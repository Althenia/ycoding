mod http;
mod validation;

use crate::mcp_events::Authorization;
pub use crate::tools::code_mode::Cancellation;
pub use http::HttpTransport;
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;
use ycoding_schema::{
    LosslessString,
    local_app::{Category, Failure, Method, Register, Registration, Scope},
    session,
};

pub type ResultFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, Failure>> + Send + 'a>>;
pub trait Sessions: Send + Sync {
    fn verify(&self, session: session::Id, cancellation: Cancellation) -> ResultFuture<'_, bool>;
}
pub trait Body: Send {
    fn next(&mut self) -> ResultFuture<'_, Option<Vec<u8>>>;
}
pub trait Transport: Send + Sync {
    fn send(&self, request: Outgoing, cancellation: Cancellation) -> ResultFuture<'_, Incoming>;
}
pub struct Dependencies {
    pub sessions: Arc<dyn Sessions>,
    pub authorization: Arc<dyn Authorization>,
    pub transport: Arc<dyn Transport>,
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}
pub struct Outgoing {
    pub url: String,
    pub method: Method,
    pub headers: BTreeMap<String, String>,
    pub body: Option<Vec<u8>>,
}
pub struct Incoming {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Box<dyn Body>,
}
pub struct Request {
    pub id: LosslessString,
    pub generation: LosslessString,
    pub scope: Scope,
    pub method: Method,
    pub path: LosslessString,
    pub headers: BTreeMap<String, String>,
    pub body: Option<Vec<u8>>,
}
pub struct Response {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

struct Epoch {
    cancel: Cancellation,
    active: AtomicUsize,
    http: AtomicUsize,
    done: Notify,
}
impl Default for Epoch {
    fn default() -> Self {
        Self {
            cancel: Cancellation::default(),
            active: AtomicUsize::new(0),
            http: AtomicUsize::new(0),
            done: Notify::new(),
        }
    }
}
#[derive(Clone)]
struct App {
    metadata: Registration,
    scope: Scope,
    origin: String,
    published: bool,
    preview: Option<String>,
    cancel: Cancellation,
    active: usize,
}
struct State {
    apps: BTreeMap<LosslessString, App>,
    pending: BTreeMap<u64, session::Id>,
    next: u64,
    epoch: Arc<Epoch>,
    closed: bool,
}
pub struct Service {
    deps: Dependencies,
    state: Mutex<State>,
}
struct Operation<'a> {
    service: &'a Service,
    epoch: Arc<Epoch>,
    pending: Option<u64>,
    app: Option<LosslessString>,
    cancel: Cancellation,
}
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.cancel.cancel();
        {
            let mut state = self
                .service
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(id) = self.pending {
                state.pending.remove(&id);
            }
            if let Some(id) = &self.app {
                if Arc::ptr_eq(&state.epoch, &self.epoch)
                    && let Some(app) = state.apps.get_mut(id)
                {
                    app.active = app.active.saturating_sub(1);
                }
                self.epoch.http.fetch_sub(1, Ordering::AcqRel);
            }
        }
        self.epoch.active.fetch_sub(1, Ordering::AcqRel);
        self.epoch.done.notify_waiters();
    }
}

impl Service {
    pub fn new(deps: Dependencies) -> Self {
        Self {
            deps,
            state: Mutex::new(State {
                apps: BTreeMap::new(),
                pending: BTreeMap::new(),
                next: 0,
                epoch: Arc::new(Epoch::default()),
                closed: false,
            }),
        }
    }

