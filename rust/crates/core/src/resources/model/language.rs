use super::{Error, ProviderContext, family};
use crate::{
    extension::{Activation, language},
    resources::catalog::{field, models_dev::text, object},
};
use std::sync::Arc;
use ycoding_ai::{
    ai_sdk,
    auth::Auth,
    llm::{Defaults, Model},
    provider_error::Reason,
    route::{Endpoint, LanguageAttempt, Route, Transport},
};
use ycoding_schema::{DomainEncode, JsonObject, JsonValue, model};

pub fn from_language(
    info: &model::Info,
    attempt: Arc<dyn LanguageAttempt>,
) -> Result<Model, Error> {
    let package = package_name(info)?;
    let key = provider_option_key(
        package,
        info.provider_id.0.as_str().ok_or(Error::InvalidSettings)?,
    );
    let (settings, body) = projection(info, package);
    let mut defaults = Defaults {
        context_limit: Some(info.limit.context.get() as f64),
        output_limit: Some(info.limit.output.get() as f64),
        provider_options: settings
            .map(|settings| provider_options(info, package, key, settings))
            .transpose()?
            .flatten(),
        ..Defaults::default()
    };
    defaults.http.body = body;
    if let Some(headers) = &info.headers {
        defaults.http.headers = headers
            .iter()
            .map(|(name, value)| {
                Ok((
                    name.to_utf8().map_err(|_| Error::InvalidSettings)?,
                    text(value).ok_or(Error::InvalidSettings)?.to_owned(),
                ))
            })
            .collect::<Result<_, Error>>()?;
    }
    Ok(Route {
        id: format!("ai-sdk:{package}"),
        provider: info.provider_id.clone(),
        provider_metadata_key: Some(key.into()),
        protocol: Arc::new(ai_sdk::Protocol),
        endpoint: Endpoint::new("ai-sdk://language", ""),
        auth: Auth::None,
        transport: Transport::Language(attempt),
        headers: Default::default(),
        defaults,
    }
    .model(info.model_id.clone()))
}

impl ProviderContext {
    pub fn bind_plugins(&self, activation: &Arc<Activation>) -> Result<(), ycoding_ai::Error> {
        self.plugins.set(Arc::downgrade(activation)).map_err(|_| {
            ycoding_ai::Error::invalid("Provider context already has a plugin activation")
        })
    }

    pub fn language_model<'a>(
        &'a self,
        info: &'a model::Info,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Option<Model>, ycoding_ai::Error>> + Send + 'a>,
    > {
        Box::pin(async move {
            let Some(binding) = self.plugins.get() else {
                return Ok(None);
            };
            let activation = binding.upgrade().ok_or_else(|| {
                ycoding_ai::Error::new(
                    Reason::Interrupted,
                    "Plugin language model activation retired",
                )
            })?;
            let invalid = |_| ycoding_ai::Error::invalid("Invalid plugin language model metadata");
            let package = package_name(info).map_err(invalid)?;
            let options = constructor_options(info, package);
            let attempt = language::claim(
                &activation.extensions().await,
                package,
                &info.encode(),
                &options,
            )
            .await?;
            if activation.is_closed().await {
                return Err(ycoding_ai::Error::new(
                    Reason::Interrupted,
                    "Plugin language model activation closed",
                ));
            }
            let attempt = match attempt {
                Some(attempt) => attempt,
                None => {
                    if info
                        .package
                        .as_ref()
                        .is_some_and(|package| family(package).is_ok())
                    {
                        return Ok(None);
                    }
                    if activation
                        .builtin_disabled("ycoding.provider.dynamic")
                        .await
                    {
                        return Err(ycoding_ai::Error::invalid(
                            "Dynamic provider packages are disabled by plugin configuration",
                        ));
                    }
                    return Err(ycoding_ai::Error::invalid(
                        "No native or process-extension language route is available for this package",
                    ));
                }
            };
            from_language(info, attempt).map(Some).map_err(invalid)
        })
    }
}

fn package_name(info: &model::Info) -> Result<&str, Error> {
    let package = info
        .package
        .as_ref()
        .and_then(|package| package.as_str())
        .ok_or(Error::UnsupportedPackage)?;
    let package = package.strip_prefix("aisdk:").unwrap_or(package);
    if package.is_empty() || package.len() > 4096 || package.contains('\0') {
        return Err(Error::InvalidSettings);
    }
    Ok(package)
}

