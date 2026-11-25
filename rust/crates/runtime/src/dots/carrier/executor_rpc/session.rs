use super::{
    control::{Abort, Sequencer, Signal, locked},
    error::*,
    handler::*,
    json::{
        self, MAX_MESSAGE_BYTES, ObjectBuilder, ParseFailure, RequestId, error_frame, parse_bytes,
        request_frame, success_frame, within_complexity,
    },
    types::*,
    wire_base, wire_env, wire_fs, wire_http,
};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{sync::oneshot, task::AbortHandle};
use ycoding_core::ycoding_schema::{JsonValue, LosslessString};

pub const CALL_TIMEOUT: Duration = Duration::from_millis(30_000);
const METHOD_NAME_UNITS: usize = 256;
const ECHOED_METHOD_UNITS: usize = 64;

pub const SUPPORTED_METHODS: [&str; 25] = [
    "initialize",
    "environment/info",
    "environment/status",
    "process/start",
    "process/read",
    "process/write",
    "process/signal",
    "process/terminate",
    "fs/readFile",
    "fs/writeFile",
    "fs/getMetadata",
    "fs/readDirectory",
    "fs/canonicalize",
    "environmentConfig/read",
    "capabilityRoots/discoverV1",
    "capabilities/discoverV2",
    "fs/createDirectory",
    "fs/open",
    "fs/readBlock",
    "fs/writeBlock",
    "fs/close",
    "fs/walk",
    "fs/remove",
    "fs/copy",
    "http/request",
];

pub const CONTROL_METHODS: [&str; 4] = [
    "process/signal",
    "process/terminate",
    "environment/info",
    "environment/status",
];

pub type FrameSink = Arc<dyn Fn(Vec<u8>) -> Boxed<'static, Result<(), SendFailed>> + Send + Sync>;

pub struct SessionOptions {
    pub environment_info: EnvironmentInfoFn,
    pub handler: Arc<dyn ExecutorHandler>,
    pub send_notification: Option<NotifyFn>,
    pub send_frame: Option<FrameSink>,
    pub signal: Option<Signal>,
}

#[derive(Default)]
struct State {
    closed: bool,
    initialize_requested: bool,
    initialized: bool,
    session_id: Option<String>,
    connection: Option<Arc<dyn ExecutorConnection>>,
}

type PendingCall = oneshot::Sender<Result<JsonValue, CallError>>;

struct Inner {
    environment_info: EnvironmentInfoFn,
    handler: Arc<dyn ExecutorHandler>,
    send_notification: Option<NotifyFn>,
    send_frame: Option<FrameSink>,
    controller: Arc<Abort>,
    signal: Signal,
    forwarder: Mutex<Option<AbortHandle>>,
    state: Mutex<State>,
    ordinary: Sequencer,
    control: Sequencer,
    pending: Mutex<HashMap<u64, PendingCall>>,
    next_call_id: AtomicU64,
}

impl Drop for Inner {
    fn drop(&mut self) {
        if let Some(forwarder) = locked(&self.forwarder).take() {
            forwarder.abort();
        }
    }
}

enum Reply {
    Plain(JsonValue),
    Streaming(JsonValue, Box<dyn HttpBodyStream>),
}

#[derive(Clone)]
pub struct RpcSession {
    inner: Arc<Inner>,
}

fn method_family(method: &str) -> String {
    if method.starts_with("process/") {
        return "exec".to_string();
    }
    if method.starts_with("fs/") {
        return "filesystem".to_string();
    }
    match method {
        "environment/info" => "environment info".to_string(),
        "environment/status" => "environment status".to_string(),
        "environmentConfig/read" => "environment config".to_string(),
        "capabilityRoots/discoverV1" => "capability discovery".to_string(),
        _ => match method.split('/').next() {
            Some(prefix) if !prefix.is_empty() => prefix.to_string(),
            _ => method.to_string(),
        },
    }
}

fn handler_frame(id: &RequestId, error: &HandlerError) -> Vec<u8> {
    let (code, message) = error.wire();
    error_frame(id, code, message)
}

fn rpc_frame(id: &RequestId, error: &RpcError) -> Vec<u8> {
    error_frame(id, error.code, error.message.clone())
}