    pub async fn register(
        &self,
        input: Register,
        scope: Scope,
        cancellation: Cancellation,
    ) -> Result<Registration, Failure> {
        validation::registration(&input, &scope)?;
        let operation = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            sweep(&mut state, (self.deps.clock)());
            if state.closed {
                return Err(failure(Category::NotFound));
            }
            if state.apps.len() + state.pending.len() >= 64
                || state
                    .apps
                    .values()
                    .filter(|app| app.metadata.session_id == input.session_id)
                    .count()
                    + state
                        .pending
                        .values()
                        .filter(|id| **id == input.session_id)
                        .count()
                    >= 16
            {
                return Err(failure(Category::Busy));
            }
            let id = state.next;
            state.next = state
                .next
                .checked_add(1)
                .ok_or_else(|| failure(Category::Busy))?;
            state.pending.insert(id, input.session_id.clone());
            state.epoch.active.fetch_add(1, Ordering::AcqRel);
            Operation {
                service: self,
                epoch: state.epoch.clone(),
                pending: Some(id),
                app: None,
                cancel: Cancellation::default(),
            }
        };
        let verified = tokio::select! {biased;_=operation.epoch.cancel.cancelled()=>return Err(failure(Category::NotFound)),_=cancellation.cancelled()=>return Err(failure(Category::UpstreamUnavailable)),value=self.deps.sessions.verify(input.session_id.clone(),operation.cancel.clone())=>value.unwrap_or(false)};
        if !verified {
            return Err(failure(Category::InvalidRegistration));
        }
        let expires_at = (self.deps.clock)()
            .checked_add(input.ttl_ms.unwrap_or(900_000) as i64)
            .filter(|value| (0..=9_007_199_254_740_991).contains(value))
            .ok_or_else(|| failure(Category::InvalidRegistration))?;
        let metadata = Registration {
            id: random("app_")?,
            generation: random("generation_")?,
            session_id: input.session_id,
            expires_at,
            entry_path: input.entry_path,
            allowed_methods: input
                .routes
                .iter()
                .flat_map(|route| route.methods.iter().copied())
                .fold(Vec::new(), |mut methods, method| {
                    if !methods.contains(&method) {
                        methods.push(method);
                    }
                    methods
                }),
            routes: input.routes,
        };
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.closed
                || operation.epoch.cancel.is_cancelled()
                || !Arc::ptr_eq(&operation.epoch, &state.epoch)
            {
                return Err(failure(Category::NotFound));
            }
            if cancellation.is_cancelled() {
                return Err(failure(Category::UpstreamUnavailable));
            }
            state.apps.insert(
                metadata.id.clone(),
                App {
                    metadata: metadata.clone(),
                    scope,
                    origin: format!("http://{}:{}", input.host.as_str(), input.port),
                    published: false,
                    preview: None,
                    cancel: Cancellation::default(),
                    active: 0,
                },
            );
        }
        Ok(metadata)
    }

    pub fn list(&self, scope: &Scope) -> Result<Vec<Registration>, Failure> {
        validation::scope(scope)?;
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        sweep(&mut state, (self.deps.clock)());
        Ok(state
            .apps
            .values()
            .filter(|app| app.scope == *scope)
            .map(|app| app.metadata.clone())
            .collect())
    }

    pub fn publish(
        &self,
        id: &LosslessString,
        generation: &LosslessString,
        scope: &Scope,
        preview_origin: Option<&str>,
    ) -> Result<Registration, Failure> {
        validation::scope(scope)?;
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let app = lookup(&mut state, id, scope, (self.deps.clock)())?;
        if app.metadata.generation != *generation {
            return Err(failure(Category::Forbidden));
        }
        if let Some(origin) = preview_origin {
            validation::preview(origin)?;
            if app.preview.as_deref().is_some_and(|bound| bound != origin) {
                return Err(failure(Category::Forbidden));
            }
            app.preview = Some(origin.to_owned());
        }
        app.published = true;
        Ok(app.metadata.clone())
    }

    pub fn revoke(&self, id: &LosslessString, scope: &Scope) -> Result<(), Failure> {
        validation::scope(scope)?;
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        lookup(&mut state, id, scope, (self.deps.clock)())?
            .cancel
            .cancel();
        state.apps.remove(id);
        Ok(())
    }

    pub fn sweep(&self) {
        sweep(
            &mut self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            (self.deps.clock)(),
        );
    }

    pub async fn clear(&self) {
        drain(self.reset(false)).await;
    }
    pub fn close(&self) -> impl Future<Output = ()> + Send + '_ {
        let old = self.reset(true);
        async move {
            drain(old).await;
        }
    }
    fn reset(&self, close: bool) -> Arc<Epoch> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.closed |= close;
        state.epoch.cancel.cancel();
        for app in state.apps.values() {
            app.cancel.cancel();
        }
        state.apps.clear();
        state.pending.clear();
        std::mem::replace(&mut state.epoch, Arc::new(Epoch::default()))
    }

    pub async fn dispatch(
        &self,
        request: Request,
        cancellation: Cancellation,
    ) -> Result<Response, Failure> {
        validation::scope(&request.scope)?;
        let (app, operation, headers) = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let app = lookup(&mut state, &request.id, &request.scope, (self.deps.clock)())?;
            if app.metadata.generation != request.generation || !app.published {
                return Err(failure(Category::Forbidden));
            }
            let path = validation::path(
                validation::text(&request.path, Category::Forbidden)?,
                Category::Forbidden,
            )?;
            if !validation::allows(&app.metadata.routes, &path, request.method)? {
                return Err(failure(Category::Forbidden));
            }
            if request
                .body
                .as_ref()
                .is_some_and(|body| body.len() > 256 * 1024)
            {
                return Err(failure(Category::TooLarge));
            }
            if request.body.is_some() && matches!(request.method, Method::Get | Method::Head) {
                return Err(failure(Category::Forbidden));
            }
            let headers = http::request_headers(&request.headers, app)?;
            if app.active >= 4 {
                return Err(failure(Category::Busy));
            }
            let snapshot = app.clone();
            if state.epoch.http.load(Ordering::Acquire) >= 16 {
                return Err(failure(Category::Busy));
            }
            state
                .apps
                .get_mut(&request.id)
                .ok_or_else(|| failure(Category::NotFound))?
                .active += 1;
            state.epoch.active.fetch_add(1, Ordering::AcqRel);
            state.epoch.http.fetch_add(1, Ordering::AcqRel);
            (
                snapshot,
                Operation {
                    service: self,
                    epoch: state.epoch.clone(),
                    pending: None,
                    app: Some(request.id.clone()),
                    cancel: Cancellation::default(),
                },
                headers,
            )
        };
        let duration = Duration::from_millis(
            app.metadata
                .expires_at
                .saturating_sub((self.deps.clock)())
                .clamp(1, 15_000) as u64,
        );
        let work = async {
            let permit = self
                .deps
                .authorization
                .check(request.scope.principal.clone(), operation.cancel.clone())
                .await
                .map_err(|_| failure(Category::UpstreamUnavailable))?;
            if permit.expires_at <= (self.deps.clock)() || permit.cancellation.is_cancelled() {
                return Err(failure(Category::UpstreamUnavailable));
            }
            let deliver = async {
                if cancellation.is_cancelled()
                    || app.cancel.is_cancelled()
                    || operation.epoch.cancel.is_cancelled()
                    || app.metadata.expires_at <= (self.deps.clock)()
                {
                    return Err(failure(Category::UpstreamUnavailable));
                }
                let response = self
                    .deps
                    .transport
                    .send(
                        Outgoing {
                            url: format!(
                                "{}{}",
                                app.origin,
                                validation::text(&request.path, Category::Forbidden)?
                            ),
                            method: request.method,
                            headers,
                            body: request.body,
                        },
                        operation.cancel.clone(),
                    )
                    .await?;
                let result = http::consume(
                    response,
                    &app,
                    validation::text(&request.path, Category::Forbidden)?,
                    request.method,
                )
                .await?;
                let fresh = self
                    .deps
                    .authorization
                    .check(request.scope.principal, operation.cancel.clone())
                    .await
                    .map_err(|_| failure(Category::UpstreamUnavailable))?;
                if fresh.expires_at <= (self.deps.clock)()
                    || fresh.cancellation.is_cancelled()
                    || permit.cancellation.is_cancelled()
                    || app.metadata.expires_at <= (self.deps.clock)()
                    || cancellation.is_cancelled()
                    || app.cancel.is_cancelled()
                    || operation.epoch.cancel.is_cancelled()
                {
                    return Err(failure(Category::UpstreamUnavailable));
                }
                Ok(result)
            };
            tokio::select! {biased;_=permit.cancellation.cancelled()=>Err(failure(Category::UpstreamUnavailable)),value=deliver=>value}
        };
        tokio::select! {biased;_=operation.epoch.cancel.cancelled()=>Err(failure(Category::UpstreamUnavailable)),_=app.cancel.cancelled()=>Err(failure(Category::UpstreamUnavailable)),_=cancellation.cancelled()=>Err(failure(Category::UpstreamUnavailable)),_=tokio::time::sleep(duration)=>Err(failure(Category::UpstreamUnavailable)),value=work=>value}
    }
}

