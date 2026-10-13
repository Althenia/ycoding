use super::BoxFuture;
use super::config::{TranscriptionConfig, number};
use super::pcm::{AudioChunk, samples_base64};
use crate::platform::process::{self, Chunk, Control, KillOptions, KillSignal, StreamKind};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;

const WORKER_SOURCE: &str = include_str!("../../../../../extensions/meeting/python/worker.py");
const MAX_REQUEST_BYTES: usize = 12 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_STDERR_CHARACTERS: usize = 8192;
const MAX_STDERR_LINES: usize = 33;
const TERMINATE_GRACE: Duration = Duration::from_secs(2);
const EXIT_WAIT: Duration = Duration::from_secs(10);
const HUGGING_FACE: &str = "huggingface";
const WHISPER: &str = "WhisperForConditionalGeneration";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModelDefinition {
    pub id: &'static str,
    pub provider: &'static str,
    pub language: &'static str,
    pub architecture: &'static str,
}

pub const MODELS: [ModelDefinition; 2] = [
    ModelDefinition {
        id: "biodatlab/whisper-th-large-v3-combined",
        provider: HUGGING_FACE,
        language: "th",
        architecture: WHISPER,
    },
    ModelDefinition {
        id: "openai/whisper-large-v3",
        provider: HUGGING_FACE,
        language: "*",
        architecture: WHISPER,
    },
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    Failure,
    ChunkLimit,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TranscriptionError {
    pub kind: ErrorKind,
    pub message: String,
}

impl TranscriptionError {
    fn failure(message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::Failure,
            message: message.into(),
        }
    }

    fn cancelled() -> Self {
        Self {
            kind: ErrorKind::Cancelled,
            message: "Transcription cancelled".into(),
        }
    }
}

impl fmt::Display for TranscriptionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for TranscriptionError {}

pub fn sanitize_error(message: &str) -> String {
    let cleaned: String = message
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut units = 0;
    let bounded: String = cleaned
        .chars()
        .take_while(|character| {
            units += character.len_utf16();
            units <= 300
        })
        .collect();
    if bounded.is_empty() {
        "Transcription failed".into()
    } else {
        bounded
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Transcript {
    pub start_ms: f64,
    pub end_ms: f64,
    pub text: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Metrics {
    pub device: Option<String>,
    pub warning: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Health {
    pub healthy: bool,
    pub initialized: bool,
    pub metrics: Option<Metrics>,
}

#[derive(Clone, Debug, Default)]
pub struct TranscribeContext {
    pub hints: Vec<String>,
    pub signal: Option<watch::Receiver<bool>>,
}

pub trait TranscriptionProvider: Send + Sync {
    fn id(&self) -> &str;
    fn initialize<'a>(
        &'a self,
        config: &'a TranscriptionConfig,
    ) -> BoxFuture<'a, Result<(), TranscriptionError>>;
    fn transcribe<'a>(
        &'a self,
        chunk: &'a AudioChunk,
        context: TranscribeContext,
    ) -> BoxFuture<'a, Result<Vec<Transcript>, TranscriptionError>>;
    fn health_check(&self) -> BoxFuture<'_, Result<Health, TranscriptionError>>;
    fn dispose(&self) -> BoxFuture<'_, ()>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Compatibility {
    pub supported: bool,
    pub provider: String,
    pub reason: Option<&'static str>,
}

pub fn model_compatibility(config: &TranscriptionConfig) -> Compatibility {
    let reason = match MODELS.iter().find(|model| model.id == config.model) {
        None => Some("Unsupported model"),
        Some(_) if config.provider != HUGGING_FACE => Some("Unsupported provider"),
        Some(_) => None,
    };
    Compatibility {
        supported: reason.is_none(),
        provider: config.provider.clone(),
        reason,
    }
}

pub fn create_provider(
    config: &TranscriptionConfig,
) -> Result<Arc<dyn TranscriptionProvider>, TranscriptionError> {
    let compatibility = model_compatibility(config);
    if let Some(reason) = compatibility.reason {
        return Err(TranscriptionError::failure(reason));
    }
    Ok(Arc::new(HuggingFaceProvider {
        config: config.clone(),
        worker: Worker::new(config.clone()),
        state: Mutex::new(ProviderState {
            initialized: false,
            disposed: false,
            metrics: None,
        }),
    }))
}

pub async fn list_models(config: &TranscriptionConfig) -> Result<Vec<Value>, TranscriptionError> {
    let worker = Worker::new(config.clone());
    let response = worker
        .request(
            request(
                "inventory",
                [
                    ("models", model_ids()),
                    ("cacheDir", json!(config.cache_dir)),
                ],
            ),
            None,
        )
        .await;
    worker.close().await;
    let inventory = response?
        .get("inventory")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| {
            TranscriptionError::failure("Transcription worker omitted model inventory")
        })?;
    Ok(MODELS
        .iter()
        .map(|model| {
            let mut value = json!({
                "id": model.id,
                "provider": model.provider,
                "language": model.language,
                "task": "transcribe",
                "architecture": model.architecture,
                "installed": false,
            });
            if let Some(Value::Object(found)) = inventory
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(model.id))
            {
                for (key, entry) in found {
                    value[key] = entry.clone();
                }
            }
            value
        })
        .collect())
}

