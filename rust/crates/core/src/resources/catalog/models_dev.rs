use super::{field, object, set};
use ring::rand::SecureRandom;
use std::sync::Arc;
use std::{
    fmt,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime},
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder, model, provider,
};
static ROOT: JsonPath = JsonPath(Vec::new());

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidSource,
    Storage,
    Request,
    Closed,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidSource => "Invalid models.dev catalog",
            Self::Storage => "Model catalog cache operation failed",
            Self::Request => "Model catalog refresh failed",
            Self::Closed => "Model catalog worker closed",
        })
    }
}
impl std::error::Error for Error {}
impl From<ycoding_schema::DecodeError> for Error {
    fn from(_: ycoding_schema::DecodeError) -> Self {
        Self::InvalidSource
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub info: provider::Info,
    pub models: Vec<model::Info>,
    pub environment: Vec<LosslessString>,
}

pub fn normalize(source: &JsonValue) -> Result<Vec<Snapshot>, Error> {
    let JsonValue::Object(providers) = source else {
        return Err(Error::InvalidSource);
    };
    let mut snapshots = Vec::new();
    for (_, provider) in providers.iter() {
        snapshots.push(normalize_provider(provider)?);
    }
    let real = providers.len() > 5
        || providers.get(&"openrouter".into()).is_some()
        || providers.get(&"anthropic".into()).is_some();
    if providers.get(&"deepseek".into()).is_none() && real {
        let mut source = object(&[
            ("id", "deepseek".encode()),
            ("name", "DeepSeek".encode()),
            ("env", JsonValue::Array(vec!["DEEPSEEK_API_KEY".encode()])),
            ("npm", "@ai-sdk/openai-compatible".encode()),
            ("api", "https://api.deepseek.com/v1".encode()),
            ("models", object(&[])),
        ]);
        let models = [deepseek_model(false), deepseek_model(true)];
        set(
            &mut source,
            "models",
            object(&[
                ("deepseek-v4-pro", models[0].clone()),
                ("deepseek-v4-flash", models[1].clone()),
            ]),
        );
        snapshots.push(normalize_provider(&source)?);
    }
    if let Some(snapshot) = snapshots
        .iter_mut()
        .find(|p| p.info.id.0 == "deepseek".into())
    {
        for (base, id, name, family, date, input, output, read) in [
            (
                "deepseek-v4-pro",
                "deepseek-v4-pro-0813",
                "DeepSeek V4 Pro 0813",
                "deepseek-thinking",
                "2026-08-12",
                0.435,
                0.87,
                0.003625,
            ),
            (
                "deepseek-v4-flash",
                "deepseek-v4-flash-0793",
                "DeepSeek V4 Flash 0793",
                "deepseek-flash",
                "2026-07-31",
                0.14,
                0.28,
                0.0028,
            ),
        ] {
            if snapshot.models.iter().any(|m| m.id == id.into()) {
                continue;
            }
            let Some(base) = snapshot
                .models
                .iter()
                .find(|m| m.id == base.into())
                .cloned()
            else {
                continue;
            };
            let mut model = base;
            model.id = id.into();
            model.model_id = id.into();
            model.name = name.into();
            model.family = Some(family.into());
            model.time.released =
                ycoding_schema::schema::Finite::new(date_millis(date).unwrap_or(0.0))?;
            model.cost = costs(Some(&object(&[
                ("input", input.encode()),
                ("output", output.encode()),
                ("cache_read", read.encode()),
            ])))?;
            model.variants = super::variants::variants(
                Some("@ai-sdk/openai-compatible"),
                &deepseek_model(base_id_flash(id)),
            )?;
            snapshot.models.push(model);
        }
    }
    if let Some(snapshot) = snapshots
        .iter_mut()
        .find(|p| p.info.id.0 == "openai".into())
        && !snapshot
            .models
            .iter()
            .any(|m| m.id == "gpt-daybreak-blue-latest".into())
        && let Some(mut alias) = snapshot
            .models
            .iter()
            .find(|m| m.id == "gpt-5.6-sol".into())
            .cloned()
    {
        alias.id = "gpt-daybreak-blue-latest".into();
        alias.model_id = alias.id.clone();
        alias.name = "Daybreak Blue".into();
        snapshot.models.push(alias);
    }
    Ok(snapshots)
}
fn base_id_flash(id: &str) -> bool {
    id.contains("flash")
}
fn deepseek_model(flash: bool) -> JsonValue {
    let mut value = ycoding_schema::parse_json(r#"{"id":"deepseek-v4-pro","name":"DeepSeek V4 Pro","family":"deepseek-thinking","release_date":"2026-08-12","attachment":false,"reasoning":true,"reasoning_options":[{"type":"toggle"},{"type":"effort","values":["high","max"]}],"tool_call":true,"interleaved":{"field":"reasoning_content"},"temperature":true,"limit":{"context":1000000,"output":384000},"modalities":{"input":["text"],"output":["text"]},"cost":{"input":0.435,"output":0.87,"cache_read":0.003625}}"#).expect("static source");
    if flash {
        for (key, text) in [
            ("id", "deepseek-v4-flash"),
            ("name", "DeepSeek V4 Flash"),
            ("family", "deepseek-flash"),
            ("release_date", "2026-07-31"),
        ] {
            set(&mut value, key, text.encode());
        }
        set(
            &mut value,
            "cost",
            object(&[
                ("input", 0.14.encode()),
                ("output", 0.28.encode()),
                ("cache_read", 0.0028.encode()),
            ]),
        );
    }
    value
}
fn normalize_provider(value: &JsonValue) -> Result<Snapshot, Error> {
    let o = ObjectDecoder::new(value, &ROOT)?;
    let id: provider::Id = o.field("id")?;
    let name: LosslessString = o.field("name")?;
    let environment: Vec<LosslessString> = o.field("env")?;
    let npm: Option<LosslessString> = o.optional("npm")?;
    let api: Option<LosslessString> = o.optional("api")?;
    let package = npm
        .as_ref()
        .filter(|s| !s.is_empty())
        .map(|s| concat(&"aisdk:".into(), &[], s).encode())
        .unwrap_or_else(|| "".encode());
    let mut info = object(&[
        ("id", id.encode()),
        ("name", name.encode()),
        ("package", package),
    ]);
    if let Some(api) = api {
        set(&mut info, "settings", object(&[("baseURL", api.encode())]));
    }
    let models: ycoding_schema::JsonObject = o.field("models")?;
    let mut normalized = Vec::new();
    for (_, source) in models.iter() {
        validate_model(source)?;
        let id_value: LosslessString = ObjectDecoder::new(source, &ROOT)?.field("id")?;
        let npm = field(source, "provider")
            .and_then(|p| field(p, "npm"))
            .and_then(text)
            .or_else(|| npm.as_ref().and_then(LosslessString::as_str));
        let variants = super::variants::variants(npm, source)?;
        let base = model_info(id.clone(), id_value.clone(), source, npm, &variants, None)?;
        if let Some(JsonValue::Object(modes)) =
            field(source, "experimental").and_then(|v| field(v, "modes"))
        {
            for (mode, options) in modes.iter() {
                let mut model = model_info(
                    id.clone(),
                    concat(&id_value, &[45], mode),
                    source,
                    npm,
                    &variants,
                    field(options, "provider"),
                )?;
                model.name = concat(&base.name, &[32], &capitalize(mode));
                if let Some(override_cost) = field(options, "cost") {
                    let mut costs = base.cost.clone();
                    for cost in costs_for(override_cost)? {
                        if let Some(current) = costs.iter_mut().find(|c| c.tier == cost.tier) {
                            *current = cost;
                        } else {
                            costs.push(cost);
                        }
                    }
                    model.cost = costs;
                }
                normalized.push(model);
            }
        }
        normalized.push(base);
        let index = normalized.len() - 1;
        let count = field(source, "experimental")
            .and_then(|v| field(v, "modes"))
            .and_then(|v| match v {
                JsonValue::Object(v) => Some(v.len()),
                _ => None,
            })
            .unwrap_or(0);
        if count > 0 {
            let base = normalized.remove(index);
            normalized.insert(index - count, base);
        }
    }
    Ok(Snapshot {
        info: provider::Info::decode(&info)?,
        models: normalized,
        environment,
    })
}
fn validate_model(value: &JsonValue) -> Result<(), Error> {
    let o = ObjectDecoder::new(value, &ROOT)?;
    o.field::<LosslessString>("id")?;
    o.field::<LosslessString>("name")?;
    o.field::<LosslessString>("release_date")?;
    o.field::<bool>("attachment")?;
    o.field::<bool>("reasoning")?;
    o.field::<bool>("tool_call")?;
    o.optional::<bool>("temperature")?;
    o.optional::<LosslessString>("family")?;
    if let Some(value) = field(value, "status")
        && !["alpha", "beta", "deprecated"]
            .iter()
            .any(|s| text(value) == Some(s))
    {
        return Err(Error::InvalidSource);
    }
    let limit: JsonValue = o.field("limit")?;
    let limit = ObjectDecoder::new(&limit, &ROOT)?;
    limit.field::<f64>("context")?;
    limit.field::<f64>("output")?;
    limit.optional::<f64>("input")?;
    if let Some(modalities) = field(value, "modalities") {
        let modalities = ObjectDecoder::new(modalities, &ROOT)?;
        for key in ["input", "output"] {
            for modality in modalities.field::<Vec<LosslessString>>(key)? {
                if !["text", "audio", "image", "video", "pdf"]
                    .iter()
                    .any(|s| modality == (*s).into())
                {
                    return Err(Error::InvalidSource);
                }
            }
        }
    }
    if let Some(JsonValue::Array(options)) = field(value, "reasoning_options") {
        for option in options {
            let o = ObjectDecoder::new(option, &ROOT)?;
            match o.field::<LosslessString>("type")?.as_str() {
                Some("toggle") => {}
                Some("effort") => {
                    let values: Vec<JsonValue> = o.field("values")?;
                    if values
                        .iter()
                        .any(|v| !matches!(v, JsonValue::String(_) | JsonValue::Null))
                    {
                        return Err(Error::InvalidSource);
                    }
                }
                Some("budget_tokens") => {
                    o.optional::<f64>("min")?;
                    o.optional::<f64>("max")?;
                }
                _ => return Err(Error::InvalidSource),
            }
        }
    } else if field(value, "reasoning_options").is_some() {
        return Err(Error::InvalidSource);
    }
    Ok(())
}
fn model_info(
    provider: provider::Id,
    id: LosslessString,
    source: &JsonValue,
    npm: Option<&str>,
    variants: &[model::Variant],
    request: Option<&JsonValue>,
) -> Result<model::Info, Error> {
    let o = ObjectDecoder::new(source, &ROOT)?;
    let source_id: LosslessString = o.field("id")?;
    let mut model = super::empty_model(provider, id)?;
    model.model_id = source_id;
    model.name = o.field("name")?;
    model.family = o
        .optional::<LosslessString>("family")?
        .filter(|s| !s.is_empty());
    model.limit = model::Limit::decode(field(source, "limit").ok_or(Error::InvalidSource)?)?;
    model.status = o.optional("status")?.unwrap_or_else(|| "active".into());
    model.time.released = ycoding_schema::schema::Finite::new(
        o.field::<LosslessString>("release_date")?
            .as_str()
            .and_then(date_millis)
            .unwrap_or(0.0),
    )?;
    model.cost = costs(field(source, "cost"))?;
    model.variants = variants.to_vec();
    model.capabilities.tools = o.field("tool_call")?;
    if let Some(modalities) = field(source, "modalities") {
        let o = ObjectDecoder::new(modalities, &ROOT)?;
        model.capabilities.input = o.field("input")?;
        model.capabilities.output = o.field("output")?;
    }
    if let Some(provider) = field(source, "provider") {
        let o = ObjectDecoder::new(provider, &ROOT)?;
        if let Some(npm) = o
            .optional::<LosslessString>("npm")?
            .filter(|s| !s.is_empty())
        {
            model.package = Some(concat(&"aisdk:".into(), &[], &npm));
        }
        if let Some(api) = o.optional::<LosslessString>("api")?
            && !api.is_empty()
        {
            model.settings = Some(provider::Settings::decode(&object(&[(
                "baseURL",
                api.encode(),
            )]))?);
        }
    }
    if npm == Some("@ai-sdk/openai") && o.field::<bool>("reasoning")? {
        model.settings = super::merge_settings(
            model.settings.as_ref(),
            Some(&provider::Settings::decode(&object(&[(
                "include",
                JsonValue::Array(vec!["reasoning.encrypted_content".encode()]),
            )]))?),
        );
    }
    if let Some(request) = request {
        let o = ObjectDecoder::new(request, &ROOT)?;
        model.headers = o.optional("headers")?;
        model.body = o.optional("body")?;
    }
    Ok(model)
}
fn costs(source: Option<&JsonValue>) -> Result<Vec<model::Cost>, Error> {
    match source {
        Some(source) => costs_for(source),
        None => Ok(vec![]),
    }
}
fn costs_for(source: &JsonValue) -> Result<Vec<model::Cost>, Error> {
    let mut result = vec![one_cost(source, None)?];
    let o = ObjectDecoder::new(source, &ROOT)?;
    let tiers: Option<Vec<JsonValue>> = o.optional("tiers")?;
    for tier in tiers.as_deref().unwrap_or(&[]) {
        result.push(one_cost(tier, field(tier, "tier"))?);
    }
    if tiers.as_ref().is_none_or(Vec::is_empty)
        && let Some(cost) = field(source, "context_over_200k")
    {
        result.push(one_cost(
            cost,
            Some(&object(&[
                ("type", "context".encode()),
                ("size", 200000.0.encode()),
            ])),
        )?);
    }
    Ok(result)
}
fn one_cost(source: &JsonValue, tier: Option<&JsonValue>) -> Result<model::Cost, Error> {
    let o = ObjectDecoder::new(source, &ROOT)?;
    Ok(model::Cost {
        tier: tier.map(model::Tier::decode).transpose()?,
        input: o.field("input")?,
        output: o.field("output")?,
        cache: model::CacheCost {
            read: o
                .optional("cache_read")?
                .unwrap_or_else(ycoding_schema::money::UsdPerMillionTokens::zero),
            write: o
                .optional("cache_write")?
                .unwrap_or_else(ycoding_schema::money::UsdPerMillionTokens::zero),
        },
    })
}
pub(crate) fn text(v: &JsonValue) -> Option<&str> {
    match v {
        JsonValue::String(s) => s.as_str(),
        _ => None,
    }
}
fn concat(a: &LosslessString, separator: &[u16], b: &LosslessString) -> LosslessString {
    LosslessString::from_utf16(
        a.code_units()
            .chain(separator.iter().copied())
            .chain(b.code_units())
            .collect(),
    )
}
fn capitalize(value: &LosslessString) -> LosslessString {
    let mut units = value.code_units();
    let Some(first) = units.next() else {
        return value.clone();
    };
    let prefix = char::from_u32(first as u32)
        .map(|c| c.to_uppercase().collect::<String>())
        .map(|s| s.encode_utf16().collect::<Vec<_>>())
        .unwrap_or(vec![first]);
    LosslessString::from_utf16(prefix.into_iter().chain(units).collect())
}

pub(crate) fn date_millis(date: &str) -> Option<f64> {
    super::date::parse(date)
}
pub(crate) fn utc_calendar(millis: i64) -> (i64, i64, i64) {
    let z = millis.div_euclid(86400000) + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    (year + i64::from(month <= 2), month, day)
}

#[derive(Clone)]
pub struct Options {
    pub source: String,
    pub cache: PathBuf,
    pub file: Option<PathBuf>,
    pub bundled: Option<JsonValue>,
    pub fetch: bool,
    pub user_agent: String,
}
pub struct Service {
    options: Options,
    client: reqwest::Client,
    snapshot: tokio::sync::Mutex<Option<Vec<Snapshot>>>,
    load: tokio::sync::Mutex<()>,
    refreshed: tokio::sync::watch::Sender<u64>,
    cleanup_error: tokio::sync::watch::Sender<Option<Error>>,
}
impl Service {
    pub fn new(options: Options) -> Result<Self, Error> {
        Ok(Self {
            options,
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| Error::Request)?,
            snapshot: tokio::sync::Mutex::new(None),
            load: tokio::sync::Mutex::new(()),
            refreshed: tokio::sync::watch::channel(0).0,
            cleanup_error: tokio::sync::watch::channel(None).0,
        })
    }
    pub async fn get(&self) -> Result<Vec<Snapshot>, Error> {
        let _load = self.load.lock().await;
        if let Some(snapshot) = self.snapshot.lock().await.as_ref() {
            return Ok(snapshot.clone());
        }
        let path = self.options.file.as_ref().unwrap_or(&self.options.cache);
        let disk = match tokio::fs::read_to_string(path).await {
            Ok(text) => ycoding_schema::parse_json(&text)
                .ok()
                .and_then(|v| normalize(&v).ok()),
            Err(_) => None,
        };
        if disk.is_none() && self.options.file.is_none() {
            let error = match tokio::fs::remove_file(path).await {
                Ok(()) => None,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(_) => Some(Error::Storage),
            };
            self.cleanup_error.send_replace(error);
        }
        let loaded = if let Some(disk) = disk {
            disk
        } else if let Some(bundled) = &self.options.bundled {
            normalize(bundled)?
        } else if !self.options.fetch {
            vec![]
        } else {
            let _lock = self.cache_lock().await?;
            self.fetch_and_write().await?
        };
        *self.snapshot.lock().await = Some(loaded.clone());
        Ok(loaded)
    }
    pub async fn refresh(&self, force: bool) -> Result<bool, Error> {
        if !force && self.fresh().await {
            return Ok(false);
        }
        let _lock = self.cache_lock().await?;
        if !force && self.fresh().await {
            return Ok(false);
        }
        self.fetch_and_write().await?;
        drop(_lock);
        let _load = self.load.lock().await;
        *self.snapshot.lock().await = None;
        self.refreshed
            .send_modify(|generation| *generation = generation.saturating_add(1));
        Ok(true)
    }
    pub fn refreshed(&self) -> tokio::sync::watch::Receiver<u64> {
        self.refreshed.subscribe()
    }
    pub fn cleanup_error(&self) -> Option<Error> {
        *self.cleanup_error.borrow()
    }
    pub fn start(self: &Arc<Self>) -> Option<RefreshWorker> {
        if !self.options.fetch {
            return None;
        }
        let service = self.clone();
        let (sender, error) = tokio::sync::watch::channel(None);
        let handle = tokio::spawn(async move {
            loop {
                let result = service.refresh(false).await;
                sender.send_replace(result.err());
                tokio::time::sleep(Duration::from_secs(3600)).await;
            }
        });
        Some(RefreshWorker {
            handle: Some(handle),
            error,
        })
    }
    async fn fresh(&self) -> bool {
        tokio::fs::metadata(&self.options.cache)
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|m| {
                SystemTime::now()
                    .duration_since(m)
                    .unwrap_or(Duration::ZERO)
            })
            .is_some_and(|age| age < Duration::from_secs(300))
    }
    async fn cache_lock(&self) -> Result<std::fs::File, Error> {
        let path = self.options.cache.with_extension("lock");
        let file = tokio::task::spawn_blocking(move || {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|_| Error::Storage)?;
            }
            let file = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(path)
                .map_err(|_| Error::Storage)?;
            Ok::<_, Error>(file)
        })
        .await
        .map_err(|_| Error::Closed)??;
        let started = std::time::Instant::now();
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(file),
                Err(std::fs::TryLockError::WouldBlock) => {}
                Err(_) => return Err(Error::Storage),
            }
            if started.elapsed() >= Duration::from_secs(300) {
                return Err(Error::Storage);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    async fn fetch_and_write(&self) -> Result<Vec<Snapshot>, Error> {
        let text = tokio::time::timeout(Duration::from_secs(10), self.fetch_text())
            .await
            .map_err(|_| Error::Request)??;
        let snapshots =
            normalize(&ycoding_schema::parse_json(&text).map_err(|_| Error::InvalidSource)?)?;
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let temporary = self.options.cache.with_extension(format!(
            "{}.{}.tmp",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        if let Some(parent) = temporary.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|_| Error::Storage)?;
        }
        tokio::fs::write(&temporary, text)
            .await
            .map_err(|_| Error::Storage)?;
        if tokio::fs::rename(&temporary, &self.options.cache)
            .await
            .is_err()
        {
            tokio::fs::remove_file(&temporary)
                .await
                .map_err(|_| Error::Storage)?;
            return Err(Error::Storage);
        }
        Ok(snapshots)
    }
    async fn fetch_text(&self) -> Result<String, Error> {
        for attempt in 0..3 {
            let response = self
                .client
                .get(format!("{}/api.json", self.options.source))
                .header("User-Agent", &self.options.user_agent)
                .send()
                .await;
            let transient = match &response {
                Ok(response) => {
                    [408, 429, 500, 502, 503, 504].contains(&response.status().as_u16())
                }
                Err(error) => !error.is_builder(),
            };
            if !transient || attempt == 2 {
                let response = response.map_err(|_| Error::Request)?;
                if !response.status().is_success() {
                    return Err(Error::Request);
                }
                return response.text().await.map_err(|_| Error::Request);
            }
            let mut random = [0; 8];
            ring::rand::SystemRandom::new()
                .fill(&mut random)
                .map_err(|_| Error::Request)?;
            let unit = (u64::from_be_bytes(random) >> 11) as f64 / 9007199254740992.0;
            let delay = 200.0 * 2_f64.powi(attempt) * (0.8 + 0.4 * unit);
            tokio::time::sleep(Duration::from_secs_f64(delay / 1000.0)).await;
        }
        Err(Error::Request)
    }
}
pub struct RefreshWorker {
    handle: Option<tokio::task::JoinHandle<()>>,
    error: tokio::sync::watch::Receiver<Option<Error>>,
}
impl RefreshWorker {
    pub fn last_error(&self) -> Option<Error> {
        *self.error.borrow()
    }
    pub async fn shutdown(mut self) -> Result<(), Error> {
        let Some(handle) = self.handle.take() else {
            return Ok(());
        };
        handle.abort();
        match handle.await {
            Ok(()) => Ok(()),
            Err(error) if error.is_cancelled() => Ok(()),
            Err(_) => Err(Error::Closed),
        }
    }
}
impl Drop for RefreshWorker {
    fn drop(&mut self) {
        if let Some(handle) = &self.handle {
            handle.abort();
        }
    }
}
pub fn cache_path(root: &std::path::Path, source: &str) -> PathBuf {
    if source == "https://models.dev" {
        return root.join("models.json");
    }
    let digest = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, source.as_bytes());
    root.join(format!(
        "models-{}.json",
        digest
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}
