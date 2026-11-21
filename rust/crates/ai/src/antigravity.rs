use crate::{
    Error,
    auth::{Auth, Credential},
    framing::Framing,
    gemini::Gemini,
    json::{self, get, s},
    llm::{BlockEvent, Defaults, Event, Part, Request, Role, ToolChoice},
    route::{Endpoint, Protocol, Route, StreamParser, Transport},
};
use reqwest::header::{HeaderMap, HeaderValue};
use ring::rand::{SecureRandom, SystemRandom};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::Arc,
};
use ycoding_schema::{JsonValue, LosslessString, provider};

pub const BASE_URL: &str = "https://daily-cloudcode-pa.googleapis.com";
pub const CLIENT_VERSION: &str = "2.28.2";

pub fn user_agent_for(os: &str, arch: &str) -> String {
    let os = match os {
        "macos" => "darwin",
        "win32" => "windows",
        value => value,
    };
    let arch = match arch {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        value => value,
    };
    format!("antigravity/hub/{CLIENT_VERSION} (aidev_client; os_type={os}; arch={arch})")
}
pub fn user_agent() -> String {
    user_agent_for(std::env::consts::OS, std::env::consts::ARCH)
}
pub fn session_id(affinity: &str, model: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in affinity
        .bytes()
        .chain(std::iter::once(0))
        .chain(model.bytes())
    {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    (hash as i64).to_string()
}

#[derive(Clone, Default)]
pub struct Config {
    pub access: Option<Credential>,
    pub auth: Option<Auth>,
    pub base_url: Option<String>,
    pub project: Option<String>,
    pub gateway_model: Option<String>,
    pub session_id: Option<String>,
    pub defaults: Defaults,
}
pub fn route(config: Config) -> Route {
    Route {
        id: "ai-sdk:@ai-sdk/google".into(),
        provider: provider::Id("antigravity".into()),
        provider_metadata_key: Some("google".into()),
        protocol: Arc::new(Antigravity {
            project: config.project,
            gateway_model: config.gateway_model,
            session_id: config.session_id,
        }),
        endpoint: Endpoint::new(
            config.base_url.unwrap_or_else(|| BASE_URL.into()),
            "/v1internal:streamGenerateContent?alt=sse",
        ),
        auth: config.auth.unwrap_or_else(|| match config.access {
            Some(access) => Auth::bearer(access),
            None => Auth::None,
        }),
        transport: Transport::Http(Framing::Sse),
        headers: BTreeMap::new(),
        defaults: config.defaults,
    }
}

pub struct Antigravity {
    project: Option<String>,
    gateway_model: Option<String>,
    session_id: Option<String>,
}
impl Antigravity {
    fn model(&self, request: &Request) -> String {
        self.gateway_model.clone().unwrap_or_else(|| {
            request
                .model
                .id
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| lossy(&request.model.id))
        })
    }
    fn affinity(&self, request: &Request) -> Option<String> {
        for name in ["x-session-affinity", "x-session-id"] {
            if let Some(value) = request
                .http
                .headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.trim())
                .filter(|value| !value.is_empty())
            {
                return Some(value.to_owned());
            }
        }
        self.session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    }
}
impl Protocol for Antigravity {
    fn id(&self) -> &'static str {
        "gemini"
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        Gemini.lower(request)
    }
    fn wire_body(&self, request: &Request, body: JsonValue) -> Result<JsonValue, Error> {
        let model = self.model(request);
        let mut inner = body;
        if model.starts_with("claude-") {
            inner = claude_declarations(inner, request);
            inner = claude_tool_ids(inner, request)?;
            inner = omit_unsigned_thinking(inner);
        }
        inner = json::remove(&inner, CACHE_CONTROL_KEYS);
        inner = strip_trailing_model_contents(inner);
        if request.tool_choice == Some(ToolChoice::None) {
            inner = json::remove(&inner, &["tools"]);
            let mut tool_config = get(&inner, "toolConfig")
                .filter(|value| matches!(value, JsonValue::Object(_)))
                .cloned()
                .unwrap_or_else(json::empty);
            json::set(
                &mut tool_config,
                "functionCallingConfig",
                json::object([("mode", s("NONE"))]),
            );
            json::set(&mut inner, "toolConfig", tool_config);
        }
        if let Some(affinity) = self.affinity(request) {
            json::set(&mut inner, "sessionId", s(session_id(&affinity, &model)));
        }
        let mut envelope = json::empty();
        if let Some(project) = &self.project {
            json::set(&mut envelope, "project", s(project.clone()));
        }
        json::set(&mut envelope, "model", s(model));
        json::set(&mut envelope, "userAgent", s("antigravity"));
        json::set(&mut envelope, "requestType", s("agent"));
        json::set(&mut envelope, "requestId", s(format!("agent-{}", uuid()?)));
        json::set(&mut envelope, "request", inner);
        Ok(envelope)
    }
    fn request_headers(&self, _request: &Request, headers: HeaderMap) -> Result<HeaderMap, Error> {
        let mut filtered = HeaderMap::new();
        if let Some(value) = headers.get("authorization") {
            filtered.insert("authorization", value.clone());
        }
        filtered.insert(
            "user-agent",
            HeaderValue::from_str(&user_agent())
                .map_err(|_| Error::invalid("Invalid Antigravity user agent"))?,
        );
        filtered.insert("content-type", HeaderValue::from_static("application/json"));
        if let Some(value) = headers.get("accept") {
            filtered.insert("accept", value.clone());
        }
        Ok(filtered)
    }
    fn parser(&self, request: &Request) -> Box<dyn StreamParser> {
        Box::new(Parser {
            inner: Gemini::parser(request),
            linker: Linker::default(),
            blocks: Blocks::default(),
        })
    }
}

