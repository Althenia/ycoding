use super::{
    catalog::{Catalog, merge_headers, merge_settings},
    credential,
};
use std::fmt;
use ycoding_schema::{DomainEncode, LosslessString, model, provider};

mod providers;
pub mod quota;
pub use providers::ProviderContext;
mod route;
pub(crate) use route::from_catalog_model_base;
pub use route::{ClaudeHost, from_catalog_model, from_catalog_model_with_claude};
pub fn account_identity(credential: &credential::Info) -> LosslessString {
    let material = super::catalog::object(&[
        ("integrationID", credential.integration_id().encode()),
        ("credentialID", credential.id().encode()),
        (
            "accountGeneration",
            (credential.account_generation() as f64).encode(),
        ),
    ]);
    ring::digest::digest(
        &ring::digest::SHA256,
        ycoding_schema::stringify_json(&material).as_bytes(),
    )
    .as_ref()
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect::<String>()
    .into()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    ModelUnavailable,
    VariantUnavailable,
    ProfileUnavailable,
    UnsupportedPackage,
    InvalidSettings,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::ModelUnavailable => "Model unavailable",
            Self::VariantUnavailable => "Variant unavailable",
            Self::ProfileUnavailable => "Selected profile is unavailable; select the profile again",
            Self::UnsupportedPackage => "Unsupported provider package",
            Self::InvalidSettings => "Invalid provider settings",
        })
    }
}
impl std::error::Error for Error {}

