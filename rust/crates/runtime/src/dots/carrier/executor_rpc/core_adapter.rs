use super::super::wire::encode_base64;
use super::{
    control::{Abort, Signal, locked},
    error::{CallError, HandlerError, RpcError},
    handler::*,
    json::lossy,
    service::{CloseFn, SessionBackend},
    types::*,
};
use std::sync::{Arc, Mutex};
use tokio::task::JoinHandle;
use ycoding_core::cca::{
    connection::Connection,
    discovery::CapabilityRootRequest as CoreRootRequest,
    environment_config::EnvironmentConfigReadParams as CoreEnvironmentConfigReadParams,
    error::{BoxFuture, ExecutorError},
    executor::{self as cx, Executor},
    fs_extended as core_fs, http as core_http, network_proxy as core_proxy,
    shell_snapshot as core_snapshot,
    signal::{HandlerContext as CoreContext, Signal as CoreSignal},
    value::{JsonObject, Value},
};

pub const CREDENTIAL_MASKING_BACKED: bool = true;
pub const ENVIRONMENT_CONFIG_READ_BACKED: bool = true;

pub fn backend_features() -> BackendFeatures {
    BackendFeatures {
        network_proxy: true,
        credential_masking: CREDENTIAL_MASKING_BACKED,
        credential_masking_custom_providers: CREDENTIAL_MASKING_BACKED,
        shell_snapshot: true,
        environment_config_read: ENVIRONMENT_CONFIG_READ_BACKED,
        capability_roots: true,
        capability_discovery_v2: true,
        file_streaming: true,
        file_write_streaming: true,
        http_request: true,
    }
}

pub struct Bridge(Option<JoinHandle<()>>);

impl Drop for Bridge {
    fn drop(&mut self) {
        if let Some(task) = self.0.take() {
            task.abort();
        }
    }
}

pub fn to_core_signal(signal: &Signal) -> (CoreSignal, Bridge) {
    let core = CoreSignal::default();
    if signal.is_aborted() {
        core.cancel();
        return (core, Bridge(None));
    }
    let source = signal.clone();
    let target = core.clone();
    let task = tokio::spawn(async move {
        source.aborted().await;
        target.cancel();
    });
    (core, Bridge(Some(task)))
}

pub fn from_core_signal(core: &CoreSignal) -> (Signal, Bridge) {
    let abort = Abort::new();
    let signal = abort.signal();
    if core.is_cancelled() {
        abort.abort();
        return (signal, Bridge(None));
    }
    let source = core.clone();
    let task = tokio::spawn(async move {
        source.cancelled().await;
        abort.abort();
    });
    (signal, Bridge(Some(task)))
}

fn core_context(ctx: &HandlerContext) -> (CoreContext, Bridge) {
    let (signal, bridge) = to_core_signal(&ctx.signal);
    (
        CoreContext {
            signal,
            session_id: ctx.session_id.clone(),
        },
        bridge,
    )
}

pub fn failure(error: ExecutorError) -> HandlerError {
    HandlerError::Executor {
        code: i64::from(error.code),
        message: error.message,
    }
}

fn call_failure(error: CallError) -> ExecutorError {
    match error {
        CallError::Remote(RpcError { code, message }) => ExecutorError::new(code as i32, message),
        other => ExecutorError::new(-32603, other.to_string()),
    }
}

pub fn url_text(text: &Text) -> String {
    lossy(text)
}

fn object_value(object: JsonObject) -> Value {
    Value::Object(object)
}

fn metadata_value(metadata: ExecMetadata) -> Value {
    let mut object = JsonObject::new();
    if let Some(thread_id) = metadata.thread_id {
        object.insert("threadId".into(), Value::String(thread_id.as_str().into()));
    }
    if let Some(tool_call_id) = metadata.tool_call_id {
        object.insert("toolCallId".into(), Value::String(tool_call_id));
    }
    Value::Object(object)
}

