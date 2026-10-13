use super::Error;
use serde_json::{Value, json};
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

pub const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub method: String,
    pub params: Option<Value>,
    pub session_id: Option<String>,
}

struct Pending {
    method: String,
    sender: oneshot::Sender<Result<Value, Error>>,
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
                while let Some(boundary) = buffer.iter().position(|byte| *byte == 0) {
                    if boundary > MAX_MESSAGE_BYTES {
                        reader_state.fail("Chrome control message exceeded the configured limit");
                        return;
                    }
                    let frame: Vec<_> = buffer.drain(..=boundary).collect();
                    if boundary == 0 {
                        continue;
                    }
                    let text = String::from_utf8_lossy(&frame[..boundary]);
                    let message = match serde_json::from_str::<Value>(&text) {
                        Ok(message) if message.is_object() => message,
                        _ => {
                            reader_state.fail("Chrome returned an invalid control message");
                            return;
                        }
                    };
                    if let Some(id) = message.get("id").and_then(Value::as_u64) {
                        let entry = reader_state
                            .pending
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .remove(&id);
                        if let Some(entry) = entry {
                            let result = if message.get("error").is_some_and(|error| {
                                !error.is_null() && error != &Value::Bool(false)
                            }) {
                                Err(Error::new(format!(
                                    "{}: Chrome rejected the command",
                                    entry.method
                                )))
                            } else {
                                Ok(message.get("result").cloned().unwrap_or(Value::Null))
                            };
                            let _ = entry.sender.send(result);
                        }
                        continue;
                    }
                    let Some(method) = message.get("method").and_then(Value::as_str) else {
                        reader_state.fail("Chrome returned an invalid control message");
                        return;
                    };
                    let _ = reader_state.events.send(Event {
                        method: method.into(),
                        params: message.get("params").filter(|p| p.is_object()).cloned(),
                        session_id: message
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .map(String::from),
                    });
                }
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
    pub async fn send(
        &self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
        mut cancellation: Option<watch::Receiver<bool>>,
        timeout: Option<Duration>,
    ) -> Result<Value, Error> {
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
        let mut request = json!({"id":id,"method":method,"params":params});
        if let Some(session) = session_id {
            request["sessionId"] = json!(session);
        }
        let mut frame = serde_json::to_vec(&request)
            .map_err(|_| Error::new("Chrome control pipe write failed"))?;
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
        tokio::select! {
            result = tokio::time::timeout(timeout.unwrap_or(self.timeout),execute) => result.map_err(|_| Error::new(format!("Chrome command timed out: {method}")))?,
            () = async {match cancellation.as_mut() {Some(signal)=> {while !*signal.borrow_and_update() {if signal.changed().await.is_err() {std::future::pending::<()>().await;}}},None=>std::future::pending::<()>().await}} => Err(cancelled()),
        }
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
