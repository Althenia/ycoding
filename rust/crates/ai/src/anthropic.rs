use crate::{
    Error,
    cache::{Capabilities, Hint, ThinkingMode, anthropic_capabilities},
    json::{self, get, s},
    llm::{
        BlockEvent, DeltaEvent, Event, Finish, FinishReason, Media, MediaData, Part, Request, Role,
        ToolCall, ToolChoice, ToolInputEvent, ToolResult, ToolResultValue, Usage,
    },
    provider_error::{Failure, classify},
    route::{Protocol, StreamParser},
};
use std::collections::BTreeMap;
use ycoding_schema::{JsonValue, LosslessString, llm::ToolContent, parse_json};

pub struct AnthropicMessages;
impl AnthropicMessages {
    pub fn parser(request: &Request) -> Parser {
        let thinking = request
            .provider_options
            .as_ref()
            .and_then(|options| get(options, "anthropic"))
            .and_then(|options| get(options, "thinking"));
        let capabilities = anthropic_capabilities(&request.model.id);
        let unreported =
            if thinking.is_some_and(|thinking| matches!(thinking, JsonValue::Object(_))) {
                thinking
                    .and_then(|thinking| get(thinking, "type"))
                    .and_then(json::text)
                    .is_some_and(|mode| matches!(mode, "adaptive" | "enabled"))
            } else {
                matches!(
                    capabilities.adaptive_thinking,
                    ThinkingMode::Default | ThinkingMode::Required
                )
            };
        Parser {
            tools: BTreeMap::new(),
            usage: None,
            unreported,
            started: false,
            text: Vec::new(),
            reasoning: Vec::new(),
            terminal: false,
        }
    }
}
impl Protocol for AnthropicMessages {
    fn response_formats(&self) -> &'static [&'static str] {
        &["json"]
    }
    fn request_headers(
        &self,
        request: &Request,
        mut headers: reqwest::header::HeaderMap,
    ) -> Result<reqwest::header::HeaderMap, Error> {
        if crate::effort::mechanism(request) == Some(crate::effort::Provider::Anthropic)
            && !crate::effort::openrouter_endpoint(&request.model.route.endpoint.base_url)
        {
            let mut values = headers
                .get("anthropic-beta")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>();
            if !values.contains(&crate::effort::ANTHROPIC_BETA) {
                values.push(crate::effort::ANTHROPIC_BETA);
            }
            let value = reqwest::header::HeaderValue::from_str(&values.join(","))
                .map_err(|_| Error::invalid("Invalid Anthropic beta header"))?;
            headers.insert("anthropic-beta", value);
        }
        Ok(headers)
    }
    fn id(&self) -> &'static str {
        "anthropic-messages"
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        lower(request)
    }
    fn parser(&self, request: &Request) -> Box<dyn StreamParser> {
        Box::new(Self::parser(request))
    }
}

