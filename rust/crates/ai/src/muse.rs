use crate::{
    Error,
    auth::{Auth, Credential, Secret},
    json,
    llm::{Event, Request},
    openai_responses::OpenAIResponses,
    provider_error::Reason,
    route::{Endpoint, Executor, Prepared, Protocol, Route, StreamParser, Transport},
};
use reqwest::header::{HeaderMap, HeaderValue};
use ring::{
    digest,
    rand::{SecureRandom, SystemRandom},
};
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
const REFRESH_INTERVAL_MS: i64 = 60_000;
const INTERNAL_HEADERS: [&str; 7] = [
    "x-ycoding-session",
    "x-ycoding-project",
    "x-ycoding-client",
    "x-parent-session-id",
    "x-session-affinity",
    "x-session-id",
    "x-opencode-session",
];

type KeySlot = Arc<tokio::sync::Mutex<Option<Arc<Key>>>>;
type RefreshSlot = Arc<tokio::sync::Mutex<Option<(i64, Snapshot)>>>;
pub struct Runtime {
    http: reqwest::Client,
    mint_url: String,
    session: String,
    keys: Mutex<BTreeMap<String, KeySlot>>,
    tiers: Mutex<BTreeMap<String, String>>,
    refreshes: Mutex<BTreeMap<String, RefreshSlot>>,
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
            tiers: Mutex::new(BTreeMap::new()),
            refreshes: Mutex::new(BTreeMap::new()),
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
        let tier = profile.and_then(|profile| self.tiers.lock().ok()?.get(profile).cloned());
        let Some(snapshot) = normalize_usage(event, now, tier.as_deref()) else {
            tracing::warn!("invalid Muse subscription usage event");
            return;
        };
        self.record(snapshot, profile);
    }
    fn record(&self, snapshot: Snapshot, profile: Option<&str>) {
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
    fn record_mint(&self, profile: Option<&str>, tier: Option<String>, usage: Option<Snapshot>) {
        if let (Some(profile), Ok(mut tiers)) = (profile, self.tiers.lock()) {
            match tier {
                Some(tier) => {
                    tiers.insert(profile.to_owned(), tier);
                }
                None => {
                    tiers.remove(profile);
                }
            }
        }
        if let Some(usage) = usage {
            self.record(usage, profile);
        }
    }
    fn refresh_slot(&self, profile: &str) -> Result<RefreshSlot, Error> {
        Ok(self
            .refreshes
            .lock()
            .map_err(|_| Error::invalid("Muse usage cache unavailable"))?
            .entry(profile.to_owned())
            .or_default()
            .clone())
    }
    async fn post_mint(&self, access: &Secret) -> Result<reqwest::Response, Error> {
        self.http
            .post(&self.mint_url)
            .bearer_auth(access.expose())
            .header("accept", "application/json")
            .header("x-api-version", "1.0.0")
            .header("content-type", "application/json")
            .body(r#"{"onboard":false}"#)
            .send()
            .await
            .map_err(|_| Error::transport("Muse key mint failed", "request"))
    }
    fn derived_id(&self, seed: &str) -> String {
        deterministic_uuid(&format!("{}:{seed}", self.session))
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
struct Wire {
    headers: HeaderMap,
    body: String,
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
        let (identity, access, expires) = match &self.account {
            Account::Key { key, base_url } => {
                return Ok(Arc::new(Key {
                    api_key: key.clone(),
                    base_url: base_url.clone(),
                }));
            }
            Account::OAuth {
                identity,
                access,
                expires,
            } => (identity, access, *expires),
        };
        if expires != 0 && expires <= now {
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
        let response = self.runtime.post_mint(access).await?;
        let status = response.status().as_u16();
        if (300..400).contains(&status) {
            return Err(Error::output("Muse key mint refused redirect"));
        }
        if status == 401 {
            return Err(reconnect());
        }
        if !(200..300).contains(&status) {
            let raw = response.bytes().await.ok();
            return Err(mint_failure(status, raw.as_deref()));
        }
        let invalid = || Error::output("Muse key mint returned an invalid response");
        let raw = response.bytes().await.map_err(|_| invalid())?;
        let minted = ycoding_schema::parse_json(std::str::from_utf8(&raw).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
        if !matches!(minted, JsonValue::Object(_))
            || ["api_key", "base_url"].iter().any(|name| {
                json::get(&minted, name).is_some_and(|v| !matches!(v, JsonValue::String(_)))
            })
            || ["subs_tier_name", "action_url"].iter().any(|name| {
                json::get(&minted, name)
                    .is_some_and(|v| !matches!(v, JsonValue::Null | JsonValue::String(_)))
            })
            || ["require_payment", "is_subs_active"].iter().any(|name| {
                json::get(&minted, name).is_some_and(|v| !matches!(v, JsonValue::Bool(_)))
            })
        {
            return Err(invalid());
        }
        if flag(&minted, "require_payment") == Some(true)
            || flag(&minted, "is_subs_active") == Some(false)
        {
            let action = json::get(&minted, "action_url")
                .and_then(json::text)
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
        let missing = || Error::output("mint response missing api_key or base_url");
        let api_key = json::get(&minted, "api_key")
            .and_then(json::text)
            .filter(|v| !v.is_empty())
            .ok_or_else(missing)?;
        let base_url = json::get(&minted, "base_url")
            .and_then(json::text)
            .filter(|v| !v.is_empty())
            .ok_or_else(missing)?;
        let tier = subscription_tier(&minted);
        let usage = json::get(&minted, "subs_usage")
            .and_then(|usage| normalize_subscription(usage, now, tier.as_deref()));
        let key = Arc::new(Key {
            api_key: Secret::new(api_key),
            base_url: normalize_base_url(base_url),
        });
        *cached = Some(key.clone());
        self.runtime
            .record_mint(self.profile.as_deref(), tier, usage);
        Ok(key)
    }
    pub async fn refresh_usage(&self, now: i64) -> Result<Snapshot, Error> {
        let Account::OAuth {
            access, expires, ..
        } = &self.account
        else {
            return Ok(unreported(now));
        };
        let Some(profile) = self.profile.as_deref() else {
            return Ok(unreported(now));
        };
        let slot = self.runtime.refresh_slot(profile)?;
        let mut cached = slot.lock().await;
        if let Some((at, snapshot)) = cached.as_ref()
            && now.saturating_sub(*at) < REFRESH_INTERVAL_MS
        {
            return Ok(snapshot.clone());
        }
        if *expires != 0 && *expires <= now {
            return Err(Error {
                status: Some(401),
                ..reconnect()
            });
        }
        let response = self.runtime.post_mint(access).await?;
        let status = response.status().as_u16();
        let failed = || Error {
            status: Some(status),
            ..Error::output("Muse usage refresh failed")
        };
        if !(200..300).contains(&status) {
            return Err(failed());
        }
        let raw = response.bytes().await.map_err(|_| failed())?;
        let minted = ycoding_schema::parse_json(std::str::from_utf8(&raw).map_err(|_| failed())?)
            .map_err(|_| failed())?;
        if !matches!(minted, JsonValue::Object(_))
            || ["require_payment", "is_subs_active"].iter().any(|name| {
                json::get(&minted, name).is_some_and(|v| !matches!(v, JsonValue::Bool(_)))
            })
            || json::get(&minted, "subs_tier_name")
                .is_some_and(|v| !matches!(v, JsonValue::Null | JsonValue::String(_)))
        {
            return Err(failed());
        }
        let tier = subscription_tier(&minted);
        let quota = json::get(&minted, "subs_usage")
            .and_then(|usage| normalize_subscription(usage, now, tier.as_deref()));
        let snapshot = if flag(&minted, "require_payment") == Some(true)
            || flag(&minted, "is_subs_active") == Some(false)
        {
            inactive(now)
        } else if let Some(quota) = quota
            && !quota.windows.is_empty()
        {
            quota
        } else {
            unreported_for(now, tier.as_deref())
        };
        *cached = Some((now, snapshot.clone()));
        Ok(snapshot)
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
    async fn models(&self, key: &Key) -> Result<reqwest::Response, Error> {
        let url = validate_url(&key.base_url)?
            .join("/muse-code/models")
            .map_err(|_| Error::invalid("Invalid Muse model endpoint"))?;
        self.runtime
            .http
            .get(url)
            .bearer_auth(key.api_key.expose())
            .header("x-client-id", "tbh:exec")
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|_| Error::transport("Muse model discovery failed", "request"))
    }
    pub async fn discover(&self, now: i64) -> Result<JsonValue, Error> {
        let mut key = self.key_for(now).await?;
        let mut response = self.models(&key).await?;
        if response.status().as_u16() == 401 && matches!(self.account, Account::OAuth { .. }) {
            self.invalidate(&key).await;
            key = self.key_for(now).await?;
            response = self.models(&key).await?;
        }
        if !response.status().is_success() {
            return Err(Error::output("Muse model discovery failed"));
        }
        let raw = response
            .text()
            .await
            .map_err(|_| Error::output("Invalid Muse model response"))?;
        ycoding_schema::parse_json(&raw).map_err(|_| Error::output("Invalid Muse model response"))
    }
    fn wire(&self, prepared: &Prepared) -> Result<Wire, Error> {
        let mut headers = prepared.headers.clone();
        let text = |name: &str| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(js_trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        let session = text("x-ycoding-session");
        let parent = text("x-parent-session-id");
        let client = text("x-ycoding-client").map(|value| value.to_lowercase());
        for name in INTERNAL_HEADERS {
            headers.remove(name);
        }
        set(
            &mut headers,
            "x-client-id",
            match client.as_deref() {
                Some("tui") => "tbh:tui",
                Some("desktop") => "tbh:desktop",
                Some("web" | "remote" | "server") => "tbh:serve",
                _ => "tbh:exec",
            },
        )?;
        let session_id = session.as_deref().map_or_else(
            || self.runtime.session.clone(),
            |session| self.runtime.derived_id(session),
        );
        set(&mut headers, "x-tbh-session-id", &session_id)?;
        set(&mut headers, "x-meta-ai-gateway-session-id", &session_id)?;
        if session.is_some() {
            set(&mut headers, "x-tbh-thread-id", &session_id)?;
            let parent = parent
                .as_deref()
                .map(|parent| self.runtime.derived_id(parent));
            set(
                &mut headers,
                "x-tbh-root-session-id",
                parent.as_deref().unwrap_or(&session_id),
            )?;
            if let Some(parent) = &parent {
                set(&mut headers, "x-tbh-parent-thread-id", parent)?;
            }
        }
        let model = json::get(&prepared.wire_body, "model")
            .and_then(json::text)
            .or_else(|| prepared.request.model.id.as_str())
            .unwrap_or_default();
        if model.ends_with("-internal") {
            headers.remove("x-tbh-contributor-mode");
        } else {
            set(
                &mut headers,
                "x-tbh-contributor-mode",
                if model.ends_with("-contributor") {
                    "1"
                } else {
                    "0"
                },
            )?;
        }
        let body = normalized_body(&prepared.wire_body).map_or_else(
            || prepared.encoded_body.clone(),
            |body| ycoding_schema::stringify_json(&body),
        );
        Ok(Wire { headers, body })
    }
    pub(crate) async fn execute(
        &self,
        executor: &Executor,
        prepared: &Prepared,
    ) -> Result<reqwest::Response, Error> {
        let wire = self.wire(prepared)?;
        let mut key = self.key_for(now()).await?;
        for attempt in 0..2 {
            let mut url =
                validate_url(&format!("{}/responses", key.base_url.trim_end_matches('/')))?;
            url.set_query(prepared.url.query());
            let headers = Auth::bearer(Credential::value(key.api_key.expose())).apply(
                crate::auth::Input {
                    method: "POST",
                    url: url.as_str(),
                    body: &wire.body,
                    headers: wire.headers.clone(),
                },
            )?;
            let result = executor
                .execute_http(
                    &url,
                    &headers,
                    reqwest::Method::POST,
                    wire.body.as_bytes().to_vec(),
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
fn flag(value: &JsonValue, name: &str) -> Option<bool> {
    json::get(value, name).and_then(json::boolean)
}
fn subscription_tier(minted: &JsonValue) -> Option<String> {
    json::get(minted, "subs_tier_name")
        .and_then(json::text)
        .map(js_trim)
        .filter(|tier| !tier.is_empty())
        .map(str::to_owned)
}
fn set(headers: &mut HeaderMap, name: &'static str, value: &str) -> Result<(), Error> {
    headers.insert(
        name,
        HeaderValue::from_str(value).map_err(|_| Error::invalid("Invalid Muse header"))?,
    );
    Ok(())
}
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}
fn js_trim(text: &str) -> &str {
    text.trim_matches(js_space)
}
fn utf16_prefix(text: &str, limit: usize) -> String {
    let mut units = 0;
    let mut result = String::new();
    for c in text.chars() {
        let width = c.len_utf16();
        if units + width > limit {
            if units < limit {
                result.push('\u{fffd}');
            }
            break;
        }
        units += width;
        result.push(c);
    }
    result
}
fn problem_detail(body: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let object = value.as_object()?;
    let field = |name: &str| match object.get(name) {
        None | Some(serde_json::Value::Null) => Some(None),
        Some(serde_json::Value::String(text)) => Some(Some(text.as_str())),
        Some(_) => None,
    };
    let title = field("title")?;
    let detail = field("detail")?;
    [detail, title]
        .into_iter()
        .flatten()
        .map(js_trim)
        .find(|text| !text.is_empty())
        .map(str::to_owned)
}
fn mint_failure(status: u16, body: Option<&[u8]>) -> Error {
    match (status, body.and_then(problem_detail)) {
        (403, None) => reconnect(),
        (403, Some(detail)) => Error::output(format!(
            "Muse key mint failed: {}",
            utf16_prefix(&detail, 240)
        )),
        (_, Some(detail)) => Error::output(format!(
            "Muse key mint failed ({status}): {}",
            utf16_prefix(&detail, 240)
        )),
        (_, None) => Error::output(format!("Muse key mint failed: {status}")),
    }
}
pub fn normalize_base_url(raw: &str) -> String {
    if let Ok(url) = reqwest::Url::parse(raw)
        && matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none_or(str::is_empty)
        && url.query().is_none_or(str::is_empty)
        && url.fragment().is_none_or(str::is_empty)
    {
        let path = url.path().trim_end_matches('/');
        let path = path.strip_suffix("/responses").unwrap_or(path);
        return format!("{}{path}", url.origin().ascii_serialization());
    }
    tracing::warn!("unrecognized Muse base_url from key mint; using default");
    BASE_URL.into()
}
fn normalized_body(body: &JsonValue) -> Option<JsonValue> {
    let choice = json::get(body, "tool_choice")?;
    if json::text(choice) == Some("auto") {
        return None;
    }
    let has_tools = json::get(body, "tools")
        .and_then(json::array)
        .is_some_and(|tools| !tools.is_empty());
    if json::text(choice) == Some("none") || !has_tools {
        return Some(json::remove(body, &["tool_choice", "tools"]));
    }
    let mut next = body.clone();
    json::set(&mut next, "tool_choice", JsonValue::String("auto".into()));
    Some(next)
}
fn deterministic_uuid(seed: &str) -> String {
    let hash = digest::digest(&digest::SHA256, seed.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let variant = (u8::from_str_radix(&hash[16..17], 16).unwrap_or(0) & 3) | 8;
    format!(
        "{}-{}-4{}-{variant:x}{}-{}",
        &hash[0..8],
        &hash[8..12],
        &hash[13..16],
        &hash[17..20],
        &hash[20..32]
    )
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

pub fn label(tier: Option<&str>) -> String {
    match tier.map(js_trim).filter(|tier| !tier.is_empty()) {
        Some(tier) => format!("Muse (Meta) · {tier}"),
        None => "Muse (Meta)".into(),
    }
}
pub fn normalize_usage(
    event: &JsonValue,
    observed_at: i64,
    tier: Option<&str>,
) -> Option<Snapshot> {
    if json::get(event, "type").and_then(json::text) != Some("response.subscription_usage") {
        return None;
    }
    normalize_subscription(json::get(event, "subscription")?, observed_at, tier)
}
pub fn normalize_subscription(
    subscription: &JsonValue,
    observed_at: i64,
    tier: Option<&str>,
) -> Option<Snapshot> {
    if !matches!(subscription, JsonValue::Object(_)) {
        return None;
    }
    if json::get(subscription, "tier")
        .is_some_and(|v| !matches!(v, JsonValue::Null | JsonValue::String(_)))
    {
        return None;
    }
    let mut windows = vec![];
    for id in ["window", "weekly"] {
        let value = match json::get(subscription, id) {
            None | Some(JsonValue::Null) => continue,
            Some(value) => value,
        };
        if !matches!(value, JsonValue::Object(_)) {
            return None;
        }
        let used = nullable(json::get(value, "used_percent"), |v| match v {
            JsonValue::Number(n) if n.is_finite() && *n >= 0.0 => Some(*n),
            _ => None,
        })?;
        let reset_at = nullable(json::get(value, "resets_at"), |v| {
            integer(v, false).and_then(|n| NonNegativeInt::new(n.checked_mul(1000)?).ok())
        })?;
        let minutes = if id == "window" {
            nullable(json::get(value, "window_duration_mins"), |v| {
                integer(v, true)
            })?
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
        let period_seconds = if id == "weekly" {
            Some(NonNegativeInt::new(604800).ok()?)
        } else {
            match minutes {
                Some(m) => Some(NonNegativeInt::new(m.checked_mul(60)?).ok()?),
                None => None,
            }
        };
        windows.push(Window {
            id: id.into(),
            label: label.into(),
            group: None,
            unit: "percent".into(),
            used,
            limit: None,
            remaining: None,
            unlimited: None,
            reset_at,
            period_seconds,
        });
    }
    Some(Snapshot {
        provider_id: provider::Id("muse".into()),
        label: label(tier).into(),
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
fn nullable<T>(
    value: Option<&JsonValue>,
    decode: impl FnOnce(&JsonValue) -> Option<T>,
) -> Option<Option<T>> {
    match value {
        None | Some(JsonValue::Null) => Some(None),
        Some(value) => decode(value).map(Some),
    }
}
pub fn unreported(now: i64) -> Snapshot {
    unreported_for(now, None)
}
fn unreported_for(now: i64, tier: Option<&str>) -> Snapshot {
    Snapshot {
        provider_id: provider::Id("muse".into()),
        label: label(tier).into(),
        profile: None,
        status: "unsupported".into(),
        source: "response_stream".into(),
        stability: "observed".into(),
        updated_at: NonNegativeInt::new(now.max(0)).expect("nonnegative time"),
        windows: vec![],
        message: Some("Quota is reported after the next Muse response".into()),
    }
}
fn inactive(now: i64) -> Snapshot {
    Snapshot {
        message: Some("Muse subscription/payment setup is required".into()),
        ..unreported_for(now, None)
    }
}
