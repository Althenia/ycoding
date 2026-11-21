use crate::{
    Error,
    json::{self, get},
    llm::Request,
    route::{Observer, Prepared, Tracker},
};
use futures_util::{SinkExt, StreamExt};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    net::TcpStream,
    sync::{OwnedMutexGuard, mpsc, oneshot},
    task::JoinHandle,
    time::Instant,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message, client::IntoClientRequest},
};
use ycoding_schema::{JsonValue, parse_json, stringify_json};

type RawSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;
struct Command {
    message: Option<Message>,
    reply: oneshot::Sender<Result<(), Error>>,
}
struct Socket {
    commands: mpsc::Sender<Command>,
    messages: mpsc::Receiver<Result<Message, Error>>,
    task: Option<JoinHandle<()>>,
    open: Arc<AtomicBool>,
}
struct OpenFlag(Arc<AtomicBool>);
impl Drop for OpenFlag {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl Socket {
    fn new(mut socket: RawSocket) -> Self {
        let (commands, mut command_rx) = mpsc::channel::<Command>(128);
        let (message_tx, messages) = mpsc::channel(128);
        let open = Arc::new(AtomicBool::new(true));
        let flag = OpenFlag(open.clone());
        let task = tokio::spawn(async move {
            let _flag = flag;
            let mut heartbeat = Instant::now();
            let mut due = heartbeat + Duration::from_secs(25);
            loop {
                tokio::select! {
                    command=command_rx.recv()=>{
                        let Some(command)=command else {let _=socket.close(None).await;break;};
                        let close=command.message.is_none();let result=match command.message {Some(message)=>socket.send(message).await,None=>socket.close(None).await}.map_err(|_|Error::transport("WebSocket send failed","write"));let failed=result.is_err();let canceled=command.reply.send(result).is_err();if close || failed || canceled {let _=socket.close(None).await;break;}
                    },
                    message=socket.next()=>{
                        let message=match message {Some(Ok(message))=>message,Some(Err(_))=>{let _=message_tx.send(Err(Error::transport("WebSocket read failed","message"))).await;break;},None=>break};
                        if matches!(message,Message::Ping(_)|Message::Pong(_)) {if socket.flush().await.is_err() {let _=message_tx.send(Err(Error::transport("WebSocket control write failed","write"))).await;break;}continue;}
                        let closed=matches!(message,Message::Close(_));if message_tx.send(Ok(message)).await.is_err() {let _=socket.close(None).await;break;}
                        if closed {break;}
                    },
                    _=tokio::time::sleep_until(due)=>{
                        let now=Instant::now();let elapsed=now.duration_since(heartbeat);heartbeat=now;due=now+Duration::from_secs(25);
                        if elapsed>Duration::from_secs(50) {let _=message_tx.send(Err(Error::transport("WebSocket lifecycle heartbeat delayed","lifecycle"))).await;let _=socket.close(None).await;break;}
                        if socket.send(Message::Ping(Vec::new().into())).await.is_err() {let _=message_tx.send(Err(Error::transport("WebSocket heartbeat failed","write"))).await;break;}
                    }
                }
            }
        });
        Self {
            commands,
            messages,
            task: Some(task),
            open,
        }
    }
    async fn send(&mut self, message: Message) -> Result<(), Error> {
        let (reply, result) = oneshot::channel();
        self.commands
            .send(Command {
                message: Some(message),
                reply,
            })
            .await
            .map_err(|_| Error::transport("WebSocket connection closed", "write"))?;
        result
            .await
            .map_err(|_| Error::transport("WebSocket send aborted", "write"))?
    }
    async fn next(&mut self) -> Option<Result<Message, Error>> {
        self.messages.recv().await
    }
    async fn close(
        &mut self,
        _: Option<tokio_tungstenite::tungstenite::protocol::CloseFrame>,
    ) -> Result<(), Error> {
        let (reply, result) = oneshot::channel();
        if self
            .commands
            .send(Command {
                message: None,
                reply,
            })
            .await
            .is_ok()
        {
            let _ = result.await;
        }
        if let Some(task) = self.task.take() {
            task.await
                .map_err(|_| Error::transport("WebSocket shutdown failed", "close"))?;
        }
        Ok(())
    }
    fn is_open(&self) -> bool {
        self.open.load(Ordering::Acquire)
    }
}
impl Drop for Socket {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
struct ActiveLease(Arc<Slot>);
impl Drop for ActiveLease {
    fn drop(&mut self) {
        self.0.active.store(false, Ordering::Release);
    }
}
type Lower = Arc<dyn Fn(&JsonValue) -> Result<JsonValue, Error> + Send + Sync>;
type Replay = Arc<dyn Fn(&Request, usize) -> Result<JsonValue, Error> + Send + Sync>;
type SessionKey = Arc<dyn Fn(&Request) -> Option<SessionMetadata> + Send + Sync>;
type Normalize = Arc<dyn Fn(&JsonValue) -> Option<JsonValue> + Send + Sync>;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionMetadata {
    pub key: String,
    pub fingerprint: String,
    pub message_boundary: usize,
    pub full_replay: bool,
}
#[derive(Clone)]
pub struct Continuation {
    pub session: SessionKey,
    pub replay_message: Replay,
    pub delta_message: Replay,
    pub normalize_output: Normalize,
}
struct Previous {
    message: JsonValue,
    response_id: String,
    output: Vec<JsonValue>,
    message_boundary: usize,
}
struct Session {
    socket: Option<Socket>,
    fingerprint: String,
    previous: Option<Previous>,
}
struct Slot {
    state: Arc<tokio::sync::Mutex<Session>>,
    active: AtomicBool,
    idle: Mutex<Option<JoinHandle<()>>>,
}
struct Pool {
    sessions: Mutex<BTreeMap<String, Arc<Slot>>>,
    order: Mutex<Vec<String>>,
}
fn evict_inactive(
    sessions: &mut BTreeMap<String, Arc<Slot>>,
    order: &mut Vec<String>,
    capacity: usize,
) {
    while sessions.len() > capacity {
        let Some(index) = order.iter().position(|key| {
            sessions
                .get(key)
                .is_some_and(|slot| !slot.active.load(Ordering::Acquire))
        }) else {
            return;
        };
        let key = order.remove(index);
        if let Some(slot) = sessions.remove(&key)
            && let Ok(mut timer) = slot.idle.lock()
            && let Some(timer) = timer.take()
        {
            timer.abort();
        }
    }
}
pub struct JsonTransport {
    pub to_message: Lower,
    pub continuation: Option<Continuation>,
    pool: Arc<Pool>,
}
impl JsonTransport {
    pub fn new(
        to_message: impl Fn(&JsonValue) -> Result<JsonValue, Error> + Send + Sync + 'static,
    ) -> Self {
        Self {
            to_message: Arc::new(to_message),
            continuation: None,
            pool: Arc::new(Pool {
                sessions: Mutex::new(BTreeMap::new()),
                order: Mutex::new(Vec::new()),
            }),
        }
    }
    pub async fn open(
        &self,
        prepared: &Prepared,
        observer: Option<Observer>,
    ) -> Result<Connection, Error> {
        self.open_inner(prepared, observer)
            .await
            .map_err(|mut error| {
                error.message = crate::route::redact(&error.message, prepared);
                error.code = error.code.map(|code| crate::route::redact(&code, prepared));
                error
            })
    }
    async fn open_inner(
        &self,
        prepared: &Prepared,
        observer: Option<Observer>,
    ) -> Result<Connection, Error> {
        let message = (self.to_message)(&prepared.wire_body)?;
        let metadata = self
            .continuation
            .as_ref()
            .and_then(|continuation| (continuation.session)(&prepared.request));
        let Some(metadata) = metadata else {
            let mut tracker = Tracker::new(prepared, "websocket-json", observer);
            let mut socket = match open_socket(prepared).await {
                Ok(socket) => socket,
                Err(error) => {
                    tracker.settle(false, false, None);
                    return Err(error);
                }
            };
            tracker.settle(true, false, None);
            socket
                .send(Message::Text(stringify_json(&message).into()))
                .await
                .map_err(|_| Error::transport("WebSocket send failed", "write"))?;
            return Ok(Connection {
                session: None,
                one_shot: Some(socket),
                slot: None,
                pool: Weak::new(),
                key: None,
                continuation: None,
                replay: None,
                message_boundary: 0,
                output: Vec::new(),
                response_id: None,
                terminal: false,
                rejected: false,
                continued: false,
                active: None,
                secrets: crate::route::secrets(prepared),
            });
        };
        let slot =
            {
                let mut sessions = self.pool.sessions.lock().map_err(|_| {
                    Error::transport("WebSocket session pool unavailable", "session")
                })?;
                let mut order = self.pool.order.lock().map_err(|_| {
                    Error::transport("WebSocket session pool unavailable", "session")
                })?;
                if !sessions.contains_key(&metadata.key) {
                    evict_inactive(&mut sessions, &mut order, 63);
                    order.push(metadata.key.clone());
                    sessions.insert(
                        metadata.key.clone(),
                        Arc::new(Slot {
                            state: Arc::new(tokio::sync::Mutex::new(Session {
                                socket: None,
                                fingerprint: metadata.fingerprint.clone(),
                                previous: None,
                            })),
                            active: AtomicBool::new(false),
                            idle: Mutex::new(None),
                        }),
                    );
                }
                sessions.get(&metadata.key).cloned().ok_or_else(|| {
                    Error::transport("WebSocket session pool unavailable", "session")
                })?
            };
        let mut session = slot.state.clone().lock_owned().await;
        slot.active.store(true, Ordering::Release);
        let active = ActiveLease(slot.clone());
        if let Ok(mut timer) = slot.idle.lock()
            && let Some(timer) = timer.take()
        {
            timer.abort();
        }
        let continuation = self
            .continuation
            .clone()
            .ok_or_else(|| Error::invalid("WebSocket continuation is missing"))?;
        let replay = (continuation.replay_message)(&prepared.request, metadata.message_boundary)?;
        if session.fingerprint != metadata.fingerprint {
            if let Some(mut socket) = session.socket.take() {
                let _ = socket.close(None).await;
            }
            session.previous = None;
            session.fingerprint = metadata.fingerprint.clone();
        }
        if metadata.full_replay {
            session.previous = None;
        }
        if session
            .socket
            .as_ref()
            .is_some_and(|socket| !socket.is_open())
            && let Some(mut socket) = session.socket.take()
        {
            let _ = socket.close(None).await;
        }
        let continued = if metadata.full_replay {
            None
        } else {
            incremental(&prepared.request, session.previous.as_ref(), &continuation)?
        };
        let sent = continued.as_ref().unwrap_or(&message);
        if session.socket.is_none() {
            let mut tracker = Tracker::new(prepared, "websocket-json", observer);
            let socket = match open_socket(prepared).await {
                Ok(socket) => socket,
                Err(error) => {
                    slot.active.store(false, Ordering::Release);
                    tracker.settle(false, false, None);
                    return Err(error);
                }
            };
            tracker.settle(true, false, None);
            session.socket = Some(socket);
        }
        let socket = session
            .socket
            .as_mut()
            .ok_or_else(|| Error::transport("WebSocket connection unavailable", "open"))?;
        if socket
            .send(Message::Text(stringify_json(sent).into()))
            .await
            .is_err()
        {
            session.socket = None;
            slot.active.store(false, Ordering::Release);
            return Err(Error::transport("WebSocket send failed", "write"));
        }
        Ok(Connection {
            session: Some(session),
            one_shot: None,
            slot: Some(slot),
            pool: Arc::downgrade(&self.pool),
            key: Some(metadata.key),
            continuation: Some(continuation),
            replay: Some(replay),
            message_boundary: metadata.message_boundary,
            output: Vec::new(),
            response_id: None,
            terminal: false,
            rejected: false,
            continued: continued.is_some(),
            active: Some(active),
            secrets: crate::route::secrets(prepared),
        })
    }
}
fn canonical(value: &JsonValue) -> JsonValue {
    match value {
        JsonValue::Object(fields) => {
            let mut fields: Vec<_> = fields
                .iter()
                .map(|(key, value)| (key.clone(), canonical(value)))
                .collect();
            fields.sort_by(|(a, _), (b, _)| a.cmp(b));
            json::object(fields)
        }
        JsonValue::Array(values) => JsonValue::Array(values.iter().map(canonical).collect()),
        _ => value.clone(),
    }
}
fn properties(value: &JsonValue) -> JsonValue {
    json::remove(value, &["input", "previous_response_id", "type"])
}
fn incremental(
    request: &Request,
    previous: Option<&Previous>,
    continuation: &Continuation,
) -> Result<Option<JsonValue>, Error> {
    let Some(previous) = previous else {
        return Ok(None);
    };
    let count = previous.message_boundary + 1;
    let replay = (continuation.replay_message)(request, count)?;
    let (Some(represented), Some(prior)) = (
        get(&replay, "input").and_then(json::array),
        get(&previous.message, "input").and_then(json::array),
    ) else {
        return Ok(None);
    };
    if canonical(&properties(&replay)) != canonical(&properties(&previous.message)) {
        return Ok(None);
    }
    let values: Vec<_> = prior.iter().chain(previous.output.iter()).collect();
    if represented.len() != values.len()
        || !represented
            .iter()
            .zip(values)
            .all(|(a, b)| canonical(a) == canonical(b))
    {
        return Ok(None);
    }
    let mut delta = (continuation.delta_message)(request, count)?;
    json::set(
        &mut delta,
        "previous_response_id",
        json::s(previous.response_id.clone()),
    );
    Ok(Some(delta))
}
async fn open_socket(prepared: &Prepared) -> Result<Socket, Error> {
    let mut url = prepared.url.clone();
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        _ => {
            return Err(Error::transport(
                "Unsupported WebSocket URL protocol",
                "websocket",
            ));
        }
    };
    url.set_scheme(scheme)
        .map_err(|_| Error::transport("Invalid WebSocket URL", "websocket"))?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| Error::transport("Invalid WebSocket request", "open"))?;
    for (name, value) in &prepared.headers {
        request.headers_mut().insert(name.clone(), value.clone());
    }
    tokio_tungstenite::connect_async(request)
        .await
        .map(|(socket, _)| Socket::new(socket))
        .map_err(|_| Error::transport("Failed to open WebSocket", "open"))
}
pub struct Connection {
    secrets: Vec<String>,
    session: Option<OwnedMutexGuard<Session>>,
    one_shot: Option<Socket>,
    slot: Option<Arc<Slot>>,
    pool: Weak<Pool>,
    key: Option<String>,
    continuation: Option<Continuation>,
    replay: Option<JsonValue>,
    message_boundary: usize,
    output: Vec<JsonValue>,
    response_id: Option<String>,
    terminal: bool,
    rejected: bool,
    continued: bool,
    active: Option<ActiveLease>,
}
impl Connection {
    pub async fn next(&mut self) -> Result<Option<String>, Error> {
        self.next_inner().await.map_err(|mut error| {
            error.message = crate::route::redact_with(&error.message, &self.secrets);
            error.code = error
                .code
                .map(|code| crate::route::redact_with(&code, &self.secrets));
            error
        })
    }
    async fn next_inner(&mut self) -> Result<Option<String>, Error> {
        loop {
            let socket = self
                .session
                .as_mut()
                .and_then(|session| session.socket.as_mut())
                .or(self.one_shot.as_mut())
                .ok_or_else(|| Error::transport("WebSocket connection closed", "close"))?;
            let message = socket.next().await;
            let message = match message {
                Some(Ok(message)) => message,
                Some(Err(error)) => return Err(error),
                None => {
                    if self.session.is_some() && !self.terminal {
                        return Err(Error::transport(
                            "WebSocket closed before a terminal response",
                            "close",
                        ));
                    }
                    return Ok(None);
                }
            };
            let text = match message {
                Message::Text(text) => text.to_string(),
                Message::Binary(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                Message::Close(frame) => {
                    if frame
                        .as_ref()
                        .is_some_and(|frame| !matches!(u16::from(frame.code), 1000 | 1005))
                    {
                        return Err(Error::transport(
                            "WebSocket closed with an abnormal code",
                            "close",
                        ));
                    }
                    if self.session.is_some() && !self.terminal {
                        return Err(Error::transport(
                            "WebSocket closed before a terminal response",
                            "close",
                        ));
                    }
                    return Ok(None);
                }
                Message::Ping(_) | Message::Pong(_) => continue,
                Message::Frame(_) => {
                    return Err(Error::transport(
                        "Unsupported WebSocket message payload",
                        "message",
                    ));
                }
            };
            if let Ok(event) = parse_json(&text) {
                if get(&event, "type").and_then(json::text) == Some("response.output_item.done")
                    && let Some(item) = get(&event, "item")
                    && let Some(item) = self
                        .continuation
                        .as_ref()
                        .and_then(|continuation| (continuation.normalize_output)(item))
                {
                    self.output.push(item);
                }
                let kind = get(&event, "type").and_then(json::text);
                if kind == Some("response.completed") {
                    self.terminal = true;
                    self.response_id = get(&event, "response")
                        .and_then(|response| get(response, "id"))
                        .and_then(json::text)
                        .filter(|id| !id.is_empty())
                        .map(String::from);
                }
                if matches!(kind, Some("response.incomplete" | "response.failed")) {
                    self.terminal = true;
                }
                let text = [
                    get(&event, "message"),
                    get(&event, "code"),
                    get(&event, "error").and_then(|error| get(error, "message")),
                    get(&event, "error").and_then(|error| get(error, "code")),
                    get(&event, "response")
                        .and_then(|response| get(response, "error"))
                        .and_then(|error| get(error, "message")),
                    get(&event, "response")
                        .and_then(|response| get(response, "error"))
                        .and_then(|error| get(error, "code")),
                ]
                .into_iter()
                .flatten()
                .filter_map(json::text)
                .collect::<Vec<_>>()
                .join(" ");
                let lower = text.to_lowercase();
                if self.continued
                    && (lower.contains("previous_response") || lower.contains("previous response"))
                    && ["invalid", "expired", "not found", "unknown", "missing"]
                        .iter()
                        .any(|word| lower.contains(word))
                {
                    self.rejected = true;
                    return Err(Error::transport(text, "websocket-continuation"));
                }
            }
            return Ok(Some(text));
        }
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        if let Some(session) = &mut self.session {
            if let Some(response_id) = self.response_id.take()
                && let Some(message) = self.replay.take()
            {
                session.previous = Some(Previous {
                    message,
                    response_id,
                    output: std::mem::take(&mut self.output),
                    message_boundary: self.message_boundary,
                });
            }
            if !self.terminal || self.rejected {
                session.socket = None;
            }
        }
        self.active = None;
        self.session = None;
        let (Some(slot), Some(key)) = (self.slot.take(), self.key.take()) else {
            return;
        };
        let weak = Arc::downgrade(&slot);
        let pool = self.pool.clone();
        let timer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let Some(slot) = weak.upgrade() else {
                return;
            };
            if slot.active.load(Ordering::Acquire) {
                return;
            }
            let mut state = slot.state.lock().await;
            if slot.active.load(Ordering::Acquire) {
                return;
            }
            if let Some(mut socket) = state.socket.take() {
                let _ = socket.close(None).await;
            }
            if let Some(pool) = pool.upgrade()
                && let Ok(mut sessions) = pool.sessions.lock()
                && sessions
                    .get(&key)
                    .is_some_and(|current| Arc::ptr_eq(current, &slot))
            {
                sessions.remove(&key);
                if let Ok(mut order) = pool.order.lock() {
                    order.retain(|current| *current != key);
                }
            }
        });
        if let Ok(mut current) = slot.idle.lock()
            && let Some(previous) = current.replace(timer)
        {
            previous.abort();
        }
        if let Some(pool) = self.pool.upgrade()
            && let Ok(mut sessions) = pool.sessions.lock()
            && let Ok(mut order) = pool.order.lock()
        {
            evict_inactive(&mut sessions, &mut order, 64);
        }
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        if let Ok(timer) = self.idle.get_mut()
            && let Some(timer) = timer.take()
        {
            timer.abort();
        }
    }
}
