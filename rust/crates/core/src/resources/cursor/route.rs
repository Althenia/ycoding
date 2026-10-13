use super::models::PACKAGE_NAME;
use crate::resources::{
    catalog::{field, models_dev::text},
    model::Error,
};
use std::{collections::BTreeMap, sync::Arc};
use ycoding_ai::{
    auth::{Auth, Credential},
    cursor::{
        headers::Identity,
        provider::{Config, RequestContext, Runtime},
    },
    llm::{Defaults, Model},
};
use ycoding_schema::{DomainEncode, JsonObject, JsonValue, credential, model};

const EXCLUDED_SETTINGS: [&str; 6] = [
    "apiKey",
    "authToken",
    "baseURL",
    "chunkTimeout",
    "fetch",
    "timeout",
];

pub struct Host {
    pub identity: Identity,
    pub context: RequestContext,
    pub runtime: Arc<Runtime>,
    pub known_mcp_servers: Vec<String>,
    pub extensions: Extensions,
}

#[derive(Clone, Default)]
pub struct Extensions {
    pub agent: Option<ycoding_ai::cursor::transport::Endpoint>,
    pub models: Vec<ycoding_ai::cursor::models::Info>,
    pub image_host: Option<Arc<dyn ycoding_ai::cursor::images::Host>>,
    pub image_environment: Option<ycoding_ai::cursor::images::Environment>,
    pub planning_host: Option<Arc<dyn ycoding_ai::cursor::planning::Host>>,
    pub observations: Option<Arc<dyn ycoding_ai::cursor::observations::Host>>,
    pub persistence: Option<Arc<dyn ycoding_ai::cursor::persistence::Store>>,
}

#[derive(Clone)]
pub struct Runtimes {
    options: ycoding_ai::cursor::transport::Options,
    accounts: Arc<tokio::sync::Mutex<BTreeMap<String, AccountRuntime>>>,
    models: Arc<tokio::sync::Mutex<BTreeMap<String, Vec<ycoding_ai::cursor::models::Info>>>>,
}
struct AccountRuntime {
    runtime: Arc<Runtime>,
    credential: bool,
}
impl Runtimes {
    pub fn new(options: ycoding_ai::cursor::transport::Options) -> Self {
        Self {
            options,
            accounts: Arc::new(tokio::sync::Mutex::new(BTreeMap::new())),
            models: Default::default(),
        }
    }
    pub async fn set_models(
        &self,
        selected: &crate::resources::credential::Info,
        models: Vec<ycoding_ai::cursor::models::Info>,
    ) -> Result<(), Error> {
        self.models.lock().await.insert(
            crate::resources::model::account_identity(selected)
                .to_utf8()
                .map_err(|_| Error::InvalidSettings)?,
            models,
        );
        Ok(())
    }
    pub async fn retain_accounts(&self, identities: &[String]) {
        self.models
            .lock()
            .await
            .retain(|identity, _| identities.contains(identity));
        let removed = self
            .accounts
            .lock()
            .await
            .extract_if(.., |identity, account| {
                account.credential && !identities.contains(identity)
            })
            .map(|(_, account)| account.runtime)
            .collect::<Vec<_>>();
        for runtime in removed {
            runtime.shutdown().await;
        }
    }
    pub async fn model(
        &self,
        info: &model::Info,
        value: Option<&credential::Value>,
        selected: Option<&crate::resources::credential::Info>,
        identity_source: Option<&credential::Value>,
        host: &Host,
    ) -> Result<Model, Error> {
        let identity = match selected {
            Some(selected) => crate::resources::model::account_identity(selected)
                .to_utf8()
                .map_err(|_| Error::InvalidSettings)?,
            None => {
                let material = match identity_source.or(value) {
                    Some(credential::Value::Key(value)) => value.key.encode(),
                    Some(credential::Value::OAuth(value)) => value.access.encode(),
                    None => info
                        .settings
                        .as_ref()
                        .and_then(|s| s.0.get(&"apiKey".into()))
                        .cloned()
                        .ok_or(Error::ProfileUnavailable)?,
                };
                ring::digest::digest(
                    &ring::digest::SHA256,
                    ycoding_schema::stringify_json(&material).as_bytes(),
                )
                .as_ref()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect()
            }
        };
        let runtime = {
            let mut accounts = self.accounts.lock().await;
            if !accounts.contains_key(&identity) {
                accounts.insert(
                    identity.clone(),
                    AccountRuntime {
                        runtime: Arc::new(
                            Runtime::new(self.options.clone())
                                .map_err(|_| Error::InvalidSettings)?,
                        ),
                        credential: selected.is_some(),
                    },
                );
            }
            accounts
                .get(&identity)
                .map(|account| account.runtime.clone())
                .ok_or(Error::InvalidSettings)?
        };
        let mut extensions = host.extensions.clone();
        if let Some(models) = self.models.lock().await.get(&identity) {
            extensions.models = models.clone();
        }
        model(
            info,
            value,
            &Host {
                identity: host.identity.clone(),
                context: host.context.clone(),
                runtime,
                known_mcp_servers: host.known_mcp_servers.clone(),
                extensions,
            },
        )
    }
    pub async fn shutdown(&self) {
        let accounts = std::mem::take(&mut *self.accounts.lock().await);
        self.models.lock().await.clear();
        for account in accounts.into_values() {
            account.runtime.shutdown().await;
        }
    }
}

