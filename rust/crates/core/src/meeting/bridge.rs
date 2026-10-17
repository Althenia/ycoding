use super::BoxFuture;
use super::owner::{Outcome, Update, parse_update};
use super::pcm::{AudioSource, decode_base64, encode_base64};
use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::response::Response;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinHandle;

const MAX_BODY: usize = 1_048_576;
const MAX_VIEW_BODY: usize = 16_384;
const MAX_DRAIN: usize = 8 * MAX_BODY;
const READ_TIMEOUT: Duration = Duration::from_secs(10);
const CLOSE_GRACE: Duration = Duration::from_secs(3);
const VIEW_ROUTES: [&str; 4] = ["/view/state", "/view/control", "/view/ask", "/view/capture"];
const OWNER_ROUTE: &str = "/view/owner/settings";
const VIEW_FIELDS: [&str; 12] = [
    "meeting",
    "meetings",
    "segments",
    "findings",
    "summary",
    "plan",
    "proposals",
    "health",
    "audio",
    "analysis",
    "config",
    "ask",
];

#[derive(Clone, Debug, PartialEq)]
pub enum CaptureMessage {
    Start {
        capture_id: String,
        microphone: bool,
    },
    Audio {
        capture_id: String,
        source: AudioSource,
        sequence: u64,
        start_ms: f64,
        sample_rate: u32,
        samples: Vec<f32>,
    },
    Stop {
        capture_id: String,
        reason: String,
    },
    Heartbeat {
        capture_id: String,
    },
}

impl CaptureMessage {
    pub fn capture_id(&self) -> &str {
        match self {
            Self::Start { capture_id, .. }
            | Self::Audio { capture_id, .. }
            | Self::Stop { capture_id, .. }
            | Self::Heartbeat { capture_id } => capture_id,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CallbackFailed;

pub trait Handlers: Send + Sync + 'static {
    fn control(&self, input: Value) -> BoxFuture<'_, Result<Value, CallbackFailed>>;
    fn capture(&self, input: CaptureMessage) -> BoxFuture<'_, Result<Value, CallbackFailed>>;
    fn disconnect(&self) {}
    fn view(&self) -> Option<BoxFuture<'_, Result<Value, CallbackFailed>>> {
        None
    }
    fn ask(&self, _question: String) -> Option<BoxFuture<'_, Result<Value, CallbackFailed>>> {
        None
    }
    fn owner_read(&self) -> Option<BoxFuture<'_, Result<Value, CallbackFailed>>> {
        None
    }
    fn owner_update(
        &self,
        _update: Update,
    ) -> Option<BoxFuture<'_, Result<Outcome, CallbackFailed>>> {
        None
    }
}

#[derive(Clone, Debug)]
pub struct Asset {
    pub content_type: String,
    pub body: String,
}

#[derive(Clone, Debug)]
pub struct ViewAssets {
    pub assets: HashMap<String, Asset>,
    pub policy: String,
}

#[derive(Clone, Debug)]
pub struct Options {
    pub port: u16,
    pub control_token: String,
    pub assets: ViewAssets,
    pub capture_timeout: Duration,
    pub expiry_interval: Duration,
}

