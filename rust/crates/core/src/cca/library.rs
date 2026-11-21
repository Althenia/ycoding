use super::value::{JsonObject, LosslessString, Value, object_get, parse_json, stringify_json};
use super::{
    encoding::random_hex,
    error::{AuthorizationDenied, BoxFuture, ExecutorError},
    signal::Signal,
};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::OnceCell,
};

pub const LIBRARY_PROCESS_URL: &str = "ycoding-library://process";
const BODY_LIMIT: usize = 256 * 1024;
const RESPONSE_LIMIT: usize = 4 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 8192;

#[derive(Clone, Debug, PartialEq)]
pub struct LibraryTool {
    pub name: String,
    pub definition: Value,
}
#[derive(Debug)]
pub enum LibraryCallError {
    Denied(AuthorizationDenied),
    Failed,
}

pub trait LibraryProcess: Send + Sync {
    fn check(&self) -> BoxFuture<'_, Result<(), ExecutorError>>;
    fn tools(&self) -> Vec<LibraryTool>;
    fn call(&self, name: &str, arguments: Value) -> BoxFuture<'_, Result<Value, LibraryCallError>>;
    fn close(&self) -> BoxFuture<'_, Result<(), ExecutorError>>;
}

pub type ReadFile = Arc<
    dyn Fn(String) -> BoxFuture<'static, Result<(String, Vec<u8>), ExecutorError>> + Send + Sync,
>;

pub struct LibraryOpenInput {
    pub process_id: LosslessString,
    pub cwd: String,
    pub read_file: ReadFile,
}
pub trait LibraryFactory: Send + Sync {
    fn open(
        &self,
        input: LibraryOpenInput,
    ) -> BoxFuture<'_, Result<Arc<dyn LibraryProcess>, ExecutorError>>;
}

struct Owner {
    backend: Arc<dyn LibraryProcess>,
    closing: tokio::sync::Mutex<bool>,
    active: AtomicUsize,
}
impl Owner {
    async fn close(&self) -> Result<(), ExecutorError> {
        let mut closing = self.closing.lock().await;
        if *closing {
            return Ok(());
        }
        *closing = true;
        self.backend.close().await
    }
}

struct Bridge {
    owners: Mutex<HashMap<String, Arc<Owner>>>,
    closed: AtomicBool,
    address: OnceCell<(String, String)>,
    server: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct LibraryBridge(Arc<Bridge>);

pub struct LibraryLease {
    pub env: std::collections::BTreeMap<String, String>,
    owner: Arc<Owner>,
    token: String,
    bridge: LibraryBridge,
    secret: Vec<u8>,
    pending: Mutex<(Vec<u8>, Vec<u8>)>,
    watcher: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl LibraryLease {
    pub async fn close(&self) -> Result<(), ExecutorError> {
        if let Some(watcher) = self
            .watcher
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            watcher.abort();
        }
        self.bridge
            .0
            .owners
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.token);
        self.owner.close().await
    }
    pub fn redact_output(&self, stderr: bool, bytes: &[u8], settled: bool) -> Vec<u8> {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let slot = if stderr {
            &mut pending.1
        } else {
            &mut pending.0
        };
        let mut data = std::mem::take(slot);
        data.extend_from_slice(bytes);
        let needle = &self.secret;
        let mut parts: Vec<u8> = vec![];
        let mut offset = 0;
        while let Some(found) = find(&data[offset..], needle) {
            parts.extend_from_slice(&data[offset..offset + found]);
            parts.extend_from_slice(b"[redacted]");
            offset += found + needle.len();
        }
        let tail = &data[offset..];
        let mut held = 0;
        if !settled {
            for size in (1..=tail.len().min(needle.len() - 1)).rev() {
                if tail[tail.len() - size..] == needle[..size] {
                    held = size;
                    break;
                }
            }
        }
        *slot = tail[tail.len() - held..].to_vec();
        parts.extend_from_slice(&tail[..tail.len() - held]);
        parts
    }
}
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn text(value: &str) -> Value {
    Value::String(LosslessString::from(value))
}
fn object(pairs: Vec<(&str, Value)>) -> Value {
    let mut object = JsonObject::new();
    for (key, value) in pairs {
        object.insert(LosslessString::from(key), value);
    }
    Value::Object(object)
}
fn json_response(status: u16, reason: &str, value: &Value) -> Vec<u8> {
    let body = stringify_json(value);
    format!("HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncache-control: no-store\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).into_bytes()
}
fn error_response(status: u16, id: &Value, code: i64, message: &str) -> Vec<u8> {
    let reason = match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        _ => "Internal Server Error",
    };
    let error = object(vec![
        ("code", Value::Number(code as f64)),
        ("message", text(message)),
    ]);
    json_response(
        status,
        reason,
        &object(vec![
            ("jsonrpc", text("2.0")),
            ("id", id.clone()),
            ("error", error),
        ]),
    )
}
fn result_response(id: &Value, result: Value) -> Vec<u8> {
    json_response(
        200,
        "OK",
        &object(vec![
            ("jsonrpc", text("2.0")),
            ("id", id.clone()),
            ("result", result),
        ]),
    )
}

