use ring::digest;
use ycoding_ai::{cache::HintType, llm};
use ycoding_schema::{
    DomainEncode, JsonValue, LosslessString, ObjectEncoder, permission, stringify_json,
};

pub const POLICY_REVISION: &str = "provider-native/v8";

pub struct Namespace<'a> {
    pub project_id: LosslessString,
    pub directory: LosslessString,
    pub workspace_id: Option<LosslessString>,
    pub provider_id: LosslessString,
    pub model_id: LosslessString,
    pub variant: Option<LosslessString>,
    pub account_identity_digest: Option<&'a str>,
    pub permissions: &'a [permission::Rule],
    pub system: &'a [llm::TextPart],
    pub tools: &'a [llm::ToolDefinition],
}

pub fn sha256(text: &str) -> String {
    digest::digest(&digest::SHA256, text.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn canonical_json(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => "null".into(),
        JsonValue::Bool(value) => value.to_string(),
        JsonValue::Number(number) if !number.is_finite() => "null".into(),
        JsonValue::Number(_) | JsonValue::String(_) => stringify_json(value),
        JsonValue::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        JsonValue::Object(fields) => {
            let mut entries = fields
                .iter()
                .map(|(key, value)| (key.to_utf8().unwrap_or_default(), key, value))
                .collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            format!(
                "{{{}}}",
                entries
                    .iter()
                    .map(|(_, key, value)| format!(
                        "{}:{}",
                        stringify_json(&JsonValue::String((*key).clone())),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

pub fn system_digest(system: &[llm::TextPart]) -> String {
    sha256(&canonical_json(&system_value(system)))
}

pub fn tool_digest(tools: &[llm::ToolDefinition]) -> String {
    sha256(&canonical_json(&tools_value(tools)))
}

pub fn namespace(input: &Namespace) -> String {
    sha256(&canonical_json(
        &ObjectEncoder::new()
            .field("namespace", "session-prompt-cache/v2")
            .field("projectID", &input.project_id)
            .field("directory", &input.directory)
            .optional("workspaceID", &input.workspace_id)
            .field("providerID", &input.provider_id)
            .field("modelID", &input.model_id)
            .optional("variant", &input.variant)
            .optional(
                "accountIdentityDigest",
                &input.account_identity_digest.map(LosslessString::from),
            )
            .field("policyRevision", POLICY_REVISION)
            .field(
                "permissions",
                &JsonValue::Array(input.permissions.iter().map(|rule| rule.encode()).collect()),
            )
            .field("system", &system_value(input.system))
            .field("tools", &tools_value(input.tools))
            .finish(),
    ))
}

fn system_value(system: &[llm::TextPart]) -> JsonValue {
    JsonValue::Array(
        system
            .iter()
            .map(|part| {
                ObjectEncoder::new()
                    .field("type", "text")
                    .field("text", &part.text)
                    .optional("cache", &part.cache.as_ref().map(hint_value))
                    .finish()
            })
            .collect(),
    )
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
                    .optional("native", &tool.native)
                    .finish()
            })
            .collect(),
    )
}

fn hint_value(hint: &ycoding_ai::cache::Hint) -> JsonValue {
    ObjectEncoder::new()
        .field(
            "type",
            match hint.kind {
                HintType::Ephemeral => "ephemeral",
                HintType::Persistent => "persistent",
            },
        )
        .optional("ttlSeconds", &hint.ttl_seconds)
        .finish()
}

pub struct Options {
    pub wire_key: String,
    pub provider_options: JsonValue,
    pub cache: Option<ycoding_ai::cache::Policy>,
}

pub struct OptionsInput<'a> {
    pub route_id: &'a str,
    pub api_model_id: &'a str,
    pub session_id: &'a LosslessString,
    pub project_id: &'a LosslessString,
    pub provider_id: &'a LosslessString,
    pub baseline_key: &'a str,
    pub interactive: bool,
}

const PROMPT_CACHE_READ_CANDIDATE_LIMIT: usize = 50;

pub fn provider_options(input: &OptionsInput) -> Options {
    let route = input.route_id;
    let wire_key = if supports_prompt_cache_key(route) {
        sha256(&canonical_json(
            &ObjectEncoder::new()
                .field("namespace", "session-prompt-cache-generation/v1")
                .field("sessionID", input.session_id)
                .field("baselineKey", input.baseline_key)
                .field("generation", &0.0)
                .finish(),
        ))
    } else {
        input.baseline_key.to_string()
    };
    let provider_session = sha256(&canonical_json(
        &ObjectEncoder::new()
            .field("namespace", "provider-session/v1")
            .field("projectID", input.project_id)
            .field("sessionID", input.session_id)
            .field("providerID", input.provider_id)
            .finish(),
    ));
    let openrouter_route = matches!(
        route,
        "ai-sdk:@openrouter/ai-sdk-provider" | "openrouter-responses" | "openrouter"
    );
    let openrouter = if openrouter_route {
        ObjectEncoder::new()
            .field("prompt_cache_key", wire_key.as_str())
            .field("session_id", provider_session.as_str())
            .field("promptCacheKey", wire_key.as_str())
            .field("sessionID", provider_session.as_str())
            .finish()
    } else {
        ObjectEncoder::new()
            .field("promptCacheKey", wire_key.as_str())
            .field("sessionID", provider_session.as_str())
            .finish()
    };
    let copilot_key_only = matches!(route, "github-copilot-chat" | "github-copilot-responses")
        && ycoding_ai::cache::supports_prompt_cache_breakpoints(
            "openai-responses",
            input.api_model_id,
        );
    let public = !copilot_key_only
        && ycoding_ai::cache::supports_prompt_cache_breakpoints(route, input.api_model_id);
    let openai = ObjectEncoder::new().field("promptCacheKey", wire_key.as_str());
    let openai = if public {
        openai
            .field(
                "promptCacheOptions",
                &ObjectEncoder::new()
                    .field("mode", "implicit")
                    .field("ttl", "30m")
                    .finish(),
            )
            .finish()
    } else {
        openai.finish()
    };
    let copilot_claude = route == "ai-sdk:@ai-sdk/github-copilot"
        && input.api_model_id.to_lowercase().contains("claude");
    let profile = ycoding_ai::cache::profile(input.api_model_id);
    let anthropic_route = matches!(
        route,
        "anthropic-messages"
            | "google-vertex-messages"
            | "ai-sdk:@ai-sdk/anthropic"
            | "ai-sdk:@ai-sdk/google-vertex/anthropic"
            | "ai-sdk:@ai-sdk/amazon-bedrock"
            | "bedrock-converse"
            | "openrouter"
            | "openrouter-responses"
            | "ai-sdk:@openrouter/ai-sdk-provider"
    );
    let profile_gated = matches!(
        route,
        "openrouter" | "openrouter-responses" | "ai-sdk:@openrouter/ai-sdk-provider"
    );
    let ttl = if profile.is_none_or(|profile| !profile.extended_ttl) || !input.interactive {
        300.0
    } else {
        3600.0
    };
    let cache = if public {
        Some(ycoding_ai::cache::Policy::Explicit {
            tools: false,
            system: true,
            messages: Some(ycoding_ai::cache::MessageStrategy::Tail(
                PROMPT_CACHE_READ_CANDIDATE_LIMIT,
            )),
            ttl_seconds: None,
        })
    } else if copilot_claude {
        Some(ycoding_ai::cache::Policy::Explicit {
            tools: false,
            system: true,
            messages: Some(ycoding_ai::cache::MessageStrategy::Tail(2)),
            ttl_seconds: None,
        })
    } else if anthropic_route
        && (!profile_gated || profile.is_some_and(|profile| profile.extended_ttl))
    {
        Some(ycoding_ai::cache::Policy::Explicit {
            tools: true,
            system: true,
            messages: Some(ycoding_ai::cache::MessageStrategy::Tail(2)),
            ttl_seconds: Some(ttl),
        })
    } else {
        None
    };
    Options {
        wire_key,
        provider_options: ObjectEncoder::new()
            .field("openai", &openai)
            .field("openrouter", &openrouter)
            .finish(),
        cache,
    }
}

fn supports_prompt_cache_key(route: &str) -> bool {
    matches!(
        route,
        "openai-chat"
            | "openai-responses"
            | "openai-responses-websocket"
            | "openai-codex-responses"
            | "openai-codex-websocket-responses"
            | "openai-compatible-chat"
            | "openai-compatible-responses"
            | "github-copilot-chat"
            | "github-copilot-responses"
            | "ai-sdk:@ai-sdk/github-copilot"
            | "ai-sdk:@openrouter/ai-sdk-provider"
            | "openrouter"
            | "openrouter-responses"
    ) || route.contains("openai")
        || route.contains("openrouter")
}
