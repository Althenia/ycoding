use super::{
    catalog::{Catalog, merge_headers, merge_settings},
    credential,
};
use std::fmt;
use ycoding_schema::{DomainEncode, LosslessString, model, provider};

pub mod quota;
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
    catalog: Catalog,
}
impl Resolver {
    pub fn new(catalog: Catalog) -> Self {
        Self { catalog }
    }
    pub fn catalog(&self) -> &Catalog {
        &self.catalog
    }
    pub fn resolve(
        &self,
        selection: &model::Ref,
        saved: &[credential::Info],
        connection: Option<&credential::Info>,
    ) -> Result<Resolved, Error> {
        let provider = self
            .catalog
            .provider(&selection.provider_id)
            .ok_or(Error::ModelUnavailable)?;
        if !self.catalog.provider_available(provider, saved) {
            return Err(Error::ModelUnavailable);
        }
        let model = self
            .catalog
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
        let info = self
            .catalog
            .for_connection(&model, connection)
            .ok_or(Error::ModelUnavailable)?;
        Ok(Resolved {
            info: with_variant(info, selection.variant.as_ref())?,
            selection: selection.clone(),
        })
    }
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
        _ => Err(Error::UnsupportedPackage),
    }
}