struct Request {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
}
async fn read_request(socket: &mut TcpStream) -> Option<Request> {
    let mut buffer: Vec<u8> = vec![];
    let mut chunk = [0u8; 4096];
    let end = loop {
        let count = socket.read(&mut chunk).await.ok()?;
        if count == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..count]);
        if let Some(end) = find(&buffer, b"\r\n\r\n") {
            break end;
        }
        if buffer.len() > MAX_HEADER_BYTES {
            return None;
        }
    };
    if end > MAX_HEADER_BYTES {
        return None;
    }
    let head = String::from_utf8_lossy(&buffer[..end]).into_owned();
    let mut lines = head.split("\r\n");
    let first = lines
        .next()?
        .split(' ')
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if first.len() != 3 {
        return None;
    }
    let headers = lines
        .filter_map(|line| {
            line.split_once(':')
                .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        })
        .collect::<Vec<_>>();
    let length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = buffer[end + 4..].to_vec();
    if length > BODY_LIMIT {
        return Some(Request {
            method: first[0].clone(),
            target: first[1].clone(),
            headers,
            body: None,
        });
    }
    while body.len() < length {
        let count = socket.read(&mut chunk).await.ok()?;
        if count == 0 {
            return None;
        }
        body.extend_from_slice(&chunk[..count]);
        if body.len() > BODY_LIMIT {
            return Some(Request {
                method: first[0].clone(),
                target: first[1].clone(),
                headers,
                body: None,
            });
        }
    }
    body.truncate(length);
    Some(Request {
        method: first[0].clone(),
        target: first[1].clone(),
        headers,
        body: Some(body),
    })
}

impl Bridge {
    async fn handle(self: Arc<Self>, mut socket: TcpStream, host: String) {
        let outcome =
            tokio::time::timeout(Duration::from_secs(30), self.respond(&mut socket, &host)).await;
        let bytes = match outcome {
            Ok(bytes) => bytes,
            Err(_) => return,
        };
        let _ = socket.write_all(&bytes).await;
        let _ = socket.shutdown().await;
    }