const CACHE_CONTROL_KEYS: &[&str] = &[
    "cachedContent",
    "cached_content",
    "promptCacheOptions",
    "prompt_cache_options",
    "systemPromptCache",
    "systemPromptCacheOptions",
    "system_prompt_cache",
    "system_prompt_cache_options",
    "cacheBreakpoints",
    "cache_breakpoints",
    "cacheRequest",
    "cache_request",
];

fn lossy(value: &LosslessString) -> String {
    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
}
fn uuid() -> Result<String, Error> {
    let mut bytes = [0; 16];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| Error::invalid("Antigravity request identity unavailable"))?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    Ok(bytes
        .iter()
        .enumerate()
        .map(|(index, byte)| {
            format!(
                "{}{byte:02x}",
                if matches!(index, 4 | 6 | 8 | 10) {
                    "-"
                } else {
                    ""
                }
            )
        })
        .collect())
}
fn entries(value: &JsonValue, key: &str) -> Option<Vec<JsonValue>> {
    json::array(get(value, key)?).map(<[JsonValue]>::to_vec)
}
fn claude_declarations(body: JsonValue, request: &Request) -> JsonValue {
    let Some(tools) = entries(&body, "tools") else {
        return body;
    };
    let tools: Vec<_> = tools
        .into_iter()
        .map(|entry| {
            let Some(declarations) = entries(&entry, "functionDeclarations") else {
                return entry;
            };
            let declarations: Vec<_> = declarations
                .into_iter()
                .map(|declaration| {
                    let schema = get(&declaration, "name")
                        .and_then(json::text)
                        .and_then(|name| {
                            request
                                .tools
                                .iter()
                                .find(|tool| tool.name.as_str() == Some(name))
                        })
                        .map(|tool| &tool.input_schema)
                        .filter(|schema| matches!(schema, JsonValue::Object(_)));
                    let Some(schema) = schema else {
                        return declaration;
                    };
                    let mut declaration = json::remove(&declaration, &["parameters"]);
                    json::set(
                        &mut declaration,
                        "parametersJsonSchema",
                        crate::tool_schema::anthropic(schema),
                    );
                    declaration
                })
                .collect();
            let mut entry = entry;
            json::set(
                &mut entry,
                "functionDeclarations",
                JsonValue::Array(declarations),
            );
            entry
        })
        .collect();
    let mut body = body;
    json::set(&mut body, "tools", JsonValue::Array(tools));
    body
}
struct HistoryEntry {
    id: String,
    name: Option<String>,
}
fn take(
    queue: &mut VecDeque<HistoryEntry>,
    kind: &str,
    name: Option<&JsonValue>,
) -> Result<String, Error> {
    let display = name
        .map(json::js_string)
        .unwrap_or_else(|| "undefined".into());
    let expected = name.and_then(json::text);
    let next = queue.pop_front();
    match next {
        Some(entry) if entry.name.as_deref() == expected && !entry.id.is_empty() => Ok(entry.id),
        _ => Err(Error::invalid(format!(
            "Antigravity Claude request has a {kind} without an id: {}",
            lossy(&display)
        ))),
    }
}
fn claude_tool_ids(body: JsonValue, request: &Request) -> Result<JsonValue, Error> {
    let Some(contents) = entries(&body, "contents") else {
        return Ok(body);
    };
    let mut calls = VecDeque::new();
    let mut responses = VecDeque::new();
    for message in &request.messages {
        for part in &message.content {
            match (message.role, part) {
                (Role::Assistant, Part::ToolCall(call)) => calls.push_back(HistoryEntry {
                    id: lossy(&call.id),
                    name: call.name.as_str().map(str::to_owned),
                }),
                (Role::Tool, Part::ToolResult(result)) => responses.push_back(HistoryEntry {
                    id: lossy(&result.id),
                    name: result.name.as_str().map(str::to_owned),
                }),
                _ => {}
            }
        }
    }
    let mut mapped = Vec::new();
    for content in contents {
        let Some(parts) = entries(&content, "parts") else {
            mapped.push(content);
            continue;
        };
        let mut kept: Vec<JsonValue> = Vec::new();
        let mut answered: BTreeMap<String, usize> = BTreeMap::new();
        for part in parts {
            if let Some(call) =
                get(&part, "functionCall").filter(|v| matches!(v, JsonValue::Object(_)))
            {
                let id = take(&mut calls, "tool call", get(call, "name"))?;
                let mut call = call.clone();
                json::set(&mut call, "id", s(id));
                let mut part = part;
                json::set(&mut part, "functionCall", call);
                kept.push(part);
            } else if let Some(response) =
                get(&part, "functionResponse").filter(|v| matches!(v, JsonValue::Object(_)))
            {
                let id = take(&mut responses, "tool result", get(response, "name"))?;
                let text = get(response, "response")
                    .and_then(|response| get(response, "content"))
                    .and_then(json::string)
                    .cloned();
                if let Some(&index) = answered.get(&id) {
                    let earlier = get(&kept[index], "functionResponse")
                        .and_then(|response| get(response, "response"))
                        .and_then(|response| get(response, "content"))
                        .and_then(json::string)
                        .cloned();
                    if let (Some(earlier), Some(text)) = (earlier, &text) {
                        let mut merged = earlier;
                        json::concat(&mut merged, &"\n".into());
                        json::concat(&mut merged, text);
                        let mut existing = get(&kept[index], "functionResponse")
                            .cloned()
                            .unwrap_or_else(json::empty);
                        let mut payload = get(&existing, "response")
                            .cloned()
                            .unwrap_or_else(json::empty);
                        json::set(&mut payload, "content", s(merged));
                        json::set(&mut existing, "response", payload);
                        let mut part = kept[index].clone();
                        json::set(&mut part, "functionResponse", existing);
                        kept[index] = part;
                        continue;
                    }
                }
                let mut response = response.clone();
                json::set(&mut response, "id", s(id.clone()));
                answered.insert(id, kept.len());
                let mut part = part;
                json::set(&mut part, "functionResponse", response);
                kept.push(part);
            } else {
                kept.push(part);
            }
        }
        let mut content = content;
        json::set(&mut content, "parts", JsonValue::Array(kept));
        mapped.push(content);
    }
    if !calls.is_empty() || !responses.is_empty() {
        return Err(Error::invalid(
            "Antigravity Claude request has a tool call or result missing from the request contents",
        ));
    }
    let mut body = body;
    json::set(&mut body, "contents", JsonValue::Array(mapped));
    Ok(body)
}
fn omit_unsigned_thinking(body: JsonValue) -> JsonValue {
    let Some(contents) = entries(&body, "contents") else {
        return body;
    };
    let signed = |part: &JsonValue| {
        !matches!(part, JsonValue::Object(_))
            || get(part, "thought") != Some(&JsonValue::Bool(true))
            || !matches!(get(part, "text"), Some(JsonValue::String(_)))
            || get(part, "thoughtSignature")
                .and_then(json::string)
                .is_some_and(|value| !value.is_empty())
    };
    let contents: Vec<_> = contents
        .into_iter()
        .filter_map(|content| {
            let Some(parts) = entries(&content, "parts") else {
                return Some(content);
            };
            let kept: Vec<_> = parts.iter().filter(|part| signed(part)).cloned().collect();
            if kept.len() == parts.len() {
                return Some(content);
            }
            if kept.is_empty() {
                return None;
            }
            let mut content = content;
            json::set(&mut content, "parts", JsonValue::Array(kept));
            Some(content)
        })
        .collect();
    let mut body = body;
    json::set(&mut body, "contents", JsonValue::Array(contents));
    body
}
fn strip_trailing_model_contents(body: JsonValue) -> JsonValue {
    let Some(mut contents) = entries(&body, "contents") else {
        return body;
    };
    let original = contents.len();
    while contents.last().is_some_and(|content| {
        json::text(get(content, "role").unwrap_or(&JsonValue::Null)) == Some("model")
    }) {
        contents.pop();
    }
    if contents.len() == original {
        return body;
    }
    let mut body = body;
    json::set(&mut body, "contents", JsonValue::Array(contents));
    body
}

