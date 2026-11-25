use super::{
    credential_broker::CredentialBrokerCache,
    encoding::{base64_encode, sha256_hex, uuid_v4},
    environment_config::{EnvironmentConfigOptions, require_full_access},
    error::{
        Attribution, AuthorizationDenied, AuthorizationInput, Authorize, AuthorizeFn, BoxFuture,
        ExecutorError, Grant, ScopeContext, run_with_grant,
    },
    library::{LibraryBridge, LibraryFactory, LibraryLease, LibraryOpenInput, ReadFile},
    network_proxy::{
        NetworkPolicyDecider, NetworkProxyCommand, NetworkProxyHandle, NetworkProxyUpstreamTrust,
        Platform, PolicyDecisionListener, RemoteNetworkProxyLaunchConfig, StartNetworkProxyOptions,
        network_proxy_capabilities, start_network_proxy,
    },
    policy::{
        self, BuildProcessEnv, PolicyCode, PolicyError, ResolveSandboxOptions, SandboxAccess,
        SandboxIntent, SandboxPolicy, assert_argv, basename, build_process_env, dirname, join,
        parse_path_uri, resolve, resolve_contained, resolve_sandbox, to_path_uri,
    },
    shell_snapshot::{
        PrepareInput, ShellInfo, ShellSnapshotCache, ShellSnapshotLaunch, ShellSnapshotRequest,
    },
    signal::{HandlerContext, Signal},
    transcript::{ProcessRecord, ProcessRecording, Recorder, WriteOperation, WriteRecord},
    value::{
        JsonObject, LosslessString, Value as PValue, concat, from_serde, join as join_units,
        object_get, os_text, stringify_json, trim,
    },
};
use crate::resources::config::Configuration;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    io,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{Notify, mpsc, watch},
};

pub const CHUNK_SPLIT_SIZE: usize = 64 * 1024;
pub const MAX_FS_READ_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_FS_DIR_ENTRIES: usize = 50_000;
const MAX_RETAINED_EXITED_PROCESSES: usize = 25;
const MAX_ACCEPTED_WRITE_IDS: usize = 4096;
const DEFAULT_MAX_LIVE_PROCESSES: usize = 64;
pub const CONTENT_CAPTURE_BYTES: u64 = 1024 * 1024;
const OUTSIDE_ROOTS_MESSAGE: &str = "Operation not permitted (os error 1)";

pub type Notifier = Arc<dyn Fn(String, PValue) -> BoxFuture<'static, ()> + Send + Sync>;
#[derive(Clone, Default)]
pub struct CallOptions {
    pub timeout_ms: Option<u64>,
    pub signal: Option<Signal>,
}
pub type SessionCall = Arc<
    dyn Fn(String, PValue, CallOptions) -> BoxFuture<'static, Result<PValue, ExecutorError>>
        + Send
        + Sync,
>;

