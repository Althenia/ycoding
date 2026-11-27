use super::{
    Acceptors, Ambient, Borrowed, Link, Opened, Opener, Prepare, PrepareError, Registry, Rejection,
    Resources, ServeFailed, Settings, Source, Supervisor, Transport, run::key_json,
};
use crate::dots::carrier::{
    Clock, Connect, ConnectError, Socket, executor, relay,
    relay_wire::{self as wire, Body, Frame},
    test_support::{self, TestClock, TestDial, TestSocket},
};
use futures_util::{SinkExt, StreamExt};
use std::{
    collections::VecDeque,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Semaphore, mpsc};
use tokio_tungstenite::tungstenite::Message;
use ycoding_core::{
    dots::{
        access,
        enrollment::{self, registry},
        native, noise,
    },
    ycoding_schema::{JsonValue, LosslessString, parse_json},
};

struct Directory(PathBuf);
impl Directory {
    fn new() -> Arc<Self> {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "ycoding-dots-supervisor-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Arc::new(Self(path))
    }
    fn state(&self) -> PathBuf {
        self.0.join("cca-executor.json")
    }
    fn home(&self) -> PathBuf {
        self.0.join("home")
    }
    fn data(&self) -> PathBuf {
        self.0.join("data")
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn enabled(revision: u64, credential_id: &str, account_id: &str) -> native::Configuration {
    native::Configuration::Enabled {
        access_revision: revision,
        profile: "selected".into(),
        credential_id: credential_id.into(),
        account_id: account_id.into(),
        account_generation: 1,
    }
}

type ChangeListener = (u64, Arc<dyn Fn() + Send + Sync>);

struct World {
    configuration: Mutex<native::Configuration>,
    listeners: Mutex<Vec<ChangeListener>>,
    next_listener: AtomicUsize,
    credential_calls: AtomicUsize,
    credential_fails: AtomicBool,
    stale_credential: Mutex<Option<String>>,
    name: Mutex<Option<LosslessString>>,
}

impl World {
    fn new(configuration: native::Configuration) -> Arc<Self> {
        Arc::new(Self {
            configuration: Mutex::new(configuration),
            listeners: Mutex::new(Vec::new()),
            next_listener: AtomicUsize::new(1),
            credential_calls: AtomicUsize::new(0),
            credential_fails: AtomicBool::new(false),
            stale_credential: Mutex::new(None),
            name: Mutex::new(None),
        })
    }

    fn set(&self, configuration: native::Configuration) {
        *self.configuration.lock().unwrap() = configuration;
        let listeners = self
            .listeners
            .lock()
            .unwrap()
            .iter()
            .map(|(_, listener)| listener.clone())
            .collect::<Vec<_>>();
        for listener in listeners {
            listener();
        }
    }

    fn listeners(&self) -> usize {
        self.listeners.lock().unwrap().len()
    }

    fn source(self: &Arc<Self>) -> Source {
        let (configuration, credential, name, subscribe) =
            (self.clone(), self.clone(), self.clone(), self.clone());
        Source {
            configuration: Arc::new(move || {
                Ok(configuration.configuration.lock().unwrap().clone())
            }),
            credential: Arc::new(move |profile, _rejected| {
                let world = credential.clone();
                Box::pin(async move {
                    world.credential_calls.fetch_add(1, Ordering::SeqCst);
                    if world.credential_fails.load(Ordering::SeqCst) {
                        return Err(access::Error::Unavailable);
                    }
                    let native::Configuration::Enabled {
                        credential_id,
                        account_id,
                        account_generation,
                        ..
                    } = world.configuration.lock().unwrap().clone()
                    else {
                        return Ok(None);
                    };
                    let credential_id = world
                        .stale_credential
                        .lock()
                        .unwrap()
                        .clone()
                        .unwrap_or(credential_id);
                    Ok(Some(native::ResolvedCredential {
                        profile,
                        access_token: format!("token-{credential_id}"),
                        credential_id,
                        account_id,
                        account_generation,
                    }))
                })
            }),
            name: Arc::new(move || name.name.lock().unwrap().clone()),
            subscribe: Arc::new(move |listener| {
                let id = subscribe.next_listener.fetch_add(1, Ordering::SeqCst) as u64;
                subscribe.listeners.lock().unwrap().push((id, listener));
                let world = subscribe.clone();
                native::Subscription::new(move || {
                    world
                        .listeners
                        .lock()
                        .unwrap()
                        .retain(|(held, _)| *held != id);
                })
            }),
        }
    }
}

#[derive(Clone, Debug)]
struct RegisterCall {
    environment_id: String,
    token: String,
    key: JsonValue,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ValidateCall {
    token: String,
    registration_id: String,
    stream_id: String,
    authorization: String,
}

#[derive(Default)]
struct FakeRegistry {
    script: Mutex<VecDeque<Result<(), registry::Error>>>,
    registered: Mutex<Vec<RegisterCall>>,
    validated: Mutex<Vec<ValidateCall>>,
}

impl Registry for FakeRegistry {
    fn register<'a>(
        &'a self,
        environment_id: &'a str,
        credential: &'a mut Arc<native::ResolvedCredential>,
        _refresh: Option<&'a registry::Refresh>,
        executor_public_key: JsonValue,
    ) -> Borrowed<'a, Result<registry::Registered, registry::Error>> {
        let number = {
            let mut registered = self.registered.lock().unwrap();
            registered.push(RegisterCall {
                environment_id: environment_id.to_owned(),
                token: credential.access_token.clone(),
                key: executor_public_key,
            });
            registered.len()
        };
        let outcome = self.script.lock().unwrap().pop_front().unwrap_or(Ok(()));
        let environment_id = environment_id.to_owned();
        Box::pin(async move {
            outcome.map(|()| registry::Registered {
                environment_id,
                executor_registration_id: format!("registration-{number}"),
                url: "wss://rendezvous.chatgpt.com/ws".into(),
                security_profile: registry::SECURITY_PROFILE.into(),
            })
        })
    }

    fn validate<'a>(
        &'a self,
        _environment_id: &'a str,
        credential: &'a mut Arc<native::ResolvedCredential>,
        _refresh: Option<&'a registry::Refresh>,
        executor_registration_id: &'a str,
        _harness_public_key: JsonValue,
        authorization: &'a str,
        stream_id: &'a str,
    ) -> Borrowed<'a, Result<(), registry::Error>> {
        self.validated.lock().unwrap().push(ValidateCall {
            token: credential.access_token.clone(),
            registration_id: executor_registration_id.to_owned(),
            stream_id: stream_id.to_owned(),
            authorization: authorization.to_owned(),
        });
        Box::pin(async { Ok(()) })
    }
}

struct Plain;
impl relay::Cipher for Plain {
    fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, ()> {
        Ok(plaintext.to_vec())
    }
    fn decrypt(&self, ciphertext: &[u8]) -> Result<Vec<u8>, ()> {
        Ok(ciphertext.to_vec())
    }
}

struct Accepting {
    gate: Option<Arc<Semaphore>>,
}
impl relay::Acceptor for Accepting {
    fn accept(
        &self,
        _: &str,
        _: Vec<u8>,
        authorize: relay::Authorize,
    ) -> Pin<Box<dyn Future<Output = Result<relay::Accepted, ()>> + Send>> {
        let gate = self.gate.clone();
        Box::pin(async move {
            if let Some(gate) = gate {
                gate.acquire().await.unwrap().forget();
            }
            authorize(
                noise::PublicKey {
                    suite: "suite".into(),
                    x25519_public_key: "eA==".into(),
                    mlkem768_public_key: "bQ==".into(),
                },
                "harness-authorization".into(),
            )
            .await?;
            Ok(relay::Accepted {
                response: b"handshake-response".to_vec(),
                cipher: Arc::new(Plain),
            })
        })
    }
}

