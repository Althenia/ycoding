use super::{Control, Credentials, Enrolled, Error, Intent, Peer, State};
use crate::{Bulk, Dispatcher, Environment, Settled, ids};
use axum::http::header::AUTHORIZATION;
use futures_util::{SinkExt, StreamExt};
use prost::Message;
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    runtime::{Handle, RuntimeFlavor},
    sync::{Mutex, Semaphore, mpsc, watch},
    task::JoinHandle,
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{self, client::IntoClientRequest, protocol::WebSocketConfig},
};
use ycoding_core::event_feed::{Payload, Scope};
use ycoding_protocol::{
    connection::{Config, Connection, Decision, ProtocolError},
    decode_strict, limits, v5,
};

pub struct Settings {
    pub enrolled: Enrolled,
    pub relay_origin: String,
    pub credentials: Arc<dyn Credentials>,
    pub reconnect_initial: Duration,
    pub reconnect_max: Duration,
    pub conflict_delay: Duration,
}

impl Settings {
    pub fn new(
        enrolled: Enrolled,
        relay_origin: String,
        credentials: Arc<dyn Credentials>,
    ) -> Result<Self, Error> {
        enrolled.bind(&relay_origin)?;
        Ok(Self {
            enrolled,
            relay_origin,
            credentials,
            reconnect_initial: Duration::from_secs(1),
            reconnect_max: Duration::from_secs(30),
            conflict_delay: Duration::from_secs(60),
        })
    }
}

pub struct Connector {
    control: Control,
    stop: watch::Sender<bool>,
    task: std::thread::JoinHandle<Result<(), Error>>,
}

impl Connector {
    pub fn start(
        control: Control,
        settings: Settings,
        environment: Arc<Environment>,
        dispatcher: Arc<Dispatcher>,
    ) -> Result<Self, Error> {
        let runtime = Handle::current();
        if runtime.runtime_flavor() != RuntimeFlavor::MultiThread
            || settings.reconnect_initial.is_zero()
            || settings.reconnect_max < settings.reconnect_initial
        {
            return Err(Error::Setup);
        }
        settings.enrolled.bind(&settings.relay_origin)?;
        let (stop, stopped) = watch::channel(false);
        let state = control.clone();
        let task = std::thread::Builder::new()
            .name("ycoding-v5-connector".into())
            .spawn(move || {
                runtime.block_on(supervise(
                    control,
                    settings,
                    environment,
                    dispatcher,
                    stopped,
                ))
            })
            .map_err(|_| Error::Setup)?;
        Ok(Self {
            control: state,
            stop,
            task,
        })
    }

    pub async fn shutdown(self) -> Result<(), Error> {
        self.control.stop();
        self.stop.send_replace(true);
        tokio::task::spawn_blocking(move || self.task.join().map_err(|_| Error::Shutdown)?)
            .await
            .map_err(|_| Error::Shutdown)?
    }
}

async fn supervise(
    control: Control,
    settings: Settings,
    environment: Arc<Environment>,
    dispatcher: Arc<Dispatcher>,
    mut stopped: watch::Receiver<bool>,
) -> Result<(), Error> {
    let mut intent = control.subscribe();
    let mut attempt = 0u32;
    let mut tasks = DispatchTasks {
        jobs: Vec::new(),
        permits: Arc::new(Semaphore::new(limits::PENDING_REQUESTS as usize)),
        lanes: BTreeMap::new(),
    };
    loop {
        let current = *intent.borrow_and_update();
        if *stopped.borrow() {
            break;
        }
        if !current.enabled {
            tokio::select! { _ = intent.changed() => { attempt = 0; }, _ = stopped.changed() => break }
            continue;
        }
        control.publish(current.generation, State::Connecting, None);
        let opened = AtomicBool::new(false);
        let result = tokio::select! {
            result = connect(&settings, &control, current, environment.clone(), dispatcher.clone(), &mut tasks, &opened) => result,
            _ = intent.changed() => { attempt = 0; continue; },
            _ = stopped.changed() => break,
        };
        if opened.load(Ordering::Acquire) {
            attempt = 0;
        }
        reap(&mut tasks.jobs).await?;
        match result {
            Err(Error::Unauthorized | Error::Forbidden | Error::Setup | Error::Incompatible) => {
                control.publish(
                    current.generation,
                    State::Error,
                    Some("Remote setup or authentication failed"),
                );
                tokio::select! { _ = intent.changed() => { attempt = 0; }, _ = stopped.changed() => break }
            }
            result => {
                let delay = if result == Err(Error::Conflict) {
                    settings.conflict_delay
                } else {
                    settings
                        .reconnect_initial
                        .saturating_mul(2u32.saturating_pow(attempt))
                        .min(settings.reconnect_max)
                };
                attempt = attempt.saturating_add(1).min(30);
                control.publish(
                    current.generation,
                    State::Connecting,
                    Some("Remote connection interrupted; retrying"),
                );
                tokio::select! { _ = tokio::time::sleep(delay) => {}, _ = intent.changed() => { attempt = 0; }, _ = stopped.changed() => break }
            }
        }
    }
    let mut joined = 0;
    let drain = async {
        while joined < tasks.jobs.len() {
            let result = (&mut tasks.jobs[joined]).await;
            joined += 1;
            if let Err(error) = result
                && !error.is_cancelled()
            {
                return Err(Error::Shutdown);
            }
        }
        Ok(())
    };
    control.publish(intent.borrow().generation, State::Off, None);
    let result = tokio::time::timeout(Duration::from_secs(10), drain).await;
    if !matches!(result, Ok(Ok(()))) {
        for job in tasks.jobs.iter().skip(joined) {
            job.abort();
        }
        for job in tasks.jobs.drain(joined..) {
            let _ = job.await;
        }
    }
    result.map_err(|_| Error::Shutdown)?
}

