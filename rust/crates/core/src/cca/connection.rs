use super::{
    discovery::{
        CapabilityDiscoveryV2, CapabilityRootDiscovery, CapabilityRootRequest,
        DiscoveryEnvironment, ReadTreeSource, discover_capability_roots,
    },
    environment_config::{self, EnvironmentConfigOptions},
    error::{
        AuthorizationDenied, AuthorizationInput, AuthorizeFn, BoxFuture, ExecutorError, Grant,
    },
    executor::{
        ActiveScope, Executor, FsDirectoryEntry, FsMetadata, FsPathParams,
        authorize_external_directory, authorize_fs_path, default_temporary_directories,
        file_contents, map_policy_error, permits, refusing, resolve_fs_path,
        sandbox_operation_roots, sandbox_permission_denied,
    },
    fs_extended::{
        CloseParams, CopyParams, CreateDirectoryParams, FsExtended, OpenMode, OpenParams,
        ReadBlockParams, ReadBlockResult, RemoveParams, WalkParams, WalkResult, WriteBlockParams,
    },
    http::{BodyDelta, Emit, HttpHandler, HttpOutcome, HttpRequestContext, HttpRequestParams},
    policy::{SandboxAccess, SandboxPolicy, parse_path_uri, within},
    signal::HandlerContext,
    transcript::{WriteOperation, WriteRecord},
    value::{LosslessString, Value},
};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

const CONTENT_CAPTURE_BYTES: u64 = 1024 * 1024;
pub use super::environment_config::EnvironmentConfigReadParams;

#[derive(Clone, Debug)]
pub struct ReadTreeParams {
    pub path: String,
    pub sandbox: Option<Value>,
}

struct TreeInner {
    executor: Executor,
    ctx: HandlerContext,
    active: Arc<ActiveScope>,
    sandbox_value: Option<Value>,
    tree_root: String,
    restricted: Option<SandboxPolicy>,
    extra_roots: Vec<String>,
    grant: tokio::sync::Mutex<Option<Grant>>,
}
#[derive(Clone)]
pub struct ReadTree {
    inner: Arc<TreeInner>,
    borrowed: bool,
}

impl ReadTree {
    pub(super) fn borrowed(&self) -> ReadTree {
        ReadTree {
            inner: self.inner.clone(),
            borrowed: true,
        }
    }
    async fn covered(&self, target: &str) -> Result<Option<(String, String)>, ExecutorError> {
        let inner = &self.inner;
        inner.executor.check_not_closed()?;
        if inner.grant.lock().await.is_none() {
            return Err(ExecutorError::new(-32603, "Read tree released"));
        }
        let native = parse_path_uri(target).map_err(map_policy_error)?;
        let resolved =
            match resolve_fs_path(&inner.active.roots(), target, false, &inner.extra_roots).await {
                Ok(resolved) => resolved,
                Err(error) if error.code == -32004 => return Err(error),
                Err(_) => return Ok(None),
            };
        Ok(within(&resolved, &inner.tree_root).then_some((resolved, native)))
    }
    fn readable(&self, resolved: &str, native: &str) -> Result<(), ExecutorError> {
        if let Some(sandbox) = &self.inner.restricted
            && !permits(sandbox.access(resolved, Some(native)), SandboxAccess::Read)
        {
            return Err(sandbox_permission_denied());
        }
        Ok(())
    }
    fn fallback(&self, path: &str) -> FsPathParams {
        FsPathParams {
            path: path.to_owned(),
            follow_symlinks: None,
            sandbox: self.inner.sandbox_value.clone(),
        }
    }
    pub async fn get_metadata(&self, path: &str) -> Result<FsMetadata, ExecutorError> {
        match self.covered(path).await? {
            None => {
                self.inner
                    .executor
                    .get_metadata(self.fallback(path), &self.inner.ctx)
                    .await
            }
            Some((resolved, _)) => Executor::path_metadata(&resolved).await,
        }
    }
    pub async fn read_directory(&self, path: &str) -> Result<Vec<FsDirectoryEntry>, ExecutorError> {
        match self.covered(path).await? {
            None => {
                self.inner
                    .executor
                    .read_directory(self.fallback(path), &self.inner.ctx)
                    .await
            }
            Some((resolved, native)) => {
                self.readable(&resolved, &native)?;
                Executor::directory_entries(&resolved).await
            }
        }
    }
    pub async fn read_file(&self, path: &str) -> Result<Vec<u8>, ExecutorError> {
        match self.covered(path).await? {
            None => Ok(self
                .inner
                .executor
                .read_file_in(&self.inner.active, path, self.inner.sandbox_value.as_ref())
                .await?
                .1),
            Some((resolved, native)) => {
                self.readable(&resolved, &native)?;
                file_contents(&resolved).await
            }
        }
    }
    pub async fn release(&self) -> Result<(), ExecutorError> {
        if self.borrowed {
            return Ok(());
        }
        let grant = self.inner.grant.lock().await.take();
        match grant {
            Some(grant) => grant.release().await.map_err(|_| ExecutorError::internal()),
            None => Ok(()),
        }
    }
}

