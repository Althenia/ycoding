use super::{config::Configuration, credential};
use std::collections::BTreeSet;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonValue, LosslessString, model, provider,
};

pub(crate) mod date;
mod discovery;
pub mod models_dev;
mod variants;
pub use discovery::{Composition, DiscoveryDiagnostic};
pub(crate) use variants::for_effort;

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderRecord {
    pub provider: provider::Info,
    pub models: Vec<model::Info>,
    pub environment: Vec<LosslessString>,
}
#[derive(Clone)]
struct Account {
    credential: LosslessString,
    generation: i64,
    provider: provider::Id,
    models: Vec<model::Info>,
}
#[derive(Clone, Default)]
pub struct Catalog {
    pub providers: Vec<ProviderRecord>,
    default: Option<model::Ref>,
    accounts: Vec<Account>,
    contextual: BTreeSet<provider::Id>,
    connected: BTreeSet<LosslessString>,
    denied: BTreeSet<provider::Id>,
}

impl Catalog {
    pub fn integrations(&self) -> Vec<provider::IntegrationRef> {
        self.providers
            .iter()
            .filter(|record| {
                record.provider.disabled != Some(true) && !self.denied.contains(&record.provider.id)
            })
            .map(|record| provider::IntegrationRef {
                provider_id: record.provider.id.clone(),
                integration_id: record.provider.integration_id.clone().unwrap_or_else(|| {
                    ycoding_schema::integration::Id::new(record.provider.id.0.clone())
                        .expect("integration ID")
                }),
            })
            .collect()
    }
    pub fn available_providers(&self, saved: &[credential::Info]) -> Vec<&provider::Info> {
        self.providers
            .iter()
            .map(|record| &record.provider)
            .filter(|provider| self.provider_available(provider, saved))
            .collect()
    }
    pub fn configured_default(&self) -> Option<&model::Ref> {
        self.default.as_ref()
    }
    pub fn set_default(&mut self, selection: Option<model::Ref>) {
        self.default = selection;
    }
    pub fn new(snapshots: Vec<models_dev::Snapshot>) -> Self {
        Self {
            providers: snapshots
                .into_iter()
                .map(|snapshot| {
                    let mut info = snapshot.info;
                    info.integration_id = Some(
                        ycoding_schema::integration::Id::new(info.id.0.clone())
                            .expect("integration IDs accept strings"),
                    );
                    let mut models = snapshot.models;
                    if info.package == "aisdk:@ai-sdk/openai".into() {
                        for model in &mut models {
                            if model.id == "gpt-5-chat-latest".into() {
                                model.enabled = false;
                            }
                        }
                    }
                    if info.package == "aisdk:@openrouter/ai-sdk-provider".into() {
                        info.package = "@ycoding-ai/ai/providers/openrouter".into();
                        let defaults = object(&[
                            (
                                "HTTP-Referer",
                                "https://github.com/Althenia/ycoding".encode(),
                            ),
                            ("X-OpenRouter-Title", "YCoding".encode()),
                            ("X-OpenRouter-Categories", "cli-agent".encode()),
                        ]);
                        let JsonValue::Object(mut headers) = defaults else {
                            unreachable!()
                        };
                        if let Some(existing) = &info.overlays.headers {
                            for (key, value) in existing.iter() {
                                headers.insert(key.clone(), value.clone());
                            }
                        }
                        headers.insert("X-Title".into(), "YCoding".encode());
                        info.overlays.headers = Some(headers);
                        for model in &mut models {
                            model.package = Some(info.package.clone());
                            if model.id == "gpt-5-chat-latest".into()
                                || model.id == "openai/gpt-5-chat".into()
                            {
                                model.enabled = false;
                            }
                        }
                    }
                    ProviderRecord {
                        provider: info,
                        models,
                        environment: snapshot.environment,
                    }
                })
                .collect(),
            ..Self::default()
        }
    }
    pub fn from_config(
        snapshots: Vec<models_dev::Snapshot>,
        config: &Configuration,
    ) -> Result<Self, models_dev::Error> {
        let mut catalog = Self::new(snapshots);
        let documents = config
            .entries
            .iter()
            .filter_map(|entry| match entry {
                super::config::Entry::Document { info, .. } => Some(info.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        catalog.configure(&documents)?;
        Ok(catalog)
    }
    pub fn provider(&self, id: &provider::Id) -> Option<&provider::Info> {
        self.providers
            .iter()
            .find(|p| &p.provider.id == id)
            .map(|p| &p.provider)
    }
    pub fn set_connected(&mut self, integration: LosslessString, connected: bool) {
        if connected {
            self.connected.insert(integration);
            return;
        }
        self.connected.remove(&integration);
    }
    pub fn set_denied(&mut self, provider: provider::Id, denied: bool) {
        if denied {
            self.denied.insert(provider);
            return;
        }
        self.denied.remove(&provider);
    }
    pub fn set_disabled(&mut self, id: &provider::Id, disabled: bool) {
        if let Some(record) = self.providers.iter_mut().find(|p| &p.provider.id == id) {
            record.provider.disabled = Some(disabled);
        }
    }
    pub fn account_update(
        &mut self,
        credential: &credential::Info,
        provider: provider::Id,
        models: Vec<model::Info>,
    ) {
        self.contextual.insert(provider.clone());
        self.accounts.retain(|account| {
            account.credential != *credential.id()
                || (account.generation == credential.account_generation()
                    && account.provider != provider)
        });
        self.accounts.push(Account {
            credential: credential.id().clone(),
            generation: credential.account_generation(),
            provider,
            models,
        });
    }
    pub fn account_clear(&mut self, provider: &provider::Id) {
        self.contextual.insert(provider.clone());
        self.accounts
            .retain(|account| &account.provider != provider);
    }
    fn account(
        &self,
        credential: &credential::Info,
        provider: &provider::Id,
    ) -> Option<&[model::Info]> {
        self.accounts
            .iter()
            .find(|account| {
                account.credential == *credential.id()
                    && account.generation == credential.account_generation()
                    && &account.provider == provider
            })
            .map(|a| a.models.as_slice())
    }
    pub fn provider_available(
        &self,
        provider: &provider::Info,
        saved: &[credential::Info],
    ) -> bool {
        if provider.disabled == Some(true) || self.denied.contains(&provider.id) {
            return false;
        }
        if provider
            .overlays
            .settings
            .as_ref()
            .and_then(|s| get(&s.0, "apiKey"))
            .is_some_and(|v| matches!(v, JsonValue::String(_)))
        {
            return true;
        }
        let integration = provider
            .integration_id
            .as_ref()
            .map(|id| id.as_lossless())
            .unwrap_or(&provider.id.0);
        if saved.iter().any(|c| c.integration_id() == integration)
            || self.connected.contains(integration)
        {
            return true;
        }
        provider.integration_id.is_none()
    }
    pub fn get(
        &self,
        provider: &provider::Id,
        id: &model::Id,
        profile: Option<&model::ProfileName>,
        saved: &[credential::Info],
    ) -> Option<model::Info> {
        let record = self.providers.iter().find(|p| &p.provider.id == provider)?;
        let model = record.models.iter().find(|m| &m.id == id).or_else(|| {
            saved
                .iter()
                .find_map(|c| self.account(c, provider)?.iter().find(|m| &m.id == id))
        });
        if let Some(profile) = profile {
            let integration = record
                .provider
                .integration_id
                .as_ref()
                .map(|i| i.as_lossless())
                .unwrap_or(&provider.0);
            let matching = saved
                .iter()
                .filter(|c| c.integration_id() == integration && c.label() == &profile.0)
                .collect::<Vec<_>>();
            if matching.len() != 1 {
                return None;
            }
            let selected = if self.contextual.contains(provider) {
                self.account(matching[0], provider)?
                    .iter()
                    .find(|m| &m.id == id)?
                    .clone()
            } else {
                project(model?, &record.provider)
            };
            return Some(self.profiled(selected, &record.provider, saved, Some(matching[0])));
        }
        Some(self.profiled(
            project(model?, &record.provider),
            &record.provider,
            saved,
            None,
        ))
    }
    fn profiled(
        &self,
        mut model: model::Info,
        provider: &provider::Info,
        saved: &[credential::Info],
        selected: Option<&credential::Info>,
    ) -> model::Info {
        let integration = provider
            .integration_id
            .as_ref()
            .map(|i| i.as_lossless())
            .unwrap_or(&provider.id.0);
        let relevant = saved
            .iter()
            .filter(|c| c.integration_id() == integration)
            .collect::<Vec<_>>();
        let active = relevant
            .iter()
            .find(|c| c.active())
            .copied()
            .or_else(|| relevant.last().copied());
        let effective = selected.or(active);
        let contextual = self.contextual.contains(&provider.id);
        if let Some(effective) = effective {
            let contextual_model = self
                .account(effective, &provider.id)
                .and_then(|models| models.iter().find(|m| m.id == model.id));
            if let Some(contextual_model) = contextual_model {
                model = contextual_model.clone();
            }
            if contextual {
                model.enabled = contextual_model.is_some_and(|m| m.enabled);
            }
        }
        model.profiles = Some(
            relevant
                .iter()
                .filter_map(|credential| {
                    if relevant
                        .iter()
                        .filter(|c| c.label() == credential.label())
                        .count()
                        != 1
                    {
                        return None;
                    }
                    let account_model = self
                        .account(credential, &provider.id)
                        .and_then(|models| models.iter().find(|m| m.id == model.id));
                    if !(if contextual {
                        account_model.is_some_and(|m| m.enabled)
                    } else {
                        model.enabled
                    }) {
                        return None;
                    }
                    let variants = if contextual {
                        account_model.map(|m| m.variants.as_slice()).unwrap_or(&[])
                    } else {
                        &model.variants
                    };
                    Some(model::Profile {
                        name: model::ProfileName(credential.label().clone()),
                        active: active.is_some_and(|c| c.id() == credential.id()),
                        variants: Some(variants.iter().map(|v| v.id.clone()).collect()),
                        daybreak: account_model
                            .and_then(|m| m.daybreak.clone())
                            .filter(|v| !v.is_empty()),
                    })
                })
                .collect(),
        );
        model
    }
    pub fn for_connection(
        &self,
        model: &model::Info,
        credential: Option<&credential::Info>,
    ) -> Option<model::Info> {
        let provider = self.provider(&model.provider_id);
        if provider.is_some_and(|p| p.disabled == Some(true))
            || self.denied.contains(&model.provider_id)
        {
            return None;
        }
        let account_models = credential.and_then(|c| self.account(c, &model.provider_id));
        if credential.is_some()
            && self.contextual.contains(&model.provider_id)
            && account_models.is_none()
        {
            return None;
        }
        let selected = match account_models {
            Some(models) => models.iter().find(|m| m.id == model.id)?,
            None => model,
        };
        if !selected.enabled {
            return None;
        }
        Some(if account_models.is_some() {
            selected.clone()
        } else {
            provider
                .map(|p| project(selected, p))
                .unwrap_or_else(|| selected.clone())
        })
    }
    pub fn all(&self, saved: &[credential::Info]) -> Vec<model::Info> {
        let mut models = self
            .providers
            .iter()
            .flat_map(|record| {
                let mut models = record.models.clone();
                for credential in saved {
                    for model in self.account(credential, &record.provider.id).unwrap_or(&[]) {
                        if !models.iter().any(|m| m.id == model.id) {
                            models.push(model.clone());
                        }
                    }
                }
                models
                    .into_iter()
                    .map(|m| {
                        self.profiled(project(&m, &record.provider), &record.provider, saved, None)
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        models.sort_by(|a, b| b.time.released.get().total_cmp(&a.time.released.get()));
        models
    }
    pub fn available(&self, saved: &[credential::Info]) -> Vec<model::Info> {
        self.all(saved)
            .into_iter()
            .filter(|m| {
                self.provider(&m.provider_id)
                    .is_some_and(|p| self.provider_available(p, saved))
                    && (m.enabled || m.profiles.as_ref().is_some_and(|p| !p.is_empty()))
            })
            .collect()
    }
    pub fn default_model(&self, saved: &[credential::Info]) -> Option<model::Info> {
        if let Some(selection) = &self.default {
            if self
                .provider(&selection.provider_id)
                .is_some_and(|p| self.provider_available(p, saved))
                && let Some(model) = self.get(
                    &selection.provider_id,
                    &selection.id,
                    selection.profile.as_ref(),
                    saved,
                )
                && selection.profile.as_ref().map_or(model.enabled, |p| {
                    model
                        .profiles
                        .as_ref()
                        .is_some_and(|profiles| profiles.iter().any(|v| &v.name == p))
                })
            {
                return Some(model);
            }
            if selection.profile.is_some() {
                return None;
            }
        }
        self.available(saved).into_iter().find(|m| m.enabled)
    }
    pub fn default_selection(&self, saved: &[credential::Info]) -> Option<model::Ref> {
        if let Some(selection) = &self.default
            && selection.profile.is_some()
        {
            return Some(selection.clone());
        }
        let model = self.default_model(saved)?;
        Some(model::Ref {
            variant: self
                .default
                .as_ref()
                .filter(|s| s.provider_id == model.provider_id && s.id == model.id)
                .and_then(|s| s.variant.clone()),
            provider_id: model.provider_id,
            id: model.id,
            profile: None,
        })
    }
    pub fn small(&self, provider: &provider::Id, now: f64) -> Option<model::Info> {
        if provider.0 == "azure".into() || provider.0 == "azure-cognitive-services".into() {
            return None;
        }
        let record = self.providers.iter().find(|p| &p.provider.id == provider)?;
        if provider.0 == "opencode".into()
            && let Some(m) = record
                .models
                .iter()
                .find(|m| m.id == "gpt-5-nano".into() && m.enabled && m.status == "active".into())
        {
            return Some(project(m, &record.provider));
        }
        let candidates = record
            .models
            .iter()
            .filter(|m| {
                m.enabled
                    && m.status == "active".into()
                    && m.capabilities
                        .input
                        .iter()
                        .any(|s| s.as_str().is_some_and(|s| s.starts_with("text")))
                    && m.capabilities
                        .output
                        .iter()
                        .any(|s| s.as_str().is_some_and(|s| s.starts_with("text")))
                    && !m.cost.is_empty()
            })
            .map(|m| (m, (now - m.time.released.get()) / 2_592_000_000.0))
            .filter(|(m, age)| m.time.released.get() == 0.0 || *age <= 18.0)
            .collect::<Vec<_>>();
        let small = candidates
            .iter()
            .filter(|(m, _)| {
                format!(
                    "{} {} {}",
                    display(&m.id),
                    m.family.as_ref().map(display).unwrap_or_default(),
                    display(&m.name)
                )
                .to_lowercase()
                .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .any(|s| ["nano", "flash", "lite", "mini", "haiku", "small", "fast"].contains(&s))
            })
            .copied()
            .collect::<Vec<_>>();
        let pool = if small.is_empty() {
            &candidates
        } else {
            &small
        };
        let max_cost = pool
            .iter()
            .map(|(m, _)| m.cost[0].input.get() + m.cost[0].output.get())
            .fold(0.01_f64, f64::max);
        let max_age = pool.iter().map(|(_, age)| *age).fold(0.01_f64, f64::max);
        pool.iter()
            .min_by(|(a, aa), (b, ba)| {
                ((a.cost[0].input.get() + a.cost[0].output.get()) / max_cost * 0.8
                    + aa / max_age * 0.2)
                    .total_cmp(
                        &((b.cost[0].input.get() + b.cost[0].output.get()) / max_cost * 0.8
                            + ba / max_age * 0.2),
                    )
            })
            .map(|(m, _)| project(m, &record.provider))
    }
    pub fn configure(&mut self, documents: &[JsonValue]) -> Result<(), models_dev::Error> {
        let mut configured = self.clone();
        for document in documents {
            if let Some(selection) = field(document, "model") {
                configured.default = Some(selection_ref(selection)?);
            }
            let Some(JsonValue::Object(providers)) = field(document, "providers") else {
                continue;
            };
            for (id, item) in providers.iter() {
                let provider_id = provider::Id(id.clone());
                if !configured
                    .providers
                    .iter()
                    .any(|p| p.provider.id == provider_id)
                {
                    configured.providers.push(ProviderRecord {
                        provider: provider::Info::decode(&object(&[
                            ("id", id.encode()),
                            ("name", id.encode()),
                            ("package", "".encode()),
                        ]))?,
                        models: vec![],
                        environment: vec![],
                    });
                }
                let record = configured
                    .providers
                    .iter_mut()
                    .find(|p| p.provider.id == provider_id)
                    .expect("inserted provider");
                let mut encoded = record.provider.encode();
                apply_fields(
                    &mut encoded,
                    item,
                    &["name", "package", "settings", "headers", "body"],
                );
                record.provider = provider::Info::decode(&encoded)?;
                if let Some(JsonValue::Array(environment)) = field(item, "env") {
                    record.environment = environment
                        .iter()
                        .map(LosslessString::decode)
                        .collect::<Result<_, _>>()?;
                }
                if let Some(JsonValue::Object(models)) = field(item, "models") {
                    for (id, config) in models.iter() {
                        if !record.models.iter().any(|m| &m.id == id) {
                            record
                                .models
                                .push(empty_model(provider_id.clone(), id.clone())?);
                        }
                        let model = record
                            .models
                            .iter_mut()
                            .find(|m| &m.id == id)
                            .expect("inserted model");
                        apply_model(model, config)?;
                    }
                }
            }
        }
        for account in &mut configured.accounts {
            for model in &mut account.models {
                for document in documents {
                    if let Some(provider) = field(document, "providers")
                        .and_then(|v| field_lossless(v, &account.provider.0))
                    {
                        let mut encoded = model.encode();
                        apply_fields(
                            &mut encoded,
                            provider,
                            &["package", "settings", "headers", "body"],
                        );
                        *model = model::Info::decode(&encoded)?;
                    }
                }
                for document in documents {
                    if let Some(config) = field(document, "providers")
                        .and_then(|v| field_lossless(v, &account.provider.0))
                        .and_then(|v| field(v, "models"))
                        .and_then(|v| field_lossless(v, &model.id))
                    {
                        apply_model(model, config)?;
                    }
                }
            }
        }
        *self = configured;
        Ok(())
    }
}

fn selection_ref(value: &JsonValue) -> Result<model::Ref, models_dev::Error> {
    let JsonValue::Object(mut value) = value.clone() else {
        return Err(models_dev::Error::InvalidSource);
    };
    let id = get(&value, "model")
        .cloned()
        .ok_or(models_dev::Error::InvalidSource)?;
    value.insert("id".into(), id);
    Ok(model::Ref::decode(&JsonValue::Object(value))?)
}
fn apply_model(model: &mut model::Info, config: &JsonValue) -> Result<(), models_dev::Error> {
    let mut encoded = model.encode();
    apply_fields(
        &mut encoded,
        config,
        &[
            "family",
            "name",
            "modelID",
            "api",
            "package",
            "settings",
            "headers",
            "body",
            "capabilities",
            "limit",
        ],
    );
    if let Some(JsonValue::Bool(disabled)) = field(config, "disabled") {
        set(&mut encoded, "enabled", JsonValue::Bool(!disabled));
    }
    if let Some(cost) = field(config, "cost") {
        let costs = match cost {
            JsonValue::Array(costs) => costs.clone(),
            cost => vec![cost.clone()],
        };
        let costs = costs
            .into_iter()
            .map(|mut cost| {
                let cache = field(&cost, "cache")
                    .cloned()
                    .unwrap_or_else(|| object(&[]));
                let cache = merge_json(
                    &object(&[("read", 0.0.encode()), ("write", 0.0.encode())]),
                    &cache,
                );
                set(&mut cost, "cache", cache);
                cost
            })
            .collect();
        set(&mut encoded, "cost", JsonValue::Array(costs));
    }
    if let Some(JsonValue::Array(variants)) = field(config, "variants") {
        let mut existing = model
            .variants
            .iter()
            .map(DomainEncode::encode)
            .collect::<Vec<_>>();
        for variant in variants {
            let id = field(variant, "id").ok_or(models_dev::Error::InvalidSource)?;
            if let Some(current) = existing.iter_mut().find(|v| field(v, "id") == Some(id)) {
                apply_fields(current, variant, &["settings", "headers", "body"]);
            } else {
                existing.push(variant.clone());
            }
        }
        set(&mut encoded, "variants", JsonValue::Array(existing));
    }
    *model = model::Info::decode(&encoded)?;
    Ok(())
}
fn apply_fields(target: &mut JsonValue, source: &JsonValue, keys: &[&str]) {
    for key in keys {
        if let Some(value) = field(source, key) {
            let next = if *key == "headers" {
                match (field(target, key), value) {
                    (Some(JsonValue::Object(left)), JsonValue::Object(right)) => {
                        JsonValue::Object(merge_headers(left, right))
                    }
                    _ => value.clone(),
                }
            } else if ["settings", "body", "capabilities", "limit"].contains(key) {
                field(target, key)
                    .map(|base| merge_json(base, value))
                    .unwrap_or_else(|| value.clone())
            } else {
                value.clone()
            };
            set(target, key, next);
        }
    }
}
pub fn project(model: &model::Info, provider: &provider::Info) -> model::Info {
    let mut model = model.clone();
    model.package = model.package.or_else(|| Some(provider.package.clone()));
    model.settings = merge_settings(provider.overlays.settings.as_ref(), model.settings.as_ref());
    model.body = merge_settings(provider.overlays.body.as_ref(), model.body.as_ref());
    model.headers = match (&provider.overlays.headers, &model.headers) {
        (Some(a), Some(b)) => Some(merge_headers(a, b)),
        (Some(a), None) => Some(a.clone()),
        _ => model.headers,
    };
    model
}
pub fn merge_settings(
    base: Option<&provider::Settings>,
    overlay: Option<&provider::Settings>,
) -> Option<provider::Settings> {
    match (base, overlay) {
        (Some(a), Some(b)) => match merge_json(&a.encode(), &b.encode()) {
            JsonValue::Object(object) => Some(provider::Settings(object)),
            _ => unreachable!(),
        },
        (Some(a), None) => Some(a.clone()),
        (None, Some(b)) => Some(b.clone()),
        _ => None,
    }
}
pub fn merge_json(base: &JsonValue, overlay: &JsonValue) -> JsonValue {
    let (JsonValue::Object(base), JsonValue::Object(overlay)) = (base, overlay) else {
        return overlay.clone();
    };
    let mut result = base.clone();
    for (key, value) in overlay.iter() {
        result.insert(
            key.clone(),
            base.get(key)
                .map(|v| merge_json(v, value))
                .unwrap_or_else(|| value.clone()),
        );
    }
    JsonValue::Object(result)
}
pub fn merge_headers(base: &JsonObject, overlay: &JsonObject) -> JsonObject {
    let mut entries: Vec<(LosslessString, LosslessString, JsonValue)> = vec![];
    for (key, value) in base.iter().chain(overlay.iter()) {
        let lower = lowercase(key);
        if let Some(existing) = entries.iter_mut().find(|entry| entry.0 == lower) {
            existing.1 = key.clone();
            existing.2 = value.clone();
            continue;
        }
        entries.push((lower, key.clone(), value.clone()));
    }
    let mut result = JsonObject::new();
    for (_, key, value) in entries {
        result.insert(key, value);
    }
    result
}
pub(crate) fn empty_model(
    provider: provider::Id,
    id: LosslessString,
) -> Result<model::Info, models_dev::Error> {
    Ok(model::Info::decode(&object(&[
        ("providerID", provider.encode()),
        ("id", id.encode()),
        ("modelID", id.encode()),
        ("name", id.encode()),
        (
            "capabilities",
            object(&[
                ("tools", false.encode()),
                ("input", JsonValue::Array(vec![])),
                ("output", JsonValue::Array(vec![])),
            ]),
        ),
        ("variants", JsonValue::Array(vec![])),
        ("time", object(&[("released", 0.0.encode())])),
        ("cost", JsonValue::Array(vec![])),
        ("status", "active".encode()),
        ("enabled", true.encode()),
        (
            "limit",
            object(&[("context", 0.0.encode()), ("output", 0.0.encode())]),
        ),
    ]))?)
}
pub(crate) fn get<'a>(object: &'a JsonObject, key: &str) -> Option<&'a JsonValue> {
    object.get(&key.into())
}
pub(crate) fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    field_lossless(value, &key.into())
}
pub(crate) fn field_lossless<'a>(
    value: &'a JsonValue,
    key: &LosslessString,
) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(key),
        _ => None,
    }
}
pub(crate) fn object(entries: &[(&str, JsonValue)]) -> JsonValue {
    let mut result = JsonObject::new();
    for (key, value) in entries {
        result.insert((*key).into(), value.clone());
    }
    JsonValue::Object(result)
}
pub(crate) fn set(value: &mut JsonValue, key: &str, entry: JsonValue) {
    if let JsonValue::Object(object) = value {
        object.insert(key.into(), entry);
    }
}
fn display(value: &LosslessString) -> String {
    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
}
fn lowercase(value: &LosslessString) -> LosslessString {
    LosslessString::from_utf16(
        char::decode_utf16(value.code_units())
            .flat_map(|c| match c {
                Ok(c) => c
                    .to_lowercase()
                    .collect::<String>()
                    .encode_utf16()
                    .collect::<Vec<_>>(),
                Err(error) => vec![error.unpaired_surrogate()],
            })
            .collect(),
    )
}
