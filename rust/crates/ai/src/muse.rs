use crate::{
    Error,
    auth::{Auth, Credential, Secret},
    json,
    llm::{Event, Request},
    openai_responses::OpenAIResponses,
    provider_error::Reason,
    route::{Endpoint, Executor, Prepared, Protocol, Route, StreamParser, Transport},
};
use ring::rand::{SecureRandom, SystemRandom};
use std::{
    collections::BTreeMap,
    fmt,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};
use ycoding_schema::{
    JsonValue, provider,
    provider_usage::{Observation, Snapshot, Window},
    schema::NonNegativeInt,
};

pub const BASE_URL: &str = "https://api.meta.ai/v1";
pub const RECONNECT: &str = "Muse account token expired or was rejected; log in again: run ycoding, then /connect and choose Muse (Meta).";

type KeySlot = Arc<tokio::sync::Mutex<Option<Arc<Key>>>>;
pub struct Runtime {
    http: reqwest::Client,
    mint_url: String,
    session: String,
    keys: Mutex<BTreeMap<String, KeySlot>>,
    observations: Mutex<BTreeMap<Option<String>, Observation>>,
}
impl fmt::Debug for Runtime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MuseRuntime([redacted])")
    }
}
impl Runtime {
    pub fn new(mint_url: String) -> Result<Arc<Self>, Error> {
        let mut bytes = [0; 16];
        SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| Error::invalid("Muse session identity unavailable"))?;
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        let session = bytes
            .iter()
            .enumerate()
            .map(|(i, b)| {
                format!(
                    "{}{b:02x}",
                    if matches!(i, 4 | 6 | 8 | 10) { "-" } else { "" }
                )
            })
            .collect();
        Ok(Arc::new(Self {
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|_| Error::invalid("Muse HTTP client unavailable"))?,
            mint_url,
            session,
            keys: Mutex::new(BTreeMap::new()),
            observations: Mutex::new(BTreeMap::new()),
        }))
    }
    pub fn shared() -> Result<Arc<Self>, Error> {
        static SHARED: LazyLock<Result<Arc<Runtime>, Error>> =
            LazyLock::new(|| Runtime::new("https://api.meta.ai/muse-code/key".into()));
        SHARED.clone()
    }
    pub fn observation(&self, profile: Option<&str>) -> Option<Observation> {
        self.observations
            .lock()
            .ok()?
            .get(&profile.map(str::to_owned))
            .cloned()
    }
    pub fn retain_accounts(&self, identities: &[String]) -> Result<(), Error> {
        self.keys
            .lock()
            .map_err(|_| Error::invalid("Muse key cache unavailable"))?
            .retain(|identity, _| identities.contains(identity));
        Ok(())
    }
    pub fn observe(&self, event: &JsonValue, profile: Option<&str>, now: i64) {
        let Some(snapshot) = normalize_usage(event, now) else {
            tracing::warn!("invalid Muse subscription usage event");
            return;
        };
        if snapshot.windows.is_empty() {
            return;
        }
        if let Ok(mut observations) = self.observations.lock() {
            observations.insert(
                profile.map(str::to_owned),
                Observation {
                    provider_id: snapshot.provider_id,
                    label: snapshot.label,
                    source: snapshot.source,
                    stability: snapshot.stability,
                    observed_at: snapshot.updated_at,
                    windows: snapshot.windows,
                },
            );
        }
    }
}

