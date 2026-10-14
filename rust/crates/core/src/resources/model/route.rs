use super::super::catalog::{field, merge_headers, models_dev::text, object};
use super::{Error, ProviderFamily, family};
use std::{collections::BTreeMap, sync::Arc};
use ycoding_ai::{
    auth::{Auth, Credential, ProviderAuth},
    llm::{Defaults, Model},
    providers::{self, Api, Config, OpenAIConfig, Transport},
    route::Route,
};
use ycoding_schema::{DomainEncode, JsonObject, JsonValue, credential, model};

#[derive(Clone)]
pub struct ClaudeHost {
    pub accounts: super::super::auth::claude::Store,
    pub credentials: super::super::credential::Service,
    pub sessions: crate::session::store::Service,
    pub quota: super::quota::Service,
    pub settings: ycoding_ai::claude_code::Settings,
}

struct ClaudeAccount {
    host: ClaudeHost,
    expected: super::super::credential::Info,
    source: String,
}
impl ycoding_ai::claude_code::Account for ClaudeAccount {
    fn resolve(&self, force_refresh: bool) -> ycoding_ai::claude_code::Resolution<'_> {
        Box::pin(async move {
            self.host
                .credentials
                .current_account(&self.expected)
                .map_err(|_| ycoding_ai::claude_code::reconnect())?;
            let credentials = self
                .host
                .accounts
                .resolve(
                    &self.source,
                    chrono::Utc::now().timestamp_millis(),
                    force_refresh,
                )
                .await
                .map_err(|_| ycoding_ai::claude_code::reconnect())?
                .ok_or_else(ycoding_ai::claude_code::reconnect)?;
            self.host
                .credentials
                .current_account(&self.expected)
                .map_err(|_| ycoding_ai::claude_code::reconnect())?;
            Ok(ycoding_ai::claude_code::Credentials {
                access_token: ycoding_ai::auth::Secret::new(credentials.access_token),
                subscription_type: credentials.subscription_type,
            })
        })
    }
    fn billing_sample(&self, session: &str) -> Option<ycoding_schema::LosslessString> {
        let id = ycoding_schema::session::Id::new(session).ok()?;
        let snapshot = self.host.sessions.client.snapshot().ok()?;
        let first = crate::session::history::type_rows(
            &snapshot,
            &id,
            "user",
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            ycoding_store::IndexOrder::Ascending,
            None,
            1,
        )
        .ok()?
        .into_iter()
        .next()?;
        let ycoding_schema::session_message::Info::User(user) = first.record.info().ok()? else {
            return None;
        };
        Some(ycoding_ai::claude_code::billing_sample(&user.text))
    }
    fn observe(
        &self,
        observation: ycoding_schema::provider_usage::Observation,
    ) -> Result<(), ycoding_ai::claude_code::ObservationError> {
        self.host
            .credentials
            .current_account(&self.expected)
            .map_err(|_| ycoding_ai::claude_code::ObservationError)?;
        self.host
            .quota
            .observe(observation, Some(super::account_identity(&self.expected)))
            .map_err(|_| ycoding_ai::claude_code::ObservationError)
    }
}

