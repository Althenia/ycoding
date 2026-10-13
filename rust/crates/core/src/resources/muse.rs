use super::{
    catalog::{Catalog, ProviderRecord, empty_model, field, for_effort, models_dev, object},
    credential, model,
};
use std::{collections::BTreeMap, sync::Arc};
use ycoding_ai::{
    llm::Model,
    muse::{BASE_URL, Connection, Runtime},
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder, model::Info,
    provider,
};

pub fn connection(
    runtime: Arc<Runtime>,
    value: &ycoding_schema::credential::Value,
    saved: Option<&credential::Info>,
    base_url: &str,
) -> Result<Connection, model::Error> {
    let profile = saved
        .map(|c| model::account_identity(c).to_utf8())
        .transpose()
        .map_err(|_| model::Error::InvalidSettings)?;
    match value {
        ycoding_schema::credential::Value::Key(key) => Ok(Connection::key(
            runtime,
            key.key
                .to_utf8()
                .map_err(|_| model::Error::InvalidSettings)?,
            base_url.into(),
            profile,
        )),
        ycoding_schema::credential::Value::OAuth(oauth) => {
            let saved = saved.ok_or(model::Error::ProfileUnavailable)?;
            Ok(Connection::oauth(
                runtime,
                format!(
                    "{}:{}",
                    saved
                        .id()
                        .to_utf8()
                        .map_err(|_| model::Error::InvalidSettings)?,
                    saved.generation()
                ),
                oauth
                    .access
                    .to_utf8()
                    .map_err(|_| model::Error::InvalidSettings)?,
                oauth.expires.get(),
                profile.ok_or(model::Error::ProfileUnavailable)?,
            ))
        }
    }
}

pub fn from_catalog_model(
    info: &Info,
    value: Option<&ycoding_schema::credential::Value>,
    saved: Option<&credential::Info>,
    runtime: Arc<Runtime>,
) -> Result<Model, model::Error> {
    if info.package.as_ref().and_then(|p| p.as_str()) != Some("aisdk:@ai-sdk/openai") {
        return Err(model::Error::UnsupportedPackage);
    }
    let value = value
        .cloned()
        .or_else(|| {
            info.settings
                .as_ref()
                .and_then(|s| s.0.get(&"apiKey".into()))
                .and_then(models_dev::text)
                .map(|key| {
                    ycoding_schema::credential::Value::Key(ycoding_schema::credential::Key {
                        key: key.into(),
                        metadata: None,
                    })
                })
        })
        .ok_or(model::Error::ProfileUnavailable)?;
    let base = info
        .settings
        .as_ref()
        .and_then(|s| s.0.get(&"baseURL".into()))
        .and_then(models_dev::text)
        .unwrap_or(BASE_URL);
    let base_model = model::from_catalog_model_base(info, Some(&value))?;
    let mut result = ycoding_ai::muse::route(connection(runtime, &value, saved, base)?)
        .model(info.model_id.clone());
    result.defaults = base_model.defaults;
    Ok(result)
}

