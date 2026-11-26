use super::{ConnectionFailure, Control, Credentials, Error, Intent, Peer, State, quota};
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
use ycoding_core::event_feed::{Payload, Scope, Subscriber};
use ycoding_protocol::{
    CONTRACT_DIGEST,
    connection::{Config, Connection, Decision, ProtocolError},
    decode_compatible, limits, v5,
};

#[path = "events.rs"]
mod events;
#[path = "notifications.rs"]
mod notifications;

pub struct Settings {
    pub credentials: Arc<dyn Credentials>,
    pub reconnect_initial: Duration,
    pub reconnect_max: Duration,
    pub conflict_delay: Duration,
}

impl Settings {
    pub fn new(credentials: Arc<dyn Credentials>) -> Self {
        Self {
            credentials,
            reconnect_initial: Duration::from_secs(1),
            reconnect_max: Duration::from_secs(30),
            conflict_delay: Duration::from_secs(60),
        }
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
        pacing: Pacing {
            quota: quota::Quota::default(),
            feed: None,
            serial: 0,
        },
    };
    tasks.pacing.drain(&environment);
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
        tracing::debug!(?result, "remote connection attempt ended");
        reap(&mut tasks.jobs).await?;
        let terminal = match result {
            Err(Error::Unauthorized | Error::Forbidden) => Some(
                "The relay rejected this device. Enroll it again, then turn Remote connection on.",
            ),
            Err(Error::NotEnrolled) => {
                Some("Enroll this device first: ycoding remote enroll <enrollmentID>.")
            }
            Err(Error::EnrollmentStore) => Some(
                "Could not access remote-device.json. Check that the file is valid and private.",
            ),
            Err(Error::Incompatible) => Some(
                "The relay protocol is incompatible. Check that YCoding and the relay are up to date.",
            ),
            Err(Error::Setup) => Some(
                "Could not initialize the remote connector. Check the runtime log, then restart YCoding.",
            ),
            _ => None,
        };
        if let Some(message) = terminal {
            control.publish(current.generation, State::Error, Some(message));
            tokio::select! { _ = intent.changed() => { attempt = 0; }, _ = stopped.changed() => break }
            continue;
        }
        let (delay, message) = if result == Err(Error::Conflict) {
            (
                settings.conflict_delay,
                "Another connector is online for this device. Close that connection or wait for it to expire; retrying.",
            )
        } else {
            (
                settings
                    .reconnect_initial
                    .saturating_mul(2u32.saturating_pow(attempt))
                    .min(settings.reconnect_max),
                match result {
                    Err(Error::Connection(failure)) => failure.retry_message(),
                    _ => {
                        "Remote connection interrupted. Check the network and relay availability; retrying."
                    }
                },
            )
        };
        tracing::debug!(
            delay_ms = delay.as_millis() as u64,
            "remote connection retry scheduled"
        );
        attempt = attempt.saturating_add(1).min(30);
        control.publish(current.generation, State::Connecting, Some(message));
        tokio::select! { _ = tokio::time::sleep(delay) => {}, _ = intent.changed() => { attempt = 0; }, _ = stopped.changed() => break }
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

const QUOTA_REFRESH: Duration = Duration::from_secs(60);

struct Pacing {
    quota: quota::Quota,
    feed: Option<Subscriber>,
    serial: u64,
}

impl Pacing {
    fn drain(&mut self, environment: &Environment) {
        let Some(core) = environment.services.core.as_ref() else {
            return;
        };
        if self.feed.is_none() {
            self.feed = core
                .events
                .subscribe_types(Scope::Global, quota::TYPES, || {})
                .ok();
        }
        let now = ids::now_millis().max(0) as u64;
        while let Some(feed) = &self.feed {
            match feed.next() {
                Ok(Some(item)) => self.quota.offer_item(&item, now),
                Ok(None) => return,
                Err(_) => {
                    tracing::warn!("quota pace subscription overflowed; resubscribing");
                    self.feed = None;
                }
            }
        }
    }
}

struct DispatchTasks {
    jobs: Vec<JoinHandle<()>>,
    permits: Arc<Semaphore>,
    lanes: BTreeMap<String, Weak<Mutex<()>>>,
    pacing: Pacing,
}

struct Work {
    cancelled: Arc<AtomicBool>,
    read: Option<tokio::task::AbortHandle>,
    scope: v5::Scope,
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
    events: events::Interests,
    notifications: notifications::Notifications,
}

impl Drop for Driver {
    fn drop(&mut self) {
        self.events.environment.subscriptions.release(&self.epoch);
        self.peer.revoke();
        for work in self.work.values() {
            work.cancelled.store(true, Ordering::Release);
            if let Some(read) = &work.read {
                read.abort();
            }
        }
    }
}

impl ConnectionFailure {
    fn retry_message(self) -> &'static str {
        match self {
            Self::Credentials => "Could not refresh the Remote device credential; retrying.",
            Self::CredentialRenewal => "Refreshing the Remote device credential and reconnecting.",
            Self::UpgradeTimedOut => "Timed out opening the Remote WebSocket; retrying.",
            Self::UpgradeRefused(_) => "The relay declined the WebSocket upgrade; retrying.",
            Self::Tls => "Could not establish TLS with the Remote relay; retrying.",
            Self::Open => "Could not open the Remote socket to the relay; retrying.",
            Self::Read(_) => "Could not read from the Remote socket; retrying.",
            Self::Write => "Could not send data on the Remote socket; retrying.",
            Self::Closed {
                established: false, ..
            } => "The relay closed the connection before Remote became ready; retrying.",
            Self::Closed {
                established: true, ..
            } => "The relay closed the established Remote connection; retrying.",
            Self::EndedWithoutClose { established: false } => {
                "The Remote socket ended without a close frame before becoming ready; retrying."
            }
            Self::EndedWithoutClose { established: true } => {
                "The established Remote socket ended without a close frame; retrying."
            }
        }
    }
}

