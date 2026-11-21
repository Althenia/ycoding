use crate::dots::carrier::executor_rpc::{
    channel::{
        ChannelClosed, ChannelRpcError, DiagnosticFailed, DiagnosticObserver, DiagnosticRecord,
        RpcChannel, RunInput, RunResult, run_channel_rpc,
    },
    control::{Abort, Signal, locked},
    error::{HandlerError, SendFailed},
    handler::*,
    json,
    session::{FrameSink, RpcSession, SessionOptions},
    types::*,
};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Semaphore, mpsc},
    task::JoinHandle,
};
use ycoding_core::ycoding_schema::{JsonValue, parse_json};

pub const SESSION_ID: &str = "session-1";
pub const FILE: &str = "file:///workspace/a.txt";

pub fn units(prefix: &str, middle: &[u16], suffix: &str) -> Text {
    let mut all: Vec<u16> = prefix.encode_utf16().collect();
    all.extend_from_slice(middle);
    all.extend(suffix.encode_utf16());
    Text::from_utf16(all)
}

pub fn parse(text: &str) -> JsonValue {
    parse_json(text).expect("test frame is valid JSON")
}

pub fn at<'a>(value: &'a JsonValue, key: &str) -> &'a JsonValue {
    match value {
        JsonValue::Object(object) => json::get(object, key).unwrap_or_else(|| {
            panic!(
                "missing key {key} in {}",
                ycoding_core::ycoding_schema::stringify_json(value)
            )
        }),
        other => panic!(
            "not an object: {}",
            ycoding_core::ycoding_schema::stringify_json(other)
        ),
    }
}

pub fn has(value: &JsonValue, key: &str) -> bool {
    matches!(value, JsonValue::Object(object) if json::has(object, key))
}

pub fn str_of(value: &JsonValue) -> String {
    match value {
        JsonValue::String(text) => json::lossy(text),
        other => panic!(
            "not a string: {}",
            ycoding_core::ycoding_schema::stringify_json(other)
        ),
    }
}

pub fn num_of(value: &JsonValue) -> f64 {
    match value {
        JsonValue::Number(number) => *number,
        other => panic!(
            "not a number: {}",
            ycoding_core::ycoding_schema::stringify_json(other)
        ),
    }
}

pub fn error_code(response: &JsonValue) -> i64 {
    num_of(at(at(response, "error"), "code")) as i64
}

pub fn error_message(response: &JsonValue) -> String {
    str_of(at(at(response, "error"), "message"))
}