impl Options {
    pub fn new(control_token: impl Into<String>) -> Self {
        Self {
            port: 0,
            control_token: control_token.into(),
            assets: ViewAssets::default(),
            capture_timeout: Duration::from_secs(20),
            expiry_interval: Duration::from_secs(1),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BridgeError(pub String);

impl fmt::Display for BridgeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for BridgeError {}

struct Activity {
    active: Option<(String, Instant)>,
    delivering: bool,
    closed: bool,
}

struct Shared {
    port: u16,
    control_digest: [u8; 32],
    view_digest: [u8; 32],
    view_key: String,
    owner_digest: [u8; 32],
    owner_key: String,
    assets: ViewAssets,
    handlers: Arc<dyn Handlers>,
    state: Mutex<Activity>,
}

pub struct Bridge {
    url: String,
    shared: Arc<Shared>,
    shutdown: watch::Sender<bool>,
    serving: Mutex<Option<JoinHandle<()>>>,
    expiry: Mutex<Option<JoinHandle<()>>>,
}

impl Bridge {
    pub async fn start(options: Options, handlers: Arc<dyn Handlers>) -> Result<Self, BridgeError> {
        if !credential(&options.control_token) {
            return Err(BridgeError("Invalid controller credential".into()));
        }
        let listener = TcpListener::bind(("127.0.0.1", options.port))
            .await
            .map_err(|error| BridgeError(format!("Meeting bridge could not listen: {error}")))?;
        let port = listener
            .local_addr()
            .map_err(|error| BridgeError(error.to_string()))?
            .port();
        let view_key =
            hex(&crate::platform::random::<32>().map_err(|error| BridgeError(error.to_string()))?);
        let owner_key =
            hex(&crate::platform::random::<32>().map_err(|error| BridgeError(error.to_string()))?);
        let shared = Arc::new(Shared {
            port,
            control_digest: digest(&options.control_token),
            view_digest: digest(&view_key),
            view_key,
            owner_digest: digest(&owner_key),
            owner_key,
            assets: options.assets,
            handlers,
            state: Mutex::new(Activity {
                active: None,
                delivering: false,
                closed: false,
            }),
        });
        let (shutdown, stopped) = watch::channel(false);
        let app = Router::new().fallback(handle).with_state(shared.clone());
        let mut serving_stopped = stopped.clone();
        let serving = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = serving_stopped.wait_for(|stopped| *stopped).await;
                })
                .await;
        });
        let expiry = tokio::spawn(expire(
            shared.clone(),
            stopped,
            options.capture_timeout,
            options.expiry_interval,
        ));
        Ok(Self {
            url: format!("http://127.0.0.1:{port}"),
            shared,
            shutdown,
            serving: Mutex::new(Some(serving)),
            expiry: Mutex::new(Some(expiry)),
        })
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub async fn close(&self) {
        {
            let mut state = lock(&self.shared.state);
            if state.closed {
                return;
            }
            state.closed = true;
        }
        let _ = self.shutdown.send(true);
        disconnect(&self.shared);
        let serving = lock(&self.serving).take();
        if let Some(mut serving) = serving
            && tokio::time::timeout(CLOSE_GRACE, &mut serving)
                .await
                .is_err()
        {
            serving.abort();
        }
        let expiry = lock(&self.expiry).take();
        if let Some(expiry) = expiry {
            let _ = expiry.await;
        }
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
    }
}

async fn expire(
    shared: Arc<Shared>,
    mut stopped: watch::Receiver<bool>,
    timeout: Duration,
    interval: Duration,
) {
    loop {
        tokio::select! {
            _ = stopped.wait_for(|stopped| *stopped) => return,
            _ = tokio::time::sleep(interval) => {
                let stale = lock(&shared.state).active.as_ref().is_some_and(|(_, seen)| seen.elapsed() > timeout);
                if stale {
                    disconnect(&shared);
                }
            }
        }
    }
}

fn disconnect(shared: &Shared) {
    if lock(&shared.state).active.take().is_some() {
        shared.handlers.disconnect();
    }
}

async fn handle(State(shared): State<Arc<Shared>>, request: Request) -> Response {
    route(&shared, request).await.into_response()
}

