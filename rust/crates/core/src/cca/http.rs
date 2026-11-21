use super::{
    encoding::{ascii_lower, base64_encode, percent_decode},
    error::{AuthorizationInput, AuthorizeFn, BoxFuture, ExecutorError, Grant},
    signal::Signal,
    value::{JsonObject, LosslessString, Value, ascii_lower as lower_units, concat, join, os_text},
};
use std::{
    collections::BTreeSet,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};
use tokio::sync::watch;
use url::Url;

pub const NETWORK_ACTION: &str = "webfetch";
pub const MAX_BODY_DELTA_BYTES: usize = 1024 * 1024;
pub const MAX_REDIRECTS: usize = 10;
pub const HEADER_ENV_DENYLIST: [&str; 15] = [
    "CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN",
    "OPENAI_FEDERATION_RULE_ID",
    "OPENAI_IDENTITY_TOKEN_FILE",
    "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
    "OPENAI_API_KEY",
    "CODEX_GUARDIAN_DECISIONS_API_KEY",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "CODEX_CONNECTORS_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AZURE_CLIENT_SECRET",
    "AZURE_FEDERATED_TOKEN_FILE",
    "GOOGLE_APPLICATION_CREDENTIALS",
];
const BODY_ERROR: &str = "error decoding response body";
const BODY_HEADERS: [&str; 4] = [
    "transfer-encoding",
    "content-encoding",
    "content-type",
    "content-length",
];
const SENSITIVE_HEADERS: [&str; 5] = [
    "authorization",
    "cookie",
    "cookie2",
    "proxy-authorization",
    "www-authenticate",
];
const SPECIAL_SCHEMES: [&str; 6] = ["http", "https", "ws", "wss", "ftp", "file"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpHeader {
    pub name: LosslessString,
    pub value: LosslessString,
    pub value_env_var: Option<LosslessString>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RedirectPolicy {
    Follow,
    Stop,
}
#[derive(Clone, Debug)]
pub struct HttpRequestParams {
    pub method: LosslessString,
    pub url: LosslessString,
    pub headers: Vec<HttpHeader>,
    pub body: Option<Vec<u8>>,
    pub timeout_ms: Option<u64>,
    pub redirect_policy: RedirectPolicy,
    pub request_id: LosslessString,
    pub stream_response: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<HttpHeader>,
    pub body: Vec<u8>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BodyDelta {
    pub request_id: LosslessString,
    pub seq: u64,
    pub delta: Vec<u8>,
    pub done: bool,
    pub error: Option<String>,
}
pub type Emit = Arc<dyn Fn(BodyDelta) -> BoxFuture<'static, Result<(), ()>> + Send + Sync>;

#[derive(Clone)]
pub struct HttpRequestContext {
    pub signal: Signal,
    pub emit: Emit,
}

pub struct HttpOutcome {
    pub response: HttpResponse,
    pub stream: Option<HttpBodyStream>,
}

fn invalid_params(message: impl Into<LosslessString>) -> ExecutorError {
    ExecutorError::new(-32602, message)
}
fn internal_error(message: impl Into<LosslessString>) -> ExecutorError {
    ExecutorError::new(-32603, message)
}

fn is_token(text: &str) -> bool {
    !text.is_empty()
        && text.chars().all(|character| {
            character.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(character)
        })
}
fn visible_header_value(text: &str) -> bool {
    text.chars()
        .all(|character| character == '\t' || ('\u{20}'..='\u{7e}').contains(&character))
}
fn ends_in_number(host: &str) -> bool {
    let mut labels = host.split('.').collect::<Vec<_>>();
    if labels.len() > 1 && labels.last() == Some(&"") {
        labels.pop();
    }
    let last = labels.last().copied().unwrap_or("");
    (!last.is_empty() && last.chars().all(|character| character.is_ascii_digit()))
        || (last.len() >= 2
            && (last.starts_with("0x") || last.starts_with("0X"))
            && last[2..]
                .chars()
                .all(|character| character.is_ascii_hexdigit()))
}
fn host_parse_error(host: &str, scheme: &str) -> Option<&'static str> {
    if host.starts_with('[') {
        return if host.ends_with(']') && Url::parse(&format!("http://{host}/")).is_ok() {
            None
        } else {
            Some("invalid IPv6 address")
        };
    }
    if !SPECIAL_SCHEMES.contains(&scheme) {
        return if host
            .chars()
            .any(|character| "\0\t\n\r #/:<>?@[\\]^|".contains(character))
        {
            Some("invalid domain character")
        } else {
            None
        };
    }
    if host.is_empty() {
        return if scheme == "file" {
            None
        } else {
            Some("empty host")
        };
    }
    if Url::parse(&format!("http://{host}/")).is_ok() {
        return None;
    }
    Some(if ends_in_number(host) {
        "invalid IPv4 address"
    } else {
        "invalid international domain name"
    })
}
pub fn url_parse_error_text(input: &str) -> String {
    let trimmed = input
        .trim_matches(|character: char| character <= '\u{20}')
        .replace(['\t', '\n', '\r'], "");
    let Some(colon) = trimmed.find(':') else {
        return "relative URL without a base".to_owned();
    };
    let scheme_text = &trimmed[..colon];
    let valid_scheme = scheme_text
        .chars()
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && scheme_text
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "+.-".contains(character));
    if !valid_scheme {
        return "relative URL without a base".to_owned();
    }
    let scheme = ascii_lower(scheme_text);
    let special = SPECIAL_SCHEMES.contains(&scheme.as_str());
    let rest = &trimmed[colon + 1..];
    let authority_start = if special {
        Some(rest.trim_start_matches(['/', '\\']))
    } else {
        rest.strip_prefix("//")
    };
    let Some(authority_start) = authority_start else {
        return "relative URL without a base".to_owned();
    };
    let authority = authority_start
        .split(|character| matches!(character, '/' | '?' | '#') || (special && character == '\\'))
        .next()
        .unwrap_or("");
    if scheme == "file" {
        return host_parse_error(authority, &scheme)
            .unwrap_or("invalid international domain name")
            .to_owned();
    }
    let host_port = authority.rsplit('@').next().unwrap_or("");
    let search_from = if host_port.starts_with('[') {
        host_port.find(']').unwrap_or(0)
    } else {
        0
    };
    let port_colon = host_port[search_from..]
        .find(':')
        .map(|index| index + search_from);
    let host = port_colon.map_or(host_port, |index| &host_port[..index]);
    if let Some(error) = host_parse_error(host, &scheme) {
        return error.to_owned();
    }
    let port = port_colon.map_or("", |index| &host_port[index + 1..]);
    if !port.chars().all(|character| character.is_ascii_digit())
        || port
            .parse::<u64>()
            .map(|value| value > 65_535)
            .unwrap_or(!port.is_empty())
    {
        return "invalid port number".to_owned();
    }
    "invalid international domain name".to_owned()
}

fn take_credentials(url: &mut Url) -> Option<String> {
    if url.username().is_empty() && url.password().is_none() {
        return None;
    }
    let username = percent_decode(url.username());
    let password = percent_decode(url.password().unwrap_or(""));
    let _ = url.set_username("");
    let _ = url.set_password(None);
    match (username, password) {
        (Some(username), Some(password)) => Some(format!(
            "Basic {}",
            base64_encode(format!("{username}:{password}").as_bytes())
        )),
        _ => None,
    }
}

#[derive(Clone)]
struct Prepared {
    method: String,
    url: Url,
    headers: Vec<(String, String, Option<LosslessString>)>,
    body: Option<Vec<u8>>,
}

fn prepare(
    params: &HttpRequestParams,
    env: &dyn Fn(&LosslessString) -> Option<LosslessString>,
) -> Result<Prepared, ExecutorError> {
    let method = params.method.as_str().filter(|method| is_token(method));
    let Some(method) = method else {
        return Err(invalid_params(
            "http/request method is invalid: invalid HTTP method",
        ));
    };
    let url_text = os_text(&params.url);
    let mut url = Url::parse(&url_text).map_err(|_| {
        invalid_params(format!(
            "http/request url is invalid: {}",
            url_parse_error_text(&url_text)
        ))
    })?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(invalid_params(format!(
            "http/request only supports http and https URLs, got {}",
            url.scheme()
        )));
    }
    let credentials = take_credentials(&mut url);
    let mut headers = vec![];
    for header in &params.headers {
        let Some(name) = header.name.as_str().filter(|name| is_token(name)) else {
            return Err(invalid_params(
                "http/request header name is invalid: invalid HTTP header name",
            ));
        };
        let mut value = header.value.clone();
        if let Some(variable) = &header.value_env_var {
            let lowered = lower_units(variable);
            if HEADER_ENV_DENYLIST
                .iter()
                .any(|denied| LosslessString::from(ascii_lower(denied)) == lowered)
            {
                return Err(invalid_params(concat(&[
                    &"http/request header ".into(),
                    &header.name,
                    &" cannot use executor environment variable ".into(),
                    variable,
                ])));
            }
            let Some(resolved) = env(variable) else {
                return Err(invalid_params(concat(&[
                    &"http/request header ".into(),
                    &header.name,
                    &" requires executor environment variable ".into(),
                    variable,
                ])));
            };
            if resolved.is_empty() {
                return Err(invalid_params(concat(&[
                    &"http/request header ".into(),
                    &header.name,
                    &" requires a non-empty executor environment variable ".into(),
                    variable,
                ])));
            }
            value = concat(&[&value, &resolved]);
        }
        let Some(value) = value.as_str().filter(|value| visible_header_value(value)) else {
            return Err(invalid_params(concat(&[
                &"http/request header value is invalid for ".into(),
                &header.name,
                &": failed to parse header value".into(),
            ])));
        };
        headers.push((
            ascii_lower(name),
            value.to_owned(),
            header.value_env_var.clone(),
        ));
    }
    if let Some(credentials) = credentials
        && !headers.iter().any(|(name, _, _)| name == "authorization")
    {
        headers.insert(0, ("authorization".to_owned(), credentials, None));
    }
    Ok(Prepared {
        method: method.to_owned(),
        url,
        headers,
        body: params.body.clone(),
    })
}

