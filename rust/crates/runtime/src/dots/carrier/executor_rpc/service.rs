use super::{
    channel::{
        ChannelRpcError, DiagnosticObserver, DiagnosticPhase, DiagnosticRecord, RunInput,
        run_channel_rpc,
    },
    control::{Signal, locked},
    error::{CallError, HandlerError, RpcError, SendFailed},
    handler::*,
    types::*,
};
use crate::dots::carrier::supervisor::{
    Borrowed, Boxed as PortBoxed, Connection, Link, Opened, Opener, Peer, Rejection, Resources,
    Serve, ServeFailed, Summary,
};
use std::sync::{Arc, Mutex};
use ycoding_core::ycoding_schema::JsonValue;

pub type CloseFn = Box<dyn FnOnce() -> Boxed<'static, Result<(), ()>> + Send>;

pub struct SessionBackend {
    pub handler: Arc<dyn ExecutorHandler>,
    pub environment_info: EnvironmentInfoFn,
    pub close: CloseFn,
}

pub type SessionFactory = Arc<dyn Fn() -> Result<SessionBackend, HandlerError> + Send + Sync>;

pub struct Endpoint {
    pub notifier: Notifier,
    pub caller: Caller,
}

fn rejection(error: HandlerError) -> Rejection {
    let (code, message) = error.wire();
    Rejection::new(code, message)
}

fn refusal(rejection: Rejection) -> HandlerError {
    HandlerError::Rpc(RpcError::new(rejection.code, rejection.message))
}

fn endpoint(link: &Link) -> Option<Arc<Endpoint>> {
    link.peer()
        .and_then(|peer| peer.downcast::<Endpoint>().ok())
}

fn forwarding_notifier(link: Link) -> Notifier {
    Notifier::new(Arc::new(move |method, params| {
        let future: Boxed<'static, Result<(), SendFailed>> = match endpoint(&link) {
            Some(endpoint) => endpoint.notifier.notify(method, params),
            None => Box::pin(async { Ok(()) }),
        };
        future
    }))
}

fn forwarding_caller(link: Link) -> Caller {
    Caller::new(Arc::new(move |method, params, options| {
        let future: Boxed<'static, Result<JsonValue, CallError>> = match endpoint(&link) {
            Some(endpoint) => endpoint.caller.call(method, params, options),
            None => Box::pin(async { Err(CallError::Closed) }),
        };
        future
    }))
}

pub struct HandlerResources {
    handler: Arc<dyn ExecutorHandler>,
    environment_info: EnvironmentInfoFn,
    close: Mutex<Option<CloseFn>>,
}

impl HandlerResources {
    pub fn new(backend: SessionBackend) -> Self {
        Self {
            handler: backend.handler,
            environment_info: backend.environment_info,
            close: Mutex::new(Some(backend.close)),
        }
    }
}

impl Resources for HandlerResources {
    fn initialize<'a>(
        &'a self,
        client_name: &'a Text,
        link: Link,
    ) -> Borrowed<'a, Result<String, Rejection>> {
        Box::pin(async move {
            let context = InitializeContext {
                signal: Signal::from_closed(link.retired()),
                notifier: forwarding_notifier(link.clone()),
                caller: forwarding_caller(link),
            };
            self.handler
                .initialize(
                    InitializeParams {
                        client_name: client_name.clone(),
                    },
                    context,
                )
                .await
                .map(|result| result.session_id)
                .map_err(rejection)
        })
    }

    fn close(&self) -> Borrowed<'_, Result<(), ()>> {
        Box::pin(async move {
            let close = locked(&self.close).take();
            match close {
                Some(close) => close().await,
                None => Ok(()),
            }
        })
    }
}

pub struct SupervisedHandler {
    connection: Connection,
}

fn backend(resources: &Arc<dyn Resources>) -> Result<&HandlerResources, HandlerError> {
    resources
        .downcast_ref::<HandlerResources>()
        .ok_or(HandlerError::Internal)
}

impl SupervisedHandler {
    pub fn new(connection: Connection) -> Self {
        Self { connection }
    }

    pub fn detach(&self) {
        self.connection.detach();
    }
}

pub fn environment_info_of(handler: &Arc<SupervisedHandler>) -> EnvironmentInfoFn {
    let handler = handler.clone();
    Arc::new(move || {
        let handler = handler.clone();
        let future: Boxed<'static, Result<EnvironmentInfo, HandlerError>> = Box::pin(async move {
            let resources = handler.connection.attached().map_err(refusal)?;
            let backend = backend(&resources)?;
            (backend.environment_info)().await
        });
        future
    })
}

macro_rules! delegate {
    ($name:ident, $params:ty, $result:ty) => {
        fn $name<'a>(
            &'a self,
            params: $params,
            ctx: HandlerContext,
        ) -> Boxed<'a, Result<$result, HandlerError>> {
            Box::pin(async move {
                let resources = self.connection.attached().map_err(refusal)?;
                backend(&resources)?.handler.$name(params, ctx).await
            })
        }
    };
}

impl ExecutorHandler for SupervisedHandler {
    fn features(&self) -> BackendFeatures {
        self.connection
            .attached()
            .ok()
            .and_then(|resources| {
                backend(&resources)
                    .map(|backend| backend.handler.features())
                    .ok()
            })
            .unwrap_or_default()
    }

