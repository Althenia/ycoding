use super::super::auth::bedrock;
use super::super::catalog::{field, merge_headers, merge_json, models_dev::text, object};
use super::{Error, ProviderFamily, family};
use std::{collections::BTreeMap, sync::Arc};
use ycoding_ai::{
    auth::{Auth, Credential, ProviderAuth},
    llm::{Defaults, Model},
    providers::{self, Api, Config, OpenAIConfig, Transport},
    route::Route,
};
use ycoding_schema::{DomainEncode, JsonObject, JsonValue, credential, model};

pub fn from_catalog_model(
    info: &model::Info,
    credential: Option<&credential::Value>,
) -> Result<Model, Error> {
    if info.provider_id.0 == "muse".into() {
        return super::super::muse::from_catalog_model(
            info,
            credential,
            None,
            ycoding_ai::muse::Runtime::shared().map_err(|_| Error::InvalidSettings)?,
        );
    }
    from_catalog_model_base(info, credential)
}

pub(crate) fn from_catalog_model_base(
    info: &model::Info,
    credential: Option<&credential::Value>,
) -> Result<Model, Error> {
    let package = info.package.as_ref().ok_or(Error::UnsupportedPackage)?;
    let family = family(package)?;
    let native = package.as_str().is_some_and(|p| !p.starts_with("aisdk:"));
    let settings = info
        .settings
        .as_ref()
        .map(|s| s.encode())
        .unwrap_or_else(|| object(&[]));
    if native
        && family == ProviderFamily::OpenAI
        && field(&settings, "transport")
            .is_some_and(|v| !matches!(text(v), Some("http" | "websocket")))
    {
        return Err(Error::InvalidSettings);
    }
    if package.as_str() == Some("@ycoding-ai/ai/providers/anthropic-compatible")
        && field(&settings, "baseURL")
            .and_then(text)
            .is_none_or(str::is_empty)
    {
        return Err(Error::InvalidSettings);
    }
    let key = match credential {
        Some(credential::Value::Key(value)) => {
            Some(value.key.to_utf8().map_err(|_| Error::InvalidSettings)?)
        }
        Some(credential::Value::OAuth(value)) => {
            Some(value.access.to_utf8().map_err(|_| Error::InvalidSettings)?)
        }
        None => field(&settings, "apiKey")
            .and_then(text)
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
    };
    if family == ProviderFamily::Anthropic
        && matches!(credential, Some(credential::Value::OAuth(_)))
        && !native
    {
        return Err(Error::UnsupportedPackage);
    }
    let auth = key
        .as_ref()
        .map(|key| Auth::bearer(Credential::value(key)))
        .unwrap_or(Auth::None);
    let namespace = match family {
        ProviderFamily::Anthropic | ProviderFamily::VertexAnthropic => "anthropic",
        ProviderFamily::Google | ProviderFamily::Vertex => "google",
        ProviderFamily::Bedrock => "bedrock",
        ProviderFamily::OpenRouter => "openrouter",
        _ => "openai",
    };
    let options = if native {
        field(&settings, "providerOptions").cloned()
    } else {
        match &settings {
            JsonValue::Object(settings) => {
                let mut options = JsonObject::new();
                for (key, value) in settings.iter().filter(|(key, _)| {
                    ![
                        "apiKey",
                        "authToken",
                        "accessToken",
                        "baseURL",
                        "claudeCodeSource",
                    ]
                    .iter()
                    .any(|name| *key == (*name).into())
                }) {
                    options.insert(key.clone(), value.clone());
                }
                (!options.is_empty()).then(|| object(&[(namespace, JsonValue::Object(options))]))
            }
            _ => None,
        }
    };
    let mut generated = JsonObject::new();
    if family == ProviderFamily::OpenAI {
        for (setting, header) in [
            ("organization", "OpenAI-Organization"),
            ("project", "OpenAI-Project"),
        ] {
            if let Some(value @ JsonValue::String(_)) = field(&settings, setting) {
                generated.insert(header.into(), value.clone());
            }
        }
    }
    let generated = info
        .headers
        .as_ref()
        .map(|headers| merge_headers(&generated, headers))
        .unwrap_or(generated);
    let headers = Some(&generated)
        .as_ref()
        .map(|headers| {
            headers
                .iter()
                .map(|(key, value)| {
                    Ok((
                        key.to_utf8().map_err(|_| Error::InvalidSettings)?,
                        text(value).ok_or(Error::InvalidSettings)?.to_owned(),
                    ))
                })
                .collect::<Result<BTreeMap<_, _>, Error>>()
        })
        .transpose()?
        .unwrap_or_default();
    let mut defaults = Defaults {
        output_limit: Some(info.limit.output.get() as f64),
        context_limit: Some(info.limit.context.get() as f64),
        provider_options: options,
        ..Defaults::default()
    };
    defaults.http.headers = headers;
    defaults.http.body = info.body.as_ref().map(DomainEncode::encode);
    if let Some(credential::Value::Key(value)) = credential
        && let Some(metadata) = &value.metadata
    {
        defaults.http.body = Some(
            defaults
                .http
                .body
                .as_ref()
                .map(|body| merge_json(body, &metadata.encode()))
                .unwrap_or_else(|| metadata.encode()),
        );
    }
    let mut common = Config::new(auth.clone());
    common.base_url = field(&settings, "baseURL")
        .and_then(text)
        .map(str::to_owned);
    common.defaults = defaults.clone();
    if family == ProviderFamily::Azure
        && let Some(JsonValue::Object(query)) = field(&settings, "queryParams")
    {
        common.query = query
            .iter()
            .map(|(key, value)| {
                Ok((
                    key.to_utf8().map_err(|_| Error::InvalidSettings)?,
                    text(value).ok_or(Error::InvalidSettings)?.into(),
                ))
            })
            .collect::<Result<_, Error>>()?;
    }
    let api = info
        .api
        .as_ref()
        .map(|a| &a.0)
        .and_then(|a| a.as_str())
        .or_else(|| field(&settings, "api").and_then(text));
    let explicit_api = api.map(|api| {
        if api == "responses" {
            Api::Responses
        } else {
            Api::Chat
        }
    });
    let api = if native && family == ProviderFamily::Xai {
        Api::Responses
    } else if native && family == ProviderFamily::Azure {
        if package.as_str() == Some("@ycoding-ai/ai/providers/azure/chat") {
            Api::Chat
        } else {
            Api::Responses
        }
    } else if native && family == ProviderFamily::Compatible {
        if package.as_str() == Some("@ycoding-ai/ai/providers/openai-compatible/responses") {
            Api::Responses
        } else {
            Api::Chat
        }
    } else if api == Some("responses") || (api.is_none() && family == ProviderFamily::Xai) {
        Api::Responses
    } else {
        Api::Chat
    };
    let mut model = match family {
        ProviderFamily::OpenAI if native => providers::openai(
            info.model_id.clone(),
            OpenAIConfig {
                common,
                organization: field(&settings, "organization")
                    .and_then(text)
                    .map(str::to_owned),
                project: field(&settings, "project")
                    .and_then(text)
                    .map(str::to_owned),
                transport: if field(&settings, "transport").and_then(text) == Some("websocket") {
                    Transport::WebSocket
                } else {
                    Transport::Http
                },
            },
        ),
        ProviderFamily::OpenAI => {
            let mut route = Route::openai_responses();
            route.auth = auth;
            if let Some(base) = common.base_url {
                route.endpoint.base_url = base;
            }
            let mut model = route.model(info.model_id.clone());
            model.defaults = defaults;
            model
        }
        ProviderFamily::Anthropic => {
            let provider_auth = if native && matches!(credential, Some(credential::Value::OAuth(_)))
            {
                key.as_ref()
                    .map(|key| ProviderAuth::Bearer(Credential::value(key)))
                    .unwrap_or(ProviderAuth::Override(Auth::None))
            } else {
                key.as_ref()
                    .map(|key| ProviderAuth::ApiKey(Credential::value(key)))
                    .unwrap_or(ProviderAuth::Override(Auth::None))
            };
            let mut route = Route::anthropic_provider(provider_auth);
            if let Some(base) = common.base_url {
                route.endpoint.base_url = base;
            }
            let mut model = route.model(info.model_id.clone());
            model.defaults = defaults;
            model
        }
        ProviderFamily::Google => ycoding_ai::google::route(ycoding_ai::google::Config {
            api_key: key.map(Credential::value),
            auth: None,
            base_url: common.base_url,
            defaults,
        })
        .model(info.model_id.clone()),
        ProviderFamily::Vertex | ProviderFamily::VertexAnthropic => {
            let config = ycoding_ai::google_vertex_shared::Config {
                api_key: if matches!(credential, Some(credential::Value::OAuth(_)))
                    || family == ProviderFamily::VertexAnthropic
                {
                    None
                } else {
                    key.as_ref().map(ycoding_ai::auth::Secret::new)
                },
                access_token: if matches!(credential, Some(credential::Value::OAuth(_)))
                    || family == ProviderFamily::VertexAnthropic
                {
                    key.map(Credential::value)
                } else {
                    None
                },
                auth: None,
                base_url: common.base_url,
                project: field(&settings, "project")
                    .and_then(text)
                    .map(str::to_owned),
                location: field(&settings, "location")
                    .and_then(text)
                    .map(str::to_owned),
                defaults,
            };
            if family == ProviderFamily::VertexAnthropic {
                ycoding_ai::google_vertex_messages::route(config)
                    .map_err(|_| Error::InvalidSettings)?
                    .model(info.model_id.clone())
            } else {
                ycoding_ai::google_vertex::model(info.model_id.clone(), config)
                    .map_err(|_| Error::InvalidSettings)?
            }
        }
        ProviderFamily::Compatible => {
            providers::compatible(info.model_id.clone(), info.provider_id.clone(), common, api)
                .map_err(|_| Error::InvalidSettings)?
        }
        ProviderFamily::Xai => providers::xai(info.model_id.clone(), common, api),
        ProviderFamily::OpenRouter => providers::openrouter(
            info.model_id.clone(),
            providers::OpenRouterConfig {
                common,
                reasoning: field(&settings, "reasoning").cloned(),
            },
        ),
        ProviderFamily::Azure => {
            let endpoint = common
                .base_url
                .map(providers::AzureEndpoint::BaseUrl)
                .or_else(|| {
                    field(&settings, "resourceName")
                        .and_then(text)
                        .map(|s| providers::AzureEndpoint::Resource(s.into()))
                })
                .ok_or(Error::InvalidSettings)?;
            providers::azure(
                info.model_id.clone(),
                providers::AzureConfig {
                    endpoint,
                    auth: key
                        .map(|key| providers::AzureAuth::Key(Credential::value(key)))
                        .unwrap_or(providers::AzureAuth::Override(Auth::None)),
                    api_version: field(&settings, "apiVersion")
                        .and_then(text)
                        .map(str::to_owned),
                    query: common.query,
                    defaults,
                },
                api,
            )
        }
        ProviderFamily::Bedrock => {
            let endpoint = common.base_url.ok_or(Error::InvalidSettings)?;
            let auth = bedrock_auth(&settings, key.as_deref(), &endpoint)?;
            ycoding_ai::bedrock::amazon_bedrock(
                info.model_id.clone(),
                ycoding_ai::bedrock::Config {
                    endpoint,
                    auth,
                    defaults,
                },
            )
        }
        ProviderFamily::RunPod => {
            let worker = match field(&settings, "worker").and_then(text) {
                Some("ollama") => ycoding_ai::runpod::Worker::Ollama,
                Some("vllm") => ycoding_ai::runpod::Worker::Vllm,
                _ => return Err(Error::InvalidSettings),
            };
            ycoding_ai::runpod::model(info.model_id.clone(), worker, common)
                .map_err(|_| Error::InvalidSettings)?
        }
        ProviderFamily::Copilot => {
            providers::github_copilot(info.model_id.clone(), common, explicit_api)
                .map_err(|_| Error::InvalidSettings)?
        }
    };
    if !native
        && let Some(package) = package.as_str()
        && let Some(provider) = crate::extension::provider::find(package)
    {
        let provider: std::sync::Arc<dyn ycoding_ai::route::ProcessAttempt> = provider;
        Arc::make_mut(&mut model.route).transport = ycoding_ai::route::Transport::Process(provider);
    }
    model.provider = info.provider_id.clone();
    if native && family == ProviderFamily::Xai {
        Arc::make_mut(&mut model.route).id = "openai-responses".into();
    }
    Arc::make_mut(&mut model.route).provider = info.provider_id.clone();
    Ok(model)
}

