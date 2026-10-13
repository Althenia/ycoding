use super::{cdp, chrome_process::error, isolated::ExecutorError};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{broadcast, oneshot, watch},
    task::{JoinHandle, JoinSet},
    time::Instant,
};
use url::Url;

const POPUP_HOLD: Duration = Duration::from_millis(500);

pub(super) struct Safety {
    failure: Mutex<Option<String>>,
    fatal: watch::Sender<bool>,
    downloads: AtomicUsize,
    popups: AtomicUsize,
    closing: AtomicBool,
    paused: AtomicBool,
}
impl Safety {
    pub(super) fn new() -> Self {
        Self {
            failure: Mutex::new(None),
            fatal: watch::channel(false).0,
            downloads: AtomicUsize::new(0),
            popups: AtomicUsize::new(0),
            closing: AtomicBool::new(false),
            paused: AtomicBool::new(false),
        }
    }
    pub(super) fn failure(&self) -> Option<String> {
        self.failure
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub(super) fn downloads(&self) -> usize {
        self.downloads.load(Ordering::Acquire)
    }
    pub(super) fn popups(&self) -> usize {
        self.popups.load(Ordering::Acquire)
    }
    pub(super) fn fatal(&self) -> watch::Receiver<bool> {
        self.fatal.subscribe()
    }
    pub(super) fn paused(&self) -> bool {
        self.paused.load(Ordering::Acquire)
    }
    pub(super) fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::Release);
    }
    fn fail(&self, message: &str, fatal: bool) {
        self.failure
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_or_insert_with(|| message.to_owned());
        self.set_paused(true);
        if fatal {
            self.fatal.send_replace(true);
        }
    }
}

pub(super) struct Settings<'a> {
    pub client: &'a Arc<cdp::Client>,
    pub safety: Arc<Safety>,
    pub downloads: &'a Path,
    pub url: &'a Url,
    pub command_timeout: Duration,
    pub destruction_timeout: Duration,
    pub settle: Duration,
    pub cancel: watch::Receiver<bool>,
    pub deadline: Instant,
}

pub(super) struct Guard {
    pub(super) browser_context_id: String,
    pub(super) page: Arc<Shared>,
    safety: Arc<Safety>,
    handler: Option<JoinHandle<()>>,
}
impl Guard {
    pub(super) async fn stop(&mut self) {
        self.safety.closing.store(true, Ordering::Release);
        if let Some(handler) = self.handler.take() {
            handler.abort();
            let _ = handler.await;
        }
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        if let Some(handler) = self.handler.take() {
            handler.abort();
        }
    }
}

