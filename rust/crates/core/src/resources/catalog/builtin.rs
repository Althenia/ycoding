use super::{Catalog, ProviderRecord, field, models_dev, object, set};
use std::collections::BTreeMap;
use ycoding_schema::{DomainDecode, DomainEncode, JsonObject, provider};

impl Catalog {
    pub fn transform_providers(
        &mut self,
        environment: &BTreeMap<String, String>,
    ) -> Result<(), models_dev::Error> {
        for record in &mut self.providers {
            transform_record(record, environment)?;
        }
        for account in &mut self.accounts {
            let Some(provider) = self
                .providers
                .iter()
                .find(|record| record.provider.id == account.provider)
            else {
                continue;
            };
            for model in &mut account.models {
                let mut record = ProviderRecord {
                    provider: provider.provider.clone(),
                    models: vec![model.clone()],
                    environment: provider.environment.clone(),
                };
                if let Some(package) = &model.package {
                    record.provider.package = package.clone();
                }
                record.provider.overlays.settings = model.settings.clone();
                record.provider.overlays.headers = model.headers.clone();
                record.provider.overlays.body = model.body.clone();
                transform_record(&mut record, environment)?;
                model.package = Some(record.provider.package);
                model.settings = record.provider.overlays.settings;
                model.headers = record.provider.overlays.headers;
                model.enabled = record.models[0].enabled;
            }
        }
        Ok(())
    }
}
fn transform_record(
    record: &mut ProviderRecord,
    environment: &BTreeMap<String, String>,
) -> Result<(), models_dev::Error> {
    let package = record
        .provider
        .package
        .as_str()
        .unwrap_or("")
        .strip_prefix("aisdk:")
        .unwrap_or(record.provider.package.as_str().unwrap_or(""))
        .to_owned();
    let mut settings = record
        .provider
        .overlays
        .settings
        .as_ref()
        .map(DomainEncode::encode)
        .unwrap_or_else(|| object(&[]));
    let mut headers = record.provider.overlays.headers.clone().unwrap_or_default();
    let endpoint = field(&settings, "baseURL")
        .and_then(models_dev::text)
        .map(str::to_owned);
    if package == "@ai-sdk/amazon-bedrock"
        && let Some(endpoint) = field(&settings, "endpoint")
            .and_then(models_dev::text)
            .map(str::to_owned)
    {
        set(&mut settings, "baseURL", endpoint.encode());
    }
    if package == "@ai-sdk/azure"
        && field(&settings, "resourceName")
            .and_then(models_dev::text)
            .is_none_or(|value| value.trim().is_empty())
        && let Some(resource) = environment.get("AZURE_RESOURCE_NAME")
    {
        set(&mut settings, "resourceName", resource.encode());
    }
    if package == "@ai-sdk/cerebras" {
        put(
            &mut headers,
            "X-Cerebras-3rd-Party-Integration",
            "ycoding",
            true,
        );
    }
    if package == "@ai-sdk/openai-compatible"
        && record.provider.id.0 == "cloudflare-workers-ai".into()
        && endpoint.is_none()
        && let Some(account) = environment
            .get("CLOUDFLARE_ACCOUNT_ID")
            .map(String::as_str)
            .or_else(|| field(&settings, "accountId").and_then(models_dev::text))
    {
        let endpoint = format!("https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1");
        set(&mut settings, "baseURL", endpoint.encode());
    }
    if package == "@ai-sdk/openai-compatible"
        && record
            .provider
            .id
            .0
            .as_str()
            .is_some_and(|id| id.contains("azure-cognitive-services"))
        && let Some(endpoint) =
            ycoding_ai::providers::azure_cognitive_endpoint(endpoint.as_deref(), environment)
    {
        set(&mut settings, "baseURL", endpoint.encode());
    }
    if package == "@ai-sdk/google-vertex"
        || package == "@ai-sdk/google-vertex/anthropic"
        || package == "@ai-sdk/openai-compatible" && record.provider.id.0 == "google-vertex".into()
    {
        let env = if package == "@ai-sdk/google-vertex/anthropic" {
            ycoding_ai::google_vertex_shared::anthropic_environment(environment)
        } else {
            environment.clone()
        };
        let project = ycoding_ai::google_vertex_shared::project(
            field(&settings, "project").and_then(models_dev::text),
            &env,
        );
        let location = ycoding_ai::google_vertex_shared::location(
            field(&settings, "location").and_then(models_dev::text),
            &env,
            if package == "@ai-sdk/google-vertex/anthropic" {
                "global"
            } else {
                "us-central1"
            },
        );
        if let Some(project) = &project {
            set(&mut settings, "project", project.encode());
        }
        set(&mut settings, "location", location.encode());
        if let Some(endpoint) = &endpoint {
            set(
                &mut settings,
                "baseURL",
                ycoding_ai::google_vertex_shared::expand_template(
                    endpoint,
                    project.as_deref(),
                    &location,
                )
                .encode(),
            );
        }
    }
    if package == "@ai-sdk/openai-compatible"
        && endpoint.as_deref() == Some("https://api.kilo.ai/api/gateway")
    {
        put(&mut headers, "X-Title", "YCoding", true);
    }
    if package == "@ai-sdk/openai-compatible"
        && endpoint.as_deref() == Some("https://api.llmgateway.io/v1")
        && record.provider.disabled != Some(true)
        && record.provider.integration_id.is_some()
    {
        put(&mut headers, "X-Title", "YCoding", true);
        put(&mut headers, "X-Source", "YCoding", true);
    }
    if package == "@ai-sdk/openai-compatible"
        && endpoint.as_deref() == Some("https://integrate.api.nvidia.com/v1")
    {
        put(&mut headers, "X-Title", "YCoding", true);
        put(&mut headers, "X-BILLING-INVOKE-ORIGIN", "YCoding", false);
    }
    if package == "@ai-sdk/openai" || package == "@ai-sdk/github-copilot" {
        for model in &mut record.models {
            if model.id == "gpt-5-chat-latest".into() {
                model.enabled = false;
            }
        }
    }
    if package == "@ai-sdk/anthropic" {
        let existing = headers
            .iter()
            .find(|(name, _)| {
                name.as_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case("anthropic-beta"))
            })
            .and_then(|(_, value)| models_dev::text(value))
            .unwrap_or("");
        let betas = ycoding_ai::claude_code::merge_betas(existing.split(',').chain([
            "interleaved-thinking-2025-05-14",
            "fine-grained-tool-streaming-2025-05-14",
        ]))
        .join(",");
        put(&mut headers, "anthropic-beta", &betas, true);
    }
    if package == "@openrouter/ai-sdk-provider" {
        put(
            &mut headers,
            "HTTP-Referer",
            "https://github.com/Althenia/ycoding",
            false,
        );
        put(&mut headers, "X-OpenRouter-Title", "YCoding", false);
        put(&mut headers, "X-OpenRouter-Categories", "cli-agent", false);
        put(&mut headers, "X-Title", "YCoding", true);
        record.provider.package = "@ycoding-ai/ai/providers/openrouter".into();
        for model in &mut record.models {
            model.package = Some(record.provider.package.clone());
            if model.id == "gpt-5-chat-latest".into() || model.id == "openai/gpt-5-chat".into() {
                model.enabled = false;
            }
        }
    }
    if package == "@ai-sdk/vercel" {
        put(&mut headers, "x-title", "YCoding", true);
    }
    if package == "@ai-sdk/openai-compatible"
        && endpoint.as_deref() == Some("https://zenmux.ai/api/v1")
    {
        put(&mut headers, "X-Title", "YCoding", false);
    }
    record.provider.overlays.settings = Some(provider::Settings::decode(&settings)?);
    if !headers.is_empty() {
        record.provider.overlays.headers = Some(headers);
    }
    if field(&settings, "apiKey")
        .and_then(models_dev::text)
        .is_none()
        && let Some(key) = record
            .environment
            .iter()
            .find_map(|name| name.as_str().and_then(|name| environment.get(name)))
    {
        set(&mut settings, "apiKey", key.encode());
        record.provider.overlays.settings = Some(provider::Settings::decode(&settings)?);
    }
    Ok(())
}
fn put(headers: &mut JsonObject, name: &str, value: &str, force: bool) {
    let present = headers.iter().any(|(key, _)| {
        key.as_str()
            .is_some_and(|key| key.eq_ignore_ascii_case(name))
    });
    if !force && present {
        return;
    }
    if present {
        let mut kept = JsonObject::new();
        for (key, value) in headers.iter().filter(|(key, _)| {
            key.as_str()
                .is_none_or(|key| !key.eq_ignore_ascii_case(name))
        }) {
            kept.insert(key.clone(), value.clone());
        }
        *headers = kept;
    }
    headers.insert(name.into(), value.encode());
}
