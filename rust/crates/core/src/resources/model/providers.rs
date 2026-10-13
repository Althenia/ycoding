use super::{Error, ProviderFamily, family, route};
use crate::resources::{
    auth,
    catalog::{field, models_dev::text, object},
    cursor,
};
use std::{collections::BTreeMap, sync::Arc};
use ycoding_ai::{
    auth::{Auth, Credential, Secret},
    llm::{Defaults, Model},
    route::{Executor, Prepared, Protocol, StreamParser},
};
use ycoding_schema::{DomainDecode, DomainEncode, JsonValue, credential, model};

#[derive(Clone)]
pub struct ProviderContext {
    pub environment: BTreeMap<String, String>,
    pub version: String,
    pub http: reqwest::Client,
    pub endpoints: BTreeMap<String, String>,
    google: Arc<tokio::sync::Mutex<Option<auth::google::Store>>>,
    pub cursor: cursor::route::Runtimes,
}
impl ProviderContext {
    pub fn new(environment: BTreeMap<String, String>, version: &str) -> Result<Self, Error> {
        Ok(Self {
            environment,
            version: version.into(),
            http: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .map_err(|_| Error::InvalidSettings)?,
            google: Arc::new(tokio::sync::Mutex::new(None)),
            endpoints: BTreeMap::new(),
            cursor: cursor::route::Runtimes::new(Default::default()),
        })
    }
    pub async fn set_google(&self, store: auth::google::Store) {
        *self.google.lock().await = Some(store);
    }
    pub async fn shutdown(&self) {
        if let Some(google) = self.google.lock().await.take() {
            let _ = google.shutdown().await;
        }
        self.cursor.shutdown().await;
    }
    pub async fn selected_model(
        &self,
        info: &model::Info,
        value: Option<&credential::Value>,
        selected: Option<&crate::resources::credential::Info>,
        claude: Option<&super::ClaudeHost>,
        cursor: Option<&cursor::route::Host>,
        cursor_auth: Option<&auth::cursor::Store>,
    ) -> Result<Model, Error> {
        if info.provider_id.0 == "muse".into() {
            return crate::resources::muse::from_catalog_model(
                info,
                value,
                selected,
                ycoding_ai::muse::Runtime::shared().map_err(|_| Error::InvalidSettings)?,
            );
        }
        if family(info.package.as_ref().ok_or(Error::UnsupportedPackage)?)?
            == ProviderFamily::Cursor
        {
            let source = value
                .cloned()
                .or_else(|| {
                    info.settings
                        .as_ref()
                        .and_then(|settings| settings.0.get(&"apiKey".into()))
                        .and_then(text)
                        .map(str::to_owned)
                        .or_else(|| self.environment.get("CURSOR_API_KEY").cloned())
                        .map(|key| {
                            credential::Value::Key(credential::Key {
                                key: key.into(),
                                metadata: None,
                            })
                        })
                })
                .ok_or(Error::ProfileUnavailable)?;
            let (access, key) = match &source {
                credential::Value::Key(key) => (None, key.key.as_str()),
                credential::Value::OAuth(value) => (value.access.as_str(), None),
            };
            let token = match cursor_auth {
                Some(store) => store
                    .resolve(access, key, chrono::Utc::now().timestamp_millis())
                    .await
                    .map_err(|_| Error::ProfileUnavailable)?,
                None => access
                    .or_else(|| key.filter(|key| !key.starts_with("crsr_")))
                    .filter(|token| !token.trim().is_empty())
                    .ok_or(Error::ProfileUnavailable)?
                    .to_owned(),
            };
            let prepared = credential::Value::Key(credential::Key {
                key: token.into(),
                metadata: None,
            });
            return self
                .cursor
                .model(
                    info,
                    Some(&prepared),
                    selected,
                    Some(&source),
                    cursor.ok_or(Error::ProfileUnavailable)?,
                )
                .await;
        }
        if matches!(value, Some(credential::Value::OAuth(value)) if value.method_id.as_lossless().as_str() == Some("claude-code"))
        {
            return super::from_catalog_model_with_claude(info, value, selected, claude);
        }
        self.model(info, value).await
    }
    pub async fn model(
        &self,
        info: &model::Info,
        value: Option<&credential::Value>,
    ) -> Result<Model, Error> {
        let mut configured = info.clone();
        let mut settings = info
            .settings
            .as_ref()
            .map(DomainEncode::encode)
            .unwrap_or_else(|| object(&[]));
        let metadata = match value {
            Some(credential::Value::Key(value)) => value.metadata.as_ref(),
            Some(credential::Value::OAuth(value)) => value.metadata.as_ref(),
            None => None,
        };
        if let Some(metadata) = metadata
            && let JsonValue::Object(fields) = &mut settings
        {
            for (name, value) in metadata.iter() {
                fields.insert(name.clone(), value.clone());
            }
        }
        if value.is_some()
            && let JsonValue::Object(fields) = &settings
        {
            let mut clean = ycoding_schema::JsonObject::new();
            for (name, value) in fields.iter().filter(|(name, _)| {
                !matches!(name.as_str(), Some("apiKey" | "authToken" | "accessToken"))
            }) {
                clean.insert(name.clone(), value.clone());
            }
            settings = JsonValue::Object(clean);
        }
        let family = family(info.package.as_ref().ok_or(Error::UnsupportedPackage)?)?;
        let key = match value {
            Some(credential::Value::Key(value)) => value.key.as_str(),
            Some(credential::Value::OAuth(value)) => value.access.as_str(),
            None => field(&settings, "apiKey")
                .and_then(text)
                .filter(|key| !key.is_empty())
                .or_else(|| {
                    vendor_env(family)
                        .and_then(|name| self.environment.get(name).map(String::as_str))
                }),
        }
        .map(str::to_owned);
        if let Some(key) = &key {
            crate::resources::catalog::set(&mut settings, "apiKey", key.encode());
        }
        configured.settings = Some(
            ycoding_schema::provider::Settings::decode(&settings)
                .map_err(|_| Error::InvalidSettings)?,
        );
        if matches!(family, ProviderFamily::Gitlab | ProviderFamily::Sap) {
            let defaults = defaults(
                &configured,
                &settings,
                if family == ProviderFamily::Sap {
                    "sap-ai"
                } else {
                    "openai"
                },
            )?;
            let mut model = if family == ProviderFamily::Gitlab {
                let mut config = ycoding_ai::gitlab::Config::new(Credential::value(
                    key.as_deref()
                        .or_else(|| self.environment.get("GITLAB_TOKEN").map(String::as_str))
                        .ok_or(Error::ProfileUnavailable)?,
                ));
                config.instance_url = option(&settings, "instanceUrl")
                    .or_else(|| self.environment.get("GITLAB_INSTANCE_URL").cloned())
                    .unwrap_or(config.instance_url);
                config.ai_gateway_url = option(&settings, "aiGatewayUrl")
                    .or_else(|| self.environment.get("GITLAB_AI_GATEWAY_URL").cloned())
                    .unwrap_or(config.ai_gateway_url);
                config
                    .ai_gateway_headers
                    .insert("User-Agent".into(), self.user_agent("gitlab-ai-provider"));
                if let Some(JsonValue::Object(headers)) = field(&settings, "aiGatewayHeaders") {
                    for (name, value) in headers.iter() {
                        config.ai_gateway_headers.insert(
                            name.to_utf8().map_err(|_| Error::InvalidSettings)?,
                            text(value).ok_or(Error::InvalidSettings)?.into(),
                        );
                    }
                }
                if let Some(JsonValue::Object(flags)) = field(&settings, "featureFlags") {
                    for (name, value) in flags.iter() {
                        let JsonValue::Bool(value) = value else {
                            return Err(Error::InvalidSettings);
                        };
                        config
                            .feature_flags
                            .insert(name.to_utf8().map_err(|_| Error::InvalidSettings)?, *value);
                    }
                }
                config.defaults = defaults;
                ycoding_ai::gitlab::model(
                    &self.http,
                    info.model_id.as_str().ok_or(Error::InvalidSettings)?,
                    config,
                )
                .await
            } else {
                ycoding_ai::sap_ai_core::model(
                    &self.http,
                    info.model_id.clone(),
                    ycoding_ai::sap_ai_core::Config {
                        service_key: option(&settings, "serviceKey")
                            .or_else(|| key.clone())
                            .map(Secret::new),
                        deployment_id: option(&settings, "deploymentId"),
                        resource_group: option(&settings, "resourceGroup"),
                        environment: self.environment.clone(),
                        defaults,
                    },
                )
                .await
            }
            .map_err(|_| Error::InvalidSettings)?;
            model.provider = info.provider_id.clone();
            Arc::make_mut(&mut model.route).provider = info.provider_id.clone();
            return Ok(self.model_endpoint(model));
        }
        let vertex = matches!(
            family,
            ProviderFamily::Vertex | ProviderFamily::VertexAnthropic
        ) || family == ProviderFamily::Compatible
            && info.provider_id.0 == "google-vertex".into();
        if vertex {
            configured.model_id = info
                .model_id
                .as_str()
                .ok_or(Error::InvalidSettings)?
                .trim()
                .into();
            let environment = if family == ProviderFamily::VertexAnthropic {
                ycoding_ai::google_vertex_shared::anthropic_environment(&self.environment)
            } else {
                self.environment.clone()
            };
            let project = ycoding_ai::google_vertex_shared::project(
                field(&settings, "project").and_then(text),
                &environment,
            );
            let location = ycoding_ai::google_vertex_shared::location(
                field(&settings, "location").and_then(text),
                &environment,
                if family == ProviderFamily::VertexAnthropic {
                    "global"
                } else {
                    "us-central1"
                },
            );
            if let Some(project) = &project {
                crate::resources::catalog::set(&mut settings, "project", project.encode());
            }
            crate::resources::catalog::set(&mut settings, "location", location.encode());
            if let Some(base) = option(&settings, "baseURL") {
                crate::resources::catalog::set(
                    &mut settings,
                    "baseURL",
                    ycoding_ai::google_vertex_shared::expand_template(
                        &base,
                        project.as_deref(),
                        &location,
                    )
                    .encode(),
                );
            }
            let access = match value {
                Some(credential::Value::OAuth(value)) => value.access.as_str().map(str::to_owned),
                _ => option(&settings, "accessToken"),
            };
            let has_access = access.is_some();
            let needs_adc = access.is_none()
                && (key.is_none()
                    || family == ProviderFamily::VertexAnthropic
                    || family == ProviderFamily::Compatible);
            let adc = if needs_adc {
                let mut store = self.google.lock().await;
                if store.is_none() {
                    let home = self
                        .environment
                        .get("HOME")
                        .or_else(|| self.environment.get("USERPROFILE"))
                        .map(std::path::PathBuf::from)
                        .ok_or(Error::InvalidSettings)?;
                    let discovered =
                        auth::google::discover(&home, &self.environment, cfg!(windows))
                            .await
                            .map_err(|_| Error::InvalidSettings)?;
                    *store = Some(
                        auth::google::Store::system(discovered, &self.version, &self.environment)
                            .map_err(|_| Error::InvalidSettings)?,
                    );
                }
                Some(store.as_ref().ok_or(Error::InvalidSettings)?.clone())
            } else {
                None
            };
            let token = match &adc {
                Some(store) => store
                    .token(chrono::Utc::now().timestamp_millis())
                    .await
                    .map_err(|_| Error::ProfileUnavailable)?,
                None => access.unwrap_or_else(|| key.clone().unwrap_or_default()),
            };
            if needs_adc || has_access {
                crate::resources::catalog::set(&mut settings, "accessToken", token.encode());
            }
            configured.settings = Some(
                ycoding_schema::provider::Settings::decode(&settings)
                    .map_err(|_| Error::InvalidSettings)?,
            );
            let mut model = route::from_catalog_model_environment(
                &configured,
                value,
                &self.environment,
                &self.version,
            )?;
            if needs_adc || access_is_oauth(value) || family == ProviderFamily::Compatible {
                Arc::make_mut(&mut model.route).auth = Auth::bearer(Credential::value(token));
            }
            if let Some(store) = adc {
                let route = Arc::make_mut(&mut model.route);
                route.protocol = Arc::new(AdcProtocol {
                    inner: route.protocol.clone(),
                    store,
                });
            }
            return Ok(self.model_endpoint(model));
        }
        route::from_catalog_model_environment(&configured, value, &self.environment, &self.version)
            .map(|model| self.model_endpoint(model))
    }
    fn model_endpoint(&self, mut model: Model) -> Model {
        if let Some(endpoint) = self.endpoints.get(&model.route.id) {
            Arc::make_mut(&mut model.route).endpoint.base_url = endpoint.clone();
        }
        model
    }
    pub fn user_agent(&self, provider: &str) -> String {
        format!(
            "ycoding/{} {provider} ({}; {})",
            self.version,
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    }
}
fn access_is_oauth(value: Option<&credential::Value>) -> bool {
    matches!(value, Some(credential::Value::OAuth(_)))
}
pub(super) fn option(settings: &JsonValue, name: &str) -> Option<String> {
    field(settings, name).and_then(text).map(str::to_owned)
}
pub(super) fn defaults(
    info: &model::Info,
    settings: &JsonValue,
    namespace: &str,
) -> Result<Defaults, Error> {
    let mut defaults = Defaults {
        output_limit: Some(info.limit.output.get() as f64),
        context_limit: Some(info.limit.context.get() as f64),
        ..Default::default()
    };
    if let Some(headers) = &info.headers {
        defaults.http.headers = headers
            .iter()
            .map(|(name, value)| {
                Ok((
                    name.to_utf8().map_err(|_| Error::InvalidSettings)?,
                    text(value).ok_or(Error::InvalidSettings)?.into(),
                ))
            })
            .collect::<Result<_, Error>>()?;
    }
    defaults.http.body = info.body.as_ref().map(DomainEncode::encode);
    let mut options = ycoding_schema::JsonObject::new();
    if let JsonValue::Object(fields) = settings {
        for (name, value) in fields.iter().filter(|(name, _)| {
            !matches!(
                name.as_str(),
                Some(
                    "apiKey"
                        | "authToken"
                        | "accessToken"
                        | "baseURL"
                        | "serviceKey"
                        | "claudeCodeSource"
                )
            )
        }) {
            options.insert(name.clone(), value.clone());
        }
    }
    let options = JsonValue::Object(options);
    defaults.provider_options = Some(object(&[(namespace, options)]));
    Ok(defaults)
}
fn vendor_env(family: ProviderFamily) -> Option<&'static str> {
    Some(match family {
        ProviderFamily::Alibaba => "ALIBABA_API_KEY",
        ProviderFamily::Cohere => "COHERE_API_KEY",
        ProviderFamily::Cerebras => "CEREBRAS_API_KEY",
        ProviderFamily::Deepinfra => "DEEPINFRA_API_KEY",
        ProviderFamily::Gateway => "AI_GATEWAY_API_KEY",
        ProviderFamily::Groq => "GROQ_API_KEY",
        ProviderFamily::Mistral => "MISTRAL_API_KEY",
        ProviderFamily::Perplexity => "PERPLEXITY_API_KEY",
        ProviderFamily::Venice => "VENICE_API_KEY",
        ProviderFamily::Vercel => "VERCEL_API_KEY",
        ProviderFamily::Together => "TOGETHER_API_KEY",
        ProviderFamily::OpenAI => "OPENAI_API_KEY",
        ProviderFamily::Anthropic => "ANTHROPIC_API_KEY",
        ProviderFamily::Google => "GOOGLE_GENERATIVE_AI_API_KEY",
        ProviderFamily::Azure => "AZURE_API_KEY",
        ProviderFamily::Xai => "XAI_API_KEY",
        _ => return None,
    })
}

