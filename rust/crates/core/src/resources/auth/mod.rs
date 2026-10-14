use super::credential::{Error, Info, Service};
use ring::{
    digest,
    rand::{SecureRandom, SystemRandom},
};
use serde_json::{Value, json};
use std::{
    fmt,
    future::Future,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use url::Url;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonValue, LosslessString, credential,
    integration_id::IntegrationMethodId, schema::NonNegativeInt,
};
use ycoding_store::resources::Secret;

mod builtin;
pub mod claude;
pub mod cursor;
pub mod integration;
pub mod muse;
pub mod page;

#[derive(Clone, Default)]
pub struct Preparation {
    pub clients: std::collections::BTreeMap<String, Client>,
    pub cursor: Option<cursor::Store>,
    pub providers: Option<crate::resources::model::ProviderContext>,
}
impl Preparation {
    pub async fn prepare_value(
        &self,
        credentials: &Service,
        stored: Info,
        time: i64,
        claude: Option<&claude::Store>,
    ) -> Result<Secret, Error> {
        let stored = credentials.current_account(&stored)?;
        if crate::resources::model::scope::dropped_provider_id(stored.integration_id()) {
            return Err(Error::ProfileUnavailable);
        }
        let integration = stored
            .integration_id()
            .as_str()
            .ok_or(Error::InvalidCredential)?;
        let client = self
            .clients
            .get(integration)
            .cloned()
            .map(Ok)
            .unwrap_or_else(|| Client::provider(integration, env!("CARGO_PKG_VERSION")));
        match client {
            Ok(client) => {
                client
                    .prepare_value(credentials, stored, time, claude, self.cursor.as_ref())
                    .await
            }
            Err(_) if !stored.needs_refresh(time)? => Ok(stored.secret().clone()),
            Err(_) => Err(Error::ProfileUnavailable),
        }
    }
}

const OPENAI_CLIENT: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