async fn route(shared: &Arc<Shared>, request: Request) -> Reply {
    if lock(&shared.state).closed {
        return reply(503, json!({ "error": "closed" }));
    }
    let headers = request.headers();
    if joined(headers, &header::HOST) != Some(format!("127.0.0.1:{}", shared.port)) {
        return reply(403, json!({ "error": "invalid_host" }));
    }
    let path = request.uri().path();
    if request.uri().query().is_some_and(|query| !query.is_empty()) {
        return reply(400, json!({ "error": "invalid_url" }));
    }
    let origin = joined(headers, &header::ORIGIN);
    let own_origin = format!("http://127.0.0.1:{}", shared.port);
    let foreign = origin.as_ref().is_some_and(|origin| *origin != own_origin);
    if let Some(asset) = shared.assets.assets.get(path) {
        if foreign {
            return reply(403, json!({ "error": "invalid_origin" }));
        }
        if request.method() != Method::GET {
            return reply(405, json!({ "error": "method_not_allowed" }));
        }
        return Reply::asset(asset, &shared.assets.policy);
    }
    let view = VIEW_ROUTES.contains(&path);
    let owner = path == OWNER_ROUTE;
    if path != "/control" && !view && !owner {
        return reply(404, json!({ "error": "not_found" }));
    }
    if (view || owner) && foreign {
        return reply(403, json!({ "error": "invalid_origin" }));
    }
    if path == "/control" && origin.is_some() {
        return reply(403, json!({ "error": "origin_forbidden" }));
    }
    let allowed = if owner {
        [Method::GET, Method::POST].contains(request.method())
    } else {
        request.method()
            == if path == "/view/state" {
                Method::GET
            } else {
                Method::POST
            }
    };
    if !allowed {
        return reply(405, json!({ "error": "method_not_allowed" }));
    }
    let token = joined(headers, &header::AUTHORIZATION)
        .and_then(|value| value.strip_prefix("Bearer ").map(str::to_owned))
        .unwrap_or_default();
    let expected = if owner {
        &shared.owner_digest
    } else if view {
        &shared.view_digest
    } else {
        &shared.control_digest
    };
    if token.len() > 256
        || digest(&token)
            .iter()
            .zip(expected)
            .fold(0, |difference, (left, right)| difference | (left ^ right))
            != 0
    {
        return reply(401, json!({ "error": "unauthorized" }));
    }
    if path == "/view/state" {
        return view_state(shared).await;
    }
    if owner && request.method() == Method::GET {
        return owner_read(shared).await;
    }
    if !joined(headers, &header::CONTENT_TYPE).is_some_and(|value| json_content_type(&value)) {
        return reply(415, json!({ "error": "invalid_content_type" }));
    }
    let limit = if (view || owner) && path != "/view/capture" {
        MAX_VIEW_BODY
    } else {
        MAX_BODY
    };
    let declared =
        joined(headers, &header::CONTENT_LENGTH).and_then(|length| length.parse::<usize>().ok());
    let path = path.to_owned();
    let body = request.into_body();
    let bytes = match declared {
        Some(declared) if declared > limit => {
            let _ = tokio::time::timeout(READ_TIMEOUT, to_bytes(body, MAX_DRAIN)).await;
            return reply(413, json!({ "error": "payload_too_large" }));
        }
        _ => match tokio::time::timeout(READ_TIMEOUT, to_bytes(body, limit)).await {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(_)) if declared.is_none() => {
                return reply(413, json!({ "error": "payload_too_large" }));
            }
            _ => return reply(400, json!({ "error": "invalid_body" })),
        },
    };
    let Ok(body) = serde_json::from_slice::<Value>(&bytes) else {
        return reply(400, json!({ "error": "invalid_json" }));
    };
    match path.as_str() {
        "/view/control" => view_control(shared, body).await,
        "/view/ask" => view_ask(shared, body).await,
        OWNER_ROUTE => owner_update(shared, body).await,
        "/control" => control(shared, body).await,
        _ => {
            let shared = shared.clone();
            tokio::spawn(async move { capture(&shared, body).await })
                .await
                .unwrap_or_else(|_| reply(500, json!({ "error": "callback_failed" })))
        }
    }
}

async fn view_state(shared: &Arc<Shared>) -> Reply {
    match run_optional(shared.handlers.clone(), |handlers| handlers.view()).await {
        Some(None) => reply(503, json!({ "error": "view_unavailable" })),
        Some(Some(Ok(Value::Object(view)))) => {
            let visible: Map<String, Value> = view
                .into_iter()
                .filter(|(key, _)| VIEW_FIELDS.contains(&key.as_str()))
                .collect();
            reply(200, Value::Object(visible))
        }
        _ => reply(500, json!({ "error": "view_failed" })),
    }
}

