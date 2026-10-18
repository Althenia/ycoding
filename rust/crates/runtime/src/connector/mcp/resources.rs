use super::{
    Peer,
    json::{get, object, string, text},
};
use crate::connector::local_apps::Facade;
use crate::{Failure, ids};
use std::collections::BTreeMap;
use std::sync::{
    Arc, Mutex, OnceLock, PoisonError, Weak,
    atomic::{AtomicBool, Ordering},
};
use ycoding_core::mcp_events::{Authorization, Cancellation, Service};
use ycoding_core::ycoding_schema::JsonValue;
use ycoding_protocol::v5;

pub(super) const HTML_URI: &str = "ui://ycoding/artifact-demo/v1.html";
const HTML: &str = include_str!("artifact-demo.html");
const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGNIv77k/6fPX/8zgAgQBwB3aA11ihy37gAAAABJRU5ErkJggg==";
const SHA256: &str = "d3a97d031a3094c93d334c8e01e97c5a235ae1f44d5aab476d51311f16f0bce5";

struct Demo {
    id: String,
    uri: String,
    expires_at: u64,
}

pub(crate) type LocalAppsFactory = Arc<dyn Fn() -> Result<Arc<Facade>, Failure> + Send + Sync>;

pub struct Server {
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    demo: Mutex<Option<Demo>>,
    closed: AtomicBool,
    events: OnceLock<Arc<Service>>,
    authorization: OnceLock<Arc<dyn Authorization>>,
    requests: Mutex<BTreeMap<usize, Weak<Cancellation>>>,
    local_apps_factory: OnceLock<LocalAppsFactory>,
    local_apps: Mutex<BTreeMap<usize, Weak<Facade>>>,
}

impl Default for Server {
    fn default() -> Self {
        Self::new(Arc::new(ids::now_millis))
    }
}

