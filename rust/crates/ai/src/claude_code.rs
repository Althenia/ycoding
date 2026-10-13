use crate::{
    Error,
    anthropic::AnthropicMessages,
    auth::{Auth, Credential, Input, Secret},
    cache::anthropic_capabilities,
    json::{self, get, s},
    llm::{Event, Request},
    provider_error::{AuthenticationKind, Reason},
    route::{Executor, Prepared, Protocol, Route, StreamParser},
};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use ring::{
    digest,
    rand::{SecureRandom, SystemRandom},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    pin::Pin,
    sync::{Arc, LazyLock},
};
use ycoding_schema::{
    JsonValue, LosslessString, provider, provider_usage::Observation, schema::NonNegativeInt,
};

pub const IDENTITY: &str = "You are Claude Code, Anthropic's official CLI for Claude.";
const BILLING: &str = "x-anthropic-billing-header";
const INTERLEAVED: &str = "interleaved-thinking-2025-05-14";
const LONG_CONTEXT: &str = "context-1m-2025-08-07";
const CLAUDE_CODE_RUNTIME_VERSION: &str = "v26.3.0";
pub const RECONNECT: &str = "Claude profile requires reconnect. Sign in to this profile again.";

#[derive(Clone, Debug)]
pub struct Credentials {
    pub access_token: Secret,
    pub subscription_type: Option<String>,
}
pub type Resolution<'a> = Pin<Box<dyn Future<Output = Result<Credentials, Error>> + Send + 'a>>;
pub trait Account: Send + Sync {
    fn resolve(&self, force_refresh: bool) -> Resolution<'_>;
    fn billing_sample(&self, session: &str) -> Option<LosslessString>;
    fn observe(&self, observation: Observation) -> Result<(), ()>;
}

pub fn reconnect() -> Error {
    Error {
        authentication_kind: Some(AuthenticationKind::Invalid),
        ..Error::new(Reason::Authentication, RECONNECT)
    }
}

#[derive(Clone, Debug)]
pub struct Settings {
    pub version: String,
    pub entrypoint: String,
    pub user_agent: String,
    pub beta_flags: String,
    pub debug_file: Option<std::path::PathBuf>,
}
impl Default for Settings {
    fn default() -> Self {
        let version = std::env::var("ANTHROPIC_CLI_VERSION").unwrap_or_else(|_| "2.1.289".into());
        Self {
            user_agent: std::env::var("ANTHROPIC_USER_AGENT")
                .unwrap_or_else(|_| format!("claude-cli/{version} (external, sdk-cli)")),
            version,
            entrypoint: std::env::var("CLAUDE_CODE_ENTRYPOINT")
                .unwrap_or_else(|_| "sdk-cli".into()),
            beta_flags: std::env::var("ANTHROPIC_BETA_FLAGS").unwrap_or_default(),
            debug_file: std::env::var("CLAUDE_AUTH_DEBUG")
                .ok()
                .filter(|value| !value.is_empty() && value != "1")
                .map(Into::into),
        }
    }
}
impl Settings {
    pub fn from_environment(data_directory: &std::path::Path) -> Self {
        let mut settings = Self::default();
        if std::env::var("CLAUDE_AUTH_DEBUG").as_deref() == Ok("1") {
            settings.debug_file = Some(data_directory.join("claude-auth-debug.log"));
        }
        settings
    }
}

pub fn model_betas(
    model: &LosslessString,
    configured: &str,
    excluded: &BTreeSet<String>,
) -> Vec<String> {
    let mut values = vec![
        "claude-code-20250219",
        "oauth-2025-04-20",
        INTERLEAVED,
        "context-management-2025-06-27",
        "prompt-caching-scope-2026-01-05",
        "advisor-tool-2026-03-01",
        "thinking-token-count-2026-05-13",
        "extended-cache-ttl-2025-04-11",
    ];
    let lower = model.as_str().unwrap_or_default().to_lowercase();
    if !anthropic_capabilities(model).effort.is_empty()
        || ["opus-4-5", "4-6", "4-7"]
            .iter()
            .any(|value| lower.contains(value))
    {
        values.push("effort-2025-11-24");
    }
    merge_betas(
        values
            .into_iter()
            .chain(configured.split(','))
            .filter(|value| !excluded.contains(value.trim()) && value.trim() != LONG_CONTEXT),
    )
}