pub fn model(
    info: &model::Info,
    credential: Option<&credential::Value>,
    host: &Host,
) -> Result<Model, Error> {
    if info.package.as_ref().and_then(|package| package.as_str())
        != Some(&format!("aisdk:{PACKAGE_NAME}"))
    {
        return Err(Error::UnsupportedPackage);
    }
    let settings = info
        .settings
        .as_ref()
        .map(DomainEncode::encode)
        .unwrap_or_else(|| JsonValue::Object(JsonObject::new()));
    let key = match credential {
        Some(credential::Value::Key(value)) => {
            Some(value.key.to_utf8().map_err(|_| Error::InvalidSettings)?)
        }
        Some(credential::Value::OAuth(value)) => {
            Some(value.access.to_utf8().map_err(|_| Error::InvalidSettings)?)
        }
        None => field(&settings, "apiKey")
            .and_then(text)
            .filter(|key| !key.is_empty())
            .map(str::to_owned),
    };
    let mut options = JsonObject::new();
    if let JsonValue::Object(settings) = &settings {
        for (name, value) in settings.iter() {
            if !EXCLUDED_SETTINGS
                .iter()
                .any(|excluded| name.as_str() == Some(excluded))
            {
                options.insert(name.clone(), value.clone());
            }
        }
    }
    let mut defaults = Defaults {
        output_limit: Some(info.limit.output.get() as f64),
        context_limit: Some(info.limit.context.get() as f64),
        provider_options: (!options.is_empty()).then(|| {
            let mut namespaced = JsonObject::new();
            namespaced.insert("cursor".into(), JsonValue::Object(options));
            JsonValue::Object(namespaced)
        }),
        ..Defaults::default()
    };
    defaults.http.headers = info
        .headers
        .as_ref()
        .map(|headers| {
            headers
                .iter()
                .map(|(name, value)| {
                    Ok((
                        name.to_utf8().map_err(|_| Error::InvalidSettings)?,
                        text(value).ok_or(Error::InvalidSettings)?.to_owned(),
                    ))
                })
                .collect::<Result<BTreeMap<_, _>, Error>>()
        })
        .transpose()?
        .unwrap_or_default();
    let auth = key
        .map(|key| Auth::bearer(Credential::value(key)))
        .unwrap_or(Auth::None);
    let mut config = Config::new(
        auth,
        host.identity.clone(),
        host.context.clone(),
        host.runtime.clone(),
    );
    config.common.base_url = field(&settings, "baseURL")
        .and_then(text)
        .map(str::to_owned);
    config.common.defaults = defaults;
    config.known_mcp_servers = host.known_mcp_servers.clone();
    config.agent = host.extensions.agent.clone();
    config.models = host.extensions.models.clone();
    config.image_host = host.extensions.image_host.clone();
    config.image_environment = host.extensions.image_environment.clone();
    config.planning_host = host.extensions.planning_host.clone();
    config.observations = host.extensions.observations.clone();
    config.persistence = host.extensions.persistence.clone();
    let mut model = ycoding_ai::cursor::provider::model(info.model_id.clone(), config)
        .map_err(|_| Error::InvalidSettings)?;
    model.provider = info.provider_id.clone();
    Arc::make_mut(&mut model.route).provider = info.provider_id.clone();
    Ok(model)
}