pub fn request(id: i64, method: &str, params: &str) -> String {
    format!(r#"{{"id":{id},"method":"{method}","params":{params}}}"#)
}

pub fn notification(method: &str) -> String {
    format!(r#"{{"method":"{method}","params":{{}}}}"#)
}

pub fn canonical_info() -> EnvironmentInfo {
    EnvironmentInfo {
        shell: ShellInfo {
            name: Text::from("zsh"),
            path: Text::from("/bin/zsh"),
        },
        executor_version: Some("0.0.0".to_string()),
        provider_id: Some("provider".to_string()),
        cwd: Presence::Value("file:///home/user".to_string()),
        user_home_dir: Presence::Value("file:///home/user".to_string()),
        platform_os: Presence::Value("linux".to_string()),
        prepend_path_dirs: None,
        temporary_directories: Some(vec!["file:///tmp".to_string()]),
        temp_dir: Presence::Null,
        capabilities: EnvironmentCapabilities {
            network_proxy_launch: Some(true),
            network_proxy_review_domains: Some(true),
            credential_masking: Some(true),
            credential_masking_custom_providers: Some(true),
            capability_discovery_sandbox: Some(true),
            capability_discovery_v2: Some(true),
            environment_config_read: Some(true),
            http_header_env_vars: Some(true),
            sandboxed_file_streaming: Some(true),
            file_write_streaming: Some(true),
            shell_snapshot_v2: Some(true),
            windows_mxc: Some(false),
            ..EnvironmentCapabilities::default()
        },
    }
}

pub fn full_features() -> BackendFeatures {
    BackendFeatures {
        network_proxy: true,
        credential_masking: true,
        credential_masking_custom_providers: true,
        shell_snapshot: true,
        environment_config_read: true,
        capability_roots: true,
        capability_discovery_v2: true,
        file_streaming: true,
        file_write_streaming: true,
        http_request: true,
    }
}

pub fn info_fn() -> EnvironmentInfoFn {
    Arc::new(|| {
        let future: Boxed<'static, Result<EnvironmentInfo, HandlerError>> =
            Box::pin(async { Ok(canonical_info()) });
        future
    })
}

pub fn unadvertised_info_fn() -> EnvironmentInfoFn {
    Arc::new(|| {
        let mut info = canonical_info();
        info.capabilities = EnvironmentCapabilities::default();
        let future: Boxed<'static, Result<EnvironmentInfo, HandlerError>> =
            Box::pin(async move { Ok(info) });
        future
    })
}

pub async fn eventually(mut condition: impl FnMut() -> bool) {
    for _ in 0..400 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("condition not reached");
}

pub struct Backend {
    pub features: BackendFeatures,
    pub optional_methods: bool,
    pub with_connection: bool,
    pub resumable: bool,
    pub calls: Mutex<Vec<String>>,
    pub started: Mutex<Vec<ExecParams>>,
    pub paths: Mutex<Vec<Text>>,
    pub fail_start: Mutex<Option<HandlerError>>,
    pub fail_initialize: Mutex<Option<HandlerError>>,
    pub client_names: Mutex<Vec<Text>>,
    pub gate_reads: AtomicBool,
    pub read_gate: Arc<Semaphore>,
    pub gate_signals: AtomicBool,
    pub signal_gate: Arc<Semaphore>,
    pub reads_entered: AtomicUsize,
    pub signals_entered: AtomicUsize,
    pub init_context: Mutex<Option<InitializeContext>>,
    pub connection_closed: Arc<AtomicBool>,
    pub http_started: Arc<AtomicUsize>,
    pub http_cancelled: Arc<AtomicUsize>,
}

impl Backend {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            features: full_features(),
            optional_methods: true,
            with_connection: true,
            resumable: false,
            calls: Mutex::new(Vec::new()),
            started: Mutex::new(Vec::new()),
            paths: Mutex::new(Vec::new()),
            fail_start: Mutex::new(None),
            fail_initialize: Mutex::new(None),
            client_names: Mutex::new(Vec::new()),
            gate_reads: AtomicBool::new(false),
            read_gate: Arc::new(Semaphore::new(0)),
            gate_signals: AtomicBool::new(false),
            signal_gate: Arc::new(Semaphore::new(0)),
            reads_entered: AtomicUsize::new(0),
            signals_entered: AtomicUsize::new(0),
            init_context: Mutex::new(None),
            connection_closed: Arc::new(AtomicBool::new(false)),
            http_started: Arc::new(AtomicUsize::new(0)),
            http_cancelled: Arc::new(AtomicUsize::new(0)),
        })
    }

    pub fn configure(mut self: Arc<Self>, change: impl FnOnce(&mut Backend)) -> Arc<Self> {
        change(Arc::get_mut(&mut self).expect("unshared backend"));
        self
    }

    pub fn minimal() -> Arc<Self> {
        Self::new().configure(|backend| {
            backend.optional_methods = false;
            backend.with_connection = false;
            backend.features = BackendFeatures::default();
        })
    }

    pub fn recorded(&self) -> Vec<String> {
        locked(&self.calls).clone()
    }

    fn record(&self, name: &str) {
        locked(&self.calls).push(name.to_string());
    }
}

fn ready<T: Send + 'static>(
    value: Result<T, HandlerError>,
) -> Boxed<'static, Result<T, HandlerError>> {
    Box::pin(async move { value })
}

impl ExecutorHandler for Backend {
    fn features(&self) -> BackendFeatures {
        self.features
    }