pub(super) async fn configure(settings: Settings<'_>) -> Result<Guard, ExecutorError> {
    let link = Link {
        client: settings.client,
        cancel: settings.cancel.clone(),
        deadline: settings.deadline,
        command_timeout: settings.command_timeout,
    };
    let events = settings.client.subscribe();
    let origin = settings.url.origin().ascii_serialization();
    let context = link
        .call(
            "Target.createBrowserContext",
            json!({"disposeOnDetach": true}),
            None,
        )
        .await?;
    let browser_context_id = identifier(&context, "browserContextId")?;
    link.call(
        "Browser.setDownloadBehavior",
        json!({
            "behavior": "deny",
            "browserContextId": browser_context_id,
            "downloadPath": settings.downloads.to_string_lossy(),
            "eventsEnabled": true,
        }),
        None,
    )
    .await?;
    tokio::try_join!(
        link.deny_permission("clipboard-read", &origin, &browser_context_id),
        link.deny_permission("clipboard-write", &origin, &browser_context_id),
    )?;
    let created = link
        .call(
            "Target.createTarget",
            json!({"url": "about:blank", "browserContextId": browser_context_id}),
            None,
        )
        .await?;
    let target_id = identifier(&created, "targetId")?;
    let attached = link
        .call(
            "Target.attachToTarget",
            json!({"targetId": target_id, "flatten": true}),
            None,
        )
        .await?;
    let session_id = identifier(&attached, "sessionId")?;
    let session = Some(session_id.as_str());
    tokio::try_join!(
        link.call("Page.enable", json!({}), session),
        link.call("Inspector.enable", json!({}), session),
        link.call("DOM.enable", json!({}), session),
        link.call("Accessibility.enable", json!({}), session),
        link.call(
            "Page.setInterceptFileChooserDialog",
            json!({"enabled": true}),
            session
        ),
    )?;
    let tree = link.call("Page.getFrameTree", json!({}), session).await?;
    let main_frame_id = tree
        .pointer("/frameTree/frame/id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| error("Chrome omitted an identifier"))?
        .to_owned();
    let shared = Arc::new(Shared {
        client: settings.client.clone(),
        safety: settings.safety.clone(),
        browser_context_id: browser_context_id.clone(),
        target_id,
        session_id: session_id.clone(),
        main_frame_id,
        document: Mutex::new(Document {
            allowed_origins: HashSet::from([origin.clone()]),
            refs: HashMap::new(),
            generation: 1,
            revision: 0,
            initialized: false,
        }),
        initial_url: settings.url.clone(),
        settle: settings.settle,
        destruction_timeout: settings.destruction_timeout,
        held: Mutex::new(HashMap::new()),
        destroyed: Mutex::new(HashMap::new()),
        inflight: watch::channel(0).0,
    });
    let guard = Guard {
        browser_context_id,
        page: shared.clone(),
        safety: settings.safety.clone(),
        handler: Some(tokio::spawn(handle_events(shared.clone(), events))),
    };
    let session = Some(session_id.as_str());
    link.call(
        "Fetch.enable",
        json!({"patterns": [{"urlPattern": "*", "requestStage": "Request"}]}),
        session,
    )
    .await?;
    link.call("Target.setDiscoverTargets", json!({"discover": true}), None)
        .await?;
    link.call(
        "Target.setAutoAttach",
        json!({
            "autoAttach": true,
            "waitForDebuggerOnStart": true,
            "flatten": true,
            "filter": [{"type": "page", "exclude": false}, {"exclude": true}],
        }),
        None,
    )
    .await?;
    link.call(
        "Page.navigate",
        json!({"url": settings.url.as_str()}),
        session,
    )
    .await?;
    link.wait_for_document(&session_id, &origin, &settings.safety)
        .await?;
    link.pause(settings.settle).await?;
    shared.document().initialized = true;
    if let Some(failure) = settings.safety.failure() {
        return Err(error(failure));
    }
    Ok(guard)
}

pub(super) fn safe_url(input: &str) -> Result<Url, ExecutorError> {
    Url::parse(input)
        .ok()
        .filter(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.username().is_empty()
                && url.password().is_none()
        })
        .ok_or_else(|| error("Only credential-free HTTP and HTTPS pages are supported"))
}

pub(super) fn request_allowed(
    input: &str,
    top_level: bool,
    allowed_origins: &HashSet<String>,
) -> bool {
    let Ok(url) = Url::parse(input) else {
        return false;
    };
    if url.as_str() == "about:blank" {
        return true;
    }
    if !matches!(url.scheme(), "http" | "https") {
        return !top_level && matches!(url.scheme(), "blob" | "data");
    }
    !top_level || allowed_origins.contains(&url.origin().ascii_serialization())
}

fn identifier(value: &Value, key: &str) -> Result<String, ExecutorError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| error("Chrome omitted an identifier"))
}