pub fn lenient_base64(text: &str) -> Vec<u8> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut decoded = Vec::with_capacity(text.len() / 4 * 3);
    let mut accumulator = 0u32;
    let mut bits = 0u32;
    for byte in text.bytes() {
        let Some(value) = ALPHABET.iter().position(|candidate| *candidate == byte) else {
            continue;
        };
        accumulator = (accumulator << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            decoded.push((accumulator >> bits) as u8);
            accumulator &= (1 << bits) - 1;
        }
    }
    decoded
}

fn proxy_config(launch: NetworkProxyLaunchConfig) -> core_proxy::RemoteNetworkProxyLaunchConfig {
    let proxy = launch.proxy;
    let audit = launch.audit_metadata;
    core_proxy::RemoteNetworkProxyLaunchConfig {
        proxy: core_proxy::RemoteNetworkProxyConfig {
            enabled: proxy.enabled,
            credential_masking: proxy.credential_masking,
            credential_providers: proxy
                .credential_providers
                .into_iter()
                .map(|(id, provider)| {
                    (
                        id,
                        core_proxy::CredentialProviderConfig {
                            env: provider.env,
                            patterns: provider.patterns,
                            url_prefixes: provider.url_prefixes,
                            url_prefix_from_env: provider.url_prefix_from_env,
                            auth: provider
                                .auth
                                .into_iter()
                                .map(|method| match method {
                                    CredentialAuthMethod::Bearer => {
                                        core_proxy::CredentialAuthMethod::Bearer
                                    }
                                    CredentialAuthMethod::Token => {
                                        core_proxy::CredentialAuthMethod::Token
                                    }
                                    CredentialAuthMethod::Basic => {
                                        core_proxy::CredentialAuthMethod::Basic
                                    }
                                    CredentialAuthMethod::Header => {
                                        core_proxy::CredentialAuthMethod::Header
                                    }
                                })
                                .collect(),
                            header: provider.header,
                            prefix: provider.prefix,
                        },
                    )
                })
                .collect(),
            enable_socks5: proxy.enable_socks5,
            enable_socks5_udp: proxy.enable_socks5_udp,
            allow_upstream_proxy: proxy.allow_upstream_proxy,
            dangerously_allow_all_unix_sockets: proxy.dangerously_allow_all_unix_sockets,
            mode: match proxy.mode {
                NetworkMode::Limited => core_proxy::NetworkMode::Limited,
                NetworkMode::Full => core_proxy::NetworkMode::Full,
            },
            domains: proxy.domains.map(|domains| {
                domains
                    .into_iter()
                    .map(|(domain, permission)| {
                        (
                            domain,
                            match permission {
                                DomainPermission::None => core_proxy::DomainPermission::None,
                                DomainPermission::Allow => core_proxy::DomainPermission::Allow,
                                DomainPermission::Deny => core_proxy::DomainPermission::Deny,
                            },
                        )
                    })
                    .collect()
            }),
            review_domains: proxy.review_domains,
            unix_sockets: proxy.unix_sockets.map(|sockets| {
                sockets
                    .into_iter()
                    .map(|(path, permission)| {
                        (
                            path,
                            match permission {
                                UnixSocketPermission::Allow => {
                                    core_proxy::UnixSocketPermission::Allow
                                }
                                UnixSocketPermission::Deny => {
                                    core_proxy::UnixSocketPermission::Deny
                                }
                            },
                        )
                    })
                    .collect()
            }),
            allow_local_binding: proxy.allow_local_binding,
        },
        audit_metadata: core_proxy::NetworkProxyAuditMetadata {
            conversation_id: audit.conversation_id,
            app_version: audit.app_version,
            user_account_id: audit.user_account_id,
            auth_mode: audit.auth_mode,
            originator: audit.originator,
            user_email: audit.user_email,
            terminal_type: audit.terminal_type,
            model: audit.model,
            slug: audit.slug,
        },
        environment_id: launch.environment_id,
        execution_id: launch.execution_id,
        policy_decision_timeout_ms: launch.policy_decision_timeout_ms,
    }
}