    fn supports(&self, _method: OptionalMethod) -> bool {
        self.optional_methods
    }

    fn initialize<'a>(
        &'a self,
        params: InitializeParams,
        ctx: InitializeContext,
    ) -> Boxed<'a, Result<InitializeResult, HandlerError>> {
        self.record("initialize");
        locked(&self.client_names).push(params.client_name);
        if let Some(error) = locked(&self.fail_initialize).clone() {
            return ready(Err(error));
        }
        *locked(&self.init_context) = Some(ctx);
        ready(Ok(InitializeResult {
            session_id: SESSION_ID.to_string(),
        }))
    }

    fn resume<'a>(
        &'a self,
        session_id: Text,
        _params: InitializeParams,
        _ctx: InitializeContext,
    ) -> Boxed<'a, Result<InitializeResult, HandlerError>> {
        self.record("resume");
        if self.resumable {
            ready(Ok(InitializeResult {
                session_id: session_id.to_utf8().unwrap_or_default(),
            }))
        } else {
            ready(Err(HandlerError::Rpc(
                super::super::error::RpcError::unknown_session(&session_id),
            )))
        }
    }

    fn start_process<'a>(
        &'a self,
        params: ExecParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<ExecResult, HandlerError>> {
        self.record("process/start");
        let process_id = params.process_id.clone();
        locked(&self.started).push(params);
        if let Some(error) = locked(&self.fail_start).clone() {
            return ready(Err(error));
        }
        ready(Ok(ExecResult {
            process_id,
            sandbox_type: Presence::Value(SandboxType::None),
        }))
    }

    fn read_process<'a>(
        &'a self,
        params: ReadParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<ReadResult, HandlerError>> {
        self.record("process/read");
        Box::pin(async move {
            self.reads_entered.fetch_add(1, Ordering::SeqCst);
            if self.gate_reads.load(Ordering::SeqCst) {
                tokio::select! {
                    permit = self.read_gate.acquire() => {
                        if let Ok(permit) = permit {
                            permit.forget();
                        }
                    }
                    _ = ctx.signal.aborted() => return Err(HandlerError::Internal),
                }
            }
            Ok(ReadResult {
                chunks: vec![ProcessOutputChunk {
                    seq: params.after_seq.unwrap_or(0) + 1,
                    stream: ProcessStream::Stdout,
                    chunk: "b3V0".to_string(),
                }],
                next_seq: params.after_seq.unwrap_or(0) + 2,
                exited: true,
                exit_code: Presence::Value(0),
                closed: true,
                failure: Presence::Null,
                sandbox_denied: Some(false),
            })
        })
    }

    fn write_process<'a>(
        &'a self,
        _params: WriteParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<WriteResult, HandlerError>> {
        self.record("process/write");
        ready(Ok(WriteResult {
            status: WriteStatus::Accepted,
        }))
    }

    fn signal_process<'a>(
        &'a self,
        _params: SignalParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<(), HandlerError>> {
        self.record("process/signal");
        Box::pin(async move {
            self.signals_entered.fetch_add(1, Ordering::SeqCst);
            if self.gate_signals.load(Ordering::SeqCst) {
                tokio::select! {
                    permit = self.signal_gate.acquire() => {
                        if let Ok(permit) = permit {
                            permit.forget();
                        }
                    }
                    _ = ctx.signal.aborted() => return Err(HandlerError::Internal),
                }
            }
            Ok(())
        })
    }

    fn terminate_process<'a>(
        &'a self,
        _params: TerminateParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<TerminateResult, HandlerError>> {
        self.record("process/terminate");
        ready(Ok(TerminateResult { running: false }))
    }

    fn read_file<'a>(
        &'a self,
        params: FsReadFileParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<FsReadFileResult, HandlerError>> {
        self.record("fs/readFile");
        locked(&self.paths).push(params.path.clone());
        if params
            .path
            .to_utf8()
            .unwrap_or_default()
            .ends_with("/missing")
        {
            return ready(Err(HandlerError::Executor {
                code: super::super::error::NOT_FOUND,
                message: Text::from("No such file or directory (os error 2)"),
            }));
        }
        ready(Ok(FsReadFileResult {
            data_base64: "aGk=".to_string(),
        }))
    }

    fn write_file<'a>(
        &'a self,
        _params: FsWriteFileParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<(), HandlerError>> {
        self.record("fs/writeFile");
        ready(Ok(()))
    }

    fn get_metadata<'a>(
        &'a self,
        _params: FsGetMetadataParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<FsGetMetadataResult, HandlerError>> {
        self.record("fs/getMetadata");
        ready(Ok(FsGetMetadataResult {
            is_directory: false,
            is_file: true,
            is_symlink: false,
            size: 2,
            created_at_ms: 10,
            modified_at_ms: 20,
        }))
    }

    fn read_directory<'a>(
        &'a self,
        _params: FsReadDirectoryParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<FsReadDirectoryResult, HandlerError>> {
        self.record("fs/readDirectory");
        ready(Ok(FsReadDirectoryResult {
            entries: vec![FsReadDirectoryEntry {
                file_name: "a.txt".to_string(),
                is_directory: false,
                is_file: true,
            }],
        }))
    }

    fn canonicalize<'a>(
        &'a self,
        params: FsCanonicalizeParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<FsCanonicalizeResult, HandlerError>> {
        self.record("fs/canonicalize");
        ready(Ok(FsCanonicalizeResult {
            path: params.path.to_utf8().unwrap_or_default(),
        }))
    }

    fn read_environment_config<'a>(
        &'a self,
        params: EnvironmentConfigReadParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<JsonValue, HandlerError>> {
        self.record("environmentConfig/read");
        ready(Ok(parse(&format!(
            r#"{{"userHomeDir":null,"codexHomeDir":"{}","hostname":"host","config":{{"layers":[{{"source":"user","baseDir":"file:///home/user/.codex","toml":"a = 1\n"}}],"cloudInsertionIndex":1}},"requirements":{{"layers":[],"cloudInsertionIndex":0}}}}"#,
            params.cwd.to_utf8().unwrap_or_default()
        ))))
    }

    fn discover_capability_roots<'a>(
        &'a self,
        params: CapabilityRootsDiscoverParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<JsonValue, HandlerError>> {
        self.record("capabilityRoots/discoverV1");
        let roots: Vec<String> = params
            .roots
            .into_iter()
            .map(|root| {
                format!(
                    r#"{{"id":"{}","path":"{}","plugin":null,"skills":[],"namespaceManifests":[],"warnings":[],"error":null}}"#,
                    root.id.to_utf8().unwrap_or_default(),
                    root.path.to_utf8().unwrap_or_default()
                )
            })
            .collect();
        ready(Ok(parse(&format!(r#"{{"roots":[{}]}}"#, roots.join(",")))))
    }

    fn open_rpc_connection(&self) -> Result<Option<Box<dyn ExecutorConnection>>, HandlerError> {
        if !self.with_connection {
            return Ok(None);
        }
        Ok(Some(Box::new(Connection {
            closed: self.connection_closed.clone(),
            http_started: self.http_started.clone(),
            http_cancelled: self.http_cancelled.clone(),
        })))
    }
}

pub struct Connection {
    closed: Arc<AtomicBool>,
    http_started: Arc<AtomicUsize>,
    http_cancelled: Arc<AtomicUsize>,
}

struct Stream {
    emit: BodyDeltaSink,
    request_id: Text,
    started: Arc<AtomicUsize>,
    cancelled: Arc<AtomicUsize>,
}

impl HttpBodyStream for Stream {
    fn start(&self) -> Boxed<'_, Result<(), HandlerError>> {
        Box::pin(async move {
            self.started.fetch_add(1, Ordering::SeqCst);
            for (seq, (delta, done)) in [(b"ab".to_vec(), false), (Vec::new(), true)]
                .into_iter()
                .enumerate()
            {
                self.emit
                    .emit(&HttpBodyDelta {
                        request_id: self.request_id.clone(),
                        seq: seq as u64 + 1,
                        delta,
                        done,
                        error: None,
                    })
                    .await
                    .map_err(|_| HandlerError::Internal)?;
            }
            Ok(())
        })
    }

    fn cancel(&self) -> Boxed<'_, Result<(), HandlerError>> {
        Box::pin(async move {
            self.cancelled.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    }
}

impl ExecutorConnection for Connection {
    fn supports(&self, _method: ConnectionMethod) -> bool {
        true
    }

    fn discover_capabilities_v2<'a>(
        &'a self,
        params: DiscoverV2Params,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<JsonValue, HandlerError>> {
        ready(Ok(parse(&format!(
            r#"{{"plugins":[],"skills":[],"warnings":["{}"]}}"#,
            params.cwd.to_utf8().unwrap_or_default()
        ))))
    }

    fn create_directory<'a>(
        &'a self,
        _params: CreateDirectoryParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<(), HandlerError>> {
        ready(Ok(()))
    }

    fn open<'a>(
        &'a self,
        params: OpenParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<OpenResult, HandlerError>> {
        ready(Ok(OpenResult {
            handle_id: params.handle_id,
        }))
    }

    fn read_block<'a>(
        &'a self,
        _params: ReadBlockParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<ReadBlockResult, HandlerError>> {
        ready(Ok(ReadBlockResult {
            chunk: b"hi".to_vec(),
            eof: true,
        }))
    }

    fn write_block<'a>(
        &'a self,
        _params: WriteBlockParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<(), HandlerError>> {
        ready(Ok(()))
    }

    fn close_handle<'a>(
        &'a self,
        _params: CloseParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<(), HandlerError>> {
        ready(Ok(()))
    }

    fn walk<'a>(
        &'a self,
        _params: WalkParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<WalkResult, HandlerError>> {
        ready(Ok(WalkResult {
            entries: vec![WalkEntry {
                path: FILE.to_string(),
                kind: WalkEntryKind::File,
            }],
            errors: Vec::new(),
            truncated: false,
        }))
    }

    fn remove<'a>(
        &'a self,
        _params: RemoveParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<(), HandlerError>> {
        ready(Err(HandlerError::Executor {
            code: super::super::error::PERMISSION_DENIED,
            message: Text::default(),
        }))
    }

    fn copy<'a>(
        &'a self,
        _params: CopyParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<(), HandlerError>> {
        ready(Ok(()))
    }

    fn http_request<'a>(
        &'a self,
        params: HttpRequestParams,
        ctx: HttpContext,
    ) -> Boxed<'a, Result<HttpOutcome, HandlerError>> {
        let stream = params.stream_response.then(|| {
            Box::new(Stream {
                emit: ctx.emit.clone(),
                request_id: params.request_id.clone(),
                started: self.http_started.clone(),
                cancelled: self.http_cancelled.clone(),
            }) as Box<dyn HttpBodyStream>
        });
        ready(Ok(HttpOutcome {
            response: HttpResponse {
                status: 200,
                headers: vec![HttpHeader {
                    name: Text::from("content-type"),
                    value: Text::from("text/plain"),
                    value_env_var: None,
                }],
                body: if params.stream_response {
                    Vec::new()
                } else {
                    b"ok".to_vec()
                },
            },
            stream,
        }))
    }

    fn close(&self) -> Boxed<'_, ()> {
        Box::pin(async move {
            self.closed.store(true, Ordering::SeqCst);
        })
    }
}