enum StartupStage {
    Inventory,
    Credentials,
    Socket,
}

fn startup_failure(error: Error, stage: StartupStage) {
    let cause = match error {
        Error::Unauthorized | Error::Forbidden => "authorization_rejected",
        Error::Setup | Error::Incompatible | Error::NotEnrolled | Error::EnrollmentStore => {
            "setup_failed"
        }
        _ => "startup_failed",
    };
    let (stage, kind) = match (stage, error) {
        (StartupStage::Inventory, _) => ("inventory", Some("server")),
        (StartupStage::Credentials, Error::Transport | Error::Connection(_)) => {
            ("credentials", Some("transport"))
        }
        (StartupStage::Credentials, _) => ("credentials", None),
        (StartupStage::Socket, Error::Transport | Error::Connection(_)) => {
            ("socket", Some("transport"))
        }
        (StartupStage::Socket, _) => ("socket", None),
    };
    if let Some(kind) = kind {
        tracing::warn!(cause, stage, kind, "remote connector failed");
    } else {
        tracing::warn!(cause, stage, "remote connector failed");
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
    tasks.pacing.serial = tasks.pacing.serial.wrapping_add(1);
    tasks.pacing.quota.begin();
    let serial = tasks.pacing.serial;
    let environment = Arc::new(Environment {
        services: environment.services.clone(),
        urls: environment.urls.clone(),
        subscriptions: crate::Subscriptions::default(),
        uploads: Default::default(),
    });
    let _staged = crate::session_attachment_upload::Release(environment.clone());
    let core = environment
        .services
        .core
        .as_ref()
        .ok_or(Error::Setup)
        .inspect_err(|error| startup_failure(*error, StartupStage::Inventory))?;
    core.sessions
        .list(&ycoding_core::session::list::Query::default())
        .map_err(|_| Error::Transport)
        .inspect_err(|error| startup_failure(*error, StartupStage::Inventory))?;
    if !control.current(intent.generation) {
        return Err(Error::Transport);
    }
    let (enrolled, credential) = tokio::time::timeout(Duration::from_secs(30), async {
        Ok::<_, Error>((
            settings.credentials.enrolled().await?,
            settings.credentials.access().await?,
        ))
    })
    .await
    .map_err(|_| Error::Transport)
    .and_then(|result| result)
    .map_err(|error| match error {
        Error::Transport => ConnectionFailure::Credentials.into(),
        error => error,
    })
    .inspect_err(|error| startup_failure(*error, StartupStage::Credentials))?;
    if !control.current(intent.generation) {
        return Err(Error::Transport);
    }
    let peer = credential
        .authenticate(&enrolled, ids::now_millis())
        .inspect_err(|error| startup_failure(*error, StartupStage::Credentials))?;
    let mut request = enrolled
        .url()
        .into_client_request()
        .map_err(|_| Error::Setup)?;
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
    .map_err(|_| Error::from(ConnectionFailure::UpgradeTimedOut))
    .inspect_err(|error| startup_failure(*error, StartupStage::Socket))?;
    let (mut socket, _) = upgrade
        .map_err(|error| match error {
            tungstenite::Error::Http(response) => {
                let status = response.status().as_u16();
                tracing::debug!(status, "remote relay declined websocket upgrade");
                match status {
                    401 => Error::Unauthorized,
                    403 => Error::Forbidden,
                    status => ConnectionFailure::UpgradeRefused(status).into(),
                }
            }
            tungstenite::Error::Tls(_) => ConnectionFailure::Tls.into(),
            _ => ConnectionFailure::Open.into(),
        })
        .inspect_err(|error| startup_failure(*error, StartupStage::Socket))?;
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
            event_types: BTreeSet::from([
                "ycoding.v5.SessionLogItem".into(),
                "ycoding.v5.PublicEvent".into(),
            ]),
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
        events: events::Interests::new(environment.clone()),
        notifications: notifications::Notifications::new(),
    };
    let subscriber = core
        .events
        .subscribe_types(Scope::Global, notifications::TYPES, || {})
        .map_err(|_| Error::Transport)?;
    driver.machine.start(0).map_err(|_| Error::Incompatible)?;
    let (completed, mut results) =
        mpsc::channel::<(String, Option<Settled>)>(limits::PENDING_REQUESTS as usize);
    let mut ticker = tokio::time::interval(Duration::from_millis(10));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut next_send = Instant::now();
    let mut next_quota_refresh = Instant::now() + QUOTA_REFRESH;
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
                driver.notification_event(core, &item)?;
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
        driver.feed_notifications(core)?;
        tasks.pacing.drain(&environment);
        if driver.established {
            if Instant::now() >= next_quota_refresh {
                tasks.pacing.quota.refresh();
                next_quota_refresh = Instant::now() + QUOTA_REFRESH;
            }
            let now = ids::now_millis().max(0) as u64;
            while let Some(quota) = tasks.pacing.quota.next(serial, now) {
                let body = v5::frame::Body::Control(v5::Control {
                    kind: Some(v5::control::Kind::QuotaPace(quota.clone())),
                });
                match driver.machine.enqueue(
                    body.clone(),
                    driver.reserve(v5::LedgerClass::Normal, body),
                    driver.now(),
                ) {
                    Ok(()) => tasks.pacing.quota.sent(&quota, serial),
                    Err(ProtocolError::Limit) => break,
                    Err(error) => return Err(protocol_error(error)),
                }
            }
        }
        if !control.current(intent.generation) {
            return Err(Error::Transport);
        }
        driver.feed_transfers()?;
        driver.feed_events()?;
        if Instant::now() >= next_send
            && let Some(prepared) = driver.machine.prepare_handoff(driver.now())
        {
            let bytes = prepared.frame().encode_to_vec();
            let association = match &prepared.frame().body {
                Some(v5::frame::Body::Result(result)) => Some(result.request_id.clone()),
                _ => None,
            };
            let length = bytes.len() as u64;
            tokio::time::timeout(
                Duration::from_millis(environment.services.budgets.delivery_timeout_ms),
                std::future::poll_fn(|context| socket.poll_ready_unpin(context)),
            )
            .await
            .map_err(|_| ConnectionFailure::Write)?
            .map_err(|_| ConnectionFailure::Write)?;
            if !control.current(intent.generation) {
                return Err(Error::Transport);
            }
            let decisions = driver
                .machine
                .handoff(prepared, length, driver.now())
                .map_err(protocol_error)?;
            if let Some(close) = decisions.into_iter().find_map(|decision| match decision {
                Decision::Closed(close) => Some(close),
                _ => None,
            }) {
                tracing::debug!(category = ?close.category, code = close.code, length, "remote connection closed at handoff");
                return Err(driver.protocol_close(close.category));
            }
            socket
                .start_send_unpin(tungstenite::Message::Binary(bytes.into()))
                .map_err(|_| ConnectionFailure::Write)?;
            if let Some(id) = association {
                driver.settle_subscription(&id)?;
            }
            tokio::time::timeout(
                Duration::from_millis(environment.services.budgets.delivery_timeout_ms),
                socket.flush(),
            )
            .await
            .map_err(|_| ConnectionFailure::Write)?
            .map_err(|_| ConnectionFailure::Write)?;
            next_send = Instant::now() + Duration::from_millis(25);
        }
        if let Some(close) = driver
            .machine
            .take_decisions()
            .into_iter()
            .find_map(|decision| match decision {
                Decision::Closed(close) => Some(close),
                _ => None,
            })
        {
            tracing::debug!(category = ?close.category, code = close.code, "remote connection closed while scheduling");
            return Err(driver.protocol_close(close.category));
        }
        tokio::select! {
            _ = &mut expiry => return Err(ConnectionFailure::CredentialRenewal.into()),
            _ = ticker.tick() => {},
            result = results.recv() => {
                let Some((id, settled)) = result else { return Err(Error::Transport); };
                if let Some(work) = driver.work.remove(&id) {
                    if work.cancelled.load(Ordering::Acquire) {
                        continue;
                    }
                    let settled = driver.subscription_result(settled, work.scope)?;
                    driver.complete(settled)?;
                }
            },
            incoming = socket.next() => {
                let bytes = match incoming {
                    Some(Ok(tungstenite::Message::Binary(bytes))) => bytes,
                    Some(Ok(tungstenite::Message::Ping(_) | tungstenite::Message::Pong(_))) => continue,
                    Some(Ok(tungstenite::Message::Close(close))) => {
                        let code = close.map(|frame| u16::from(frame.code));
                        tracing::debug!(?code, established = driver.established, "remote websocket closed by peer");
                        return Err(match code {
                            Some(4401) if driver.established => ConnectionFailure::CredentialRenewal.into(),
                            Some(4401) => Error::Unauthorized,
                            Some(4403) => Error::Forbidden,
                            Some(4409) => Error::Conflict,
                            code => ConnectionFailure::Closed { code, established: driver.established }.into(),
                        });
                    }
                    Some(Ok(tungstenite::Message::Text(_))) => return Err(Error::Incompatible),
                    Some(Err(tungstenite::Error::Capacity(error))) => {
                        tracing::debug!(?error, "remote websocket capacity failed");
                        return Err(Error::Incompatible);
                    },
                    Some(Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::Protocol(tungstenite::error::ProtocolError::ResetWithoutClosingHandshake))) | None => {
                        return Err(ConnectionFailure::EndedWithoutClose { established: driver.established }.into());
                    }
                    Some(Err(tungstenite::Error::Io(error))) => {
                        return Err(ConnectionFailure::Read(error.kind()).into());
                    }
                    Some(Err(tungstenite::Error::Protocol(_))) => {
                        tracing::debug!("remote websocket protocol failed");
                        return Err(Error::Incompatible);
                    },
                    _ => return Err(Error::Transport),
                };
                let token = driver.machine.admit_incoming(bytes.len() as u64).ok_or_else(|| {
                    tracing::debug!("remote frame admission failed");
                    Error::Incompatible
                })?;
                let frame = decode_compatible::<v5::Frame>(&bytes).map_err(|_| {
                    tracing::debug!("remote frame failed decoding");
                    Error::Incompatible
                })?;
                let peer_digest = if let Some(v5::frame::Body::Ready(ready)) = &frame.body {
                    driver.epoch = ready.connection_epoch.clone();
                    Some(ready.contract_digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>())
                } else {
                    None
                };
                let ordinal = frame.delivery_ordinal;
                let decisions = driver.machine.accept_incoming(&token, frame, driver.now()).map_err(protocol_error)?;
                for decision in decisions {
                    match decision {
                        Decision::Established => {
                            if let Some(peer_digest) = peer_digest.as_deref().filter(|digest| *digest != CONTRACT_DIGEST) {
                                tracing::warn!(local_digest = CONTRACT_DIGEST, peer_digest, "Contract digest differs");
                            }
                            opened.store(true, Ordering::Release);
                            driver.established = true;
                            control.publish(intent.generation, State::On, None);
                            let body = v5::frame::Body::Control(v5::Control { kind: Some(v5::control::Kind::InventoryInvalidated(v5::InventoryInvalidated {})) });
                            driver.machine.enqueue(body.clone(), driver.reserve(v5::LedgerClass::Normal, body), driver.now()).map_err(protocol_error)?;
                        },
                        Decision::Request(request) => {
                            driver.consume(ordinal)?;
                            let descriptor = dispatcher.descriptor(request.operation_id).ok_or(Error::Incompatible)?;
                            driver.stash_log(&request, &descriptor.diagnostic_name)?;
                            let mutation = descriptor.mutation == v5::MutationClass::Mutation as i32;
                            let cancelled = Arc::new(AtomicBool::new(false));
                            let cancellation = cancelled.clone();
                            let id = request.request_id.clone();
                            let request_id = id.clone();
                            let scope = request.scope.clone();
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
                            driver.work.insert(request_id, Work { cancelled, read: (!mutation).then(|| job.abort_handle()), scope });
                            tasks.jobs.push(job);
                        },
                        Decision::Control(control) => {
                            match control.kind {
                                Some(v5::control::Kind::Priority(_)) => {},
                                Some(v5::control::Kind::SubscriptionSnapshot(snapshot)) => driver.snapshot(snapshot, &dispatcher).await?,
                                Some(v5::control::Kind::QuotaPaceResult(result)) => tasks.pacing.quota.settle(&result),
                                _ => {
                                    tracing::debug!("remote control has no connector handler");
                                    return Err(Error::Incompatible);
                                },
                            }
                            driver.consume(ordinal)?;
                        },
                        Decision::CancelWork { target, mutation: _ } => driver.cancel(&target),
                        Decision::Closed(close) => {
                            let reason = close.reason();
                            tracing::debug!(category = ?close.category, code = close.code, %reason, "remote connection closed while receiving");
                            let _ = tokio::time::timeout(Duration::from_secs(1), socket.close(Some(tungstenite::protocol::CloseFrame { code: close.code.into(), reason: reason.as_ref().into() }))).await;
                            return Err(driver.protocol_close(close.category));
                        },
                        Decision::Send(_) => {},
                        _ => {
                            tracing::debug!("remote decision has no connector handler");
                            return Err(Error::Incompatible);
                        },
                    }
                }
            }
        }
    }
}

fn protocol_error(error: ProtocolError) -> Error {
    tracing::debug!(?error, "remote protocol operation failed");
    match error {
        ProtocolError::Limit | ProtocolError::Closed => Error::Transport,
        _ => Error::Incompatible,
    }
}

impl Driver {
    fn protocol_close(&self, category: ProtocolError) -> Error {
        if self.established {
            protocol_error(category)
        } else {
            Error::Incompatible
        }
    }

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
        if let v5::cancel::Target::RequestId(id) = target {
            self.events.associations.remove(id);
        }
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