struct Link<'a> {
    client: &'a cdp::Client,
    cancel: watch::Receiver<bool>,
    deadline: Instant,
    command_timeout: Duration,
}
impl Link<'_> {
    async fn call(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value, ExecutorError> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        self.client
            .send(
                method,
                params,
                session,
                Some(self.cancel.clone()),
                Some(self.command_timeout.min(remaining)),
            )
            .await
            .map_err(|failure| {
                error(if failure.cancelled {
                    "Isolated Chrome startup was canceled"
                } else if Instant::now() >= self.deadline {
                    "Isolated Chrome startup timed out"
                } else {
                    "Failed to configure isolated Chrome"
                })
            })
    }
    async fn wait_for_document(
        &self,
        session_id: &str,
        origin: &str,
        safety: &Safety,
    ) -> Result<(), ExecutorError> {
        while Instant::now() < self.deadline {
            if let Some(failure) = safety.failure() {
                return Err(error(failure));
            }
            let tree = self
                .call("Page.getFrameTree", json!({}), Some(session_id))
                .await?;
            let ready = tree
                .pointer("/frameTree/frame/url")
                .and_then(Value::as_str)
                .and_then(|url| safe_url(url).ok())
                .is_some_and(|url| url.origin().ascii_serialization() == origin);
            if ready {
                return Ok(());
            }
            self.pause(Duration::from_millis(25)).await?;
        }
        Err(error("Initial page did not become ready"))
    }
    async fn pause(&self, duration: Duration) -> Result<(), ExecutorError> {
        let mut cancel = self.cancel.clone();
        tokio::select! {
            () = tokio::time::sleep(duration) => Ok(()),
            _ = cancel.wait_for(|cancelled| *cancelled) => Err(error("Isolated Chrome startup was canceled")),
        }
    }
    async fn deny_permission(
        &self,
        name: &str,
        origin: &str,
        browser_context_id: &str,
    ) -> Result<Value, ExecutorError> {
        self.call(
            "Browser.setPermission",
            json!({
                "permission": {"name": name},
                "setting": "denied",
                "origin": origin,
                "browserContextId": browser_context_id,
            }),
            None,
        )
        .await
    }
}

pub(super) struct Document {
    pub(super) allowed_origins: HashSet<String>,
    pub(super) refs: HashMap<String, i64>,
    pub(super) generation: u64,
    pub(super) revision: u64,
    pub(super) initialized: bool,
}

pub(super) struct Shared {
    pub(super) client: Arc<cdp::Client>,
    pub(super) safety: Arc<Safety>,
    pub(super) browser_context_id: String,
    pub(super) target_id: String,
    pub(super) session_id: String,
    pub(super) main_frame_id: String,
    pub(super) initial_url: Url,
    pub(super) settle: Duration,
    document: Mutex<Document>,
    destruction_timeout: Duration,
    held: Mutex<HashMap<String, Option<oneshot::Sender<()>>>>,
    destroyed: Mutex<HashMap<String, oneshot::Sender<()>>>,
    inflight: watch::Sender<usize>,
}