struct Breakpoints {
    remaining: usize,
    dropped: usize,
}
impl Breakpoints {
    fn attach(&mut self, mut block: JsonValue, hint: Option<&Hint>) -> JsonValue {
        if let Some(hint) = hint {
            if self.remaining == 0 {
                self.dropped += 1;
                return block;
            }
            self.remaining -= 1;
            let mut control = json::object([("type", s("ephemeral"))]);
            if hint.one_hour() {
                json::set(&mut control, "ttl", s("1h"));
            }
            json::set(&mut block, "cache_control", control);
        }
        block
    }
}
fn text_block(text: LosslessString) -> JsonValue {
    json::object([("type", s("text")), ("text", s(text))])
}
fn append_user(messages: &mut Vec<JsonValue>, content: Vec<JsonValue>, volatile: bool) {
    if !volatile
        && let Some(previous) = messages.last_mut()
        && get(previous, "role").and_then(json::text) == Some("user")
    {
        let mut blocks = get(previous, "content")
            .and_then(json::array)
            .unwrap_or(&[])
            .to_vec();
        blocks.extend(content);
        json::set(previous, "content", JsonValue::Array(blocks));
        return;
    }
    messages.push(json::object([
        ("role", s("user")),
        ("content", JsonValue::Array(content)),
    ]));
}
fn server_type(name: &LosslessString) -> Option<&'static str> {
    match name.as_str() {
        Some("web_search") => Some("web_search_tool_result"),
        Some("code_execution") => Some("code_execution_tool_result"),
        Some("web_fetch") => Some("web_fetch_tool_result"),
        _ => None,
    }
}
fn options(request: &Request) -> Option<&JsonValue> {
    request
        .provider_options
        .as_ref()
        .and_then(|options| get(options, "anthropic"))
}
fn thinking(request: &Request, capabilities: &Capabilities) -> Result<Option<JsonValue>, Error> {
    let raw = options(request).and_then(|options| get(options, "thinking"));
    let Some(raw) = raw.filter(|value| matches!(value, JsonValue::Object(_))) else {
        return Ok(matches!(
            capabilities.adaptive_thinking,
            ThinkingMode::Default | ThinkingMode::Required
        )
        .then(|| json::object([("type", s("adaptive"))])));
    };
    match get(raw, "type").and_then(json::text) {
        Some("adaptive") => {
            let mut value = json::object([("type", s("adaptive"))]);
            if let Some(display) = get(raw, "display")
                .and_then(json::text)
                .filter(|value| matches!(*value, "summarized" | "omitted"))
            {
                json::set(&mut value, "display", s(display));
            }
            Ok(Some(value))
        }
        Some("disabled") => {
            if capabilities.adaptive_thinking == ThinkingMode::Required {
                return Err(Error::invalid(format!(
                    "Anthropic model {} requires adaptive thinking",
                    request.model.id.as_str().unwrap_or("")
                )));
            }
            if let Some(maximum) = capabilities.disable_thinking_max_effort
                && let Some(effort) = options(request)
                    .and_then(|options| get(options, "effort"))
                    .and_then(json::text)
                && capabilities
                    .effort
                    .iter()
                    .position(|value| *value == effort)
                    > capabilities
                        .effort
                        .iter()
                        .position(|value| *value == maximum)
            {
                return Err(Error::invalid(format!(
                    "Anthropic model {} cannot disable thinking at effort {effort}",
                    request.model.id.as_str().unwrap_or("")
                )));
            }
            Ok(Some(json::object([("type", s("disabled"))])))
        }
        Some("enabled") => {
            if !capabilities.manual_thinking
                && capabilities.adaptive_thinking != ThinkingMode::Unsupported
            {
                return Err(Error::invalid(format!(
                    "Anthropic model {} requires adaptive thinking",
                    request.model.id.as_str().unwrap_or("")
                )));
            }
            let budget = get(raw, "budgetTokens")
                .and_then(json::number)
                .or_else(|| get(raw, "budget_tokens").and_then(json::number))
                .ok_or_else(|| {
                    Error::invalid("Anthropic thinking provider option requires budgetTokens")
                })?;
            Ok(Some(json::object([
                ("type", s("enabled")),
                ("budget_tokens", JsonValue::Number(budget)),
            ])))
        }
        _ => Ok(None),
    }
}
pub fn lower(request: &Request) -> Result<JsonValue, Error> {
    let capabilities = anthropic_capabilities(&request.model.id);
    let mut breakpoints = Breakpoints {
        remaining: 4,
        dropped: 0,
    };
    let tools = if request.tool_choice == Some(ToolChoice::None) || request.tools.is_empty() {
        None
    } else {
        Some(JsonValue::Array(
            request
                .tools
                .iter()
                .map(|tool| {
                    if !matches!(&tool.input_schema, JsonValue::Object(_)) {
                        return Err(Error::invalid("Tool inputSchema must be a JSON object"));
                    }
                    let schema =
                        crate::tool_schema::anthropic(&crate::tool_schema::model_compatibility(
                            &tool.input_schema,
                            request.model.tool_schema,
                        ));
                    Ok(breakpoints.attach(
                        json::object([
                            ("name", s(tool.name.clone())),
                            ("description", s(tool.description.clone())),
                            ("input_schema", schema),
                        ]),
                        tool.cache.as_ref(),
                    ))
                })
                .collect::<Result<Vec<_>, Error>>()?,
        ))
    };
    let system = if request.system.is_empty() {
        None
    } else {
        Some(JsonValue::Array(
            request
                .system
                .iter()
                .map(|part| breakpoints.attach(text_block(part.text.clone()), part.cache.as_ref()))
                .collect(),
        ))
    };
    let mut messages = Vec::new();
    let mut pending = Vec::new();
    for (index, message) in request.messages.iter().enumerate() {
        if let Some(effort) = crate::effort::update(message, crate::effort::Provider::Anthropic) {
            let valid = ["low", "medium", "high", "xhigh", "max"].contains(&effort)
                || crate::effort::openrouter_endpoint(&request.model.route.endpoint.base_url)
                    && ["none", "minimal"].contains(&effort);
            if crate::effort::mechanism(request) != Some(crate::effort::Provider::Anthropic)
                || message.role != Role::System
                || !message.content.is_empty()
                || !valid
            {
                return Err(Error::invalid(
                    "Anthropic effort update requires a supported Messages endpoint, model and thinking mode",
                ));
            }
            messages.push(json::object([
                ("role", s("system")),
                ("content", JsonValue::Array(vec![])),
                ("output_config", json::object([("effort", s(effort))])),
            ]));
            continue;
        }
        if message.role == Role::System {
            if !pending.is_empty() {
                return Err(Error::invalid(
                    "Anthropic Messages system updates cannot split a local tool call from its tool result",
                ));
            }
            let parts = message
                .content
                .iter()
                .map(|part| {
                    if let Part::Text(part) = part {
                        Ok(part)
                    } else {
                        Err(Error::invalid(
                            "Anthropic Messages system messages only support text content for now",
                        ))
                    }
                })
                .collect::<Result<Vec<_>, _>>()?;
            let previous = index
                .checked_sub(1)
                .and_then(|index| request.messages.get(index));
            let next = request.messages.get(index + 1);
            let native=capabilities.mid_conversation_system && previous.is_some_and(|message| matches!(message.role,Role::User|Role::Tool) || message.role==Role::Assistant && matches!(message.content.last(),Some(Part::ToolCall(call)) if call.provider_executed==Some(true))) && next.is_none_or(|message|message.role==Role::Assistant);
            if native {
                messages.push(json::object([
                    ("role", s("system")),
                    (
                        "content",
                        JsonValue::Array(
                            parts
                                .into_iter()
                                .map(|part| {
                                    breakpoints
                                        .attach(text_block(part.text.clone()), part.cache.as_ref())
                                })
                                .collect(),
                        ),
                    ),
                ]));
            } else {
                let mut units = Vec::new();
                for (i, part) in parts.iter().enumerate() {
                    if i > 0 {
                        units.push(10);
                    }
                    for unit in part.text.code_units() {
                        match unit {
                            38 => units.extend("&amp;".encode_utf16()),
                            60 => units.extend("&lt;".encode_utf16()),
                            62 => units.extend("&gt;".encode_utf16()),
                            _ => units.push(unit),
                        }
                    }
                }
                let text = LosslessString::from_utf16(
                    "<system-update>\n"
                        .encode_utf16()
                        .chain(units)
                        .chain("\n</system-update>".encode_utf16())
                        .collect(),
                );
                append_user(
                    &mut messages,
                    vec![breakpoints.attach(
                        text_block(text),
                        parts.last().and_then(|part| part.cache.as_ref()),
                    )],
                    false,
                );
            }
            continue;
        }
        let mut content = Vec::new();
        for part in &message.content {
            let block = match (message.role, part) {
                (Role::User | Role::Assistant, Part::Text(part)) => {
                    breakpoints.attach(text_block(part.text.clone()), part.cache.as_ref())
                }
                (Role::User, Part::Media(part)) => media(part),
                (Role::Assistant, Part::Reasoning(part)) => {
                    let metadata = part
                        .provider_metadata
                        .as_ref()
                        .and_then(|metadata| get(metadata, "anthropic"));
                    if let Some(data) = metadata
                        .and_then(|metadata| get(metadata, "redactedData"))
                        .and_then(json::string)
                    {
                        json::object([("type", s("redacted_thinking")), ("data", s(data.clone()))])
                    } else {
                        let mut block = json::object([
                            ("type", s("thinking")),
                            ("thinking", s(part.text.clone())),
                        ]);
                        if let Some(signature) = part.encrypted.as_ref().or_else(|| {
                            metadata
                                .and_then(|metadata| get(metadata, "signature"))
                                .and_then(json::string)
                        }) {
                            json::set(&mut block, "signature", s(signature.clone()));
                        }
                        block
                    }
                }
                (Role::Assistant, Part::ToolCall(call)) => {
                    if call.provider_executed != Some(true) && !pending.contains(&call.id) {
                        pending.push(call.id.clone());
                    }
                    json::object([
                        (
                            "type",
                            s(if call.provider_executed == Some(true) {
                                "server_tool_use"
                            } else {
                                "tool_use"
                            }),
                        ),
                        ("id", s(call.id.clone())),
                        ("name", s(call.name.clone())),
                        ("input", call.input.clone()),
                    ])
                }
                (Role::Assistant, Part::ToolResult(result))
                    if result.provider_executed == Some(true) =>
                {
                    let kind=server_type(&result.name).ok_or_else(||Error::invalid(format!("Anthropic Messages does not know how to round-trip server tool result for {}",result.name.as_str().unwrap_or(""))))?;
                    json::object([
                        ("type", s(kind)),
                        ("tool_use_id", s(result.id.clone())),
                        ("content", result.result.to_json()),
                    ])
                }
                (Role::Tool, Part::ToolResult(result)) => {
                    pending.retain(|id| *id != result.id);
                    let value = match &result.result {
                        ToolResultValue::Content(items) => JsonValue::Array(
                            items
                                .iter()
                                .map(|item| match item {
                                    ToolContent::Text(part) => text_block(part.text.clone()),
                                    ToolContent::File(part) => media(&Media {
                                        mime: part.mime.clone(),
                                        data: MediaData::Encoded(part.uri.clone()),
                                        filename: part.name.clone(),
                                    }),
                                })
                                .collect(),
                        ),
                        _ => s(result.result.to_text()),
                    };
                    let mut block = json::object([
                        ("type", s("tool_result")),
                        ("tool_use_id", s(result.id.clone())),
                        ("content", value),
                    ]);
                    if matches!(result.result, ToolResultValue::Error(_)) {
                        json::set(&mut block, "is_error", JsonValue::Bool(true));
                    }
                    breakpoints.attach(block, result.cache.as_ref())
                }
                (Role::Assistant, _) => {
                    return Err(Error::invalid(
                        "Anthropic Messages assistant messages only support text, reasoning, and tool-call content for now",
                    ));
                }
                (Role::Tool, _) => {
                    return Err(Error::invalid(
                        "Anthropic Messages tool messages only support tool-result content for now",
                    ));
                }
                _ => {
                    return Err(Error::invalid(
                        "Anthropic Messages user messages only support text and media content for now",
                    ));
                }
            };
            content.push(block);
        }
        if matches!(message.role, Role::User | Role::Tool) {
            append_user(&mut messages, content, message.volatile);
        } else {
            messages.push(json::object([
                ("role", s("assistant")),
                ("content", JsonValue::Array(content)),
            ]));
        }
    }
    let mut body = json::object([("model", s(request.model.id.clone()))]);
    if let Some(system) = system {
        json::set(&mut body, "system", system);
    }
    json::set(&mut body, "messages", JsonValue::Array(messages));
    if let Some(tools) = tools {
        json::set(&mut body, "tools", tools);
    }
    if let Some(choice) = &request.tool_choice {
        let choice = match choice {
            ToolChoice::None => None,
            ToolChoice::Auto => Some(json::object([("type", s("auto"))])),
            ToolChoice::Required => Some(json::object([("type", s("any"))])),
            ToolChoice::Tool(name) => {
                if name.is_empty() {
                    return Err(Error::invalid(
                        "Anthropic Messages tool choice requires a tool name",
                    ));
                }
                Some(json::object([
                    ("type", s("tool")),
                    ("name", s(name.clone())),
                ]))
            }
        };
        if let Some(choice) = choice {
            json::set(&mut body, "tool_choice", choice);
        }
    }
    json::set(&mut body, "stream", JsonValue::Bool(true));
    json::set(
        &mut body,
        "max_tokens",
        JsonValue::Number(
            request
                .generation
                .max_tokens
                .or(request.model.defaults.output_limit)
                .or(request.model.route.defaults.output_limit)
                .unwrap_or(4096.0),
        ),
    );
    if !capabilities.default_only_sampling {
        for (key, value) in [
            ("temperature", request.generation.temperature),
            ("top_p", request.generation.top_p),
            ("top_k", request.generation.top_k),
        ] {
            if let Some(value) = value {
                json::set(&mut body, key, JsonValue::Number(value));
            }
        }
    } else if request.generation.temperature.is_some()
        || request.generation.top_p.is_some()
        || request.generation.top_k.is_some()
    {
        tracing::warn!(
            "Anthropic model does not support non-default sampling; omitted temperature, topP, and topK"
        );
    }
    if let Some(stop) = &request.generation.stop {
        json::set(
            &mut body,
            "stop_sequences",
            JsonValue::Array(stop.iter().cloned().map(s).collect()),
        );
    }
    if let Some(thinking) = thinking(request, &capabilities)? {
        json::set(&mut body, "thinking", thinking);
    }
    if let Some(effort) = options(request)
        .and_then(|options| get(options, "effort"))
        .and_then(json::string)
    {
        if !capabilities.effort.is_empty()
            && !capabilities.effort.contains(&effort.as_str().unwrap_or(""))
        {
            return Err(Error::invalid(format!(
                "Anthropic model {} does not support effort {}",
                request.model.id.as_str().unwrap_or(""),
                effort.as_str().unwrap_or("")
            )));
        }
        json::set(
            &mut body,
            "output_config",
            json::object([("effort", s(effort.clone()))]),
        );
    }
    if let Some(schema) = crate::structured_output::request_schema(request) {
        let output = json::merge(
            &get(&body, "output_config")
                .cloned()
                .unwrap_or_else(json::empty),
            &json::object([(
                "format",
                json::object([("type", s("json_schema")), ("schema", schema)]),
            )]),
        );
        json::set(&mut body, "output_config", output);
    }
    if breakpoints.dropped > 0 {
        tracing::warn!(
            dropped = breakpoints.dropped,
            "Anthropic Messages: dropped cache breakpoints; the API allows at most 4 per request"
        );
    }
    Ok(body)
}
fn media(part: &Media) -> JsonValue {
    match crate::media::validate("Anthropic Messages", part) {
        Ok((mime, data)) => json::object([
            ("type", s("image")),
            (
                "source",
                json::object([
                    ("type", s("base64")),
                    ("media_type", s(mime)),
                    ("data", s(data)),
                ]),
            ),
        ]),
        Err(error) => {
            let notice = format!(
                "File {} ({}) omitted: {}",
                part.filename
                    .as_ref()
                    .and_then(LosslessString::as_str)
                    .unwrap_or("(unnamed)"),
                part.mime.as_str().unwrap_or(""),
                error.message
            );
            tracing::warn!("Anthropic Messages: {notice}");
            text_block(notice.into())
        }
    }
}