impl ReadTreeSource for Executor {
    fn open_read_tree(
        &self,
        path: String,
        sandbox: Option<Value>,
        ctx: HandlerContext,
    ) -> BoxFuture<'_, Result<ReadTree, ExecutorError>> {
        Box::pin(async move {
            self.open_read_tree(ReadTreeParams { path, sandbox }, &ctx)
                .await
        })
    }
}

impl Executor {
    pub async fn open_read_tree(
        &self,
        params: ReadTreeParams,
        ctx: &HandlerContext,
    ) -> Result<ReadTree, ExecutorError> {
        self.check_not_closed()?;
        let sandbox = params.sandbox.clone();
        let active = self.session_scope(&ctx.session_id).await?;
        let opened = authorize_fs_path(
            &active,
            &params.path,
            sandbox.as_ref(),
            false,
            "read",
            SandboxAccess::Read,
            false,
        )
        .await?;
        let restricted = opened.sandbox.filter(|sandbox| sandbox.restricted);
        Ok(ReadTree {
            inner: Arc::new(TreeInner {
                executor: self.clone(),
                ctx: ctx.clone(),
                active,
                sandbox_value: params.sandbox,
                tree_root: opened.resolved,
                restricted,
                extra_roots: opened.extra_roots,
                grant: tokio::sync::Mutex::new(Some(opened.grant)),
            }),
            borrowed: false,
        })
    }

    pub async fn discover_capability_roots(
        &self,
        roots: Vec<CapabilityRootRequest>,
        ctx: &HandlerContext,
    ) -> Result<Vec<CapabilityRootDiscovery>, ExecutorError> {
        let source: Arc<dyn ReadTreeSource> = Arc::new(self.clone());
        discover_capability_roots(source, roots, ctx).await
    }

    pub async fn read_environment_config(
        &self,
        params: EnvironmentConfigReadParams,
        _ctx: &HandlerContext,
    ) -> Result<Value, ExecutorError> {
        self.check_not_closed()?;
        let options = &self.0.options;
        environment_config::read_environment_config(
            params,
            &EnvironmentConfigOptions {
                home_directory: options.home_directory.clone(),
                codex_home_env: options.codex_home_env.clone(),
                system_config_path: options.system_config_path.clone(),
                system_requirements_path: options.system_requirements_path.clone(),
                managed_config_path: options.managed_config_path.clone(),
                ..EnvironmentConfigOptions::default()
            },
        )
        .await
        .map(|result| result.to_json())
    }

    pub fn open_connection(&self) -> Result<Connection, ExecutorError> {
        self.check_not_closed()?;
        let source: Arc<dyn ReadTreeSource> = Arc::new(self.clone());
        let options = &self.0.options;
        let discovery = CapabilityDiscoveryV2::new(
            source,
            DiscoveryEnvironment {
                home_directory: options.home_directory.clone(),
                codex_home_env: options.codex_home_env.clone(),
                system_config_path: options.system_config_path.clone(),
                data_directory: options.data_directory.clone(),
            },
        );
        Ok(Connection(Arc::new(ConnInner {
            executor: self.clone(),
            https: Mutex::new(HashMap::new()),
            filesystems: Mutex::new(HashMap::new()),
            handles: Mutex::new(HashMap::new()),
            discovery,
            closing: tokio::sync::OnceCell::new(),
        })))
    }
}

