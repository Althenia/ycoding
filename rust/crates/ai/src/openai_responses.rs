use crate::{
    Error,
    json::{self, get, s},
    llm::{
        Event, Finish, FinishReason, Media, MediaData, Message, Part, Request, Role, ToolCall,
        ToolChoice, ToolDefinition, ToolInputEvent, ToolResult, ToolResultValue, Usage,
    },
    openai_options,
    openai_shared::{self, Lifecycle, PendingTool, Tools, join, metadata, pick, string, validate},
    provider_error::{Failure, classify},
    route::{Protocol, StreamParser},
    websocket::{Continuation, JsonTransport, SessionMetadata},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
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
    fn response_formats(&self) -> &'static [&'static str] {
        &["json"]
    }
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
    let copilot = request
        .provider_options
        .as_ref()
        .and_then(|value| get(value, "copilot"))
        .and_then(|value| get(value, "store"))
        .and_then(json::boolean);
    if openai_options::store(request) != Some(false)
        && !(request.model.route.id == "ai-sdk:@ai-sdk/github-copilot" && copilot == Some(false))
    {
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
fn assistant_phase(part: &crate::llm::TextPart) -> Option<&LosslessString> {
    part.provider_metadata
        .as_ref()
        .and_then(|value| get(value, "openai"))
        .and_then(|value| string(value, "phase"))
        .filter(|value| matches!(value.as_str(), Some("commentary" | "final_answer")))
}
fn flush_text(input: &mut Vec<JsonValue>, text: &mut Vec<&crate::llm::TextPart>) {
    if text.is_empty() {
        return;
    }
    let phase = text.first().and_then(|part| assistant_phase(part));
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
    let continuation =
        store == Some(true) && openai_options::previous_response_id(request).is_some();
    let mut input = Vec::new();
    if !continuation && !request.system.is_empty() {
        let text = join(request.system.iter().map(|part| part.text.clone()), "\n");
        let content = if marked && request.system.iter().any(|part| part.cache.is_some()) {
            JsonValue::Array(vec![text_block(text, true)])
        } else {
            s(text)
        };
        input.push(json::object([("role", s("system")), ("content", content)]));
    }
    let start = if continuation {
        openai_options::safe_integer(openai_options::value(request, "continuationInputStart"))
            .unwrap_or(0)
            .min(request.messages.len())
    } else {
        0
    };
    for message in prune_messages(request).iter().skip(start) {
        let provider =
            if crate::effort::update(message, crate::effort::Provider::OpenRouter).is_some() {
                crate::effort::Provider::OpenRouter
            } else {
                crate::effort::Provider::OpenAI
            };
        if let Some(effort) = crate::effort::update(message, provider) {
            if crate::effort::mechanism(request) != Some(provider)
                || message.role != Role::System
                || !message.content.is_empty()
            {
                return Err(Error::invalid(
                    "OpenAI effort update requires a supported public GPT-6 Responses request",
                ));
            }
            if input
                .last()
                .and_then(|value| get(value, "type"))
                .and_then(json::text)
                == Some("configuration_update")
            {
                return Err(Error::invalid("OpenAI effort updates cannot be adjacent"));
            }
            input.push(json::object([
                ("type", s("configuration_update")),
                ("reasoning", json::object([("effort", s(effort))])),
            ]));
            continue;
        }
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
                || [
                    "openai-responses",
                    "openai-responses-websocket",
                    "github-copilot-responses",
                ]
                .contains(&request.model.route.id.as_str())
                    && openai_options::gpt56(&request.model.id);
            if native {
                let content=message.content.iter().map(|part|if let Part::Text(part)=part {Ok(text_block(part.text.clone(),marked && part.cache.is_some()))}else {Err(Error::invalid("OpenAI Responses system messages only support text content for now"))}).collect::<Result<Vec<_>,_>>()?;
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
            if !message.volatile
                && let Some(previous) = input.last_mut()
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
            let mut text: Vec<&crate::llm::TextPart> = Vec::new();
            let mut reasoning_items = BTreeMap::new();
            let mut references = Vec::new();
            let mut compactions = Vec::new();
            let mut hosted = Vec::new();
            for part in &message.content {
                match part {
                    Part::Text(part) => {
                        if text.last().is_some_and(|previous| {
                            assistant_phase(previous) != assistant_phase(part)
                        }) {
                            flush_text(&mut input, &mut text);
                        }
                        text.push(part);
                    }
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
    if let Some(schema) = crate::structured_output::request_schema(request) {
        json::set(
            &mut body,
            "text",
            json::object([(
                "format",
                json::object([
                    ("type", s("json_schema")),
                    ("name", s("response")),
                    ("schema", schema),
                    ("strict", JsonValue::Bool(true)),
                ]),
            )]),
        );
    }
    let mut body = json::merge(&body, &openai_options::lower(request, true));
    let active_reasoning = get(&body, "reasoning")
        .and_then(|reasoning| get(reasoning, "effort"))
        .and_then(json::text)
        .is_some_and(|effort| effort != "none");
    if (active_reasoning
        || ["openai-codex-responses", "openai-codex-websocket-responses"]
            .contains(&request.model.route.id.as_str()))
        && let JsonValue::Object(fields) = &mut body
    {
        let mut filtered = ycoding_schema::JsonObject::new();
        for (key, value) in fields
            .iter()
            .filter(|(key, _)| key.as_str() != Some("temperature"))
        {
            filtered.insert(key.clone(), value.clone());
        }
        *fields = filtered;
    }
    Ok(pick(
        &body,
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

#[derive(Default)]
struct ReasoningItem {
    encrypted: Option<JsonValue>,
    parts: BTreeMap<usize, LosslessString>,
}
#[derive(Default)]
pub struct Parser {
    remote: bool,
    tools: Tools,
    tool_arguments: BTreeMap<LosslessString, LosslessString>,
    tool_items: Vec<JsonValue>,
    settled_items: BTreeSet<LosslessString>,
    settled_calls: BTreeSet<LosslessString>,
    hosted_items: BTreeSet<LosslessString>,
    lifecycle: Lifecycle,
    text: BTreeMap<LosslessString, LosslessString>,
    phases: BTreeMap<LosslessString, LosslessString>,
    reasoning: BTreeMap<LosslessString, ReasoningItem>,
    reasoning_active: Option<(LosslessString, usize)>,
    reasoning_observed: bool,
    usage: Option<JsonValue>,
    terminal: bool,
    refused: bool,
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
fn suffix(
    previous: &LosslessString,
    final_value: &LosslessString,
    mismatch: &str,
) -> Result<LosslessString, Error> {
    let mut units = final_value.code_units();
    for unit in previous.code_units() {
        if units.next() != Some(unit) {
            return Err(Error::output(mismatch));
        }
    }
    Ok(LosslessString::from_utf16(units.collect()))
}
fn refusal(part: &JsonValue) -> bool {
    get(part, "type").and_then(json::text) == Some("refusal")
}
fn message_refusal(item: &JsonValue) -> bool {
    get(item, "type").and_then(json::text) == Some("message")
        && get(item, "content")
            .and_then(json::array)
            .is_some_and(|parts| parts.iter().any(refusal))
}
fn function_item_id(item: &JsonValue) -> Option<&LosslessString> {
    string(item, "id").filter(|id| !id.is_empty())
}
fn same_function_item(left: &JsonValue, right: &JsonValue) -> bool {
    match (function_item_id(left), function_item_id(right)) {
        (Some(left), Some(right)) => left == right,
        _ => string(left, "call_id")
            .filter(|id| !id.is_empty())
            .is_some_and(|id| string(right, "call_id") == Some(id)),
    }
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
        let suffix = suffix(
            &previous,
            &text,
            "Completed output text contradicts streamed text",
        )?;
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
    fn end_reasoning(&mut self, events: &mut Vec<Event>) {
        if let Some((id, index)) = self.reasoning_active.take() {
            let encrypted = self
                .reasoning
                .get(&id)
                .and_then(|item| item.encrypted.as_ref());
            self.lifecycle.end(
                events,
                &indexed_id(&id, &index.to_string()),
                true,
                reasoning_metadata(&id, encrypted),
            );
        }
    }
    fn reasoning_part(
        &mut self,
        id: &LosslessString,
        index: usize,
        delta: Option<&LosslessString>,
        snapshot: bool,
        events: &mut Vec<Event>,
    ) -> Result<(), Error> {
        let item = self.reasoning.entry(id.clone()).or_default();
        let previous = item.parts.get(&index);
        let active = self
            .reasoning_active
            .as_ref()
            .is_some_and(|(key, part)| key == id && *part == index);
        let chunk = match (delta, snapshot, previous) {
            (Some(text), true, Some(previous)) => suffix(
                previous,
                text,
                "Completed reasoning summary contradicts streamed reasoning",
            )?,
            (Some(text), _, _) => text.clone(),
            (None, _, _) => LosslessString::default(),
        };
        if !active && previous.is_some() {
            return if chunk.is_empty() {
                Ok(())
            } else {
                Err(Error::output("Provider changed a closed reasoning summary"))
            };
        }
        let metadata = reasoning_metadata(id, item.encrypted.as_ref());
        let text = item.parts.entry(index).or_default();
        if !chunk.is_empty() {
            json::concat(text, &chunk);
            self.reasoning_observed = true;
        }
        let block = indexed_id(id, &index.to_string());
        if !active {
            self.end_reasoning(events);
            self.lifecycle
                .reasoning_start(events, block.clone(), metadata);
            self.reasoning_active = Some((id.clone(), index));
        }
        if !chunk.is_empty() {
            self.lifecycle.reasoning_delta(events, block, chunk, None);
        }
        Ok(())
    }
    fn reasoning_item(
        &mut self,
        item: &JsonValue,
        id: &LosslessString,
        done: bool,
        events: &mut Vec<Event>,
    ) -> Result<(), Error> {
        let state = self.reasoning.entry(id.clone()).or_default();
        if let Some(encrypted) = string(item, "encrypted_content") {
            state.encrypted = Some(s(encrypted.clone()));
            self.reasoning_observed |= !encrypted.is_empty();
        }
        let has_parts = !state.parts.is_empty();
        if let Some(summary) = get(item, "summary").and_then(json::array) {
            for (index, part) in summary.iter().enumerate() {
                if get(part, "type").and_then(json::text) == Some("summary_text") {
                    self.reasoning_part(id, index, string(part, "text"), true, events)?;
                }
            }
        }
        if !has_parts
            && self
                .reasoning
                .get(id)
                .is_some_and(|item| item.parts.is_empty())
        {
            self.reasoning_part(id, 0, None, false, events)?;
        }
        if done
            && self
                .reasoning_active
                .as_ref()
                .is_some_and(|(key, _)| key == id)
        {
            self.end_reasoning(events);
        }
        Ok(())
    }
    fn start_tool(
        &mut self,
        item_id: Option<&LosslessString>,
        call: &LosslessString,
        name: &LosslessString,
        events: &mut Vec<Event>,
    ) -> Result<(), Error> {
        let id = item_id.unwrap_or(call);
        if let Some(tool) = self.tools.get(id) {
            return if &tool.id == call && &tool.name == name {
                Ok(())
            } else {
                Err(Error::output(
                    "OpenAI Responses changed a tool call identity",
                ))
            };
        }
        if self.settled_calls.contains(call)
            || self.tools.0.iter().any(|(_, tool)| &tool.id == call)
        {
            return Err(Error::output("OpenAI Responses reused a tool call ID"));
        }
        self.lifecycle.start(events);
        let metadata = item_id.and_then(|id| metadata(json::object([("itemId", s(id.clone()))])));
        self.tools.start(
            id.clone(),
            PendingTool {
                id: call.clone(),
                name: name.clone(),
                input: LosslessString::default(),
                metadata: metadata.clone(),
            },
        );
        events.push(Event::ToolInputStart(ToolInputEvent {
            id: call.clone(),
            name: name.clone(),
            provider_executed: None,
            provider_metadata: metadata,
        }));
        Ok(())
    }
    fn settle_tool(
        &mut self,
        item: &JsonValue,
        fallback: Option<&JsonValue>,
        events: &mut Vec<Event>,
    ) -> Result<(), Error> {
        let field = |key| string(item, key).or_else(|| fallback.and_then(|item| string(item, key)));
        let call = field("call_id").filter(|id| !id.is_empty());
        let item_id = function_item_id(item)
            .or_else(|| fallback.and_then(function_item_id))
            .or_else(|| {
                self.tools
                    .0
                    .iter()
                    .find(|(_, tool)| call == Some(&tool.id))
                    .map(|(id, _)| id)
            });
        let Some(id) = item_id.or(call) else {
            return Ok(());
        };
        if !self.settled_items.insert(id.clone())
            || field("status").is_some_and(|status| status.as_str() != Some("completed"))
        {
            return Ok(());
        }
        let pending = self.tools.get(id);
        let Some(call) = call
            .or_else(|| pending.map(|tool| &tool.id))
            .filter(|value| !value.is_empty())
        else {
            return Ok(());
        };
        let Some(name) = field("name")
            .or_else(|| pending.map(|tool| &tool.name))
            .filter(|value| !value.is_empty())
        else {
            return Ok(());
        };
        let Some(arguments) = field("arguments")
            .filter(|value| !value.is_empty())
            .or_else(|| {
                self.tool_arguments
                    .get(id)
                    .filter(|value| !value.is_empty())
            })
            .or_else(|| {
                pending
                    .map(|tool| &tool.input)
                    .filter(|value| !value.is_empty())
            })
        else {
            return Ok(());
        };
        let tail = if let Some(tool) = pending {
            suffix(
                &tool.input,
                arguments,
                "Completed tool arguments contradict streamed arguments",
            )?
        } else {
            arguments.clone()
        };
        let (id, item_id, call, name) = (id.clone(), item_id.cloned(), call.clone(), name.clone());
        self.start_tool(item_id.as_ref(), &call, &name, events)?;
        events.extend(self.tools.append(&id, &tail)?);
        events.extend(self.tools.finish(&id, None));
        self.settled_calls.insert(call);
        Ok(())
    }
    fn output_done(
        &mut self,
        item: &JsonValue,
        terminal: bool,
        events: &mut Vec<Event>,
    ) -> Result<(), Error> {
        let kind = get(item, "type").and_then(json::text).unwrap_or("");
        let id = string(item, "id").filter(|value| !value.is_empty());
        if kind == "message" {
            self.refused |= message_refusal(item);
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
            if id.is_some() || string(item, "call_id").is_some_and(|id| !id.is_empty()) {
                if let Some(prior) = self
                    .tool_items
                    .iter_mut()
                    .find(|prior| same_function_item(prior, item))
                {
                    *prior = json::merge(prior, item);
                } else {
                    self.tool_items.push(item.clone());
                }
            }
            return Ok(());
        }
        if compaction(item) {
            let id = id.cloned().unwrap_or_else(|| "compaction-0".into());
            if !self.hosted_items.insert(id.clone()) {
                return Ok(());
            }
            self.end_reasoning(events);
            let metadata = metadata(json::object([("opaqueCompactionItem", item.clone())]));
            self.lifecycle
                .reasoning_start(events, id.clone(), metadata.clone());
            self.lifecycle.end(events, &id, true, metadata);
            return Ok(());
        }
        if let Some(id) = id {
            if kind == "reasoning" {
                return self.reasoning_item(
                    item,
                    id,
                    terminal || string(item, "encrypted_content").is_some(),
                    events,
                );
            }
            if let Some((name, input)) = hosted_input(item)
                && !matches!(
                    get(item, "status").and_then(json::text),
                    Some("in_progress" | "searching" | "generating" | "queued" | "incomplete")
                )
                && self.hosted_items.insert(id.clone())
            {
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
        let usage = get(event, "response")
            .and_then(|value| get(value, "usage"))
            .filter(|value| !matches!(value, JsonValue::Null));
        if let Some(raw) = usage {
            let reported = openai_shared::usage(raw, false, self.reasoning_observed, None);
            if [
                reported.input_tokens,
                reported.output_tokens,
                reported.reasoning_tokens,
                reported.total_tokens,
            ]
            .iter()
            .any(Option::is_some)
            {
                self.usage = Some(raw.clone());
            }
        }
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
            "response.content_part.added" | "response.content_part.done" => {
                if let Some(part) = get(event, "part") {
                    self.refused |= refusal(part);
                    if kind != "response.content_part.done"
                        || get(part, "type").and_then(json::text) != Some("output_text")
                    {
                        return Ok(events);
                    }
                    let mut event = event.clone();
                    if let Some(text) = get(part, "text") {
                        json::set(&mut event, "text", text.clone());
                    }
                    self.text_done(&event, &mut events)?;
                }
            }
            "response.reasoning_text.delta"
            | "response.reasoning_summary.delta"
            | "response.reasoning_summary_text.delta"
            | "response.reasoning_text.done"
            | "response.reasoning_summary.done"
            | "response.reasoning_summary_text.done" => {
                let done = kind.ends_with(".done");
                if let Some(delta) = string(event, if done { "text" } else { "delta" })
                    .filter(|value| !value.is_empty())
                {
                    let item = string(event, "item_id")
                        .cloned()
                        .unwrap_or_else(|| "reasoning-0".into());
                    let index =
                        openai_options::safe_integer(get(event, "summary_index")).unwrap_or(0);
                    self.reasoning_part(&item, index, Some(delta), done, &mut events)?;
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
                                self.reasoning_item(item, id, false, &mut events)?;
                            }
                            Some("function_call") => {
                                if self.tools.get(id).is_none()
                                    && let (Some(call), Some(name)) =
                                        (string(item, "call_id"), string(item, "name"))
                                    && !call.is_empty()
                                    && !name.is_empty()
                                {
                                    self.start_tool(Some(id), call, name, &mut events)?;
                                    if let Some(args) = string(item, "arguments") {
                                        events.extend(self.tools.append(id, args)?);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            "response.reasoning_summary_part.added" | "response.reasoning_summary_part.done" => {
                if let (Some(id), Some(index)) = (
                    string(event, "item_id").filter(|value| !value.is_empty()),
                    openai_options::safe_integer(get(event, "summary_index")),
                ) {
                    self.reasoning_part(
                        id,
                        index,
                        get(event, "part").and_then(|part| string(part, "text")),
                        true,
                        &mut events,
                    )?;
                }
            }
            "response.function_call_arguments.done" => {
                if let (Some(id), Some(arguments)) =
                    (string(event, "item_id"), string(event, "arguments"))
                {
                    self.tool_arguments.insert(id.clone(), arguments.clone());
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
                    self.output_done(item, false, &mut events)?;
                }
            }
            "response.refusal.delta" => {
                self.refused |= string(event, "delta").is_some_and(json::nonblank)
            }
            "response.refusal.done" => self.refused = true,
            "response.completed" | "response.incomplete" => {
                let response = get(event, "response");
                let output = response
                    .and_then(|value| get(value, "output"))
                    .and_then(json::array)
                    .unwrap_or(&[]);
                let refused = self.refused || output.iter().any(message_refusal);
                let reason = response
                    .and_then(|value| get(value, "incomplete_details"))
                    .and_then(|value| get(value, "reason"))
                    .and_then(json::text);
                let completed = kind == "response.completed"
                    && reason.is_none()
                    && response.is_none_or(|value| allowed(value, "status", &["completed"]));
                let allow_calls = completed && !refused;
                let mut tool_items = std::mem::take(&mut self.tool_items);
                for item in output {
                    if get(item, "type").and_then(json::text) == Some("function_call") {
                        if allow_calls {
                            let fallback = tool_items
                                .iter()
                                .position(|prior| same_function_item(prior, item))
                                .map(|index| tool_items.remove(index));
                            self.settle_tool(item, fallback.as_ref(), &mut events)?;
                        }
                    } else {
                        self.output_done(item, true, &mut events)?;
                    }
                }
                if allow_calls {
                    for item in &tool_items {
                        self.settle_tool(item, None, &mut events)?;
                    }
                }
                self.end_reasoning(&mut events);
                let reason = match reason {
                    _ if refused => FinishReason::ContentFilter,
                    Some("max_output_tokens") => FinishReason::Length,
                    Some("content_filter") => FinishReason::ContentFilter,
                    _ if !completed => FinishReason::Unknown,
                    _ if !self.settled_calls.is_empty() => FinishReason::ToolCalls,
                    _ => FinishReason::Stop,
                };
                let usage = usage
                    .or(self.usage.as_ref())
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
                        JsonValue::Bool(completed),
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
                self.terminal = true;
                let sources = [
                    Some(event),
                    get(event, "error"),
                    get(event, "response").and_then(|value| get(value, "error")),
                ];
                let field = |key| {
                    sources
                        .into_iter()
                        .flatten()
                        .find_map(|value| string(value, key).filter(|value| !value.is_empty()))
                };
                let code = field("code");
                let message = field("message");
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
                    status: get(event, "status")
                        .and_then(json::number)
                        .filter(|status| (100.0..=599.0).contains(status) && status.fract() == 0.0)
                        .map(|status| status as u16),
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
    fn reported_usage(&self) -> Option<Usage> {
        self.usage
            .as_ref()
            .map(|raw| openai_shared::usage(raw, false, self.reasoning_observed, None))
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
        let result = result.replace(['\r', '\n'], "");
        let bytes = crate::media::decode(&result)
            .map_err(|_| Error::output("OpenAI Responses returned invalid image base64"))?;
        if bytes.is_empty() || crate::media::encode(&bytes) != result {
            return Err(Error::output(
                "OpenAI Responses returned invalid image base64",
            ));
        }
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
            &["type", "delta", "text", "item_id", "arguments", "refusal"],
            &["code", "param", "message"],
            &["content_index", "summary_index"],
        )
        && get(event, "part").is_none_or(|value| {
            string(value, "type").is_some() && validate(value, &["text", "refusal"], &[], &[])
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
                "container_id",
                "server_label",
            ],
            &["encrypted_content", "code", "result"],
            &[],
        )
        && (get(value, "phase") == Some(&JsonValue::Null)
            || allowed(value, "phase", &["commentary", "final_answer"]))
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