async fn join_finished(tasks: Vec<tokio::task::JoinHandle<()>>) -> Result<(), Error> {
    for task in tasks {
        task.await.map_err(|_| Error::UnknownOutcome)?;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Pending,
    Complete,
    Failed,
    Denied,
    Expired,
    Cancelled,
    UnknownOutcome,
}

#[derive(Clone, PartialEq)]
pub enum Poll {
    WaitUntil(i64),
    Complete(Secret),
}
impl fmt::Debug for Poll {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WaitUntil(time) => f.debug_tuple("WaitUntil").field(time).finish(),
            Self::Complete(_) => f.write_str("Complete([redacted])"),
        }
    }
}
#[derive(Clone)]
pub enum DeviceFlow {
    Openai,
    Muse,
}
impl fmt::Debug for DeviceFlow {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DeviceFlow([redacted])")
    }
}

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    endpoint: String,
    user_agent: String,
}
impl fmt::Debug for Client {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AuthClient([redacted])")
    }
}
impl Client {
    pub fn new(endpoint: &str, version: &str) -> Result<Self, Error> {
        let mut url = Url::parse(endpoint).map_err(|_| Error::Rejected)?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(Error::Rejected);
        }
        url.set_query(None);
        url.set_fragment(None);
        Ok(Self {
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .build()
                .map_err(|_| Error::Rejected)?,
            endpoint: url.as_str().trim_end_matches('/').into(),
            user_agent: format!("ycoding/{version}"),
        })
    }
    pub fn provider(provider: &str, version: &str) -> Result<Self, Error> {
        Self::new(
            match provider {
                "openai" => "https://auth.openai.com",
                "cursor" => "https://api2.cursor.sh",
                "anthropic" => "https://claude.ai",
                "muse" => "https://auth.meta.com",
                _ => return Err(Error::Rejected),
            },
            version,
        )
    }

    pub async fn login_key(
        &self,
        service: &Service,
        integration: LosslessString,
        label: Option<LosslessString>,
        key: LosslessString,
    ) -> Result<Info, Error> {
        let secret = Secret::new(
            credential::Value::Key(credential::Key {
                key,
                metadata: None,
            })
            .encode(),
        )
        .map_err(|_| Error::InvalidCredential)?;
        service
            .create(credential_id()?, integration, label, secret, now()?)
            .await
    }

    pub async fn enroll_device(
        &self,
        service: Service,
        flow: DeviceFlow,
        label: Option<LosslessString>,
    ) -> Result<Enrollment, Error> {
        let integration = match &flow {
            DeviceFlow::Openai => "openai",
            DeviceFlow::Muse => "muse",
        }
        .into();
        let attempt = self.start_device(flow, now()?).await?;
        let url = attempt.url.clone();
        let instructions = attempt.instructions.clone();
        let (sender, receiver) = tokio::sync::watch::channel(EnrollmentState {
            status: Status::Pending,
            persisting: false,
            result: None,
        });
        let task = tokio::spawn(async move {
            let mut attempt = attempt;
            let result = drive_device(&mut attempt).await;
            let result = match result {
                Ok(secret) => {
                    sender.send_replace(EnrollmentState {
                        status: Status::Pending,
                        persisting: true,
                        result: None,
                    });
                    match (credential_id(), now()) {
                        (Ok(id), Ok(time)) => {
                            service.create(id, integration, label, secret, time).await
                        }
                        _ => Err(Error::Rejected),
                    }
                }
                Err(error) => Err(error),
            };
            let status = match &result {
                Ok(_) => Status::Complete,
                Err(Error::UnknownOutcome) => Status::UnknownOutcome,
                Err(_) if attempt.status != Status::Complete => attempt.status,
                Err(_) => Status::Failed,
            };
            sender.send_replace(EnrollmentState {
                status,
                persisting: false,
                result: Some(result),
            });
        });
        Ok(Enrollment {
            url,
            instructions,
            receiver,
            task: Some(task),
            cancelled: false,
        })
    }

    pub async fn start_browser(
        &self,
        provider: &str,
        method: &str,
        port: Option<u16>,
    ) -> Result<BrowserAttempt, Error> {
        let (host, default_port, path) = match (provider, method) {
            ("openai", "chatgpt-browser") => ("localhost", 1455, "/auth/callback"),
            _ => return Err(Error::Rejected),
        };
        let listener = tokio::net::TcpListener::bind((host, port.unwrap_or(default_port)))
            .await
            .map_err(|_| Error::Rejected)?;
        let redirect = format!(
            "http://{host}:{}{path}",
            listener.local_addr().map_err(|_| Error::Rejected)?.port()
        );
        Ok(BrowserAttempt {
            code: self.start_code(provider, method, &redirect)?,
            listener: Some(listener),
        })
    }

    pub fn start_cursor(&self, website: &str, now: i64) -> Result<CursorAttempt, Error> {
        let mut url = Url::parse(website).map_err(|_| Error::Rejected)?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(Error::Rejected);
        }
        url.set_path("/loginDeepControl");
        url.set_query(None);
        url.set_fragment(None);
        let verifier = base64(&random_bytes(32)?);
        let challenge = base64(digest::digest(&digest::SHA256, verifier.as_bytes()).as_ref());
        let mut bytes = random_bytes(16)?;
        bytes[6] = bytes[6] & 15 | 64;
        bytes[8] = bytes[8] & 63 | 128;
        let uuid = bytes
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
            .collect::<String>();
        url.query_pairs_mut().extend_pairs([
            ("challenge", challenge.as_str()),
            ("uuid", uuid.as_str()),
            ("mode", "login"),
            ("redirectTarget", "cli"),
        ]);
        Ok(CursorAttempt {
            client: self.clone(),
            url: url.into(),
            uuid,
            verifier,
            next_poll: now.saturating_add(1000),
            attempts: 0,
            failures: 0,
            status: Status::Pending,
        })
    }

    pub async fn start_device(&self, flow: DeviceFlow, now: i64) -> Result<DeviceAttempt, Error> {
        let request = match &flow {
            DeviceFlow::Openai => self.json(
                "/api/accounts/deviceauth/usercode",
                json!({"client_id":OPENAI_CLIENT}),
            ),
            DeviceFlow::Muse => self.form(
                "/oidc/device/authorization/",
                &[("client_id", muse::CLIENT_ID)],
            ),
        };
        let (status, value) = self.send(request).await?;
        if !status.is_success() {
            return Err(Error::Rejected);
        }
        let (url, instructions, code, user_code, interval, expires) = match &flow {
            DeviceFlow::Muse => {
                let uri = string(&value, "verification_uri")?;
                let user = string(&value, "user_code")?;
                let expires = number(&value, "expires_in").ok_or(Error::Rejected)?;
                (
                    value
                        .get("verification_uri_complete")
                        .and_then(Value::as_str)
                        .unwrap_or(uri)
                        .into(),
                    format!("Enter code: {user}"),
                    string(&value, "device_code")?.into(),
                    user.into(),
                    number(&value, "interval")
                        .filter(|n| n.is_finite() && *n > 0.0)
                        .unwrap_or(5.0)
                        * 1000.0,
                    now.saturating_add((expires * 1000.0) as i64),
                )
            }
            DeviceFlow::Openai => {
                let user = string(&value, "user_code")?;
                let interval = value
                    .get("interval")
                    .and_then(Value::as_str)
                    .and_then(|v| v.trim_start().split(|c: char| !c.is_ascii_digit()).next())
                    .and_then(|v| v.parse::<i64>().ok())
                    .filter(|v| *v != 0)
                    .unwrap_or(5)
                    .max(1);
                (
                    format!("{}/codex/device", self.endpoint),
                    format!("Enter code: {user}"),
                    string(&value, "device_auth_id")?.into(),
                    user.into(),
                    interval as f64 * 1000.0,
                    now.saturating_add(600_000),
                )
            }
        };
        Ok(DeviceAttempt {
            client: self.clone(),
            flow,
            url,
            instructions,
            code,
            user_code,
            interval: interval as i64,
            expires,
            next_poll: now,
            status: Status::Pending,
        })
    }

    pub fn start_code(
        &self,
        provider: &str,
        method: &str,
        redirect: &str,
    ) -> Result<CodeAttempt, Error> {
        if (provider, method) != ("openai", "chatgpt-browser") {
            return Err(Error::Rejected);
        }
        let redirect_url = Url::parse(redirect).map_err(|_| Error::Rejected)?;
        if redirect_url.scheme() != "http"
            || !matches!(redirect_url.host_str(), Some("localhost" | "127.0.0.1"))
            || !redirect_url.username().is_empty()
            || redirect_url.password().is_some()
        {
            return Err(Error::Rejected);
        }
        let verifier = random_string(43)?;
        let state = base64(&random_bytes(32)?);
        let challenge = base64(digest::digest(&digest::SHA256, verifier.as_bytes()).as_ref());
        let mut url = Url::parse(&format!("{}/oauth/authorize", self.endpoint))
            .map_err(|_| Error::Rejected)?;
        url.query_pairs_mut().extend_pairs([
            ("response_type", "code"),
            ("client_id", OPENAI_CLIENT),
            ("redirect_uri", redirect),
            ("scope", "openid profile email offline_access"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("state", &state),
        ]);
        url.query_pairs_mut().extend_pairs([
            ("id_token_add_organizations", "true"),
            ("codex_cli_simplified_flow", "true"),
            ("originator", "ycoding"),
        ]);
        Ok(CodeAttempt {
            client: self.clone(),
            provider: provider.into(),
            method: method.into(),
            redirect: redirect.into(),
            verifier,
            state,
            url: url.into(),
            status: Status::Pending,
        })
    }

    pub async fn prepare(&self, service: &Service, stored: Info, now: i64) -> Result<Info, Error> {
        let stored = service.current_account(&stored)?;
        let credential::Value::OAuth(value) = stored
            .secret()
            .domain()
            .map_err(|_| Error::InvalidCredential)?
        else {
            return Ok(stored);
        };
        if !stored.needs_refresh(now)? {
            return Ok(stored);
        }
        let integration = stored
            .integration_id()
            .as_str()
            .ok_or(Error::InvalidCredential)?;
        if integration == "muse" {
            return if value.expires.get() == 0 || value.expires.get() > now {
                Ok(stored)
            } else {
                Err(Error::ProfileUnavailable)
            };
        }
        if !matches!(integration, "openai" | "cursor") {
            return Err(Error::Rejected);
        }
        let client = self.clone();
        let integration = integration.to_owned();
        service
            .refresh(stored, now, async move {
                client.refresh(&integration, value, now).await
            })
            .await?
            .ok_or(Error::ProfileUnavailable)
    }

    pub async fn prepare_value(
        &self,
        service: &Service,
        stored: Info,
        now: i64,
        claude: Option<&claude::Store>,
        cursor: Option<&cursor::Store>,
    ) -> Result<Secret, Error> {
        let stored = self.prepare(service, stored, now).await?;
        let value = stored
            .secret()
            .domain()
            .map_err(|_| Error::InvalidCredential)?;
        if stored.integration_id().as_str() == Some("anthropic")
            && let credential::Value::OAuth(value) = &value
            && value.method_id.as_lossless().as_str() == Some("claude-code")
        {
            let metadata = value.metadata.as_ref().ok_or(Error::ProfileUnavailable)?;
            if metadata.get(&"authKind".into()) != Some(&JsonValue::String("claude-code".into()))
                || metadata.get(&"managed".into()) != Some(&JsonValue::Bool(true))
                || metadata.get(&"requiresLogin".into()) == Some(&JsonValue::Bool(true))
                || value.expires.get() != 9_007_199_254_740_991
                || metadata.get(&"source".into()) != Some(&JsonValue::String(value.access.clone()))
            {
                return Err(Error::ProfileUnavailable);
            }
            let source = value.access.as_str().ok_or(Error::ProfileUnavailable)?;
            let resolved = claude
                .ok_or(Error::ProfileUnavailable)?
                .resolve(source, now, false)
                .await?
                .ok_or(Error::ProfileUnavailable)?;
            service.current_account(&stored)?;
            return oauth_secret(
                "claude-code",
                &resolved.access_token,
                &resolved.refresh_token,
                resolved.expires_at,
                value.metadata.clone(),
            );
        }
        if stored.integration_id().as_str() == Some("cursor") {
            let (access, key) = match &value {
                credential::Value::Key(value) => (None, value.key.as_str()),
                credential::Value::OAuth(value) => (value.access.as_str(), None),
            };
            let token = match cursor {
                Some(cursor) => cursor.resolve(access, key, now).await?,
                None => access
                    .or_else(|| key.filter(|key| !key.starts_with("crsr_")))
                    .filter(|token| !token.trim().is_empty())
                    .ok_or(Error::InvalidCredential)?
                    .to_owned(),
            };
            service.current_account(&stored)?;
            return Secret::new(
                credential::Value::Key(credential::Key {
                    key: token.into(),
                    metadata: None,
                })
                .encode(),
            )
            .map_err(|_| Error::InvalidCredential);
        }
        Ok(stored.secret().clone())
    }

    async fn refresh(
        &self,
        provider: &str,
        value: credential::OAuth,
        now: i64,
    ) -> Result<Secret, Error> {
        let refresh = value.refresh.as_str().ok_or(Error::InvalidCredential)?;
        if provider == "cursor" {
            let (status, tokens) = self
                .send(
                    self.json("/auth/token", json!({"refreshToken":refresh}))
                        .timeout(Duration::from_secs(5)),
                )
                .await?;
            if !status.is_success() {
                return Err(Error::Rejected);
            }
            return cursor_secret(&tokens);
        }
        let (status, tokens) = self
            .send(self.form(
                "/oauth/token",
                &[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", refresh),
                    ("client_id", OPENAI_CLIENT),
                ],
            ))
            .await?;
        if !status.is_success() {
            return Err(Error::Rejected);
        }
        token_secret(
            provider,
            value
                .method_id
                .as_lossless()
                .as_str()
                .ok_or(Error::InvalidCredential)?,
            &tokens,
            now,
            Some(&value),
        )
    }

    fn json(&self, path: &str, value: Value) -> reqwest::RequestBuilder {
        self.http
            .post(format!("{}{path}", self.endpoint))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .header("User-Agent", &self.user_agent)
            .body(value.to_string())
    }
    fn form(&self, path: &str, pairs: &[(&str, &str)]) -> reqwest::RequestBuilder {
        self.http
            .post(format!("{}{path}", self.endpoint))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Accept", "application/json")
            .header("User-Agent", &self.user_agent)
            .body(
                url::form_urlencoded::Serializer::new(String::new())
                    .extend_pairs(pairs.iter().copied())
                    .finish(),
            )
    }
    async fn send(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<(reqwest::StatusCode, Value), Error> {
        let response = request.send().await.map_err(|_| Error::UnknownOutcome)?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(|_| Error::UnknownOutcome)?;
        let value = serde_json::from_slice(&bytes).map_err(|_| {
            if status.is_success() {
                Error::UnknownOutcome
            } else {
                Error::Rejected
            }
        })?;
        Ok((status, value))
    }
}

struct EnrollmentState {
    status: Status,
    persisting: bool,
    result: Option<Result<Info, Error>>,
}
pub struct Enrollment {
    url: String,
    instructions: String,
    receiver: tokio::sync::watch::Receiver<EnrollmentState>,
    task: Option<tokio::task::JoinHandle<()>>,
    cancelled: bool,
}
impl fmt::Debug for Enrollment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Enrollment([redacted])")
    }
}
impl Enrollment {
    pub fn url(&self) -> &str {
        &self.url
    }
    pub fn instructions(&self) -> &str {
        &self.instructions
    }
    pub fn status(&self) -> Status {
        if self.cancelled {
            Status::Cancelled
        } else {
            self.receiver.borrow().status
        }
    }
    pub async fn wait(&mut self) -> Result<Info, Error> {
        if self.cancelled {
            return Err(Error::Rejected);
        }
        loop {
            let result = self.receiver.borrow_and_update().result.clone();
            if let Some(result) = result {
                if let Some(task) = self.task.take() {
                    task.await.map_err(|_| Error::UnknownOutcome)?;
                }
                return result;
            }
            self.receiver
                .changed()
                .await
                .map_err(|_| Error::UnknownOutcome)?;
        }
    }
    pub async fn cancel(&mut self) -> Result<(), Error> {
        if self.receiver.borrow().persisting || self.status() != Status::Pending {
            return Ok(());
        }
        if let Some(task) = self.task.take() {
            task.abort();
            if let Err(error) = task.await
                && !error.is_cancelled()
            {
                return Err(Error::UnknownOutcome);
            }
        }
        self.cancelled = true;
        Ok(())
    }
}
impl Drop for Enrollment {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
async fn drive_device(attempt: &mut DeviceAttempt) -> Result<Secret, Error> {
    loop {
        let time = now()?;
        let remaining = attempt.expires.saturating_sub(time).max(0) as u64;
        let poll = tokio::time::timeout(Duration::from_millis(remaining), attempt.poll(time)).await;
        match poll {
            Ok(Ok(Poll::Complete(secret))) => return Ok(secret),
            Ok(Ok(Poll::WaitUntil(next))) => {
                tokio::time::sleep(Duration::from_millis(
                    next.min(attempt.expires).saturating_sub(now()?).max(0) as u64,
                ))
                .await
            }
            Ok(Err(error)) => return Err(error),
            Err(_) if attempt.status == Status::UnknownOutcome => {
                return Err(Error::UnknownOutcome);
            }
            Err(_) => {
                attempt.status = Status::Expired;
                return Err(Error::Rejected);
            }
        }
    }
}

pub struct BrowserAttempt {
    code: CodeAttempt,
    listener: Option<tokio::net::TcpListener>,
}
impl fmt::Debug for BrowserAttempt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("BrowserAttempt([redacted])")
    }
}
impl BrowserAttempt {
    pub fn url(&self) -> &str {
        self.code.url()
    }
    pub fn status(&self) -> Status {
        self.code.status()
    }
    pub fn cancel(&mut self) {
        self.code.cancel();
        self.listener.take();
    }
    pub async fn wait(&mut self) -> Result<Secret, Error> {
        let Some(listener) = self.listener.take() else {
            return Err(Error::Rejected);
        };
        let result =
            tokio::time::timeout(Duration::from_secs(600), self.accept_callback(listener)).await;
        match result {
            Ok(result) => result,
            Err(_) if self.code.status == Status::UnknownOutcome => Err(Error::UnknownOutcome),
            Err(_) => {
                self.code.status = Status::Expired;
                Err(Error::Rejected)
            }
        }
    }
    async fn accept_callback(
        &mut self,
        listener: tokio::net::TcpListener,
    ) -> Result<Secret, Error> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        loop {
            let (mut stream, _) = listener.accept().await.map_err(|_| Error::Rejected)?;
            let mut request = Vec::new();
            loop {
                let mut bytes = [0; 1024];
                let count = stream.read(&mut bytes).await.map_err(|_| Error::Rejected)?;
                request.extend_from_slice(&bytes[..count]);
                if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    break;
                }
                if count == 0 || request.len() > 16_384 {
                    return Err(Error::Rejected);
                }
            }
            let request = std::str::from_utf8(&request).map_err(|_| Error::Rejected)?;
            let mut line = request
                .lines()
                .next()
                .ok_or(Error::Rejected)?
                .split_whitespace();
            line.next().ok_or(Error::Rejected)?;
            let path = line.next().ok_or(Error::Rejected)?;
            let redirect = Url::parse(&self.code.redirect).map_err(|_| Error::Rejected)?;
            let callback = redirect.join(path).map_err(|_| Error::Rejected)?;
            if callback.path() != redirect.path() {
                stream
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await
                    .map_err(|_| Error::Rejected)?;
                continue;
            }
            let valid = callback.origin() == redirect.origin()
                && callback
                    .query_pairs()
                    .any(|(name, value)| name == "state" && value == self.code.state)
                && callback
                    .query_pairs()
                    .any(|(name, value)| name == "code" && !value.is_empty())
                && !callback
                    .query_pairs()
                    .any(|(name, _)| matches!(name.as_ref(), "error" | "error_description"));
            let response = if valid { "200 OK" } else { "400 Bad Request" };
            let provider = if self.code.provider == "openai" {
                "ChatGPT"
            } else {
                "xAI"
            };
            let html = if valid {
                page::success(Some(provider), true)
            } else {
                page::error(
                    "Authorization failed. Check the authorization code and state.",
                    Some(provider),
                )
            };
            stream.write_all(format!("HTTP/1.1 {response}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}", html.len()).as_bytes()).await.map_err(|_| Error::Rejected)?;
            return self.code.complete(callback.as_str(), now()?).await;
        }
    }
}

