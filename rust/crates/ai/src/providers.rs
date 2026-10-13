use crate::{
    Error,
    auth::{Auth, Credential},
    json::{self, get, s},
    llm::{Defaults, Model, Request},
    openai_options,
    openai_responses::{self, OpenAIResponses},
    openai_shared::{pick, string},
    route::{Endpoint, Protocol, Route, StreamParser},
};
use std::{collections::BTreeMap, sync::Arc};
use ycoding_schema::{JsonValue, LosslessString, provider};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Api {
    Chat,
    Responses,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Transport {
    #[default]
    Http,
    WebSocket,
}
#[derive(Clone)]
pub struct Config {
    pub auth: Auth,
    pub base_url: Option<String>,
    pub query: BTreeMap<String, String>,
    pub defaults: Defaults,
}
impl Config {
    pub fn new(auth: Auth) -> Self {
        Self {
            auth,
            base_url: None,
            query: BTreeMap::new(),
            defaults: Defaults::default(),
        }
    }
}
#[derive(Clone)]
pub struct OpenAIConfig {
    pub common: Config,
    pub organization: Option<String>,
    pub project: Option<String>,
    pub transport: Transport,
}
pub fn openai(id: impl Into<LosslessString>, config: OpenAIConfig) -> Model {
    let id = id.into();
    let mut route = match config.transport {
        Transport::Http => Route::openai_responses(),
        Transport::WebSocket => Route::openai_responses_websocket(),
    };
    for (key, value) in [
        ("OpenAI-Organization", config.organization),
        ("OpenAI-Project", config.project),
    ] {
        if let Some(value) = value {
            route.headers.insert(key.into(), value);
        }
    }
    configured(&mut route, &config.common);
    let mut model = route.model(id);
    model.defaults = config.common.defaults;
    model.defaults.provider_options = Some(json::merge(
        &openai_options::provider_defaults(&model.id, true, true, true),
        model
            .defaults
            .provider_options
            .as_ref()
            .unwrap_or(&json::empty()),
    ));
    model
}
fn configured(route: &mut Route, input: &Config) {
    if let Some(base_url) = &input.base_url {
        route.endpoint.base_url = base_url.clone();
    }
    route.endpoint.query.extend(input.query.clone());
    route.auth = input.auth.clone();
}
pub fn compatible(
    id: impl Into<LosslessString>,
    provider: provider::Id,
    config: Config,
    api: Api,
) -> Result<Model, Error> {
    if config.base_url.as_ref().is_none_or(String::is_empty) {
        return Err(Error::invalid(
            "OpenAI-compatible providers require a baseURL",
        ));
    }
    let mut route = match api {
        Api::Chat => Route::openai_chat(),
        Api::Responses => Route::openai_responses(),
    };
    route.id = match api {
        Api::Chat => "openai-compatible-chat",
        Api::Responses => "openai-compatible-responses",
    }
    .into();
    route.provider = provider;
    configured(&mut route, &config);
    let mut model = route.model(id);
    model.defaults = config.defaults;
    Ok(model)
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    Baseten,
    Cerebras,
    Deepinfra,
    Deepseek,
    Fireworks,
    Groq,
    Meta,
    Openrouter,
    Togetherai,
    Xai,
}
impl Profile {
    pub fn identity(self) -> (&'static str, &'static str) {
        match self {
            Self::Baseten => ("baseten", "https://inference.baseten.co/v1"),
            Self::Cerebras => ("cerebras", "https://api.cerebras.ai/v1"),
            Self::Deepinfra => ("deepinfra", "https://api.deepinfra.com/v1/openai"),
            Self::Deepseek => ("deepseek", "https://api.deepseek.com/v1"),
            Self::Fireworks => ("fireworks", "https://api.fireworks.ai/inference/v1"),
            Self::Groq => ("groq", "https://api.groq.com/openai/v1"),
            Self::Meta => ("meta", "https://api.llama.com/v1"),
            Self::Openrouter => ("openrouter", "https://openrouter.ai/api/v1"),
            Self::Togetherai => ("togetherai", "https://api.together.xyz/v1"),
            Self::Xai => ("xai", "https://api.x.ai/v1"),
        }
    }
}
pub fn compatible_profile(
    id: impl Into<LosslessString>,
    profile: Profile,
    mut config: Config,
) -> Result<Model, Error> {
    let (provider, url) = profile.identity();
    if config.base_url.is_none() {
        config.base_url = Some(url.into());
    }
    compatible(id, provider::Id(provider.into()), config, Api::Chat)
}
#[derive(Clone)]
pub enum AzureEndpoint {
    Resource(String),
    BaseUrl(String),
}
#[derive(Clone)]
pub enum AzureAuth {
    Key(Credential),
    Override(Auth),
}
pub struct AzureConfig {
    pub endpoint: AzureEndpoint,
    pub auth: AzureAuth,
    pub api_version: Option<String>,
    pub query: BTreeMap<String, String>,
    pub defaults: Defaults,
}
pub fn azure(id: impl Into<LosslessString>, config: AzureConfig, api: Api) -> Model {
    let mut route = match api {
        Api::Chat => Route::openai_chat(),
        Api::Responses => Route::openai_responses(),
    };
    route.id = match api {
        Api::Chat => "azure-openai-chat",
        Api::Responses => "azure-openai-responses",
    }
    .into();
    route.provider = provider::Id("azure".into());
    route.endpoint.base_url = match config.endpoint {
        AzureEndpoint::Resource(name) => {
            format!("https://{}.openai.azure.com/openai/v1", name.trim())
        }
        AzureEndpoint::BaseUrl(url) => url,
    };
    route.endpoint.query.insert(
        "api-version".into(),
        config
            .api_version
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "v1".into()),
    );
    route.endpoint.query.extend(config.query);
    route.auth = match config.auth {
        AzureAuth::Key(key) => {
            Auth::Remove("authorization".into()).and_then(Auth::header("api-key", key))
        }
        AzureAuth::Override(auth) => auth,
    };
    let mut model = route.model(id);
    model.defaults = config.defaults;
    model.defaults.provider_options = Some(json::merge(
        &openai_options::provider_defaults(&model.id, false, false, false),
        model
            .defaults
            .provider_options
            .as_ref()
            .unwrap_or(&json::empty()),
    ));
    model
}
pub fn xai(id: impl Into<LosslessString>, config: Config, api: Api) -> Model {
    let mut route = match api {
        Api::Chat => Route::openai_chat(),
        Api::Responses => Route::openai_responses(),
    };
    if api == Api::Chat {
        route.id = "openai-compatible-chat".into();
    }
    route.provider = provider::Id("xai".into());
    route.endpoint.base_url = Profile::Xai.identity().1.into();
    configured(&mut route, &config);
    let mut model = route.model(id);
    model.defaults = config.defaults;
    model
}
pub fn copilot_uses_responses(id: &LosslessString, api: Option<Api>) -> bool {
    if let Some(api) = api {
        return api == Api::Responses;
    }
    let Some(version) = id.as_str().and_then(|id| id.strip_prefix("gpt-")) else {
        return false;
    };
    let major = version
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse::<f64>()
        .unwrap_or(0.0);
    major >= 5.0 && !id.as_str().unwrap_or("").starts_with("gpt-5-mini")
}
pub fn github_copilot_sdk(
    id: impl Into<LosslessString>,
    config: crate::github_copilot::Config,
) -> Result<Model, Error> {
    crate::github_copilot::model(id, config)
}
pub fn github_copilot(
    id: impl Into<LosslessString>,
    config: Config,
    api: Option<Api>,
) -> Result<Model, Error> {
    if config.base_url.as_ref().is_none_or(String::is_empty) {
        return Err(Error::invalid("GitHub Copilot requires a baseURL"));
    }
    let id = id.into();
    let responses = copilot_uses_responses(&id, api);
    let mut route = if responses {
        Route::openai_responses()
    } else {
        Route::openai_chat()
    };
    route.id = if responses {
        "github-copilot-responses"
    } else {
        "github-copilot-chat"
    }
    .into();
    route.provider = provider::Id("github-copilot".into());
    configured(&mut route, &config);
    let mut model = route.model(id);
    model.defaults = config.defaults;
    model.defaults.provider_options = Some(json::merge(
        &openai_options::provider_defaults(&model.id, false, false, false),
        model
            .defaults
            .provider_options
            .as_ref()
            .unwrap_or(&json::empty()),
    ));
    Ok(model)
}
pub enum CloudflareEndpoint {
    Gateway {
        account: String,
        gateway: Option<String>,
    },
    Workers {
        account: String,
    },
    BaseUrl(String),
}
pub enum GatewayAuth {
    Gateway(Credential),
    Upstream(Credential),
    Both {
        gateway: Credential,
        upstream: Credential,
    },
    Override(Auth),
}
fn component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
                )
            {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}