fn known_port(url: &Url) -> u16 {
    url.port_or_known_default()
        .unwrap_or(if url.scheme() == "https" { 443 } else { 80 })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Interruption {
    Timeout,
    Cancel,
}

const STREAM_NONE: u8 = 0;
const STREAM_PENDING: u8 = 1;
const STREAM_STARTED: u8 = 2;

struct Flight {
    stream_id: Option<LosslessString>,
    interruption: Mutex<Option<Interruption>>,
    interrupted: Signal,
    grants: tokio::sync::Mutex<Vec<Grant>>,
    finished: watch::Sender<bool>,
    settled: tokio::sync::Mutex<Option<bool>>,
    stream_state: AtomicU8,
    background: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}
impl Flight {
    fn interrupt(&self, kind: Interruption) {
        let mut interruption = self
            .interruption
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if interruption.is_some() {
            return;
        }
        *interruption = Some(kind);
        drop(interruption);
        self.interrupted.cancel();
    }
    fn interruption(&self) -> Option<Interruption> {
        *self
            .interruption
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
    async fn race<T>(&self, work: impl std::future::Future<Output = T>) -> Option<T> {
        tokio::select! {
            outcome = work => Some(outcome),
            _ = self.interrupted.cancelled() => None,
        }
    }
}

type EnvironmentValue = Arc<dyn Fn(&LosslessString) -> Option<LosslessString> + Send + Sync>;

struct Inner {
    authorize: AuthorizeFn,
    env: EnvironmentValue,
    client: reqwest::Client,
    flights: Mutex<Vec<Arc<Flight>>>,
    stream_ids: Mutex<BTreeSet<LosslessString>>,
    closed: std::sync::atomic::AtomicBool,
    release_failed: std::sync::atomic::AtomicBool,
}

#[derive(Clone)]
pub struct HttpHandler(Arc<Inner>);

pub struct HttpBodyStream {
    handler: HttpHandler,
    flight: Arc<Flight>,
    response: Arc<tokio::sync::Mutex<Option<reqwest::Response>>>,
    request_id: LosslessString,
    emit: Emit,
    running: Arc<Mutex<Option<watch::Receiver<bool>>>>,
}

fn environment_value(name: &LosslessString) -> Option<LosslessString> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        let key = std::ffi::OsString::from_wide(&name.code_units().collect::<Vec<_>>());
        std::env::var_os(key).map(|value| LosslessString::from_utf16(value.encode_wide().collect()))
    }
    #[cfg(not(windows))]
    {
        std::env::var_os(name.as_str()?)
            .map(|value| LosslessString::from(value.to_string_lossy().into_owned()))
    }
}