pub struct DeviceAttempt {
    client: Client,
    flow: DeviceFlow,
    url: String,
    instructions: String,
    code: String,
    user_code: String,
    interval: i64,
    expires: i64,
    next_poll: i64,
    status: Status,
}
impl fmt::Debug for DeviceAttempt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DeviceAttempt([redacted])")
    }
}
impl DeviceAttempt {
    pub fn url(&self) -> &str {
        &self.url
    }
    pub fn instructions(&self) -> &str {
        &self.instructions
    }
    pub fn status(&self) -> Status {
        self.status
    }
    pub fn expires_at(&self) -> i64 {
        self.expires
    }
    pub fn cancel(&mut self) {
        if self.status == Status::Pending {
            self.status = Status::Cancelled;
        }
    }
    pub async fn poll(&mut self, now: i64) -> Result<Poll, Error> {
        if self.status == Status::UnknownOutcome {
            return Err(Error::UnknownOutcome);
        }
        if self.status != Status::Pending {
            return Err(Error::Rejected);
        }
        if now >= self.expires {
            self.status = Status::Expired;
            return Err(Error::Rejected);
        }
        if now < self.next_poll {
            return Ok(Poll::WaitUntil(self.next_poll));
        }
        self.status = Status::UnknownOutcome;
        let result = self.poll_request(now).await;
        match &result {
            Ok(Poll::Complete(_)) => self.status = Status::Complete,
            Ok(Poll::WaitUntil(_)) => self.status = Status::Pending,
            Err(Error::UnknownOutcome) => {}
            Err(_) if self.status == Status::UnknownOutcome => self.status = Status::Failed,
            Err(_) => {}
        }
        result
    }
    async fn poll_request(&mut self, now: i64) -> Result<Poll, Error> {
        let request = match &self.flow {
            DeviceFlow::Openai => self.client.json(
                "/api/accounts/deviceauth/token",
                json!({"device_auth_id":self.code,"user_code":self.user_code}),
            ),
            DeviceFlow::Muse => self.client.form(
                "/oidc/device/token/",
                &[
                    ("grant_type", DEVICE_GRANT),
                    ("device_code", &self.code),
                    ("client_id", muse::CLIENT_ID),
                ],
            ),
        };
        let (status, tokens) = self.client.send(request).await?;
        if matches!(self.flow, DeviceFlow::Muse)
            && status.is_success()
            && tokens
                .get("access_token")
                .and_then(Value::as_str)
                .is_some_and(|v| !v.is_empty())
        {
            let refresh = match tokens.get("refresh_token") {
                None => "",
                Some(value) => value.as_str().ok_or(Error::Rejected)?,
            };
            let expires = match tokens.get("expires_in") {
                None => 0,
                Some(value) => {
                    let seconds = value
                        .as_f64()
                        .filter(|v| v.is_finite())
                        .ok_or(Error::Rejected)?;
                    NonNegativeInt::decode(&JsonValue::Number(now as f64 + seconds * 1000.0))
                        .map_err(|_| Error::Rejected)?
                        .get()
                }
            };
            return Ok(Poll::Complete(oauth_secret(
                "device",
                string(&tokens, "access_token")?,
                refresh,
                expires,
                None,
            )?));
        }
        if matches!(self.flow, DeviceFlow::Openai) {
            if status.is_success() {
                let (status, tokens) = self
                    .client
                    .send(self.client.form(
                        "/oauth/token",
                        &[
                            ("grant_type", "authorization_code"),
                            ("code", string(&tokens, "authorization_code")?),
                            ("code_verifier", string(&tokens, "code_verifier")?),
                            (
                                "redirect_uri",
                                &format!("{}/deviceauth/callback", self.client.endpoint),
                            ),
                            ("client_id", OPENAI_CLIENT),
                        ],
                    ))
                    .await?;
                if !status.is_success() {
                    return Err(Error::Rejected);
                }
                return Ok(Poll::Complete(token_secret(
                    "openai",
                    "chatgpt-headless",
                    &tokens,
                    now,
                    None,
                )?));
            }
            if matches!(status.as_u16(), 403 | 404) {
                return Ok(self.wait(now));
            }
            return Err(Error::Rejected);
        }
        match tokens.get("error").and_then(Value::as_str) {
            Some("authorization_pending") => Ok(self.wait(now)),
            Some("slow_down") => {
                self.interval = self.interval.saturating_add(5000);
                Ok(self.wait(now))
            }
            Some("access_denied" | "authorization_denied") => {
                self.status = Status::Denied;
                Err(Error::Rejected)
            }
            Some("expired_token") => {
                self.status = Status::Expired;
                Err(Error::Rejected)
            }
            _ => Err(Error::Rejected),
        }
    }
    fn wait(&mut self, now: i64) -> Poll {
        self.next_poll = if matches!(self.flow, DeviceFlow::Muse) {
            now.saturating_add(self.interval).min(self.expires)
        } else {
            now.saturating_add(self.interval).saturating_add(3000)
        };
        Poll::WaitUntil(self.next_poll)
    }
}

