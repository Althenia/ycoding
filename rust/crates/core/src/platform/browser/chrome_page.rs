use super::{
    Error, capture,
    chrome_process::error,
    chrome_semantics::{
        array, attributes_of, domain, file_input, get, integer, lossless, nested, protected_input,
        string, utf8_size,
    },
    chrome_target::{RefTarget, Shared, request_allowed, safe_url},
    isolated::{ActionOutput, ExecutorError, Phase, Snapshot},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::sync::watch;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, browser, parse_json,
    stringify_json,
};

const PAUSED: &str = "Isolated browser control is paused";
const FOCUS_REFUSAL: &str = "This key requires verified keyboard focus in profile, owned, and isolated modes; focus was refused only for a sensitive password, one-time-code, payment, or secret-named field, a file input, or unverified focus";
const FOCUS_WORLD: &str = "ycoding-key-focus";

struct FocusRoot {
    session: String,
    frame: String,
}

impl Shared {
    pub(super) fn pause(&self) {
        self.safety.set_paused(true);
    }

    pub(super) fn resume(&self) -> Result<(), ExecutorError> {
        if let Some(failure) = self.safety.failure() {
            return Err(error(failure));
        }
        self.safety.set_paused(false);
        let mut document = self.document();
        document.refs.clear();
        document.revision = 0;
        Ok(())
    }

    pub(super) async fn observe(&self) -> Result<Snapshot, ExecutorError> {
        self.snapshot(true, None).await
    }

    pub(super) async fn act(
        &self,
        action: browser::Action,
        origins: Vec<String>,
        cancel: watch::Receiver<bool>,
    ) -> Result<ActionOutput, ExecutorError> {
        self.ensure_active()?;
        if matches!(
            action,
            browser::Action::ClipboardRead(_)
                | browser::Action::ClipboardWrite(_)
                | browser::Action::Upload(_)
                | browser::Action::Download(_)
                | browser::Action::Group(_)
                | browser::Action::Ungroup(_)
                | browser::Action::GroupControl(_)
        ) {
            return Err(error("This action is unavailable in isolated mode"));
        }
        self.document().allowed_origins = origins.iter().cloned().collect::<HashSet<_>>();
        let attempt = Attempt {
            page: self,
            cancel: cancel.clone(),
            dispatched: AtomicBool::new(false),
        };
        for origin in &origins {
            tokio::try_join!(
                self.deny_permission("clipboard-read", origin, &cancel),
                self.deny_permission("clipboard-write", origin, &cancel),
            )?;
        }
        let popups = self.safety.popups();
        let downloads = self.safety.downloads();
        let peripheral = attempt.perform(&action).await?;
        tokio::select! {
            () = tokio::time::sleep(self.settle) => {}
            () = cancelled(cancel.clone()) => {
                return Err(attempt.reject("Isolated browser operation was canceled"));
            }
        }
        self.contained().await;
        if let Some(failure) = self.safety.failure() {
            return Err(attempt.reject(&failure));
        }
        if self.safety.downloads() != downloads {
            return Err(attempt.reject("A download attempt was blocked"));
        }
        let snapshot = self
            .snapshot(false, Some(cancel))
            .await
            .map_err(|failure| ExecutorError {
                phase: attempt.phase(),
                ..failure
            })?;
        Ok(ActionOutput {
            snapshot,
            capture: peripheral.capture,
            text: peripheral.text,
            data: peripheral.data,
            logs: peripheral.logs,
            webmcp_tools: peripheral.webmcp_tools,
            rejected: (self.safety.popups() != popups)
                .then(|| LosslessString::from("A popup was safely blocked")),
            dialog: peripheral.dialog,
            control: peripheral.control,
            frame: peripheral.frame,
            message: peripheral.message,
        })
    }

    async fn deny_permission(
        &self,
        name: &str,
        origin: &str,
        cancel: &watch::Receiver<bool>,
    ) -> Result<(), ExecutorError> {
        self.client
            .send(
                "Browser.setPermission",
                json!({
                    "permission": {"name": name},
                    "setting": "denied",
                    "origin": origin,
                    "browserContextId": self.browser_context_id,
                }),
                None,
                Some(cancel.clone()),
                None,
            )
            .await
            .map(|_| ())
            .map_err(|failure| cdp_failure(&failure, "Isolated browser action failed", false))
    }

    pub(super) fn ensure_active(&self) -> Result<(), ExecutorError> {
        if self.safety.paused() {
            return Err(error(
                self.safety.failure().unwrap_or_else(|| PAUSED.into()),
            ));
        }
        Ok(())
    }
}

