use super::{
    Cache, Error, empty, normalize_codex, normalize_cursor, normalize_openrouter,
    normalize_organization, normalize_zai,
};
use crate::resources::catalog::{
    field,
    models_dev::{date_millis, text},
};
use crate::resources::credential::Info;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use ycoding_schema::{
    JsonValue, LosslessString, credential, provider,
    provider_usage::{Observation, Snapshot},
};

#[derive(Clone, Default)]
pub struct Endpoints(pub BTreeMap<String, String>);
impl Endpoints {
    pub fn provider() -> Self {
        Self(BTreeMap::from([
            ("openrouter".into(), "https://openrouter.ai/api/v1".into()),
            ("anthropic".into(), "https://api.anthropic.com".into()),
            ("openai".into(), "https://api.openai.com/v1".into()),
            ("codex".into(), "https://chatgpt.com/backend-api".into()),
            ("meta".into(), "https://api.llama.com/v1".into()),
            ("zai".into(), "https://api.z.ai".into()),
            ("zai-coding-plan".into(), "https://api.z.ai".into()),
            (
                "cursor".into(),
                "https://api2.cursor.sh/aiserver.v1.DashboardService".into(),
            ),
        ]))
    }
}
#[derive(Clone)]
pub struct Service {
    credentials: crate::resources::credential::Service,
    cache: Cache,
    client: reqwest::Client,
    endpoints: Endpoints,
    observations: Arc<Mutex<Observations>>,
    user_agent: String,
    app_server: Option<super::AppServerCommand>,
    store: Option<ycoding_store::Client>,
    auxiliary_errors: Arc<Mutex<BTreeMap<&'static str, Error>>>,
    preparation: crate::resources::auth::Preparation,
    claude: Option<crate::resources::auth::claude::Store>,
}
type Observations = BTreeMap<(provider::Id, Option<LosslessString>), Snapshot>;
impl Service {
    pub fn new(
        credentials: crate::resources::credential::Service,
        endpoints: Endpoints,
    ) -> Result<Self, Error> {
        Ok(Self {
            credentials,
            cache: Cache::new(),
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|_| Error::Request(None))?,
            endpoints,
            observations: Arc::new(Mutex::new(BTreeMap::new())),
            user_agent: "ycoding".into(),
            app_server: None,
            store: None,
            auxiliary_errors: Arc::new(Mutex::new(BTreeMap::new())),
            preparation: Default::default(),
            claude: None,
        })
    }
    pub fn with_version(mut self, version: &str) -> Self {
        self.user_agent = format!("ycoding/{version}");
        self
    }
    pub fn with_auth(
        mut self,
        preparation: crate::resources::auth::Preparation,
        claude: Option<crate::resources::auth::claude::Store>,
    ) -> Self {
        self.preparation = preparation;
        self.claude = claude;
        self
    }
    pub fn with_store(mut self, store: ycoding_store::Client) -> Self {
        self.store = Some(store);
        self
    }
    pub fn with_configuration(
        mut self,
        configuration: &crate::resources::config::Configuration,
    ) -> Result<Self, Error> {
        self.app_server = configuration
            .latest("provider_usage")
            .and_then(|value| field(value, "codex_app_server"))
            .map(|value| {
                let command = field(value, "command")
                    .and_then(text)
                    .ok_or(Error::InvalidResponse)?
                    .into();
                let args = match field(value, "args") {
                    None => vec![],
                    Some(JsonValue::Array(args)) => args
                        .iter()
                        .map(|value| text(value).map(str::to_owned).ok_or(Error::InvalidResponse))
                        .collect::<Result<_, _>>()?,
                    _ => return Err(Error::InvalidResponse),
                };
                let timeout_ms = match field(value, "timeoutMs") {
                    None => None,
                    Some(JsonValue::Number(value)) => Some(*value),
                    _ => return Err(Error::InvalidResponse),
                };
                let cwd = field(value, "cwd")
                    .map(|value| {
                        text(value)
                            .map(std::path::PathBuf::from)
                            .ok_or(Error::InvalidResponse)
                    })
                    .transpose()?;
                Ok(super::AppServerCommand {
                    command,
                    args,
                    timeout_ms,
                    cwd,
                })
            })
            .transpose()?;
        Ok(self)
    }
    pub fn auxiliary_errors(&self) -> Result<BTreeMap<&'static str, Error>, Error> {
        Ok(self
            .auxiliary_errors
            .lock()
            .map_err(|_| Error::Worker)?
            .clone())
    }
    pub async fn get(
        &self,
        provider: provider::Id,
        credential_id: Option<&LosslessString>,
        refresh: bool,
        now: i64,
    ) -> Snapshot {
        let label = label(&provider);
        let saved = match self.credentials.list(&provider.0) {
            Ok(saved) => saved,
            Err(_) => {
                return unavailable(
                    provider,
                    &label,
                    now,
                    "error",
                    "Provider usage refresh failed",
                );
            }
        };
        let selected = credential_id
            .and_then(|id| saved.iter().find(|c| c.id() == id))
            .or_else(|| {
                if credential_id.is_none() {
                    saved.iter().find(|c| c.active()).or_else(|| saved.first())
                } else {
                    None
                }
            });
        let profile_source = selected.and_then(|selected| {
            if provider.0 == "muse".into() {
                return Some(super::super::account_identity(selected));
            }
            let value = selected.secret().domain().ok()?;
            match value {
                credential::Value::OAuth(oauth)
                    if oauth.metadata.as_ref().is_some_and(|m| {
                        m.get(&"managed".into()) == Some(&JsonValue::Bool(true))
                            && m.get(&"source".into())
                                .is_some_and(|v| matches!(v, JsonValue::String(_)))
                    }) =>
                {
                    Some(super::super::account_identity(selected))
                }
                _ => None,
            }
        });
        if provider.0 == "muse".into() {
            if credential_id.is_some() && selected.is_none() {
                return unavailable(
                    provider,
                    &label,
                    now,
                    "unsupported",
                    "No supported credential is configured",
                );
            }
            let observation = ycoding_ai::muse::Runtime::shared().ok().and_then(|r| {
                r.observation(profile_source.as_ref().and_then(LosslessString::as_str))
            });
            if let Some(observation) = observation {
                let _ = self.observe(observation, profile_source.clone());
            }
            if let Ok(observations) = self.observations.lock()
                && let Some(observed) =
                    observations.get(&(provider.clone(), profile_source.clone()))
            {
                let mut observed = observed.clone();
                if saved.len() > 1 {
                    observed.profile = selected.map(|c| c.label().clone());
                }
                return observed;
            }
            let mut snapshot = ycoding_ai::muse::unreported(now);
            if saved.len() > 1 {
                snapshot.profile = selected.map(|c| c.label().clone());
            }
            return snapshot;
        }
        if !refresh
            && (profile_source.is_some() || credential_id.is_none())
            && let Ok(observations) = self.observations.lock()
            && let Some(observed) = observations.get(&(provider.clone(), profile_source.clone()))
        {
            if profile_source.is_some()
                && let Some(selected) = selected
            {
                let current = self
                    .credentials
                    .get(selected.id())
                    .ok()
                    .flatten()
                    .filter(|c| c.account_generation() == selected.account_generation());
                let Some(current) = current else {
                    return unavailable(
                        provider,
                        &label,
                        now,
                        "unsupported",
                        "Provider usage account changed during refresh",
                    );
                };
                let mut observed = observed.clone();
                if saved.len() > 1 {
                    observed.profile = Some(current.label().clone());
                }
                return observed;
            }
            return observed.clone();
        }
        if !self
            .endpoints
            .0
            .contains_key(provider.0.as_str().unwrap_or(""))
        {
            return unavailable(
                provider,
                &label,
                now,
                "unsupported",
                "Provider usage is unsupported",
            );
        }
        let Some(selected) = selected else {
            if credential_id.is_none()
                && let Ok(observations) = self.observations.lock()
                && let Some(observed) = observations.get(&(provider.clone(), None))
            {
                return observed.clone();
            }
            return unavailable(
                provider,
                &label,
                now,
                "unsupported",
                "No supported credential is configured",
            );
        };
        let key = format!(
            "{:?}:{:?}:{}:{}",
            provider,
            selected.id(),
            selected.account_generation(),
            selected.generation()
        );
        let selected = selected.clone();
        let input = selected.clone();
        let service = self.clone();
        let provider_copy = provider.clone();
        let label_copy = label.clone();
        let result = self
            .cache
            .get(
                key,
                now,
                if provider.0 == "anthropic".into() {
                    300_000
                } else {
                    60_000
                },
                refresh,
                move || async move { service.load(provider_copy, &label_copy, input, now).await },
            )
            .await;
        let mut snapshot = match result {
            Ok(snapshot) => snapshot,
            Err(
                Error::Request(Some(401 | 403))
                | Error::RequestWithRetry {
                    status: 401 | 403, ..
                },
            ) => unavailable(
                provider.clone(),
                &label,
                now,
                "unauthorized",
                "Provider usage credentials are unauthorized",
            ),
            Err(Error::Request(Some(404)) | Error::RequestWithRetry { status: 404, .. }) => {
                unavailable(
                    provider.clone(),
                    &label,
                    now,
                    "unsupported",
                    "Provider usage refresh failed",
                )
            }
            Err(_) => unavailable(
                provider.clone(),
                &label,
                now,
                "error",
                "Provider usage refresh failed",
            ),
        };
        if provider.0 == "anthropic".into() || provider.0 == "openai".into() && selected.secret().domain().is_ok_and(|value| matches!(value,credential::Value::OAuth(oauth) if ["chatgpt-browser","chatgpt-headless"].iter().any(|method| oauth.method_id.as_lossless() == &(*method).into()))) { snapshot.source = "provider_internal_api".into(); snapshot.stability = "best_effort".into(); }
        let current = self.credentials.list(&provider.0);
        let current = match current {
            Ok(current) => current,
            Err(_) => {
                return unavailable(
                    provider,
                    &label,
                    now,
                    "error",
                    "Provider usage refresh failed",
                );
            }
        };
        let Some(credential) = current.iter().find(|c| {
            c.id() == selected.id() && c.account_generation() == selected.account_generation()
        }) else {
            return unavailable(
                provider,
                &label,
                now,
                "unsupported",
                "Provider usage account changed during refresh",
            );
        };
        if current.len() > 1 {
            snapshot.profile = Some(credential.label().clone());
        }
        if (profile_source.is_some() || credential_id.is_none())
            && let Ok(observations) = self.observations.lock()
            && let Some(observed) = observations.get(&(provider, profile_source.clone()))
            && (observed.updated_at >= snapshot.updated_at
                || (snapshot.status == "unsupported".into() && snapshot.windows.is_empty()))
        {
            if profile_source.is_some() {
                let mut observed = observed.clone();
                if current.len() > 1 {
                    observed.profile = Some(credential.label().clone());
                }
                return observed;
            }
            return observed.clone();
        }
        snapshot
    }
    pub async fn list(&self, providers: &[provider::Id], refresh: bool, now: i64) -> Vec<Snapshot> {
        let available = providers.iter().cloned().collect::<BTreeSet<_>>();
        let mut targets = Vec::new();
        let mut providers = providers.to_vec();
        providers.sort();
        providers.dedup();
        for provider in providers {
            let saved = match self.credentials.list(&provider.0) {
                Ok(saved) => saved,
                Err(_) => {
                    targets.push((provider, None));
                    continue;
                }
            };
            if (provider.0.as_str() == Some("muse")
                || self
                    .endpoints
                    .0
                    .contains_key(provider.0.as_str().unwrap_or("")))
                && saved.len() > 1
            {
                let mut saved = saved;
                saved.sort_by(|a, b| a.label().cmp(b.label()));
                targets.extend(
                    saved
                        .into_iter()
                        .map(|c| (provider.clone(), Some(c.id().clone()))),
                );
                continue;
            }
            targets.push((provider, None));
        }
        let mut snapshots = Vec::new();
        for chunk in targets.chunks(4) {
            let mut workers = tokio::task::JoinSet::new();
            for (index, (provider, credential)) in chunk.iter().enumerate() {
                let service = self.clone();
                let provider = provider.clone();
                let credential = credential.clone();
                workers.spawn(async move {
                    (
                        index,
                        service
                            .get(provider, credential.as_ref(), refresh, now)
                            .await,
                    )
                });
            }
            let mut results = Vec::new();
            while let Some(result) = workers.join_next().await {
                match result {
                    Ok(result) => results.push(result),
                    Err(_) => continue,
                }
            }
            for (index, (provider, _)) in chunk.iter().enumerate() {
                if !results.iter().any(|(existing, _)| *existing == index) {
                    results.push((
                        index,
                        unavailable(
                            provider.clone(),
                            &label(provider),
                            now,
                            "error",
                            "Provider usage worker failed",
                        ),
                    ));
                }
            }
            results.sort_by_key(|(index, _)| *index);
            snapshots.extend(results.into_iter().map(|(_, snapshot)| snapshot));
        }
        if let Ok(observations) = self.observations.lock() {
            snapshots.extend(
                observations
                    .iter()
                    .filter(|((provider, source), _)| {
                        source.is_none()
                            && available.contains(provider)
                            && self
                                .credentials
                                .list(&provider.0)
                                .is_ok_and(|saved| saved.len() > 1)
                    })
                    .map(|(_, snapshot)| snapshot.clone()),
            );
        }
        if let Some(command) = &self.app_server {
            let command = command.clone();
            let result = self
                .cache
                .get(
                    "openai:codex-app-server".into(),
                    now,
                    60000,
                    refresh,
                    move || async move {
                        let mut snapshot = super::load_app_server(
                            &command,
                            provider::Id("openai".into()),
                            "Codex",
                            now,
                        )
                        .await?;
                        snapshot.profile = Some("Codex app-server".into());
                        Ok(snapshot)
                    },
                )
                .await;
            match result {
                Ok(snapshot) => {
                    if available.contains(&snapshot.provider_id) {
                        snapshots.push(snapshot);
                    }
                    if let Ok(mut errors) = self.auxiliary_errors.lock() {
                        errors.remove("codex-app-server");
                    }
                }
                Err(error) => {
                    if let Ok(mut errors) = self.auxiliary_errors.lock() {
                        errors.insert("codex-app-server", error);
                    }
                }
            }
        }
        if let Some(store) = &self.store {
            let store = store.clone();
            let local =
                tokio::task::spawn_blocking(move || super::local_spend_from_store(&store, now))
                    .await
                    .unwrap_or(Err(Error::Worker));
            match local {
                Ok(local) => {
                    snapshots.extend(
                        local
                            .into_iter()
                            .filter(|s| available.contains(&s.provider_id)),
                    );
                    if let Ok(mut errors) = self.auxiliary_errors.lock() {
                        errors.remove("local-spend");
                    }
                }
                Err(error) => {
                    if let Ok(mut errors) = self.auxiliary_errors.lock() {
                        errors.insert("local-spend", error);
                    }
                }
            }
        }
        snapshots
    }
    pub fn observe(
        &self,
        observation: Observation,
        profile_source: Option<LosslessString>,
    ) -> Result<(), Error> {
        let key = (observation.provider_id.clone(), profile_source);
        let mut observations = self.observations.lock().map_err(|_| Error::Worker)?;
        if observations
            .get(&key)
            .is_some_and(|s| s.updated_at > observation.observed_at)
        {
            return Ok(());
        }
        observations.insert(
            key,
            Snapshot {
                provider_id: observation.provider_id,
                label: observation.label,
                profile: None,
                status: "available".into(),
                source: observation.source,
                stability: observation.stability,
                updated_at: observation.observed_at,
                windows: observation.windows,
                message: None,
            },
        );
        Ok(())
    }
    pub async fn shutdown(&self) -> Result<(), Error> {
        self.cache.shutdown().await
    }
    async fn load(
        &self,
        provider: provider::Id,
        label: &str,
        credential: Info,
        now: i64,
    ) -> Result<Snapshot, Error> {
        let prepared = self
            .preparation
            .prepare_value(
                &self.credentials,
                credential.clone(),
                now,
                self.claude.as_ref(),
            )
            .await
            .map_err(|_| Error::Request(Some(401)))?;
        let value = prepared.domain().map_err(|_| Error::InvalidResponse)?;
        let key = match &value {
            credential::Value::Key(key) => key.key.to_utf8().map_err(|_| Error::InvalidResponse)?,
            credential::Value::OAuth(oauth) => {
                oauth.access.to_utf8().map_err(|_| Error::InvalidResponse)?
            }
        };
        let base = self
            .endpoints
            .0
            .get(provider.0.as_str().ok_or(Error::InvalidResponse)?)
            .ok_or(Error::InvalidResponse)?;
        match provider.0.as_str() {
            Some("anthropic") => {
                let stored = credential
                    .secret()
                    .domain()
                    .map_err(|_| Error::InvalidResponse)?;
                let source = crate::resources::auth::claude::credential_source(&stored);
                let Some(source) = source else {
                    let mut snapshot = unavailable(
                        provider,
                        "Claude",
                        now,
                        "unsupported",
                        "Claude subscription usage requires a Claude Code OAuth account",
                    );
                    snapshot.source = "provider_internal_api".into();
                    snapshot.stability = "best_effort".into();
                    return Ok(snapshot);
                };
                let store = self.claude.as_ref().ok_or(Error::Request(Some(401)))?;
                let current = store
                    .resolve(source, now, false)
                    .await
                    .map_err(|_| Error::Request(Some(401)))?
                    .ok_or(Error::Request(Some(401)))?;
                let request = |access: &str| {
                    self.client
                        .get(format!("{base}/api/oauth/usage"))
                        .bearer_auth(access)
                        .header("anthropic-beta", "oauth-2025-04-20")
                };
                let first = self.response(request(&current.access_token)).await;
                let (response, subscription) = if matches!(
                    first,
                    Err(Error::Request(Some(401)) | Error::RequestWithRetry { status: 401, .. })
                ) {
                    match store.resolve(source, now, true).await {
                        Ok(Some(rotated)) if rotated.access_token != current.access_token => {
                            self.credentials
                                .current_account(&credential)
                                .map_err(|_| Error::InvalidResponse)?;
                            (
                                self.response(request(&rotated.access_token)).await,
                                rotated.subscription_type,
                            )
                        }
                        _ => (first, current.subscription_type),
                    }
                } else {
                    (first, current.subscription_type)
                };
                self.credentials
                    .current_account(&credential)
                    .map_err(|_| Error::InvalidResponse)?;
                let label = match subscription
                    .as_deref()
                    .map(str::trim)
                    .map(str::to_ascii_lowercase)
                    .as_deref()
                {
                    Some("pro") => "Claude Pro",
                    Some("max") => "Claude Max",
                    _ => "Claude",
                };
                super::normalize_claude(provider, label, now, &response?)
            }
            Some("openai") => {
                if let credential::Value::OAuth(oauth) = &value {
                    if ["chatgpt-browser", "chatgpt-headless"]
                        .iter()
                        .any(|method| oauth.method_id.as_lossless() == &(*method).into())
                    {
                        let base = self
                            .endpoints
                            .0
                            .get("codex")
                            .ok_or(Error::InvalidResponse)?;
                        let mut request = self
                            .client
                            .get(format!("{base}/wham/usage"))
                            .bearer_auth(&key);
                        if let Some(account) = oauth
                            .metadata
                            .as_ref()
                            .and_then(|m| m.get(&"accountID".into()))
                            .and_then(text)
                        {
                            request = request.header("ChatGPT-Account-ID", account);
                        }
                        return normalize_codex(
                            provider,
                            "Codex",
                            now,
                            &self.response(request).await?,
                            "provider_internal_api",
                            "best_effort",
                        );
                    }
                    return Err(Error::InvalidResponse);
                }
                let credential::Value::Key(key_value) = &value else {
                    return Err(Error::InvalidResponse);
                };
                if !key_value.metadata.as_ref().is_some_and(|m| {
                    ["usageAdmin", "usage_admin"]
                        .iter()
                        .any(|key| m.get(&(*key).into()) == Some(&JsonValue::Bool(true)))
                }) {
                    return Ok(unavailable(
                        provider,
                        label,
                        now,
                        "unauthorized",
                        "Organization usage requires an explicitly configured admin credential",
                    ));
                }
                let (week, month) = utc_starts(now);
                let query = format!(
                    "start_time={}&end_time={}&bucket_width=1d&limit=31",
                    week.min(month),
                    now.div_euclid(1000)
                );
                let usage = self
                    .pages(
                        format!("{base}/organization/usage/completions?{query}"),
                        &key,
                    )
                    .await?;
                let costs = self
                    .pages(format!("{base}/organization/costs?{query}"), &key)
                    .await?;
                normalize_organization(
                    provider,
                    label,
                    now,
                    (week as f64, month as f64),
                    &usage,
                    &costs,
                    false,
                )
            }
            Some("meta") => {
                if !matches!(value, credential::Value::Key(_)) {
                    return Err(Error::InvalidResponse);
                }
                let (week, month) = utc_starts(now);
                let query = format!(
                    "start_time={}&end_time={}&bucket_width=1d&limit=31",
                    week.min(month),
                    now.div_euclid(1000)
                );
                let usage = self
                    .pages(
                        format!("{base}/organization/usage/completions?{query}"),
                        &key,
                    )
                    .await?;
                let costs = self
                    .pages(format!("{base}/organization/costs?{query}"), &key)
                    .await?;
                normalize_organization(
                    provider,
                    label,
                    now,
                    (week as f64, month as f64),
                    &usage,
                    &costs,
                    true,
                )
            }
            Some("zai" | "zai-coding-plan") => {
                if !matches!(value, credential::Value::Key(_)) {
                    return Err(Error::InvalidResponse);
                }
                let quota = self
                    .request(format!("{base}/api/monitor/usage/quota/limit"), &key, false)
                    .await?;
                if field(&quota, "success") == Some(&JsonValue::Bool(false))
                    && field(&quota, "msg")
                        .and_then(text)
                        .is_some_and(|s| s.to_lowercase().contains("coding plan"))
                {
                    let mut snapshot = unavailable(
                        provider,
                        "Z.ai",
                        now,
                        "unsupported",
                        "No active GLM Coding Plan",
                    );
                    snapshot.source = "provider_internal_api".into();
                    snapshot.stability = "best_effort".into();
                    return Ok(snapshot);
                }
                let plan = self
                    .request(format!("{base}/api/biz/subscription/list"), &key, false)
                    .await
                    .ok();
                normalize_zai(provider, "Z.ai", now, &quota, plan.as_ref())
            }
            Some("openrouter") => {
                if !matches!(value, credential::Value::Key(_)) {
                    return Err(Error::InvalidResponse);
                }
                let response = self.request(format!("{base}/key"), &key, false).await;
                let initial = match &response {
                    Ok(response) => {
                        normalize_openrouter(provider.clone(), label, now, response, None)?
                    }
                    Err(
                        Error::Request(Some(401 | 403))
                        | Error::RequestWithRetry {
                            status: 401 | 403, ..
                        },
                    ) => empty(provider.clone(), label, now, "provider_api", "stable"),
                    Err(error) => return Err(*error),
                };
                match self.request(format!("{base}/credits"), &key, false).await {
                    Ok(credits) => {
                        let payload = response.as_ref().ok().cloned().unwrap_or_else(|| {
                            ycoding_schema::parse_json(r#"{"data":{}}"#).expect("static JSON")
                        });
                        match normalize_openrouter(provider, label, now, &payload, Some(&credits)) {
                            Ok(snapshot) => Ok(snapshot),
                            Err(_) if response.is_ok() => Ok(initial),
                            Err(error) => Err(error),
                        }
                    }
                    Err(_) if response.is_ok() => Ok(initial),
                    Err(error) => Err(error),
                }
            }
            Some("cursor") => {
                let usage = self
                    .request(format!("{base}/GetCurrentPeriodUsage"), &key, true)
                    .await?;
                let plan = self
                    .request(format!("{base}/GetPlanInfo"), &key, true)
                    .await
                    .ok();
                normalize_cursor(provider, "Cursor", now, &usage, plan.as_ref())
            }
            _ => Err(Error::InvalidResponse),
        }
    }
    async fn request(&self, url: String, key: &str, rpc: bool) -> Result<JsonValue, Error> {
        let request = if rpc {
            self.client
                .post(url)
                .header("connect-protocol-version", "1")
                .header("Content-Type", "application/json")
                .body("{}")
        } else {
            self.client.get(url)
        };
        self.response(request.bearer_auth(key)).await
    }
    async fn response(&self, request: reqwest::RequestBuilder) -> Result<JsonValue, Error> {
        let response = request
            .header("Accept", "application/json")
            .header("User-Agent", &self.user_agent)
            .send()
            .await
            .map_err(|_| Error::Request(None))?;
        if !response.status().is_success() {
            if let Some(retry) = response
                .headers()
                .get("retry-after")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| {
                    value
                        .parse::<f64>()
                        .ok()
                        .filter(|value| value.is_finite() && *value >= 0.0)
                        .map(|value| (value * 1000.0) as u64)
                })
            {
                return Err(Error::RequestWithRetry {
                    status: response.status().as_u16(),
                    retry_after_ms: retry,
                });
            }
            return Err(Error::Request(Some(response.status().as_u16())));
        }
        ycoding_schema::parse_json(&response.text().await.map_err(|_| Error::InvalidResponse)?)
            .map_err(|_| Error::InvalidResponse)
    }
    async fn pages(&self, url: String, key: &str) -> Result<Vec<JsonValue>, Error> {
        let mut values = Vec::new();
        let mut next = None;
        loop {
            let target = next
                .as_ref()
                .map(|next: &String| {
                    format!(
                        "{url}&page={}",
                        url::form_urlencoded::byte_serialize(next.as_bytes()).collect::<String>()
                    )
                })
                .unwrap_or_else(|| url.clone());
            let response = self.request(target, key, false).await?;
            let Some(JsonValue::Array(data)) = field(&response, "data") else {
                return Err(Error::InvalidResponse);
            };
            values.extend(data.iter().cloned());
            next = if field(&response, "has_more") == Some(&JsonValue::Bool(true)) {
                field(&response, "next_page")
                    .and_then(text)
                    .map(str::to_owned)
            } else {
                None
            };
            if next.is_none() {
                return Ok(values);
            }
        }
    }
}
fn utc_starts(now: i64) -> (i64, i64) {
    let day = now.div_euclid(86400000);
    let week = day - (day + 3).rem_euclid(7);
    let z = day + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (
        week * 86400,
        date_millis(&format!("{year:04}-{month:02}-01")).unwrap_or(0.0) as i64 / 1000,
    )
}
fn unavailable(
    provider: provider::Id,
    label: &str,
    now: i64,
    status: &str,
    message: &str,
) -> Snapshot {
    let mut snapshot = empty(provider, label, now, "provider_api", "stable");
    snapshot.status = status.into();
    snapshot.message = Some(message.into());
    snapshot
}
fn label(provider: &provider::Id) -> String {
    if provider.0 == "muse".into() {
        return "Muse (Meta)".into();
    }
    if provider.0 == "anthropic".into() {
        return "Claude".into();
    }
    provider
        .0
        .as_str()
        .unwrap_or("Provider")
        .split(['-', '_'])
        .filter(|s| !s.is_empty())
        .map(|s| {
            let mut c = s.chars();
            c.next()
                .map(|c| c.to_uppercase().collect::<String>())
                .unwrap_or_default()
                + c.as_str()
        })
        .collect::<Vec<_>>()
        .join(" ")
}
