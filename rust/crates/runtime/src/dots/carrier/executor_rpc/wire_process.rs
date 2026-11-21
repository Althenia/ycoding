#[cfg(test)]
use super::super::wire::encode_base64;
use super::{
    control::Signal,
    error::{RpcError, echo},
    handler::{CallOptions, Caller},
    json::{self, ObjectBuilder, lossy},
    types::*,
};
use std::time::Duration;
use ycoding_core::ycoding_schema::{JsonObject, JsonValue};

pub const NETWORK_POLICY_REQUEST_METHOD: &str = "network/policyRequest";
pub const NETWORK_POLICY_DECISION_METHOD: &str = "network/policyDecision";
#[cfg(test)]
pub const PROCESS_OUTPUT_METHOD: &str = "process/output";
#[cfg(test)]
pub const PROCESS_EXITED_METHOD: &str = "process/exited";
#[cfg(test)]
pub const PROCESS_CLOSED_METHOD: &str = "process/closed";
pub const MAX_NETWORK_POLICY_HOST_BYTES: usize = 253;
pub const MAX_NETWORK_POLICY_PROCESS_ID_BYTES: usize = 256;
pub const MAX_NETWORK_POLICY_REASON_BYTES: usize = 1024;
pub const NETWORK_POLICY_TRANSPORT_MARGIN_MS: u64 = 5_000;

const PROVIDER_FIELDS: [&str; 7] = [
    "env",
    "patterns",
    "url_prefixes",
    "url_prefix_from_env",
    "auth",
    "header",
    "prefix",
];
const AUDIT_FIELDS: [&str; 9] = [
    "conversationId",
    "appVersion",
    "userAccountId",
    "authMode",
    "originator",
    "userEmail",
    "terminalType",
    "model",
    "slug",
];

fn invalid(message: impl Into<Text>) -> RpcError {
    RpcError::invalid_params(echo("Invalid params: ", &message.into(), ""))
}

fn named(field: &Text, suffix: &str) -> RpcError {
    invalid(echo("", field, suffix))
}

fn field(name: &str) -> Text {
    Text::from(name)
}

fn child(parent: &Text, key: &str) -> Text {
    echo("", parent, &format!(".{key}"))
}

fn join(left: &Text, right: &Text) -> Text {
    let mut units: Vec<u16> = left.code_units().collect();
    units.extend(right.code_units());
    Text::from_utf16(units)
}

fn keyed(parent: &Text, key: &Text) -> Text {
    join(&echo("", parent, "."), key)
}

fn indexed(parent: &Text, index: usize) -> Text {
    echo("", parent, &format!("[{index}]"))
}

fn object<'a>(value: &'a JsonValue, name: &Text) -> Result<&'a JsonObject, RpcError> {
    match value {
        JsonValue::Object(object) => Ok(object),
        _ => Err(named(name, " must be an object")),
    }
}

fn string(value: &JsonValue, name: &Text) -> Result<Text, RpcError> {
    match value {
        JsonValue::String(text) => Ok(text.clone()),
        _ => Err(named(name, " must be a string")),
    }
}

fn boolean(value: Option<&JsonValue>, name: &Text) -> Result<bool, RpcError> {
    match value {
        Some(JsonValue::Bool(flag)) => Ok(*flag),
        _ => Err(named(name, " must be a boolean")),
    }
}

fn optional_string(value: Option<&JsonValue>, name: &Text) -> Result<Option<Text>, RpcError> {
    match value {
        None | Some(JsonValue::Null) => Ok(None),
        Some(value) => string(value, name).map(Some),
    }
}

fn strings(value: &JsonValue, name: &Text) -> Result<Vec<Text>, RpcError> {
    let JsonValue::Array(items) = value else {
        return Err(named(name, " must be a string array"));
    };
    items
        .iter()
        .map(|item| match item {
            JsonValue::String(text) => Ok(text.clone()),
            _ => Err(named(name, " must be a string array")),
        })
        .collect()
}

fn strings_or_empty(value: Option<&JsonValue>, name: &Text) -> Result<Vec<Text>, RpcError> {
    value.map_or(Ok(Vec::new()), |value| strings(value, name))
}

