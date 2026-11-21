#[cfg(test)]
use super::wire_process;
use super::{
    control::Signal,
    error::{CallError, HandlerError, RpcError, SendFailed},
    types::*,
};
use std::{future::Future, pin::Pin, sync::Arc, time::Duration};
use ycoding_core::ycoding_schema::JsonValue;

pub type Boxed<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub type NotifyFn =
    Arc<dyn Fn(String, JsonValue) -> Boxed<'static, Result<(), SendFailed>> + Send + Sync>;
pub type CallFn = Arc<
    dyn Fn(String, JsonValue, CallOptions) -> Boxed<'static, Result<JsonValue, CallError>>
        + Send
        + Sync,
>;
pub type EnvironmentInfoFn =
    Arc<dyn Fn() -> Boxed<'static, Result<EnvironmentInfo, HandlerError>> + Send + Sync>;

#[derive(Clone, Debug, Default)]
pub struct CallOptions {
    pub timeout: Option<Duration>,
    pub signal: Option<Signal>,
}

#[derive(Clone)]
pub struct Notifier(NotifyFn);

impl Notifier {
    pub fn new(send: NotifyFn) -> Self {
        Self(send)
    }

    pub fn notify(
        &self,
        method: impl Into<String>,
        params: JsonValue,
    ) -> Boxed<'static, Result<(), SendFailed>> {
        (self.0)(method.into(), params)
    }

    #[cfg(test)]
    pub fn process_event(&self, event: &ProcessEvent) -> Boxed<'static, Result<(), SendFailed>> {
        let (method, params) = wire_process::encode_process_event(event);
        self.notify(method, params)
    }
}

#[derive(Clone)]
pub struct Caller(CallFn);

impl Caller {
    pub fn new(call: CallFn) -> Self {
        Self(call)
    }

    pub fn call(
        &self,
        method: impl Into<String>,
        params: JsonValue,
        options: CallOptions,
    ) -> Boxed<'static, Result<JsonValue, CallError>> {
        (self.0)(method.into(), params, options)
    }
}

#[derive(Clone)]
pub struct InitializeContext {
    pub signal: Signal,
    pub notifier: Notifier,
    pub caller: Caller,
}

#[derive(Clone, Debug)]
pub struct HandlerContext {
    pub signal: Signal,
    pub session_id: String,
}

#[derive(Clone)]
pub struct BodyDeltaSink(Notifier);

impl BodyDeltaSink {
    pub fn new(notifier: Notifier) -> Self {
        Self(notifier)
    }

    pub fn emit(&self, delta: &HttpBodyDelta) -> Boxed<'static, Result<(), SendFailed>> {
        self.0.notify(
            super::wire_http::HTTP_REQUEST_BODY_DELTA_METHOD,
            super::wire_http::encode_body_delta(delta),
        )
    }
}

#[derive(Clone)]
pub struct HttpContext {
    pub signal: Signal,
    pub session_id: String,
    pub emit: BodyDeltaSink,
}

pub trait HttpBodyStream: Send + Sync {
    fn start(&self) -> Boxed<'_, Result<(), HandlerError>>;
    fn cancel(&self) -> Boxed<'_, Result<(), HandlerError>>;
}

pub struct HttpOutcome {
    pub response: HttpResponse,
    pub stream: Option<Box<dyn HttpBodyStream>>,
}

fn unsupported<T: Send + 'static>(method: &str) -> Boxed<'static, Result<T, HandlerError>> {
    let error = HandlerError::Rpc(RpcError::not_supported(method));
    Box::pin(async move { Err(error) })
}

pub trait ExecutorConnection: Send + Sync {
    fn supports(&self, method: ConnectionMethod) -> bool;

    fn discover_capabilities_v2<'a>(
        &'a self,
        _params: DiscoverV2Params,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<JsonValue, HandlerError>> {
        unsupported(ConnectionMethod::CapabilitiesDiscoverV2.name())
    }

    fn create_directory<'a>(
        &'a self,
        _params: CreateDirectoryParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<(), HandlerError>> {
        unsupported(ConnectionMethod::FsCreateDirectory.name())
    }