pub struct CodeAttempt {
    client: Client,
    provider: String,
    method: String,
    redirect: String,
    verifier: String,
    state: String,
    url: String,
    status: Status,
}

pub struct CursorAttempt {
    client: Client,
    url: String,
    uuid: String,
    verifier: String,
    next_poll: i64,
    attempts: i32,
    failures: u8,
    status: Status,
}
impl fmt::Debug for CursorAttempt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CursorAttempt([redacted])")
    }
}
impl CursorAttempt {
    pub fn url(&self) -> &str {
        &self.url
    }
    pub fn status(&self) -> Status {
        self.status
    }
    pub fn cancel(&mut self) {
        if self.status == Status::Pending {
            self.status = Status::Cancelled;
        }
    }
    pub async fn poll(&mut self, now: i64) -> Result<Poll, Error> {
        if self.status == Status::UnknownOutcome {
            return Err(Error::UnknownOutcome);
        }
        if self.status != Status::Pending {
            return Err(Error::Rejected);
        }
        if self.attempts >= 150 {
            self.status = Status::Expired;
            return Err(Error::Rejected);
        }
        if now < self.next_poll {
            return Ok(Poll::WaitUntil(self.next_poll));
        }
        let mut url = Url::parse(&format!("{}/auth/poll", self.client.endpoint))
            .map_err(|_| Error::Rejected)?;
        url.query_pairs_mut().extend_pairs([
            ("uuid", self.uuid.as_str()),
            ("verifier", self.verifier.as_str()),
        ]);
        self.status = Status::UnknownOutcome;
        self.attempts += 1;
        let response = self
            .client
            .http
            .get(url)
            .send()
            .await
            .map_err(|_| Error::UnknownOutcome)?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            self.failures = 0;
        } else if status.is_success() {
            let bytes = response.bytes().await.map_err(|_| Error::UnknownOutcome)?;
            let tokens: Value =
                serde_json::from_slice(&bytes).map_err(|_| Error::UnknownOutcome)?;
            if tokens
                .get("accessToken")
                .and_then(Value::as_str)
                .is_some_and(|v| !v.is_empty())
                && tokens
                    .get("refreshToken")
                    .and_then(Value::as_str)
                    .is_some_and(|v| !v.is_empty())
            {
                let secret = cursor_secret(&tokens)?;
                self.status = Status::Complete;
                return Ok(Poll::Complete(secret));
            }
            self.failures += 1;
        } else {
            self.failures += 1;
        }
        if self.failures >= 3 {
            self.status = Status::Failed;
            return Err(Error::Rejected);
        }
        self.status = Status::Pending;
        self.next_poll =
            now.saturating_add((1000.0 * 1.2_f64.powi(self.attempts)).min(10_000.0) as i64);
        Ok(Poll::WaitUntil(self.next_poll))
    }
}