pub fn core_exec(params: ExecParams) -> cx::ExecParams {
    cx::ExecParams {
        process_id: params.process_id,
        argv: params.argv,
        cwd: params.cwd,
        env: params.env,
        tty: params.tty,
        pipe_stdin: params.pipe_stdin,
        arg0: params.arg0,
        metadata: params.metadata.map(metadata_value),
        env_policy: params.env_policy.map(object_value),
        shell_snapshot: params
            .shell_snapshot
            .map(|snapshot| core_snapshot::ShellSnapshotRequest {
                scope_id: snapshot.scope_id,
                shell: core_snapshot::ShellInfo {
                    name: snapshot.shell.name,
                    path: snapshot.shell.path,
                },
            }),
        sandbox: params.sandbox.map(object_value),
        enforce_managed_network: params.enforce_managed_network,
        managed_network: params.managed_network.map(object_value),
        network_proxy: params.network_proxy.map(proxy_config),
    }
}

fn sandbox_type(kind: cx::SandboxType) -> SandboxType {
    match kind {
        cx::SandboxType::None => SandboxType::None,
        cx::SandboxType::MacosSeatbelt => SandboxType::MacosSeatbelt,
        cx::SandboxType::LinuxSeccomp => SandboxType::LinuxSeccomp,
        cx::SandboxType::WindowsRestrictedToken => SandboxType::WindowsRestrictedToken,
        cx::SandboxType::WindowsMxc => SandboxType::WindowsMxc,
    }
}

fn process_stream(stream: cx::OutputStream) -> ProcessStream {
    match stream {
        cx::OutputStream::Stdout => ProcessStream::Stdout,
        cx::OutputStream::Stderr => ProcessStream::Stderr,
        cx::OutputStream::Pty => ProcessStream::Pty,
    }
}

pub fn read_result(result: cx::ReadResult) -> ReadResult {
    ReadResult {
        chunks: result
            .chunks
            .into_iter()
            .map(|chunk| ProcessOutputChunk {
                seq: chunk.seq,
                stream: process_stream(chunk.stream),
                chunk: encode_base64(&chunk.chunk),
            })
            .collect(),
        next_seq: result.next_seq,
        exited: result.exited,
        exit_code: result.exit_code.map_or(Presence::Null, Presence::Value),
        closed: result.closed,
        failure: result.failure.map_or(Presence::Null, Presence::Value),
        sandbox_denied: Some(result.sandbox_denied),
    }
}

fn fs_path(
    path: &Text,
    follow_symlinks: Option<bool>,
    sandbox: Option<JsonObject>,
) -> cx::FsPathParams {
    cx::FsPathParams {
        path: url_text(path),
        follow_symlinks,
        sandbox: sandbox.map(object_value),
    }
}

fn presence(value: Option<String>) -> Presence<String> {
    value.map_or(Presence::Absent, Presence::Value)
}

pub fn environment_info(info: cx::EnvironmentInfo) -> EnvironmentInfo {
    let capabilities = info.capabilities;
    EnvironmentInfo {
        shell: ShellInfo {
            name: info.shell.name,
            path: info.shell.path,
        },
        executor_version: info.executor_version,
        provider_id: info.provider_id,
        cwd: presence(info.cwd),
        user_home_dir: presence(info.user_home_dir),
        platform_os: presence(info.platform_os),
        prepend_path_dirs: (!info.prepend_path_dirs.is_empty()).then_some(info.prepend_path_dirs),
        temporary_directories: Some(info.temporary_directories),
        temp_dir: presence(info.temp_dir),
        capabilities: EnvironmentCapabilities {
            network_proxy_launch: capabilities.network_proxy_launch,
            network_proxy_review_domains: capabilities.network_proxy_review_domains,
            credential_masking: capabilities.credential_masking,
            credential_masking_custom_providers: capabilities.credential_masking_custom_providers,
            capability_discovery_sandbox: capabilities.capability_discovery_sandbox,
            capability_discovery_v2: capabilities.capability_discovery_v2,
            environment_config_read: capabilities.environment_config_read,
            http_header_env_vars: capabilities.http_header_env_vars,
            sandboxed_file_streaming: capabilities.sandboxed_file_streaming,
            file_write_streaming: capabilities.file_write_streaming,
            shell_snapshot_v2: capabilities.shell_snapshot_v2,
            windows_mxc: capabilities.windows_mxc,
            ..EnvironmentCapabilities::default()
        },
    }
}

