use ycoding_core::ycoding_schema::{JsonObject, JsonValue, LosslessString};

pub type Text = LosslessString;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum Presence<T> {
    #[default]
    Absent,
    Null,
    Value(T),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InitializeParams {
    pub client_name: Text,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InitializeResult {
    pub session_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShellInfo {
    pub name: Text,
    pub path: Text,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct EnvironmentCapabilities {
    pub network_proxy_launch: Option<bool>,
    pub network_proxy_review_domains: Option<bool>,
    pub credential_masking: Option<bool>,
    pub credential_masking_custom_providers: Option<bool>,
    pub capability_discovery_sandbox: Option<bool>,
    pub fs_watch_missing: Option<bool>,
    pub capability_discovery_v2: Option<bool>,
    pub environment_config_read: Option<bool>,
    pub http_header_env_vars: Option<bool>,
    pub sandboxed_file_streaming: Option<bool>,
    pub file_write_streaming: Option<bool>,
    pub shell_snapshot_v2: Option<bool>,
    pub windows_mxc: Option<bool>,
    pub linux_root_write_preserves_devices: Option<bool>,
    pub linux_approved_root_write_preserves_restrictions: Option<bool>,
    pub extra: Vec<(String, JsonValue)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EnvironmentInfo {
    pub shell: ShellInfo,
    pub executor_version: Option<String>,
    pub provider_id: Option<String>,
    pub cwd: Presence<String>,
    pub user_home_dir: Presence<String>,
    pub platform_os: Presence<String>,
    pub prepend_path_dirs: Option<Vec<String>>,
    pub temporary_directories: Option<Vec<String>>,
    pub temp_dir: Presence<String>,
    pub capabilities: EnvironmentCapabilities,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct BackendFeatures {
    pub network_proxy: bool,
    pub credential_masking: bool,
    pub credential_masking_custom_providers: bool,
    pub shell_snapshot: bool,
    pub environment_config_read: bool,
    pub capability_roots: bool,
    pub capability_discovery_v2: bool,
    pub file_streaming: bool,
    pub file_write_streaming: bool,
    pub http_request: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OptionalMethod {
    EnvironmentConfigRead,
    CapabilityRootsDiscoverV1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectionMethod {
    CapabilitiesDiscoverV2,
    FsCreateDirectory,
    FsOpen,
    FsReadBlock,
    FsWriteBlock,
    FsClose,
    FsWalk,
    FsRemove,
    FsCopy,
    HttpRequest,
}

impl ConnectionMethod {
    pub const ALL: [ConnectionMethod; 10] = [
        Self::CapabilitiesDiscoverV2,
        Self::FsCreateDirectory,
        Self::FsOpen,
        Self::FsReadBlock,
        Self::FsWriteBlock,
        Self::FsClose,
        Self::FsWalk,
        Self::FsRemove,
        Self::FsCopy,
        Self::HttpRequest,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::CapabilitiesDiscoverV2 => "capabilities/discoverV2",
            Self::FsCreateDirectory => "fs/createDirectory",
            Self::FsOpen => "fs/open",
            Self::FsReadBlock => "fs/readBlock",
            Self::FsWriteBlock => "fs/writeBlock",
            Self::FsClose => "fs/close",
            Self::FsWalk => "fs/walk",
            Self::FsRemove => "fs/remove",
            Self::FsCopy => "fs/copy",
            Self::HttpRequest => "http/request",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|method| method.name() == name)
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ExecMetadata {
    pub thread_id: Option<String>,
    pub tool_call_id: Option<Text>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShellSnapshotRequest {
    pub scope_id: Text,
    pub shell: ShellInfo,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NetworkMode {
    Limited,
    Full,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DomainPermission {
    None,
    Allow,
    Deny,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnixSocketPermission {
    Allow,
    Deny,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CredentialAuthMethod {
    Bearer,
    Token,
    Basic,
    Header,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialProviderConfig {
    pub env: Vec<Text>,
    pub patterns: Vec<Text>,
    pub url_prefixes: Vec<Text>,
    pub url_prefix_from_env: Option<Text>,
    pub auth: Vec<CredentialAuthMethod>,
    pub header: Option<Text>,
    pub prefix: Option<Text>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NetworkProxyConfig {
    pub enabled: bool,
    pub credential_masking: bool,
    pub credential_providers: Vec<(Text, CredentialProviderConfig)>,
    pub enable_socks5: bool,
    pub enable_socks5_udp: bool,
    pub allow_upstream_proxy: bool,
    pub dangerously_allow_all_unix_sockets: bool,
    pub mode: NetworkMode,
    pub domains: Option<Vec<(Text, DomainPermission)>>,
    pub review_domains: Vec<Text>,
    pub unix_sockets: Option<Vec<(Text, UnixSocketPermission)>>,
    pub allow_local_binding: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct NetworkProxyAuditMetadata {
    pub conversation_id: Option<Text>,
    pub app_version: Option<Text>,
    pub user_account_id: Option<Text>,
    pub auth_mode: Option<Text>,
    pub originator: Option<Text>,
    pub user_email: Option<Text>,
    pub terminal_type: Option<Text>,
    pub model: Option<Text>,
    pub slug: Option<Text>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NetworkProxyLaunchConfig {
    pub proxy: NetworkProxyConfig,
    pub audit_metadata: NetworkProxyAuditMetadata,
    pub environment_id: Option<Text>,
    pub execution_id: Option<Text>,
    pub policy_decision_timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExecParams {
    pub process_id: Text,
    pub argv: Vec<Text>,
    pub cwd: Text,
    pub env: Vec<(Text, Text)>,
    pub tty: bool,
    pub pipe_stdin: bool,
    pub arg0: Option<Text>,
    pub metadata: Option<ExecMetadata>,
    pub env_policy: Option<JsonObject>,
    pub shell_snapshot: Option<ShellSnapshotRequest>,
    pub sandbox: Option<JsonObject>,
    pub enforce_managed_network: Option<bool>,
    pub managed_network: Option<JsonObject>,
    pub network_proxy: Option<NetworkProxyLaunchConfig>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxType {
    None,
    MacosSeatbelt,
    LinuxSeccomp,
    WindowsRestrictedToken,
    WindowsMxc,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecResult {
    pub process_id: Text,
    pub sandbox_type: Presence<SandboxType>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadParams {
    pub process_id: Text,
    pub after_seq: Option<u64>,
    pub max_bytes: Option<u64>,
    pub wait_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessStream {
    Stdout,
    Stderr,
    Pty,
}

impl ProcessStream {
    pub fn name(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
            Self::Pty => "pty",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessOutputChunk {
    pub seq: u64,
    pub stream: ProcessStream,
    pub chunk: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadResult {
    pub chunks: Vec<ProcessOutputChunk>,
    pub next_seq: u64,
    pub exited: bool,
    pub exit_code: Presence<i64>,
    pub closed: bool,
    pub failure: Presence<String>,
    pub sandbox_denied: Option<bool>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WriteParams {
    pub process_id: Text,
    pub chunk: String,
    pub write_id: Text,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WriteStatus {
    Accepted,
    UnknownProcess,
    StdinClosed,
    Starting,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WriteResult {
    pub status: WriteStatus,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignalParams {
    pub process_id: Text,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminateParams {
    pub process_id: Text,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminateResult {
    pub running: bool,
}

#[cfg(test)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProcessEvent {
    Output {
        process_id: Text,
        seq: u64,
        stream: ProcessStream,
        chunk: Vec<u8>,
    },
    Exited {
        process_id: Text,
        seq: u64,
        exit_code: Option<i64>,
        sandbox_denied: bool,
    },
    Closed {
        process_id: Text,
        seq: u64,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct FsReadFileParams {
    pub path: Text,
    pub follow_symlinks: Option<bool>,
    pub sandbox: Option<JsonObject>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FsReadFileResult {
    pub data_base64: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FsWriteFileParams {
    pub path: Text,
    pub data_base64: String,
    pub follow_symlinks: Option<bool>,
    pub sandbox: Option<JsonObject>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FsGetMetadataParams {
    pub path: Text,
    pub follow_symlinks: Option<bool>,
    pub sandbox: Option<JsonObject>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FsGetMetadataResult {
    pub is_directory: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub created_at_ms: i64,
    pub modified_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FsReadDirectoryParams {
    pub path: Text,
    pub sandbox: Option<JsonObject>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FsReadDirectoryEntry {
    pub file_name: String,
    pub is_directory: bool,
    pub is_file: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FsReadDirectoryResult {
    pub entries: Vec<FsReadDirectoryEntry>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FsCanonicalizeParams {
    pub path: Text,
    pub sandbox: Option<JsonObject>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FsCanonicalizeResult {
    pub path: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CreateDirectoryParams {
    pub path: String,
    pub recursive: Option<bool>,
    pub follow_symlinks: Option<bool>,
    pub sandbox: Option<JsonObject>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpenMode {
    Read,
    Replace,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OpenParams {
    pub handle_id: Text,
    pub path: String,
    pub mode: OpenMode,
    pub sandbox: Option<JsonObject>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenResult {
    pub handle_id: Text,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadBlockParams {
    pub handle_id: Text,
    pub offset: u64,
    pub len: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadBlockResult {
    pub chunk: Vec<u8>,
    pub eof: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WriteBlockParams {
    pub handle_id: Text,
    pub offset: u64,
    pub chunk: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CloseParams {
    pub handle_id: Text,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WalkOptions {
    pub max_depth: u64,
    pub max_directories: u64,
    pub max_entries: u64,
    pub follow_directory_symlinks: bool,
    pub prune_hidden_directories: Option<bool>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WalkParams {
    pub path: String,
    pub options: WalkOptions,
    pub sandbox: Option<JsonObject>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WalkEntryKind {
    Directory,
    File,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WalkEntry {
    pub path: String,
    pub kind: WalkEntryKind,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WalkError {
    pub path: String,
    pub message: Text,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WalkResult {
    pub entries: Vec<WalkEntry>,
    pub errors: Vec<WalkError>,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RemoveParams {
    pub path: String,
    pub recursive: Option<bool>,
    pub force: Option<bool>,
    pub follow_symlinks: Option<bool>,
    pub sandbox: Option<JsonObject>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CopyParams {
    pub source_path: String,
    pub destination_path: String,
    pub recursive: bool,
    pub sandbox: Option<JsonObject>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpHeader {
    pub name: Text,
    pub value: Text,
    pub value_env_var: Option<Text>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HttpRedirectPolicy {
    Follow,
    Stop,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpRequestParams {
    pub method: Text,
    pub url: Text,
    pub headers: Vec<HttpHeader>,
    pub body: Option<Vec<u8>>,
    pub timeout_ms: Option<u64>,
    pub redirect_policy: HttpRedirectPolicy,
    pub request_id: Text,
    pub stream_response: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<HttpHeader>,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpBodyDelta {
    pub request_id: Text,
    pub seq: u64,
    pub delta: Vec<u8>,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnvironmentConfigReadParams {
    pub cwd: Text,
    pub config_paths: Vec<Vec<Text>>,
    pub requirements_paths: Vec<Vec<Text>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CapabilityRootRequest {
    pub id: Text,
    pub path: Text,
    pub sandbox: Option<JsonObject>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CapabilityRootsDiscoverParams {
    pub roots: Vec<CapabilityRootRequest>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DiscoverV2Params {
    pub cwd: Text,
    pub sandbox: Option<JsonObject>,
}
