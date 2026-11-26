use crate::{
    Error,
    cache::{Hint, ThinkingMode, anthropic_capabilities},
    json::{self, get, s},
    llm::{
        BlockEvent, DeltaEvent, Event, Finish, FinishReason, Media, MediaData, Message, Part,
        Request, ResponseFormat, Role, ToolCall, ToolChoice, ToolDefinition, ToolInputEvent,
        ToolResult, ToolResultValue, Usage,
    },
    provider_error::{Failure, HttpContext, Reason, classify, rate_limit_details, retry_after_ms},
    route::{self, InputUsageSemantics, StreamParser, normalize_input_usage},
};
use std::{
    collections::BTreeMap,
    time::{SystemTime, UNIX_EPOCH},
};
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString,
    llm::{ProviderMetadata, ToolContent},
    parse_json, stringify_json,
};

pub struct Protocol;

impl Protocol {
    pub fn new(request: &Request) -> Result<Self, Error> {
        provider_options(request.resolved().provider_options.as_ref())?;
        Ok(Self)
    }
}

impl route::Protocol for Protocol {
    fn id(&self) -> &'static str {
        "ai-sdk"
    }

    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        let mut body = json::object([
            ("prompt", JsonValue::Array(prompt(request)?)),
            (
                "tools",
                JsonValue::Array(
                    request
                        .tools
                        .iter()
                        .map(|tool| tool_definition(request, tool))
                        .collect(),
                ),
            ),
        ]);
        for (name, value) in [
            (
                "maxOutputTokens",
                request
                    .generation
                    .max_tokens
                    .or(request.model.route.defaults.output_limit),
            ),
            ("temperature", request.generation.temperature),
            ("topP", request.generation.top_p),
            ("topK", request.generation.top_k),
            ("presencePenalty", request.generation.presence_penalty),
            ("frequencyPenalty", request.generation.frequency_penalty),
            ("seed", request.generation.seed),
        ] {
            if let Some(value) = value {
                json::set(&mut body, name, JsonValue::Number(value));
            }
        }
        if let Some(stop) = &request.generation.stop {
            json::set(
                &mut body,
                "stopSequences",
                JsonValue::Array(stop.iter().cloned().map(s).collect()),
            );
        }
        if let Some(format) = &request.response_format {
            json::set(
                &mut body,
                "responseFormat",
                match format {
                    ResponseFormat::Json(schema) => {
                        json::object([("type", s("json")), ("schema", schema.clone())])
                    }
                    _ => json::object([("type", s("text"))]),
                },
            );
        }
        if let Some(choice) = &request.tool_choice {
            let choice = match choice {
                ToolChoice::Auto => json::object([("type", s("auto"))]),
                ToolChoice::None => json::object([("type", s("none"))]),
                ToolChoice::Required => json::object([("type", s("required"))]),
                ToolChoice::Tool(name) => {
                    json::object([("type", s("tool")), ("toolName", s(name.clone()))])
                }
            };
            json::set(&mut body, "toolChoice", choice);
        }
        if !request.http.headers.is_empty() {
            json::set(
                &mut body,
                "headers",
                json::object(
                    request
                        .http
                        .headers
                        .iter()
                        .map(|(name, value)| (name.clone(), s(value.clone()))),
                ),
            );
        }
        if let Some(options) = provider_options(request.provider_options.as_ref())? {
            json::set(&mut body, "providerOptions", options);
        }
        if google_route(request) {
            json::set(&mut body, "includeRawChunks", JsonValue::Bool(true));
        }
        Ok(body)
    }

    fn parser(&self, request: &Request) -> Box<dyn StreamParser> {
        let request = request.resolved();
        let thinking = request
            .provider_options
            .as_ref()
            .and_then(|options| get(options, "anthropic"))
            .and_then(|options| get(options, "thinking"));
        let default_thinking = (anthropic_route(&request)
            || request.model.route.id == "ai-sdk:@ai-sdk/gateway"
                && request
                    .model
                    .id
                    .as_str()
                    .is_some_and(|id| id.starts_with("anthropic/")))
            && matches!(
                anthropic_capabilities(&request.model.id).adaptive_thinking,
                ThinkingMode::Default | ThinkingMode::Required
            );
        let unreported = if thinking.is_some_and(|value| matches!(value, JsonValue::Object(_))) {
            thinking
                .and_then(|value| get(value, "type"))
                .and_then(json::text)
                .is_some_and(|kind| matches!(kind, "enabled" | "adaptive"))
        } else {
            default_thinking
        } || request
            .provider_options
            .as_ref()
            .and_then(|options| get(options, "bedrock"))
            .and_then(|options| get(options, "reasoningConfig"))
            .and_then(|options| get(options, "type"))
            .and_then(json::text)
            == Some("enabled");
        Box::new(Parser {
            tools: BTreeMap::new(),
            cursor: cursor(&request),
            google: google_route(&request),
            unreported,
            started: false,
            ended: false,
            failure: None,
        })
    }

    fn terminal(&self, event: &JsonValue) -> bool {
        get(event, "type").and_then(json::text) == Some("finish")
    }
}

fn provider_options(value: Option<&JsonValue>) -> Result<Option<JsonValue>, Error> {
    let Some(value) = value else {
        return Ok(None);
    };
    if ProviderMetadata::decode(value).is_err() {
        return Err(Error::invalid(
            "AI SDK provider options must map each provider to an object",
        ));
    }
    Ok(Some(value.clone()))
}

