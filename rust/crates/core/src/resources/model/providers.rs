use super::{Error, ProviderFamily, family, route};
use crate::resources::{
    auth,
    catalog::{field, models_dev::text, object},
    cursor,
};
use std::{collections::BTreeMap, sync::Arc};
use ycoding_ai::llm::Model;
use ycoding_schema::{DomainDecode, DomainEncode, JsonValue, credential, model};

#[derive(Clone)]
pub struct ProviderContext {
    pub environment: BTreeMap<String, String>,
    pub version: String,
    pub http: reqwest::Client,
    pub endpoints: BTreeMap<String, String>,
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
            endpoints: BTreeMap::new(),
            cursor: cursor::route::Runtimes::new(Default::default()),
        })
    }
    pub async fn shutdown(&self) {
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
                    match family {
                        ProviderFamily::OpenAI => self.environment.get("OPENAI_API_KEY"),
                        ProviderFamily::Anthropic => self.environment.get("ANTHROPIC_API_KEY"),
                        _ => None,
                    }
                    .map(String::as_str)
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
        let mut model = route::from_catalog_model_base(&configured, value)?;
        if let Some(endpoint) = self.endpoints.get(&model.route.id) {
            Arc::make_mut(&mut model.route).endpoint.base_url = endpoint.clone();
        }
        Ok(model)
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