pub fn merge_betas<'a>(values: impl Iterator<Item = &'a str>) -> Vec<String> {
    values
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .fold(Vec::new(), |mut values, value| {
            if !values.iter().any(|existing| existing == value) {
                values.push(value.to_owned());
            }
            values
        })
}

fn uuid() -> Result<String, Error> {
    let mut bytes = [0; 16];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| Error::invalid("Claude request identity unavailable"))?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    Ok(bytes
        .iter()
        .enumerate()
        .map(|(index, byte)| {
            format!(
                "{}{byte:02x}",
                if matches!(index, 4 | 6 | 8 | 10) {
                    "-"
                } else {
                    ""
                }
            )
        })
        .collect())
}

pub fn headers(
    mut headers: HeaderMap,
    credentials: &Credentials,
    model: &LosslessString,
    settings: &Settings,
    excluded: &BTreeSet<String>,
) -> Result<HeaderMap, Error> {
    let betas = model_betas(model, &settings.beta_flags, excluded);
    let betas = merge_betas(
        betas.iter().map(String::as_str).chain(
            headers
                .get("anthropic-beta")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .split(','),
        ),
    );
    let request_id = uuid()?;
    static SESSION: LazyLock<Result<String, Error>> = LazyLock::new(uuid);
    let session = headers
        .get("x-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .unwrap_or(SESSION.clone()?);
    for (name, value) in [
        ("anthropic-version", "2023-06-01".to_owned()),
        ("anthropic-beta", betas.join(",")),
        ("anthropic-dangerous-direct-browser-access", "true".into()),
        ("x-app", "cli".into()),
        ("user-agent", settings.user_agent.clone()),
        ("x-client-request-id", request_id),
        ("x-claude-code-session-id", session),
    ] {
        headers.insert(
            HeaderName::from_static(name),
            HeaderValue::from_str(&value)
                .map_err(|_| Error::invalid("Invalid Claude request header"))?,
        );
    }
    for (name, value) in [
        (
            "x-stainless-arch",
            if cfg!(target_arch = "aarch64") {
                "arm64"
            } else if cfg!(target_arch = "x86_64") {
                "x64"
            } else {
                std::env::consts::ARCH
            },
        ),
        ("x-stainless-lang", "js"),
        (
            "x-stainless-os",
            if cfg!(target_os = "macos") {
                "MacOS"
            } else if cfg!(target_os = "windows") {
                "win32"
            } else {
                std::env::consts::OS
            },
        ),
        ("x-stainless-package-version", "0.81.0"),
        ("x-stainless-retry-count", "0"),
        ("x-stainless-runtime", "node"),
        ("x-stainless-runtime-version", CLAUDE_CODE_RUNTIME_VERSION),
        ("x-stainless-timeout", "600"),
    ] {
        if !headers.contains_key(name) {
            headers.insert(
                HeaderName::from_static(name),
                HeaderValue::from_static(value),
            );
        }
    }
    headers.remove("x-api-key");
    Auth::bearer(Credential::resolved(None, credentials.access_token.clone())).apply(Input {
        method: "POST",
        url: "",
        body: "",
        headers,
    })
}

pub fn billing_sample(text: &LosslessString) -> LosslessString {
    let units: Vec<_> = text.code_units().take(21).collect();
    LosslessString::from_utf16(
        [4, 7, 20]
            .map(|index| units.get(index).copied().unwrap_or(b'0' as u16))
            .to_vec(),
    )
}

pub fn transform_body(
    mut body: JsonValue,
    settings: &Settings,
    sample: Option<&LosslessString>,
) -> JsonValue {
    let messages = get(&body, "messages").and_then(json::array).unwrap_or(&[]);
    let text = messages
        .iter()
        .find(|message| get(message, "role").and_then(json::text) == Some("user"))
        .and_then(|message| get(message, "content"))
        .and_then(|content| {
            json::string(content).or_else(|| {
                json::array(content)?
                    .iter()
                    .find(|block| get(block, "type").and_then(json::text) == Some("text"))
                    .and_then(|block| get(block, "text"))
                    .and_then(json::string)
            })
        })
        .cloned()
        .unwrap_or_default();
    let sample = sample.cloned().unwrap_or_else(|| billing_sample(&text));
    let sample = String::from_utf16_lossy(&sample.code_units().collect::<Vec<_>>());
    let hash = digest::digest(
        &digest::SHA256,
        format!("59cf53e54c78{sample}{}", settings.version).as_bytes(),
    );
    let suffix = format!("{:02x}{:x}", hash.as_ref()[0], hash.as_ref()[1] >> 4);
    let mut system = vec![json::object([
        ("type", s("text")),
        (
            "text",
            s(format!(
                "{BILLING}: cc_version={}.{suffix}; cc_entrypoint={};",
                settings.version, settings.entrypoint
            )),
        ),
    ])];
    for entry in get(&body, "system").and_then(json::array).unwrap_or(&[]) {
        let text = get(entry, "text").and_then(json::string);
        if get(entry, "type").and_then(json::text) == Some("text")
            && text.is_some_and(|text| starts_with(text, BILLING))
        {
            continue;
        }
        if get(entry, "type").and_then(json::text) == Some("text")
            && let Some(text) =
                text.filter(|text| starts_with(text, IDENTITY) && text.len() > IDENTITY.len())
        {
            let mut identity = json::remove(entry, &["cache_control"]);
            json::set(&mut identity, "text", s(IDENTITY));
            system.push(identity);
            let rest = LosslessString::from_utf16(
                text.code_units()
                    .skip(IDENTITY.len())
                    .skip_while(|unit| *unit == 10)
                    .collect(),
            );
            if !rest.is_empty() {
                let mut remaining = entry.clone();
                json::set(&mut remaining, "text", s(rest));
                system.push(remaining);
            }
            continue;
        }
        system.push(entry.clone());
    }
    if !system
        .iter()
        .any(|entry| get(entry, "text").and_then(json::text) == Some(IDENTITY))
    {
        system.insert(
            1,
            json::object([("type", s("text")), ("text", s(IDENTITY))]),
        );
    }
    let kept: Vec<_> = system
        .iter()
        .filter(|entry| {
            get(entry, "text")
                .and_then(json::string)
                .is_some_and(|text| starts_with(text, BILLING) || starts_with(text, IDENTITY))
        })
        .cloned()
        .collect();
    let moved: Vec<_> = system
        .iter()
        .filter(|entry| {
            get(entry, "text")
                .and_then(json::string)
                .is_some_and(|text| !text.is_empty())
                && !kept.contains(entry)
        })
        .cloned()
        .collect();
    let mut messages = get(&body, "messages")
        .and_then(json::array)
        .unwrap_or(&[])
        .to_vec();
    if !moved.is_empty()
        && let Some(first) = messages
            .iter_mut()
            .find(|message| get(message, "role").and_then(json::text) == Some("user"))
    {
        let mut content = moved;
        match get(first, "content") {
            Some(JsonValue::String(text)) => content.push(json::object([
                ("type", s("text")),
                ("text", s(text.clone())),
            ])),
            Some(JsonValue::Array(blocks)) => content.extend(blocks.clone()),
            _ => {}
        }
        json::set(first, "content", JsonValue::Array(content));
        system = kept;
    }
    json::set(&mut body, "system", JsonValue::Array(system));
    if get(&body, "model")
        .and_then(json::text)
        .is_some_and(|model| model.to_lowercase().contains("haiku"))
    {
        for key in ["output_config", "thinking"] {
            if let Some(value) = get(&body, key) {
                let value = json::remove(value, &["effort"]);
                if matches!(&value, JsonValue::Object(fields) if fields.is_empty()) {
                    body = json::remove(&body, &[key]);
                } else {
                    json::set(&mut body, key, value);
                }
            }
        }
    }
    if let Some(tools) = get(&body, "tools").and_then(json::array) {
        let tools = tools
            .iter()
            .cloned()
            .map(|mut tool| {
                prefix_name(&mut tool);
                tool
            })
            .collect();
        json::set(&mut body, "tools", JsonValue::Array(tools));
    }
    for message in &mut messages {
        if let Some(blocks) = get(message, "content").and_then(json::array) {
            let blocks = blocks
                .iter()
                .cloned()
                .map(|mut block| {
                    if get(&block, "type").and_then(json::text) == Some("tool_use") {
                        prefix_name(&mut block);
                    }
                    block
                })
                .collect();
            json::set(message, "content", JsonValue::Array(blocks));
        }
    }
    if get(&body, "messages").is_some() {
        json::set(
            &mut body,
            "messages",
            JsonValue::Array(repair_pairs(messages)),
        );
    }
    body
}

fn prefix_name(value: &mut JsonValue) {
    if let Some(name) = get(value, "name")
        .and_then(json::string)
        .filter(|name| !name.is_empty())
    {
        let mut units = name.code_units();
        let first = units.next().unwrap_or_default();
        let capital = char::from_u32(first as u32)
            .map(|ch| {
                ch.to_uppercase()
                    .collect::<String>()
                    .encode_utf16()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| vec![first]);
        json::set(
            value,
            "name",
            s(LosslessString::from_utf16(
                "mcp_".encode_utf16().chain(capital).chain(units).collect(),
            )),
        );
    }
}

fn starts_with(text: &LosslessString, prefix: &str) -> bool {
    text.code_units()
        .take(prefix.encode_utf16().count())
        .eq(prefix.encode_utf16())
}

pub fn repair_pairs(messages: Vec<JsonValue>) -> Vec<JsonValue> {
    let mut uses = BTreeMap::new();
    let mut results = BTreeMap::new();
    for (index, message) in messages.iter().enumerate() {
        for block in get(message, "content").and_then(json::array).unwrap_or(&[]) {
            match get(block, "type").and_then(json::text) {
                Some("tool_use") => {
                    if let Some(id) = get(block, "id").and_then(json::string) {
                        uses.entry(id.clone()).or_insert(index);
                    }
                }
                Some("tool_result") => {
                    if let Some(id) = get(block, "tool_use_id").and_then(json::string) {
                        results.entry(id.clone()).or_insert(index);
                    }
                }
                _ => {}
            }
        }
    }
    let adjacent = |id: &LosslessString| {
        uses.get(id)
            .is_some_and(|index| results.get(id) == Some(&(index + 1)))
    };
    if uses.keys().chain(results.keys()).all(adjacent) {
        return messages;
    }
    messages
        .into_iter()
        .enumerate()
        .filter_map(|(index, mut message)| {
            let Some(content) = get(&message, "content").and_then(json::array) else {
                return Some(message);
            };
            let content: Vec<_> = content
                .iter()
                .filter(|block| match get(block, "type").and_then(json::text) {
                    Some("tool_use") => get(block, "id")
                        .and_then(json::string)
                        .is_none_or(|id| adjacent(id) && uses.get(id) == Some(&index)),
                    Some("tool_result") => get(block, "tool_use_id")
                        .and_then(json::string)
                        .is_none_or(|id| adjacent(id) && results.get(id) == Some(&index)),
                    _ => true,
                })
                .cloned()
                .collect();
            if content.is_empty() {
                return None;
            }
            json::set(&mut message, "content", JsonValue::Array(content));
            Some(message)
        })
        .collect()
}

struct Parser(Box<dyn StreamParser>);
impl StreamParser for Parser {
    fn push(&mut self, event: &JsonValue) -> Result<Vec<Event>, Error> {
        let mut event = event.clone();
        restore_names(&mut event);
        self.0.push(&event)
    }
    fn finish(&mut self) -> Result<Vec<Event>, Error> {
        self.0.finish()
    }
}
fn restore_names(value: &mut JsonValue) {
    match value {
        JsonValue::Object(fields) => {
            if let Some(JsonValue::String(name)) = fields.get(&"name".into())
                && let Some(name) = name
                    .as_str()
                    .and_then(|name| name.strip_prefix("mcp_"))
                    .filter(|name| !name.is_empty())
            {
                let mut chars = name.chars();
                let first = chars
                    .next()
                    .map(|ch| ch.to_lowercase().collect::<String>())
                    .unwrap_or_default();
                fields.insert("name".into(), s(format!("{first}{}", chars.as_str())));
            }
            let entries: Vec<_> = fields.iter().cloned().collect();
            for (key, mut value) in entries {
                restore_names(&mut value);
                fields.insert(key, value);
            }
        }
        JsonValue::Array(values) => values.iter_mut().for_each(restore_names),
        _ => {}
    }
}

pub struct ClaudeCode {
    account: Arc<dyn Account>,
    settings: Settings,
}
pub fn route(account: Arc<dyn Account>, settings: Settings) -> Route {
    let mut route = Route::anthropic();
    route.protocol = Arc::new(ClaudeCode { account, settings });
    route
}
impl Protocol for ClaudeCode {
    fn id(&self) -> &'static str {
        "anthropic-messages"
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        crate::anthropic::lower(request)
    }
    fn wire_body(&self, request: &Request, body: JsonValue) -> Result<JsonValue, Error> {
        let session = request
            .http
            .headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("x-ycoding-session"))
            .or_else(|| {
                request
                    .http
                    .headers
                    .iter()
                    .find(|(key, _)| key.eq_ignore_ascii_case("x-session-id"))
            })
            .map(|(_, value)| value);
        let sample = session.and_then(|session| self.account.billing_sample(session));
        Ok(transform_body(body, &self.settings, sample.as_ref()))
    }
    fn parser(&self, request: &Request) -> Box<dyn StreamParser> {
        Box::new(Parser(AnthropicMessages.parser(request)))
    }
    fn dispatch<'a>(
        &'a self,
        executor: &'a Executor,
        prepared: &'a mut Prepared,
    ) -> Pin<Box<dyn Future<Output = Result<reqwest::Response, Error>> + Send + 'a>> {
        Box::pin(async move {
            if prepared.url.path() == "/v1/messages"
                && !prepared.url.query_pairs().any(|(name, _)| name == "beta")
            {
                prepared.url.query_pairs_mut().append_pair("beta", "true");
            }
            let mut current = self.account.resolve(false).await?;
            let original = prepared.headers.clone();
            let mut excluded = BTreeSet::new();
            let mut refreshed = false;
            loop {
                prepared.headers = headers(
                    original.clone(),
                    &current,
                    &prepared.request.model.id,
                    &self.settings,
                    &excluded,
                )?;
                let result = executor.execute(prepared).await;
                if let Err(error) = &result {
                    if error.status == Some(401) && !refreshed {
                        refreshed = true;
                        if let Ok(next) = self.account.resolve(true).await
                            && next.access_token.expose() != current.access_token.expose()
                        {
                            self.event("credential-rotated", None);
                            current = next;
                            continue;
                        }
                        self.observe_error(error, &current);
                        return result;
                    }
                    if matches!(error.status, Some(400 | 429))
                        && error
                            .http
                            .as_ref()
                            .and_then(|http| http.body.as_ref())
                            .is_some_and(|body| {
                                [
                                    "Extra usage is required for long context requests",
                                    "long context beta is not yet available",
                                    "You're out of extra usage",
                                ]
                                .iter()
                                .any(|text| body.contains(text))
                            })
                        && model_betas(
                            &prepared.request.model.id,
                            &self.settings.beta_flags,
                            &excluded,
                        )
                        .iter()
                        .any(|beta| beta == INTERLEAVED)
                    {
                        excluded.insert(INTERLEAVED.into());
                        self.event("beta-excluded", Some(INTERLEAVED));
                        current = self.account.resolve(false).await?;
                        continue;
                    }
                    self.observe_error(error, &current);
                    return result;
                }
                if let Ok(response) = &result {
                    self.observe(response.headers(), &current);
                }
                return result;
            }
        })
    }
}
impl ClaudeCode {
    fn event(&self, event: &'static str, beta: Option<&'static str>) {
        tracing::debug!(event, beta, "Claude account request");
        let Some(file) = &self.settings.debug_file else {
            return;
        };
        let write = || -> Result<(), std::io::Error> {
            use std::io::Write;
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut options = std::fs::OpenOptions::new();
            options.create(true).append(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
                #[cfg(target_os = "macos")]
                options.custom_flags(0x100);
                #[cfg(target_os = "linux")]
                options.custom_flags(0x20000);
            }
            let mut file = options.open(file)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            }
            let time = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let data = beta.map_or_else(
                || serde_json::json!({}),
                |beta| serde_json::json!({"beta":beta}),
            );
            writeln!(
                file,
                "{}",
                serde_json::json!({"time":time,"event":event,"data":data})
            )
        };
        if write().is_err() {
            tracing::debug!(event = "debug-write-failed", "Claude account request");
        }
    }
    fn observe_error(&self, error: &Error, credentials: &Credentials) {
        if let Some(http) = &error.http
            && let Ok(headers) = crate::route::request_headers(http.response_headers.iter())
        {
            self.observe(&headers, credentials);
        }
    }
    fn observe(&self, headers: &HeaderMap, credentials: &Credentials) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(i64::MAX as u128) as i64;
        match normalize_headers(headers, credentials.subscription_type.as_deref(), now) {
            Ok(observation) if !observation.windows.is_empty() => {
                if self.account.observe(observation).is_err() {
                    self.event("response-observer-failed", None);
                }
            }
            Err(_) => self.event("response-observer-failed", None),
            _ => {}
        }
    }
}