fn plain_frame(id: &RequestId, code: i64, message: &str) -> Vec<u8> {
    error_frame(id, code, LosslessString::from(message))
}

fn method_not_supported(id: &RequestId, method: &LosslessString) -> Vec<u8> {
    let mut units: Vec<u16> = "Method not supported: ".encode_utf16().collect();
    units.extend(json::truncated_units(method, ECHOED_METHOD_UNITS));
    error_frame(id, METHOD_NOT_FOUND, LosslessString::from_utf16(units))
}

fn spawn_stream_start(stream: Box<dyn HttpBodyStream>) {
    tokio::spawn(async move {
        let _ = stream.start().await;
    });
}

fn spawn_stream_cancel(stream: Box<dyn HttpBodyStream>) {
    tokio::spawn(async move {
        let _ = stream.cancel().await;
    });
}

impl RpcSession {
    pub fn new(options: SessionOptions) -> Self {
        let controller = Arc::new(Abort::new());
        let signal = controller.signal();
        let mut forwarder = None;
        if let Some(external) = options.signal {
            if external.is_aborted() {
                controller.abort();
            } else {
                let target = controller.clone();
                let task = tokio::spawn(async move {
                    external.aborted().await;
                    target.abort();
                });
                forwarder = Some(task.abort_handle());
            }
        }
        Self {
            inner: Arc::new(Inner {
                environment_info: options.environment_info,
                handler: options.handler,
                send_notification: options.send_notification,
                send_frame: options.send_frame,
                controller,
                signal,
                forwarder: Mutex::new(forwarder),
                state: Mutex::new(State::default()),
                ordinary: Sequencer::default(),
                control: Sequencer::default(),
                pending: Mutex::new(HashMap::new()),
                next_call_id: AtomicU64::new(1),
            }),
        }
    }

    fn is_closed(&self) -> bool {
        locked(&self.inner.state).closed || self.inner.signal.is_aborted()
    }

