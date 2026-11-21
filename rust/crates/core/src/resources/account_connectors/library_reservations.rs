use super::{
    Context, Failure, LosslessString, Prepared, Value, attachment_store, object, text, unavailable,
};
use crate::cca::{
    encoding::{sha256_hex, uuid_v4},
    error::{AuthorizationInput, BoxFuture, ExecutorError, Grant},
    library::{LibraryCallError, LibraryOpenInput, LibraryProcess, LibraryTool},
    signal::Signal,
    value::{JsonObject, parse_json, stringify_json},
};
use std::{
    future::Future,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Mutex, OnceCell, mpsc, oneshot},
    task::JoinHandle,
    time::Instant,
};
use ycoding_schema::prompt::ManagedAttachmentContent;

const PREPARE: &str = "ycoding_library.prepare_uploads";
const FINALIZE: &str = "ycoding_library.finalize_uploads";
const INPUT_LIMIT: usize = 256 * 1024;

pub(super) struct Operation<'a> {
    context: &'a Context,
    stop: &'a Signal,
    cancelled: &'a Signal,
    expires: Option<Instant>,
    dispatched: &'a AtomicBool,
}

impl Operation<'_> {
    fn live(&self) -> Result<(), Failure> {
        if self.stop.is_cancelled() || self.cancelled.is_cancelled() {
            return Err(Failure::Retired);
        }
        if self
            .expires
            .is_some_and(|expires| Instant::now() >= expires)
        {
            return Err(Failure::Expired);
        }
        Ok(())
    }

    pub(super) async fn current(&self) -> Result<Prepared, Failure> {
        self.live()?;
        let prepared = self.context.current().await;
        self.live()?;
        prepared
    }

    pub(super) async fn check(&self) -> Result<(), Failure> {
        self.current().await.map(|_| ())
    }

    pub(super) fn dispatch(&self) {
        self.dispatched.store(true, Ordering::Release);
    }

    pub(super) async fn io<T>(
        &self,
        work: impl Future<Output = Result<T, ()>>,
    ) -> Result<T, Failure> {
        self.check().await?;
        let outcome = tokio::select! {
            biased;
            _ = self.stop.cancelled() => Err(Failure::Retired),
            _ = self.cancelled.cancelled() => Err(Failure::Retired),
            _ = deadline(self.expires) => Err(Failure::Expired),
            outcome = work => outcome.map_err(|_| Failure::Uncertain),
        };
        self.check().await?;
        outcome
    }
}

async fn deadline(expires: Option<Instant>) {
    match expires {
        Some(expires) => tokio::time::sleep_until(expires).await,
        None => std::future::pending::<()>().await,
    }
}

struct Item {
    path: String,
    name: LosslessString,
    bytes: usize,
    mime: Option<LosslessString>,
}

impl Item {
    fn decode(value: &Value) -> Result<Self, Failure> {
        let item = upload(
            value,
            &[
                "workspace_path",
                "file_name",
                "purpose",
                "file_size_bytes",
                "mime_type",
            ],
        )?;
        if string(item, "purpose")? != LosslessString::from("create_library_file") {
            return Err(Failure::Invalid);
        }
        let path = string(item, "workspace_path")?
            .to_utf8()
            .map_err(|_| Failure::Invalid)?;
        let name = string(item, "file_name")?;
        if !name_valid(&name)
            || !crate::cca::policy::is_absolute(&path)
            || LosslessString::from(crate::cca::policy::basename(&path).as_str()) != name
        {
            return Err(Failure::Invalid);
        }
        let bytes = size(item)?;
        let mime = match item.get(&"mime_type".into()) {
            None => None,
            Some(Value::String(mime)) if mime_valid(mime) => Some(mime.clone()),
            _ => return Err(Failure::Invalid),
        };
        Ok(Self {
            path,
            name,
            bytes,
            mime,
        })
    }

