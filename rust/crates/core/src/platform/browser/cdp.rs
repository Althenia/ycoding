use super::Error;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{broadcast, oneshot, watch},
    task::JoinHandle,
};
use ycoding_schema::{
    JsonPath, JsonValue, LosslessString, ObjectDecoder, ObjectEncoder, parse_json, stringify_json,
};

pub const MAX_MESSAGE_BYTES: usize = 12 * 1024 * 1024;

pub(super) fn stale_context(message: &str) -> bool {
    [
        "Cannot find context",
        "Execution context was destroyed",
        "Inspected target navigated",
    ]
    .iter()
    .any(|part| message.contains(part))
}

pub(super) fn stale_node(message: &str) -> bool {
    stale_context(message)
        || [
            "Could not find node",
            "No node with given id",
            "Could not find object",
        ]
        .iter()
        .any(|part| message.contains(part))
}

#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub method: String,
    pub params: Option<JsonValue>,
    pub session_id: Option<String>,
}

struct Pending {
    method: String,
    sender: oneshot::Sender<Result<JsonValue, Error>>,
}
struct State {
    pending: Mutex<HashMap<u64, Pending>>,
    closed: AtomicBool,
    sequence: AtomicU64,
    events: broadcast::Sender<Event>,
    settled: watch::Sender<bool>,
}
impl State {
    fn fail(&self, message: &str) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.settled.send_replace(true);
        let pending = std::mem::take(&mut *self.pending.lock().unwrap_or_else(|e| e.into_inner()));
        for entry in pending.into_values() {
            let _ = entry.sender.send(Err(Error::new(message)));
        }
    }
}

pub struct Client {
    state: Arc<State>,
    writer: tokio::sync::Mutex<Box<dyn AsyncWrite + Unpin + Send>>,
    reader: Mutex<Option<JoinHandle<()>>>,
    timeout: Duration,
}

struct PendingGuard<'a> {
    state: &'a State,
    id: u64,
}
impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.state
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
    }
}

pub trait Message: Sized {
    fn encode_message(&self) -> Result<JsonValue, Error>;
    fn decode_message(value: JsonValue) -> Result<Self, Error>;
}
impl Message for JsonValue {
    fn encode_message(&self) -> Result<JsonValue, Error> {
        Ok(self.clone())
    }
    fn decode_message(value: JsonValue) -> Result<Self, Error> {
        Ok(value)
    }
}
impl Message for Value {
    fn encode_message(&self) -> Result<JsonValue, Error> {
        parse_json(&self.to_string())
            .map_err(|_| Error::new("Chrome control message encoding failed"))
    }
    fn decode_message(value: JsonValue) -> Result<Self, Error> {
        serde_json::from_str(&stringify_json(&value))
            .map_err(|_| Error::new("Chrome control response requires lossless text decoding"))
    }
}