async fn view_control(shared: &Arc<Shared>, body: Value) -> Reply {
    if !exact_keys(&body, &["action"])
        || !matches!(
            body.get("action").and_then(Value::as_str),
            Some("stop" | "retry")
        )
    {
        return reply(400, json!({ "error": "invalid_action" }));
    }
    match run(shared.handlers.clone(), move |handlers| {
        handlers.control(body)
    })
    .await
    {
        Some(Ok(value)) => reply(200, value),
        _ => reply(500, json!({ "error": "control_failed" })),
    }
}

async fn view_ask(shared: &Arc<Shared>, body: Value) -> Reply {
    let question = body
        .get("question")
        .and_then(Value::as_str)
        .filter(|question| {
            exact_keys(&body, &["question"])
                && !question.trim().is_empty()
                && question.encode_utf16().count() <= 2000
        });
    let Some(question) = question else {
        return reply(400, json!({ "error": "invalid_question" }));
    };
    let question = question.trim().to_owned();
    let answer = match run_optional(shared.handlers.clone(), move |handlers| {
        handlers.ask(question)
    })
    .await
    {
        Some(None) => return reply(503, json!({ "error": "ask_unavailable" })),
        Some(Some(Ok(answer))) => answer,
        _ => return reply(502, json!({ "error": "answer_failed" })),
    };
    if answer.get("busy") == Some(&Value::Bool(true)) {
        return reply(409, json!({ "error": "busy" }));
    }
    if answer.get("status").and_then(Value::as_str) == Some("error") {
        return reply(
            if answer.get("error").and_then(Value::as_str) == Some("answer_failed") {
                502
            } else {
                422
            },
            answer,
        );
    }
    reply(200, answer)
}

async fn owner_read(shared: &Arc<Shared>) -> Reply {
    match run_optional(shared.handlers.clone(), |handlers| handlers.owner_read()).await {
        Some(None) => reply(503, json!({ "error": "owner_unavailable" })),
        Some(Some(Ok(settings))) => reply(200, settings),
        _ => reply(500, json!({ "error": "owner_failed" })),
    }
}

async fn owner_update(shared: &Arc<Shared>, body: Value) -> Reply {
    let Some(update) = parse_update(&body) else {
        return reply(400, json!({ "error": "invalid_settings" }));
    };
    match run_optional(shared.handlers.clone(), move |handlers| {
        handlers.owner_update(update)
    })
    .await
    {
        Some(None) => reply(503, json!({ "error": "owner_unavailable" })),
        Some(Some(Ok(Outcome::Saved(settings)))) => reply(200, settings),
        Some(Some(Ok(Outcome::SelectionUnavailable))) => {
            reply(422, json!({ "error": "selection_unavailable" }))
        }
        _ => reply(500, json!({ "error": "owner_failed" })),
    }
}

async fn control(shared: &Arc<Shared>, body: Value) -> Reply {
    let page = match body.get("action").and_then(Value::as_str) {
        Some("view") => Some(format!("#key={}", shared.view_key)),
        Some("owner-view") => Some(format!(
            "#key={}&owner={}",
            shared.view_key, shared.owner_key
        )),
        _ => None,
    };
    if let Some(fragment) = page {
        if !exact_keys(&body, &["action"]) {
            return reply(400, json!({ "error": "invalid_action" }));
        }
        return reply(
            200,
            json!({ "url": format!("http://127.0.0.1:{}/view{fragment}", shared.port) }),
        );
    }
    match run(shared.handlers.clone(), move |handlers| {
        handlers.control(body)
    })
    .await
    {
        Some(Ok(value)) => reply(200, value),
        _ => reply(500, json!({ "error": "callback_failed" })),
    }
}

struct Delivery<'a>(&'a Shared);