    fn value(&self) -> Value {
        let Value::Object(mut value) = object([
            ("workspace_path", text(&self.path)),
            ("file_name", Value::String(self.name.clone())),
            ("purpose", text("create_library_file")),
            ("file_size_bytes", Value::Number(self.bytes as f64)),
        ]) else {
            unreachable!()
        };
        if let Some(mime) = &self.mime {
            value.insert("mime_type".into(), Value::String(mime.clone()));
        }
        Value::Object(value)
    }
}

#[derive(Clone, PartialEq)]
struct Echo {
    token: LosslessString,
    id: LosslessString,
    path: String,
    name: LosslessString,
    mime: LosslessString,
    bytes: usize,
}

impl Echo {
    fn decode(value: &Value) -> Result<Self, Failure> {
        let item = upload(
            value,
            &[
                "workspace_path",
                "file_name",
                "purpose",
                "file_size_bytes",
                "mime_type",
                "upload_session_id",
                "file_id",
                "store_in_library",
            ],
        )?;
        if item.get(&"store_in_library".into()) != Some(&Value::Bool(true))
            || string(item, "purpose")? != LosslessString::from("create_library_file")
        {
            return Err(Failure::Invalid);
        }
        let token = string(item, "upload_session_id")?;
        let id = string(item, "file_id")?;
        let path = string(item, "workspace_path")?
            .to_utf8()
            .map_err(|_| Failure::Invalid)?;
        let name = string(item, "file_name")?;
        let mime = string(item, "mime_type")?;
        if token.is_empty() || !name_valid(&name) || !mime_valid(&mime) {
            return Err(Failure::Invalid);
        }
        Ok(Self {
            token,
            id,
            path,
            name,
            mime,
            bytes: size(item)?,
        })
    }

    fn value(&self) -> Value {
        object([
            ("upload_session_id", Value::String(self.token.clone())),
            ("file_id", Value::String(self.id.clone())),
            ("workspace_path", text(&self.path)),
            ("file_name", Value::String(self.name.clone())),
            ("purpose", text("create_library_file")),
            ("store_in_library", Value::Bool(true)),
            ("mime_type", Value::String(self.mime.clone())),
            ("file_size_bytes", Value::Number(self.bytes as f64)),
        ])
    }

    fn reply(&self) -> Value {
        object([("uploads", Value::Array(vec![self.value()]))])
    }
}

fn upload<'a>(value: &'a Value, allowed: &[&str]) -> Result<&'a JsonObject, Failure> {
    if stringify_json(value).len() > INPUT_LIMIT {
        return Err(Failure::Invalid);
    }
    let Value::Object(root) = value else {
        return Err(Failure::Invalid);
    };
    if root.len() != 1 {
        return Err(Failure::Invalid);
    }
    let Some(Value::Array(items)) = root.get(&"uploads".into()) else {
        return Err(Failure::Invalid);
    };
    let [Value::Object(item)] = items.as_slice() else {
        return Err(Failure::Invalid);
    };
    if item.iter().any(|(key, _)| {
        !allowed
            .iter()
            .any(|allowed| key == &LosslessString::from(*allowed))
    }) {
        return Err(Failure::Invalid);
    }
    Ok(item)
}

fn supplied_token(value: &Value) -> Option<&LosslessString> {
    let Value::Object(root) = value else {
        return None;
    };
    let Some(Value::Array(items)) = root.get(&"uploads".into()) else {
        return None;
    };
    let [Value::Object(item)] = items.as_slice() else {
        return None;
    };
    match item.get(&"upload_session_id".into()) {
        Some(Value::String(token)) => Some(token),
        _ => None,
    }
}

fn string(value: &JsonObject, key: &str) -> Result<LosslessString, Failure> {
    match value.get(&key.into()) {
        Some(Value::String(value)) => Ok(value.clone()),
        _ => Err(Failure::Invalid),
    }
}

