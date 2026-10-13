#![allow(dead_code)]

use axum::{
    Router,
    extract::{State, WebSocketUpgrade, ws},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use prost::Message;
use std::{
    collections::{BTreeMap, BTreeSet},
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
use ycoding_protocol::{
    OPERATIONS,
    connection::{Budgets, Config, Connection, Decision},
    decode_strict, v5,
};

pub const WAIT: Duration = Duration::from_secs(10);

pub enum Command {
    Request(v5::Request, oneshot::Sender<String>),
    Cancel(String, oneshot::Sender<u64>),
    Close(u16),
    Raw(v5::Frame),
    Body(v5::frame::Body),
    ConsumeEvent(u64),
}

pub struct Opening {
    pub generation: usize,
    pub commands: mpsc::Sender<Command>,
}

pub struct Seen {
    pub generation: usize,
    pub frame: Option<v5::Frame>,
}

struct Shared {
    frames: mpsc::Sender<Seen>,
    openings: mpsc::Sender<Opening>,
    generation: AtomicUsize,
    upgrades: AtomicUsize,
    bulk_credits: AtomicUsize,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    ready_revision: u32,
    corrupt_digest: bool,
    budgets: Budgets,
}

pub struct Relay {
    pub address: SocketAddr,
    pub frames: mpsc::Receiver<Seen>,
    pub openings: mpsc::Receiver<Opening>,
    shared: Arc<Shared>,
    stop: watch::Sender<bool>,
    server: JoinHandle<()>,
}

impl Relay {
    pub async fn start(revision: u32, corrupt_digest: bool, budgets: Budgets) -> Self {
        let (frames, receiver) = mpsc::channel(512);
        let (openings, opened) = mpsc::channel(16);
        let shared = Arc::new(Shared {
            frames,
            openings,
            generation: AtomicUsize::new(0),
            upgrades: AtomicUsize::new(0),
            bulk_credits: AtomicUsize::new(0),
            tasks: Mutex::new(Vec::new()),
            ready_revision: revision,
            corrupt_digest,
            budgets,
        });
        let router = Router::new()
            .route("/ws/v5/agent", get(upgrade))
            .with_state(shared.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, mut stopped) = watch::channel(false);
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = stopped.changed().await;
                })
                .await
                .unwrap();
        });
        Self {
            address,
            frames: receiver,
            openings: opened,
            shared,
            stop,
            server,
        }
    }

    pub fn origin(&self) -> String {
        format!("http://{}", self.address)
    }

    pub fn upgrades(&self) -> usize {
        self.shared.upgrades.load(Ordering::Acquire)
    }

    pub fn bulk_credits(&self) -> usize {
        self.shared.bulk_credits.load(Ordering::Acquire)
    }

    pub async fn opening(&mut self) -> Opening {
        tokio::time::timeout(WAIT, self.openings.recv())
            .await
            .unwrap()
            .unwrap()
    }

    pub async fn matching(
        &mut self,
        generation: usize,
        predicate: impl Fn(&v5::Frame) -> bool,
    ) -> v5::Frame {
        tokio::time::timeout(WAIT, async {
            loop {
                let seen = self.frames.recv().await.unwrap();
                if seen.generation != generation {
                    continue;
                }
                let frame = seen
                    .frame
                    .expect("relay connection closed before expected frame");
                if predicate(&frame) {
                    return frame;
                }
            }
        })
        .await
        .unwrap()
    }

    pub async fn closed(&mut self, generation: usize) {
        tokio::time::timeout(WAIT, async {
            loop {
                let seen = self.frames.recv().await.unwrap();
                if seen.generation == generation && seen.frame.is_none() {
                    return;
                }
            }
        })
        .await
        .unwrap();
    }

    pub async fn shutdown(self) {
        self.stop.send_replace(true);
        tokio::time::timeout(WAIT, self.server)
            .await
            .unwrap()
            .unwrap();
        let tasks = std::mem::take(&mut *self.shared.tasks.lock().unwrap());
        for task in tasks {
            tokio::time::timeout(WAIT, task).await.unwrap().unwrap();
        }
    }
}

impl Opening {
    pub async fn request(&self, operation_id: u32, scope: v5::Scope, payload: Vec<u8>) -> String {
        let (send, receive) = oneshot::channel();
        self.commands
            .send(Command::Request(
                v5::Request {
                    request_id: String::new(),
                    operation_id,
                    scope,
                    payload,
                },
                send,
            ))
            .await
            .unwrap();
        tokio::time::timeout(WAIT, receive).await.unwrap().unwrap()
    }

