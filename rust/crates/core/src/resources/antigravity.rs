use super::{
    auth::{self, Preparation},
    catalog::{Catalog, ProviderRecord, empty_model, field, models_dev, object},
    credential,
};
use std::{collections::BTreeSet, time::Duration};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonValue, LosslessString, model::Info, provider,
};

const EFFORTS: [&str; 6] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const PREFERRED: [&str; 6] = ["medium", "high", "low", "xhigh", "max", "minimal"];

#[derive(Clone, Default)]
struct Entry {
    display_name: Option<LosslessString>,
    max_tokens: Option<f64>,
    max_output_tokens: Option<f64>,
    supports_images: Option<bool>,
    supports_thinking: Option<bool>,
    thinking_level: Option<f64>,
    thinking_budget: Option<f64>,
    supports_video: Option<bool>,
    supports_pdf: Option<bool>,
    is_internal: Option<bool>,
    disabled: Option<bool>,
}
struct Row {
    id: String,
    lossless_id: LosslessString,
    entry: Entry,
}
struct EffortRow {
    row: usize,
    effort: String,
    name: String,
}
#[derive(Default)]
struct Group {
    base: Option<usize>,
    efforts: Vec<EffortRow>,
}

fn optional_text(row: &JsonValue, name: &str) -> Option<Option<LosslessString>> {
    match field(row, name) {
        None => Some(None),
        Some(JsonValue::String(value)) => Some(Some(value.clone())),
        Some(_) => None,
    }
}
fn optional_number(row: &JsonValue, name: &str) -> Option<Option<f64>> {
    match field(row, name) {
        None => Some(None),
        Some(JsonValue::Number(value)) => Some(Some(*value)),
        Some(_) => None,
    }
}
fn optional_bool(row: &JsonValue, name: &str) -> Option<Option<bool>> {
    match field(row, name) {
        None => Some(None),
        Some(JsonValue::Bool(value)) => Some(Some(*value)),
        Some(_) => None,
    }
}
fn decode_entry(row: &JsonValue) -> Option<Entry> {
    if !matches!(row, JsonValue::Object(_)) {
        return None;
    }
    Some(Entry {
        display_name: optional_text(row, "displayName")?,
        max_tokens: optional_number(row, "maxTokens")?,
        max_output_tokens: optional_number(row, "maxOutputTokens")?,
        supports_images: optional_bool(row, "supportsImages")?,
        supports_thinking: optional_bool(row, "supportsThinking")?,
        thinking_level: optional_number(row, "thinkingLevel")?,
        thinking_budget: optional_number(row, "thinkingBudget")?,
        supports_video: optional_bool(row, "supportsVideo")?,
        supports_pdf: optional_bool(row, "supportsPdf")?,
        is_internal: optional_bool(row, "isInternal")?,
        disabled: optional_bool(row, "disabled")?,
    })
}
fn thinking_settings(entry: &Entry) -> Option<JsonValue> {
    if entry.supports_thinking != Some(true) {
        return None;
    }
    let level = match entry.thinking_level {
        Some(1.0) => Some("low"),
        Some(2.0) => Some("medium"),
        Some(3.0) => Some("high"),
        Some(4.0) => Some("minimal"),
        _ => None,
    };
    let mut config = vec![("includeThoughts", true.encode())];
    if let Some(level) = level {
        config.push(("thinkingLevel", level.encode()));
    } else if let Some(budget) = entry.thinking_budget {
        config.push(("thinkingBudget", budget.encode()));
    }
    Some(object(&[("thinkingConfig", object(&config))]))
}
fn is_gemini(row: &Row) -> bool {
    if row.id.len() >= 7 && row.id[..7].eq_ignore_ascii_case("gemini-") {
        return true;
    }
    let Some(name) = row
        .entry
        .display_name
        .as_ref()
        .and_then(|name| name.as_str())
    else {
        return false;
    };
    name.len() >= 6
        && name.is_char_boundary(6)
        && name[..6].eq_ignore_ascii_case("gemini")
        && !name[6..]
            .chars()
            .next()
            .is_some_and(|next| next.is_ascii_alphanumeric() || next == '_')
}
fn trailing_suffix(display_name: &str) -> Option<(&str, &str)> {
    let inner = display_name.strip_suffix(')')?;
    let open = inner.rfind('(')?;
    let title = &inner[open + 1..];
    let name = &inner[..open];
    (!title.is_empty()
        && !title.contains(')')
        && name.chars().last().is_some_and(char::is_whitespace))
    .then_some((name, title))
}
fn effort_row(rows: &[Row], index: usize) -> Option<(String, EffortRow)> {
    let row = &rows[index];
    if let Some(effort) = EFFORTS
        .iter()
        .copied()
        .find(|effort| row.id.len() > effort.len() + 1 && row.id.ends_with(&format!("-{effort}")))
    {
        let base = row.id[..row.id.len() - effort.len() - 1].to_owned();
        match &row.entry.display_name {
            None => {
                return Some((
                    base.clone(),
                    EffortRow {
                        row: index,
                        effort: effort.into(),
                        name: base,
                    },
                ));
            }
            Some(display_name) => {
                if let Some((name, title)) = display_name.as_str().and_then(trailing_suffix)
                    && matches!(
                        title,
                        "Minimal" | "Low" | "Medium" | "High" | "XHigh" | "Max"
                    )
                    && title.to_ascii_lowercase() == effort
                {
                    return Some((
                        base,
                        EffortRow {
                            row: index,
                            effort: effort.into(),
                            name: name.trim_end().to_owned(),
                        },
                    ));
                }
            }
        }
    }
    if !is_gemini(row) {
        return None;
    }
    let (name, title) = row
        .entry
        .display_name
        .as_ref()
        .and_then(|name| name.as_str())
        .and_then(trailing_suffix)?;
    let name = name.trim();
    let variant = title
        .trim()
        .to_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if name.is_empty() || variant.is_empty() {
        return None;
    }
    let base = row
        .id
        .strip_suffix(&format!("-{variant}"))
        .filter(|base| !base.is_empty())
        .unwrap_or(&row.id)
        .to_owned();
    Some((
        base,
        EffortRow {
            row: index,
            effort: variant,
            name: name.to_owned(),
        },
    ))
}
fn variant(rows: &[Row], effort: &EffortRow) -> Option<ycoding_schema::model::Variant> {
    let row = &rows[effort.row];
    let mut settings = JsonObject::new();
    if let Some(JsonValue::Object(thinking)) = thinking_settings(&row.entry) {
        for (key, value) in thinking.iter() {
            settings.insert(key.clone(), value.clone());
        }
    }
    settings.insert("antigravityModelID".into(), row.id.as_str().encode());
    ycoding_schema::model::Variant::decode(&object(&[
        ("id", effort.effort.as_str().encode()),
        ("settings", JsonValue::Object(settings)),
    ]))
    .ok()
}
fn catalog_model(
    id: &LosslessString,
    id_text: &str,
    row: &Row,
    name: Option<String>,
    model_id: Option<&str>,
    variants: Vec<ycoding_schema::model::Variant>,
) -> Option<Info> {
    let entry = &row.entry;
    let image = id_text.contains("image");
    let mut model = empty_model(provider::Id("antigravity".into()), id.clone()).ok()?;
    model.name = name
        .map(|name| name.as_str().into())
        .or_else(|| entry.display_name.clone())
        .unwrap_or_else(|| id.clone());
    if let Some(model_id) = model_id {
        model.model_id = model_id.into();
    }
    model.package = Some("aisdk:@ai-sdk/google".into());
    model.settings = thinking_settings(entry)
        .map(|settings| provider::Settings::decode(&settings))
        .transpose()
        .ok()?;
    model.capabilities.tools = !image;
    model.capabilities.input = vec!["text".into()];
    if entry.supports_images == Some(true) {
        model.capabilities.input.push("image".into());
    }
    if entry.supports_video == Some(true) {
        model.capabilities.input.push("video".into());
    }
    if entry.supports_pdf == Some(true) {
        model.capabilities.input.push("pdf".into());
    }
    model.capabilities.output = if image {
        vec!["text".into(), "image".into()]
    } else {
        vec!["text".into()]
    };
    let context = entry
        .max_tokens
        .filter(|value| value.fract() == 0.0 && *value > 0.0)
        .unwrap_or(0.0);
    model.limit = ycoding_schema::model::Limit::decode(&object(&[
        ("context", context.encode()),
        ("output", entry.max_output_tokens.unwrap_or(8192.0).encode()),
    ]))
    .ok()?;
    model.variants = variants;
    Some(model)
}