pub async fn install_model(
    model: &str,
    authorized: bool,
    config: &TranscriptionConfig,
) -> Result<(), TranscriptionError> {
    if !authorized {
        return Err(TranscriptionError::failure(
            "Model installation requires explicit authorization",
        ));
    }
    if !MODELS
        .iter()
        .any(|known| known.id == model && known.provider == HUGGING_FACE)
    {
        return Err(TranscriptionError::failure("Unsupported model"));
    }
    let worker = Worker::new(config.with_model(model));
    let response = worker
        .request(
            request(
                "install",
                [
                    ("model", json!(model)),
                    ("models", model_ids()),
                    ("cacheDir", json!(config.cache_dir)),
                    ("authorized", json!(true)),
                ],
            ),
            None,
        )
        .await;
    worker.close().await;
    response.map(|_| ())
}

fn model_ids() -> Value {
    Value::Array(
        MODELS
            .iter()
            .filter(|model| model.provider == HUGGING_FACE)
            .map(|model| json!(model.id))
            .collect(),
    )
}

fn request<const N: usize>(operation: &str, fields: [(&str, Value); N]) -> Map<String, Value> {
    let mut message = Map::new();
    message.insert("op".into(), json!(operation));
    for (key, value) in fields {
        message.insert(key.into(), value);
    }
    message
}

struct ProviderState {
    initialized: bool,
    disposed: bool,
    metrics: Option<Metrics>,
}

struct HuggingFaceProvider {
    config: TranscriptionConfig,
    worker: Worker,
    state: Mutex<ProviderState>,
}

impl HuggingFaceProvider {
    fn state(&self) -> std::sync::MutexGuard<'_, ProviderState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn refresh(&self) {
        if self.worker.failed() {
            self.state().initialized = false;
        }
    }
}

impl TranscriptionProvider for HuggingFaceProvider {
    fn id(&self) -> &str {
        HUGGING_FACE
    }