impl HttpHandler {
    pub fn new(
        authorize: AuthorizeFn,
        env: Option<EnvironmentValue>,
    ) -> Result<Self, ExecutorError> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .http1_only()
            .build()
            .map_err(|_| internal_error("http client unavailable"))?;
        Ok(Self(Arc::new(Inner {
            authorize,
            env: env.unwrap_or_else(|| Arc::new(environment_value)),
            client,
            flights: Mutex::new(vec![]),
            stream_ids: Mutex::new(BTreeSet::new()),
            closed: Default::default(),
            release_failed: Default::default(),
        })))
    }

    fn is_closed(&self) -> bool {
        self.0.closed.load(Ordering::Acquire)
    }

    async fn settle(&self, flight: &Arc<Flight>) -> bool {
        let mut settled = flight.settled.lock().await;
        if let Some(released) = *settled {
            return released;
        }
        for task in flight
            .background
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .drain(..)
        {
            task.abort();
        }
        let grants = std::mem::take(&mut *flight.grants.lock().await);
        let mut released = true;
        for grant in grants {
            if grant.release().await.is_err() {
                released = false;
            }
        }
        self.0
            .flights
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .retain(|candidate| !Arc::ptr_eq(candidate, flight));
        if let Some(stream_id) = &flight.stream_id {
            self.0
                .stream_ids
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(stream_id);
        }
        if !released {
            self.0.release_failed.store(true, Ordering::Release);
        }
        let _ = flight.finished.send_replace(true);
        *settled = Some(released);
        released
    }

    fn open(&self, signal: &Signal, stream_id: Option<LosslessString>) -> Arc<Flight> {
        let (finished, _) = watch::channel(false);
        let flight = Arc::new(Flight {
            stream_id: stream_id.clone(),
            interruption: Mutex::new(None),
            interrupted: Signal::default(),
            grants: tokio::sync::Mutex::new(vec![]),
            finished,
            settled: tokio::sync::Mutex::new(None),
            stream_state: AtomicU8::new(STREAM_NONE),
            background: Mutex::new(vec![]),
        });
        let watched = flight.clone();
        let external = signal.clone();
        flight
            .background
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(tokio::spawn(async move {
                external.cancelled().await;
                watched.interrupt(Interruption::Cancel);
            }));
        self.0
            .flights
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(flight.clone());
        if let Some(stream_id) = stream_id {
            self.0
                .stream_ids
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(stream_id);
        }
        flight
    }

    fn interrupted_error(&self, flight: &Flight, url: &Url) -> ExecutorError {
        if flight.interruption() == Some(Interruption::Cancel) || self.is_closed() {
            ExecutorError::session_closed()
        } else {
            internal_error(format!(
                "http/request failed: error sending request for url ({})",
                url.as_str()
            ))
        }
    }

    async fn authorize_hop(
        &self,
        flight: &Arc<Flight>,
        request: &Prepared,
    ) -> Result<(), ExecutorError> {
        let mut metadata = JsonObject::new();
        metadata.insert(
            "method".into(),
            Value::String(request.method.clone().into()),
        );
        let mut ordered = vec![];
        for variable in request
            .headers
            .iter()
            .filter_map(|(_, _, variable)| variable.clone())
        {
            if !ordered.contains(&variable) {
                ordered.push(variable);
            }
        }
        if !ordered.is_empty() {
            metadata.insert("headerEnvVars".into(), Value::String(join(&ordered, ",")));
        }
        let mut input = AuthorizationInput::new(NETWORK_ACTION, vec![request.url.as_str().into()]);
        input.metadata = Some(metadata);
        let grant = (self.0.authorize)(input)
            .await
            .map_err(|_| ExecutorError::permission_denied())?;
        flight.grants.lock().await.push(grant);
        if self.is_closed() || flight.interruption().is_some() {
            return Err(self.interrupted_error(flight, &request.url));
        }
        Ok(())
    }

    async fn send(
        &self,
        flight: &Arc<Flight>,
        request: &Prepared,
    ) -> Result<reqwest::Response, ExecutorError> {
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|_| invalid_params("http/request method is invalid: invalid HTTP method"))?;
        let mut builder = self.0.client.request(method, request.url.clone());
        for (name, value, _) in &request.headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        if let Some(body) = &request.body {
            builder = builder.body(body.clone());
        }
        let built = builder
            .build()
            .map_err(|_| self.interrupted_error(flight, &request.url))?;
        match flight.race(self.0.client.execute(built)).await {
            Some(Ok(response)) => Ok(response),
            _ => Err(self.interrupted_error(flight, &request.url)),
        }
    }

    async fn execute(
        &self,
        flight: &Arc<Flight>,
        prepared: Prepared,
        params: &HttpRequestParams,
    ) -> Result<reqwest::Response, ExecutorError> {
        let mut current = prepared;
        let mut visited: Vec<Url> = vec![];
        loop {
            self.authorize_hop(flight, &current).await?;
            if visited.is_empty()
                && let Some(timeout_ms) = params.timeout_ms
            {
                let watched = flight.clone();
                flight
                    .background
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .push(tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
                        watched.interrupt(Interruption::Timeout);
                    }));
            }
            let response = self.send(flight, &current).await?;
            if params.redirect_policy == RedirectPolicy::Stop {
                return Ok(response);
            }
            let status = response.status().as_u16();
            let mut method = current.method.clone();
            let mut headers = current.headers.clone();
            let mut body = current.body.clone();
            if matches!(status, 301..=303) {
                body = None;
                headers.retain(|(name, _, _)| !BODY_HEADERS.contains(&name.as_str()));
                if method != "GET" && method != "HEAD" {
                    method = "GET".to_owned();
                }
            } else if status != 307 && status != 308 {
                return Ok(response);
            }
            let next = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .and_then(|location| current.url.join(location).ok());
            let Some(mut next) = next else {
                return Ok(response);
            };
            take_credentials(&mut next);
            let referer = if next.scheme() == "http" && current.url.scheme() == "https" {
                None
            } else {
                let mut previous = current.url.clone();
                previous.set_fragment(None);
                Some(previous.as_str().to_owned())
            };
            if let Some(referer) = referer {
                headers.retain(|(name, _, _)| name != "referer");
                headers.push(("referer".to_owned(), referer, None));
            }
            visited.push(current.url.clone());
            drop(response);
            if visited.len() > MAX_REDIRECTS {
                return Err(internal_error(format!(
                    "http/request failed: error following redirect for url ({})",
                    current.url.as_str()
                )));
            }
            if next.scheme() != "http" && next.scheme() != "https" {
                return Err(internal_error(format!(
                    "http/request failed: builder error for url ({})",
                    next.as_str()
                )));
            }
            if next.host_str() != current.url.host_str()
                || known_port(&next) != known_port(&current.url)
            {
                headers.retain(|(name, _, _)| !SENSITIVE_HEADERS.contains(&name.as_str()));
            }
            current = Prepared {
                method,
                url: next,
                headers,
                body,
            };
        }
    }

    fn response_head(response: &reqwest::Response) -> (u16, Vec<HttpHeader>) {
        let mut groups: Vec<(String, Vec<String>)> = vec![];
        for (name, value) in response.headers() {
            let name = ascii_lower(name.as_str());
            let index = match groups.iter().position(|(existing, _)| *existing == name) {
                Some(index) => index,
                None => {
                    groups.push((name, vec![]));
                    groups.len() - 1
                }
            };
            if let Ok(text) = value.to_str()
                && visible_header_value(text)
            {
                groups[index].1.push(text.to_owned());
            }
        }
        let headers = groups
            .into_iter()
            .flat_map(|(name, values)| {
                values.into_iter().map(move |value| HttpHeader {
                    name: name.clone().into(),
                    value: value.into(),
                    value_env_var: None,
                })
            })
            .collect();
        (response.status().as_u16(), headers)
    }

    pub async fn request(
        &self,
        params: HttpRequestParams,
        ctx: HttpRequestContext,
    ) -> Result<HttpOutcome, ExecutorError> {
        if self.is_closed() || ctx.signal.is_cancelled() {
            return Err(ExecutorError::session_closed());
        }
        if params.stream_response
            && self
                .0
                .stream_ids
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .contains(&params.request_id)
        {
            return Err(invalid_params(concat(&[
                &"http/request streamResponse requestId `".into(),
                &params.request_id,
                &"` is already active".into(),
            ])));
        }
        let flight = self.open(
            &ctx.signal,
            params.stream_response.then(|| params.request_id.clone()),
        );
        let env = self.0.env.clone();
        let prepared = match prepare(&params, &*env) {
            Ok(prepared) => prepared,
            Err(error) => {
                self.settle(&flight).await;
                return Err(error);
            }
        };
        let mut response = match self.execute(&flight, prepared, &params).await {
            Ok(response) => response,
            Err(error) => {
                self.settle(&flight).await;
                return Err(error);
            }
        };
        let (status, headers) = Self::response_head(&response);
        if params.stream_response {
            flight.stream_state.store(STREAM_PENDING, Ordering::Release);
            return Ok(HttpOutcome {
                response: HttpResponse {
                    status,
                    headers,
                    body: vec![],
                },
                stream: Some(HttpBodyStream {
                    handler: self.clone(),
                    flight,
                    response: Arc::new(tokio::sync::Mutex::new(Some(response))),
                    request_id: params.request_id,
                    emit: ctx.emit,
                    running: Arc::new(Mutex::new(None)),
                }),
            });
        }
        let mut body = vec![];
        let failure = loop {
            match flight.race(response.chunk()).await {
                Some(Ok(Some(chunk))) => body.extend_from_slice(&chunk),
                Some(Ok(None)) => break None,
                _ => {
                    break Some(
                        if flight.interruption() == Some(Interruption::Cancel) || self.is_closed() {
                            ExecutorError::session_closed()
                        } else {
                            internal_error(format!(
                                "failed to read http/request response body: {BODY_ERROR}"
                            ))
                        },
                    );
                }
            }
        };
        if let Some(failure) = failure {
            self.settle(&flight).await;
            return Err(failure);
        }
        if !self.settle(&flight).await {
            return Err(internal_error("Internal error"));
        }
        Ok(HttpOutcome {
            response: HttpResponse {
                status,
                headers,
                body,
            },
            stream: None,
        })
    }

    pub async fn close(&self) -> Result<(), ExecutorError> {
        self.0.closed.store(true, Ordering::Release);
        let live = self
            .0
            .flights
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        for flight in &live {
            flight.interrupt(Interruption::Cancel);
            if flight.stream_state.load(Ordering::Acquire) == STREAM_PENDING {
                self.settle(flight).await;
            }
        }
        for flight in live {
            let mut receiver = flight.finished.subscribe();
            while !*receiver.borrow() {
                if receiver.changed().await.is_err() {
                    break;
                }
            }
        }
        if self.0.release_failed.load(Ordering::Acquire) {
            return Err(internal_error("Internal error"));
        }
        Ok(())
    }
}