fn cloudflare_url(endpoint: CloudflareEndpoint, gateway: bool) -> Result<String, Error> {
    match endpoint {
        CloudflareEndpoint::BaseUrl(url) if !url.is_empty() => Ok(url),
        CloudflareEndpoint::Gateway {
            account,
            gateway: label,
        } if gateway && !account.is_empty() => Ok(format!(
            "https://gateway.ai.cloudflare.com/v1/{}/{}/compat",
            component(&account),
            component(
                label
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("default")
            )
        )),
        CloudflareEndpoint::Workers { account } if !gateway && !account.is_empty() => Ok(format!(
            "https://api.cloudflare.com/client/v4/accounts/{}/ai/v1",
            component(&account)
        )),
        _ => Err(Error::invalid(
            "Cloudflare requires accountId unless baseURL is supplied",
        )),
    }
}
pub fn cloudflare_gateway(
    id: impl Into<LosslessString>,
    endpoint: CloudflareEndpoint,
    auth: GatewayAuth,
    defaults: Defaults,
) -> Result<Model, Error> {
    let base_url = cloudflare_url(endpoint, true)?;
    let auth = match auth {
        GatewayAuth::Gateway(key) => Auth::Header {
            name: "cf-aig-authorization".into(),
            credential: key,
            bearer: true,
        },
        GatewayAuth::Upstream(key) => Auth::bearer(key),
        GatewayAuth::Both { gateway, upstream } => Auth::Header {
            name: "cf-aig-authorization".into(),
            credential: gateway,
            bearer: true,
        }
        .and_then(Auth::bearer(upstream)),
        GatewayAuth::Override(auth) => auth,
    };
    let mut route = Route::openai_chat();
    route.id = "cloudflare-ai-gateway".into();
    route.provider = provider::Id("cloudflare-ai-gateway".into());
    route.endpoint.base_url = base_url;
    route.auth = auth;
    let mut model = route.model(id);
    model.defaults = defaults;
    Ok(model)
}
pub fn cloudflare_workers(
    id: impl Into<LosslessString>,
    endpoint: CloudflareEndpoint,
    auth: Auth,
    defaults: Defaults,
) -> Result<Model, Error> {
    let mut route = Route::openai_chat();
    route.id = "cloudflare-workers-ai".into();
    route.provider = provider::Id("cloudflare-workers-ai".into());
    route.endpoint.base_url = cloudflare_url(endpoint, false)?;
    route.auth = auth;
    let mut model = route.model(id);
    model.defaults = defaults;
    Ok(model)
}
pub struct OpenRouterConfig {
    pub common: Config,
    pub reasoning: Option<JsonValue>,
}
pub fn openrouter(id: impl Into<LosslessString>, config: OpenRouterConfig) -> Model {
    let mut route = Route::openai_responses();
    route.id = "openrouter-responses".into();
    route.provider = provider::Id("openrouter".into());
    route.endpoint = Endpoint::new(Profile::Openrouter.identity().1, "/responses");
    route.protocol = Arc::new(OpenRouterResponses);
    configured(&mut route, &config.common);
    let mut model = route.model(id);
    model.defaults = config.common.defaults;
    if let Some(reasoning) = config.reasoning {
        model.defaults.provider_options = Some(json::merge(
            model
                .defaults
                .provider_options
                .as_ref()
                .unwrap_or(&json::empty()),
            &json::object([("openrouter", json::object([("reasoning", reasoning)]))]),
        ));
    }
    model
}
pub struct OpenRouterResponses;
impl Protocol for OpenRouterResponses {
    fn id(&self) -> &'static str {
        "openrouter-responses"
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        router_lower(request)
    }
    fn parser(&self, request: &Request) -> Box<dyn StreamParser> {
        Box::new(OpenAIResponses::parser(request))
    }
    fn terminal(&self, event: &JsonValue) -> bool {
        OpenAIResponses.terminal(event)
    }
}
fn router_lower(request: &Request) -> Result<JsonValue, Error> {
    let options = request.provider_options.as_ref();
    let openai = options
        .and_then(|value| get(value, "openai"))
        .filter(|value| matches!(value, JsonValue::Object(_)))
        .cloned()
        .unwrap_or_else(json::empty);
    let router = options
        .and_then(|value| get(value, "openrouter"))
        .filter(|value| matches!(value, JsonValue::Object(_)))
        .cloned()
        .unwrap_or_else(json::empty);
    let store = get(&openai, "store")
        .and_then(json::boolean)
        .or_else(|| get(&router, "store").and_then(json::boolean));
    if store == Some(true) {
        return Err(Error::invalid(
            "OpenRouter Responses is stateless: store:true is not supported",
        ));
    }
    if [&openai, &router].iter().any(|value| {
        ["previousResponseId", "previous_response_id"]
            .iter()
            .any(|key| string(value, key).is_some())
    }) {
        return Err(Error::invalid(
            "OpenRouter Responses is stateless: previous_response_id is not supported",
        ));
    }
    let key = [
        (&router, "promptCacheKey"),
        (&router, "prompt_cache_key"),
        (&openai, "promptCacheKey"),
        (&openai, "prompt_cache_key"),
    ]
    .into_iter()
    .find_map(|(value, key)| string(value, key))
    .cloned();
    let session = [
        (&router, "sessionID"),
        (&router, "session_id"),
        (&openai, "sessionID"),
        (&openai, "session_id"),
    ]
    .into_iter()
    .find_map(|(value, key)| string(value, key))
    .cloned();
    let mut sanitized = request.clone();
    let mut openai = json::remove(
        &openai,
        &[
            "previousResponseId",
            "previous_response_id",
            "prompt_cache_key",
            "session_id",
            "sessionID",
        ],
    );
    json::set(&mut openai, "store", JsonValue::Bool(false));
    if let Some(key) = key.as_ref().filter(|value| !value.is_empty()) {
        json::set(&mut openai, "promptCacheKey", s(key.clone()));
    }
    let mut options = options.cloned().unwrap_or_else(json::empty);
    json::set(&mut options, "openai", openai);
    json::set(
        &mut options,
        "openrouter",
        json::remove(
            &router,
            &["store", "previousResponseId", "previous_response_id"],
        ),
    );
    sanitized.provider_options = Some(options);
    let raw = openai_responses::lower(&sanitized)?;
    let mut body = json::remove(
        &raw,
        &[
            "store",
            "previous_response_id",
            "prompt_cache_options",
            "reasoning",
        ],
    );
    let reasoning = json::merge(
        get(&raw, "reasoning")
            .filter(|value| matches!(value, JsonValue::Object(_)))
            .unwrap_or(&json::empty()),
        get(&router, "reasoning")
            .filter(|value| matches!(value, JsonValue::Object(_)))
            .unwrap_or(&json::empty()),
    );
    if matches!(&reasoning,JsonValue::Object(fields) if !fields.is_empty()) {
        json::set(&mut body, "reasoning", reasoning);
    }
    if let Some(key) = key.filter(|value| !value.is_empty()) {
        json::set(&mut body, "prompt_cache_key", s(key));
    }
    if let Some(session) = session.filter(|value| !value.is_empty()) {
        json::set(&mut body, "session_id", s(session));
    }
    if let Some(usage) = get(&router, "usage") {
        if usage == &JsonValue::Bool(true) {
            json::set(
                &mut body,
                "usage",
                json::object([("include", JsonValue::Bool(true))]),
            );
        } else if matches!(usage, JsonValue::Object(_)) {
            json::set(&mut body, "usage", usage.clone());
        }
    }
    if let Some(include) = openai_options::include(request) {
        json::set(&mut body, "include", include);
    } else if openai_options::value(request, "include").is_none()
        && request
            .model
            .id
            .as_str()
            .is_some_and(|id| id.starts_with("openai/"))
        && openai_options::gpt56(&request.model.id)
    {
        json::set(
            &mut body,
            "include",
            JsonValue::Array(vec![s("reasoning.encrypted_content")]),
        );
    }
    if openai_options::cache_options(request)
        .as_ref()
        .and_then(|value| get(value, "mode"))
        .and_then(json::text)
        == Some("explicit")
        && let Some(options) = get(&raw, "prompt_cache_options")
    {
        json::set(&mut body, "prompt_cache_options", options.clone());
    }
    if request.model.id.as_str().is_some_and(|id| {
        let id = id.to_lowercase();
        id.starts_with("anthropic/") || id.starts_with("~anthropic/")
    }) && let Some(hint) = crate::cache::auto_placement_hint(request)
    {
        let mut control = json::object([("type", s("ephemeral"))]);
        if hint.one_hour() {
            json::set(&mut control, "ttl", s("1h"));
        }
        json::set(&mut body, "cache_control", control);
    }
    let fields = [
        "model",
        "input",
        "instructions",
        "tools",
        "tool_choice",
        "store",
        "previous_response_id",
        "service_tier",
        "prompt_cache_key",
        "session_id",
        "prompt_cache_retention",
        "prompt_cache_options",
        "context_management",
        "include",
        "reasoning",
        "text",
        "max_output_tokens",
        "temperature",
        "top_p",
        "usage",
        "cache_control",
        "stream",
    ];
    let mut ordered = pick(&body, &fields);
    if let (JsonValue::Object(values), JsonValue::Object(output)) = (body, &mut ordered) {
        for (key, value) in values
            .iter()
            .filter(|(key, _)| !key.as_str().is_some_and(|key| fields.contains(&key)))
        {
            output.insert(key.clone(), value.clone());
        }
    }
    Ok(ordered)
}