fn candidate_parts(frame: &JsonValue) -> Option<Vec<JsonValue>> {
    let candidates = json::array(get(frame, "candidates")?)?;
    let content = get(candidates.first()?, "content")?;
    json::array(get(content, "parts")?).map(<[JsonValue]>::to_vec)
}
fn set_candidate_parts(frame: &mut JsonValue, parts: Vec<JsonValue>) {
    let Some(mut candidates) = entries(frame, "candidates") else {
        return;
    };
    let Some(candidate) = candidates.first().cloned() else {
        return;
    };
    let mut content = get(&candidate, "content")
        .cloned()
        .unwrap_or_else(json::empty);
    json::set(&mut content, "parts", JsonValue::Array(parts));
    let mut candidate = candidate;
    json::set(&mut candidate, "content", content);
    candidates[0] = candidate;
    json::set(frame, "candidates", JsonValue::Array(candidates));
}

#[derive(Default)]
struct Linker {
    pending: Vec<JsonValue>,
    open: Option<usize>,
}
impl Linker {
    fn push(&mut self, mut frame: JsonValue) -> Vec<JsonValue> {
        let mut open_in_current: Option<usize> = None;
        if let Some(parts) = candidate_parts(&frame) {
            let mut kept: Vec<JsonValue> = Vec::new();
            for part in parts {
                if !matches!(part, JsonValue::Object(_)) {
                    self.open = None;
                    open_in_current = None;
                    kept.push(part);
                    continue;
                }
                let text = get(&part, "text");
                let text_string = text.and_then(json::string);
                let thought = get(&part, "thought") == Some(&JsonValue::Bool(true));
                if let Some(text) = text_string
                    && !text.is_empty()
                    && thought
                {
                    self.open = None;
                    open_in_current = Some(kept.len());
                    kept.push(part);
                    continue;
                }
                let signature = get(&part, "thoughtSignature")
                    .and_then(json::string)
                    .filter(|value| !value.is_empty())
                    .cloned();
                let empty_text = match text {
                    None => true,
                    Some(_) => text_string.is_some_and(LosslessString::is_empty),
                };
                let only_signature_keys = match &part {
                    JsonValue::Object(fields) => fields.iter().all(|(key, _)| {
                        matches!(key.as_str(), Some("text" | "thought" | "thoughtSignature"))
                    }),
                    _ => false,
                };
                if empty_text
                    && let Some(signature) = signature
                    && only_signature_keys
                    && (open_in_current.is_some() || self.open.is_some())
                {
                    if let Some(index) = open_in_current {
                        json::set(&mut kept[index], "thoughtSignature", s(signature));
                    } else if let Some(index) = self.open
                        && let Some(pending) = self.pending.first_mut()
                        && let Some(mut parts) = candidate_parts(pending)
                        && let Some(part) = parts.get_mut(index)
                    {
                        json::set(part, "thoughtSignature", s(signature));
                        set_candidate_parts(pending, parts);
                    }
                    continue;
                }
                if !matches!(text, Some(JsonValue::String(value)) if value.is_empty()) {
                    self.open = None;
                    open_in_current = None;
                }
                kept.push(part);
            }
            set_candidate_parts(&mut frame, kept);
        }
        let held = open_in_current.is_some_and(|index| {
            candidate_parts(&frame)
                .and_then(|parts| {
                    parts
                        .get(index)
                        .map(|part| get(part, "thoughtSignature").is_none())
                })
                .unwrap_or(false)
        });
        if held {
            let released = std::mem::replace(&mut self.pending, vec![frame]);
            self.open = open_in_current;
            released
        } else {
            self.open = None;
            let mut released = std::mem::take(&mut self.pending);
            released.push(frame);
            released
        }
    }
    fn flush(&mut self) -> Vec<JsonValue> {
        self.open = None;
        std::mem::take(&mut self.pending)
    }
}
fn split(frame: JsonValue) -> Vec<JsonValue> {
    let Some(parts) = candidate_parts(&frame) else {
        return vec![frame];
    };
    let Some(mut candidates) = entries(&frame, "candidates") else {
        return vec![frame];
    };
    let Some(candidate) = candidates.first().cloned() else {
        return vec![frame];
    };
    if !matches!(get(&candidate, "content"), Some(JsonValue::Object(_))) {
        return vec![frame];
    }
    let mut groups: Vec<Vec<JsonValue>> = vec![Vec::new()];
    for part in parts {
        if groups
            .last()
            .and_then(|group| group.last())
            .is_some_and(|last| get(last, "functionCall").is_some())
        {
            groups.push(Vec::new());
        }
        groups.last_mut().expect("group").push(part);
    }
    if groups.len() == 1 {
        return vec![frame];
    }
    let fields = json::remove(&frame, &["candidates"]);
    let before_final = json::remove(&candidate, &["finishReason"]);
    let content = get(&candidate, "content")
        .cloned()
        .unwrap_or_else(json::empty);
    let rest: Vec<_> = candidates.split_off(1);
    let total = groups.len();
    groups
        .into_iter()
        .enumerate()
        .map(|(index, group)| {
            let last = index + 1 == total;
            let mut response = if last { fields.clone() } else { json::empty() };
            let mut single = if last {
                candidate.clone()
            } else {
                before_final.clone()
            };
            let mut content = content.clone();
            json::set(&mut content, "parts", JsonValue::Array(group));
            json::set(&mut single, "content", content);
            let mut grouped = vec![single];
            if last {
                grouped.extend(rest.iter().cloned());
            }
            json::set(&mut response, "candidates", JsonValue::Array(grouped));
            response
        })
        .collect()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Reasoning,
}
#[derive(Default)]
struct Block {
    active: Option<LosslessString>,
    epoch: u64,
    used: Vec<LosslessString>,
}
#[derive(Default)]
struct Blocks {
    text: Block,
    reasoning: Block,
}
impl Blocks {
    fn block(&mut self, kind: Kind) -> &mut Block {
        match kind {
            Kind::Text => &mut self.text,
            Kind::Reasoning => &mut self.reasoning,
        }
    }
    fn close(&mut self, kind: Kind, out: &mut Vec<Event>) {
        if let Some(id) = self.block(kind).active.take() {
            out.push(match kind {
                Kind::Text => Event::TextEnd(BlockEvent {
                    id,
                    provider_metadata: None,
                }),
                Kind::Reasoning => Event::ReasoningEnd(BlockEvent {
                    id,
                    provider_metadata: None,
                }),
            });
        }
    }
    fn normalize(&mut self, events: Vec<Event>) -> Vec<Event> {
        let mut out = Vec::new();
        for event in events {
            match event {
                Event::TextStart(block) => self.start(Kind::Text, block, &mut out),
                Event::ReasoningStart(block) => self.start(Kind::Reasoning, block, &mut out),
                Event::TextDelta(mut delta) => {
                    if self.text.active.is_none() {
                        self.text.epoch += 1;
                        let id: LosslessString =
                            format!("{}:{}", lossy(&delta.id), self.text.epoch).into();
                        self.text.active = Some(id.clone());
                        out.push(Event::TextStart(BlockEvent {
                            id,
                            provider_metadata: delta.provider_metadata.clone(),
                        }));
                    }
                    delta.id = self.text.active.clone().expect("active text block");
                    out.push(Event::TextDelta(delta));
                }
                Event::ReasoningDelta(mut delta) => {
                    if self.reasoning.active.is_none() {
                        self.reasoning.epoch += 1;
                        let id: LosslessString =
                            format!("{}:{}", lossy(&delta.id), self.reasoning.epoch).into();
                        self.reasoning.active = Some(id.clone());
                        out.push(Event::ReasoningStart(BlockEvent {
                            id,
                            provider_metadata: delta.provider_metadata.clone(),
                        }));
                    }
                    delta.id = self
                        .reasoning
                        .active
                        .clone()
                        .expect("active reasoning block");
                    out.push(Event::ReasoningDelta(delta));
                }
                Event::TextEnd(mut block) => {
                    if let Some(id) = self.text.active.take() {
                        block.id = id;
                        out.push(Event::TextEnd(block));
                    }
                }
                Event::ReasoningEnd(mut block) => {
                    if let Some(id) = self.reasoning.active.take() {
                        block.id = id;
                        out.push(Event::ReasoningEnd(block));
                    }
                }
                event => {
                    if matches!(
                        event,
                        Event::ToolInputStart(_)
                            | Event::ToolCall(_)
                            | Event::ToolResult(_)
                            | Event::Finish(_)
                    ) {
                        self.close(Kind::Reasoning, &mut out);
                        self.close(Kind::Text, &mut out);
                    }
                    out.push(event);
                }
            }
        }
        out
    }
    fn start(&mut self, kind: Kind, mut block: BlockEvent, out: &mut Vec<Event>) {
        self.close(
            match kind {
                Kind::Text => Kind::Reasoning,
                Kind::Reasoning => Kind::Text,
            },
            out,
        );
        let state = self.block(kind);
        let active = if state.used.contains(&block.id) {
            state.epoch += 1;
            format!("{}:{}", lossy(&block.id), state.epoch).into()
        } else {
            state.used.push(block.id.clone());
            block.id.clone()
        };
        state.active = Some(active.clone());
        block.id = active;
        out.push(match kind {
            Kind::Text => Event::TextStart(block),
            Kind::Reasoning => Event::ReasoningStart(block),
        });
    }
}

struct Parser {
    inner: Box<dyn StreamParser>,
    linker: Linker,
    blocks: Blocks,
}
impl Parser {
    fn feed(&mut self, frames: Vec<JsonValue>) -> Result<Vec<Event>, Error> {
        let mut events = Vec::new();
        for frame in frames {
            for frame in split(frame) {
                if let Some(message) = get(&frame, "error")
                    .and_then(|error| get(error, "message"))
                    .and_then(json::string)
                {
                    events.push(Event::ProviderError {
                        message: message.clone(),
                        context_overflow: false,
                        provider_metadata: None,
                    });
                    continue;
                }
                events.extend(self.inner.push(&frame)?);
            }
        }
        Ok(self.blocks.normalize(events))
    }
}
impl StreamParser for Parser {
    fn push(&mut self, event: &JsonValue) -> Result<Vec<Event>, Error> {
        let frame = get(event, "response")
            .cloned()
            .unwrap_or_else(|| event.clone());
        let released = self.linker.push(frame);
        self.feed(released)
    }
    fn finish(&mut self) -> Result<Vec<Event>, Error> {
        let released = self.linker.flush();
        let mut events = self.feed(released)?;
        events.extend(self.blocks.normalize(self.inner.finish()?));
        Ok(events)
    }
}
