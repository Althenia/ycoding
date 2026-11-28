use super::compaction_policy::{Advisory, Resolved};
use ycoding_ai::{cache::Hint, llm};
use ycoding_schema::{JsonObject, JsonValue, ObjectEncoder, model, stringify_json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Normal,
    Consider,
    Advised,
    Mandatory,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capabilities {
    pub context_window_tokens: i64,
    pub max_output_tokens: i64,
    pub context_safety_margin_tokens: i64,
}

#[derive(Clone, Copy)]
pub struct Usage<'a> {
    pub system: &'a [llm::TextPart],
    pub tools: &'a [llm::ToolDefinition],
    pub messages: &'a [llm::Message],
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Breakdown {
    pub system: i64,
    pub tools: i64,
    pub user: i64,
    pub assistant: i64,
    pub reasoning: i64,
    pub tool_calls: i64,
    pub other: i64,
}

pub fn capabilities(info: &model::Info, safety_margin_tokens: i64) -> Capabilities {
    Capabilities {
        context_window_tokens: info.limit.context.get(),
        max_output_tokens: info.limit.output.get(),
        context_safety_margin_tokens: safety_margin_tokens,
    }
}

pub fn hard_input_cap_tokens(capabilities: &Capabilities) -> i64 {
    capabilities.context_window_tokens - capabilities.context_safety_margin_tokens
}

pub fn estimate(text: &str) -> i64 {
    let units = text.encode_utf16().count() as f64;
    ((units / 4.0) + 0.5).floor() as i64
}

pub fn estimate_json(value: &JsonValue) -> i64 {
    estimate(&stringify_json(&strip_media(value)))
}

pub fn estimated_input_tokens(usage: Usage) -> i64 {
    estimate(&system_text(usage.system))
        + estimate(&stringify_json(&tools_value(usage.tools)))
        + estimate_json(&JsonValue::Array(
            usage.messages.iter().map(message_value).collect(),
        ))
}

pub fn breakdown(usage: Usage) -> Breakdown {
    let mut totals = Breakdown {
        system: estimate(&system_text(usage.system)),
        tools: if usage.tools.is_empty() {
            0
        } else {
            estimate(&stringify_json(&tools_value(usage.tools)))
        },
        ..Breakdown::default()
    };
    for message in usage.messages {
        for part in &message.content {
            let tool = matches!(part, llm::Part::ToolCall(_) | llm::Part::ToolResult(_))
                || message.role == llm::Role::Tool;
            let category = if tool {
                &mut totals.tool_calls
            } else {
                match (part, message.role) {
                    (llm::Part::Reasoning(_), _) => &mut totals.reasoning,
                    (llm::Part::Text(_), llm::Role::User) => &mut totals.user,
                    (llm::Part::Text(_), llm::Role::Assistant) => &mut totals.assistant,
                    (llm::Part::Text(_), llm::Role::System) => &mut totals.system,
                    _ => &mut totals.other,
                }
            };
            *category += estimate_json(&part_value(part));
        }
    }
    totals
}

pub fn level(capabilities: &Capabilities, policy: &Resolved, estimate: i64) -> Level {
    let cap = hard_input_cap_tokens(capabilities);
    if cap <= 0 || estimate >= cap {
        return Level::Mandatory;
    }
    let Advisory::Thresholds {
        consider_percent,
        strongly_advised_percent,
    } = policy.advisory
    else {
        return Level::Normal;
    };
    let scaled = estimate * 100;
    if scaled >= capabilities.context_window_tokens * strongly_advised_percent {
        Level::Advised
    } else if scaled >= capabilities.context_window_tokens * consider_percent {
        Level::Consider
    } else {
        Level::Normal
    }
}

fn system_text(system: &[llm::TextPart]) -> String {
    system
        .iter()
        .map(|part| part.text.to_utf8().unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\n")
}

fn tools_value(tools: &[llm::ToolDefinition]) -> JsonValue {
    JsonValue::Array(
        tools
            .iter()
            .map(|tool| {
                ObjectEncoder::new()
                    .field("name", &tool.name)
                    .field("description", &tool.description)
                    .field("inputSchema", &tool.input_schema)
                    .optional("outputSchema", &tool.output_schema)
                    .optional("cache", &tool.cache.as_ref().map(hint_value))
                    .optional("metadata", &tool.metadata)
                    .optional("native", &tool.native)
                    .finish()
            })
            .collect(),
    )
}

fn hint_value(hint: &Hint) -> JsonValue {
    ObjectEncoder::new()
        .field(
            "type",
            match hint.kind {
                ycoding_ai::cache::HintType::Ephemeral => "ephemeral",
                ycoding_ai::cache::HintType::Persistent => "persistent",
            },
        )
        .optional("ttlSeconds", &hint.ttl_seconds)
        .finish()
}

pub fn message_value(message: &llm::Message) -> JsonValue {
    ObjectEncoder::new()
        .optional("id", &message.id)
        .field(
            "role",
            match message.role {
                llm::Role::User => "user",
                llm::Role::Assistant => "assistant",
                llm::Role::System => "system",
                llm::Role::Tool => "tool",
            },
        )
        .field(
            "content",
            &JsonValue::Array(message.content.iter().map(part_value).collect()),
        )
        .optional("metadata", &message.metadata)
        .finish()
}

fn part_value(part: &llm::Part) -> JsonValue {
    match part {
        llm::Part::Text(text) => ObjectEncoder::new()
            .field("type", "text")
            .field("text", &text.text)
            .optional("providerMetadata", &text.provider_metadata)
            .finish(),
        llm::Part::Media(media) => ObjectEncoder::new()
            .field("type", "media")
            .field("mediaType", &media.mime)
            .field(
                "data",
                &match &media.data {
                    llm::MediaData::Encoded(data) => data.clone(),
                    llm::MediaData::Bytes(_) => "".into(),
                },
            )
            .optional("filename", &media.filename)
            .finish(),
        llm::Part::Reasoning(reasoning) => ObjectEncoder::new()
            .field("type", "reasoning")
            .field("text", &reasoning.text)
            .optional("encrypted", &reasoning.encrypted)
            .optional("providerMetadata", &reasoning.provider_metadata)
            .finish(),
        llm::Part::ToolCall(call) => ObjectEncoder::new()
            .field("type", "tool-call")
            .field("id", &call.id)
            .field("name", &call.name)
            .field("input", &call.input)
            .optional("providerExecuted", &call.provider_executed)
            .optional("providerMetadata", &call.provider_metadata)
            .finish(),
        llm::Part::ToolResult(result) => ObjectEncoder::new()
            .field("type", "tool-result")
            .field("id", &result.id)
            .field("name", &result.name)
            .field("result", &result.result.to_json())
            .optional("providerExecuted", &result.provider_executed)
            .optional("providerMetadata", &result.provider_metadata)
            .finish(),
    }
}

fn data_uri(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    lowered
        .strip_prefix("data:")
        .and_then(|rest| rest.split_once(";base64,"))
        .is_some_and(|(media, _)| !media.is_empty() && !media.contains(';'))
}

fn long_base64(value: &str) -> bool {
    value.encode_utf16().count() > 1_024
        && value.chars().all(|ch| {
            ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '=') || ch.is_whitespace()
        })
}

pub fn strip_media(value: &JsonValue) -> JsonValue {
    match value {
        JsonValue::String(text) => match text.as_str() {
            Some(text) if data_uri(text) => JsonValue::String("".into()),
            _ => value.clone(),
        },
        JsonValue::Array(items) => JsonValue::Array(items.iter().map(strip_media).collect()),
        JsonValue::Object(fields) => {
            let media = matches!(
                fields.get(&"type".into()),
                Some(JsonValue::String(kind)) if kind.as_str() == Some("media")
            ) && fields.get(&"data".into()).is_some();
            let blank_data = media
                || matches!(
                    fields.get(&"data".into()),
                    Some(JsonValue::String(data))
                        if data.as_str().is_some_and(|data| data_uri(data) || long_base64(data))
                );
            let mut result = JsonObject::new();
            for (key, entry) in fields.iter() {
                let blanked = (key.as_str() == Some("data") && blank_data)
                    || matches!(entry, JsonValue::String(text) if text.as_str().is_some_and(data_uri));
                result.insert(
                    key.clone(),
                    if blanked {
                        JsonValue::String("".into())
                    } else {
                        strip_media(entry)
                    },
                );
            }
            JsonValue::Object(result)
        }
        other => other.clone(),
    }
}
