use crate::{
    Error,
    auth::Auth,
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
    Meta,
    Openrouter,
}
impl Profile {
    pub fn identity(self) -> (&'static str, &'static str) {
        match self {
            Self::Meta => ("meta", "https://api.llama.com/v1"),
            Self::Openrouter => ("openrouter", "https://openrouter.ai/api/v1"),
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
    let reasoning = if get(&reasoning, "effort") == Some(&JsonValue::Null) {
        json::remove(&reasoning, &["effort"])
    } else {
        reasoning
    };
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