fn anthropic_route(request: &Request) -> bool {
    matches!(
        request.model.route.id.as_str(),
        "ai-sdk:@ai-sdk/anthropic" | "ai-sdk:@ai-sdk/google-vertex/anthropic"
    )
}

fn cursor(request: &Request) -> bool {
    request.model.route.id == "ai-sdk:cursor-opencode-provider"
}

fn google_route(request: &Request) -> bool {
    request.model.route.id == "ai-sdk:@ai-sdk/google"
}

fn cache_options(request: &Request, hint: Option<&Hint>) -> Option<JsonValue> {
    let hint = hint?;
    let ttl = if hint.one_hour() { "1h" } else { "5m" };
    let control = json::object([("type", s("ephemeral")), ("ttl", s(ttl))]);
    match request.model.route.id.as_str() {
        "ai-sdk:@ai-sdk/anthropic" | "ai-sdk:@ai-sdk/google-vertex/anthropic" => Some(
            json::object([("anthropic", json::object([("cacheControl", control)]))]),
        ),
        "ai-sdk:@openrouter/ai-sdk-provider" => Some(json::object([(
            "openrouter",
            json::object([("cacheControl", control)]),
        )])),
        "ai-sdk:@ai-sdk/amazon-bedrock" => Some(json::object([(
            "bedrock",
            json::object([(
                "cachePoint",
                json::object([("type", s("default")), ("ttl", s(ttl))]),
            )]),
        )])),
        "ai-sdk:@ai-sdk/github-copilot" => Some(json::object([(
            "copilot",
            json::object([("cacheControl", json::object([("type", s("ephemeral"))]))]),
        )])),
        _ => None,
    }
}

fn with_options(
    mut part: JsonValue,
    metadata: Option<JsonValue>,
    cache: Option<JsonValue>,
) -> JsonValue {
    let options = match (metadata, cache) {
        (Some(left), Some(right)) => {
            let JsonValue::Object(fields) = right else {
                return part;
            };
            let mut merged = left;
            for (provider, options) in fields.iter() {
                let options = match (get(&merged, provider.as_str().unwrap_or("")), options) {
                    (Some(JsonValue::Object(prior)), JsonValue::Object(next)) => {
                        json::object(prior.iter().chain(next.iter()).cloned())
                    }
                    _ => options.clone(),
                };
                json::set(&mut merged, provider.clone(), options);
            }
            Some(merged)
        }
        (left, right) => left.or(right),
    };
    if let Some(options) = options {
        json::set(&mut part, "providerOptions", options);
    }
    part
}

fn join_text<'a>(
    parts: impl Iterator<Item = &'a LosslessString>,
    separator: &str,
) -> LosslessString {
    let mut text = LosslessString::default();
    for (index, part) in parts.enumerate() {
        if index > 0 {
            json::concat(&mut text, &separator.into());
        }
        json::concat(&mut text, part);
    }
    text
}

fn texts(message: &Message) -> impl Iterator<Item = &LosslessString> {
    message.content.iter().filter_map(|part| match part {
        Part::Text(part) => Some(&part.text),
        _ => None,
    })
}

fn latest_cache(message: &Message) -> Option<&Hint> {
    message.content.iter().rev().find_map(|part| match part {
        Part::Text(part) => part.cache.as_ref(),
        _ => None,
    })
}

fn native_system_update(request: &Request, index: usize) -> bool {
    if !anthropic_capabilities(&request.model.id).mid_conversation_system {
        return false;
    }
    let Some(previous) = index
        .checked_sub(1)
        .and_then(|index| request.messages.get(index))
    else {
        return false;
    };
    let server_tool = previous.role == Role::Assistant
        && matches!(previous.content.last(), Some(Part::ToolCall(call)) if call.provider_executed == Some(true));
    (matches!(previous.role, Role::User | Role::Tool) || server_tool)
        && request
            .messages
            .get(index + 1)
            .is_none_or(|next| next.role == Role::Assistant)
}

