use super::super::relay::Channel;
use super::{
    control::{Abort, Sequencer, Signal, locked},
    error::SendFailed,
    handler::{Boxed, EnvironmentInfoFn, ExecutorHandler, NotifyFn},
    json::{self, MAX_MESSAGE_BYTES, RequestId, notification_frame},
    session::{CONTROL_METHODS, FrameSink, RpcSession, SessionOptions},
};
use std::{
    fmt,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
};
use tokio::{
    sync::Notify,
    task::{AbortHandle, JoinSet},
};
use ycoding_core::ycoding_schema::JsonValue;

pub const MAX_ORDINARY_IN_FLIGHT: usize = 64;
pub const MAX_CONTROL_IN_FLIGHT: usize = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ChannelClosed;

pub trait RpcChannel: Send + Sync + 'static {
    fn send<'a>(&'a self, message: &'a [u8]) -> Boxed<'a, Result<(), ChannelClosed>>;
    fn next(&self) -> Boxed<'_, Option<Vec<u8>>>;
    fn closed(&self) -> Signal;
}

impl RpcChannel for Channel {
    fn send<'a>(&'a self, message: &'a [u8]) -> Boxed<'a, Result<(), ChannelClosed>> {
        Box::pin(async move {
            Channel::send(self, message)
                .await
                .map_err(|_| ChannelClosed)
        })
    }

    fn next(&self) -> Boxed<'_, Option<Vec<u8>>> {
        Box::pin(Channel::next(self))
    }

    fn closed(&self) -> Signal {
        Signal::from_closed(Channel::closed(self))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelRpcError {
    ChannelSendFailed,
    Aborted,
    ProofJournal,
}

impl fmt::Display for ChannelRpcError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::ChannelSendFailed => "CCA channel RPC send failed",
            Self::Aborted => "CCA channel RPC was aborted",
            Self::ProofJournal => "CCA proof status journal failed",
        })
    }
}