pub fn core_environment_config(
    params: EnvironmentConfigReadParams,
) -> CoreEnvironmentConfigReadParams {
    CoreEnvironmentConfigReadParams {
        cwd: url_text(&params.cwd),
        config_paths: params.config_paths,
        requirements_paths: params.requirements_paths,
    }
}

pub fn core_root_requests(params: CapabilityRootsDiscoverParams) -> Vec<CoreRootRequest> {
    params
        .roots
        .into_iter()
        .map(|root| CoreRootRequest {
            id: root.id,
            path: url_text(&root.path),
            sandbox: root.sandbox.map(object_value),
        })
        .collect()
}

pub fn core_initialize(params: InitializeParams) -> cx::InitializeParams {
    cx::InitializeParams {
        client_name: params.client_name,
    }
}

pub fn core_open(params: OpenParams) -> core_fs::OpenParams {
    core_fs::OpenParams {
        handle_id: params.handle_id,
        path: params.path,
        mode: match params.mode {
            OpenMode::Read => core_fs::OpenMode::Read,
            OpenMode::Replace => core_fs::OpenMode::Replace,
        },
        sandbox: params.sandbox.map(object_value),
    }
}

pub fn core_read_block(params: ReadBlockParams) -> core_fs::ReadBlockParams {
    core_fs::ReadBlockParams {
        handle_id: params.handle_id,
        offset: params.offset,
        len: usize::try_from(params.len).unwrap_or(usize::MAX),
    }
}

pub fn core_write_block(params: WriteBlockParams) -> core_fs::WriteBlockParams {
    core_fs::WriteBlockParams {
        handle_id: params.handle_id,
        offset: params.offset,
        chunk: params.chunk,
    }
}

pub fn core_close(params: CloseParams) -> core_fs::CloseParams {
    core_fs::CloseParams {
        handle_id: params.handle_id,
    }
}

pub fn core_http_request(params: HttpRequestParams) -> core_http::HttpRequestParams {
    core_http::HttpRequestParams {
        method: params.method,
        url: params.url,
        headers: params.headers.into_iter().map(core_header).collect(),
        body: params.body,
        timeout_ms: params.timeout_ms,
        redirect_policy: match params.redirect_policy {
            HttpRedirectPolicy::Follow => core_http::RedirectPolicy::Follow,
            HttpRedirectPolicy::Stop => core_http::RedirectPolicy::Stop,
        },
        request_id: params.request_id,
        stream_response: params.stream_response,
    }
}

pub struct CoreHandler {
    executor: Executor,
    sessions: Mutex<Vec<Bridge>>,
}

impl CoreHandler {
    pub fn new(executor: Executor) -> Self {
        Self {
            executor,
            sessions: Mutex::new(Vec::new()),
        }
    }

    pub fn environment_info(&self) -> EnvironmentInfo {
        environment_info(self.executor.environment_info())
    }

    pub async fn close(&self) -> Result<(), HandlerError> {
        locked(&self.sessions).clear();
        self.executor.close().await.map_err(failure)
    }
}

pub fn session_backend(executor: Executor) -> SessionBackend {
    let handler = Arc::new(CoreHandler::new(executor));
    let info = handler.clone();
    let closing = handler.clone();
    let close: CloseFn = Box::new(move || {
        let future: Boxed<'static, Result<(), ()>> =
            Box::pin(async move { closing.close().await.map_err(|_| ()) });
        future
    });
    SessionBackend {
        handler,
        environment_info: Arc::new(move || {
            let info = info.clone();
            let future: Boxed<'static, Result<EnvironmentInfo, HandlerError>> =
                Box::pin(async move { Ok(info.environment_info()) });
            future
        }),
        close,
    }
}

fn notifier(notifier: Notifier) -> cx::Notifier {
    Arc::new(move |method, params| {
        let notifier = notifier.clone();
        let future: BoxFuture<'static, ()> = Box::pin(async move {
            let _ = notifier.notify(method, params).await;
        });
        future
    })
}