pub struct Harness {
    pub session: RpcSession,
    pub backend: Arc<Backend>,
    pub sent: Arc<Mutex<Vec<Vec<u8>>>>,
    pub notes: Arc<Mutex<Vec<(String, JsonValue)>>>,
    pub fail_sends: Arc<AtomicBool>,
}

impl Harness {
    pub fn new() -> Self {
        Self::with_backend(Backend::new())
    }

    pub fn with_backend(backend: Arc<Backend>) -> Self {
        Self::build(backend, info_fn(), None)
    }

    pub fn build(backend: Arc<Backend>, info: EnvironmentInfoFn, signal: Option<Signal>) -> Self {
        Self::over(backend.clone(), backend, info, signal)
    }

    pub fn over(
        handler: Arc<dyn ExecutorHandler>,
        backend: Arc<Backend>,
        info: EnvironmentInfoFn,
        signal: Option<Signal>,
    ) -> Self {
        let sent: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
        let notes: Arc<Mutex<Vec<(String, JsonValue)>>> = Arc::new(Mutex::new(Vec::new()));
        let fail_sends = Arc::new(AtomicBool::new(false));
        let frame_sink: FrameSink = {
            let sent = sent.clone();
            let fail = fail_sends.clone();
            Arc::new(move |bytes| {
                let sent = sent.clone();
                let fail = fail.clone();
                let future: Boxed<'static, Result<(), SendFailed>> = Box::pin(async move {
                    if fail.load(Ordering::SeqCst) {
                        return Err(SendFailed);
                    }
                    locked(&sent).push(bytes);
                    Ok(())
                });
                future
            })
        };
        let note_sink: NotifyFn = {
            let notes = notes.clone();
            Arc::new(move |method, params| {
                let notes = notes.clone();
                let future: Boxed<'static, Result<(), SendFailed>> = Box::pin(async move {
                    locked(&notes).push((method, params));
                    Ok(())
                });
                future
            })
        };
        let session = RpcSession::new(SessionOptions {
            environment_info: info,
            handler,
            send_notification: Some(note_sink),
            send_frame: Some(frame_sink),
            signal,
        });
        Self {
            session,
            backend,
            sent,
            notes,
            fail_sends,
        }
    }

    pub async fn rpc(&self, frame: &str) -> Vec<JsonValue> {
        self.session
            .receive(frame.as_bytes().to_vec())
            .await
            .iter()
            .map(|bytes| parse(std::str::from_utf8(bytes).expect("response is UTF-8")))
            .collect()
    }

    pub async fn one(&self, frame: &str) -> JsonValue {
        let mut responses = self.rpc(frame).await;
        assert_eq!(responses.len(), 1, "expected one response to {frame}");
        responses.remove(0)
    }

    pub async fn handshake(&self) {
        let response = self
            .one(&request(1, "initialize", r#"{"clientName":"test"}"#))
            .await;
        assert_eq!(str_of(at(at(&response, "result"), "sessionId")), SESSION_ID);
        assert!(self.rpc(&notification("initialized")).await.is_empty());
    }

    pub fn notes_named(&self, method: &str) -> Vec<JsonValue> {
        locked(&self.notes)
            .iter()
            .filter(|(name, _)| name == method)
            .map(|(_, params)| params.clone())
            .collect()
    }
}

pub struct MockChannel {
    inbound: tokio::sync::Mutex<mpsc::UnboundedReceiver<Vec<u8>>>,
    outbound: mpsc::UnboundedSender<Vec<u8>>,
    closed: Signal,
    pub consumed: Arc<AtomicUsize>,
    pub fail_sends: Arc<AtomicBool>,
}

impl RpcChannel for MockChannel {
    fn send<'a>(&'a self, message: &'a [u8]) -> Boxed<'a, Result<(), ChannelClosed>> {
        Box::pin(async move {
            if self.fail_sends.load(Ordering::SeqCst) {
                return Err(ChannelClosed);
            }
            self.outbound
                .send(message.to_vec())
                .map_err(|_| ChannelClosed)
        })
    }

    fn next(&self) -> Boxed<'_, Option<Vec<u8>>> {
        Box::pin(async move {
            let message = self.inbound.lock().await.recv().await;
            if message.is_some() {
                self.consumed.fetch_add(1, Ordering::SeqCst);
            }
            message
        })
    }

    fn closed(&self) -> Signal {
        self.closed.clone()
    }
}