async fn reap(jobs: &mut Vec<JoinHandle<()>>) -> Result<(), Error> {
    let mut index = 0;
    while index < jobs.len() {
        if !jobs[index].is_finished() {
            index += 1;
            continue;
        }
        let job = jobs.swap_remove(index);
        if let Err(error) = job.await
            && !error.is_cancelled()
        {
            return Err(Error::Shutdown);
        }
    }
    Ok(())
}

struct DispatchTasks {
    jobs: Vec<JoinHandle<()>>,
    permits: Arc<Semaphore>,
    lanes: BTreeMap<String, Weak<Mutex<()>>>,
}

struct Work {
    cancelled: Arc<AtomicBool>,
    read: Option<tokio::task::AbortHandle>,
}

struct Transfer {
    bulk: Bulk,
    id: String,
    started: bool,
    offset: usize,
    index: u32,
}

struct Driver {
    machine: Connection,
    peer: Peer,
    epoch: String,
    started: Instant,
    work: BTreeMap<String, Work>,
    transfers: VecDeque<Transfer>,
    next_transfer: u64,
    established: bool,
}

impl Drop for Driver {
    fn drop(&mut self) {
        self.peer.revoke();
        for work in self.work.values() {
            work.cancelled.store(true, Ordering::Release);
            if let Some(read) = &work.read {
                read.abort();
            }
        }
    }
}