#[derive(Clone)]
pub struct InitializeContext {
    pub signal: Signal,
    pub notify: Option<Notifier>,
    pub call: Option<SessionCall>,
}
#[derive(Clone, Debug)]
pub struct InitializeParams {
    pub client_name: LosslessString,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InitializeResult {
    pub session_id: String,
}

#[derive(Clone, Debug, Default)]
pub struct ExecParams {
    pub process_id: LosslessString,
    pub argv: Vec<LosslessString>,
    pub cwd: LosslessString,
    pub env: Vec<(LosslessString, LosslessString)>,
    pub tty: bool,
    pub pipe_stdin: bool,
    pub arg0: Option<LosslessString>,
    pub metadata: Option<PValue>,
    pub env_policy: Option<PValue>,
    pub shell_snapshot: Option<ShellSnapshotRequest>,
    pub sandbox: Option<PValue>,
    pub enforce_managed_network: Option<bool>,
    pub managed_network: Option<PValue>,
    pub network_proxy: Option<RemoteNetworkProxyLaunchConfig>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecResult {
    pub process_id: LosslessString,
    pub sandbox_type: Option<SandboxType>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxType {
    None,
    MacosSeatbelt,
    LinuxSeccomp,
    WindowsRestrictedToken,
    WindowsMxc,
}
impl SandboxType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::MacosSeatbelt => "macosSeatbelt",
            Self::LinuxSeccomp => "linuxSeccomp",
            Self::WindowsRestrictedToken => "windowsRestrictedToken",
            Self::WindowsMxc => "windowsMxc",
        }
    }
}
#[derive(Clone, Debug)]
pub struct ReadParams {
    pub process_id: LosslessString,
    pub after_seq: Option<u64>,
    pub max_bytes: Option<u64>,
    pub wait_ms: Option<u64>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputStream {
    Stdout,
    Stderr,
    Pty,
}
impl OutputStream {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
            Self::Pty => "pty",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessOutputChunk {
    pub seq: u64,
    pub stream: OutputStream,
    pub chunk: Vec<u8>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadResult {
    pub chunks: Vec<ProcessOutputChunk>,
    pub next_seq: u64,
    pub exited: bool,
    pub exit_code: Option<i64>,
    pub closed: bool,
    pub failure: Option<String>,
    pub sandbox_denied: bool,
}
#[derive(Clone, Debug)]
pub struct WriteParams {
    pub process_id: LosslessString,
    pub chunk: Vec<u8>,
    pub write_id: LosslessString,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteStatus {
    Accepted,
    UnknownProcess,
    StdinClosed,
    Starting,
}
#[derive(Clone, Debug)]
pub struct SignalParams {
    pub process_id: LosslessString,
}
#[derive(Clone, Debug)]
pub struct TerminateParams {
    pub process_id: LosslessString,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminateResult {
    pub running: bool,
}

#[derive(Clone, Debug)]
pub struct FsReadFileParams {
    pub path: String,
    pub follow_symlinks: Option<bool>,
    pub sandbox: Option<PValue>,
}
#[derive(Clone, Debug)]
pub struct FsWriteFileParams {
    pub path: String,
    pub data: Vec<u8>,
    pub follow_symlinks: Option<bool>,
    pub sandbox: Option<PValue>,
}
#[derive(Clone, Debug)]
pub struct FsPathParams {
    pub path: String,
    pub follow_symlinks: Option<bool>,
    pub sandbox: Option<PValue>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FsMetadata {
    pub is_directory: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub created_at_ms: i64,
    pub modified_at_ms: i64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FsDirectoryEntry {
    pub file_name: String,
    pub is_directory: bool,
    pub is_file: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CreateDirectoryResult {
    Created { path: String },
    Existing,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EnvironmentCapabilities {
    pub network_proxy_launch: Option<bool>,
    pub network_proxy_review_domains: Option<bool>,
    pub credential_masking: Option<bool>,
    pub credential_masking_custom_providers: Option<bool>,
    pub capability_discovery_sandbox: Option<bool>,
    pub capability_discovery_v2: Option<bool>,
    pub environment_config_read: Option<bool>,
    pub http_header_env_vars: Option<bool>,
    pub sandboxed_file_streaming: Option<bool>,
    pub file_write_streaming: Option<bool>,
    pub shell_snapshot_v2: Option<bool>,
    pub windows_mxc: Option<bool>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvironmentInfo {
    pub shell: ShellInfo,
    pub executor_version: Option<String>,
    pub provider_id: Option<String>,
    pub cwd: Option<String>,
    pub user_home_dir: Option<String>,
    pub platform_os: Option<String>,
    pub prepend_path_dirs: Vec<String>,
    pub temporary_directories: Vec<String>,
    pub temp_dir: Option<String>,
    pub capabilities: EnvironmentCapabilities,
}
impl EnvironmentInfo {
    pub fn to_json(&self) -> PValue {
        let mut capabilities = serde_json::Map::new();
        let flags = [
            ("networkProxyLaunch", self.capabilities.network_proxy_launch),
            (
                "networkProxyReviewDomains",
                self.capabilities.network_proxy_review_domains,
            ),
            ("credentialMasking", self.capabilities.credential_masking),
            (
                "credentialMaskingCustomProviders",
                self.capabilities.credential_masking_custom_providers,
            ),
            (
                "capabilityDiscoverySandbox",
                self.capabilities.capability_discovery_sandbox,
            ),
            (
                "capabilityDiscoveryV2",
                self.capabilities.capability_discovery_v2,
            ),
            (
                "environmentConfigRead",
                self.capabilities.environment_config_read,
            ),
            ("httpHeaderEnvVars", self.capabilities.http_header_env_vars),
            (
                "sandboxedFileStreaming",
                self.capabilities.sandboxed_file_streaming,
            ),
            ("fileWriteStreaming", self.capabilities.file_write_streaming),
            ("shellSnapshotV2", self.capabilities.shell_snapshot_v2),
            ("windowsMxc", self.capabilities.windows_mxc),
        ];
        for (name, flag) in flags {
            if let Some(flag) = flag {
                capabilities.insert(name.to_owned(), Value::Bool(flag));
            }
        }
        let mut info = serde_json::Map::new();
        if let Some(value) = &self.executor_version {
            info.insert("executorVersion".to_owned(), json!(value));
        }
        if let Some(value) = &self.provider_id {
            info.insert("providerId".to_owned(), json!(value));
        }
        if let Some(value) = &self.cwd {
            info.insert("cwd".to_owned(), json!(value));
        }
        if let Some(value) = &self.user_home_dir {
            info.insert("userHomeDir".to_owned(), json!(value));
        }
        if let Some(value) = &self.platform_os {
            info.insert("platformOs".to_owned(), json!(value));
        }
        if !self.prepend_path_dirs.is_empty() {
            info.insert("prependPathDirs".to_owned(), json!(self.prepend_path_dirs));
        }
        info.insert(
            "temporaryDirectories".to_owned(),
            json!(self.temporary_directories),
        );
        if let Some(value) = &self.temp_dir {
            info.insert("tempDir".to_owned(), json!(value));
        }
        info.insert("capabilities".to_owned(), Value::Object(capabilities));
        let PValue::Object(mut info) = from_serde(&Value::Object(info)) else {
            unreachable!()
        };
        let mut shell = JsonObject::new();
        shell.insert("name".into(), PValue::String(self.shell.name.clone()));
        shell.insert("path".into(), PValue::String(self.shell.path.clone()));
        info.insert("shell".into(), PValue::Object(shell));
        PValue::Object(info)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EnvironmentOverrides {
    pub shell: Option<ShellInfo>,
    pub executor_version: Option<String>,
    pub provider_id: Option<String>,
    pub user_home_dir: Option<String>,
    pub temp_dir: Option<String>,
    pub prepend_path_dirs: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct ProcessAnswer {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i64,
}
pub struct AnswerContext {
    pub attribution: Option<Attribution>,
    pub session_id: String,
}
pub trait AnswerProcess: Send + Sync {
    fn answer(
        &self,
        params: &ExecParams,
        context: AnswerContext,
    ) -> BoxFuture<'static, Result<Option<ProcessAnswer>, ExecutorError>>;
}

pub struct NetworkPolicyInput {
    pub process_id: LosslessString,
    pub launch: RemoteNetworkProxyLaunchConfig,
    pub call: SessionCall,
    pub notify: Arc<dyn Fn(String, PValue) + Send + Sync>,
    pub signal: Signal,
}
#[derive(Default)]
pub struct NetworkPolicyHooks {
    pub decider: Option<NetworkPolicyDecider>,
    pub on_policy_decision: Option<PolicyDecisionListener>,
}
pub trait NetworkPolicyFactory: Send + Sync {
    fn hooks(&self, input: NetworkPolicyInput) -> NetworkPolicyHooks;
}

pub trait ExecutorScope: Send + Sync {
    fn session_id(&self) -> String;
    fn roots(&self) -> Vec<String>;
    fn authorization(&self) -> Arc<dyn Authorize>;
    fn transcript(&self) -> Option<Arc<dyn Recorder>> {
        None
    }
    fn library(&self) -> Option<Arc<dyn LibraryFactory>> {
        None
    }
    fn library_signal(&self) -> Option<Signal> {
        None
    }
    fn close(&self) -> BoxFuture<'_, Result<(), ExecutorError>>;
}
pub trait ScopeProvider: Send + Sync {
    fn scope_for(
        &self,
        attribution: Option<Attribution>,
        context: ScopeContext,
    ) -> BoxFuture<'_, Result<Arc<dyn ExecutorScope>, ExecutorError>>;
}

pub struct ExecutorOptions {
    pub scope_provider: Arc<dyn ScopeProvider>,
    pub answer_process: Option<Arc<dyn AnswerProcess>>,
    pub base_env: BTreeMap<String, String>,
    pub session_id: Option<Arc<dyn Fn() -> String + Send + Sync>>,
    pub process_timeout_ms: Option<u64>,
    pub max_buffered_bytes_per_process: Option<usize>,
    pub max_live_processes: Option<usize>,
    pub network_proxy_ca_directory: Option<PathBuf>,
    pub network_proxy_upstream_trust: Option<NetworkProxyUpstreamTrust>,
    pub network_policy: Option<Arc<dyn NetworkPolicyFactory>>,
    pub environment: EnvironmentOverrides,
    pub home_directory: PathBuf,
    pub data_directory: PathBuf,
    pub codex_home_env: Option<String>,
    pub system_config_path: Option<PathBuf>,
    pub system_requirements_path: Option<PathBuf>,
    pub managed_config_path: Option<PathBuf>,
}

tokio::task_local! {
    static REFUSALS: Arc<Mutex<Option<LosslessString>>>;
}

pub(super) struct ActiveScope {
    pub(super) id: u64,
    pub(super) scope: Arc<dyn ExecutorScope>,
    pub(super) outside: Vec<String>,
}
impl ActiveScope {
    pub(super) fn roots(&self) -> Vec<String> {
        self.scope.roots()
    }
    pub(super) fn record(&self, write: impl FnOnce(&dyn Recorder)) {
        if let Some(recorder) = self.scope.transcript() {
            write(recorder.as_ref());
        }
    }
    pub(super) async fn authorize(
        &self,
        input: AuthorizationInput,
    ) -> Result<Grant, AuthorizationDenied> {
        let authorization = self.scope.authorization();
        match authorization.authorize(input.clone()).await {
            Ok(grant) => Ok(grant),
            Err(denied) => {
                let subject = denied_subject(&input);
                self.record(|recorder| recorder.denied(&input.action, &subject, &denied.trace));
                if let Some(text) = denied.refusal_text() {
                    let _ = REFUSALS.try_with(|slot| {
                        let mut slot = slot.lock().unwrap_or_else(|error| error.into_inner());
                        if slot.is_none() {
                            *slot = Some(text);
                        }
                    });
                }
                Err(denied)
            }
        }
    }
    pub(super) async fn check(
        &self,
        action: &str,
        resources: Vec<LosslessString>,
        metadata: Option<JsonObject>,
    ) -> Result<Grant, ExecutorError> {
        let mut input = AuthorizationInput::new(action, resources);
        input.metadata = metadata;
        match self.authorize(input).await {
            Ok(grant) => Ok(grant),
            Err(denied) => Err(match denied.refusal_text() {
                Some(text) => ExecutorError::refusal(text),
                None => ExecutorError::permission_denied(),
            }),
        }
    }
}
fn denied_subject(input: &AuthorizationInput) -> LosslessString {
    let subject = input.resources.first().cloned().unwrap_or_default();
    if input.action != super::http::NETWORK_ACTION {
        return subject;
    }
    match url::Url::parse(&os_text(&subject)) {
        Ok(url) => format!("{}{}", url.origin().ascii_serialization(), url.path()).into(),
        Err(_) => LosslessString::default(),
    }
}

pub(super) async fn refusing<T>(
    run: impl std::future::Future<Output = Result<T, ExecutorError>>,
) -> Result<T, ExecutorError> {
    let slot = Arc::new(Mutex::new(None));
    let outcome = REFUSALS.scope(slot.clone(), run).await;
    match outcome {
        Err(error) if error.refusal.is_none() => {
            let text = slot
                .lock()
                .unwrap_or_else(|inner| inner.into_inner())
                .clone();
            Err(match text {
                Some(text) => ExecutorError::refusal(text),
                None => error,
            })
        }
        other => other,
    }
}
fn slot_text() -> Option<LosslessString> {
    REFUSALS
        .try_with(|slot| {
            slot.lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone()
        })
        .ok()
        .flatten()
}

pub(super) fn default_temporary_directories() -> Vec<String> {
    let names: &[&str] = if cfg!(windows) {
        &["TEMP", "TMP"]
    } else {
        &["TMPDIR"]
    };
    let mut directories: Vec<String> = vec![];
    for name in names {
        let Ok(value) = std::env::var(name) else {
            continue;
        };
        if value.is_empty() || (cfg!(windows) && !policy::is_absolute(&value)) {
            continue;
        }
        let resolved = resolve(
            &std::env::current_dir()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|_| "/".to_owned()),
            &value,
        );
        if !directories.contains(&resolved) {
            directories.push(resolved);
        }
    }
    directories
}
fn path_uris(paths: &[String]) -> Vec<String> {
    let mut uris: Vec<String> = vec![];
    for entry in paths {
        if let Ok(uri) = to_path_uri(entry)
            && !uris.contains(&uri)
        {
            uris.push(uri);
        }
    }
    uris
}

fn field<'a>(value: &'a PValue, key: &str) -> Option<&'a PValue> {
    match value {
        PValue::Object(object) => object_get(object, key),
        _ => None,
    }
}
fn json_array(value: &PValue) -> Option<&Vec<PValue>> {
    match value {
        PValue::Array(items) => Some(items),
        _ => None,
    }
}
fn json_text(value: &PValue) -> Option<&str> {
    match value {
        PValue::String(text) => text.as_str(),
        _ => None,
    }
}
pub(super) fn sandbox_operation_roots(sandbox: Option<&PValue>) -> Vec<String> {
    let Some(sandbox) = sandbox.filter(|value| !matches!(value, PValue::Null)) else {
        return vec![];
    };
    let context = field(sandbox, "policyContext").unwrap_or(sandbox);
    let mut roots: Vec<String> = vec![];
    let add = |roots: &mut Vec<String>, value: Option<&PValue>| {
        if let Some(PValue::String(text)) = value
            && let Ok(native) = parse_path_uri(&os_text(text))
        {
            roots.push(native);
        }
    };
    add(&mut roots, field(context, "cwd"));
    if let Some(workspace) = field(context, "workspaceRoots").and_then(json_array) {
        for root in workspace {
            add(&mut roots, Some(root));
        }
    }
    let Some(entries) = field(sandbox, "permissions")
        .and_then(|permissions| field(permissions, "file_system"))
        .and_then(|fs| field(fs, "entries"))
        .and_then(json_array)
    else {
        return roots;
    };
    let temporary = field(sandbox, "temporaryDirectories").and_then(json_array);
    for entry in entries {
        let access = field(entry, "access").and_then(json_text);
        let target = field(entry, "path");
        if !matches!(access, Some("read" | "write"))
            || target
                .and_then(|target| field(target, "type"))
                .and_then(json_text)
                != Some("special")
        {
            continue;
        }
        let kind = target
            .and_then(|target| field(target, "value"))
            .and_then(|value| field(value, "kind"))
            .and_then(json_text);
        if kind == Some("tmpdir") {
            match temporary {
                Some(list) => {
                    for root in list {
                        add(&mut roots, Some(root));
                    }
                }
                None => roots.extend(default_temporary_directories()),
            }
        } else if kind == Some("slash_tmp") && !cfg!(windows) {
            roots.push("/tmp".to_owned());
        }
    }
    roots
}

pub(super) fn permits(access: SandboxAccess, need: SandboxAccess) -> bool {
    access.permits(need)
}
fn outside_roots() -> ExecutorError {
    ExecutorError::new(-32600, OUTSIDE_ROOTS_MESSAGE)
}
pub(super) fn is_outside_roots(error: &ExecutorError) -> bool {
    error.code == -32600 && error.message.as_str() == Some(OUTSIDE_ROOTS_MESSAGE)
}
pub(super) fn sandbox_permission_denied() -> ExecutorError {
    ExecutorError::new(-32600, "Permission denied")
}
pub(super) fn map_policy_error(error: PolicyError) -> ExecutorError {
    if error.code == PolicyCode::OutsideRoots {
        outside_roots()
    } else {
        ExecutorError::new(-32602, error.message)
    }
}
fn not_a_directory() -> ExecutorError {
    ExecutorError::new(-32603, "Not a directory (os error 20)")
}
async fn missing_fs_path(native: &str) -> ExecutorError {
    match tokio::fs::metadata(native).await {
        Err(error) if error.kind() == io::ErrorKind::NotADirectory => not_a_directory(),
        _ => ExecutorError::not_found(),
    }
}
pub(super) fn map_fs_error(error: &io::Error) -> ExecutorError {
    match error.kind() {
        io::ErrorKind::NotFound => ExecutorError::not_found(),
        io::ErrorKind::NotADirectory => not_a_directory(),
        io::ErrorKind::InvalidInput => ExecutorError::new(-32600, "Invalid path"),
        io::ErrorKind::PermissionDenied => ExecutorError::new(-32600, "Permission denied"),
        _ => ExecutorError::new(-32603, "Filesystem error"),
    }
}
fn missing_path(error: &PolicyError) -> bool {
    error.code == PolicyCode::InvalidPath && error.message.as_str() == Some("path does not exist")
}

#[derive(Clone, Copy)]
enum Missing {
    Fs,
    Start,
}
async fn missing_error(kind: Missing, native: &str) -> ExecutorError {
    match kind {
        Missing::Fs => missing_fs_path(native).await,
        Missing::Start => ExecutorError::new(-32603, "Failed to start process"),
    }
}
async fn resolve_existing_path(
    roots: &[String],
    uri: &str,
    allow_missing_final: bool,
    inside: Missing,
    extra_roots: &[String],
    outside: Option<Missing>,
) -> Result<String, ExecutorError> {
    let scope = roots
        .iter()
        .chain(extra_roots.iter())
        .cloned()
        .collect::<Vec<_>>();
    let native = parse_path_uri(uri).map_err(map_policy_error)?;
    match resolve_contained(&native, &scope, allow_missing_final).await {
        Ok(resolved) => return Ok(resolved),
        Err(error) if missing_path(&error) => {}
        Err(error) => return Err(map_policy_error(error)),
    }
    let mut ancestor = dirname(&native);
    loop {
        let contained = match resolve_contained(&ancestor, &scope, false).await {
            Ok(_) => Some(true),
            Err(error) if missing_path(&error) => Some(false),
            Err(error) if outside.is_some() && error.code == PolicyCode::OutsideRoots => None,
            Err(error) => return Err(map_policy_error(error)),
        };
        if contained == Some(true) {
            return Err(missing_error(inside, &native).await);
        }
        if contained.is_none() || dirname(&ancestor) == ancestor {
            return Err(match outside {
                None => outside_roots(),
                Some(kind) => missing_error(kind, &native).await,
            });
        }
        ancestor = dirname(&ancestor);
    }
}
pub(super) async fn resolve_fs_path(
    roots: &[String],
    uri: &str,
    allow_missing_final: bool,
    extra_roots: &[String],
) -> Result<String, ExecutorError> {
    resolve_existing_path(
        roots,
        uri,
        allow_missing_final,
        Missing::Fs,
        extra_roots,
        Some(Missing::Fs),
    )
    .await
}
async fn inside_roots(roots: &[String], resolved: &str) -> bool {
    resolve_contained(resolved, roots, true).await.is_ok()
}
pub(super) async fn authorize_external_directory(
    active: &ActiveScope,
    resolved: &str,
) -> Result<Option<Grant>, ExecutorError> {
    if inside_roots(&active.roots(), resolved).await {
        return Ok(None);
    }
    let is_directory = tokio::fs::metadata(resolved)
        .await
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false);
    let directory = if is_directory {
        resolved.to_owned()
    } else {
        dirname(resolved)
    };
    let mut metadata = JsonObject::new();
    metadata.insert("filepath".into(), PValue::String(resolved.into()));
    metadata.insert("parentDir".into(), PValue::String(directory.clone().into()));
    active
        .check(
            "external_directory",
            vec![join(&directory, &["*"]).into()],
            Some(metadata),
        )
        .await
        .map(Some)
}

pub(super) struct AuthorizedPath {
    pub resolved: String,
    pub grant: Grant,
    pub sandbox: Option<SandboxPolicy>,
    pub extra_roots: Vec<String>,
}
pub(super) async fn authorize_fs_path(
    active: &ActiveScope,
    path: &str,
    sandbox_value: Option<&PValue>,
    allow_missing_final: bool,
    action: &str,
    need: SandboxAccess,
    check_sandbox_access: bool,
) -> Result<AuthorizedPath, ExecutorError> {
    let native = parse_path_uri(path).map_err(map_policy_error)?;
    let sandbox = resolve_sandbox(
        &SandboxIntent {
            sandbox: sandbox_value,
            ..Default::default()
        },
        &ResolveSandboxOptions {
            temporary_directories: default_temporary_directories(),
            ..Default::default()
        },
    )
    .await
    .map_err(map_policy_error)?;
    let confined = sandbox.as_ref().is_some_and(|sandbox| sandbox.restricted);
    let mut extra_roots = sandbox_operation_roots(sandbox_value);
    extra_roots.extend(active.outside.clone());
    let resolved =
        match resolve_fs_path(&active.roots(), path, allow_missing_final, &extra_roots).await {
            Ok(resolved) => resolved,
            Err(error) if confined && is_outside_roots(&error) => {
                return Err(sandbox_permission_denied());
            }
            Err(error) => return Err(error),
        };
    if check_sandbox_access
        && confined
        && !sandbox
            .as_ref()
            .is_some_and(|sandbox| permits(sandbox.access(&resolved, Some(&native)), need))
    {
        return Err(sandbox_permission_denied());
    }
    let external = match authorize_external_directory(active, &resolved).await {
        Ok(external) => external,
        Err(error) if confined && error.code == -32001 => return Err(sandbox_permission_denied()),
        Err(error) => return Err(error),
    };
    match active
        .check(action, vec![resolved.clone().into()], None)
        .await
    {
        Ok(grant) => Ok(AuthorizedPath {
            resolved,
            grant: Grant::combine(external, grant),
            sandbox,
            extra_roots,
        }),
        Err(error) => {
            if let Some(external) = external {
                let _ = external.release().await;
            }
            if confined && error.code == -32001 {
                return Err(sandbox_permission_denied());
            }
            Err(error)
        }
    }
}

const SHELL_WRAPPER_NAMES: [&str; 3] = ["sh", "bash", "zsh"];
const SHELL_WRAPPER_FLAGS: [&str; 3] = ["-c", "-lc", "-ic"];
pub(super) fn shell_wrapper_script(argv: &[LosslessString]) -> Option<&LosslessString> {
    if argv.len() != 3 {
        return None;
    }
    let program = argv[0].code_units().collect::<Vec<_>>();
    let start = program
        .iter()
        .rposition(|unit| *unit == 0x2f || (cfg!(windows) && *unit == 0x5c))
        .map_or(0, |index| index + 1);
    let name = LosslessString::from_utf16(program[start..].to_vec());
    if !name
        .as_str()
        .is_some_and(|name| SHELL_WRAPPER_NAMES.contains(&name))
        || !argv[1]
            .as_str()
            .is_some_and(|flag| SHELL_WRAPPER_FLAGS.contains(&flag))
    {
        return None;
    }
    Some(&argv[2])
}

fn uppercase(name: &LosslessString) -> LosslessString {
    let mut units = vec![];
    for character in char::decode_utf16(name.code_units()) {
        match character {
            Ok(character) => {
                for upper in character.to_uppercase() {
                    units.extend(upper.encode_utf16(&mut [0; 2]).iter().copied());
                }
            }
            Err(unit) => units.push(unit.unpaired_surrogate()),
        }
    }
    LosslessString::from_utf16(units)
}
fn library_reserved(name: &LosslessString) -> bool {
    let upper = uppercase(name).code_units().collect::<Vec<_>>();
    let prefix = "CODEX_APPS_".encode_utf16().collect::<Vec<_>>();
    if let Some(rest) = upper.strip_prefix(prefix.as_slice()) {
        let exact = |name: &str| rest.iter().copied().eq(name.encode_utf16());
        let contains = |name: &str| {
            let name = name.encode_utf16().collect::<Vec<_>>();
            rest.windows(name.len()).any(|part| part == name.as_slice())
        };
        if exact("MCP_URL") || exact("AUTHORIZATION") || contains("ACCOUNT") || contains("HEADERS")
        {
            return true;
        }
    }
    ["CHATGPT_ACCOUNT_ID", "OPENAI_ACCOUNT_ID", "NO_PROXY"]
        .iter()
        .any(|name| upper.iter().copied().eq(name.encode_utf16()))
}
fn assignment_name(word: &[u16]) -> Option<LosslessString> {
    let equals = word.iter().position(|unit| *unit == 0x3d)?;
    let name = &word[..equals];
    let letter =
        |unit: u16| (0x41..=0x5a).contains(&unit) || (0x61..=0x7a).contains(&unit) || unit == 0x5f;
    (name.first().is_some_and(|unit| letter(*unit))
        && name
            .iter()
            .all(|unit| letter(*unit) || (0x30..=0x39).contains(unit)))
    .then(|| LosslessString::from_utf16(name.to_vec()))
}
fn library_selector() -> LosslessString {
    format!("CODEX_APPS_MCP_URL={}", super::library::LIBRARY_PROCESS_URL).into()
}
pub(super) fn library_command(
    argv: &[LosslessString],
) -> Result<(Vec<LosslessString>, bool), ExecutorError> {
    let invalid = |message: &str| ExecutorError::new(-32602, message);
    let Some(script) = shell_wrapper_script(argv) else {
        if argv.first().and_then(LosslessString::as_str) != Some("/usr/bin/env")
            || argv.get(1) != Some(&library_selector())
        {
            return Ok((argv.to_vec(), false));
        }
        let mut executable = false;
        for word in &argv[2..] {
            let units = word.code_units().collect::<Vec<_>>();
            let Some(name) = assignment_name(&units) else {
                if units.is_empty() || units.first() == Some(&0x2d) || units.contains(&0x3d) {
                    return Err(invalid("Private Library command requires an executable"));
                }
                executable = true;
                break;
            };
            if library_reserved(&name) {
                return Err(invalid("Reserved private Library environment assignment"));
            }
        }
        if !executable {
            return Err(invalid("Private Library command requires an executable"));
        }
        let mut selected = vec![argv[0].clone()];
        selected.extend(argv[2..].iter().cloned());
        return Ok((selected, true));
    };
    let script = script.code_units().collect::<Vec<_>>();
    let selector = library_selector().code_units().collect::<Vec<_>>();
    let leading = script
        .iter()
        .take_while(|unit| matches!(**unit, 0x20 | 0x9))
        .count();
    let trimmed = &script[leading..];
    let env_command = "/usr/bin/env".encode_utf16().collect::<Vec<_>>();
    let Some(after_env) = trimmed.strip_prefix(env_command.as_slice()) else {
        return Ok((argv.to_vec(), false));
    };
    let spaces = after_env
        .iter()
        .take_while(|unit| matches!(**unit, 0x20 | 0x9))
        .count();
    if spaces == 0 {
        return Ok((argv.to_vec(), false));
    }
    let Some(rest) = after_env[spaces..].strip_prefix(selector.as_slice()) else {
        return Ok((argv.to_vec(), false));
    };
    if rest
        .first()
        .is_some_and(|unit| !matches!(*unit, 0x20 | 0x9))
    {
        return Ok((argv.to_vec(), false));
    }
    let mut index = 0;
    let mut executable = false;
    while index < rest.len() {
        while index < rest.len() && matches!(rest[index], 0x20 | 0x9) {
            index += 1;
        }
        if index >= rest.len() || matches!(rest[index], 0x3b | 0x7c | 0x26 | 0x3c | 0x3e | 0xa) {
            break;
        }
        let mut word = vec![];
        let mut quote: Option<u16> = None;
        let mut dynamic = false;
        while index < rest.len() {
            let character = rest[index];
            if quote.is_none()
                && matches!(
                    character,
                    0x20 | 0x9 | 0xa | 0x3b | 0x7c | 0x26 | 0x3c | 0x3e
                )
            {
                break;
            }
            index += 1;
            if character == 0x5c && quote != Some(0x27) {
                if index >= rest.len() || rest[index] == 0xa {
                    return Err(invalid("Invalid private Library command"));
                }
                word.push(rest[index]);
                index += 1;
            } else if quote == Some(character) {
                quote = None;
            } else if quote.is_none() && matches!(character, 0x27 | 0x22) {
                quote = Some(character);
            } else {
                if (quote != Some(0x27) && matches!(character, 0x24 | 0x60))
                    || (quote.is_none()
                        && (matches!(
                            character,
                            0x3f | 0x2a | 0x5b | 0x5d | 0x7b | 0x7d | 0x7e | 0x28 | 0x29
                        ) || (character == 0x23 && word.is_empty())))
                {
                    dynamic = true;
                }
                word.push(character);
            }
        }
        if quote.is_some() {
            return Err(invalid("Invalid private Library command"));
        }
        if dynamic {
            return Err(invalid(
                "Private Library command must begin with a literal executable",
            ));
        }
        let Some(name) = assignment_name(&word) else {
            if word.is_empty() || word.first() == Some(&0x2d) || word.contains(&0x3d) {
                return Err(invalid("Private Library command requires an executable"));
            }
            executable = true;
            break;
        };
        if library_reserved(&name) {
            return Err(invalid("Reserved private Library environment assignment"));
        }
    }
    if !executable {
        return Err(invalid("Private Library command requires an executable"));
    }
    Ok((argv.to_vec(), true))
}

fn set_environment(
    env: &mut Vec<(LosslessString, LosslessString)>,
    key: &str,
    value: LosslessString,
) {
    if let Some((_, current)) = env.iter_mut().find(|(name, _)| name.as_str() == Some(key)) {
        *current = value;
    } else {
        env.push((key.into(), value));
    }
}

#[derive(Clone, Copy)]
pub(super) enum Kill {
    Term,
    Int,
    Force,
}
pub(super) fn kill_group(pid: u32, kind: Kill) {
    #[cfg(unix)]
    unsafe {
        let signal = match kind {
            Kill::Term => libc::SIGTERM,
            Kill::Int => libc::SIGINT,
            Kill::Force => libc::SIGKILL,
        };
        if libc::kill(-(pid as i32), signal) == -1 {
            libc::kill(pid as i32, signal);
        }
    }
    #[cfg(windows)]
    {
        let _ = kind;
        let _ = std::process::Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .spawn();
    }
}

fn attribution_of(metadata: Option<&PValue>) -> Option<Attribution> {
    let text = |key: &str| {
        metadata
            .and_then(|metadata| match metadata {
                PValue::Object(object) => object_get(object, key),
                _ => None,
            })
            .and_then(|value| match value {
                PValue::String(text) => Some(text),
                _ => None,
            })
            .filter(|value| !trim(value).is_empty() && value.len() <= 256)
            .cloned()
    };
    let (thread_id, tool_call_id) = (text("threadId"), text("toolCallId"));
    if thread_id.is_none() && tool_call_id.is_none() {
        return None;
    }
    Some(Attribution {
        thread_id,
        tool_call_id,
    })
}

struct StdioChunk {
    seq: u64,
    stream: OutputStream,
    bytes: Vec<u8>,
}
pub(super) struct ProcState {
    active: Option<Arc<ActiveScope>>,
    recording: Option<Arc<dyn ProcessRecording>>,
    pid: Option<u32>,
    stdin: Option<Arc<tokio::sync::Mutex<Option<tokio::process::ChildStdin>>>>,
    spawned: bool,
    accepted: VecDeque<(LosslessString, String)>,
    chunks: VecDeque<StdioChunk>,
    retained_bytes: usize,
    next_seq: u64,
    exited: bool,
    exit_code: Option<i64>,
    closed: bool,
    termination_requested: bool,
    pending_interrupt: bool,
    stdout_ended: bool,
    stderr_ended: bool,
    sandbox_denied: bool,
    exited_notified: bool,
    closed_notified: bool,
    timeout_task: Option<tokio::task::JoinHandle<()>>,
    kill_task: Option<tokio::task::JoinHandle<()>>,
    grant: Option<Grant>,
    network_proxy: Option<Arc<NetworkProxyHandle>>,
    network_shutdown: Option<Signal>,
    snapshot: Option<ShellSnapshotLaunch>,
    library: Option<Arc<LibraryLease>>,
    release_failed: bool,
    done_resolved: bool,
}
pub(super) struct ProcEntry {
    process_id: LosslessString,
    session_id: String,
    state: Mutex<ProcState>,
    changed: Notify,
    done: watch::Sender<bool>,
}

type ScopeInitialization = Arc<tokio::sync::OnceCell<Result<Arc<ActiveScope>, ExecutorError>>>;

pub(super) struct Inner {
    pub(super) options: ExecutorOptions,
    pub(super) closed: AtomicBool,
    notifiers: Mutex<HashMap<String, mpsc::UnboundedSender<(String, PValue)>>>,
    callers: Mutex<HashMap<String, SessionCall>>,
    pub(super) processes: Mutex<HashMap<LosslessString, Arc<ProcEntry>>>,
    shell_snapshots: ShellSnapshotCache,
    credential_brokers: Arc<Mutex<CredentialBrokerCache>>,
    library_bridge: LibraryBridge,
    scopes: tokio::sync::Mutex<HashMap<LosslessString, ScopeInitialization>>,
    scope_list: Mutex<Vec<Arc<ActiveScope>>>,
    bindings: Mutex<HashMap<String, Option<LosslessString>>>,
    scope_ids: AtomicU64,
    scopes_released: AtomicBool,
    release_failure_recorded: AtomicBool,
    pub(super) environment: EnvironmentInfo,
    timeout_ms: u64,
    max_buffered_bytes: usize,
    max_live_processes: usize,
}

#[derive(Clone)]
pub struct Executor(pub(super) Arc<Inner>);

impl Executor {
    pub fn new(options: ExecutorOptions) -> Self {
        let environment = build_environment_info(&options);
        Self::from_environment(options, environment)
    }

    fn from_environment(options: ExecutorOptions, environment: EnvironmentInfo) -> Self {
        let timeout_ms = options
            .process_timeout_ms
            .filter(|value| *value > 0)
            .map_or(600_000, |value| value.min(3_600_000));
        let max_buffered_bytes = options
            .max_buffered_bytes_per_process
            .unwrap_or(1024 * 1024);
        let max_live_processes = options
            .max_live_processes
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_MAX_LIVE_PROCESSES);
        let platform = Platform::current();
        let snapshot_slot: Arc<Mutex<Option<std::sync::Weak<Inner>>>> = Arc::new(Mutex::new(None));
        let authorize_slot = snapshot_slot.clone();
        let snapshot_authorize: AuthorizeFn = Arc::new(move |input: AuthorizationInput| {
            let inner = authorize_slot
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_ref()
                .and_then(std::sync::Weak::upgrade);
            Box::pin(async move {
                let Some(inner) = inner else {
                    return Err(AuthorizationDenied::default());
                };
                let process_id = input
                    .metadata
                    .as_ref()
                    .and_then(|metadata| object_get(metadata, "processId"))
                    .and_then(|value| match value {
                        PValue::String(text) => Some(text),
                        _ => None,
                    });
                let active = process_id.and_then(|process_id| {
                    inner
                        .processes
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .get(process_id)
                        .and_then(|entry| {
                            entry
                                .state
                                .lock()
                                .unwrap_or_else(|error| error.into_inner())
                                .active
                                .clone()
                        })
                });
                match active {
                    Some(active) => active.authorize(input).await,
                    None => Err(AuthorizationDenied::default()),
                }
            })
        });
        let inner = Arc::new(Inner {
            closed: AtomicBool::new(false),
            notifiers: Mutex::new(HashMap::new()),
            callers: Mutex::new(HashMap::new()),
            processes: Mutex::new(HashMap::new()),
            shell_snapshots: ShellSnapshotCache::new(snapshot_authorize, platform, None),
            credential_brokers: Arc::new(Mutex::new(CredentialBrokerCache::new())),
            library_bridge: LibraryBridge::new(),
            scopes: tokio::sync::Mutex::new(HashMap::new()),
            scope_list: Mutex::new(vec![]),
            bindings: Mutex::new(HashMap::new()),
            scope_ids: AtomicU64::new(0),
            scopes_released: AtomicBool::new(false),
            release_failure_recorded: AtomicBool::new(false),
            environment,
            timeout_ms,
            max_buffered_bytes,
            max_live_processes,
            options,
        });
        *snapshot_slot
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(Arc::downgrade(&inner));
        Self(inner)
    }

    pub fn new_prepared(
        mut options: ExecutorOptions,
        prepared: &PreparedExecutor,
    ) -> Result<Self, ExecutorError> {
        if options.home_directory != prepared.home_directory {
            return Err(ExecutorError::invalid_params("home directory mismatch"));
        }
        if options.data_directory != prepared.data_directory {
            return Err(ExecutorError::invalid_params("data directory mismatch"));
        }
        if options.environment != prepared.environment {
            return Err(ExecutorError::invalid_params(
                "environment overrides mismatch",
            ));
        }
        if options.network_proxy_ca_directory.as_deref()
            != Some(prepared.network_proxy_ca_directory.as_path())
        {
            return Err(ExecutorError::invalid_params(
                "network proxy CA directory mismatch",
            ));
        }
        if options.network_proxy_upstream_trust.is_some() {
            return Err(ExecutorError::invalid_params(
                "separately supplied network proxy upstream trust is not permitted with prepared executor",
            ));
        }
        options.network_proxy_upstream_trust = Some(prepared.upstream_trust.clone());
        Ok(Self::from_environment(
            options,
            prepared.environment_info.clone(),
        ))
    }

    pub fn environment_info(&self) -> EnvironmentInfo {
        self.0.environment.clone()
    }
    pub fn upstream_trust(&self) -> Option<&super::network_proxy::NetworkProxyUpstreamTrust> {
        self.0.options.network_proxy_upstream_trust.as_ref()
    }
    pub(super) fn check_not_closed(&self) -> Result<(), ExecutorError> {
        if self.0.closed.load(Ordering::Acquire) {
            Err(ExecutorError::session_closed())
        } else {
            Ok(())
        }
    }

    pub async fn initialize(
        &self,
        _params: InitializeParams,
        ctx: InitializeContext,
    ) -> Result<InitializeResult, ExecutorError> {
        self.check_not_closed()?;
        let session_id = self
            .0
            .options
            .session_id
            .as_ref()
            .map_or_else(uuid_v4, |generate| generate());
        if let Some(notify) = ctx.notify {
            let (sender, mut receiver) = mpsc::unbounded_channel::<(String, PValue)>();
            tokio::spawn(async move {
                while let Some((method, params)) = receiver.recv().await {
                    notify(method, params).await;
                }
            });
            self.0
                .notifiers
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(session_id.clone(), sender);
        }
        if let Some(call) = ctx.call {
            self.0
                .callers
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(session_id.clone(), call);
        }
        Ok(InitializeResult { session_id })
    }

    fn process_event(
        &self,
        session_id: &str,
        method: &str,
        process_id: &LosslessString,
        fields: Vec<(&str, PValue)>,
    ) {
        let mut object = JsonObject::new();
        object.insert(
            LosslessString::from("processId"),
            PValue::String(process_id.clone()),
        );
        for (key, value) in fields {
            object.insert(LosslessString::from(key), value);
        }
        self.emit(session_id, method, PValue::Object(object));
    }
    fn emit(&self, session_id: &str, method: &str, params: PValue) {
        if let Some(sender) = self
            .0
            .notifiers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(session_id)
        {
            let _ = sender.send((method.to_owned(), params));
        }
    }
    fn session_call(&self, session_id: &str) -> SessionCall {
        let inner = self.0.clone();
        let session_id = session_id.to_owned();
        Arc::new(move |method, params, options| {
            let call = inner
                .callers
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .get(&session_id)
                .cloned();
            Box::pin(async move {
                match call {
                    Some(call) => call(method, params, options).await,
                    None => Err(ExecutorError::new(-32603, "Connection closed")),
                }
            })
        })
    }

    fn activate(&self, scope: Arc<dyn ExecutorScope>) -> Result<Arc<ActiveScope>, ExecutorError> {
        if scope.roots().is_empty() {
            return Err(ExecutorError::new(
                -32602,
                "at least one containing root is required",
            ));
        }
        let outside = if scope.authorization().defers() {
            vec![policy::root_of(
                &std::env::current_dir()
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_else(|_| "/".to_owned()),
            )]
        } else {
            vec![]
        };
        let active = Arc::new(ActiveScope {
            id: self.0.scope_ids.fetch_add(1, Ordering::AcqRel) + 1,
            scope,
            outside,
        });
        self.0
            .scope_list
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(active.clone());
        Ok(active)
    }

    pub(super) async fn resolve_scope(
        &self,
        attribution: Option<Attribution>,
        context: ScopeContext,
    ) -> Result<Arc<ActiveScope>, ExecutorError> {
        let thread_id = attribution
            .as_ref()
            .and_then(|attribution| attribution.thread_id.clone());
        let key = thread_id.clone().unwrap_or_default();
        if self.0.scopes_released.load(Ordering::Acquire) {
            return Err(ExecutorError::new(-32603, "Executor session closed"));
        }
        let cell = {
            let mut scopes = self.0.scopes.lock().await;
            scopes
                .entry(key.clone())
                .or_insert_with(|| Arc::new(tokio::sync::OnceCell::new()))
                .clone()
        };
        let executor = self.clone();
        let provided = thread_id.map(|_| attribution.clone()).unwrap_or(None);
        let result = cell
            .get_or_init(|| async move {
                let scope = executor
                    .0
                    .options
                    .scope_provider
                    .scope_for(provided, context)
                    .await
                    .map_err(|_| ExecutorError::new(-32603, "Executor scope unavailable"))?;
                if executor.0.scopes_released.load(Ordering::Acquire) {
                    let _ = scope.close().await;
                    return Err(ExecutorError::new(-32603, "Executor session closed"));
                }
                executor.activate(scope)
            })
            .await
            .clone();
        if result.is_err() {
            let mut scopes = self.0.scopes.lock().await;
            if scopes
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, &cell))
            {
                scopes.remove(&key);
            }
        }
        result
    }

    pub(super) async fn session_scope(
        &self,
        session_id: &str,
    ) -> Result<Arc<ActiveScope>, ExecutorError> {
        let thread_id = self
            .0
            .bindings
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(session_id)
            .cloned()
            .flatten();
        self.resolve_scope(
            thread_id.map(|thread_id| Attribution {
                thread_id: Some(thread_id),
                tool_call_id: None,
            }),
            ScopeContext {
                session_id: session_id.to_owned(),
                cwd: None,
            },
        )
        .await
    }
    fn bind(&self, session_id: &str, thread_id: Option<&LosslessString>) {
        let Some(thread_id) = thread_id else { return };
        let mut bindings = self
            .0
            .bindings
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match bindings.get(session_id) {
            None => {
                bindings.insert(session_id.to_owned(), Some(thread_id.to_owned()));
            }
            Some(existing) if existing.as_ref() != Some(thread_id) => {
                bindings.insert(session_id.to_owned(), None);
            }
            _ => {}
        }
    }

    fn entry(&self, process_id: &LosslessString) -> Option<Arc<ProcEntry>> {
        self.0
            .processes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(process_id)
            .cloned()
    }
    fn lock<'a>(entry: &'a ProcEntry) -> std::sync::MutexGuard<'a, ProcState> {
        entry
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
    fn finish_entry(entry: &ProcEntry) {
        let mut state = Self::lock(entry);
        if state.done_resolved {
            return;
        }
        state.done_resolved = true;
        drop(state);
        let _ = entry.done.send_replace(true);
    }
    fn prune_exited(&self) {
        let mut processes = self
            .0
            .processes
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if processes.len() <= MAX_RETAINED_EXITED_PROCESSES {
            return;
        }
        let removable = processes
            .iter()
            .filter(|(_, entry)| {
                let state = Self::lock(entry);
                state.closed && state.done_resolved
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in removable {
            processes.remove(&id);
            if processes.len() <= MAX_RETAINED_EXITED_PROCESSES {
                break;
            }
        }
    }
    fn clear_timers(entry: &ProcEntry) {
        let mut state = Self::lock(entry);
        if let Some(task) = state.timeout_task.take() {
            task.abort();
        }
        if let Some(task) = state.kill_task.take() {
            task.abort();
        }
    }
    fn terminate_graceful(&self, entry: &Arc<ProcEntry>) {
        let mut state = Self::lock(entry);
        let Some(pid) = state.pid else { return };
        if state.exited {
            return;
        }
        kill_group(pid, Kill::Term);
        if state.kill_task.is_some() {
            return;
        }
        let watched = entry.clone();
        state.kill_task = Some(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let mut state = Executor::lock(&watched);
            state.kill_task = None;
            if let Some(pid) = state.pid
                && !state.exited
            {
                kill_group(pid, Kill::Force);
            }
        }));
    }
    async fn settle_grant(&self, entry: &ProcEntry) {
        let grant = Self::lock(entry).grant.take();
        if let Some(grant) = grant
            && grant.release().await.is_err()
        {
            Self::lock(entry).release_failed = true;
            self.0
                .release_failure_recorded
                .store(true, Ordering::Release);
        }
    }
    async fn release_network(&self, entry: &ProcEntry) {
        let (shutdown, proxy, library) = {
            let mut state = Self::lock(entry);
            (
                state.network_shutdown.take(),
                state.network_proxy.take(),
                state.library.take(),
            )
        };
        if let Some(shutdown) = shutdown {
            shutdown.cancel();
        }
        if let Some(library) = library
            && library.close().await.is_err()
        {
            Self::lock(entry).release_failed = true;
        }
        if let Some(proxy) = proxy {
            proxy.close().await;
        }
    }
    fn release_snapshot(entry: &ProcEntry) {
        if let Some(mut snapshot) = Self::lock(entry).snapshot.take() {
            snapshot.release();
        }
    }
    async fn release_library(&self, entry: &ProcEntry) {
        let library = Self::lock(entry).library.clone();
        if let Some(library) = library
            && library.close().await.is_err()
        {
            Self::lock(entry).release_failed = true;
        }
    }

    fn maybe_emit_exited(&self, entry: &Arc<ProcEntry>) {
        let (seq, exit_code) = {
            let mut state = Self::lock(entry);
            if !state.spawned
                || !state.exited
                || state.exited_notified
                || !state.stdout_ended
                || !state.stderr_ended
            {
                return;
            }
            state.exited_notified = true;
            let seq = state.next_seq;
            state.next_seq += 1;
            (seq, state.exit_code)
        };
        self.process_event(
            &entry.session_id,
            "process/exited",
            &entry.process_id,
            vec![
                ("seq", PValue::Number(seq as f64)),
                (
                    "exitCode",
                    exit_code.map_or(PValue::Null, |code| PValue::Number(code as f64)),
                ),
                ("sandboxDenied", PValue::Bool(false)),
            ],
        );
        let executor = self.clone();
        let entry = entry.clone();
        tokio::spawn(async move { executor.settle_grant(&entry).await });
    }

    fn on_data(&self, entry: &Arc<ProcEntry>, stream: OutputStream, raw: &[u8], settled: bool) {
        let library = Self::lock(entry).library.clone();
        let data = match library {
            Some(lease) => lease.redact_output(stream == OutputStream::Stderr, raw, settled),
            None => raw.to_vec(),
        };
        let mut emitted = vec![];
        {
            let mut state = Self::lock(entry);
            for slice in data.chunks(CHUNK_SPLIT_SIZE) {
                let seq = state.next_seq;
                state.next_seq += 1;
                state.chunks.push_back(StdioChunk {
                    seq,
                    stream,
                    bytes: slice.to_vec(),
                });
                state.retained_bytes += slice.len();
                if let (Some(recording), true) = (state.recording.clone(), true) {
                    recording.output(slice);
                }
                while state.retained_bytes > self.0.max_buffered_bytes && !state.chunks.is_empty() {
                    let dropped = state.chunks.pop_front().expect("chunk present");
                    state.retained_bytes -= dropped.bytes.len();
                }
                emitted.push((seq, slice.to_vec()));
            }
        }
        for (seq, bytes) in emitted {
            self.process_event(
                &entry.session_id,
                "process/output",
                &entry.process_id,
                vec![
                    ("seq", PValue::Number(seq as f64)),
                    (
                        "stream",
                        PValue::String(LosslessString::from(stream.as_str())),
                    ),
                    (
                        "chunk",
                        PValue::String(LosslessString::from(base64_encode(&bytes))),
                    ),
                ],
            );
        }
        entry.changed.notify_waiters();
    }

    pub async fn start_authenticated_process(
        &self,
        params: ExecParams,
        ctx: &HandlerContext,
        configuration: &Configuration,
        environment_id: &str,
        harness_key_sha256: &str,
    ) -> Result<ExecResult, ExecutorError> {
        self.check_not_closed()?;
        let (source, binding) = configuration.native_dots_full_access_executor().map_err(|error| {
            let source = error.source_path().and_then(Path::file_name).and_then(|name| name.to_str()).unwrap_or("ycoding.json or ycoding.jsonc");
            ExecutorError::new(-32001, format!("Cannot read the full-access grant: check dots.fullAccessExecutor in trusted global {source}"))
        })?;
        let source = source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("ycoding.json or ycoding.jsonc");
        let binding = binding.ok_or_else(|| ExecutorError::new(-32001, format!("Full access is not configured: set dots.fullAccessExecutor in trusted global {source}")))?;
        if binding.environment_id != environment_id {
            return Err(ExecutorError::new(
                -32001,
                format!(
                    "Authenticated environment does not match dots.fullAccessExecutor.environmentId in trusted global {source}"
                ),
            ));
        }
        if binding.harness_key_sha256 != harness_key_sha256 {
            return Err(ExecutorError::new(
                -32001,
                format!(
                    "Authenticated harness key does not match dots.fullAccessExecutor.harnessKeySha256 in trusted global {source}"
                ),
            ));
        }
        if policy::process_requires_sandbox(params.sandbox.as_ref()).map_err(map_policy_error)? {
            return Err(ExecutorError::new(
                -32001,
                "The requested sandbox or network restrictions are incompatible with full access; use an unrestricted profile",
            ));
        }
        let managed_network = params
            .managed_network
            .as_ref()
            .filter(|value| !matches!(value, PValue::Null));
        if let Some(network) = managed_network {
            policy::read_managed_network(network).map_err(map_policy_error)?;
        }
        if params.enforce_managed_network == Some(true)
            || managed_network.is_some()
            || params.network_proxy.is_some()
        {
            return Err(ExecutorError::new(
                -32001,
                "The requested managed network or proxy is incompatible with full access; use an unrestricted network profile",
            ));
        }
        require_full_access(&EnvironmentConfigOptions {
            system_requirements_path: self.0.options.system_requirements_path.clone(),
            managed_config_path: self.0.options.managed_config_path.clone(),
            ..EnvironmentConfigOptions::default()
        })
        .await?;
        self.start_process(params, ctx).await
    }

    pub async fn start_process(
        &self,
        params: ExecParams,
        ctx: &HandlerContext,
    ) -> Result<ExecResult, ExecutorError> {
        refusing(self.start_process_in(params, ctx)).await
    }

    async fn start_process_in(
        &self,
        public: ExecParams,
        ctx: &HandlerContext,
    ) -> Result<ExecResult, ExecutorError> {
        self.check_not_closed()?;
        if public.tty {
            return Err(ExecutorError::new(-32602, "tty is unsupported"));
        }
        let params = public.clone();
        assert_argv(&params.argv).map_err(map_policy_error)?;
        let (done, _) = watch::channel(false);
        let entry = Arc::new(ProcEntry {
            process_id: params.process_id.clone(),
            session_id: ctx.session_id.clone(),
            state: Mutex::new(ProcState {
                active: None,
                recording: None,
                pid: None,
                stdin: None,
                spawned: false,
                accepted: VecDeque::new(),
                chunks: VecDeque::new(),
                retained_bytes: 0,
                next_seq: 1,
                exited: false,
                exit_code: None,
                closed: false,
                termination_requested: false,
                pending_interrupt: false,
                stdout_ended: false,
                stderr_ended: false,
                sandbox_denied: false,
                exited_notified: false,
                closed_notified: false,
                timeout_task: None,
                kill_task: None,
                grant: None,
                network_proxy: None,
                network_shutdown: None,
                snapshot: None,
                library: None,
                release_failed: false,
                done_resolved: false,
            }),
            changed: Notify::new(),
            done,
        });
        {
            let mut processes = self
                .0
                .processes
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if let Some(existing) = processes.get(&params.process_id) {
                let state = Self::lock(existing);
                if !state.closed && !state.exited {
                    return Err(ExecutorError::new(
                        -32600,
                        concat(&[
                            &"process ".into(),
                            &params.process_id,
                            &" already exists".into(),
                        ]),
                    ));
                }
            }
            let live = processes
                .values()
                .filter(|candidate| {
                    let state = Self::lock(candidate);
                    !state.exited && !state.closed
                })
                .count();
            if live >= self.0.max_live_processes {
                return Err(ExecutorError::new(-32602, "Too many processes"));
            }
            processes.insert(params.process_id.clone(), entry.clone());
        }
        let attribution = attribution_of(params.metadata.as_ref());
        self.bind(
            &ctx.session_id,
            attribution
                .as_ref()
                .and_then(|attribution| attribution.thread_id.as_ref()),
        );
        let refusal_cwd = Arc::new(Mutex::new(String::new()));
        match self
            .start_body(
                &params,
                &public,
                ctx,
                &entry,
                attribution.clone(),
                refusal_cwd.clone(),
            )
            .await
        {
            Ok(result) => Ok(result),
            Err(error) => {
                let refusal = error.refusal.clone().or_else(slot_text);
                let alive = !self.0.closed.load(Ordering::Acquire)
                    && self
                        .entry(&params.process_id)
                        .is_some_and(|current| Arc::ptr_eq(&current, &entry));
                if let (Some(text), true) = (refusal, alive && !Self::lock(&entry).spawned) {
                    Self::clear_timers(&entry);
                    Self::release_snapshot(&entry);
                    self.release_network(&entry).await;
                    let cwd = refusal_cwd
                        .lock()
                        .unwrap_or_else(|inner| inner.into_inner())
                        .clone();
                    if Self::lock(&entry).recording.is_none() {
                        self.start_recording(&entry, &params, attribution.as_ref(), &cwd);
                    }
                    return self.complete_without_spawn(
                        &entry,
                        &params,
                        vec![(
                            OutputStream::Stderr,
                            os_text(&concat(&[&text, &"\n".into()])).into_bytes(),
                        )],
                        1,
                        false,
                    );
                }
                let recording = Self::lock(&entry).recording.clone();
                if let Some(recording) = recording {
                    recording.ended(None, false);
                }
                Self::clear_timers(&entry);
                Self::release_snapshot(&entry);
                self.release_network(&entry).await;
                self.settle_grant(&entry).await;
                Self::finish_entry(&entry);
                {
                    let mut processes = self
                        .0
                        .processes
                        .lock()
                        .unwrap_or_else(|inner| inner.into_inner());
                    if processes
                        .get(&params.process_id)
                        .is_some_and(|current| Arc::ptr_eq(current, &entry))
                    {
                        processes.remove(&params.process_id);
                    }
                }
                entry.changed.notify_waiters();
                Err(error)
            }
        }
    }

    fn start_recording(
        &self,
        entry: &Arc<ProcEntry>,
        params: &ExecParams,
        attribution: Option<&Attribution>,
        cwd: &str,
    ) {
        let active = Self::lock(entry).active.clone();
        let Some(active) = active else { return };
        let command = shell_wrapper_script(&params.argv)
            .cloned()
            .unwrap_or_else(|| join_units(&params.argv, " "));
        let mut recording = None;
        active.record(|recorder| {
            recording = Some(recorder.process(ProcessRecord {
                process_id: params.process_id.clone(),
                command,
                shell: basename(&params.argv.first().map(os_text).unwrap_or_default()),
                cwd: cwd.to_owned(),
                thread_id: attribution.and_then(|attribution| attribution.thread_id.clone()),
                tool_call_id: attribution.and_then(|attribution| attribution.tool_call_id.clone()),
            }));
        });
        Self::lock(entry).recording = recording;
    }

    fn complete_without_spawn(
        &self,
        entry: &Arc<ProcEntry>,
        params: &ExecParams,
        outputs: Vec<(OutputStream, Vec<u8>)>,
        exit_code: i64,
        sandbox_denied: bool,
    ) -> Result<ExecResult, ExecutorError> {
        let current = self
            .entry(&params.process_id)
            .is_some_and(|current| Arc::ptr_eq(&current, entry));
        if self.0.closed.load(Ordering::Acquire) || !current {
            return Err(ExecutorError::session_closed());
        }
        let mut chunks: Vec<StdioChunk> = vec![];
        for (stream, data) in &outputs {
            for slice in data.chunks(CHUNK_SPLIT_SIZE) {
                chunks.push(StdioChunk {
                    seq: chunks.len() as u64 + 1,
                    stream: *stream,
                    bytes: slice.to_vec(),
                });
            }
        }
        let exited_seq = chunks.len() as u64 + 1;
        let emitted = chunks
            .iter()
            .map(|chunk| (chunk.seq, chunk.stream, chunk.bytes.clone()))
            .collect::<Vec<_>>();
        {
            let mut state = Self::lock(entry);
            state.retained_bytes = chunks.iter().map(|chunk| chunk.bytes.len()).sum();
            state.chunks = chunks.into();
            while state.retained_bytes > self.0.max_buffered_bytes && !state.chunks.is_empty() {
                let dropped = state.chunks.pop_front().expect("chunk present");
                state.retained_bytes -= dropped.bytes.len();
            }
            state.next_seq = exited_seq + 2;
            state.exited = true;
            state.exit_code = Some(exit_code);
            state.closed = true;
            state.stdout_ended = true;
            state.stderr_ended = true;
            state.sandbox_denied = sandbox_denied;
            state.exited_notified = true;
            state.closed_notified = true;
            if let Some(recording) = state.recording.clone() {
                for (_, _, bytes) in &emitted {
                    recording.output(bytes);
                }
                recording.ended(Some(exit_code), sandbox_denied);
            }
        }
        let executor = self.clone();
        let settle = entry.clone();
        tokio::spawn(async move { executor.settle_grant(&settle).await });
        Self::finish_entry(entry);
        entry.changed.notify_waiters();
        let executor = self.clone();
        let session_id = entry.session_id.clone();
        let process_id = params.process_id.clone();
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            for (seq, stream, bytes) in emitted {
                executor.process_event(
                    &session_id,
                    "process/output",
                    &process_id,
                    vec![
                        ("seq", PValue::Number(seq as f64)),
                        (
                            "stream",
                            PValue::String(LosslessString::from(stream.as_str())),
                        ),
                        (
                            "chunk",
                            PValue::String(LosslessString::from(base64_encode(&bytes))),
                        ),
                    ],
                );
            }
            executor.process_event(
                &session_id,
                "process/exited",
                &process_id,
                vec![
                    ("seq", PValue::Number(exited_seq as f64)),
                    ("exitCode", PValue::Number(exit_code as f64)),
                    ("sandboxDenied", PValue::Bool(sandbox_denied)),
                ],
            );
            executor.process_event(
                &session_id,
                "process/closed",
                &process_id,
                vec![("seq", PValue::Number((exited_seq + 1) as f64))],
            );
        });
        self.prune_exited();
        Ok(ExecResult {
            process_id: params.process_id.clone(),
            sandbox_type: Some(SandboxType::None),
        })
    }

    async fn start_body(
        &self,
        params: &ExecParams,
        public: &ExecParams,
        ctx: &HandlerContext,
        entry: &Arc<ProcEntry>,
        attribution: Option<Attribution>,
        refusal_cwd: Arc<Mutex<String>>,
    ) -> Result<ExecResult, ExecutorError> {
        let still_current = |executor: &Executor| {
            !executor.0.closed.load(Ordering::Acquire)
                && executor
                    .entry(&params.process_id)
                    .is_some_and(|current| Arc::ptr_eq(&current, entry))
        };
        let cwd_uri = os_text(&params.cwd);
        let native_cwd = parse_path_uri(&cwd_uri).map_err(map_policy_error)?;
        let sandbox_value = params.sandbox.clone();
        let managed_network = params.managed_network.clone();
        *refusal_cwd
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = native_cwd.clone();
        let sandbox = resolve_sandbox(
            &SandboxIntent {
                sandbox: sandbox_value.as_ref(),
                enforce_managed_network: params.enforce_managed_network == Some(true),
                managed_network: managed_network.as_ref(),
                network_proxy: None,
            },
            &ResolveSandboxOptions {
                cwd: Some(native_cwd.clone()),
                readable_policy_cwd: true,
                temporary_directories: default_temporary_directories(),
            },
        )
        .await
        .map_err(map_policy_error)?;
        let active = if attribution
            .as_ref()
            .and_then(|attribution| attribution.thread_id.as_ref())
            .is_none()
        {
            self.session_scope(&ctx.session_id).await?
        } else {
            self.resolve_scope(
                attribution.clone(),
                ScopeContext {
                    session_id: ctx.session_id.clone(),
                    cwd: Some(native_cwd.clone()),
                },
            )
            .await?
        };
        Self::lock(entry).active = Some(active.clone());
        let sandboxed = sandbox.as_ref().is_some_and(|sandbox| sandbox.sandboxed);
        let mut extra = sandbox_operation_roots(sandbox_value.as_ref());
        extra.extend(active.outside.clone());
        let resolved_cwd = match resolve_existing_path(
            &active.roots(),
            &cwd_uri,
            false,
            Missing::Start,
            &extra,
            None,
        )
        .await
        {
            Ok(resolved) => resolved,
            Err(error) if sandboxed && is_outside_roots(&error) => {
                return self.deny_as_sandbox(
                    entry,
                    params,
                    attribution.as_ref(),
                    &native_cwd,
                    "the working directory is outside the permitted roots",
                    still_current(self),
                );
            }
            Err(error) => return Err(error),
        };
        *refusal_cwd
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = resolved_cwd.clone();
        if sandbox.as_ref().is_some_and(|sandbox| {
            sandbox.sandboxed
                && !permits(
                    sandbox.access(&resolved_cwd, Some(&native_cwd)),
                    SandboxAccess::Read,
                )
        }) {
            return self.deny_as_sandbox(
                entry,
                params,
                attribution.as_ref(),
                &resolved_cwd,
                "the requested sandbox profile does not permit reading the working directory",
                still_current(self),
            );
        }
        let external = match authorize_external_directory(&active, &resolved_cwd).await {
            Ok(external) => external,
            Err(error) if sandboxed && error.code == -32001 => {
                return self.deny_as_sandbox(
                    entry,
                    params,
                    attribution.as_ref(),
                    &resolved_cwd,
                    "Permission denied: external directory access was not granted",
                    still_current(self),
                );
            }
            Err(error) => return Err(error),
        };
        let script = shell_wrapper_script(&params.argv);
        let command = script
            .cloned()
            .unwrap_or_else(|| join_units(&params.argv, " "));
        let mut metadata = JsonObject::new();
        metadata.insert("cwd".into(), PValue::String(resolved_cwd.clone().into()));
        metadata.insert(
            "workdir".into(),
            PValue::String(resolved_cwd.clone().into()),
        );
        if script.is_some() {
            metadata.insert(
                "argv".into(),
                PValue::String(
                    stringify_json(&PValue::Array(
                        params.argv.iter().cloned().map(PValue::String).collect(),
                    ))
                    .into(),
                ),
            );
        }
        match active.check("shell", vec![command], Some(metadata)).await {
            Ok(grant) => Self::lock(entry).grant = Some(Grant::combine(external, grant)),
            Err(error) => {
                if let Some(external) = external {
                    let _ = external.release().await;
                }
                if sandboxed && error.code == -32001 {
                    return self.deny_as_sandbox(
                        entry,
                        params,
                        attribution.as_ref(),
                        &resolved_cwd,
                        "Permission denied: shell access was not granted",
                        still_current(self),
                    );
                }
                return Err(error);
            }
        }
        if !still_current(self) {
            return Err(ExecutorError::session_closed());
        }
        self.start_recording(entry, params, attribution.as_ref(), &resolved_cwd);
        if let Some(answerer) = &self.0.options.answer_process {
            let answer = answerer
                .answer(
                    public,
                    AnswerContext {
                        attribution: attribution.clone(),
                        session_id: ctx.session_id.clone(),
                    },
                )
                .await?;
            if let Some(answer) = answer {
                let outputs = [
                    (OutputStream::Stdout, answer.stdout.into_bytes()),
                    (OutputStream::Stderr, answer.stderr.into_bytes()),
                ]
                .into_iter()
                .filter(|(_, data)| !data.is_empty())
                .collect();
                return self.complete_without_spawn(
                    entry,
                    params,
                    outputs,
                    answer.exit_code,
                    false,
                );
            }
        }
        if !still_current(self) {
            return Err(ExecutorError::session_closed());
        }
        let base_env: BTreeMap<String, String> = if params
            .env_policy
            .as_ref()
            .is_none_or(|value| matches!(value, PValue::Null))
        {
            let mut base = BTreeMap::new();
            base.insert("PATH".to_owned(), std::env::var("PATH").unwrap_or_default());
            base.insert(
                "HOME".to_owned(),
                self.0.options.home_directory.to_string_lossy().into_owned(),
            );
            base.insert(
                "TMPDIR".to_owned(),
                std::env::temp_dir().to_string_lossy().into_owned(),
            );
            base.extend(self.0.options.base_env.clone());
            base
        } else {
            let mut base: BTreeMap<String, String> = std::env::vars().collect();
            base.extend(self.0.options.base_env.clone());
            base
        };
        let mut child_env = build_process_env(&BuildProcessEnv {
            base: &base_env,
            env: &params.env,
            env_policy: params.env_policy.as_ref(),
            windows: cfg!(windows),
        })
        .map_err(map_policy_error)?;
        let (argv_selected, selected) = library_command(&params.argv)?;
        let channel = child_env
            .iter()
            .find(|(key, _)| uppercase(key).as_str() == Some("CODEX_APPS_MCP_URL"))
            .map(|(_, value)| value.clone());
        let private_library = selected
            || channel.as_ref().and_then(LosslessString::as_str)
                == Some(super::library::LIBRARY_PROCESS_URL);
        if channel.as_ref().is_some_and(|channel| {
            char::decode_utf16(channel.code_units())
                .map_while(Result::ok)
                .flat_map(char::to_lowercase)
                .take("ycoding-library:".len())
                .eq("ycoding-library:".chars())
        }) && channel.as_ref().and_then(LosslessString::as_str)
            != Some(super::library::LIBRARY_PROCESS_URL)
        {
            return Err(ExecutorError::new(
                -32602,
                "Unsupported private Library channel",
            ));
        }
        let library_factory = active.scope.library();
        if private_library {
            if library_factory.is_none() {
                return Err(ExecutorError::new(
                    -32603,
                    "Private Library channel unavailable",
                ));
            }
            child_env.retain(|(key, _)| {
                !library_reserved(key) || uppercase(key).as_str() == Some("NO_PROXY")
            });
        }
        let mut argv = argv_selected;
        let selected_script = if selected {
            shell_wrapper_script(&argv).cloned()
        } else {
            None
        };
        let library_aliases = selected_script.as_ref().map(|_| {
            let prefix = format!("__YCODING_LIBRARY_{}", uuid_v4().replace('-', ""));
            (
                format!("{prefix}_URL"),
                format!("{prefix}_AUTH"),
                format!("{prefix}_NO_PROXY"),
            )
        });
        if let (Some((url, authorization, no_proxy)), Some(script)) =
            (&library_aliases, &selected_script)
        {
            argv[2] = concat(&[&format!("set +x\nCODEX_APPS_MCP_URL=\"${{{url}:?}}\" CODEX_APPS_AUTHORIZATION=\"${{{authorization}:?}}\" NO_PROXY=\"${{{no_proxy}:?}}\" ").into(), script]);
        }
        if let Some(launch) = &params.network_proxy {
            let shutdown = Signal::default();
            Self::lock(entry).network_shutdown = Some(shutdown.clone());
            let hooks = self.0.options.network_policy.as_ref().map(|factory| {
                let executor = self.clone();
                let session_id = entry.session_id.clone();
                factory.hooks(NetworkPolicyInput {
                    process_id: params.process_id.clone(),
                    launch: launch.clone(),
                    call: self.session_call(&ctx.session_id),
                    notify: Arc::new(move |method, params| {
                        executor.emit(&session_id, &method, params)
                    }),
                    signal: shutdown.clone(),
                })
            });
            let hooks = hooks.unwrap_or_default();
            let authorize_scope = active.clone();
            let authorize: AuthorizeFn = Arc::new(move |input| {
                let active = authorize_scope.clone();
                Box::pin(async move { active.authorize(input).await })
            });
            let proxy = start_network_proxy(StartNetworkProxyOptions {
                process_id: params.process_id.clone(),
                launch: launch.clone(),
                env: child_env.clone(),
                authorize,
                decider: hooks.decider,
                on_policy_decision: hooks.on_policy_decision,
                ca_directory: self.0.options.network_proxy_ca_directory.clone(),
                upstream_trust: self.0.options.network_proxy_upstream_trust.clone(),
                credential_brokers: Some(self.0.credential_brokers.clone()),
                command: Some(NetworkProxyCommand {
                    argv: argv.clone(),
                    arg0: params.arg0.clone(),
                    shell_snapshot_shell_name: params
                        .shell_snapshot
                        .as_ref()
                        .map(|request| (request.shell.name.clone(), request.shell.path.clone())),
                }),
                lookup: None,
                platform: Platform::current(),
            })
            .await?;
            child_env = proxy.env.clone();
            Self::lock(entry).network_proxy = Some(Arc::new(proxy));
            if !still_current(self) {
                return Err(ExecutorError::session_closed());
            }
        }
        let mut snapshot: Option<ShellSnapshotLaunch> = None;
        if let Some(request) = &params.shell_snapshot {
            let credential_broker = {
                let state = Self::lock(entry);
                state
                    .network_proxy
                    .as_ref()
                    .and_then(|proxy| proxy.credential_broker.clone())
            };
            let prepared = self
                .0
                .shell_snapshots
                .prepare_with_broker(
                    PrepareInput {
                        session_id: ctx.session_id.clone(),
                        process_id: params.process_id.clone(),
                        request: request.clone(),
                        argv: argv.clone(),
                        arg0: params.arg0.clone(),
                        cwd: resolved_cwd.clone().into(),
                        env: child_env.clone(),
                        request_env: params.env.clone(),
                        env_policy: params
                            .env_policy
                            .clone()
                            .filter(|policy| !matches!(policy, PValue::Null)),
                        sandbox_key: params
                            .sandbox
                            .as_ref()
                            .filter(|sandbox| !matches!(sandbox, PValue::Null))
                            .map(stringify_json),
                    },
                    credential_broker,
                )
                .await
                .map_err(|error| ExecutorError::new(error.code, error.message))?;
            if let Some(launch) = prepared {
                argv = launch.argv.clone();
                child_env = launch.env.clone();
                snapshot = Some(launch);
            }
            if !still_current(self) {
                if let Some(mut launch) = snapshot {
                    launch.release();
                }
                return Err(ExecutorError::session_closed());
            }
        }
        let snapshot_fd = snapshot.as_mut().and_then(|launch| launch.fd.take());
        if let Some(launch) = snapshot {
            Self::lock(entry).snapshot = Some(ShellSnapshotLaunch {
                argv: launch.argv,
                env: launch.env,
                fd: None,
            });
        }
        if private_library && let Some(factory) = library_factory {
            let limited_network = params.enforce_managed_network == Some(true) || sandbox.as_ref().is_some_and(|sandbox| matches!(object_get(&sandbox.metadata, "sandboxNetwork"), Some(PValue::String(text)) if text.as_str() == Some("restricted")));
            let loopback_ports = managed_network
                .as_ref()
                .and_then(|network| field(network, "loopbackPorts"))
                .and_then(json_array)
                .cloned()
                .unwrap_or_default();
            if limited_network && loopback_ports.is_empty() {
                return Err(ExecutorError::new(
                    -32001,
                    "Private Library loopback channel is not permitted by this process network policy",
                ));
            }
            let read_active = active.clone();
            let read_cwd = resolved_cwd.clone();
            let read_sandbox = sandbox_value.clone();
            let read_entry = entry.clone();
            let read_executor = self.clone();
            let read_file: ReadFile = Arc::new(move |requested: String| {
                let (active, cwd, sandbox, entry, executor) = (
                    read_active.clone(),
                    read_cwd.clone(),
                    read_sandbox.clone(),
                    read_entry.clone(),
                    read_executor.clone(),
                );
                Box::pin(async move {
                    executor
                        .library_read(&active, &entry, &cwd, &sandbox, &requested)
                        .await
                })
            });
            let mut signals = vec![ctx.signal.clone()];
            signals.extend(active.scope.library_signal());
            let lease = self
                .0
                .library_bridge
                .open(
                    factory,
                    LibraryOpenInput {
                        process_id: params.process_id.clone(),
                        cwd: resolved_cwd.clone(),
                        read_file,
                    },
                    signals,
                )
                .await?;
            let endpoint = lease
                .env
                .get("CODEX_APPS_MCP_URL")
                .cloned()
                .unwrap_or_default();
            let parsed = url::Url::parse(&endpoint)
                .map_err(|_| ExecutorError::new(-32603, "Private Library channel unavailable"))?;
            let port = parsed.port().unwrap_or(0);
            if limited_network && !loopback_ports.iter().any(|candidate| matches!(candidate, PValue::Number(value) if *value == f64::from(port))) {
                    let _ = lease.close().await;
                    return Err(ExecutorError::new(-32001, "Private Library loopback channel is not permitted by this process network policy"));
                }
            let no_proxy = child_env
                .iter()
                .find(|(key, _)| uppercase(key).as_str() == Some("NO_PROXY"))
                .map(|(_, value)| value.clone());
            child_env.retain(|(key, _)| !library_reserved(key));
            for (key, value) in &lease.env {
                set_environment(&mut child_env, key, value.clone().into());
            }
            let host = format!("{}:{}", parsed.host_str().unwrap_or(""), port).into();
            let no_proxy = join_units(
                &no_proxy
                    .into_iter()
                    .chain(std::iter::once(host))
                    .collect::<Vec<_>>(),
                ",",
            );
            set_environment(&mut child_env, "NO_PROXY", no_proxy.clone());
            if let Some((url, authorization, no_proxy_alias)) = &library_aliases {
                set_environment(
                    &mut child_env,
                    url,
                    lease
                        .env
                        .get("CODEX_APPS_MCP_URL")
                        .cloned()
                        .unwrap_or_default()
                        .into(),
                );
                set_environment(
                    &mut child_env,
                    authorization,
                    lease
                        .env
                        .get("CODEX_APPS_AUTHORIZATION")
                        .cloned()
                        .unwrap_or_default()
                        .into(),
                );
                set_environment(&mut child_env, no_proxy_alias, no_proxy);
            }
            Self::lock(entry).library = Some(Arc::new(lease));
        }
        set_environment(
            &mut child_env,
            "YCODING_SESSION_ID",
            active.scope.session_id().into(),
        );
        let native_argv = argv.iter().map(os_text).collect::<Vec<_>>();
        let native_env = child_env
            .iter()
            .map(|(key, value)| (os_text(key), os_text(value)))
            .collect::<Vec<_>>();
        let mut command = tokio::process::Command::new(&native_argv[0]);
        command
            .args(&native_argv[1..])
            .current_dir(&resolved_cwd)
            .env_clear()
            .envs(native_env.iter().map(|(key, value)| (key, value)));
        #[cfg(unix)]
        {
            if let Some(arg0) = &params.arg0 {
                command.arg0(os_text(arg0));
            }
            command.process_group(0);
        }
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        command
            .stdin(if params.pipe_stdin {
                std::process::Stdio::piped()
            } else {
                std::process::Stdio::null()
            })
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(unix)]
        if let Some(fd) = &snapshot_fd {
            use std::os::fd::AsRawFd;
            let raw = fd.as_raw_fd();
            unsafe {
                command.pre_exec(move || {
                    if raw == super::shell_snapshot::SNAPSHOT_FD {
                        let flags = libc::fcntl(raw, libc::F_GETFD);
                        if flags == -1
                            || libc::fcntl(raw, libc::F_SETFD, flags & !libc::FD_CLOEXEC) == -1
                        {
                            return Err(io::Error::last_os_error());
                        }
                    } else if libc::dup2(raw, super::shell_snapshot::SNAPSHOT_FD) == -1 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        let mut child = command
            .spawn()
            .map_err(|_| ExecutorError::new(-32603, "Failed to start process"))?;
        drop(snapshot_fd);
        Self::release_snapshot(entry);
        let pid = child.id().unwrap_or(0);
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdin = child.stdin.take();
        {
            let mut state = Self::lock(entry);
            state.pid = Some(pid);
            state.spawned = true;
            state.stdin = Some(Arc::new(tokio::sync::Mutex::new(stdin)));
            if stdout.is_none() {
                state.stdout_ended = true;
            }
            if stderr.is_none() {
                state.stderr_ended = true;
            }
        }
        if self.0.timeout_ms > 0 {
            let watched = entry.clone();
            let executor = self.clone();
            let timeout = Duration::from_millis(self.0.timeout_ms);
            Self::lock(entry).timeout_task = Some(tokio::spawn(async move {
                tokio::time::sleep(timeout).await;
                executor.terminate_graceful(&watched);
            }));
        }
        self.supervise(entry.clone(), child, stdout, stderr);
        if !still_current(self) {
            kill_group(pid, Kill::Force);
            return Err(ExecutorError::session_closed());
        }
        let (terminate, interrupt) = {
            let mut state = Self::lock(entry);
            let interrupt = state.pending_interrupt && !state.termination_requested;
            if interrupt {
                state.pending_interrupt = false;
            }
            (state.termination_requested, interrupt)
        };
        if terminate {
            self.terminate_graceful(entry);
        } else if interrupt {
            kill_group(pid, Kill::Int);
        }
        self.prune_exited();
        Ok(ExecResult {
            process_id: params.process_id.clone(),
            sandbox_type: Some(SandboxType::None),
        })
    }

    fn deny_as_sandbox(
        &self,
        entry: &Arc<ProcEntry>,
        params: &ExecParams,
        attribution: Option<&Attribution>,
        cwd: &str,
        reason: &str,
        current: bool,
    ) -> Result<ExecResult, ExecutorError> {
        if !current {
            return Err(ExecutorError::session_closed());
        }
        self.start_recording(entry, params, attribution, cwd);
        self.complete_without_spawn(
            entry,
            params,
            vec![(
                OutputStream::Stderr,
                format!("sandbox denied: {reason}\n").into_bytes(),
            )],
            1,
            true,
        )
    }

    fn supervise(
        &self,
        entry: Arc<ProcEntry>,
        mut child: tokio::process::Child,
        stdout: Option<tokio::process::ChildStdout>,
        stderr: Option<tokio::process::ChildStderr>,
    ) {
        let executor = self.clone();
        async fn pump(
            executor: Executor,
            entry: Arc<ProcEntry>,
            stream: OutputStream,
            mut reader: impl tokio::io::AsyncRead + Unpin,
        ) {
            let mut buffer = vec![0u8; CHUNK_SPLIT_SIZE];
            loop {
                match reader.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(count) => executor.on_data(&entry, stream, &buffer[..count], false),
                }
            }
            executor.on_data(&entry, stream, &[], true);
            {
                let mut state = Executor::lock(&entry);
                match stream {
                    OutputStream::Stdout => state.stdout_ended = true,
                    OutputStream::Stderr => state.stderr_ended = true,
                    OutputStream::Pty => {
                        state.stdout_ended = true;
                        state.stderr_ended = true;
                    }
                }
            }
            executor.maybe_emit_exited(&entry);
        }
        tokio::spawn(async move {
            let out_task = stdout.map(|reader| {
                tokio::spawn(pump(
                    executor.clone(),
                    entry.clone(),
                    OutputStream::Stdout,
                    reader,
                ))
            });
            let err_task = stderr.map(|reader| {
                tokio::spawn(pump(
                    executor.clone(),
                    entry.clone(),
                    OutputStream::Stderr,
                    reader,
                ))
            });
            let status = child.wait().await;
            executor.release_library(&entry).await;
            let code: i64 = match &status {
                Ok(status) => match status.code() {
                    #[cfg(windows)]
                    Some(code) => code as u32 as i64,
                    #[cfg(not(windows))]
                    Some(code) => code as i64,
                    None => {
                        #[cfg(unix)]
                        {
                            use std::os::unix::process::ExitStatusExt;
                            status.signal().map_or(1, |signal| 128 + signal as i64)
                        }
                        #[cfg(not(unix))]
                        1
                    }
                },
                Err(_) => 1,
            };
            {
                let mut state = Executor::lock(&entry);
                state.exited = true;
                state.exit_code = Some(code);
            }
            Executor::clear_timers(&entry);
            executor.maybe_emit_exited(&entry);
            entry.changed.notify_waiters();
            executor.prune_exited();
            if let Some(task) = out_task {
                let _ = task.await;
            }
            if let Some(task) = err_task {
                let _ = task.await;
            }
            Executor::clear_timers(&entry);
            executor.release_network(&entry).await;
            let (recording, exit_code, close_seq) = {
                let mut state = Executor::lock(&entry);
                state.closed = true;
                state.stdout_ended = true;
                state.stderr_ended = true;
                let seq = if state.spawned && !state.closed_notified {
                    state.closed_notified = true;
                    let seq = state.next_seq;
                    state.next_seq += 1;
                    Some(seq)
                } else {
                    None
                };
                (state.recording.clone(), state.exit_code, seq)
            };
            executor.maybe_emit_exited(&entry);
            if let Some(recording) = recording {
                recording.ended(exit_code, false);
            }
            if let Some(seq) = close_seq {
                executor.process_event(
                    &entry.session_id,
                    "process/closed",
                    &entry.process_id,
                    vec![("seq", PValue::Number(seq as f64))],
                );
            }
            entry.changed.notify_waiters();
            executor.settle_grant(&entry).await;
            Executor::finish_entry(&entry);
        });
    }

    async fn library_read(
        &self,
        active: &Arc<ActiveScope>,
        entry: &Arc<ProcEntry>,
        cwd: &str,
        sandbox: &Option<PValue>,
        requested: &str,
    ) -> Result<(String, Vec<u8>), ExecutorError> {
        let unavailable = || ExecutorError::new(-32603, "Executor scope unavailable");
        {
            let state = Self::lock(entry);
            if self.0.closed.load(Ordering::Acquire) || state.exited || state.termination_requested
            {
                return Err(unavailable());
            }
        }
        let uri = to_path_uri(&resolve(cwd, requested))
            .map_err(|error| ExecutorError::new(-32602, error.message))?;
        let opened = authorize_fs_path(
            active,
            &uri,
            sandbox.as_ref(),
            false,
            "read",
            SandboxAccess::Read,
            true,
        )
        .await?;
        let resolved = opened.resolved.clone();
        run_with_grant(opened.grant, async {
            const LIMIT: u64 = 20 * 1024 * 1024;
            let path = resolved.clone();
            let outcome = tokio::task::spawn_blocking(
                move || -> io::Result<Option<(Vec<u8>, std::fs::Metadata)>> {
                    use std::io::Read;
                    let mut options = std::fs::OpenOptions::new();
                    options.read(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
                    }
                    let mut file = options.open(&path)?;
                    let before = file.metadata()?;
                    if !before.is_file() || before.len() > LIMIT {
                        return Ok(None);
                    }
                    let mut bytes = Vec::with_capacity(before.len() as usize + 1);
                    file.by_ref().take(LIMIT + 1).read_to_end(&mut bytes)?;
                    Ok(Some((bytes, before)))
                },
            )
            .await
            .map_err(|_| ExecutorError::internal())?
            .map_err(|error| map_fs_error(&error))?;
            let Some((bytes, before)) = outcome else {
                return Err(ExecutorError::new(
                    -32602,
                    "Library source must be a regular file within the upload limit",
                ));
            };
            let canonical = policy::real_path(&resolved)
                .await
                .map_err(|error| map_fs_error(&error))?;
            let after = tokio::fs::metadata(&canonical)
                .await
                .map_err(|error| map_fs_error(&error))?;
            let state = Self::lock(entry);
            let changed = bytes.len() as u64 != before.len()
                || before.len() != after.len()
                || before.modified().ok() != after.modified().ok()
                || canonical != resolved;
            if self.0.closed.load(Ordering::Acquire)
                || state.exited
                || state.termination_requested
                || changed
            {
                return Err(ExecutorError::new(
                    -32603,
                    "Library source changed during its authorized read",
                ));
            }
            drop(state);
            let length = bytes.len() as u64;
            active.record(|recorder| recorder.read(&canonical, length));
            Ok((canonical, bytes))
        })
        .await
    }

    async fn process_scope(
        &self,
        process_id: &LosslessString,
        session_id: &str,
    ) -> Result<Arc<ActiveScope>, ExecutorError> {
        if let Some(entry) = self.entry(process_id)
            && let Some(active) = Self::lock(&entry).active.clone()
        {
            return Ok(active);
        }
        self.session_scope(session_id).await
    }

    pub async fn read_process(
        &self,
        params: ReadParams,
        ctx: &HandlerContext,
    ) -> Result<ReadResult, ExecutorError> {
        self.check_not_closed()?;
        let active = self
            .process_scope(&params.process_id, &ctx.session_id)
            .await?;
        let grant = active
            .check("read", vec![params.process_id.clone()], None)
            .await?;
        run_with_grant(grant, async {
            let entry = self.entry(&params.process_id).ok_or_else(|| {
                ExecutorError::new(
                    -32600,
                    concat(&[&"unknown process id ".into(), &params.process_id]),
                )
            })?;
            let after_seq = params.after_seq.unwrap_or(0);
            let max_bytes = params.max_bytes.unwrap_or(u64::MAX);
            let wait = Duration::from_millis(params.wait_ms.unwrap_or(0).min(30_000));
            let filter = |state: &ProcState| -> (Vec<ProcessOutputChunk>, u64) {
                let mut result = vec![];
                let mut total = 0u64;
                let mut next = state.next_seq;
                for chunk in &state.chunks {
                    if chunk.seq > after_seq {
                        if !result.is_empty() && total + chunk.bytes.len() as u64 > max_bytes {
                            break;
                        }
                        total += chunk.bytes.len() as u64;
                        result.push(ProcessOutputChunk {
                            seq: chunk.seq,
                            stream: chunk.stream,
                            chunk: chunk.bytes.clone(),
                        });
                        next = chunk.seq + 1;
                        if total >= max_bytes {
                            break;
                        }
                    }
                }
                (
                    result,
                    if params.max_bytes.is_none() {
                        state.next_seq
                    } else {
                        next
                    },
                )
            };
            let (mut chunks, mut next_seq) = filter(&Self::lock(&entry));
            let waiting = chunks.is_empty()
                && !Self::lock(&entry).closed
                && !wait.is_zero()
                && !ctx.signal.is_cancelled();
            if waiting {
                let notified = entry.changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let (again, _) = filter(&Self::lock(&entry));
                if again.is_empty() {
                    tokio::select! {
                        _ = &mut notified => {}
                        _ = tokio::time::sleep(wait) => {}
                        _ = ctx.signal.cancelled() => {}
                    }
                }
                let (refreshed, refreshed_next) = filter(&Self::lock(&entry));
                chunks = refreshed;
                next_seq = refreshed_next;
            }
            let state = Self::lock(&entry);
            Ok(ReadResult {
                chunks,
                next_seq,
                exited: state.exited,
                exit_code: state.exit_code,
                closed: state.closed,
                failure: None,
                sandbox_denied: state.sandbox_denied,
            })
        })
        .await
    }

    pub async fn write_process(
        &self,
        params: WriteParams,
        ctx: &HandlerContext,
    ) -> Result<WriteStatus, ExecutorError> {
        self.check_not_closed()?;
        if params.chunk.len() > 16 * 1024 * 1024 {
            return Err(ExecutorError::new(-32602, "chunk exceeds max size"));
        }
        let full_text = String::from_utf8_lossy(&params.chunk).into_owned();
        let preview = full_text
            .chars()
            .take(200)
            .filter(|character| (*character as u32) >= 0x20 && *character as u32 != 0x7f)
            .collect::<String>();
        let mut metadata = JsonObject::new();
        metadata.insert("writeId".into(), PValue::String(params.write_id.clone()));
        metadata.insert(
            "bytes".into(),
            PValue::String(params.chunk.len().to_string().into()),
        );
        metadata.insert("preview".into(), PValue::String(preview.into()));
        let active = self
            .process_scope(&params.process_id, &ctx.session_id)
            .await?;
        let grant = active
            .check(
                "shell",
                vec![params.process_id.clone(), full_text.into()],
                Some(metadata),
            )
            .await?;
        run_with_grant(grant, async {
            let Some(entry) = self.entry(&params.process_id) else {
                return Ok(WriteStatus::UnknownProcess);
            };
            let (stdin, exited, spawned) = {
                let state = Self::lock(&entry);
                (state.stdin.clone(), state.exited, state.spawned)
            };
            if !spawned {
                return Ok(if exited {
                    WriteStatus::StdinClosed
                } else {
                    WriteStatus::Starting
                });
            }
            let hash = sha256_hex(&params.chunk);
            {
                let state = Self::lock(&entry);
                if let Some((_, existing)) =
                    state.accepted.iter().find(|(id, _)| *id == params.write_id)
                {
                    if *existing == hash {
                        return Ok(WriteStatus::Accepted);
                    }
                    return Err(ExecutorError::new(
                        -32602,
                        "writeId reused with different payload",
                    ));
                }
            }
            let Some(stdin) = stdin else {
                return Ok(WriteStatus::StdinClosed);
            };
            let mut guard = stdin.lock().await;
            let Some(writer) = guard.as_mut() else {
                return Ok(WriteStatus::StdinClosed);
            };
            if writer.write_all(&params.chunk).await.is_err() || writer.flush().await.is_err() {
                return Ok(WriteStatus::StdinClosed);
            }
            drop(guard);
            let mut state = Self::lock(&entry);
            state.accepted.push_back((params.write_id.clone(), hash));
            while state.accepted.len() > MAX_ACCEPTED_WRITE_IDS {
                state.accepted.pop_front();
            }
            Ok(WriteStatus::Accepted)
        })
        .await
    }

    pub async fn signal_process(
        &self,
        params: SignalParams,
        ctx: &HandlerContext,
    ) -> Result<(), ExecutorError> {
        self.check_not_closed()?;
        let active = self
            .process_scope(&params.process_id, &ctx.session_id)
            .await?;
        let grant = active
            .check("shell", vec![params.process_id.clone()], None)
            .await?;
        run_with_grant(grant, async {
            let Some(entry) = self.entry(&params.process_id) else {
                return Ok(());
            };
            self.release_library(&entry).await;
            let mut state = Self::lock(&entry);
            if state.exited {
                return Ok(());
            }
            match state.pid {
                None => state.pending_interrupt = true,
                Some(pid) => kill_group(pid, Kill::Int),
            }
            Ok(())
        })
        .await
    }

    pub async fn terminate_process(
        &self,
        params: TerminateParams,
        ctx: &HandlerContext,
    ) -> Result<TerminateResult, ExecutorError> {
        self.check_not_closed()?;
        let active = self
            .process_scope(&params.process_id, &ctx.session_id)
            .await?;
        let grant = active
            .check("shell", vec![params.process_id.clone()], None)
            .await?;
        run_with_grant(grant, async {
            let Some(entry) = self.entry(&params.process_id) else {
                return Ok(TerminateResult { running: false });
            };
            let running = {
                let mut state = Self::lock(&entry);
                if state.exited {
                    return Ok(TerminateResult { running: false });
                }
                let running = !state.termination_requested && !state.exited;
                state.termination_requested = true;
                running
            };
            if running {
                self.release_library(&entry).await;
                self.terminate_graceful(&entry);
            }
            Ok(TerminateResult { running })
        })
        .await
    }

    pub(crate) async fn file_contents(resolved: &str) -> Result<Vec<u8>, ExecutorError> {
        file_contents(resolved).await
    }
    pub(super) async fn path_metadata(resolved: &str) -> Result<FsMetadata, ExecutorError> {
        let stat = tokio::fs::metadata(resolved)
            .await
            .map_err(|error| map_fs_error(&error))?;
        let lstat = tokio::fs::symlink_metadata(resolved)
            .await
            .map_err(|error| map_fs_error(&error))?;
        let millis = |time: io::Result<std::time::SystemTime>| {
            time.ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |elapsed| (elapsed.as_secs_f64() * 1000.0).round() as i64)
        };
        Ok(FsMetadata {
            is_directory: stat.is_dir(),
            is_file: stat.is_file(),
            is_symlink: lstat.file_type().is_symlink(),
            size: stat.len(),
            created_at_ms: millis(stat.created().or_else(|_| stat.modified())),
            modified_at_ms: millis(stat.modified()),
        })
    }
    pub(super) async fn directory_entries(
        resolved: &str,
    ) -> Result<Vec<FsDirectoryEntry>, ExecutorError> {
        let mut reader = tokio::fs::read_dir(resolved)
            .await
            .map_err(|error| map_fs_error(&error))?;
        let mut entries = vec![];
        while let Some(entry) = reader
            .next_entry()
            .await
            .map_err(|error| map_fs_error(&error))?
        {
            if entries.len() >= MAX_FS_DIR_ENTRIES {
                break;
            }
            let kind = entry
                .file_type()
                .await
                .map_err(|error| map_fs_error(&error))?;
            entries.push(FsDirectoryEntry {
                file_name: entry.file_name().to_string_lossy().into_owned(),
                is_directory: kind.is_dir(),
                is_file: kind.is_file(),
            });
        }
        Ok(entries)
    }
    pub(super) async fn read_file_in(
        &self,
        active: &Arc<ActiveScope>,
        path: &str,
        sandbox: Option<&PValue>,
    ) -> Result<(String, Vec<u8>), ExecutorError> {
        let opened = authorize_fs_path(
            active,
            path,
            sandbox,
            false,
            "read",
            SandboxAccess::Read,
            true,
        )
        .await?;
        let resolved = opened.resolved.clone();
        let data = run_with_grant(opened.grant, Self::file_contents(&resolved)).await?;
        Ok((resolved, data))
    }

    pub async fn read_file(
        &self,
        params: FsReadFileParams,
        ctx: &HandlerContext,
    ) -> Result<Vec<u8>, ExecutorError> {
        self.check_not_closed()?;
        let sandbox = params.sandbox.clone();
        let active = self.session_scope(&ctx.session_id).await?;
        let (resolved, data) = self
            .read_file_in(&active, &params.path, sandbox.as_ref())
            .await?;
        let length = data.len() as u64;
        active.record(|recorder| recorder.read(&resolved, length));
        Ok(data)
    }

    pub(super) async fn previous_content(target: &str) -> Option<Vec<u8>> {
        match tokio::fs::metadata(target).await {
            Err(_) => Some(vec![]),
            Ok(metadata) if !metadata.is_file() || metadata.len() > CONTENT_CAPTURE_BYTES => None,
            Ok(_) => tokio::fs::read(target).await.ok(),
        }
    }

    pub async fn write_file(
        &self,
        params: FsWriteFileParams,
        ctx: &HandlerContext,
    ) -> Result<(), ExecutorError> {
        self.check_not_closed()?;
        let sandbox = params.sandbox.clone();
        let active = self.session_scope(&ctx.session_id).await?;
        let opened = authorize_fs_path(
            &active,
            &params.path,
            sandbox.as_ref(),
            true,
            "edit",
            SandboxAccess::Write,
            true,
        )
        .await?;
        let resolved = opened.resolved.clone();
        run_with_grant(opened.grant, async {
            let before = Self::previous_content(&resolved).await;
            if let Some(parent) = std::path::Path::new(&resolved).parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|error| map_fs_error(&error))?;
            }
            tokio::fs::write(&resolved, &params.data)
                .await
                .map_err(|error| map_fs_error(&error))?;
            let length = params.data.len() as u64;
            let after = (length <= CONTENT_CAPTURE_BYTES).then(|| params.data.clone());
            active.record(|recorder| {
                recorder.write(WriteRecord {
                    operation: WriteOperation::Write,
                    path: resolved.clone(),
                    destination: None,
                    bytes: Some(length),
                    before,
                    after,
                });
            });
            Ok(())
        })
        .await
    }

    pub async fn get_metadata(
        &self,
        params: FsPathParams,
        ctx: &HandlerContext,
    ) -> Result<FsMetadata, ExecutorError> {
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
            true,
        )
        .await?;
        let resolved = opened.resolved.clone();
        run_with_grant(opened.grant, Self::path_metadata(&resolved)).await
    }

