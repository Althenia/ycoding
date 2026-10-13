use crate::{
    Error,
    json::{self, get, s},
    llm::{Event, Model, Request},
    openai_chat::OpenAIChat,
    providers::Config,
    route::{Protocol, Route, StreamParser},
};
use std::sync::Arc;
use ycoding_schema::{JsonValue, LosslessString, provider};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Vendor {
    Alibaba,
    Mistral,
    Perplexity,
    Venice,
    Vercel,
}
impl Vendor {
    pub fn identity(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::Alibaba => (
                "alibaba",
                "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
                "ALIBABA_API_KEY",
            ),
            Self::Mistral => ("mistral", "https://api.mistral.ai/v1", "MISTRAL_API_KEY"),
            Self::Perplexity => (
                "perplexity",
                "https://api.perplexity.ai",
                "PERPLEXITY_API_KEY",
            ),
            Self::Venice => ("venice", "https://api.venice.ai/api/v1", "VENICE_API_KEY"),
            Self::Vercel => ("vercel", "https://api.v0.dev/v1", "VERCEL_API_KEY"),
        }
    }
}
pub fn model(id: impl Into<LosslessString>, vendor: Vendor, config: Config) -> Model {
    let mut route = Route::openai_chat();
    let (name, endpoint, _) = vendor.identity();
    route.id = format!("{name}-chat");
    route.provider = provider::Id(name.into());
    route.protocol = Arc::new(Chat(vendor));
    route.endpoint.base_url = config.base_url.unwrap_or_else(|| endpoint.into());
    route.endpoint.query = config.query;
    route.auth = config.auth;
    route.defaults = config.defaults;
    if vendor == Vendor::Vercel {
        route
            .defaults
            .http
            .headers
            .retain(|name, _| !name.eq_ignore_ascii_case("x-title"));
        route
            .defaults
            .http
            .headers
            .insert("x-title".into(), "YCoding".into());
    }
    route.model(id)
}
struct Chat(Vendor);
impl Protocol for Chat {
    fn id(&self) -> &'static str {
        "hosted-chat"
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        let mut body = OpenAIChat.lower(request)?;
        let options = request
            .provider_options
            .as_ref()
            .and_then(|options| get(options, self.0.identity().0));
        if let Some(crate::llm::ResponseFormat::Json(schema)) = &request.response_format {
            json::set(
                &mut body,
                "response_format",
                match self.0 {
                    Vendor::Perplexity => json::object([
                        ("type", s("json_schema")),
                        ("json_schema", json::object([("schema", schema.clone())])),
                    ]),
                    _ => json::object([
                        ("type", s("json_schema")),
                        (
                            "json_schema",
                            json::object([("name", s("response")), ("schema", schema.clone())]),
                        ),
                    ]),
                },
            );
        }
        match self.0 {
            Vendor::Alibaba => {
                body = json::remove(&body, &["frequency_penalty"]);
                json::set(&mut body, "messages", messages(request, self.0)?);
                if let Some(value) = request.generation.top_k {
                    json::set(&mut body, "top_k", JsonValue::Number(value));
                }
                for (from, to) in [
                    ("enableThinking", "enable_thinking"),
                    ("thinkingBudget", "thinking_budget"),
                    ("parallelToolCalls", "parallel_tool_calls"),
                ] {
                    if let Some(value) = options.and_then(|o| get(o, from)) {
                        json::set(&mut body, to, value.clone());
                    }
                }
            }
            Vendor::Mistral => {
                body = json::remove(
                    &body,
                    &[
                        "stream_options",
                        "frequency_penalty",
                        "presence_penalty",
                        "stop",
                        "seed",
                    ],
                );
                json::set(&mut body, "messages", messages(request, self.0)?);
                if let Some(seed) = request.generation.seed {
                    json::set(&mut body, "random_seed", JsonValue::Number(seed));
                }
                for (from, to) in [
                    ("safePrompt", "safe_prompt"),
                    ("reasoningEffort", "reasoning_effort"),
                    ("documentImageLimit", "document_image_limit"),
                    ("documentPageLimit", "document_page_limit"),
                    ("parallelToolCalls", "parallel_tool_calls"),
                ] {
                    if let Some(value) = options.and_then(|o| get(o, from)) {
                        json::set(&mut body, to, value.clone());
                    }
                }
                if let Some(JsonValue::Array(messages)) = get(&body, "messages").cloned() {
                    json::set(
                        &mut body,
                        "messages",
                        JsonValue::Array(
                            messages
                                .into_iter()
                                .map(|mut message| {
                                    if let Some(JsonValue::Array(parts)) =
                                        get(&message, "content").cloned()
                                    {
                                        json::set(
                                            &mut message,
                                            "content",
                                            JsonValue::Array(
                                                parts
                                                    .into_iter()
                                                    .map(|mut part| {
                                                        if let Some(url) = get(&part, "image_url")
                                                            .and_then(|v| get(v, "url"))
                                                            .cloned()
                                                        {
                                                            json::set(&mut part, "image_url", url);
                                                        }
                                                        part
                                                    })
                                                    .collect(),
                                            ),
                                        );
                                    }
                                    message
                                })
                                .collect(),
                        ),
                    );
                }
            }
            Vendor::Perplexity => {
                if !request.tools.is_empty()
                    || request.messages.iter().flat_map(|m| &m.content).any(|p| {
                        matches!(
                            p,
                            crate::llm::Part::ToolCall(_) | crate::llm::Part::ToolResult(_)
                        )
                    })
                {
                    return Err(Error::invalid("Perplexity does not support tool calls"));
                }
                body = json::remove(
                    &body,
                    &["stream_options", "tools", "tool_choice", "stop", "seed"],
                );
                json::set(&mut body, "messages", messages(request, self.0)?);
                if let Some(value) = request.generation.top_k {
                    json::set(&mut body, "top_k", JsonValue::Number(value));
                }
                if let Some(options) = options {
                    body = json::merge(&body, options);
                }
            }
            Vendor::Venice => {
                if let Some(options) = options {
                    body = json::merge(&body, options);
                }
            }
            Vendor::Vercel => {}
        }
        Ok(body)
    }
    fn parser(&self, request: &Request) -> Box<dyn StreamParser> {
        Box::new(Parser {
            vendor: self.0,
            inner: OpenAIChat.parser(request),
            metadata: json::empty(),
            next_tool_index: 0,
        })
    }
}
fn messages(request: &Request, vendor: Vendor) -> Result<JsonValue, Error> {
    use crate::llm::{Part, Role};
    let cache = |hint: Option<&crate::cache::Hint>, metadata: Option<&JsonValue>| {
        metadata
            .and_then(|value| get(value, "alibaba"))
            .and_then(|value| get(value, "cacheControl").or_else(|| get(value, "cache_control")))
            .cloned()
            .or_else(|| hint.map(|_| json::object([("type", s("ephemeral"))])))
    };
    let mut messages = Vec::new();
    if !request.system.is_empty() {
        let text = crate::openai_shared::join(request.system.iter().map(|p| p.text.clone()), "\n");
        let marker = if vendor == Vendor::Alibaba {
            request
                .system
                .iter()
                .rev()
                .find_map(|part| cache(part.cache.as_ref(), part.provider_metadata.as_ref()))
        } else {
            None
        };
        let content = marker
            .map(|marker| {
                JsonValue::Array(vec![json::object([
                    ("type", s("text")),
                    ("text", s(text.clone())),
                    ("cache_control", marker),
                ])])
            })
            .unwrap_or_else(|| s(text));
        messages.push(json::object([("role", s("system")), ("content", content)]));
    }
    for message in &request.messages {
        if message.role == Role::Tool {
            for part in &message.content {
                let Part::ToolResult(part) = part else {
                    return Err(Error::invalid("Hosted tool messages require tool results"));
                };
                if vendor == Vendor::Perplexity {
                    return Err(Error::invalid("Perplexity does not support tool results"));
                }
                let mut result = json::object([
                    ("role", s("tool")),
                    ("tool_call_id", s(part.id.clone())),
                    ("content", s(part.result.to_text())),
                ]);
                if vendor == Vendor::Alibaba
                    && let Some(marker) =
                        cache(part.cache.as_ref(), part.provider_metadata.as_ref())
                {
                    json::set(
                        &mut result,
                        "content",
                        JsonValue::Array(vec![json::object([
                            ("type", s("text")),
                            ("text", s(part.result.to_text())),
                            ("cache_control", marker),
                        ])]),
                    );
                }
                messages.push(result);
            }
            continue;
        }
        let mut parts = Vec::new();
        let mut calls = Vec::new();
        for part in &message.content {
            let mut lowered = match part {
                Part::Text(part) => {
                    json::object([("type", s("text")), ("text", s(part.text.clone()))])
                }
                Part::Reasoning(part) if vendor == Vendor::Alibaba => {
                    json::object([("type", s("text")), ("text", s(part.text.clone()))])
                }
                Part::Reasoning(part) if vendor == Vendor::Mistral => json::object([
                    ("type", s("thinking")),
                    (
                        "thinking",
                        JsonValue::Array(vec![json::object([
                            ("type", s("text")),
                            ("text", s(part.text.clone())),
                        ])]),
                    ),
                ]),
                Part::Reasoning(_) if vendor == Vendor::Perplexity => continue,
                Part::ToolCall(part) => {
                    calls.push(json::object([
                        ("id", s(part.id.clone())),
                        ("type", s("function")),
                        (
                            "function",
                            json::object([
                                ("name", s(part.name.clone())),
                                ("arguments", s(ycoding_schema::stringify_json(&part.input))),
                            ]),
                        ),
                    ]));
                    continue;
                }
                Part::Media(part) if message.role == Role::User => {
                    let (mime, data) = crate::media::validate("Hosted provider", part)?;
                    let url = format!("data:{mime};base64,{data}");
                    if mime.starts_with("image/") {
                        json::object([
                            ("type", s("image_url")),
                            (
                                "image_url",
                                if vendor == Vendor::Mistral {
                                    s(url)
                                } else {
                                    json::object([("url", s(url))])
                                },
                            ),
                        ])
                    } else if vendor == Vendor::Mistral {
                        json::object([("type", s("document_url")), ("document_url", s(url))])
                    } else if vendor == Vendor::Perplexity {
                        json::object([
                            ("type", s("file_url")),
                            ("file_url", json::object([("url", s(url))])),
                        ])
                    } else {
                        return Err(Error::invalid("Alibaba only supports image media"));
                    }
                }
                _ => return Err(Error::invalid("Unsupported hosted message content")),
            };
            if vendor == Vendor::Alibaba {
                let metadata = match part {
                    Part::Text(part) => part.provider_metadata.as_ref(),
                    _ => None,
                };
                if let Some(marker) = cache(part.cache(), metadata) {
                    json::set(&mut lowered, "cache_control", marker);
                }
            }
            parts.push(lowered);
        }
        let role = match message.role {
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::System => "system",
            Role::Tool => unreachable!(),
        };
        let content = if parts.iter().all(|part| {
            get(part, "type").and_then(json::text) == Some("text")
                && get(part, "cache_control").is_none()
        }) {
            let text = crate::openai_shared::join(
                parts
                    .iter()
                    .filter_map(|part| get(part, "text").and_then(json::string).cloned()),
                "",
            );
            if text.is_empty() && !calls.is_empty() {
                JsonValue::Null
            } else {
                s(text)
            }
        } else {
            JsonValue::Array(parts)
        };
        let mut lowered = json::object([("role", s(role)), ("content", content)]);
        if !calls.is_empty() {
            json::set(&mut lowered, "tool_calls", JsonValue::Array(calls));
        }
        messages.push(lowered);
    }
    Ok(JsonValue::Array(messages))
}
struct Parser {
    vendor: Vendor,
    inner: Box<dyn StreamParser>,
    metadata: JsonValue,
    next_tool_index: usize,
}
impl StreamParser for Parser {
    fn push(&mut self, event: &JsonValue) -> Result<Vec<Event>, Error> {
        let mut event = event.clone();
        if self.vendor == Vendor::Alibaba {
            if let Some(mut usage) = get(&event, "usage").cloned() {
                if let Some(mut details) = get(&usage, "prompt_tokens_details").cloned() {
                    if let Some(write) = get(&details, "cache_creation_input_tokens").cloned() {
                        json::set(&mut details, "cache_write_tokens", write);
                    }
                    json::set(&mut usage, "prompt_tokens_details", details);
                }
                json::set(&mut event, "usage", usage);
            }
        }
        if self.vendor == Vendor::Mistral {
            if let Some(JsonValue::Array(choices)) = get(&event, "choices").cloned() {
                json::set(
                    &mut event,
                    "choices",
                    JsonValue::Array(
                        choices
                            .into_iter()
                            .map(|mut choice| {
                                if let Some(mut delta) = get(&choice, "delta").cloned() {
                                    if let Some(JsonValue::Array(content)) =
                                        get(&delta, "content").cloned()
                                    {
                                        let text = crate::openai_shared::join(
                                            content.iter().filter_map(|p| {
                                                get(p, "text").and_then(json::string).cloned()
                                            }),
                                            "",
                                        );
                                        let reasoning = crate::openai_shared::join(
                                            content
                                                .iter()
                                                .filter_map(|p| get(p, "thinking"))
                                                .flat_map(|v| json::array(v).unwrap_or(&[]))
                                                .filter_map(|p| {
                                                    get(p, "text").and_then(json::string).cloned()
                                                }),
                                            "",
                                        );
                                        json::set(&mut delta, "content", s(text));
                                        if !reasoning.is_empty() {
                                            json::set(
                                                &mut delta,
                                                "reasoning_content",
                                                s(reasoning),
                                            );
                                        }
                                    }
                                    if let Some(JsonValue::Array(tools)) =
                                        get(&delta, "tool_calls").cloned()
                                    {
                                        json::set(
                                            &mut delta,
                                            "tool_calls",
                                            JsonValue::Array(
                                                tools
                                                    .into_iter()
                                                    .map(|mut tool| {
                                                        if get(&tool, "index").is_none() {
                                                            json::set(
                                                                &mut tool,
                                                                "index",
                                                                JsonValue::Number(
                                                                    self.next_tool_index as f64,
                                                                ),
                                                            );
                                                            self.next_tool_index += 1;
                                                        }
                                                        tool
                                                    })
                                                    .collect(),
                                            ),
                                        );
                                    }
                                    json::set(&mut choice, "delta", delta);
                                }
                                choice
                            })
                            .collect(),
                    ),
                );
            }
        }
        if self.vendor == Vendor::Perplexity {
            if let Some(citations) = get(&event, "citations").and_then(json::array) {
                json::set(
                    &mut self.metadata,
                    "citations",
                    JsonValue::Array(
                        citations
                            .iter()
                            .filter(|value| matches!(value, JsonValue::String(_)))
                            .cloned()
                            .collect(),
                    ),
                );
            }
            if let Some(images) = get(&event, "images").and_then(json::array) {
                let images = images
                    .iter()
                    .map(|image| {
                        json::object(
                            [
                                ("image_url", "imageUrl"),
                                ("origin_url", "originUrl"),
                                ("height", "height"),
                                ("width", "width"),
                            ]
                            .into_iter()
                            .filter_map(|(from, to)| {
                                get(image, from)
                                    .filter(|value| {
                                        matches!(value, JsonValue::String(_) | JsonValue::Number(_))
                                    })
                                    .map(|value| (to, value.clone()))
                            }),
                        )
                    })
                    .collect();
                json::set(&mut self.metadata, "images", JsonValue::Array(images));
            }
            if let Some(usage) = get(&event, "usage") {
                json::set(
                    &mut self.metadata,
                    "usage",
                    json::object(
                        [
                            ("citation_tokens", "citationTokens"),
                            ("num_search_queries", "numSearchQueries"),
                        ]
                        .into_iter()
                        .map(|(from, to)| {
                            (
                                to,
                                get(usage, from)
                                    .and_then(json::number)
                                    .map(JsonValue::Number)
                                    .unwrap_or(JsonValue::Null),
                            )
                        }),
                    ),
                );
                if let Some(cost) = get(usage, "cost") {
                    json::set(
                        &mut self.metadata,
                        "cost",
                        json::object(
                            [
                                ("input_tokens_cost", "inputTokensCost"),
                                ("output_tokens_cost", "outputTokensCost"),
                                ("request_cost", "requestCost"),
                                ("total_cost", "totalCost"),
                            ]
                            .into_iter()
                            .map(|(from, to)| {
                                (
                                    to,
                                    get(cost, from)
                                        .and_then(json::number)
                                        .map(JsonValue::Number)
                                        .unwrap_or(JsonValue::Null),
                                )
                            }),
                        ),
                    );
                }
            }
        }
        if self.vendor == Vendor::Venice {
            if let Some(cost) = get(&event, "cost") {
                json::set(
                    &mut self.metadata,
                    "cost",
                    json::object(["diem", "usd"].into_iter().filter_map(|key| {
                        get(cost, key)
                            .and_then(json::number)
                            .map(|value| (key, JsonValue::Number(value)))
                    })),
                );
            }
            if let Some(citations) = get(&event, "venice_parameters")
                .and_then(|value| get(value, "web_search_citations"))
                .and_then(json::array)
            {
                json::set(
                    &mut self.metadata,
                    "webSearchCitations",
                    JsonValue::Array(
                        citations
                            .iter()
                            .map(|citation| {
                                crate::openai_shared::pick(
                                    citation,
                                    &["title", "url", "content", "date"],
                                )
                            })
                            .collect(),
                    ),
                );
            }
        }
        self.inner.push(&event)
    }
    fn finish(&mut self) -> Result<Vec<Event>, Error> {
        let mut events = self.inner.finish()?;
        if matches!(self.vendor, Vendor::Perplexity | Vendor::Venice) {
            for event in &mut events {
                if let Event::Finish(finish) | Event::StepFinish { finish, .. } = event {
                    finish.provider_metadata = Some(json::object([(
                        self.vendor.identity().0,
                        self.metadata.clone(),
                    )]));
                }
            }
        }
        Ok(events)
    }
}