    pub async fn cancel(&self, id: String) -> u64 {
        let (send, receive) = oneshot::channel();
        self.commands.send(Command::Cancel(id, send)).await.unwrap();
        tokio::time::timeout(WAIT, receive).await.unwrap().unwrap()
    }
}

async fn upgrade(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    shared.upgrades.fetch_add(1, Ordering::Release);
    if headers
        .get("Authorization")
        .and_then(|header| header.to_str().ok())
        != Some("Bearer stand-in-token")
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    upgrade.on_upgrade(move |socket| async move {
        let runtime = tokio::runtime::Handle::current();
        let owner = shared.clone();
        let task = tokio::task::spawn_blocking(move || runtime.block_on(drive(socket, owner)));
        shared.tasks.lock().unwrap().push(task);
    })
}

fn reserve(epoch: &str, body: v5::frame::Body) -> u64 {
    v5::Frame {
        revision: 5,
        connection_epoch: Some(epoch.into()),
        ledger: Some(v5::LedgerClass::Normal as i32),
        delivery_ordinal: Some(u64::MAX),
        tiny_consumed_through: Some(u64::MAX),
        body: Some(body),
    }
    .encoded_len() as u64
}

async fn drive(mut socket: ws::WebSocket, shared: Arc<Shared>) {
    let generation = shared.generation.fetch_add(1, Ordering::AcqRel) + 1;
    let epoch = format!("relay-connection-{generation}");
    let mut machine = Connection::new(
        Config {
            local_role: v5::PeerRole::Relay,
            peer_role: v5::PeerRole::Agent,
            source_epoch: "relay-source".into(),
            connection_epoch: epoch.clone(),
            budgets: shared.budgets.clone(),
            authorized_sessions: BTreeSet::new(),
            authorized_workspaces: BTreeSet::new(),
            reservation: None,
            event_types: BTreeSet::from([
                "ycoding.v5.SessionLogItem".into(),
                "ycoding.v5.PublicEvent".into(),
            ]),
        },
        OPERATIONS.clone(),
        0,
    )
    .unwrap();
    let (commands, mut command) = mpsc::channel(32);
    shared
        .openings
        .send(Opening {
            generation,
            commands,
        })
        .await
        .unwrap();
    let started = Instant::now();
    let mut ticker = tokio::time::interval(Duration::from_millis(5));
    let mut requests = BTreeMap::new();
    let mut scopes = BTreeMap::new();
    let mut epochs: BTreeMap<String, String> = BTreeMap::new();
    let mut cancels = BTreeMap::new();
    loop {
        let now = started.elapsed().as_millis() as u64;
        while let Some(prepared) = machine.prepare_handoff(now) {
            let mut frame = prepared.frame().clone();
            if let Some(v5::frame::Body::Ready(ready)) = &mut frame.body {
                ready.revision = shared.ready_revision;
                if shared.corrupt_digest {
                    ready.contract_digest[0] ^= 1;
                }
            }
            let bytes = frame.encode_to_vec();
            if socket
                .send(ws::Message::Binary(bytes.clone().into()))
                .await
                .is_err()
            {
                break;
            }
            if matches!(&frame.body, Some(v5::frame::Body::Control(v5::Control { kind: Some(v5::control::Kind::Credit(credit)) })) if credit.ledger == v5::LedgerClass::Bulk as i32)
            {
                shared.bulk_credits.fetch_add(1, Ordering::Release);
            }
            let _ = machine.handoff(prepared, bytes.len() as u64, now).unwrap();
            if let Some(v5::frame::Body::Request(request)) = &frame.body
                && let Some(reply) = requests.remove(&request.request_id)
            {
                let _ = oneshot::Sender::<String>::send(reply, request.request_id.clone());
            }
            if let Some(v5::frame::Body::Control(v5::Control {
                kind:
                    Some(v5::control::Kind::Cancel(v5::Cancel {
                        target: Some(v5::cancel::Target::RequestId(id)),
                    })),
            })) = &frame.body
                && let Some(reply) = cancels.remove(id)
            {
                let _ = oneshot::Sender::<u64>::send(reply, frame.delivery_ordinal.unwrap());
            }
        }
        if machine
            .take_decisions()
            .iter()
            .any(|decision| matches!(decision, Decision::Closed(_)))
        {
            break;
        }
        tokio::select! {
            _ = ticker.tick() => {},
            next = command.recv() => match next {
                Some(Command::Request(request, reply)) => {
                    let scope = request.scope.clone();
                    let reserved = reserve(&epoch, v5::frame::Body::Request(v5::Request { request_id: u64::MAX.to_string(), ..request.clone() }));
                    let id = machine.request(request.operation_id, request.scope, request.payload, reserved, started.elapsed().as_millis() as u64).unwrap();
                    scopes.insert(id.clone(), scope);
                    requests.insert(id, reply);
                },
                Some(Command::Cancel(id, reply)) => {
                    let _ = machine.cancel_request(&id, started.elapsed().as_millis() as u64).unwrap();
                    cancels.insert(id, reply);
                },
                Some(Command::Close(code)) => {
                    let _ = socket.send(ws::Message::Close(Some(ws::CloseFrame { code, reason: "stand-in close".into() }))).await;
                    break;
                },
                Some(Command::Raw(frame)) => { socket.send(ws::Message::Binary(frame.encode_to_vec().into())).await.unwrap(); },
                Some(Command::Body(body)) => {
                    let reserved = reserve(&epoch, body.clone());
                    machine.enqueue(body, reserved, started.elapsed().as_millis() as u64).unwrap();
                },
                Some(Command::ConsumeEvent(ordinal)) => {
                    machine.consume(v5::LedgerClass::Event, ordinal, started.elapsed().as_millis() as u64).unwrap();
                },
                None => break,
            },
            next = socket.recv() => {
                let bytes = match next { Some(Ok(ws::Message::Binary(bytes))) => bytes, Some(Ok(ws::Message::Ping(_) | ws::Message::Pong(_))) => continue, _ => break };
                let frame = decode_strict::<v5::Frame>(&bytes).unwrap();
                shared.frames.send(Seen { generation, frame: Some(frame.clone()) }).await.unwrap();
                let Some(token) = machine.admit_incoming(bytes.len() as u64) else { break; };
                let ordinal = frame.delivery_ordinal;
                let ledger = frame.ledger;
                let decisions = machine.accept_incoming(&token, frame, started.elapsed().as_millis() as u64).unwrap();
                let mut closed = false;
                for decision in decisions {
                    match decision {
                        Decision::Forward(frame) => {
                            if let Some(v5::frame::Body::Result(result)) = &frame.body
                                && result.operation_id == 4000
                                && let Some(v5::result::Outcome::Success(payload)) = &result.outcome {
                                let accepted = decode_strict::<v5::EventSubscribeResult>(&payload.payload).unwrap();
                                let id = String::from_utf16(&ycoding_protocol::decode_lossless(&accepted.subscription_id, 1024).unwrap()).unwrap();
                                let scope = scopes.get(&result.request_id).unwrap().clone();
                                let session = match &scope.target { Some(v5::scope::Target::Session(id)) => id, _ => panic!("Session subscription") };
                                machine.accept_subscription(&result.request_id, id, scope.clone(), started.elapsed().as_millis() as u64, ycoding_protocol::connection::Direction::Receive, Some(epochs.get(session).unwrap().clone())).unwrap();
                            }
                            if ledger != Some(v5::LedgerClass::Event as i32) {
                                machine.consume(v5::LedgerClass::try_from(ledger.unwrap()).unwrap(), ordinal.unwrap(), started.elapsed().as_millis() as u64).unwrap();
                            }
                        },
                        Decision::Resync(resync) => {
                            if let Some(v5::scope::Target::Session(id)) = resync.scope.target { epochs.insert(id, resync.source_epoch); }
                            assert_eq!(ledger, Some(v5::LedgerClass::Normal as i32), "Unexpected event epoch invalidation");
                        },
                        Decision::Control(_) => {
                            machine.consume(v5::LedgerClass::try_from(ledger.unwrap()).unwrap(), ordinal.unwrap(), started.elapsed().as_millis() as u64).unwrap();
                        },
                        Decision::Closed(_) => closed = true,
                        _ => {},
                    }
                }
                if closed { break; }
            }
        }
    }
    let _ = shared
        .frames
        .send(Seen {
            generation,
            frame: None,
        })
        .await;
}