    pub async fn read_directory(
        &self,
        params: FsPathParams,
        ctx: &HandlerContext,
    ) -> Result<Vec<FsDirectoryEntry>, ExecutorError> {
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
            true,
        )
        .await?;
        let resolved = opened.resolved.clone();
        run_with_grant(opened.grant, Self::directory_entries(&resolved)).await
    }

    pub async fn canonicalize(
        &self,
        params: FsPathParams,
        ctx: &HandlerContext,
    ) -> Result<String, ExecutorError> {
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
            true,
        )
        .await?;
        let resolved = opened.resolved.clone();
        run_with_grant(opened.grant, async {
            to_path_uri(&resolved).map_err(|error| ExecutorError::new(-32602, error.message))
        })
        .await
    }

    pub async fn create_directory(
        &self,
        path: &str,
        ctx: &HandlerContext,
    ) -> Result<CreateDirectoryResult, ExecutorError> {
        self.check_not_closed()?;
        let native = parse_path_uri(path).map_err(map_policy_error)?;
        let name = basename(&native);
        if name.is_empty() || name == "." || name == ".." {
            return Err(ExecutorError::new(-32602, "Invalid path"));
        }
        let active = self.session_scope(&ctx.session_id).await?;
        let parent_uri = to_path_uri(&dirname(&native))
            .map_err(|error| ExecutorError::new(-32602, error.message))?;
        let parent = resolve_fs_path(&active.roots(), &parent_uri, true, &active.outside).await?;
        let target = join(&parent, &[&name]);
        let external = authorize_external_directory(&active, &target).await?;
        let grant = match active
            .check("edit", vec![target.clone().into()], None)
            .await
        {
            Ok(grant) => Grant::combine(external, grant),
            Err(error) => {
                if let Some(external) = external {
                    let _ = external.release().await;
                }
                return Err(error);
            }
        };
        run_with_grant(grant, async {
            match tokio::fs::symlink_metadata(&target).await {
                Ok(_) => return Ok(CreateDirectoryResult::Existing),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(map_fs_error(&error)),
            }
            tokio::fs::create_dir_all(&parent)
                .await
                .map_err(|error| map_fs_error(&error))?;
            if let Err(error) = tokio::fs::create_dir(&target).await {
                if error.kind() == io::ErrorKind::AlreadyExists {
                    return Ok(CreateDirectoryResult::Existing);
                }
                return Err(map_fs_error(&error));
            }
            active.record(|recorder| {
                recorder.write(WriteRecord {
                    operation: WriteOperation::CreateDirectory,
                    path: target.clone(),
                    destination: None,
                    bytes: None,
                    before: None,
                    after: None,
                });
            });
            Ok(CreateDirectoryResult::Created {
                path: to_path_uri(&target)
                    .map_err(|error| ExecutorError::new(-32602, error.message))?,
            })
        })
        .await
    }

    pub async fn close(&self) -> Result<(), ExecutorError> {
        self.0.closed.store(true, Ordering::Release);
        self.0
            .notifiers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        self.0
            .callers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        let entries = self
            .0
            .processes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for entry in &entries {
            self.release_library(entry).await;
            let finish = {
                let mut state = Self::lock(entry);
                state.termination_requested = true;
                if let Some(pid) = state.pid
                    && !state.exited
                {
                    kill_group(pid, Kill::Force);
                }
                state.pid.is_none() && state.exited
            };
            Self::clear_timers(entry);
            entry.changed.notify_waiters();
            if finish {
                Self::finish_entry(entry);
            }
        }
        for entry in &entries {
            let mut receiver = entry.done.subscribe();
            while !*receiver.borrow() {
                if receiver.changed().await.is_err() {
                    break;
                }
            }
        }
        for entry in &entries {
            self.release_network(entry).await;
        }
        self.0.library_bridge.close().await;
        self.0.shell_snapshots.close().await;
        for entry in &entries {
            self.settle_grant(entry).await;
        }
        self.0
            .processes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        self.0.scopes_released.store(true, Ordering::Release);
        let opened = std::mem::take(
            &mut *self
                .0
                .scope_list
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        self.0.scopes.lock().await.clear();
        self.0
            .bindings
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        let mut scope_failed = false;
        for active in opened {
            if active.scope.close().await.is_err() {
                scope_failed = true;
            }
        }
        let release_failed = entries.iter().any(|entry| Self::lock(entry).release_failed);
        if self.0.release_failure_recorded.load(Ordering::Acquire) || release_failed || scope_failed
        {
            return Err(ExecutorError::internal());
        }
        Ok(())
    }
}

