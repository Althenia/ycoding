use crate::{
    Error,
    auth::{Auth, Credential},
    json::{self, s},
    llm::{Defaults, Model, Request},
    openai_chat::OpenAIChat,
    providers::{self, Api, Config},
    route::{Protocol, Route, StreamParser},
};
use std::{collections::BTreeMap, sync::Arc};
use ycoding_schema::{JsonValue, LosslessString, parse_json, provider, stringify_json};

#[derive(Clone, Default)]
pub struct GatewayOptions {
    pub metadata: Option<JsonValue>,
    pub cache_ttl: Option<u64>,
    pub cache_key: Option<String>,
    pub skip_cache: Option<bool>,
    pub collect_log: Option<bool>,
}
pub struct GatewayConfig {
    pub account_id: Option<String>,
    pub gateway_id: Option<String>,
    pub api_key: Option<Credential>,
    pub base_url: Option<String>,
    pub environment: BTreeMap<String, String>,
    pub options: GatewayOptions,
    pub defaults: Defaults,
    pub user_agent: String,
}
pub fn gateway(id: impl Into<LosslessString>, config: GatewayConfig) -> Result<Model, Error> {
    let token = ["CLOUDFLARE_API_TOKEN", "CF_AIG_TOKEN"]
        .iter()
        .find_map(|key| config.environment.get(*key))
        .map(|key| Credential::value(key.clone()))
        .or(config.api_key)
        .ok_or_else(|| Error::invalid("Cloudflare gateway requires apiKey"))?;
    if let Some(base_url) = config.base_url {
        return providers::compatible(
            id,
            provider::Id("cloudflare-ai-gateway".into()),
            Config {
                auth: Auth::bearer(token),
                base_url: Some(base_url),
                query: BTreeMap::new(),
                defaults: config.defaults,
            },
            Api::Chat,
        );
    }
    let account = config
        .environment
        .get("CLOUDFLARE_ACCOUNT_ID")
        .cloned()
        .or(config.account_id)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| Error::invalid("Cloudflare gateway requires accountId"))?;
    let gateway = config
        .environment
        .get("CLOUDFLARE_GATEWAY_ID")
        .cloned()
        .or(config.gateway_id)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| Error::invalid("Cloudflare gateway requires gatewayId"))?;
    let mut route = Route::openai_chat();
    route.id = "cloudflare-unified-gateway".into();
    route.provider = provider::Id("cloudflare-ai-gateway".into());
    route.endpoint.base_url = format!(
        "https://gateway.ai.cloudflare.com/v1/{}/{}",
        component(&account),
        component(&gateway)
    );
    route.endpoint.path.clear();
    route.auth = Auth::Header {
        name: "cf-aig-authorization".into(),
        credential: token.clone(),
        bearer: true,
    };
    route.defaults = config.defaults;
    let metadata = config.options.metadata.or_else(|| {
        route
            .defaults
            .http
            .headers
            .get("cf-aig-metadata")
            .and_then(|value| parse_json(value).ok())
    });
    if let Some(metadata) = metadata {
        route
            .defaults
            .http
            .headers
            .insert("cf-aig-metadata".into(), stringify_json(&metadata));
    }
    for (name, value) in [
        (
            "cf-cache-ttl",
            config
                .options
                .cache_ttl
                .filter(|value| *value != 0)
                .map(|v| v.to_string()),
        ),
        ("cf-aig-cache-key", config.options.cache_key),
        (
            "cf-skip-cache",
            config
                .options
                .skip_cache
                .filter(|value| *value)
                .map(|v| v.to_string()),
        ),
        (
            "cf-aig-collect-log",
            config.options.collect_log.map(|v| v.to_string()),
        ),
    ] {
        if let Some(value) = value {
            route.defaults.http.headers.insert(name.into(), value);
        }
    }
    route
        .defaults
        .http
        .headers
        .insert("User-Agent".into(), config.user_agent);
    route.protocol = Arc::new(UnifiedWithKey(token));
    Ok(route.model(id))
}
struct UnifiedWithKey(Credential);
impl Protocol for UnifiedWithKey {
    fn id(&self) -> &'static str {
        "cloudflare-unified"
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        let headers = Auth::bearer(self.0.clone()).apply(crate::auth::Input {
            method: "POST",
            url: "",
            body: "",
            headers: reqwest::header::HeaderMap::new(),
        })?;
        let authorization = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| Error::invalid("Invalid Cloudflare authorization"))?;
        Ok(JsonValue::Array(vec![json::object([
            ("provider", s("compat")),
            ("endpoint", s("chat/completions")),
            (
                "headers",
                json::object([
                    ("Authorization", s(authorization)),
                    ("Content-Type", s("application/json")),
                ]),
            ),
            ("query", OpenAIChat.lower(request)?),
        ])]))
    }
    fn parser(&self, request: &Request) -> Box<dyn StreamParser> {
        OpenAIChat.parser(request)
    }
}
pub struct WorkersConfig {
    pub account_id: Option<String>,
    pub common: Config,
    pub environment: BTreeMap<String, String>,
    pub user_agent: String,
}
pub fn workers(id: impl Into<LosslessString>, mut config: WorkersConfig) -> Result<Model, Error> {
    let account = config
        .environment
        .get("CLOUDFLARE_ACCOUNT_ID")
        .cloned()
        .or(config.account_id);
    config.common.base_url = config
        .common
        .base_url
        .map(|url| {
            url.replace(
                "${CLOUDFLARE_ACCOUNT_ID}",
                config
                    .environment
                    .get("CLOUDFLARE_ACCOUNT_ID")
                    .map(String::as_str)
                    .unwrap_or("${CLOUDFLARE_ACCOUNT_ID}"),
            )
        })
        .or_else(|| {
            account.map(|account| {
                format!(
                    "https://api.cloudflare.com/client/v4/accounts/{}/ai/v1",
                    component(&account)
                )
            })
        });
    if let Some(key) = config.environment.get("CLOUDFLARE_API_KEY") {
        config.common.auth = Auth::bearer(Credential::value(key.clone()));
    }
    if !config
        .common
        .defaults
        .http
        .headers
        .keys()
        .any(|name| name.eq_ignore_ascii_case("user-agent"))
    {
        config
            .common
            .defaults
            .http
            .headers
            .insert("User-Agent".into(), config.user_agent);
    }
    providers::compatible(
        id,
        provider::Id("cloudflare-workers-ai".into()),
        config.common,
        Api::Chat,
    )
}
fn component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.') {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}