impl std::error::Error for ChannelRpcError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiagnosticPhase {
    Received,
    Response,
    Notification,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiagnosticEvent {
    Observed,
    Completed,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RpcMethod {
    Initialize,
    Initialized,
    EnvironmentInfo,
    EnvironmentStatus,
    ProcessStart,
    ProcessRead,
    ProcessWrite,
    ProcessSignal,
    ProcessTerminate,
    FsReadFile,
    FsWriteFile,
    FsGetMetadata,
    FsReadDirectory,
    FsCanonicalize,
    CapabilitiesDiscoverV2,
    CapabilityRootsDiscoverV1,
    ProcessOutput,
    ProcessExited,
    ProcessClosed,
    Other,
}

const DIAGNOSTIC_METHODS: [(&str, RpcMethod); 19] = [
    ("initialize", RpcMethod::Initialize),
    ("initialized", RpcMethod::Initialized),
    ("environment/info", RpcMethod::EnvironmentInfo),
    ("environment/status", RpcMethod::EnvironmentStatus),
    ("process/start", RpcMethod::ProcessStart),
    ("process/read", RpcMethod::ProcessRead),
    ("process/write", RpcMethod::ProcessWrite),
    ("process/signal", RpcMethod::ProcessSignal),
    ("process/terminate", RpcMethod::ProcessTerminate),
    ("fs/readFile", RpcMethod::FsReadFile),
    ("fs/writeFile", RpcMethod::FsWriteFile),
    ("fs/getMetadata", RpcMethod::FsGetMetadata),
    ("fs/readDirectory", RpcMethod::FsReadDirectory),
    ("fs/canonicalize", RpcMethod::FsCanonicalize),
    ("capabilities/discoverV2", RpcMethod::CapabilitiesDiscoverV2),
    (
        "capabilityRoots/discoverV1",
        RpcMethod::CapabilityRootsDiscoverV1,
    ),
    ("process/output", RpcMethod::ProcessOutput),
    ("process/exited", RpcMethod::ProcessExited),
    ("process/closed", RpcMethod::ProcessClosed),
];

impl RpcMethod {
    pub fn parse(name: &str) -> Self {
        DIAGNOSTIC_METHODS
            .iter()
            .find(|(candidate, _)| *candidate == name)
            .map_or(Self::Other, |(_, method)| *method)
    }

    pub fn name(self) -> &'static str {
        DIAGNOSTIC_METHODS
            .iter()
            .find(|(_, method)| *method == self)
            .map_or("other", |(name, _)| *name)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RpcOutcome {
    Result,
    InvalidRequest,
    MethodNotFound,
    InvalidParams,
    InternalError,
    PermissionDenied,
    OtherError,
    Notification,
    SendFailed,
    Aborted,
}

impl RpcOutcome {
    pub fn name(self) -> &'static str {
        match self {
            Self::Result => "result",
            Self::InvalidRequest => "invalid_request",
            Self::MethodNotFound => "method_not_found",
            Self::InvalidParams => "invalid_params",
            Self::InternalError => "internal_error",
            Self::PermissionDenied => "permission_denied",
            Self::OtherError => "other_error",
            Self::Notification => "notification",
            Self::SendFailed => "send_failed",
            Self::Aborted => "aborted",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DiagnosticRecord {
    pub phase: DiagnosticPhase,
    pub event: DiagnosticEvent,
    pub method: RpcMethod,
    pub outcome: Option<RpcOutcome>,
    pub resume_requested: Option<bool>,
    pub requests: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DiagnosticFailed;

pub type DiagnosticObserver =
    Arc<dyn Fn(DiagnosticRecord) -> Result<(), DiagnosticFailed> + Send + Sync>;

pub struct RunInput<C: RpcChannel> {
    pub channel: C,
    pub environment_info: EnvironmentInfoFn,
    pub handler: Arc<dyn ExecutorHandler>,
    pub signal: Option<Signal>,
    pub on_diagnostic: Option<DiagnosticObserver>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RunResult {
    pub requests: u64,
    pub responses: u64,
    pub notifications: u64,
}

fn is_control_frame(bytes: &[u8]) -> bool {
    let Ok(JsonValue::Object(message)) = json::parse_bytes(bytes) else {
        return false;
    };
    let Some(id) = json::get(&message, "id") else {
        return false;
    };
    if RequestId::from_value(id).is_none() {
        return false;
    }
    match json::get(&message, "method") {
        Some(JsonValue::String(method)) => CONTROL_METHODS.contains(&json::lossy(method).as_str()),
        _ => false,
    }
}

fn parse_diagnostic_frame(bytes: &[u8]) -> Option<ycoding_core::ycoding_schema::JsonObject> {
    if bytes.len() > MAX_MESSAGE_BYTES {
        return None;
    }
    match json::parse_bytes(bytes) {
        Ok(JsonValue::Object(object)) => Some(object),
        _ => None,
    }
}

fn classify_request(bytes: &[u8]) -> (RpcMethod, Option<bool>) {
    let message = parse_diagnostic_frame(bytes);
    let method = match message
        .as_ref()
        .and_then(|message| json::get(message, "method"))
    {
        Some(JsonValue::String(name)) => RpcMethod::parse(&json::lossy(name)),
        _ => RpcMethod::Other,
    };
    if method != RpcMethod::Initialize {
        return (method, None);
    }
    let resume = match message
        .as_ref()
        .and_then(|message| json::get(message, "params"))
    {
        Some(JsonValue::Object(params)) => !matches!(
            json::get(params, "resumeSessionId"),
            None | Some(JsonValue::Null)
        ),
        _ => false,
    };
    (method, Some(resume))
}

fn response_outcome(bytes: &[u8]) -> RpcOutcome {
    let Some(message) = parse_diagnostic_frame(bytes) else {
        return RpcOutcome::OtherError;
    };
    let Some(error) = json::get(&message, "error") else {
        return if json::has(&message, "result") {
            RpcOutcome::Result
        } else {
            RpcOutcome::OtherError
        };
    };
    let code = match error {
        JsonValue::Object(error) => match json::get(error, "code") {
            Some(JsonValue::Number(code)) => Some(*code),
            _ => None,
        },
        _ => None,
    };
    match code {
        Some(-32600.0) => RpcOutcome::InvalidRequest,
        Some(-32601.0) => RpcOutcome::MethodNotFound,
        Some(-32602.0) => RpcOutcome::InvalidParams,
        Some(-32603.0) => RpcOutcome::InternalError,
        Some(-32001.0) => RpcOutcome::PermissionDenied,
        _ => RpcOutcome::OtherError,
    }
}

struct Forwarders(Vec<AbortHandle>);

impl Drop for Forwarders {
    fn drop(&mut self) {
        for forwarder in &self.0 {
            forwarder.abort();
        }
    }
}

struct Diagnostics {
    observer: Option<DiagnosticObserver>,
    open: AtomicBool,
    failed: AtomicBool,
}

impl Diagnostics {
    fn enabled(&self) -> bool {
        self.observer.is_some() && self.open.load(Ordering::SeqCst)
    }

    fn emit(&self, record: DiagnosticRecord) {
        let Some(observer) = &self.observer else {
            return;
        };
        if !self.open.load(Ordering::SeqCst) || self.failed.load(Ordering::SeqCst) {
            return;
        }
        if observer(record).is_err() {
            self.failed.store(true, Ordering::SeqCst);
        }
    }
}

struct Shared {
    external: Option<Signal>,
    combined: Signal,
    failure: Mutex<Option<ChannelRpcError>>,
    failed: Abort,
    changed: Notify,
    ordinary: AtomicUsize,
    control: AtomicUsize,
    requests: AtomicU64,
    responses: AtomicU64,
    notifications: AtomicU64,
}

impl Shared {
    fn external_aborted(&self) -> bool {
        self.external.as_ref().is_some_and(Signal::is_aborted)
    }

    fn has_failure(&self) -> bool {
        locked(&self.failure).is_some()
    }

    fn record_failure(&self) {
        {
            let mut failure = locked(&self.failure);
            if failure.is_some() || self.combined.is_aborted() {
                return;
            }
            *failure = Some(if self.external_aborted() {
                ChannelRpcError::Aborted
            } else {
                ChannelRpcError::ChannelSendFailed
            });
        }
        self.failed.abort();
        self.changed.notify_waiters();
    }

    fn failed_outcome(&self) -> RpcOutcome {
        if self.external_aborted() {
            RpcOutcome::Aborted
        } else {
            RpcOutcome::SendFailed
        }
    }
}

struct Slot {
    shared: Arc<Shared>,
    control: bool,
}

impl Slot {
    fn take(shared: &Arc<Shared>, control: bool) -> Self {
        let counter = if control {
            &shared.control
        } else {
            &shared.ordinary
        };
        counter.fetch_add(1, Ordering::SeqCst);
        Self {
            shared: shared.clone(),
            control,
        }
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let counter = if self.control {
            &self.shared.control
        } else {
            &self.shared.ordinary
        };
        counter.fetch_sub(1, Ordering::SeqCst);
        self.shared.changed.notify_waiters();
    }
}

struct Outbound<C: RpcChannel> {
    channel: Arc<C>,
    sequencer: Sequencer,
}

fn enqueue<C: RpcChannel>(
    outbound: &Arc<Outbound<C>>,
    bytes: Vec<u8>,
) -> Boxed<'static, Result<(), SendFailed>> {
    let mut turn = outbound.sequencer.turn();
    let outbound = outbound.clone();
    Box::pin(async move {
        turn.begin().await;
        let result = outbound.channel.send(&bytes).await;
        drop(turn);
        result.map_err(|_| SendFailed)
    })
}

type SendBytes = Arc<dyn Fn(Vec<u8>) -> Boxed<'static, Result<(), SendFailed>> + Send + Sync>;

async fn drain(tasks: &mut JoinSet<()>, shared: &Shared) {
    while let Some(outcome) = tasks.join_next().await {
        if outcome.is_err() {
            shared.record_failure();
        }
    }
}

pub async fn run_channel_rpc<C: RpcChannel>(
    input: RunInput<C>,
) -> Result<RunResult, ChannelRpcError> {
    let channel = Arc::new(input.channel);
    let channel_signal = channel.closed();

    let combined = Arc::new(Abort::new());
    let combined_signal = combined.signal();
    let mut forwarders = Forwarders(Vec::new());
    for signal in [Some(channel_signal.clone()), input.signal.clone()]
        .into_iter()
        .flatten()
    {
        if signal.is_aborted() {
            combined.abort();
        } else {
            let target = combined.clone();
            forwarders.0.push(
                tokio::spawn(async move {
                    signal.aborted().await;
                    target.abort();
                })
                .abort_handle(),
            );
        }
    }

    let shared = Arc::new(Shared {
        external: input.signal.clone(),
        combined: combined_signal.clone(),
        failure: Mutex::new(None),
        failed: Abort::new(),
        changed: Notify::new(),
        ordinary: AtomicUsize::new(0),
        control: AtomicUsize::new(0),
        requests: AtomicU64::new(0),
        responses: AtomicU64::new(0),
        notifications: AtomicU64::new(0),
    });
    let diagnostics = Arc::new(Diagnostics {
        observer: input.on_diagnostic,
        open: AtomicBool::new(true),
        failed: AtomicBool::new(false),
    });

    let outbound = Arc::new(Outbound {
        channel: channel.clone(),
        sequencer: Sequencer::default(),
    });
    let send_bytes: SendBytes = {
        let outbound = outbound.clone();
        Arc::new(move |bytes| enqueue(&outbound, bytes))
    };

    let frame_sink: FrameSink = {
        let send_bytes = send_bytes.clone();
        let shared = shared.clone();
        Arc::new(move |bytes| {
            let send_bytes = send_bytes.clone();
            let shared = shared.clone();
            let future: Boxed<'static, Result<(), SendFailed>> = Box::pin(async move {
                send_bytes(bytes).await?;
                shared.responses.fetch_add(1, Ordering::SeqCst);
                Ok(())
            });
            future
        })
    };
    let notification_sink: NotifyFn = {
        let send_bytes = send_bytes.clone();
        let shared = shared.clone();
        let diagnostics = diagnostics.clone();
        Arc::new(move |method: String, params: JsonValue| {
            let send_bytes = send_bytes.clone();
            let shared = shared.clone();
            let diagnostics = diagnostics.clone();
            let future: Boxed<'static, Result<(), SendFailed>> = Box::pin(async move {
                let rpc_method = RpcMethod::parse(&method);
                let sent = send_bytes(notification_frame(&method, params)).await;
                if sent.is_err() {
                    if diagnostics.enabled() {
                        diagnostics.emit(DiagnosticRecord {
                            phase: DiagnosticPhase::Notification,
                            event: DiagnosticEvent::Failed,
                            method: rpc_method,
                            outcome: Some(shared.failed_outcome()),
                            resume_requested: None,
                            requests: None,
                        });
                    }
                    return Err(SendFailed);
                }
                if diagnostics.enabled() {
                    diagnostics.emit(DiagnosticRecord {
                        phase: DiagnosticPhase::Notification,
                        event: DiagnosticEvent::Completed,
                        method: rpc_method,
                        outcome: Some(RpcOutcome::Notification),
                        resume_requested: None,
                        requests: None,
                    });
                }
                shared.notifications.fetch_add(1, Ordering::SeqCst);
                Ok(())
            });
            future
        })
    };

    let session = RpcSession::new(SessionOptions {
        environment_info: input.environment_info,
        handler: input.handler,
        send_notification: Some(notification_sink),
        send_frame: Some(frame_sink),
        signal: Some(combined_signal.clone()),
    });

    let failed_signal = shared.failed.signal();
    let mut tasks: JoinSet<()> = JoinSet::new();
    let mut stop_requested = false;

    'outer: loop {
        if combined_signal.is_aborted() || shared.has_failure() {
            stop_requested = true;
            break;
        }
        let message = tokio::select! {
            message = channel.next() => Some(message),
            _ = combined_signal.aborted() => None,
            _ = failed_signal.aborted() => None,
        };
        let bytes = match message {
            Some(Some(bytes)) => bytes,
            Some(None) => break,
            None => {
                stop_requested = true;
                break;
            }
        };
        let frame_number = shared.requests.fetch_add(1, Ordering::SeqCst) + 1;
        let request = diagnostics
            .observer
            .is_some()
            .then(|| classify_request(&bytes));
        if let Some((method, resume_requested)) = request {
            diagnostics.emit(DiagnosticRecord {
                phase: DiagnosticPhase::Received,
                event: DiagnosticEvent::Observed,
                method,
                outcome: None,
                resume_requested,
                requests: Some(frame_number),
            });
        }
        let control = is_control_frame(&bytes);
        loop {
            let notified = shared.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let (in_flight, capacity) = if control {
                (shared.control.load(Ordering::SeqCst), MAX_CONTROL_IN_FLIGHT)
            } else {
                (
                    shared.ordinary.load(Ordering::SeqCst),
                    MAX_ORDINARY_IN_FLIGHT,
                )
            };
            if in_flight < capacity {
                break;
            }
            let changed = tokio::select! {
                _ = &mut notified => true,
                _ = combined_signal.aborted() => false,
                _ = failed_signal.aborted() => false,
            };
            if !changed || combined_signal.is_aborted() || shared.has_failure() {
                stop_requested = true;
                break 'outer;
            }
        }
        if combined_signal.is_aborted() || shared.has_failure() {
            stop_requested = true;
            break;
        }

        let slot = Slot::take(&shared, control);
        let receiving = session.receive(bytes);
        let send_bytes = send_bytes.clone();
        let shared = shared.clone();
        let diagnostics = diagnostics.clone();
        tasks.spawn(async move {
            let _slot = slot;
            let frames = receiving.await;
            for frame in frames {
                let outcome = diagnostics.enabled().then(|| response_outcome(&frame));
                if send_bytes(frame).await.is_err() {
                    if let Some((method, _)) = request {
                        diagnostics.emit(DiagnosticRecord {
                            phase: DiagnosticPhase::Response,
                            event: DiagnosticEvent::Failed,
                            method,
                            outcome: Some(shared.failed_outcome()),
                            resume_requested: None,
                            requests: Some(frame_number),
                        });
                    }
                    shared.record_failure();
                    return;
                }
                if let (Some((method, _)), Some(outcome)) = (request, outcome) {
                    diagnostics.emit(DiagnosticRecord {
                        phase: DiagnosticPhase::Response,
                        event: DiagnosticEvent::Completed,
                        method,
                        outcome: Some(outcome),
                        resume_requested: None,
                        requests: Some(frame_number),
                    });
                }
                shared.responses.fetch_add(1, Ordering::SeqCst);
            }
        });
    }

    if stop_requested || combined_signal.is_aborted() || shared.has_failure() {
        tokio::join!(session.close(), drain(&mut tasks, &shared));
    } else {
        drain(&mut tasks, &shared).await;
        session.close().await;
    }
    outbound.sequencer.idle().await;
    diagnostics.open.store(false, Ordering::SeqCst);
    drop(forwarders);

    let failure = *locked(&shared.failure);
    if let Some(failure) = failure {
        return Err(failure);
    }
    if shared.external_aborted() && !channel_signal.is_aborted() {
        return Err(ChannelRpcError::Aborted);
    }
    if diagnostics.failed.load(Ordering::SeqCst) {
        return Err(ChannelRpcError::ProofJournal);
    }
    Ok(RunResult {
        requests: shared.requests.load(Ordering::SeqCst),
        responses: shared.responses.load(Ordering::SeqCst),
        notifications: shared.notifications.load(Ordering::SeqCst),
    })
}