async fn connect(
    settings: &Settings,
    control: &Control,
    intent: Intent,
    environment: Arc<Environment>,
    dispatcher: Arc<Dispatcher>,
    tasks: &mut DispatchTasks,
    opened: &AtomicBool,
) -> Result<(), Error> {
    let environment = Arc::new(Environment {
        services: environment.services.clone(),
        urls: environment.urls.clone(),
        subscriptions: crate::Subscriptions::default(),
    });
    let url = settings.enrolled.bind(&settings.relay_origin)?;
    let core = environment.services.core.as_ref().ok_or(Error::Setup)?;
    core.sessions
        .list(&ycoding_core::session::list::Query::default())
        .map_err(|_| Error::Transport)?;
    if !control.current(intent.generation) {
        return Err(Error::Transport);
    }
    let credential = tokio::time::timeout(Duration::from_secs(30), settings.credentials.access())
        .await
        .map_err(|_| Error::Transport)??;
    if !control.current(intent.generation) {
        return Err(Error::Transport);
    }
    let peer = credential.authenticate(&settings.enrolled, ids::now_millis())?;
    let mut request = url.into_client_request().map_err(|_| Error::Setup)?;
    let mut authorization = format!("Bearer {}", credential.token)
        .parse()
        .map_err(|_| Error::Unauthorized)?;
    axum::http::HeaderValue::set_sensitive(&mut authorization, true);
    request.headers_mut().insert(AUTHORIZATION, authorization);
    let config = WebSocketConfig::default()
        .max_message_size(Some(limits::CLIENT_FRAME_BYTES as usize))
        .max_frame_size(Some(limits::CLIENT_FRAME_BYTES as usize));
    let upgrade = tokio::time::timeout(
        Duration::from_secs(10),
        connect_async_with_config(request, Some(config), false),
    )
    .await
    .map_err(|_| Error::Transport)?;
    let (mut socket, _) = upgrade.map_err(|error| match error {
        tungstenite::Error::Http(response) if response.status().as_u16() == 401 => {
            Error::Unauthorized
        }
        tungstenite::Error::Http(response) if response.status().as_u16() == 403 => Error::Forbidden,
        _ => Error::Transport,
    })?;
    if !control.current(intent.generation) {
        return Err(Error::Transport);
    }
    let machine = Connection::new(
        Config {
            local_role: v5::PeerRole::Agent,
            peer_role: v5::PeerRole::Relay,
            source_epoch: environment.services.identity.source_epoch.clone(),
            connection_epoch: String::new(),
            budgets: environment.services.budgets.clone(),
            authorized_sessions: BTreeSet::new(),
            authorized_workspaces: BTreeSet::new(),
            reservation: None,
            event_types: BTreeSet::from(["ycoding.v5.SessionLogItem".into()]),
        },
        dispatcher.descriptors(),
        0,
    )
    .map_err(|_| Error::Setup)?;
    let mut driver = Driver {
        machine,
        peer,
        epoch: String::new(),
        started: Instant::now(),
        work: BTreeMap::new(),
        transfers: VecDeque::new(),
        next_transfer: 1,
        established: false,
    };
    let subscriber = core
        .events
        .subscribe(Scope::Global, None, || {})
        .map_err(|_| Error::Transport)?;
    driver.machine.start(0).map_err(|_| Error::Incompatible)?;
    let (completed, mut results) =
        mpsc::channel::<(String, Option<Settled>)>(limits::PENDING_REQUESTS as usize);
    let mut ticker = tokio::time::interval(Duration::from_millis(10));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut next_send = Instant::now();
    let expiry = tokio::time::sleep(Duration::from_millis(
        credential
            .expires_at
            .saturating_sub(ids::now_millis())
            .max(0) as u64,
    ));
    tokio::pin!(expiry);
    loop {
        if !control.current(intent.generation) {
            return Err(Error::Transport);
        }
        reap(&mut tasks.jobs).await?;
        if driver.established {
            while let Some(item) = subscriber.next().map_err(|_| Error::Transport)? {
                let body = v5::frame::Body::Control(v5::Control {
                    kind: Some(v5::control::Kind::InventoryInvalidated(
                        v5::InventoryInvalidated {},
                    )),
                });
                if matches!(&item.payload, Payload::Durable(event) if event.type_.as_str().is_some_and(|name| name.starts_with("session.created") || name.starts_with("session.deleted") || name.starts_with("session.updated")))
                {
                    driver
                        .machine
                        .enqueue(
                            body.clone(),
                            driver.reserve(v5::LedgerClass::Normal, body),
                            driver.now(),
                        )
                        .map_err(protocol_error)?;
                }
            }
        }
        driver.feed_transfers()?;
        if Instant::now() >= next_send
            && let Some(prepared) = driver.machine.prepare_handoff(driver.now())
        {
            let bytes = prepared.frame().encode_to_vec();
            let length = bytes.len() as u64;
            tokio::time::timeout(
                Duration::from_millis(environment.services.budgets.delivery_timeout_ms),
                socket.send(tungstenite::Message::Binary(bytes.into())),
            )
            .await
            .map_err(|_| Error::Transport)?
            .map_err(|_| Error::Transport)?;
            let decisions = driver
                .machine
                .handoff(prepared, length, driver.now())
                .map_err(protocol_error)?;
            if decisions
                .iter()
                .any(|decision| matches!(decision, Decision::Closed(_)))
            {
                return Err(Error::Incompatible);
            }
            next_send = Instant::now() + Duration::from_millis(25);
        }
        if driver
            .machine
            .take_decisions()
            .iter()
            .any(|decision| matches!(decision, Decision::Closed(_)))
        {
            return Err(Error::Incompatible);
        }
        tokio::select! {
            _ = &mut expiry => return Err(Error::Transport),
            _ = ticker.tick() => {},
            result = results.recv() => {
                let Some((id, settled)) = result else { return Err(Error::Transport); };
                if driver.work.remove(&id).is_some() { driver.complete(settled)?; }
            },
            incoming = socket.next() => {
                let bytes = match incoming {
                    Some(Ok(tungstenite::Message::Binary(bytes))) => bytes,
                    Some(Ok(tungstenite::Message::Ping(_) | tungstenite::Message::Pong(_))) => continue,
                    Some(Ok(tungstenite::Message::Close(Some(close)))) => return Err(match u16::from(close.code) { 4401 => Error::Unauthorized, 4403 => Error::Forbidden, 4409 => Error::Conflict, _ => Error::Transport }),
                    Some(Ok(tungstenite::Message::Text(_))) => return Err(Error::Incompatible),
                    Some(Err(tungstenite::Error::Capacity(_) | tungstenite::Error::Protocol(_))) => return Err(Error::Incompatible),
                    _ => return Err(Error::Transport),
                };
                let token = driver.machine.admit_incoming(bytes.len() as u64).ok_or(Error::Incompatible)?;
                let frame = decode_strict::<v5::Frame>(&bytes).map_err(|_| Error::Incompatible)?;
                if let Some(v5::frame::Body::Ready(ready)) = &frame.body { driver.epoch = ready.connection_epoch.clone(); }
                let ordinal = frame.delivery_ordinal;
                let decisions = driver.machine.accept_incoming(&token, frame, driver.now()).map_err(protocol_error)?;
                for decision in decisions {
                    match decision {
                        Decision::Established => {
                            opened.store(true, Ordering::Release);
                            driver.established = true;
                            control.publish(intent.generation, State::On, None);
                            let body = v5::frame::Body::Control(v5::Control { kind: Some(v5::control::Kind::InventoryInvalidated(v5::InventoryInvalidated {})) });
                            driver.machine.enqueue(body.clone(), driver.reserve(v5::LedgerClass::Normal, body), driver.now()).map_err(protocol_error)?;
                        },
                        Decision::Request(request) => {
                            driver.consume(ordinal)?;
                            let descriptor = dispatcher.descriptor(request.operation_id).ok_or(Error::Incompatible)?;
                            let mutation = descriptor.mutation == v5::MutationClass::Mutation as i32;
                            let cancelled = Arc::new(AtomicBool::new(false));
                            let cancellation = cancelled.clone();
                            let id = request.request_id.clone();
                            let request_id = id.clone();
                            let peer = driver.peer.clone();
                            let connection_id = driver.epoch.clone();
                            let environment = environment.clone();
                            let dispatcher = dispatcher.clone();
                            let completed = completed.clone();
                            let control = control.clone();
                            let permit = tasks.permits.clone().try_acquire_owned().map_err(|_| Error::Transport)?;
                            tasks.lanes.retain(|_, lane| lane.strong_count() > 0);
                            let lane = if mutation {
                                let key = match &request.scope.target { Some(v5::scope::Target::Session(id) | v5::scope::Target::Form(id)) => id.clone(), _ => String::new() };
                                let lock = tasks.lanes.get(&key).and_then(Weak::upgrade).unwrap_or_else(|| Arc::new(Mutex::new(())));
                                tasks.lanes.insert(key, Arc::downgrade(&lock)); Some(lock)
                            } else { None };
                            let job = tokio::spawn(async move {
                                let _permit = permit;
                                let _lane = match &lane { Some(lane) => Some(lane.lock().await), None => None };
                                if cancellation.load(Ordering::Acquire) || !control.current(intent.generation) { return; }
                                let settled = dispatcher.invoke_remote(environment, connection_id, &peer, request).await;
                                let _ = completed.send((id, settled)).await;
                            });
                            driver.work.insert(request_id, Work { cancelled, read: (!mutation).then(|| job.abort_handle()) });
                            tasks.jobs.push(job);
                        },
                        Decision::Control(control) => {
                            driver.consume(ordinal)?;
                            match control.kind {
                                Some(v5::control::Kind::Priority(_)) => {},
                                _ => return Err(Error::Incompatible),
                            }
                        },
                        Decision::CancelWork { target, mutation: _ } => driver.cancel(&target),
                        Decision::Closed(close) => {
                            let _ = tokio::time::timeout(Duration::from_secs(1), socket.close(Some(tungstenite::protocol::CloseFrame { code: close.code.into(), reason: close.reason().into() }))).await;
                            return Err(Error::Incompatible);
                        },
                        Decision::Send(_) => {},
                        _ => return Err(Error::Incompatible),
                    }
                }
            }
        }
    }
}