fn one_of<T: Copy>(
    value: Option<&JsonValue>,
    allowed: &[(&str, T)],
    name: &Text,
) -> Result<T, RpcError> {
    if let Some(JsonValue::String(text)) = value {
        let text = lossy(text);
        if let Some((_, matched)) = allowed.iter().find(|(candidate, _)| *candidate == text) {
            return Ok(*matched);
        }
    }
    let names: Vec<&str> = allowed.iter().map(|(candidate, _)| *candidate).collect();
    Err(named(
        name,
        &format!(" must be one of {}", names.join(", ")),
    ))
}

fn permission_map<T: Copy>(
    value: Option<&JsonValue>,
    allowed: &[(&str, T)],
    name: &Text,
) -> Result<Option<Vec<(Text, T)>>, RpcError> {
    let value = match value {
        None | Some(JsonValue::Null) => return Ok(None),
        Some(value) => value,
    };
    let mut entries = Vec::new();
    for (key, item) in object(value, name)?.iter() {
        let permission = one_of(Some(item), allowed, &keyed(name, key))?;
        entries.push((key.clone(), permission));
    }
    Ok(Some(entries))
}

fn provider(value: &JsonValue, name: &Text) -> Result<CredentialProviderConfig, RpcError> {
    let raw = object(value, name)?;
    for (key, _) in raw.iter() {
        if !PROVIDER_FIELDS.contains(&lossy(key).as_str()) {
            return Err(invalid(join(&echo("", name, " has unknown field "), key)));
        }
    }
    let url_prefix_from_env = optional_string(
        json::get(raw, "url_prefix_from_env"),
        &child(name, "url_prefix_from_env"),
    )?;
    let header = optional_string(json::get(raw, "header"), &child(name, "header"))?;
    let prefix = optional_string(json::get(raw, "prefix"), &child(name, "prefix"))?;
    let env = strings_or_empty(json::get(raw, "env"), &child(name, "env"))?;
    let patterns = strings_or_empty(json::get(raw, "patterns"), &child(name, "patterns"))?;
    let url_prefixes =
        strings_or_empty(json::get(raw, "url_prefixes"), &child(name, "url_prefixes"))?;
    let auth = match json::get(raw, "auth") {
        None => Vec::new(),
        Some(JsonValue::Array(items)) => {
            let methods = [
                ("bearer", CredentialAuthMethod::Bearer),
                ("token", CredentialAuthMethod::Token),
                ("basic", CredentialAuthMethod::Basic),
                ("header", CredentialAuthMethod::Header),
            ];
            let auth_name = child(name, "auth");
            let mut auth = Vec::new();
            for (index, item) in items.iter().enumerate() {
                auth.push(one_of(Some(item), &methods, &indexed(&auth_name, index))?);
            }
            auth
        }
        Some(_) => return Err(named(&child(name, "auth"), " must be an array")),
    };
    Ok(CredentialProviderConfig {
        env,
        patterns,
        url_prefixes,
        url_prefix_from_env,
        auth,
        header,
        prefix,
    })
}