pub struct Models {
    pub models: Vec<Info>,
    pub skipped: usize,
}
pub fn models(response: &JsonValue) -> Result<Models, models_dev::Error> {
    let deprecated = match field(response, "deprecatedModelIds") {
        None => BTreeSet::new(),
        Some(JsonValue::Object(entries)) => entries
            .iter()
            .filter_map(|(id, _)| id.as_str().map(str::to_owned))
            .collect(),
        Some(_) => return Err(models_dev::Error::InvalidSource),
    };
    let entries = match field(response, "models") {
        None => {
            return Ok(Models {
                models: Vec::new(),
                skipped: 0,
            });
        }
        Some(JsonValue::Object(entries)) => entries,
        Some(_) => return Err(models_dev::Error::InvalidSource),
    };
    let mut sorted = entries.iter().collect::<Vec<_>>();
    sorted.sort_by(|(left, _), (right, _)| left.as_str().cmp(&right.as_str()));
    let mut rows = Vec::new();
    let mut skipped = 0;
    for (id, row) in sorted {
        let Some(id_text) = id.as_str().map(str::to_owned) else {
            skipped += 1;
            continue;
        };
        let Some(entry) = decode_entry(row) else {
            skipped += 1;
            continue;
        };
        if entry.disabled == Some(true)
            || entry.is_internal == Some(true)
            || deprecated.contains(&id_text)
        {
            skipped += 1;
            continue;
        }
        rows.push(Row {
            id: id_text,
            lossless_id: id.clone(),
            entry,
        });
    }
    let mut groups: Vec<(String, Group)> = Vec::new();
    for index in 0..rows.len() {
        let parsed = effort_row(&rows, index);
        let key = parsed
            .as_ref()
            .map(|(base, _)| base.clone())
            .unwrap_or_else(|| rows[index].id.clone());
        let position = match groups.iter().position(|(existing, _)| *existing == key) {
            Some(position) => position,
            None => {
                groups.push((key, Group::default()));
                groups.len() - 1
            }
        };
        match parsed {
            Some((_, effort)) => groups[position].1.efforts.push(effort),
            None => groups[position].1.base = Some(index),
        }
    }
    groups.sort_by(|(left, _), (right, _)| left.cmp(right));
    let mut result = Vec::new();
    for (base, group) in &groups {
        if group.efforts.is_empty() {
            if let Some(row) = group.base.map(|index| &rows[index])
                && let Some(model) =
                    catalog_model(&row.lossless_id, &row.id, row, None, None, Vec::new())
            {
                result.push(model);
            }
            continue;
        }
        if group.base.is_none()
            && group.efforts.len() == 1
            && !is_gemini(&rows[group.efforts[0].row])
        {
            let row = &rows[group.efforts[0].row];
            if let Some(model) =
                catalog_model(&row.lossless_id, &row.id, row, None, None, Vec::new())
            {
                result.push(model);
            }
            continue;
        }
        let preferred = PREFERRED
            .iter()
            .find_map(|effort| group.efforts.iter().find(|row| row.effort == *effort));
        let pick = group
            .base
            .or_else(|| preferred.map(|row| row.row))
            .or_else(|| group.efforts.first().map(|row| row.row));
        let Some(pick) = pick.map(|index| &rows[index]) else {
            continue;
        };
        let mut efforts = group.efforts.iter().collect::<Vec<_>>();
        efforts.sort_by(|left, right| {
            let position =
                |row: &EffortRow| EFFORTS.iter().position(|effort| *effort == row.effort);
            match (position(left), position(right)) {
                (Some(left), Some(right)) => left.cmp(&right),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => left.effort.cmp(&right.effort),
            }
        });
        let Some(variants) = efforts
            .iter()
            .map(|effort| variant(&rows, effort))
            .collect::<Option<Vec<_>>>()
        else {
            continue;
        };
        let name = if group.base.is_some() {
            pick.entry
                .display_name
                .as_ref()
                .and_then(|name| name.as_str().map(str::to_owned))
                .unwrap_or_else(|| base.clone())
        } else {
            preferred
                .or_else(|| group.efforts.first())
                .map(|row| row.name.clone())
                .unwrap_or_else(|| base.clone())
        };
        if let Some(model) = catalog_model(
            &base.as_str().into(),
            base,
            pick,
            Some(name),
            Some(&pick.id),
            variants,
        ) {
            result.push(model);
        }
    }
    Ok(Models {
        models: result,
        skipped,
    })
}