pub struct ManualAttempt<C> {
    service: Service,
    integration: LosslessString,
    label: Option<LosslessString>,
    url: String,
    instructions: String,
    callback: Option<C>,
    status: Status,
    expires: Instant,
}
impl<C> fmt::Debug for ManualAttempt<C> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ManualAttempt([redacted])")
    }
}
impl<C, F> ManualAttempt<C>
where
    C: FnOnce(String) -> F,
    F: Future<Output = Result<Secret, Error>>,
{
    pub fn new(
        service: Service,
        integration: LosslessString,
        label: Option<LosslessString>,
        url: String,
        instructions: String,
        callback: C,
    ) -> Self {
        Self {
            service,
            integration,
            label,
            url,
            instructions,
            callback: Some(callback),
            status: Status::Pending,
            expires: Instant::now() + Duration::from_secs(600),
        }
    }
    pub fn url(&self) -> &str {
        &self.url
    }
    pub fn instructions(&self) -> &str {
        &self.instructions
    }
    pub fn status(&self) -> Status {
        self.status
    }
    pub fn cancel(&mut self, integration: &LosslessString) {
        if &self.integration == integration && self.status == Status::Pending {
            self.status = Status::Cancelled;
            self.callback.take();
        }
    }
    pub async fn complete(
        &mut self,
        integration: &LosslessString,
        code: Option<String>,
    ) -> Result<(), Error> {
        if &self.integration != integration {
            return Err(Error::Rejected);
        }
        if self.status == Status::UnknownOutcome {
            return Err(Error::UnknownOutcome);
        }
        if self.status == Status::Complete
            || self.status == Status::Failed
            || self.status == Status::Expired
        {
            return Ok(());
        }
        if self.status != Status::Pending {
            return Err(Error::Rejected);
        }
        if Instant::now() >= self.expires {
            self.status = Status::Expired;
            self.callback.take();
            return Ok(());
        }
        let code = code.ok_or(Error::CodeRequired)?;
        let callback = self.callback.take().ok_or(Error::Rejected)?;
        self.status = Status::UnknownOutcome;
        let secret = match callback(code).await {
            Ok(secret) => secret,
            Err(error) => {
                self.status = if error == Error::UnknownOutcome {
                    Status::UnknownOutcome
                } else {
                    Status::Failed
                };
                return Err(error);
            }
        };
        if !matches!(
            secret.domain().map_err(|_| Error::InvalidCredential)?,
            credential::Value::OAuth(_)
        ) {
            self.status = Status::Failed;
            return Err(Error::InvalidCredential);
        }
        let result = self
            .service
            .create(
                credential_id()?,
                self.integration.clone(),
                self.label.clone(),
                secret,
                now()?,
            )
            .await;
        self.status = match &result {
            Ok(_) => Status::Complete,
            Err(Error::UnknownOutcome) => Status::UnknownOutcome,
            Err(_) => Status::Failed,
        };
        result.map(|_| ())
    }
}
impl fmt::Debug for CodeAttempt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CodeAttempt([redacted])")
    }
}
impl CodeAttempt {
    pub fn url(&self) -> &str {
        &self.url
    }
    pub fn status(&self) -> Status {
        self.status
    }
    pub fn cancel(&mut self) {
        if self.status == Status::Pending {
            self.status = Status::Cancelled;
        }
    }
    pub async fn complete(&mut self, callback: &str, now: i64) -> Result<Secret, Error> {
        if self.status == Status::UnknownOutcome {
            return Err(Error::UnknownOutcome);
        }
        if self.status != Status::Pending {
            return Err(Error::Rejected);
        }
        let url = Url::parse(callback).map_err(|_| Error::Rejected)?;
        let code = url
            .query_pairs()
            .find(|(name, _)| name == "code")
            .map(|(_, value)| value.into_owned());
        let state = url
            .query_pairs()
            .find(|(name, _)| name == "state")
            .map(|(_, value)| value.into_owned());
        let redirect = Url::parse(&self.redirect).map_err(|_| Error::Rejected)?;
        if url.origin() != redirect.origin()
            || url.path() != redirect.path()
            || state.as_deref() != Some(&self.state)
            || code.as_ref().is_none_or(String::is_empty)
            || url
                .query_pairs()
                .any(|(name, _)| matches!(name.as_ref(), "error" | "error_description"))
        {
            self.status = Status::Failed;
            return Err(Error::Rejected);
        }
        self.status = Status::UnknownOutcome;
        let result = self
            .exchange(code.as_deref().ok_or(Error::Rejected)?, now)
            .await;
        self.status = match result {
            Ok(_) => Status::Complete,
            Err(Error::UnknownOutcome) => Status::UnknownOutcome,
            Err(_) => Status::Failed,
        };
        result
    }
    async fn exchange(&self, code: &str, now: i64) -> Result<Secret, Error> {
        let (status, tokens) = self
            .client
            .send(self.client.form(
                "/oauth/token",
                &[
                    ("grant_type", "authorization_code"),
                    ("code", code),
                    ("redirect_uri", &self.redirect),
                    ("client_id", OPENAI_CLIENT),
                    ("code_verifier", &self.verifier),
                ],
            ))
            .await?;
        if !status.is_success() {
            return Err(Error::Rejected);
        }
        token_secret(&self.provider, &self.method, &tokens, now, None)
    }
}