struct Handle {
    handlers: FsExtended,
    active: Arc<ActiveScope>,
    path: String,
    mode: OpenMode,
    before: Option<Vec<u8>>,
    blocks: Vec<u8>,
    bytes: u64,
    sequential: bool,
}
struct ConnInner {
    executor: Executor,
    https: Mutex<HashMap<u64, HttpHandler>>,
    filesystems: Mutex<HashMap<String, FsExtended>>,
    handles: Mutex<HashMap<LosslessString, Handle>>,
    discovery: CapabilityDiscoveryV2,
    closing: tokio::sync::OnceCell<Result<(), ExecutorError>>,
}
#[derive(Clone)]
pub struct Connection(Arc<ConnInner>);

fn native_path(uri: &str) -> String {
    parse_path_uri(uri).unwrap_or_else(|_| uri.to_owned())
}
fn active_authorize(active: &Arc<ActiveScope>) -> AuthorizeFn {
    let active = active.clone();
    Arc::new(move |input: AuthorizationInput| {
        let active = active.clone();
        Box::pin(async move { active.authorize(input).await })
    })
}
fn authorize_with_external_directories(active: &Arc<ActiveScope>) -> AuthorizeFn {
    let active = active.clone();
    Arc::new(move |input: AuthorizationInput| {
        let active = active.clone();
        Box::pin(async move {
            let mut grants: Vec<Grant> = vec![];
            let outcome: Result<Grant, AuthorizationDenied> = async {
                for resource in &input.resources {
                    let Some(resource) = resource.as_str() else {
                        continue;
                    };
                    if !super::policy::is_absolute(resource) {
                        continue;
                    }
                    match authorize_external_directory(&active, resource).await {
                        Ok(Some(external)) => grants.push(external),
                        Ok(None) => {}
                        Err(_) => return Err(AuthorizationDenied::default()),
                    }
                }
                active.authorize(input.clone()).await
            }
            .await;
            match outcome {
                Ok(grant) => Ok(grants.into_iter().rev().fold(grant, |combined, external| {
                    Grant::combine(Some(external), combined)
                })),
                Err(error) => {
                    for grant in grants {
                        let _ = grant.release().await;
                    }
                    Err(error)
                }
            }
        })
    })
}