fn session_call(caller: Caller) -> cx::SessionCall {
    Arc::new(move |method, params, options| {
        let caller = caller.clone();
        let future: BoxFuture<'static, Result<Value, ExecutorError>> = Box::pin(async move {
            let (signal, _bridge) = match &options.signal {
                Some(signal) => {
                    let (signal, bridge) = from_core_signal(signal);
                    (Some(signal), Some(bridge))
                }
                None => (None, None),
            };
            caller
                .call(
                    method,
                    params,
                    CallOptions {
                        timeout: options.timeout_ms.map(std::time::Duration::from_millis),
                        signal,
                    },
                )
                .await
                .map_err(call_failure)
        });
        future
    })
}

impl ExecutorHandler for CoreHandler {
    fn features(&self) -> BackendFeatures {
        backend_features()
    }

    fn supports(&self, method: OptionalMethod) -> bool {
        match method {
            OptionalMethod::EnvironmentConfigRead => ENVIRONMENT_CONFIG_READ_BACKED,
            OptionalMethod::CapabilityRootsDiscoverV1 => true,
        }
    }

    fn initialize<'a>(
        &'a self,
        params: InitializeParams,
        ctx: InitializeContext,
    ) -> Boxed<'a, Result<InitializeResult, HandlerError>> {
        Box::pin(async move {
            let (signal, bridge) = to_core_signal(&ctx.signal);
            locked(&self.sessions).push(bridge);
            let result = self
                .executor
                .initialize(
                    core_initialize(params),
                    cx::InitializeContext {
                        signal,
                        notify: Some(notifier(ctx.notifier)),
                        call: Some(session_call(ctx.caller)),
                    },
                )
                .await
                .map_err(failure)?;
            Ok(InitializeResult {
                session_id: result.session_id,
            })
        })
    }

    fn start_process<'a>(
        &'a self,
        params: ExecParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<ExecResult, HandlerError>> {
        Box::pin(async move {
            let (context, _bridge) = core_context(&ctx);
            let result = self
                .executor
                .start_process(core_exec(params), &context)
                .await
                .map_err(failure)?;
            Ok(ExecResult {
                process_id: result.process_id,
                sandbox_type: result
                    .sandbox_type
                    .map_or(Presence::Absent, |kind| Presence::Value(sandbox_type(kind))),
            })
        })
    }

    fn read_process<'a>(
        &'a self,
        params: ReadParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<ReadResult, HandlerError>> {
        Box::pin(async move {
            let (context, _bridge) = core_context(&ctx);
            let result = self
                .executor
                .read_process(
                    cx::ReadParams {
                        process_id: params.process_id,
                        after_seq: params.after_seq,
                        max_bytes: params.max_bytes,
                        wait_ms: params.wait_ms,
                    },
                    &context,
                )
                .await
                .map_err(failure)?;
            Ok(read_result(result))
        })
    }

    fn write_process<'a>(
        &'a self,
        params: WriteParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<WriteResult, HandlerError>> {
        Box::pin(async move {
            let (context, _bridge) = core_context(&ctx);
            let status = self
                .executor
                .write_process(
                    cx::WriteParams {
                        process_id: params.process_id,
                        chunk: lenient_base64(&params.chunk),
                        write_id: params.write_id,
                    },
                    &context,
                )
                .await
                .map_err(failure)?;
            Ok(WriteResult {
                status: match status {
                    cx::WriteStatus::Accepted => WriteStatus::Accepted,
                    cx::WriteStatus::UnknownProcess => WriteStatus::UnknownProcess,
                    cx::WriteStatus::StdinClosed => WriteStatus::StdinClosed,
                    cx::WriteStatus::Starting => WriteStatus::Starting,
                },
            })
        })
    }

    fn signal_process<'a>(
        &'a self,
        params: SignalParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<(), HandlerError>> {
        Box::pin(async move {
            let (context, _bridge) = core_context(&ctx);
            self.executor
                .signal_process(
                    cx::SignalParams {
                        process_id: params.process_id,
                    },
                    &context,
                )
                .await
                .map_err(failure)
        })
    }

    fn terminate_process<'a>(
        &'a self,
        params: TerminateParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<TerminateResult, HandlerError>> {
        Box::pin(async move {
            let (context, _bridge) = core_context(&ctx);
            let result = self
                .executor
                .terminate_process(
                    cx::TerminateParams {
                        process_id: params.process_id,
                    },
                    &context,
                )
                .await
                .map_err(failure)?;
            Ok(TerminateResult {
                running: result.running,
            })
        })
    }

    fn read_file<'a>(
        &'a self,
        params: FsReadFileParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<FsReadFileResult, HandlerError>> {
        Box::pin(async move {
            let (context, _bridge) = core_context(&ctx);
            let bytes = self
                .executor
                .read_file(
                    cx::FsReadFileParams {
                        path: url_text(&params.path),
                        follow_symlinks: params.follow_symlinks,
                        sandbox: params.sandbox.map(object_value),
                    },
                    &context,
                )
                .await
                .map_err(failure)?;
            Ok(FsReadFileResult {
                data_base64: encode_base64(&bytes),
            })
        })
    }

    fn write_file<'a>(
        &'a self,
        params: FsWriteFileParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<(), HandlerError>> {
        Box::pin(async move {
            let (context, _bridge) = core_context(&ctx);
            self.executor
                .write_file(
                    cx::FsWriteFileParams {
                        path: url_text(&params.path),
                        data: lenient_base64(&params.data_base64),
                        follow_symlinks: params.follow_symlinks,
                        sandbox: params.sandbox.map(object_value),
                    },
                    &context,
                )
                .await
                .map_err(failure)
        })
    }

    fn get_metadata<'a>(
        &'a self,
        params: FsGetMetadataParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<FsGetMetadataResult, HandlerError>> {
        Box::pin(async move {
            let (context, _bridge) = core_context(&ctx);
            let metadata = self
                .executor
                .get_metadata(
                    fs_path(&params.path, params.follow_symlinks, params.sandbox),
                    &context,
                )
                .await
                .map_err(failure)?;
            Ok(FsGetMetadataResult {
                is_directory: metadata.is_directory,
                is_file: metadata.is_file,
                is_symlink: metadata.is_symlink,
                size: metadata.size,
                created_at_ms: metadata.created_at_ms,
                modified_at_ms: metadata.modified_at_ms,
            })
        })
    }

    fn read_directory<'a>(
        &'a self,
        params: FsReadDirectoryParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<FsReadDirectoryResult, HandlerError>> {
        Box::pin(async move {
            let (context, _bridge) = core_context(&ctx);
            let entries = self
                .executor
                .read_directory(fs_path(&params.path, None, params.sandbox), &context)
                .await
                .map_err(failure)?;
            Ok(FsReadDirectoryResult {
                entries: entries
                    .into_iter()
                    .map(|entry| FsReadDirectoryEntry {
                        file_name: entry.file_name,
                        is_directory: entry.is_directory,
                        is_file: entry.is_file,
                    })
                    .collect(),
            })
        })
    }

    fn canonicalize<'a>(
        &'a self,
        params: FsCanonicalizeParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<FsCanonicalizeResult, HandlerError>> {
        Box::pin(async move {
            let (context, _bridge) = core_context(&ctx);
            let path = self
                .executor
                .canonicalize(fs_path(&params.path, None, params.sandbox), &context)
                .await
                .map_err(failure)?;
            Ok(FsCanonicalizeResult { path })
        })
    }

    fn read_environment_config<'a>(
        &'a self,
        params: EnvironmentConfigReadParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<Value, HandlerError>> {
        Box::pin(async move {
            let (context, _bridge) = core_context(&ctx);
            self.executor
                .read_environment_config(core_environment_config(params), &context)
                .await
                .map_err(failure)
        })
    }

    fn discover_capability_roots<'a>(
        &'a self,
        params: CapabilityRootsDiscoverParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<Value, HandlerError>> {
        Box::pin(async move {
            let (context, _bridge) = core_context(&ctx);
            let discovered = self
                .executor
                .discover_capability_roots(core_root_requests(params), &context)
                .await
                .map_err(failure)?;
            let mut document = JsonObject::new();
            document.insert(
                "roots".into(),
                Value::Array(discovered.iter().map(|root| root.to_json()).collect()),
            );
            Ok(Value::Object(document))
        })
    }

    fn open_rpc_connection(&self) -> Result<Option<Box<dyn ExecutorConnection>>, HandlerError> {
        let connection = self.executor.open_connection().map_err(failure)?;
        Ok(Some(Box::new(CoreConnection { connection })))
    }
}

