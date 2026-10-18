use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    future::Future,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;
use ycoding_core::{
    local_app::{
        self, Body, Dependencies, Incoming, Outgoing, Request, Service, Sessions, Transport,
    },
    mcp_events::{self, Authorization, Cancellation, Grant, Permit},
};
use ycoding_schema::{
    DomainDecode, DomainEncode,
    local_app::{Category, Failure, Register, Registration, Scope},
    mcp_events::{Principal, RequestContext},
    parse_json, session, stringify_json,
};

pub const NOW: i64 = 1_800_000_000_000;

pub fn decode<T: DomainDecode>(value: Value) -> T {
    T::decode(&parse_json(&value.to_string()).unwrap()).unwrap()
}
pub fn encoded<T: DomainEncode>(value: &T) -> Value {
    serde_json::from_str(&stringify_json(&value.encode())).unwrap()
}
pub fn scope() -> Scope {
    decode(
        json!({"ownerID":"owner_synthetic","deviceID":"device_synthetic","sessionID":"ses_synthetic","clientID":"client_synthetic","grantID":"grant_synthetic","epoch":"epoch_synthetic"}),
    )
}
pub fn input() -> Register {
    decode(
        json!({"sessionID":"ses_synthetic","host":"127.0.0.1","port":43210,"entryPath":"/app/index.html","routes":[{"path":"/app","match":"prefix","methods":["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"]}]}),
    )
}
pub fn incoming(
    status: u16,
    headers: BTreeMap<String, String>,
    chunks: Vec<Result<Vec<u8>, Failure>>,
) -> Incoming {
    Incoming {
        status,
        headers,
        body: Box::new(Chunks(chunks.into())),
    }
}
struct Chunks(VecDeque<Result<Vec<u8>, Failure>>);
impl Body for Chunks {
    fn next(&mut self) -> local_app::ResultFuture<'_, Option<Vec<u8>>> {
        Box::pin(async move { self.0.pop_front().transpose() })
    }
}
struct FutureBody(Option<local_app::ResultFuture<'static, Vec<u8>>>);
impl Body for FutureBody {
    fn next(&mut self) -> local_app::ResultFuture<'_, Option<Vec<u8>>> {
        Box::pin(async move {
            match self.0.take() {
                Some(future) => future.await.map(Some),
                None => Ok(None),
            }
        })
    }
}
pub fn future_body(
    future: impl Future<Output = Result<Vec<u8>, Failure>> + Send + 'static,
) -> Box<dyn Body> {
    Box::new(FutureBody(Some(Box::pin(future))))
}
pub fn failure(category: Category) -> Failure {
    Failure { category }
}

#[derive(Default)]
pub struct Gate {
    pub calls: AtomicUsize,
    pub changed: Notify,
    pub release: Cancellation,
}
impl Gate {
    pub fn enter(&self) -> usize {
        let count = self.calls.fetch_add(1, Ordering::AcqRel) + 1;
        self.changed.notify_waiters();
        count
    }
    pub async fn wait(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let changed = self.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if self.calls.load(Ordering::Acquire) >= count {
                    return;
                }
                changed.await;
            }
        })
        .await
        .unwrap();
    }
}

pub struct SessionVerifier {
    pub allowed: AtomicBool,
    pub failed: AtomicBool,
    pub held: AtomicBool,
    pub gate: Gate,
}
impl Default for SessionVerifier {
    fn default() -> Self {
        Self {
            allowed: AtomicBool::new(true),
            failed: AtomicBool::new(false),
            held: AtomicBool::new(false),
            gate: Gate::default(),
        }
    }
}
impl Sessions for SessionVerifier {
    fn verify(
        &self,
        _session: session::Id,
        _cancellation: Cancellation,
    ) -> local_app::ResultFuture<'_, bool> {
        Box::pin(async move {
            self.gate.enter();
            if self.held.load(Ordering::Acquire) {
                self.gate.release.cancelled().await;
            }
            if self.failed.load(Ordering::Acquire) {
                return Err(failure(Category::UpstreamUnavailable));
            }
            Ok(self.allowed.load(Ordering::Acquire))
        })
    }
}