fn size(value: &JsonObject) -> Result<usize, Failure> {
    match value.get(&"file_size_bytes".into()) {
        Some(Value::Number(value))
            if value.is_finite()
                && value.fract() == 0.0
                && *value >= 1.0
                && *value <= attachment_store::MAX_BYTES as f64 =>
        {
            Ok(*value as usize)
        }
        _ => Err(Failure::Invalid),
    }
}

fn name_valid(value: &LosslessString) -> bool {
    (1..=255).contains(&value.code_units().count())
        && !value
            .code_units()
            .any(|unit| matches!(unit, 47 | 92 | 13 | 10))
}

fn mime_valid(value: &LosslessString) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    let Some((top, sub)) = value.split_once('/') else {
        return false;
    };
    [top, sub].iter().all(|part| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".+-".contains(&byte))
    })
}

#[derive(Clone)]
struct Reservation {
    key: String,
    echo: Echo,
    content: ManagedAttachmentContent,
}

struct Completed {
    key: String,
    echo: Echo,
    reply: Value,
}

#[derive(Default)]
struct State {
    grant: Option<Grant>,
    active: Option<Reservation>,
    completed: Option<Completed>,
    expires: Option<Instant>,
    unknown: bool,
    retired: bool,
    cleanup_failed: bool,
}

impl State {
    async fn release(&mut self, context: &Context) -> Result<(), Failure> {
        let Some(grant) = self.grant.take() else {
            return Ok(());
        };
        let before = context.fence().await;
        let outcome = grant.release().await;
        let after = context.fence().await;
        self.retired |= before.is_err() || after.is_err();
        if outcome.is_err() {
            self.cleanup_failed = true;
            return Err(Failure::Cleanup);
        }
        Ok(())
    }

    async fn retire(&mut self, context: &Context) -> Result<(), Failure> {
        self.retired = true;
        self.active = None;
        self.completed = None;
        self.expires = None;
        self.release(context).await
    }
}

struct Call {
    name: String,
    value: Value,
    cancelled: Signal,
    reply: oneshot::Sender<Result<Value, LibraryCallError>>,
}

struct CancelCall(Signal);
impl Drop for CancelCall {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

struct Process {
    context: Arc<Context>,
    stop: Signal,
    closed: Arc<AtomicBool>,
    busy: Arc<AtomicBool>,
    calls: mpsc::Sender<Call>,
    closing: Arc<Closing>,
    tools: Vec<LibraryTool>,
}

type WorkerHandle = JoinHandle<Result<(), ExecutorError>>;

struct Closing {
    worker: OnceLock<Mutex<Option<WorkerHandle>>>,
    outcome: OnceCell<Result<(), ExecutorError>>,
}

impl Closing {
    async fn wait(&self) -> Result<(), ExecutorError> {
        self.outcome
            .get_or_init(|| async {
                let worker = self.worker.get().ok_or_else(unavailable)?;
                let mut worker = worker.lock().await;
                let outcome = match worker.as_mut() {
                    Some(worker) => worker.await.map_err(|_| unavailable())?,
                    None => return Err(unavailable()),
                };
                *worker = None;
                outcome
            })
            .await
            .clone()
    }
}

impl LibraryProcess for Process {
    fn check(&self) -> BoxFuture<'_, Result<(), ExecutorError>> {
        Box::pin(async move {
            if self.stop.is_cancelled() || self.closed.load(Ordering::Acquire) {
                return Err(unavailable());
            }
            if self.context.current().await.is_err() {
                self.close().await?;
                return Err(unavailable());
            }
            if self.stop.is_cancelled() || self.closed.load(Ordering::Acquire) {
                return Err(unavailable());
            }
            Ok(())
        })
    }

    fn tools(&self) -> Vec<LibraryTool> {
        self.tools.clone()
    }