type Reply = enrollment::ExecutorResponse;

fn reply(status: u16, body: &str) -> Reply {
    enrollment::ExecutorResponse {
        status,
        challenged: false,
        body: body.to_owned(),
    }
}

fn registered_reply(executor_id: &str) -> Reply {
    reply(
        200,
        &format!(r#"{{"executor_id":"{executor_id}","custom_display_name":null}}"#),
    )
}

#[derive(Default)]
struct Posts {
    replies: Mutex<VecDeque<Reply>>,
    sent: Mutex<Vec<(String, String)>>,
}

impl Posts {
    fn post(self: &Arc<Self>) -> enrollment::ExecutorPost {
        let posts = self.clone();
        Arc::new(move |request: enrollment::ExecutorRequest| {
            posts.sent.lock().unwrap().push((
                request.credential.access_token.clone(),
                request.body.clone(),
            ));
            let next = posts
                .replies
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| registered_reply("exec-1"));
            Box::pin(async move { Ok(next) }) as native::NativeFuture<'static, Reply>
        })
    }
}

#[derive(Clone, Copy)]
enum Mode {
    Panic,
    Hold,
    Fail,
    Sessions,
}

#[derive(Default)]
struct Log {
    opened: Mutex<Vec<(String, String)>>,
    session: Mutex<Option<String>>,
    created: AtomicUsize,
    resumed: AtomicUsize,
    closed: Arc<AtomicUsize>,
    fail_close: Arc<AtomicBool>,
}

struct Probe {
    closed: Arc<AtomicUsize>,
    fail_close: Arc<AtomicBool>,
}
impl Resources for Probe {
    fn initialize<'a>(
        &'a self,
        _: &'a ycoding_core::ycoding_schema::LosslessString,
        _: Link,
    ) -> Borrowed<'a, Result<String, Rejection>> {
        Box::pin(async { Ok("session-1".to_owned()) })
    }
    fn close(&self) -> Borrowed<'_, Result<(), ()>> {
        Box::pin(async move {
            self.closed.fetch_add(1, Ordering::SeqCst);
            if self.fail_close.load(Ordering::SeqCst) {
                Err(())
            } else {
                Ok(())
            }
        })
    }
}

fn serve(mode: Mode, log: Arc<Log>) -> super::Serve {
    Arc::new(move |opened: Opened| {
        let log = log.clone();
        Box::pin(async move {
            log.opened.lock().unwrap().push((
                opened.channel.stream_id().to_owned(),
                opened.environment_id.clone(),
            ));
            opened.summary.received("initialize", false);
            match mode {
                Mode::Panic => panic!("synthetic serving task panic"),
                Mode::Fail => Err(ServeFailed),
                Mode::Hold => {
                    std::future::pending::<()>().await;
                    Ok(())
                }
                Mode::Sessions => {
                    let (created, closed, fail_close) =
                        (log.clone(), log.closed.clone(), log.fail_close.clone());
                    let open: Opener = Arc::new(move || {
                        created.created.fetch_add(1, Ordering::SeqCst);
                        let probe: Arc<dyn Resources> = Arc::new(Probe {
                            closed: closed.clone(),
                            fail_close: fail_close.clone(),
                        });
                        Box::pin(async move { Ok(probe) })
                    });
                    let connection = opened.sessions.connect(open);
                    let existing = log.session.lock().unwrap().clone();
                    match existing {
                        None => {
                            let id = connection
                                .initialize(
                                    &ycoding_core::ycoding_schema::LosslessString::from("client"),
                                    Arc::new(()),
                                )
                                .await
                                .map_err(|_| ServeFailed)?;
                            *log.session.lock().unwrap() = Some(id);
                        }
                        Some(id) => {
                            connection
                                .resume(&id, Arc::new(()))
                                .await
                                .map_err(|_| ServeFailed)?;
                            log.resumed.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                    std::future::pending::<()>().await;
                    Ok(())
                }
            }
        })
    })
}

struct Options {
    directory: Arc<Directory>,
    configuration: native::Configuration,
    mode: Mode,
    gated: bool,
    name: Option<&'static str>,
    dial_failures: Vec<Option<u16>>,
    registrations: Vec<Result<(), registry::Error>>,
    replies: Vec<Reply>,
}

fn options() -> Options {
    Options {
        directory: Directory::new(),
        configuration: enabled(1, "credential-1", "account-1"),
        mode: Mode::Hold,
        gated: false,
        name: None,
        dial_failures: Vec::new(),
        registrations: Vec::new(),
        replies: Vec::new(),
    }
}

struct Harness {
    supervisor: Arc<Supervisor>,
    world: Arc<World>,
    registry: Arc<FakeRegistry>,
    posts: Arc<Posts>,
    log: Arc<Log>,
    peers: mpsc::UnboundedReceiver<TestSocket>,
    clock: TestClock,
    armed: mpsc::UnboundedReceiver<u64>,
    lines: Arc<Mutex<Vec<String>>>,
    cleanup_failed: tokio::sync::watch::Receiver<bool>,
    dials: Arc<AtomicUsize>,
    identities: Arc<Mutex<Vec<noise::PublicKey>>>,
    gate: Arc<Semaphore>,
    _directory: Arc<Directory>,
}

fn connector(
    dial: TestDial,
    dials: Arc<AtomicUsize>,
    failures: Arc<Mutex<VecDeque<Option<u16>>>>,
) -> Connect {
    Arc::new(move |_request| {
        dials.fetch_add(1, Ordering::SeqCst);
        let failure = failures.lock().unwrap().pop_front();
        let socket = dial();
        Box::pin(async move {
            if let Some(status) = failure {
                return Err(ConnectError { status });
            }
            socket
                .await
                .map(|socket| Box::new(socket) as Socket)
                .map_err(|_| ConnectError { status: None })
        }) as Pin<Box<dyn Future<Output = Result<Socket, ConnectError>> + Send>>
    })
}

async fn start_held(options: Options) -> Result<Harness, PrepareError> {
    let world = World::new(options.configuration);
    *world.name.lock().unwrap() = options.name.map(LosslessString::from);
    let registry = Arc::new(FakeRegistry::default());
    registry
        .script
        .lock()
        .unwrap()
        .extend(options.registrations);
    let posts = Arc::new(Posts::default());
    posts.replies.lock().unwrap().extend(options.replies);
    let log = Arc::new(Log::default());
    let (dial, peers) = test_support::dial();
    let (clock, armed) = test_support::clock();
    let lines = Arc::new(Mutex::new(Vec::new()));
    let (cleanup_failed, observed_cleanup_failure) = tokio::sync::watch::channel(false);
    let cleanup_failed_diagnostic =
        format!("CCA executor {}", super::Diagnostic::CleanupFailed.name());
    let dials = Arc::new(AtomicUsize::new(0));
    let failures = Arc::new(Mutex::new(VecDeque::from(options.dial_failures)));
    let identities = Arc::new(Mutex::new(Vec::new()));
    let gate = Arc::new(Semaphore::new(0));
    let acceptors: Acceptors = {
        let (identities, gate, gated) = (identities.clone(), gate.clone(), options.gated);
        Arc::new(move |identity, _, _| {
            identities
                .lock()
                .unwrap()
                .push(identity.public_key().clone());
            Arc::new(Accepting {
                gate: gated.then(|| gate.clone()),
            })
        })
    };
    let shared_clock: Arc<dyn Clock> = Arc::new(clock.clone());
    let sink = lines.clone();
    let settings = Settings {
        source: world.source(),
        transport: Transport {
            connect: connector(dial, dials.clone(), failures),
            registry: registry.clone(),
            acceptors,
        },
        ambient: Ambient {
            clock: shared_clock,
            random: Arc::new(|| 0.0),
            entropy: Arc::new(|| "0123456789abcdef0123456789abcdef".to_owned()),
        },
        post: posts.post(),
        installation: Box::new(|| Box::pin(async { Some("inst-1".to_owned()) })),
        state_path: options.directory.state(),
        hostname: "synthetic-host".into(),
        home: options.directory.home(),
        data: options.directory.data(),
        detached_ttl_ms: 30_000,
        diagnostic: Arc::new(move |line| {
            sink.lock().unwrap().push(line.to_owned());
            if line == cleanup_failed_diagnostic.as_str() {
                cleanup_failed.send_replace(true);
            }
        }),
        prepare: Box::new(|| Box::pin(async { Ok(()) })),
        serve: serve(options.mode, log.clone()),
    };
    let supervisor = Supervisor::start(settings).await?;
    Ok(Harness {
        supervisor,
        world,
        registry,
        posts,
        log,
        peers,
        clock,
        armed,
        lines,
        cleanup_failed: observed_cleanup_failure,
        dials,
        identities,
        gate,
        _directory: options.directory,
    })
}

async fn start(options: Options) -> Harness {
    start_held(options).await.ok().unwrap()
}

impl Harness {
    async fn peer(&mut self) -> TestSocket {
        tokio::time::timeout(Duration::from_secs(5), self.peers.recv())
            .await
            .expect("no connection dialed")
            .unwrap()
    }

    async fn armed(&mut self, deadline: u64) {
        let wait = async {
            loop {
                if self.armed.recv().await.unwrap() == deadline {
                    return;
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(5), wait)
            .await
            .unwrap_or_else(|_| panic!("deadline {deadline} was never armed"));
    }

    fn lines(&self) -> Vec<String> {
        self.lines.lock().unwrap().clone()
    }

    fn has(&self, line: &str) -> bool {
        self.lines().iter().any(|candidate| candidate == line)
    }

    async fn until(&self, mut condition: impl FnMut(&Self) -> bool) {
        for _ in 0..500 {
            if condition(self) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition was not reached; diagnostics: {:?}", self.lines());
    }

    async fn stop(self) {
        tokio::time::timeout(Duration::from_secs(5), self.supervisor.shutdown())
            .await
            .expect("shutdown did not finish")
            .expect("shutdown failed");
    }

    fn registrations(&self) -> usize {
        self.registry.registered.lock().unwrap().len()
    }
}

fn field(body: &str, name: &str) -> Option<String> {
    let Ok(JsonValue::Object(object)) = parse_json(body) else {
        return None;
    };
    match object.get(&name.into()) {
        Some(JsonValue::String(value)) => value.to_utf8().ok(),
        _ => None,
    }
}

async fn recorded(
    directory: &Directory,
    ready: impl Fn(&executor::Record) -> bool,
) -> executor::Record {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(Some(record)) = executor::load(&directory.state()).await
                && ready(&record)
            {
                return record;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the stored record never reached the expected state")
}

async fn open(peer: &mut TestSocket, stream: &str) {
    let handshake = wire::encode(&Frame::new(
        stream,
        Body::Handshake {
            payload: vec![1, 2, 3],
        },
    ));
    peer.send(Message::Binary(handshake.into())).await.unwrap();
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), peer.next())
            .await
            .expect("no handshake reply")
            .unwrap()
            .unwrap();
        if let Message::Binary(bytes) = message
            && wire::decode(&bytes)
                == Ok(Frame::new(
                    stream,
                    Body::Handshake {
                        payload: b"handshake-response".to_vec(),
                    },
                ))
        {
            return;
        }
    }
}

async fn closed(peer: &mut TestSocket) {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), peer.next())
            .await
            .expect("socket stayed open")
        {
            None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
            Some(Ok(_)) => {}
        }
    }
}