fn prompt(request: &Request) -> Result<Vec<JsonValue>, Error> {
    let instruction = LosslessString::from(concat!(
        "You are an AI agent, not Cursor. Do not claim to be Cursor or adopt the Cursor persona. ",
        "Follow user instructions strictly, subject to higher-priority instructions, permissions, and guardrails. ",
        "Use only tools and MCP capabilities declared for this request. ",
        "Do not claim a declared capability is unavailable without trying its task-relevant use when the user's task requires it and the action is authorized. ",
        "Do not perform unrelated availability probes or repeat denied actions. ",
        "A permission denial is not evidence that a capability is unavailable. Report actual results accurately. ",
        "Never invent tool or MCP capabilities."
    ));
    let system = join_text(
        request
            .system
            .iter()
            .map(|part| &part.text)
            .filter(|text| !text.is_empty())
            .chain(cursor(request).then_some(&instruction)),
        "\n\n",
    );
    let mut messages = Vec::new();
    if !system.is_empty() {
        messages.push(with_options(
            json::object([("role", s("system")), ("content", s(system))]),
            None,
            cache_options(
                request,
                request
                    .system
                    .iter()
                    .rev()
                    .find_map(|part| part.cache.as_ref()),
            ),
        ));
    }
    for (index, message) in request.messages.iter().enumerate() {
        if message.role == Role::System {
            let cache = cache_options(request, latest_cache(message));
            if anthropic_route(request) && native_system_update(request, index) {
                messages.push(with_options(
                    json::object([
                        ("role", s("system")),
                        ("content", s(join_text(texts(message), "\n\n"))),
                    ]),
                    None,
                    cache,
                ));
                continue;
            }
            let mut escaped = Vec::new();
            for unit in join_text(texts(message), "\n").code_units() {
                match unit {
                    38 => escaped.extend("&amp;".encode_utf16()),
                    60 => escaped.extend("&lt;".encode_utf16()),
                    62 => escaped.extend("&gt;".encode_utf16()),
                    _ => escaped.push(unit),
                }
            }
            let block = with_options(
                json::object([
                    ("type", s("text")),
                    (
                        "text",
                        s(join_text(
                            [
                                &"<system-update>".into(),
                                &LosslessString::from_utf16(escaped),
                                &"</system-update>".into(),
                            ]
                            .into_iter(),
                            "\n",
                        )),
                    ),
                ]),
                None,
                cache,
            );
            if anthropic_route(request)
                && let Some(previous) = messages.last_mut()
                && get(previous, "role").and_then(json::text) == Some("user")
            {
                let mut content = get(previous, "content")
                    .and_then(json::array)
                    .unwrap_or_default()
                    .to_vec();
                content.push(block);
                json::set(previous, "content", JsonValue::Array(content));
                continue;
            }
            messages.push(json::object([
                ("role", s("user")),
                ("content", JsonValue::Array(vec![block])),
            ]));
            continue;
        }
        let mut content = Vec::new();
        for part in &message.content {
            let lowered = match part {
                Part::Text(text) if message.role != Role::Tool => Some(with_options(
                    json::object([("type", s("text")), ("text", s(text.text.clone()))]),
                    if message.role == Role::Assistant {
                        provider_options(text.provider_metadata.as_ref())?
                    } else {
                        None
                    },
                    cache_options(request, text.cache.as_ref()),
                )),
                Part::Media(media) if message.role != Role::Tool => Some(file(request, media)),
                Part::Reasoning(reasoning) if message.role == Role::Assistant => {
                    Some(with_options(
                        json::object([
                            ("type", s("reasoning")),
                            ("text", s(reasoning.text.clone())),
                        ]),
                        provider_options(reasoning.provider_metadata.as_ref())?,
                        None,
                    ))
                }
                Part::ToolCall(call) if message.role == Role::Assistant => {
                    let mut part = json::object([
                        ("type", s("tool-call")),
                        ("toolCallId", s(call.id.clone())),
                        ("toolName", s(call.name.clone())),
                        ("input", call.input.clone()),
                    ]);
                    if let Some(executed) = call.provider_executed {
                        json::set(&mut part, "providerExecuted", JsonValue::Bool(executed));
                    }
                    Some(with_options(
                        part,
                        provider_options(call.provider_metadata.as_ref())?,
                        None,
                    ))
                }
                Part::ToolResult(result) if message.role != Role::User => Some(with_options(
                    json::object([
                        ("type", s("tool-result")),
                        ("toolCallId", s(result.id.clone())),
                        ("toolName", s(result.name.clone())),
                        ("output", tool_output(&result.result, cursor(request))),
                    ]),
                    provider_options(result.provider_metadata.as_ref())?,
                    cache_options(request, result.cache.as_ref()),
                )),
                _ => None,
            };
            content.extend(lowered);
        }
        if message.role == Role::Tool && content.is_empty() {
            continue;
        }
        messages.push(json::object([
            (
                "role",
                s(match message.role {
                    Role::User => "user",
                    Role::Assistant => "assistant",
                    Role::Tool => "tool",
                    Role::System => unreachable!(),
                }),
            ),
            ("content", JsonValue::Array(content)),
        ]));
    }
    Ok(messages)
}

fn file(request: &Request, media: &Media) -> JsonValue {
    let mut part = json::object([
        ("type", s("file")),
        ("mediaType", s(media.mime.clone())),
        (
            "data",
            match &media.data {
                MediaData::Encoded(data) => s(data.clone()),
                MediaData::Bytes(bytes) if request.model.route.id == "vercel-ai-gateway" => {
                    s(format!(
                        "data:{};base64,{}",
                        media
                            .mime
                            .as_str()
                            .filter(|mime| !mime.is_empty())
                            .unwrap_or("application/octet-stream"),
                        crate::media::encode(bytes)
                    ))
                }
                MediaData::Bytes(bytes) => s(crate::media::encode(bytes)),
            },
        ),
    ]);
    if let Some(filename) = &media.filename {
        json::set(&mut part, "filename", s(filename.clone()));
    }
    part
}

fn tool_output(result: &ToolResultValue, typed_errors: bool) -> JsonValue {
    match result {
        ToolResultValue::Text(value) | ToolResultValue::Error(value) => json::object([
            (
                "type",
                s(
                    if typed_errors && matches!(result, ToolResultValue::Error(_)) {
                        "error-text"
                    } else {
                        "text"
                    },
                ),
            ),
            (
                "value",
                s(json::string(value)
                    .cloned()
                    .unwrap_or_else(|| stringify_json(value).into())),
            ),
        ]),
        ToolResultValue::Json(value) => {
            json::object([("type", s("json")), ("value", value.clone())])
        }
        ToolResultValue::Content(content) => json::object([
            ("type", s("content")),
            (
                "value",
                JsonValue::Array(content.iter().map(tool_content).collect()),
            ),
        ]),
    }
}