pub(crate) async fn file_contents(resolved: &str) -> Result<Vec<u8>, ExecutorError> {
    let metadata = tokio::fs::metadata(resolved)
        .await
        .map_err(|error| map_fs_error(&error))?;
    if !metadata.is_file() {
        return Err(ExecutorError::new(-32600, "Path is not a file"));
    }
    if metadata.len() > MAX_FS_READ_BYTES {
        return Err(ExecutorError::new(-32602, "file exceeds max read size"));
    }
    let data = tokio::fs::read(resolved)
        .await
        .map_err(|error| map_fs_error(&error))?;
    if data.len() as u64 > MAX_FS_READ_BYTES {
        return Err(ExecutorError::new(-32602, "file exceeds max read size"));
    }
    Ok(data)
}

fn build_environment_info_inner(
    home_directory: &Path,
    overrides: &EnvironmentOverrides,
    has_ca_directory: bool,
    captured_env: Option<&BTreeMap<String, String>>,
    captured_cwd: Option<&Path>,
    captured_temp_dir: &Path,
) -> EnvironmentInfo {
    let user_home = overrides
        .user_home_dir
        .clone()
        .unwrap_or_else(|| home_directory.to_string_lossy().into_owned());
    let shell_path = overrides
        .shell
        .as_ref()
        .map(|shell| shell.path.clone())
        .or_else(|| {
            if let Some(env) = captured_env {
                env.get("SHELL").cloned().map(LosslessString::from)
            } else {
                std::env::var("SHELL").ok().map(LosslessString::from)
            }
        })
        .unwrap_or_else(|| {
            if cfg!(windows) {
                "powershell.exe".into()
            } else {
                "/bin/sh".into()
            }
        });
    let default_name = {
        let name = basename(&os_text(&shell_path));
        name.strip_suffix(".exe").map(str::to_owned).unwrap_or(name)
    };
    let shell_name = overrides
        .shell
        .as_ref()
        .map(|shell| shell.name.clone())
        .unwrap_or_else(|| {
            if default_name.is_empty() {
                if cfg!(windows) {
                    "powershell".into()
                } else {
                    "sh".into()
                }
            } else {
                default_name.into()
            }
        });
    let temp_dir = overrides
        .temp_dir
        .clone()
        .or_else(|| {
            if let Some(env) = captured_env {
                if cfg!(windows) {
                    env.get("TEMP").or_else(|| env.get("TMP")).cloned()
                } else {
                    env.get("TMPDIR").cloned()
                }
            } else {
                None
            }
        })
        .unwrap_or_else(|| captured_temp_dir.to_string_lossy().into_owned());
    let platform = Platform::current();
    let network = network_proxy_capabilities(platform, &os_text(&shell_path));
    let prepend = overrides
        .prepend_path_dirs
        .iter()
        .filter(|directory| std::fs::metadata(directory).is_ok_and(|metadata| metadata.is_dir()))
        .filter_map(|directory| to_path_uri(directory).ok())
        .collect::<Vec<_>>();
    let cwd_path = captured_cwd
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| user_home.clone());
    EnvironmentInfo {
        shell: ShellInfo {
            name: shell_name,
            path: shell_path,
        },
        executor_version: Some(
            overrides
                .executor_version
                .clone()
                .unwrap_or_else(|| "0.0.0".to_owned()),
        ),
        provider_id: overrides.provider_id.clone(),
        cwd: to_path_uri(&cwd_path).ok(),
        user_home_dir: to_path_uri(&user_home).ok(),
        platform_os: Some(match platform {
            Platform::Darwin => "macos".to_owned(),
            Platform::Windows => "windows".to_owned(),
            Platform::Linux => "linux".to_owned(),
            Platform::Other => std::env::consts::OS.to_owned(),
        }),
        prepend_path_dirs: prepend,
        temporary_directories: path_uris(&default_temporary_directories()),
        temp_dir: to_path_uri(&temp_dir).ok(),
        capabilities: EnvironmentCapabilities {
            network_proxy_launch: Some(network.network_proxy_launch),
            network_proxy_review_domains: network.network_proxy_review_domains.then_some(true),
            credential_masking: (has_ca_directory && network.credential_masking).then_some(true),
            credential_masking_custom_providers: (has_ca_directory
                && network.credential_masking_custom_providers)
                .then_some(true),
            capability_discovery_sandbox: Some(true),
            capability_discovery_v2: Some(true),
            environment_config_read: Some(true),
            http_header_env_vars: Some(true),
            sandboxed_file_streaming: Some(true),
            file_write_streaming: Some(true),
            shell_snapshot_v2: Some(network.shell_snapshot_v2),
            windows_mxc: Some(false),
        },
    }
}