    fn notifier(&self) -> Notifier {
        let sink = self.inner.send_notification.clone();
        Notifier::new(Arc::new(move |method, params| {
            let future: Boxed<'static, Result<(), SendFailed>> = match &sink {
                Some(send) => send(method, params),
                None => Box::pin(async { Ok(()) }),
            };
            future
        }))
    }

    fn caller(&self) -> Caller {
        let weak: Weak<Inner> = Arc::downgrade(&self.inner);
        Caller::new(Arc::new(move |method, params, options| {
            let weak = weak.clone();
            let future: Boxed<'static, Result<JsonValue, CallError>> = Box::pin(async move {
                match weak.upgrade() {
                    Some(inner) => {
                        RpcSession { inner }
                            .perform_call(method, params, options)
                            .await
                    }
                    None => Err(CallError::Closed),
                }
            });
            future
        }))
    }

    fn take_pending(&self, id: u64) -> Option<PendingCall> {
        locked(&self.inner.pending).remove(&id)
    }

    async fn perform_call(
        &self,
        method: String,
        params: JsonValue,
        options: CallOptions,
    ) -> Result<JsonValue, CallError> {
        let Some(send_frame) = self.inner.send_frame.clone() else {
            return Err(CallError::Closed);
        };
        if self.is_closed() {
            return Err(CallError::Closed);
        }
        if options.signal.as_ref().is_some_and(Signal::is_aborted) {
            return Err(CallError::Cancelled { method });
        }
        let id = self.inner.next_call_id.fetch_add(1, Ordering::SeqCst);
        let (sender, mut receiver) = oneshot::channel();
        locked(&self.inner.pending).insert(id, sender);
        let sending = send_frame(request_frame(id, &method, params));
        let session = self.clone();
        tokio::spawn(async move {
            if sending.await.is_err() {
                session.take_pending(id);
            }
        });
        let timeout = options.timeout.unwrap_or(CALL_TIMEOUT);
        let cancelled = async {
            match &options.signal {
                Some(signal) => signal.aborted().await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            settled = &mut receiver => settled.unwrap_or(Err(CallError::Closed)),
            _ = tokio::time::sleep(timeout) => {
                self.take_pending(id);
                Err(CallError::TimedOut { method })
            }
            _ = cancelled => {
                self.take_pending(id);
                Err(CallError::Cancelled { method })
            }
        }
    }

    fn settle_call(&self, bytes: &[u8]) -> bool {
        if self.inner.next_call_id.load(Ordering::SeqCst) == 1 || bytes.len() > MAX_MESSAGE_BYTES {
            return false;
        }
        let Ok(parsed) = parse_bytes(bytes) else {
            return false;
        };
        let JsonValue::Object(message) = &parsed else {
            return false;
        };
        if json::has(message, "method") {
            return false;
        }
        let Some(JsonValue::Number(id)) = json::get(message, "id") else {
            return false;
        };
        if !json::has(message, "result") && !json::has(message, "error") {
            return false;
        }
        let pending = if json::is_integer(*id) && *id >= 1.0 {
            self.take_pending(*id as u64)
        } else {
            None
        };
        let Some(pending) = pending else {
            return true;
        };
        let outcome = match json::get(message, "error") {
            None | Some(JsonValue::Null) => Ok(json::get(message, "result")
                .cloned()
                .unwrap_or(JsonValue::Null)),
            Some(error) => {
                let record = match error {
                    JsonValue::Object(record) => Some(record),
                    _ => None,
                };
                let code = match record.and_then(|record| json::get(record, "code")) {
                    Some(JsonValue::Number(code)) => *code as i64,
                    _ => INTERNAL_ERROR,
                };
                let message = match record.and_then(|record| json::get(record, "message")) {
                    Some(JsonValue::String(text)) => text.clone(),
                    _ => Text::from("Internal error"),
                };
                Err(CallError::Remote(RpcError::new(code, message)))
            }
        };
        let _ = pending.send(outcome);
        true
    }

    fn is_control_request(&self, bytes: &[u8]) -> bool {
        {
            let state = locked(&self.inner.state);
            if !state.initialize_requested || !state.initialized {
                return false;
            }
        }
        if bytes.len() > MAX_MESSAGE_BYTES {
            return false;
        }
        let Ok(JsonValue::Object(message)) = parse_bytes(bytes) else {
            return false;
        };
        let Some(id) = json::get(&message, "id") else {
            return false;
        };
        if RequestId::from_value(id).is_none() {
            return false;
        }
        match json::get(&message, "method") {
            Some(JsonValue::String(method)) => {
                CONTROL_METHODS.contains(&json::lossy(method).as_str())
            }
            _ => false,
        }
    }

    pub fn receive(&self, bytes: Vec<u8>) -> Boxed<'static, Vec<Vec<u8>>> {
        if self.settle_call(&bytes) {
            return Box::pin(async { Vec::new() });
        }
        let mut turn = if self.is_control_request(&bytes) {
            self.inner.control.turn()
        } else {
            self.inner.ordinary.turn()
        };
        let session = self.clone();
        Box::pin(async move {
            turn.begin().await;
            let frames = session.dispatch(bytes).await;
            drop(turn);
            frames
        })
    }

    pub async fn close(&self) {
        locked(&self.inner.state).closed = true;
        self.inner.controller.abort();
        let pending: Vec<PendingCall> = locked(&self.inner.pending)
            .drain()
            .map(|(_, sender)| sender)
            .collect();
        for sender in pending {
            let _ = sender.send(Err(CallError::Closed));
        }
        tokio::join!(self.inner.ordinary.idle(), self.inner.control.idle());
        let connection = locked(&self.inner.state).connection.take();
        if let Some(connection) = connection {
            connection.close().await;
        }
        if let Some(forwarder) = locked(&self.inner.forwarder).take() {
            forwarder.abort();
        }
    }

    async fn environment_info(&self) -> Result<EnvironmentInfo, HandlerError> {
        let info = (self.inner.environment_info)().await?;
        let features = self.inner.handler.features();
        if wire_base::unbacked_capability(&info.capabilities, &features).is_some() {
            return Err(HandlerError::Internal);
        }
        Ok(info)
    }

    async fn dispatch(&self, bytes: Vec<u8>) -> Vec<Vec<u8>> {
        let unknown = RequestId::unknown();
        if self.is_closed() {
            return vec![plain_frame(&unknown, INTERNAL_ERROR, "Connection closed")];
        }
        if bytes.len() > MAX_MESSAGE_BYTES {
            return vec![plain_frame(
                &unknown,
                INVALID_REQUEST,
                "Message exceeds size limit",
            )];
        }
        let parsed = match parse_bytes(&bytes) {
            Ok(parsed) => parsed,
            Err(ParseFailure::Utf8) => {
                return vec![plain_frame(
                    &unknown,
                    INVALID_REQUEST,
                    "Invalid UTF-8 framing",
                )];
            }
            Err(ParseFailure::Json) => {
                return vec![plain_frame(
                    &unknown,
                    INVALID_REQUEST,
                    "Invalid JSON framing",
                )];
            }
        };
        let JsonValue::Object(message) = &parsed else {
            return vec![plain_frame(
                &unknown,
                INVALID_REQUEST,
                "expected a JSON-RPC object",
            )];
        };
        if !within_complexity(&parsed) {
            let id = json::get(message, "id")
                .and_then(RequestId::from_value)
                .unwrap_or_else(RequestId::unknown);
            return vec![plain_frame(
                &id,
                INVALID_REQUEST,
                "JSON-RPC message exceeds complexity limit",
            )];
        }
        let notification = json::get(message, "id").is_none();
        let id = match json::get(message, "id") {
            None => RequestId::unknown(),
            Some(value) => match RequestId::from_value(value) {
                Some(id) => id,
                None => return vec![plain_frame(&unknown, INVALID_REQUEST, "Invalid request ID")],
            },
        };
        let method = match json::get(message, "method") {
            Some(JsonValue::String(method)) if (1..=METHOD_NAME_UNITS).contains(&method.len()) => {
                method
            }
            _ => {
                if notification {
                    return Vec::new();
                }
                return vec![plain_frame(&id, INVALID_REQUEST, "Invalid method name")];
            }
        };
        let name = json::lossy(method);
        let params = json::get(message, "params");

        if notification {
            if name == "initialized" {
                let mut state = locked(&self.inner.state);
                if state.initialize_requested {
                    state.initialized = true;
                }
            }
            return Vec::new();
        }

        if !SUPPORTED_METHODS.contains(&name.as_str()) {
            return vec![method_not_supported(&id, method)];
        }

        if name == "initialize" {
            return vec![self.initialize(&id, params).await];
        }

        let family = method_family(&name);
        let (context, connection) = {
            let state = locked(&self.inner.state);
            if !state.initialize_requested {
                return vec![plain_frame(
                    &id,
                    INVALID_REQUEST,
                    &format!("client must call initialize before using {family} methods"),
                )];
            }
            if !state.initialized {
                return vec![plain_frame(
                    &id,
                    INVALID_REQUEST,
                    &format!("client must send initialized before using {family} methods"),
                )];
            }
            (
                HandlerContext {
                    signal: self.inner.controller.signal(),
                    session_id: state.session_id.clone().unwrap_or_default(),
                    authenticated_executor: None,
                },
                state.connection.clone(),
            )
        };

        if let Some(connection_method) = ConnectionMethod::parse(&name) {
            let Some(connection) = connection.filter(|c| c.supports(connection_method)) else {
                return vec![method_not_supported(&id, method)];
            };
            return self
                .connection_request(&id, &*connection, connection_method, params, context)
                .await;
        }

        match self.method_result(&name, params, context).await {
            Ok(result) => vec![success_frame(&id, result)],
            Err(error) => vec![handler_frame(&id, &error)],
        }
    }

    async fn initialize(&self, id: &RequestId, params: Option<&JsonValue>) -> Vec<u8> {
        if locked(&self.inner.state).initialize_requested {
            return plain_frame(
                id,
                INVALID_REQUEST,
                "initialize may only be sent once per connection",
            );
        }
        let (client_name, resume) = match wire_base::decode_initialize(params) {
            Ok(decoded) => decoded,
            Err(error) => return rpc_frame(id, &error),
        };
        let initialize_params = InitializeParams { client_name };
        let context = InitializeContext {
            signal: self.inner.controller.signal(),
            notifier: self.notifier(),
            caller: self.caller(),
        };
        let result = match resume {
            Some(session_id) => {
                self.inner
                    .handler
                    .resume(session_id, initialize_params, context)
                    .await
            }
            None => {
                self.inner
                    .handler
                    .initialize(initialize_params, context)
                    .await
            }
        };
        let session_id = match result {
            Ok(result) => result.session_id,
            Err(error) => return handler_frame(id, &error),
        };
        let connection = {
            let mut state = locked(&self.inner.state);
            state.session_id = Some(session_id.clone());
            state.initialize_requested = true;
            match self.inner.handler.open_rpc_connection() {
                Ok(connection) => {
                    state.connection = connection.map(Arc::from);
                    Ok(())
                }
                Err(error) => Err(error),
            }
        };
        if let Err(error) = connection {
            return handler_frame(id, &error);
        }
        match self.environment_info().await {
            Ok(info) => success_frame(
                id,
                ObjectBuilder::new()
                    .field("sessionId", json::text(&session_id))
                    .field("environmentInfo", wire_base::encode_environment_info(&info))
                    .finish(),
            ),
            Err(error) => handler_frame(id, &error),
        }
    }

    async fn method_result(
        &self,
        name: &str,
        params: Option<&JsonValue>,
        context: HandlerContext,
    ) -> Result<JsonValue, HandlerError> {
        let handler = &self.inner.handler;
        match name {
            "environment/info" => Ok(wire_base::encode_environment_info(
                &self.environment_info().await?,
            )),
            "environment/status" => Ok(wire_base::encode_status()),
            "process/start" => {
                let decoded = wire_base::decode_process_start(params)?;
                Ok(wire_base::encode_exec_result(
                    &handler.start_process(decoded, context).await?,
                ))
            }
            "process/read" => {
                let decoded = wire_base::decode_process_read(params)?;
                Ok(wire_base::encode_read_result(
                    &handler.read_process(decoded, context).await?,
                ))
            }
            "process/write" => {
                let decoded = wire_base::decode_process_write(params)?;
                Ok(wire_base::encode_write_result(
                    &handler.write_process(decoded, context).await?,
                ))
            }
            "process/signal" => {
                let decoded = wire_base::decode_process_signal(params)?;
                handler.signal_process(decoded, context).await?;
                Ok(wire_fs::encode_empty())
            }
            "process/terminate" => {
                let decoded = wire_base::decode_process_terminate(params)?;
                Ok(wire_base::encode_terminate_result(
                    &handler.terminate_process(decoded, context).await?,
                ))
            }
            "fs/readFile" => {
                let decoded = wire_base::decode_read_file(params)?;
                Ok(wire_base::encode_read_file_result(
                    &handler.read_file(decoded, context).await?,
                ))
            }
            "fs/writeFile" => {
                let decoded = wire_base::decode_write_file(params)?;
                handler.write_file(decoded, context).await?;
                Ok(wire_fs::encode_empty())
            }
            "fs/getMetadata" => {
                let decoded = wire_base::decode_get_metadata(params)?;
                Ok(wire_base::encode_metadata_result(
                    &handler.get_metadata(decoded, context).await?,
                ))
            }
            "fs/readDirectory" => {
                let decoded = wire_base::decode_read_directory(params)?;
                Ok(wire_base::encode_read_directory_result(
                    &handler.read_directory(decoded, context).await?,
                ))
            }
            "fs/canonicalize" => {
                let decoded = wire_base::decode_canonicalize(params)?;
                Ok(wire_base::encode_canonicalize_result(
                    &handler.canonicalize(decoded, context).await?,
                ))
            }
            "environmentConfig/read" => {
                if !handler.supports(OptionalMethod::EnvironmentConfigRead) {
                    return Err(HandlerError::Rpc(RpcError::not_supported(name)));
                }
                let decoded = wire_env::decode_environment_config_read(params)?;
                Ok(handler.read_environment_config(decoded, context).await?)
            }
            "capabilityRoots/discoverV1" => {
                if !handler.supports(OptionalMethod::CapabilityRootsDiscoverV1) {
                    return Err(HandlerError::Rpc(RpcError::not_supported(name)));
                }
                let decoded = wire_env::decode_capability_roots_discover(params)?;
                Ok(handler.discover_capability_roots(decoded, context).await?)
            }
            _ => Err(HandlerError::Rpc(RpcError::not_supported(name))),
        }
    }

    async fn connection_request(
        &self,
        id: &RequestId,
        connection: &dyn ExecutorConnection,
        method: ConnectionMethod,
        params: Option<&JsonValue>,
        context: HandlerContext,
    ) -> Vec<Vec<u8>> {
        let reply = match self
            .connection_result(connection, method, params, context)
            .await
        {
            Ok(reply) => reply,
            Err(error) => return vec![handler_frame(id, &error)],
        };
        let (result, stream) = match reply {
            Reply::Plain(result) => return vec![success_frame(id, result)],
            Reply::Streaming(result, stream) => (result, stream),
        };
        let frame = success_frame(id, result);
        let closed = locked(&self.inner.state).closed;
        let Some(send_frame) = self.inner.send_frame.clone().filter(|_| !closed) else {
            spawn_stream_cancel(stream);
            return vec![plain_frame(id, INTERNAL_ERROR, "Internal error")];
        };
        match send_frame(frame).await {
            Ok(()) => {
                spawn_stream_start(stream);
                Vec::new()
            }
            Err(SendFailed) => {
                spawn_stream_cancel(stream);
                Vec::new()
            }
        }
    }

    async fn connection_result(
        &self,
        connection: &dyn ExecutorConnection,
        method: ConnectionMethod,
        params: Option<&JsonValue>,
        context: HandlerContext,
    ) -> Result<Reply, HandlerError> {
        let null = JsonValue::Null;
        let value = params.unwrap_or(&null);
        let result = match method {
            ConnectionMethod::CapabilitiesDiscoverV2 => {
                let decoded = wire_env::decode_discover_v2(params)?;
                connection
                    .discover_capabilities_v2(decoded, context)
                    .await?
            }
            ConnectionMethod::FsCreateDirectory => {
                let decoded = wire_fs::decode_create_directory(value)?;
                connection.create_directory(decoded, context).await?;
                wire_fs::encode_empty()
            }
            ConnectionMethod::FsOpen => {
                let decoded = wire_fs::decode_open(value)?;
                wire_fs::encode_open_result(&connection.open(decoded, context).await?)
            }
            ConnectionMethod::FsReadBlock => {
                let decoded = wire_fs::decode_read_block(value)?;
                wire_fs::encode_read_block_result(&connection.read_block(decoded, context).await?)
            }
            ConnectionMethod::FsWriteBlock => {
                let decoded = wire_fs::decode_write_block(value)?;
                connection.write_block(decoded, context).await?;
                wire_fs::encode_empty()
            }
            ConnectionMethod::FsClose => {
                let decoded = wire_fs::decode_close(value)?;
                connection.close_handle(decoded, context).await?;
                wire_fs::encode_empty()
            }
            ConnectionMethod::FsWalk => {
                let decoded = wire_fs::decode_walk(value)?;
                wire_fs::encode_walk_result(&connection.walk(decoded, context).await?)
            }
            ConnectionMethod::FsRemove => {
                let decoded = wire_fs::decode_remove(value)?;
                connection.remove(decoded, context).await?;
                wire_fs::encode_empty()
            }
            ConnectionMethod::FsCopy => {
                let decoded = wire_fs::decode_copy(value)?;
                connection.copy(decoded, context).await?;
                wire_fs::encode_empty()
            }
            ConnectionMethod::HttpRequest => {
                let decoded = wire_http::decode_request(value)?;
                let http = HttpContext {
                    signal: context.signal.clone(),
                    session_id: context.session_id.clone(),
                    emit: BodyDeltaSink::new(self.notifier()),
                };
                let outcome = connection.http_request(decoded, http).await?;
                let result = wire_http::encode_response(&outcome.response);
                return Ok(match outcome.stream {
                    None => Reply::Plain(result),
                    Some(stream) => Reply::Streaming(result, stream),
                });
            }
        };
        Ok(Reply::Plain(result))
    }
}