    fn supports(&self, _method: OptionalMethod) -> bool {
        true
    }

    fn initialize<'a>(
        &'a self,
        params: InitializeParams,
        ctx: InitializeContext,
    ) -> Boxed<'a, Result<InitializeResult, HandlerError>> {
        Box::pin(async move {
            let peer: Peer = Arc::new(Endpoint {
                notifier: ctx.notifier,
                caller: ctx.caller,
            });
            let session_id = self
                .connection
                .initialize(&params.client_name, peer)
                .await
                .map_err(refusal)?;
            Ok(InitializeResult { session_id })
        })
    }

    fn resume<'a>(
        &'a self,
        session_id: Text,
        _params: InitializeParams,
        ctx: InitializeContext,
    ) -> Boxed<'a, Result<InitializeResult, HandlerError>> {
        Box::pin(async move {
            let Ok(known) = session_id.to_utf8() else {
                return Err(HandlerError::Rpc(RpcError::unknown_session(&session_id)));
            };
            let peer: Peer = Arc::new(Endpoint {
                notifier: ctx.notifier,
                caller: ctx.caller,
            });
            self.connection
                .resume(&known, peer)
                .await
                .map_err(refusal)?;
            Ok(InitializeResult { session_id: known })
        })
    }

    delegate!(start_process, ExecParams, ExecResult);
    delegate!(read_process, ReadParams, ReadResult);
    delegate!(write_process, WriteParams, WriteResult);
    delegate!(signal_process, SignalParams, ());
    delegate!(terminate_process, TerminateParams, TerminateResult);
    delegate!(read_file, FsReadFileParams, FsReadFileResult);
    delegate!(write_file, FsWriteFileParams, ());
    delegate!(get_metadata, FsGetMetadataParams, FsGetMetadataResult);
    delegate!(read_directory, FsReadDirectoryParams, FsReadDirectoryResult);
    delegate!(canonicalize, FsCanonicalizeParams, FsCanonicalizeResult);

    fn read_environment_config<'a>(
        &'a self,
        params: EnvironmentConfigReadParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<JsonValue, HandlerError>> {
        Box::pin(async move {
            let resources = self.connection.attached().map_err(refusal)?;
            let backend = backend(&resources)?;
            if !backend
                .handler
                .supports(OptionalMethod::EnvironmentConfigRead)
            {
                return Err(HandlerError::Rpc(RpcError::not_supported(
                    "environmentConfig/read",
                )));
            }
            backend.handler.read_environment_config(params, ctx).await
        })
    }

    fn discover_capability_roots<'a>(
        &'a self,
        params: CapabilityRootsDiscoverParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<JsonValue, HandlerError>> {
        Box::pin(async move {
            let resources = self.connection.attached().map_err(refusal)?;
            let backend = backend(&resources)?;
            if !backend
                .handler
                .supports(OptionalMethod::CapabilityRootsDiscoverV1)
            {
                return Err(HandlerError::Rpc(RpcError::not_supported(
                    "capabilityRoots/discoverV1",
                )));
            }
            backend.handler.discover_capability_roots(params, ctx).await
        })
    }

    fn open_rpc_connection(&self) -> Result<Option<Box<dyn ExecutorConnection>>, HandlerError> {
        let resources = self.connection.attached().map_err(refusal)?;
        backend(&resources)?.handler.open_rpc_connection()
    }
}

pub fn opener(factory: SessionFactory) -> Opener {
    Arc::new(move || {
        let factory = factory.clone();
        let future: PortBoxed<Result<Arc<dyn Resources>, Rejection>> = Box::pin(async move {
            let backend = factory().map_err(rejection)?;
            let resources: Arc<dyn Resources> = Arc::new(HandlerResources::new(backend));
            Ok(resources)
        });
        future
    })
}

fn record_summary(summary: &Summary, record: &DiagnosticRecord) {
    let method = record.method.name();
    let outcome = record
        .outcome
        .map_or("other_error", |outcome| outcome.name());
    match record.phase {
        DiagnosticPhase::Received => {
            summary.received(method, record.resume_requested.unwrap_or(false));
        }
        DiagnosticPhase::Response => summary.responded(method, outcome),
        DiagnosticPhase::Notification => summary.notified(method, outcome),
    }
}

async fn serve_channel(factory: SessionFactory, opened: Opened) -> Result<(), ServeFailed> {
    let handler = Arc::new(SupervisedHandler::new(
        opened.sessions.connect(opener(factory)),
    ));
    let summary = opened.summary.clone();
    let observer: DiagnosticObserver = Arc::new(move |record| {
        record_summary(&summary, &record);
        Ok(())
    });
    let outcome = run_channel_rpc(RunInput {
        channel: opened.channel,
        environment_info: environment_info_of(&handler),
        handler: handler.clone(),
        signal: None,
        on_diagnostic: Some(observer),
    })
    .await;
    handler.detach();
    match outcome {
        Ok(_) | Err(ChannelRpcError::Aborted) => Ok(()),
        Err(_) => Err(ServeFailed),
    }
}

pub fn serve(factory: SessionFactory) -> Serve {
    Arc::new(move |opened| {
        let factory = factory.clone();
        let future: PortBoxed<Result<(), ServeFailed>> =
            Box::pin(async move { serve_channel(factory, opened).await });
        future
    })
}
