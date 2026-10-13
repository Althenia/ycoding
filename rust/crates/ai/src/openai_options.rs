use crate::{
    cache,
    json::{self, get, s},
    llm::Request,
};
use ycoding_schema::{JsonValue, LosslessString};

pub fn value<'a>(request: &'a Request, key: &str) -> Option<&'a JsonValue> {
    request
        .provider_options
        .as_ref()
        .and_then(|options| get(options, "openai"))
        .and_then(|options| get(options, key))
}
pub fn text<'a>(request: &'a Request, key: &str) -> Option<&'a LosslessString> {
    value(request, key).and_then(json::string)
}
pub fn store(request: &Request) -> Option<bool> {
    value(request, "store").and_then(json::boolean)
}
pub fn gpt56(model: &LosslessString) -> bool {
    cache::supports_prompt_cache_breakpoints("openai-responses", model.as_str().unwrap_or(""))
}
pub fn breakpoints(request: &Request) -> bool {
    !["github-copilot-chat", "github-copilot-responses"].contains(&request.model.route.id.as_str())
        && cache::supports_prompt_cache_breakpoints(
            &request.model.route.id,
            request.model.id.as_str().unwrap_or(""),
        )
}
pub fn previous_response_id(request: &Request) -> Option<&LosslessString> {
    text(request, "previousResponseId").filter(|value| !value.is_empty())
}
pub fn safe_integer(value: Option<&JsonValue>) -> Option<usize> {
    value
        .and_then(json::number)
        .filter(|value| {
            value.is_finite()
                && *value >= 0.0
                && value.fract() == 0.0
                && *value <= 9_007_199_254_740_991.0
        })
        .map(|value| value as usize)
}
pub fn cache_options(request: &Request) -> Option<JsonValue> {
    let value = value(request, "promptCacheOptions")?;
    let mode = get(value, "mode")
        .and_then(json::text)
        .filter(|value| matches!(*value, "implicit" | "explicit"));
    let ttl = get(value, "ttl")
        .and_then(json::text)
        .filter(|value| *value == "30m");
    if mode.is_none() && ttl.is_none() {
        return None;
    }
    let mut result = json::empty();
    if let Some(mode) = mode {
        json::set(&mut result, "mode", s(mode));
    }
    if let Some(ttl) = ttl {
        json::set(&mut result, "ttl", s(ttl));
    }
    Some(result)
}
pub fn include(request: &Request) -> Option<JsonValue> {
    const ALLOWED: &[&str] = &[
        "file_search_call.results",
        "web_search_call.results",
        "web_search_call.action.sources",
        "message.input_image.image_url",
        "computer_call_output.output.image_url",
        "code_interpreter_call.outputs",
        "reasoning.encrypted_content",
        "message.output_text.logprobs",
    ];
    let items = value(request, "include")
        .and_then(json::array)?
        .iter()
        .filter(|value| json::text(value).is_some_and(|value| ALLOWED.contains(&value)))
        .cloned()
        .collect::<Vec<_>>();
    (!items.is_empty()).then_some(JsonValue::Array(items))
}
fn extended_retention(model: &LosslessString) -> bool {
    let id = model.as_str().unwrap_or("").to_lowercase();
    let mut id = id.rsplit('/').next().unwrap_or("").to_string();
    if id.len() >= 11 {
        let suffix = &id[id.len() - 11..];
        if suffix.as_bytes()[0] == b'-'
            && suffix.as_bytes()[5] == b'-'
            && suffix.as_bytes()[8] == b'-'
            && suffix
                .bytes()
                .enumerate()
                .all(|(index, ch)| matches!(index, 0 | 5 | 8) || ch.is_ascii_digit())
        {
            id.truncate(id.len() - 11);
        }
    }
    [
        "gpt-5.5",
        "gpt-5.5-pro",
        "gpt-5.4",
        "gpt-5.2",
        "gpt-5.1-codex-max",
        "gpt-5.1",
        "gpt-5.1-codex",
        "gpt-5.1-codex-mini",
        "gpt-5.1-chat-latest",
        "gpt-5",
        "gpt-5-codex",
        "gpt-4.1",
    ]
    .contains(&id.as_str())
        || id.starts_with("muse-spark-")
}
pub fn lower(request: &Request, responses: bool) -> JsonValue {
    let mut result = json::empty();
    let route = request.model.route.id.as_str();
    if let Some(store) = store(request) {
        json::set(&mut result, "store", JsonValue::Bool(store));
    }
    if let Some(key) = text(request, "promptCacheKey").filter(|value| !value.is_empty()) {
        json::set(&mut result, "prompt_cache_key", s(key.clone()));
    }
    let public = [
        "openai-chat",
        "openai-responses",
        "openai-responses-websocket",
        "openrouter",
        "openrouter-responses",
    ]
    .contains(&route);
    if public
        && gpt56(&request.model.id)
        && let Some(options) = cache_options(request)
    {
        json::set(&mut result, "prompt_cache_options", options);
    }
    if public
        && !gpt56(&request.model.id)
        && let Some(retention) = text(request, "promptCacheRetention")
            .filter(|value| matches!(value.as_str(), Some("in_memory" | "24h")))
            .filter(|value| value.as_str() != Some("24h") || extended_retention(&request.model.id))
    {
        json::set(&mut result, "prompt_cache_retention", s(retention.clone()));
    }
    if !responses {
        if let Some(effort) = text(request, "reasoningEffort").filter(|value| !value.is_empty()) {
            json::set(&mut result, "reasoning_effort", s(effort.clone()));
        }
        if let Some(kind) = value(request, "thinking")
            .and_then(|value| get(value, "type"))
            .and_then(json::text)
            .filter(|value| matches!(*value, "enabled" | "disabled"))
        {
            json::set(&mut result, "thinking", json::object([("type", s(kind))]));
        }
        return result;
    }
    for (key, wire) in [
        ("instructions", "instructions"),
        ("serviceTier", "service_tier"),
    ] {
        if let Some(value) = text(request, key)
            .filter(|value| !value.is_empty())
            .filter(|value| {
                key != "serviceTier"
                    || matches!(
                        value.as_str(),
                        Some("auto" | "default" | "flex" | "priority")
                    )
            })
        {
            json::set(&mut result, wire, s(value.clone()));
        }
    }
    if store(request) == Some(true)
        && let Some(id) = previous_response_id(request)
    {
        json::set(&mut result, "previous_response_id", s(id.clone()));
    }
    let retained = [
        "openai-responses",
        "openai-responses-websocket",
        "openrouter-responses",
    ]
    .contains(&route)
        && gpt56(&request.model.id);
    let mut reasoning = json::empty();
    if let Some(effort) = text(request, "reasoningEffort").filter(|value| !value.is_empty()) {
        json::set(&mut reasoning, "effort", s(effort.clone()));
    }
    if text(request, "reasoningSummary").and_then(LosslessString::as_str) == Some("auto") {
        json::set(&mut reasoning, "summary", s("auto"));
    }
    if retained {
        json::set(&mut reasoning, "context", s("all_turns"));
    }
    if matches!(&reasoning,JsonValue::Object(fields) if !fields.is_empty()) {
        json::set(&mut result, "reasoning", reasoning);
    }
    if let Some(verbosity) = text(request, "textVerbosity")
        .filter(|value| matches!(value.as_str(), Some("low" | "medium" | "high")))
    {
        json::set(
            &mut result,
            "text",
            json::object([("verbosity", s(verbosity.clone()))]),
        );
    }
    if let Some(include) = include(request) {
        json::set(&mut result, "include", include);
    }
    if ["openai-responses", "openai-responses-websocket"].contains(&route)
        && gpt56(&request.model.id)
    {
        let configured = value(request, "contextManagement")
            .and_then(json::array)
            .map(|values| {
                values
                    .iter()
                    .filter(|value| get(value, "type").and_then(json::text) == Some("compaction"))
                    .filter_map(|value| {
                        let threshold = get(value, "compactThreshold");
                        if threshold.is_some_and(|value| {
                            json::number(value).is_none_or(|value| !value.is_finite())
                        }) {
                            return None;
                        }
                        let mut item = json::object([("type", s("compaction"))]);
                        if let Some(threshold) = threshold {
                            json::set(&mut item, "compact_threshold", threshold.clone());
                        }
                        Some(item)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| {
                vec![json::object([
                    ("type", s("compaction")),
                    ("compact_threshold", JsonValue::Number(200_000.0)),
                ])]
            });
        if !configured.is_empty() {
            json::set(
                &mut result,
                "context_management",
                JsonValue::Array(configured),
            );
        }
    }
    result
}
pub fn image_detail(request: &Request) -> Result<Option<&LosslessString>, crate::Error> {
    let Some(value) = value(request, "imageDetail") else {
        return Ok(None);
    };
    let Some(detail) = json::string(value)
        .filter(|value| matches!(value.as_str(), Some("auto" | "low" | "high" | "original")))
    else {
        return Err(crate::Error::invalid(format!(
            "OpenAI Responses image detail is invalid: {}",
            json::text(value).unwrap_or("non-string value")
        )));
    };
    if detail.as_str() == Some("original") {
        let id = request.model.id.as_str().unwrap_or("").to_lowercase();
        let version = id.split('/').find_map(|part| part.strip_prefix("gpt-"));
        let allowed = gpt56(&request.model.id)
            || version.is_some_and(|version| {
                version.starts_with("5.5")
                    || version.starts_with("5.4")
                        && !version.starts_with("5.4-mini")
                        && !version.starts_with("5.4-nano")
            });
        if !allowed {
            return Err(crate::Error::invalid(format!(
                "OpenAI Responses image detail original requires GPT-5.4 or later: {}",
                request.model.id.as_str().unwrap_or("")
            )));
        }
    }
    Ok(Some(detail))
}
pub fn provider_defaults(
    model: &LosslessString,
    text_verbosity: bool,
    store: bool,
    retained: bool,
) -> JsonValue {
    let mut options = json::object([("store", JsonValue::Bool(store))]);
    let id = model.as_str().unwrap_or("").to_lowercase();
    if retained && gpt56(model) {
        json::set(&mut options, "reasoningContext", s("all_turns"));
    }
    if id.contains("gpt-5") && !id.contains("gpt-5-chat") && !id.contains("gpt-5-pro") {
        json::set(&mut options, "reasoningEffort", s("medium"));
        json::set(&mut options, "reasoningSummary", s("auto"));
        json::set(
            &mut options,
            "include",
            JsonValue::Array(vec![s("reasoning.encrypted_content")]),
        );
        if text_verbosity && id.contains("gpt-5.") && !id.contains("codex") && !id.contains("-chat")
        {
            json::set(&mut options, "textVerbosity", s("low"));
        }
    }
    json::object([("openai", options)])
}