pub struct Peer {
    to_executor: Option<mpsc::UnboundedSender<Vec<u8>>>,
    from_executor: mpsc::UnboundedReceiver<Vec<u8>>,
    channel_abort: Abort,
    pub consumed: Arc<AtomicUsize>,
    pub fail_sends: Arc<AtomicBool>,
}

pub type Run = JoinHandle<Result<RunResult, ChannelRpcError>>;

pub struct Served {
    pub peer: Peer,
    pub run: Run,
    pub external: Arc<Abort>,
    pub diagnostics: Arc<Mutex<Vec<DiagnosticRecord>>>,
}

pub fn serve(backend: Arc<Backend>) -> Served {
    let diagnostics: Arc<Mutex<Vec<DiagnosticRecord>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = diagnostics.clone();
    let observer: DiagnosticObserver = Arc::new(
        move |record: DiagnosticRecord| -> Result<(), DiagnosticFailed> {
            locked(&recorded).push(record);
            Ok(())
        },
    );
    serve_observed(backend, Some(observer), diagnostics)
}

pub fn serve_observed(
    backend: Arc<Backend>,
    observer: Option<DiagnosticObserver>,
    diagnostics: Arc<Mutex<Vec<DiagnosticRecord>>>,
) -> Served {
    let (to_executor, inbound) = mpsc::unbounded_channel();
    let (outbound, from_executor) = mpsc::unbounded_channel();
    let channel_abort = Abort::new();
    let consumed = Arc::new(AtomicUsize::new(0));
    let fail_sends = Arc::new(AtomicBool::new(false));
    let channel = MockChannel {
        inbound: tokio::sync::Mutex::new(inbound),
        outbound,
        closed: channel_abort.signal(),
        consumed: consumed.clone(),
        fail_sends: fail_sends.clone(),
    };
    let external = Arc::new(Abort::new());
    let run = tokio::spawn(run_channel_rpc(RunInput {
        channel,
        environment_info: info_fn(),
        handler: backend,
        signal: Some(external.signal()),
        on_diagnostic: observer,
    }));
    Served {
        peer: Peer {
            to_executor: Some(to_executor),
            from_executor,
            channel_abort,
            consumed,
            fail_sends,
        },
        run,
        external,
        diagnostics,
    }
}

