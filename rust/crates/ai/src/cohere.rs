use crate::{
    Error,
    json::{self, get, s},
    llm::{
        Event, Finish, FinishReason, MediaData, Model, Part, Request, Role, ToolChoice,
        ToolInputEvent, Usage,
    },
    openai_shared::{Lifecycle, PendingTool, Tools},
    providers::Config,
    route::{Protocol, Route, StreamParser},
};
use std::{collections::BTreeMap, sync::Arc};
use ycoding_schema::{JsonValue, LosslessString, provider, stringify_json};

pub fn model(id: impl Into<LosslessString>, config: Config) -> Model {
    let mut route = Route::openai_chat();
    route.id = "cohere-chat".into();
    route.provider = provider::Id("cohere".into());
    route.provider_metadata_key = Some("cohere".into());
    route.endpoint.base_url = config
        .base_url
        .unwrap_or_else(|| "https://api.cohere.com/v2".into());
    route.endpoint.path = "/chat".into();
    route.endpoint.query = config.query;
    route.protocol = Arc::new(Cohere);
    route.auth = config.auth;
    route.defaults = config.defaults;
    route.model(id)
}
struct Cohere;
impl Protocol for Cohere {
    fn id(&self) -> &'static str {
        "cohere-v2"
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        let mut messages = request
            .system
            .iter()
            .map(|part| json::object([("role", s("system")), ("content", s(part.text.clone()))]))
            .collect::<Vec<_>>();
        let mut documents = Vec::new();
        for message in &request.messages {
            let mut text = LosslessString::default();
            let mut calls = Vec::new();
            for part in &message.content {
                match part {
                    Part::Text(part) => json::concat(&mut text, &part.text),
                    Part::Reasoning(_) => {}
                    Part::Media(part) if message.role == Role::User => {
                        let mime = part.mime.as_str().unwrap_or("");
                        if !mime.starts_with("text/") && mime != "application/json" {
                            return Err(Error::invalid(
                                "Cohere documents require text or application/json media",
                            ));
                        }
                        let content = match &part.data {
                            MediaData::Bytes(data) => String::from_utf8_lossy(data).into_owned(),
                            MediaData::Encoded(data) => {
                                let bytes =
                                    crate::media::decode(data.as_str().ok_or_else(|| {
                                        Error::invalid("Invalid Cohere document")
                                    })?)
                                    .map_err(|_| {
                                        Error::invalid("Invalid Cohere document base64")
                                    })?;
                                String::from_utf8_lossy(&bytes).into_owned()
                            }
                        };
                        let mut data = json::object([("text", s(content))]);
                        if let Some(title) = &part.filename {
                            json::set(&mut data, "title", s(title.clone()));
                        }
                        documents.push(json::object([("data", data)]));
                    }
                    Part::ToolCall(call) if message.role == Role::Assistant => {
                        calls.push(json::object([
                            ("id", s(call.id.clone())),
                            ("type", s("function")),
                            (
                                "function",
                                json::object([
                                    ("name", s(call.name.clone())),
                                    ("arguments", s(stringify_json(&call.input))),
                                ]),
                            ),
                        ]))
                    }
                    Part::ToolResult(result) if message.role == Role::Tool => {
                        messages.push(json::object([
                            ("role", s("tool")),
                            ("tool_call_id", s(result.id.clone())),
                            ("content", s(result.result.to_text())),
                        ]))
                    }
                    _ => return Err(Error::invalid("Unsupported Cohere message content")),
                }
            }
            if message.role == Role::Tool {
                continue;
            }
            let role = match message.role {
                Role::User => "user",
                Role::Assistant => "assistant",
                Role::System => "system",
                Role::Tool => unreachable!(),
            };
            let mut lowered = json::object([("role", s(role))]);
            if calls.is_empty() {
                json::set(&mut lowered, "content", s(text));
            }
            if !calls.is_empty() {
                json::set(&mut lowered, "tool_calls", JsonValue::Array(calls));
            }
            messages.push(lowered);
        }
        let mut body = json::object([
            ("model", s(request.model.id.clone())),
            ("messages", JsonValue::Array(messages)),
            ("stream", JsonValue::Bool(true)),
        ]);
        for (key, value) in [
            ("max_tokens", request.generation.max_tokens),
            ("temperature", request.generation.temperature),
            ("p", request.generation.top_p),
            ("k", request.generation.top_k),
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
                "stop_sequences",
                JsonValue::Array(stop.iter().cloned().map(s).collect()),
            );
        }
        if !documents.is_empty() {
            json::set(&mut body, "documents", JsonValue::Array(documents));
        }
        if !request.tools.is_empty() {
            json::set(&mut body, "tools", JsonValue::Array(request.tools.iter().filter(|tool| !matches!(&request.tool_choice, Some(ToolChoice::Tool(name)) if &tool.name != name)).map(|tool| json::object([("type", s("function")), ("function", json::object([("name", s(tool.name.clone())), ("description", s(tool.description.clone())), ("parameters", tool.input_schema.clone())]))])).collect()));
            match &request.tool_choice {
                Some(ToolChoice::None) => json::set(&mut body, "tool_choice", s("NONE")),
                Some(ToolChoice::Required | ToolChoice::Tool(_)) => {
                    json::set(&mut body, "tool_choice", s("REQUIRED"))
                }
                _ => {}
            }
        }
        if let Some(crate::llm::ResponseFormat::Json(schema)) = &request.response_format {
            json::set(
                &mut body,
                "response_format",
                json::object([("type", s("json_object")), ("json_schema", schema.clone())]),
            );
        }
        if let Some(thinking) = request
            .provider_options
            .as_ref()
            .and_then(|o| get(o, "cohere"))
            .and_then(|o| get(o, "thinking"))
        {
            let mut value = json::object([(
                "type",
                get(thinking, "type")
                    .cloned()
                    .unwrap_or_else(|| s("enabled")),
            )]);
            if let Some(budget) = get(thinking, "tokenBudget") {
                json::set(&mut value, "token_budget", budget.clone());
            }
            json::set(&mut body, "thinking", value);
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
    reasoning: BTreeMap<LosslessString, bool>,
    reason: Option<FinishReason>,
    usage: Option<Usage>,
    settled: bool,
}
impl StreamParser for Parser {
    fn push(&mut self, event: &JsonValue) -> Result<Vec<Event>, Error> {
        if self.settled || self.reason.is_some() {
            return Err(Error::output("Cohere emitted an event after message-end"));
        }
        let kind = get(event, "type")
            .and_then(json::text)
            .ok_or_else(|| Error::output("Invalid Cohere stream event"))?;
        let delta = get(event, "delta");
        let message = delta.and_then(|v| get(v, "message"));
        let key = get(event, "index")
            .map(json::js_string)
            .unwrap_or_else(|| "0".into());
        let mut events = Vec::new();
        match kind {
            "message-start" => self.lifecycle.start(&mut events),
            "content-start" | "content-delta" => {
                let content = message
                    .and_then(|v| get(v, "content"))
                    .ok_or_else(|| Error::output("Missing Cohere content"))?;
                let reasoning = get(content, "thinking").is_some()
                    || get(content, "type").and_then(json::text) == Some("thinking");
                self.reasoning.insert(key.clone(), reasoning);
                let text = get(content, if reasoning { "thinking" } else { "text" })
                    .and_then(json::string)
                    .cloned()
                    .unwrap_or_default();
                if reasoning {
                    self.lifecycle
                        .reasoning_delta(&mut events, key.clone(), text.clone(), None);
                }
                if !reasoning {
                    self.lifecycle.text_delta(&mut events, key, text, None);
                }
            }
            "content-end" => self.lifecycle.end(
                &mut events,
                &key,
                self.reasoning.remove(&key).unwrap_or(false),
                None,
            ),
            "tool-call-start" => {
                let call = message
                    .and_then(|v| get(v, "tool_calls"))
                    .ok_or_else(|| Error::output("Missing Cohere tool call"))?;
                let function = get(call, "function")
                    .ok_or_else(|| Error::output("Missing Cohere tool function"))?;
                let id = required(call, "id")?;
                let name = required(function, "name")?;
                self.lifecycle.start(&mut events);
                self.tools.start(
                    key.clone(),
                    PendingTool {
                        id: id.clone(),
                        name: name.clone(),
                        input: "".into(),
                        metadata: None,
                    },
                );
                events.push(Event::ToolInputStart(ToolInputEvent {
                    id,
                    name,
                    provider_executed: None,
                    provider_metadata: None,
                }));
                if let Some(args) = get(function, "arguments").and_then(json::string) {
                    events.extend(self.tools.append(&key, args)?);
                }
            }
            "tool-call-delta" => {
                let args = message
                    .and_then(|v| get(v, "tool_calls"))
                    .and_then(|v| get(v, "function"))
                    .ok_or_else(|| Error::output("Missing Cohere tool delta"))?;
                events.extend(self.tools.append(&key, &required(args, "arguments")?)?);
            }
            "tool-call-end" => {
                if self.tools.get(&key).is_none() {
                    return Err(Error::output("Missing Cohere tool start"));
                }
                events.extend(self.tools.finish(&key, None));
            }
            "message-end" => {
                let delta = delta.ok_or_else(|| Error::output("Missing Cohere terminal delta"))?;
                self.reason = Some(match get(delta, "finish_reason").and_then(json::text) {
                    Some("COMPLETE" | "STOP_SEQUENCE") => FinishReason::Stop,
                    Some("MAX_TOKENS") => FinishReason::Length,
                    Some("TOOL_CALL") => FinishReason::ToolCalls,
                    Some("ERROR" | "TIMEOUT") => {
                        return Err(Error::output("Cohere generation failed"));
                    }
                    _ => return Err(Error::output("Invalid Cohere finish reason")),
                });
                if let Some(tokens) = get(delta, "usage").and_then(|v| get(v, "tokens")) {
                    let input = get(tokens, "input_tokens").and_then(json::number);
                    let output = get(tokens, "output_tokens").and_then(json::number);
                    self.usage = Some(Usage {
                        input_tokens: input,
                        non_cached_input_tokens: input,
                        output_tokens: output,
                        total_tokens: crate::route::sum_tokens(&[input, output]),
                        ..Default::default()
                    });
                }
            }
            "citation-start" | "citation-end" | "tool-plan-delta" | "debug" => {}
            _ => return Err(Error::output("Unknown Cohere stream event")),
        }
        Ok(events)
    }
    fn finish(&mut self) -> Result<Vec<Event>, Error> {
        if self.settled {
            return Err(Error::output("Cohere stream already settled"));
        }
        if !self.tools.0.is_empty() {
            return Err(Error::output("Incomplete Cohere tool call"));
        }
        let reason = self
            .reason
            .ok_or_else(|| Error::output("Cohere stream ended without message-end"))?;
        self.settled = true;
        let mut events = Vec::new();
        self.lifecycle.finish(
            &mut events,
            Finish {
                reason,
                usage: self.usage.clone(),
                provider_metadata: None,
            },
        );
        Ok(events)
    }
}
fn required(value: &JsonValue, key: &str) -> Result<LosslessString, Error> {
    get(value, key)
        .and_then(json::string)
        .cloned()
        .ok_or_else(|| Error::output("Invalid Cohere stream field"))
}