    fn open<'a>(
        &'a self,
        _params: OpenParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<OpenResult, HandlerError>> {
        unsupported(ConnectionMethod::FsOpen.name())
    }

    fn read_block<'a>(
        &'a self,
        _params: ReadBlockParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<ReadBlockResult, HandlerError>> {
        unsupported(ConnectionMethod::FsReadBlock.name())
    }

    fn write_block<'a>(
        &'a self,
        _params: WriteBlockParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<(), HandlerError>> {
        unsupported(ConnectionMethod::FsWriteBlock.name())
    }

    fn close_handle<'a>(
        &'a self,
        _params: CloseParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<(), HandlerError>> {
        unsupported(ConnectionMethod::FsClose.name())
    }

    fn walk<'a>(
        &'a self,
        _params: WalkParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<WalkResult, HandlerError>> {
        unsupported(ConnectionMethod::FsWalk.name())
    }

    fn remove<'a>(
        &'a self,
        _params: RemoveParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<(), HandlerError>> {
        unsupported(ConnectionMethod::FsRemove.name())
    }

    fn copy<'a>(
        &'a self,
        _params: CopyParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<(), HandlerError>> {
        unsupported(ConnectionMethod::FsCopy.name())
    }

    fn http_request<'a>(
        &'a self,
        _params: HttpRequestParams,
        _ctx: HttpContext,
    ) -> Boxed<'a, Result<HttpOutcome, HandlerError>> {
        unsupported(ConnectionMethod::HttpRequest.name())
    }

    fn close(&self) -> Boxed<'_, ()>;
}

pub trait ExecutorHandler: Send + Sync {
    fn features(&self) -> BackendFeatures {
        BackendFeatures::default()
    }

    fn supports(&self, _method: OptionalMethod) -> bool {
        false
    }

    fn initialize<'a>(
        &'a self,
        params: InitializeParams,
        ctx: InitializeContext,
    ) -> Boxed<'a, Result<InitializeResult, HandlerError>>;

    fn resume<'a>(
        &'a self,
        session_id: Text,
        _params: InitializeParams,
        _ctx: InitializeContext,
    ) -> Boxed<'a, Result<InitializeResult, HandlerError>> {
        Box::pin(async move { Err(HandlerError::Rpc(RpcError::unknown_session(&session_id))) })
    }

    fn start_process<'a>(
        &'a self,
        params: ExecParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<ExecResult, HandlerError>>;

    fn read_process<'a>(
        &'a self,
        params: ReadParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<ReadResult, HandlerError>>;

    fn write_process<'a>(
        &'a self,
        params: WriteParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<WriteResult, HandlerError>>;

    fn signal_process<'a>(
        &'a self,
        params: SignalParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<(), HandlerError>>;

    fn terminate_process<'a>(
        &'a self,
        params: TerminateParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<TerminateResult, HandlerError>>;

    fn read_file<'a>(
        &'a self,
        params: FsReadFileParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<FsReadFileResult, HandlerError>>;

    fn write_file<'a>(
        &'a self,
        params: FsWriteFileParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<(), HandlerError>>;

    fn get_metadata<'a>(
        &'a self,
        params: FsGetMetadataParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<FsGetMetadataResult, HandlerError>>;

    fn read_directory<'a>(
        &'a self,
        params: FsReadDirectoryParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<FsReadDirectoryResult, HandlerError>>;

    fn canonicalize<'a>(
        &'a self,
        params: FsCanonicalizeParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<FsCanonicalizeResult, HandlerError>>;

    fn read_environment_config<'a>(
        &'a self,
        _params: EnvironmentConfigReadParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<JsonValue, HandlerError>> {
        unsupported("environmentConfig/read")
    }

    fn discover_capability_roots<'a>(
        &'a self,
        _params: CapabilityRootsDiscoverParams,
        _ctx: HandlerContext,
    ) -> Boxed<'a, Result<JsonValue, HandlerError>> {
        unsupported("capabilityRoots/discoverV1")
    }

    fn open_rpc_connection(&self) -> Result<Option<Box<dyn ExecutorConnection>>, HandlerError> {
        Ok(None)
    }
}