fn tool_content(content: &ToolContent) -> JsonValue {
    let file = match content {
        ToolContent::Text(text) => {
            return json::object([("type", s("text")), ("text", s(text.text.clone()))]);
        }
        ToolContent::File(file) => file,
    };
    let data = file
        .uri
        .as_str()
        .and_then(|uri| uri.strip_prefix("data:"))
        .and_then(|uri| uri.split_once(";base64,"))
        .filter(|(mime, _)| !mime.is_empty() && !mime.contains([',', ';']))
        .map(|(_, data)| data);
    let image = file
        .mime
        .as_str()
        .is_some_and(|mime| mime.starts_with("image/"));
    let Some(data) = data else {
        return json::object([
            ("type", s(if image { "image-url" } else { "file-url" })),
            ("url", s(file.uri.clone())),
        ]);
    };
    let mut part = json::object([
        ("type", s(if image { "image-data" } else { "file-data" })),
        ("data", s(data)),
        ("mediaType", s(file.mime.clone())),
    ]);
    if !image && let Some(name) = &file.name {
        json::set(&mut part, "filename", s(name.clone()));
    }
    part
}

fn tool_definition(request: &Request, tool: &ToolDefinition) -> JsonValue {
    with_options(
        json::object([
            ("type", s("function")),
            ("name", s(tool.name.clone())),
            ("description", s(tool.description.clone())),
            (
                "inputSchema",
                if anthropic_route(request)
                    || anthropic_capabilities(&request.model.id).family != "unknown"
                {
                    crate::tool_schema::anthropic(&tool.input_schema)
                } else {
                    tool.input_schema.clone()
                },
            ),
        ]),
        None,
        cache_options(request, tool.cache.as_ref()),
    )
}

struct Parser {
    tools: BTreeMap<LosslessString, LosslessString>,
    cursor: bool,
    google: bool,
    unreported: bool,
    started: bool,
    ended: bool,
    failure: Option<Error>,
}

impl StreamParser for Parser {
    fn push(&mut self, event: &JsonValue) -> Result<Vec<Event>, Error> {
        if self.ended || self.failure.is_some() {
            return Err(Error::output(
                "AI SDK emitted a part after stream settlement",
            ));
        }
        let events = self.part(event);
        match events {
            Ok(mut events) => {
                if !self.started {
                    self.started = true;
                    events.insert(0, Event::StepStart { index: 0.0 });
                }
                Ok(events)
            }
            Err(error) => {
                self.failure = Some(error.clone());
                Err(error)
            }
        }
    }

    fn finish(&mut self) -> Result<Vec<Event>, Error> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        if !self.ended {
            return Err(Error::missing_terminal());
        }
        Ok(Vec::new())
    }
}

