use super::*;
use crate::filesystem_fixture;
use futures_util::{SinkExt, StreamExt};
use std::{
    collections::{BTreeSet, VecDeque},
    future::pending,
    net::SocketAddr,
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};
use tokio::{net::TcpStream, sync::Notify, time::timeout};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Error as WsError, Message as Frame, client::IntoClientRequest, http},
};
use ycoding_core::{
    process::guardrails::{Paths, Settings as Guardrails},
    resources::agent,
    session::run_coordinator,
    ycoding_schema::{ObjectEncoder, parse_json, stringify_json},
    ycoding_store::{Metadata, Options, Store, native as schema, resources::Secret},
};
use ycoding_protocol::{
    OPERATIONS,
    connection::{Budgets, Config, Connection, Decision, Outcome},
    decode_strict,
};

const VALID_AUTH: &str = "Basic eWNvZGluZzpzeW50aGV0aWMtcGFzc3dvcmQ=";
const WRONG_AUTH: &str = "Basic eWNvZGluZzp3cm9uZw==";

struct NoSessionRunners;

impl execution::Locations for NoSessionRunners {
    fn get(&self, _: &session::Info) -> Result<Arc<dyn execution::Runner>, run_coordinator::Error> {
        panic!("a Location-scoped approval must not acquire a Session runner")
    }
}

#[derive(Default)]
struct Peer {
    connected: Notify,
    pending_received: Notify,
    writes: Mutex<Vec<JsonValue>>,
}

struct DurableSocket {
    peer: Arc<Peer>,
    incoming: VecDeque<Frame>,
    connected: bool,
    approval_queued: bool,
}

impl conversation::Socket for DurableSocket {
    fn ready(&mut self) -> conversation::SocketFuture<'_, Result<(), conversation::SocketError>> {
        Box::pin(async { Ok(()) })
    }

    fn start_send(&mut self, message: Frame) -> Result<(), conversation::SocketError> {
        let value = parse_json(message.to_text().unwrap()).unwrap();
        let JsonValue::Object(fields) = &value else {
            panic!("expected a JSON object")
        };
        let method = fields.get(&"method".into()).and_then(|value| match value {
            JsonValue::String(s) => s.as_str(),
            _ => None,
        });
        match method {
            Some("initialize" | "thread/resume") => {
                let result = ObjectEncoder::new()
                    .field("id", fields.get(&"id".into()).unwrap())
                    .field("result", &ObjectEncoder::new().finish())
                    .finish();
                self.incoming
                    .push_back(Frame::text(stringify_json(&result)));
                if method == Some("thread/resume") {
                    self.incoming.push_back(Frame::text(
                        r#"{"id":17,"method":"item/commandExecution/requestApproval","params":{"threadId":"member-thread","turnId":"turn-1"}}"#,
                    ));
                    self.approval_queued = true;
                }
            }
            Some("initialized") => self.connected = true,
            None => self.peer.writes.lock().unwrap().push(value),
            Some(method) => panic!("unexpected durable method {method}"),
        }
        Ok(())
    }

    fn flush(&mut self) -> conversation::SocketFuture<'_, Result<(), conversation::SocketError>> {
        Box::pin(async { Ok(()) })
    }

    fn next(
        &mut self,
    ) -> conversation::SocketFuture<'_, Option<Result<Frame, conversation::SocketError>>> {
        Box::pin(async move {
            if let Some(message) = self.incoming.pop_front() {
                return Some(Ok(message));
            }
            if std::mem::take(&mut self.connected) {
                self.peer.connected.notify_one();
            }
            if std::mem::take(&mut self.approval_queued) {
                self.peer.pending_received.notify_one();
            }
            pending().await
        })
    }
}