async fn assert_rejected_preparation(
    directory: Arc<Directory>,
    prepare: Prepare,
) -> super::PrepareError {
    let world = World::new(enabled(1, "credential-1", "account-1"));
    let registry = Arc::new(FakeRegistry::default());
    let posts = Arc::new(Posts::default());
    let dials = Arc::new(AtomicUsize::new(0));
    let installations = Arc::new(AtomicUsize::new(0));
    let installed = installations.clone();
    let (dial, _peers) = test_support::dial();
    let (clock, _armed) = test_support::clock();
    let shared_clock: Arc<dyn Clock> = Arc::new(clock);
    let settings = Settings {
        source: world.source(),
        transport: Transport {
            connect: connector(dial, dials.clone(), Arc::default()),
            registry: registry.clone(),
            acceptors: Arc::new(|_, _, _| Arc::new(Accepting { gate: None })),
        },
        ambient: Ambient {
            clock: shared_clock,
            random: Arc::new(|| 0.0),
            entropy: Arc::new(String::new),
        },
        post: posts.post(),
        installation: Box::new(move || {
            let installed = installed.clone();
            Box::pin(async move {
                installed.fetch_add(1, Ordering::SeqCst);
                Some("inst-1".to_owned())
            })
        }),
        state_path: directory.state(),
        hostname: "synthetic-host".into(),
        home: directory.home(),
        data: directory.data(),
        detached_ttl_ms: 30_000,
        diagnostic: Arc::new(|_| {}),
        prepare,
        serve: serve(Mode::Hold, Arc::default()),
    };
    let error = match Supervisor::start(settings).await {
        Err(error) => error,
        Ok(supervisor) => {
            supervisor.shutdown().await.unwrap();
            panic!("start succeeded past a held preparation")
        }
    };
    assert_eq!(world.listeners(), 0);
    assert_eq!(world.credential_calls.load(Ordering::SeqCst), 0);
    assert_eq!(installations.load(Ordering::SeqCst), 0);
    assert_eq!(dials.load(Ordering::SeqCst), 0);
    assert!(posts.sent.lock().unwrap().is_empty());
    assert!(registry.registered.lock().unwrap().is_empty());
    assert!(!directory.state().exists());
    error
}

async fn assert_held_preparation(directory: Arc<Directory>, prepare: Prepare, expected: &str) {
    match assert_rejected_preparation(directory, prepare).await {
        super::PrepareError::Held { reason } => assert_eq!(reason, expected),
        super::PrepareError::Failed(error) => panic!("intended hold became a failure: {error:?}"),
    }
}

#[tokio::test]
async fn a_held_preparation_blocks_start_before_any_effect() {
    let prepare: Prepare = Box::new(|| {
        Box::pin(async {
            Err(PrepareError::Held {
                reason: "operator skill provisioning is held",
            })
        })
    });
    assert_held_preparation(
        Directory::new(),
        prepare,
        "operator skill provisioning is held",
    )
    .await;
}