struct PendingTool {
    id: LosslessString,
    name: LosslessString,
    input: LosslessString,
    server: bool,
}
pub struct Parser {
    tools: BTreeMap<String, PendingTool>,
    usage: Option<Usage>,
    unreported: bool,
    started: bool,
    text: Vec<String>,
    reasoning: Vec<String>,
    terminal: bool,
}
fn metadata(key: &str, value: JsonValue) -> Option<JsonValue> {
    Some(json::object([("anthropic", json::object([(key, value)]))]))
}
impl Parser {
    pub fn push(&mut self, frame: &str) -> Result<Vec<Event>, Error> {
        let event = parse_json(frame)
            .map_err(|_| Error::output("Invalid anthropic-messages stream event"))?;
        self.push_event(&event)
    }
    pub fn finish(&self) -> Result<(), Error> {
        if self.terminal {
            Ok(())
        } else {
            Err(Error::missing_terminal())
        }
    }
    fn start(&mut self, events: &mut Vec<Event>) {
        if !self.started {
            self.started = true;
            events.push(Event::StepStart { index: 0.0 });
        }
    }
    fn delta(
        &mut self,
        events: &mut Vec<Event>,
        id: String,
        text: LosslessString,
        reasoning: bool,
    ) {
        self.start(events);
        let ids = if reasoning {
            &mut self.reasoning
        } else {
            &mut self.text
        };
        if !ids.contains(&id) {
            ids.push(id.clone());
            let block = BlockEvent {
                id: id.clone().into(),
                provider_metadata: None,
            };
            events.push(if reasoning {
                Event::ReasoningStart(block)
            } else {
                Event::TextStart(block)
            });
        }
        let delta = DeltaEvent {
            id: id.into(),
            text,
            provider_metadata: None,
        };
        events.push(if reasoning {
            Event::ReasoningDelta(delta)
        } else {
            Event::TextDelta(delta)
        });
    }
    fn reasoning_start(&mut self, events: &mut Vec<Event>, id: String) {
        if self.reasoning.contains(&id) {
            return;
        }
        self.start(events);
        self.reasoning.push(id.clone());
        events.push(Event::ReasoningStart(BlockEvent {
            id: id.into(),
            provider_metadata: None,
        }));
    }
    fn end(
        &mut self,
        events: &mut Vec<Event>,
        id: String,
        reasoning: bool,
        metadata: Option<JsonValue>,
    ) {
        let ids = if reasoning {
            &mut self.reasoning
        } else {
            &mut self.text
        };
        if !ids.contains(&id) {
            return;
        }
        ids.retain(|current| *current != id);
        let block = BlockEvent {
            id: id.into(),
            provider_metadata: metadata,
        };
        events.push(if reasoning {
            Event::ReasoningEnd(block)
        } else {
            Event::TextEnd(block)
        });
    }
    fn push_event(&mut self, event: &JsonValue) -> Result<Vec<Event>, Error> {
        validate_event(event)?;
        let kind = get(event, "type").and_then(json::text).unwrap_or("");
        let index = get(event, "index")
            .and_then(json::number)
            .unwrap_or(0.0)
            .to_string();
        let text_id = format!("text-{index}");
        let reasoning_id = format!("reasoning-{index}");
        let mut events = Vec::new();
        match kind {
            "message_start" => {
                if let Some(usage) = get(event, "message").and_then(|message| get(message, "usage"))
                {
                    self.merge_usage(usage);
                }
            }
            "content_block_start" => {
                if let Some(block) = get(event, "content_block") {
                    match get(block, "type").and_then(json::text).unwrap_or("") {
                        "tool_use" | "server_tool_use" if get(event, "index").is_some() => {
                            self.start(&mut events);
                            let server =
                                get(block, "type").and_then(json::text) == Some("server_tool_use");
                            let id = get(block, "id")
                                .and_then(json::string)
                                .cloned()
                                .unwrap_or_else(|| index.clone().into());
                            let name = get(block, "name")
                                .and_then(json::string)
                                .cloned()
                                .unwrap_or_default();
                            events.push(Event::ToolInputStart(ToolInputEvent {
                                id: id.clone(),
                                name: name.clone(),
                                provider_executed: server.then_some(true),
                                provider_metadata: None,
                            }));
                            self.tools.insert(
                                index.clone(),
                                PendingTool {
                                    id,
                                    name,
                                    input: LosslessString::default(),
                                    server,
                                },
                            );
                        }
                        "text" => {
                            if let Some(text) = get(block, "text")
                                .and_then(json::string)
                                .filter(|text| !text.is_empty())
                            {
                                self.delta(&mut events, text_id.clone(), text.clone(), false);
                            }
                        }
                        "thinking" => {
                            self.reasoning_start(&mut events, reasoning_id.clone());
                            if let Some(text) = get(block, "thinking")
                                .and_then(json::string)
                                .filter(|text| !text.is_empty())
                            {
                                self.delta(&mut events, reasoning_id.clone(), text.clone(), true);
                            }
                        }
                        "redacted_thinking" => {
                            if let Some(data) = get(block, "data").and_then(json::string) {
                                self.reasoning_start(&mut events, reasoning_id.clone());
                                self.end(
                                    &mut events,
                                    reasoning_id.clone(),
                                    true,
                                    metadata("redactedData", s(data.clone())),
                                );
                            }
                        }
                        "web_search_tool_result"
                        | "code_execution_tool_result"
                        | "web_fetch_tool_result" => {
                            self.start(&mut events);
                            let kind = get(block, "type").and_then(json::text).unwrap_or("");
                            let name = kind.trim_end_matches("_tool_result");
                            let content = get(block, "content").cloned().unwrap_or(JsonValue::Null);
                            let error = get(&content, "type")
                                .and_then(json::text)
                                .is_some_and(|value| value.ends_with("_tool_result_error"));
                            events.push(Event::ToolResult(ToolResult {
                                id: get(block, "tool_use_id")
                                    .and_then(json::string)
                                    .cloned()
                                    .unwrap_or_default(),
                                name: name.into(),
                                result: if error {
                                    ToolResultValue::Error(content)
                                } else {
                                    ToolResultValue::Json(content)
                                },
                                cache: None,
                                provider_executed: Some(true),
                                provider_metadata: metadata("blockType", s(kind)),
                                output: None,
                            }));
                        }
                        _ => {}
                    }
                }
            }
            "content_block_delta" => {
                if let Some(delta) = get(event, "delta") {
                    match get(delta, "type").and_then(json::text) {
                        Some("text_delta") => {
                            if let Some(text) = get(delta, "text")
                                .and_then(json::string)
                                .filter(|text| !text.is_empty())
                            {
                                self.delta(&mut events, text_id.clone(), text.clone(), false);
                            }
                        }
                        Some("thinking_delta") => {
                            if let Some(text) = get(delta, "thinking")
                                .and_then(json::string)
                                .filter(|text| !text.is_empty())
                            {
                                self.delta(&mut events, reasoning_id.clone(), text.clone(), true);
                            }
                        }
                        Some("signature_delta") => {
                            if let Some(signature) = get(delta, "signature")
                                .and_then(json::string)
                                .filter(|text| !text.is_empty())
                            {
                                self.end(
                                    &mut events,
                                    reasoning_id.clone(),
                                    true,
                                    metadata("signature", s(signature.clone())),
                                );
                            }
                        }
                        Some("input_json_delta") if get(event, "index").is_some() => {
                            if let Some(text) = get(delta, "partial_json")
                                .and_then(json::string)
                                .filter(|text| !text.is_empty())
                            {
                                self.start(&mut events);
                                let tool=self.tools.get_mut(&index).ok_or_else(||Error::output("Anthropic Messages tool argument delta is missing its tool call"))?;
                                json::concat(&mut tool.input, text);
                                events.push(Event::ToolInputDelta {
                                    id: tool.id.clone(),
                                    name: tool.name.clone(),
                                    text: text.clone(),
                                });
                            }
                        }
                        _ => {}
                    }
                }
            }
            "content_block_stop" if get(event, "index").is_some() => {
                if let Some(tool) = self.tools.remove(&index) {
                    match json::parse_tool_input(&tool.input) {
                        Ok(input) => {
                            self.start(&mut events);
                            events.push(Event::ToolInputEnd(ToolInputEvent {
                                id: tool.id.clone(),
                                name: tool.name.clone(),
                                provider_executed: None,
                                provider_metadata: None,
                            }));
                            events.push(Event::ToolCall(ToolCall {
                                id: tool.id,
                                name: tool.name,
                                input,
                                provider_executed: tool.server.then_some(true),
                                provider_metadata: None,
                            }));
                        }
                        Err(_) => {
                            if tool.server {
                                return Err(Error::output(format!(
                                    "Invalid JSON input for anthropic-messages tool call {}",
                                    tool.name.as_str().unwrap_or("")
                                )));
                            } else {
                                self.start(&mut events);
                                events.push(Event::ToolInputError {
                                    id: tool.id,
                                    name: tool.name,
                                    raw: tool.input,
                                });
                            }
                        }
                    }
                } else {
                    self.end(&mut events, text_id, false, None);
                    self.end(&mut events, reasoning_id, true, None);
                }
            }
            "message_delta" => {
                if let Some(usage) = get(event, "usage") {
                    self.merge_usage(usage);
                }
                self.start(&mut events);
                for id in self.reasoning.clone() {
                    self.end(&mut events, id, true, None);
                }
                for id in self.text.clone() {
                    self.end(&mut events, id, false, None);
                }
                let delta = get(event, "delta");
                let reason = match delta
                    .and_then(|delta| get(delta, "stop_reason"))
                    .and_then(json::text)
                {
                    Some("end_turn" | "stop_sequence" | "pause_turn") => FinishReason::Stop,
                    Some("max_tokens") => FinishReason::Length,
                    Some("tool_use") => FinishReason::ToolCalls,
                    Some("refusal") => FinishReason::ContentFilter,
                    _ => FinishReason::Unknown,
                };
                let finish = Finish {
                    reason,
                    usage: self.usage.clone(),
                    provider_metadata: delta
                        .and_then(|delta| get(delta, "stop_sequence"))
                        .and_then(json::string)
                        .filter(|value| !value.is_empty())
                        .and_then(|value| metadata("stopSequence", s(value.clone()))),
                };
                events.push(Event::StepFinish {
                    index: 0.0,
                    finish: finish.clone(),
                });
                events.push(Event::Finish(finish));
                self.started = false;
            }
            "error" => {
                let error = get(event, "error");
                let kind = error
                    .and_then(|error| get(error, "type"))
                    .and_then(json::text)
                    .filter(|value| !value.is_empty());
                let message = error
                    .and_then(|error| get(error, "message"))
                    .and_then(json::text)
                    .filter(|value| !value.is_empty());
                let message = match (kind, message) {
                    (Some(kind), Some(message)) => format!("{kind}: {message}"),
                    (None, Some(message)) => message.into(),
                    (Some(kind), None) => kind.into(),
                    _ => "Anthropic Messages stream error".into(),
                };
                return Err(classify(Failure {
                    message,
                    code: kind.map(String::from),
                    ..Failure::default()
                }));
            }
            _ => {}
        }
        if self.terminal && !events.is_empty() {
            return Err(Error::output(
                "Provider emitted an event after the terminal event",
            ));
        }
        if events.iter().any(Event::terminal) {
            self.terminal = true;
        }
        Ok(events)
    }
    fn merge_usage(&mut self, raw: &JsonValue) {
        let mut native = self
            .usage
            .as_ref()
            .and_then(|usage| usage.provider_metadata.as_ref())
            .and_then(|metadata| get(metadata, "anthropic"))
            .cloned()
            .unwrap_or_else(json::empty);
        let mut decoded = json::empty();
        for key in [
            "input_tokens",
            "output_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
        ] {
            if let Some(value) = get(raw, key) {
                json::set(&mut decoded, key, value.clone());
            }
        }
        if let Some(creation) = get(raw, "cache_creation") {
            let mut value = json::empty();
            for key in ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"] {
                if let Some(field) = get(creation, key) {
                    json::set(&mut value, key, field.clone());
                }
            }
            if matches!(creation, JsonValue::Null) {
                value = JsonValue::Null;
            }
            json::set(&mut decoded, "cache_creation", value);
        }
        let creation = json::merge(
            get(&native, "cache_creation")
                .filter(|value| matches!(value, JsonValue::Object(_)))
                .unwrap_or(&json::empty()),
            get(&decoded, "cache_creation")
                .filter(|value| matches!(value, JsonValue::Object(_)))
                .unwrap_or(&json::empty()),
        );
        native = json::merge(&native, &decoded);
        if matches!(&creation,JsonValue::Object(fields) if !fields.is_empty()) {
            json::set(&mut native, "cache_creation", creation);
        }
        let previous = self.usage.clone().unwrap_or_default();
        let count = |key: &str| {
            get(raw, key)
                .and_then(json::number)
                .filter(|number| number.is_finite())
                .map(|number| number.max(0.0))
        };
        let non_cached = count("input_tokens").or(previous.non_cached_input_tokens);
        let read = count("cache_read_input_tokens").or(previous.cache_read_input_tokens);
        let write = count("cache_creation_input_tokens").or(previous.cache_write_input_tokens);
        let output = get(raw, "output_tokens")
            .and_then(json::number)
            .or(previous.output_tokens);
        let input = crate::route::sum_tokens(&[non_cached, read, write]);
        self.usage = Some(Usage {
            input_tokens: input,
            non_cached_input_tokens: non_cached,
            cache_read_input_tokens: read,
            cache_write_input_tokens: write,
            output_tokens: output,
            total_tokens: crate::route::sum_tokens(&[input, output]),
            output_may_include_unreported_reasoning: self.unreported.then_some(true),
            provider_metadata: Some(json::object([("anthropic", native)])),
            ..Usage::default()
        });
    }
}
impl StreamParser for Parser {
    fn push(&mut self, event: &JsonValue) -> Result<Vec<Event>, Error> {
        self.push_event(event)
    }
    fn finish(&mut self) -> Result<Vec<Event>, Error> {
        Parser::finish(self)?;
        Ok(Vec::new())
    }
}
fn validate_event(event: &JsonValue) -> Result<(), Error> {
    fn fields(value: &JsonValue, strings: &[&str], numbers: &[&str], nullable: &[&str]) -> bool {
        matches!(value, JsonValue::Object(_))
            && strings.iter().all(|key| {
                get(value, key).is_none_or(|value| matches!(value, JsonValue::String(_)))
            })
            && numbers.iter().all(|key| {
                get(value, key).is_none_or(|value| matches!(value, JsonValue::Number(_)))
            })
            && nullable.iter().all(|key| {
                get(value, key)
                    .is_none_or(|value| matches!(value, JsonValue::Null | JsonValue::String(_)))
            })
    }
    fn usage(value: &JsonValue) -> bool {
        fields(value, &[], &["input_tokens", "output_tokens"], &[])
            && ["cache_creation_input_tokens", "cache_read_input_tokens"]
                .iter()
                .all(|key| {
                    get(value, key)
                        .is_none_or(|value| matches!(value, JsonValue::Number(_) | JsonValue::Null))
                })
            && get(value, "cache_creation").is_none_or(|value| {
                matches!(value, JsonValue::Null)
                    || fields(
                        value,
                        &[],
                        &["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"],
                        &[],
                    )
            })
    }
    let valid = get(event, "type").is_some_and(|value| matches!(value, JsonValue::String(_)))
        && fields(event, &[], &["index"], &[])
        && get(event, "message").is_none_or(|value| {
            matches!(value, JsonValue::Object(_)) && get(value, "usage").is_none_or(usage)
        })
        && get(event, "usage").is_none_or(usage)
        && get(event, "content_block").is_none_or(|value| {
            get(value, "type").is_some_and(|value| matches!(value, JsonValue::String(_)))
                && fields(
                    value,
                    &[
                        "type",
                        "id",
                        "name",
                        "text",
                        "thinking",
                        "signature",
                        "tool_use_id",
                        "data",
                    ],
                    &[],
                    &[],
                )
        })
        && get(event, "delta").is_none_or(|value| {
            fields(
                value,
                &["type", "text", "thinking", "partial_json", "signature"],
                &[],
                &["stop_reason", "stop_sequence"],
            )
        })
        && get(event, "error").is_none_or(|value| fields(value, &["type", "message"], &[], &[]));
    if valid {
        Ok(())
    } else {
        Err(Error::output("Invalid anthropic-messages stream event"))
    }
}
