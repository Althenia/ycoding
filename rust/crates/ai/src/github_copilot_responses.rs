use crate::{
    Error, github_copilot,
    json::{self, get, s},
    llm::{Event, Part, Request, Role},
    openai_shared::{self, join, string},
    route::{Protocol, StreamParser},
};
use std::collections::BTreeMap;
use ycoding_schema::{JsonValue, LosslessString, stringify_json};

pub struct Responses;
fn reasoning_model(id: &str) -> bool {
    !id.starts_with("gpt-5-chat")
        && ["o", "gpt-5", "codex-", "computer-use"]
            .iter()
            .any(|prefix| id.starts_with(prefix))
}
impl Protocol for Responses {
    fn id(&self) -> &'static str {
        "github-copilot-responses"
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        let request = github_copilot::resolved(request);
        let options = github_copilot::options(&request);
        let mut body = crate::openai_responses::lower(&request)?;
        json::set(
            &mut body,
            "input",
            JsonValue::Array(input(&request, &options)?),
        );
        let id = request.model.id.as_str().unwrap_or("");
        if reasoning_model(id) {
            body = json::remove(&body, &["temperature", "top_p"]);
        } else {
            body = json::remove(&body, &["reasoning"]);
        }
        for (key, wire) in [
            ("maxToolCalls", "max_tool_calls"),
            ("metadata", "metadata"),
            ("parallelToolCalls", "parallel_tool_calls"),
            ("user", "user"),
            ("safetyIdentifier", "safety_identifier"),
        ] {
            if let Some(value) = get(&options, key) {
                json::set(&mut body, wire, value.clone());
            }
        }
        if let Some(entries) = get(&options, "contextManagement").and_then(json::array) {
            json::set(
                &mut body,
                "context_management",
                JsonValue::Array(
                    entries
                        .iter()
                        .map(|entry| {
                            let mut item = json::object([("type", s("compaction"))]);
                            if let Some(threshold) = get(entry, "compactThreshold") {
                                json::set(&mut item, "compact_threshold", threshold.clone());
                            }
                            item
                        })
                        .collect(),
                ),
            );
        }
        if let Some(value) = get(&options, "previousResponseId") {
            json::set(&mut body, "previous_response_id", value.clone());
        }
        if let Some(logprobs) = get(&options, "logprobs") {
            let count = if json::boolean(logprobs) == Some(true) {
                Some(20.0)
            } else {
                json::number(logprobs)
            };
            if let Some(count) = count {
                json::set(&mut body, "top_logprobs", JsonValue::Number(count));
                let mut include = get(&body, "include")
                    .and_then(json::array)
                    .unwrap_or(&[])
                    .to_vec();
                include.push(s("message.output_text.logprobs"));
                json::set(&mut body, "include", JsonValue::Array(include));
            }
        }
        if let Some(JsonValue::Array(tools)) = get(&body, "tools") {
            let tools = tools
                .iter()
                .zip(&request.tools)
                .map(|(value, tool)| {
                    if get(value, "type").and_then(json::text) != Some("function") {
                        return value.clone();
                    }
                    let mut value = value.clone();
                    json::set(&mut value, "parameters", tool.input_schema.clone());
                    json::set(
                        &mut value,
                        "strict",
                        get(&options, "strictJsonSchema")
                            .cloned()
                            .unwrap_or(JsonValue::Bool(false)),
                    );
                    value
                })
                .collect();
            json::set(&mut body, "tools", JsonValue::Array(tools));
        }
        if request.tools.is_empty() {
            body = json::remove(&body, &["tool_choice"]);
        }
        Ok(openai_shared::pick(
            &body,
            &[
                "model",
                "input",
                "temperature",
                "top_p",
                "max_output_tokens",
                "text",
                "max_tool_calls",
                "metadata",
                "parallel_tool_calls",
                "previous_response_id",
                "store",
                "user",
                "instructions",
                "service_tier",
                "include",
                "prompt_cache_key",
                "safety_identifier",
                "top_logprobs",
                "context_management",
                "reasoning",
                "truncation",
                "tools",
                "tool_choice",
                "stream",
            ],
        ))
    }
    fn parser(&self, request: &Request) -> Box<dyn StreamParser> {
        let mut request = github_copilot::resolved(request);
        request.provider_options = Some(json::object([(
            "openai",
            json::object([("store", JsonValue::Bool(false))]),
        )]));
        Box::new(Parser {
            inner: crate::openai_responses::OpenAIResponses::parser(&request),
            items: BTreeMap::new(),
            canonical: BTreeMap::new(),
        })
    }
    fn terminal(&self, event: &JsonValue) -> bool {
        matches!(
            get(event, "type").and_then(json::text),
            Some("response.completed" | "response.incomplete" | "response.failed")
        )
    }
}

