use super::{
    CleanupError, CleanupFailure,
    diagnostic::{Diagnostic, Diagnostics},
    ports::{Borrowed, Boxed},
};
use crate::dots::carrier::Clock;
use futures_util::{FutureExt, future::Shared};
use std::{
    any::Any,
    collections::HashMap,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::{
    sync::{oneshot, watch},
    task::{AbortHandle, JoinSet},
};
use ycoding_core::ycoding_schema::LosslessString;

pub(crate) const DETACHED_TTL_MS: u64 = 30_000;
pub(crate) const ALREADY_ATTACHED: i64 = -32010;
pub(crate) const INVALID_REQUEST: i64 = -32600;
pub(crate) const INTERNAL_ERROR: i64 = -32603;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Rejection {
    pub code: i64,
    pub message: LosslessString,
}

impl Rejection {
    pub(crate) fn new(code: i64, message: impl Into<LosslessString>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn unknown_session(session_id: &str) -> Self {
        Self::new(INVALID_REQUEST, format!("unknown session id {session_id}"))
    }

    fn detached() -> Self {
        Self::new(
            INVALID_REQUEST,
            "session is no longer attached to this connection",
        )
    }

    fn shut_down() -> Self {
        Self::new(INTERNAL_ERROR, "Executor session registry is shut down")
    }
}

pub(crate) type Peer = Arc<dyn Any + Send + Sync>;

#[derive(Clone)]
pub(crate) struct Link {
    slot: Arc<Mutex<Option<Peer>>>,
    retired: watch::Receiver<bool>,
}

impl Link {
    pub(crate) fn peer(&self) -> Option<Peer> {
        locked(&self.slot).clone()
    }

    pub(crate) fn retired(&self) -> watch::Receiver<bool> {
        self.retired.clone()
    }
}

pub(crate) trait Resources: Any + Send + Sync {
    fn initialize<'a>(
        &'a self,
        client_name: &'a LosslessString,
        link: Link,
    ) -> Borrowed<'a, Result<String, Rejection>>;

    fn close(&self) -> Borrowed<'_, Result<(), ()>>;
}

impl dyn Resources {
    pub(crate) fn downcast_ref<T: Resources>(&self) -> Option<&T> {
        let any: &dyn Any = self;
        any.downcast_ref()
    }
}

pub(crate) type Opener =
    Arc<dyn Fn() -> Boxed<Result<Arc<dyn Resources>, Rejection>> + Send + Sync>;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

struct Detached {
    connection: u64,
    expires_at: u64,
    timer: AbortHandle,
}

struct Attachment {
    connection: Option<u64>,
    detached: Option<Detached>,
}

struct Entry {
    session_id: String,
    resources: Arc<dyn Resources>,
    slot: Arc<Mutex<Option<Peer>>>,
    retire: watch::Sender<bool>,
    attachment: Mutex<Attachment>,
}

#[derive(Default)]
struct State {
    sessions: HashMap<String, Arc<Entry>>,
    shut: bool,
}

type Shutdown = Shared<Boxed<Result<(), CleanupError>>>;

pub(crate) struct Registry {
    clock: Arc<dyn Clock>,
    ttl_ms: u64,
    diagnostics: Diagnostics,
    state: Mutex<State>,
    closing: Arc<Mutex<JoinSet<Result<(), CleanupFailure>>>>,
    timers: Arc<Mutex<JoinSet<()>>>,
    stop: watch::Sender<bool>,
    shutdown: Mutex<Option<Shutdown>>,
    next: AtomicU64,
}

impl Registry {
    pub(crate) fn new(clock: Arc<dyn Clock>, ttl_ms: u64, diagnostics: Diagnostics) -> Arc<Self> {
        Arc::new(Self {
            clock,
            ttl_ms,
            diagnostics,
            state: Mutex::new(State::default()),
            closing: Arc::new(Mutex::new(JoinSet::new())),
            timers: Arc::new(Mutex::new(JoinSet::new())),
            stop: watch::channel(false).0,
            shutdown: Mutex::new(None),
            next: AtomicU64::new(1),
        })
    }

    pub(crate) fn connect(self: &Arc<Self>, open: Opener) -> Connection {
        Connection {
            registry: self.clone(),
            open,
            id: self.next.fetch_add(1, Ordering::SeqCst),
            entry: Arc::new(Mutex::new(None)),
        }
    }

    fn is_shut(&self) -> bool {
        locked(&self.state).shut
    }

    fn close(&self, resources: Arc<dyn Resources>) -> oneshot::Receiver<()> {
        let (done, closed) = oneshot::channel();
        let diagnostics = self.diagnostics.clone();
        locked(&self.closing).spawn(async move {
            let result = resources
                .close()
                .await
                .map_err(|_| CleanupFailure::ResourceClose);
            if result.is_err() {
                diagnostics.report(Diagnostic::CleanupFailed);
            }
            let _ = done.send(());
            result
        });
        closed
    }

    fn retire(&self, entry: &Arc<Entry>) -> oneshot::Receiver<()> {
        let mut state = locked(&self.state);
        let (first, peer) = {
            let mut attachment = locked(&entry.attachment);
            let first = !*entry.retire.borrow();
            if let Some(detached) = attachment.detached.take() {
                detached.timer.abort();
            }
            attachment.connection = None;
            let peer = locked(&entry.slot).take();
            entry.retire.send_replace(true);
            (first, peer)
        };
        let closed = if first {
            let closed = self.close(entry.resources.clone());
            if state
                .sessions
                .get(&entry.session_id)
                .is_some_and(|current| Arc::ptr_eq(current, entry))
            {
                state.sessions.remove(&entry.session_id);
            }
            closed
        } else {
            let (done, closed) = oneshot::channel();
            let _ = done.send(());
            closed
        };
        drop(state);
        drop(peer);
        closed
    }

    fn expire(&self, entry: &Arc<Entry>, connection: u64) {
        let due = locked(&entry.attachment)
            .detached
            .as_ref()
            .is_some_and(|detached| detached.connection == connection);
        if due {
            drop(self.retire(entry));
        }
    }

    pub(crate) async fn shutdown(&self) -> Result<(), CleanupError> {
        let entries = {
            let mut state = locked(&self.state);
            state.shut = true;
            self.stop.send_replace(true);
            state.sessions.values().cloned().collect::<Vec<_>>()
        };
        for entry in &entries {
            drop(self.retire(entry));
        }
        let completion = {
            let mut shutdown = locked(&self.shutdown);
            shutdown
                .get_or_insert_with(|| {
                    let (closing, timers, diagnostics) = (
                        self.closing.clone(),
                        self.timers.clone(),
                        self.diagnostics.clone(),
                    );
                    let drain: Boxed<Result<(), CleanupError>> = Box::pin(async move {
                        let mut failures = Vec::new();
                        let mut timers = std::mem::take(&mut *locked(&timers));
                        timers.abort_all();
                        while let Some(result) = timers.join_next().await {
                            if result.is_err_and(|error| !error.is_cancelled()) {
                                failures.push(CleanupFailure::TimerJoin);
                            }
                        }
                        loop {
                            let mut pending = std::mem::take(&mut *locked(&closing));
                            if pending.is_empty() {
                                break;
                            }
                            while let Some(result) = pending.join_next().await {
                                match result {
                                    Ok(Ok(())) => {}
                                    Ok(Err(error)) => failures.push(error),
                                    Err(_) => {
                                        diagnostics.report(Diagnostic::CleanupFailed);
                                        failures.push(CleanupFailure::ResourceJoin);
                                    }
                                }
                            }
                        }
                        CleanupError::result(failures)
                    });
                    drain.shared()
                })
                .clone()
        };
        completion.await
    }
}

pub(crate) struct Connection {
    registry: Arc<Registry>,
    open: Opener,
    id: u64,
    entry: Arc<Mutex<Option<Arc<Entry>>>>,
}

impl Connection {
    pub(crate) async fn initialize(
        &self,
        client_name: &LosslessString,
        peer: Peer,
    ) -> Result<String, Rejection> {
        let registry = self.registry.clone();
        let (respond, response) = oneshot::channel();
        let (cancel, cancelled) = watch::channel(false);
        let request = Request(cancel);
        let (open, client_name, connection, entry) = (
            self.open.clone(),
            client_name.clone(),
            self.id,
            self.entry.clone(),
        );
        {
            let state = locked(&registry.state);
            if state.shut {
                return Err(Rejection::shut_down());
            }
            let owner = registry.clone();
            locked(&registry.closing).spawn(async move {
                let result = Self::open(
                    owner.clone(),
                    open,
                    client_name,
                    peer,
                    connection,
                    entry.clone(),
                    cancelled,
                )
                .await;
                if let Err(Ok(session_id)) = respond.send(result) {
                    let attached = locked(&entry).clone();
                    if let Some(attached) =
                        attached.filter(|attached| attached.session_id == session_id)
                    {
                        drop(owner.retire(&attached));
                    }
                }
                Ok(())
            });
        }
        let result = response.await.unwrap_or_else(|_| {
            Err(Rejection::new(
                INTERNAL_ERROR,
                "Executor session owner failed",
            ))
        });
        drop(request);
        result
    }

    async fn open(
        registry: Arc<Registry>,
        open: Opener,
        client_name: LosslessString,
        peer: Peer,
        connection: u64,
        target: Arc<Mutex<Option<Arc<Entry>>>>,
        mut cancelled: watch::Receiver<bool>,
    ) -> Result<String, Rejection> {
        let resources = open().await?;
        let mut owned = Opening {
            registry: registry.clone(),
            resources: resources.clone(),
            armed: true,
        };
        let slot = Arc::new(Mutex::new(Some(peer)));
        let (retire, retired) = watch::channel(false);
        let link = Link {
            slot: slot.clone(),
            retired,
        };
        let initialized = if registry.is_shut() || *cancelled.borrow() {
            Err(Rejection::shut_down())
        } else {
            let mut stopped = registry.stop.subscribe();
            tokio::select! {
                biased;
                _ = crate::dots::carrier::cancelled(&mut cancelled) => Err(Rejection::shut_down()),
                _ = crate::dots::carrier::cancelled(&mut stopped) => Err(Rejection::shut_down()),
                result = resources.initialize(&client_name, link) => result,
            }
        };
        let session_id = match initialized {
            Ok(_) if registry.is_shut() || *cancelled.borrow() => Err(Rejection::shut_down()),
            other => other,
        };
        let session_id = match session_id {
            Ok(session_id) => session_id,
            Err(rejection) => {
                retire.send_replace(true);
                owned.armed = false;
                let _ = registry.close(resources).await;
                return Err(rejection);
            }
        };
        let entry = Arc::new(Entry {
            session_id,
            resources: resources.clone(),
            slot,
            retire,
            attachment: Mutex::new(Attachment {
                connection: Some(connection),
                detached: None,
            }),
        });
        let refusal = {
            let mut state = locked(&registry.state);
            if state.shut || *cancelled.borrow() {
                Some(Rejection::shut_down())
            } else if state.sessions.contains_key(&entry.session_id) {
                Some(Rejection::new(INTERNAL_ERROR, "duplicate session id"))
            } else {
                state
                    .sessions
                    .insert(entry.session_id.clone(), entry.clone());
                None
            }
        };
        if let Some(rejection) = refusal {
            *locked(&entry.slot) = None;
            entry.retire.send_replace(true);
            owned.armed = false;
            let _ = registry.close(entry.resources.clone()).await;
            return Err(rejection);
        }
        let session_id = entry.session_id.clone();
        *locked(&target) = Some(entry);
        owned.armed = false;
        Ok(session_id)
    }

    pub(crate) async fn resume(&self, session_id: &str, peer: Peer) -> Result<String, Rejection> {
        let registry = &self.registry;
        if registry.is_shut() {
            return Err(Rejection::shut_down());
        }
        let found = locked(&registry.state)
            .sessions
            .get(session_id)
            .cloned()
            .ok_or_else(|| Rejection::unknown_session(session_id))?;
        let expired = locked(&found.attachment)
            .detached
            .as_ref()
            .is_some_and(|detached| registry.clock.now() >= detached.expires_at);
        if expired {
            let _ = registry.retire(&found).await;
            return Err(Rejection::unknown_session(session_id));
        }
        {
            let mut attachment = locked(&found.attachment);
            if *found.retire.borrow() {
                return Err(Rejection::unknown_session(session_id));
            }
            if attachment.connection.is_some() {
                return Err(Rejection::new(
                    ALREADY_ATTACHED,
                    format!("session {session_id} is already attached to another connection"),
                ));
            }
            if let Some(detached) = attachment.detached.take() {
                detached.timer.abort();
            }
            attachment.connection = Some(self.id);
            *locked(&found.slot) = Some(peer);
        }
        *locked(&self.entry) = Some(found);
        Ok(session_id.to_owned())
    }

    pub(crate) fn attached(&self) -> Result<Arc<dyn Resources>, Rejection> {
        let entry = locked(&self.entry).clone();
        match entry {
            Some(entry) if locked(&entry.attachment).connection == Some(self.id) => {
                Ok(entry.resources.clone())
            }
            _ => Err(Rejection::detached()),
        }
    }

    pub(crate) fn detach(&self) {
        let Some(entry) = locked(&self.entry).clone() else {
            return;
        };
        let state = locked(&self.registry.state);
        if state.shut {
            return;
        }
        let mut attachment = locked(&entry.attachment);
        if attachment.connection != Some(self.id) {
            return;
        }
        attachment.connection = None;
        let peer = locked(&entry.slot).take();
        let expires_at = self.registry.clock.now() + self.registry.ttl_ms;
        let (registry, expiring, connection) = (self.registry.clone(), entry.clone(), self.id);
        let timer = locked(&self.registry.timers).spawn(async move {
            registry.clock.sleep_until(expires_at).await;
            registry.expire(&expiring, connection);
        });
        attachment.detached = Some(Detached {
            connection: self.id,
            expires_at,
            timer,
        });
        drop(attachment);
        drop(state);
        drop(peer);
    }
}

struct Request(watch::Sender<bool>);

impl Drop for Request {
    fn drop(&mut self) {
        self.0.send_replace(true);
    }
}

struct Opening {
    registry: Arc<Registry>,
    resources: Arc<dyn Resources>,
    armed: bool,
}

impl Drop for Opening {
    fn drop(&mut self) {
        if self.armed {
            drop(self.registry.close(self.resources.clone()));
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        if tokio::runtime::Handle::try_current().is_ok() {
            self.detach();
        }
    }
}
