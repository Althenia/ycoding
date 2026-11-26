use crate::{
    Error,
    json::{self, get, s},
    llm::{
        Event, Finish, FinishReason, Media, MediaData, Message, Part, Request, Role,
        ToolInputEvent, ToolResultValue,
    },
    openai_options,
    openai_shared::{
        self, Lifecycle, PendingTool, Tools, join, metadata, pick, string, truthy, validate,
    },
    provider_error::{Failure, Reason, classify},
    route::{Protocol, StreamParser},
};
use std::collections::BTreeMap;
use ycoding_schema::{JsonValue, LosslessString, llm::ToolContent, stringify_json};

pub struct OpenAIChat;
impl OpenAIChat {
    pub fn parser(_request: &Request) -> Parser {
        Parser::default()
    }
}
impl Protocol for OpenAIChat {
    fn response_formats(&self) -> &'static [&'static str] {
        &["json"]
    }
    fn id(&self) -> &'static str {
        "openai-chat"
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        lower(request)
    }
    fn parser(&self, request: &Request) -> Box<dyn StreamParser> {
        Box::new(Self::parser(request))
    }
}
fn text_block(part: &crate::llm::TextPart, marked: bool) -> JsonValue {
    let mut value = json::object([("type", s("text")), ("text", s(part.text.clone()))]);
    if marked && part.cache.is_some() {
        json::set(
            &mut value,
            "prompt_cache_breakpoint",
            json::object([("mode", s("explicit"))]),
        );
    }
    value
}
fn media(part: &Media) -> JsonValue {
    match crate::media::validate("OpenAI Chat", part) {
        Ok((mime, data)) => json::object([
            ("type", s("image_url")),
            (
                "image_url",
                json::object([("url", s(format!("data:{mime};base64,{data}")))]),
            ),
        ]),
        Err(error) => json::object([
            ("type", s("text")),
            ("text", s(crate::media::notice(part, &error))),
        ]),
    }
}
fn assistant(message: &Message, marked: bool) -> Result<JsonValue, Error> {
    let mut text = Vec::new();
    let mut reasoning = Vec::new();
    let mut calls = Vec::new();
    for part in &message.content {
        match part {
            Part::Text(part) => text.push(part),
            Part::Reasoning(part) => reasoning.push(part),
            Part::ToolCall(call) => calls.push(json::object([
                ("id", s(call.id.clone())),
                ("type", s("function")),
                (
                    "function",
                    json::object([
                        ("name", s(call.name.clone())),
                        ("arguments", s(stringify_json(&call.input))),
                    ]),
                ),
            ])),
            _ => {
                return Err(Error::invalid(
                    "OpenAI Chat assistant messages only support text, reasoning, and tool-call content for now",
                ));
            }
        }
    }
    let content = if text.is_empty() {
        JsonValue::Null
    } else if marked && text.iter().any(|part| part.cache.is_some()) {
        JsonValue::Array(text.iter().map(|part| text_block(part, marked)).collect())
    } else {
        s(join(text.iter().map(|part| part.text.clone()), "\n"))
    };
    let mut result = json::object([("role", s("assistant")), ("content", content)]);
    if !calls.is_empty() {
        json::set(&mut result, "tool_calls", JsonValue::Array(calls));
    }
    let native = message
        .native
        .as_ref()
        .and_then(|value| get(value, "openaiCompatible"));
    let native_reasoning = native.and_then(|value| {
        ["reasoning_content", "reasoning", "thought", "thinking"]
            .into_iter()
            .find_map(|field| string(value, field))
    });
    let observed = reasoning.iter().find_map(|part| {
        part.provider_metadata
            .as_ref()
            .and_then(|value| get(value, "openai"))
            .and_then(|value| string(value, "reasoningField"))
            .and_then(LosslessString::as_str)
            .filter(|field| {
                matches!(
                    *field,
                    "reasoning" | "reasoning_content" | "reasoning_text" | "thought" | "thinking"
                )
            })
    });
    let details: Vec<_> = reasoning
        .iter()
        .filter_map(|part| {
            part.provider_metadata
                .as_ref()
                .and_then(|value| get(value, "openai"))
                .and_then(|value| get(value, "reasoningDetails"))
                .and_then(json::array)
        })
        .collect();
    let field = if reasoning.is_empty() {
        None
    } else {
        observed.or_else(|| {
            if native_reasoning.is_some() || details.len() != reasoning.len() {
                Some("reasoning_content")
            } else {
                None
            }
        })
    };
    if let Some(field) = field {
        json::set(
            &mut result,
            field,
            s(join(reasoning.iter().map(|part| part.text.clone()), "")),
        );
    } else if reasoning.is_empty()
        && let Some(value) = native_reasoning
    {
        json::set(&mut result, "reasoning_content", s(value.clone()));
    }
    if !details.is_empty() {
        json::set(
            &mut result,
            "reasoning_details",
            JsonValue::Array(details.into_iter().flatten().cloned().collect()),
        );
    } else if let Some(details) = native
        .and_then(|value| get(value, "reasoning_details"))
        .filter(|value| matches!(value, JsonValue::Array(_)))
    {
        json::set(&mut result, "reasoning_details", details.clone());
    }
    Ok(pick(
        &result,
        &[
            "role",
            "content",
            "tool_calls",
            "reasoning_content",
            "reasoning",
            "reasoning_text",
            "reasoning_details",
            "thought",
            "thinking",
        ],
    ))
}
pub fn lower(request: &Request) -> Result<JsonValue, Error> {
    let marked = openai_options::breakpoints(request);
    let mut messages = Vec::new();
    let mut images = Vec::new();
    if !request.system.is_empty() {
        let text = join(request.system.iter().map(|part| part.text.clone()), "\n");
        let content = if marked && request.system.iter().any(|part| part.cache.is_some()) {
            JsonValue::Array(vec![json::object([
                ("type", s("text")),
                ("text", s(text)),
                (
                    "prompt_cache_breakpoint",
                    json::object([("mode", s("explicit"))]),
                ),
            ])])
        } else {
            s(text)
        };
        messages.push(json::object([("role", s("system")), ("content", content)]));
    }
    for message in &request.messages {
        if let Some(effort) = crate::effort::update(message, crate::effort::Provider::OpenAI) {
            if crate::effort::mechanism(request) != Some(crate::effort::Provider::OpenAI)
                || !crate::effort::openrouter_endpoint(&request.model.route.endpoint.base_url)
                || message.role != Role::System
                || !message.content.is_empty()
            {
                return Err(Error::invalid(
                    "OpenAI Chat effort update requires a supported OpenRouter endpoint and model",
                ));
            }
            if !images.is_empty() {
                messages.push(json::object([
                    ("role", s("user")),
                    ("content", JsonValue::Array(std::mem::take(&mut images))),
                ]));
            }
            messages.push(json::object([
                ("role", s("system")),
                ("content", s("")),
                (
                    "configuration_update",
                    json::object([("reasoning", json::object([("effort", s(effort))]))]),
                ),
            ]));
            continue;
        }
        if message.role == Role::System {
            if request.model.route.id == "github-copilot-chat"
                && openai_options::gpt56(&request.model.id)
            {
                if !images.is_empty() {
                    messages.push(json::object([
                        ("role", s("user")),
                        ("content", JsonValue::Array(std::mem::take(&mut images))),
                    ]));
                }
                let text = message
                    .content
                    .iter()
                    .map(|part| {
                        if let Part::Text(part) = part {
                            Ok(part.text.clone())
                        } else {
                            Err(Error::invalid(
                                "OpenAI Chat system messages only support text content for now",
                            ))
                        }
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                messages.push(json::object([
                    ("role", s("system")),
                    ("content", s(join(text, "\n"))),
                ]));
                continue;
            }
            let text = openai_shared::wrapped_system(message, "OpenAI Chat")?;
            if !images.is_empty() {
                if !message.volatile {
                    images.push(json::object([
                        ("type", s("text")),
                        ("text", s(text.clone())),
                    ]));
                }
                messages.push(json::object([
                    ("role", s("user")),
                    ("content", JsonValue::Array(std::mem::take(&mut images))),
                ]));
                if !message.volatile {
                    continue;
                }
            }
            if !message.volatile
                && let Some(previous) = messages.last_mut()
                && get(previous, "role").and_then(json::text) == Some("user")
            {
                match get(previous, "content") {
                    Some(JsonValue::String(prior)) => {
                        let combined = join([prior.clone(), text], "\n");
                        json::set(previous, "content", s(combined));
                        continue;
                    }
                    Some(JsonValue::Array(prior)) => {
                        let mut content = prior.clone();
                        content.push(json::object([("type", s("text")), ("text", s(text))]));
                        json::set(previous, "content", JsonValue::Array(content));
                        continue;
                    }
                    _ => {}
                }
            }
            messages.push(json::object([("role", s("user")), ("content", s(text))]));
            continue;
        }
        if message.role == Role::Tool {
            for part in &message.content {
                let Part::ToolResult(part) = part else {
                    return Err(Error::invalid(
                        "OpenAI Chat tool messages only support tool-result content for now",
                    ));
                };
                let text = if let ToolResultValue::Content(content) = &part.result {
                    for item in content {
                        if let ToolContent::File(part) = item {
                            images.push(media(&Media {
                                mime: part.mime.clone(),
                                data: MediaData::Encoded(part.uri.clone()),
                                filename: part.name.clone(),
                            }));
                        }
                    }
                    join(
                        content.iter().filter_map(|part| {
                            if let ToolContent::Text(part) = part {
                                Some(part.text.clone())
                            } else {
                                None
                            }
                        }),
                        "\n",
                    )
                } else {
                    part.result.to_text()
                };
                messages.push(json::object([
                    ("role", s("tool")),
                    ("tool_call_id", s(part.id.clone())),
                    ("content", s(text)),
                ]));
            }
            continue;
        }
        if !images.is_empty() {
            messages.push(json::object([
                ("role", s("user")),
                ("content", JsonValue::Array(std::mem::take(&mut images))),
            ]));
        }
        if message.role == Role::Assistant {
            messages.push(assistant(message, marked)?);
            continue;
        }
        let blocks = message
            .content
            .iter()
            .map(|part| match part {
                Part::Text(part) => Ok(text_block(part, marked)),
                Part::Media(part) => Ok(media(part)),
                _ => Err(Error::invalid(
                    "OpenAI Chat user messages only support text and media content for now",
                )),
            })
            .collect::<Result<Vec<_>, _>>()?;
        let content = if blocks.iter().all(|block| {
            get(block, "type").and_then(json::text) == Some("text")
                && get(block, "prompt_cache_breakpoint").is_none()
        }) {
            s(join(
                blocks
                    .iter()
                    .filter_map(|part| string(part, "text").cloned()),
                "",
            ))
        } else {
            JsonValue::Array(blocks)
        };
        messages.push(json::object([("role", s("user")), ("content", content)]));
    }
    if !images.is_empty() {
        messages.push(json::object([
            ("role", s("user")),
            ("content", JsonValue::Array(images)),
        ]));
    }
    let mut body = json::object([
        ("model", s(request.model.id.clone())),
        ("messages", JsonValue::Array(messages)),
    ]);
    if !request.tools.is_empty() {
        let tools = request
            .tools
            .iter()
            .map(|tool| {
                json::object([
                    ("type", s("function")),
                    (
                        "function",
                        json::object([
                            ("name", s(tool.name.clone())),
                            ("description", s(tool.description.clone())),
                            (
                                "parameters",
                                crate::tool_schema::openai(
                                    &crate::tool_schema::model_compatibility(
                                        &tool.input_schema,
                                        request.model.tool_schema,
                                    ),
                                ),
                            ),
                        ]),
                    ),
                ])
            })
            .collect();
        json::set(&mut body, "tools", JsonValue::Array(tools));
    }
    if let Some(choice) = &request.tool_choice {
        json::set(
            &mut body,
            "tool_choice",
            super::openai_responses::tool_choice(choice, false, &request.tools)?,
        );
    }
    json::set(&mut body, "stream", JsonValue::Bool(true));
    if request
        .provider_options
        .as_ref()
        .and_then(|options| get(options, "openai-compatible"))
        .and_then(|options| get(options, "includeUsage"))
        .and_then(json::boolean)
        .unwrap_or(true)
    {
        json::set(
            &mut body,
            "stream_options",
            json::object([("include_usage", JsonValue::Bool(true))]),
        );
    }
    for (key, value) in [
        ("max_tokens", request.generation.max_tokens),
        ("temperature", request.generation.temperature),
        ("top_p", request.generation.top_p),
        ("frequency_penalty", request.generation.frequency_penalty),
        ("presence_penalty", request.generation.presence_penalty),
        ("seed", request.generation.seed),
    ] {
        if let Some(value) = value {
            json::set(&mut body, key, JsonValue::Number(value));
        }
    }
    if let Some(stop) = &request.generation.stop {
        json::set(
            &mut body,
            "stop",
            JsonValue::Array(stop.iter().cloned().map(s).collect()),
        );
    }
    if let Some(schema) = crate::structured_output::request_schema(request) {
        json::set(
            &mut body,
            "response_format",
            json::object([
                ("type", s("json_schema")),
                (
                    "json_schema",
                    json::object([
                        ("name", s("response")),
                        ("schema", schema),
                        ("strict", JsonValue::Bool(true)),
                    ]),
                ),
            ]),
        );
    }
    Ok(pick(
        &json::merge(&body, &openai_options::lower(request, false)),
        &[
            "model",
            "messages",
            "tools",
            "tool_choice",
            "stream",
            "stream_options",
            "store",
            "prompt_cache_key",
            "prompt_cache_retention",
            "prompt_cache_options",
            "reasoning_effort",
            "thinking",
            "max_tokens",
            "temperature",
            "top_p",
            "frequency_penalty",
            "presence_penalty",
            "seed",
            "stop",
            "response_format",
        ],
    ))
}

#[derive(Default)]
pub struct Parser {
    tools: Tools,
    pending: BTreeMap<
        LosslessString,
        (
            Option<LosslessString>,
            Option<LosslessString>,
            LosslessString,
        ),
    >,
    usage: Option<crate::llm::Usage>,
    reason: Option<FinishReason>,
    lifecycle: Lifecycle,
    reasoning_field: Option<LosslessString>,
    details: Vec<JsonValue>,
    details_observed: bool,
    inside: bool,
    buffer: LosslessString,
    settled: bool,
    refused: bool,
}
impl Parser {
    fn reasoning_metadata(&self, details: bool) -> Option<JsonValue> {
        let mut value = json::empty();
        if let Some(field) = &self.reasoning_field {
            json::set(&mut value, "reasoningField", s(field.clone()));
        }
        if details && self.details_observed {
            json::set(
                &mut value,
                "reasoningDetails",
                JsonValue::Array(self.details.clone()),
            );
        }
        metadata(value)
    }
    fn push_event(&mut self, event: &JsonValue) -> Result<Vec<Event>, Error> {
        if self.settled {
            return Err(Error::output(
                "Provider emitted an event after the terminal event",
            ));
        }
        let choice = get(event, "choices")
            .and_then(json::array)
            .and_then(|values| values.first());
        if let Some(error) = [
            get(event, "error"),
            choice.and_then(|choice| get(choice, "error")),
        ]
        .into_iter()
        .flatten()
        .find(|value| !matches!(value, JsonValue::Null))
        {
            return Err(stream_error(error));
        }
        validate_event(event)?;
        let finish = choice
            .and_then(|choice| string(choice, "finish_reason"))
            .filter(|value| !value.is_empty());
        if finish.and_then(LosslessString::as_str) == Some("error") {
            return Err(Error::new(
                Reason::UnknownProvider,
                "OpenAI Chat reported a stream error",
            ));
        }
        let finish = finish.map(|value| match value.as_str() {
            Some("stop") => FinishReason::Stop,
            Some("length") => FinishReason::Length,
            Some("content_filter") => FinishReason::ContentFilter,
            Some("function_call" | "tool_calls") => FinishReason::ToolCalls,
            _ => FinishReason::Unknown,
        });
        if let (Some(previous), Some(next)) = (self.reason, finish)
            && previous != next
        {
            return Err(Error::output("OpenAI Chat changed its finish reason"));
        }
        let mut events = Vec::new();
        if let Some(raw) = get(event, "usage").filter(|value| !matches!(value, JsonValue::Null)) {
            self.usage = Some(openai_shared::usage(
                raw,
                true,
                false,
                get(event, "cache_discount"),
            ));
        }
        let delta = choice.and_then(|choice| get(choice, "delta"));
        self.refused |= delta
            .and_then(|delta| string(delta, "refusal"))
            .is_some_and(|refusal| !refusal.is_empty());
        let scalar = delta.and_then(|delta| {
            [
                "reasoning_content",
                "reasoning",
                "reasoning_text",
                "thought",
                "thinking",
            ]
            .into_iter()
            .find_map(|field| {
                string(delta, field)
                    .filter(|value| !value.is_empty())
                    .map(|value| (field, value.clone()))
            })
        });
        let text_started = !self.lifecycle.text.is_empty();
        if self.reasoning_field.is_none() && !text_started {
            self.reasoning_field = scalar.as_ref().map(|(field, _)| (*field).into());
        }
        let detail = delta
            .and_then(|delta| get(delta, "reasoning_details"))
            .and_then(json::array);
        if let Some(details) = detail {
            self.details_observed = true;
            for detail in details {
                let previous = self.details.last();
                let conflict = previous.is_some_and(|previous| {
                    ["id", "index", "format"].iter().any(|key| {
                        get(previous, key).is_some_and(|a| {
                            !matches!(a, JsonValue::Null)
                                && get(detail, key)
                                    .is_some_and(|b| !matches!(b, JsonValue::Null) && a != b)
                        })
                    }) || get(previous, "signature").is_some_and(|a| {
                        truthy(a) && get(detail, "signature").is_some_and(|b| truthy(b) && a != b)
                    })
                });
                if let Some(previous) = previous.filter(|previous| {
                    get(previous, "type").and_then(json::text) == Some("reasoning.text")
                        && get(detail, "type").and_then(json::text) == Some("reasoning.text")
                        && !conflict
                }) {
                    let mut merged = json::merge(previous, detail);
                    json::set(
                        &mut merged,
                        "text",
                        s(join(
                            [
                                string(previous, "text").cloned().unwrap_or_default(),
                                string(detail, "text").cloned().unwrap_or_default(),
                            ],
                            "",
                        )),
                    );
                    for key in ["signature", "format"] {
                        let merged_value = get(previous, key)
                            .filter(|value| truthy(value))
                            .or_else(|| get(detail, key).filter(|value| truthy(value)))
                            .or_else(|| get(previous, key))
                            .or_else(|| get(detail, key));
                        if let Some(value) = merged_value {
                            json::set(&mut merged, key, value.clone());
                        }
                    }
                    let index = self.details.len() - 1;
                    self.details[index] = merged;
                } else {
                    self.details.push(detail.clone());
                }
            }
        }
        let detail_text = detail
            .map(|details| {
                join(
                    details.iter().filter_map(|detail| {
                        ["text", "summary", "thought", "thinking"]
                            .into_iter()
                            .find_map(|field| {
                                string(detail, field)
                                    .filter(|value| !value.is_empty())
                                    .cloned()
                            })
                    }),
                    "",
                )
            })
            .filter(|text| !text.is_empty());
        let reasoning = match (detail_text, scalar.as_ref().map(|(_, text)| text.clone())) {
            (Some(a), Some(b)) => {
                if a == b {
                    Some(a)
                } else if json::contains(&a, &b) || json::contains(&b, &a) {
                    Some(if a.len() >= b.len() { a } else { b })
                } else {
                    Some(join([a, b], "\n\n"))
                }
            }
            (a, b) => a.or(b),
        };
        let metadata = self.reasoning_metadata(false);
        let tool_deltas = delta
            .and_then(|delta| get(delta, "tool_calls"))
            .and_then(json::array)
            .unwrap_or(&[]);
        if self.reason.is_some() && !tool_deltas.is_empty() {
            return Err(Error::output(
                "OpenAI Chat emitted tool arguments after its finish reason",
            ));
        }
        if !text_started && let Some(text) = reasoning {
            self.lifecycle.reasoning_delta(
                &mut events,
                "reasoning-0".into(),
                text,
                metadata.clone(),
            );
        } else if self.details_observed
            && self.lifecycle.reasoning.is_empty()
            && (delta
                .and_then(|delta| string(delta, "content"))
                .is_some_and(|value| !value.is_empty())
                || !tool_deltas.is_empty())
        {
            self.lifecycle
                .reasoning_start(&mut events, "reasoning-0".into(), metadata.clone());
        }
        if let Some(text) = delta.and_then(|delta| string(delta, "content")) {
            json::concat(&mut self.buffer, text);
            let (text, reasoning) = parse_think(&mut self.buffer, &mut self.inside);
            if !reasoning.is_empty() {
                self.lifecycle.reasoning_delta(
                    &mut events,
                    "reasoning-0".into(),
                    reasoning,
                    metadata,
                );
            }
            if !text.is_empty() {
                self.lifecycle
                    .text_delta(&mut events, "text-0".into(), text, None);
            }
        }
        for delta in tool_deltas {
            let key = get(delta, "index")
                .and_then(json::number)
                .unwrap_or(0.0)
                .to_string()
                .into();
            let current = self.tools.get(&key);
            let pending = self.pending.remove(&key);
            let function = get(delta, "function");
            let id = current
                .map(|tool| tool.id.clone())
                .or_else(|| pending.as_ref().and_then(|(id, _, _)| id.clone()))
                .or_else(|| {
                    string(delta, "id")
                        .filter(|value| !value.is_empty())
                        .cloned()
                });
            let name = current
                .map(|tool| tool.name.clone())
                .or_else(|| pending.as_ref().and_then(|(_, name, _)| name.clone()))
                .or_else(|| {
                    function
                        .and_then(|value| string(value, "name"))
                        .filter(|value| !value.is_empty())
                        .cloned()
                });
            let text = join(
                [
                    pending
                        .as_ref()
                        .map(|(_, _, text)| text.clone())
                        .unwrap_or_default(),
                    function
                        .and_then(|value| string(value, "arguments"))
                        .cloned()
                        .unwrap_or_default(),
                ],
                "",
            );
            let (Some(id), Some(name)) = (id.clone(), name.clone()) else {
                self.pending.insert(key, (id, name, text));
                continue;
            };
            if current.is_none() {
                self.lifecycle.start(&mut events);
                events.push(Event::ToolInputStart(ToolInputEvent {
                    id: id.clone(),
                    name: name.clone(),
                    provider_executed: None,
                    provider_metadata: None,
                }));
                self.tools.start(
                    key.clone(),
                    PendingTool {
                        id,
                        name,
                        input: LosslessString::default(),
                        metadata: None,
                    },
                );
            }
            let deltas = self.tools.append(&key, &text)?;
            if !deltas.is_empty() {
                self.lifecycle.start(&mut events);
            }
            events.extend(deltas);
        }
        self.reason = self.reason.or(finish);
        Ok(events)
    }
}
impl StreamParser for Parser {
    fn push(&mut self, event: &JsonValue) -> Result<Vec<Event>, Error> {
        self.push_event(event).inspect_err(|_| self.settled = true)
    }
    fn reported_usage(&self) -> Option<crate::llm::Usage> {
        self.usage.clone()
    }
    fn finish(&mut self) -> Result<Vec<Event>, Error> {
        if self.settled {
            return Ok(Vec::new());
        }
        self.settled = true;
        let mut reason = self.reason.ok_or_else(Error::missing_terminal)?;
        if self.refused {
            reason = FinishReason::ContentFilter;
        }
        let calls = if matches!(reason, FinishReason::Stop | FinishReason::ToolCalls) {
            if !self.pending.is_empty() {
                return Err(Error::output(
                    "OpenAI Chat tool call delta is missing id or name",
                ));
            }
            self.tools.finish_all()
        } else {
            Vec::new()
        };
        if reason == FinishReason::Stop && !calls.is_empty() {
            reason = FinishReason::ToolCalls;
        }
        let mut events = Vec::new();
        let metadata = self.reasoning_metadata(false);
        let tail = std::mem::take(&mut self.buffer);
        if self.inside && !tail.is_empty() {
            self.lifecycle.reasoning_delta(
                &mut events,
                "reasoning-0".into(),
                tail.clone(),
                metadata.clone(),
            );
        }
        if self.details_observed && self.lifecycle.reasoning.is_empty() {
            self.lifecycle
                .reasoning_start(&mut events, "reasoning-0".into(), metadata);
        }
        let reasoning_emitted = !self.lifecycle.reasoning.is_empty();
        let metadata = self.reasoning_metadata(true);
        self.lifecycle
            .end(&mut events, &"reasoning-0".into(), true, metadata);
        if !self.inside && !tail.is_empty() {
            self.lifecycle
                .text_delta(&mut events, "text-0".into(), tail, None);
        }
        events.extend(calls);
        let mut usage = self.usage.take();
        if reasoning_emitted
            && let Some(usage) = &mut usage
            && usage.reasoning_tokens.is_none()
        {
            usage.output_may_include_unreported_reasoning = Some(true);
        }
        self.lifecycle.finish(
            &mut events,
            Finish {
                reason,
                usage,
                provider_metadata: None,
            },
        );
        Ok(events)
    }
}
fn stream_error(error: &JsonValue) -> Error {
    let Some(message) = string(error, "message").and_then(|message| message.to_utf8().ok()) else {
        return Error::output("Invalid OpenAI Chat stream error");
    };
    let status = get(error, "code")
        .and_then(json::number)
        .filter(|code| code.fract() == 0.0 && (400.0..=599.0).contains(code))
        .map(|code| code as u16);
    let code = get(error, "metadata")
        .and_then(|metadata| string(metadata, "error_type"))
        .or_else(|| string(error, "code"))
        .or_else(|| string(error, "type"))
        .and_then(|code| code.to_utf8().ok());
    let reason = match code.as_deref() {
        Some("content_policy_violation" | "image_content_policy_violation" | "refusal") => {
            Some(Reason::ContentPolicy)
        }
        Some("payment_required") => Some(Reason::QuotaExceeded),
        _ if status == Some(402) => Some(Reason::QuotaExceeded),
        _ => None,
    };
    if let Some(reason) = reason {
        return Error {
            status,
            code,
            ..Error::new(reason, message)
        };
    }
    classify(Failure {
        message,
        status,
        code,
        ..Default::default()
    })
}
fn parse_think(buffer: &mut LosslessString, inside: &mut bool) -> (LosslessString, LosslessString) {
    let mut remaining = buffer.code_units().collect::<Vec<_>>();
    let mut text = Vec::new();
    let mut reasoning = Vec::new();
    loop {
        let marker = if *inside { "</think>" } else { "<think>" }
            .encode_utf16()
            .collect::<Vec<_>>();
        let target = if *inside { &mut reasoning } else { &mut text };
        if let Some(index) = remaining
            .windows(marker.len())
            .position(|value| value == marker)
        {
            target.extend(&remaining[..index]);
            remaining.drain(..index + marker.len());
            *inside = !*inside;
            continue;
        }
        let prefix = (1..marker.len())
            .rev()
            .find(|size| remaining.ends_with(&marker[..*size]))
            .unwrap_or(0);
        target.extend(&remaining[..remaining.len() - prefix]);
        *buffer = LosslessString::from_utf16(remaining[remaining.len() - prefix..].to_vec());
        break;
    }
    (
        LosslessString::from_utf16(text),
        LosslessString::from_utf16(reasoning),
    )
}
fn validate_event(event: &JsonValue) -> Result<(), Error> {
    let valid = validate(event, &[], &[], &[])
        && get(event, "choices")
            .and_then(json::array)
            .is_some_and(|choices| {
                choices.iter().all(|choice| {
                    validate(choice, &[], &["finish_reason"], &[])
                        && get(choice, "delta").is_none_or(|delta| {
                            matches!(delta, JsonValue::Null)
                                || validate(
                                    delta,
                                    &[],
                                    &[
                                        "content",
                                        "reasoning_content",
                                        "reasoning",
                                        "reasoning_text",
                                        "thought",
                                        "thinking",
                                        "refusal",
                                    ],
                                    &[],
                                ) && get(delta, "reasoning_details").is_none_or(|value| {
                                    matches!(value, JsonValue::Null | JsonValue::Array(_))
                                }) && get(delta, "tool_calls").is_none_or(|value| {
                                    matches!(value, JsonValue::Null)
                                        || json::array(value).is_some_and(|tools| {
                                            tools.iter().all(|tool| {
                                                validate(tool, &[], &["id"], &["index"])
                                                    && get(tool, "index")
                                                        .and_then(json::number)
                                                        .is_some()
                                                    && get(tool, "function").is_none_or(|value| {
                                                        matches!(value, JsonValue::Null)
                                                            || validate(
                                                                value,
                                                                &[],
                                                                &["name", "arguments"],
                                                                &[],
                                                            )
                                                    })
                                            })
                                        })
                                })
                        })
                })
            })
        && get(event, "usage").is_none_or(|usage| {
            matches!(usage, JsonValue::Null)
                || validate(
                    usage,
                    &[],
                    &[],
                    &[
                        "prompt_tokens",
                        "prompt_cache_hit_tokens",
                        "prompt_cache_miss_tokens",
                        "completion_tokens",
                        "total_tokens",
                    ],
                ) && ["prompt_tokens_details", "completion_tokens_details"]
                    .iter()
                    .all(|key| {
                        get(usage, key).is_none_or(|value| {
                            matches!(value, JsonValue::Null)
                                || validate(
                                    value,
                                    &[],
                                    &[],
                                    if *key == "prompt_tokens_details" {
                                        &["cached_tokens", "cache_write_tokens"]
                                    } else {
                                        &["reasoning_tokens"]
                                    },
                                )
                        })
                    })
        })
        && get(event, "cache_discount")
            .is_none_or(|value| matches!(value, JsonValue::Null | JsonValue::Number(_)));
    if valid {
        Ok(())
    } else {
        Err(Error::output("Invalid openai-chat stream event"))
    }
}