pub struct Key {
    pub api_key: Secret,
    pub base_url: String,
}
impl fmt::Debug for Key {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MuseKey([redacted])")
    }
}
#[derive(Clone)]
enum Account {
    Key {
        key: Secret,
        base_url: String,
    },
    OAuth {
        identity: String,
        access: Secret,
        expires: i64,
    },
}
#[derive(Clone)]
pub struct Connection {
    runtime: Arc<Runtime>,
    account: Account,
    profile: Option<String>,
}
impl fmt::Debug for Connection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MuseConnection([redacted])")
    }
}
impl Connection {
    pub fn key(
        runtime: Arc<Runtime>,
        key: String,
        base_url: String,
        profile: Option<String>,
    ) -> Self {
        Self {
            runtime,
            account: Account::Key {
                key: Secret::new(key),
                base_url,
            },
            profile,
        }
    }
    pub fn oauth(
        runtime: Arc<Runtime>,
        identity: String,
        access: String,
        expires: i64,
        profile: String,
    ) -> Self {
        Self {
            runtime,
            account: Account::OAuth {
                identity,
                access: Secret::new(access),
                expires,
            },
            profile: Some(profile),
        }
    }
    pub async fn key_for(&self, now: i64) -> Result<Arc<Key>, Error> {
        let Account::OAuth {
            identity,
            access,
            expires,
        } = &self.account
        else {
            let Account::Key { key, base_url } = &self.account else {
                unreachable!()
            };
            return Ok(Arc::new(Key {
                api_key: key.clone(),
                base_url: base_url.clone(),
            }));
        };
        if *expires != 0 && *expires <= now {
            return Err(reconnect());
        }
        let slot = self
            .runtime
            .keys
            .lock()
            .map_err(|_| Error::invalid("Muse key cache unavailable"))?
            .entry(identity.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(None)))
            .clone();
        let mut cached = slot.lock().await;
        if let Some(key) = cached.as_ref() {
            return Ok(key.clone());
        }
        let response = self
            .runtime
            .http
            .post(&self.runtime.mint_url)
            .bearer_auth(access.expose())
            .header("x-api-version", "1.0.0")
            .header("content-type", "application/json")
            .body(r#"{"onboard":false}"#)
            .send()
            .await
            .map_err(|_| Error::transport("Muse key mint failed", "request"))?;
        let status = response.status().as_u16();
        if matches!(status, 401 | 403) {
            return Err(reconnect());
        }
        if !(200..300).contains(&status) {
            return Err(Error::output(format!("Muse key mint failed: {status}")));
        }
        let raw = response
            .bytes()
            .await
            .map_err(|_| Error::output("Muse key mint returned an invalid response"))?;
        let minted: serde_json::Value = serde_json::from_slice(&raw)
            .map_err(|_| Error::output("Muse key mint returned an invalid response"))?;
        let invalid = || Error::output("Muse key mint returned an invalid response");
        if !minted.is_object()
            || ["api_key", "base_url", "subs_tier_name"]
                .iter()
                .any(|k| minted.get(k).is_some_and(|v| !v.is_string()))
            || ["require_payment", "is_subs_active"]
                .iter()
                .any(|k| minted.get(k).is_some_and(|v| !v.is_boolean()))
            || minted
                .get("action_url")
                .is_some_and(|v| !v.is_null() && !v.is_string())
        {
            return Err(invalid());
        }
        if minted["require_payment"] == true || minted["is_subs_active"] == false {
            let action = minted
                .get("action_url")
                .and_then(serde_json::Value::as_str)
                .and_then(|v| validate_url(v).ok())
                .map(|mut url| {
                    url.set_query(None);
                    url.set_fragment(None);
                    format!(": {url}")
                })
                .unwrap_or_default();
            return Err(Error::output(format!(
                "Muse subscription/payment setup is required{action}"
            )));
        }
        let api_key = minted
            .get("api_key")
            .and_then(serde_json::Value::as_str)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| Error::output("mint response missing api_key or base_url"))?;
        let base_url = minted
            .get("base_url")
            .and_then(serde_json::Value::as_str)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| Error::output("mint response missing api_key or base_url"))?;
        validate_url(base_url)?;
        let key = Arc::new(Key {
            api_key: Secret::new(api_key),
            base_url: base_url.into(),
        });
        *cached = Some(key.clone());
        Ok(key)
    }
    async fn invalidate(&self, key: &Arc<Key>) {
        if let Account::OAuth { identity, .. } = &self.account {
            let slot = self
                .runtime
                .keys
                .lock()
                .ok()
                .and_then(|keys| keys.get(identity).cloned());
            if let Some(slot) = slot {
                let mut cached = slot.lock().await;
                if cached
                    .as_ref()
                    .is_some_and(|cached| Arc::ptr_eq(cached, key))
                {
                    *cached = None;
                }
            }
        }
    }
    pub async fn discover(&self, now: i64) -> Result<JsonValue, Error> {
        let key = self.key_for(now).await?;
        let url = validate_url(&key.base_url)?
            .join("/muse-code/models")
            .map_err(|_| Error::invalid("Invalid Muse model endpoint"))?;
        let response = self
            .runtime
            .http
            .get(url)
            .bearer_auth(key.api_key.expose())
            .header("x-client-id", "tbh:exec")
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|_| Error::transport("Muse model discovery failed", "request"))?;
        if !response.status().is_success() {
            return Err(Error::output("Muse model discovery failed"));
        }
        let raw = response
            .text()
            .await
            .map_err(|_| Error::output("Invalid Muse model response"))?;
        ycoding_schema::parse_json(&raw).map_err(|_| Error::output("Invalid Muse model response"))
    }
    pub(crate) async fn execute(
        &self,
        executor: &Executor,
        prepared: &Prepared,
    ) -> Result<reqwest::Response, Error> {
        let mut key = self.key_for(now()).await?;
        for attempt in 0..2 {
            let url = validate_url(&format!("{}/responses", key.base_url.trim_end_matches('/')))?;
            let mut headers = Auth::bearer(Credential::value(key.api_key.expose())).apply(
                crate::auth::Input {
                    method: "POST",
                    url: url.as_str(),
                    body: &prepared.encoded_body,
                    headers: prepared.headers.clone(),
                },
            )?;
            headers.insert(
                "x-client-id",
                "tbh:exec"
                    .parse()
                    .map_err(|_| Error::invalid("Invalid Muse header"))?,
            );
            for name in ["x-tbh-session-id", "x-meta-ai-gateway-session-id"] {
                headers.insert(
                    name,
                    self.runtime
                        .session
                        .parse()
                        .map_err(|_| Error::invalid("Invalid Muse session header"))?,
                );
            }
            let result = executor
                .execute_http(
                    &url,
                    &headers,
                    reqwest::Method::POST,
                    prepared.encoded_body.as_bytes().to_vec(),
                )
                .await;
            if !matches!(self.account, Account::OAuth { .. })
                || !result
                    .as_ref()
                    .is_err_and(|e| e.http.as_ref().is_some_and(|h| h.status == Some(401)))
            {
                return result;
            }
            self.invalidate(&key).await;
            if attempt == 1 {
                return Err(reconnect());
            }
            key = self.key_for(now()).await?;
        }
        unreachable!()
    }
}
fn reconnect() -> Error {
    Error::new(Reason::Authentication, RECONNECT)
}
fn validate_url(url: &str) -> Result<reqwest::Url, Error> {
    let url = reqwest::Url::parse(url).map_err(|_| Error::invalid("Invalid Muse endpoint"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Error::invalid("Invalid Muse endpoint"));
    }
    Ok(url)
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

pub fn route(connection: Connection) -> Route {
    let mut route = Route::openai_responses();
    route.id = "muse-responses".into();
    route.provider = provider::Id("muse".into());
    route.endpoint = Endpoint::new(BASE_URL, "/responses");
    route.protocol = Arc::new(MuseProtocol(connection.clone()));
    route.transport = Transport::Muse(Arc::new(connection));
    route.defaults.provider_options = Some(json::object([(
        "openai",
        json::object([
            ("store", JsonValue::Bool(false)),
            (
                "include",
                JsonValue::Array(vec![JsonValue::String(
                    "reasoning.encrypted_content".into(),
                )]),
            ),
        ]),
    )]));
    route
}
struct MuseProtocol(Connection);
impl Protocol for MuseProtocol {
    fn id(&self) -> &'static str {
        "openai-responses"
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        OpenAIResponses.lower(request)
    }
    fn parser(&self, request: &Request) -> Box<dyn StreamParser> {
        Box::new(MuseParser {
            inner: OpenAIResponses.parser(request),
            connection: self.0.clone(),
        })
    }
}
struct MuseParser {
    inner: Box<dyn StreamParser>,
    connection: Connection,
}
impl StreamParser for MuseParser {
    fn push(&mut self, event: &JsonValue) -> Result<Vec<Event>, Error> {
        if json::get(event, "type").and_then(json::text) == Some("response.subscription_usage") {
            self.connection
                .runtime
                .observe(event, self.connection.profile.as_deref(), now());
            return Ok(vec![]);
        }
        self.inner.push(event)
    }
    fn finish(&mut self) -> Result<Vec<Event>, Error> {
        self.inner.finish()
    }
}