fn bedrock_auth(settings: &JsonValue, key: Option<&str>, endpoint: &str) -> Result<Auth, Error> {
    if let Some(key) = key.filter(|key| !key.is_empty()) {
        return Ok(Auth::bearer(Credential::value(key)));
    }
    let env: BTreeMap<String, String> = std::env::vars().collect();
    if let Some(token) = env
        .get("AWS_BEARER_TOKEN_BEDROCK")
        .filter(|token| !token.is_empty())
    {
        return Ok(Auth::bearer(Credential::value(token)));
    }
    let setting = field(settings, "region").and_then(text);
    let region = bedrock::region(setting, &env, endpoint);
    let options = bedrock::Options {
        profile: field(settings, "profile").and_then(text).map(str::to_owned),
        home: bedrock::home(),
        region: Some(region.clone()),
        ..bedrock::Options::default()
    };
    let credentials =
        bedrock::resolve_blocking(&env, &options).map_err(|_| Error::InvalidSettings)?;
    let Some(credentials) = credentials else {
        return Ok(Auth::None);
    };
    Ok(ycoding_ai::bedrock_auth::sigv4(
        Some(ycoding_ai::bedrock_auth::Credentials {
            region,
            access_key_id: ycoding_ai::auth::Secret::new(credentials.access_key_id),
            secret_access_key: ycoding_ai::auth::Secret::new(credentials.secret_access_key),
            session_token: credentials.session_token.map(ycoding_ai::auth::Secret::new),
        }),
        || chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string(),
    ))
}
