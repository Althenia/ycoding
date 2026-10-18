use crate::{
    json::{self, get},
    llm::{Message, Request},
};

pub const ANTHROPIC_BETA: &str = "mid-conversation-output-config-2026-07-01";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    OpenAI,
    Anthropic,
    OpenRouter,
}
impl Provider {
    pub fn key(self) -> &'static str {
        match self {
            Self::OpenAI => "openai",
            Self::Anthropic => "anthropic",
            Self::OpenRouter => "openrouter",
        }
    }
    pub fn effort_key(self) -> &'static str {
        if self == Self::OpenAI {
            "reasoningEffort"
        } else {
            "effort"
        }
    }
}
fn dated(id: &str) -> &str {
    if let Some((base, date)) = id.rsplit_once('-')
        && date.len() == 8
        && date.bytes().all(|byte| byte.is_ascii_digit())
    {
        return base;
    }
    if id.len() >= 11 {
        let at = id.len() - 11;
        if id.is_char_boundary(at) {
            let date = &id[at..];
            if date.bytes().enumerate().all(|(index, byte)| {
                if matches!(index, 0 | 5 | 8) {
                    byte == b'-'
                } else {
                    byte.is_ascii_digit()
                }
            }) {
                return &id[..at];
            }
        }
    }
    id
}
pub fn gpt6(id: &str) -> bool {
    if id.rsplit_once('-').is_some_and(|(_, suffix)| {
        suffix.len() == 8 && suffix.bytes().all(|byte| byte.is_ascii_digit())
    }) {
        return false;
    }
    matches!(
        dated(id),
        "gpt-6-luna" | "gpt-6-sol" | "gpt-6-astra" | "gpt-6.1-sol"
    )
}
pub fn anthropic_model(id: &str) -> bool {
    let id = id
        .strip_prefix("anthropic/")
        .unwrap_or(id)
        .replace(['.', '@'], "-");
    if id.len() >= 11 && dated(&id).len() + 11 == id.len() {
        return false;
    }
    matches!(
        dated(&id),
        "claude-fable-5-1"
            | "claude-mythos-5-1"
            | "claude-opus-5"
            | "claude-opus-5-5"
            | "claude-sonnet-5-5"
            | "claude-haiku-5-5"
    )
}
pub fn openrouter_endpoint(url: &str) -> bool {
    public_endpoint(url, "https://openrouter.ai/api/v1")
}
fn public_endpoint(url: &str, base: &str) -> bool {
    url == base || url.strip_suffix('/') == Some(base)
}
fn vertex_endpoint(url: &str) -> bool {
    let Some(authority) = url
        .strip_prefix("https://")
        .and_then(|rest| rest.split('/').next())
    else {
        return false;
    };
    if authority.is_empty() || authority.contains(':') {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(url) else {
        return false;
    };
    let host = url.host_str().unwrap_or_default();
    let path = url.path().strip_suffix('/').unwrap_or(url.path());
    let segments = path.split('/').collect::<Vec<_>>();
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && (host == "aiplatform.googleapis.com"
            || host == "aiplatform.eu.rep.googleapis.com"
            || host == "aiplatform.us.rep.googleapis.com"
            || host
                .strip_suffix("-aiplatform.googleapis.com")
                .is_some_and(|prefix| {
                    !prefix.is_empty()
                        && prefix.bytes().all(|byte| {
                            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                        })
                }))
        && segments.len() == 9
        && matches!(segments[1], "v1" | "v1beta1")
        && segments[2] == "projects"
        && !segments[3].is_empty()
        && segments[4] == "locations"
        && !segments[5].is_empty()
        && segments[6..] == ["publishers", "anthropic", "models"]
}
fn options(request: &Request) -> Option<ycoding_schema::JsonValue> {
    [
        request.model.route.defaults.provider_options.as_ref(),
        request.model.defaults.provider_options.as_ref(),
        request.provider_options.as_ref(),
    ]
    .into_iter()
    .flatten()
    .cloned()
    .reduce(|a, b| json::merge(&a, &b))
}
pub fn mechanism(request: &Request) -> Option<Provider> {
    // External adapters do not promise these native protocol directives.
    if matches!(
        &request.model.route.transport,
        crate::route::Transport::Process(_)
    ) {
        return None;
    }
    let route = request.model.route.id.as_str();
    let endpoint = request.model.route.endpoint.base_url.as_str();
    let options = options(request);
    let options = options.as_ref();
    let openai = options.and_then(|value| get(value, "openai"));
    let router = options
        .and_then(|value| get(value, "openrouter"))
        .and_then(|value| get(value, "reasoning"));
    let http = request
        .model
        .route
        .defaults
        .http
        .overlay(&request.model.defaults.http)
        .overlay(&request.http);
    let body = http.body.as_ref();
    let reasoning = body.and_then(|value| get(value, "reasoning"));
    let standard = [
        openai.and_then(|value| get(value, "reasoningMode")),
        reasoning.and_then(|value| get(value, "mode")),
        router.and_then(|value| get(value, "mode")),
    ]
    .into_iter()
    .all(|value| value.is_none_or(|value| json::text(value) == Some("standard")))
        && body
            .and_then(|value| get(value, "multi_agent"))
            .and_then(|value| get(value, "enabled"))
            .and_then(json::boolean)
            != Some(true)
        && [
            openai.and_then(|value| get(value, "contextManagement")),
            body.and_then(|value| get(value, "context_management")),
        ]
        .into_iter()
        .all(|value| {
            value
                .and_then(json::array)
                .is_none_or(|values| values.is_empty())
        })
        && body
            .and_then(|value| get(value, "truncation"))
            .and_then(json::text)
            != Some("auto")
        && reasoning.and_then(|value| get(value, "effort")).is_none();
    let thinking = options
        .and_then(|value| get(value, "anthropic"))
        .and_then(|value| get(value, "thinking"));
    let adaptive = thinking.is_none_or(|value| {
        !matches!(value, ycoding_schema::JsonValue::Object(_))
            || get(value, "type").and_then(json::text) == Some("adaptive")
    });
    let output_override = body
        .and_then(|value| get(value, "output_config"))
        .and_then(|value| get(value, "effort"))
        .is_some();
    let id = request.model.id.as_str().unwrap_or_default();
    let router_model = id.strip_prefix("openai/").is_some_and(gpt6)
        || matches!(
            id,
            "anthropic/claude-fable-5.1" | "anthropic/claude-fable-5-1" | "anthropic/claude-opus-5"
        );
    if openrouter_endpoint(endpoint)
        && router_model
        && standard
        && router.is_none_or(|value| {
            get(value, "enabled").is_none() && get(value, "max_tokens").is_none()
        })
    {
        if route == "openrouter-responses" {
            return Some(Provider::OpenRouter);
        }
        if matches!(
            route,
            "openai-compatible-responses"
                | "openai-compatible-chat"
                | "openai-responses"
                | "openai-chat"
        ) {
            return Some(Provider::OpenAI);
        }
        if route == "anthropic-messages" && adaptive && !output_override {
            return Some(Provider::Anthropic);
        }
    }
    if matches!(route, "openai-responses" | "openai-responses-websocket")
        && public_endpoint(endpoint, "https://api.openai.com/v1")
        && gpt6(id)
        && standard
    {
        return Some(Provider::OpenAI);
    }
    if ((route == "anthropic-messages"
        && public_endpoint(endpoint, "https://api.anthropic.com/v1"))
        || (route == "google-vertex-messages" && vertex_endpoint(endpoint)))
        && anthropic_model(id)
        && adaptive
        && !output_override
    {
        return Some(Provider::Anthropic);
    }
    None
}
pub fn update(message: &Message, provider: Provider) -> Option<&str> {
    message
        .native
        .as_ref()
        .and_then(|value| get(value, provider.key()))
        .and_then(|value| get(value, provider.effort_key()))
        .and_then(json::text)
}
pub fn selected(request: &Request, provider: Provider) -> Option<String> {
    let options = options(request)?;
    let options = &options;
    if provider == Provider::OpenRouter {
        return get(options, "openrouter")
            .and_then(|value| get(value, "reasoning"))
            .and_then(|value| get(value, "effort"))
            .and_then(json::text)
            .or_else(|| {
                get(options, "openai")
                    .and_then(|value| get(value, "reasoningEffort"))
                    .and_then(json::text)
            })
            .map(str::to_owned);
    }
    get(options, provider.key())
        .and_then(|value| get(value, provider.effort_key()))
        .and_then(json::text)
        .map(str::to_owned)
}
pub fn default_effort(id: &str) -> Option<&'static str> {
    let id = id.rsplit('/').next().unwrap_or(id);
    if dated(id) == "gpt-6-astra" {
        return None;
    }
    if gpt6(id) {
        return Some("medium");
    }
    let normalized = id.replace(['.', '@'], "-");
    Some(
        if matches!(dated(&normalized), "claude-opus-5-5" | "claude-haiku-5-5") {
            "medium"
        } else {
            "high"
        },
    )
}