fn proxy_config(value: Option<&JsonValue>) -> Result<NetworkProxyConfig, RpcError> {
    let root = field("networkProxy.proxy");
    let raw = match value {
        Some(value) => object(value, &root)?,
        None => return Err(named(&root, " must be an object")),
    };
    let credential_masking = match json::get(raw, "credentialMasking") {
        None => false,
        Some(value) => boolean(Some(value), &child(&root, "credentialMasking"))?,
    };
    let providers = match json::get(raw, "credentialProviders") {
        None => Vec::new(),
        Some(value) => {
            let name = child(&root, "credentialProviders");
            let mut providers = Vec::new();
            for (id, item) in object(value, &name)?.iter() {
                let config = provider(item, &keyed(&name, id))?;
                providers.push((id.clone(), config));
            }
            providers
        }
    };
    let domains = permission_map(
        json::get(raw, "domains"),
        &[
            ("none", DomainPermission::None),
            ("allow", DomainPermission::Allow),
            ("deny", DomainPermission::Deny),
        ],
        &child(&root, "domains"),
    )?;
    let unix_sockets = permission_map(
        json::get(raw, "unixSockets"),
        &[
            ("allow", UnixSocketPermission::Allow),
            ("deny", UnixSocketPermission::Deny),
        ],
        &child(&root, "unixSockets"),
    )?;
    let enabled = boolean(json::get(raw, "enabled"), &child(&root, "enabled"))?;
    let enable_socks5 = boolean(
        json::get(raw, "enableSocks5"),
        &child(&root, "enableSocks5"),
    )?;
    let enable_socks5_udp = boolean(
        json::get(raw, "enableSocks5Udp"),
        &child(&root, "enableSocks5Udp"),
    )?;
    let allow_upstream_proxy = boolean(
        json::get(raw, "allowUpstreamProxy"),
        &child(&root, "allowUpstreamProxy"),
    )?;
    let dangerously_allow_all_unix_sockets = boolean(
        json::get(raw, "dangerouslyAllowAllUnixSockets"),
        &child(&root, "dangerouslyAllowAllUnixSockets"),
    )?;
    let mode = one_of(
        json::get(raw, "mode"),
        &[
            ("limited", NetworkMode::Limited),
            ("full", NetworkMode::Full),
        ],
        &child(&root, "mode"),
    )?;
    let review_domains = strings_or_empty(
        json::get(raw, "reviewDomains"),
        &child(&root, "reviewDomains"),
    )?;
    let allow_local_binding = boolean(
        json::get(raw, "allowLocalBinding"),
        &child(&root, "allowLocalBinding"),
    )?;
    Ok(NetworkProxyConfig {
        enabled,
        credential_masking,
        credential_providers: if credential_masking {
            providers
        } else {
            Vec::new()
        },
        enable_socks5,
        enable_socks5_udp,
        allow_upstream_proxy,
        dangerously_allow_all_unix_sockets,
        mode,
        domains,
        review_domains,
        unix_sockets,
        allow_local_binding,
    })
}

fn launch_config(
    value: &JsonValue,
    process_id: &Text,
) -> Result<NetworkProxyLaunchConfig, RpcError> {
    let root = field("networkProxy");
    let raw = object(value, &root)?;
    let audit_name = child(&root, "auditMetadata");
    let audit_raw = match json::get(raw, "auditMetadata") {
        None => None,
        Some(value) => Some(object(value, &audit_name)?),
    };
    let mut audit = NetworkProxyAuditMetadata::default();
    for key in AUDIT_FIELDS {
        let item = audit_raw.and_then(|audit_raw| json::get(audit_raw, key));
        let item = optional_string(item, &child(&audit_name, key))?;
        match key {
            "conversationId" => audit.conversation_id = item,
            "appVersion" => audit.app_version = item,
            "userAccountId" => audit.user_account_id = item,
            "authMode" => audit.auth_mode = item,
            "originator" => audit.originator = item,
            "userEmail" => audit.user_email = item,
            "terminalType" => audit.terminal_type = item,
            "model" => audit.model = item,
            _ => audit.slug = item,
        }
    }
    let environment_id = optional_string(
        json::get(raw, "environmentId"),
        &child(&root, "environmentId"),
    )?;
    let execution_id =
        optional_string(json::get(raw, "executionId"), &child(&root, "executionId"))?;
    let timeout = match json::get(raw, "policyDecisionTimeoutMs") {
        None | Some(JsonValue::Null) => None,
        Some(JsonValue::Number(number)) if json::is_safe_integer(*number) && *number >= 0.0 => {
            Some(*number as u64)
        }
        Some(_) => {
            return Err(named(
                &child(&root, "policyDecisionTimeoutMs"),
                " must be a non-negative integer",
            ));
        }
    };
    if timeout == Some(0) {
        return Err(invalid(
            "network policy decision callback timeout must be nonzero",
        ));
    }
    if timeout.is_some()
        && (process_id.is_empty() || lossy(process_id).len() > MAX_NETWORK_POLICY_PROCESS_ID_BYTES)
    {
        return Err(invalid(format!(
            "callback-enabled process ID must be non-empty and at most {MAX_NETWORK_POLICY_PROCESS_ID_BYTES} bytes"
        )));
    }
    Ok(NetworkProxyLaunchConfig {
        proxy: proxy_config(json::get(raw, "proxy"))?,
        audit_metadata: audit,
        environment_id,
        execution_id,
        policy_decision_timeout_ms: timeout,
    })
}