pub struct CoreConnection {
    connection: Connection,
}

struct CoreStream {
    stream: core_http::HttpBodyStream,
    _bridge: Bridge,
}

impl HttpBodyStream for CoreStream {
    fn start(&self) -> Boxed<'_, Result<(), HandlerError>> {
        Box::pin(async move {
            self.stream.start().await;
            Ok(())
        })
    }

    fn cancel(&self) -> Boxed<'_, Result<(), HandlerError>> {
        Box::pin(async move {
            self.stream.cancel().await;
            Ok(())
        })
    }
}

fn core_header(header: HttpHeader) -> core_http::HttpHeader {
    core_http::HttpHeader {
        name: header.name,
        value: header.value,
        value_env_var: header.value_env_var,
    }
}

fn header(header: core_http::HttpHeader) -> HttpHeader {
    HttpHeader {
        name: header.name,
        value: header.value,
        value_env_var: header.value_env_var,
    }
}

fn discover_v2_value(params: &DiscoverV2Params) -> Value {
    let mut object = JsonObject::new();
    object.insert("cwd".into(), Value::String(params.cwd.clone()));
    if let Some(sandbox) = &params.sandbox {
        object.insert("sandbox".into(), Value::Object(sandbox.clone()));
    }
    Value::Object(object)
}