    fn call(&self, name: &str, arguments: Value) -> BoxFuture<'_, Result<Value, LibraryCallError>> {
        let name = name.to_owned();
        Box::pin(async move {
            self.check().await.map_err(|_| LibraryCallError::Failed)?;
            if !matches!(name.as_str(), PREPARE | FINALIZE)
                || self
                    .busy
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
            {
                return Err(LibraryCallError::Failed);
            }
            let (reply, result) = oneshot::channel();
            let cancelled = Signal::default();
            let cancellation = CancelCall(cancelled.clone());
            if self
                .calls
                .try_send(Call {
                    name,
                    value: arguments,
                    cancelled,
                    reply,
                })
                .is_err()
            {
                self.busy.store(false, Ordering::Release);
                return Err(LibraryCallError::Failed);
            }
            let outcome = result.await.map_err(|_| LibraryCallError::Failed)?;
            drop(cancellation);
            outcome
        })
    }

    fn close(&self) -> BoxFuture<'_, Result<(), ExecutorError>> {
        self.stop.cancel();
        let closing = self.closing.clone();
        Box::pin(async move { closing.wait().await })
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

struct Worker {
    context: Arc<Context>,
    owner: LibraryOpenInput,
    nonce: LosslessString,
    lifetime: Duration,
    stop: Signal,
    closed: Arc<AtomicBool>,
    busy: Arc<AtomicBool>,
    state: State,
}

struct WorkerExit {
    closed: Arc<AtomicBool>,
    busy: Arc<AtomicBool>,
}
impl Drop for WorkerExit {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Release);
        self.busy.store(false, Ordering::Release);
    }
}

impl Worker {
    async fn read(
        &self,
        operation: &Operation<'_>,
        path: &str,
        expected: usize,
    ) -> Result<(String, Vec<u8>), Failure> {
        operation.check().await?;
        let outcome = (self.owner.read_file)(path.to_owned()).await;
        operation.check().await?;
        let (canonical, bytes) = outcome.map_err(|_| Failure::Invalid)?;
        if !crate::cca::policy::is_absolute(&canonical)
            || bytes.len() != expected
            || bytes.is_empty()
            || bytes.len() > attachment_store::MAX_BYTES
            || !self
                .context
                .input
                .scope
                .roots
                .iter()
                .any(|root| crate::cca::policy::within(&canonical, root))
        {
            return Err(Failure::Invalid);
        }
        Ok((canonical, bytes))
    }