fn upstream(
    peer: Arc<Peer>,
    calls: Arc<AtomicUsize>,
) -> (conversation::Connect, conversation::RestDriver) {
    let connect: conversation::Connect = Arc::new(move |request| {
        assert_eq!(request.uri(), "wss://codex-cloud-backend.chatgpt.com/");
        assert_eq!(request.headers()["chatgpt-account-id"], "synthetic-account");
        assert_eq!(
            request.headers()["sec-websocket-protocol"],
            "codex-app-server, codex-client.desktop, openai-bearer.synthetic-access"
        );
        let socket: Box<dyn conversation::Socket> = Box::new(DurableSocket {
            peer: peer.clone(),
            incoming: VecDeque::new(),
            connected: false,
            approval_queued: false,
        });
        Box::pin(async { Ok(socket) })
    });
    let rest: conversation::RestDriver = Arc::new(move |_, request| {
        assert_eq!(request.method(), "GET");
        assert_eq!(request.url().scheme(), "https");
        assert_eq!(request.url().host_str(), Some("chatgpt.com"));
        assert_eq!(
            request.headers()["authorization"],
            "Bearer synthetic-access"
        );
        assert_eq!(request.headers()["chatgpt-account-id"], "synthetic-account");
        let body = match request.url().path() {
            "/backend-api/tbo" => r#"{"items":[{"id":"synthetic-dot","status":"active"}]}"#,
            "/backend-api/tbo/synthetic-dot/root-thread" => r#"{"root_thread_id":"root-thread"}"#,
            "/backend-api/tbo/synthetic-dot/threads" => {
                r#"{"items":[{"thread_id":"member-thread"}]}"#
            }
            path => panic!("unexpected REST path {path}"),
        };
        calls.fetch_add(1, Ordering::Relaxed);
        Box::pin(async move { Ok(http::Response::new(body).into()) })
    });
    (connect, rest)
}

type Wire = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn connect(address: SocketAddr, authorization: Option<&str>) -> Result<Wire, u16> {
    let mut request = format!("ws://{address}/ws/v5/local")
        .into_client_request()
        .unwrap();
    if let Some(value) = authorization {
        request
            .headers_mut()
            .insert("authorization", value.parse().unwrap());
    }
    match connect_async(request).await {
        Ok((socket, _)) => Ok(socket),
        Err(WsError::Http(reply)) => Err(reply.status().as_u16()),
        Err(error) => panic!("local WebSocket upgrade failed: {error}"),
    }
}

struct LocalClient {
    wire: Wire,
    connection: Connection,
    started: Instant,
}

impl LocalClient {
    async fn open(wire: Wire) -> Self {
        let mut connection = Connection::new(
            Config {
                local_role: v5::PeerRole::LocalClient,
                peer_role: v5::PeerRole::Server,
                source_epoch: "dots-client-source".into(),
                connection_epoch: "dots-client-connection".into(),
                budgets: Budgets::default(),
                authorized_sessions: BTreeSet::new(),
                authorized_workspaces: BTreeSet::new(),
                reservation: None,
                event_types: BTreeSet::new(),
            },
            OPERATIONS.clone(),
            0,
        )
        .unwrap();
        connection.start(0).unwrap();
        let mut client = Self {
            wire,
            connection,
            started: Instant::now(),
        };
        while !client
            .step()
            .await
            .iter()
            .any(|d| matches!(d, Decision::Established))
        {}
        client
    }