#[derive(Clone, PartialEq)]
pub struct Resolved {
    pub info: model::Info,
    pub selection: model::Ref,
}
impl fmt::Debug for Resolved {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ResolvedModel([redacted])")
    }
}
pub struct Resolver {
    catalog: std::sync::RwLock<std::sync::Arc<Catalog>>,
}
impl Resolver {
    pub fn new(catalog: Catalog) -> Self {
        Self {
            catalog: std::sync::RwLock::new(std::sync::Arc::new(catalog)),
        }
    }
    pub fn catalog(&self) -> std::sync::Arc<Catalog> {
        self.catalog
            .read()
            .expect("Catalog writers only replace owned snapshots")
            .clone()
    }
    pub fn replace(&self, catalog: Catalog) -> Result<(), Error> {
        let catalog = std::sync::Arc::new(catalog);
        *self.catalog.write().map_err(|_| Error::ModelUnavailable)? = catalog;
        Ok(())
    }
    pub fn resolve(
        &self,
        selection: &model::Ref,
        saved: &[credential::Info],
        connection: Option<&credential::Info>,
    ) -> Result<Resolved, Error> {
        resolve_catalog(&self.catalog(), selection, saved, connection)
    }
}
pub(crate) fn resolve_catalog(
    catalog: &Catalog,
    selection: &model::Ref,
    saved: &[credential::Info],
    connection: Option<&credential::Info>,
) -> Result<Resolved, Error> {
    let provider = catalog
        .provider(&selection.provider_id)
        .ok_or(Error::ModelUnavailable)?;
    if !catalog.provider_available(provider, saved) {
        return Err(Error::ModelUnavailable);
    }
    let model = catalog
        .get(
            &selection.provider_id,
            &selection.id,
            selection.profile.as_ref(),
            saved,
        )
        .ok_or(if selection.profile.is_some() {
            Error::ProfileUnavailable
        } else {
            Error::ModelUnavailable
        })?;
    let info = catalog
        .for_connection(&model, connection)
        .ok_or(Error::ModelUnavailable)?;
    Ok(Resolved {
        info: with_variant(info, selection.variant.as_ref())?,
        selection: selection.clone(),
    })
}
pub fn with_variant(
    mut info: model::Info,
    variant: Option<&model::VariantId>,
) -> Result<model::Info, Error> {
    let Some(id) = variant else {
        return Ok(info);
    };
    let variant = info
        .variants
        .iter()
        .find(|v| &v.id == id)
        .ok_or(Error::VariantUnavailable)?;
    info.settings = merge_settings(info.settings.as_ref(), variant.settings.as_ref());
    info.body = merge_settings(info.body.as_ref(), variant.body.as_ref());
    info.headers = match (&info.headers, &variant.headers) {
        (Some(a), Some(b)) => Some(merge_headers(a, b)),
        (None, Some(b)) => Some(b.clone()),
        _ => info.headers,
    };
    Ok(info)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderFamily {
    OpenAI,
    Anthropic,
    Google,
    Compatible,
    Azure,
    OpenRouter,
    Xai,
    Bedrock,
    RunPod,
    Copilot,
    Vertex,
    VertexAnthropic,
    Alibaba,
    Cohere,
    Cerebras,
    Deepinfra,
    Gateway,
    Groq,
    Mistral,
    Perplexity,
    Venice,
    Vercel,
    Together,
    Gitlab,
    Sap,
    CloudflareGateway,
    Mantle,
    Cursor,
}
pub fn family(package: &provider::Package) -> Result<ProviderFamily, Error> {
    let package = package.as_str().ok_or(Error::UnsupportedPackage)?;
    let package = package.strip_prefix("aisdk:").unwrap_or(package);
    match package {
        "@ai-sdk/openai"
        | "@ycoding-ai/ai/providers/openai"
        | "@ycoding-ai/ai/providers/openai/responses" => Ok(ProviderFamily::OpenAI),
        "@ai-sdk/anthropic"
        | "@ycoding-ai/ai/providers/anthropic"
        | "@ycoding-ai/ai/providers/anthropic-compatible" => Ok(ProviderFamily::Anthropic),
        "@ai-sdk/google" | "@ycoding-ai/ai/providers/google" => Ok(ProviderFamily::Google),
        "@ai-sdk/google-vertex" | "@ycoding-ai/ai/providers/google-vertex" => {
            Ok(ProviderFamily::Vertex)
        }
        "@ai-sdk/google-vertex/anthropic" | "@ycoding-ai/ai/providers/google-vertex/anthropic" => {
            Ok(ProviderFamily::VertexAnthropic)
        }
        "@ai-sdk/openai-compatible"
        | "@ycoding-ai/ai/providers/openai-compatible"
        | "@ycoding-ai/ai/providers/openai-compatible/responses" => Ok(ProviderFamily::Compatible),
        "@ai-sdk/azure"
        | "@ycoding-ai/ai/providers/azure"
        | "@ycoding-ai/ai/providers/azure/chat"
        | "@ycoding-ai/ai/providers/azure/responses" => Ok(ProviderFamily::Azure),
        "@openrouter/ai-sdk-provider" | "@ycoding-ai/ai/providers/openrouter" => {
            Ok(ProviderFamily::OpenRouter)
        }
        "@ai-sdk/xai" | "@ycoding-ai/ai/providers/xai" => Ok(ProviderFamily::Xai),
        "@ai-sdk/amazon-bedrock" | "@ycoding-ai/ai/providers/amazon-bedrock" => {
            Ok(ProviderFamily::Bedrock)
        }
        "@ycoding-ai/ai/providers/runpod" => Ok(ProviderFamily::RunPod),
        "@ai-sdk/github-copilot" => Ok(ProviderFamily::Copilot),
        "@ai-sdk/alibaba" => Ok(ProviderFamily::Alibaba),
        "@ai-sdk/cohere" => Ok(ProviderFamily::Cohere),
        "@ai-sdk/cerebras" => Ok(ProviderFamily::Cerebras),
        "@ai-sdk/deepinfra" => Ok(ProviderFamily::Deepinfra),
        "@ai-sdk/gateway" => Ok(ProviderFamily::Gateway),
        "@ai-sdk/groq" => Ok(ProviderFamily::Groq),
        "@ai-sdk/mistral" => Ok(ProviderFamily::Mistral),
        "@ai-sdk/perplexity" => Ok(ProviderFamily::Perplexity),
        "venice-ai-sdk-provider" => Ok(ProviderFamily::Venice),
        "@ai-sdk/vercel" => Ok(ProviderFamily::Vercel),
        "@ai-sdk/togetherai" => Ok(ProviderFamily::Together),
        "gitlab-ai-provider" => Ok(ProviderFamily::Gitlab),
        "@jerome-benoit/sap-ai-provider-v2" => Ok(ProviderFamily::Sap),
        "ai-gateway-provider" => Ok(ProviderFamily::CloudflareGateway),
        "@ai-sdk/amazon-bedrock/mantle" => Ok(ProviderFamily::Mantle),
        "cursor-opencode-provider" => Ok(ProviderFamily::Cursor),
        _ => Err(Error::UnsupportedPackage),
    }
}