fn shell_snapshot(value: &JsonValue) -> Result<ShellSnapshotRequest, RpcError> {
    let null = JsonValue::Null;
    let root = field("shellSnapshot");
    let raw = object(value, &root)?;
    let scope_id = string(
        json::get(raw, "scopeId").unwrap_or(&null),
        &child(&root, "scopeId"),
    )?;
    let shell_name = child(&root, "shell");
    let shell = object(json::get(raw, "shell").unwrap_or(&null), &shell_name)?;
    Ok(ShellSnapshotRequest {
        scope_id,
        shell: ShellInfo {
            name: string(
                json::get(shell, "name").unwrap_or(&null),
                &child(&shell_name, "name"),
            )?,
            path: string(
                json::get(shell, "path").unwrap_or(&null),
                &child(&shell_name, "path"),
            )?,
        },
    })
}

pub struct ProcessStartExtensions {
    pub network_proxy: Option<NetworkProxyLaunchConfig>,
    pub shell_snapshot: Option<ShellSnapshotRequest>,
}

pub fn decode_start_extensions(
    process_id: &Text,
    network_proxy: Option<&JsonValue>,
    snapshot: Option<&JsonValue>,
) -> Result<ProcessStartExtensions, RpcError> {
    let network_proxy = match network_proxy {
        None | Some(JsonValue::Null) => None,
        Some(value) => Some(launch_config(value, process_id)?),
    };
    let shell_snapshot = match snapshot {
        None | Some(JsonValue::Null) => None,
        Some(value) => Some(shell_snapshot(value)?),
    };
    Ok(ProcessStartExtensions {
        network_proxy,
        shell_snapshot,
    })
}