    async fn respond(&self, socket: &mut TcpStream, host: &str) -> Vec<u8> {
        let Some(request) = read_request(socket).await else {
            return error_response(
                400,
                &Value::Null,
                -32600,
                "Invalid private JSON-RPC request",
            );
        };
        let header = |name: &str| {
            request
                .headers
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        };
        if header("host").as_deref() != Some(host) || header("origin").is_some() {
            return error_response(
                403,
                &Value::Null,
                -32001,
                "Private Library channel unavailable",
            );
        }
        if request.target != "/mcp" {
            return error_response(404, &Value::Null, -32600, "Unknown private endpoint");
        }
        let token = header("authorization").unwrap_or_default();
        let owner = self
            .owners
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&token)
            .cloned();
        let Some(owner) = owner.filter(|_| !self.closed.load(Ordering::Acquire)) else {
            return error_response(
                401,
                &Value::Null,
                -32001,
                "Private Library capability unavailable",
            );
        };
        if request.method != "POST" {
            return error_response(405, &Value::Null, -32601, "Only POST is supported");
        }
        if owner.active.load(Ordering::Acquire) >= 4 {
            return error_response(429, &Value::Null, -32603, "Private Library channel is busy");
        }
        owner.active.fetch_add(1, Ordering::AcqRel);
        let response = self.serve(&owner, &token, &request).await;
        owner.active.fetch_sub(1, Ordering::AcqRel);
        response
    }

    async fn current(&self, owner: &Arc<Owner>, token: &str) -> Result<(), ()> {
        let live = |bridge: &Bridge| {
            !bridge.closed.load(Ordering::Acquire)
                && bridge
                    .owners
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .get(token)
                    .is_some_and(|candidate| Arc::ptr_eq(candidate, owner))
        };
        if !live(self) {
            return Err(());
        }
        owner.backend.check().await.map_err(|_| ())?;
        if live(self) { Ok(()) } else { Err(()) }
    }

    async fn serve(&self, owner: &Arc<Owner>, token: &str, request: &Request) -> Vec<u8> {
        let mut id = Value::Null;
        let retired = |id: &Value| {
            error_response(
                403,
                id,
                -32001,
                "Private Library operation retired; do not replay an uncertain upload",
            )
        };
        if self.current(owner, token).await.is_err() {
            let _ = owner.close().await;
            return error_response(403, &id, -32001, "Private Library capability retired");
        }
        let Some(body) = &request.body else {
            return error_response(413, &id, -32600, "Request exceeds private channel limit");
        };
        let Some(Value::Object(message)) = String::from_utf8(body.clone())
            .ok()
            .and_then(|source| parse_json(&source).ok())
        else {
            return error_response(400, &id, -32700, "Invalid JSON");
        };
        let valid_keys = message.iter().all(|(key, _)| {
            ["jsonrpc", "id", "method", "params"]
                .iter()
                .any(|allowed| key.as_str() == Some(allowed))
        });
        let valid_id = match object_get(&message, "id") {
            Some(Value::String(_)) => true,
            Some(Value::Number(number)) => {
                number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
            }
            _ => false,
        };
        let version = matches!(object_get(&message, "jsonrpc"), Some(Value::String(version)) if version.as_str() == Some("2.0"));
        if !valid_keys || !version || !valid_id {
            return error_response(400, &id, -32600, "Invalid private JSON-RPC request");
        }
        id = object_get(&message, "id").cloned().unwrap_or(Value::Null);
        let params = match object_get(&message, "params") {
            None => JsonObject::new(),
            Some(Value::Object(params)) => params.clone(),
            Some(_) => return error_response(400, &id, -32602, "Invalid parameters"),
        };
        if self.current(owner, token).await.is_err() {
            let _ = owner.close().await;
            return retired(&id);
        }
        let method = match object_get(&message, "method") {
            Some(Value::String(method)) => method.as_str().map(str::to_owned),
            _ => None,
        };
        match method.as_deref() {
            Some("tools/list") => {
                if params.iter().any(|(key, _)| key.as_str() != Some("_meta")) {
                    return error_response(400, &id, -32602, "Unsupported list parameters");
                }
                if self.current(owner, token).await.is_err() {
                    let _ = owner.close().await;
                    return retired(&id);
                }
                let tools = owner
                    .backend
                    .tools()
                    .into_iter()
                    .map(|tool| tool.definition)
                    .collect::<Vec<_>>();
                result_response(&id, object(vec![("tools", Value::Array(tools))]))
            }
            Some("tools/call") => {
                let allowed = params.iter().all(|(key, _)| {
                    ["name", "arguments", "_meta"]
                        .iter()
                        .any(|candidate| key.as_str() == Some(candidate))
                });
                let name = match object_get(&params, "name") {
                    Some(Value::String(name)) => name.as_str().map(str::to_owned),
                    _ => None,
                };
                let arguments = match object_get(&params, "arguments") {
                    Some(arguments @ Value::Object(_)) => Some(arguments.clone()),
                    _ => None,
                };
                let (Some(name), Some(arguments), true) = (name, arguments, allowed) else {
                    return error_response(400, &id, -32602, "Unknown tool or invalid arguments");
                };
                if !owner.backend.tools().iter().any(|tool| tool.name == name) {
                    return error_response(400, &id, -32602, "Unknown tool or invalid arguments");
                }
                let result = match owner.backend.call(&name, arguments).await {
                    Ok(result) => result,
                    Err(failure) => {
                        let message = match failure {
                            LibraryCallError::Denied(denied) => denied
                                .refusal_text()
                                .unwrap_or_else(|| "Library permission denied.".into()),
                            LibraryCallError::Failed => {
                                "Library operation failed. Do not retry an uncertain upload.".into()
                            }
                        };
                        if self.current(owner, token).await.is_err() {
                            let _ = owner.close().await;
                            return retired(&id);
                        }
                        let content = Value::Array(vec![object(vec![
                            ("type", text("text")),
                            ("text", Value::String(message)),
                        ])]);
                        return result_response(
                            &id,
                            object(vec![("isError", Value::Bool(true)), ("content", content)]),
                        );
                    }
                };
                if self.current(owner, token).await.is_err() {
                    let _ = owner.close().await;
                    return retired(&id);
                }
                let serialized = stringify_json(&result);
                if serialized.len() > RESPONSE_LIMIT {
                    return error_response(
                        413,
                        &id,
                        -32603,
                        "Library result exceeds private channel limit",
                    );
                }
                let content = Value::Array(vec![object(vec![
                    ("type", text("text")),
                    ("text", text(&serialized)),
                ])]);
                result_response(
                    &id,
                    object(vec![("structuredContent", result), ("content", content)]),
                )
            }
            _ => error_response(400, &id, -32601, "Unsupported private method"),
        }
    }
}