    fn now(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    async fn step(&mut self) -> Vec<Decision> {
        while let Some(prepared) = self.connection.prepare_handoff(self.now()) {
            let bytes = prepared.frame().encode_to_vec();
            let decisions = self
                .connection
                .handoff(prepared, bytes.len() as u64, self.now())
                .unwrap();
            assert!(
                decisions
                    .iter()
                    .any(|decision| matches!(decision, Decision::Send(_)))
            );
            self.wire.send(Frame::binary(bytes)).await.unwrap();
        }
        let Frame::Binary(bytes) = self.wire.next().await.unwrap().unwrap() else {
            panic!("expected a V5 frame")
        };
        let admitted = self.connection.admit_incoming(bytes.len() as u64).unwrap();
        let frame: v5::Frame = decode_strict(&bytes).unwrap();
        let ordinal = frame.delivery_ordinal;
        let decisions = self
            .connection
            .accept_incoming(&admitted, frame, self.now())
            .unwrap();
        assert!(
            !decisions
                .iter()
                .any(|decision| matches!(decision, Decision::Closed(_)))
        );
        if let Some(ordinal) = ordinal.filter(|ordinal| *ordinal > 0)
            && decisions
                .iter()
                .any(|decision| matches!(decision, Decision::Settled { .. }))
        {
            self.connection
                .consume(v5::LedgerClass::Normal, ordinal, self.now())
                .unwrap();
        }
        decisions
    }

    async fn call(&mut self, name: &str, message: &impl Message) -> Outcome {
        let operation = OPERATIONS
            .iter()
            .find(|op| op.diagnostic_name == name)
            .unwrap();
        let scope = v5::Scope {
            target: Some(v5::scope::Target::Location(text("/project"))),
        };
        let request_id = self
            .connection
            .request(
                operation.operation_id,
                scope,
                message.encode_to_vec(),
                1024,
                self.now(),
            )
            .unwrap();
        loop {
            for decision in self.step().await {
                if let Decision::Settled {
                    request_id: id,
                    outcome,
                } = decision
                {
                    assert_eq!(id, request_id);
                    return outcome;
                }
            }
        }
    }
}

fn text(s: &str) -> v5::LosslessString {
    v5::LosslessString {
        encoding: Some(v5::lossless_string::Encoding::Utf8(s.into())),
    }
}

fn success<T: Message + Name + Default>(outcome: Outcome) -> T {
    let Outcome::Success { payload, .. } = outcome else {
        panic!("expected {}", T::full_name())
    };
    assert_eq!(payload.type_name, T::full_name());
    decode_strict(&payload.payload).unwrap()
}

#[test]
fn authenticated_dots_respond_settles_once_and_rejects_stale_replay() {
    const CHILD: &str = "YCODING_DOTS_RESPOND_TEST_PROCESS";
    if std::env::var_os(CHILD).is_none() {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                concat!(
                    module_path!(),
                    "::authenticated_dots_respond_settles_once_and_rejects_stale_replay"
                )
                .strip_prefix("ycoding_runtime::")
                .unwrap(),
                "--nocapture",
            ])
            .env(CHILD, "1")
            .status()
            .unwrap();
        assert!(
            status.success(),
            "isolated approval test exited with {status}"
        );
        return;
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let joined = crate::ProductionOwner::scope(&runtime, |owner| {
        runtime.block_on(async {
            timeout(Duration::from_secs(15), stale_replay(owner))
                .await
                .unwrap()
        });
    });
    joined.body.unwrap();
    joined.cleanup.result().unwrap();
}