fn token_secret(
    provider: &str,
    method: &str,
    tokens: &Value,
    now: i64,
    current: Option<&credential::OAuth>,
) -> Result<Secret, Error> {
    let access = string(tokens, "access_token").map_err(|_| Error::UnknownOutcome)?;
    let refresh = tokens
        .get("refresh_token")
        .and_then(Value::as_str)
        .ok_or(Error::UnknownOutcome)?;
    let seconds = match tokens.get("expires_in") {
        None => None,
        Some(Value::Null) if provider == "openai" => None,
        Some(Value::Number(value)) => Some(value.as_f64().ok_or(Error::UnknownOutcome)?),
        Some(Value::String(value)) if provider == "openai" => {
            let value = value
                .trim_matches(|c: char| c == '\u{feff}' || c.is_whitespace() && c != '\u{0085}');
            let seconds = if value.is_empty() {
                0.0
            } else if let Some(value) = value
                .strip_prefix("0x")
                .or_else(|| value.strip_prefix("0X"))
            {
                u64::from_str_radix(value, 16).map_err(|_| Error::UnknownOutcome)? as f64
            } else if let Some(value) = value
                .strip_prefix("0o")
                .or_else(|| value.strip_prefix("0O"))
            {
                u64::from_str_radix(value, 8).map_err(|_| Error::UnknownOutcome)? as f64
            } else if let Some(value) = value
                .strip_prefix("0b")
                .or_else(|| value.strip_prefix("0B"))
            {
                u64::from_str_radix(value, 2).map_err(|_| Error::UnknownOutcome)? as f64
            } else {
                value.parse::<f64>().map_err(|_| Error::UnknownOutcome)?
            };
            Some(seconds)
        }
        _ => return Err(Error::UnknownOutcome),
    };
    let expires = if provider == "openai" {
        now as f64 + seconds.unwrap_or(3600.0) * 1000.0
    } else if seconds.is_some_and(|value| value != 0.0) {
        now as f64
            + seconds
                .filter(|value| value.is_finite() && *value > 0.0)
                .unwrap_or(3600.0)
                * 1000.0
    } else {
        jwt(access)
            .and_then(|value| number(&value, "exp"))
            .filter(|value| *value != 0.0)
            .map(|value| value * 1000.0)
            .unwrap_or(now as f64 + 3_600_000.0)
    };
    let expires = NonNegativeInt::decode(&JsonValue::Number(expires))
        .map_err(|_| Error::UnknownOutcome)?
        .get();
    let metadata = if provider == "openai" {
        tokens
            .get("id_token")
            .and_then(Value::as_str)
            .and_then(account_claim)
            .or_else(|| account_claim(access))
            .filter(|account| !account.is_empty())
            .map(|account| {
                let mut metadata = JsonObject::new();
                metadata.insert("accountID".into(), JsonValue::String(account.into()));
                metadata
            })
            .or_else(|| current.and_then(|value| value.metadata.clone()))
    } else {
        current.and_then(|value| value.metadata.clone())
    };
    oauth_secret(method, access, refresh, expires, metadata).map_err(|_| Error::UnknownOutcome)
}
fn oauth_secret(
    method: &str,
    access: &str,
    refresh: &str,
    expires: i64,
    metadata: Option<JsonObject>,
) -> Result<Secret, Error> {
    Secret::new(
        credential::Value::OAuth(credential::OAuth {
            method_id: IntegrationMethodId::new(method).map_err(|_| Error::InvalidCredential)?,
            access: access.into(),
            refresh: refresh.into(),
            expires: NonNegativeInt::new(expires).map_err(|_| Error::InvalidCredential)?,
            metadata,
        })
        .encode(),
    )
    .map_err(|_| Error::InvalidCredential)
}
fn cursor_secret(tokens: &Value) -> Result<Secret, Error> {
    let access = string(tokens, "accessToken").map_err(|_| Error::UnknownOutcome)?;
    let expires = jwt(access)
        .and_then(|value| number(&value, "exp"))
        .map(|value| value * 1000.0)
        .unwrap_or(0.0);
    let expires = NonNegativeInt::decode(&JsonValue::Number(expires))
        .map_err(|_| Error::UnknownOutcome)?
        .get();
    oauth_secret(
        "browser",
        access,
        string(tokens, "refreshToken").map_err(|_| Error::UnknownOutcome)?,
        expires,
        None,
    )
    .map_err(|_| Error::UnknownOutcome)
}
fn string<'a>(value: &'a Value, field: &str) -> Result<&'a str, Error> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or(Error::InvalidCredential)
}
fn number(value: &Value, field: &str) -> Option<f64> {
    value
        .get(field)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}
