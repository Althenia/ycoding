use super::{
    Catalog, DiscoveryDiagnostic, ProviderRecord, field,
    models_dev::{self, text},
    object, project, set,
};
use crate::resources::{auth, credential, cursor, muse};
use std::collections::BTreeMap;
use ycoding_schema::{DomainDecode, DomainEncode, JsonValue, provider};

struct Inventory {
    selected: credential::Info,
    providers: Vec<ProviderRecord>,
}
pub struct AccountCatalog {
    pub preparation: auth::Preparation,
    pub claude: Option<auth::claude::Store>,
    pub environment: BTreeMap<String, String>,
    pub endpoints: BTreeMap<String, String>,
    http: reqwest::Client,
    accounts: Vec<Inventory>,
    muse: muse::Service,
    source: Option<String>,
    next_reconcile: i64,
    configured: Option<(String, Catalog, Vec<DiscoveryDiagnostic>, i64)>,
    cursor_env: Option<(String, Vec<ycoding_schema::model::Info>)>,
}
impl AccountCatalog {
    pub fn new(
        preparation: auth::Preparation,
        environment: BTreeMap<String, String>,
    ) -> Result<Self, models_dev::Error> {
        Ok(Self {
            preparation,
            environment,
            claude: None,
            endpoints: BTreeMap::new(),
            http: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(3))
                .build()
                .map_err(|_| models_dev::Error::Request)?,
            accounts: Vec::new(),
            muse: muse::Service::new(
                ycoding_ai::muse::Runtime::shared().map_err(|_| models_dev::Error::Request)?,
            ),
            source: None,
            next_reconcile: 0,
            configured: None,
            cursor_env: None,
        })
    }
    pub fn seed(
        &self,
        catalog: &mut Catalog,
        credentials: &credential::Service,
    ) -> Result<(), models_dev::Error> {
        let saved = credentials.all().map_err(|_| models_dev::Error::Storage)?;
        for id in catalog
            .providers
            .iter()
            .filter(|record| matches!(record.provider.id.0.as_str(), Some("cursor")))
            .map(|record| record.provider.id.clone())
            .chain(
                self.accounts
                    .iter()
                    .flat_map(|account| account.providers.iter())
                    .filter(|record| matches!(record.provider.id.0.as_str(), Some("cursor")))
                    .map(|record| record.provider.id.clone()),
            )
            .collect::<std::collections::BTreeSet<_>>()
        {
            catalog.account_clear(&id);
            if let Some(record) = catalog
                .providers
                .iter_mut()
                .find(|record| record.provider.id == id)
            {
                record.models.clear();
            }
        }
        for inventory in &self.accounts {
            if !saved.iter().any(|current| {
                current.id() == inventory.selected.id()
                    && current.account_generation() == inventory.selected.account_generation()
            }) {
                continue;
            }
            for record in &inventory.providers {
                publish(catalog, &inventory.selected, record.clone());
            }
        }
        if !saved
            .iter()
            .any(|selected| selected.integration_id().as_str() == Some("cursor"))
            && let Some((key, models)) = &self.cursor_env
            && self.environment.get("CURSOR_API_KEY") == Some(key)
        {
            cursor::catalog::sync(catalog, models.clone());
        }
        if saved
            .iter()
            .any(|selected| selected.integration_id().as_str() == Some("muse"))
            || self.environment.contains_key("META_API_KEY")
            || catalog
                .providers
                .iter()
                .any(|record| record.provider.id.0 == "muse".into())
        {
            self.muse.seed(catalog, credentials, &self.environment)?;
        }
        let openai = provider::Id("openai".into());
        catalog.accounts.retain(|account| {
            saved.iter().any(|selected| {
                selected.id() == &account.credential
                    && selected.account_generation() == account.generation
            })
        });
        if let Some(record) = catalog
            .providers
            .iter()
            .find(|record| record.provider.id == openai)
            .cloned()
        {
            for selected in saved
                .iter()
                .filter(|selected| selected.integration_id().as_str() == Some("openai"))
            {
                let value = selected
                    .secret()
                    .domain()
                    .map_err(|_| models_dev::Error::Storage)?;
                let chatgpt = is_chatgpt(&value);
                let current = catalog.account(selected, &openai).map(<[_]>::to_vec);
                let models = current.unwrap_or_else(|| {
                    record
                        .models
                        .iter()
                        .filter(|model| {
                            model.id != "gpt-5-chat-latest".into()
                                && (!chatgpt
                                    || eligible(model.model_id.as_str().unwrap_or(""))
                                        && model
                                            .body
                                            .as_ref()
                                            .and_then(|body| body.0.get(&"reasoning".into()))
                                            .and_then(|reasoning| field(reasoning, "mode"))
                                            .and_then(text)
                                            != Some("pro"))
                        })
                        .map(|model| {
                            let mut model = project(model, &record.provider);
                            model.daybreak = None;
                            model
                        })
                        .collect()
                });
                catalog.account_update(selected, openai.clone(), models);
            }
        }
        catalog.transform_providers(&self.environment)
    }
    pub async fn reconcile(
        &mut self,
        catalog: &mut Catalog,
        credentials: &credential::Service,
        now: i64,
        force: bool,
    ) -> Result<Vec<DiscoveryDiagnostic>, models_dev::Error> {
        let saved = credentials.all().map_err(|_| models_dev::Error::Storage)?;
        let source = fingerprint(&JsonValue::Array(
            saved
                .iter()
                .map(|selected| {
                    object(&[
                        ("id", selected.id().encode()),
                        ("generation", (selected.generation() as f64).encode()),
                        (
                            "accountGeneration",
                            (selected.account_generation() as f64).encode(),
                        ),
                    ])
                })
                .chain(self.environment.iter().map(|(name, value)| {
                    object(&[("env", name.encode()), ("value", value.encode())])
                }))
                .collect(),
        ));
        if !force && self.source.as_ref() == Some(&source) && now < self.next_reconcile {
            self.seed(catalog, credentials)?;
            return Ok(Vec::new());
        }
        let baseline = catalog.clone();
        let mut next = Vec::new();
        let mut diagnostics = Vec::new();
        if catalog.provider_permitted(&provider::Id("anthropic".into()))
            && let Some(claude) = &self.claude
            && claude.accounts(now).await.is_err()
        {
            diagnostics.push(DiscoveryDiagnostic {
                provider_id: provider::Id("anthropic".into()),
            });
        }
        for selected in &saved {
            let integration = selected.integration_id().as_str().unwrap_or("");
            if !matches!(integration, "openai" | "cursor" | "anthropic") {
                continue;
            }
            if !catalog.provider_permitted(&provider::Id(integration.into())) {
                continue;
            }
            let prepared = self
                .preparation
                .prepare_value(credentials, selected.clone(), now, self.claude.as_ref())
                .await;
            let loaded = match prepared {
                Ok(prepared) => match prepared.domain() {
                    Ok(value) => self.discover(&baseline, selected, &value).await,
                    Err(_) => Err(models_dev::Error::Storage),
                },
                Err(_) => Err(models_dev::Error::Request),
            };
            match loaded {
                Ok(providers) if credentials.current_account(selected).is_ok() => {
                    next.push(Inventory {
                        selected: selected.clone(),
                        providers,
                    })
                }
                _ => {
                    diagnostics.push(DiscoveryDiagnostic {
                        provider_id: provider::Id(integration.into()),
                    });
                    if integration == "cursor" {
                        tracing::warn!(provider = "cursor", "failed to sync Cursor models");
                    }
                    if let Some(previous) = self.accounts.iter().find(|account| {
                        account.selected.id() == selected.id()
                            && account.selected.account_generation()
                                == selected.account_generation()
                    }) {
                        next.push(Inventory {
                            selected: selected.clone(),
                            providers: previous.providers.clone(),
                        });
                    }
                }
            }
        }
        for id in self
            .accounts
            .iter()
            .flat_map(|account| account.providers.iter())
            .filter(|record| matches!(record.provider.id.0.as_str(), Some("cursor")))
            .map(|record| record.provider.id.clone())
            .collect::<std::collections::BTreeSet<_>>()
        {
            catalog.account_clear(&id);
            if let Some(record) = catalog
                .providers
                .iter_mut()
                .find(|record| record.provider.id == id)
            {
                record.models.clear();
            }
        }
        self.accounts = next;
        self.source = (!diagnostics
            .iter()
            .any(|diagnostic| diagnostic.provider_id.0 == "cursor".into()))
        .then_some(source);
        self.next_reconcile = now.saturating_add(60_000);
        self.seed(catalog, credentials)?;
        let identities = saved
            .iter()
            .filter(|selected| selected.integration_id().as_str() == Some("muse"))
            .map(|selected| {
                Ok(format!(
                    "{}:{}",
                    selected
                        .id()
                        .to_utf8()
                        .map_err(|_| models_dev::Error::InvalidSource)?,
                    selected.generation()
                ))
            })
            .collect::<Result<Vec<_>, models_dev::Error>>()?;
        if let Some(context) = &self.preparation.providers {
            let cursor_identities = saved
                .iter()
                .filter(|selected| selected.integration_id().as_str() == Some("cursor"))
                .map(|selected| {
                    crate::resources::model::account_identity(selected)
                        .to_utf8()
                        .map_err(|_| models_dev::Error::InvalidSource)
                })
                .collect::<Result<Vec<_>, _>>()?;
            context.cursor.retain_accounts(&cursor_identities).await;
        }
        ycoding_ai::muse::Runtime::shared()
            .map_err(|_| models_dev::Error::Request)?
            .retain_accounts(&identities)
            .map_err(|_| models_dev::Error::Request)?;
        if catalog.provider_permitted(&provider::Id("muse".into()))
            && (saved
                .iter()
                .any(|selected| selected.integration_id().as_str() == Some("muse"))
                || self.environment.contains_key("META_API_KEY")
                || catalog
                    .providers
                    .iter()
                    .any(|record| record.provider.id.0 == "muse".into()))
        {
            if let Some(base) = self.endpoints.get("muse") {
                self.muse.base_url = base.clone();
            }
            if force {
                self.muse
                    .refresh(catalog, credentials, &self.environment, now)
                    .await?;
            } else {
                self.muse
                    .reconcile(catalog, credentials, &self.environment, now)
                    .await?;
            }
        }
        if catalog.provider_permitted(&provider::Id("cursor".into()))
            && !saved
                .iter()
                .any(|selected| selected.integration_id().as_str() == Some("cursor"))
            && let Some(key) = self.environment.get("CURSOR_API_KEY")
        {
            let discovered = async {
                let bearer = self
                    .preparation
                    .cursor
                    .as_ref()
                    .ok_or(models_dev::Error::Request)?
                    .resolve(None, Some(key), now)
                    .await
                    .map_err(|_| models_dev::Error::Request)?;
                let response = self.cursor_models(&bearer).await?;
                Ok::<_, models_dev::Error>(cursor::models::from_cursor(
                    &ycoding_ai::cursor::models::available_models(&response)
                        .map_err(|_| models_dev::Error::InvalidSource)?,
                ))
            }
            .await;
            let models = match discovered {
                Ok(models) => models,
                Err(_) => {
                    tracing::warn!(provider = "cursor", "failed to sync Cursor models");
                    diagnostics.push(DiscoveryDiagnostic {
                        provider_id: provider::Id("cursor".into()),
                    });
                    self.source = None;
                    self.cursor_env
                        .as_ref()
                        .map(|(_, models)| models.clone())
                        .unwrap_or_default()
                }
            };
            self.cursor_env = Some((key.clone(), models.clone()));
            cursor::catalog::sync(catalog, models);
        }
        catalog.transform_providers(&self.environment)?;
        Ok(diagnostics)
    }
    pub(crate) async fn configured(
        &mut self,
        snapshots: Vec<models_dev::Snapshot>,
        documents: &[JsonValue],
        credentials: &credential::Service,
        now: i64,
        force: bool,
    ) -> Result<super::Composition, models_dev::Error> {
        let source = fingerprint(&object(&[
            (
                "snapshots",
                JsonValue::Array(
                    snapshots
                        .iter()
                        .map(|snapshot| {
                            object(&[
                                ("provider", snapshot.info.encode()),
                                (
                                    "models",
                                    JsonValue::Array(
                                        snapshot.models.iter().map(DomainEncode::encode).collect(),
                                    ),
                                ),
                            ])
                        })
                        .collect(),
                ),
            ),
            ("documents", JsonValue::Array(documents.to_vec())),
            (
                "credentials",
                JsonValue::Array(
                    credentials
                        .all()
                        .map_err(|_| models_dev::Error::Storage)?
                        .iter()
                        .map(|selected| {
                            object(&[
                                ("id", selected.id().encode()),
                                ("generation", (selected.generation() as f64).encode()),
                                (
                                    "accountGeneration",
                                    (selected.account_generation() as f64).encode(),
                                ),
                            ])
                        })
                        .collect(),
                ),
            ),
        ]));
        if !force
            && let Some((previous, catalog, diagnostics, deadline)) = &self.configured
            && previous == &source
            && now < *deadline
        {
            return Ok(super::Composition {
                catalog: Catalog {
                    event_source: Default::default(),
                    ..catalog.clone()
                },
                diagnostics: diagnostics.clone(),
            });
        }
        if self
            .configured
            .as_ref()
            .is_some_and(|(previous, _, _, _)| previous != &source)
        {
            self.source = None;
        }
        let composition = Catalog::compose_prepared(
            snapshots,
            documents,
            credentials,
            &self.preparation,
            self.claude.as_ref(),
            now,
        )
        .await?;
        if !composition.diagnostics.is_empty() {
            return Ok(composition);
        }
        self.configured = Some((
            source,
            Catalog {
                event_source: Default::default(),
                ..composition.catalog.clone()
            },
            composition.diagnostics.clone(),
            now.saturating_add(60_000),
        ));
        Ok(composition)
    }
    async fn discover(
        &self,
        baseline: &Catalog,
        selected: &credential::Info,
        value: &ycoding_schema::credential::Value,
    ) -> Result<Vec<ProviderRecord>, models_dev::Error> {
        let integration = selected
            .integration_id()
            .as_str()
            .ok_or(models_dev::Error::InvalidSource)?;
        let (token, metadata) = match value {
            ycoding_schema::credential::Value::Key(value) => {
                (value.key.as_str(), value.metadata.as_ref())
            }
            ycoding_schema::credential::Value::OAuth(value) => {
                (value.access.as_str(), value.metadata.as_ref())
            }
        };
        let token = token.ok_or(models_dev::Error::Request)?;
        if integration == "cursor" {
            let response = self.cursor_models(token).await?;
            let available = ycoding_ai::cursor::models::available_models(&response)
                .map_err(|_| models_dev::Error::InvalidSource)?;
            if let Some(context) = &self.preparation.providers {
                context
                    .cursor
                    .set_models(selected, available.clone())
                    .await
                    .map_err(|_| models_dev::Error::InvalidSource)?;
            }
            let models = cursor::models::from_cursor(&available);
            let mut catalog = Catalog::default();
            cursor::catalog::sync(&mut catalog, models);
            return Ok(catalog.providers);
        }
        let Some(mut record) = baseline
            .providers
            .iter()
            .find(|record| record.provider.id.0 == integration.into())
            .cloned()
        else {
            return Ok(Vec::new());
        };
        if integration == "anthropic" {
            return Ok(vec![record]);
        }
        record.models = record
            .models
            .iter()
            .filter(|model| {
                model.id != "gpt-5-chat-latest".into()
                    && (!is_chatgpt(value)
                        || eligible(model.model_id.as_str().unwrap_or(""))
                            && model
                                .body
                                .as_ref()
                                .and_then(|body| body.0.get(&"reasoning".into()))
                                .and_then(|reasoning| field(reasoning, "mode"))
                                .and_then(text)
                                != Some("pro"))
            })
            .map(|model| {
                let mut model = project(model, &record.provider);
                model.daybreak = None;
                model
            })
            .collect();
        if is_chatgpt(value)
            && let Some(account) = metadata
                .and_then(|metadata| metadata.get(&"accountID".into()))
                .and_then(text)
        {
            let base = self
                .endpoints
                .get("codex")
                .map(String::as_str)
                .unwrap_or(ycoding_ai::openai_codex::BASE_URL);
            let mut url = url::Url::parse(&format!("{base}/models"))
                .map_err(|_| models_dev::Error::InvalidSource)?;
            url.query_pairs_mut()
                .append_pair("client_version", "0.157.1");
            let response = async {
                json(
                    self.http
                        .get(url)
                        .bearer_auth(token)
                        .header("chatgpt-account-id", account)
                        .header(
                            "User-Agent",
                            self.preparation
                                .providers
                                .as_ref()
                                .map(|context| format!("ycoding/{}", context.version))
                                .unwrap_or_else(|| {
                                    format!("ycoding/{}", env!("CARGO_PKG_VERSION"))
                                }),
                        )
                        .send()
                        .await
                        .map_err(|_| models_dev::Error::Request)?,
                )
                .await
            }
            .await
            .ok();
            for model in &mut record.models {
                model.daybreak = None;
            }
            if let Some(JsonValue::Array(models)) = response
                .as_ref()
                .and_then(|response| field(response, "models"))
            {
                for model in &mut record.models {
                    let programs = models
                        .iter()
                        .find(|row| field(row, "slug").and_then(text) == model.model_id.as_str())
                        .and_then(|row| field(row, "available_access_programs"))
                        .and_then(|programs| field(programs, "cyber"));
                    if let Some(JsonValue::Array(programs)) = programs {
                        let mut encoded = model.encode();
                        let programs = programs
                            .iter()
                            .filter(|program| {
                                matches!(text(program), Some("daybreak_blue" | "daybreak_red"))
                            })
                            .cloned()
                            .collect::<Vec<_>>();
                        if !programs.is_empty() {
                            set(&mut encoded, "daybreak", JsonValue::Array(programs));
                            *model = ycoding_schema::model::Info::decode(&encoded)?;
                        }
                    }
                }
            }
        }
        Ok(vec![record])
    }
    async fn cursor_models(&self, token: &str) -> Result<JsonValue, models_dev::Error> {
        let base = self
            .endpoints
            .get("cursor")
            .map(String::as_str)
            .unwrap_or("https://api2.cursor.sh");
        json(self.http.post(format!("{base}/aiserver.v1.AiService/AvailableModels")).bearer_auth(token).header("connect-protocol-version","1").header("content-type","application/json").body("{\"includeLongContextModels\":true,\"useModelParameters\":true,\"useCloudAgentEffortModes\":true}").send().await.map_err(|_|models_dev::Error::Request)?).await
    }
}
fn fingerprint(value: &JsonValue) -> String {
    ring::digest::digest(
        &ring::digest::SHA256,
        ycoding_schema::stringify_json(value).as_bytes(),
    )
    .as_ref()
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect()
}
fn publish(catalog: &mut Catalog, selected: &credential::Info, record: ProviderRecord) {
    let models = record
        .models
        .iter()
        .map(|model| project(model, &record.provider))
        .collect::<Vec<_>>();
    catalog.account_update(selected, record.provider.id.clone(), models);
    if let Some(existing) = catalog
        .providers
        .iter_mut()
        .find(|existing| existing.provider.id == record.provider.id)
    {
        existing.provider = record.provider;
        for model in record.models {
            if let Some(current) = existing
                .models
                .iter_mut()
                .find(|current| current.id == model.id)
            {
                *current = model;
            } else {
                existing.models.push(model);
            }
        }
    } else {
        catalog.providers.push(record);
    }
}
fn is_chatgpt(value: &ycoding_schema::credential::Value) -> bool {
    matches!(value,ycoding_schema::credential::Value::OAuth(value) if matches!(value.method_id.as_lossless().as_str(),Some("chatgpt-browser"|"chatgpt-headless")))
}
pub fn eligible(id: &str) -> bool {
    if matches!(
        id,
        "gpt-5.5" | "gpt-5.3-codex-spark" | "gpt-5.4" | "gpt-5.4-mini"
    ) {
        return true;
    }
    if matches!(id, "gpt-5.5-pro" | "gpt-5.6") {
        return false;
    }
    let Some(version) = id.strip_prefix("gpt-") else {
        return false;
    };
    let mut version = version.split('.');
    let major = version
        .next()
        .unwrap_or("")
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse::<u64>()
        .unwrap_or(0);
    let minor = version
        .next()
        .unwrap_or("")
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse::<u64>()
        .unwrap_or(0);
    major > 5 || major == 5 && minor > 4
}
async fn json(response: reqwest::Response) -> Result<JsonValue, models_dev::Error> {
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