pub struct Authority {
    pub allowed: AtomicBool,
    pub hold_at: AtomicUsize,
    pub gate: Gate,
    pub permit: Cancellation,
}
impl Default for Authority {
    fn default() -> Self {
        Self {
            allowed: AtomicBool::new(true),
            hold_at: AtomicUsize::new(0),
            gate: Gate::default(),
            permit: Cancellation::default(),
        }
    }
}
impl Authorization for Authority {
    fn capabilities(&self, _cancellation: Cancellation) -> mcp_events::ResultFuture<'_, bool> {
        Box::pin(async { Ok(true) })
    }
    fn resolve(
        &self,
        _context: RequestContext,
        _cancellation: Cancellation,
    ) -> mcp_events::ResultFuture<'_, Grant> {
        Box::pin(async { panic!("Local app engine must receive a resolved scope") })
    }
    fn check(
        &self,
        _principal: Principal,
        _cancellation: Cancellation,
    ) -> mcp_events::ResultFuture<'_, Permit> {
        Box::pin(async move {
            let count = self.gate.enter();
            if self.hold_at.load(Ordering::Acquire) == count {
                self.gate.release.cancelled().await;
            }
            if !self.allowed.load(Ordering::Acquire) {
                return Err(decode(
                    json!({"_tag":"McpEvents.Failure","category":"unauthorized","reason":"grant_revoked"}),
                ));
            }
            Ok(Permit {
                expires_at: NOW + 3_600_000,
                cancellation: self.permit.clone(),
            })
        })
    }
}

#[derive(Default)]
pub struct RecordingTransport {
    pub requests: Mutex<Vec<Outgoing>>,
    pub replies: Mutex<VecDeque<Incoming>>,
    pub held: AtomicBool,
    pub gate: Gate,
    pub failed: AtomicBool,
}
impl Transport for RecordingTransport {
    fn send(
        &self,
        request: Outgoing,
        _cancellation: Cancellation,
    ) -> local_app::ResultFuture<'_, Incoming> {
        Box::pin(async move {
            self.requests.lock().unwrap().push(request);
            self.gate.enter();
            if self.held.load(Ordering::Acquire) {
                self.gate.release.cancelled().await;
            }
            if self.failed.load(Ordering::Acquire) {
                return Err(failure(Category::UpstreamUnavailable));
            }
            Ok(self
                .replies
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| incoming(200, BTreeMap::new(), vec![Ok(b"synthetic".to_vec())])))
        })
    }
}

pub struct Fixture<T: Transport = RecordingTransport> {
    pub service: Arc<Service>,
    pub sessions: Arc<SessionVerifier>,
    pub authority: Arc<Authority>,
    pub transport: Arc<T>,
    pub clock: Arc<AtomicI64>,
}
impl Default for Fixture<RecordingTransport> {
    fn default() -> Self {
        Self::new()
    }
}
impl Fixture<RecordingTransport> {
    pub fn new() -> Self {
        Self::with_transport(Arc::new(RecordingTransport::default()))
    }
}
impl<T: Transport + 'static> Fixture<T> {
    pub fn with_transport(transport: Arc<T>) -> Self {
        let sessions = Arc::new(SessionVerifier::default());
        let authority = Arc::new(Authority::default());
        let clock = Arc::new(AtomicI64::new(NOW));
        let now = clock.clone();
        Self {
            service: Arc::new(Service::new(Dependencies {
                sessions: sessions.clone(),
                authorization: authority.clone(),
                transport: transport.clone(),
                clock: Arc::new(move || now.load(Ordering::Acquire)),
            })),
            sessions,
            authority,
            transport,
            clock,
        }
    }
    pub async fn register(&self) -> Registration {
        self.service
            .register(input(), scope(), Cancellation::default())
            .await
            .unwrap()
    }
    pub async fn add(&self) -> Registration {
        let app = self.register().await;
        self.service
            .publish(&app.id, &app.generation, &scope(), None)
            .unwrap();
        app
    }
    pub fn request(&self, app: &Registration) -> Request {
        Request {
            id: app.id.clone(),
            generation: app.generation.clone(),
            scope: scope(),
            method: ycoding_schema::local_app::Method::Get,
            path: "/app/index.html".into(),
            headers: BTreeMap::new(),
            body: None,
        }
    }
    pub async fn send(&self, app: &Registration) -> local_app::Response {
        self.service
            .dispatch(self.request(app), Cancellation::default())
            .await
            .unwrap()
    }
}