pub struct Models {
    pub models: Vec<Info>,
    pub skipped: usize,
}
pub fn models(response: &JsonValue, base_url: &str) -> Result<Models, models_dev::Error> {
    let Some(JsonValue::Array(rows)) = field(response, "data") else {
        return Err(models_dev::Error::InvalidSource);
    };
    let mut result = Models {
        models: vec![],
        skipped: 0,
    };
    for row in rows {
        match decode_model(row, base_url) {
            Some(model) => result.models.push(model),
            None => result.skipped += 1,
        }
    }
    Ok(result)
}
fn decode_model(row: &JsonValue, base_url: &str) -> Option<Info> {
    let p = JsonPath(Vec::new());
    let row = ObjectDecoder::new(row, &p).ok()?;
    let id: LosslessString = row.field("id").ok()?;
    let metadata: JsonValue = row.field("metadata").ok()?;
    let metadata = ObjectDecoder::new(field(&metadata, "muse-code")?, &p).ok()?;
    let name: Option<LosslessString> = metadata.optional("name").ok()?;
    let family: Option<LosslessString> = metadata.optional("family").ok()?;
    let released: Option<LosslessString> = metadata.optional("release_date").ok()?;
    let hidden: Option<bool> = metadata.optional("is_hidden").ok()?;
    let tools: Option<bool> = metadata.optional("tool_call").ok()?;
    let modalities: JsonValue = metadata.field("modalities").ok()?;
    let modalities = ObjectDecoder::new(&modalities, &p).ok()?;
    let input: Vec<LosslessString> = modalities.field("input").ok()?;
    let output: Vec<LosslessString> = modalities.field("output").ok()?;
    let limit: ycoding_schema::model::Limit = metadata.field("limit").ok()?;
    if hidden == Some(true) || tools == Some(false) || !output.contains(&"text".into()) {
        return None;
    }
    let options: Option<JsonValue> = metadata.optional("options").ok()?;
    let effort: Option<LosslessString> = options
        .as_ref()
        .map(|v| ObjectDecoder::new(v, &p)?.optional("reasoningEffort"))
        .transpose()
        .ok()?
        .flatten();
    let mut settings = for_effort(
        "@ai-sdk/openai",
        id.as_str()?,
        effort
            .as_ref()
            .and_then(LosslessString::as_str)
            .unwrap_or("none"),
    )?;
    if effort.is_none()
        && let JsonValue::Object(s) = &settings
    {
        let mut filtered = ycoding_schema::JsonObject::new();
        for (key, value) in s
            .iter()
            .filter(|(key, _)| key.as_str() != Some("reasoningEffort"))
        {
            filtered.insert(key.clone(), value.clone());
        }
        settings = JsonValue::Object(filtered);
    }
    if let JsonValue::Object(s) = &mut settings {
        s.insert("store".into(), false.encode());
        s.insert("baseURL".into(), base_url.encode());
    }
    let variants: Option<ycoding_schema::JsonObject> = metadata.optional("variants").ok()?;
    let variants = optional(variants.map(|variants| {
        variants
            .iter()
            .map(|(id, v)| {
                let effort: LosslessString = ObjectDecoder::new(v, &p)
                    .ok()?
                    .field("reasoningEffort")
                    .ok()?;
                ycoding_schema::model::Variant::decode(&object(&[
                    ("id", id.encode()),
                    (
                        "settings",
                        for_effort("@ai-sdk/openai", "muse", effort.as_str()?)?,
                    ),
                ]))
                .ok()
            })
            .collect::<Option<Vec<_>>>()
    }))?
    .unwrap_or_default();
    let mut model = empty_model(provider::Id("muse".into()), id.clone()).ok()?;
    model.name = name.unwrap_or(id);
    model.family = family;
    model.package = Some("aisdk:@ai-sdk/openai".into());
    model.settings = Some(provider::Settings::decode(&settings).ok()?);
    model.limit = limit;
    model.capabilities.tools = true;
    model.capabilities.input = input;
    model.capabilities.output = output;
    model.time.released = ycoding_schema::schema::Finite::new(
        released
            .as_ref()
            .and_then(LosslessString::as_str)
            .and_then(models_dev::date_millis)
            .unwrap_or(0.0),
    )
    .ok()?;
    model.variants = variants;
    Some(model)
}
fn optional<T>(value: Option<Option<T>>) -> Option<Option<T>> {
    match value {
        None => Some(None),
        Some(Some(v)) => Some(Some(v)),
        Some(None) => None,
    }
}