impl HttpBodyStream {
    async fn pump(&self) {
        let mut seq = 1u64;
        let Some(mut response) = self.response.lock().await.take() else {
            return;
        };
        let emit = |delta: BodyDelta| {
            let emit = self.emit.clone();
            async move { emit(delta).await.is_ok() }
        };
        loop {
            match self.flight.race(response.chunk()).await {
                Some(Ok(Some(chunk))) => {
                    for part in chunk.chunks(MAX_BODY_DELTA_BYTES) {
                        let delta = BodyDelta {
                            request_id: self.request_id.clone(),
                            seq,
                            delta: part.to_vec(),
                            done: false,
                            error: None,
                        };
                        if !emit(delta).await {
                            return;
                        }
                        seq += 1;
                    }
                }
                Some(Ok(None)) => break,
                _ => {
                    if self.flight.interruption() != Some(Interruption::Cancel) {
                        emit(BodyDelta {
                            request_id: self.request_id.clone(),
                            seq,
                            delta: vec![],
                            done: true,
                            error: Some(BODY_ERROR.to_owned()),
                        })
                        .await;
                    }
                    return;
                }
            }
        }
        emit(BodyDelta {
            request_id: self.request_id.clone(),
            seq,
            delta: vec![],
            done: true,
            error: None,
        })
        .await;
    }