#[tokio::test]
async fn operator_provisioning_failure_prevents_preflight_and_enrollment() {
    let directory = Directory::new();
    let skill = directory
        .data()
        .join("dots/skills/session-operator/SKILL.md");
    std::fs::create_dir_all(&skill).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let called = calls.clone();
    let next: Prepare = Box::new(move || {
        Box::pin(async move {
            called.fetch_add(1, Ordering::SeqCst);
            Err(PrepareError::Held {
                reason: "upstream TLS preparation failed",
            })
        })
    });
    let prepare = crate::dots::carrier::operator::prepare(directory.data(), next);
    assert_held_preparation(directory, prepare, "operator skill provisioning failed").await;
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn preflight_failure_after_operator_provisioning_prevents_enrollment() {
    let directory = Directory::new();
    let skill = directory
        .data()
        .join("dots/skills/session-operator/SKILL.md");
    let calls = Arc::new(AtomicUsize::new(0));
    let called = calls.clone();
    let next: Prepare = Box::new(move || {
        Box::pin(async move {
            let bytes = tokio::fs::read(skill).await.unwrap();
            assert_eq!(bytes.len(), 30_366);
            assert_eq!(
                ycoding_core::session::prompt_cache::sha256(std::str::from_utf8(&bytes).unwrap()),
                "241dae490283dd37951d7e415d290d2876bf3cf45b55004f4489b455ab2383b9",
            );
            called.fetch_add(1, Ordering::SeqCst);
            Err(PrepareError::Held {
                reason: "upstream TLS preparation failed",
            })
        })
    });
    let prepare = crate::dots::carrier::operator::prepare(directory.data(), next);
    assert_held_preparation(directory, prepare, "upstream TLS preparation failed").await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn unbacked_advertisement_after_operator_and_preflight_prevents_enrollment() {
    use crate::dots::carrier::executor_rpc::{core_adapter, readiness, types};
    let directory = Directory::new();
    let skill = directory
        .data()
        .join("dots/skills/session-operator/SKILL.md");
    let calls = Arc::new(AtomicUsize::new(0));
    let called = calls.clone();
    let next: Prepare = Box::new(move || {
        Box::pin(async move {
            assert!(tokio::fs::metadata(skill).await.unwrap().is_file());
            called.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    });
    let advertised = types::EnvironmentInfo {
        shell: types::ShellInfo {
            name: "sh".into(),
            path: "/bin/sh".into(),
        },
        executor_version: None,
        provider_id: None,
        cwd: types::Presence::Absent,
        user_home_dir: types::Presence::Absent,
        platform_os: types::Presence::Absent,
        prepend_path_dirs: None,
        temporary_directories: None,
        temp_dir: types::Presence::Absent,
        capabilities: types::EnvironmentCapabilities {
            credential_masking: Some(true),
            ..Default::default()
        },
    };
    let preflight = readiness::prepare(
        next,
        advertised,
        types::BackendFeatures {
            credential_masking: false,
            ..core_adapter::backend_features()
        },
    );
    let prepare = crate::dots::carrier::operator::prepare(directory.data(), preflight);
    assert_held_preparation(
        directory,
        prepare,
        "advertised capability credentialMasking is not backed",
    )
    .await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

fn native_configuration(
    fixture: &test_support::HostFixture,
) -> (
    Arc<ycoding_core::resources::config::Configuration>,
    ycoding_core::resources::config::Roots,
) {
    use ycoding_core::resources::config;
    let directory = fixture.state_path().parent().unwrap().to_owned();
    let roots = config::Roots::runtime(
        &directory,
        &directory.join("tmp"),
        &std::collections::BTreeMap::from([(
            "YCODING_CONFIG_DIR".into(),
            directory.join("global").to_str().unwrap().into(),
        )]),
    )
    .unwrap();
    let global = config::Configuration::load(config::LoadOptions {
        directory,
        roots: roots.clone(),
        project: false,
        file: None,
        content: None,
        env: Default::default(),
    })
    .unwrap();
    (Arc::new(global), roots)
}

#[tokio::test]
async fn disabled_default_keeps_host_and_computer_administration_without_executor_effects() {
    use crate::dots::{NativeExecutor, NativeTransport, executor_configured};
    let fixture = test_support::HostFixture::new().await;
    let (global, roots) = native_configuration(&fixture);
    std::fs::write(roots.config.join("ycoding.json"), "{}").unwrap();
    assert!(!executor_configured(&global).unwrap());
    let state = Arc::new(NativeExecutor::Disabled);
    let transport = Arc::new(NativeTransport::new(
        fixture.host.clone(),
        fixture.state_path(),
        state,
    ));
    let attachment = fixture.host.attach_transport(transport).unwrap();
    let status = fixture.access.status().await.unwrap();
    assert_eq!(status.connection.state, "off");
    assert!(status.computer.is_some());
    assert!(!roots.state.join("cca-proxy").exists());
    assert!(!fixture.state_path().exists());
    assert!(
        !fixture
            .state_path()
            .with_file_name("cca-executor.json")
            .exists()
    );
    attachment.release();
    assert_eq!(
        fixture.access.status().await.unwrap().connection.state,
        "unavailable"
    );
    fixture.host.close();
}

#[tokio::test]
async fn configured_off_keeps_the_executor_gate_and_can_enable_access_later() {
    use crate::dots::{NativeExecutor, NativeTransport, executor_configured};
    let fixture = test_support::HostFixture::new().await;
    let (global, _) = native_configuration(&fixture);
    let revision = fixture.access.get().unwrap().revision;
    fixture.access.set(false, revision).await.unwrap();
    assert!(matches!(
        fixture.host.configuration().unwrap(),
        native::Configuration::Disabled
    ));
    assert!(executor_configured(&global).unwrap());
    let state = Arc::new(NativeExecutor::Held("synthetic upstream prerequisite"));
    let transport = Arc::new(NativeTransport::new(
        fixture.host.clone(),
        fixture.state_path(),
        state.clone(),
    ));
    let attachment = fixture.host.attach_transport(transport).unwrap();
    assert_eq!(
        fixture.access.status().await.unwrap().connection.state,
        "off"
    );
    let revision = fixture.access.get().unwrap().revision;
    fixture.access.set(true, revision).await.unwrap();
    assert!(matches!(
        fixture.host.configuration().unwrap(),
        native::Configuration::Enabled { .. }
    ));
    assert!(executor_configured(&global).unwrap());
    assert_eq!(state.held_reason(), Some("synthetic upstream prerequisite"));
    assert_eq!(
        fixture.access.status().await.unwrap().connection.state,
        "error"
    );
    assert!(!fixture.state_path().exists());
    assert!(
        !fixture
            .state_path()
            .with_file_name("cca-executor.json")
            .exists()
    );
    attachment.release();
    fixture.host.close();
}

#[tokio::test]
async fn configured_hold_is_retained_and_status_transport_preserves_computer_target_checks() {
    use crate::dots::{NativeExecutor, NativeTransport};
    let fixture = test_support::HostFixture::new().await;
    let state = Arc::new(NativeExecutor::Held("synthetic verifier prerequisite"));
    let transport = NativeTransport::new(fixture.host.clone(), fixture.state_path(), state.clone());
    assert_eq!(state.held_reason(), Some("synthetic verifier prerequisite"));
    let status = access::Transport::status(&transport).await.unwrap();
    assert_eq!(status.state, "error");
    assert_eq!(status.problem, None);
    assert_eq!(status.hostname, None);
    let target = access::ComputerTarget {
        dot_id: "synthetic-dot".into(),
        thread_id: "synthetic-thread".into(),
        environment_id: "synthetic-environment".into(),
        revision: "0".repeat(64),
    };
    let input = access::ComputerAttach {
        replace_others: false,
        expected_target: Some(target),
    };
    let direct = transport.control.attach(input.clone()).await;
    let delegated = access::Transport::attach_computer(&transport, input).await;
    assert_eq!(delegated, Ok(direct));
    assert_eq!(
        access::Transport::computer(&transport).await,
        Ok(transport.control.computer().await)
    );
    assert!(!fixture.state_path().exists());
    assert!(
        !fixture
            .state_path()
            .with_file_name("cca-executor.json")
            .exists()
    );
    fixture.host.close();
}

#[tokio::test]
async fn captured_startup_environment_survives_the_real_registry_move() {
    use crate::dots::NativePreparation;
    use std::collections::BTreeMap;
    use ycoding_core::resources::{auth, credential};
    let fixture = test_support::Fixture::default();
    let directory = Directory::new();
    let (home, data) = (directory.home(), directory.data());
    let mut environment = BTreeMap::from([
        ("SHELL".into(), "/synthetic/startup-shell".into()),
        ("SSL_CERT_FILE".into(), "/synthetic/startup-ca.pem".into()),
        ("TMPDIR".into(), "/synthetic/startup-temp".into()),
    ]);
    let preparation = NativePreparation::capture(home.clone(), data.clone(), &environment);
    environment.insert("SHELL".into(), "/synthetic/changed-shell".into());
    let registry = auth::integration::Registry::prepared(
        credential::Service::new(fixture.store.client()),
        environment,
        auth::Preparation::default(),
        None,
    );
    assert_eq!(preparation.home, home);
    assert_eq!(preparation.data, data);
    assert_eq!(
        preparation.environment.get("SHELL").unwrap(),
        "/synthetic/startup-shell"
    );
    assert_eq!(
        preparation.environment.get("SSL_CERT_FILE").unwrap(),
        "/synthetic/startup-ca.pem"
    );
    assert_eq!(
        preparation.environment.get("TMPDIR").unwrap(),
        "/synthetic/startup-temp"
    );
    registry.shutdown().await.unwrap();
}

#[tokio::test]
async fn owned_connection_status_tracks_connection_loss_and_joined_shutdown() {
    let mut harness = start(options()).await;
    let mut peer = harness.peer().await;
    harness.until(|h| h.has("CCA executor connected")).await;
    assert_eq!(harness.supervisor.connection_status().state, "connected");
    let original = harness.world.configuration.lock().unwrap().clone();
    *harness.world.configuration.lock().unwrap() = enabled(2, "credential-2", "account-2");
    assert_eq!(harness.supervisor.connection_status().state, "connecting");
    *harness.world.configuration.lock().unwrap() = original;
    peer.close(None).await.unwrap();
    harness
        .until(|h| h.has("CCA executor connection-dropped"))
        .await;
    assert_ne!(harness.supervisor.connection_status().state, "connected");
    let supervisor = harness.supervisor.clone();
    harness.stop().await;
    assert_eq!(supervisor.connection_status().state, "off");
}

#[tokio::test]
async fn failed_preparation_keeps_its_cause_without_becoming_a_hold_or_starting_effects() {
    use ycoding_core::cca::error::ExecutorError;
    let expected = ExecutorError::new(-32603, "synthetic preparation cause");
    let failure = expected.clone();
    let directory = Directory::new();
    let prepare: Prepare =
        Box::new(move || Box::pin(async move { Err(super::PrepareError::Failed(failure)) }));
    let prepare = crate::dots::carrier::operator::prepare(directory.data(), prepare);
    match assert_rejected_preparation(directory, prepare).await {
        super::PrepareError::Failed(actual) => assert_eq!(actual, expected),
        super::PrepareError::Held { reason } => panic!("real failure became a hold: {reason}"),
    }
}

#[tokio::test]
async fn a_disabled_configuration_idles_until_enabled_and_stops_when_disabled_again() {
    let mut harness = start(Options {
        configuration: native::Configuration::Disabled,
        ..options()
    })
    .await;
    assert_eq!(harness.world.listeners(), 1);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(harness.world.credential_calls.load(Ordering::SeqCst), 0);
    assert_eq!(harness.dials.load(Ordering::SeqCst), 0);

    harness.world.set(enabled(1, "credential-1", "account-1"));
    let mut peer = harness.peer().await;
    assert_eq!(harness.registrations(), 1);
    assert_eq!(
        harness.registry.registered.lock().unwrap()[0].environment_id,
        "exec-1"
    );
    harness.until(|h| h.has("CCA executor connected")).await;

    harness.world.set(native::Configuration::Disabled);
    closed(&mut peer).await;
    harness.stop().await;
}

#[tokio::test]
async fn shutdown_closes_the_connection_unsubscribes_and_ignores_later_changes() {
    let mut harness = start(options()).await;
    let mut peer = harness.peer().await;
    harness.until(|h| h.has("CCA executor connected")).await;
    assert_eq!(harness.world.listeners(), 1);
    let world = harness.world.clone();
    let dials = harness.dials.clone();
    harness.stop().await;
    closed(&mut peer).await;
    assert_eq!(world.listeners(), 0);
    world.set(enabled(2, "credential-1", "account-1"));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(dials.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_rotated_credential_with_the_same_label_replaces_identity_and_registration() {
    let mut harness = start(options()).await;
    let mut first = harness.peer().await;
    harness.until(|h| h.has("CCA executor connected")).await;

    harness.world.set(enabled(2, "credential-2", "account-1"));
    closed(&mut first).await;
    let _second = harness.peer().await;
    harness
        .until(|h| h.registrations() == 2 && h.identities.lock().unwrap().len() == 2)
        .await;

    let registered = harness.registry.registered.lock().unwrap().clone();
    assert_eq!(registered[0].token, "token-credential-1");
    assert_eq!(registered[1].token, "token-credential-2");
    assert_ne!(registered[0].key, registered[1].key);
    let identities = harness.identities.lock().unwrap().clone();
    assert_eq!(identities.len(), 2);
    assert_eq!(registered[0].key, key_json(&identities[0]));
    assert_eq!(registered[1].key, key_json(&identities[1]));
    let sent = harness.posts.sent.lock().unwrap().clone();
    assert_eq!(sent.len(), 2);
    assert_eq!(
        field(&sent[1].1, "installation_id").as_deref(),
        Some("inst-1")
    );
    assert!(field(&sent[1].1, "displayName").is_some());
    harness.stop().await;
}

#[tokio::test]
async fn a_revision_only_change_restarts_the_run_with_a_new_identity() {
    let mut harness = start(options()).await;
    let mut first = harness.peer().await;
    harness.world.set(enabled(2, "credential-1", "account-1"));
    closed(&mut first).await;
    let _second = harness.peer().await;
    harness
        .until(|h| h.identities.lock().unwrap().len() == 2)
        .await;
    assert_eq!(harness.registrations(), 2);
    harness.stop().await;
}

#[tokio::test]
async fn a_label_only_change_neither_restarts_nor_renames_within_a_run() {
    let mut harness = start(Options {
        name: Some("Old Name"),
        ..options()
    })
    .await;
    let mut peer = harness.peer().await;
    harness.until(|h| h.has("CCA executor connected")).await;
    *harness.world.name.lock().unwrap() = Some(LosslessString::from("New Name"));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(harness.dials.load(Ordering::SeqCst), 1);

    peer.close(None).await.unwrap();
    harness.armed(500).await;
    harness.clock.advance_to(500);
    let _again = harness.peer().await;
    harness
        .until(|h| h.identities.lock().unwrap().len() == 2)
        .await;
    assert_eq!(harness.dials.load(Ordering::SeqCst), 2);
    assert_eq!(harness.registrations(), 1);
    let sent = harness.posts.sent.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(
        field(&sent[0].1, "displayName").as_deref(),
        Some("Old Name")
    );
    harness.stop().await;
}

#[tokio::test]
async fn a_new_run_reconciles_first_and_skips_the_rename_when_the_server_confirms_the_label() {
    let directory = Directory::new();
    let first = start(Options {
        directory: directory.clone(),
        ..options()
    })
    .await;
    let mut peer = {
        let mut first = first;
        let peer = first.peer().await;
        first.stop().await;
        peer
    };
    closed(&mut peer).await;

    let mut second = start(Options {
        directory: directory.clone(),
        name: Some("  Custom Name  "),
        replies: vec![reply(
            200,
            r#"{"executor_id":"exec-1","custom_display_name":"Custom Name"}"#,
        )],
        ..options()
    })
    .await;
    let _peer = second.peer().await;
    second.until(|h| h.has("CCA executor connected")).await;
    let sent = second.posts.sent.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(
        field(&sent[0].1, "installation_id").as_deref(),
        Some("inst-1")
    );
    assert_eq!(
        field(&sent[0].1, "displayName").as_deref(),
        Some("Custom Name")
    );
    assert_eq!(field(&sent[0].1, "custom_display_name"), None);
    let record = recorded(&directory, |record| record.custom_display_name.is_some()).await;
    assert_eq!(
        record.custom_display_name,
        Some(LosslessString::from("Custom Name"))
    );
    assert_eq!(
        record.display_name,
        Some(LosslessString::from("Custom Name"))
    );
    assert_eq!(record.rename_declined, None);
    assert_eq!(
        second
            .registry
            .registered
            .lock()
            .unwrap()
            .iter()
            .map(|call| call.environment_id.clone())
            .collect::<Vec<_>>(),
        ["exec-1"]
    );
    second.stop().await;
}

#[tokio::test]
async fn a_rename_pending_enrollment_reconciles_at_cold_start_and_registers_only_the_replacement() {
    let directory = Directory::new();
    let mut first = start(Options {
        directory: directory.clone(),
        ..options()
    })
    .await;
    let _peer = first.peer().await;
    first.stop().await;

    let mut second = start(Options {
        directory: directory.clone(),
        name: Some("Work"),
        replies: vec![reply(
            200,
            r#"{"executor_id":"exec-2","custom_display_name":"Work"}"#,
        )],
        ..options()
    })
    .await;
    let _peer = second.peer().await;
    second.until(|h| h.has("CCA executor connected")).await;
    let sent = second.posts.sent.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(field(&sent[0].1, "displayName").as_deref(), Some("Work"));
    assert_eq!(
        field(&sent[0].1, "installation_id").as_deref(),
        Some("inst-1")
    );
    assert_eq!(field(&sent[0].1, "custom_display_name"), None);
    let record = recorded(&directory, |record| {
        record.executor_id == Some(LosslessString::from("exec-2"))
    })
    .await;
    assert_eq!(
        record.custom_display_name,
        Some(LosslessString::from("Work"))
    );
    assert_eq!(record.rename_declined, None);
    assert_eq!(
        second
            .registry
            .registered
            .lock()
            .unwrap()
            .iter()
            .map(|call| call.environment_id.clone())
            .collect::<Vec<_>>(),
        ["exec-2"]
    );
    assert!(second.has("CCA executor registration-executor-changed"));
    second.stop().await;
}

#[tokio::test]
async fn reconcile_without_name_confirmation_still_renames_after_the_registry() {
    let directory = Directory::new();
    let mut first = start(Options {
        directory: directory.clone(),
        ..options()
    })
    .await;
    let _peer = first.peer().await;
    first.stop().await;

    let mut second = start(Options {
        directory: directory.clone(),
        name: Some("Work"),
        replies: vec![
            reply(
                200,
                r#"{"executor_id":"exec-1","custom_display_name":null}"#,
            ),
            reply(
                200,
                r#"{"executor_id":"exec-1","custom_display_name":null}"#,
            ),
        ],
        ..options()
    })
    .await;
    let _peer = second.peer().await;
    second
        .until(|h| h.has("CCA executor registration-rename-unconfirmed"))
        .await;
    let sent = second.posts.sent.lock().unwrap().clone();
    assert_eq!(sent.len(), 2);
    assert_eq!(field(&sent[0].1, "displayName").as_deref(), Some("Work"));
    assert_eq!(
        field(&sent[0].1, "installation_id").as_deref(),
        Some("inst-1")
    );
    assert_eq!(
        field(&sent[1].1, "custom_display_name").as_deref(),
        Some("Work")
    );
    assert_eq!(
        field(&sent[1].1, "installation_id").as_deref(),
        Some("inst-1")
    );
    assert_eq!(field(&sent[1].1, "displayName"), None);
    assert_eq!(
        second
            .registry
            .registered
            .lock()
            .unwrap()
            .iter()
            .map(|call| call.environment_id.clone())
            .collect::<Vec<_>>(),
        ["exec-1"]
    );
    let record = recorded(&directory, |record| record.rename_declined.is_some()).await;
    let declined = record.rename_declined.unwrap();
    assert_eq!(declined.label, LosslessString::from("Work"));
    assert_eq!(declined.outcome, executor::Declined::Unconfirmed);
    assert_eq!(record.executor_id, Some(LosslessString::from("exec-1")));
    second.stop().await;
}

#[tokio::test]
async fn a_rename_confirmed_replacement_is_adopted_and_reregistered_with_the_registry() {
    let directory = Directory::new();
    let mut first = start(Options {
        directory: directory.clone(),
        ..options()
    })
    .await;
    let _peer = first.peer().await;
    first.stop().await;

    let mut second = start(Options {
        directory: directory.clone(),
        name: Some("Work"),
        replies: vec![
            reply(
                200,
                r#"{"executor_id":"exec-1","custom_display_name":null}"#,
            ),
            reply(
                200,
                r#"{"executor_id":"exec-2","custom_display_name":"Work"}"#,
            ),
        ],
        ..options()
    })
    .await;
    let _peer = second.peer().await;
    second
        .until(|h| h.has("CCA executor registration-rename-executor-changed"))
        .await;
    second.until(|h| h.registrations() == 2).await;
    let sent = second.posts.sent.lock().unwrap().clone();
    assert_eq!(sent.len(), 2);
    assert_eq!(
        field(&sent[1].1, "custom_display_name").as_deref(),
        Some("Work")
    );
    assert_eq!(
        second
            .registry
            .registered
            .lock()
            .unwrap()
            .iter()
            .map(|call| call.environment_id.clone())
            .collect::<Vec<_>>(),
        ["exec-1", "exec-2"]
    );
    let record = recorded(&directory, |record| {
        record.executor_id == Some(LosslessString::from("exec-2"))
    })
    .await;
    assert_eq!(
        record.custom_display_name,
        Some(LosslessString::from("Work"))
    );
    assert_eq!(record.rename_declined, None);
    second.stop().await;
}

#[tokio::test]
async fn an_unconfirmed_rename_is_reported_and_remembered() {
    let directory = Directory::new();
    let mut first = start(Options {
        directory: directory.clone(),
        ..options()
    })
    .await;
    let _peer = first.peer().await;
    first.stop().await;

    let mut second = start(Options {
        directory: directory.clone(),
        name: Some("Custom Name"),
        replies: vec![reply(
            200,
            r#"{"executor_id":"exec-1","custom_display_name":"Other"}"#,
        )],
        ..options()
    })
    .await;
    let _peer = second.peer().await;
    second
        .until(|h| h.has("CCA executor registration-rename-unconfirmed"))
        .await;
    let record = recorded(&directory, |record| record.rename_declined.is_some()).await;
    let declined = record.rename_declined.unwrap();
    assert_eq!(declined.label, LosslessString::from("Custom Name"));
    assert_eq!(declined.outcome, executor::Declined::Unconfirmed);
    second.stop().await;
}

#[tokio::test]
async fn reconnects_follow_the_canonical_backoff_schedule() {
    let mut harness = start(Options {
        dial_failures: vec![None; 7],
        ..options()
    })
    .await;
    let mut now = 0;
    for pause in [500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000] {
        now += pause;
        harness.armed(now).await;
        harness.clock.advance_to(now);
    }
    let _peer = harness.peer().await;
    assert_eq!(harness.dials.load(Ordering::SeqCst), 8);
    assert_eq!(harness.registrations(), 1);
    assert_eq!(
        harness
            .lines()
            .iter()
            .filter(|line| *line == "CCA executor connection-failed")
            .count(),
        7
    );
    harness.stop().await;
}

#[tokio::test]
async fn a_stable_connection_resets_the_backoff() {
    let mut harness = start(Options {
        dial_failures: vec![None],
        ..options()
    })
    .await;
    harness.armed(500).await;
    harness.clock.advance_to(500);
    let mut peer = harness.peer().await;
    harness.until(|h| h.has("CCA executor connected")).await;
    harness.clock.advance_to(130_500);
    tokio::time::sleep(Duration::from_millis(100)).await;
    peer.close(None).await.unwrap();
    harness.armed(131_000).await;
    harness
        .until(|h| h.has("CCA executor connection-dropped"))
        .await;
    harness.clock.advance_to(131_000);
    let _again = harness.peer().await;
    harness.stop().await;
}

#[tokio::test]
async fn a_definitive_registration_rejection_stops_the_run_without_a_retry() {
    let mut harness = start(Options {
        registrations: vec![Err(registry::Error::Http {
            status: 403,
            code: None,
        })],
        ..options()
    })
    .await;
    harness
        .until(|h| h.has("CCA executor registration-rejected status=403"))
        .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(harness.dials.load(Ordering::SeqCst), 0);
    assert_eq!(harness.registrations(), 1);
    assert!(harness.armed.try_recv().is_err());
    harness.stop().await;
}

#[tokio::test]
async fn throttled_and_server_registration_failures_are_retried_after_the_pause() {
    let mut harness = start(Options {
        registrations: vec![
            Err(registry::Error::Http {
                status: 429,
                code: None,
            }),
            Err(registry::Error::Http {
                status: 500,
                code: None,
            }),
        ],
        ..options()
    })
    .await;
    harness.armed(500).await;
    harness.clock.advance_to(500);
    harness.armed(1_500).await;
    harness.clock.advance_to(1_500);
    let _peer = harness.peer().await;
    assert_eq!(harness.registrations(), 3);
    assert_eq!(
        harness
            .lines()
            .iter()
            .filter(|line| *line == "CCA executor connection-failed")
            .count(),
        2
    );
    assert!(
        !harness
            .lines()
            .iter()
            .any(|line| line.contains("registration-rejected"))
    );
    harness.stop().await;
}

#[tokio::test]
async fn a_registration_conflict_is_retried_in_place_with_its_own_delay() {
    let mut harness = start(Options {
        registrations: vec![Err(registry::Error::Http {
            status: 503,
            code: Some("registration_conflict".into()),
        })],
        ..options()
    })
    .await;
    harness.armed(500).await;
    harness.clock.advance_to(500);
    let _peer = harness.peer().await;
    assert_eq!(harness.registrations(), 2);
    assert!(
        !harness
            .lines()
            .iter()
            .any(|line| line.contains("connection-failed"))
    );
    harness.stop().await;
}

#[tokio::test]
async fn a_client_error_on_dial_replaces_the_registration_but_a_server_error_does_not() {
    let mut harness = start(Options {
        dial_failures: vec![Some(403), Some(500)],
        ..options()
    })
    .await;
    harness.armed(500).await;
    assert_eq!(harness.registrations(), 2);
    harness.clock.advance_to(500);
    harness.armed(1_500).await;
    assert_eq!(harness.registrations(), 2);
    harness.clock.advance_to(1_500);
    let _peer = harness.peer().await;
    let registered = harness.registry.registered.lock().unwrap().clone();
    assert_eq!(registered[0].key, registered[1].key);
    harness.stop().await;
}

#[tokio::test]
async fn a_credential_for_another_revision_stops_the_run_without_registering() {
    let mut harness = start(Options {
        configuration: native::Configuration::Disabled,
        ..options()
    })
    .await;
    *harness.world.stale_credential.lock().unwrap() = Some("credential-other".into());
    harness.world.set(enabled(1, "credential-1", "account-1"));
    harness
        .until(|h| h.has("CCA executor credential-unavailable"))
        .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(harness.world.credential_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.registrations(), 0);
    assert_eq!(harness.dials.load(Ordering::SeqCst), 0);
    assert!(harness.posts.sent.lock().unwrap().is_empty());
    assert!(harness.armed.try_recv().is_err());
    harness.stop().await;
}

#[tokio::test]
async fn a_credential_lookup_error_is_retried_after_the_pause() {
    let mut harness = start(Options {
        configuration: native::Configuration::Disabled,
        ..options()
    })
    .await;
    harness.world.credential_fails.store(true, Ordering::SeqCst);
    harness.world.set(enabled(1, "credential-1", "account-1"));
    harness.armed(500).await;
    assert!(harness.has("CCA executor credential-unavailable"));
    harness
        .world
        .credential_fails
        .store(false, Ordering::SeqCst);
    harness.clock.advance_to(500);
    let _peer = harness.peer().await;
    harness.stop().await;
}

#[tokio::test]
async fn opened_channels_invoke_the_serving_callback_and_validate_the_harness_key() {
    let mut harness = start(options()).await;
    let mut peer = harness.peer().await;
    open(&mut peer, "stream-1").await;
    harness
        .until(|h| !h.log.opened.lock().unwrap().is_empty())
        .await;
    assert_eq!(
        harness.log.opened.lock().unwrap().as_slice(),
        [("stream-1".to_owned(), "exec-1".to_owned())]
    );
    assert_eq!(
        harness.registry.validated.lock().unwrap().as_slice(),
        [ValidateCall {
            token: "token-credential-1".into(),
            registration_id: "registration-1".into(),
            stream_id: "stream-1".into(),
            authorization: "harness-authorization".into(),
        }]
    );
    assert!(harness.has("CCA executor channel-opened"));
    let lines = harness.lines.clone();
    harness.stop().await;
    assert!(
        lines
            .lock()
            .unwrap()
            .contains(&"CCA executor channel-summary end=connection rpc=>initialize".to_owned())
    );
}

#[tokio::test]
async fn a_failing_serving_callback_is_reported_and_the_connection_keeps_serving() {
    let mut harness = start(Options {
        mode: Mode::Fail,
        ..options()
    })
    .await;
    let mut peer = harness.peer().await;
    open(&mut peer, "stream-1").await;
    harness
        .until(|h| h.has("CCA executor channel-summary end=failed rpc=>initialize"))
        .await;
    assert!(harness.has("CCA executor channel-failed"));
    open(&mut peer, "stream-2").await;
    harness
        .until(|h| h.log.opened.lock().unwrap().len() == 2)
        .await;
    assert_eq!(harness.dials.load(Ordering::SeqCst), 1);
    harness.stop().await;
}

#[tokio::test]
async fn a_dropped_transport_ends_the_channel_as_a_connection_end_and_reconnects() {
    let mut harness = start(options()).await;
    let mut peer = harness.peer().await;
    open(&mut peer, "stream-1").await;
    harness
        .until(|h| !h.log.opened.lock().unwrap().is_empty())
        .await;
    peer.close(None).await.unwrap();
    harness.armed(500).await;
    assert!(harness.has("CCA executor channel-summary end=connection rpc=>initialize"));
    assert!(harness.has("CCA executor connection-dropped"));
    harness.clock.advance_to(500);
    let _again = harness.peer().await;
    harness.stop().await;
}

#[tokio::test]
async fn a_stopped_run_refuses_a_late_harness_authorization() {
    let mut harness = start(Options {
        gated: true,
        ..options()
    })
    .await;
    let mut peer = harness.peer().await;
    let handshake = wire::encode(&Frame::new(
        "stream-1",
        Body::Handshake {
            payload: vec![1, 2, 3],
        },
    ));
    peer.send(Message::Binary(handshake.into())).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    harness.world.set(native::Configuration::Disabled);
    tokio::time::sleep(Duration::from_millis(100)).await;
    harness.gate.add_permits(1);
    closed(&mut peer).await;
    assert!(harness.registry.validated.lock().unwrap().is_empty());
    assert!(harness.log.opened.lock().unwrap().is_empty());
    harness.stop().await;
}

#[tokio::test]
async fn sessions_survive_a_reconnect_within_the_ttl_and_close_at_shutdown() {
    let mut harness = start(Options {
        mode: Mode::Sessions,
        ..options()
    })
    .await;
    let mut first = harness.peer().await;
    open(&mut first, "stream-1").await;
    harness
        .until(|h| h.log.session.lock().unwrap().is_some())
        .await;
    first.close(None).await.unwrap();
    harness.armed(500).await;
    harness.clock.advance_to(500);
    let mut second = harness.peer().await;
    open(&mut second, "stream-2").await;
    harness
        .until(|h| h.log.resumed.load(Ordering::SeqCst) == 1)
        .await;
    assert_eq!(harness.log.created.load(Ordering::SeqCst), 1);
    assert_eq!(harness.log.closed.load(Ordering::SeqCst), 0);
    let log = harness.log.clone();
    harness.stop().await;
    assert_eq!(log.closed.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn rotation_returns_a_close_failure_without_starting_a_replacement_run() {
    let mut harness = start(Options {
        mode: Mode::Sessions,
        ..options()
    })
    .await;
    let mut peer = harness.peer().await;
    open(&mut peer, "stream-1").await;
    harness
        .until(|h| h.log.session.lock().unwrap().is_some())
        .await;
    harness.log.fail_close.store(true, Ordering::SeqCst);
    harness.world.set(enabled(2, "credential-2", "account-2"));
    let failed = tokio::time::timeout(
        Duration::from_secs(5),
        harness.supervisor.completion.clone(),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert_eq!(failed.failures, [super::CleanupFailure::ResourceClose]);
    assert_eq!(harness.log.closed.load(Ordering::SeqCst), 1);
    assert_eq!(harness.registrations(), 1);
    assert_eq!(harness.dials.load(Ordering::SeqCst), 1);
    assert_eq!(harness.supervisor.shutdown().await.unwrap_err(), failed);
    assert_eq!(harness.world.listeners(), 0);
}

#[tokio::test]
async fn rendezvous_cleanup_failure_reaches_shutdown_without_reconnecting() {
    let mut harness = start(Options {
        mode: Mode::Panic,
        ..options()
    })
    .await;
    let mut peer = harness.peer().await;
    open(&mut peer, "stream-1").await;
    harness
        .until(|h| h.log.opened.lock().unwrap().len() == 1)
        .await;
    let mut cleanup_failed = harness.cleanup_failed.clone();
    peer.close(None).await.unwrap();
    tokio::time::timeout(
        Duration::from_secs(5),
        cleanup_failed.wait_for(|failed| *failed),
    )
    .await
    .expect("rendezvous cleanup did not report failure")
    .expect("diagnostics closed before the cleanup failure");
    let failure = tokio::time::timeout(Duration::from_secs(5), harness.supervisor.shutdown())
        .await
        .unwrap()
        .unwrap_err();
    let [super::CleanupFailure::Rendezvous(cleanup)] = failure.failures.as_slice() else {
        panic!("unexpected shutdown failures: {failure:?}");
    };
    let [crate::dots::carrier::rendezvous::CleanupFailure::Relay(relay_failure)] =
        cleanup.failures()
    else {
        panic!("unexpected rendezvous failures: {cleanup:?}");
    };
    assert_eq!(relay_failure.failures().len(), 1);
    assert_eq!(relay_failure.failures()[0].worker, relay::Worker::Channel);
    assert_eq!(relay_failure.failures()[0].kind, relay::JoinFailure::Panic);
    assert_eq!(harness.registrations(), 1);
    assert_eq!(harness.dials.load(Ordering::SeqCst), 1);
    assert_eq!(harness.supervisor.shutdown().await.unwrap_err(), failure);
}

#[tokio::test]
async fn a_session_detached_past_the_ttl_is_closed_and_not_resumed() {
    let mut harness = start(Options {
        mode: Mode::Sessions,
        ..options()
    })
    .await;
    let mut first = harness.peer().await;
    open(&mut first, "stream-1").await;
    harness
        .until(|h| h.log.session.lock().unwrap().is_some())
        .await;
    first.close(None).await.unwrap();
    harness.armed(500).await;
    harness.clock.advance_to(30_000);
    harness
        .until(|h| h.log.closed.load(Ordering::SeqCst) == 1)
        .await;
    let mut second = harness.peer().await;
    open(&mut second, "stream-2").await;
    harness
        .until(|h| h.has("CCA executor channel-summary end=failed rpc=>initialize"))
        .await;
    assert_eq!(harness.log.resumed.load(Ordering::SeqCst), 0);
    assert_eq!(harness.log.closed.load(Ordering::SeqCst), 1);
    harness.stop().await;
}

#[tokio::test]
async fn source_host_follows_the_native_configuration() {
    let fixture = test_support::HostFixture::new().await;
    let source = Source::host(fixture.host.clone(), Arc::new(|| None));
    assert!(matches!(
        (source.configuration)().unwrap(),
        native::Configuration::Enabled { .. }
    ));
    let notified = Arc::new(AtomicUsize::new(0));
    let counter = notified.clone();
    let subscription = (source.subscribe)(Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    }));
    fixture.access.set(false, 1).await.unwrap();
    assert!(matches!(
        (source.configuration)().unwrap(),
        native::Configuration::Disabled
    ));
    assert!(notified.load(Ordering::SeqCst) >= 1);
    assert!(
        (source.credential)("selected".into(), None)
            .await
            .unwrap()
            .is_none()
    );
    drop(subscription);
}
