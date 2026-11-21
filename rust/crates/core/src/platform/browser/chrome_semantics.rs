use super::{
    Error,
    bridge::safe_page,
    chrome_process::error,
    chrome_target::{FrameTarget, RefTarget, Shared, safe_url},
    isolated::{ExecutorError, Phase, Snapshot},
    payload,
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use tokio::sync::watch;
use url::Url;
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, browser, parse_json, stringify_json,
};

const INTERACTIVE: [&str; 14] = [
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

const AX_EXPANSION_CALLS: usize = 256;
const AX_DEPTH: usize = 32;
const POPUP_CONTAINERS: usize = 16;
const POPUP_ROW_DEPTH: usize = 8;
const POPUP_ROW_NODES: usize = 64;
const POPUP_SCAN_NODES: usize = 2_000;
const CONTROL_WORLD: &str = "ycoding-control";

impl Shared {
    pub(super) async fn ax_tree(
        &self,
        frame: &str,
        session: &str,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<(Vec<JsonValue>, bool), Error> {
        let tree = self
            .client
            .send(
                "Accessibility.getFullAXTree",
                domain(json!({"frameId": frame, "depth": AX_DEPTH})),
                Some(session),
                cancel.clone(),
                None,
            )
            .await?;
        let mut nodes = array(get(&tree, "nodes")).to_vec();
        let mut known = nodes
            .iter()
            .filter_map(|node| string(get(node, "nodeId")).map(str::to_owned))
            .collect::<HashSet<_>>();
        let mut frontier = nodes
            .iter()
            .filter(|node| unexpanded(node, &known))
            .cloned()
            .collect::<Vec<_>>();
        let mut calls = 0;
        for _ in 0..AX_DEPTH {
            if frontier.is_empty() {
                return Ok((nodes, false));
            }
            let mut next = Vec::new();
            for parent in frontier {
                if calls >= AX_EXPANSION_CALLS {
                    return Ok((nodes, true));
                }
                calls += 1;
                let children = self
                    .client
                    .send(
                        "Accessibility.getChildAXNodes",
                        domain(json!({"id": string(get(&parent, "nodeId")), "frameId": frame})),
                        Some(session),
                        cancel.clone(),
                        None,
                    )
                    .await?;
                for child in array(get(&children, "nodes")) {
                    let Some(id) = string(get(child, "nodeId")) else {
                        continue;
                    };
                    if known.insert(id.to_owned()) {
                        nodes.push(child.clone());
                        next.push(child.clone());
                    }
                }
            }
            frontier = next
                .into_iter()
                .filter(|node| unexpanded(node, &known))
                .collect();
        }
        Ok((nodes, !frontier.is_empty()))
    }

    pub(super) async fn popup_rows(
        &self,
        frame: &str,
        session: &str,
        nodes: &[JsonValue],
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<(Vec<(i64, LosslessString)>, bool), Error> {
        let mut containers = Vec::new();
        for node in nodes {
            if get(node, "ignored") == Some(&JsonValue::Bool(true)) {
                continue;
            }
            if matches!(
                string(nested(node, &["role", "value"])),
                Some("listbox" | "menu" | "tree" | "grid")
            ) && let Some(backend) = integer(get(node, "backendDOMNodeId"))
                && !containers.contains(&backend)
            {
                containers.push(backend);
            }
            if ax_bool(node, "expanded") != Some(true) {
                continue;
            }
            for name in ["controls", "owns"] {
                for related in array(ax_related(node, name)) {
                    if let Some(backend) = integer(get(related, "backendDOMNodeId"))
                        && !containers.contains(&backend)
                    {
                        containers.push(backend);
                    }
                }
            }
        }
        let mut truncated = containers.len() > POPUP_CONTAINERS;
        let mut rows: Vec<(i64, LosslessString)> = Vec::new();
        for container in containers.into_iter().take(POPUP_CONTAINERS) {
            let limit = browser::MAX_OBSERVATION_ELEMENTS.saturating_sub(rows.len());
            if limit == 0 {
                return Ok((rows, true));
            }
            let result = self
                .popup_container_rows(container, frame, session, limit, cancel.clone())
                .await;
            let _ = self
                .client
                .send(
                    "Runtime.releaseObjectGroup",
                    domain(json!({"objectGroup": CONTROL_WORLD})),
                    Some(session),
                    None,
                    None,
                )
                .await;
            let (found, limited) = match result {
                Ok(result) => result,
                Err(failure) if super::cdp::stale_node(&failure.message) => continue,
                Err(failure) => return Err(failure),
            };
            truncated |= limited;
            for (backend, name) in found {
                if let Some(row) = rows.iter_mut().find(|row| row.0 == backend) {
                    row.1 = name;
                } else {
                    rows.push((backend, name));
                }
            }
        }
        Ok((rows, truncated))
    }

    async fn popup_container_rows(
        &self,
        container: i64,
        frame: &str,
        session: &str,
        limit: usize,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<(Vec<(i64, LosslessString)>, bool), Error> {
        let world = self
            .client
            .send(
                "Page.createIsolatedWorld",
                domain(json!({"frameId": frame, "worldName": CONTROL_WORLD})),
                Some(session),
                cancel.clone(),
                None,
            )
            .await?;
        let context = integer(get(&world, "executionContextId"))
            .ok_or_else(|| Error::new("Chrome omitted a number"))?;
        let resolved = self
            .client
            .send(
                "DOM.resolveNode",
                domain(json!({"backendNodeId": container, "executionContextId": context, "objectGroup": CONTROL_WORLD})),
                Some(session),
                cancel.clone(),
                None,
            )
            .await?;
        let object = string(nested(&resolved, &["object", "objectId"]))
            .ok_or_else(|| Error::new("Chrome omitted an identifier"))?;
        let listed = self
            .client
            .send(
                "Runtime.callFunctionOn",
                domain(json!({
                    "functionDeclaration": super::chrome_safety::f_popup_rows(),
                    "objectId": object,
                    "arguments": [{"value": limit}, {"value": POPUP_ROW_NODES}, {"value": POPUP_SCAN_NODES}],
                    "returnByValue": false,
                    "objectGroup": CONTROL_WORLD,
                })),
                Some(session),
                cancel.clone(),
                None,
            )
            .await?;
        evaluation_ok(&listed)?;
        let object = string(nested(&listed, &["result", "objectId"]))
            .ok_or_else(|| Error::new("Chrome omitted an identifier"))?;
        let properties = self
            .remote_properties(object, session, cancel.clone())
            .await?;
        let truncated = properties
            .get("truncated")
            .and_then(|value| get(value, "value"))
            != Some(&JsonValue::Bool(false));
        let rows_id = properties
            .get("rows")
            .and_then(|value| string(get(value, "objectId")));
        let mut rows = Vec::new();
        if let Some(rows_id) = rows_id {
            let properties = self
                .remote_properties(rows_id, session, cancel.clone())
                .await?;
            let mut objects = properties
                .iter()
                .filter_map(|(name, value)| {
                    Some((name.parse::<usize>().ok()?, string(get(value, "objectId"))?))
                })
                .collect::<Vec<_>>();
            objects.sort_by_key(|(index, _)| *index);
            for (_, object) in objects.into_iter().take(limit) {
                let described = self
                    .client
                    .send(
                        "DOM.describeNode",
                        domain(
                            json!({"objectId": object, "depth": POPUP_ROW_DEPTH, "pierce": true}),
                        ),
                        Some(session),
                        cancel.clone(),
                        None,
                    )
                    .await?;
                let Some(node) = get(&described, "node") else {
                    continue;
                };
                let Some(backend) = integer(get(node, "backendNodeId")) else {
                    continue;
                };
                if !row_content_safe(node) {
                    continue;
                }
                let response = self
                    .client
                    .send(
                        "Runtime.callFunctionOn",
                        domain(json!({"functionDeclaration": super::chrome_safety::F_ROW_NAME, "objectId": object, "returnByValue": true})),
                        Some(session),
                        cancel.clone(),
                        None,
                    )
                    .await?;
                evaluation_ok(&response)?;
                if let Some(name) = lossless(nested(&response, &["result", "value"]))
                    .filter(|name| !name.is_empty())
                {
                    rows.push((backend, payload::bounded(name, browser::MAX_NAME_LENGTH)));
                }
            }
        }
        Ok((rows, truncated))
    }

    async fn remote_properties(
        &self,
        object: &str,
        session: &str,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<HashMap<String, JsonValue>, Error> {
        let response = self
            .client
            .send(
                "Runtime.getProperties",
                domain(json!({"objectId": object, "ownProperties": true})),
                Some(session),
                cancel,
                None,
            )
            .await?;
        Ok(array(get(&response, "result"))
            .iter()
            .filter_map(|property| {
                Some((
                    string(get(property, "name"))?.to_owned(),
                    get(property, "value")?.clone(),
                ))
            })
            .collect())
    }

    pub(super) async fn snapshot(
        &self,
        include_elements: bool,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<Snapshot, ExecutorError> {
        self.ensure_active()?;
        let target = self
            .client
            .send(
                "Target.getTargetInfo",
                domain(json!({"targetId":self.target_id})),
                None,
                cancel.clone(),
                None,
            )
            .await
            .map_err(observation_error)?;
        let info = get(&target, "targetInfo")
            .ok_or_else(|| error("Chrome returned an invalid response"))?;
        let url = safe_url(string(get(info, "url")).unwrap_or(""))?;
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
        let title = payload::bounded(
            lossless(get(info, "title")).unwrap_or_default(),
            browser::MAX_TITLE_LENGTH,
        );
        let (elements, texts, frames, truncated) = if include_elements {
            self.elements(&url, cancel).await?
        } else {
            let mut document = self.document();
            document.refs.clear();
            document.revision = 0;
            (Vec::new(), None, None, false)
        };
        let mut document = self.document();
        if include_elements {
            document.revision += 1;
        }
        Ok(Snapshot {
            title,
            url: url.as_str().into(),
            document_generation: number(document.generation)?,
            revision: number(document.revision)?,
            elements,
            texts,
            frames,
            truncated,
        })
    }

    async fn elements(
        &self,
        page: &Url,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<
        (
            Vec<browser::Element>,
            Option<Vec<browser::Text>>,
            Option<Vec<browser::Frame>>,
            bool,
        ),
        ExecutorError,
    > {
        let tree = self
            .client
            .send(
                "Page.getFrameTree",
                domain(json!({})),
                Some(&self.session_id),
                cancel.clone(),
                None,
            )
            .await
            .map_err(observation_error)?;
        let mut discovered = Vec::new();
        collect_frames(get(&tree, "frameTree"), &mut discovered);
        {
            let mut document = self.document();
            for (id, url) in discovered {
                if id != self.main_frame_id && !document.frames.contains_key(&id) {
                    document.frames.insert(
                        id,
                        FrameTarget {
                            session: self.session_id.clone(),
                            parent_session: self.session_id.clone(),
                            url,
                            target: None,
                        },
                    );
                }
            }
        }
        let (children, known) = {
            let document = self.document();
            (document.frames.clone(), document.discovered_origins.clone())
        };
        let mut targets = vec![(
            self.main_frame_id.clone(),
            self.session_id.clone(),
            page.clone(),
            true,
        )];
        let mut children = children.into_iter().collect::<Vec<_>>();
        children.sort_by(|a, b| a.0.cmp(&b.0));
        let mut frames = Vec::new();
        let mut new_origins = Vec::new();
        let mut truncated = children.len() > browser::MAX_OBSERVATION_FRAMES;
        for (id, frame) in children.into_iter().take(browser::MAX_OBSERVATION_FRAMES) {
            let observed = known.contains(&frame.url.origin().ascii_serialization());
            new_origins.push(frame.url.origin().ascii_serialization());
            frames.push(browser::Frame {
                page: safe_page(&frame.url.as_str().into())
                    .map_err(|failure| error(failure.to_string()))?,
                observed,
            });
            if observed {
                targets.push((id, frame.session, frame.url, false));
            }
        }
        let mut refs = HashMap::new();
        let mut elements = Vec::new();
        let mut texts = Vec::new();
        let mut sequence = 0;
        let mut seen_backends = HashSet::new();
        for (frame, session, url, main) in targets {
            let (nodes, tree_truncated) = self
                .ax_tree(&frame, &session, cancel.clone())
                .await
                .map_err(observation_error)?;
            let (rows, rows_truncated) = self
                .popup_rows(&frame, &session, &nodes, cancel.clone())
                .await
                .map_err(observation_error)?;
            truncated |= tree_truncated || rows_truncated;
            for node in &nodes {
                if get(node, "ignored") == Some(&JsonValue::Bool(true)) {
                    continue;
                }
                let role = string(nested(node, &["role", "value"])).unwrap_or("");
                let interactive = INTERACTIVE.contains(&role);
                let named = lossless(nested(node, &["name", "value"])).unwrap_or_default();
                if !interactive
                    && (named.is_empty()
                        || !matches!(
                            role,
                            "StaticText" | "heading" | "paragraph" | "text" | "label"
                        ))
                {
                    continue;
                }
                let Some(backend) = integer(get(node, "backendDOMNodeId")) else {
                    continue;
                };
                let described = self
                    .describe(backend, &session, cancel.clone())
                    .await
                    .map_err(observation_error)?;
                if interactive {
                    if !seen_backends.insert((session.clone(), backend)) {
                        continue;
                    }
                    sequence += 1;
                }
                if file_input(&described) {
                    continue;
                }
                let page = safe_page(&url.as_str().into())
                    .map_err(|failure| error(failure.to_string()))?;
                if interactive {
                    if elements.len() >= browser::MAX_OBSERVATION_ELEMENTS {
                        truncated = true;
                        continue;
                    }
                    let reference = format!("b{sequence}");
                    let description = payload::bounded(
                        lossless(nested(node, &["description", "value"])).unwrap_or_default(),
                        browser::MAX_NAME_LENGTH,
                    );
                    let disabled = array(get(node, "properties")).iter().any(|property| {
                        string(get(property, "name")) == Some("disabled")
                            && nested(property, &["value", "value"]) == Some(&JsonValue::Bool(true))
                    });
                    let attributes = attributes_of(get(&described, "attributes"));
                    let destination = attributes
                        .get("href")
                        .and_then(|href| url.join(href).ok())
                        .and_then(|url| safe_page(&url.as_str().into()).ok());
                    let sensitive = super::chrome_safety::is_sensitive_attributes(
                        string(get(&described, "nodeName")).unwrap_or(""),
                        &attributes,
                        named.as_str().unwrap_or(""),
                    );
                    let state = ax_state(node, role, sensitive);
                    let element = browser::Element {
                        r#ref: reference.clone().into(),
                        role: payload::bounded(role.into(), 64),
                        name: payload::bounded(named, browser::MAX_NAME_LENGTH),
                        description: (!description.is_empty()).then_some(description),
                        disabled: disabled.then_some(true),
                        checked: state.checked,
                        pressed: state.pressed,
                        expanded: state.expanded,
                        selected: state.selected,
                        value: state.value,
                        sensitive: sensitive.then_some(true),
                        locator: None,
                        destination,
                        frame: (!main).then_some(page),
                    };
                    refs.insert(
                        reference,
                        RefTarget {
                            backend,
                            session: session.clone(),
                            frame: frame.clone(),
                            url: url.clone(),
                            inferred: false,
                        },
                    );
                    elements.push(element);
                } else if texts.len() < browser::MAX_OBSERVATION_TEXTS {
                    texts.push(browser::Text {
                        role: payload::bounded(role.into(), 64),
                        name: payload::bounded(named, browser::MAX_NAME_LENGTH),
                        frame: (!main).then_some(page),
                    });
                } else {
                    truncated = true;
                }
            }
            for (backend, name) in rows {
                if !seen_backends.insert((session.clone(), backend)) {
                    continue;
                }
                if elements.len() >= browser::MAX_OBSERVATION_ELEMENTS {
                    truncated = true;
                    continue;
                }
                sequence += 1;
                let reference = format!("b{sequence}");
                refs.insert(
                    reference.clone(),
                    RefTarget {
                        backend,
                        session: session.clone(),
                        frame: frame.clone(),
                        url: url.clone(),
                        inferred: true,
                    },
                );
                elements.push(browser::Element {
                    r#ref: reference.into(),
                    role: "clickable".into(),
                    name,
                    description: None,
                    disabled: None,
                    checked: None,
                    pressed: None,
                    expanded: None,
                    selected: None,
                    value: None,
                    sensitive: None,
                    locator: None,
                    destination: None,
                    frame: if main {
                        None
                    } else {
                        Some(safe_page(&url.as_str().into()).map_err(|e| error(e.to_string()))?)
                    },
                });
            }
        }
        let mut counts: HashMap<Vec<u16>, usize> = HashMap::new();
        for element in &elements {
            let mut key = element.role.code_units().collect::<Vec<_>>();
            key.push(0);
            key.extend(element.name.code_units().take(128));
            *counts.entry(key).or_default() += 1;
        }
        let mut seen: HashMap<Vec<u16>, usize> = HashMap::new();
        for element in &mut elements {
            let mut key = element.role.code_units().collect::<Vec<_>>();
            key.push(0);
            key.extend(element.name.code_units().take(128));
            let index = seen.entry(key.clone()).or_default();
            let nth = if counts[&key] > 1 && *index > 0 {
                Some(*index)
            } else {
                None
            };
            *index += 1;
            element.locator = Some(super::operation::make_locator(
                &element.role,
                &element.name,
                nth,
            ));
        }
        let mut document = self.document();
        document.refs = refs;
        document.discovered_origins.extend(new_origins);
        Ok((
            elements,
            Some(texts),
            (!frames.is_empty()).then_some(frames),
            truncated,
        ))
    }

    pub(super) async fn describe(
        &self,
        backend: i64,
        session: &str,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<JsonValue, Error> {
        let described = self
            .client
            .send(
                "DOM.describeNode",
                domain(json!({"backendNodeId":backend,"depth":0})),
                Some(session),
                cancel,
                None,
            )
            .await?;
        get(&described, "node")
            .filter(|node| matches!(node, JsonValue::Object(_)))
            .cloned()
            .ok_or_else(|| Error::new("Chrome returned an invalid response"))
    }

    pub(super) fn page_event(&self, event: &super::cdp::Event) {
        match event.method.as_str() {
            "Page.javascriptDialogOpening" => {
                let Some(params) = event.params.as_ref() else {
                    return;
                };
                let kind = match string(get(params, "type")) {
                    Some("alert") => browser::DialogKind::Alert,
                    Some("confirm") => browser::DialogKind::Confirm,
                    Some("prompt") => browser::DialogKind::Prompt,
                    Some("beforeunload") => browser::DialogKind::BeforeUnload,
                    _ => return,
                };
                let dialog = browser::DialogInfo {
                    kind,
                    message: payload::bounded(
                        lossless(get(params, "message")).unwrap_or_default(),
                        browser::MAX_NAME_LENGTH,
                    ),
                    default_prompt: lossless(get(params, "defaultPrompt"))
                        .filter(|value| !value.is_empty())
                        .map(|value| payload::bounded(value, browser::MAX_NAME_LENGTH)),
                };
                self.document().dialog = Some((dialog, event.session_id.clone()));
            }
            "Page.javascriptDialogClosed" => {
                self.document().dialog = None;
            }
            "Network.requestWillBeSent" | "Network.loadingFinished" | "Network.loadingFailed" => {
                let Some(params) = event.params.as_ref() else {
                    return;
                };
                let Some(request) = string(get(params, "requestId")).filter(|id| !id.is_empty())
                else {
                    return;
                };
                let session = event.session_id.clone().unwrap_or_default();
                let mut document = self.document();
                if event.method == "Network.requestWillBeSent" {
                    document
                        .network_inflight
                        .entry(session)
                        .or_default()
                        .insert(request.into());
                } else if let Some(requests) = document.network_inflight.get_mut(&session)
                    && requests.remove(request)
                {
                    if requests.is_empty() {
                        document.network_inflight.remove(&session);
                    }
                    if document
                        .network_inflight
                        .values()
                        .all(|requests| requests.is_empty())
                    {
                        document.network_quiet_since = std::time::Instant::now();
                    }
                }
            }
            _ => {}
        }
    }

    pub(super) fn console_event(&self, event: &super::cdp::Event) -> bool {
        let Some(params) = event.params.as_ref() else {
            return false;
        };
        let session = event.session_id.as_deref().unwrap_or("");
        let owned = session == self.session_id
            || self
                .document()
                .frames
                .values()
                .any(|frame| frame.session == session);
        if !owned {
            return false;
        }
        match event.method.as_str() {
            "Runtime.executionContextCreated" => {
                if let Some(context) = get(params, "context")
                    && let Some(id) = integer(get(context, "id"))
                {
                    let frame = string(nested(context, &["auxData", "frameId"]));
                    let page = frame
                        .and_then(|id| {
                            self.document()
                                .frames
                                .get(id)
                                .and_then(|frame| safe_page(&frame.url.as_str().into()).ok())
                        })
                        .or_else(|| {
                            string(get(context, "origin"))
                                .and_then(|origin| safe_page(&format!("{origin}/").into()).ok())
                        });
                    self.document().contexts.insert((session.into(), id), page);
                }
                true
            }
            "Runtime.executionContextDestroyed" => {
                if let Some(id) = integer(get(params, "executionContextId")) {
                    self.document().contexts.remove(&(session.into(), id));
                }
                true
            }
            "Runtime.executionContextsCleared" => {
                self.document()
                    .contexts
                    .retain(|(owner, _), _| owner != session);
                true
            }
            "Runtime.consoleAPICalled" => {
                let mut units = Vec::new();
                for arg in array(get(params, "args")) {
                    if !units.is_empty() {
                        units.push(32);
                    }
                    let value = get(arg, "value");
                    let text = lossless(value)
                        .or_else(|| lossless(get(arg, "description")))
                        .unwrap_or_else(|| value.map(stringify_json).unwrap_or_default().into());
                    units.extend(text.code_units());
                }
                let frame = integer(get(params, "executionContextId")).and_then(|id| {
                    self.document()
                        .contexts
                        .get(&(session.into(), id))
                        .cloned()
                        .flatten()
                });
                let entry = browser::LogEntry {
                    level: payload::bounded(
                        lossless(get(params, "type")).unwrap_or_else(|| "log".into()),
                        16,
                    ),
                    text: payload::bounded(
                        LosslessString::from_utf16(units),
                        browser::MAX_NAME_LENGTH,
                    ),
                    frame,
                };
                let mut document = self.document();
                document.logs.push_back(entry);
                while document.logs.len() > browser::MAX_LOG_ENTRIES {
                    document.logs.pop_front();
                }
                true
            }
            _ => false,
        }
    }
}

pub(super) fn get<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    if let JsonValue::Object(object) = value {
        object.get(&LosslessString::from(name))
    } else {
        None
    }
}
pub(super) fn nested<'a>(value: &'a JsonValue, names: &[&str]) -> Option<&'a JsonValue> {
    let mut value = Some(value);
    for name in names {
        value = value.and_then(|value| get(value, name));
    }
    value
}
pub(super) fn array(value: Option<&JsonValue>) -> &[JsonValue] {
    match value {
        Some(JsonValue::Array(values)) => values,
        _ => &[],
    }
}
pub(super) fn string(value: Option<&JsonValue>) -> Option<&str> {
    match value {
        Some(JsonValue::String(value)) => value.as_str(),
        _ => None,
    }
}
pub(super) fn lossless(value: Option<&JsonValue>) -> Option<LosslessString> {
    match value {
        Some(JsonValue::String(value)) => Some(value.clone()),
        _ => None,
    }
}
pub(super) fn integer(value: Option<&JsonValue>) -> Option<i64> {
    match value {
        Some(JsonValue::Number(number)) if number.is_finite() && number.fract() == 0.0 => {
            Some(*number as i64)
        }
        _ => None,
    }
}
pub(super) fn domain(value: Value) -> JsonValue {
    parse_json(&value.to_string()).expect("serde JSON is valid JSON")
}
pub(super) fn utf8_size(value: &LosslessString) -> usize {
    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>()).len()
}
pub(super) fn file_input(node: &JsonValue) -> bool {
    string(get(node, "nodeName")).is_some_and(|name| name.eq_ignore_ascii_case("input"))
        && attributes_of(get(node, "attributes"))
            .get("type")
            .is_some_and(|kind| kind.eq_ignore_ascii_case("file"))
}
pub(super) struct AxState {
    pub checked: Option<browser::Tristate>,
    pub pressed: Option<browser::Tristate>,
    pub expanded: Option<bool>,
    pub selected: Option<bool>,
    pub value: Option<LosslessString>,
}
fn ax_property<'a>(node: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    array(get(node, "properties"))
        .iter()
        .find(|property| string(get(property, "name")) == Some(name))
        .and_then(|property| nested(property, &["value", "value"]))
}
fn ax_tristate(node: &JsonValue, name: &str) -> Option<browser::Tristate> {
    match ax_property(node, name) {
        Some(JsonValue::Bool(value)) => Some(browser::Tristate::Boolean(*value)),
        Some(JsonValue::String(value)) => match value.as_str() {
            Some("true") => Some(browser::Tristate::Boolean(true)),
            Some("false") => Some(browser::Tristate::Boolean(false)),
            Some("mixed") => Some(browser::Tristate::Mixed),
            _ => None,
        },
        _ => None,
    }
}
pub(super) fn ax_bool(node: &JsonValue, name: &str) -> Option<bool> {
    match ax_property(node, name) {
        Some(JsonValue::Bool(value)) => Some(*value),
        _ => None,
    }
}

pub(super) fn ax_related<'a>(node: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    array(get(node, "properties"))
        .iter()
        .find(|property| string(get(property, "name")) == Some(name))
        .and_then(|property| nested(property, &["value", "relatedNodes"]))
}

fn unexpanded(node: &JsonValue, known: &HashSet<String>) -> bool {
    string(nested(node, &["role", "value"])) != Some("StaticText")
        && array(get(node, "childIds"))
            .iter()
            .filter_map(|id| string(Some(id)))
            .any(|id| !known.contains(id))
}

fn evaluation_ok(response: &JsonValue) -> Result<(), Error> {
    if get(response, "exceptionDetails").is_some() {
        return Err(Error::new("Page evaluation failed"));
    }
    Ok(())
}

pub(super) fn row_content_safe(root: &JsonValue) -> bool {
    let mut pending = vec![root];
    let mut count = 0;
    while let Some(node) = pending.pop() {
        count += 1;
        if count > POPUP_ROW_NODES {
            return false;
        }
        let attributes = attributes_of(get(node, "attributes"));
        let tag = string(get(node, "nodeName"))
            .unwrap_or("")
            .to_ascii_lowercase();
        if integer(get(node, "nodeType")) == Some(1)
            && ([
                "input", "textarea", "select", "button", "iframe", "frame", "object", "embed",
            ]
            .contains(&tag.as_str())
                || get(node, "contentDocument").is_some()
                || attributes
                    .get("contenteditable")
                    .is_some_and(|value| value != "false")
                || attributes
                    .get("role")
                    .is_some_and(|role| INTERACTIVE.contains(&role.as_str()))
                || array(get(node, "shadowRoots"))
                    .iter()
                    .any(|root| string(get(root, "shadowRootType")) != Some("user-agent")))
        {
            return false;
        }
        let children = array(get(node, "children"));
        if integer(get(node, "childNodeCount")).is_some_and(|size| size > children.len() as i64) {
            return false;
        }
        pending.extend(children);
    }
    true
}
const VALUE_ROLES: [&str; 9] = [
    "textbox",
    "searchbox",
    "combobox",
    "spinbutton",
    "slider",
    "Date",
    "InputTime",
    "DateTime",
    "ColorWell",
];
pub(super) fn ax_state(node: &JsonValue, role: &str, sensitive: bool) -> AxState {
    let value = if !sensitive && VALUE_ROLES.contains(&role) {
        match nested(node, &["value", "value"]) {
            Some(JsonValue::String(value)) => {
                Some(payload::bounded(value.clone(), browser::MAX_NAME_LENGTH))
            }
            Some(JsonValue::Number(value)) => Some(payload::bounded(
                format_number(*value).into(),
                browser::MAX_NAME_LENGTH,
            )),
            _ => None,
        }
    } else {
        None
    };
    AxState {
        checked: ax_tristate(node, "checked"),
        pressed: ax_tristate(node, "pressed"),
        expanded: ax_bool(node, "expanded"),
        selected: ax_bool(node, "selected"),
        value,
    }
}
pub(super) fn format_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}
pub(super) fn protected_input(node: &JsonValue) -> bool {
    string(get(node, "nodeName")).is_some_and(|name| name.eq_ignore_ascii_case("input"))
        && matches!(
            attributes_of(get(node, "attributes"))
                .get("type")
                .map(|kind| kind.to_ascii_lowercase())
                .as_deref(),
            Some("file" | "password")
        )
}
pub(super) fn attributes_of(input: Option<&JsonValue>) -> HashMap<String, String> {
    array(input)
        .as_chunks::<2>()
        .0
        .iter()
        .filter_map(|pair| {
            Some((
                string(Some(&pair[0]))?.to_owned(),
                string(Some(&pair[1]))?.to_owned(),
            ))
        })
        .collect()
}
fn collect_frames(tree: Option<&JsonValue>, frames: &mut Vec<(String, Url)>) {
    if let Some(tree) = tree {
        if let (Some(id), Some(url)) = (
            string(nested(tree, &["frame", "id"])),
            string(nested(tree, &["frame", "url"])).and_then(|url| safe_url(url).ok()),
        ) {
            frames.push((id.into(), url));
        }
        for child in array(get(tree, "childFrames")) {
            collect_frames(Some(child), frames);
        }
    }
}
fn number<T: DomainDecode>(value: u64) -> Result<T, ExecutorError> {
    T::decode(&JsonValue::Number(value as f64))
        .map_err(|_| error("Chrome returned an invalid response"))
}
fn observation_error(failure: Error) -> ExecutorError {
    ExecutorError {
        message: if failure.cancelled {
            "Isolated browser operation was canceled"
        } else {
            "Isolated browser observation failed"
        }
        .into(),
        phase: Phase::Predispatch,
    }
}
