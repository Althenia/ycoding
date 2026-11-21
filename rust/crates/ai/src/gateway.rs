use crate::{
    Error,
    json::{self, get, s},
    llm::{
        Event, Finish, FinishReason, Model, Part, Request, Role, ToolCall, ToolChoice,
        ToolInputEvent, ToolResult, ToolResultValue, Usage,
    },
    openai_shared::{Lifecycle, PendingTool, Tools},
    providers::Config,
    route::{Protocol, Route, StreamParser},
};
use std::sync::Arc;
use ycoding_schema::{JsonValue, LosslessString, provider};

pub fn model(id: impl Into<LosslessString>, config: Config) -> Model {
    let id = id.into();
    let mut route = Route::openai_chat();
    route.id = "vercel-ai-gateway".into();
    route.provider = provider::Id("gateway".into());
    route.provider_metadata_key = Some("gateway".into());
    route.protocol = Arc::new(Gateway);
    route.endpoint.base_url = config
        .base_url
        .unwrap_or_else(|| "https://ai-gateway.vercel.sh/v3/ai".into());
    route.endpoint.path = "/language-model".into();
    route.endpoint.query = config.query;
    route.auth = config.auth;
    route.defaults = config.defaults;
    route.headers.extend([
        ("ai-gateway-protocol-version".into(), "0.0.1".into()),
        ("ai-gateway-auth-method".into(), "api-key".into()),
        ("ai-language-model-specification-version".into(), "3".into()),
        ("ai-language-model-streaming".into(), "true".into()),
        (
            "ai-language-model-id".into(),
            id.as_str().unwrap_or("").into(),
        ),
    ]);
    route.model(id)
}
struct Gateway;
impl Protocol for Gateway {
    fn id(&self) -> &'static str {
        "gateway-v3"
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        let mut prompt = request
            .system
            .iter()
            .map(|p| {
                let mut message =
                    json::object([("role", s("system")), ("content", s(p.text.clone()))]);
                if let Some(options) = part_options(
                    p.provider_metadata.as_ref(),
                    p.cache.as_ref(),
                    &request.model.id,
                ) {
                    json::set(&mut message, "providerOptions", options);
                }
                message
            })
            .collect::<Vec<_>>();
        for message in &request.messages {
            let role = match message.role {
                Role::System => "system",
                Role::User => "user",
                Role::Assistant => "assistant",
                Role::Tool => "tool",
            };
            let parts = message
                .content
                .iter()
                .map(|part| {
                    let mut value = match part {
                        Part::Text(p) => {
                            json::object([("type", s("text")), ("text", s(p.text.clone()))])
                        }
                        Part::Reasoning(p) => {
                            json::object([("type", s("reasoning")), ("text", s(p.text.clone()))])
                        }
                        Part::Media(p) => {
                            let (mime, data) = crate::media::validate("Gateway", p)?;
                            json::object([
                                ("type", s("file")),
                                ("mediaType", s(mime.clone())),
                                ("data", s(format!("data:{mime};base64,{data}"))),
                            ])
                        }
                        Part::ToolCall(p) => json::object([
                            ("type", s("tool-call")),
                            ("toolCallId", s(p.id.clone())),
                            ("toolName", s(p.name.clone())),
                            ("input", p.input.clone()),
                        ]),
                        Part::ToolResult(p) => json::object([
                            ("type", s("tool-result")),
                            ("toolCallId", s(p.id.clone())),
                            ("toolName", s(p.name.clone())),
                            (
                                "output",
                                json::object([
                                    (
                                        "type",
                                        s(match &p.result {
                                            ToolResultValue::Text(_) => "text",
                                            ToolResultValue::Error(_) => "error-json",
                                            _ => "json",
                                        }),
                                    ),
                                    ("value", p.result.to_json()),
                                ]),
                            ),
                        ]),
                    };
                    let metadata = match part {
                        Part::Text(p) => p.provider_metadata.as_ref(),
                        Part::Reasoning(p) => p.provider_metadata.as_ref(),
                        Part::ToolCall(p) => p.provider_metadata.as_ref(),
                        Part::ToolResult(p) => p.provider_metadata.as_ref(),
                        Part::Media(_) => None,
                    };
                    if let Some(options) = part_options(metadata, part.cache(), &request.model.id) {
                        json::set(&mut value, "providerOptions", options);
                    }
                    if let Part::ToolCall(p) = part
                        && let Some(executed) = p.provider_executed
                    {
                        json::set(&mut value, "providerExecuted", JsonValue::Bool(executed));
                    }
                    Ok(value)
                })
                .collect::<Result<Vec<_>, Error>>()?;
            let content = if message.role == Role::System {
                s(crate::openai_shared::join(
                    message.content.iter().filter_map(|p| {
                        if let Part::Text(p) = p {
                            Some(p.text.clone())
                        } else {
                            None
                        }
                    }),
                    "\n",
                ))
            } else {
                JsonValue::Array(parts)
            };
            prompt.push(json::object([("role", s(role)), ("content", content)]));
        }
        let mut body = json::object([("prompt", JsonValue::Array(prompt))]);
        for (key, value) in [
            ("maxOutputTokens", request.generation.max_tokens),
            ("temperature", request.generation.temperature),
            ("topP", request.generation.top_p),
            ("topK", request.generation.top_k),
            ("frequencyPenalty", request.generation.frequency_penalty),
            ("presencePenalty", request.generation.presence_penalty),
            ("seed", request.generation.seed),
        ] {
            if let Some(value) = value {
                json::set(&mut body, key, JsonValue::Number(value));
            }
        }
        if let Some(stop) = &request.generation.stop {
            json::set(
                &mut body,
                "stopSequences",
                JsonValue::Array(stop.iter().cloned().map(s).collect()),
            );
        }
        if let Some(options) = &request.provider_options {
            json::set(&mut body, "providerOptions", options.clone());
        }
        if !request.tools.is_empty() {
            json::set(
                &mut body,
                "tools",
                JsonValue::Array(
                    request
                        .tools
                        .iter()
                        .map(|tool| {
                            json::object([
                                ("type", s("function")),
                                ("name", s(tool.name.clone())),
                                ("description", s(tool.description.clone())),
                                ("inputSchema", tool.input_schema.clone()),
                            ])
                        })
                        .collect(),
                ),
            );
        }
        if let Some(choice) = &request.tool_choice {
            json::set(
                &mut body,
                "toolChoice",
                match choice {
                    ToolChoice::Auto => json::object([("type", s("auto"))]),
                    ToolChoice::None => json::object([("type", s("none"))]),
                    ToolChoice::Required => json::object([("type", s("required"))]),
                    ToolChoice::Tool(name) => {
                        json::object([("type", s("tool")), ("toolName", s(name.clone()))])
                    }
                },
            );
        }
        if let Some(format) = &request.response_format {
            json::set(
                &mut body,
                "responseFormat",
                match format {
                    crate::llm::ResponseFormat::Text => json::object([("type", s("text"))]),
                    crate::llm::ResponseFormat::Json(schema) => {
                        json::object([("type", s("json")), ("schema", schema.clone())])
                    }
                    _ => {
                        return Err(Error::invalid(
                            "Gateway response format must be text or JSON",
                        ));
                    }
                },
            );
        }
        Ok(body)
    }
    fn parser(&self, _: &Request) -> Box<dyn StreamParser> {
        Box::new(Parser::default())
    }
}
#[derive(Default)]
struct Parser {
    lifecycle: Lifecycle,
    tools: Tools,
    finish: Option<Finish>,
    settled: bool,
    sources: Vec<JsonValue>,
}
impl StreamParser for Parser {
    fn push(&mut self, event: &JsonValue) -> Result<Vec<Event>, Error> {
        if self.finish.is_some() || self.settled {
            return Err(Error::output("Gateway emitted an event after finish"));
        }
        let kind = get(event, "type")
            .and_then(json::text)
            .ok_or_else(|| Error::output("Invalid Gateway stream event"))?;
        let mut events = Vec::new();
        match kind {
            "stream-start" | "response-metadata" => self.lifecycle.start(&mut events),
            "text-start" | "reasoning-start" => {
                let id = required(event, "id")?;
                match kind {
                    "reasoning-start" => self.lifecycle.reasoning_start(
                        &mut events,
                        id,
                        get(event, "providerMetadata").cloned(),
                    ),
                    _ => self.lifecycle.text_delta(
                        &mut events,
                        id,
                        "".into(),
                        get(event, "providerMetadata").cloned(),
                    ),
                }
            }
            "text-delta" | "reasoning-delta" => {
                let id = required(event, "id")?;
                let text = required(event, "delta")?;
                if kind == "reasoning-delta" {
                    self.lifecycle.reasoning_delta(
                        &mut events,
                        id.clone(),
                        text.clone(),
                        get(event, "providerMetadata").cloned(),
                    );
                }
                if kind == "text-delta" {
                    self.lifecycle.text_delta(
                        &mut events,
                        id,
                        text,
                        get(event, "providerMetadata").cloned(),
                    );
                }
            }
            "text-end" | "reasoning-end" => self.lifecycle.end(
                &mut events,
                &required(event, "id")?,
                kind == "reasoning-end",
                get(event, "providerMetadata").cloned(),
            ),
            "tool-input-start" => {
                let id = required(event, "id")?;
                let name = required(event, "toolName")?;
                self.tools.start(
                    id.clone(),
                    PendingTool {
                        id: id.clone(),
                        name: name.clone(),
                        input: "".into(),
                        metadata: get(event, "providerMetadata").cloned(),
                    },
                );
                self.lifecycle.start(&mut events);
                events.push(Event::ToolInputStart(ToolInputEvent {
                    id,
                    name,
                    provider_executed: get(event, "providerExecuted").and_then(json::boolean),
                    provider_metadata: get(event, "providerMetadata").cloned(),
                }));
            }
            "tool-input-delta" => events.extend(
                self.tools
                    .append(&required(event, "id")?, &required(event, "delta")?)?,
            ),
            "tool-input-end" => {
                let id = required(event, "id")?;
                let call = self
                    .tools
                    .get(&id)
                    .ok_or_else(|| Error::output("Gateway tool end without start"))?;
                events.push(Event::ToolInputEnd(ToolInputEvent {
                    id,
                    name: call.name.clone(),
                    provider_executed: None,
                    provider_metadata: call.metadata.clone(),
                }));
            }
            "tool-call" => {
                let id = required(event, "toolCallId")?;
                let input = required(event, "input")?;
                self.tools.0.retain(|(key, _)| key != &id);
                events.push(Event::ToolCall(ToolCall {
                    id,
                    name: required(event, "toolName")?,
                    input: json::parse_tool_input(&input)
                        .map_err(|_| Error::output("Invalid Gateway tool JSON"))?,
                    provider_executed: get(event, "providerExecuted").and_then(json::boolean),
                    provider_metadata: get(event, "providerMetadata").cloned(),
                }));
            }
            "tool-result" => {
                if get(event, "preliminary").and_then(json::boolean) == Some(true) {
                    return Err(Error::output(
                        "Gateway preliminary tool results require an output-replacement contract",
                    ));
                }
                let result = get(event, "result")
                    .filter(|value| !matches!(value, JsonValue::Null))
                    .cloned()
                    .ok_or_else(|| Error::output("Invalid Gateway tool result"))?;
                events.push(Event::ToolResult(ToolResult {
                    id: required(event, "toolCallId")?,
                    name: required(event, "toolName")?,
                    result: if get(event, "isError").and_then(json::boolean) == Some(true) {
                        ToolResultValue::Error(result)
                    } else {
                        ToolResultValue::Json(result)
                    },
                    cache: None,
                    provider_executed: Some(true),
                    provider_metadata: get(event, "providerMetadata").cloned(),
                    output: None,
                }));
            }
            "source" => self.sources.push(event.clone()),
            "finish" => {
                let reason = get(event, "finishReason")
                    .and_then(|v| get(v, "unified"))
                    .and_then(json::text)
                    .ok_or_else(|| Error::output("Invalid Gateway finish reason"))?;
                let reason = match reason {
                    "stop" => FinishReason::Stop,
                    "length" => FinishReason::Length,
                    "tool-calls" => FinishReason::ToolCalls,
                    "content-filter" => FinishReason::ContentFilter,
                    "error" => return Err(Error::output("Gateway generation failed")),
                    "other" => FinishReason::Unknown,
                    _ => return Err(Error::output("Unknown Gateway finish reason")),
                };
                let usage = get(event, "usage").map(|usage| {
                    let input = get(usage, "inputTokens");
                    let output = get(usage, "outputTokens");
                    let input_total = input.and_then(|v| get(v, "total")).and_then(json::number);
                    let output_total = output.and_then(|v| get(v, "total")).and_then(json::number);
                    Usage {
                        output_tokens: output_total,
                        reasoning_tokens: output
                            .and_then(|v| get(v, "reasoning"))
                            .and_then(json::number),
                        total_tokens: crate::route::sum_tokens(&[input_total, output_total]),
                        ..crate::route::normalize_input_usage(
                            input_total,
                            input.and_then(|v| get(v, "noCache")).and_then(json::number),
                            input
                                .and_then(|v| get(v, "cacheRead"))
                                .and_then(json::number),
                            input
                                .and_then(|v| get(v, "cacheWrite"))
                                .and_then(json::number),
                            crate::route::InputUsageSemantics::Inclusive,
                        )
                    }
                });
                self.finish = Some(Finish {
                    reason,
                    usage,
                    provider_metadata: get(event, "providerMetadata").cloned(),
                });
            }
            "raw" => {}
            "error" => return Err(Error::output("Gateway stream reported an error")),
            _ => return Err(Error::output("Unsupported Gateway stream event")),
        }
        Ok(events)
    }
    fn finish(&mut self) -> Result<Vec<Event>, Error> {
        if self.settled {
            return Err(Error::output("Gateway stream already settled"));
        }
        if !self.tools.0.is_empty() {
            return Err(Error::output("Incomplete Gateway tool call"));
        }
        let mut finish = self
            .finish
            .take()
            .ok_or_else(|| Error::output("Gateway stream ended without finish"))?;
        if !self.sources.is_empty() {
            finish.provider_metadata = Some(json::merge(
                finish.provider_metadata.as_ref().unwrap_or(&json::empty()),
                &json::object([(
                    "gateway",
                    json::object([("sources", JsonValue::Array(self.sources.clone()))]),
                )]),
            ));
        }
        self.settled = true;
        let mut events = Vec::new();
        self.lifecycle.finish(&mut events, finish);
        Ok(events)
    }
}
fn required(value: &JsonValue, key: &str) -> Result<LosslessString, Error> {
    get(value, key)
        .and_then(json::string)
        .cloned()
        .ok_or_else(|| Error::output("Invalid Gateway stream field"))
}
fn part_options(
    metadata: Option<&JsonValue>,
    hint: Option<&crate::cache::Hint>,
    model: &LosslessString,
) -> Option<JsonValue> {
    let options = metadata.cloned();
    let provider = model
        .as_str()
        .and_then(|model| model.split_once('/'))
        .map(|(provider, _)| provider);
    let Some(hint) = hint.filter(|_| matches!(provider, Some("anthropic" | "alibaba"))) else {
        return options;
    };
    let mut marker = json::object([("type", s("ephemeral"))]);
    if hint.one_hour() && provider == Some("anthropic") {
        json::set(&mut marker, "ttl", s("1h"));
    }
    Some(json::merge(
        options.as_ref().unwrap_or(&json::empty()),
        &json::object([(
            provider.unwrap_or(""),
            json::object([("cacheControl", marker)]),
        )]),
    ))
}