fn account_claim(token: &str) -> Option<String> {
    let value = jwt(token)?;
    if value
        .get("chatgpt_account_id")
        .is_some_and(|value| !value.is_string())
        || value.get("organizations").is_some_and(|value| {
            value.as_array().is_none_or(|organizations| {
                organizations
                    .iter()
                    .any(|organization| organization.get("id").is_none_or(|id| !id.is_string()))
            })
        })
        || value
            .get("https://api.openai.com/auth")
            .is_some_and(|value| {
                value.as_object().is_none_or(|auth| {
                    auth.get("chatgpt_account_id")
                        .is_some_and(|value| !value.is_string())
                })
            })
    {
        return None;
    }
    value
        .get("chatgpt_account_id")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("https://api.openai.com/auth")?
                .get("chatgpt_account_id")?
                .as_str()
        })
        .or_else(|| {
            value
                .get("organizations")?
                .as_array()?
                .first()?
                .get("id")?
                .as_str()
        })
        .map(str::to_owned)
}
fn jwt(token: &str) -> Option<Value> {
    let bytes = decode_base64(token.split('.').nth(1)?)?;
    serde_json::from_slice(&bytes).ok().filter(Value::is_object)
}
const BASE64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
fn base64(bytes: &[u8]) -> String {
    let mut output = String::new();
    for chunk in bytes.chunks(3) {
        let bits = chunk
            .iter()
            .fold(0_u32, |bits, byte| bits << 8 | u32::from(*byte))
            << (8 * (3 - chunk.len()));
        for shift in (0..chunk.len() + 1).map(|index| 18 - 6 * index) {
            output.push(BASE64[((bits >> shift) & 63) as usize] as char);
        }
    }
    output
}
fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut bits = 0_u32;
    let mut count = 0;
    for byte in text.bytes().take_while(|byte| *byte != b'=') {
        let value = match byte {
            b'+' => 62,
            b'/' => 63,
            _ => BASE64.iter().position(|candidate| *candidate == byte)? as u32,
        };
        bits = bits << 6 | value;
        count += 6;
        if count >= 8 {
            count -= 8;
            bytes.push((bits >> count) as u8);
        }
    }
    Some(bytes)
}
fn random_bytes(length: usize) -> Result<Vec<u8>, Error> {
    let mut bytes = vec![0; length];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| Error::Rejected)?;
    Ok(bytes)
}
fn random_string(length: usize) -> Result<String, Error> {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    Ok(random_bytes(length)?
        .into_iter()
        .map(|byte| alphabet[usize::from(byte) % alphabet.len()] as char)
        .collect())
}
fn now() -> Result<i64, Error> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Error::Rejected)?
        .as_millis()
        .try_into()
        .map_err(|_| Error::Rejected)
}
fn credential_id() -> Result<LosslessString, Error> {
    static GENERATOR: LazyLock<Mutex<ycoding_schema::identifier::Generator>> =
        LazyLock::new(|| Mutex::new(ycoding_schema::identifier::Generator::default()));
    let entropy: [u8; 14] = random_bytes(14)?.try_into().map_err(|_| Error::Rejected)?;
    let suffix = GENERATOR
        .lock()
        .map_err(|_| Error::Rejected)?
        .ascending(now()? as f64, entropy)
        .map_err(|_| Error::Rejected)?;
    Ok(format!("cred_{}", suffix.as_str().ok_or(Error::Rejected)?).into())
}