impl Parser {
    fn part(&mut self, event: &JsonValue) -> Result<Vec<Event>, Error> {
        let kind = get(event, "type")
            .and_then(json::text)
            .ok_or_else(|| Error::output("AI SDK stream part must have a string type"))?;
        let metadata = get(event, "providerMetadata")
            .filter(|value| ProviderMetadata::decode(value).is_ok())
            .cloned();
        let required = |name| required_string(event, kind, name);
        let event = match kind {
            "raw" => {
                if self.google
                    && let Some(error) = google_stream_error(get(event, "rawValue"))
                {
                    return Err(error);
                }
                return Ok(Vec::new());
            }
            "stream-start" | "response-metadata" | "file" | "source" | "tool-approval-request" => {
                return Ok(Vec::new());
            }
            "text-start" | "text-end" | "reasoning-start" | "reasoning-end" => {
                let block = BlockEvent {
                    id: required("id")?,
                    provider_metadata: metadata,
                };
                match kind {
                    "text-start" => Event::TextStart(block),
                    "text-end" => Event::TextEnd(block),
                    "reasoning-start" => Event::ReasoningStart(block),
                    _ => Event::ReasoningEnd(block),
                }
            }
            "text-delta" | "reasoning-delta" => {
                let delta = DeltaEvent {
                    id: required("id")?,
                    text: required("delta")?,
                    provider_metadata: metadata,
                };
                if kind == "text-delta" {
                    Event::TextDelta(delta)
                } else {
                    Event::ReasoningDelta(delta)
                }
            }
            "tool-input-start" => {
                let input = ToolInputEvent {
                    id: required("id")?,
                    name: required("toolName")?,
                    provider_executed: optional_bool(event, kind, "providerExecuted")?,
                    provider_metadata: metadata,
                };
                self.tools.insert(input.id.clone(), input.name.clone());
                Event::ToolInputStart(input)
            }
            "tool-input-delta" | "tool-input-end" => {
                let id = required("id")?;
                let name = self
                    .tools
                    .get(&id)
                    .cloned()
                    .unwrap_or_else(|| "unknown".into());
                if kind == "tool-input-delta" {
                    Event::ToolInputDelta {
                        id,
                        name,
                        text: required("delta")?,
                    }
                } else {
                    Event::ToolInputEnd(ToolInputEvent {
                        id,
                        name,
                        provider_executed: None,
                        provider_metadata: metadata,
                    })
                }
            }
            "tool-call" => {
                let id = required("toolCallId")?;
                let name = required("toolName")?;
                let raw = required("input")?;
                let provider_executed = optional_bool(event, kind, "providerExecuted")?;
                self.tools.insert(id.clone(), name.clone());
                match json::parse_tool_input(&raw) {
                    Ok(input) => Event::ToolCall(ToolCall {
                        id,
                        name,
                        input,
                        provider_executed,
                        provider_metadata: metadata,
                    }),
                    Err(_) if provider_executed != Some(true) => {
                        Event::ToolInputError { id, name, raw }
                    }
                    Err(_) => {
                        return Err(Error::output(format!(
                            "Invalid JSON input for aisdk tool call {}",
                            lossy(&name)
                        )));
                    }
                }
            }
            "tool-result" => {
                let id = required("toolCallId")?;
                let name = required("toolName")?;
                let result = get(event, "result")
                    .filter(|result| !matches!(result, JsonValue::Null))
                    .ok_or_else(|| Error::output("AI SDK tool-result part requires a result"))?;
                let result =
                    tool_result(result, optional_bool(event, kind, "isError")? == Some(true))?;
                self.tools.remove(&id);
                Event::ToolResult(ToolResult {
                    id,
                    name,
                    result,
                    cache: None,
                    provider_executed: Some(true),
                    provider_metadata: metadata,
                    output: None,
                })
            }
            "finish" => {
                let usage = get(event, "usage")
                    .filter(|usage| {
                        matches!(get(usage, "inputTokens"), Some(JsonValue::Object(_)))
                            && matches!(get(usage, "outputTokens"), Some(JsonValue::Object(_)))
                    })
                    .ok_or_else(|| Error::output("AI SDK finish part requires a usage object"))?;
                for (name, keys) in [
                    (
                        "inputTokens",
                        &["total", "noCache", "cacheRead", "cacheWrite"][..],
                    ),
                    ("outputTokens", &["total", "text", "reasoning"][..]),
                ] {
                    for key in keys {
                        if get(usage, name).and_then(|value| get(value, key)).is_some_and(|value| {
                            !matches!(value, JsonValue::Null)
                                && !matches!(value, JsonValue::Number(value) if value.is_finite())
                        }) {
                            return Err(Error::output("AI SDK finish part has a non-numeric token count"));
                        }
                    }
                }
                let reason = get(event, "finishReason")
                    .and_then(|reason| get(reason, "unified"))
                    .and_then(json::text)
                    .ok_or_else(|| {
                        Error::output("AI SDK finish part requires a unified finish reason")
                    })?;
                let reason = match reason {
                    "stop" => FinishReason::Stop,
                    "length" => FinishReason::Length,
                    "tool-calls" => FinishReason::ToolCalls,
                    "content-filter" => FinishReason::ContentFilter,
                    "error" => FinishReason::Error,
                    "other" => FinishReason::Unknown,
                    _ => {
                        return Err(Error::output(format!(
                            "AI SDK finish part has unsupported finish reason {reason}"
                        )));
                    }
                };
                let finish = Finish {
                    reason,
                    usage: if self.cursor {
                        cursor_usage(usage, metadata.as_ref())
                    } else {
                        token_usage(usage, metadata.as_ref(), self.unreported)
                    },
                    provider_metadata: metadata,
                };
                self.ended = true;
                return Ok(vec![
                    Event::StepFinish {
                        index: 0.0,
                        finish: finish.clone(),
                    },
                    Event::Finish(finish),
                ]);
            }
            "error" => {
                return Err(stream_error(
                    get(event, "error").unwrap_or(&JsonValue::Null),
                ));
            }
            _ => {
                return Err(Error::output(format!(
                    "Unsupported AI SDK stream part {kind}"
                )));
            }
        };
        Ok(vec![event])
    }
}

fn required_string(event: &JsonValue, kind: &str, name: &str) -> Result<LosslessString, Error> {
    get(event, name)
        .and_then(json::string)
        .cloned()
        .ok_or_else(|| Error::output(format!("AI SDK {kind} part requires string field {name}")))
}

fn optional_bool(event: &JsonValue, kind: &str, name: &str) -> Result<Option<bool>, Error> {
    get(event, name)
        .map(|value| {
            json::boolean(value).ok_or_else(|| {
                Error::output(format!("AI SDK {kind} part requires boolean field {name}"))
            })
        })
        .transpose()
}

fn tool_result(result: &JsonValue, error: bool) -> Result<ToolResultValue, Error> {
    if let Some(value) = get(result, "value") {
        match get(result, "type").and_then(json::text) {
            Some("text") => return Ok(ToolResultValue::Text(value.clone())),
            Some("json") => return Ok(ToolResultValue::Json(value.clone())),
            Some("error") => return Ok(ToolResultValue::Error(value.clone())),
            Some("content") => {
                return Vec::<ToolContent>::decode(value)
                    .map(ToolResultValue::Content)
                    .map_err(|_| Error::output("AI SDK tool result content is invalid"));
            }
            _ => {}
        }
    }
    Ok(if error {
        ToolResultValue::Error(result.clone())
    } else {
        ToolResultValue::Json(result.clone())
    })
}