fn protocol_error(error: ProtocolError) -> Error {
    match error {
        ProtocolError::Limit | ProtocolError::Closed => Error::Transport,
        _ => Error::Incompatible,
    }
}

impl Driver {
    fn now(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    fn reserve(&self, ledger: v5::LedgerClass, body: v5::frame::Body) -> u64 {
        v5::Frame {
            revision: 5,
            connection_epoch: Some(self.epoch.clone()),
            ledger: Some(ledger as i32),
            delivery_ordinal: Some(u64::MAX),
            tiny_consumed_through: Some(u64::MAX),
            body: Some(body),
        }
        .encoded_len() as u64
    }

    fn consume(&mut self, ordinal: Option<u64>) -> Result<(), Error> {
        self.machine
            .consume(
                v5::LedgerClass::Normal,
                ordinal.ok_or(Error::Incompatible)?,
                self.now(),
            )
            .map(|_| ())
            .map_err(protocol_error)
    }

    fn complete(&mut self, settled: Option<Settled>) -> Result<(), Error> {
        let (bulk, metadata) = match settled.ok_or(Error::Incompatible)? {
            Settled::Result(result) => {
                let reserved = self.reserve(
                    v5::LedgerClass::Normal,
                    v5::frame::Body::Result(result.clone()),
                );
                return self
                    .machine
                    .respond(result, reserved, self.now())
                    .map_err(protocol_error);
            }
            Settled::Bulk(bulk) => (bulk, None),
            Settled::Asset { metadata, bulk } => (bulk, Some(metadata)),
        };
        if self
            .transfers
            .iter()
            .map(|transfer| transfer.bulk.body.len())
            .sum::<usize>()
            + bulk.body.len()
            > limits::BULK_MESSAGE_BYTES as usize
        {
            return Err(Error::Transport);
        }
        let id = format!("connector-{}", self.next_transfer);
        self.next_transfer = self.next_transfer.checked_add(1).ok_or(Error::Transport)?;
        if let Some(metadata) = metadata {
            let reserved = self.reserve(
                v5::LedgerClass::Normal,
                v5::frame::Body::Result(metadata.clone()),
            );
            self.machine
                .respond(metadata, reserved, self.now())
                .map_err(protocol_error)?;
        }
        self.transfers.push_back(Transfer {
            bulk,
            id,
            started: false,
            offset: 0,
            index: 0,
        });
        Ok(())
    }

    fn cancel(&mut self, target: &v5::cancel::Target) {
        self.transfers.retain(|transfer| match target {
            v5::cancel::Target::RequestId(id) => &transfer.bulk.request_id != id,
            v5::cancel::Target::TransferId(id) => &transfer.id != id,
        });
        if let v5::cancel::Target::RequestId(id) = target
            && let Some(work) = self.work.remove(id)
        {
            work.cancelled.store(true, Ordering::Release);
            if let Some(read) = work.read {
                read.abort();
            }
        }
    }

    fn feed_transfers(&mut self) -> Result<(), Error> {
        let mut position = 0;
        while position < self.transfers.len() {
            let transfer = &self.transfers[position];
            let end =
                (transfer.offset + limits::BULK_PIECE_BYTES as usize).min(transfer.bulk.body.len());
            let (ledger, body) = if !transfer.started {
                (
                    v5::LedgerClass::Normal,
                    v5::frame::Body::BulkStart(v5::BulkStart {
                        request_id: transfer.bulk.request_id.clone(),
                        transfer_id: transfer.id.clone(),
                        operation_id: transfer.bulk.operation_id,
                        type_name: transfer.bulk.type_name.clone(),
                        content_kind: transfer.bulk.content_kind as i32,
                        byte_count: transfer.bulk.body.len() as u64,
                        chunk_count: transfer
                            .bulk
                            .body
                            .len()
                            .div_ceil(limits::BULK_PIECE_BYTES as usize)
                            as u32,
                    }),
                )
            } else if transfer.offset < transfer.bulk.body.len() {
                (
                    v5::LedgerClass::Bulk,
                    v5::frame::Body::BulkPiece(v5::BulkPiece {
                        transfer_id: transfer.id.clone(),
                        index: transfer.index,
                        offset: transfer.offset as u64,
                        data: transfer.bulk.body[transfer.offset..end].to_vec(),
                    }),
                )
            } else {
                (
                    v5::LedgerClass::Normal,
                    v5::frame::Body::BulkEnd(v5::BulkEnd {
                        transfer_id: transfer.id.clone(),
                        byte_count: transfer.bulk.body.len() as u64,
                        outcome: Some(v5::bulk_end::Outcome::Success(v5::Empty {})),
                    }),
                )
            };
            let ending = matches!(body, v5::frame::Body::BulkEnd(_));
            match self
                .machine
                .enqueue(body.clone(), self.reserve(ledger, body), self.now())
            {
                Ok(()) if ending => {
                    self.transfers.remove(position);
                }
                Ok(()) => {
                    let transfer = &mut self.transfers[position];
                    if transfer.started {
                        transfer.offset = end;
                        transfer.index += 1;
                    }
                    transfer.started = true;
                    position += 1;
                }
                Err(ProtocolError::Limit) => position += 1,
                Err(error) => return Err(protocol_error(error)),
            }
        }
        Ok(())
    }
}