async fn stale_replay(owner: crate::Handle) {
    let fixture = filesystem_fixture::Fixture::new();
    let roots = config::Roots::development(&fixture.0).unwrap();
    roots.initialize().unwrap();
    let global = Arc::new(
        config::Configuration::load(config::LoadOptions {
            directory: fixture.0.clone(),
            roots: roots.clone(),
            project: false,
            file: None,
            content: None,
            env: BTreeMap::new(),
        })
        .unwrap(),
    );
    let database = Store::initialize(
        fixture.0.join("store.redb"),
        Options::core(),
        schema::catalog(schema::DatabaseKind::Core),
        Metadata::new([7; 16], 1),
    )
    .unwrap();
    let client = database.client();
    let execution = execution::Execution::install(
        store::Service::new(client.clone()),
        Arc::new(NoSessionRunners),
        ycoding_core::job::Jobs::new(),
        None,
    )
    .unwrap();
    let git = Arc::new(ycoding_core::platform::git::Service::new(1024));
    let mut core = crate::Core::new(
        client.clone(),
        execution,
        crate::Configuration {
            agents: Arc::new(agent::Service::new(vec![])),
            publisher: Arc::new(|_| Ok(())),
            helpers: None,
            guardrails: Guardrails {
                paths: Paths {
                    workdir: "/project".into(),
                    project: "/project".into(),
                    home: "/synthetic-home".into(),
                    tmpdir: None,
                    trusted_paths: vec![],
                },
                global_roots: vec![],
                custom: Arc::new(Vec::new),
                enabled: true,
                limits: Default::default(),
                decide_reviews: false,
                decide_hard_reviews: false,
            },
            snapshots: crate::SnapshotSettings {
                git: git.clone(),
                data: roots.data.clone(),
                enabled: false,
            },
        },
        ycoding_core::generation_activity::Service::new(0, 0),
        roots.state.clone(),
    );
    core.credentials.create("credential_synthetic".into(), "openai".into(), Some("synthetic-profile".into()), Secret::new(parse_json(r#"{"type":"oauth","methodID":"chatgpt-browser","access":"synthetic-access","refresh":"synthetic-refresh","expires":9007199254740000,"metadata":{"accountID":"synthetic-account"}}"#).unwrap()).unwrap(), 1).await.unwrap();

    let peer = Arc::new(Peer::default());
    let rest_calls = Arc::new(AtomicUsize::new(0));
    let (connect_upstream, rest) = upstream(peer.clone(), rest_calls.clone());
    let dots = Arc::new(
        Services::start_with(
            Settings {
                owner,
                client,
                global,
                credentials: core.credentials.clone(),
                sessions: core.sessions.clone(),
                execution,
                locations: core.locations.clone(),
                git,
                orchestration: core.orchestration.clone(),
                reviews: core.reviews.clone(),
                events: core.events.clone(),
                catalogs: Arc::new(|_, _| panic!("approval does not resolve Session catalogs")),
                auth: Default::default(),
                preparation: Default::default(),
                env: BTreeMap::new(),
                state: roots.state.clone(),
                home: roots.home.clone(),
                data: roots.data.clone(),
                codex_home: String::new(),
            },
            connect_upstream,
            rest,
        )
        .await
        .unwrap(),
    );
    std::fs::write(
        roots.config.join("ycoding.json"),
        r#"{"dots":{"enabled":true,"profile":"synthetic-profile"}}"#,
    )
    .unwrap();
    dots.access.set(true, 0).await.unwrap();
    peer.connected.notified().await;
    core.dots = Some(dots.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server = crate::serve(
        listener,
        crate::Services {
            identity: crate::Identity {
                version: "9.9.9-test".into(),
                pid: u64::from(std::process::id()),
                source_epoch: "dots-server".into(),
            },
            auth: crate::LocalAuth::with_password("synthetic-password"),
            core: Some(core),
            cors: Vec::new(),
            budgets: Budgets::default(),
        },
    )
    .await
    .unwrap();
    let address = server.address();
    for authorization in [None, Some(WRONG_AUTH)] {
        assert_eq!(connect(address, authorization).await.err(), Some(401));
    }
    assert_eq!(rest_calls.load(Ordering::Relaxed), 0);
    assert!(peer.writes.lock().unwrap().is_empty());

    let mut local = LocalClient::open(connect(address, Some(VALID_AUTH)).await.unwrap()).await;
    let pending = v5::DotsThreadRequestsRequest {
        params: v5::DotsThreadRequestsRequestParams {
            thread_id: text("member-thread"),
        },
    };
    let _: v5::DotsThreadRequestsResult =
        success(local.call("dots.thread.requests", &pending).await);
    peer.pending_received.notified().await;
    let approval: v5::DotsThreadRequestsResult =
        success(local.call("dots.thread.requests", &pending).await);
    assert_eq!(approval.data.requests.items.len(), 1);
    assert_eq!(approval.data.requests.items[0].request_id, text("17"));

    let response = v5::DotsThreadRespondRequest {
        params: v5::DotsThreadRespondRequestParams {
            thread_id: text("member-thread"),
            request_id: text("17"),
        },
        payload: v5::DotsRequestResponse {
            decision: Some(
                v5::DotsRequestResponseDecision::DotsRequestresponseDecisionDecline as i32,
            ),
            answers: None,
        },
    };
    let sent: v5::DotsThreadRespondResult =
        success(local.call("dots.thread.respond", &response).await);
    assert_eq!(
        sent.data.outcome(),
        v5::DotsRespondResultOutcome::DotsRespondresultOutcomeSent
    );
    let settled: v5::DotsThreadRequestsResult =
        success(local.call("dots.thread.requests", &pending).await);
    assert!(settled.data.requests.items.is_empty());

    let Outcome::Rejected(error) = local.call("dots.thread.respond", &response).await else {
        panic!("expected stale replay rejection")
    };
    assert_eq!(error.type_name, v5::ConflictError::full_name());
    let error: v5::ConflictError = decode_strict(&error.payload).unwrap();
    assert_eq!(
        error.message,
        text(
            "This request was already answered or is no longer pending. Refresh the pending requests."
        )
    );
    assert_eq!(error.resource, None);
    assert_eq!(rest_calls.load(Ordering::Relaxed), 15);
    assert_eq!(
        peer.writes.lock().unwrap().as_slice(),
        &[parse_json(r#"{"id":17,"result":{"decision":"decline"}}"#).unwrap()]
    );

    drop(local);
    server.shutdown().await.unwrap();
    dots.shutdown().await.unwrap();
    database.shutdown().unwrap();
}
