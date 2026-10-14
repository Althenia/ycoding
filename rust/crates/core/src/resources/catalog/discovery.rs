use super::{Catalog, ProviderRecord, empty_model, field, field_lossless, models_dev, object, set};
use crate::resources::credential;
use std::time::Duration;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonValue, LosslessString, model, provider,
};

pub struct Composition {
    pub catalog: Catalog,
    pub diagnostics: Vec<DiscoveryDiagnostic>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveryDiagnostic {
    pub provider_id: provider::Id,
}
impl Catalog {
    pub async fn compose_with_accounts(
        snapshots: Vec<models_dev::Snapshot>,
        documents: &[JsonValue],
        credentials: &credential::Service,
        accounts: &mut super::AccountCatalog,
        now: i64,
        force: bool,
    ) -> Result<Composition, models_dev::Error> {
        let mut composition = accounts
            .configured(snapshots, documents, credentials, now, force)
            .await?;
        composition.diagnostics.extend(
            accounts
                .reconcile(&mut composition.catalog, credentials, now, force)
                .await?,
        );
        composition.catalog.configure(documents)?;
        Ok(composition)
    }
    pub async fn compose(
        snapshots: Vec<models_dev::Snapshot>,
        documents: &[JsonValue],
        credentials: &credential::Service,
    ) -> Result<Composition, models_dev::Error> {
        Self::compose_prepared(
            snapshots,
            documents,
            credentials,
            &Default::default(),
            None,
            chrono::Utc::now().timestamp_millis(),
        )
        .await
    }
    pub(crate) async fn compose_prepared(
        snapshots: Vec<models_dev::Snapshot>,
        documents: &[JsonValue],
        credentials: &credential::Service,
        preparation: &crate::resources::auth::Preparation,
        claude: Option<&crate::resources::auth::claude::Store>,
        now: i64,
    ) -> Result<Composition, models_dev::Error> {
        let mut catalog = Catalog::new(snapshots);
        let base = catalog.clone();
        let mut configured: Vec<(LosslessString, JsonValue)> = Vec::new();
        for document in documents {
            let Some(JsonValue::Object(providers)) = field(document, "providers") else {
                continue;
            };
            for (id, provider) in providers.iter() {
                if crate::resources::model::scope::dropped_provider(id, provider) {
                    continue;
                }
                if !configured.iter().any(|(key, _)| key == id) {
                    configured.push((
                        id.clone(),
                        object(&[("settings", object(&[])), ("headers", object(&[]))]),
                    ));
                }
                let current = &mut configured
                    .iter_mut()
                    .find(|(key, _)| key == id)
                    .expect("configured provider")
                    .1;
                for key in ["settings", "headers"] {
                    let mut value = field(current, key).cloned().unwrap_or_else(|| object(&[]));
                    if let Some(JsonValue::Object(overlay)) = field(provider, key) {
                        for (name, entry) in overlay.iter() {
                            if let JsonValue::Object(value) = &mut value {
                                value.insert(name.clone(), entry.clone());
                            }
                        }
                    }
                    set(current, key, value);
                }
                if let Some(source) = field(provider, "catalog").and_then(|v| field(v, "source")) {
                    set(current, "source", source.clone());
                }
            }
        }
        let managed = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| models_dev::Error::Request)?;
        let unmanaged = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| models_dev::Error::Request)?;
        let mut diagnostics = Vec::new();
        for (id, configuration) in configured {
            if field(&configuration, "source").and_then(models_dev::text) != Some("openai-models") {
                continue;
            }
            let provider_id = provider::Id(id.clone());
            let integration = catalog
                .provider(&provider_id)
                .and_then(|p| p.integration_id.as_ref())
                .map(|i| i.as_lossless())
                .unwrap_or(&id);
            let saved = credentials
                .list(integration)
                .map_err(|_| models_dev::Error::Storage)?;
            let selections = if saved.is_empty() {
                vec![None]
            } else {
                saved.iter().map(Some).collect()
            };
            if catalog.provider(&provider_id).is_none() {
                catalog.providers.push(ProviderRecord {
                    provider: provider::Info::decode(&object(&[
                        ("id", id.encode()),
                        ("name", id.encode()),
                        ("package", "".encode()),
                    ]))?,
                    models: vec![],
                    environment: vec![],
                });
            }
            let configured_ids = documents
                .iter()
                .filter_map(|d| {
                    field(d, "providers")
                        .and_then(|p| field_lossless(p, &id))
                        .and_then(|p| field(p, "models"))
                })
                .filter_map(|v| match v {
                    JsonValue::Object(m) => {
                        Some(m.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>())
                    }
                    _ => None,
                })
                .flatten()
                .collect::<Vec<_>>();
            for credential in selections {
                let prepared = match credential {
                    Some(credential) => preparation
                        .prepare_value(credentials, credential.clone(), now, claude)
                        .await
                        .map_err(|_| models_dev::Error::Request)
                        .and_then(|secret| secret.domain().map_err(|_| models_dev::Error::Storage))
                        .map(Some),
                    None => Ok(None),
                };
                let discovered = match prepared {
                    Ok(input) => {
                        discover(
                            if credential.is_some() {
                                &managed
                            } else {
                                &unmanaged
                            },
                            &configuration,
                            input.as_ref(),
                        )
                        .await
                    }
                    Err(error) => Err(error),
                };
                let discovered = match discovered {
                    Ok(discovered) => discovered,
                    _ => {
                        diagnostics.push(DiscoveryDiagnostic {
                            provider_id: provider_id.clone(),
                        });
                        vec![]
                    }
                };
                let discovered = if let Some(credential) = credential {
                    if credentials
                        .get(credential.id())
                        .map_err(|_| models_dev::Error::Storage)?
                        .is_none_or(|current| {
                            current.account_generation() != credential.account_generation()
                        })
                    {
                        vec![]
                    } else {
                        discovered
                    }
                } else {
                    discovered
                };
                let mut account = Vec::new();
                for discovered in &discovered {
                    let id = field(discovered, "id")
                        .and_then(models_dev::text)
                        .ok_or(models_dev::Error::InvalidSource)?;
                    let model =
                        apply_discovered(&base, provider_id.clone(), id.into(), discovered)?;
                    let record = catalog
                        .providers
                        .iter_mut()
                        .find(|p| p.provider.id == provider_id)
                        .expect("discovered provider");
                    if let Some(existing) = record.models.iter_mut().find(|m| m.id == model.id) {
                        *existing = model.clone();
                    } else {
                        record.models.push(model.clone());
                    }
                    account.push(model);
                }
                for id in &configured_ids {
                    if !account.iter().any(|m| &m.id == id) {
                        account.push(
                            base.providers
                                .iter()
                                .find(|p| p.provider.id == provider_id)
                                .and_then(|p| p.models.iter().find(|m| &m.id == id))
                                .cloned()
                                .unwrap_or(empty_model(provider_id.clone(), id.clone())?),
                        );
                    }
                }
                if let Some(credential) = credential {
                    catalog.account_update(credential, provider_id.clone(), account);
                }
            }
        }
        catalog.configure(documents)?;
        Ok(Composition {
            catalog,
            diagnostics,
        })
    }
}
async fn discover(
    client: &reqwest::Client,
    configuration: &JsonValue,
    credential: Option<&ycoding_schema::credential::Value>,
) -> Result<Vec<JsonValue>, models_dev::Error> {
    let settings = field(configuration, "settings").ok_or(models_dev::Error::InvalidSource)?;
    let base = field(settings, "baseURL")
        .and_then(models_dev::text)
        .filter(|s| !s.is_empty())
        .ok_or(models_dev::Error::InvalidSource)?;
    let endpoint = format!("{}/models", base.strip_suffix('/').unwrap_or(base));
    if credential.is_some() {
        let url = url::Url::parse(&endpoint).map_err(|_| models_dev::Error::InvalidSource)?;
        if !url.username().is_empty()
            || url.password().is_some()
            || !(url.scheme() == "https"
                || (url.scheme() == "http"
                    && ["localhost", "127.0.0.1", "[::1]"].contains(&url.host_str().unwrap_or(""))))
        {
            return Err(models_dev::Error::InvalidSource);
        }
    }
    let mut request = client.get(endpoint);
    let mut headers = reqwest::header::HeaderMap::new();
    if let Some(JsonValue::Object(input)) = field(configuration, "headers") {
        for (name, value) in input.iter() {
            headers.insert(
                reqwest::header::HeaderName::from_bytes(
                    name.to_utf8()
                        .map_err(|_| models_dev::Error::InvalidSource)?
                        .as_bytes(),
                )
                .map_err(|_| models_dev::Error::InvalidSource)?,
                reqwest::header::HeaderValue::from_str(
                    models_dev::text(value).ok_or(models_dev::Error::InvalidSource)?,
                )
                .map_err(|_| models_dev::Error::InvalidSource)?,
            );
        }
    }
    if let Some(credential) = credential {
        let token = match credential {
            ycoding_schema::credential::Value::Key(key) => &key.key,
            ycoding_schema::credential::Value::OAuth(oauth) => &oauth.access,
        };
        headers.insert(
            "authorization",
            reqwest::header::HeaderValue::from_str(&format!(
                "Bearer {}",
                token
                    .to_utf8()
                    .map_err(|_| models_dev::Error::InvalidSource)?
            ))
            .map_err(|_| models_dev::Error::InvalidSource)?,
        );
    } else if !headers.contains_key("authorization")
        && let Some(key) = field(settings, "apiKey")
            .and_then(models_dev::text)
            .filter(|s| !s.is_empty())
    {
        request = request.bearer_auth(key);
    }
    let response = request
        .headers(headers)
        .send()
        .await
        .map_err(|_| models_dev::Error::Request)?;
    if !response.status().is_success() {
        return Err(models_dev::Error::Request);
    }
    let response = ycoding_schema::parse_json(
        &response
            .text()
            .await
            .map_err(|_| models_dev::Error::InvalidSource)?,
    )
    .map_err(|_| models_dev::Error::InvalidSource)?;
    if field(&response, "object").and_then(models_dev::text) != Some("list") {
        return Err(models_dev::Error::InvalidSource);
    }
    let Some(JsonValue::Array(data)) = field(&response, "data") else {
        return Err(models_dev::Error::InvalidSource);
    };
    if data.iter().any(|item| {
        field(item, "id")
            .and_then(models_dev::text)
            .is_none_or(str::is_empty)
    }) {
        return Err(models_dev::Error::InvalidSource);
    }
    Ok(data.clone())
}
fn apply_discovered(
    base: &Catalog,
    provider: provider::Id,
    id: LosslessString,
    discovered: &JsonValue,
) -> Result<model::Info, models_dev::Error> {
    let mut model = empty_model(provider.clone(), id.clone())?;
    let name = field(discovered, "name").and_then(models_dev::text);
    let candidates = base
        .providers
        .iter()
        .filter(|p| p.provider.id != provider)
        .flat_map(|p| p.models.iter())
        .filter(|m| {
            m.id == id || m.model_id == id || name.is_some_and(|name| m.name == name.into())
        })
        .collect::<Vec<_>>();
    let source = candidates
        .iter()
        .find(|m| m.provider_id.0 == "openrouter".into())
        .or_else(|| {
            candidates
                .iter()
                .find(|m| m.provider_id.0 == "openai".into())
        })
        .or_else(|| candidates.first());
    if let Some(source) = source {
        model.family = source.family.clone();
        model.limit = source.limit.clone();
        model.cost = source.cost.clone();
        model.capabilities = source.capabilities.clone();
    }
    if let Some(name) = name.filter(|name| !name.is_empty()) {
        model.name = name.into();
    }
    if source.is_none() {
        model.capabilities.input = vec!["text".into()];
        model.capabilities.output = vec!["text".into()];
    }
    if let Some(capabilities) = field(discovered, "capabilities") {
        if let Some(JsonValue::Bool(tools)) = field(capabilities, "tools") {
            model.capabilities.tools = *tools;
        }
        for key in ["input", "output"] {
            if let Some(JsonValue::Array(values)) = field(capabilities, key)
                && values.iter().all(|v| matches!(v, JsonValue::String(_)))
            {
                let values = values
                    .iter()
                    .map(LosslessString::decode)
                    .collect::<Result<Vec<_>, _>>()?;
                if key == "input" {
                    model.capabilities.input = values;
                } else {
                    model.capabilities.output = values;
                }
            }
        }
    }
    if let Some(limit) = field(discovered, "limit") {
        let mut encoded = model.limit.encode();
        for key in ["context", "input", "output"] {
            if let Some(value @ JsonValue::Number(_)) = field(limit, key) {
                set(&mut encoded, key, value.clone());
            }
        }
        model.limit = model::Limit::decode(&encoded)?;
    }
    if let Some(JsonValue::Array(variants)) = field(discovered, "variants") {
        model.variants = variants
            .iter()
            .filter(|v| {
                field(v, "id")
                    .and_then(models_dev::text)
                    .is_some_and(|id| !id.is_empty())
            })
            .map(|v| {
                let mut variant = JsonObject::new();
                for key in ["id", "settings", "headers", "body"] {
                    if let Some(value) = field(v, key)
                        .filter(|value| key == "id" || matches!(value, JsonValue::Object(_)))
                    {
                        variant.insert(key.into(), value.clone());
                    }
                }
                model::Variant::decode(&JsonValue::Object(variant))
            })
            .collect::<Result<_, _>>()?;
    }
    Ok(model)
}