impl Drop for Delivery<'_> {
    fn drop(&mut self) {
        lock(&self.0.state).delivering = false;
    }
}

async fn capture(shared: &Arc<Shared>, body: Value) -> Reply {
    let Some(message) = parse_capture(&body) else {
        return reply(400, json!({ "error": "invalid_capture" }));
    };
    let heartbeat = matches!(message, CaptureMessage::Heartbeat { .. });
    let stopping = matches!(message, CaptureMessage::Stop { .. });
    let starting = matches!(message, CaptureMessage::Start { .. });
    let capture_id = message.capture_id().to_owned();
    let delivery = {
        let mut state = lock(&shared.state);
        if heartbeat
            && let Some((active, seen)) = &mut state.active
            && *active == capture_id
        {
            *seen = Instant::now();
        }
        if state.delivering && !heartbeat {
            return busy();
        }
        (!heartbeat).then(|| {
            state.delivering = true;
            Delivery(shared)
        })
    };
    let outcome = run(shared.handlers.clone(), move |handlers| {
        handlers.capture(message)
    })
    .await;
    drop(delivery);
    let Some(Ok(result)) = outcome else {
        return reply(500, json!({ "error": "callback_failed" }));
    };
    if result.get("busy") == Some(&Value::Bool(true)) {
        return busy();
    }
    let mut state = lock(&shared.state);
    if !state.closed {
        if starting {
            state.active = Some((capture_id.clone(), Instant::now()));
        }
        if let Some((active, seen)) = &mut state.active
            && *active == capture_id
        {
            *seen = Instant::now();
            if stopping || result.get("stop") == Some(&Value::Bool(true)) {
                state.active = None;
            }
        }
    }
    reply(200, result)
}

async fn run<T: Send + 'static>(
    handlers: Arc<dyn Handlers>,
    call: impl FnOnce(&dyn Handlers) -> BoxFuture<'_, T> + Send + 'static,
) -> Option<T> {
    tokio::spawn(async move { call(handlers.as_ref()).await })
        .await
        .ok()
}

async fn run_optional<T: Send + 'static>(
    handlers: Arc<dyn Handlers>,
    call: impl FnOnce(&dyn Handlers) -> Option<BoxFuture<'_, T>> + Send + 'static,
) -> Option<Option<T>> {
    tokio::spawn(async move {
        match call(handlers.as_ref()) {
            Some(pending) => Some(pending.await),
            None => None,
        }
    })
    .await
    .ok()
}

fn busy() -> Reply {
    let mut response = reply(429, json!({ "error": "busy" }));
    response.headers.push(("retry-after", "1".into()));
    response
}

fn exact_keys(value: &Value, allowed: &[&str]) -> bool {
    value.as_object().is_some_and(|map| {
        map.len() == allowed.len() && allowed.iter().all(|key| map.contains_key(*key))
    })
}

fn json_content_type(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    let Some(rest) = value.strip_prefix("application/json") else {
        return false;
    };
    let rest = rest.trim_start();
    rest.is_empty()
        || rest
            .strip_prefix(';')
            .is_some_and(|parameter| parameter.trim() == "charset=utf-8")
}

fn joined(headers: &HeaderMap, name: &HeaderName) -> Option<String> {
    let values: Vec<_> = headers
        .get_all(name)
        .iter()
        .map(|value| String::from_utf8_lossy(value.as_bytes()).trim().to_owned())
        .collect();
    (!values.is_empty()).then(|| values.join(", "))
}