fn token_usage(input: &JsonValue, metadata: Option<&JsonValue>, unreported: bool) -> Option<Usage> {
    let count = |section, key| {
        get(input, section)
            .and_then(|value| get(value, key))
            .and_then(json::number)
    };
    let mut usage = normalize_input_usage(
        count("inputTokens", "total"),
        count("inputTokens", "noCache"),
        count("inputTokens", "cacheRead"),
        count("inputTokens", "cacheWrite"),
        InputUsageSemantics::AiSdk,
    );
    usage.output_tokens = count("outputTokens", "total");
    usage.reasoning_tokens = count("outputTokens", "reasoning");
    usage.output_may_include_unreported_reasoning =
        (unreported && usage.reasoning_tokens.is_none()).then_some(true);
    usage.total_tokens = usage
        .input_tokens
        .zip(usage.output_tokens)
        .map(|(input, output)| input + output);
    if let Some(creation) = metadata
        .and_then(|value| get(value, "anthropic"))
        .and_then(|value| get(value, "usage"))
        .and_then(|value| get(value, "cache_creation"))
    {
        let creation = ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"]
            .into_iter()
            .filter_map(|key| {
                get(creation, key)
                    .and_then(json::number)
                    .filter(|count| count.is_finite() && *count >= 0.0)
                    .map(|count| (key, JsonValue::Number(count)))
            })
            .collect::<Vec<_>>();
        if !creation.is_empty() {
            usage.provider_metadata = Some(json::object([(
                "anthropic",
                json::object([("cache_creation", json::object(creation))]),
            )]));
        }
    }
    (usage != Usage::default()).then_some(usage)
}

fn cursor_usage(input: &JsonValue, metadata: Option<&JsonValue>) -> Option<Usage> {
    let cursor = metadata.and_then(|value| get(value, "cursor"))?;
    let context = get(cursor, "context");
    let input_tokens = context
        .filter(|context| get(context, "stale").and_then(json::boolean) != Some(true))
        .and_then(|context| get(context, "usedTokens"))
        .and_then(non_negative_count)
        .filter(|count| *count > 0.0);
    let output_tokens = (get(cursor, "occupancyOnly").and_then(json::boolean) != Some(true))
        .then(|| {
            get(cursor, "outputTokensRaw")
                .and_then(non_negative_count)
                .filter(|count| *count > 0.0)
        })
        .flatten();
    if input_tokens.is_none() && output_tokens.is_none() {
        return None;
    }
    let mut usage = Usage {
        input_tokens,
        output_tokens,
        non_cached_input_tokens: input_tokens,
        reasoning_tokens: output_tokens
            .and_then(|_| get(cursor, "reasoningTokensRaw").and_then(non_negative_count)),
        total_tokens: input_tokens
            .zip(output_tokens)
            .map(|(input, output)| input + output),
        ..Default::default()
    };
    if let Some(occupancy) = input_tokens {
        let count = |key| {
            get(input, "inputTokens")
                .and_then(|value| get(value, key))
                .and_then(non_negative_count)
        };
        let read = count("cacheRead");
        let write = count("cacheWrite");
        let parts = if read.is_some() || write.is_some() {
            Some((
                count("noCache").unwrap_or(0.0),
                read.unwrap_or(0.0),
                write.unwrap_or(0.0),
            ))
        } else {
            get(cursor, "inputTokensRaw")
                .and_then(non_negative_count)
                .zip(get(cursor, "cacheReadRaw").and_then(non_negative_count))
                .zip(get(cursor, "cacheWriteRaw").and_then(non_negative_count))
                .map(|((input, read), write)| {
                    let read = read.min(input);
                    let write = write.min(input - read);
                    (input - read - write, read, write)
                })
        };
        if let Some((uncached, read, write)) = parts {
            let basis = uncached + read + write;
            let (read, write) = if basis <= 0.0 {
                (0.0, 0.0)
            } else if read + write <= occupancy && basis <= occupancy + 1.0 {
                (read.min(occupancy), write.min(occupancy - read))
            } else {
                let read = (occupancy * read / basis).round().min(occupancy);
                (
                    read,
                    (occupancy * write / basis).round().min(occupancy - read),
                )
            };
            usage.cache_read_input_tokens = Some(read);
            usage.cache_write_input_tokens = Some(write);
            usage.non_cached_input_tokens = Some(occupancy - read - write);
        }
    }
    Some(usage)
}

fn non_negative_count(value: &JsonValue) -> Option<f64> {
    json::number(value)
        .filter(|count| count.is_finite() && *count >= 0.0)
        .map(f64::trunc)
}

fn meaningful(value: Option<&JsonValue>) -> Option<String> {
    value
        .and_then(json::text)
        .map(str::trim)
        .filter(|text| {
            !text.is_empty()
                && !["error", "unknown error", "request failed"]
                    .contains(&text.to_lowercase().as_str())
        })
        .map(String::from)
}

fn google_stream_error(value: Option<&JsonValue>) -> Option<Error> {
    let error = value
        .filter(|value| matches!(value, JsonValue::Object(_)))
        .and_then(|value| get(value, "error"))
        .filter(|value| matches!(value, JsonValue::Object(_)))?;
    let code = get(error, "status")
        .and_then(json::text)
        .filter(|code| !code.is_empty())
        .map(String::from);
    let status = get(error, "code")
        .and_then(json::number)
        .filter(|status| status.is_finite() && status.fract() == 0.0 && *status >= 0.0)
        .map(|status| status as u16);
    let message = meaningful(get(error, "message")).unwrap_or_else(|| {
        code.as_ref()
            .map(|code| format!("Provider reported {code}"))
            .unwrap_or_else(|| "Provider stream failed".into())
    });
    Some(classify(Failure {
        message,
        status,
        code,
        ..Default::default()
    }))
}

