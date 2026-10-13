use crate::{
    Error, github_copilot,
    json::{self, get, s},
    llm::{Event, Finish, FinishReason, Part, Request, Role, ToolInputEvent},
    openai_shared::{self, Lifecycle, PendingTool, Tools, join, string},
    route::{Protocol, StreamParser},
};
use std::collections::BTreeSet;
use ycoding_schema::{JsonValue, LosslessString, stringify_json};

pub struct Chat;
impl Protocol for Chat {
    fn id(&self) -> &'static str {
        "github-copilot-chat"
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        let request = github_copilot::resolved(request);
        let options = github_copilot::options(&request);
        let mut body = crate::openai_chat::lower(&request)?;
        let mut messages = Vec::new();
        let mut markers = 0;
        for system in &request.system {
            let mut message =
                json::object([("role", s("system")), ("content", s(system.text.clone()))]);
            mark(&mut message, system.cache.is_some(), &mut markers);
            messages.push(message);
        }
        for message in &request.messages {
            let has_cache = message.content.iter().any(|part| {
                part.cache().is_some()
                    || github_copilot::part_metadata(part)
                        .is_some_and(|value| get(value, "cacheControl").is_some())
            });
            let mut value = match message.role {
                Role::System => json::object([
                    ("role", s("system")),
                    (
                        "content",
                        s(join(
                            message.content.iter().filter_map(|part| {
                                if let Part::Text(part) = part {
                                    Some(part.text.clone())
                                } else {
                                    None
                                }
                            }),
                            "",
                        )),
                    ),
                ]),
                Role::User => {
                    let blocks = message
                        .content
                        .iter()
                        .map(|part| match part {
                            Part::Text(part) => {
                                let mut value = json::object([
                                    ("type", s("text")),
                                    ("text", s(part.text.clone())),
                                ]);
                                extend(
                                    &mut value,
                                    part.provider_metadata
                                        .as_ref()
                                        .and_then(|value| get(value, "copilot")),
                                );
                                Ok(value)
                            }
                            Part::Media(part) => github_copilot::image(part, false),
                            _ => Err(Error::invalid(
                                "Copilot Chat user content must be text or images",
                            )),
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    if let [Part::Text(part)] = message.content.as_slice() {
                        let mut value =
                            json::object([("role", s("user")), ("content", s(part.text.clone()))]);
                        extend(
                            &mut value,
                            github_copilot::part_metadata(&message.content[0]),
                        );
                        value
                    } else {
                        json::object([("role", s("user")), ("content", JsonValue::Array(blocks))])
                    }
                }
                Role::Assistant => {
                    let text = join(
                        message.content.iter().filter_map(|part| {
                            if let Part::Text(part) = part {
                                Some(part.text.clone())
                            } else {
                                None
                            }
                        }),
                        "",
                    );
                    let mut value = json::object([
                        ("role", s("assistant")),
                        (
                            "content",
                            if text.is_empty() {
                                JsonValue::Null
                            } else {
                                s(text)
                            },
                        ),
                    ]);
                    let calls = message
                        .content
                        .iter()
                        .filter_map(|part| {
                            if let Part::ToolCall(call) = part {
                                let mut value = json::object([
                                    ("id", s(call.id.clone())),
                                    ("type", s("function")),
                                    (
                                        "function",
                                        json::object([
                                            ("name", s(call.name.clone())),
                                            ("arguments", s(stringify_json(&call.input))),
                                        ]),
                                    ),
                                ]);
                                extend(&mut value, github_copilot::part_metadata(part));
                                Some(value)
                            } else {
                                None
                            }
                        })
                        .collect::<Vec<_>>();
                    if !calls.is_empty() {
                        json::set(&mut value, "tool_calls", JsonValue::Array(calls));
                    }
                    if let Some(opaque) = message.content.iter().find_map(|part| {
                        github_copilot::part_metadata(part)
                            .and_then(|value| string(value, "reasoningOpaque"))
                            .filter(|value| !value.is_empty())
                    }) {
                        if let Some(text) = message.content.iter().rev().find_map(|part| {
                            if let Part::Reasoning(part) = part {
                                (!part.text.is_empty()).then_some(&part.text)
                            } else {
                                None
                            }
                        }) {
                            json::set(&mut value, "reasoning_text", s(text.clone()));
                        }
                        json::set(&mut value, "reasoning_opaque", s(opaque.clone()));
                    }
                    value
                }
                Role::Tool => {
                    if has_cache && markers < 4 {
                        markers += 1;
                    }
                    for part in &message.content {
                        let Part::ToolResult(result) = part else {
                            return Err(Error::invalid(
                                "Copilot Chat tool content must be tool results",
                            ));
                        };
                        let mut value = json::object([
                            ("role", s("tool")),
                            ("tool_call_id", s(result.id.clone())),
                            ("content", s(result.result.to_text())),
                        ]);
                        extend(&mut value, github_copilot::part_metadata(part));
                        mark(
                            &mut value,
                            part.cache().is_some()
                                || github_copilot::part_metadata(part)
                                    .is_some_and(|value| get(value, "cacheControl").is_some()),
                            &mut markers,
                        );
                        messages.push(value);
                    }
                    continue;
                }
            };
            extend(
                &mut value,
                message
                    .native
                    .as_ref()
                    .and_then(|value| get(value, "copilot")),
            );
            mark(&mut value, has_cache, &mut markers);
            messages.push(value);
        }
        json::set(&mut body, "messages", JsonValue::Array(messages));
        body = json::remove(&body, &["stream_options"]);
        if request.tools.is_empty() {
            body = json::remove(&body, &["tool_choice"]);
        }
        if let Some(JsonValue::Array(tools)) = get(&body, "tools") {
            let tools = tools
                .iter()
                .zip(&request.tools)
                .map(|(value, tool)| {
                    let mut value = value.clone();
                    if let Some(function) = get(&value, "function") {
                        let mut function = function.clone();
                        json::set(&mut function, "parameters", tool.input_schema.clone());
                        json::set(&mut value, "function", function);
                    }
                    value
                })
                .collect();
            json::set(&mut body, "tools", JsonValue::Array(tools));
        }
        for (key, wire) in [
            ("user", "user"),
            ("reasoningEffort", "reasoning_effort"),
            ("textVerbosity", "verbosity"),
            ("thinking_budget", "thinking_budget"),
        ] {
            if let Some(value) = get(&options, key) {
                json::set(&mut body, wire, value.clone());
            }
        }
        Ok(openai_shared::pick(
            &body,
            &[
                "model",
                "user",
                "max_tokens",
                "temperature",
                "top_p",
                "frequency_penalty",
                "presence_penalty",
                "response_format",
                "stop",
                "seed",
                "reasoning_effort",
                "verbosity",
                "messages",
                "tools",
                "tool_choice",
                "thinking_budget",
                "stream",
            ],
        ))
    }
    fn parser(&self, _request: &Request) -> Box<dyn StreamParser> {
        Box::new(Parser::default())
    }
}
fn extend(value: &mut JsonValue, metadata: Option<&JsonValue>) {
    if let Some(JsonValue::Object(fields)) = metadata {
        for (key, field) in fields
            .iter()
            .filter(|(key, _)| key.as_str() != Some("cacheControl"))
        {
            json::set(value, key.clone(), field.clone());
        }
    }
}
fn mark(value: &mut JsonValue, hint: bool, markers: &mut usize) {
    if hint && *markers < 4 {
        *markers += 1;
        json::set(
            value,
            "copilot_cache_control",
            json::object([("type", s("ephemeral"))]),
        );
    }
}

#[derive(Default)]
struct Parser {
    lifecycle: Lifecycle,
    tools: Tools,
    completed: BTreeSet<LosslessString>,
    opaque: Option<LosslessString>,
    usage: Option<crate::llm::Usage>,
    reason: Option<FinishReason>,
    predictions: Option<JsonValue>,
    settled: bool,
}
impl Parser {
    fn metadata(&self) -> Option<JsonValue> {
        self.opaque.as_ref().and_then(|value| {
            github_copilot::metadata(json::object([("reasoningOpaque", s(value.clone()))]))
        })
    }
}
impl StreamParser for Parser {
    fn push(&mut self, event: &JsonValue) -> Result<Vec<Event>, Error> {
        if self.settled {
            return Err(Error::output(
                "Provider emitted an event after the terminal event",
            ));
        }
        if let Some(error) = get(event, "error") {
            return Err(Error::output(
                string(error, "message")
                    .and_then(LosslessString::as_str)
                    .unwrap_or("Copilot stream error"),
            ));
        }
        let choices = get(event, "choices")
            .and_then(json::array)
            .ok_or_else(|| Error::output("Invalid Copilot Chat choices"))?;
        let mut events = Vec::new();
        if let Some(raw) = get(event, "usage").filter(|value| !matches!(value, JsonValue::Null)) {
            let previous = self.usage.take();
            let mut usage = openai_shared::usage(raw, true, false, None);
            usage.cache_write_input_tokens = None;
            if let Some(previous) = previous {
                usage.cache_read_input_tokens = usage
                    .cache_read_input_tokens
                    .or(previous.cache_read_input_tokens);
                usage.reasoning_tokens = usage.reasoning_tokens.or(previous.reasoning_tokens);
            }
            usage.provider_metadata = github_copilot::metadata(raw.clone());
            self.usage = Some(usage);
            if let Some(details) = get(raw, "completion_tokens_details") {
                for (wire, key) in [
                    ("accepted_prediction_tokens", "acceptedPredictionTokens"),
                    ("rejected_prediction_tokens", "rejectedPredictionTokens"),
                ] {
                    if let Some(value) =
                        get(details, wire).filter(|value| !matches!(value, JsonValue::Null))
                    {
                        json::set(
                            self.predictions.get_or_insert_with(json::empty),
                            key,
                            value.clone(),
                        );
                    }
                }
            }
        }
        let Some(choice) = choices.first() else {
            return Ok(events);
        };
        if let Some(reason) = string(choice, "finish_reason") {
            self.reason = Some(match reason.as_str() {
                Some("stop") => FinishReason::Stop,
                Some("length") => FinishReason::Length,
                Some("content_filter") => FinishReason::ContentFilter,
                Some("function_call" | "tool_calls") => FinishReason::ToolCalls,
                _ => FinishReason::Unknown,
            });
        }
        let Some(delta) = get(choice, "delta").filter(|value| !matches!(value, JsonValue::Null))
        else {
            return Ok(events);
        };
        if let Some(opaque) = string(delta, "reasoning_opaque").filter(|value| !value.is_empty()) {
            if self.opaque.is_some() {
                return Err(Error::output(
                    "Multiple reasoning_opaque values received in a single response",
                ));
            }
            self.opaque = Some(opaque.clone());
        }
        if let Some(text) = string(delta, "reasoning_text").filter(|value| !value.is_empty()) {
            self.lifecycle
                .reasoning_delta(&mut events, "reasoning-0".into(), text.clone(), None);
        }
        if let Some(text) = string(delta, "content").filter(|value| !value.is_empty()) {
            let metadata = self.metadata();
            self.lifecycle
                .end(&mut events, &"reasoning-0".into(), true, metadata.clone());
            self.lifecycle
                .text_delta(&mut events, "txt-0".into(), text.clone(), metadata);
        }
        if let Some(tools) = get(delta, "tool_calls").and_then(json::array) {
            let metadata = self.metadata();
            self.lifecycle
                .end(&mut events, &"reasoning-0".into(), true, metadata.clone());
            for tool in tools {
                let index = get(tool, "index")
                    .and_then(json::number)
                    .ok_or_else(|| Error::output("Missing Copilot tool index"))?
                    .to_string()
                    .into();
                if self.completed.contains(&index) {
                    continue;
                }
                let function = get(tool, "function");
                if self.tools.get(&index).is_none() {
                    let id = string(tool, "id")
                        .ok_or_else(|| Error::output("Expected tool id to be a string"))?;
                    let name = function
                        .and_then(|value| string(value, "name"))
                        .ok_or_else(|| {
                            Error::output("Expected tool function.name to be a string")
                        })?;
                    self.lifecycle.start(&mut events);
                    events.push(Event::ToolInputStart(ToolInputEvent {
                        id: id.clone(),
                        name: name.clone(),
                        provider_executed: None,
                        provider_metadata: None,
                    }));
                    self.tools.start(
                        index.clone(),
                        PendingTool {
                            id: id.clone(),
                            name: name.clone(),
                            input: LosslessString::default(),
                            metadata: metadata.clone(),
                        },
                    );
                }
                if let Some(text) = function.and_then(|value| string(value, "arguments")) {
                    events.extend(self.tools.append(&index, text)?);
                }
                if self
                    .tools
                    .get(&index)
                    .is_some_and(|tool| json::parse_tool_input(&tool.input).is_ok())
                {
                    events.extend(self.tools.finish(&index, None));
                    self.completed.insert(index);
                }
            }
        }
        Ok(events)
    }
    fn finish(&mut self) -> Result<Vec<Event>, Error> {
        if self.settled {
            return Ok(Vec::new());
        }
        self.settled = true;
        let mut events = Vec::new();
        self.lifecycle
            .end(&mut events, &"reasoning-0".into(), true, self.metadata());
        events.extend(self.tools.finish_all());
        let mut metadata = self.predictions.clone().unwrap_or_else(json::empty);
        if let Some(opaque) = &self.opaque {
            json::set(&mut metadata, "reasoningOpaque", s(opaque.clone()));
        }
        self.lifecycle.finish(
            &mut events,
            Finish {
                reason: self.reason.ok_or_else(Error::missing_terminal)?,
                usage: self.usage.clone(),
                provider_metadata: github_copilot::metadata(metadata),
            },
        );
        Ok(events)
    }
}