    pub async fn start(&self) {
        let receiver = {
            let mut running = self
                .running
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if running.is_none() {
                self.flight
                    .stream_state
                    .store(STREAM_STARTED, Ordering::Release);
                let (done, receiver) = watch::channel(false);
                *running = Some(receiver);
                let stream = HttpBodyStream {
                    handler: self.handler.clone(),
                    flight: self.flight.clone(),
                    response: self.response.clone(),
                    request_id: self.request_id.clone(),
                    emit: self.emit.clone(),
                    running: self.running.clone(),
                };
                tokio::spawn(async move {
                    stream.pump().await;
                    stream.handler.settle(&stream.flight).await;
                    let _ = done.send_replace(true);
                });
            }
            running.clone().expect("stream running receiver set")
        };
        let mut receiver = receiver;
        while !*receiver.borrow() {
            if receiver.changed().await.is_err() {
                break;
            }
        }
    }

    pub async fn cancel(&self) {
        self.flight.interrupt(Interruption::Cancel);
        let started = self
            .running
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        match started {
            Some(mut receiver) => {
                while !*receiver.borrow() {
                    if receiver.changed().await.is_err() {
                        break;
                    }
                }
            }
            None => {
                self.response.lock().await.take();
                self.handler.settle(&self.flight).await;
            }
        }
    }
}
