pub use super::credential_broker::{CredentialAuthMethod, CredentialProviderConfig};
use super::{
    credential_broker::{
        BrokeredProtocols, CCA_CREDENTIAL_MASKING_PARTIAL_WARNING, CredentialBrokerCache,
        CredentialBrokerEntry, CredentialBrokerKey,
    },
    encoding::ascii_lower,
    error::{AuthorizationInput, AuthorizeFn, BoxFuture, ExecutorError, Grant},
    mitm_ca::{ChildTrustBundle, MitmAuthority, UpstreamTlsConnector, upstream_openssl_connector},
    signal::Signal,
    value::{JsonObject, LosslessString, Value, concat},
};
mod interception;
#[cfg(test)]
mod interception_tests;
use interception::{RequestHead, TunnelMode, forward_request, read_request_head, run_tunnel};
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Notify,
};

pub const REASON_DENIED: &str = "denied";
pub const REASON_METHOD_NOT_ALLOWED: &str = "method_not_allowed";
pub const REASON_MITM_REQUIRED: &str = "mitm_required";
pub const REASON_NOT_ALLOWED: &str = "not_allowed";
pub const REASON_NOT_ALLOWED_LOCAL: &str = "not_allowed_local";
pub const REASON_POLICY_DENIED: &str = "policy_denied";
const DNS_LOOKUP_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_REQUEST_HEAD_BYTES: usize = 64 * 1024;

pub const PROXY_ACTIVE_ENV_KEY: &str = "CODEX_NETWORK_PROXY_ACTIVE";
const ALLOW_LOCAL_BINDING_ENV_KEY: &str = "CODEX_NETWORK_ALLOW_LOCAL_BINDING";
const GIT_SSH_COMMAND_ENV_KEY: &str = "GIT_SSH_COMMAND";
const GIT_SSH_COMMAND_PREFIX: &str =
    "CODEX_PROXY_GIT_SSH_COMMAND=1 ssh -o ProxyCommand='nc -X 5 -x ";
const GIT_SSH_COMMAND_SUFFIX: &str = " %h %p'";
const DEFAULT_NO_PROXY_VALUE: &str =
    "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";
const HTTP_PROXY_ENV_KEYS: [&str; 17] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "YARN_HTTP_PROXY",
    "YARN_HTTPS_PROXY",
    "npm_config_http_proxy",
    "npm_config_https_proxy",
    "npm_config_proxy",
    "NPM_CONFIG_HTTP_PROXY",
    "NPM_CONFIG_HTTPS_PROXY",
    "NPM_CONFIG_PROXY",
    "BUNDLE_HTTP_PROXY",
    "BUNDLE_HTTPS_PROXY",
    "PIP_PROXY",
    "DOCKER_HTTP_PROXY",
    "DOCKER_HTTPS_PROXY",
];
const WEBSOCKET_PROXY_ENV_KEYS: [&str; 4] = ["WS_PROXY", "WSS_PROXY", "ws_proxy", "wss_proxy"];
const NO_PROXY_ENV_KEYS: [&str; 5] = [
    "NO_PROXY",
    "no_proxy",
    "npm_config_noproxy",
    "NPM_CONFIG_NOPROXY",
    "BUNDLE_NO_PROXY",
];
const ALL_PROXY_ENV_KEYS: [&str; 2] = ["ALL_PROXY", "all_proxy"];
const FTP_PROXY_ENV_KEYS: [&str; 2] = ["FTP_PROXY", "ftp_proxy"];
pub const CUSTOM_CA_ENV_KEYS: [&str; 11] = [
    "CODEX_CA_CERTIFICATE",
    "SSL_CERT_FILE",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
    "GIT_SSL_CAINFO",
    "CARGO_HTTP_CAINFO",
    "PIP_CERT",
    "BUNDLE_SSL_CA_CERT",
    "npm_config_cafile",
    "NPM_CONFIG_CAFILE",
];
pub const MANAGED_PROXY_ENV_KEYS: [&str; 4] = [
    PROXY_ACTIVE_ENV_KEY,
    "CODEX_NETWORK_PROXY_CREDENTIAL_BROKER_ACTIVE",
    "CODEX_NETWORK_PROXY_BROKERED_CREDENTIALS",
    ALLOW_LOCAL_BINDING_ENV_KEY,
];
const MANAGED_PROXY_EXTRA_KEYS: [&str; 3] = [
    "CODEX_NETWORK_PROXY_ATTRIBUTION_TOKEN",
    "ELECTRON_GET_USE_PROXY",
    "NODE_USE_ENV_PROXY",
];
const OTHER_MANAGED_KEYS: [&str; 2] = ["YARN_NO_PROXY", "BUNDLE_NO_PROXY"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Linux,
    Darwin,
    Windows,
    Other,
}
impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "linux") {
            Self::Linux
        } else if cfg!(target_os = "macos") {
            Self::Darwin
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Other
        }
    }
}

