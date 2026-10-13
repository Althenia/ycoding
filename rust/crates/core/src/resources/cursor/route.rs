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
    let mut model = ycoding_ai::cursor::provider::model(info.model_id.clone(), config)
        .map_err(|_| Error::InvalidSettings)?;
    model.provider = info.provider_id.clone();
    Arc::make_mut(&mut model.route).provider = info.provider_id.clone();
    Ok(model)
}
