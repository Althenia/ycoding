use crate::{
    Error,
    json::{self, get, s},
    llm::{
        Event, Finish, FinishReason, Media, MediaData, Message, Model, Part, Request,
        ResponseFormat, Role, ToolCall, ToolChoice, ToolResultValue, Usage,
    },
    openai_chat::OpenAIChat,
    openai_shared::{Lifecycle, join, pick, string, truthy, validate, wrapped_system},
    providers::Config,
    route::{
        Endpoint, Executor, InputUsageSemantics, Prepared, Protocol, Route, StreamParser, Tracker,
        Transport, normalize_input_usage,
    },
};
use reqwest::Method;
use std::{sync::Arc, time::Duration};
use ycoding_schema::{JsonValue, LosslessString, llm::ToolContent, provider};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Worker {
    Ollama,
    Vllm,
}
impl Worker {
    fn id(self) -> &'static str {
        match self {
            Self::Ollama => "runpod-ollama",
            Self::Vllm => "runpod-vllm",
        }
    }
}
pub fn model(
    id: impl Into<LosslessString>,
    worker: Worker,
    config: Config,
) -> Result<Model, Error> {
    Ok(route(worker, config)?.model(id))
}
pub fn route(worker: Worker, config: Config) -> Result<Route, Error> {
    let base_url = config
        .base_url
        .ok_or_else(|| Error::invalid("Runpod Serverless requires a baseURL"))?;
    let mut route = Route::openai_chat();
    route.id = worker.id().into();
    route.provider = provider::Id("runpod".into());
    route.provider_metadata_key = None;
    route.protocol = Arc::new(RunPod(worker));
    route.endpoint = Endpoint::new(base_url, "/runsync");
    route.endpoint.query = config.query;
    route.auth = config.auth;
    route.defaults = config.defaults;
    route.transport = Transport::RunPodJobs;
    Ok(route)
}
pub struct RunPod(pub Worker);
impl Protocol for RunPod {
    fn id(&self) -> &'static str {
        self.0.id()
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        if self.0 == Worker::Ollama
            && request
                .tool_choice
                .as_ref()
                .is_some_and(|choice| !matches!(choice, ToolChoice::Auto | ToolChoice::None))
        {
            return Err(Error::invalid(
                "Runpod Ollama supports only automatic or disabled tool choice",
            ));
        }
        if request
            .response_format
            .as_ref()
            .is_some_and(|format| !matches!(format, ResponseFormat::Text))
        {
            return Err(Error::invalid(match self.0 {
                Worker::Ollama => "Runpod Ollama does not support structured response format",
                Worker::Vllm => {
                    "Runpod vLLM chat proxy does not support structured response format"
                }
            }));
        }
        if self.0 == Worker::Vllm {
            return vllm_body(request);
        }
        if request.generation.frequency_penalty.is_some()
            || request.generation.presence_penalty.is_some()
        {
            return Err(Error::invalid(
                "Runpod Ollama does not support frequency or presence penalties",
            ));
        }
        let system = join(request.system.iter().map(|part| part.text.clone()), "\n");
        let mut messages = Vec::new();
        if !system.is_empty() {
            messages.push(json::object([
                ("role", s("system")),
                ("content", s(system)),
            ]));
        }
        messages.extend(
            request
                .messages
                .iter()
                .map(ollama_message)
                .collect::<Result<Vec<_>, _>>()?,
        );
        let mut options = json::empty();
        for (key, value) in [
            ("temperature", request.generation.temperature),
            ("top_p", request.generation.top_p),
            ("num_predict", request.generation.max_tokens),
            ("top_k", request.generation.top_k),
            ("seed", request.generation.seed),
        ] {
            if let Some(value) = value {
                json::set(&mut options, key, JsonValue::Number(value));
            }
        }
        if let Some(stop) = &request.generation.stop {
            json::set(
                &mut options,
                "stop",
                JsonValue::Array(stop.iter().cloned().map(s).collect()),
            );
        }
        let mut input = json::object([
            ("messages", JsonValue::Array(messages)),
            ("stream", JsonValue::Bool(false)),
            ("options", options),
        ]);
        if !request.tools.is_empty() && request.tool_choice != Some(ToolChoice::None) {
            json::set(
                &mut input,
                "tools",
                JsonValue::Array(
                    request
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
                                        ("parameters", tool.input_schema.clone()),
                                    ]),
                                ),
                            ])
                        })
                        .collect(),
                ),
            );
        }
        Ok(json::object([("input", input)]))
    }
    fn parser(&self, request: &Request) -> Box<dyn StreamParser> {
        Box::new(Parser {
            worker: self.0,
            request_id: request.id.clone().map(Ok).unwrap_or_else(|| {
                if self.0 == Worker::Ollama {
                    uuid()
                } else {
                    Ok("".into())
                }
            }),
            settled: false,
        })
    }
}
fn notice(worker: Worker, media: &Media) -> LosslessString {
    crate::media::notice(
        media,
        &Error::invalid(format!("{} supports text only", worker.id())),
    )
    .into()
}
fn content(worker: Worker, content: &[ToolContent]) -> Vec<ToolContent> {
    content
        .iter()
        .map(|item| match item {
            ToolContent::Text(_) => item.clone(),
            ToolContent::File(file) => ToolContent::Text(ycoding_schema::llm::ToolTextContent {
                text: notice(
                    worker,
                    &Media {
                        mime: file.mime.clone(),
                        data: MediaData::Encoded(file.uri.clone()),
                        filename: file.name.clone(),
                    },
                ),
            }),
        })
        .collect()
}
fn ollama_message(message: &Message) -> Result<JsonValue, Error> {
    if message.role == Role::System {
        return Ok(json::object([
            ("role", s("user")),
            ("content", s(wrapped_system(message, "runpod-ollama")?)),
        ]));
    }
    if message.role == Role::Tool {
        let [Part::ToolResult(result)] = message.content.as_slice() else {
            return Err(Error::invalid(
                "Runpod Ollama tool messages require one tool result",
            ));
        };
        let text = match &result.result {
            ToolResultValue::Content(items) => join(
                content(Worker::Ollama, items)
                    .into_iter()
                    .filter_map(|item| {
                        if let ToolContent::Text(text) = item {
                            Some(text.text)
                        } else {
                            None
                        }
                    }),
                "\n",
            ),
            _ => result.result.to_text(),
        };
        return Ok(json::object([("role", s("tool")), ("content", s(text))]));
    }
    let text = message
        .content
        .iter()
        .map(|part| match part {
            Part::Text(text) => Ok(text.text.clone()),
            Part::Media(media) => Ok(notice(Worker::Ollama, media)),
            Part::ToolCall(_) if message.role == Role::Assistant => Ok("".into()),
            _ => Err(Error::invalid(
                "Runpod Ollama supports text and assistant tool calls only",
            )),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut value = json::object([
        (
            "role",
            s(if message.role == Role::Assistant {
                "assistant"
            } else {
                "user"
            }),
        ),
        ("content", s(join(text, ""))),
    ]);
    if message.role == Role::Assistant {
        json::set(
            &mut value,
            "tool_calls",
            JsonValue::Array(
                message
                    .content
                    .iter()
                    .filter_map(|part| {
                        if let Part::ToolCall(call) = part {
                            Some(json::object([(
                                "function",
                                json::object([
                                    ("name", s(call.name.clone())),
                                    ("arguments", call.input.clone()),
                                ]),
                            )]))
                        } else {
                            None
                        }
                    })
                    .collect(),
            ),
        );
    }
    Ok(value)
}
fn vllm_body(request: &Request) -> Result<JsonValue, Error> {
    let mut request = request.clone();
    for message in &mut request.messages {
        for part in &mut message.content {
            if message.role == Role::User
                && let Part::Media(media) = part
            {
                *part = Part::Text(notice(Worker::Vllm, media).into());
            }
            if message.role == Role::Tool
                && let Part::ToolResult(result) = part
                && let ToolResultValue::Content(items) = &mut result.result
            {
                *items = content(Worker::Vllm, items);
            }
        }
    }
    let mut chat = OpenAIChat.lower(&request)?;
    json::set(&mut chat, "stream", JsonValue::Bool(false));
    if let Some(top_k) = request.generation.top_k {
        json::set(&mut chat, "top_k", JsonValue::Number(top_k));
    }
    Ok(json::object([(
        "input",
        json::object([
            ("route", s("/v1/chat/completions")),
            ("method", s("POST")),
            (
                "body",
                pick(
                    &chat,
                    &[
                        "model",
                        "messages",
                        "stream",
                        "tools",
                        "tool_choice",
                        "temperature",
                        "top_p",
                        "top_k",
                        "max_tokens",
                        "seed",
                        "stop",
                        "frequency_penalty",
                        "presence_penalty",
                    ],
                ),
            ),
        ]),
    )]))
}
pub(crate) fn envelope(value: &JsonValue) -> Result<&LosslessString, Error> {
    if !validate(value, &["id", "status"], &[], &[]) {
        return Err(Error::output("Invalid job response"));
    }
    string(value, "status").ok_or_else(|| Error::output("Invalid job response"))
}
fn unfinished(status: &LosslessString) -> bool {
    matches!(status.as_str(), Some("IN_QUEUE" | "IN_PROGRESS"))
}
pub(crate) async fn frames(executor: &Executor, prepared: &Prepared) -> Result<JsonValue, Error> {
    let mut tracker = Tracker::new(prepared, "http-json", executor.observer.clone());
    let response = match executor.execute(prepared).await {
        Ok(response) => response,
        Err(error) => {
            tracker.settle(false, false, None);
            return Err(error);
        }
    };
    let status = response.status().as_u16();
    let text = match response.text().await {
        Ok(text) => text,
        Err(_) => {
            tracker.settle(false, true, Some(status));
            return Err(Error::transport("The HTTP response stream failed", "read"));
        }
    };
    tracker.settle(true, true, Some(status));
    let mut job =
        ycoding_schema::parse_json(&text).map_err(|_| Error::output("Invalid job response"))?;
    if !unfinished(envelope(&job)?) {
        return Ok(job);
    }
    let id = string(&job, "id")
        .filter(|id| !id.is_empty())
        .ok_or_else(|| Error::output("Unfinished job has no id"))?
        .clone();
    let mut url = prepared.url.clone();
    let path = url
        .path()
        .strip_suffix("/runsync")
        .ok_or_else(|| Error::invalid("Invalid Runpod jobs endpoint"))?
        .to_owned();
    url.set_path(&format!(
        "{path}/status/{}",
        crate::bedrock_auth::uri_component(
            id.as_str().ok_or_else(|| Error::output("Invalid job id"))?
        )
    ));
    url.set_query(None);
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let response = executor
            .execute_http(&url, &prepared.headers, Method::GET, Vec::new())
            .await?;
        let text = response
            .text()
            .await
            .map_err(|_| Error::transport("The HTTP response stream failed", "read"))?;
        job =
            ycoding_schema::parse_json(&text).map_err(|_| Error::output("Invalid job response"))?;
        envelope(&job)?;
        if string(&job, "id").is_some_and(|next| next != &id) {
            return Err(Error::output("Status response belongs to another job"));
        }
        if !unfinished(envelope(&job)?) {
            return Ok(job);
        }
    }
}
fn error_message(value: Option<&JsonValue>) -> Option<LosslessString> {
    value
        .and_then(|value| json::string(value).or_else(|| string(value, "message")))
        .cloned()
}
pub struct Parser {
    worker: Worker,
    request_id: Result<LosslessString, Error>,
    settled: bool,
}
impl StreamParser for Parser {
    fn push(&mut self, job: &JsonValue) -> Result<Vec<Event>, Error> {
        if self.settled {
            return Err(Error::output(
                "Provider emitted an event after the terminal event",
            ));
        }
        let status = envelope(job)?;
        if status.as_str() != Some("COMPLETED") {
            self.settled = true;
            return Ok(vec![Event::ProviderError {
                message: error_message(get(job, "error")).unwrap_or_else(|| {
                    let mut message = "Runpod job ".into();
                    json::concat(&mut message, status);
                    message
                }),
                context_overflow: false,
                provider_metadata: None,
            }]);
        }
        let output = match get(job, "output") {
            Some(JsonValue::Array(items)) if items.len() != 1 => {
                return Err(Error::output("Expected one aggregated worker response"));
            }
            Some(JsonValue::Array(items)) => &items[0],
            Some(value) => value,
            None => return Err(Error::output("Missing worker response")),
        };
        if let Some(error) = get(output, "error") {
            self.settled = true;
            return Ok(vec![Event::ProviderError {
                message: error_message(Some(error))
                    .unwrap_or_else(|| "Runpod worker failed".into()),
                context_overflow: false,
                provider_metadata: None,
            }]);
        }
        if !truthy(output) {
            return Err(Error::output("Missing worker response"));
        }
        let (message, reason, usage, calls) = self.response(output)?;
        let mut events = Vec::new();
        let mut lifecycle = Lifecycle::default();
        if let Some(text) = string(message, "content").filter(|text| !text.is_empty()) {
            lifecycle.text_delta(&mut events, "text-0".into(), text.clone(), None);
        }
        lifecycle.end(&mut events, &"text-0".into(), false, None);
        if !calls.is_empty() {
            lifecycle.start(&mut events);
        }
        events.extend(calls.into_iter().map(Event::ToolCall));
        lifecycle.finish(
            &mut events,
            Finish {
                reason,
                usage: Some(usage),
                provider_metadata: None,
            },
        );
        self.settled = true;
        Ok(events)
    }
    fn finish(&mut self) -> Result<Vec<Event>, Error> {
        if self.settled {
            Ok(Vec::new())
        } else {
            Err(Error::missing_terminal())
        }
    }
}
impl Parser {
    fn response<'a>(
        &self,
        output: &'a JsonValue,
    ) -> Result<(&'a JsonValue, FinishReason, Usage, Vec<ToolCall>), Error> {
        let invalid = || {
            Error::output(if self.worker == Worker::Ollama {
                "Invalid Ollama response"
            } else {
                "Invalid vLLM response"
            })
        };
        let choice = if self.worker == Worker::Vllm {
            let choices = get(output, "choices")
                .and_then(json::array)
                .ok_or_else(invalid)?;
            for choice in choices {
                validate_choice(choice).then_some(()).ok_or_else(invalid)?;
            }
            if !validate_usage(get(output, "usage")) {
                return Err(invalid());
            }
            if choices.len() != 1 {
                return Err(Error::output("Expected one vLLM choice"));
            }
            &choices[0]
        } else {
            output
        };
        let message = get(choice, "message").ok_or_else(invalid)?;
        if string(message, "role").and_then(LosslessString::as_str) != Some("assistant") {
            return Err(invalid());
        }
        if self.worker == Worker::Ollama
            && (get(output, "done") != Some(&JsonValue::Bool(true))
                || string(message, "content").is_none()
                || !validate(message, &["thinking"], &[], &[])
                || !validate(
                    output,
                    &["done_reason"],
                    &[],
                    &[
                        "prompt_eval_count",
                        "prompt_eval_cached_count",
                        "prompt_eval_duration",
                        "eval_duration",
                        "load_duration",
                        "eval_count",
                    ],
                ))
        {
            return Err(invalid());
        }
        let reason = string(
            choice,
            if self.worker == Worker::Ollama {
                "done_reason"
            } else {
                "finish_reason"
            },
        )
        .and_then(LosslessString::as_str);
        if self.worker == Worker::Vllm {
            if !matches!(reason, Some("stop" | "length" | "tool_calls")) {
                return Err(Error::output(format!(
                    "Unsupported vLLM finish reason: {}",
                    reason.unwrap_or("")
                )));
            }
            if reason == Some("tool_calls")
                && get(message, "tool_calls")
                    .and_then(json::array)
                    .is_none_or(|calls| calls.is_empty())
            {
                return Err(Error::output(
                    "vLLM reported tool calls without tool inputs",
                ));
            }
        }
        let mut calls = Vec::new();
        if let Some(value) = get(message, "tool_calls") {
            for (index, call) in json::array(value).ok_or_else(invalid)?.iter().enumerate() {
                let function = get(call, "function").ok_or_else(invalid)?;
                let name = string(function, "name").ok_or_else(invalid)?.clone();
                let (id, input) = if self.worker == Worker::Ollama {
                    let input = get(function, "arguments")
                        .filter(|input| matches!(input, JsonValue::Object(_)))
                        .ok_or_else(invalid)?
                        .clone();
                    let mut id = self.request_id.clone()?;
                    json::concat(&mut id, &format!("-ollama-tool-{index}").into());
                    (id, input)
                } else {
                    if string(call, "type").and_then(LosslessString::as_str) != Some("function") {
                        return Err(invalid());
                    }
                    let raw = string(function, "arguments").ok_or_else(invalid)?;
                    let input = json::parse_tool_input(raw).map_err(|_| {
                        Error::output(format!(
                            "Invalid JSON input for `runpod-vllm` tool call `{}`",
                            name.as_str().unwrap_or("")
                        ))
                    })?;
                    (string(call, "id").ok_or_else(invalid)?.clone(), input)
                };
                calls.push(ToolCall {
                    id,
                    name,
                    input,
                    provider_executed: None,
                    provider_metadata: None,
                });
            }
        }
        let usage = if self.worker == Worker::Ollama {
            let input = get(output, "prompt_eval_count").and_then(json::number);
            let output_tokens = get(output, "eval_count").and_then(json::number);
            let duration = |key| {
                get(output, key).and_then(json::number).filter(|value| {
                    value.is_finite()
                        && *value >= 0.0
                        && *value <= 9007199254740991.0
                        && value.fract() == 0.0
                })
            };
            Usage {
                output_tokens,
                total_tokens: input
                    .zip(output_tokens)
                    .map(|(input, output)| input + output),
                output_may_include_unreported_reasoning: string(message, "thinking")
                    .is_some_and(|text| !text.is_empty())
                    .then_some(true),
                prompt_eval_duration_ns: duration("prompt_eval_duration"),
                generation_duration_ns: duration("eval_duration"),
                load_duration_ns: duration("load_duration"),
                ..normalize_input_usage(
                    input,
                    None,
                    get(output, "prompt_eval_cached_count").and_then(json::number),
                    None,
                    InputUsageSemantics::Inclusive,
                )
            }
        } else {
            let raw = get(output, "usage");
            Usage {
                output_tokens: raw
                    .and_then(|raw| get(raw, "completion_tokens"))
                    .and_then(json::number),
                total_tokens: raw
                    .and_then(|raw| get(raw, "total_tokens"))
                    .and_then(json::number),
                output_may_include_unreported_reasoning: string(message, "reasoning_content")
                    .is_some_and(|text| !text.is_empty())
                    .then_some(true),
                ..normalize_input_usage(
                    raw.and_then(|raw| get(raw, "prompt_tokens"))
                        .and_then(json::number),
                    None,
                    raw.and_then(|raw| get(raw, "prompt_tokens_details"))
                        .and_then(|raw| get(raw, "cached_tokens"))
                        .and_then(json::number),
                    None,
                    InputUsageSemantics::Inclusive,
                )
            }
        };
        Ok((
            message,
            if !calls.is_empty() {
                FinishReason::ToolCalls
            } else if reason == Some("length") {
                FinishReason::Length
            } else {
                FinishReason::Stop
            },
            usage,
            calls,
        ))
    }
}
fn validate_choice(choice: &JsonValue) -> bool {
    string(choice, "finish_reason").is_some()
        && get(choice, "message").is_some_and(|message| {
            validate(message, &["role"], &["content", "reasoning_content"], &[])
                && get(message, "content").is_some()
                && string(message, "role").and_then(LosslessString::as_str) == Some("assistant")
                && get(message, "tool_calls").is_none_or(|calls| {
                    json::array(calls).is_some_and(|calls| {
                        calls.iter().all(|call| {
                            string(call, "id").is_some()
                                && string(call, "type").and_then(LosslessString::as_str)
                                    == Some("function")
                                && get(call, "function").is_some_and(|function| {
                                    string(function, "name").is_some()
                                        && string(function, "arguments").is_some()
                                })
                        })
                    })
                })
        })
}
fn validate_usage(raw: Option<&JsonValue>) -> bool {
    raw.is_none_or(|raw| {
        validate(
            raw,
            &[],
            &[],
            &["prompt_tokens", "completion_tokens", "total_tokens"],
        ) && get(raw, "prompt_tokens_details").is_none_or(|details| {
            matches!(details, JsonValue::Null) || validate(details, &[], &[], &["cached_tokens"])
        })
    })
}
fn uuid() -> Result<LosslessString, Error> {
    let mut bytes = [0u8; 16];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes)
        .map_err(|_| Error::transport("Failed to create Runpod request ID", "client"))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
    .into())
}