fn input(request: &Request, options: &JsonValue) -> Result<Vec<JsonValue>, Error> {
    let id = request.model.id.as_str().unwrap_or("");
    let role = if reasoning_model(id) {
        "developer"
    } else {
        "system"
    };
    let remove_system = id.starts_with("o1-mini") || id.starts_with("o1-preview");
    let store = get(options, "store")
        .and_then(json::boolean)
        .unwrap_or(true);
    let mut input = Vec::new();
    if !remove_system {
        input.extend(
            request
                .system
                .iter()
                .map(|part| json::object([("role", s(role)), ("content", s(part.text.clone()))])),
        );
    }
    let boundary = request
        .messages
        .iter()
        .enumerate()
        .flat_map(|(m, message)| {
            message
                .content
                .iter()
                .enumerate()
                .filter_map(move |(p, part)| {
                    (message.role == Role::Assistant)
                        .then(|| {
                            github_copilot::part_metadata(part).and_then(github_copilot::opaque)
                        })
                        .flatten()
                        .map(|item| (m, p, item))
                })
        })
        .last();
    for (index, message) in request.messages.iter().enumerate() {
        if boundary.is_some_and(|(m, _, _)| index < m && message.role != Role::System) {
            continue;
        }
        let content = if let Some((_, p, item)) = boundary.filter(|(m, _, _)| *m == index) {
            input.push(item.clone());
            &message.content[p + 1..]
        } else {
            &message.content[..]
        };
        match message.role {
            Role::System => {
                if !remove_system {
                    input.push(json::object([
                        ("role", s(role)),
                        (
                            "content",
                            s(join(
                                content.iter().filter_map(|part| {
                                    if let Part::Text(part) = part {
                                        Some(part.text.clone())
                                    } else {
                                        None
                                    }
                                }),
                                "",
                            )),
                        ),
                    ]));
                }
            }
            Role::User => {
                let content = content
                    .iter()
                    .enumerate()
                    .map(|(index, part)| match part {
                        Part::Text(part) => Ok(json::object([
                            ("type", s("input_text")),
                            ("text", s(part.text.clone())),
                        ])),
                        Part::Media(part) => {
                            let mut value = github_copilot::image(part, true)?;
                            if part.mime.as_str() == Some("application/pdf")
                                && part.filename.is_none()
                                && get(&value, "file_data").is_some()
                            {
                                json::set(&mut value, "filename", s(format!("part-{index}.pdf")));
                            }
                            Ok(value)
                        }
                        _ => Err(Error::invalid(
                            "Copilot Responses user content must be text or media",
                        )),
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                input.push(json::object([
                    ("role", s("user")),
                    ("content", JsonValue::Array(content)),
                ]));
            }
            Role::Assistant => {
                let mut reasoning = BTreeMap::<LosslessString, usize>::new();
                for part in content {
                    let metadata = github_copilot::part_metadata(part);
                    let item_id = metadata.and_then(|value| string(value, "itemId"));
                    match part {
                        Part::Text(part) => {
                            let mut item = json::object([
                                ("role", s("assistant")),
                                (
                                    "content",
                                    JsonValue::Array(vec![json::object([
                                        ("type", s("output_text")),
                                        ("text", s(part.text.clone())),
                                    ])]),
                                ),
                            ]);
                            if let Some(id) = item_id {
                                json::set(&mut item, "id", s(id.clone()));
                            }
                            input.push(item);
                        }
                        Part::ToolCall(call) if call.provider_executed != Some(true) => {
                            let mut item = json::object([
                                ("type", s("function_call")),
                                ("call_id", s(call.id.clone())),
                                ("name", s(call.name.clone())),
                                ("arguments", s(stringify_json(&call.input))),
                            ]);
                            if let Some(id) = item_id {
                                json::set(&mut item, "id", s(id.clone()));
                            }
                            input.push(item);
                        }
                        Part::ToolCall(_) => {}
                        Part::ToolResult(result) => {
                            if store {
                                input.push(json::object([
                                    ("type", s("item_reference")),
                                    ("id", s(result.id.clone())),
                                ]));
                            }
                        }
                        Part::Reasoning(part) => {
                            let Some(id) = item_id else {
                                continue;
                            };
                            if let Some(index) = reasoning.get(id).copied() {
                                if !store && !part.text.is_empty() {
                                    let mut summary = get(&input[index], "summary")
                                        .and_then(json::array)
                                        .unwrap_or(&[])
                                        .to_vec();
                                    summary.push(json::object([
                                        ("type", s("summary_text")),
                                        ("text", s(part.text.clone())),
                                    ]));
                                    json::set(
                                        &mut input[index],
                                        "summary",
                                        JsonValue::Array(summary),
                                    );
                                }
                                continue;
                            }
                            reasoning.insert(id.clone(), input.len());
                            if store {
                                input.push(json::object([
                                    ("type", s("item_reference")),
                                    ("id", s(id.clone())),
                                ]));
                                continue;
                            }
                            let mut item =
                                json::object([("type", s("reasoning")), ("id", s(id.clone()))]);
                            if let Some(encrypted) =
                                metadata.and_then(|value| get(value, "reasoningEncryptedContent"))
                            {
                                json::set(&mut item, "encrypted_content", encrypted.clone());
                            }
                            json::set(
                                &mut item,
                                "summary",
                                JsonValue::Array(if part.text.is_empty() {
                                    Vec::new()
                                } else {
                                    vec![json::object([
                                        ("type", s("summary_text")),
                                        ("text", s(part.text.clone())),
                                    ])]
                                }),
                            );
                            input.push(item);
                        }
                        _ => {
                            return Err(Error::invalid(
                                "Unsupported Copilot Responses assistant part",
                            ));
                        }
                    }
                }
            }
            Role::Tool => {
                for part in content {
                    let Part::ToolResult(result) = part else {
                        return Err(Error::invalid(
                            "Copilot Responses tool content must be tool results",
                        ));
                    };
                    input.push(json::object([
                        ("type", s("function_call_output")),
                        ("call_id", s(result.id.clone())),
                        ("output", s(result.result.to_text())),
                    ]));
                }
            }
        }
    }
    Ok(input)
}

struct Parser {
    inner: crate::openai_responses::Parser,
    items: BTreeMap<LosslessString, JsonValue>,
    canonical: BTreeMap<String, LosslessString>,
}
impl Parser {
    fn metadata(&self, value: &mut Option<JsonValue>, id: Option<&LosslessString>, full: bool) {
        let mut extra = value
            .as_ref()
            .and_then(|value| get(value, "openai"))
            .cloned()
            .unwrap_or_else(json::empty);
        if let Some(id) = id {
            let item_id = self
                .items
                .keys()
                .filter(|item| {
                    id == *item
                        || id
                            .as_str()
                            .zip(item.as_str())
                            .is_some_and(|(id, item)| id.starts_with(&format!("{item}:")))
                })
                .max_by_key(|item| item.len());
            if let Some(item_id) = item_id {
                let item = &self.items[item_id];
                json::set(&mut extra, "itemId", s(item_id.clone()));
                if full && get(item, "type").and_then(json::text) == Some("reasoning") {
                    json::set(
                        &mut extra,
                        "reasoningEncryptedContent",
                        get(item, "encrypted_content")
                            .cloned()
                            .unwrap_or(JsonValue::Null),
                    );
                }
            }
        }
        *value = github_copilot::metadata(extra);
    }
    fn convert(&self, events: &mut [Event]) {
        for event in events {
            match event {
                Event::TextStart(part) | Event::TextEnd(part) => {
                    self.metadata(&mut part.provider_metadata, Some(&part.id), false)
                }
                Event::TextDelta(part) => {
                    self.metadata(&mut part.provider_metadata, Some(&part.id), false)
                }
                Event::ReasoningStart(part) | Event::ReasoningEnd(part) => {
                    self.metadata(&mut part.provider_metadata, Some(&part.id), true);
                    if let Some(item) = self
                        .items
                        .get(&part.id)
                        .filter(|item| get(item, "type").and_then(json::text) == Some("compaction"))
                    {
                        part.provider_metadata = github_copilot::metadata(json::object([
                            ("itemId", s(part.id.clone())),
                            ("opaqueCompactionItem", item.clone()),
                        ]));
                        part.id = join([part.id.clone(), ":0".into()], "");
                    }
                }
                Event::ReasoningDelta(part) => {
                    self.metadata(&mut part.provider_metadata, Some(&part.id), false)
                }
                Event::ToolInputStart(part) | Event::ToolInputEnd(part) => {
                    self.metadata(&mut part.provider_metadata, None, false)
                }
                Event::ToolCall(part) => {
                    self.metadata(&mut part.provider_metadata, None, false);
                    if let Some((id, _)) = self
                        .items
                        .iter()
                        .find(|(_, item)| string(item, "call_id") == Some(&part.id))
                    {
                        part.provider_metadata =
                            github_copilot::metadata(json::object([("itemId", s(id.clone()))]));
                    }
                }
                Event::ToolResult(part) => self.metadata(&mut part.provider_metadata, None, false),
                Event::Finish(finish) | Event::StepFinish { finish, .. } => {
                    if finish.provider_metadata.is_some() {
                        self.metadata(&mut finish.provider_metadata, None, false);
                    }
                    if let Some(usage) = &mut finish.usage {
                        self.metadata(&mut usage.provider_metadata, None, false);
                    }
                }
                _ => {}
            }
        }
    }
}
impl StreamParser for Parser {
    fn push(&mut self, event: &JsonValue) -> Result<Vec<Event>, Error> {
        let mut event = event.clone();
        if let Some(item) = get(&event, "item") {
            let mut item = item.clone();
            let index = get(&event, "output_index")
                .and_then(json::number)
                .map(|index| index.to_string());
            if let Some(id) = string(&item, "id") {
                let id = if let Some(index) = index {
                    let canonical = self
                        .canonical
                        .entry(index)
                        .or_insert_with(|| id.clone())
                        .clone();
                    if get(&item, "type").and_then(json::text) == Some("reasoning") {
                        canonical
                    } else {
                        id.clone()
                    }
                } else {
                    id.clone()
                };
                json::set(&mut item, "id", s(id.clone()));
                self.items.insert(id, item.clone());
            }
            json::set(&mut event, "item", item);
        }
        let mut events = self.inner.push(&event)?;
        self.convert(&mut events);
        Ok(events)
    }
    fn finish(&mut self) -> Result<Vec<Event>, Error> {
        let mut events = self.inner.finish()?;
        self.convert(&mut events);
        Ok(events)
    }
}