fn lookup<'a>(
    state: &'a mut State,
    id: &LosslessString,
    scope: &Scope,
    now: i64,
) -> Result<&'a mut App, Failure> {
    if state.closed {
        return Err(failure(Category::NotFound));
    }
    let app = state
        .apps
        .get(id)
        .ok_or_else(|| failure(Category::NotFound))?;
    if app.scope != *scope {
        return Err(failure(Category::Forbidden));
    }
    if now >= app.metadata.expires_at {
        app.cancel.cancel();
        state.apps.remove(id);
        return Err(failure(Category::Expired));
    }
    state
        .apps
        .get_mut(id)
        .ok_or_else(|| failure(Category::NotFound))
}
fn sweep(state: &mut State, now: i64) {
    state.apps.retain(|_, app| {
        if now >= app.metadata.expires_at {
            app.cancel.cancel();
            return false;
        }
        true
    });
}
fn random(prefix: &str) -> Result<LosslessString, Failure> {
    let bytes =
        crate::platform::random::<16>().map_err(|_| failure(Category::UpstreamUnavailable))?;
    Ok(format!(
        "{prefix}{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
    .into())
}
fn failure(category: Category) -> Failure {
    Failure { category }
}
async fn drain(epoch: Arc<Epoch>) {
    loop {
        let notified = epoch.done.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if epoch.active.load(Ordering::Acquire) == 0 {
            return;
        }
        notified.await;
    }
}