fn provider_option_key<'a>(package: &'a str, provider: &'a str) -> &'a str {
    match package {
        "@ai-sdk/google" => "google",
        "@ai-sdk/google-vertex" => "vertex",
        "@ai-sdk/google-vertex/anthropic" => "anthropic",
        "@ai-sdk/amazon-bedrock" => "bedrock",
        "@ai-sdk/amazon-bedrock/mantle" => "openai",
        "@ai-sdk/azure" => "azure",
        "@ai-sdk/github-copilot" => "copilot",
        "@jerome-benoit/sap-ai-provider-v2" => "sap-ai",
        "@ai-sdk/openai-compatible" => provider.split('.').next().unwrap_or(provider),
        "@openrouter/ai-sdk-provider" => "openrouter",
        "ai-gateway-provider" => "openaiCompatible",
        _ => package.strip_prefix("@ai-sdk/").unwrap_or(provider),
    }
}

fn projection(info: &model::Info, package: &str) -> (Option<JsonObject>, Option<JsonValue>) {
    let mut settings = JsonObject::new();
    if let Some(configured) = &info.settings {
        for (key, value) in configured.0.iter().filter(|(key, _)| {
            !matches!(
                key.as_str(),
                Some("apiKey" | "authToken" | "baseURL" | "chunkTimeout" | "fetch" | "timeout")
            )
        }) {
            settings.insert(key.clone(), value.clone());
        }
    }
    let pro = info
        .body
        .as_ref()
        .and_then(|body| body.0.get(&"reasoning".into()))
        .and_then(|reasoning| field(reasoning, "mode"))
        .and_then(text)
        == Some("pro");
    if matches!(
        package,
        "@ai-sdk/openai" | "@ai-sdk/azure" | "@ai-sdk/amazon-bedrock/mantle"
    ) && (pro
        || settings.get(&"reasoningEffort".into()).is_some()
        || settings.get(&"reasoningSummary".into()).is_some())
    {
        settings.insert("forceReasoning".into(), JsonValue::Bool(true));
    }
    if pro {
        settings.insert("reasoningMode".into(), "pro".encode());
    }
    let body = info.body.as_ref().and_then(|body| {
        if !pro {
            return Some(body.encode());
        }
        let mut projected = JsonObject::new();
        for (key, value) in body
            .0
            .iter()
            .filter(|(key, _)| key.as_str() != Some("reasoning"))
        {
            projected.insert(key.clone(), value.clone());
        }
        (!projected.is_empty()).then_some(JsonValue::Object(projected))
    });
    ((!settings.is_empty()).then_some(settings), body)
}

fn provider_options(
    info: &model::Info,
    package: &str,
    key: &str,
    settings: JsonObject,
) -> Result<Option<JsonValue>, Error> {
    if package == "@ai-sdk/azure" {
        let settings = JsonValue::Object(settings);
        return Ok(Some(object(&[
            ("openai", settings.clone()),
            ("azure", settings),
        ])));
    }
    if package != "@ai-sdk/gateway" {
        return Ok(Some(object(&[(key, JsonValue::Object(settings))])));
    }
    let gateway = settings
        .get(&"gateway".into())
        .filter(|value| matches!(value, JsonValue::Object(_)));
    let mut upstream = JsonObject::new();
    for (key, value) in settings
        .iter()
        .filter(|(key, _)| key.as_str() != Some("gateway"))
    {
        upstream.insert(key.clone(), value.clone());
    }
    if upstream.is_empty() {
        return Ok(gateway.map(|gateway| object(&[("gateway", gateway.clone())])));
    }
    let prefix = info
        .model_id
        .as_str()
        .ok_or(Error::InvalidSettings)?
        .split_once('/')
        .filter(|(prefix, _)| !prefix.is_empty())
        .map(|(prefix, _)| {
            if prefix == "amazon" {
                "bedrock"
            } else {
                prefix
            }
        });
    let mut options = JsonObject::new();
    if let Some(gateway) = gateway {
        options.insert("gateway".into(), gateway.clone());
    }
    if let Some(prefix) = prefix {
        options.insert(prefix.into(), JsonValue::Object(upstream));
    } else {
        let mut merged = match gateway {
            Some(JsonValue::Object(gateway)) => gateway.clone(),
            _ => JsonObject::new(),
        };
        for (key, value) in upstream.iter() {
            merged.insert(key.clone(), value.clone());
        }
        options.insert("gateway".into(), JsonValue::Object(merged));
    }
    Ok(Some(JsonValue::Object(options)))
}

fn constructor_options(info: &model::Info, package: &str) -> JsonValue {
    let mut options = JsonObject::new();
    options.insert("name".into(), info.provider_id.encode());
    if let Some(settings) = &info.settings {
        for (key, value) in settings
            .0
            .iter()
            .filter(|(key, _)| !matches!(key.as_str(), Some("headers" | "body")))
        {
            options.insert(key.clone(), value.clone());
        }
    }
    if let Some(headers) = &info.headers {
        options.insert("headers".into(), headers.encode());
    }
    if let Some(body) = projection(info, package).1 {
        options.insert("body".into(), body);
    }
    JsonValue::Object(options)
}