fn stream_error(error: &JsonValue) -> Error {
    if !matches!(error, JsonValue::Object(_)) {
        return Error::new(Reason::UnknownProvider, lossy(&json::js_string(error)));
    }
    let structured = ["statusCode", "responseBody", "responseHeaders", "url"]
        .iter()
        .any(|key| get(error, key).is_some());
    if !structured {
        let sources = [
            get(error, "error"),
            get(error, "response").and_then(|value| get(value, "error")),
            Some(error),
        ];
        let code = sources
            .iter()
            .filter_map(|source| {
                source
                    .and_then(|source| get(source, "code"))
                    .and_then(json::text)
            })
            .find(|code| !code.is_empty())
            .or_else(|| {
                sources
                    .iter()
                    .filter_map(|source| {
                        source
                            .and_then(|source| get(source, "type"))
                            .and_then(json::text)
                    })
                    .find(|code| !code.is_empty() && *code != "error")
            })
            .map(String::from);
        if code.is_none()
            && get(error, "name")
                .and_then(json::text)
                .is_some_and(|name| name.ends_with("Error"))
        {
            let message = get(error, "message")
                .and_then(json::string)
                .map(lossy)
                .unwrap_or_else(|| "Provider stream failed".into());
            let lower = message.to_lowercase();
            return if [
                "socket closed unexpectedly",
                "socket was closed unexpectedly",
                "connection closed unexpectedly",
                "connection was closed unexpectedly",
                "cannot connect to api",
                "websocket closed with code 1006",
            ]
            .iter()
            .any(|pattern| lower.contains(pattern))
            {
                Error::transport(message, "read")
            } else {
                Error::new(Reason::UnknownProvider, message)
            };
        }
        let message = sources
            .iter()
            .find_map(|source| meaningful(source.and_then(|source| get(source, "message"))))
            .unwrap_or_else(|| {
                code.as_ref()
                    .map(|code| format!("Provider reported {code}"))
                    .unwrap_or_else(|| "Provider stream failed".into())
            });
        let mut failure = classify(Failure {
            message,
            code,
            ..Default::default()
        });
        if failure.reason == Reason::UnknownProvider {
            match failure.code.as_deref() {
                Some("ECONNRESET" | "UND_ERR_SOCKET" | "ConnectionClosed") => {
                    failure.reason = Reason::Transport;
                    failure.transport_kind = Some("read");
                }
                Some("content_filter") => failure.reason = Reason::ContentPolicy,
                _ => {}
            }
        }
        return failure;
    }
    let mut secrets = Vec::new();
    if let Some(value) = get(error, "requestBodyValues") {
        collect_secrets(value, None, &mut secrets);
    }
    if let Some(value) = get(error, "responseHeaders") {
        collect_secrets(value, None, &mut secrets);
    }
    let url = get(error, "url")
        .and_then(json::text)
        .and_then(|url| reqwest::Url::parse(url).ok())
        .map(|mut url| {
            for (key, value) in url.query_pairs() {
                if sensitive(&key) || matches!(key.to_lowercase().as_str(), "key" | "sig") {
                    secrets.push(value.into_owned());
                }
            }
            if !url.username().is_empty() {
                secrets.push(url.username().into());
            }
            if let Some(password) = url.password() {
                secrets.push(password.into());
            }
            let _ = url.set_username("");
            let _ = url.set_password(None);
            let pairs = url
                .query_pairs()
                .map(|(key, value)| {
                    let value = if sensitive(&key)
                        || matches!(key.to_lowercase().as_str(), "key" | "sig")
                    {
                        "<redacted>".into()
                    } else {
                        value.into_owned()
                    };
                    (key.into_owned(), value)
                })
                .collect::<Vec<_>>();
            if url.query().is_some() {
                url.query_pairs_mut().clear().extend_pairs(pairs);
            }
            url.to_string()
        })
        .unwrap_or_else(|| "about:blank".into());
    secrets.retain(|secret| secret.len() >= 4);
    secrets.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
    secrets.dedup();
    let headers = error_headers(get(error, "responseHeaders"), &secrets);
    let status = get(error, "statusCode")
        .and_then(json::number)
        .filter(|status| {
            status.is_finite() && *status >= 100.0 && *status <= 599.0 && status.fract() == 0.0
        })
        .map(|status| status as u16);
    let raw_body = get(error, "responseBody").and_then(json::text);
    let decoded = raw_body.and_then(|body| parse_json(body).ok());
    let nested = decoded.as_ref().and_then(|value| get(value, "error"));
    let code = nested
        .and_then(|value| get(value, "type"))
        .and_then(json::text)
        .or_else(|| {
            nested
                .and_then(|value| get(value, "code"))
                .and_then(json::text)
        })
        .or_else(|| {
            decoded
                .as_ref()
                .and_then(|value| get(value, "code"))
                .and_then(json::text)
        })
        .or_else(|| {
            decoded
                .as_ref()
                .and_then(|value| get(value, "type"))
                .and_then(json::text)
                .filter(|value| *value != "error")
        })
        .map(|code| redact_text(code, &secrets));
    let message = meaningful(nested.and_then(|value| get(value, "message")))
        .or_else(|| meaningful(decoded.as_ref().and_then(|value| get(value, "message"))))
        .or_else(|| meaningful(get(error, "message")))
        .map(|message| redact_text(&message, &secrets))
        .unwrap_or_else(|| {
            code.as_ref()
                .map(|code| format!("Provider reported {code}"))
                .unwrap_or_else(|| {
                    status
                        .map(|status| format!("Provider request failed with HTTP {status}"))
                        .unwrap_or_else(|| "Provider request failed".into())
                })
        });
    let body = raw_body.map(|body| redact_text(body, &secrets));
    let body_truncated = body.as_ref().is_some_and(|body| body.len() > 16_384);
    let body = body.map(|mut body| {
        let mut end = body.len().min(16_384);
        while !body.is_char_boundary(end) {
            end -= 1;
        }
        body.truncate(end);
        body
    });
    let retry = retry_after_ms(
        &headers,
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(i64::MAX as u128) as i64,
    );
    let rate_limit = rate_limit_details(&headers, retry);
    let request_id = [
        "x-request-id",
        "request-id",
        "x-amzn-requestid",
        "x-amz-request-id",
        "x-goog-request-id",
        "cf-ray",
    ]
    .iter()
    .find_map(|name| headers.get(*name).cloned());
    classify(Failure {
        message,
        status,
        code,
        retry_after_ms: retry,
        rate_limit: rate_limit.clone(),
        http: Some(HttpContext {
            method: "POST".into(),
            url,
            request_headers: BTreeMap::new(),
            status,
            response_headers: headers,
            body,
            body_truncated,
            request_id,
            rate_limit,
        }),
        ..Default::default()
    })
}