    async fn prepare(
        &mut self,
        value: &Value,
        cancelled: &Signal,
        dispatched: &AtomicBool,
        created_file: &mut bool,
    ) -> Result<Value, Failure> {
        let context = self.context.clone();
        let stop = self.stop.clone();
        let operation = Operation {
            context: &context,
            stop: &stop,
            cancelled,
            expires: self.state.expires,
            dispatched,
        };
        let item = Item::decode(value)?;
        let (canonical, bytes) = self.read(&operation, &item.path, item.bytes).await?;
        operation.check().await?;
        let attachments = context.input.attachments.clone();
        let imported = tokio::task::spawn_blocking(move || {
            attachments.import(&bytes).map(|content| (content, bytes))
        })
        .await;
        operation.check().await?;
        let (content, bytes) = imported
            .map_err(|_| Failure::Invalid)?
            .map_err(|_| Failure::Invalid)?;
        let key = sha256_hex(
            stringify_json(&object([
                ("item", item.value()),
                ("canonical", text(&canonical)),
                ("digest", Value::String(content.digest.0.clone())),
                ("scope", context.identity.clone()),
                ("nonce", Value::String(self.nonce.clone())),
                ("processID", Value::String(self.owner.process_id.clone())),
                ("cwd", text(&self.owner.cwd)),
            ]))
            .as_bytes(),
        );
        if let Some(active) = &self.state.active {
            return if active.key == key {
                Ok(active.echo.reply())
            } else {
                Err(Failure::Invalid)
            };
        }
        if let Some(completed) = &self.state.completed
            && completed.key == key
        {
            return Ok(completed.echo.reply());
        }
        operation.check().await?;
        let Value::Object(metadata) = object([
            ("operationDigest", text(&key)),
            ("connectorLabel", text("YCoding Library bridge")),
        ]) else {
            unreachable!()
        };
        let grant = context
            .input
            .scope
            .authorize
            .authorize(AuthorizationInput {
                action: "chatgpt_library_upload".into(),
                guardrail_action: Some("mcp_execute".into()),
                resources: vec![item.name.clone()],
                metadata: Some(metadata),
            })
            .await;
        match grant {
            Ok(grant) => self.state.grant = Some(grant),
            Err(denied) => {
                operation.check().await?;
                return Err(Failure::Denied(denied));
            }
        }
        operation.check().await?;
        self.state.completed = None;
        self.state.expires = Some(
            Instant::now()
                .checked_add(self.lifetime)
                .ok_or(Failure::Invalid)?,
        );
        let operation = Operation {
            expires: self.state.expires,
            ..operation
        };
        let mime = item
            .mime
            .clone()
            .unwrap_or_else(|| crate::session::attachment_admission::detect(&bytes).into());
        let created = context
            .transport
            .create(&operation, &item.name, &mime, bytes.len())
            .await?;
        *created_file = true;
        operation.check().await?;
        context
            .transport
            .transfer(&operation, &created, &item.name, &mime, bytes)
            .await?;
        operation.check().await?;
        let echo = Echo {
            token: uuid_v4().into(),
            id: created.id,
            path: canonical,
            name: item.name,
            mime,
            bytes: content.bytes.get() as usize,
        };
        self.state.active = Some(Reservation {
            key,
            echo: echo.clone(),
            content,
        });
        Ok(echo.reply())
    }

    async fn finalize(
        &mut self,
        value: &Value,
        cancelled: &Signal,
        dispatched: &AtomicBool,
        finalizing: &mut bool,
    ) -> Result<Value, Failure> {
        let echo = match Echo::decode(value) {
            Ok(echo) => echo,
            Err(error) => {
                if self
                    .state
                    .active
                    .as_ref()
                    .is_some_and(|active| supplied_token(value) == Some(&active.echo.token))
                {
                    *finalizing = true;
                    return Err(Failure::InvalidFinalization);
                }
                return Err(error);
            }
        };
        if let Some(completed) = &self.state.completed
            && completed.echo == echo
        {
            return Ok(completed.reply.clone());
        }
        let reservation = self
            .state
            .active
            .as_ref()
            .filter(|reservation| reservation.echo.token == echo.token)
            .cloned()
            .ok_or(Failure::Invalid)?;
        *finalizing = true;
        if reservation.echo != echo {
            return Err(Failure::InvalidFinalization);
        }
        let context = self.context.clone();
        let stop = self.stop.clone();
        let operation = Operation {
            context: &context,
            stop: &stop,
            cancelled,
            expires: self.state.expires,
            dispatched,
        };
        let (canonical, bytes) = self.read(&operation, &echo.path, echo.bytes).await?;
        if canonical != echo.path {
            return Err(Failure::Uncertain);
        }
        operation.check().await?;
        let (attachments, content) = (
            context.input.attachments.clone(),
            reservation.content.clone(),
        );
        let stored = tokio::task::spawn_blocking(move || attachments.read(&content)).await;
        operation.check().await?;
        let stored = stored
            .map_err(|_| Failure::Uncertain)?
            .map_err(|_| Failure::Uncertain)?;
        let digest = reservation
            .content
            .digest
            .0
            .as_str()
            .ok_or(Failure::Uncertain)?;
        if sha256_hex(&bytes) != digest || sha256_hex(&stored) != digest {
            return Err(Failure::Uncertain);
        }
        self.state.active = None;
        let reply = context
            .transport
            .finalize(&operation, &echo.id, &echo.name, &echo.mime)
            .await?;
        operation.check().await?;
        self.state.release(&context).await?;
        operation.check().await?;
        if self.state.retired {
            return Err(Failure::Retired);
        }
        self.state.completed = Some(Completed {
            key: reservation.key,
            echo: reservation.echo,
            reply: reply.clone(),
        });
        Ok(reply)
    }