impl ExecutorConnection for CoreConnection {
    fn supports(&self, _method: ConnectionMethod) -> bool {
        true
    }

    fn discover_capabilities_v2<'a>(
        &'a self,
        params: DiscoverV2Params,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<Value, HandlerError>> {
        Box::pin(async move {
            let (context, _bridge) = core_context(&ctx);
            self.connection
                .discover_capabilities_v2(&discover_v2_value(&params), &context)
                .await
                .map_err(failure)
        })
    }

    fn create_directory<'a>(
        &'a self,
        params: CreateDirectoryParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<(), HandlerError>> {
        Box::pin(async move {
            let (context, _bridge) = core_context(&ctx);
            self.connection
                .create_directory(
                    core_fs::CreateDirectoryParams {
                        path: params.path,
                        recursive: params.recursive,
                        follow_symlinks: params.follow_symlinks,
                        sandbox: params.sandbox.map(object_value),
                    },
                    &context,
                )
                .await
                .map_err(failure)
        })
    }

    fn open<'a>(
        &'a self,
        params: OpenParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<OpenResult, HandlerError>> {
        Box::pin(async move {
            let (context, _bridge) = core_context(&ctx);
            let opened = self
                .connection
                .open(core_open(params), &context)
                .await
                .map_err(failure)?;
            Ok(OpenResult { handle_id: opened })
        })
    }

    fn read_block<'a>(
        &'a self,
        params: ReadBlockParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<ReadBlockResult, HandlerError>> {
        Box::pin(async move {
            let (context, _bridge) = core_context(&ctx);
            let block = self
                .connection
                .read_block(core_read_block(params), &context)
                .await
                .map_err(failure)?;
            Ok(ReadBlockResult {
                chunk: block.chunk,
                eof: block.eof,
            })
        })
    }

    fn write_block<'a>(
        &'a self,
        params: WriteBlockParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<(), HandlerError>> {
        Box::pin(async move {
            let (context, _bridge) = core_context(&ctx);
            self.connection
                .write_block(core_write_block(params), &context)
                .await
                .map_err(failure)
        })
    }

    fn close_handle<'a>(
        &'a self,
        params: CloseParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<(), HandlerError>> {
        Box::pin(async move {
            let (context, _bridge) = core_context(&ctx);
            self.connection
                .close_handle(core_close(params), &context)
                .await
                .map_err(failure)
        })
    }

