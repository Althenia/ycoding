use super::{
    catalog::{Catalog, merge_headers, merge_settings},
    credential,
};
use std::fmt;
use ycoding_schema::{DomainEncode, LosslessString, model, provider};

mod providers;
pub mod quota;
pub(crate) mod scope;
pub use providers::ProviderContext;
mod route;
pub(crate) use route::from_catalog_model_base;
pub use route::{ClaudeHost, from_catalog_model, from_catalog_model_with_claude};
pub const DROPPED_UPSTREAM_PROVIDER_ID: &str = "opencode"; // YCODING_EXTERNAL_OPENCODE: external models.dev provider ID, kept recognizable so the unsupported-provider diagnostic works.
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
    Compatible,
    OpenRouter,
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
        "@ai-sdk/openai-compatible"
        | "@ycoding-ai/ai/providers/openai-compatible"
        | "@ycoding-ai/ai/providers/openai-compatible/responses" => Ok(ProviderFamily::Compatible),
        "@openrouter/ai-sdk-provider" | "@ycoding-ai/ai/providers/openrouter" => {
            Ok(ProviderFamily::OpenRouter)
        }
        "cursor-opencode-provider" => Ok(ProviderFamily::Cursor),
        _ => Err(Error::UnsupportedPackage),
    }
}