pub fn normalize_usage(event: &JsonValue, observed_at: i64) -> Option<Snapshot> {
    if json::get(event, "type").and_then(json::text) != Some("response.subscription_usage") {
        return None;
    }
    let subscription = json::get(event, "subscription")?;
    if !matches!(subscription, JsonValue::Object(_)) {
        return None;
    }
    let mut windows = vec![];
    for id in ["window", "weekly"] {
        let Some(value) = json::get(subscription, id) else {
            continue;
        };
        if !matches!(value, JsonValue::Object(_)) {
            return None;
        }
        let used = optional(json::get(value, "used_percent").map(|v| match v {
            JsonValue::Number(n) if n.is_finite() && (0.0..=100.0).contains(n) => Some(*n),
            _ => None,
        }))?;
        let reset_at = optional(json::get(value, "resets_at").map(|v| {
            integer(v, false).and_then(|n| NonNegativeInt::new(n.checked_mul(1000)?).ok())
        }))?;
        let minutes = if id == "window" {
            optional(json::get(value, "window_duration_mins").map(|v| integer(v, true)))?
        } else {
            None
        };
        let label = if id == "weekly" {
            "Weekly".into()
        } else {
            minutes.map_or("Window".into(), |m| {
                if m >= 60 {
                    format!("{}-hour window", m as f64 / 60.0)
                } else {
                    format!("{m}-minute window")
                }
            })
        };
        windows.push(Window {
            id: id.into(),
            label: label.into(),
            unit: "percent".into(),
            used,
            limit: None,
            remaining: None,
            unlimited: None,
            reset_at,
            period_seconds: if id == "weekly" {
                Some(NonNegativeInt::new(604800).ok()?)
            } else {
                optional(
                    minutes.map(|m| m.checked_mul(60).and_then(|n| NonNegativeInt::new(n).ok())),
                )?
            },
        });
    }
    Some(Snapshot {
        provider_id: provider::Id("muse".into()),
        label: "Muse (Meta)".into(),
        profile: None,
        status: "available".into(),
        source: "response_stream".into(),
        stability: "observed".into(),
        updated_at: NonNegativeInt::new(observed_at.max(0)).ok()?,
        windows,
        message: None,
    })
}
fn integer(value: &JsonValue, positive: bool) -> Option<i64> {
    match value {
        JsonValue::Number(n)
            if n.is_finite()
                && n.fract() == 0.0
                && *n >= if positive { 1.0 } else { 0.0 }
                && *n <= 9_007_199_254_740_991.0 =>
        {
            Some(*n as i64)
        }
        _ => None,
    }
}
fn optional<T>(value: Option<Option<T>>) -> Option<Option<T>> {
    match value {
        None => Some(None),
        Some(Some(v)) => Some(Some(v)),
        Some(None) => None,
    }
}
pub fn unreported(now: i64) -> Snapshot {
    Snapshot {
        provider_id: provider::Id("muse".into()),
        label: "Muse (Meta)".into(),
        profile: None,
        status: "unsupported".into(),
        source: "response_stream".into(),
        stability: "observed".into(),
        updated_at: NonNegativeInt::new(now.max(0)).expect("nonnegative time"),
        windows: vec![],
        message: Some("Quota is reported after the next Muse response".into()),
    }
}
