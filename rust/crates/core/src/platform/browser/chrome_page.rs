use super::{
    Error, capture,
    chrome_process::error,
    chrome_target::{Shared, request_allowed, safe_url},
    isolated::{ActionOutput, ExecutorError, Phase, Snapshot},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::sync::watch;
use url::Url;
use ycoding_schema::{DomainDecode, JsonValue, LosslessString, browser, parse_json};

const INTERACTIVE_ROLES: [&str; 14] = [
    "button",
    "checkbox",
    "combobox",
    "link",
    "listbox",
    "menuitem",
    "option",
    "radio",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "textbox",
];
const PAUSED: &str = "Isolated browser control is paused";

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
        let capture = attempt.perform(&action).await?;
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
        let snapshot = self.snapshot(false, Some(cancel)).await?;
        Ok(ActionOutput {
            snapshot,
            capture,
            rejected: (self.safety.popups() != popups)
                .then(|| LosslessString::from("A popup was safely blocked")),
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

    fn ensure_active(&self) -> Result<(), ExecutorError> {
        if self.safety.paused() {
            return Err(error(
                self.safety.failure().unwrap_or_else(|| PAUSED.into()),
            ));
        }
        Ok(())
    }

    async fn snapshot(
        &self,
        include_elements: bool,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<Snapshot, ExecutorError> {
        self.ensure_active()?;
        let observe =
            |failure: Error| cdp_failure(&failure, "Isolated browser observation failed", false);
        let target = self
            .client
            .send(
                "Target.getTargetInfo",
                json!({"targetId": self.target_id}),
                None,
                cancel.clone(),
                None,
            )
            .await
            .map_err(observe)?;
        let info = target
            .get("targetInfo")
            .filter(|info| info.is_object())
            .ok_or_else(|| error("Chrome returned an invalid response"))?;
        let url = safe_url(info.get("url").and_then(Value::as_str).unwrap_or(""))?;
        if !self
            .document()
            .allowed_origins
            .contains(&url.origin().ascii_serialization())
        {
            return Err(ExecutorError {
                message: "The browser crossed its approved origin boundary".into(),
                phase: Phase::Postdispatch,
            });
        }
        let title = bounded(
            info.get("title").and_then(Value::as_str).unwrap_or(""),
            browser::MAX_TITLE_LENGTH,
        );
        let (elements, truncated) = if include_elements {
            self.elements(&url, cancel).await?
        } else {
            let mut document = self.document();
            document.refs.clear();
            document.revision = 0;
            (Vec::new(), false)
        };
        let mut document = self.document();
        if include_elements {
            document.revision += 1;
        }
        Ok(Snapshot {
            title: title.into(),
            url: url.as_str().into(),
            document_generation: number(document.generation)?,
            revision: number(document.revision)?,
            elements,
            truncated,
        })
    }

    async fn elements(
        &self,
        page: &Url,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<(Vec<browser::Element>, bool), ExecutorError> {
        let observe =
            |failure: Error| cdp_failure(&failure, "Isolated browser observation failed", false);
        let tree = self
            .client
            .send(
                "Accessibility.getFullAXTree",
                json!({"depth": 12}),
                Some(&self.session_id),
                cancel.clone(),
                None,
            )
            .await
            .map_err(observe)?;
        let candidates = tree
            .get("nodes")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter(|node| node.is_object() && node.get("ignored") != Some(&Value::Bool(true)))
            .filter(|node| {
                INTERACTIVE_ROLES.contains(
                    &node
                        .pointer("/role/value")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                ) && node
                    .get("backendDOMNodeId")
                    .and_then(Value::as_i64)
                    .is_some()
            })
            .collect::<Vec<_>>();
        let selected = &candidates[..candidates.len().min(browser::MAX_OBSERVATION_ELEMENTS)];
        let mut refs = HashMap::new();
        let mut elements = Vec::new();
        for (index, node) in selected.iter().enumerate() {
            let backend = node["backendDOMNodeId"].as_i64().unwrap_or_default();
            let described = self
                .describe(backend, cancel.clone())
                .await
                .map_err(observe)?;
            if protected_input(&described) {
                continue;
            }
            let reference = format!("b{}", index + 1);
            refs.insert(reference.clone(), backend);
            elements.push(element(&reference, node, &described, page)?);
        }
        self.document().refs = refs;
        Ok((
            elements,
            candidates.len() > browser::MAX_OBSERVATION_ELEMENTS,
        ))
    }

    async fn describe(
        &self,
        backend: i64,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<Value, Error> {
        let described = self
            .client
            .send(
                "DOM.describeNode",
                json!({"backendNodeId": backend, "depth": 0}),
                Some(&self.session_id),
                cancel,
                None,
            )
            .await?;
        described
            .get("node")
            .filter(|node| node.is_object())
            .cloned()
            .ok_or_else(|| Error::new("Chrome returned an invalid response"))
    }
}

struct Attempt<'a> {
    page: &'a Shared,
    cancel: watch::Receiver<bool>,
    dispatched: AtomicBool,
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
    async fn send(&self, method: &str, params: Value) -> Result<Value, ExecutorError> {
        self.page
            .client
            .send(
                method,
                params,
                Some(&self.page.session_id),
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
    async fn describe(&self, reference: &str) -> Result<(i64, Value), ExecutorError> {
        let backend = self
            .page
            .document()
            .refs
            .get(reference)
            .copied()
            .ok_or_else(|| self.reject("Semantic element reference is stale"))?;
        let node = self
            .page
            .describe(backend, Some(self.cancel.clone()))
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

    async fn perform(
        &self,
        action: &browser::Action,
    ) -> Result<Option<browser::CaptureOutput>, ExecutorError> {
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
            browser::Action::Click(click) => self.click(click).await?,
            browser::Action::Type(typed) => {
                let reference = typed.r#ref.to_utf8().unwrap_or_default();
                let (backend, node) = self.describe(&reference).await?;
                if protected_input(&node) {
                    return Err(self.reject("Protected inputs are unsupported"));
                }
                let text = typed
                    .text
                    .to_utf8()
                    .map_err(|_| self.reject("Typed text must be valid Unicode"))?;
                self.dispatch();
                self.send("DOM.focus", json!({"backendNodeId": backend}))
                    .await?;
                self.send("Input.insertText", json!({"text": text})).await?;
            }
            browser::Action::Scroll(scroll) => {
                self.dispatch();
                self.send(
                    "Input.dispatchMouseEvent",
                    json!({"type": "mouseWheel", "x": 0, "y": 0, "deltaX": 0, "deltaY": scroll.delta_y.get()}),
                )
                .await?;
            }
            browser::Action::Capture(_) => {
                let captured = capture::capture_page(
                    &self.page.client,
                    &self.page.session_id,
                    Some(self.cancel.clone()),
                )
                .await
                .map_err(|failure| ExecutorError {
                    message: bounded(&failure.message, 1024),
                    phase: self.phase(),
                })?;
                return browser::CaptureOutput::decode(
                    &parse_json(
                        &json!({"mediaType": captured.media_type, "data": captured.data, "bytes": captured.bytes})
                            .to_string(),
                    )
                    .map_err(|_| self.reject("Chrome returned an invalid response"))?,
                )
                .map(Some)
                .map_err(|_| self.reject("Chrome returned an invalid response"));
            }
            browser::Action::Group(_) | browser::Action::Ungroup(_) => {}
        }
        Ok(None)
    }

    async fn click(&self, click: &browser::Click) -> Result<(), ExecutorError> {
        let reference = click.r#ref.to_utf8().unwrap_or_default();
        let (backend, node) = self.describe(&reference).await?;
        let attributes = attributes_of(node.get("attributes"));
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
            let approved = self
                .page
                .initial_url
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
        if protected_input(&node) {
            return Err(self.reject("Protected inputs are unsupported"));
        }
        self.send(
            "DOM.scrollIntoViewIfNeeded",
            json!({"backendNodeId": backend}),
        )
        .await?;
        let quads = self
            .send("DOM.getContentQuads", json!({"backendNodeId": backend}))
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
        let (x, y) = (point(0), point(1));
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
}

fn element(
    reference: &str,
    node: &Value,
    described: &Value,
    page: &Url,
) -> Result<browser::Element, ExecutorError> {
    let text = |pointer: &str, limit: usize| {
        bounded(
            node.pointer(pointer).and_then(Value::as_str).unwrap_or(""),
            limit,
        )
    };
    let mut value = json!({
        "ref": reference,
        "role": text("/role/value", 64),
        "name": text("/name/value", browser::MAX_NAME_LENGTH),
    });
    let description = text("/description/value", browser::MAX_NAME_LENGTH);
    if !description.is_empty() {
        value["description"] = json!(description);
    }
    if node
        .get("properties")
        .and_then(Value::as_array)
        .is_some_and(|properties| {
            properties.iter().any(|property| {
                property.get("name") == Some(&json!("disabled"))
                    && property.pointer("/value/value") == Some(&Value::Bool(true))
            })
        })
    {
        value["disabled"] = json!(true);
    }
    let destination = attributes_of(described.get("attributes"))
        .get("href")
        .and_then(|href| page.join(href).ok())
        .and_then(|url| safe_url(url.as_str()).ok());
    if let Some(destination) = destination {
        value["destination"] = json!({
            "origin": destination.origin().ascii_serialization(),
            "path": destination.path(),
        });
    }
    parse_json(&value.to_string())
        .ok()
        .and_then(|value| browser::Element::decode(&value).ok())
        .ok_or_else(|| error("Chrome returned an invalid response"))
}

async fn cancelled(mut cancel: watch::Receiver<bool>) {
    if cancel.wait_for(|cancelled| *cancelled).await.is_err() {
        std::future::pending::<()>().await;
    }
}

fn protected_input(node: &Value) -> bool {
    node.get("nodeName")
        .and_then(Value::as_str)
        .is_some_and(|name| name.eq_ignore_ascii_case("input"))
        && matches!(
            attributes_of(node.get("attributes"))
                .get("type")
                .map_or("text".to_owned(), |kind| kind.to_ascii_lowercase())
                .as_str(),
            "file" | "password"
        )
}

fn attributes_of(input: Option<&Value>) -> HashMap<String, String> {
    input
        .and_then(Value::as_array)
        .map(|values| {
            values
                .as_chunks::<2>()
                .0
                .iter()
                .filter_map(|pair| {
                    Some((pair[0].as_str()?.to_owned(), pair[1].as_str()?.to_owned()))
                })
                .filter(|(name, _)| !name.is_empty())
                .collect()
        })
        .unwrap_or_default()
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

fn number<T: DomainDecode>(value: u64) -> Result<T, ExecutorError> {
    T::decode(&JsonValue::Number(value as f64))
        .map_err(|_| error("Chrome returned an invalid response"))
}

fn cdp_failure(failure: &Error, fallback: &str, dispatched: bool) -> ExecutorError {
    ExecutorError {
        message: if failure.cancelled {
            "Isolated browser operation was canceled".into()
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