fn sensitive(name: &str) -> bool {
    route::sensitive(name) || name.to_lowercase().contains("cookie")
}

fn collect_secrets(value: &JsonValue, name: Option<&str>, secrets: &mut Vec<String>) {
    if name.is_some_and(sensitive) {
        if let Some(value) = json::text(value) {
            secrets.push(value.into());
            if let Some(token) = value.strip_prefix("Bearer ") {
                secrets.push(token.into());
            }
        }
        if let JsonValue::Array(values) = value {
            for value in values {
                collect_secrets(value, name, secrets);
            }
        }
        return;
    }
    match value {
        JsonValue::Object(values) => {
            for (name, value) in values.iter() {
                collect_secrets(value, name.as_str(), secrets);
            }
        }
        JsonValue::Array(values) => {
            for value in values {
                collect_secrets(value, None, secrets);
            }
        }
        _ => {}
    }
}

fn error_headers(value: Option<&JsonValue>, secrets: &[String]) -> BTreeMap<String, String> {
    let entries = match value {
        Some(JsonValue::Object(fields)) => fields
            .iter()
            .map(|(key, value)| (lossy(key), value.clone()))
            .collect::<Vec<_>>(),
        Some(JsonValue::Array(values)) => values
            .iter()
            .filter_map(|pair| {
                let pair = json::array(pair)?;
                Some((json::text(pair.first()?)?.to_owned(), pair.get(1)?.clone()))
            })
            .collect(),
        _ => Vec::new(),
    };
    entries
        .into_iter()
        .filter(|(_, value)| !matches!(value, JsonValue::Null))
        .map(|(name, value)| {
            let name = name.to_lowercase();
            let value = if sensitive(&name) {
                "<redacted>".into()
            } else {
                redact_text(&lossy(&json::js_string(&value)), secrets)
            };
            (name, value)
        })
        .collect()
}

fn lossy(value: &LosslessString) -> String {
    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
}

fn redact_text(value: &str, secrets: &[String]) -> String {
    fn redact_value(value: &JsonValue) -> JsonValue {
        match value {
            JsonValue::Object(fields) => json::object(fields.iter().map(|(name, value)| {
                (
                    name.clone(),
                    if name.as_str().is_some_and(sensitive) {
                        s("<redacted>")
                    } else {
                        redact_value(value)
                    },
                )
            })),
            JsonValue::Array(values) => JsonValue::Array(values.iter().map(redact_value).collect()),
            _ => value.clone(),
        }
    }
    let value = parse_json(value)
        .map(|value| stringify_json(&redact_value(&value)))
        .unwrap_or_else(|_| value.into());
    let value = route::redact_with(&value, secrets);
    let bytes = value.as_bytes();
    let mut output = String::new();
    let mut copied = 0;
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_alphabetic()
            || index > 0 && (bytes[index - 1].is_ascii_alphanumeric() || bytes[index - 1] == b'_')
        {
            index += 1;
            continue;
        }
        let start = index;
        while index < bytes.len()
            && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'-' | b'_'))
        {
            index += 1;
        }
        let name = &value[start..index];
        let word_end = index;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        let bearer = name.eq_ignore_ascii_case("bearer") && index > word_end;
        if !bearer {
            if !sensitive(name) || index >= bytes.len() || !matches!(bytes[index], b':' | b'=') {
                continue;
            }
            index += 1;
            while index < bytes.len() && bytes[index].is_ascii_whitespace() {
                index += 1;
            }
        }
        let secret_start = index;
        while index < bytes.len()
            && !bytes[index].is_ascii_whitespace()
            && !matches!(bytes[index], b',' | b'"' | b'\'')
        {
            index += 1;
        }
        if index > secret_start {
            output.push_str(&value[copied..secret_start]);
            output.push_str("<redacted>");
            copied = index;
        }
    }
    output.push_str(&value[copied..]);
    output
}
