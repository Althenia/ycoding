use crate::{
    Error,
    json::{self, get, s},
    llm::{
        Event, Finish, FinishReason, Media, MediaData, Message, Part, Request, Role, ToolCall,
        ToolChoice, ToolDefinition, ToolInputEvent, ToolResult, ToolResultValue,
    },
    openai_options,
    openai_shared::{self, Lifecycle, PendingTool, Tools, join, metadata, pick, string, validate},
    provider_error::{Failure, classify},
    route::{Protocol, StreamParser},
    websocket::{Continuation, JsonTransport, SessionMetadata},
};
use std::{collections::BTreeMap, sync::Arc};
use ycoding_schema::{
    JsonValue, LosslessString,
    llm::{ToolContent, ToolFileContent},
    stringify_json,
};

pub struct OpenAIResponses;
impl OpenAIResponses {
    pub fn parser(request: &Request) -> Parser {
        Self::resolved_parser(&request.resolved())
    }
    fn resolved_parser(request: &Request) -> Parser {
        Parser {
            store: openai_options::store(request),
            remote: request
                .messages
                .last()
                .and_then(|message| message.native.as_ref())
                .and_then(|value| get(value, "openai"))
                .and_then(|value| get(value, "compactionTrigger"))
                .and_then(json::boolean)
                == Some(true),
            ..Parser::default()
        }
    }
}
impl Protocol for OpenAIResponses {
    fn id(&self) -> &'static str {
        "openai-responses"
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        lower(request)
    }
    fn parser(&self, request: &Request) -> Box<dyn StreamParser> {
        Box::new(Self::resolved_parser(request))
    }
    fn terminal(&self, event: &JsonValue) -> bool {
        matches!(
            get(event, "type").and_then(json::text),
            Some("response.completed" | "response.incomplete" | "response.failed")
        )
    }
}
fn native_tool(tool: &ToolDefinition) -> Option<&JsonValue> {
    tool.native.as_ref().and_then(|value| get(value, "openai"))
}
fn allowed(value: &JsonValue, key: &str, options: &[&str]) -> bool {
    get(value, key)
        .is_none_or(|value| json::text(value).is_some_and(|value| options.contains(&value)))
}
fn native_valid(value: &JsonValue) -> bool {
    match get(value, "type").and_then(json::text) {
        Some("image_generation") => {
            allowed(value, "action", &["auto", "generate", "edit"])
                && allowed(value, "background", &["auto", "opaque", "transparent"])
                && allowed(value, "input_fidelity", &["low", "high"])
                && allowed(value, "output_format", &["png", "jpeg", "webp"])
                && allowed(value, "quality", &["auto", "low", "medium", "high"])
                && get(value, "output_compression").is_none_or(|value| {
                    json::number(value)
                        .is_some_and(|value| (0.0..=100.0).contains(&value) && value.fract() == 0.0)
                })
                && get(value, "partial_images").is_none_or(|value| {
                    json::number(value).is_some_and(|value| value >= 0.0 && value.fract() == 0.0)
                })
                && get(value, "size").is_none_or(|value| {
                    json::text(value).is_some_and(|value| {
                        value == "auto"
                            || value.split_once('x').is_some_and(|(width, height)| {
                                !width.is_empty()
                                    && !height.is_empty()
                                    && width
                                        .bytes()
                                        .chain(height.bytes())
                                        .all(|ch| ch.is_ascii_digit())
                                    && width.parse::<f64>().is_ok_and(|value| value > 0.0)
                                    && height.parse::<f64>().is_ok_and(|value| value > 0.0)
                            })
                    })
                })
        }
        Some("web_search") => {
            allowed(value, "search_context_size", &["low", "medium", "high"])
                && allowed(value, "return_token_budget", &["default", "unlimited"])
                && get(value, "external_web_access")
                    .is_none_or(|value| matches!(value, JsonValue::Bool(_)))
                && get(value, "filters").is_none_or(|value| {
                    matches!(value, JsonValue::Object(_))
                        && ["allowed_domains", "blocked_domains"].iter().all(|key| {
                            get(value, key).is_none_or(|value| {
                                json::array(value).is_some_and(|values| {
                                    values
                                        .iter()
                                        .all(|value| matches!(value, JsonValue::String(_)))
                                })
                            })
                        })
                })
                && get(value, "user_location").is_none_or(|value| {
                    get(value, "type").and_then(json::text) == Some("approximate")
                        && validate(value, &["city", "country", "region", "timezone"], &[], &[])
                })
        }
        _ => false,
    }
}
fn lower_tool(tool: &ToolDefinition, request: &Request) -> Result<JsonValue, Error> {
    if let Some(native) = native_tool(tool).filter(|value| {
        matches!(
            get(value, "type").and_then(json::text),
            Some("image_generation" | "web_search")
        )
    }) {
        if !native_valid(native) {
            return Err(Error::invalid(format!(
                "OpenAI Responses {} tool options are invalid",
                if get(native, "type").and_then(json::text) == Some("web_search") {
                    "web search"
                } else {
                    "image generation"
                }
            )));
        }
        let mut result = pick(
            native,
            if get(native, "type").and_then(json::text) == Some("web_search") {
                &[
                    "type",
                    "filters",
                    "search_context_size",
                    "user_location",
                    "external_web_access",
                    "return_token_budget",
                ]
            } else {
                &[
                    "type",
                    "action",
                    "background",
                    "input_fidelity",
                    "output_compression",
                    "output_format",
                    "partial_images",
                    "quality",
                    "size",
                ]
            },
        );
        for (key, fields) in [
            ("filters", &["allowed_domains", "blocked_domains"][..]),
            (
                "user_location",
                &["type", "city", "country", "region", "timezone"][..],
            ),
        ] {
            if let Some(value) = get(native, key) {
                json::set(&mut result, key, pick(value, fields));
            }
        }
        return Ok(result);
    }
    if !matches!(tool.input_schema, JsonValue::Object(_)) {
        return Err(Error::invalid("Tool inputSchema must be a JSON object"));
    }
    Ok(json::object([
        ("type", s("function")),
        ("name", s(tool.name.clone())),
        ("description", s(tool.description.clone())),
        (
            "parameters",
            crate::tool_schema::openai(&crate::tool_schema::model_compatibility(
                &tool.input_schema,
                request.model.tool_schema,
            )),
        ),
        ("strict", JsonValue::Bool(false)),
    ]))
}
pub(crate) fn tool_choice(
    choice: &ToolChoice,
    responses: bool,
    tools: &[ToolDefinition],
) -> Result<JsonValue, Error> {
    match choice {
        ToolChoice::Auto => Ok(s("auto")),
        ToolChoice::None => Ok(s("none")),
        ToolChoice::Required => Ok(s("required")),
        ToolChoice::Tool(name) => {
            if name.is_empty() {
                return Err(Error::invalid(format!(
                    "OpenAI {} tool choice requires a tool name",
                    if responses { "Responses" } else { "Chat" }
                )));
            }
            if responses {
                if let Some(native) = tools
                    .iter()
                    .find(|tool| tool.name == *name)
                    .and_then(native_tool)
                    .filter(|native| native_valid(native))
                {
                    return Ok(pick(native, &["type"]));
                }
                Ok(json::object([
                    ("type", s("function")),
                    ("name", s(name.clone())),
                ]))
            } else {
                Ok(json::object([
                    ("type", s("function")),
                    ("function", json::object([("name", s(name.clone()))])),
                ]))
            }
        }
    }
}
fn text_block(text: LosslessString, cache: bool) -> JsonValue {
    let mut block = json::object([("type", s("input_text")), ("text", s(text))]);
    if cache {
        json::set(
            &mut block,
            "prompt_cache_breakpoint",
            json::object([("mode", s("explicit"))]),
        );
    }
    block
}
fn media(part: &Media, detail: Option<&LosslessString>, cache: bool) -> JsonValue {
    match crate::media::validate("OpenAI Responses", part) {
        Ok((mime, data)) => {
            let mut block = json::object([
                ("type", s("input_image")),
                ("image_url", s(format!("data:{mime};base64,{data}"))),
            ]);
            if let Some(detail) = detail {
                json::set(&mut block, "detail", s(detail.clone()));
            }
            block
        }
        Err(error) => text_block(crate::media::notice(part, &error).into(), cache),
    }
}
fn content_item(item: &ToolContent, detail: Option<&LosslessString>, cache: bool) -> JsonValue {
    match item {
        ToolContent::Text(part) => text_block(part.text.clone(), cache),
        ToolContent::File(part) => media(
            &Media {
                mime: part.mime.clone(),
                data: MediaData::Encoded(part.uri.clone()),
                filename: part.name.clone(),
            },
            detail,
            cache,
        ),
    }
}
fn compaction(value: &JsonValue) -> bool {
    get(value, "type").and_then(json::text) == Some("compaction")
        && string(value, "encrypted_content").is_some()
        && get(value, "id").is_none_or(|value| matches!(value, JsonValue::String(_)))
}
pub fn prune_messages(request: &Request) -> Vec<Message> {
    if openai_options::store(request) != Some(false) {
        return request.messages.clone();
    }
    let boundaries = request
        .messages
        .iter()
        .enumerate()
        .flat_map(|(m, message)| {
            message
                .content
                .iter()
                .enumerate()
                .filter_map(move |(p, part)| {
                    if message.role == Role::Assistant {
                        if let Part::Reasoning(part) = part {
                            let metadata = part.provider_metadata.as_ref().and_then(|value| {
                                get(value, "openai").or_else(|| get(value, "copilot"))
                            });
                            if metadata.is_some_and(|value| {
                                get(value, "opaqueCompactionItem").is_some_and(compaction)
                                    || string(value, "compactionEncryptedContent").is_some()
                            }) {
                                return Some((
                                    m,
                                    p,
                                    metadata
                                        .and_then(|value| get(value, "remoteCompactionV2"))
                                        .and_then(json::boolean)
                                        == Some(true),
                                ));
                            }
                        }
                        None
                    } else {
                        None
                    }
                })
        })
        .collect::<Vec<_>>();
    let Some((message, part, remote)) = boundaries.last().copied() else {
        return request.messages.clone();
    };
    if remote {
        return request.messages[boundaries
            .iter()
            .rev()
            .nth(1)
            .map(|(message, _, _)| message + 1)
            .unwrap_or(0)..]
            .to_vec();
    }
    let mut messages = request.messages[message..].to_vec();
    messages[0].content = messages[0].content[part..].to_vec();
    messages
}
fn flush_text(input: &mut Vec<JsonValue>, text: &mut Vec<crate::llm::TextPart>) {
    if text.is_empty() {
        return;
    }
    let phase = text.iter().rev().find_map(|part| {
        part.provider_metadata
            .as_ref()
            .and_then(|value| get(value, "openai"))
            .and_then(|value| string(value, "phase"))
            .filter(|value| matches!(value.as_str(), Some("commentary" | "final_answer")))
    });
    let mut item = json::object([("role", s("assistant"))]);
    if let Some(phase) = phase {
        json::set(&mut item, "phase", s(phase.clone()));
    }
    json::set(
        &mut item,
        "content",
        JsonValue::Array(
            text.iter()
                .map(|part| {
                    json::object([("type", s("output_text")), ("text", s(part.text.clone()))])
                })
                .collect(),
        ),
    );
    input.push(pick(&item, &["role", "content", "phase"]));
    text.clear();
}
pub fn lower(request: &Request) -> Result<JsonValue, Error> {
    let detail = openai_options::image_detail(request)?;
    let marked = openai_options::breakpoints(request);
    let store = openai_options::store(request);
    let mut input = Vec::new();
    if !request.system.is_empty() {
        let text = join(request.system.iter().map(|part| part.text.clone()), "\n");
        let content = if marked && request.system.iter().any(|part| part.cache.is_some()) {
            JsonValue::Array(vec![text_block(text, true)])
        } else {
            s(text)
        };
        input.push(json::object([("role", s("system")), ("content", content)]));
    }
    let start = if store == Some(true) && openai_options::previous_response_id(request).is_some() {
        openai_options::safe_integer(openai_options::value(request, "continuationInputStart"))
            .unwrap_or(0)
            .min(request.messages.len())
    } else {
        0
    };
    for message in prune_messages(request).iter().skip(start) {
        if message
            .native
            .as_ref()
            .and_then(|value| get(value, "openai"))
            .and_then(|value| get(value, "compactionTrigger"))
            .and_then(json::boolean)
            == Some(true)
        {
            if message.role != Role::User
                || !message.content.is_empty()
                || !["openai-codex-responses", "openai-codex-websocket-responses"]
                    .contains(&request.model.route.id.as_str())
            {
                return Err(Error::invalid(
                    "Codex remote compaction trigger requires an empty Codex input item",
                ));
            }
            input.push(json::object([("type", s("compaction_trigger"))]));
            continue;
        }
        if message.role == Role::System {
            let native = ["openai-codex-responses", "openai-codex-websocket-responses"]
                .contains(&request.model.route.id.as_str())
                || ["openai-responses", "openai-responses-websocket"]
                    .contains(&request.model.route.id.as_str())
                    && openai_options::gpt56(&request.model.id);
            if native {
                let content=message.content.iter().map(|part|if let Part::Text(part)=part {Ok(text_block(part.text.clone(),false))}else {Err(Error::invalid("OpenAI Responses system messages only support text content for now"))}).collect::<Result<Vec<_>,_>>()?;
                input.push(json::object([
                    ("role", s("system")),
                    ("content", JsonValue::Array(content)),
                ]));
                continue;
            }
            let block = text_block(
                openai_shared::wrapped_system(message, "OpenAI Responses")?,
                false,
            );
            if let Some(previous) = input.last_mut()
                && get(previous, "role").and_then(json::text) == Some("user")
                && let Some(content) = get(previous, "content").and_then(json::array)
            {
                let mut content = content.to_vec();
                content.push(block);
                json::set(previous, "content", JsonValue::Array(content));
                continue;
            }
            input.push(json::object([
                ("role", s("user")),
                ("content", JsonValue::Array(vec![block])),
            ]));
            continue;
        }
        if message.role == Role::User {
            let content=message.content.iter().map(|part|match part {Part::Text(part)=>Ok(text_block(part.text.clone(),marked && part.cache.is_some())),Part::Media(part)=>Ok(media(part,detail,false)),_=>Err(Error::invalid("OpenAI Responses user messages only support text and media content for now"))}).collect::<Result<Vec<_>,_>>()?;
            input.push(json::object([
                ("role", s("user")),
                ("content", JsonValue::Array(content)),
            ]));
            continue;
        }
        if message.role == Role::Assistant {
            let mut text = Vec::new();
            let mut reasoning_items = BTreeMap::new();
            let mut references = Vec::new();
            let mut compactions = Vec::new();
            let mut hosted = Vec::new();
            for part in &message.content {
                match part {
                    Part::Text(part) => text.push(part.clone()),
                    Part::Reasoning(part) => {
                        flush_text(&mut input, &mut text);
                        let Some(value) = part
                            .provider_metadata
                            .as_ref()
                            .and_then(|value| get(value, "openai"))
                        else {
                            continue;
                        };
                        let opaque = get(value, "opaqueCompactionItem")
                            .filter(|value| compaction(value))
                            .cloned()
                            .or_else(|| {
                                string(value, "compactionEncryptedContent").map(|encrypted| {
                                    let mut value = json::object([
                                        ("type", s("compaction")),
                                        ("encrypted_content", s(encrypted.clone())),
                                    ]);
                                    if let Some(id) = part
                                        .provider_metadata
                                        .as_ref()
                                        .and_then(|value| get(value, "openai"))
                                        .and_then(|value| string(value, "itemId"))
                                        .filter(|value| !value.is_empty())
                                    {
                                        json::set(&mut value, "id", s(id.clone()));
                                    }
                                    value
                                })
                            });
                        if let Some(opaque) = opaque {
                            if store != Some(false)
                                && let Some(id) =
                                    string(&opaque, "id").filter(|value| !value.is_empty())
                            {
                                if !compactions.contains(id) {
                                    input.push(json::object([
                                        ("type", s("item_reference")),
                                        ("id", s(id.clone())),
                                    ]));
                                    compactions.push(id.clone());
                                }
                                continue;
                            }
                            input.push(opaque);
                            continue;
                        }
                        let Some(id) = string(value, "itemId").filter(|value| !value.is_empty())
                        else {
                            continue;
                        };
                        if store != Some(false) {
                            if !references.contains(id) {
                                input.push(json::object([
                                    ("type", s("item_reference")),
                                    ("id", s(id.clone())),
                                ]));
                                references.push(id.clone());
                            }
                            continue;
                        }
                        let summary = if part.text.is_empty() {
                            Vec::new()
                        } else {
                            vec![json::object([
                                ("type", s("summary_text")),
                                ("text", s(part.text.clone())),
                            ])]
                        };
                        let encrypted = get(value, "reasoningEncryptedContent").filter(|value| {
                            matches!(value, JsonValue::String(_) | JsonValue::Null)
                        });
                        if let Some(index) = reasoning_items.get(id).copied() {
                            let existing: &mut JsonValue = &mut input[index];
                            let mut summaries = get(existing, "summary")
                                .and_then(json::array)
                                .unwrap_or(&[])
                                .to_vec();
                            summaries.extend(summary);
                            json::set(existing, "summary", JsonValue::Array(summaries));
                            if let Some(encrypted) =
                                encrypted.filter(|value| matches!(value, JsonValue::String(_)))
                            {
                                json::set(existing, "encrypted_content", encrypted.clone());
                            }
                            continue;
                        }
                        let mut item = json::object([
                            ("type", s("reasoning")),
                            ("summary", JsonValue::Array(summary)),
                        ]);
                        if let Some(encrypted) = encrypted {
                            json::set(&mut item, "encrypted_content", encrypted.clone());
                        }
                        reasoning_items.insert(id.clone(), input.len());
                        input.push(item);
                    }
                    Part::ToolCall(call) => {
                        flush_text(&mut input, &mut text);
                        if call.provider_executed != Some(true) {
                            input.push(json::object([
                                ("type", s("function_call")),
                                ("call_id", s(call.id.clone())),
                                ("name", s(call.name.clone())),
                                ("arguments", s(stringify_json(&call.input))),
                            ]));
                        }
                    }
                    Part::ToolResult(result) if result.provider_executed == Some(true) => {
                        flush_text(&mut input, &mut text);
                        let id = result
                            .provider_metadata
                            .as_ref()
                            .and_then(|value| get(value, "openai"))
                            .and_then(|value| string(value, "itemId"))
                            .filter(|value| !value.is_empty());
                        if store != Some(false)
                            && let Some(id) = id
                            && !hosted.contains(id)
                        {
                            input.push(json::object([
                                ("type", s("item_reference")),
                                ("id", s(id.clone())),
                            ]));
                        }
                        if store == Some(false) {
                            if matches!(
                                result.name.as_str(),
                                Some("web_search" | "web_search_preview")
                            ) && let ToolResultValue::Json(item) = &result.result
                                && matches!(
                                    get(item, "type").and_then(json::text),
                                    Some("web_search_call" | "web_search_preview_call")
                                )
                                && string(item, "id").is_some()
                            {
                                input.push(item.clone());
                            }
                            if result.name.as_str() == Some("image_generation")
                                && let ToolResultValue::Content(content) = &result.result
                            {
                                input.push(json::object([
                                    ("role", s("user")),
                                    (
                                        "content",
                                        JsonValue::Array(
                                            content
                                                .iter()
                                                .map(|item| content_item(item, detail, false))
                                                .collect(),
                                        ),
                                    ),
                                ]));
                            }
                        }
                        if let Some(id) = id {
                            hosted.push(id.clone());
                        }
                    }
                    _ => {
                        return Err(Error::invalid(
                            "OpenAI Responses assistant messages only support text, reasoning, tool-call, and tool-result content for now",
                        ));
                    }
                }
            }
            flush_text(&mut input, &mut text);
            continue;
        }
        for part in &message.content {
            let Part::ToolResult(part) = part else {
                return Err(Error::invalid(
                    "OpenAI Responses tool messages only support tool-result content for now",
                ));
            };
            let output = if let ToolResultValue::Content(content) = &part.result {
                let index = if marked && part.cache.is_some() {
                    content.iter().rposition(|value|matches!(value,ToolContent::Text(part) if json::nonblank(&part.text)))
                } else {
                    None
                };
                JsonValue::Array(
                    content
                        .iter()
                        .enumerate()
                        .map(|(i, item)| content_item(item, detail, index == Some(i)))
                        .collect(),
                )
            } else {
                let text = part.result.to_text();
                if marked && part.cache.is_some() && json::nonblank(&text) {
                    JsonValue::Array(vec![text_block(text, true)])
                } else {
                    s(text)
                }
            };
            input.push(json::object([
                ("type", s("function_call_output")),
                ("call_id", s(part.id.clone())),
                ("output", output),
            ]));
        }
    }
    if store == Some(false) {
        input.retain(|value| {
            get(value, "type").and_then(json::text) != Some("reasoning")
                || string(value, "encrypted_content").is_some()
        });
    }
    let mut body = json::object([
        ("model", s(request.model.id.clone())),
        ("input", JsonValue::Array(input)),
    ]);
    if !request.tools.is_empty() {
        json::set(
            &mut body,
            "tools",
            JsonValue::Array(
                request
                    .tools
                    .iter()
                    .map(|tool| lower_tool(tool, request))
                    .collect::<Result<Vec<_>, _>>()?,
            ),
        );
    }
    if let Some(choice) = &request.tool_choice {
        json::set(
            &mut body,
            "tool_choice",
            tool_choice(choice, true, &request.tools)?,
        );
    }
    if ["openai-codex-responses", "openai-codex-websocket-responses"]
        .contains(&request.model.route.id.as_str())
        && openai_options::value(request, "parallelToolCalls").and_then(json::boolean) == Some(true)
    {
        json::set(&mut body, "parallel_tool_calls", JsonValue::Bool(true));
    }
    json::set(&mut body, "stream", JsonValue::Bool(true));
    for (key, value) in [
        ("max_output_tokens", request.generation.max_tokens),
        ("temperature", request.generation.temperature),
        ("top_p", request.generation.top_p),
    ] {
        if let Some(value) = value {
            json::set(&mut body, key, JsonValue::Number(value));
        }
    }
    Ok(pick(
        &json::merge(&body, &openai_options::lower(request, true)),
        &[
            "model",
            "input",
            "instructions",
            "tools",
            "parallel_tool_calls",
            "tool_choice",
            "store",
            "previous_response_id",
            "service_tier",
            "prompt_cache_key",
            "prompt_cache_retention",
            "prompt_cache_options",
            "context_management",
            "include",
            "reasoning",
            "text",
            "max_output_tokens",
            "temperature",
            "top_p",
            "stream",
        ],
    ))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SummaryState {
    Active,
    CanConclude,
    Concluded,
}
#[derive(Default)]
struct ReasoningItem {
    encrypted: Option<JsonValue>,
    parts: BTreeMap<String, SummaryState>,
}
#[derive(Default)]
pub struct Parser {
    store: Option<bool>,
    remote: bool,
    tools: Tools,
    function_call: bool,
    lifecycle: Lifecycle,
    text: BTreeMap<LosslessString, LosslessString>,
    phases: BTreeMap<LosslessString, LosslessString>,
    reasoning: BTreeMap<LosslessString, ReasoningItem>,
    reasoning_observed: bool,
    terminal: bool,
}
fn indexed_id(id: &LosslessString, index: &str) -> LosslessString {
    join([id.clone(), index.into()], ":")
}
fn text_id(event: &JsonValue) -> LosslessString {
    let id = string(event, "item_id")
        .cloned()
        .unwrap_or_else(|| "text-0".into());
    let index = get(event, "content_index")
        .and_then(json::number)
        .filter(|value| *value != 0.0);
    index
        .map(|index| indexed_id(&id, &index.to_string()))
        .unwrap_or(id)
}
fn reasoning_metadata(id: &LosslessString, encrypted: Option<&JsonValue>) -> Option<JsonValue> {
    metadata(json::object([
        ("itemId", s(id.clone())),
        (
            "reasoningEncryptedContent",
            encrypted
                .filter(|value| !matches!(value, JsonValue::Null))
                .cloned()
                .unwrap_or(JsonValue::Null),
        ),
    ]))
}
impl Parser {
    fn phase_metadata(&self, id: &LosslessString) -> Option<JsonValue> {
        self.phases
            .get(id)
            .and_then(|phase| metadata(json::object([("phase", s(phase.clone()))])))
    }
    fn text_done(&mut self, event: &JsonValue, events: &mut Vec<Event>) -> Result<(), Error> {
        let id = text_id(event);
        let item = string(event, "item_id")
            .cloned()
            .unwrap_or_else(|| "text-0".into());
        let previous = self.text.get(&id).cloned().unwrap_or_default();
        let text = string(event, "text")
            .cloned()
            .unwrap_or_else(|| previous.clone());
        let units = text.code_units().collect::<Vec<_>>();
        let prior = previous.code_units().collect::<Vec<_>>();
        if !units.starts_with(&prior) {
            return Err(Error::output(
                "Completed output text contradicts streamed text",
            ));
        }
        let suffix = LosslessString::from_utf16(units[prior.len()..].to_vec());
        if !suffix.is_empty() && !previous.is_empty() && !self.lifecycle.text.contains(&id) {
            return Err(Error::output("Provider changed completed output text"));
        }
        let metadata = self.phase_metadata(&item);
        if !suffix.is_empty() {
            self.lifecycle
                .text_delta(events, id.clone(), suffix, metadata.clone());
        }
        self.text.insert(id.clone(), text);
        self.lifecycle.end(events, &id, false, metadata);
        Ok(())
    }
    fn output_done(&mut self, item: &JsonValue, events: &mut Vec<Event>) -> Result<(), Error> {
        let kind = get(item, "type").and_then(json::text).unwrap_or("");
        let id = string(item, "id").filter(|value| !value.is_empty());
        if kind == "message" {
            if let Some(id) = id {
                if let Some(phase) = string(item, "phase") {
                    self.phases.insert(id.clone(), phase.clone());
                }
                for (index, part) in get(item, "content")
                    .and_then(json::array)
                    .unwrap_or(&[])
                    .iter()
                    .enumerate()
                {
                    if get(part, "type").and_then(json::text) == Some("output_text")
                        && string(part, "text").is_some()
                    {
                        self.text_done(
                            &json::object([
                                ("item_id", s(id.clone())),
                                ("content_index", JsonValue::Number(index as f64)),
                                (
                                    "text",
                                    get(part, "text").cloned().unwrap_or(JsonValue::Null),
                                ),
                            ]),
                            events,
                        )?;
                    }
                }
                self.text_done(&json::object([("item_id", s(id.clone()))]), events)?;
                self.phases.remove(id);
            }
            return Ok(());
        }
        if kind == "function_call" {
            if let (Some(id), Some(call), Some(name)) = (
                id,
                string(item, "call_id").filter(|value| !value.is_empty()),
                string(item, "name").filter(|value| !value.is_empty()),
            ) {
                if self.tools.get(id).is_none() {
                    self.tools.start(
                        id.clone(),
                        PendingTool {
                            id: call.clone(),
                            name: name.clone(),
                            input: LosslessString::default(),
                            metadata: None,
                        },
                    );
                }
                let result = self.tools.finish(id, string(item, "arguments").cloned());
                if !result.is_empty() {
                    self.lifecycle.start(events);
                    self.function_call |= result.iter().any(|event| {
                        matches!(event, Event::ToolCall(_) | Event::ToolInputError { .. })
                    });
                    events.extend(result);
                }
            }
            return Ok(());
        }
        if compaction(item) {
            let id = id.cloned().unwrap_or_else(|| "compaction-0".into());
            let metadata = metadata(json::object([("opaqueCompactionItem", item.clone())]));
            self.lifecycle
                .reasoning_start(events, id.clone(), metadata.clone());
            self.lifecycle.end(events, &id, true, metadata);
            return Ok(());
        }
        if let Some(id) = id {
            if kind == "reasoning" {
                let metadata = reasoning_metadata(id, get(item, "encrypted_content"));
                if let Some(reasoning) = self.reasoning.remove(id) {
                    for (index, status) in reasoning.parts {
                        if matches!(status, SummaryState::Active | SummaryState::CanConclude) {
                            self.lifecycle.end(
                                events,
                                &indexed_id(id, &index),
                                true,
                                metadata.clone(),
                            );
                        }
                    }
                } else if self.lifecycle.reasoning.contains(id) {
                    self.lifecycle.end(events, id, true, metadata);
                } else {
                    self.lifecycle
                        .reasoning_start(events, id.clone(), metadata.clone());
                    self.lifecycle.end(events, id, true, metadata);
                }
                return Ok(());
            }
            if let Some((name, input)) = hosted_input(item) {
                self.lifecycle.start(events);
                let metadata = metadata(json::object([("itemId", s(id.clone()))]));
                events.push(Event::ToolCall(ToolCall {
                    id: id.clone(),
                    name: name.into(),
                    input,
                    provider_executed: Some(true),
                    provider_metadata: metadata.clone(),
                }));
                events.push(Event::ToolResult(ToolResult {
                    id: id.clone(),
                    name: name.into(),
                    result: hosted_result(item)?,
                    cache: None,
                    provider_executed: Some(true),
                    provider_metadata: metadata,
                    output: None,
                }));
            }
        }
        Ok(())
    }
    fn push_event(&mut self, event: &JsonValue) -> Result<Vec<Event>, Error> {
        validate_event(event)?;
        if self.terminal {
            return Err(Error::output(
                "Provider emitted an event after the terminal event",
            ));
        }
        let kind = get(event, "type").and_then(json::text).unwrap_or("");
        let mut events = Vec::new();
        match kind {
            "response.output_text.delta" => {
                if let Some(delta) = string(event, "delta").filter(|value| !value.is_empty()) {
                    let id = text_id(event);
                    json::concat(self.text.entry(id.clone()).or_default(), delta);
                    let item = string(event, "item_id")
                        .cloned()
                        .unwrap_or_else(|| "text-0".into());
                    let metadata = self.phase_metadata(&item);
                    self.lifecycle
                        .text_delta(&mut events, id, delta.clone(), metadata);
                }
            }
            "response.output_text.annotation.added" => {
                if let Some(annotation) = get(event, "annotation")
                    && get(annotation, "type").and_then(json::text) == Some("url_citation")
                    && let (Some(title), Some(url)) = (
                        string(annotation, "title").filter(|value| !value.is_empty()),
                        string(annotation, "url").filter(|value| !value.is_empty()),
                    )
                {
                    let text = join(
                        [
                            "\n\nSource: ".into(),
                            title.clone(),
                            "\n".into(),
                            url.clone(),
                        ],
                        "",
                    );
                    let item = string(event, "item_id")
                        .cloned()
                        .unwrap_or_else(|| "text-0".into());
                    let metadata = self.phase_metadata(&item);
                    self.lifecycle
                        .text_delta(&mut events, text_id(event), text, metadata);
                }
            }
            "response.output_text.done" => self.text_done(event, &mut events)?,
            "response.content_part.done" => {
                if let Some(part) = get(event, "part")
                    .filter(|value| get(value, "type").and_then(json::text) == Some("output_text"))
                {
                    let mut event = event.clone();
                    if let Some(text) = get(part, "text") {
                        json::set(&mut event, "text", text.clone());
                    }
                    self.text_done(&event, &mut events)?;
                }
            }
            "response.reasoning_text.delta"
            | "response.reasoning_summary.delta"
            | "response.reasoning_summary_text.delta" => {
                if let Some(delta) = string(event, "delta").filter(|value| !value.is_empty()) {
                    let item = string(event, "item_id")
                        .cloned()
                        .unwrap_or_else(|| "reasoning-0".into());
                    let index = get(event, "summary_index").and_then(json::number);
                    let id = if index.is_some() || self.reasoning.contains_key(&item) {
                        indexed_id(&item, &index.unwrap_or(0.0).to_string())
                    } else {
                        item
                    };
                    self.lifecycle
                        .reasoning_delta(&mut events, id, delta.clone(), None);
                    self.reasoning_observed = true;
                }
            }
            "response.output_item.added" => {
                if let Some(item) = get(event, "item") {
                    let kind = get(item, "type").and_then(json::text);
                    if let Some(id) = string(item, "id").filter(|value| !value.is_empty()) {
                        match kind {
                            Some("message") => {
                                if let Some(phase) = string(item, "phase") {
                                    self.phases.insert(id.clone(), phase.clone());
                                }
                            }
                            Some("reasoning") => {
                                self.lifecycle.reasoning_start(
                                    &mut events,
                                    indexed_id(id, "0"),
                                    reasoning_metadata(id, get(item, "encrypted_content")),
                                );
                                self.reasoning.insert(
                                    id.clone(),
                                    ReasoningItem {
                                        encrypted: get(item, "encrypted_content").cloned(),
                                        parts: BTreeMap::from([("0".into(), SummaryState::Active)]),
                                    },
                                );
                            }
                            Some("function_call") => {
                                self.lifecycle.start(&mut events);
                                let metadata = metadata(json::object([("itemId", s(id.clone()))]));
                                let call = string(item, "call_id")
                                    .cloned()
                                    .unwrap_or_else(|| id.clone());
                                let name = string(item, "name").cloned().unwrap_or_default();
                                self.tools.start(
                                    id.clone(),
                                    PendingTool {
                                        id: call.clone(),
                                        name: name.clone(),
                                        input: string(item, "arguments")
                                            .cloned()
                                            .unwrap_or_default(),
                                        metadata: metadata.clone(),
                                    },
                                );
                                events.push(Event::ToolInputStart(ToolInputEvent {
                                    id: call,
                                    name,
                                    provider_executed: None,
                                    provider_metadata: metadata,
                                }));
                            }
                            _ => {}
                        }
                    }
                }
            }
            "response.reasoning_summary_part.added" => {
                if let (Some(id), Some(index)) = (
                    string(event, "item_id").filter(|value| !value.is_empty()),
                    get(event, "summary_index").and_then(json::number),
                ) {
                    if index == 0.0 && self.reasoning.contains_key(id) {
                        return Ok(events);
                    }
                    let mut item = self.reasoning.remove(id).unwrap_or_default();
                    if index != 0.0 {
                        for (index, state) in &mut item.parts {
                            if *state == SummaryState::CanConclude {
                                self.lifecycle.end(
                                    &mut events,
                                    &indexed_id(id, index),
                                    true,
                                    metadata(json::object([("itemId", s(id.clone()))])),
                                );
                                *state = SummaryState::Concluded;
                            }
                        }
                    }
                    let index = index.to_string();
                    self.lifecycle.reasoning_start(
                        &mut events,
                        indexed_id(id, &index),
                        reasoning_metadata(id, item.encrypted.as_ref()),
                    );
                    item.parts.insert(index, SummaryState::Active);
                    self.reasoning.insert(id.clone(), item);
                }
            }
            "response.reasoning_summary_part.done" => {
                if let (Some(id), Some(index)) = (
                    string(event, "item_id"),
                    get(event, "summary_index").and_then(json::number),
                ) && let Some(item) = self.reasoning.get_mut(id)
                {
                    let index = index.to_string();
                    if self.store != Some(false) {
                        self.lifecycle.end(
                            &mut events,
                            &indexed_id(id, &index),
                            true,
                            metadata(json::object([("itemId", s(id.clone()))])),
                        );
                    }
                    item.parts.insert(
                        index,
                        if self.store == Some(false) {
                            SummaryState::CanConclude
                        } else {
                            SummaryState::Concluded
                        },
                    );
                }
            }
            "response.function_call_arguments.delta" => {
                if let (Some(id), Some(delta)) = (
                    string(event, "item_id").filter(|value| !value.is_empty()),
                    string(event, "delta").filter(|value| !value.is_empty()),
                ) {
                    let deltas = self.tools.append(id, delta)?;
                    if !deltas.is_empty() {
                        self.lifecycle.start(&mut events);
                    }
                    events.extend(deltas);
                }
            }
            "response.output_item.done" => {
                if let Some(item) = get(event, "item") {
                    self.output_done(item, &mut events)?;
                }
            }
            "response.completed" | "response.incomplete" => {
                let response = get(event, "response");
                for item in response
                    .and_then(|value| get(value, "output"))
                    .and_then(json::array)
                    .unwrap_or(&[])
                {
                    if get(item, "type").and_then(json::text) == Some("message") {
                        self.output_done(item, &mut events)?;
                    }
                }
                let reason = match response
                    .and_then(|value| get(value, "incomplete_details"))
                    .and_then(|value| get(value, "reason"))
                    .and_then(json::text)
                {
                    None => {
                        if self.function_call {
                            FinishReason::ToolCalls
                        } else {
                            FinishReason::Stop
                        }
                    }
                    Some("max_output_tokens") => FinishReason::Length,
                    Some("content_filter") => FinishReason::ContentFilter,
                    _ => {
                        if self.function_call {
                            FinishReason::ToolCalls
                        } else {
                            FinishReason::Unknown
                        }
                    }
                };
                let usage = response
                    .and_then(|value| get(value, "usage"))
                    .filter(|value| !matches!(value, JsonValue::Null))
                    .map(|value| openai_shared::usage(value, false, self.reasoning_observed, None));
                let mut extra = json::empty();
                if let Some(response) = response {
                    for (key, wire) in [("id", "responseId"), ("service_tier", "serviceTier")] {
                        if let Some(value) = get(response, key) {
                            json::set(&mut extra, wire, value.clone());
                        }
                    }
                }
                if self.remote {
                    json::set(
                        &mut extra,
                        "remoteCompactionCompleted",
                        JsonValue::Bool(kind == "response.completed"),
                    );
                }
                let metadata = if self.remote
                    || response.is_some_and(|value| {
                        string(value, "id").is_some_and(|value| !value.is_empty())
                            || string(value, "service_tier").is_some_and(|value| !value.is_empty())
                    }) {
                    metadata(extra)
                } else {
                    None
                };
                self.lifecycle.finish(
                    &mut events,
                    Finish {
                        reason,
                        usage,
                        provider_metadata: metadata,
                    },
                );
                self.terminal = true;
            }
            "response.failed" | "error" => {
                let nested = get(event, "error")
                    .filter(|value| !matches!(value, JsonValue::Null))
                    .or_else(|| {
                        get(event, "response")
                            .and_then(|value| get(value, "error"))
                            .filter(|value| !matches!(value, JsonValue::Null))
                    });
                let code = string(event, "code")
                    .filter(|value| !value.is_empty())
                    .or_else(|| {
                        nested
                            .and_then(|value| string(value, "code"))
                            .filter(|value| !value.is_empty())
                    });
                let message = string(event, "message")
                    .filter(|value| !value.is_empty())
                    .or_else(|| {
                        nested
                            .and_then(|value| string(value, "message"))
                            .filter(|value| !value.is_empty())
                    });
                let text = match (code, message) {
                    (Some(code), Some(message)) => join([code.clone(), message.clone()], ": "),
                    (code, message) => code.or(message).cloned().unwrap_or_else(|| {
                        if kind == "response.failed" {
                            "OpenAI Responses response failed".into()
                        } else {
                            "OpenAI Responses stream error".into()
                        }
                    }),
                };
                return Err(classify(Failure {
                    message: text
                        .as_str()
                        .map(String::from)
                        .unwrap_or_else(|| stringify_json(&s(text.clone()))),
                    code: code.and_then(LosslessString::as_str).map(String::from),
                    ..Failure::default()
                }));
            }
            _ => {}
        }
        Ok(events)
    }
}
impl StreamParser for Parser {
    fn push(&mut self, event: &JsonValue) -> Result<Vec<Event>, Error> {
        self.push_event(event)
    }
    fn finish(&mut self) -> Result<Vec<Event>, Error> {
        if self.terminal {
            Ok(Vec::new())
        } else {
            Err(Error::missing_terminal())
        }
    }
}
fn hosted_input(item: &JsonValue) -> Option<(&'static str, JsonValue)> {
    match get(item, "type").and_then(json::text) {
        Some("web_search_call") => Some((
            "web_search",
            get(item, "action")
                .cloned()
                .filter(|value| !matches!(value, JsonValue::Null))
                .unwrap_or_else(json::empty),
        )),
        Some("web_search_preview_call") => Some((
            "web_search_preview",
            get(item, "action")
                .cloned()
                .filter(|value| !matches!(value, JsonValue::Null))
                .unwrap_or_else(json::empty),
        )),
        Some("file_search_call") => Some((
            "file_search",
            json::object([(
                "queries",
                get(item, "queries")
                    .cloned()
                    .filter(|value| !matches!(value, JsonValue::Null))
                    .unwrap_or_else(|| JsonValue::Array(Vec::new())),
            )]),
        )),
        Some("code_interpreter_call") => {
            Some(("code_interpreter", pick(item, &["code", "container_id"])))
        }
        Some("computer_use_call") => Some((
            "computer_use",
            get(item, "action")
                .cloned()
                .filter(|value| !matches!(value, JsonValue::Null))
                .unwrap_or_else(json::empty),
        )),
        Some("image_generation_call") => Some(("image_generation", json::empty())),
        Some("mcp_call") => Some(("mcp", pick(item, &["server_label", "name", "arguments"]))),
        Some("local_shell_call") => Some((
            "local_shell",
            get(item, "action")
                .cloned()
                .filter(|value| !matches!(value, JsonValue::Null))
                .unwrap_or_else(json::empty),
        )),
        _ => None,
    }
}
fn hosted_result(item: &JsonValue) -> Result<ToolResultValue, Error> {
    if get(item, "type").and_then(json::text) == Some("image_generation_call")
        && let Some(result) = string(item, "result").filter(|value| !value.is_empty())
    {
        let result = result
            .as_str()
            .ok_or_else(|| Error::output("OpenAI Responses returned invalid image base64"))?;
        crate::media::decode(&result.replace(['\r', '\n'], ""))
            .map_err(|_| Error::output("OpenAI Responses returned invalid image base64"))?;
        let format = get(item, "output_format")
            .and_then(json::text)
            .unwrap_or("png");
        return Ok(ToolResultValue::Content(vec![ToolContent::File(
            ToolFileContent {
                uri: format!("data:image/{format};base64,{result}").into(),
                mime: format!("image/{format}").into(),
                name: None,
            },
        )]));
    }
    Ok(
        if let Some(error) = get(item, "error").filter(|value| !matches!(value, JsonValue::Null)) {
            ToolResultValue::Error(error.clone())
        } else {
            ToolResultValue::Json(item.clone())
        },
    )
}
fn validate_event(event: &JsonValue) -> Result<(), Error> {
    let valid = string(event, "type").is_some()
        && validate(
            event,
            &["type", "delta", "text", "item_id", "message"],
            &["code", "param"],
            &["content_index", "summary_index"],
        )
        && get(event, "part").is_none_or(|value| {
            string(value, "type").is_some() && validate(value, &["text"], &[], &[])
        })
        && get(event, "annotation").is_none_or(|value| {
            string(value, "type").is_some() && validate(value, &["title", "url"], &[], &[])
        })
        && get(event, "item").is_none_or(valid_item)
        && get(event, "error").is_none_or(valid_error)
        && get(event, "response").is_none_or(|value| {
            validate(value, &["id"], &["service_tier"], &[])
                && get(value, "error").is_none_or(valid_error)
                && get(value, "incomplete_details").is_none_or(|value| {
                    matches!(value, JsonValue::Null) || string(value, "reason").is_some()
                })
                && get(value, "output").is_none_or(|value| {
                    json::array(value).is_some_and(|values| values.iter().all(valid_item))
                })
                && get(value, "usage").is_none_or(valid_usage)
        });
    if valid {
        Ok(())
    } else {
        Err(Error::output("Invalid openai-responses stream event"))
    }
}
fn valid_error(value: &JsonValue) -> bool {
    matches!(value, JsonValue::Null) || validate(value, &[], &["code", "message", "param"], &[])
}
fn valid_usage(value: &JsonValue) -> bool {
    matches!(value, JsonValue::Null)
        || validate(
            value,
            &[],
            &[],
            &["input_tokens", "output_tokens", "total_tokens"],
        ) && ["input_tokens_details", "output_tokens_details"]
            .iter()
            .all(|key| {
                get(value, key).is_none_or(|value| {
                    matches!(value, JsonValue::Null)
                        || validate(
                            value,
                            &[],
                            &[],
                            if *key == "input_tokens_details" {
                                &["cached_tokens", "cache_write_tokens"]
                            } else {
                                &["reasoning_tokens"]
                            },
                        )
                })
            })
}
fn valid_item(value: &JsonValue) -> bool {
    string(value, "type").is_some()
        && validate(
            value,
            &[
                "type",
                "id",
                "call_id",
                "name",
                "arguments",
                "status",
                "code",
                "container_id",
                "server_label",
                "result",
            ],
            &["encrypted_content"],
            &[],
        )
        && allowed(value, "phase", &["commentary", "final_answer"])
        && allowed(value, "output_format", &["png", "jpeg", "webp"])
}
pub fn websocket_message(body: &JsonValue) -> Result<JsonValue, Error> {
    if !matches!(body, JsonValue::Object(_)) {
        return Err(Error::invalid(
            "OpenAI Responses WebSocket body must be a JSON object",
        ));
    }
    Ok(json::merge(
        &json::object([("type", s("response.create"))]),
        &json::remove(body, &["stream", "type"]),
    ))
}
pub fn websocket_transport() -> JsonTransport {
    let mut transport = JsonTransport::new(websocket_message);
    transport.continuation = Some(Continuation {
        session: Arc::new(|request| {
            let value = openai_options::value(request, "responsesWebSocket")?;
            let key = string(value, "sessionKey")
                .and_then(LosslessString::as_str)
                .filter(|value| !value.is_empty())?;
            let fingerprint = string(value, "fingerprint")
                .and_then(LosslessString::as_str)
                .filter(|value| !value.is_empty())?;
            Some(SessionMetadata {
                key: key.into(),
                fingerprint: fingerprint.into(),
                message_boundary: openai_options::safe_integer(get(value, "messageBoundary"))?,
                full_replay: get(value, "fullReplay").and_then(json::boolean) == Some(true),
            })
        }),
        replay_message: Arc::new(|request, count| {
            let mut request = request.clone();
            request.messages.truncate(count);
            websocket_message(&lower(&request)?)
        }),
        delta_message: Arc::new(|request, start| {
            let mut request = request.clone();
            request.messages = request.messages.get(start..).unwrap_or(&[]).to_vec();
            request.system.clear();
            websocket_message(&lower(&request)?)
        }),
        normalize_output: Arc::new(normalized_output),
    });
    transport
}
pub fn normalized_output(value: &JsonValue) -> Option<JsonValue> {
    let kind = get(value, "type").and_then(json::text)?;
    if kind == "message" {
        let content = get(value, "content")
            .and_then(json::array)?
            .iter()
            .filter(|value| {
                get(value, "type").and_then(json::text) == Some("output_text")
                    && string(value, "text").is_some()
            })
            .map(|value| pick(value, &["type", "text"]))
            .collect::<Vec<_>>();
        if content.is_empty() {
            return None;
        }
        let mut item = json::object([("role", s("assistant"))]);
        if let Some(phase) = string(value, "phase")
            .filter(|value| matches!(value.as_str(), Some("commentary" | "final_answer")))
        {
            json::set(&mut item, "phase", s(phase.clone()));
        }
        json::set(&mut item, "content", JsonValue::Array(content));
        return Some(item);
    }
    if kind == "function_call" {
        return ["call_id", "name", "arguments"]
            .iter()
            .all(|key| string(value, key).is_some())
            .then(|| pick(value, &["type", "call_id", "name", "arguments"]));
    }
    if kind == "reasoning" {
        return get(value, "summary")
            .and_then(json::array)
            .map(|_| pick(value, &["type", "summary", "encrypted_content"]));
    }
    Some(json::remove(value, &["id", "status"]))
}