fn build_environment_info(options: &ExecutorOptions) -> EnvironmentInfo {
    let standard_temp = std::env::temp_dir();
    build_environment_info_inner(
        &options.home_directory,
        &options.environment,
        options.network_proxy_ca_directory.is_some(),
        None,
        None,
        &standard_temp,
    )
}

pub struct PrepareExecutorInput<'a> {
    pub home_directory: &'a Path,
    pub data_directory: &'a Path,
    pub network_proxy_ca_directory: &'a Path,
    pub startup_environment: &'a BTreeMap<String, String>,
}

#[derive(Clone)]
pub struct PreparedExecutor {
    home_directory: PathBuf,
    data_directory: PathBuf,
    environment: EnvironmentOverrides,
    network_proxy_ca_directory: PathBuf,
    environment_info: EnvironmentInfo,
    upstream_trust: super::network_proxy::NetworkProxyUpstreamTrust,
}

impl PreparedExecutor {
    pub fn environment_info(&self) -> EnvironmentInfo {
        self.environment_info.clone()
    }

    pub fn environment_overrides(&self) -> EnvironmentOverrides {
        self.environment.clone()
    }

    pub fn upstream_trust(&self) -> &super::network_proxy::NetworkProxyUpstreamTrust {
        &self.upstream_trust
    }
}