struct AdcProtocol {
    inner: Arc<dyn Protocol>,
    store: auth::google::Store,
}
impl Protocol for AdcProtocol {
    fn id(&self) -> &'static str {
        self.inner.id()
    }
    fn lower(&self, request: &ycoding_ai::llm::Request) -> Result<JsonValue, ycoding_ai::Error> {
        self.inner.lower(request)
    }
    fn parser(&self, request: &ycoding_ai::llm::Request) -> Box<dyn StreamParser> {
        self.inner.parser(request)
    }
    fn terminal(&self, event: &JsonValue) -> bool {
        self.inner.terminal(event)
    }
    fn request_headers(
        &self,
        request: &ycoding_ai::llm::Request,
        headers: reqwest::header::HeaderMap,
    ) -> Result<reqwest::header::HeaderMap, ycoding_ai::Error> {
        self.inner.request_headers(request, headers)
    }
    fn response_headers(
        &self,
        request: &ycoding_ai::llm::Request,
        headers: &reqwest::header::HeaderMap,
    ) {
        self.inner.response_headers(request, headers)
    }
    fn wire_body(
        &self,
        request: &ycoding_ai::llm::Request,
        body: JsonValue,
    ) -> Result<JsonValue, ycoding_ai::Error> {
        self.inner.wire_body(request, body)
    }
    fn dispatch<'a>(
        &'a self,
        executor: &'a Executor,
        prepared: &'a mut Prepared,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<reqwest::Response, ycoding_ai::Error>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            let token = self
                .store
                .token(chrono::Utc::now().timestamp_millis())
                .await
                .map_err(|_| ycoding_ai::Error::invalid("Google ADC refresh failed"))?;
            let headers =
                Auth::bearer(Credential::value(token)).apply(ycoding_ai::auth::Input {
                    method: "POST",
                    url: prepared.url.as_str(),
                    body: &prepared.encoded_body,
                    headers: prepared.headers.clone(),
                })?;
            prepared.headers = headers;
            self.inner.dispatch(executor, prepared).await
        })
    }
}