impl Client {
    pub fn connect<R, W>(mut readable: R, writable: W, timeout: Duration) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (events, _) = broadcast::channel(256);
        let state = Arc::new(State {
            pending: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            sequence: AtomicU64::new(0),
            events,
            settled: watch::channel(false).0,
        });
        let reader_state = state.clone();
        let reader = tokio::spawn(async move {
            let mut buffer = Vec::new();
            let mut scanned = 0usize;
            let mut chunk = [0; 8192];
            loop {
                let count = match readable.read(&mut chunk).await {
                    Ok(0) => {
                        reader_state.fail("Chrome control pipe closed");
                        break;
                    }
                    Ok(count) => count,
                    Err(_) => {
                        reader_state.fail("Chrome control pipe failed");
                        break;
                    }
                };
                buffer.extend_from_slice(&chunk[..count]);
                while let Some(offset) = buffer[scanned..].iter().position(|byte| *byte == 0) {
                    let boundary = scanned + offset;
                    if boundary > MAX_MESSAGE_BYTES {
                        reader_state.fail("Chrome control message exceeded the configured limit");
                        return;
                    }
                    let frame: Vec<_> = buffer.drain(..=boundary).collect();
                    scanned = 0;
                    if boundary == 0 {
                        continue;
                    }
                    let message = match std::str::from_utf8(&frame[..boundary])
                        .ok()
                        .and_then(|text| parse_json(text).ok())
                    {
                        Some(message @ JsonValue::Object(_)) => message,
                        _ => {
                            reader_state.fail("Chrome returned an invalid control message");
                            return;
                        }
                    };
                    let path = JsonPath::default();
                    let object = ObjectDecoder::new(&message, &path).expect("object checked");
                    if let Ok(Some(id)) = object.optional::<f64>("id") {
                        let entry = reader_state
                            .pending
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .remove(&(id as u64));
                        if let Some(entry) = entry {
                            let failure =
                                object.optional::<JsonValue>("error").ok().flatten().filter(
                                    |value| {
                                        !matches!(value, JsonValue::Null | JsonValue::Bool(false))
                                    },
                                );
                            let result = if let Some(failure) = failure {
                                let message = ObjectDecoder::new(&failure, &path)
                                    .ok()
                                    .and_then(|object| {
                                        object.optional::<LosslessString>("message").ok().flatten()
                                    })
                                    .filter(|message| message.as_str().is_some_and(stale_node))
                                    .map(|message| super::payload::bounded(message, 1024))
                                    .and_then(|message| message.to_utf8().ok());
                                Err(Error::new(message.unwrap_or_else(|| {
                                    format!("{}: Chrome rejected the command", entry.method)
                                })))
                            } else {
                                Ok(object
                                    .optional::<JsonValue>("result")
                                    .ok()
                                    .flatten()
                                    .unwrap_or(JsonValue::Null))
                            };
                            let _ = entry.sender.send(result);
                        }
                        continue;
                    }
                    let method = match object
                        .field::<LosslessString>("method")
                        .ok()
                        .and_then(|method| method.to_utf8().ok())
                    {
                        Some(method) => method,
                        None => {
                            reader_state.fail("Chrome returned an invalid control message");
                            return;
                        }
                    };
                    let _ = reader_state.events.send(Event {
                        method,
                        params: object
                            .optional::<JsonValue>("params")
                            .ok()
                            .flatten()
                            .filter(|params| matches!(params, JsonValue::Object(_))),
                        session_id: object
                            .optional::<LosslessString>("sessionId")
                            .ok()
                            .flatten()
                            .and_then(|id| id.to_utf8().ok()),
                    });
                }
                scanned = buffer.len();
                if buffer.len() > MAX_MESSAGE_BYTES {
                    reader_state.fail("Chrome control message exceeded the configured limit");
                    break;
                }
            }
        });
        Self {
            state,
            writer: tokio::sync::Mutex::new(Box::new(writable)),
            reader: Mutex::new(Some(reader)),
            timeout,
        }
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.state.events.subscribe()
    }
    pub async fn closed(&self) {
        let mut settled = self.state.settled.subscribe();
        let _ = settled.wait_for(|closed| *closed).await;
    }
    pub async fn send<P: Message>(
        &self,
        method: &str,
        params: P,
        session_id: Option<&str>,
        mut cancellation: Option<watch::Receiver<bool>>,
        timeout: Option<Duration>,
    ) -> Result<P, Error> {
        if self.state.closed.load(Ordering::Acquire) {
            return Err(Error::new("Chrome control pipe is closed"));
        }
        if cancellation.as_ref().is_some_and(|c| *c.borrow()) {
            return Err(cancelled());
        }
        let id = self.state.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.state.pending.lock().unwrap_or_else(|e| e.into_inner());
            if self.state.closed.load(Ordering::Acquire) {
                return Err(Error::new("Chrome control pipe is closed"));
            }
            pending.insert(
                id,
                Pending {
                    method: method.into(),
                    sender,
                },
            );
        }
        let _guard = PendingGuard {
            state: &self.state,
            id,
        };
        let request = ObjectEncoder::new()
            .field("id", &(id as f64))
            .field("method", method)
            .field("params", &params.encode_message()?)
            .optional("sessionId", &session_id.map(LosslessString::from))
            .finish();
        let mut frame = stringify_json(&request).into_bytes();
        if frame.len() > MAX_MESSAGE_BYTES {
            return Err(Error::new(
                "Chrome control message exceeded the configured limit",
            ));
        }
        frame.push(0);
        let execute = async {
            self.writer
                .lock()
                .await
                .write_all(&frame)
                .await
                .map_err(|_| Error::new("Chrome control pipe write failed"))?;
            receiver
                .await
                .map_err(|_| Error::new("Chrome control pipe closed"))?
        };
        let response = tokio::select! {
            result = tokio::time::timeout(timeout.unwrap_or(self.timeout),execute) => result.map_err(|_| Error::new(format!("Chrome command timed out: {method}")))?,
            () = async {match cancellation.as_mut() {Some(signal)=> {while !*signal.borrow_and_update() {if signal.changed().await.is_err() {std::future::pending::<()>().await;}}},None=>std::future::pending::<()>().await}} => Err(cancelled()),
        }?;
        P::decode_message(response)
    }
    pub fn close(&self) {
        self.state.fail("Chrome control pipe closed");
        if let Some(reader) = self
            .reader
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            reader.abort();
        }
    }
    pub async fn shutdown(&self) -> Result<(), Error> {
        self.close();
        self.writer
            .lock()
            .await
            .shutdown()
            .await
            .map_err(|_| Error::new("Chrome control pipe write failed"))?;
        let reader = self.reader.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(reader) = reader {
            match reader.await {
                Ok(()) => {}
                Err(error) if error.is_cancelled() => {}
                Err(_) => return Err(Error::new("Chrome control reader failed")),
            }
        }
        Ok(())
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.close();
    }
}
fn cancelled() -> Error {
    Error {
        message: "The Chrome command was canceled".into(),
        cancelled: true,
    }
}