impl Peer {
    pub fn send(&self, frame: &str) {
        self.send_bytes(frame.as_bytes().to_vec());
    }

    pub fn send_bytes(&self, bytes: Vec<u8>) {
        if let Some(sender) = &self.to_executor {
            let _ = sender.send(bytes);
        }
    }

    pub async fn recv(&mut self) -> JsonValue {
        let bytes = tokio::time::timeout(Duration::from_secs(5), self.from_executor.recv())
            .await
            .expect("executor answered in time")
            .expect("executor channel open");
        parse(std::str::from_utf8(&bytes).expect("response is UTF-8"))
    }

    pub async fn recv_none(&mut self) {
        let outcome =
            tokio::time::timeout(Duration::from_millis(150), self.from_executor.recv()).await;
        assert!(outcome.is_err(), "unexpected frame: {outcome:?}");
    }

    pub fn end_input(&mut self) {
        self.to_executor = None;
    }

    pub fn close_channel(&self) {
        self.channel_abort.abort();
    }

    pub async fn handshake(&mut self) {
        self.send(&request(1, "initialize", r#"{"clientName":"test"}"#));
        let response = self.recv().await;
        assert_eq!(str_of(at(at(&response, "result"), "sessionId")), SESSION_ID);
        self.send(&notification("initialized"));
        self.send(&request(
            2,
            "fs/readFile",
            &format!(r#"{{"path":"{FILE}"}}"#),
        ));
        let probe = self.recv().await;
        assert_eq!(num_of(at(&probe, "id")) as i64, 2);
    }
}