    fn walk<'a>(
        &'a self,
        params: WalkParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<WalkResult, HandlerError>> {
        Box::pin(async move {
            let (context, _bridge) = core_context(&ctx);
            let walked = self
                .connection
                .walk(
                    core_fs::WalkParams {
                        path: params.path,
                        options: core_fs::WalkOptions {
                            max_depth: params.options.max_depth,
                            max_directories: params.options.max_directories,
                            max_entries: params.options.max_entries,
                            follow_directory_symlinks: params.options.follow_directory_symlinks,
                            prune_hidden_directories: params.options.prune_hidden_directories,
                        },
                        sandbox: params.sandbox.map(object_value),
                    },
                    &context,
                )
                .await
                .map_err(failure)?;
            Ok(WalkResult {
                entries: walked
                    .entries
                    .into_iter()
                    .map(|entry| WalkEntry {
                        path: entry.path,
                        kind: match entry.kind {
                            core_fs::WalkKind::Directory => WalkEntryKind::Directory,
                            core_fs::WalkKind::File => WalkEntryKind::File,
                        },
                    })
                    .collect(),
                errors: walked
                    .errors
                    .into_iter()
                    .map(|error| WalkError {
                        path: error.path,
                        message: error.message,
                    })
                    .collect(),
                truncated: walked.truncated,
            })
        })
    }

    fn remove<'a>(
        &'a self,
        params: RemoveParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<(), HandlerError>> {
        Box::pin(async move {
            let (context, _bridge) = core_context(&ctx);
            self.connection
                .remove(
                    core_fs::RemoveParams {
                        path: params.path,
                        recursive: params.recursive,
                        force: params.force,
                        follow_symlinks: params.follow_symlinks,
                        sandbox: params.sandbox.map(object_value),
                    },
                    &context,
                )
                .await
                .map_err(failure)
        })
    }

    fn copy<'a>(
        &'a self,
        params: CopyParams,
        ctx: HandlerContext,
    ) -> Boxed<'a, Result<(), HandlerError>> {
        Box::pin(async move {
            let (context, _bridge) = core_context(&ctx);
            self.connection
                .copy(
                    core_fs::CopyParams {
                        source_path: params.source_path,
                        destination_path: params.destination_path,
                        recursive: params.recursive,
                        sandbox: params.sandbox.map(object_value),
                    },
                    &context,
                )
                .await
                .map_err(failure)
        })
    }

    fn http_request<'a>(
        &'a self,
        params: HttpRequestParams,
        ctx: HttpContext,
    ) -> Boxed<'a, Result<HttpOutcome, HandlerError>> {
        Box::pin(async move {
            let handler_context = HandlerContext {
                signal: ctx.signal.clone(),
                session_id: ctx.session_id.clone(),
            };
            let request = core_http_request(params);
            let (context, bridge) = core_context(&handler_context);
            let sink = ctx.emit.clone();
            let emit: core_http::Emit = Arc::new(move |delta: core_http::BodyDelta| {
                let sink = sink.clone();
                let future: BoxFuture<'static, Result<(), ()>> = Box::pin(async move {
                    sink.emit(&HttpBodyDelta {
                        request_id: delta.request_id,
                        seq: delta.seq,
                        delta: delta.delta,
                        done: delta.done,
                        error: delta.error,
                    })
                    .await
                    .map_err(|_| ())
                });
                future
            });
            let outcome = self
                .connection
                .http_request(request, &context, emit)
                .await
                .map_err(failure)?;
            let stream = outcome.stream.map(|stream| {
                Box::new(CoreStream {
                    stream,
                    _bridge: bridge,
                }) as Box<dyn HttpBodyStream>
            });
            Ok(HttpOutcome {
                response: HttpResponse {
                    status: outcome.response.status,
                    headers: outcome.response.headers.into_iter().map(header).collect(),
                    body: outcome.response.body,
                },
                stream,
            })
        })
    }

    fn close(&self) -> Boxed<'_, ()> {
        Box::pin(async move {
            let _ = self.connection.close().await;
        })
    }
}