#[cfg(test)]
pub fn encode_process_event(event: &ProcessEvent) -> (&'static str, JsonValue) {
    match event {
        ProcessEvent::Output {
            process_id,
            seq,
            stream,
            chunk,
        } => (
            PROCESS_OUTPUT_METHOD,
            ObjectBuilder::new()
                .field("processId", json::lossless(process_id))
                .field("seq", json::uint(*seq))
                .field("stream", json::text(stream.name()))
                .field("chunk", json::text(&encode_base64(chunk)))
                .finish(),
        ),
        ProcessEvent::Exited {
            process_id,
            seq,
            exit_code,
            sandbox_denied,
        } => (
            PROCESS_EXITED_METHOD,
            ObjectBuilder::new()
                .field("processId", json::lossless(process_id))
                .field("seq", json::uint(*seq))
                .field("exitCode", exit_code.map_or(JsonValue::Null, json::int))
                .field("sandboxDenied", JsonValue::Bool(*sandbox_denied))
                .finish(),
        ),
        ProcessEvent::Closed { process_id, seq } => (
            PROCESS_CLOSED_METHOD,
            ObjectBuilder::new()
                .field("processId", json::lossless(process_id))
                .field("seq", json::uint(*seq))
                .finish(),
        ),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NetworkProtocol {
    Http,
    HttpsConnect,
    Socks5Tcp,
    Socks5Udp,
}

impl NetworkProtocol {
    pub fn name(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::HttpsConnect => "https_connect",
            Self::Socks5Tcp => "socks5_tcp",
            Self::Socks5Udp => "socks5_udp",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NetworkPolicyRequest {
    pub protocol: NetworkProtocol,
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NetworkDecision {
    Allow,
    Deny { reason: Text },
    Ask { reason: Text },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DecisionSource {
    BaselinePolicy,
    ModeGuard,
    ProxyState,
    Decider,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuditDecision {
    Allow,
    Deny,
    Ask,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NetworkPolicyAuditEvent {
    pub timestamp: Text,
    pub decision: AuditDecision,
    pub source: DecisionSource,
    pub reason: Text,
    pub protocol: NetworkProtocol,
    pub host: Text,
    pub port: u16,
    pub method: Option<Text>,
    pub client: Option<Text>,
    pub policy_override: bool,
}

pub fn encode_network_policy_request(
    process_id: &Text,
    request: &NetworkPolicyRequest,
) -> JsonValue {
    let inner = ObjectBuilder::new()
        .field("protocol", json::text(request.protocol.name()))
        .field("host", json::text(&request.host))
        .field("port", json::uint(u64::from(request.port)))
        .finish();
    ObjectBuilder::new()
        .field("processId", json::lossless(process_id))
        .field("request", inner)
        .finish()
}

pub fn encode_network_policy_decision(
    process_id: &Text,
    event: &NetworkPolicyAuditEvent,
) -> JsonValue {
    ObjectBuilder::new()
        .field("processId", json::lossless(process_id))
        .field("timestamp", json::lossless(&event.timestamp))
        .field("scope", json::text("domain"))
        .field(
            "decision",
            json::text(match event.decision {
                AuditDecision::Allow => "allow",
                AuditDecision::Deny => "deny",
                AuditDecision::Ask => "ask",
            }),
        )
        .field(
            "source",
            json::text(match event.source {
                DecisionSource::BaselinePolicy => "baseline_policy",
                DecisionSource::ModeGuard => "mode_guard",
                DecisionSource::ProxyState => "proxy_state",
                DecisionSource::Decider => "decider",
            }),
        )
        .field("reason", json::lossless(&event.reason))
        .field("protocol", json::text(event.protocol.name()))
        .field("host", json::lossless(&event.host))
        .field("port", json::uint(u64::from(event.port)))
        .optional("method", event.method.as_ref().map(json::lossless))
        .optional("client", event.client.as_ref().map(json::lossless))
        .field("policyOverride", JsonValue::Bool(event.policy_override))
        .finish()
}

fn not_allowed() -> NetworkDecision {
    NetworkDecision::Deny {
        reason: Text::from("not_allowed"),
    }
}

pub fn decode_network_policy_response(result: &JsonValue) -> NetworkDecision {
    let JsonValue::Object(result) = result else {
        return not_allowed();
    };
    let Some(JsonValue::Object(decision)) = json::get(result, "decision") else {
        return not_allowed();
    };
    let kind = match json::get(decision, "type") {
        Some(JsonValue::String(kind)) => lossy(kind),
        _ => return not_allowed(),
    };
    if kind == "allow" {
        return NetworkDecision::Allow;
    }
    let reason = match json::get(decision, "reason") {
        Some(JsonValue::String(reason)) if kind == "deny" || kind == "ask" => reason.clone(),
        _ => return not_allowed(),
    };
    let measured = lossy(&reason);
    if measured.len() > MAX_NETWORK_POLICY_REASON_BYTES || measured.chars().any(char::is_control) {
        return not_allowed();
    }
    if kind == "deny" {
        NetworkDecision::Deny { reason }
    } else {
        NetworkDecision::Ask { reason }
    }
}

fn is_script_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

pub struct NetworkPolicyDecider {
    process_id: Text,
    timeout: Duration,
    caller: Caller,
    signal: Option<Signal>,
}

impl NetworkPolicyDecider {
    pub fn new(
        process_id: impl Into<Text>,
        controller_timeout_ms: u64,
        caller: Caller,
        signal: Option<Signal>,
        transport_margin_ms: Option<u64>,
    ) -> Self {
        let margin = transport_margin_ms.unwrap_or(NETWORK_POLICY_TRANSPORT_MARGIN_MS);
        Self {
            process_id: process_id.into(),
            timeout: Duration::from_millis(controller_timeout_ms.saturating_add(margin)),
            caller,
            signal,
        }
    }

    pub async fn decide(&self, request: &NetworkPolicyRequest) -> NetworkDecision {
        let host = &request.host;
        if host.is_empty()
            || host.len() > MAX_NETWORK_POLICY_HOST_BYTES
            || host.chars().any(char::is_control)
            || host.chars().any(is_script_whitespace)
            || self.signal.as_ref().is_some_and(Signal::is_aborted)
        {
            return not_allowed();
        }
        let controller = super::control::Abort::new();
        let call = self.caller.call(
            NETWORK_POLICY_REQUEST_METHOD,
            encode_network_policy_request(&self.process_id, request),
            CallOptions {
                timeout: Some(self.timeout),
                signal: Some(controller.signal()),
            },
        );
        let shutdown = async {
            match &self.signal {
                Some(signal) => signal.aborted().await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            result = call => match result {
                Ok(value) => decode_network_policy_response(&value),
                Err(_) => not_allowed(),
            },
            _ = tokio::time::sleep(self.timeout) => {
                controller.abort();
                not_allowed()
            }
            _ = shutdown => {
                controller.abort();
                not_allowed()
            }
        }
    }
}