pub fn is_managed_proxy_env_var(key: &str, value: &str, platform: Platform) -> bool {
    if MANAGED_PROXY_ENV_KEYS.contains(&key)
        || MANAGED_PROXY_EXTRA_KEYS.contains(&key)
        || HTTP_PROXY_ENV_KEYS.contains(&key)
        || WEBSOCKET_PROXY_ENV_KEYS.contains(&key)
        || NO_PROXY_ENV_KEYS.contains(&key)
        || OTHER_MANAGED_KEYS.contains(&key)
        || ALL_PROXY_ENV_KEYS.contains(&key)
        || FTP_PROXY_ENV_KEYS.contains(&key)
    {
        return true;
    }
    if CUSTOM_CA_ENV_KEYS.contains(&key) {
        let name = value.rsplit(['/', '\\']).next().unwrap_or("");
        return name.len() == "ca-bundle-".len() + 64 + ".pem".len()
            && name.starts_with("ca-bundle-")
            && name.ends_with(".pem")
            && name["ca-bundle-".len()..name.len() - 4]
                .chars()
                .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character));
    }
    platform == Platform::Darwin
        && key == GIT_SSH_COMMAND_ENV_KEY
        && value.starts_with("CODEX_PROXY_GIT_SSH_COMMAND=1 ")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetworkMode {
    Limited,
    Full,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DomainPermission {
    None,
    Allow,
    Deny,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnixSocketPermission {
    Allow,
    Deny,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteNetworkProxyConfig {
    pub enabled: bool,
    pub credential_masking: bool,
    pub credential_providers: Vec<(LosslessString, CredentialProviderConfig)>,
    pub enable_socks5: bool,
    pub enable_socks5_udp: bool,
    pub allow_upstream_proxy: bool,
    pub dangerously_allow_all_unix_sockets: bool,
    pub mode: NetworkMode,
    pub domains: Option<Vec<(LosslessString, DomainPermission)>>,
    pub review_domains: Vec<LosslessString>,
    pub unix_sockets: Option<Vec<(LosslessString, UnixSocketPermission)>>,
    pub allow_local_binding: bool,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NetworkProxyAuditMetadata {
    pub conversation_id: Option<LosslessString>,
    pub app_version: Option<LosslessString>,
    pub user_account_id: Option<LosslessString>,
    pub auth_mode: Option<LosslessString>,
    pub originator: Option<LosslessString>,
    pub user_email: Option<LosslessString>,
    pub terminal_type: Option<LosslessString>,
    pub model: Option<LosslessString>,
    pub slug: Option<LosslessString>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteNetworkProxyLaunchConfig {
    pub proxy: RemoteNetworkProxyConfig,
    pub audit_metadata: NetworkProxyAuditMetadata,
    pub environment_id: Option<LosslessString>,
    pub execution_id: Option<LosslessString>,
    pub policy_decision_timeout_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NetworkProxyCapabilities {
    pub network_proxy_launch: bool,
    pub network_proxy_review_domains: bool,
    pub credential_masking: bool,
    pub credential_masking_custom_providers: bool,
    pub shell_snapshot_v2: bool,
}
pub fn network_proxy_capabilities(platform: Platform, shell: &str) -> NetworkProxyCapabilities {
    let name = super::policy::basename(shell);
    let name = name
        .strip_suffix(".exe")
        .or_else(|| name.strip_suffix(".EXE"))
        .unwrap_or(&name)
        .to_owned();
    let credential_masking =
        matches!(platform, Platform::Linux | Platform::Darwin) && (name == "bash" || name == "zsh");
    NetworkProxyCapabilities {
        network_proxy_launch: true,
        network_proxy_review_domains: true,
        credential_masking,
        credential_masking_custom_providers: credential_masking,
        shell_snapshot_v2: platform != Platform::Windows,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetworkProtocol {
    Http,
    HttpsConnect,
    Socks5Tcp,
    Socks5Udp,
}
impl NetworkProtocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::HttpsConnect => "https_connect",
            Self::Socks5Tcp => "socks5_tcp",
            Self::Socks5Udp => "socks5_udp",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetworkPolicyRequest {
    pub protocol: NetworkProtocol,
    pub host: String,
    pub port: u16,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NetworkDecision {
    Allow,
    Deny(LosslessString),
    Ask(LosslessString),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecisionSource {
    BaselinePolicy,
    ModeGuard,
    ProxyState,
    Decider,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetworkPolicyAuditEvent {
    pub timestamp: LosslessString,
    pub decision: &'static str,
    pub source: DecisionSource,
    pub reason: LosslessString,
    pub protocol: NetworkProtocol,
    pub host: LosslessString,
    pub port: u16,
    pub method: Option<LosslessString>,
    pub client: Option<LosslessString>,
    pub policy_override: bool,
}
pub type NetworkPolicyDecider = Arc<
    dyn Fn(NetworkPolicyRequest) -> BoxFuture<'static, Result<NetworkDecision, ()>> + Send + Sync,
>;
pub type PolicyDecisionListener = Arc<dyn Fn(NetworkPolicyAuditEvent) + Send + Sync>;
pub type DnsLookup =
    Arc<dyn Fn(String, u16) -> BoxFuture<'static, Result<Vec<String>, ()>> + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostBlockDecision {
    Allowed,
    Denied,
    NotAllowed,
    NotAllowedLocal,
}
impl HostBlockDecision {
    fn reason(self) -> &'static str {
        match self {
            Self::Allowed => "allow",
            Self::Denied => REASON_DENIED,
            Self::NotAllowed => REASON_NOT_ALLOWED,
            Self::NotAllowedLocal => REASON_NOT_ALLOWED_LOCAL,
        }
    }
}

fn strict_ip(value: &str) -> u8 {
    if value.contains('%') {
        0
    } else if value.parse::<Ipv4Addr>().is_ok() {
        4
    } else if value.parse::<Ipv6Addr>().is_ok() {
        6
    } else {
        0
    }
}
fn normalize_ip_literal(host: &str) -> Option<String> {
    if strict_ip(host) != 0 {
        return Some(host.to_owned());
    }
    for delimiter in ["%25", "%"] {
        if let Some(index) = host.find(delimiter)
            && strict_ip(&host[..index]) != 0
        {
            return Some(format!(
                "{}%{}",
                &host[..index],
                &host[index + delimiter.len()..]
            ));
        }
    }
    None
}
fn normalize_dns_host_or_ip_literal(host: &str) -> String {
    let lowered = ascii_lower(host).trim_end_matches('.').to_owned();
    normalize_ip_literal(&lowered).unwrap_or(lowered)
}
fn js_whitespace(character: char) -> bool {
    matches!(character as u32, 0x9..=0xd | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
pub fn normalize_host(host: &str) -> String {
    let trimmed = host.trim_matches(js_whitespace);
    if trimmed.starts_with('[')
        && let Some(end) = trimmed.find(']')
    {
        return normalize_dns_host_or_ip_literal(&trimmed[1..end]);
    }
    let parts = trimmed.split(':').collect::<Vec<_>>();
    if parts.len() == 2 {
        return normalize_dns_host_or_ip_literal(parts[0]);
    }
    normalize_dns_host_or_ip_literal(trimmed)
}
fn unscoped_ip_literal(host: &str) -> Option<String> {
    let index = host.find('%')?;
    (strict_ip(&host[..index]) != 0).then(|| host[..index].to_owned())
}
fn normalize_pattern(pattern: &str) -> String {
    let trimmed = pattern.trim_matches(js_whitespace);
    if trimmed == "*" {
        return "*".to_owned();
    }
    let prefix = if trimmed.starts_with("**.") {
        "**."
    } else if trimmed.starts_with("*.") {
        "*."
    } else {
        ""
    };
    format!("{prefix}{}", normalize_host(&trimmed[prefix.len()..]))
}
fn expand_domain_pattern(pattern: &str) -> Vec<String> {
    let trimmed = pattern.trim_matches(js_whitespace);
    let prefix = if trimmed.starts_with("**.") {
        "**."
    } else if trimmed.starts_with("*.") {
        "*."
    } else {
        ""
    };
    if prefix.is_empty() {
        return vec![trimmed.to_owned()];
    }
    let domain = trimmed[prefix.len()..].trim_matches(js_whitespace);
    if domain.is_empty() {
        return vec![String::new()];
    }
    if prefix == "**." {
        vec![domain.to_owned(), format!("?*.{domain}")]
    } else {
        vec![format!("?*.{domain}")]
    }
}
fn matches_bytes(pattern: &[u8], host: &[u8]) -> bool {
    let (mut p, mut h) = (0usize, 0usize);
    let mut star: Option<(usize, usize)> = None;
    while h < host.len() {
        let current = pattern.get(p).copied();
        if current == Some(b'*') {
            star = Some((p + 1, h));
            p += 1;
        } else if current.is_some_and(|byte| byte == b'?' || byte.eq_ignore_ascii_case(&host[h])) {
            p += 1;
            h += 1;
        } else if let Some((resume, consumed)) = star {
            star = Some((resume, consumed + 1));
            p = resume;
            h = consumed + 1;
        } else {
            return false;
        }
    }
    pattern[p.min(pattern.len())..]
        .iter()
        .all(|byte| *byte == b'*')
}

#[derive(Clone, Debug, Default)]
pub struct DomainPatternSet(Vec<Vec<u8>>);
impl DomainPatternSet {
    pub fn is_match(&self, host: &str) -> bool {
        self.0
            .iter()
            .any(|pattern| matches_bytes(pattern, host.as_bytes()))
    }
}
pub fn compile_domain_patterns(
    patterns: &[LosslessString],
    reject_global_wildcard: bool,
) -> Result<DomainPatternSet, LosslessString> {
    let mut compiled: Vec<Vec<u8>> = vec![];
    let mut seen: Vec<String> = vec![];
    for original in patterns {
        let pattern = String::from_utf16_lossy(&original.code_units().collect::<Vec<_>>());
        let pattern = pattern.as_str();
        if reject_global_wildcard
            && expand_domain_pattern(&normalize_pattern(pattern))
                .iter()
                .any(|candidate| candidate == "*")
        {
            return Err("unsupported global wildcard domain pattern \"*\"; use exact hosts or scoped wildcards like *.example.com or **.example.com".into());
        }
        let raw = pattern.trim_matches(js_whitespace);
        if raw.chars().any(|character| {
            matches!(character, '{' | '}' | '\\' | '/') || js_whitespace(character)
        }) {
            return Err(concat(&[
                &"unsupported domain pattern syntax: ".into(),
                original,
            ]));
        }
        let host = raw
            .strip_prefix("**.")
            .or_else(|| raw.strip_prefix("*."))
            .unwrap_or(raw);
        if host.contains("**") {
            return Err(concat(&[
                &"unsupported repeated wildcard: ".into(),
                original,
            ]));
        }
        if host.contains('[') || host.contains(']') {
            let close = if host.starts_with('[') {
                host.find(']')
            } else {
                None
            };
            let ip = close.map_or("", |close| &host[1..close]);
            let suffix = close.map_or("", |close| &host[close + 1..]);
            let normalized = normalize_dns_host_or_ip_literal(ip);
            let unscoped = normalized.split('%').next().unwrap_or("").to_owned();
            let valid = close.is_some()
                && !ip.contains(['[', ']'])
                && (normalized == "*" || strict_ip(&unscoped) == 6)
                && !suffix.contains(['[', ']'])
                && (suffix.chars().all(|character| character == '.') || suffix.starts_with(':'));
            if !valid {
                return Err(concat(&[
                    &"brackets are only supported for IPv6 literals or [*]: ".into(),
                    original,
                ]));
            }
        }
        for candidate in expand_domain_pattern(&normalize_pattern(pattern)) {
            if seen.contains(&candidate) {
                continue;
            }
            seen.push(candidate.clone());
            if candidate.is_empty() {
                return Err("domain pattern is empty".into());
            }
            compiled.push(candidate.into_bytes());
        }
    }
    Ok(DomainPatternSet(compiled))
}

fn non_public_ipv4(octets: [u8; 4]) -> bool {
    let value = u32::from_be_bytes(octets);
    let in_cidr = |base: [u8; 4], prefix: u32| {
        let mask = if prefix == 0 {
            0
        } else {
            u32::MAX << (32 - prefix)
        };
        (value & mask) == (u32::from_be_bytes(base) & mask)
    };
    in_cidr([127, 0, 0, 0], 8)
        || in_cidr([10, 0, 0, 0], 8)
        || in_cidr([172, 16, 0, 0], 12)
        || in_cidr([192, 168, 0, 0], 16)
        || in_cidr([169, 254, 0, 0], 16)
        || in_cidr([224, 0, 0, 0], 4)
        || in_cidr([255, 255, 255, 255], 32)
        || in_cidr([0, 0, 0, 0], 8)
        || in_cidr([100, 64, 0, 0], 10)
        || in_cidr([192, 0, 0, 0], 24)
        || in_cidr([192, 0, 2, 0], 24)
        || in_cidr([198, 18, 0, 0], 15)
        || in_cidr([198, 51, 100, 0], 24)
        || in_cidr([203, 0, 113, 0], 24)
        || in_cidr([240, 0, 0, 0], 4)
}
pub fn is_non_public_ip(ip: &str) -> bool {
    match ip.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) if !ip.contains('%') => non_public_ipv4(address.octets()),
        Ok(IpAddr::V6(address)) if !ip.contains('%') => {
            let bytes = address.octets();
            let zero_prefix = bytes[..10].iter().all(|byte| *byte == 0);
            let embedded = zero_prefix
                && ((bytes[10] == 0 && bytes[11] == 0) || (bytes[10] == 0xff && bytes[11] == 0xff));
            let loopback = bytes[..15].iter().all(|byte| *byte == 0) && bytes[15] == 1;
            if embedded {
                return non_public_ipv4([bytes[12], bytes[13], bytes[14], bytes[15]]) || loopback;
            }
            loopback
                || bytes.iter().all(|byte| *byte == 0)
                || bytes[0] == 0xff
                || (bytes[0] & 0xfe) == 0xfc
                || (bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80)
        }
        _ => false,
    }
}
fn is_loopback_host(host: &str) -> bool {
    let candidate = unscoped_ip_literal(host).unwrap_or_else(|| host.to_owned());
    if candidate == "localhost" {
        return true;
    }
    match candidate.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => address.octets()[0] == 127,
        Ok(IpAddr::V6(address)) => {
            let bytes = address.octets();
            bytes[..15].iter().all(|byte| *byte == 0) && bytes[15] == 1
        }
        Err(_) => false,
    }
}

fn domain_entries(
    config: &RemoteNetworkProxyConfig,
    permission: DomainPermission,
) -> Vec<LosslessString> {
    let mut entries = JsonObject::new();
    for (key, value) in config.domains.iter().flatten() {
        entries.insert(key.clone(), Value::Bool(*value == permission));
    }
    entries
        .iter()
        .filter(|(_, value)| matches!(value, Value::Bool(true)))
        .map(|(key, _)| key.clone())
        .collect()
}
pub fn allowed_unix_sockets(config: &RemoteNetworkProxyConfig) -> Vec<LosslessString> {
    let mut entries = JsonObject::new();
    for (key, value) in config.unix_sockets.iter().flatten() {
        entries.insert(
            key.clone(),
            Value::Bool(*value == UnixSocketPermission::Allow),
        );
    }
    let mut sockets = entries
        .iter()
        .filter(|(_, value)| matches!(value, Value::Bool(true)))
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>();
    sockets.sort();
    sockets
}

pub struct HostPolicyEvaluation {
    pub decision: NetworkDecision,
    pub event: NetworkPolicyAuditEvent,
}
#[derive(Clone)]
pub struct HostPolicy {
    allowed_domains: Vec<LosslessString>,
    deny_set: DomainPatternSet,
    allow_set: DomainPatternSet,
    review_set: DomainPatternSet,
    allow_local_binding: bool,
    lookup: DnsLookup,
}

pub fn default_lookup() -> DnsLookup {
    Arc::new(|host: String, port: u16| {
        Box::pin(async move {
            tokio::net::lookup_host((host.as_str(), port))
                .await
                .map(|addresses| addresses.map(|address| address.ip().to_string()).collect())
                .map_err(|_| ())
        })
    })
}

impl HostPolicy {
    pub fn new(
        config: &RemoteNetworkProxyConfig,
        lookup: Option<DnsLookup>,
        platform: Platform,
    ) -> Result<Self, LosslessString> {
        for (index, socket) in allowed_unix_sockets(config).iter().enumerate() {
            let socket = String::from_utf16_lossy(&socket.code_units().collect::<Vec<_>>());
            let absolute = if platform == Platform::Windows {
                super::policy::is_absolute(&socket)
            } else {
                socket.starts_with('/')
            };
            if !absolute || socket.contains('\0') {
                return Err(format!(
                    "invalid network.allow_unix_sockets[{index}]: expected a NUL-free absolute path"
                )
                .into());
            }
        }
        let allowed_domains = domain_entries(config, DomainPermission::Allow);
        Ok(Self {
            deny_set: compile_domain_patterns(
                &domain_entries(config, DomainPermission::Deny),
                true,
            )?,
            allow_set: compile_domain_patterns(&allowed_domains, false)?,
            review_set: compile_domain_patterns(&config.review_domains, false)?,
            allowed_domains,
            allow_local_binding: config.allow_local_binding,
            lookup: lookup.unwrap_or_else(default_lookup),
        })
    }
    fn matches(set: &DomainPatternSet, host: &str) -> bool {
        set.is_match(host)
            || unscoped_ip_literal(host).is_some_and(|unscoped| set.is_match(&unscoped))
    }
    fn explicit_local_allowlisted(&self, host: &str) -> bool {
        let unscoped = unscoped_ip_literal(host);
        self.allowed_domains.iter().any(|entry| {
            let entry = String::from_utf16_lossy(&entry.code_units().collect::<Vec<_>>());
            let pattern = entry.trim_matches(js_whitespace);
            if pattern == "*"
                || pattern.starts_with("*.")
                || pattern.starts_with("**.")
                || pattern.contains('*')
                || pattern.contains('?')
            {
                return false;
            }
            let normalized = normalize_host(pattern);
            normalized == host || unscoped.as_deref() == Some(normalized.as_str())
        })
    }
    async fn resolves_to_non_public_ip(&self, host: &str, port: u16) -> bool {
        if strict_ip(host) != 0 {
            return is_non_public_ip(host);
        }
        match tokio::time::timeout(DNS_LOOKUP_TIMEOUT, (self.lookup)(host.to_owned(), port)).await {
            Ok(Ok(addresses)) => addresses.iter().any(|address| is_non_public_ip(address)),
            _ => true,
        }
    }
    pub async fn host_blocked(&self, input: &str, port: u16, approved: bool) -> HostBlockDecision {
        let host = normalize_host(input);
        if host.is_empty() {
            return HostBlockDecision::NotAllowed;
        }
        if Self::matches(&self.deny_set, &host) {
            return HostBlockDecision::Denied;
        }
        let authorized = approved
            || (!Self::matches(&self.review_set, &host) && Self::matches(&self.allow_set, &host));
        if !self.allow_local_binding {
            let unscoped = unscoped_ip_literal(&host).unwrap_or_else(|| host.clone());
            let local_literal = is_loopback_host(&host)
                || (strict_ip(&unscoped) != 0 && is_non_public_ip(&unscoped));
            if local_literal {
                if !self.explicit_local_allowlisted(&host) {
                    return HostBlockDecision::NotAllowedLocal;
                }
            } else if authorized && self.resolves_to_non_public_ip(&host, port).await {
                return HostBlockDecision::NotAllowedLocal;
            }
        }
        if authorized {
            HostBlockDecision::Allowed
        } else {
            HostBlockDecision::NotAllowed
        }
    }
    pub async fn evaluate(
        &self,
        request: &NetworkPolicyRequest,
        decider: Option<&NetworkPolicyDecider>,
        method: Option<&LosslessString>,
        client: Option<&LosslessString>,
    ) -> HostPolicyEvaluation {
        let event = |decision: &'static str,
                     source: DecisionSource,
                     reason: LosslessString,
                     policy_override: bool| NetworkPolicyAuditEvent {
            timestamp: iso_timestamp().into(),
            decision,
            source,
            reason,
            protocol: request.protocol,
            host: request.host.clone().into(),
            port: request.port,
            method: method.cloned(),
            client: client.cloned(),
            policy_override,
        };
        let blocked = self.host_blocked(&request.host, request.port, false).await;
        if blocked == HostBlockDecision::Allowed {
            return HostPolicyEvaluation {
                decision: NetworkDecision::Allow,
                event: event(
                    "allow",
                    DecisionSource::BaselinePolicy,
                    "allow".into(),
                    false,
                ),
            };
        }
        let Some(decider) = decider.filter(|_| blocked == HostBlockDecision::NotAllowed) else {
            return HostPolicyEvaluation {
                decision: NetworkDecision::Deny(blocked.reason().into()),
                event: event(
                    "deny",
                    DecisionSource::BaselinePolicy,
                    blocked.reason().into(),
                    false,
                ),
            };
        };
        let decided = decider(request.clone())
            .await
            .unwrap_or_else(|_| NetworkDecision::Deny(REASON_NOT_ALLOWED.into()));
        let (kind, reason) = match decided {
            NetworkDecision::Allow => ("allow", LosslessString::default()),
            NetworkDecision::Deny(reason) => ("deny", reason),
            NetworkDecision::Ask(reason) => ("ask", reason),
        };
        if kind != "allow" {
            let reason = if reason.is_empty() {
                REASON_POLICY_DENIED.into()
            } else {
                reason
            };
            let decision = if kind == "ask" {
                NetworkDecision::Ask(reason.clone())
            } else {
                NetworkDecision::Deny(reason.clone())
            };
            return HostPolicyEvaluation {
                decision,
                event: event(kind, DecisionSource::Decider, reason, false),
            };
        }
        let approved = self.host_blocked(&request.host, request.port, true).await;
        if approved != HostBlockDecision::Allowed {
            return HostPolicyEvaluation {
                decision: NetworkDecision::Deny(approved.reason().into()),
                event: event(
                    "deny",
                    DecisionSource::BaselinePolicy,
                    approved.reason().into(),
                    false,
                ),
            };
        }
        HostPolicyEvaluation {
            decision: NetworkDecision::Allow,
            event: event(
                "allow",
                DecisionSource::Decider,
                REASON_NOT_ALLOWED.into(),
                true,
            ),
        }
    }
}
fn iso_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = now.as_secs() as i64;
    let millis = now.subsec_millis();
    let days = seconds.div_euclid(86_400);
    let remainder = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        remainder / 3600,
        (remainder % 3600) / 60,
        remainder % 60
    )
}
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn env_get<'a>(
    env: &'a [(LosslessString, LosslessString)],
    key: &str,
) -> Option<&'a LosslessString> {
    env.iter()
        .rev()
        .find(|(name, _)| name == &LosslessString::from(key))
        .map(|(_, value)| value)
}
fn env_set(env: &mut Vec<(LosslessString, LosslessString)>, key: &str, value: LosslessString) {
    if let Some((_, existing)) = env
        .iter_mut()
        .find(|(name, _)| name == &LosslessString::from(key))
    {
        *existing = value;
    } else {
        env.push((key.into(), value));
    }
}
fn ordered_environment(
    env: &[(LosslessString, LosslessString)],
) -> Vec<(LosslessString, LosslessString)> {
    let mut object = JsonObject::new();
    for (key, value) in env {
        object.insert(key.clone(), Value::String(value.clone()));
    }
    object
        .iter()
        .filter_map(|(key, value)| match value {
            Value::String(value) => Some((key.clone(), value.clone())),
            _ => None,
        })
        .collect()
}
fn apply_proxy_env(
    env: &mut Vec<(LosslessString, LosslessString)>,
    http_port: u16,
    socks_port: Option<u16>,
    allow_local_binding: bool,
    platform: Platform,
) {
    let http_url = format!("http://127.0.0.1:{http_port}");
    let mut set = |keys: &[&str], value: &str| {
        for key in keys {
            env_set(env, key, value.into());
        }
    };
    set(&[PROXY_ACTIVE_ENV_KEY], "1");
    set(
        &[ALLOW_LOCAL_BINDING_ENV_KEY],
        if allow_local_binding { "1" } else { "0" },
    );
    set(&HTTP_PROXY_ENV_KEYS, &http_url);
    set(&WEBSOCKET_PROXY_ENV_KEYS, &http_url);
    set(
        &NO_PROXY_ENV_KEYS,
        if allow_local_binding {
            DEFAULT_NO_PROXY_VALUE
        } else {
            ""
        },
    );
    set(&["ELECTRON_GET_USE_PROXY"], "true");
    set(&["NODE_USE_ENV_PROXY"], "1");
    let Some(socks_port) = socks_port else {
        set(&ALL_PROXY_ENV_KEYS, &http_url);
        set(&FTP_PROXY_ENV_KEYS, &http_url);
        return;
    };
    let socks_url = format!("socks5h://127.0.0.1:{socks_port}");
    set(&ALL_PROXY_ENV_KEYS, &socks_url);
    set(&FTP_PROXY_ENV_KEYS, &socks_url);
    let existing = env_get(env, GIT_SSH_COMMAND_ENV_KEY);
    let injected = existing
        .and_then(LosslessString::as_str)
        .is_some_and(|value| {
            value.starts_with(GIT_SSH_COMMAND_PREFIX) && value.ends_with(GIT_SSH_COMMAND_SUFFIX)
        });
    if platform == Platform::Darwin && (existing.is_none() || injected) {
        env_set(
            env,
            GIT_SSH_COMMAND_ENV_KEY,
            format!("{GIT_SSH_COMMAND_PREFIX}127.0.0.1:{socks_port}{GIT_SSH_COMMAND_SUFFIX}")
                .into(),
        );
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManagedNetworkSandboxContext {
    pub loopback_ports: Vec<u16>,
    pub allow_local_binding: bool,
    pub allow_unix_sockets: Vec<LosslessString>,
    pub dangerously_allow_all_unix_sockets: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetworkProxyCommand {
    pub argv: Vec<LosslessString>,
    pub arg0: Option<LosslessString>,
    pub shell_snapshot_shell_name: Option<(LosslessString, LosslessString)>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialMaskingState {
    Disabled,
    Enabled,
    Snapshot,
    Unavailable,
}
pub const CREDENTIAL_MASKING_UNAVAILABLE_WARNING: &str = "Credential masking is unavailable for this shell startup; preserving shell profiles and snapshots and running with unmasked credentials.";

fn masking_startup(
    command: Option<&NetworkProxyCommand>,
    env: &[(LosslessString, LosslessString)],
    platform: Platform,
) -> CredentialMaskingState {
    let Some(command) = command.filter(|command| command.arg0.is_none() && command.argv.len() == 3)
    else {
        return CredentialMaskingState::Unavailable;
    };
    if !matches!(platform, Platform::Linux | Platform::Darwin) {
        return CredentialMaskingState::Unavailable;
    }
    let program = &command.argv[0];
    let basename = LosslessString::from_utf16(
        program
            .code_units()
            .collect::<Vec<_>>()
            .rsplit(|unit| *unit == 47)
            .next()
            .unwrap_or_default()
            .to_vec(),
    );
    if let Some((name, path)) = &command.shell_snapshot_shell_name {
        if name == &LosslessString::from("zsh")
            && program == path
            && basename == LosslessString::from("zsh")
            && command.argv[1] == LosslessString::from("-lc")
        {
            return CredentialMaskingState::Snapshot;
        }
    } else if basename == LosslessString::from("bash")
        && command.argv[1] == LosslessString::from("-c")
        && !["BASH_ENV", "ENV", "SSH_CLIENT", "SSH2_CLIENT"]
            .iter()
            .any(|key| env_get(env, key).is_some())
    {
        return CredentialMaskingState::Enabled;
    }
    CredentialMaskingState::Unavailable
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetworkProxyError {
    pub code: i32,
    pub message: LosslessString,
}
impl From<NetworkProxyError> for ExecutorError {
    fn from(error: NetworkProxyError) -> Self {
        ExecutorError::new(error.code, error.message)
    }
}

pub struct StartNetworkProxyOptions {
    pub process_id: LosslessString,
    pub launch: RemoteNetworkProxyLaunchConfig,
    pub env: Vec<(LosslessString, LosslessString)>,
    pub authorize: AuthorizeFn,
    pub decider: Option<NetworkPolicyDecider>,
    pub on_policy_decision: Option<PolicyDecisionListener>,
    pub ca_directory: Option<std::path::PathBuf>,
    pub upstream_trust: Option<NetworkProxyUpstreamTrust>,
    pub(crate) credential_brokers: Option<Arc<Mutex<CredentialBrokerCache>>>,
    pub command: Option<NetworkProxyCommand>,
    pub lookup: Option<DnsLookup>,
    pub platform: Platform,
}

#[derive(Clone)]
pub struct NetworkProxyUpstreamTrust {
    pub authority: Arc<MitmAuthority>,
    pub roots: rustls::RootCertStore,
    pub certificates_pem: Vec<String>,
    pub startup_values: Vec<(LosslessString, LosslessString)>,
}

struct Shared {
    process_id: LosslessString,
    mode: NetworkMode,
    policy: HostPolicy,
    decider: Option<NetworkPolicyDecider>,
    on_decision: Option<PolicyDecisionListener>,
    authorize: AuthorizeFn,
    broker: Option<Arc<CredentialBrokerEntry>>,
    authority: Option<Arc<MitmAuthority>>,
    upstream_tls: Option<Arc<UpstreamTlsConnector>>,
    closed: AtomicBool,
    shutdown: Signal,
    grants: Mutex<Vec<Arc<Grant>>>,
    active: AtomicUsize,
    idle: Notify,
    workers: Mutex<tokio::task::JoinSet<()>>,
    releases: Mutex<tokio::task::JoinSet<()>>,
}
impl Shared {
    fn emit(&self, event: NetworkPolicyAuditEvent) {
        if let Some(listener) = &self.on_decision {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(event)));
        }
    }
    fn release_grant(self: &Arc<Self>, grant: Arc<Grant>) {
        let shared = self.clone();
        let mut releases = self
            .releases
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        while let Some(result) = releases.try_join_next() {
            if result.is_err() {
                tracing::warn!("CCA proxy grant release task failed");
            }
        }
        releases.spawn(async move {
            let _ = grant.release().await;
            shared
                .grants
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .retain(|held| !Arc::ptr_eq(held, &grant));
        });
    }
    async fn admit(
        self: &Arc<Self>,
        request: NetworkPolicyRequest,
        method: &str,
        client: Option<&str>,
        resource: String,
        guard: Option<&'static str>,
    ) -> Result<Arc<Grant>, LosslessString> {
        let evaluation = self
            .policy
            .evaluate(
                &request,
                self.decider.as_ref(),
                Some(&method.into()),
                client.map(LosslessString::from).as_ref(),
            )
            .await;
        if !matches!(evaluation.decision, NetworkDecision::Allow) {
            self.emit(evaluation.event);
            return Err(match evaluation.decision {
                NetworkDecision::Deny(reason) | NetworkDecision::Ask(reason) => reason,
                NetworkDecision::Allow => unreachable!("allow handled above"),
            });
        }
        if let Some(guarded) = guard {
            self.emit(evaluation.event.clone());
            let mut denied = evaluation.event;
            denied.decision = "deny";
            denied.source = DecisionSource::ModeGuard;
            denied.reason = guarded.into();
            denied.policy_override = false;
            self.emit(denied);
            return Err(guarded.into());
        }
        let mut metadata = JsonObject::new();
        metadata.insert("processId".into(), Value::String(self.process_id.clone()));
        metadata.insert(
            "networkProtocol".into(),
            Value::String(request.protocol.as_str().into()),
        );
        metadata.insert("networkMethod".into(), Value::String(method.into()));
        let mut input = AuthorizationInput::new("webfetch", vec![resource.into()]);
        input.metadata = Some(metadata);
        let grant = (self.authorize)(input).await.ok();
        let denied = |event: NetworkPolicyAuditEvent| NetworkPolicyAuditEvent {
            decision: "deny",
            source: DecisionSource::ProxyState,
            reason: REASON_POLICY_DENIED.into(),
            policy_override: false,
            ..event
        };
        match grant {
            Some(grant) if !self.closed.load(Ordering::Acquire) => {
                let grant = Arc::new(grant);
                self.grants
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .push(grant.clone());
                self.emit(evaluation.event);
                Ok(grant)
            }
            Some(grant) => {
                self.release_grant(Arc::new(grant));
                self.emit(denied(evaluation.event));
                Err(REASON_POLICY_DENIED.into())
            }
            None => {
                self.emit(denied(evaluation.event));
                Err(REASON_POLICY_DENIED.into())
            }
        }
    }
    fn begin(self: &Arc<Self>) -> ActiveGuard {
        self.active.fetch_add(1, Ordering::AcqRel);
        ActiveGuard(self.clone())
    }
}
struct ActiveGuard(Arc<Shared>);
impl Drop for ActiveGuard {
    fn drop(&mut self) {
        if self.0.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.idle.notify_waiters();
        }
    }
}

fn text_response(status: u16, status_text: &str, body: &str, headers: &[String]) -> String {
    let mut lines = vec![
        format!("HTTP/1.1 {status} {status_text}"),
        "content-type: text/plain".to_owned(),
    ];
    lines.extend(headers.iter().cloned());
    lines.push(format!("content-length: {}", body.len()));
    lines.push("connection: close".to_owned());
    lines.push(String::new());
    lines.push(body.to_owned());
    lines.join("\r\n")
}
fn blocked_response(reason: &str) -> String {
    let (header, message) = match reason {
        REASON_NOT_ALLOWED => ("blocked-by-allowlist", "Domain not in allowlist."),
        REASON_NOT_ALLOWED_LOCAL => (
            "blocked-by-allowlist",
            "Sandbox policy blocks local/private network addresses.",
        ),
        REASON_DENIED => (
            "blocked-by-denylist",
            "Domain denied by the sandbox policy.",
        ),
        REASON_METHOD_NOT_ALLOWED => (
            "blocked-by-method-policy",
            "Method not allowed in limited mode.",
        ),
        REASON_MITM_REQUIRED => (
            "blocked-by-mitm-required",
            "MITM required for limited HTTPS.",
        ),
        _ => ("blocked-by-policy", "Request blocked by network policy."),
    };
    text_response(
        403,
        "Forbidden",
        message,
        &[format!("x-proxy-error: {header}")],
    )
}

const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authorization",
    "proxy-authenticate",
    "te",
    "trailer",
    "upgrade",
];
const SAFE_METHODS: [&str; 3] = ["GET", "HEAD", "OPTIONS"];

fn parse_authority(authority: &str) -> Option<(String, u16)> {
    let (host, port) = if let Some(stripped) = authority.strip_prefix('[') {
        let close = stripped.find(']')?;
        let host = &stripped[..close];
        let port = stripped[close + 1..].strip_prefix(':')?;
        (host, port)
    } else {
        let colon = authority.find(':')?;
        (&authority[..colon], &authority[colon + 1..])
    };
    if host.is_empty() || host.contains([':', '[', ']']) && !authority.starts_with('[') {
        return None;
    }
    if port.is_empty()
        || port.len() > 5
        || !port.chars().all(|character| character.is_ascii_digit())
    {
        return None;
    }
    let port = port.parse::<u32>().ok()?;
    (1..=65_535)
        .contains(&port)
        .then(|| (host.to_owned(), port as u16))
}
fn url_host(host: &str) -> String {
    if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    }
}
fn forwarded_headers(head: &RequestHead) -> Vec<(LosslessString, LosslessString)> {
    let tokens = head
        .headers
        .iter()
        .filter(|(name, _)| header_is(name, "connection"))
        .flat_map(|(_, value)| {
            value
                .as_str()
                .expect("parsed Latin-1 header")
                .split(',')
                .map(|token| ascii_lower(token.trim()))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    head.headers
        .iter()
        .filter(|(name, _)| {
            let name = ascii_lower(name.as_str().expect("parsed Latin-1 header"));
            !HOP_BY_HOP.contains(&name.as_str()) && !tokens.contains(&name)
        })
        .cloned()
        .collect()
}
fn header_is(name: &LosslessString, expected: &str) -> bool {
    name.as_str()
        .is_some_and(|name| name.eq_ignore_ascii_case(expected))
}

async fn forward_opaque(
    shared: &Arc<Shared>,
    mut socket: TcpStream,
    prefix: Vec<u8>,
    host: &str,
    port: u16,
) {
    let Ok(mut upstream) = TcpStream::connect((host, port)).await else {
        return;
    };
    if !prefix.is_empty() && upstream.write_all(&prefix).await.is_err() {
        return;
    }
    tokio::select! {
        _ = tokio::io::copy_bidirectional(&mut socket, &mut upstream) => {}
        _ = shared.shutdown.cancelled() => {}
    }
}

fn tunnel_guard(shared: &Shared, host: &str, port: u16) -> Option<&'static str> {
    if interception::tunnel_mode(shared, host, port) == TunnelMode::Enabled
        && shared.authority.is_none()
    {
        Some(REASON_MITM_REQUIRED)
    } else {
        None
    }
}

async fn handle_connect(
    shared: &Arc<Shared>,
    mut socket: TcpStream,
    head: RequestHead,
    client: Option<String>,
) {
    let target = parse_authority(&head.target);
    let host = target
        .as_ref()
        .map(|(host, _)| normalize_host(host))
        .unwrap_or_default();
    let Some((_, port)) = target.filter(|_| !host.is_empty()) else {
        let _ = socket
            .write_all(text_response(400, "Bad Request", "missing authority", &[]).as_bytes())
            .await;
        return;
    };
    let admitted = shared
        .admit(
            NetworkPolicyRequest {
                protocol: NetworkProtocol::HttpsConnect,
                host: host.clone(),
                port,
            },
            "CONNECT",
            client.as_deref(),
            format!("https://{}:{port}", url_host(&host)),
            tunnel_guard(shared, &host, port),
        )
        .await;
    let grant = match admitted {
        Ok(grant) => grant,
        Err(reason) => {
            let _ = socket
                .write_all(blocked_response(reason.as_str().unwrap_or("")).as_bytes())
                .await;
            return;
        }
    };
    if socket
        .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
        .await
        .is_ok()
    {
        run_tunnel(shared, socket, head.rest, &host, port).await;
    }
    shared.release_grant(grant);
}

async fn handle_plain(
    shared: &Arc<Shared>,
    mut socket: TcpStream,
    head: RequestHead,
    client: Option<String>,
) {
    let host_headers = head
        .headers
        .iter()
        .filter(|(name, _)| header_is(name, "host"))
        .count();
    if host_headers > 1 {
        let _ = socket
            .write_all(text_response(400, "Bad Request", "multiple Host headers", &[]).as_bytes())
            .await;
        return;
    }
    let Ok(url) = url::Url::parse(&head.target) else {
        let _ = socket
            .write_all(text_response(400, "Bad Request", "missing host", &[]).as_bytes())
            .await;
        return;
    };
    if url.scheme() != "http" {
        let _ = socket
            .write_all(text_response(400, "Bad Request", "unsupported scheme", &[]).as_bytes())
            .await;
        return;
    }
    let host = normalize_host(url.host_str().unwrap_or(""));
    if host.is_empty() {
        let _ = socket
            .write_all(text_response(400, "Bad Request", "missing host", &[]).as_bytes())
            .await;
        return;
    }
    let port = url.port().unwrap_or(80);
    let query = url
        .query()
        .map(|query| format!("?{query}"))
        .unwrap_or_default();
    let guard =
        if shared.mode == NetworkMode::Limited && !SAFE_METHODS.contains(&head.method.as_str()) {
            Some(REASON_METHOD_NOT_ALLOWED)
        } else {
            None
        };
    let admitted = shared
        .admit(
            NetworkPolicyRequest {
                protocol: NetworkProtocol::Http,
                host: host.clone(),
                port,
            },
            &head.method,
            client.as_deref(),
            format!("http://{}:{port}{}{query}", url_host(&host), url.path()),
            guard,
        )
        .await;
    let grant = match admitted {
        Ok(grant) => grant,
        Err(reason) => {
            let _ = socket
                .write_all(blocked_response(reason.as_str().unwrap_or("")).as_bytes())
                .await;
            return;
        }
    };
    let mut headers = forwarded_headers(&head);
    if host_headers == 0 {
        let authority = match url.port() {
            Some(port) => format!("{}:{port}", url.host_str().unwrap_or("")),
            None => url.host_str().unwrap_or("").to_owned(),
        };
        headers.insert(0, ("Host".into(), authority.into()));
    }
    if let Some(entry) = &shared.broker {
        headers = entry.broker.restore_request_headers(
            &url,
            &interception::raw_path_of(&head.target),
            &headers,
        );
    }
    match TcpStream::connect((host.as_str(), port)).await {
        Ok(upstream) => {
            let target = format!("{}{query}", url.path());
            forward_request(shared, socket, upstream, &head, &target, &headers).await;
        }
        Err(_) => {
            let _ = socket
                .write_all(
                    text_response(502, "Bad Gateway", "upstream connection failed", &[]).as_bytes(),
                )
                .await;
        }
    }
    shared.release_grant(grant);
}

async fn handle_http(shared: Arc<Shared>, mut socket: TcpStream) {
    let _active = shared.begin();
    let client = socket
        .peer_addr()
        .ok()
        .map(|address| address.ip().to_string());
    let Some(head) = read_request_head(&mut socket).await else {
        let _ = socket
            .write_all(text_response(400, "Bad Request", "invalid request", &[]).as_bytes())
            .await;
        return;
    };
    if head.method == "CONNECT" {
        handle_connect(&shared, socket, head, client).await;
    } else {
        handle_plain(&shared, socket, head, client).await;
    }
}

fn socks_reply(code: u8) -> [u8; 10] {
    [5, code, 0, 1, 0, 0, 0, 0, 0, 0]
}
async fn read_exactly(
    socket: &mut TcpStream,
    buffer: &mut Vec<u8>,
    count: usize,
) -> Option<Vec<u8>> {
    let mut chunk = [0u8; 4096];
    while buffer.len() < count {
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    Some(buffer.drain(..count).collect())
}

async fn handle_socks(shared: Arc<Shared>, mut socket: TcpStream) {
    let _active = shared.begin();
    let mut buffer: Vec<u8> = vec![];
    let Some(greeting) = read_exactly(&mut socket, &mut buffer, 2).await else {
        return;
    };
    if greeting[0] != 5 {
        return;
    }
    let Some(methods) = read_exactly(&mut socket, &mut buffer, greeting[1] as usize).await else {
        return;
    };
    if !methods.contains(&0) {
        let _ = socket.write_all(&[5, 0xff]).await;
        return;
    }
    if socket.write_all(&[5, 0]).await.is_err() {
        return;
    }
    let Some(request) = read_exactly(&mut socket, &mut buffer, 4).await else {
        return;
    };
    if request[0] != 5 {
        return;
    }
    let raw_host = match request[3] {
        1 => {
            let Some(address) = read_exactly(&mut socket, &mut buffer, 4).await else {
                return;
            };
            address
                .iter()
                .map(u8::to_string)
                .collect::<Vec<_>>()
                .join(".")
        }
        3 => {
            let Some(length) = read_exactly(&mut socket, &mut buffer, 1).await else {
                return;
            };
            let Some(name) = read_exactly(&mut socket, &mut buffer, length[0] as usize).await
            else {
                return;
            };
            String::from_utf8_lossy(&name).into_owned()
        }
        4 => {
            let Some(address) = read_exactly(&mut socket, &mut buffer, 16).await else {
                return;
            };
            (0..8)
                .map(|index| {
                    format!(
                        "{:x}",
                        u16::from_be_bytes([address[index * 2], address[index * 2 + 1]])
                    )
                })
                .collect::<Vec<_>>()
                .join(":")
        }
        _ => {
            let _ = socket.write_all(&socks_reply(8)).await;
            return;
        }
    };
    let Some(port_bytes) = read_exactly(&mut socket, &mut buffer, 2).await else {
        return;
    };
    if request[1] != 1 {
        let _ = socket.write_all(&socks_reply(7)).await;
        return;
    }
    let port = u16::from_be_bytes([port_bytes[0], port_bytes[1]]);
    let host = normalize_host(&raw_host);
    if host.is_empty() || port == 0 {
        let _ = socket.write_all(&socks_reply(1)).await;
        return;
    }
    let guard = if shared.mode == NetworkMode::Limited
        && port != 443
        && !interception::protocols_for(&shared, &host, port).http
    {
        Some(REASON_METHOD_NOT_ALLOWED)
    } else {
        tunnel_guard(&shared, &host, port)
    };
    let client = socket
        .peer_addr()
        .ok()
        .map(|address| address.ip().to_string());
    let admitted = shared
        .admit(
            NetworkPolicyRequest {
                protocol: NetworkProtocol::Socks5Tcp,
                host: host.clone(),
                port,
            },
            "CONNECT",
            client.as_deref(),
            format!("socks5h://{}:{port}", url_host(&host)),
            guard,
        )
        .await;
    let grant = match admitted {
        Ok(grant) => grant,
        Err(_) => {
            let _ = socket.write_all(&socks_reply(2)).await;
            return;
        }
    };
    if socket.write_all(&socks_reply(0)).await.is_ok() {
        run_tunnel(&shared, socket, buffer, &host, port).await;
    }
    shared.release_grant(grant);
}

fn spawn_connection(shared: &Arc<Shared>, socket: TcpStream, socks: bool) {
    let owner = shared.clone();
    let mut workers = shared
        .workers
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    while let Some(result) = workers.try_join_next() {
        if result.is_err() {
            tracing::warn!("CCA proxy connection task failed");
        }
    }
    workers.spawn(async move {
        tokio::select! {
            _ = async {
                if socks { handle_socks(owner.clone(), socket).await; }
                else { handle_http(owner.clone(), socket).await; }
            } => {}
            _ = owner.shutdown.cancelled() => {}
        }
    });
}

pub struct NetworkProxyHandle {
    pub env: Vec<(LosslessString, LosslessString)>,
    pub managed_network: ManagedNetworkSandboxContext,
    pub credential_masking: CredentialMaskingState,
    pub warnings: Vec<LosslessString>,
    pub ignored_providers: Vec<LosslessString>,
    pub child_trust: Option<ChildTrustBundle>,
    pub(crate) credential_broker: Option<Arc<CredentialBrokerEntry>>,
    shared: Arc<Shared>,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    close_lock: tokio::sync::Mutex<()>,
}
impl NetworkProxyHandle {
    pub async fn close(&self) {
        let _closing = self.close_lock.lock().await;
        if self.shared.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.shared.shutdown.cancel();
        let tasks =
            std::mem::take(&mut *self.tasks.lock().unwrap_or_else(|error| error.into_inner()));
        for task in &tasks {
            task.abort();
        }
        for task in tasks {
            let _ = task.await;
        }
        let mut workers = std::mem::take(
            &mut *self
                .shared
                .workers
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        while let Some(result) = workers.join_next().await {
            if result.is_err() {
                tracing::warn!("CCA proxy connection task failed");
            }
        }
        let grants = std::mem::take(
            &mut *self
                .shared
                .grants
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        for grant in grants {
            let _ = grant.release().await;
        }
        let mut releases = std::mem::take(
            &mut *self
                .shared
                .releases
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        while let Some(result) = releases.join_next().await {
            if result.is_err() {
                tracing::warn!("CCA proxy grant release task failed");
            }
        }
        loop {
            let idle = self.shared.idle.notified();
            tokio::pin!(idle);
            idle.as_mut().enable();
            if self.shared.active.load(Ordering::Acquire) == 0 {
                break;
            }
            let _ = tokio::time::timeout(Duration::from_secs(5), idle).await;
            if self.shared.active.load(Ordering::Acquire) != 0 {
                break;
            }
        }
    }
}

pub async fn start_network_proxy(
    options: StartNetworkProxyOptions,
) -> Result<NetworkProxyHandle, NetworkProxyError> {
    let proxy = options.launch.proxy.clone();
    let policy = (|| {
        if !proxy.enabled {
            return Err(LosslessString::from(
                "executor-local network proxy launch requires an enabled proxy",
            ));
        }
        HostPolicy::new(&proxy, options.lookup.clone(), options.platform)
    })()
    .map_err(|message| NetworkProxyError {
        code: -32602,
        message: concat(&[&"invalid network proxy config: ".into(), &message]),
    })?;
    let masking_missing = || NetworkProxyError {
        code: -32603,
        message:
            "credential masking requires an explicit broker cache, upstream roots and CA directory"
                .into(),
    };
    let masking_failed = || NetworkProxyError {
        code: -32603,
        message: "failed to build executor network proxy".into(),
    };
    let mut broker = None;
    let mut authority = None;
    let mut upstream_tls = None;
    let mut child_trust = None;
    if proxy.credential_masking {
        let cache = options
            .credential_brokers
            .as_ref()
            .ok_or_else(masking_missing)?;
        let trust = options
            .upstream_trust
            .as_ref()
            .ok_or_else(masking_missing)?;
        let directory = options.ca_directory.as_ref().ok_or_else(masking_missing)?;
        if trust.roots.is_empty() || trust.certificates_pem.is_empty() {
            return Err(masking_missing());
        }
        let key = CredentialBrokerKey {
            environment_id: options.launch.environment_id.clone(),
            conversation_id: options.launch.audit_metadata.conversation_id.clone(),
            providers: proxy.credential_providers.clone(),
        };
        broker = Some(
            cache
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .broker_for(&key)
                .map_err(|_| masking_failed())?,
        );
        upstream_tls = Some(
            upstream_openssl_connector(&trust.certificates_pem).map_err(|_| masking_failed())?,
        );
        child_trust = Some(
            trust
                .authority
                .export_child_trust(directory, &trust.certificates_pem)
                .await
                .map_err(|_| masking_failed())?,
        );
        authority = Some(trust.authority.clone());
    }
    let mut env = ordered_environment(&options.env);
    let mut warnings = vec![];
    let mut credential_masking = CredentialMaskingState::Disabled;
    if let Some(entry) = &broker {
        let masked = entry
            .broker
            .mask_environment(&env)
            .map_err(|_| masking_failed())?;
        credential_masking = masking_startup(options.command.as_ref(), &env, options.platform);
        env = masked.env;
        if credential_masking == CredentialMaskingState::Enabled && !masked.unmasked_keys.is_empty()
        {
            warnings.push(CCA_CREDENTIAL_MASKING_PARTIAL_WARNING.into());
        }
        if credential_masking == CredentialMaskingState::Unavailable {
            warnings.push(CREDENTIAL_MASKING_UNAVAILABLE_WARNING.into());
        }
    }
    let ignored_providers = broker
        .as_ref()
        .map_or_else(Vec::new, |entry| entry.ignored_providers.clone());
    let shared = Arc::new(Shared {
        process_id: options.process_id.clone(),
        mode: proxy.mode,
        policy,
        decider: options.decider.clone(),
        on_decision: options.on_policy_decision.clone(),
        authorize: options.authorize.clone(),
        broker: broker.clone(),
        authority,
        upstream_tls,
        closed: AtomicBool::new(false),
        shutdown: Signal::default(),
        grants: Mutex::new(vec![]),
        active: AtomicUsize::new(0),
        idle: Notify::new(),
        workers: Mutex::new(tokio::task::JoinSet::new()),
        releases: Mutex::new(tokio::task::JoinSet::new()),
    });
    let failed = || NetworkProxyError {
        code: -32603,
        message: "failed to start executor network proxy".into(),
    };
    let http_listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|_| failed())?;
    let http_port = http_listener.local_addr().map_err(|_| failed())?.port();
    let mut socks_port = None;
    let mut socks_listener = None;
    if proxy.enable_socks5 {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|_| failed())?;
        socks_port = Some(listener.local_addr().map_err(|_| failed())?.port());
        socks_listener = Some(listener);
    }
    apply_proxy_env(
        &mut env,
        http_port,
        socks_port,
        proxy.allow_local_binding,
        options.platform,
    );
    if let (Some(bundle), Some(trust)) = (&child_trust, &options.upstream_trust) {
        let bundle_path = bundle.bundle_path.to_str().ok_or_else(masking_failed)?;
        for key in CUSTOM_CA_ENV_KEYS {
            let value = env_get(&env, key);
            let startup = env_get(&trust.startup_values, key);
            if value.is_none_or(|value| {
                value.is_empty()
                    || value == &LosslessString::from(bundle_path)
                    || Some(value) == startup
            }) {
                env_set(&mut env, key, bundle_path.into());
            }
        }
    }
    if let Some(entry) = &broker
        && credential_masking != CredentialMaskingState::Enabled
    {
        env = entry.broker.restore_environment(&env);
    }
    env = ordered_environment(&env);
    let mut tasks = vec![];
    let accept_shared = shared.clone();
    tasks.push(tokio::spawn(async move {
        while let Ok((socket, _)) = http_listener.accept().await {
            spawn_connection(&accept_shared, socket, false);
        }
    }));
    if let Some(listener) = socks_listener {
        let accept_shared = shared.clone();
        tasks.push(tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                spawn_connection(&accept_shared, socket, true);
            }
        }));
    }
    Ok(NetworkProxyHandle {
        env,
        managed_network: ManagedNetworkSandboxContext {
            loopback_ports: socks_port
                .map_or_else(|| vec![http_port], |socks| vec![http_port, socks]),
            allow_local_binding: proxy.allow_local_binding,
            allow_unix_sockets: allowed_unix_sockets(&proxy),
            dangerously_allow_all_unix_sockets: proxy.dangerously_allow_all_unix_sockets,
        },
        credential_masking,
        warnings,
        ignored_providers,
        child_trust,
        credential_broker: if credential_masking == CredentialMaskingState::Snapshot {
            broker
        } else {
            None
        },
        shared,
        tasks: Mutex::new(tasks),
        close_lock: tokio::sync::Mutex::new(()),
    })
}