pub fn parse_capture(value: &Value) -> Option<CaptureMessage> {
    let map = value.as_object()?;
    let capture_id = map.get("captureID")?.as_str()?;
    if capture_id.is_empty()
        || capture_id.len() > 128
        || !capture_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return None;
    }
    let capture_id = capture_id.to_owned();
    match map.get("type")?.as_str()? {
        "heartbeat" if exact_keys(value, &["type", "captureID"]) => {
            Some(CaptureMessage::Heartbeat { capture_id })
        }
        "start"
            if exact_keys(value, &["type", "captureID", "microphone", "consent"])
                && map.get("consent") == Some(&Value::Bool(true)) =>
        {
            Some(CaptureMessage::Start {
                capture_id,
                microphone: map.get("microphone")?.as_bool()?,
            })
        }
        "stop" if exact_keys(value, &["type", "captureID", "reason"]) => {
            let reason = map.get("reason")?.as_str()?;
            (!reason.is_empty()
                && reason.encode_utf16().count() <= 256
                && !reason.chars().any(|character| character < ' '))
            .then(|| CaptureMessage::Stop {
                capture_id,
                reason: reason.into(),
            })
        }
        "audio"
            if exact_keys(
                value,
                &[
                    "type",
                    "captureID",
                    "source",
                    "sequence",
                    "startMs",
                    "sampleRate",
                    "pcm",
                ],
            ) =>
        {
            let source = match map.get("source")?.as_str()? {
                "remote" => AudioSource::Remote,
                "microphone" => AudioSource::Microphone,
                _ => return None,
            };
            let sequence = map.get("sequence")?.as_f64().filter(|value| {
                value.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(value)
            })? as u64;
            let start_ms = map
                .get("startMs")?
                .as_f64()
                .filter(|value| value.is_finite() && *value >= 0.0)?;
            let sample_rate = map
                .get("sampleRate")?
                .as_f64()
                .filter(|value| value.fract() == 0.0 && (1.0..=192_000.0).contains(value))?
                as u32;
            let samples = pcm(map.get("pcm")?.as_str()?, sample_rate)?;
            Some(CaptureMessage::Audio {
                capture_id,
                source,
                sequence,
                start_ms,
                sample_rate,
                samples,
            })
        }
        _ => None,
    }
}

fn pcm(encoded: &str, sample_rate: u32) -> Option<Vec<f32>> {
    if encoded.is_empty() || encoded.len() > 1_024_000 || !encoded.len().is_multiple_of(4) {
        return None;
    }
    let bytes = decode_base64(encoded)?;
    if bytes.is_empty()
        || !bytes.len().is_multiple_of(4)
        || bytes.len() / 4 > sample_rate as usize
        || encode_base64(&bytes) != encoded
    {
        return None;
    }
    bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|word| {
            Some(f32::from_le_bytes(*word))
                .filter(|sample| sample.is_finite() && (-1.0..=1.0).contains(sample))
        })
        .collect()
}

struct Reply {
    status: u16,
    headers: Vec<(&'static str, String)>,
    body: Vec<u8>,
}

impl Reply {
    fn asset(asset: &Asset, policy: &str) -> Self {
        Self {
            status: 200,
            headers: vec![
                ("content-type", asset.content_type.clone()),
                ("content-security-policy", policy.into()),
                ("cache-control", "no-store".into()),
                ("referrer-policy", "no-referrer".into()),
                ("x-content-type-options", "nosniff".into()),
            ],
            body: asset.body.clone().into_bytes(),
        }
    }

    fn into_response(self) -> Response {
        let mut response = Response::new(Body::from(self.body));
        *response.status_mut() =
            StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        for (name, value) in self.headers {
            if let Ok(value) = HeaderValue::from_str(&value) {
                response
                    .headers_mut()
                    .insert(HeaderName::from_static(name), value);
            }
        }
        response
    }
}

fn reply(status: u16, value: Value) -> Reply {
    Reply {
        status,
        headers: vec![
            ("cache-control", "no-store".into()),
            ("content-type", "application/json".into()),
            ("x-content-type-options", "nosniff".into()),
        ],
        body: value.to_string().into_bytes(),
    }
}

fn credential(token: &str) -> bool {
    (32..=256).contains(&token.len()) && token.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn digest(value: &str) -> [u8; 32] {
    let mut output = [0u8; 32];
    output.copy_from_slice(ring::digest::digest(&ring::digest::SHA256, value.as_bytes()).as_ref());
    output
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}