#[derive(Clone)]
pub struct Account {
    credential: credential::Info,
    project: Option<String>,
    pub models: Vec<Info>,
}
pub struct Service {
    http: reqwest::Client,
    pub(crate) base_url: String,
    accounts: Vec<Account>,
    source: Option<String>,
    next_reconcile: i64,
}
impl Service {
    pub fn new() -> Result<Self, models_dev::Error> {
        Ok(Self {
            http: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| models_dev::Error::Request)?,
            base_url: ycoding_ai::antigravity::BASE_URL.into(),
            accounts: Vec::new(),
            source: None,
            next_reconcile: 0,
        })
    }
    pub fn with_base_url(mut self, base_url: String) -> Self {
        self.base_url = base_url;
        self
    }
    pub fn source(&self) -> Option<&str> {
        self.source.as_deref()
    }
    pub fn seed(
        &self,
        catalog: &mut Catalog,
        credentials: &credential::Service,
    ) -> Result<(), models_dev::Error> {
        let saved = credentials
            .list(&"antigravity".into())
            .map_err(|_| models_dev::Error::Storage)?;
        let accounts = self
            .accounts
            .iter()
            .filter(|account| {
                saved.iter().any(|current| {
                    current.id() == account.credential.id()
                        && current.account_generation() == account.credential.account_generation()
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        publish(catalog, &accounts);
        Ok(())
    }
    pub async fn refresh(
        &mut self,
        catalog: &mut Catalog,
        credentials: &credential::Service,
        preparation: &Preparation,
        now: i64,
    ) -> Result<bool, models_dev::Error> {
        self.source = None;
        self.reconcile(catalog, credentials, preparation, now).await
    }
    pub async fn reconcile(
        &mut self,
        catalog: &mut Catalog,
        credentials: &credential::Service,
        preparation: &Preparation,
        now: i64,
    ) -> Result<bool, models_dev::Error> {
        let saved = credentials
            .list(&"antigravity".into())
            .map_err(|_| models_dev::Error::Storage)?;
        let material = JsonValue::Array(
            saved
                .iter()
                .map(|credential| {
                    object(&[
                        ("id", credential.id().encode()),
                        ("generation", (credential.generation() as f64).encode()),
                        (
                            "accountGeneration",
                            (credential.account_generation() as f64).encode(),
                        ),
                    ])
                })
                .collect(),
        );
        let source = ring::digest::digest(
            &ring::digest::SHA256,
            ycoding_schema::stringify_json(&material).as_bytes(),
        )
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
        if self.source.as_ref() == Some(&source) && now < self.next_reconcile {
            self.seed(catalog, credentials)?;
            return Ok(false);
        }
        let mut accounts = Vec::new();
        let mut failed = false;
        for selected in &saved {
            let Ok(secret) = preparation
                .prepare_value(credentials, selected.clone(), now, None)
                .await
            else {
                continue;
            };
            let Ok(ycoding_schema::credential::Value::OAuth(value)) = secret.domain() else {
                continue;
            };
            let Some(access) = value.access.as_str().map(str::to_owned) else {
                continue;
            };
            let retained = self.accounts.iter().find(|account| {
                account.credential.id() == selected.id()
                    && account.credential.account_generation() == selected.account_generation()
            });
            let stored_project = value
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get(&"projectID".into()))
                .and_then(models_dev::text)
                .filter(|project| !project.is_empty())
                .map(str::to_owned);
            let project = match stored_project {
                Some(project) => Some(project),
                None => match tokio::time::timeout(
                    Duration::from_secs(60),
                    auth::antigravity::discover_project(&self.base_url, &access),
                )
                .await
                {
                    Ok(Ok(project)) => project,
                    _ => {
                        tracing::warn!(
                            provider = "antigravity",
                            "failed to discover the Antigravity project"
                        );
                        retained.and_then(|account| account.project.clone())
                    }
                },
            };
            let loaded = tokio::time::timeout(
                Duration::from_secs(15),
                self.fetch_models(&access, project.as_deref()),
            )
            .await;
            let discovered = match loaded {
                Ok(Ok(response)) => models(&response).map(|discovered| discovered.models).ok(),
                _ => None,
            };
            let models = match discovered {
                Some(models) => models,
                None => {
                    failed = true;
                    tracing::warn!(
                        provider = "antigravity",
                        "failed to sync Antigravity models; check the subscription and reconnect Antigravity if the account token expired"
                    );
                    retained
                        .map(|account| account.models.clone())
                        .unwrap_or_default()
                }
            };
            if credentials.current_account(selected).is_err() {
                failed = true;
                continue;
            }
            accounts.push(Account {
                credential: selected.clone(),
                project: project.or_else(|| retained.and_then(|account| account.project.clone())),
                models,
            });
        }
        publish(catalog, &accounts);
        self.accounts = accounts;
        self.source = (!failed).then_some(source);
        self.next_reconcile = now.saturating_add(60_000);
        Ok(true)
    }
    async fn fetch_models(
        &self,
        access: &str,
        project: Option<&str>,
    ) -> Result<JsonValue, models_dev::Error> {
        let body = project.map_or_else(
            || object(&[]),
            |project| object(&[("project", project.encode())]),
        );
        let response = self
            .http
            .post(format!(
                "{}/v1internal:fetchAvailableModels",
                self.base_url.trim_end_matches('/')
            ))
            .bearer_auth(access)
            .header("Accept", "application/json")
            .header("User-Agent", ycoding_ai::antigravity::user_agent())
            .header("Content-Type", "application/json")
            .body(ycoding_schema::stringify_json(&body))
            .send()
            .await
            .map_err(|_| models_dev::Error::Request)?;
        if !response.status().is_success() {
            return Err(models_dev::Error::Request);
        }
        if response
            .content_length()
            .is_some_and(|length| length > 4 * 1024 * 1024)
        {
            return Err(models_dev::Error::InvalidSource);
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| models_dev::Error::Request)?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err(models_dev::Error::InvalidSource);
        }
        ycoding_schema::parse_json(
            std::str::from_utf8(&bytes).map_err(|_| models_dev::Error::InvalidSource)?,
        )
        .map_err(|_| models_dev::Error::InvalidSource)
    }
}
pub fn publish(catalog: &mut Catalog, accounts: &[Account]) {
    let id = provider::Id("antigravity".into());
    let mut models = Vec::<Info>::new();
    for model in accounts.iter().flat_map(|account| &account.models) {
        if let Some(existing) = models.iter_mut().find(|existing| existing.id == model.id) {
            *existing = model.clone();
        } else {
            models.push(model.clone());
        }
    }
    let info = provider::Info::decode(&object(&[
        ("id", id.encode()),
        ("name", "Antigravity".encode()),
        ("integrationID", "antigravity".encode()),
        ("package", "aisdk:@ai-sdk/google".encode()),
    ]))
    .expect("static Antigravity provider");
    if let Some(record) = catalog
        .providers
        .iter_mut()
        .find(|record| record.provider.id == id)
    {
        record.provider = info;
        record.models = models;
        record.environment = Vec::new();
    } else {
        catalog.providers.push(ProviderRecord {
            provider: info,
            models,
            environment: Vec::new(),
        });
    }
    catalog.account_clear(&id);
    for account in accounts {
        catalog.account_update(&account.credential, id.clone(), account.models.clone());
    }
}