#[derive(Debug)]
pub enum PrepareExecutorError {
    Held {
        environment_info: Box<EnvironmentInfo>,
        prerequisite: &'static str,
    },
    Failed(ExecutorError),
}

pub fn prepare_executor(
    input: PrepareExecutorInput<'_>,
) -> Result<PreparedExecutor, PrepareExecutorError> {
    let platform = if cfg!(target_os = "macos") {
        super::upstream_roots::platform::Platform::MacOs
    } else if cfg!(target_os = "windows") {
        super::upstream_roots::platform::Platform::Windows
    } else {
        super::upstream_roots::platform::Platform::Unix
    };
    let defaults =
        super::upstream_roots::platform::CompiledOpenSslDefaults::node_26_4_bundled_linux_build();
    prepare_executor_for_platform(input, platform, Some(&defaults))
}

pub(crate) fn prepare_executor_for_platform(
    input: PrepareExecutorInput<'_>,
    platform: super::upstream_roots::platform::Platform,
    defaults: Option<&super::upstream_roots::platform::CompiledOpenSslDefaults>,
) -> Result<PreparedExecutor, PrepareExecutorError> {
    let canonical_overrides = EnvironmentOverrides {
        executor_version: Some(crate::dots::enrollment::registry::EXEC_SERVER_VERSION.into()),
        provider_id: Some(
            "sha256:6c00ea8010dd56f75443a655293fd43e86b65f038786b1a257324d4a6028d4cf".into(),
        ),
        prepend_path_dirs: vec![
            "/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex-path".into(),
        ],
        ..Default::default()
    };

    let current_dir = std::env::current_dir().map_err(|error| {
        PrepareExecutorError::Failed(ExecutorError::new(
            -32603,
            format!("failed to determine current directory: {error}"),
        ))
    })?;
    let standard_temp = std::env::temp_dir();
    let environment_info = build_environment_info_inner(
        input.home_directory,
        &canonical_overrides,
        true,
        Some(input.startup_environment),
        Some(&current_dir),
        &standard_temp,
    );

    let plan = match super::upstream_roots::platform::system_plan(
        platform,
        defaults,
        input.startup_environment,
    ) {
        Ok(plan) => plan,
        Err(super::upstream_roots::RootError::RequiredOpenSslDefaults) => {
            return Err(PrepareExecutorError::Held {
                environment_info: Box::new(environment_info),
                prerequisite: "packaging_openssl_defaults",
            });
        }
        Err(error) => {
            return Err(PrepareExecutorError::Failed(ExecutorError::new(
                -32603,
                format!("system plan failure: {error}"),
            )));
        }
    };

    let snapshot = super::upstream_roots::StartupCaSnapshot::capture(input.startup_environment);
    let provider = super::upstream_roots::RequiredRootProvider::new();
    let mut managed_paths = HashMap::new();
    for (_, path) in snapshot.values() {
        if !managed_paths.contains_key(path) {
            let is_managed = super::mitm_ca::is_managed_trust_bundle_path(
                input.network_proxy_ca_directory,
                Path::new(path),
            )
            .map_err(|error| {
                PrepareExecutorError::Failed(ExecutorError::new(-32603, error.to_string()))
            })?;
            managed_paths.insert(path.clone(), is_managed);
        }
    }

    let authority = Arc::new(super::mitm_ca::MitmAuthority::issue().map_err(|error| {
        PrepareExecutorError::Failed(ExecutorError::new(-32603, error.to_string()))
    })?);

    let upstream_roots = provider
        .load(
            || super::upstream_roots::platform::collect_current_system(&plan),
            &snapshot,
            super::upstream_roots::read_startup_ca_file,
            |path| managed_paths.get(path).copied().unwrap_or(false),
            authority.certificate_pem(),
        )
        .map_err(|error| match error {
            super::upstream_roots::RootError::RequiredOpenSslDefaults => {
                PrepareExecutorError::Held {
                    environment_info: Box::new(environment_info.clone()),
                    prerequisite: "packaging_openssl_defaults",
                }
            }
            other => PrepareExecutorError::Failed(ExecutorError::new(-32603, other.to_string())),
        })?;

    let (roots, certificates_pem) = upstream_roots.into_parts();
    let startup_values = snapshot
        .values()
        .iter()
        .map(|(k, v)| (LosslessString::from(*k), LosslessString::from(v.as_str())))
        .collect();

    let upstream_trust = super::network_proxy::NetworkProxyUpstreamTrust {
        authority,
        roots,
        certificates_pem,
        startup_values,
    };

    Ok(PreparedExecutor {
        home_directory: input.home_directory.to_path_buf(),
        data_directory: input.data_directory.to_path_buf(),
        environment: canonical_overrides,
        network_proxy_ca_directory: input.network_proxy_ca_directory.to_path_buf(),
        environment_info,
        upstream_trust,
    })
}

