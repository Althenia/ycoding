use super::{Peer, json::object};
use crate::Failure;
use std::collections::BTreeMap;
use std::sync::{
    Arc, Mutex, OnceLock, PoisonError, Weak,
    atomic::{AtomicBool, Ordering},
};
use ycoding_core::mcp_events::{Authorization, Cancellation, Service};
use ycoding_core::ycoding_schema::JsonValue;

pub struct Server {
    closed: AtomicBool,
    events: OnceLock<Arc<Service>>,
    authorization: OnceLock<Arc<dyn Authorization>>,
    requests: Mutex<BTreeMap<usize, Weak<Cancellation>>>,
}

impl Default for Server {
    fn default() -> Self {
        Self {
            closed: AtomicBool::new(false),
            events: OnceLock::new(),
            authorization: OnceLock::new(),
            requests: Mutex::new(BTreeMap::new()),
        }
    }
}

impl Server {
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        if let Some(events) = self.events.get() {
            events.close();
        }
        for token in self
            .requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .filter_map(Weak::upgrade)
        {
            token.cancel();
        }
    }

    pub fn install_events(&self, service: Arc<Service>) -> Result<(), Failure> {
        if self.closed.load(Ordering::Acquire) {
            return Err(Failure::Unavailable("Relay MCP is unavailable".into()));
        }
        self.events
            .set(service)
            .map_err(|_| Failure::Unavailable("MCP Events already has a backend owner".into()))
    }

    pub fn install_authorization(
        &self,
        authorization: Arc<dyn Authorization>,
    ) -> Result<(), Failure> {
        if self.closed.load(Ordering::Acquire) {
            return Err(Failure::Unavailable("Relay MCP is unavailable".into()));
        }
        self.authorization.set(authorization).map_err(|_| {
            Failure::Unavailable("Relay MCP authorization already has a backend owner".into())
        })
    }

    pub fn authorization(&self) -> Option<Arc<dyn Authorization>> {
        (!self.closed.load(Ordering::Acquire))
            .then(|| self.authorization.get().cloned())
            .flatten()
    }

    pub async fn shutdown(&self) -> Result<(), Failure> {
        self.close();
        if let Some(events) = self.events.get() {
            events
                .shutdown()
                .await
                .map_err(|_| Failure::Unavailable("MCP Events shutdown failed".into()))?;
        }
        Ok(())
    }

    fn request_token(&self, cancelled: &Arc<AtomicBool>) -> Arc<Cancellation> {
        let mut requests = self.requests.lock().unwrap_or_else(PoisonError::into_inner);
        requests.retain(|_, token| token.strong_count() > 0);
        let key = Arc::as_ptr(cancelled) as usize;
        let token = requests
            .get(&key)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| {
                let token = Arc::new(Cancellation::default());
                requests.insert(key, Arc::downgrade(&token));
                token
            });
        if cancelled.load(Ordering::Acquire) {
            token.cancel();
        }
        token
    }
}

#[derive(Clone)]
pub struct Lease {
    peer: Peer,
    connection: String,
    epoch: String,
    live: Arc<AtomicBool>,
    authority: Cancellation,
}

impl Lease {
    pub fn new(peer: Peer, connection: String, epoch: String) -> Result<Self, super::super::Error> {
        if !peer.authorized() || connection.is_empty() || !super::stable_id(&epoch) {
            return Err(super::super::Error::Unauthorized);
        }
        Ok(Self {
            peer,
            connection,
            epoch,
            live: Arc::new(AtomicBool::new(true)),
            authority: Cancellation::default(),
        })
    }

    pub fn revoke(&self) {
        self.live.store(false, Ordering::Release);
        self.authority.cancel();
    }

    pub(crate) fn authority(&self, epoch: Option<&str>) -> Option<(Peer, Cancellation)> {
        (epoch.is_none_or(|epoch| epoch == self.epoch)
            && self.current(&self.connection, &self.epoch))
        .then(|| (self.peer.clone(), self.authority.clone()))
    }

    pub(crate) fn current(&self, connection: &str, epoch: &str) -> bool {
        self.connection == connection
            && self.epoch == epoch
            && self.live.load(Ordering::Acquire)
            && self.peer.authorized()
    }
}

#[derive(Clone)]
pub struct Access {
    server: Arc<Server>,
    lease: Lease,
    cancelled: Arc<AtomicBool>,
    request_cancel: Arc<Cancellation>,
}

impl Access {
    pub fn new(server: Arc<Server>, lease: Lease, cancelled: Arc<AtomicBool>) -> Self {
        let request_cancel = server.request_token(&cancelled);
        Self {
            server,
            lease,
            cancelled,
            request_cancel,
        }
    }

    fn bound(&self, context: &ycoding_core::ycoding_schema::mcp_events::RequestContext) -> bool {
        self.active()
            && context.epoch.as_str() == Some(self.lease.epoch.as_str())
            && context.principal.device_id.as_str() == Some(self.lease.peer.device())
    }

    pub(crate) fn active(&self) -> bool {
        !self.server.closed.load(Ordering::Acquire)
            && !self.cancelled.load(Ordering::Acquire)
            && self
                .lease
                .current(&self.lease.connection, &self.lease.epoch)
    }

    pub(crate) fn cancellation(&self) -> Arc<AtomicBool> {
        self.cancelled.clone()
    }

    pub(crate) fn events(
        &self,
        context: &ycoding_core::ycoding_schema::mcp_events::RequestContext,
    ) -> Option<Arc<Service>> {
        self.bound(context)
            .then(|| self.server.events.get().cloned())
            .flatten()
    }

    pub fn authorization(
        &self,
        context: &ycoding_core::ycoding_schema::mcp_events::RequestContext,
    ) -> Option<Arc<dyn Authorization>> {
        self.bound(context)
            .then(|| self.server.authorization())
            .flatten()
    }

    pub(crate) fn event_cancellation(&self) -> Cancellation {
        if self.cancelled.load(Ordering::Acquire) {
            self.request_cancel.cancel();
        }
        self.request_cancel.as_ref().clone()
    }

    pub(crate) fn authority_cancellation(&self) -> Cancellation {
        self.lease.authority.clone()
    }

    pub(crate) fn authorized(&self, connection: &str, peer: &Peer) -> bool {
        self.active()
            && self.lease.connection == connection
            && self.lease.peer.device() == peer.device()
            && peer.authorized()
    }

    pub(crate) fn bound_to(&self, connection: &str) -> bool {
        self.lease.connection == connection
    }

    fn check(&self) -> Result<(), Failure> {
        if !self.active() {
            return Err(Failure::Unavailable("Relay MCP is unavailable".into()));
        }
        Ok(())
    }

    pub(super) fn list(&self) -> Result<JsonValue, Failure> {
        self.check()?;
        Ok(object([("resources", JsonValue::Array(vec![]))]))
    }

    pub(super) fn read(&self, _uri: &str) -> Result<Option<JsonValue>, Failure> {
        self.check()?;
        Ok(None)
    }
}