struct Attempt<'a> {
    page: &'a Shared,
    cancel: watch::Receiver<bool>,
    dispatched: AtomicBool,
}
#[derive(Default)]
struct Peripherals {
    capture: Option<browser::CaptureOutput>,
    text: Option<LosslessString>,
    data: Option<LosslessString>,
    logs: Option<Vec<browser::LogEntry>>,
    webmcp_tools: Option<Vec<browser::WebMcpTool>>,
    dialog: Option<browser::DialogInfo>,
    control: Option<browser::ControlState>,
    frame: Option<browser::Page>,
    message: Option<LosslessString>,
}
impl Attempt<'_> {
    fn reject(&self, message: &str) -> ExecutorError {
        ExecutorError {
            message: message.into(),
            phase: self.phase(),
        }
    }
    fn phase(&self) -> Phase {
        if self.dispatched.load(Ordering::Acquire) {
            Phase::Postdispatch
        } else {
            Phase::Predispatch
        }
    }
    fn dispatch(&self) {
        self.dispatched.store(true, Ordering::Release);
    }
    async fn send<P: super::cdp::Message>(
        &self,
        method: &str,
        params: P,
    ) -> Result<P, ExecutorError> {
        self.send_to(method, params, &self.page.session_id).await
    }
    async fn send_to<P: super::cdp::Message>(
        &self,
        method: &str,
        params: P,
        session: &str,
    ) -> Result<P, ExecutorError> {
        self.page
            .client
            .send(
                method,
                params,
                Some(session),
                Some(self.cancel.clone()),
                None,
            )
            .await
            .map_err(|failure| {
                cdp_failure(
                    &failure,
                    "Isolated browser action failed",
                    self.phase() == Phase::Postdispatch,
                )
            })
    }
    async fn describe(&self, reference: &str) -> Result<(RefTarget, JsonValue), ExecutorError> {
        let backend = self
            .page
            .document()
            .refs
            .get(reference)
            .cloned()
            .ok_or_else(|| self.reject("Semantic element reference is stale"))?;
        let node = self
            .page
            .describe(backend.backend, &backend.session, Some(self.cancel.clone()))
            .await
            .map_err(|failure| {
                cdp_failure(
                    &failure,
                    "Isolated browser action failed",
                    self.phase() == Phase::Postdispatch,
                )
            })?;
        Ok((backend, node))
    }

    async fn resolve(&self, backend: &RefTarget) -> Result<String, ExecutorError> {
        let value = self
            .send_to(
                "DOM.resolveNode",
                json!({"backendNodeId": backend.backend}),
                &backend.session,
            )
            .await?;
        value
            .pointer("/object/objectId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| self.reject("Chrome omitted an identifier"))
    }
    async fn call_on(
        &self,
        declaration: &str,
        arguments: Value,
        object_id: &str,
        session: &str,
    ) -> Result<JsonValue, ExecutorError> {
        let response = self
            .send_to(
                "Runtime.callFunctionOn",
                domain(
                    json!({"functionDeclaration": declaration, "objectId": object_id, "arguments": arguments, "returnByValue": true, "userGesture": true}),
                ),
                session,
            )
            .await?;
        self.function_value(&response)
    }
    fn function_value(&self, response: &JsonValue) -> Result<JsonValue, ExecutorError> {
        if let Some(details) = get(response, "exceptionDetails") {
            let message = string(nested(details, &["exception", "description"]))
                .or_else(|| string(get(details, "text")))
                .unwrap_or("Page evaluation failed");
            return Err(ExecutorError {
                message: bounded(message, 1024),
                phase: self.phase(),
            });
        }
        nested(response, &["result", "value"])
            .cloned()
            .ok_or_else(|| self.reject("Chrome returned an invalid response"))
    }
    async fn call_document(
        &self,
        declaration: &str,
        arguments: Value,
        frame: &str,
        session: &str,
    ) -> Result<JsonValue, ExecutorError> {
        let world = self
            .send_to(
                "Page.createIsolatedWorld",
                domain(json!({"frameId": frame, "worldName": "ycoding-browser-wait", "grantUniveralAccess": false})),
                session,
            )
            .await?;
        let context = integer(get(&world, "executionContextId"))
            .ok_or_else(|| self.reject("Chrome omitted a number"))?;
        let response = self
            .send_to(
                "Runtime.callFunctionOn",
                domain(
                    json!({"functionDeclaration": declaration, "arguments": arguments, "executionContextId": context, "returnByValue": true}),
                ),
                session,
            )
            .await?;
        self.function_value(&response)
    }
    fn element_frame(&self, backend: &RefTarget) -> Option<browser::Page> {
        if backend.frame == self.page.main_frame_id {
            return None;
        }
        super::bridge::safe_page(&backend.url.as_str().into()).ok()
    }
    async fn control_state(
        &self,
        backend: &RefTarget,
        object_id: &str,
    ) -> Result<browser::ControlState, ExecutorError> {
        let value = self
            .call_on(
                &super::chrome_safety::f_control_state(),
                json!([]),
                object_id,
                &backend.session,
            )
            .await?;
        if get(&value, "sensitive") == Some(&JsonValue::Bool(true)) {
            return Ok(browser::ControlState {
                checked: None,
                value: None,
                selected: None,
                sensitive: Some(true),
            });
        }
        let selected = get(&value, "selected").map(|_| {
            array(get(&value, "selected"))
                .iter()
                .filter_map(|option| {
                    let index = integer(get(option, "index")).filter(|index| *index >= 0)?;
                    Some(browser::SelectedOption {
                        value: lossless(get(option, "value"))
                            .map(|text| super::payload::bounded(text, browser::MAX_NAME_LENGTH)),
                        label: super::payload::bounded(
                            lossless(get(option, "label"))?,
                            browser::MAX_NAME_LENGTH,
                        ),
                        index: ycoding_schema::schema::NonNegativeInt::new(index).ok()?,
                    })
                })
                .take(browser::MAX_SELECT_OPTIONS)
                .collect::<Vec<_>>()
        });
        Ok(super::operation::sanitize_control(browser::ControlState {
            checked: match get(&value, "checked") {
                Some(JsonValue::Bool(value)) => Some(browser::Tristate::Boolean(*value)),
                Some(JsonValue::String(value)) if value.as_str() == Some("mixed") => {
                    Some(browser::Tristate::Mixed)
                }
                _ => None,
            },
            value: lossless(get(&value, "value"))
                .map(|text| super::payload::bounded(text, browser::MAX_NAME_LENGTH)),
            selected,
            sensitive: None,
        }))
    }
    fn evaluate_error(&self, value: &JsonValue) -> Option<String> {
        string(get(value, "error")).map(str::to_owned)
    }

    async fn perform(&self, action: &browser::Action) -> Result<Peripherals, ExecutorError> {
        let mut output = Peripherals::default();
        match action {
            browser::Action::Navigate(navigate) => {
                let destination = navigate
                    .url
                    .to_utf8()
                    .map_err(|_| {
                        self.reject("Only credential-free HTTP and HTTPS pages are supported")
                    })
                    .and_then(|url| {
                        safe_url(&url).map_err(|failure| self.reject(&failure.message))
                    })?;
                if !self
                    .page
                    .document()
                    .allowed_origins
                    .contains(&destination.origin().ascii_serialization())
                {
                    return Err(self.reject("Navigation origin is not approved"));
                }
                self.dispatch();
                self.send("Page.navigate", json!({"url": destination.as_str()}))
                    .await?;
            }
            browser::Action::Click(click) => output.frame = self.click(click).await?,
            browser::Action::Type(typed) => {
                let reference = typed
                    .r#ref
                    .as_ref()
                    .and_then(|r| r.to_utf8().ok())
                    .unwrap_or_default();
                let (backend, node) = self.describe(&reference).await?;
                output.frame = self.element_frame(&backend);
                if protected_input(&node) {
                    return Err(self.reject("Protected inputs are unsupported"));
                }
                self.assert_editable(&backend, &node).await?;
                self.dispatch();
                self.send_to(
                    "DOM.focus",
                    json!({"backendNodeId": backend.backend}),
                    &backend.session,
                )
                .await?;
                self.send_to(
                    "Input.insertText",
                    ObjectEncoder::new().field("text", &typed.text).finish(),
                    &backend.session,
                )
                .await?;
            }
            browser::Action::Scroll(scroll) => {
                self.dispatch();
                self.send(
                    "Input.dispatchMouseEvent",
                    json!({"type": "mouseWheel", "x": 0, "y": 0, "deltaX": 0, "deltaY": scroll.delta_y.get()}),
                )
                .await?;
            }
            browser::Action::Capture(capture_action) => {
                let mut clip = capture_action.clip;
                if let Some(reference) = &capture_action.r#ref {
                    let reference = reference.to_utf8().unwrap_or_default();
                    let (backend, _) = self.describe(&reference).await?;
                    output.frame = self.element_frame(&backend);
                    let quads = self
                        .send_to(
                            "DOM.getContentQuads",
                            json!({"backendNodeId": backend.backend}),
                            &backend.session,
                        )
                        .await?;
                    let quad = quads
                        .pointer("/quads/0")
                        .and_then(Value::as_array)
                        .filter(|quad| quad.len() >= 8 && quad.iter().all(Value::is_number))
                        .ok_or_else(|| self.reject("Element is not visible"))?;
                    let xs = [0, 2, 4, 6].map(|i| quad[i].as_f64().unwrap_or_default());
                    let ys = [1, 3, 5, 7].map(|i| quad[i].as_f64().unwrap_or_default());
                    let x = xs.into_iter().fold(f64::INFINITY, f64::min).floor();
                    let y = ys.into_iter().fold(f64::INFINITY, f64::min).floor();
                    let width = xs.into_iter().fold(f64::NEG_INFINITY, f64::max).ceil() - x;
                    let height = ys.into_iter().fold(f64::NEG_INFINITY, f64::max).ceil() - y;
                    clip = Some(browser::Clip::decode_at(
                        &parse_json(
                            &json!({"x": x as i64, "y": y as i64, "width": width as i64, "height": height as i64}).to_string(),
                        )
                        .map_err(|_| self.reject("Chrome returned an invalid response"))?,
                        &ycoding_schema::JsonPath::default(),
                    )
                    .map_err(|_| self.reject("Element is not visible"))?);
                }
                let frames = self
                    .page
                    .document()
                    .frames
                    .iter()
                    .filter(|(_, frame)| frame.session != self.page.session_id)
                    .map(|(id, frame)| (id.clone(), frame.session.clone()))
                    .collect::<Vec<_>>();
                let captured = capture::capture_options(
                    &self.page.client,
                    &self.page.session_id,
                    &frames,
                    Some(self.cancel.clone()),
                    clip,
                    capture_action.full_page == Some(true),
                )
                .await
                .map_err(|failure| ExecutorError {
                    message: bounded(&failure.message, 1024),
                    phase: self.phase(),
                })?;
                output.capture = Some(browser::CaptureOutput::decode(
                    &parse_json(
                        &json!({"mediaType": captured.media_type, "data": captured.data, "bytes": captured.bytes})
                            .to_string(),
                    )
                    .map_err(|_| self.reject("Chrome returned an invalid response"))?,
                )
                .map_err(|_| self.reject("Chrome returned an invalid response"))?);
            }
            browser::Action::Fill(action) => self.fill(action, &mut output).await?,
            browser::Action::Select(action) => self.select(action, &mut output).await?,
            browser::Action::Check(action) => self.check(action, &mut output).await?,
            browser::Action::Hover(action) => self.hover(action, &mut output).await?,
            browser::Action::Dialog(action) => self.dialog(action, &mut output).await?,
            browser::Action::Group(_)
            | browser::Action::Ungroup(_)
            | browser::Action::GroupControl(_)
            | browser::Action::ClipboardRead(_)
            | browser::Action::ClipboardWrite(_)
            | browser::Action::Upload(_)
            | browser::Action::Download(_) => {
                return Err(self.reject("This action is unavailable in isolated mode"));
            }
            browser::Action::Back(_) | browser::Action::Forward(_) => {
                self.history(matches!(action, browser::Action::Forward(_)))
                    .await?
            }
            browser::Action::Reload(_) => {
                self.dispatch();
                self.send("Page.reload", json!({})).await?;
            }
            browser::Action::Key(action) => self.key(action).await?,
            browser::Action::Wait(action) => self.wait(action).await?,
            browser::Action::Logs(action) => {
                let limit = action
                    .limit
                    .map_or(browser::MAX_LOG_ENTRIES, |limit| limit.get() as usize);
                let document = self.page.document();
                output.logs = Some(
                    document
                        .logs
                        .iter()
                        .skip(document.logs.len().saturating_sub(limit))
                        .cloned()
                        .collect(),
                );
            }
            browser::Action::Export(_) => {
                let value = self
                    .send("Page.captureSnapshot", domain(json!({"format":"mhtml"})))
                    .await?;
                let data = lossless(get(&value, "data"))
                    .filter(|data| !data.is_empty())
                    .ok_or_else(|| self.reject("Chrome returned an invalid archive"))?;
                if utf8_size(&data) > 8 * 1024 * 1024 {
                    return Err(self.reject("Export exceeds the 8 MiB limit"));
                }
                output.data = Some(data);
            }
            browser::Action::WebMcpList(_) => output.webmcp_tools = Some(self.webmcp_list().await?),
            browser::Action::WebMcpInvoke(action) => {
                let tools = self.webmcp_list().await?;
                if !tools.iter().any(|tool| tool.name == action.name) {
                    return Err(self.reject("WebMCP tool is no longer available on this page"));
                }
                let name = stringify_json(&action.name.encode());
                let arguments = action
                    .arguments
                    .as_ref()
                    .map(DomainEncode::encode)
                    .unwrap_or_else(|| domain(json!({})));
                let arguments = stringify_json(&arguments);
                self.dispatch();
                let value = self.evaluate(&format!("if(typeof mc.executeTool==='function')return {{supported:true,result:await mc.executeTool({name},{arguments})}};if(typeof mc.callTool==='function')return {{supported:true,result:await mc.callTool({name},{arguments})}};return {{supported:true,unsupportedInvoke:true}};")).await?;
                if get(&value, "unsupportedInvoke") == Some(&JsonValue::Bool(true)) {
                    return Err(self.reject("WebMCP invocation is not supported on this page"));
                }
                let result = get(&value, "result")
                    .ok_or_else(|| self.reject("Chrome returned an invalid WebMCP response"))?;
                let text = lossless(Some(result)).unwrap_or_else(|| stringify_json(result).into());
                if utf8_size(&text) > browser::MAX_CLIPBOARD_BYTES {
                    return Err(self.reject("WebMCP result exceeds the 64 KiB limit"));
                }
                output.text = Some(text);
            }
        }
        Ok(output)
    }

    async fn history(&self, forward: bool) -> Result<(), ExecutorError> {
        let history = self
            .send("Page.getNavigationHistory", domain(json!({})))
            .await?;
        let current = integer(get(&history, "currentIndex"))
            .ok_or_else(|| self.reject("Chrome omitted the navigation history index"))?;
        let index = current + if forward { 1 } else { -1 };
        let entry = usize::try_from(index)
            .ok()
            .and_then(|index| array(get(&history, "entries")).get(index))
            .ok_or_else(|| {
                self.reject(if forward {
                    "No later page in history"
                } else {
                    "No earlier page in history"
                })
            })?;
        let url = string(get(entry, "url"))
            .and_then(|url| safe_url(url).ok())
            .ok_or_else(|| self.reject("History target is not approved"))?;
        if !self
            .page
            .document()
            .allowed_origins
            .contains(&url.origin().ascii_serialization())
        {
            return Err(self.reject("History target is not approved"));
        }
        let entry_id = integer(get(entry, "id"))
            .ok_or_else(|| self.reject("Chrome omitted the navigation history entry"))?;
        self.dispatch();
        self.send("Page.navigateToHistoryEntry", json!({"entryId":entry_id}))
            .await?;
        Ok(())
    }

    async fn focus_inspection(&self) -> Result<(), ExecutorError> {
        let (roots, frame_urls) = self.focus_roots().await?;
        let allowed_origins = self.page.document().allowed_origins.clone();
        for root in &roots {
            if self
                .focus_root_refused(root, &roots, &frame_urls, &allowed_origins)
                .await?
            {
                return Err(self.reject(FOCUS_REFUSAL));
            }
        }
        Ok(())
    }

    async fn focus_roots(
        &self,
    ) -> Result<(Vec<FocusRoot>, HashMap<String, url::Url>), ExecutorError> {
        self.page.contained().await;
        if self.page.safety.failure().is_some() {
            return Err(self.reject("A frame could not be inspected for sensitive fields"));
        }
        let mut frame_urls = HashMap::new();
        {
            let document = self.page.document();
            for frame in document.frames.values() {
                if frame.target.is_some() && frame.session != self.page.session_id {
                    frame_urls
                        .entry(frame.session.clone())
                        .or_insert_with(|| frame.url.clone());
                }
            }
        }
        let mut sessions = frame_urls.keys().cloned().collect::<Vec<_>>();
        sessions.sort();
        let mut roots = vec![FocusRoot {
            session: self.page.session_id.clone(),
            frame: self.page.main_frame_id.clone(),
        }];
        for session in sessions {
            let tree: JsonValue = self
                .send_to("Page.getFrameTree", domain(json!({})), &session)
                .await?;
            let frame = string(nested(&tree, &["frameTree", "frame", "id"]))
                .filter(|id| !id.is_empty())
                .ok_or_else(|| self.reject("Chrome omitted an identifier"))?
                .to_owned();
            roots.push(FocusRoot { session, frame });
        }
        Ok((roots, frame_urls))
    }

    async fn focus_root_refused(
        &self,
        root: &FocusRoot,
        roots: &[FocusRoot],
        frame_urls: &HashMap<String, url::Url>,
        allowed_origins: &HashSet<String>,
    ) -> Result<bool, ExecutorError> {
        let world: JsonValue = self
            .send_to(
                "Page.createIsolatedWorld",
                domain(
                    json!({"frameId": root.frame, "worldName": FOCUS_WORLD, "grantUniveralAccess": false}),
                ),
                &root.session,
            )
            .await?;
        let Some(context) = integer(get(&world, "executionContextId")) else {
            return Ok(true);
        };
        let response: JsonValue = self
            .send_to(
                "Runtime.callFunctionOn",
                domain(json!({
                    "functionDeclaration": super::chrome_safety::F_ACTIVE_ELEMENT,
                    "arguments": [],
                    "executionContextId": context,
                    "returnByValue": false,
                    "objectGroup": FOCUS_WORLD,
                })),
                &root.session,
            )
            .await?;
        if get(&response, "exceptionDetails").is_some() {
            return Ok(true);
        }
        let Some(object_id) = get(&response, "result")
            .and_then(|result| string(get(result, "objectId")))
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
        else {
            return Ok(true);
        };
        let refused = self
            .focus_leaf_refused(root, roots, frame_urls, allowed_origins, &object_id)
            .await;
        let _ = self
            .send_to(
                "Runtime.releaseObjectGroup",
                json!({"objectGroup": FOCUS_WORLD}),
                &root.session,
            )
            .await;
        refused
    }

    async fn focus_leaf_refused(
        &self,
        root: &FocusRoot,
        roots: &[FocusRoot],
        frame_urls: &HashMap<String, url::Url>,
        allowed_origins: &HashSet<String>,
        object_id: &str,
    ) -> Result<bool, ExecutorError> {
        let described: JsonValue = self
            .send_to(
                "DOM.describeNode",
                domain(json!({"objectId": object_id, "depth": 0, "pierce": true})),
                &root.session,
            )
            .await?;
        let Some(node) = get(&described, "node")
            .filter(|node| matches!(node, JsonValue::Object(_)))
            .cloned()
        else {
            return Ok(true);
        };
        let node_name = string(get(&node, "nodeName"))
            .filter(|name| !name.is_empty())
            .map(str::to_owned);
        let backend = integer(get(&node, "backendNodeId"));
        let attributes_valid = matches!(
            get(&node, "attributes"),
            Some(JsonValue::Array(values))
                if values.len() % 2 == 0
                    && values.iter().all(|value| matches!(value, JsonValue::String(_)))
        );
        let shadow_roots_valid =
            matches!(get(&node, "shadowRoots"), None | Some(JsonValue::Array(_)));
        if integer(get(&node, "nodeType")) != Some(1)
            || node_name.is_none()
            || backend.is_none()
            || !attributes_valid
            || !shadow_roots_valid
        {
            return Ok(true);
        }
        let node_name = node_name.unwrap();
        let backend = backend.unwrap();
        if self
            .call_on(
                super::chrome_safety::F_CONNECTED,
                json!([]),
                object_id,
                &root.session,
            )
            .await?
            != JsonValue::Bool(true)
        {
            return Ok(true);
        }
        let shadow_roots = array(get(&node, "shadowRoots"));
        if shadow_roots.iter().any(|entry| {
            !matches!(entry, JsonValue::Object(_))
                || !matches!(
                    string(get(entry, "shadowRootType")),
                    Some("closed" | "open" | "user-agent")
                )
        }) {
            return Ok(true);
        }
        let closed_shadow_root = shadow_roots
            .iter()
            .any(|entry| string(get(entry, "shadowRootType")) == Some("closed"));
        let frame_unreachable = self
            .call_on(
                super::chrome_safety::F_FRAME_UNREACHABLE,
                json!([]),
                object_id,
                &root.session,
            )
            .await?;
        let JsonValue::Bool(frame_unreachable) = frame_unreachable else {
            return Ok(true);
        };
        if frame_unreachable {
            let inspected = string(get(&node, "frameId"))
                .and_then(|frame_id| {
                    roots.iter().find(|candidate| {
                        candidate.frame == frame_id && candidate.session != root.session
                    })
                })
                .and_then(|owned| frame_urls.get(&owned.session))
                .and_then(|url| super::bridge::safe_page(&url.as_str().into()).ok())
                .is_some_and(|page| {
                    page.origin
                        .as_str()
                        .is_some_and(|origin| allowed_origins.contains(origin))
                });
            return Ok(super::chrome_safety::refuses_editing_key(
                Some(false),
                Some(closed_shadow_root),
                Some(Some(inspected)),
            ));
        }
        if self
            .call_on(
                &super::chrome_safety::f_refuse_field(),
                json!([]),
                object_id,
                &root.session,
            )
            .await?
            != JsonValue::Bool(false)
        {
            return Ok(true);
        }
        let tree: JsonValue = self
            .send_to(
                "Accessibility.getPartialAXTree",
                domain(json!({"objectId": object_id, "fetchRelatives": false})),
                &root.session,
            )
            .await?;
        let accessible_name = array(get(&tree, "nodes"))
            .iter()
            .filter(|candidate| matches!(candidate, JsonValue::Object(_)))
            .find(|candidate| integer(get(candidate, "backendDOMNodeId")) == Some(backend))
            .and_then(|candidate| nested(candidate, &["name", "value"]))
            .and_then(|value| match value {
                JsonValue::String(value) => Some(String::from_utf16_lossy(
                    &value.code_units().collect::<Vec<_>>(),
                )),
                _ => None,
            });
        let attributes = attributes_of(get(&node, "attributes"));
        if accessible_name.is_none()
            && super::chrome_safety::is_editable_field(&node_name, &attributes)
        {
            return Ok(true);
        }
        let sensitive = file_input(&node)
            || super::chrome_safety::is_sensitive_attributes(
                &node_name,
                &attributes,
                accessible_name.as_deref().unwrap_or(""),
            );
        Ok(super::chrome_safety::refuses_editing_key(
            Some(sensitive),
            Some(closed_shadow_root),
            None,
        ))
    }

    async fn key(&self, action: &browser::Key) -> Result<(), ExecutorError> {
        let modifier_names: Vec<String> = action
            .modifiers
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|modifier| match modifier {
                browser::Modifier::Alt => "Alt".into(),
                browser::Modifier::Control => "Control".into(),
                browser::Modifier::Meta => "Meta".into(),
                browser::Modifier::Shift => "Shift".into(),
            })
            .collect();
        if !super::chrome_safety::is_safe_navigation_key(
            action.key.as_str().unwrap_or(""),
            &modifier_names,
        ) {
            self.focus_inspection().await?;
        }
        let modifiers =
            action
                .modifiers
                .as_deref()
                .unwrap_or_default()
                .iter()
                .fold(0, |bits, modifier| {
                    bits | match modifier {
                        browser::Modifier::Alt => 1,
                        browser::Modifier::Control => 2,
                        browser::Modifier::Meta => 4,
                        browser::Modifier::Shift => 8,
                    }
                });
        let named = match action.key.as_str() {
            Some("Enter") => Some(("Enter", "Enter", 13)),
            Some("Tab") => Some(("Tab", "Tab", 9)),
            Some("Escape") => Some(("Escape", "Escape", 27)),
            Some("Backspace") => Some(("Backspace", "Backspace", 8)),
            Some("Delete") => Some(("Delete", "Delete", 46)),
            Some("ArrowLeft") => Some(("ArrowLeft", "ArrowLeft", 37)),
            Some("ArrowUp") => Some(("ArrowUp", "ArrowUp", 38)),
            Some("ArrowRight") => Some(("ArrowRight", "ArrowRight", 39)),
            Some("ArrowDown") => Some(("ArrowDown", "ArrowDown", 40)),
            Some("Home") => Some(("Home", "Home", 36)),
            Some("End") => Some(("End", "End", 35)),
            Some("PageUp") => Some(("PageUp", "PageUp", 33)),
            Some("PageDown") => Some(("PageDown", "PageDown", 34)),
            Some("Insert") => Some(("Insert", "Insert", 45)),
            Some("Space" | " ") => Some((" ", "Space", 32)),
            _ => None,
        };
        let single = action.key.len() == 1;
        if named.is_none() && !single {
            return Err(self.reject("Unsupported browser key"));
        }
        let key = named
            .map(|named| LosslessString::from(named.0))
            .unwrap_or_else(|| action.key.clone());
        let code = named.map_or("", |named| named.1);
        let virtual_key = named.map_or(0, |named| named.2);
        let text = if modifiers == 0 {
            match action.key.as_str() {
                Some("Enter") => Some(LosslessString::from("\r")),
                Some("Space" | " ") => Some(LosslessString::from(" ")),
                _ if single && named.is_none() => Some(key.clone()),
                _ => None,
            }
        } else {
            None
        };
        self.dispatch();
        for kind in ["keyDown", "keyUp"] {
            let mut event = ObjectEncoder::new()
                .field("type", kind)
                .field("key", &key)
                .field("code", code)
                .field("windowsVirtualKeyCode", &(virtual_key as f64))
                .field("modifiers", &(modifiers as f64));
            if kind == "keyDown"
                && let Some(text) = &text
            {
                event = event.field("text", text);
            }
            self.send("Input.dispatchKeyEvent", event.finish()).await?;
        }
        Ok(())
    }

    async fn wait(&self, action: &browser::Wait) -> Result<(), ExecutorError> {
        let locator = action
            .locator
            .as_ref()
            .map(|locator| {
                locator
                    .to_utf8()
                    .ok()
                    .and_then(|locator| super::operation::parse_locator(&locator))
                    .ok_or_else(|| self.reject("Locator is malformed"))
            })
            .transpose()?;
        let started = std::time::Instant::now();
        let deadline = tokio::time::Instant::now()
            + std::time::Duration::from_millis(
                action.timeout_ms.map_or(5000, |value| value.get()) as u64
            );
        loop {
            if self.wait_check(action, locator.as_ref(), started).await? {
                return Ok(());
            }
            if *self.cancel.borrow() {
                return Err(self.reject("Isolated browser operation was canceled"));
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(self.reject("Timed out waiting for the page"));
            }
            tokio::select! { () = tokio::time::sleep_until(deadline.min(tokio::time::Instant::now()+std::time::Duration::from_millis(50))) => {}, () = cancelled(self.cancel.clone()) => return Err(self.reject("Isolated browser operation was canceled")) }
        }
    }

    async fn wait_check(
        &self,
        action: &browser::Wait,
        locator: Option<&super::operation::ParsedLocator>,
        started: std::time::Instant,
    ) -> Result<bool, ExecutorError> {
        if let Some(pattern) = &action.url {
            let pattern = pattern.to_utf8().unwrap_or_default();
            let target = self
                .send(
                    "Target.getTargetInfo",
                    domain(json!({"targetId": self.page.target_id})),
                )
                .await?;
            let url = string(nested(&target, &["targetInfo", "url"])).unwrap_or("");
            let url = safe_url(url).map_err(|failure| self.reject(&failure.message))?;
            let page = super::bridge::safe_page(&url.as_str().into())
                .map_err(|failure| self.reject(&failure.to_string()))?;
            let value = format!(
                "{}{}",
                page.origin.as_str().unwrap_or(""),
                page.path.as_str().unwrap_or("")
            );
            return Ok(super::chrome_safety::glob_match(&pattern, &value));
        }
        if let Some(text) = &action.text {
            for (frame, session) in self.wait_frames().await? {
                let value = self
                    .call_document(
                        super::chrome_safety::F_TEXT_PRESENT,
                        call_args(&[json_arg(&text.encode())]),
                        &frame,
                        &session,
                    )
                    .await?;
                if value == JsonValue::Bool(true) {
                    return Ok(true);
                }
            }
            return Ok(false);
        }
        if let Some(load) = &action.load {
            if *load == browser::LoadState::NetworkIdle {
                let document = self.page.document();
                let pending: usize = document
                    .network_inflight
                    .values()
                    .map(|requests| requests.len())
                    .sum();
                return Ok(pending == 0
                    && std::time::Instant::now()
                        .duration_since(document.network_quiet_since.max(started))
                        >= std::time::Duration::from_millis(500));
            }
            let value = self
                .call_document(
                    super::chrome_safety::F_READY,
                    json!([]),
                    &self.page.main_frame_id.clone(),
                    &self.page.session_id.clone(),
                )
                .await?;
            let state = match &value {
                JsonValue::String(value) => value.as_str().unwrap_or("").to_owned(),
                _ => String::new(),
            };
            return Ok(match load {
                browser::LoadState::DomContentLoaded => {
                    state == "interactive" || state == "complete"
                }
                _ => state == "complete",
            });
        }
        if locator.is_some() || action.r#ref.is_some() {
            let state = action.state.unwrap_or(if locator.is_some() {
                browser::WaitState::Visible
            } else {
                browser::WaitState::Attached
            });
            let backend = if let Some(locator) = locator {
                self.locator_backend(locator).await?
            } else {
                let reference = action
                    .r#ref
                    .as_ref()
                    .and_then(|r| r.to_utf8().ok())
                    .unwrap_or_default();
                self.page.document().refs.get(&reference).cloned()
            };
            let Some(backend) = backend else {
                return Ok(state == browser::WaitState::Detached);
            };
            if state == browser::WaitState::Attached {
                return Ok(true);
            }
            let object_id = match self.resolve(&backend).await {
                Ok(id) => id,
                Err(_) => return Ok(state == browser::WaitState::Detached),
            };
            let connected = self
                .call_on(
                    super::chrome_safety::F_CONNECTED,
                    json!([]),
                    &object_id,
                    &backend.session,
                )
                .await?;
            if connected != JsonValue::Bool(true) {
                return Ok(state == browser::WaitState::Detached);
            }
            if state == browser::WaitState::Detached {
                return Ok(false);
            }
            let visible = match self
                .send_to(
                    "DOM.getContentQuads",
                    json!({"backendNodeId": backend.backend}),
                    &backend.session,
                )
                .await
            {
                Ok(quads) => quads
                    .pointer("/quads/0")
                    .and_then(Value::as_array)
                    .is_some_and(|quad| quad.len() >= 8),
                Err(_) => false,
            };
            return Ok(match state {
                browser::WaitState::Visible => visible,
                browser::WaitState::Hidden => !visible,
                _ => true,
            });
        }
        let value = self
            .call_document(
                super::chrome_safety::F_READY,
                json!([]),
                &self.page.main_frame_id.clone(),
                &self.page.session_id.clone(),
            )
            .await?;
        Ok(matches!(&value, JsonValue::String(value) if value.as_str() == Some("complete")))
    }

    async fn wait_frames(&self) -> Result<Vec<(String, String)>, ExecutorError> {
        let mut frames = vec![(
            self.page.main_frame_id.clone(),
            self.page.session_id.clone(),
        )];
        let known = self.page.document().discovered_origins.clone();
        let children = self.page.document().frames.clone();
        for (id, frame) in children {
            if known.contains(&frame.url.origin().ascii_serialization())
                && !frames.iter().any(|(existing, _)| *existing == id)
            {
                frames.push((id, frame.session));
            }
        }
        Ok(frames)
    }

    async fn locator_backend(
        &self,
        locator: &super::operation::ParsedLocator,
    ) -> Result<Option<RefTarget>, ExecutorError> {
        let mut matched = 0usize;
        let mut seen = HashSet::new();
        for (frame, session) in self.wait_frames().await? {
            let (nodes, _) = self
                .page
                .ax_tree(&frame, &session, Some(self.cancel.clone()))
                .await
                .map_err(|failure| self.reject(&failure.message))?;
            let inferred = locator.role == "clickable";
            let candidates = if inferred {
                self.page
                    .popup_rows(&frame, &session, &nodes, Some(self.cancel.clone()))
                    .await
                    .map_err(|failure| self.reject(&failure.message))?
                    .0
            } else {
                nodes
                    .iter()
                    .filter(|node| {
                        get(node, "ignored") != Some(&JsonValue::Bool(true))
                            && string(nested(node, &["role", "value"]))
                                == Some(locator.role.as_str())
                    })
                    .filter_map(|node| {
                        Some((
                            integer(get(node, "backendDOMNodeId"))?,
                            lossless(nested(node, &["name", "value"])).unwrap_or_default(),
                        ))
                    })
                    .collect()
            };
            for (backend, name) in candidates {
                if !super::operation::locator_name_matches(&locator.name, &name)
                    || !seen.insert((session.clone(), backend))
                {
                    continue;
                }
                if matched == locator.nth {
                    return Ok(Some(RefTarget {
                        backend,
                        session: session.clone(),
                        frame: frame.clone(),
                        url: self
                            .page
                            .document()
                            .frames
                            .get(&frame)
                            .map(|target| target.url.clone())
                            .unwrap_or_else(|| url::Url::parse("about:blank").expect("static URL")),
                        inferred,
                    }));
                }
                matched += 1;
            }
        }
        Ok(None)
    }

    async fn evaluate(&self, body: &str) -> Result<JsonValue, ExecutorError> {
        let expression = format!(
            "(async()=>{{const mc=(typeof document!=='undefined'&&document.modelContext)||(typeof navigator!=='undefined'&&navigator.modelContext)||undefined;if(!mc)return {{supported:false}};{body}}})()"
        );
        let response = self.send("Runtime.evaluate", domain(json!({"expression":expression,"awaitPromise":true,"returnByValue":true,"userGesture":true}))).await?;
        if get(&response, "exceptionDetails").is_some() {
            return Err(self.reject("WebMCP execution failed"));
        }
        let value = nested(&response, &["result", "value"])
            .ok_or_else(|| self.reject("Chrome returned an invalid WebMCP response"))?;
        if get(value, "supported") != Some(&JsonValue::Bool(true)) {
            return Err(self.reject("WebMCP is not available on this page"));
        }
        Ok(value.clone())
    }

    async fn webmcp_list(&self) -> Result<Vec<browser::WebMcpTool>, ExecutorError> {
        let value = self.evaluate("const tools=typeof mc.getTools==='function'?await mc.getTools():(mc.tools??[]);return {supported:true,tools:[...tools].map(tool=>({name:String(tool?.name??''),description:String(tool?.description??'')}))};").await?;
        Ok(array(get(&value, "tools"))
            .iter()
            .filter_map(|tool| {
                let name = lossless(get(tool, "name")).filter(|name| !name.is_empty())?;
                let description = lossless(get(tool, "description"))
                    .filter(|text| !text.is_empty())
                    .map(|text| super::payload::bounded(text, browser::MAX_NAME_LENGTH));
                Some(browser::WebMcpTool {
                    name: super::payload::bounded(name, 128),
                    description,
                })
            })
            .take(browser::MAX_LOG_ENTRIES)
            .collect())
    }

    async fn click(&self, click: &browser::Click) -> Result<Option<browser::Page>, ExecutorError> {
        let reference = click
            .r#ref
            .as_ref()
            .and_then(|r| r.to_utf8().ok())
            .unwrap_or_default();
        let (backend, node) = self.describe(&reference).await?;
        let frame = self.element_frame(&backend);
        self.click_target(&backend, &node).await?;
        Ok(frame)
    }

    async fn click_target(
        &self,
        backend: &RefTarget,
        node: &JsonValue,
    ) -> Result<(), ExecutorError> {
        let attributes = attributes_of(get(node, "attributes"));
        if attributes.contains_key("download") {
            return Err(self.reject("Downloads are unsupported"));
        }
        if attributes
            .get("target")
            .is_some_and(|target| !target.is_empty() && target != "_self")
        {
            return Err(self.reject("New tabs and popups are unsupported"));
        }
        if let Some(href) = attributes.get("href").filter(|href| !href.is_empty()) {
            let approved = backend
                .url
                .join(href)
                .map(|destination| {
                    request_allowed(
                        destination.as_str(),
                        true,
                        &self.page.document().allowed_origins,
                    )
                })
                .unwrap_or(false);
            if !approved {
                return Err(self.reject("Link destination is not approved"));
            }
        }
        if protected_input(node) {
            return Err(self.reject("Protected inputs are unsupported"));
        }
        let (x, y) = self.point_for(backend).await?;
        if backend.inferred {
            let object = self.resolve(backend).await?;
            if self
                .call_on(
                    &super::chrome_safety::f_hit_testable(),
                    json!([]),
                    &object,
                    &backend.session,
                )
                .await?
                != JsonValue::Bool(true)
            {
                return Err(self.reject("The inferred row is not visible at its click point"));
            }
        }
        self.dispatch();
        for kind in ["mousePressed", "mouseReleased"] {
            self.send(
                "Input.dispatchMouseEvent",
                json!({"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1}),
            )
            .await?;
        }
        Ok(())
    }

    async fn point_for(&self, backend: &RefTarget) -> Result<(f64, f64), ExecutorError> {
        self.send_to(
            "DOM.scrollIntoViewIfNeeded",
            json!({"backendNodeId": backend.backend}),
            &backend.session,
        )
        .await?;
        let quads = self
            .send_to(
                "DOM.getContentQuads",
                json!({"backendNodeId": backend.backend}),
                &backend.session,
            )
            .await?;
        let quad = quads
            .pointer("/quads/0")
            .and_then(Value::as_array)
            .filter(|quad| quad.len() >= 8 && quad.iter().all(Value::is_number))
            .ok_or_else(|| self.reject("Element is not visible"))?;
        let point = |offset: usize| {
            (0..4)
                .map(|corner| quad[corner * 2 + offset].as_f64().unwrap_or_default())
                .sum::<f64>()
                / 4.0
        };
        let (mut x, mut y) = (point(0), point(1));
        let mut session = backend.session.clone();
        let mut visited = HashSet::new();
        while session != self.page.session_id {
            if !visited.insert(session.clone()) {
                return Err(self.reject("Invalid frame ancestry"));
            }
            let frame = {
                self.page
                    .document()
                    .frames
                    .iter()
                    .find(|(_, frame)| frame.session == session)
                    .map(|(id, frame)| (id.clone(), frame.clone()))
            }
            .ok_or_else(|| self.reject("Semantic frame is stale"))?;
            let owner = self
                .send_to(
                    "DOM.getFrameOwner",
                    json!({"frameId":frame.0}),
                    &frame.1.parent_session,
                )
                .await?;
            let owner_id = owner
                .get("backendNodeId")
                .and_then(Value::as_i64)
                .ok_or_else(|| self.reject("Chrome omitted the frame owner"))?;
            let quad = self
                .send_to(
                    "DOM.getContentQuads",
                    json!({"backendNodeId":owner_id}),
                    &frame.1.parent_session,
                )
                .await?;
            let quad = quad
                .pointer("/quads/0")
                .and_then(Value::as_array)
                .filter(|quad| quad.len() >= 8)
                .ok_or_else(|| self.reject("Frame is not visible"))?;
            x += quad[0]
                .as_f64()
                .ok_or_else(|| self.reject("Frame is not visible"))?;
            y += quad[1]
                .as_f64()
                .ok_or_else(|| self.reject("Frame is not visible"))?;
            session = frame.1.parent_session;
        }
        Ok((x, y))
    }

    async fn fill(
        &self,
        action: &browser::Fill,
        output: &mut Peripherals,
    ) -> Result<(), ExecutorError> {
        let reference = action
            .r#ref
            .as_ref()
            .and_then(|r| r.to_utf8().ok())
            .unwrap_or_default();
        let (backend, node) = self.describe(&reference).await?;
        output.frame = self.element_frame(&backend);
        self.assert_editable(&backend, &node).await?;
        let object_id = self.resolve(&backend).await?;
        let plan = self
            .call_on(
                &super::chrome_safety::f_fill(),
                call_args(&[json_arg(&action.text.encode()), Value::Bool(false)]),
                &object_id,
                &backend.session,
            )
            .await?;
        if let Some(message) = self.evaluate_error(&plan) {
            return Err(self.reject(&message));
        }
        let kind = string(get(&plan, "kind")).unwrap_or("").to_owned();
        self.dispatch();
        let applied = self
            .call_on(
                &super::chrome_safety::f_fill(),
                call_args(&[json_arg(&action.text.encode()), Value::Bool(true)]),
                &object_id,
                &backend.session,
            )
            .await?;
        if let Some(message) = self.evaluate_error(&applied) {
            return Err(self.reject(&message));
        }
        if kind == "insert" {
            self.send_to(
                "Input.insertText",
                ObjectEncoder::new().field("text", &action.text).finish(),
                &backend.session,
            )
            .await?;
        }
        output.control = Some(self.control_state(&backend, &object_id).await?);
        Ok(())
    }

    async fn select(
        &self,
        action: &browser::Select,
        output: &mut Peripherals,
    ) -> Result<(), ExecutorError> {
        let reference = action
            .r#ref
            .as_ref()
            .and_then(|r| r.to_utf8().ok())
            .unwrap_or_default();
        let (backend, node) = self.describe(&reference).await?;
        output.frame = self.element_frame(&backend);
        if !string(get(&node, "nodeName")).is_some_and(|name| name.eq_ignore_ascii_case("select")) {
            return self.select_listbox(&backend, action, output).await;
        }
        let object_id = self.resolve(&backend).await?;
        let criteria = domain(json!({
            "values": action.values.as_ref().map(|values| values.iter().filter_map(|v| v.to_utf8().ok()).collect::<Vec<_>>()),
            "labels": action.labels.as_ref().map(|values| values.iter().filter_map(|v| v.to_utf8().ok()).collect::<Vec<_>>()),
            "indexes": action.indexes.as_ref().map(|values| values.iter().map(|v| v.get()).collect::<Vec<_>>()),
        }));
        let plan = self
            .call_on(
                super::chrome_safety::F_SELECT,
                call_args(&[json_arg(&criteria), Value::Bool(false)]),
                &object_id,
                &backend.session,
            )
            .await?;
        if let Some(message) = self.evaluate_error(&plan) {
            return Err(self.reject(&message));
        }
        self.dispatch();
        let applied = self
            .call_on(
                super::chrome_safety::F_SELECT,
                call_args(&[json_arg(&criteria), Value::Bool(true)]),
                &object_id,
                &backend.session,
            )
            .await?;
        if let Some(message) = self.evaluate_error(&applied) {
            return Err(self.reject(&message));
        }
        output.control = Some(self.control_state(&backend, &object_id).await?);
        Ok(())
    }

    async fn ax_node(&self, backend: &RefTarget) -> Result<JsonValue, ExecutorError> {
        let tree = self
            .send_to(
                "Accessibility.getPartialAXTree",
                domain(json!({"backendNodeId": backend.backend, "fetchRelatives": false})),
                &backend.session,
            )
            .await?;
        array(get(&tree, "nodes"))
            .iter()
            .find(|node| integer(get(node, "backendDOMNodeId")) == Some(backend.backend))
            .cloned()
            .ok_or_else(|| self.reject("Element does not expose accessibility state"))
    }

    async fn assert_editable(
        &self,
        backend: &RefTarget,
        node: &JsonValue,
    ) -> Result<(), ExecutorError> {
        if file_input(node) {
            return Err(self.reject("Protected inputs are unsupported"));
        }
        let accessible = self.ax_node(backend).await?;
        if super::chrome_safety::is_sensitive_attributes(
            string(get(node, "nodeName")).unwrap_or(""),
            &attributes_of(get(node, "attributes")),
            string(nested(&accessible, &["name", "value"])).unwrap_or(""),
        ) {
            return Err(self.reject("Sensitive fields cannot be filled"));
        }
        Ok(())
    }

    async fn select_listbox(
        &self,
        backend: &RefTarget,
        action: &browser::Select,
        output: &mut Peripherals,
    ) -> Result<(), ExecutorError> {
        let node = self.ax_node(backend).await?;
        let role = string(nested(&node, &["role", "value"])).unwrap_or("");
        let mut listbox = backend.backend;
        if role == "combobox" {
            if super::chrome_semantics::ax_bool(&node, "expanded") != Some(true) {
                return Err(self.reject(
                    "The combobox is collapsed. Open the list first, observe, then select",
                ));
            }
            let mut found = None;
            for related in array(super::chrome_semantics::ax_related(&node, "controls")) {
                let Some(id) = integer(get(related, "backendDOMNodeId")) else {
                    continue;
                };
                let candidate = self
                    .ax_node(&RefTarget {
                        backend: id,
                        ..backend.clone()
                    })
                    .await?;
                if string(nested(&candidate, &["role", "value"])) == Some("listbox") {
                    found = Some(id);
                    break;
                }
            }
            listbox = found.ok_or_else(|| self.reject("The combobox does not expose its list"))?;
        } else if role != "listbox" {
            return Err(self.reject("Element is not a select or listbox"));
        }
        if action.values.is_some() {
            return Err(
                self.reject("Option values apply only to native selects; use labels or indexes")
            );
        }
        if action
            .labels
            .as_ref()
            .map(Vec::len)
            .or_else(|| action.indexes.as_ref().map(Vec::len))
            != Some(1)
        {
            return Err(self.reject("Select exactly one option of a listbox"));
        }
        let queried = self
            .send_to(
                "Accessibility.queryAXTree",
                domain(json!({"backendNodeId": listbox, "role": "option"})),
                &backend.session,
            )
            .await?;
        let options = array(get(&queried, "nodes"))
            .iter()
            .filter(|node| get(node, "ignored") != Some(&JsonValue::Bool(true)))
            .filter_map(|node| Some((integer(get(node, "backendDOMNodeId"))?, node)))
            .enumerate()
            .map(|(index, (id, node))| {
                let label = normalized(string(nested(node, &["name", "value"])).unwrap_or(""));
                (
                    index,
                    id,
                    node,
                    super::payload::bounded(label.into(), browser::MAX_NAME_LENGTH),
                )
            })
            .collect::<Vec<_>>();
        let wanted = if let Some(labels) = &action.labels {
            let label = normalized(labels[0].as_str().unwrap_or(""));
            options
                .iter()
                .find(|option| option.3.as_str() == Some(label.as_str()))
        } else {
            action
                .indexes
                .as_ref()
                .and_then(|indexes| options.get(indexes[0].get() as usize))
        }
        .ok_or_else(|| self.reject("Option not found"))?;
        if super::chrome_semantics::ax_bool(wanted.2, "disabled") == Some(true) {
            return Err(self.reject("Option is disabled"));
        }
        let target = RefTarget {
            backend: wanted.1,
            inferred: false,
            ..backend.clone()
        };
        let mut selected = super::chrome_semantics::ax_bool(wanted.2, "selected") == Some(true);
        if !selected {
            let described = self
                .page
                .describe(target.backend, &target.session, Some(self.cancel.clone()))
                .await
                .map_err(|failure| self.reject(&failure.message))?;
            self.click_target(&target, &described).await?;
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(500);
            loop {
                selected = self.ax_node(&target).await.ok().is_some_and(|option| {
                    super::chrome_semantics::ax_bool(&option, "selected") == Some(true)
                });
                if !selected && role == "combobox" {
                    let combobox = self.ax_node(backend).await?;
                    let connected = match self.resolve(&target).await {
                        Ok(object) => {
                            self.call_on(
                                super::chrome_safety::F_CONNECTED,
                                json!([]),
                                &object,
                                &target.session,
                            )
                            .await
                            .unwrap_or(JsonValue::Bool(false))
                                == JsonValue::Bool(true)
                        }
                        Err(_) => false,
                    };
                    if super::chrome_semantics::ax_bool(&combobox, "expanded") != Some(true)
                        || !connected
                    {
                        selected =
                            string(nested(&combobox, &["value", "value"])).is_some_and(|value| {
                                normalized(value) == wanted.3.as_str().unwrap_or("")
                            });
                    }
                }
                if selected || tokio::time::Instant::now() >= deadline {
                    break;
                }
                tokio::select! {
                    () = tokio::time::sleep(std::time::Duration::from_millis(50)) => {}
                    () = cancelled(self.cancel.clone()) => return Err(self.reject("Isolated browser operation was canceled")),
                }
            }
        }
        output.control = Some(browser::ControlState {
            checked: None,
            value: None,
            sensitive: None,
            selected: Some(if selected {
                vec![browser::SelectedOption {
                    value: None,
                    label: wanted.3.clone(),
                    index: ycoding_schema::schema::NonNegativeInt::new(wanted.0 as i64)
                        .map_err(|_| self.reject("Chrome returned an invalid option index"))?,
                }]
            } else {
                Vec::new()
            }),
        });
        output.message = (!selected).then(|| "The selection could not be confirmed".into());
        Ok(())
    }

    async fn partial_checked(
        &self,
        backend: &RefTarget,
    ) -> Result<Option<browser::Tristate>, ExecutorError> {
        let tree = self
            .send_to(
                "Accessibility.getPartialAXTree",
                domain(json!({"backendNodeId": backend.backend, "fetchRelatives": false})),
                &backend.session,
            )
            .await?;
        Ok(array(get(&tree, "nodes"))
            .first()
            .and_then(|node| super::chrome_semantics::ax_state(node, "", false).checked))
    }

    async fn check(
        &self,
        action: &browser::Check,
        output: &mut Peripherals,
    ) -> Result<(), ExecutorError> {
        let reference = action
            .r#ref
            .as_ref()
            .and_then(|r| r.to_utf8().ok())
            .unwrap_or_default();
        let (backend, node) = self.describe(&reference).await?;
        output.frame = self.element_frame(&backend);
        if protected_input(&node) {
            return Err(self.reject("Protected inputs are unsupported"));
        }
        let wanted = if action.checked {
            browser::Tristate::Boolean(true)
        } else {
            browser::Tristate::Boolean(false)
        };
        let current = self.partial_checked(&backend).await?;
        if current != Some(wanted) {
            let (x, y) = self.point_for(&backend).await?;
            self.dispatch();
            for kind in ["mousePressed", "mouseReleased"] {
                self.send(
                    "Input.dispatchMouseEvent",
                    json!({"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1}),
                )
                .await?;
            }
        }
        if self.partial_checked(&backend).await? != Some(wanted) {
            return Err(self.reject("The control did not reach the requested state"));
        }
        let object_id = self.resolve(&backend).await?;
        output.control = Some(self.control_state(&backend, &object_id).await?);
        Ok(())
    }

    async fn hover(
        &self,
        action: &browser::Hover,
        output: &mut Peripherals,
    ) -> Result<(), ExecutorError> {
        let reference = action
            .r#ref
            .as_ref()
            .and_then(|r| r.to_utf8().ok())
            .unwrap_or_default();
        let (backend, _) = self.describe(&reference).await?;
        output.frame = self.element_frame(&backend);
        let (x, y) = self.point_for(&backend).await?;
        self.dispatch();
        self.send(
            "Input.dispatchMouseEvent",
            json!({"type": "mouseMoved", "x": x, "y": y}),
        )
        .await?;
        Ok(())
    }

    async fn dialog(
        &self,
        action: &browser::Dialog,
        output: &mut Peripherals,
    ) -> Result<(), ExecutorError> {
        let open = self.page.document().dialog.clone();
        let Some((info, session)) = open else {
            return Err(self.reject("No JavaScript dialog is open on this tab"));
        };
        output.dialog = Some(info);
        if let Some(accept) = action.accept {
            self.dispatch();
            let mut parameters = json!({"accept": accept});
            if let Some(text) = &action.text {
                parameters["promptText"] = Value::String(text.to_utf8().unwrap_or_default());
            }
            self.send_to(
                "Page.handleJavaScriptDialog",
                parameters,
                session.as_deref().unwrap_or(&self.page.session_id),
            )
            .await?;
            self.page.document().dialog = None;
        }
        Ok(())
    }
}

fn json_arg(value: &JsonValue) -> Value {
    serde_json::from_str(&stringify_json(value)).unwrap_or(Value::Null)
}

fn call_args(values: &[Value]) -> Value {
    Value::Array(values.iter().map(|value| json!({"value": value})).collect())
}

fn normalized(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

async fn cancelled(mut cancel: watch::Receiver<bool>) {
    if cancel.wait_for(|cancelled| *cancelled).await.is_err() {
        std::future::pending::<()>().await;
    }
}

fn bounded(input: &str, limit: usize) -> String {
    let mut units = 0;
    input
        .chars()
        .take_while(|character| {
            units += character.len_utf16();
            units <= limit
        })
        .collect()
}

fn cdp_failure(failure: &Error, fallback: &str, dispatched: bool) -> ExecutorError {
    ExecutorError {
        message: if failure.cancelled {
            "Isolated browser operation was canceled".into()
        } else if super::cdp::stale_context(&failure.message) {
            bounded(&failure.message, 1024)
        } else {
            fallback.into()
        },
        phase: if dispatched {
            Phase::Postdispatch
        } else {
            Phase::Predispatch
        },
    }
}