    async fn call(
        &mut self,
        name: &str,
        value: &Value,
        cancelled: &Signal,
    ) -> Result<Value, Failure> {
        let dispatched = AtomicBool::new(false);
        let operation = Operation {
            context: &self.context,
            stop: &self.stop,
            cancelled,
            expires: self.state.expires,
            dispatched: &dispatched,
        };
        let admitted = operation.check().await;
        let mut finalizing = false;
        let mut created_file = false;
        let outcome = match admitted {
            Err(error) => Err(error),
            Ok(()) if self.state.unknown || self.state.retired => Err(Failure::Uncertain),
            Ok(()) => match name {
                PREPARE => {
                    self.prepare(value, cancelled, &dispatched, &mut created_file)
                        .await
                }
                FINALIZE => {
                    self.finalize(value, cancelled, &dispatched, &mut finalizing)
                        .await
                }
                _ => Err(Failure::Invalid),
            },
        };
        let outcome = match outcome {
            Ok(value) => {
                let operation = Operation {
                    context: &self.context,
                    stop: &self.stop,
                    cancelled,
                    expires: self.state.expires,
                    dispatched: &dispatched,
                };
                operation.check().await.map(|_| value)
            }
            Err(error) => Err(error),
        };
        let Err(error) = outcome else {
            return outcome;
        };
        self.state.retired |= matches!(error, Failure::Retired | Failure::Expired);
        if !created_file && !finalizing && matches!(error, Failure::Rejected(401 | 403)) {
            self.state.expires = None;
            self.state.release(&self.context).await?;
            return Err(error);
        }
        if dispatched.load(Ordering::Acquire) || finalizing {
            self.state.unknown = true;
            self.state.active = None;
            self.state.completed = None;
            self.state.release(&self.context).await?;
            return Err(if matches!(error, Failure::InvalidFinalization) {
                error
            } else {
                Failure::Uncertain
            });
        }
        if self.state.active.is_none() && self.state.completed.is_none() {
            self.state.expires = None;
        }
        if self.state.active.is_none() {
            self.state.release(&self.context).await?;
        }
        Err(error)
    }

    async fn run(mut self, mut calls: mpsc::Receiver<Call>) -> Result<(), ExecutorError> {
        let _exit = WorkerExit {
            closed: self.closed.clone(),
            busy: self.busy.clone(),
        };
        loop {
            let call = tokio::select! {
                biased;
                _ = self.stop.cancelled() => break,
                _ = deadline(self.state.expires) => break,
                call = calls.recv() => match call { Some(call) => call, None => break },
            };
            let outcome = self.call(&call.name, &call.value, &call.cancelled).await;
            let outcome = match outcome {
                Ok(value) => Ok(value),
                Err(Failure::Denied(denied)) => Err(LibraryCallError::Denied(denied)),
                Err(_) => Err(LibraryCallError::Failed),
            };
            if call.reply.send(outcome).is_err() {
                self.state.unknown = true;
                self.state.active = None;
                self.state.completed = None;
                if self.state.release(&self.context).await.is_err() {
                    self.state.cleanup_failed = true;
                }
            }
            self.busy.store(false, Ordering::Release);
            if self.state.retired || self.state.cleanup_failed {
                break;
            }
        }
        self.stop.cancel();
        calls.close();
        while let Ok(call) = calls.try_recv() {
            if call.reply.send(Err(LibraryCallError::Failed)).is_err() {
                self.state.unknown = true;
            }
        }
        let retired = self.state.retire(&self.context).await;
        if self.state.cleanup_failed || retired.is_err() {
            Err(unavailable())
        } else {
            Ok(())
        }
    }
}