    fn initialize<'a>(
        &'a self,
        selected: &'a TranscriptionConfig,
    ) -> BoxFuture<'a, Result<(), TranscriptionError>> {
        Box::pin(async move {
            if self.state().disposed {
                return Err(TranscriptionError::failure(
                    "Transcription provider is disposed",
                ));
            }
            if *selected != self.config {
                return Err(TranscriptionError::failure(
                    "Provider configuration changes require creating a provider",
                ));
            }
            if self.state().initialized {
                return Ok(());
            }
            let mut message = selected.to_value();
            let Value::Object(fields) = &mut message else {
                unreachable!("configuration serializes as an object")
            };
            fields.insert("op".into(), json!("initialize"));
            fields.insert("models".into(), model_ids());
            let response = self.worker.request(std::mem::take(fields), None).await?;
            let mut state = self.state();
            state.initialized = true;
            state.metrics = Some(metrics(&response));
            Ok(())
        })
    }

    fn transcribe<'a>(
        &'a self,
        chunk: &'a AudioChunk,
        context: TranscribeContext,
    ) -> BoxFuture<'a, Result<Vec<Transcript>, TranscriptionError>> {
        Box::pin(async move {
            self.refresh();
            let (initialized, disposed) = {
                let state = self.state();
                (state.initialized, state.disposed)
            };
            if !initialized || disposed {
                return Err(TranscriptionError::failure(
                    "Transcription provider is not initialized",
                ));
            }
            if context
                .signal
                .as_ref()
                .is_some_and(|signal| *signal.borrow())
            {
                return Err(TranscriptionError::cancelled());
            }
            if chunk.id.is_empty()
                || chunk.id.len() > 128
                || !chunk.start_ms.is_finite()
                || chunk.start_ms < 0.0
            {
                return Err(TranscriptionError::failure("Invalid audio chunk metadata"));
            }
            if !(8000..=192_000).contains(&chunk.sample_rate) {
                return Err(TranscriptionError::failure(
                    "Audio sample rate must be between 8000 and 192000 Hz",
                ));
            }
            if chunk.samples.is_empty() {
                return Ok(Vec::new());
            }
            if chunk.samples.len() > chunk.sample_rate as usize * self.config.chunk_seconds as usize
            {
                return Err(TranscriptionError {
                    kind: ErrorKind::ChunkLimit,
                    message: "Audio chunk exceeds the configured duration limit".into(),
                });
            }
            if chunk.samples.iter().any(|sample| !sample.is_finite()) {
                return Err(TranscriptionError::failure("Audio samples must be finite"));
            }
            if context.hints.len() > 64
                || context
                    .hints
                    .iter()
                    .any(|hint| hint.encode_utf16().count() > 512)
                || context.hints.iter().map(String::len).sum::<usize>() > 8192
            {
                return Err(TranscriptionError::failure(
                    "Transcription hints exceed the count or size limit",
                ));
            }
            let message = request(
                "transcribe",
                [
                    (
                        "chunk",
                        json!({
                            "id": chunk.id,
                            "source": chunk.source.as_str(),
                            "startMs": number(chunk.start_ms),
                            "sampleRate": chunk.sample_rate,
                            "samples": samples_base64(&chunk.samples),
                        }),
                    ),
                    ("hints", json!(context.hints)),
                ],
            );
            let response = self.worker.request(message, context.signal).await;
            self.refresh();
            let response = response?;
            let results = response
                .get("results")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    TranscriptionError::failure("Transcription worker omitted transcript results")
                })?;
            let update = metrics(&response);
            let mut state = self.state();
            let merged = state.metrics.get_or_insert_with(Metrics::default);
            merged.device = update.device.or(merged.device.take());
            merged.warning = update.warning.or(merged.warning.take());
            drop(state);
            Ok(results
                .iter()
                .filter_map(|item| {
                    Some(Transcript {
                        start_ms: item.get("startMs")?.as_f64()?,
                        end_ms: item.get("endMs")?.as_f64()?,
                        text: item.get("text")?.as_str()?.into(),
                    })
                })
                .collect())
        })
    }

    fn health_check(&self) -> BoxFuture<'_, Result<Health, TranscriptionError>> {
        Box::pin(async move {
            self.refresh();
            let (initialized, disposed, known) = {
                let state = self.state();
                (state.initialized, state.disposed, state.metrics.clone())
            };
            if !initialized || disposed {
                return Ok(Health {
                    healthy: false,
                    initialized: false,
                    metrics: known,
                });
            }
            let response = self.worker.request(request("health", []), None).await;
            self.refresh();
            let healthy = response?
                .get("healthy")
                .and_then(Value::as_bool)
                .ok_or_else(|| {
                    TranscriptionError::failure("Transcription worker omitted health status")
                })?;
            Ok(Health {
                healthy,
                initialized: true,
                metrics: self.state().metrics.clone(),
            })
        })
    }

    fn dispose(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if std::mem::replace(&mut self.state().disposed, true) {
                return;
            }
            self.worker.close().await;
            let mut state = self.state();
            state.initialized = false;
            state.metrics = None;
        })
    }
}