#[cfg(test)]
mod logical_launch_tests {
    use super::*;

    fn lone(prefix: &str) -> LosslessString {
        LosslessString::from_utf16(prefix.encode_utf16().chain([0xd800]).collect())
    }

    #[test]
    fn direct_library_selection_preserves_original_argument_units() {
        let original = vec![
            "/usr/bin/env".into(),
            library_selector(),
            "SYNTHETIC=value".into(),
            lone("tool"),
            lone("argument"),
        ];
        let (selected, private) = library_command(&original).unwrap();
        assert!(private);
        assert_eq!(
            selected,
            vec![
                original[0].clone(),
                original[2].clone(),
                original[3].clone(),
                original[4].clone()
            ]
        );
        let ordinary = vec![
            "/usr/bin/env".into(),
            lone("CODEX_APPS_MCP_URL=ycoding-library:"),
            "tool".into(),
        ];
        assert_eq!(library_command(&ordinary).unwrap(), (ordinary, false));
    }

    #[test]
    fn shell_library_selection_preserves_script_and_literal_guards() {
        let prefix = concat(&[
            &" \t/usr/bin/env ".into(),
            &library_selector(),
            &" SYNTHETIC='quoted value' tool ".into(),
        ]);
        let script = concat(&[&prefix, &lone("argument")]);
        let original = vec!["/bin/sh".into(), "-lc".into(), script.clone()];
        assert_eq!(shell_wrapper_script(&original), Some(&script));
        assert_eq!(library_command(&original).unwrap(), (original, true));
        for command in [
            "OPENAI_ACCOUNT_ID=x tool",
            "CODEX_APPS_HEADERS=x tool",
            "\"${SYNTHETIC}\"",
            "'unterminated",
            "-option",
            "SYNTHETIC=x",
        ] {
            let script = concat(&[
                &"/usr/bin/env ".into(),
                &library_selector(),
                &" ".into(),
                &command.into(),
            ]);
            assert_eq!(
                library_command(&["sh".into(), "-c".into(), script])
                    .unwrap_err()
                    .code,
                -32602
            );
        }
    }

    #[test]
    fn executor_environment_injection_retains_order_and_distinct_original_keys() {
        let original = lone("name");
        let replacement: LosslessString = "name\u{fffd}".into();
        let mut env = vec![
            (original.clone(), lone("value")),
            ("NO_PROXY".into(), "first".into()),
            (replacement.clone(), "separate".into()),
        ];
        set_environment(&mut env, "NO_PROXY", lone("updated"));
        set_environment(&mut env, "YCODING_SESSION_ID", "synthetic".into());
        assert_eq!(
            env,
            vec![
                (original, lone("value")),
                ("NO_PROXY".into(), lone("updated")),
                (replacement, "separate".into()),
                ("YCODING_SESSION_ID".into(), "synthetic".into())
            ]
        );
        assert!(library_reserved(&"CODEX_APP\u{17f}_MCP_URL".into()));
        assert!(library_reserved(&concat(&[
            &"CODEX_APPS_".into(),
            &lone(""),
            &"ACCOUNT".into()
        ])));
    }