pub(super) fn open(
    context: Arc<Context>,
    owner: LibraryOpenInput,
    lifetime: Duration,
) -> Result<Arc<dyn LibraryProcess>, ExecutorError> {
    let tools = tools().map_err(|_| unavailable())?;
    let stop = Signal::default();
    let closed = Arc::new(AtomicBool::new(false));
    let busy = Arc::new(AtomicBool::new(false));
    let (sender, receiver) = mpsc::channel(1);
    let worker = Worker {
        context: context.clone(),
        owner,
        nonce: uuid_v4().into(),
        lifetime,
        stop: stop.clone(),
        closed: closed.clone(),
        busy: busy.clone(),
        state: State::default(),
    };
    let closing = Arc::new(Closing {
        worker: OnceLock::new(),
        outcome: OnceCell::new(),
    });
    let retained = closing.clone();
    let handle = tokio::spawn(async move {
        let outcome = worker.run(receiver).await;
        drop(retained);
        outcome
    });
    closing.worker.get_or_init(|| Mutex::new(Some(handle)));
    let process = Arc::new(Process {
        context,
        stop,
        closed,
        busy,
        calls: sender,
        closing,
        tools,
    });
    Ok(process)
}

fn tools() -> Result<Vec<LibraryTool>, Failure> {
    let definition = parse_json(r#"[
      {"name":"ycoding_library.prepare_uploads","description":"YCoding private Library bridge. Supports one create_library_file upload using the process's authorized local file. No replacement, shared, directory, version or artifact-type operations.","_meta":{"connector_id":"connector_openai_library","connector_name":"YCoding Library bridge"},"inputSchema":{"type":"object","additionalProperties":false,"required":["uploads"],"properties":{"uploads":{"type":"array","minItems":1,"maxItems":1,"items":{"type":"object","additionalProperties":false,"required":["workspace_path","file_name","purpose","file_size_bytes"],"properties":{"workspace_path":{"type":"string","minLength":1},"file_name":{"type":"string","minLength":1,"maxLength":255,"pattern":"^[^/\\\\\\r\\n]{1,255}$"},"purpose":{"type":"string","const":"create_library_file"},"file_size_bytes":{"type":"integer","minimum":1,"maximum":20971520},"mime_type":{"type":"string","pattern":"^[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+$"}}}}}}},
      {"name":"ycoding_library.finalize_uploads","description":"YCoding private Library bridge. Supports one create_library_file upload using the process's authorized local file. No replacement, shared, directory, version or artifact-type operations.","_meta":{"connector_id":"connector_openai_library","connector_name":"YCoding Library bridge"},"inputSchema":{"type":"object","additionalProperties":false,"required":["uploads"],"properties":{"uploads":{"type":"array","minItems":1,"maxItems":1,"items":{"type":"object","additionalProperties":false,"required":["workspace_path","file_name","purpose","file_size_bytes","mime_type","upload_session_id","file_id","store_in_library"],"properties":{"workspace_path":{"type":"string","minLength":1},"file_name":{"type":"string","minLength":1,"maxLength":255,"pattern":"^[^/\\\\\\r\\n]{1,255}$"},"purpose":{"type":"string","const":"create_library_file"},"file_size_bytes":{"type":"integer","minimum":1,"maximum":20971520},"mime_type":{"type":"string","pattern":"^[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+$"},"upload_session_id":{"type":"string"},"file_id":{"type":"string"},"store_in_library":{"type":"boolean","const":true}}}}}}}
    ]"#).map_err(|_| Failure::Invalid)?;
    let Value::Array(definitions) = definition else {
        return Err(Failure::Invalid);
    };
    definitions
        .into_iter()
        .map(|definition| {
            let Value::Object(object) = &definition else {
                return Err(Failure::Invalid);
            };
            let name = string(object, "name")?
                .to_utf8()
                .map_err(|_| Failure::Invalid)?;
            Ok(LibraryTool { name, definition })
        })
        .collect()
}
