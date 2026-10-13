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
                .map(|(key, value)| (code_points(key), key, value))
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

fn code_points(value: &LosslessString) -> Vec<u32> {
    char::decode_utf16(value.code_units())
        .map(|point| point.map_or_else(|error| u32::from(error.unpaired_surrogate()), u32::from))
        .collect()
}

pub fn canonical_tools(tools: &mut [llm::ToolDefinition]) {
    for tool in tools.iter_mut() {
        tool.input_schema = ycoding_schema::parse_json(&canonical_json(&tool.input_schema))
            .expect("canonical JSON is valid lossless JSON");
        tool.output_schema = tool.output_schema.as_ref().map(|schema| {
            ycoding_schema::parse_json(&canonical_json(schema))
                .expect("canonical JSON is valid lossless JSON")
        });
        tool.native = tool.native.as_ref().map(|native| {
            ycoding_schema::parse_json(&canonical_json(native))
                .expect("canonical JSON is valid lossless JSON")
        });
    }
    tools.sort_by(|left, right| left.name.cmp(&right.name));
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
    pub settings: &'a Settings,
}

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub enum OpenAIMode {
    #[default]
    Auto,
    Implicit,
    Explicit,
}

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub enum AnthropicTtl {
    #[default]
    Adaptive,
    FiveMinutes,
    OneHour,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settings {
    pub responses_stored: bool,
    pub responses_continuation: bool,
    pub openai_mode: OpenAIMode,
    pub anthropic_ttl: AnthropicTtl,
    pub openai_extended_retention: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            responses_stored: true,
            responses_continuation: true,
            openai_mode: OpenAIMode::Auto,
            anthropic_ttl: AnthropicTtl::Adaptive,
            openai_extended_retention: false,
        }
    }
}

impl Settings {
    pub fn read(config: Option<&crate::resources::config::Configuration>) -> Self {
        let Some(JsonValue::Object(efficiency)) =
            config.and_then(|config| config.latest("efficiency"))
        else {
            return Self::default();
        };
        let prompt_cache = match efficiency.get(&"prompt_cache".into()) {
            Some(JsonValue::Object(cache)) => Some(cache),
            _ => None,
        };
        let option = |key: &str| prompt_cache.and_then(|cache| cache.get(&key.into()));
        Self {
            responses_stored: efficiency.get(&"openai_responses_state".into())
                != Some(&JsonValue::String("stateless".into())),
            responses_continuation: efficiency.get(&"openai_responses_continuation".into())
                != Some(&JsonValue::String("off".into())),
            openai_mode: match option("openai_mode") {
                Some(JsonValue::String(mode)) if mode.as_str() == Some("implicit") => {
                    OpenAIMode::Implicit
                }
                Some(JsonValue::String(mode)) if mode.as_str() == Some("explicit") => {
                    OpenAIMode::Explicit
                }
                _ => OpenAIMode::Auto,
            },
            anthropic_ttl: match option("anthropic_ttl") {
                Some(JsonValue::String(ttl)) if ttl.as_str() == Some("5m") => {
                    AnthropicTtl::FiveMinutes
                }
                Some(JsonValue::String(ttl)) if ttl.as_str() == Some("1h") => AnthropicTtl::OneHour,
                _ => AnthropicTtl::Adaptive,
            },
            openai_extended_retention: option("openai_extended_retention")
                == Some(&JsonValue::Bool(true)),
        }
    }
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
    let controlled = public && input.settings.openai_mode != OpenAIMode::Implicit;
    let openai = ObjectEncoder::new().field("promptCacheKey", wire_key.as_str());
    let openai = if controlled {
        openai
            .field(
                "promptCacheOptions",
                &ObjectEncoder::new()
                    .field(
                        "mode",
                        if input.settings.openai_mode == OpenAIMode::Explicit {
                            "explicit"
                        } else {
                            "implicit"
                        },
                    )
                    .field("ttl", "30m")
                    .finish(),
            )
            .finish()
    } else if !public
        && !copilot_key_only
        && [
            "openai-chat",
            "openai-responses",
            "openai-responses-websocket",
            "github-copilot-chat",
            "github-copilot-responses",
            "openrouter",
            "openrouter-responses",
        ]
        .contains(&route)
        && input.settings.openai_extended_retention
        && extended_retention(input.api_model_id)
    {
        openai.field("promptCacheRetention", "24h").finish()
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
    let ttl = if profile.is_none_or(|profile| !profile.extended_ttl)
        || input.settings.anthropic_ttl == AnthropicTtl::FiveMinutes
        || (input.settings.anthropic_ttl == AnthropicTtl::Adaptive && !input.interactive)
    {
        300.0
    } else {
        3600.0
    };
    let cache = if controlled {
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

fn extended_retention(model: &str) -> bool {
    let model = model.to_lowercase();
    let model = model.rsplit('/').next().unwrap_or_default();
    let model = model
        .as_bytes()
        .get(model.len().saturating_sub(11)..)
        .filter(|suffix| {
            suffix.len() == 11
                && suffix.iter().enumerate().all(|(index, byte)| {
                    if matches!(index, 0 | 5 | 8) {
                        *byte == b'-'
                    } else {
                        byte.is_ascii_digit()
                    }
                })
        })
        .map_or(model, |_| &model[..model.len() - 11]);
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
    .contains(&model)
        || model.starts_with("muse-spark-")
}

fn supports_prompt_cache_key(route: &str) -> bool {
    matches!(
        route,
        "openai-chat"
            | "muse-responses"
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