    #[test]
    fn output_stream_pty_completes_both_stream_ends() {
        let (mut stdout_ended, mut stderr_ended) = (false, false);
        let stream = OutputStream::Pty;
        match stream {
            OutputStream::Stdout => stdout_ended = true,
            OutputStream::Stderr => stderr_ended = true,
            OutputStream::Pty => {
                stdout_ended = true;
                stderr_ended = true;
            }
        }
        assert!(stdout_ended);
        assert!(stderr_ended);
    }
}

#[cfg(test)]
mod pre_enrollment_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestPolicy {
        allow: bool,
        seen: Mutex<Vec<String>>,
    }
    impl Authorize for TestPolicy {
        fn authorize(
            &self,
            input: AuthorizationInput,
        ) -> BoxFuture<'static, Result<Grant, AuthorizationDenied>> {
            let resource_str = input
                .resources
                .iter()
                .map(|r| r.as_str().unwrap_or(""))
                .collect::<Vec<_>>()
                .join(" ");
            self.seen
                .lock()
                .unwrap()
                .push(format!("{} {}", input.action, resource_str));
            let allow = self.allow;
            Box::pin(async move {
                if allow {
                    Ok(Grant::noop())
                } else {
                    Err(AuthorizationDenied::default())
                }
            })
        }
    }

    struct TestScope {
        root: String,
        policy: Arc<TestPolicy>,
    }
    impl ExecutorScope for TestScope {
        fn session_id(&self) -> String {
            "ses_synthetic".to_owned()
        }
        fn roots(&self) -> Vec<String> {
            vec![self.root.clone()]
        }
        fn authorization(&self) -> Arc<dyn Authorize> {
            self.policy.clone()
        }
        fn close(&self) -> BoxFuture<'_, Result<(), ExecutorError>> {
            Box::pin(async { Ok(()) })
        }
    }

    struct CountingProvider {
        root: String,
        policy: Arc<TestPolicy>,
        calls: Arc<AtomicUsize>,
    }
    impl ScopeProvider for CountingProvider {
        fn scope_for(
            &self,
            _attribution: Option<Attribution>,
            _context: ScopeContext,
        ) -> BoxFuture<'_, Result<Arc<dyn ExecutorScope>, ExecutorError>> {
            self.calls.fetch_add(1, AtomicOrdering::SeqCst);
            let scope: Arc<dyn ExecutorScope> = Arc::new(TestScope {
                root: self.root.clone(),
                policy: self.policy.clone(),
            });
            Box::pin(async move { Ok(scope) })
        }
    }

    fn test_workspace(label: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("cca-prep-test-{label}-{stamp}"));
        let home = base.join("home");
        let data = base.join("data");
        let ca = base.join("ca");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        (base, home, data, ca)
    }

    fn clean_workspace(base: &Path) {
        let _ = std::fs::remove_dir_all(base);
    }

    fn test_options(
        home: &Path,
        data: &Path,
        ca: Option<&Path>,
        env: EnvironmentOverrides,
    ) -> (ExecutorOptions, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let policy = Arc::new(TestPolicy {
            allow: true,
            seen: Mutex::new(vec![]),
        });
        let options = ExecutorOptions {
            scope_provider: Arc::new(CountingProvider {
                root: home.to_string_lossy().into_owned(),
                policy,
                calls: calls.clone(),
            }),
            answer_process: None,
            base_env: BTreeMap::new(),
            session_id: None,
            process_timeout_ms: None,
            max_buffered_bytes_per_process: None,
            max_live_processes: None,
            network_proxy_ca_directory: ca.map(Path::to_path_buf),
            network_proxy_upstream_trust: None,
            network_policy: None,
            environment: env,
            home_directory: home.to_path_buf(),
            data_directory: data.to_path_buf(),
            codex_home_env: None,
            system_config_path: None,
            system_requirements_path: None,
            managed_config_path: None,
        };
        (options, calls)
    }

    #[test]
    fn preparation_has_no_scope_identity_inputs() {
        let (base, home, data, ca) = test_workspace("identity-inputs");
        let startup = BTreeMap::new();
        let input = PrepareExecutorInput {
            home_directory: &home,
            data_directory: &data,
            network_proxy_ca_directory: &ca,
            startup_environment: &startup,
        };
        let prepared = prepare_executor(input).expect("preparation succeeds");
        assert_eq!(prepared.home_directory, home);
        assert_eq!(prepared.data_directory, data);
        assert_eq!(prepared.network_proxy_ca_directory, ca);
        clean_workspace(&base);
    }

    #[test]
    fn metadata_matches_single_core_builder() {
        let (base, home, data, ca) = test_workspace("single-builder");
        let mut startup = BTreeMap::new();
        startup.insert("SHELL".into(), "/bin/bash".into());
        let input = PrepareExecutorInput {
            home_directory: &home,
            data_directory: &data,
            network_proxy_ca_directory: &ca,
            startup_environment: &startup,
        };
        let prepared = prepare_executor(input).expect("preparation succeeds");
        let info = prepared.environment_info();
        assert_eq!(
            info.executor_version.as_deref(),
            Some(crate::dots::enrollment::registry::EXEC_SERVER_VERSION)
        );
        assert_eq!(
            info.provider_id.as_deref(),
            Some("sha256:6c00ea8010dd56f75443a655293fd43e86b65f038786b1a257324d4a6028d4cf")
        );
        assert_eq!(info.capabilities.credential_masking, Some(true));
        clean_workspace(&base);
    }

    #[test]
    fn held_metadata_is_actual_metadata() {
        let (base, home, data, ca) = test_workspace("held-metadata");
        let mut startup = BTreeMap::new();
        startup.insert("SHELL".into(), "/bin/bash".into());
        let input = PrepareExecutorInput {
            home_directory: &home,
            data_directory: &data,
            network_proxy_ca_directory: &ca,
            startup_environment: &startup,
        };
        let res = prepare_executor_for_platform(
            input,
            super::super::upstream_roots::platform::Platform::Unix,
            None,
        );
        match res {
            Err(PrepareExecutorError::Held {
                environment_info,
                prerequisite,
            }) => {
                assert_eq!(prerequisite, "packaging_openssl_defaults");
                assert_eq!(
                    environment_info.executor_version.as_deref(),
                    Some(crate::dots::enrollment::registry::EXEC_SERVER_VERSION)
                );
                assert_eq!(
                    environment_info.provider_id.as_deref(),
                    Some("sha256:6c00ea8010dd56f75443a655293fd43e86b65f038786b1a257324d4a6028d4cf")
                );
                assert_eq!(environment_info.capabilities.credential_masking, Some(true));
            }
            Ok(_) => panic!("Unix platform without defaults should be Held"),
            Err(PrepareExecutorError::Failed(err)) => {
                panic!("Expected Held, got Failed: {err:?}");
            }
        }
        clean_workspace(&base);
    }

    #[test]
    fn unix_preparation_succeeds_with_node_26_4_openssl_defaults() {
        let (base, home, data, ca) = test_workspace("unix-openssl-defaults");
        let cert_file = base.join("cert.pem");
        std::fs::write(&cert_file, "").unwrap();
        let cert_dir = base.join("certs");
        std::fs::create_dir_all(&cert_dir).unwrap();
        let mut startup = BTreeMap::new();
        startup.insert("SHELL".into(), "/bin/bash".into());
        startup.insert(
            "SSL_CERT_FILE".into(),
            cert_file.to_string_lossy().into_owned(),
        );
        startup.insert(
            "SSL_CERT_DIR".into(),
            cert_dir.to_string_lossy().into_owned(),
        );
        let input = PrepareExecutorInput {
            home_directory: &home,
            data_directory: &data,
            network_proxy_ca_directory: &ca,
            startup_environment: &startup,
        };
        let defaults =
            super::super::upstream_roots::platform::CompiledOpenSslDefaults::node_26_4_bundled_linux_build();
        let prepared = prepare_executor_for_platform(
            input,
            super::super::upstream_roots::platform::Platform::Unix,
            Some(&defaults),
        )
        .expect("Unix preparation with Node 26.4 OpenSSL defaults succeeds");
        assert!(!prepared.upstream_trust().certificates_pem.is_empty());
        assert_eq!(
            prepared.environment_info().capabilities.credential_masking,
            Some(true)
        );
        clean_workspace(&base);
    }

    #[test]
    fn packaging_defaults_are_explicit() {
        let empty_env = BTreeMap::new();
        let res = super::super::upstream_roots::platform::system_plan(
            super::super::upstream_roots::platform::Platform::Unix,
            None,
            &empty_env,
        );
        match res {
            Err(super::super::upstream_roots::RootError::RequiredOpenSslDefaults) => {}
            other => panic!("expected RequiredOpenSslDefaults on unconfigured Unix, got {other:?}"),
        }
    }

    #[test]
    fn failure_classification_preserves_cause() {
        let (base, home, data, ca) = test_workspace("failure-cause");
        let bad_pem = base.join("invalid_cert.pem");
        std::fs::write(
            &bad_pem,
            "-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n",
        )
        .unwrap();
        let mut startup = BTreeMap::new();
        startup.insert(
            "NODE_EXTRA_CA_CERTS".into(),
            bad_pem.to_string_lossy().into_owned(),
        );
        let input = PrepareExecutorInput {
            home_directory: &home,
            data_directory: &data,
            network_proxy_ca_directory: &ca,
            startup_environment: &startup,
        };
        let res = prepare_executor(input);
        match res {
            Err(PrepareExecutorError::Failed(err)) => {
                assert!(!err.message.is_empty());
            }
            Ok(_) => panic!("expected failure on corrupted extra CA certificate"),
            Err(PrepareExecutorError::Held { .. }) => panic!("expected Failed error variant"),
        }
        clean_workspace(&base);
    }

    #[test]
    fn prepared_metadata_is_frozen() {
        let (base, home, data, ca) = test_workspace("frozen-metadata");
        let mut startup = BTreeMap::new();
        startup.insert("SHELL".into(), "/bin/bash".into());
        let input = PrepareExecutorInput {
            home_directory: &home,
            data_directory: &data,
            network_proxy_ca_directory: &ca,
            startup_environment: &startup,
        };
        let prepared = prepare_executor(input).expect("preparation succeeds");
        let frozen_info = prepared.environment_info();
        startup.insert("SHELL".into(), "/bin/zsh".into());
        assert_eq!(
            frozen_info.shell.name,
            prepared.environment_info().shell.name
        );
        clean_workspace(&base);
    }

    #[test]
    fn prepared_binding_rejects_mismatch() {
        let (base, home, data, ca) = test_workspace("binding-mismatch");
        let startup = BTreeMap::new();
        let input = PrepareExecutorInput {
            home_directory: &home,
            data_directory: &data,
            network_proxy_ca_directory: &ca,
            startup_environment: &startup,
        };
        let prepared = prepare_executor(input).expect("preparation succeeds");

        // Partition 1: home directory mismatch
        let (options_bad_home, _) = test_options(
            &base.join("other_home"),
            &data,
            Some(&ca),
            prepared.environment_overrides(),
        );
        let err1 = match Executor::new_prepared(options_bad_home, &prepared) {
            Err(e) => e,
            Ok(_) => panic!("expected home mismatch error"),
        };
        assert_eq!(err1.message, "home directory mismatch".into());

        // Partition 2: data directory mismatch
        let (options_bad_data, _) = test_options(
            &home,
            &base.join("other_data"),
            Some(&ca),
            prepared.environment_overrides(),
        );
        let err2 = match Executor::new_prepared(options_bad_data, &prepared) {
            Err(e) => e,
            Ok(_) => panic!("expected data mismatch error"),
        };
        assert_eq!(err2.message, "data directory mismatch".into());

        // Partition 3: environment overrides mismatch
        let mut bad_env = prepared.environment_overrides();
        bad_env.provider_id = Some("mismatched".into());
        let (options_bad_env, _) = test_options(&home, &data, Some(&ca), bad_env);
        let err3 = match Executor::new_prepared(options_bad_env, &prepared) {
            Err(e) => e,
            Ok(_) => panic!("expected env mismatch error"),
        };
        assert_eq!(err3.message, "environment overrides mismatch".into());

        // Partition 4: network proxy CA directory mismatch
        let (options_bad_ca, _) = test_options(
            &home,
            &data,
            Some(&base.join("other_ca")),
            prepared.environment_overrides(),
        );
        let err4 = match Executor::new_prepared(options_bad_ca, &prepared) {
            Err(e) => e,
            Ok(_) => panic!("expected ca mismatch error"),
        };
        assert_eq!(err4.message, "network proxy CA directory mismatch".into());

        // Partition 5: separately supplied network proxy upstream trust
        let (mut options_duplicate_trust, _) =
            test_options(&home, &data, Some(&ca), prepared.environment_overrides());
        options_duplicate_trust.network_proxy_upstream_trust =
            Some(prepared.upstream_trust().clone());
        let err5 = match Executor::new_prepared(options_duplicate_trust, &prepared) {
            Err(e) => e,
            Ok(_) => panic!("expected duplicate trust error"),
        };
        assert_eq!(
            err5.message,
            "separately supplied network proxy upstream trust is not permitted with prepared executor".into()
        );

        clean_workspace(&base);
    }

    #[test]
    fn prepared_binding_reuses_trust() {
        let (base, home, data, ca) = test_workspace("reuse-trust");
        let startup = BTreeMap::new();
        let input = PrepareExecutorInput {
            home_directory: &home,
            data_directory: &data,
            network_proxy_ca_directory: &ca,
            startup_environment: &startup,
        };
        let prepared = prepare_executor(input).expect("preparation succeeds");

        let (options1, _) = test_options(&home, &data, Some(&ca), prepared.environment_overrides());
        let exec1 = match Executor::new_prepared(options1, &prepared) {
            Ok(e) => e,
            Err(e) => panic!("binding 1 failed: {e:?}"),
        };

        let (options2, _) = test_options(&home, &data, Some(&ca), prepared.environment_overrides());
        let exec2 = match Executor::new_prepared(options2, &prepared) {
            Ok(e) => e,
            Err(e) => panic!("binding 2 failed: {e:?}"),
        };

        let t1 = exec1.upstream_trust().expect("trust attached on exec1");
        let t2 = exec2.upstream_trust().expect("trust attached on exec2");

        assert!(Arc::ptr_eq(&t1.authority, &t2.authority));
        assert_eq!(t1.certificates_pem, t2.certificates_pem);
        assert_eq!(t1.startup_values, t2.startup_values);
        assert_eq!(t1.roots.len(), t2.roots.len());

        clean_workspace(&base);
    }

    #[test]
    fn preparation_does_not_export_child_files() {
        let (base, home, data, ca) = test_workspace("no-export");
        assert!(!ca.exists(), "ca directory must not exist initially");
        let startup = BTreeMap::new();
        let input = PrepareExecutorInput {
            home_directory: &home,
            data_directory: &data,
            network_proxy_ca_directory: &ca,
            startup_environment: &startup,
        };
        let prepared = prepare_executor(input).expect("preparation succeeds");
        assert!(
            !ca.exists(),
            "preparation must not create or export ca directory"
        );
        let (options, _) = test_options(&home, &data, Some(&ca), prepared.environment_overrides());
        let _exec = match Executor::new_prepared(options, &prepared) {
            Ok(e) => e,
            Err(e) => panic!("binding failed: {e:?}"),
        };
        assert!(
            !ca.exists(),
            "binding must not create or export ca directory"
        );
        clean_workspace(&base);
    }

    #[test]
    fn prepared_value_owns_inputs() {
        let (base, prepared) = {
            let (base, home, data, ca) = test_workspace("ownership");
            let startup = BTreeMap::new();
            let input = PrepareExecutorInput {
                home_directory: &home,
                data_directory: &data,
                network_proxy_ca_directory: &ca,
                startup_environment: &startup,
            };
            let prep = prepare_executor(input).expect("preparation succeeds");
            (base, prep)
        };
        let home = prepared.home_directory.clone();
        let data = prepared.data_directory.clone();
        let ca = prepared.network_proxy_ca_directory.clone();
        let (options, _) = test_options(&home, &data, Some(&ca), prepared.environment_overrides());
        let exec = match Executor::new_prepared(options, &prepared) {
            Ok(e) => e,
            Err(e) => panic!("binding failed: {e:?}"),
        };
        assert!(exec.check_not_closed().is_ok());
        clean_workspace(&base);
    }

    #[test]
    fn ordinary_new_contract_is_preserved() {
        let (base, home, data, _) = test_workspace("ordinary-new");
        let (options, _) = test_options(&home, &data, None, EnvironmentOverrides::default());
        let executor = Executor::new(options);
        assert_eq!(
            executor.environment_info().capabilities.windows_mxc,
            Some(false)
        );
        assert_eq!(
            executor.environment_info().capabilities.credential_masking,
            None
        );
        assert!(executor.upstream_trust().is_none());
        assert!(executor.check_not_closed().is_ok());
        clean_workspace(&base);
    }
}