async fn handle_events(shared: Arc<Shared>, mut events: broadcast::Receiver<cdp::Event>) {
    let mut contained = JoinSet::new();
    loop {
        tokio::select! {
            received = events.recv() => match received {
                Ok(event) => {
                    if shared.safety.closing.load(Ordering::Acquire) {
                        continue;
                    }
                    if shared.dispatch(event, &mut contained).await.is_err() {
                        shared.safety.fail("A browser safety guard failed", true);
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    shared.safety.fail("A browser safety guard failed", true);
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            Some(_) = contained.join_next(), if !contained.is_empty() => {}
        }
    }
}

impl Shared {
    async fn dispatch(
        self: &Arc<Self>,
        event: cdp::Event,
        contained: &mut JoinSet<()>,
    ) -> Result<(), ()> {
        let params = event.params.clone().unwrap_or(Value::Null);
        let main = event.session_id.as_deref() == Some(self.session_id.as_str());
        match event.method.as_str() {
            "Target.targetDestroyed" => {
                if let Some(target) = params.get("targetId").and_then(Value::as_str) {
                    if target == self.target_id {
                        self.safety
                            .fail("The controllable browser target was destroyed", true);
                    }
                    if let Some(waiter) = self.destroyed.lock().map_err(|_| ())?.remove(target) {
                        let _ = waiter.send(());
                    }
                }
            }
            "Inspector.targetCrashed" if main => self.crashed(),
            "Target.targetCrashed"
                if params.get("targetId").and_then(Value::as_str)
                    == Some(self.target_id.as_str()) =>
            {
                self.crashed()
            }
            "Target.attachedToTarget" => {
                let shared = self.clone();
                self.inflight.send_modify(|count| *count += 1);
                contained.spawn(async move {
                    if shared.attached(&params).await.is_err() {
                        shared.safety.fail("A browser safety guard failed", true);
                    }
                    shared.inflight.send_modify(|count| *count -= 1);
                });
            }
            "Page.frameNavigated" if main => {
                if params.pointer("/frame/id").and_then(Value::as_str)
                    == Some(self.main_frame_id.as_str())
                {
                    let mut document = self.document();
                    if document.initialized {
                        document.generation += 1;
                    }
                    document.revision = 0;
                    document.refs.clear();
                }
            }
            "Fetch.requestPaused" => self.request_paused(&event, &params).await?,
            "Page.frameAttached" if main => {
                self.safety.fail("Child frames are unsupported", true);
                let _ = self
                    .command("Page.stopLoading", json!({}), Some(&self.session_id))
                    .await;
            }
            "Page.frameRequestedNavigation" if main => {
                let url = params.get("url").and_then(Value::as_str).unwrap_or("");
                if !request_allowed(url, true, &self.document().allowed_origins) {
                    self.safety.fail(
                        "A disallowed navigation or external protocol was blocked",
                        false,
                    );
                    let _ = self
                        .command("Page.stopLoading", json!({}), Some(&self.session_id))
                        .await;
                }
            }
            "Page.fileChooserOpened" if main => {
                self.safety.fail("File selection is unsupported", false)
            }
            "Browser.downloadWillBegin" => {
                self.safety.downloads.fetch_add(1, Ordering::AcqRel);
            }
            _ => {}
        }
        Ok(())
    }
    pub(super) fn document(&self) -> std::sync::MutexGuard<'_, Document> {
        self.document.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub(super) async fn contained(&self) {
        let _ = self
            .inflight
            .subscribe()
            .wait_for(|count| *count == 0)
            .await;
    }
    fn crashed(&self) {
        self.safety
            .fail("The controllable browser target crashed", true);
    }
    async fn request_paused(&self, event: &cdp::Event, params: &Value) -> Result<(), ()> {
        if let Some(session) = &event.session_id
            && let Some(slot) = self.held.lock().map_err(|_| ())?.get_mut(session)
        {
            if let Some(paused) = slot.take() {
                let _ = paused.send(());
            }
            return Ok(());
        }
        if event.session_id.as_deref() != Some(self.session_id.as_str()) {
            return Ok(());
        }
        let request_id = params.get("requestId").and_then(Value::as_str).ok_or(())?;
        let url = params
            .pointer("/request/url")
            .and_then(Value::as_str)
            .unwrap_or("");
        let document = params.get("resourceType").and_then(Value::as_str) == Some("Document");
        let in_main_frame =
            params.get("frameId").and_then(Value::as_str) == Some(self.main_frame_id.as_str());
        let session = Some(self.session_id.as_str());
        if document && !in_main_frame {
            self.block(request_id).await?;
            self.safety.fail("Child frames are unsupported", true);
            return Ok(());
        }
        let allowed = request_allowed(
            url,
            document && in_main_frame,
            &self.document().allowed_origins,
        );
        if !allowed {
            self.block(request_id).await?;
            self.safety.fail(
                "A disallowed navigation or external protocol was blocked",
                false,
            );
            return Ok(());
        }
        self.command(
            "Fetch.continueRequest",
            json!({"requestId": request_id}),
            session,
        )
        .await?;
        Ok(())
    }
    async fn block(&self, request_id: &str) -> Result<(), ()> {
        self.command(
            "Fetch.failRequest",
            json!({"requestId": request_id, "errorReason": "BlockedByClient"}),
            Some(&self.session_id),
        )
        .await
        .map(|_| ())
    }
    async fn attached(self: &Arc<Self>, params: &Value) -> Result<(), ()> {
        let Some(target) = params.get("targetInfo").filter(|target| target.is_object()) else {
            self.safety
                .fail("An unexpected browser target could not be identified", true);
            return Ok(());
        };
        let Some(target_id) = target.get("targetId").and_then(Value::as_str) else {
            self.safety
                .fail("An unexpected browser target could not be identified", true);
            return Ok(());
        };
        if target_id == self.target_id {
            return Ok(());
        }
        let popup = target.get("browserContextId").and_then(Value::as_str)
            == Some(self.browser_context_id.as_str())
            && target.get("type").and_then(Value::as_str) == Some("page")
            && target.get("openerId").and_then(Value::as_str) == Some(self.target_id.as_str())
            && params.get("waitingForDebugger") == Some(&Value::Bool(true));
        let popup_session = params.get("sessionId").and_then(Value::as_str);
        match (popup, popup_session) {
            (true, Some(session)) => self.contain(session, target_id).await,
            _ => self.close_exactly(target_id).await,
        }
    }
    async fn contain(&self, popup_session: &str, popup_target: &str) -> Result<(), ()> {
        let (paused, first_request) = oneshot::channel();
        self.held
            .lock()
            .map_err(|_| ())?
            .insert(popup_session.to_owned(), Some(paused));
        let outcome = async {
            let session = Some(popup_session);
            self.command(
                "Emulation.setScriptExecutionDisabled",
                json!({"value": true}),
                session,
            )
            .await?;
            self.command(
                "Fetch.enable",
                json!({"patterns": [{"urlPattern": "*", "requestStage": "Request"}]}),
                session,
            )
            .await?;
            self.command("Runtime.runIfWaitingForDebugger", json!({}), session)
                .await?;
            let _ = tokio::time::timeout(POPUP_HOLD, first_request).await;
            self.close_exactly(popup_target).await
        }
        .await;
        self.held.lock().map_err(|_| ())?.remove(popup_session);
        if outcome.is_ok() {
            self.safety.popups.fetch_add(1, Ordering::AcqRel);
            return Ok(());
        }
        self.safety
            .fail("An unexpected browser target could not be contained", true);
        let _ = self.close_exactly(popup_target).await;
        Ok(())
    }
    async fn close_exactly(&self, target_id: &str) -> Result<(), ()> {
        let (destroyed, acknowledged) = oneshot::channel();
        self.destroyed
            .lock()
            .map_err(|_| ())?
            .insert(target_id.to_owned(), destroyed);
        let outcome = async {
            self.command("Target.closeTarget", json!({"targetId": target_id}), None)
                .await?;
            tokio::time::timeout(self.destruction_timeout, acknowledged)
                .await
                .map_err(|_| ())?
                .map_err(|_| ())
        }
        .await;
        self.destroyed.lock().map_err(|_| ())?.remove(target_id);
        outcome
    }
    async fn command(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value, ()> {
        self.client
            .send(method, params, session, None, None)
            .await
            .map_err(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::{HashSet, request_allowed, safe_url};

    #[test]
    fn requests_are_allowed_only_within_the_approved_origin_and_inert_subresources() {
        let allowed = HashSet::from(["https://example.test".to_owned()]);
        for (url, top_level, expected) in [
            ("about:blank", true, true),
            ("https://example.test/a", true, true),
            ("https://other.test/a", true, false),
            ("https://other.test/a", false, true),
            ("data:text/plain,x", false, true),
            ("data:text/plain,x", true, false),
            ("blob:https://example.test/id", false, true),
            ("intent://launch", false, false),
            ("file:///etc/passwd", true, false),
            ("not a url", false, false),
        ] {
            assert_eq!(request_allowed(url, top_level, &allowed), expected, "{url}");
        }
    }

    #[test]
    fn initial_pages_must_be_credential_free_http_pages() {
        assert!(safe_url("https://example.test/path").is_ok());
        for input in [
            "file:///etc/passwd",
            "https://user:secret@example.test/",
            "https://user@example.test/",
            "about:blank",
            "garbage",
        ] {
            assert_eq!(
                safe_url(input).unwrap_err().message,
                "Only credential-free HTTP and HTTPS pages are supported",
                "{input}"
            );
        }
    }
}