pub fn from_catalog_model_with_claude(
    info: &model::Info,
    value: Option<&credential::Value>,
    selected: Option<&super::super::credential::Info>,
    host: Option<&ClaudeHost>,
) -> Result<Model, Error> {
    let managed = family(info.package.as_ref().ok_or(Error::UnsupportedPackage)?)?
        == ProviderFamily::Anthropic
        && (matches!(value, Some(credential::Value::OAuth(value)) if value.method_id.as_lossless().as_str() == Some("claude-code"))
            || info
                .settings
                .as_ref()
                .and_then(|settings| settings.0.get(&"apiKey".into()))
                .and_then(text)
                == Some("claude-code")
                && !matches!(value, Some(credential::Value::Key(_))));
    if !managed {
        return from_catalog_model(info, value);
    }
    let host = host.ok_or(Error::ProfileUnavailable)?;
    let selected = selected.ok_or(Error::ProfileUnavailable)?;
    host.credentials
        .current_account(selected)
        .map_err(|_| Error::ProfileUnavailable)?;
    let stored = selected
        .secret()
        .domain()
        .map_err(|_| Error::ProfileUnavailable)?;
    let source =
        super::super::auth::claude::credential_source(&stored).ok_or(Error::ProfileUnavailable)?;
    let Some(credential::Value::OAuth(value)) = value else {
        return Err(Error::ProfileUnavailable);
    };
    if value.method_id.as_lossless().as_str() != Some("claude-code")
        || value
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get(&"authKind".into()))
            != Some(&JsonValue::String("claude-code".into()))
        || value
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get(&"managed".into()))
            != Some(&JsonValue::Bool(true))
        || value
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get(&"source".into()))
            .and_then(text)
            != Some(source)
        || value
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get(&"requiresLogin".into()))
            == Some(&JsonValue::Bool(true))
    {
        return Err(Error::ProfileUnavailable);
    }
    let mut configured = info.clone();
    if let Some(settings) = &mut configured.settings {
        let mut fields = JsonObject::new();
        for (name, value) in settings
            .0
            .iter()
            .filter(|(name, _)| !matches!(name.as_str(), Some("apiKey" | "claudeCodeSource")))
        {
            fields.insert(name.clone(), value.clone());
        }
        settings.0 = fields;
    }
    let mut model = from_catalog_model_base(&configured, None)?;
    let mut route = ycoding_ai::claude_code::route(
        Arc::new(ClaudeAccount {
            host: host.clone(),
            expected: selected.clone(),
            source: source.into(),
        }),
        host.settings.clone(),
    );
    route.endpoint.base_url = model.route.endpoint.base_url.clone();
    route.provider = info.provider_id.clone();
    model.route = Arc::new(route);
    Ok(model)
}

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
    if family == ProviderFamily::Anthropic
        && (matches!(credential, Some(credential::Value::OAuth(value)) if value.method_id.as_lossless().as_str() == Some("claude-code"))
            || field(&settings, "apiKey").and_then(text) == Some("claude-code")
                && !matches!(credential, Some(credential::Value::Key(_))))
    {
        return Err(Error::ProfileUnavailable);
    }
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
            .or_else(|| field(&settings, "authToken"))
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
        ProviderFamily::Anthropic => "anthropic",
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
    let headers = generated
        .iter()
        .map(|(key, value)| {
            Ok((
                key.to_utf8().map_err(|_| Error::InvalidSettings)?,
                text(value).ok_or(Error::InvalidSettings)?.to_owned(),
            ))
        })
        .collect::<Result<BTreeMap<_, _>, Error>>()?;
    let mut defaults = Defaults {
        output_limit: Some(info.limit.output.get() as f64),
        context_limit: Some(info.limit.context.get() as f64),
        provider_options: options,
        ..Defaults::default()
    };
    defaults.http.headers = headers;
    if family == ProviderFamily::Compatible
        && let Some(usage) = field(&settings, "includeUsage")
    {
        defaults.provider_options = Some(super::super::catalog::merge_json(
            defaults.provider_options.as_ref().unwrap_or(&object(&[])),
            &object(&[(
                "openai-compatible",
                object(&[("includeUsage", usage.clone())]),
            )]),
        ));
    }
    if family == ProviderFamily::Anthropic && !native {
        let existing = defaults
            .http
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("anthropic-beta"))
            .map(|(_, value)| value.clone())
            .unwrap_or_default();
        defaults
            .http
            .headers
            .retain(|name, _| !name.eq_ignore_ascii_case("anthropic-beta"));
        defaults.http.headers.insert(
            "anthropic-beta".into(),
            ycoding_ai::claude_code::merge_betas(existing.split(',').chain([
                "interleaved-thinking-2025-05-14",
                "fine-grained-tool-streaming-2025-05-14",
            ]))
            .join(","),
        );
    }
    defaults.http.body = info.body.as_ref().map(DomainEncode::encode);
    let mut common = Config::new(auth.clone());
    common.base_url = field(&settings, "baseURL")
        .and_then(text)
        .map(str::to_owned);
    common.defaults = defaults.clone();
    let api = if native && family == ProviderFamily::Compatible {
        if package.as_str() == Some("@ycoding-ai/ai/providers/openai-compatible/responses") {
            Api::Responses
        } else {
            Api::Chat
        }
    } else if info
        .api
        .as_ref()
        .and_then(|a| a.0.as_str())
        .or_else(|| field(&settings, "api").and_then(text))
        == Some("responses")
    {
        Api::Responses
    } else {
        Api::Chat
    };
    let mut model = match family {
        ProviderFamily::OpenAI if matches!(credential, Some(credential::Value::OAuth(value)) if matches!(value.method_id.as_lossless().as_str(),Some("chatgpt-browser"|"chatgpt-headless"))) =>
        {
            let mut config = ycoding_ai::openai_codex::Config::new(Credential::value(
                key.as_ref().ok_or(Error::ProfileUnavailable)?,
            ));
            config.account_id = credential.and_then(|value| match value {
                credential::Value::OAuth(value) => value
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.get(&"accountID".into()))
                    .and_then(text)
                    .map(str::to_owned),
                _ => None,
            });
            config.websocket = field(&settings, "transport").and_then(text) == Some("websocket");
            config.defaults = defaults;
            ycoding_ai::openai_codex::model(info.model_id.clone(), config)
                .map_err(|_| Error::InvalidSettings)?
        }
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
                ProviderAuth::Override(Auth::None)
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
        ProviderFamily::Compatible => {
            providers::compatible(info.model_id.clone(), info.provider_id.clone(), common, api)
                .map_err(|_| Error::InvalidSettings)?
        }
        ProviderFamily::OpenRouter => providers::openrouter(
            info.model_id.clone(),
            providers::OpenRouterConfig {
                common,
                reasoning: field(&settings, "reasoning").cloned(),
            },
        ),
        ProviderFamily::Cursor => return Err(Error::UnsupportedPackage),
    };
    if !native
        && let Some(package) = package.as_str()
        && let Some(provider) = crate::extension::provider::find(package)
    {
        let provider: std::sync::Arc<dyn ycoding_ai::route::ProcessAttempt> = provider;
        Arc::make_mut(&mut model.route).transport = ycoding_ai::route::Transport::Process(provider);
    }
    model.provider = info.provider_id.clone();
    Arc::make_mut(&mut model.route).provider = info.provider_id.clone();
    Ok(model)
}