impl Default for LibraryBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl LibraryBridge {
    pub fn new() -> Self {
        Self(Arc::new(Bridge {
            owners: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            address: OnceCell::new(),
            server: Mutex::new(None),
        }))
    }

    async fn listen(&self) -> Result<(String, String), ExecutorError> {
        let bridge = self.0.clone();
        self.0
            .address
            .get_or_try_init(|| async move {
                let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|_| {
                    ExecutorError::new(-32603, "Private Library listener unavailable")
                })?;
                let port = listener
                    .local_addr()
                    .map_err(|_| {
                        ExecutorError::new(-32603, "Private Library listener unavailable")
                    })?
                    .port();
                let host = format!("127.0.0.1:{port}");
                let served = bridge.clone();
                let served_host = host.clone();
                let task = tokio::spawn(async move {
                    while let Ok((socket, _)) = listener.accept().await {
                        tokio::spawn(served.clone().handle(socket, served_host.clone()));
                    }
                });
                *bridge
                    .server
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some(task);
                Ok::<_, ExecutorError>((format!("http://{host}/mcp"), host))
            })
            .await
            .cloned()
    }

    pub async fn open(
        &self,
        factory: Arc<dyn LibraryFactory>,
        input: LibraryOpenInput,
        signals: Vec<Signal>,
    ) -> Result<LibraryLease, ExecutorError> {
        let unavailable = || ExecutorError::new(-32603, "Private Library channel unavailable");
        if self.0.closed.load(Ordering::Acquire) || signals.iter().any(Signal::is_cancelled) {
            return Err(unavailable());
        }
        let (url, _) = self.listen().await?;
        let backend = factory.open(input).await?;
        let secret = random_hex(32);
        let token = format!("Bearer {secret}");
        let owner = Arc::new(Owner {
            backend,
            closing: tokio::sync::Mutex::new(false),
            active: AtomicUsize::new(0),
        });
        if self.0.closed.load(Ordering::Acquire) || signals.iter().any(Signal::is_cancelled) {
            let _ = owner.close().await;
            return Err(unavailable());
        }
        if owner.backend.check().await.is_err() {
            let _ = owner.close().await;
            return Err(unavailable());
        }
        if self.0.closed.load(Ordering::Acquire) || signals.iter().any(Signal::is_cancelled) {
            let _ = owner.close().await;
            return Err(unavailable());
        }
        self.0
            .owners
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(token.clone(), owner.clone());
        let watcher = if signals.is_empty() {
            None
        } else {
            let bridge = self.clone();
            let (owner, token) = (owner.clone(), token.clone());
            Some(tokio::spawn(async move {
                let linked = Signal::any(&signals);
                linked.signal().cancelled().await;
                bridge
                    .0
                    .owners
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(&token);
                let _ = owner.close().await;
                drop(linked);
            }))
        };
        Ok(LibraryLease {
            env: [
                ("CODEX_APPS_MCP_URL".to_owned(), url),
                ("CODEX_APPS_AUTHORIZATION".to_owned(), token.clone()),
            ]
            .into_iter()
            .collect(),
            owner,
            token,
            bridge: self.clone(),
            secret: secret.into_bytes(),
            pending: Mutex::new((vec![], vec![])),
            watcher: Mutex::new(watcher),
        })
    }

    pub async fn close(&self) {
        self.0.closed.store(true, Ordering::Release);
        let owners = self
            .0
            .owners
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .drain()
            .map(|(_, owner)| owner)
            .collect::<Vec<_>>();
        for owner in owners {
            let _ = owner.close().await;
        }
        if let Some(task) = self
            .0
            .server
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            task.abort();
        }
    }
}