pub fn normalize_headers(
    headers: &HeaderMap,
    subscription: Option<&str>,
    now: i64,
) -> Result<Observation, Error> {
    let mut windows = Vec::new();
    for (id, label, prefix, reset) in [
        (
            "five-hour",
            "5-hour",
            "anthropic-ratelimit-unified-5h",
            Some("anthropic-ratelimit-unified-5h-reset"),
        ),
        (
            "seven-day",
            "Weekly",
            "anthropic-ratelimit-unified-7d",
            Some("anthropic-ratelimit-unified-7d-reset"),
        ),
        (
            "overage",
            "Extra usage",
            "anthropic-ratelimit-unified-overage",
            None,
        ),
    ] {
        let number = |key: &str| -> Result<Option<f64>, Error> {
            headers
                .get(key)
                .map(|value| {
                    value
                        .to_str()
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                        .and_then(|value| value.trim().parse::<f64>().ok())
                        .filter(|value| value.is_finite() && *value >= 0.0)
                        .ok_or_else(|| Error::output("Invalid Claude usage headers"))
                })
                .transpose()
        };
        let used = if let Some(value) = number(&format!("{prefix}-utilization"))? {
            if value > 100.0 {
                return Err(Error::output("Invalid Claude usage headers"));
            }
            Some(if value <= 1.0 { value * 100.0 } else { value })
        } else {
            match (
                number(&format!("{prefix}-limit"))?,
                number(&format!("{prefix}-remaining"))?,
            ) {
                (Some(limit), Some(remaining)) => {
                    if limit <= 0.0 || remaining > limit {
                        return Err(Error::output("Invalid Claude usage headers"));
                    }
                    Some((limit - remaining) / limit * 100.0)
                }
                _ => None,
            }
        };
        let Some(used) = used else {
            continue;
        };
        let reset_at = reset
            .and_then(|key| headers.get(key))
            .map(|value| {
                let raw = value
                    .to_str()
                    .map_err(|_| Error::output("Invalid Claude usage headers"))?;
                if raw.is_empty() {
                    return Ok(None);
                }
                let numeric = raw.parse::<f64>().ok();
                if numeric.is_some_and(|value| !value.is_finite() || value < 0.0) {
                    return Err(Error::output("Invalid Claude usage headers"));
                }
                let millis = numeric
                    .map(|value| {
                        if value < 10_000_000_000.0 {
                            value * 1000.0
                        } else {
                            value
                        }
                    })
                    .or_else(|| http_date(raw));
                millis
                    .map(|value| {
                        NonNegativeInt::new(value.trunc() as i64)
                            .map(Some)
                            .map_err(|_| Error::output("Invalid Claude usage headers"))
                    })
                    .unwrap_or_else(|| Err(Error::output("Invalid Claude usage headers")))
            })
            .transpose()?
            .flatten();
        windows.push(ycoding_schema::provider_usage::Window {
            id: id.into(),
            label: label.into(),
            unit: "percent".into(),
            used: Some((used * 100.0).round() / 100.0),
            limit: None,
            remaining: None,
            unlimited: None,
            reset_at,
            period_seconds: None,
        });
    }
    let label = match subscription
        .map(str::trim)
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("pro") => "Claude Pro",
        Some("max") => "Claude Max",
        _ => "Claude",
    };
    Ok(Observation {
        provider_id: provider::Id("anthropic".into()),
        label: label.into(),
        source: "response_headers".into(),
        stability: "observed".into(),
        observed_at: NonNegativeInt::new(now.max(0))
            .map_err(|_| Error::output("Invalid Claude observation time"))?,
        windows,
    })
}

fn http_date(raw: &str) -> Option<f64> {
    crate::provider_error::retry_after_ms(&BTreeMap::from([("retry-after".into(), raw.into())]), 0)
}