impl Server {
    pub fn new(clock: Arc<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Self {
            clock,
            demo: Mutex::new(None),
            closed: AtomicBool::new(false),
            events: OnceLock::new(),
            authorization: OnceLock::new(),
            requests: Mutex::new(BTreeMap::new()),
            local_apps_factory: OnceLock::new(),
            local_apps: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        if let Some(events) = self.events.get() {
            events.close();
        }
        for facade in self.app_owners() {
            drop(facade.close());
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

    pub(crate) fn install_local_apps_factory(
        &self,
        factory: LocalAppsFactory,
    ) -> Result<(), Failure> {
        if self.closed.load(Ordering::Acquire) {
            return Err(Failure::Unavailable("Relay MCP is unavailable".into()));
        }
        self.local_apps_factory.set(factory).map_err(|_| {
            Failure::Unavailable("Local applications already have a backend owner".into())
        })
    }

    pub(crate) fn create_local_apps(&self) -> Result<Option<Arc<Facade>>, Failure> {
        if self.closed.load(Ordering::Acquire) {
            return Err(Failure::Unavailable("Relay MCP is unavailable".into()));
        }
        let Some(factory) = self.local_apps_factory.get() else {
            return Ok(None);
        };
        let facade = factory()?;
        self.track_apps(&facade);
        if self.closed.load(Ordering::Acquire) {
            return Err(Failure::Unavailable("Relay MCP is unavailable".into()));
        }
        Ok(Some(facade))
    }

    fn track_apps(&self, facade: &Arc<Facade>) {
        let mut owners = self
            .local_apps
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        owners.retain(|_, owner| owner.strong_count() > 0);
        owners.insert(Arc::as_ptr(facade) as usize, Arc::downgrade(facade));
        drop(owners);
        if self.closed.load(Ordering::Acquire) {
            drop(facade.close());
        }
    }

    fn app_owners(&self) -> Vec<Arc<Facade>> {
        self.local_apps
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .filter_map(Weak::upgrade)
            .collect()
    }

    pub async fn shutdown(&self) -> Result<(), Failure> {
        self.close();
        for facade in self.app_owners() {
            facade.close().await;
        }
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
    local_apps: Arc<OnceLock<Arc<Facade>>>,
}

impl Lease {
    pub fn new(peer: Peer, connection: String, epoch: String) -> Result<Self, super::super::Error> {
        if !peer.authorized()
            || connection.is_empty()
            || !super::super::mcp_state::stable_id(&epoch)
        {
            return Err(super::super::Error::Unauthorized);
        }
        Ok(Self {
            peer,
            connection,
            epoch,
            live: Arc::new(AtomicBool::new(true)),
            authority: Cancellation::default(),
            local_apps: Arc::new(OnceLock::new()),
        })
    }

    pub fn revoke(&self) {
        self.live.store(false, Ordering::Release);
        self.authority.cancel();
        if let Some(facade) = self.local_apps.get() {
            drop(facade.close());
        }
    }

    pub fn install_local_apps(&self, facade: Arc<Facade>) -> Result<(), Failure> {
        if !self.current(&self.connection, &self.epoch) {
            return Err(Failure::Unavailable("Relay MCP is unavailable".into()));
        }
        self.local_apps.set(facade).map_err(|_| {
            Failure::Unavailable("Local applications already have a connector owner".into())
        })?;
        if !self.current(&self.connection, &self.epoch) {
            if let Some(facade) = self.local_apps.get() {
                drop(facade.close());
            }
            return Err(Failure::Unavailable("Relay MCP is unavailable".into()));
        }
        Ok(())
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
    trusted_context: Option<ycoding_core::ycoding_schema::mcp_events::RequestContext>,
}

impl Access {
    pub fn new(server: Arc<Server>, lease: Lease, cancelled: Arc<AtomicBool>) -> Self {
        let request_cancel = server.request_token(&cancelled);
        if let Some(facade) = lease.local_apps.get() {
            server.track_apps(facade);
        }
        Self {
            server,
            lease,
            cancelled,
            request_cancel,
            trusted_context: None,
        }
    }

    pub(crate) fn with_context(
        mut self,
        context: Option<ycoding_core::ycoding_schema::mcp_events::RequestContext>,
    ) -> Self {
        self.trusted_context = context;
        self
    }

    pub(crate) fn local_apps(
        &self,
    ) -> Option<(
        Arc<Facade>,
        ycoding_core::ycoding_schema::mcp_events::RequestContext,
        Cancellation,
    )> {
        let context = self.trusted_context.as_ref()?;
        if !self.active()
            || context.epoch.as_str() != Some(self.lease.epoch.as_str())
            || context.principal.device_id.as_str() != Some(self.lease.peer.device())
        {
            return None;
        }
        Some((
            self.lease.local_apps.get()?.clone(),
            context.clone(),
            self.event_cancellation(),
        ))
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

    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.request_cancel.cancel();
    }

    pub(crate) fn events(
        &self,
        context: &ycoding_core::ycoding_schema::mcp_events::RequestContext,
    ) -> Option<Arc<Service>> {
        (self.active()
            && context.epoch.as_str() == Some(self.lease.epoch.as_str())
            && context.principal.device_id.as_str() == Some(self.lease.peer.device()))
        .then(|| self.server.events.get().cloned())
        .flatten()
    }

    pub fn authorization(
        &self,
        context: &ycoding_core::ycoding_schema::mcp_events::RequestContext,
    ) -> Option<Arc<dyn Authorization>> {
        (self.active()
            && context.epoch.as_str() == Some(self.lease.epoch.as_str())
            && context.principal.device_id.as_str() == Some(self.lease.peer.device()))
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

    pub(crate) fn initialize(&self) -> Result<(), Failure> {
        self.check()?;
        let mut slot = self
            .server
            .demo
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if slot.is_none() {
            let expires_at = (self.server.clock)()
                .checked_add(900_000)
                .filter(|time| (0..=9_007_199_254_740_991).contains(time))
                .ok_or_else(|| Failure::Unavailable("Demo clock is unavailable".into()))?
                as u64;
            let id = ids::prefixed("art_")
                .map_err(|_| Failure::Unavailable("Demo identity is unavailable".into()))?
                .to_utf8()
                .map_err(|_| Failure::Unavailable("Demo identity is unavailable".into()))?;
            self.check()?;
            *slot = Some(Demo {
                uri: format!("artifact://ycoding-demo/{id}"),
                id,
                expires_at,
            });
        }
        self.check()
    }

    fn check(&self) -> Result<(), Failure> {
        if !self.active() {
            return Err(Failure::Unavailable("Relay MCP is unavailable".into()));
        }
        Ok(())
    }

    pub fn preview(&self) -> Result<v5::ArtifactDemoPreviewResult, Failure> {
        self.initialize()?;
        Ok(v5::ArtifactDemoPreviewResult {
            variants: vec![1, 2],
            host_verification: 1,
        })
    }

    pub fn export(&self) -> Result<v5::ArtifactDemoExportResult, Failure> {
        self.initialize()?;
        let slot = self
            .server
            .demo
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let demo = slot
            .as_ref()
            .ok_or_else(|| Failure::Unavailable("Demo is unavailable".into()))?;
        if (self.server.clock)() >= demo.expires_at as i64 {
            return Err(Failure::Connector {
                code: 1,
                message: "Demo resource expired",
            });
        }
        let result = v5::ArtifactDemoExportResult {
            id: demo.id.clone(),
            filename: "ycoding-demo.png".into(),
            mime: 1,
            size: 79,
            sha256: SHA256.into(),
            expires_at: demo.expires_at,
            delivery: 1,
        };
        self.check()?;
        Ok(result)
    }

    pub(super) fn list(&self) -> Result<JsonValue, Failure> {
        self.initialize()?;
        let slot = self
            .server
            .demo
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let demo = slot
            .as_ref()
            .ok_or_else(|| Failure::Unavailable("Demo is unavailable".into()))?;
        let mut resources = vec![object([
            ("uri", string(HTML_URI)),
            ("name", string("Artifact client demo")),
            ("mimeType", string("text/html;profile=mcp-app")),
        ])];
        if (self.server.clock)() < demo.expires_at as i64 {
            resources.push(png_descriptor(&demo.uri));
        }
        if let Some(facade) = self.lease.local_apps.get() {
            let descriptors = facade.resources();
            if let Some(JsonValue::Array(apps)) = get(&descriptors, "resources") {
                resources.extend(apps.iter().cloned());
            }
        }
        self.check()?;
        Ok(object([("resources", JsonValue::Array(resources))]))
    }

    pub(super) fn read(&self, uri: &str) -> Result<Option<JsonValue>, Failure> {
        self.check()?;
        if let Some(facade) = self.lease.local_apps.get()
            && let Some(resource) = facade.resource(uri)
        {
            self.check()?;
            return Ok(Some(resource));
        }
        self.initialize()?;
        let slot = self
            .server
            .demo
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let demo = slot
            .as_ref()
            .ok_or_else(|| Failure::Unavailable("Demo is unavailable".into()))?;
        let content = if uri == HTML_URI {
            object([
                ("uri", string(HTML_URI)),
                ("mimeType", string("text/html;profile=mcp-app")),
                ("text", string(HTML)),
                (
                    "_meta",
                    object([(
                        "ui",
                        object([
                            ("prefersBorder", JsonValue::Bool(true)),
                            (
                                "csp",
                                object([
                                    ("connectDomains", JsonValue::Array(vec![])),
                                    ("resourceDomains", JsonValue::Array(vec![])),
                                    ("frameDomains", JsonValue::Array(vec![])),
                                ]),
                            ),
                        ]),
                    )]),
                ),
            ])
        } else if uri == demo.uri && (self.server.clock)() < demo.expires_at as i64 {
            object([
                ("uri", string(uri)),
                ("mimeType", string("image/png")),
                ("blob", string(PNG)),
            ])
        } else {
            return Ok(None);
        };
        self.check()?;
        Ok(Some(object([(
            "contents",
            JsonValue::Array(vec![content]),
        )])))
    }

    pub(super) fn presentation(
        &self,
        operation: &str,
        value: JsonValue,
    ) -> Result<JsonValue, Failure> {
        self.check()?;
        let content = if operation == "artifact.demo.export" {
            let export = self.export()?;
            if get(&value, "id").and_then(text) != Some(export.id.as_str()) {
                return Err(Failure::Unavailable(
                    "Demo result identity is unavailable".into(),
                ));
            }
            let descriptor = png_descriptor(&format!("artifact://ycoding-demo/{}", export.id));
            super::json::extend(descriptor, vec![("type", string("resource_link"))])
        } else {
            object([
                ("type", string("text")),
                (
                    "text",
                    string(
                        "Two-variant client demo. Confirm switching variants and the isolated-frame probe in the actual chat.",
                    ),
                ),
            ])
        };
        self.check()?;
        Ok(object([
            ("content", JsonValue::Array(vec![content])),
            ("structuredContent", value),
        ]))
    }
}

fn png_descriptor(uri: &str) -> JsonValue {
    object([
        ("uri", string(uri)),
        ("name", string("ycoding-demo.png")),
        ("mimeType", string("image/png")),
        ("size", JsonValue::Number(79.0)),
    ])
}