impl Connection {
    async fn scoped(
        &self,
        ctx: &HandlerContext,
        sandbox: Option<&Value>,
    ) -> Result<(Arc<ActiveScope>, FsExtended), ExecutorError> {
        let active = self.0.executor.session_scope(&ctx.session_id).await?;
        let mut extra = sandbox_operation_roots(sandbox);
        extra.extend(active.outside.clone());
        let mut seen = vec![];
        extra.retain(|root| {
            let fresh = !seen.contains(root);
            seen.push(root.clone());
            fresh
        });
        let key = serde_json::json!([active.id, active.roots(), extra]).to_string();
        let existing = self
            .0
            .filesystems
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&key)
            .cloned();
        let handlers = match existing {
            Some(handlers) => handlers,
            None => {
                let roots = active
                    .roots()
                    .into_iter()
                    .chain(extra.iter().cloned())
                    .collect::<Vec<_>>();
                let authorize = if extra.is_empty() {
                    active_authorize(&active)
                } else {
                    authorize_with_external_directories(&active)
                };
                let created =
                    FsExtended::new(roots, authorize, Arc::new(default_temporary_directories))?;
                self.0
                    .filesystems
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .entry(key)
                    .or_insert(created)
                    .clone()
            }
        };
        Ok((active, handlers))
    }
    async fn owner(
        &self,
        handle_id: &LosslessString,
        ctx: &HandlerContext,
    ) -> Result<FsExtended, ExecutorError> {
        let existing = self
            .0
            .handles
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(handle_id)
            .map(|handle| handle.handlers.clone());
        match existing {
            Some(handlers) => Ok(handlers),
            None => Ok(self.scoped(ctx, None).await?.1),
        }
    }
    fn record_write(
        active: &ActiveScope,
        operation: WriteOperation,
        path: String,
        destination: Option<String>,
    ) {
        active.record(|recorder| {
            recorder.write(WriteRecord {
                operation,
                path,
                destination,
                bytes: None,
                before: None,
                after: None,
            })
        });
    }

    pub async fn create_directory(
        &self,
        params: CreateDirectoryParams,
        ctx: &HandlerContext,
    ) -> Result<(), ExecutorError> {
        refusing(async {
            let (active, handlers) = self.scoped(ctx, params.sandbox.as_ref()).await?;
            handlers.create_directory(params.clone(), ctx).await?;
            Self::record_write(
                &active,
                WriteOperation::CreateDirectory,
                native_path(&params.path),
                None,
            );
            Ok(())
        })
        .await
    }
    pub async fn open(
        &self,
        params: OpenParams,
        ctx: &HandlerContext,
    ) -> Result<LosslessString, ExecutorError> {
        refusing(async {
            let (active, handlers) = self.scoped(ctx, params.sandbox.as_ref()).await?;
            let native = native_path(&params.path);
            let before = if params.mode == OpenMode::Replace {
                Executor::previous_content(&native).await
            } else {
                None
            };
            let handle_id = handlers.open(params.clone(), ctx).await?;
            self.0
                .handles
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(
                    params.handle_id.clone(),
                    Handle {
                        handlers,
                        active,
                        path: native,
                        mode: params.mode,
                        before,
                        blocks: vec![],
                        bytes: 0,
                        sequential: true,
                    },
                );
            Ok(handle_id)
        })
        .await
    }
    pub async fn read_block(
        &self,
        params: ReadBlockParams,
        ctx: &HandlerContext,
    ) -> Result<ReadBlockResult, ExecutorError> {
        refusing(async {
            let result = self
                .owner(&params.handle_id, ctx)
                .await?
                .read_block(params.clone(), ctx)
                .await?;
            if let Some(handle) = self
                .0
                .handles
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .get_mut(&params.handle_id)
            {
                handle.bytes += result.chunk.len() as u64;
            }
            Ok(result)
        })
        .await
    }
    pub async fn write_block(
        &self,
        params: WriteBlockParams,
        ctx: &HandlerContext,
    ) -> Result<(), ExecutorError> {
        refusing(async {
            self.owner(&params.handle_id, ctx)
                .await?
                .write_block(params.clone(), ctx)
                .await?;
            if let Some(handle) = self
                .0
                .handles
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .get_mut(&params.handle_id)
            {
                let length = params.chunk.len() as u64;
                handle.sequential = handle.sequential
                    && params.offset == handle.bytes
                    && handle.bytes + length <= CONTENT_CAPTURE_BYTES;
                if handle.sequential {
                    handle.blocks.extend_from_slice(&params.chunk);
                }
                handle.bytes += length;
            }
            Ok(())
        })
        .await
    }
    pub async fn close_handle(
        &self,
        params: CloseParams,
        ctx: &HandlerContext,
    ) -> Result<(), ExecutorError> {
        refusing(async {
            self.owner(&params.handle_id, ctx)
                .await?
                .close_handle(params.clone(), ctx)
                .await?;
            let handle = self
                .0
                .handles
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&params.handle_id);
            if let Some(handle) = handle {
                match handle.mode {
                    OpenMode::Read => handle
                        .active
                        .record(|recorder| recorder.read(&handle.path, handle.bytes)),
                    OpenMode::Replace => handle.active.record(|recorder| {
                        recorder.write(WriteRecord {
                            operation: WriteOperation::Write,
                            path: handle.path.clone(),
                            destination: None,
                            bytes: Some(handle.bytes),
                            before: handle.before.clone(),
                            after: handle.sequential.then(|| handle.blocks.clone()),
                        })
                    }),
                }
            }
            Ok(())
        })
        .await
    }
    pub async fn walk(
        &self,
        params: WalkParams,
        ctx: &HandlerContext,
    ) -> Result<WalkResult, ExecutorError> {
        refusing(async {
            let (_, handlers) = self.scoped(ctx, params.sandbox.as_ref()).await?;
            handlers.walk(params.clone(), ctx).await
        })
        .await
    }
    pub async fn remove(
        &self,
        params: RemoveParams,
        ctx: &HandlerContext,
    ) -> Result<(), ExecutorError> {
        refusing(async {
            let (active, handlers) = self.scoped(ctx, params.sandbox.as_ref()).await?;
            handlers.remove(params.clone(), ctx).await?;
            Self::record_write(
                &active,
                WriteOperation::Remove,
                native_path(&params.path),
                None,
            );
            Ok(())
        })
        .await
    }
    pub async fn copy(
        &self,
        params: CopyParams,
        ctx: &HandlerContext,
    ) -> Result<(), ExecutorError> {
        refusing(async {
            let (active, handlers) = self.scoped(ctx, params.sandbox.as_ref()).await?;
            handlers.copy(params.clone(), ctx).await?;
            Self::record_write(
                &active,
                WriteOperation::Copy,
                native_path(&params.source_path),
                Some(native_path(&params.destination_path)),
            );
            Ok(())
        })
        .await
    }

    pub async fn http_request(
        &self,
        params: HttpRequestParams,
        ctx: &HandlerContext,
        emit: Emit,
    ) -> Result<HttpOutcome, ExecutorError> {
        refusing(async {
            let active = self.0.executor.session_scope(&ctx.session_id).await?;
            let handler = {
                let mut https = self
                    .0
                    .https
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                match https.get(&active.id) {
                    Some(handler) => handler.clone(),
                    None => {
                        let created = HttpHandler::new(active_authorize(&active), None)?;
                        https.insert(active.id, created.clone());
                        created
                    }
                }
            };
            let streamed = Arc::new(AtomicU64::new(0));
            let status: Arc<Mutex<Option<u16>>> = Arc::new(Mutex::new(None));
            let (method, url) = (params.method.clone(), params.url.clone());
            let record = {
                let active = active.clone();
                move |status: Option<u16>, bytes: u64| {
                    active.record(|recorder| recorder.http(&method, &url, status, bytes))
                }
            };
            let wrapped: Emit = {
                let (streamed, status, record, emit) = (
                    streamed.clone(),
                    status.clone(),
                    record.clone(),
                    emit.clone(),
                );
                Arc::new(move |delta: BodyDelta| {
                    let total = streamed.fetch_add(delta.delta.len() as u64, Ordering::AcqRel)
                        + delta.delta.len() as u64;
                    if delta.done {
                        record(
                            *status.lock().unwrap_or_else(|error| error.into_inner()),
                            total,
                        );
                    }
                    emit(delta)
                })
            };
            let outcome = handler
                .request(
                    params,
                    HttpRequestContext {
                        signal: ctx.signal.clone(),
                        emit: wrapped,
                    },
                )
                .await;
            let outcome = match outcome {
                Ok(outcome) => outcome,
                Err(error) => {
                    if error.code != -32001 {
                        record(None, 0);
                    }
                    return Err(error);
                }
            };
            *status.lock().unwrap_or_else(|error| error.into_inner()) =
                Some(outcome.response.status);
            if outcome.stream.is_none() {
                record(
                    Some(outcome.response.status),
                    outcome.response.body.len() as u64,
                );
            }
            Ok(outcome)
        })
        .await
    }

    pub async fn discover_capabilities_v2(
        &self,
        params: &Value,
        ctx: &HandlerContext,
    ) -> Result<Value, ExecutorError> {
        self.0.executor.check_not_closed()?;
        Ok(self.0.discovery.discover(params, ctx).await?.to_json())
    }

    pub async fn close(&self) -> Result<(), ExecutorError> {
        self.0
            .closing
            .get_or_init(|| async {
                let filesystems = self
                    .0
                    .filesystems
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .values()
                    .cloned()
                    .collect::<Vec<_>>();
                let https = self
                    .0
                    .https
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .values()
                    .cloned()
                    .collect::<Vec<_>>();
                self.0.discovery.close();
                let mut failed = false;
                for handlers in filesystems {
                    failed |= handlers.shutdown().await.is_err();
                }
                for handler in https {
                    failed |= handler.close().await.is_err();
                }
                self.0
                    .handles
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .clear();
                if failed {
                    Err(ExecutorError::internal())
                } else {
                    Ok(())
                }
            })
            .await
            .clone()
    }
}