#[derive(Clone)]
pub struct Account {
    credential: Option<credential::Info>,
    env_key: Option<String>,
    pub models: Vec<Info>,
}
pub struct Service {
    runtime: Arc<Runtime>,
    pub(crate) base_url: String,
    accounts: Vec<Account>,
    source: Option<String>,
    next_reconcile: i64,
}
impl Service {
    pub fn new(runtime: Arc<Runtime>) -> Self {
        Self {
            runtime,
            base_url: BASE_URL.into(),
            accounts: vec![],
            source: None,
            next_reconcile: 0,
        }
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
        env: &BTreeMap<String, String>,
    ) -> Result<(), models_dev::Error> {
        let saved = credentials
            .list(&"muse".into())
            .map_err(|_| models_dev::Error::Storage)?;
        let accounts = self
            .accounts
            .iter()
            .filter(|account| match &account.credential {
                Some(selected) => saved.iter().any(|current| {
                    current.id() == selected.id()
                        && current.account_generation() == selected.account_generation()
                }),
                None => saved.is_empty() && account.env_key.as_ref() == env.get("META_API_KEY"),
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
        env: &BTreeMap<String, String>,
        now: i64,
    ) -> Result<bool, models_dev::Error> {
        self.source = None;
        self.reconcile(catalog, credentials, env, now).await
    }
    pub async fn reconcile(
        &mut self,
        catalog: &mut Catalog,
        credentials: &credential::Service,
        env: &BTreeMap<String, String>,
        now: i64,
    ) -> Result<bool, models_dev::Error> {
        let saved = credentials
            .list(&"muse".into())
            .map_err(|_| models_dev::Error::Storage)?;
        let env_key = env.get("META_API_KEY").filter(|v| !v.is_empty());
        let material = object(&[
            (
                "credentials",
                JsonValue::Array(
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
                ),
            ),
            (
                "env",
                env_key.map_or(JsonValue::Null, |key| key.as_str().encode()),
            ),
        ]);
        let source = ring::digest::digest(
            &ring::digest::SHA256,
            ycoding_schema::stringify_json(&material).as_bytes(),
        )
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
        if self.source.as_ref() == Some(&source) && now < self.next_reconcile {
            self.seed(catalog, credentials, env)?;
            return Ok(false);
        }
        let connections = if saved.is_empty() {
            env_key
                .map(|key| {
                    (
                        None,
                        ycoding_schema::credential::Value::Key(ycoding_schema::credential::Key {
                            key: key.clone().into(),
                            metadata: None,
                        }),
                    )
                })
                .into_iter()
                .collect()
        } else {
            saved
                .iter()
                .filter_map(|c| c.secret().domain().ok().map(|v| (Some(c.clone()), v)))
                .collect::<Vec<_>>()
        };
        let mut accounts = vec![];
        let mut failed = false;
        for (saved, value) in connections {
            let loaded = async {
                let connection =
                    connection(self.runtime.clone(), &value, saved.as_ref(), &self.base_url)
                        .map_err(|_| models_dev::Error::Request)?;
                let key = connection
                    .key_for(now)
                    .await
                    .map_err(|_| models_dev::Error::Request)?;
                models(
                    &connection
                        .discover(now)
                        .await
                        .map_err(|_| models_dev::Error::Request)?,
                    &key.base_url,
                )
            }
            .await;
            let models = match loaded {
                Ok(loaded) => loaded.models,
                Err(_) => {
                    failed = true;
                    self.accounts
                        .iter()
                        .find(|account| match (&account.credential, &saved) {
                            (Some(a), Some(b)) => {
                                a.id() == b.id() && a.account_generation() == b.account_generation()
                            }
                            (None, None) => account.env_key.as_ref() == env_key,
                            _ => false,
                        })
                        .map_or_else(Vec::new, |a| a.models.clone())
                }
            };
            if let Some(saved) = &saved
                && credentials.current_account(saved).is_err()
            {
                failed = true;
                continue;
            }
            accounts.push(Account {
                credential: saved,
                env_key: env_key.cloned(),
                models,
            });
        }
        publish(catalog, &accounts);
        self.accounts = accounts;
        self.source = (!failed).then_some(source);
        self.next_reconcile = now.saturating_add(60_000);
        Ok(true)
    }
}
pub fn publish(catalog: &mut Catalog, accounts: &[Account]) {
    let id = provider::Id("muse".into());
    let mut models = Vec::<Info>::new();
    for model in accounts.iter().flat_map(|a| &a.models) {
        if let Some(existing) = models.iter_mut().find(|m| m.id == model.id) {
            *existing = model.clone();
        } else {
            models.push(model.clone());
        }
    }
    let info = provider::Info::decode(&object(&[
        ("id", id.encode()),
        ("name", "Muse (Meta)".encode()),
        ("integrationID", "muse".encode()),
        ("package", "aisdk:@ai-sdk/openai".encode()),
    ]))
    .expect("static Muse provider");
    if let Some(record) = catalog.providers.iter_mut().find(|r| r.provider.id == id) {
        record.provider = info;
        record.models = models;
        record.environment = vec!["META_API_KEY".into()];
    } else {
        catalog.providers.push(ProviderRecord {
            provider: info,
            models,
            environment: vec!["META_API_KEY".into()],
        });
    }
    catalog.account_clear(&id);
    for account in accounts {
        if let Some(c) = &account.credential {
            catalog.account_update(c, id.clone(), account.models.clone());
        }
    }
}