fn metrics(response: &Value) -> Metrics {
    let text = |key: &str| {
        response
            .get("metrics")
            .and_then(|metrics| metrics.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    Metrics {
        device: text("device"),
        warning: text("warning"),
    }
}

struct Shared {
    next_id: AtomicU64,
    dead: AtomicBool,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, TranscriptionError>>>>,
    stderr_tail: Mutex<String>,
}

impl Shared {
    fn fail_all(&self, error: TranscriptionError) -> TranscriptionError {
        self.dead.store(true, Ordering::Release);
        let error = if error.kind == ErrorKind::Cancelled {
            error
        } else {
            let tail = self
                .stderr_tail
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .trim()
                .to_owned();
            let detail = match tail.lines().last() {
                Some(line) => format!("{}: {line}", error.message),
                None => error.message,
            };
            TranscriptionError::failure(sanitize_error(&detail))
        };
        let pending = std::mem::take(
            &mut *self
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        for (_, sender) in pending {
            let _ = sender.send(Err(error.clone()));
        }
        error
    }

    fn append_stderr(&self, bytes: &[u8]) {
        let mut tail = self
            .stderr_tail
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        tail.push_str(&String::from_utf8_lossy(bytes));
        let characters = tail.chars().count();
        if characters > MAX_STDERR_CHARACTERS {
            *tail = tail
                .chars()
                .skip(characters - MAX_STDERR_CHARACTERS)
                .collect();
        }
        let lines: Vec<_> = tail.split('\n').collect();
        if lines.len() > MAX_STDERR_LINES {
            *tail = lines[lines.len() - MAX_STDERR_LINES..].join("\n");
        }
    }
}

struct Live {
    control: Control,
    exit: watch::Receiver<bool>,
    monitor: JoinHandle<()>,
}

struct Worker {
    config: TranscriptionConfig,
    shared: Arc<Shared>,
    live: tokio::sync::Mutex<Option<Live>>,
}

impl Worker {
    fn new(config: TranscriptionConfig) -> Self {
        Self {
            config,
            shared: Arc::new(Shared {
                next_id: AtomicU64::new(0),
                dead: AtomicBool::new(false),
                pending: Mutex::new(HashMap::new()),
                stderr_tail: Mutex::new(String::new()),
            }),
            live: tokio::sync::Mutex::new(None),
        }
    }

    fn failed(&self) -> bool {
        self.shared.dead.load(Ordering::Acquire)
    }

    async fn control(&self) -> Result<Control, TranscriptionError> {
        let mut live = self.live.lock().await;
        if let Some(live) = live.as_ref() {
            return Ok(live.control.clone());
        }
        let mut command =
            process::Command::new(self.config.python_executable.clone(), ["-c", WORKER_SOURCE]);
        command
            .env
            .insert("HF_HUB_CACHE".into(), self.config.cache_dir.clone());
        let mut child = process::spawn(command).await.map_err(|_| {
            self.shared.fail_all(TranscriptionError::failure(
                "Transcription worker failed to start",
            ))
        })?;
        let control = child.control();
        let Some(output) = child.take_output() else {
            return Err(self.shared.fail_all(TranscriptionError::failure(
                "Transcription worker failed to start",
            )));
        };
        let (exited, exit) = watch::channel(false);
        let reader = tokio::spawn(read_output(self.shared.clone(), control.clone(), output));
        let shared = self.shared.clone();
        let monitor = tokio::spawn(async move {
            let status = child.wait().await.ok().and_then(|exit| exit.code);
            let _ = reader.await;
            shared.fail_all(TranscriptionError::failure(format!(
                "Transcription worker exited ({})",
                status.map_or("signal".to_owned(), |code| code.to_string())
            )));
            let _ = exited.send(true);
        });
        *live = Some(Live {
            control: control.clone(),
            exit,
            monitor,
        });
        Ok(control)
    }

    async fn request(
        &self,
        mut message: Map<String, Value>,
        mut signal: Option<watch::Receiver<bool>>,
    ) -> Result<Value, TranscriptionError> {
        if signal.as_ref().is_some_and(|signal| *signal.borrow()) {
            return Err(TranscriptionError::cancelled());
        }
        if self.failed() {
            return Err(TranscriptionError::failure(
                "Transcription worker is unavailable",
            ));
        }
        let control = self.control().await?;
        let id = (self.shared.next_id.fetch_add(1, Ordering::AcqRel) + 1).to_string();
        message.insert("id".into(), json!(id));
        let mut line = Value::Object(message).to_string();
        line.push('\n');
        if line.len() > MAX_REQUEST_BYTES {
            return Err(TranscriptionError::failure(
                "Transcription request exceeds the protocol limit",
            ));
        }
        let (sender, mut response) = oneshot::channel();
        self.shared
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(id, sender);
        if control.write(line.into_bytes()).await.is_err() {
            let error = self.shared.fail_all(TranscriptionError::failure(
                "Could not write to transcription worker",
            ));
            let _ = control.signal(KillSignal::Term).await;
            return Err(error);
        }
        let cancelled = async {
            match signal.as_mut() {
                Some(signal) => {
                    let _ = signal.wait_for(|cancelled| *cancelled).await;
                }
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            result = &mut response => result.unwrap_or_else(|_| Err(TranscriptionError::failure("Transcription worker is unavailable"))),
            _ = tokio::time::sleep(Duration::from_millis(self.config.request_timeout_ms)) => {
                let error = self.shared.fail_all(TranscriptionError::failure("Transcription worker request timed out"));
                let _ = control.kill(KillOptions { signal: KillSignal::Kill, force_kill_after: Some(Duration::ZERO) }).await;
                Err(error)
            }
            _ = cancelled => {
                let error = self.shared.fail_all(TranscriptionError::cancelled());
                let _ = control.signal(KillSignal::Term).await;
                Err(error)
            }
        }
    }

    async fn close(&self) {
        self.shared
            .fail_all(TranscriptionError::failure("Transcription worker closed"));
        let Some(mut live) = self.live.lock().await.take() else {
            return;
        };
        let _ = live.control.close_input().await;
        let _ = live
            .control
            .kill(KillOptions {
                signal: KillSignal::Term,
                force_kill_after: Some(TERMINATE_GRACE),
            })
            .await;
        if tokio::time::timeout(EXIT_WAIT, live.exit.wait_for(|exited| *exited))
            .await
            .is_err()
        {
            live.control.terminate_now();
            live.monitor.abort();
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        if let Ok(live) = self.live.try_lock()
            && let Some(live) = live.as_ref()
        {
            live.control.terminate_now();
        }
    }
}

async fn read_output(shared: Arc<Shared>, control: Control, mut output: mpsc::Receiver<Chunk>) {
    let mut buffer: Vec<u8> = Vec::new();
    while let Some(chunk) = output.recv().await {
        match chunk.kind {
            StreamKind::Stderr => shared.append_stderr(&chunk.bytes),
            StreamKind::Stdout => {
                buffer.extend_from_slice(&chunk.bytes);
                while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<u8> = buffer.drain(..=newline).collect();
                    if line.len() - 1 > MAX_RESPONSE_BYTES
                        || !receive(&shared, &line[..line.len() - 1])
                    {
                        shared.fail_all(TranscriptionError::failure(
                            if line.len() - 1 > MAX_RESPONSE_BYTES {
                                "Transcription worker response exceeds the protocol limit"
                            } else {
                                "Transcription worker returned invalid JSON"
                            },
                        ));
                        control.terminate_now();
                        return;
                    }
                }
                if buffer.len() > MAX_RESPONSE_BYTES {
                    shared.fail_all(TranscriptionError::failure(
                        "Transcription worker response exceeds the protocol limit",
                    ));
                    control.terminate_now();
                    return;
                }
            }
            StreamKind::Fd(_) => (),
        }
    }
}

fn receive(shared: &Shared, line: &[u8]) -> bool {
    let Ok(response) = serde_json::from_slice::<Value>(line) else {
        return false;
    };
    if !valid_response(&response) {
        return false;
    }
    let Some(sender) = shared
        .pending
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(response["id"].as_str().unwrap_or_default())
    else {
        return true;
    };
    let _ = sender.send(if response["ok"] == Value::Bool(true) {
        Ok(response)
    } else {
        Err(TranscriptionError::failure(sanitize_error(
            response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Transcription worker failed"),
        )))
    });
    true
}

fn valid_response(response: &Value) -> bool {
    let optional = |key: &str, check: fn(&Value) -> bool| response.get(key).is_none_or(check);
    response.get("id").is_some_and(Value::is_string)
        && response.get("ok").is_some_and(Value::is_boolean)
        && optional("error", Value::is_string)
        && optional("healthy", Value::is_boolean)
        && optional("results", |results| {
            results.as_array().is_some_and(|items| {
                items.iter().all(|item| {
                    item.get("startMs").is_some_and(Value::is_number)
                        && item.get("endMs").is_some_and(Value::is_number)
                        && item.get("text").is_some_and(Value::is_string)
                })
            })
        })
        && optional("metrics", |metrics| {
            metrics.as_object().is_some_and(|map| {
                [
                    "initializationMs",
                    "inferenceMs",
                    "realTimeFactor",
                    "peakMemoryMb",
                ]
                .iter()
                .all(|key| map.get(*key).is_none_or(Value::is_number))
                    && ["device", "warning"]
                        .iter()
                        .all(|key| map.get(*key).is_none_or(Value::is_string))
            })
        })
        && optional("inventory", |inventory| {
            inventory.as_array().is_some_and(|items| {
                items.iter().all(|item| {
                    item.get("id").is_some_and(Value::is_string)
                        && item.get("installed").is_some_and(Value::is_boolean)
                        && item.get("architecture").is_none_or(Value::is_string)
                        && item.get("reason").is_none_or(Value::is_string)
                })
            })
        })
}
