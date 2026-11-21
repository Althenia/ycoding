use super::{
    error::RpcError,
    json::{self, ObjectBuilder, lossy},
    types::*,
    wire_process,
};
use url::Url;
use ycoding_core::ycoding_schema::{JsonObject, JsonValue};

const MAX_ID_UNITS: usize = 256;
const MAX_READ_BYTES: f64 = 100.0 * 1024.0 * 1024.0;
const MAX_WAIT_MS: f64 = 120_000.0;
const MAX_BASE64_DECODED_BYTES: usize = 16 * 1024 * 1024;

fn invalid(message: &str) -> RpcError {
    RpcError::invalid_params(format!("Invalid params: {message}"))
}

fn fields(params: Option<&JsonValue>) -> Result<&JsonObject, RpcError> {
    match params {
        Some(JsonValue::Object(object)) => Ok(object),
        _ => Err(invalid("object expected")),
    }
}

fn identifier(object: &JsonObject, key: &str, message: &str) -> Result<Text, RpcError> {
    match json::get(object, key) {
        Some(JsonValue::String(text)) if (1..=MAX_ID_UNITS).contains(&text.len()) => {
            Ok(text.clone())
        }
        _ => Err(invalid(message)),
    }
}

fn file_uri(object: &JsonObject, key: &str, message: &str) -> Result<Text, RpcError> {
    match json::get(object, key) {
        Some(JsonValue::String(text))
            if (1..=4096).contains(&text.len())
                && Url::parse(&lossy(text)).is_ok_and(|url| url.scheme() == "file") =>
        {
            Ok(text.clone())
        }
        _ => Err(invalid(message)),
    }
}

fn optional_flag(object: &JsonObject, key: &str, message: &str) -> Result<Option<bool>, RpcError> {
    match json::get(object, key) {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::Bool(flag)) => Ok(Some(*flag)),
        Some(_) => Err(invalid(message)),
    }
}

fn strict_flag(object: &JsonObject, key: &str) -> Result<Option<bool>, RpcError> {
    match json::get(object, key) {
        None => Ok(None),
        Some(JsonValue::Bool(flag)) => Ok(Some(*flag)),
        Some(_) => Err(invalid(&format!("{key} must be a boolean"))),
    }
}

fn optional_object(
    object: &JsonObject,
    key: &str,
    message: &str,
) -> Result<Option<JsonObject>, RpcError> {
    match json::get(object, key) {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::Object(value)) => Ok(Some(value.clone())),
        Some(_) => Err(invalid(message)),
    }
}

fn bounded_integer(
    object: &JsonObject,
    key: &str,
    maximum: Option<f64>,
    message: &str,
) -> Result<Option<u64>, RpcError> {
    match json::get(object, key) {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::Number(number))
            if json::is_safe_integer(*number)
                && *number >= 0.0
                && maximum.is_none_or(|maximum| *number <= maximum) =>
        {
            Ok(Some(*number as u64))
        }
        Some(_) => Err(invalid(message)),
    }
}

fn is_valid_base64(value: Option<&JsonValue>) -> Option<String> {
    let Some(JsonValue::String(text)) = value else {
        return None;
    };
    let text = lossy(text);
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let padding = bytes.iter().rev().take_while(|byte| **byte == b'=').count();
    if padding > 2 {
        return None;
    }
    let body = &bytes[..bytes.len() - padding];
    if !body
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/')
    {
        return None;
    }
    let decoded = bytes.len() / 4 * 3 - padding;
    (decoded <= MAX_BASE64_DECODED_BYTES).then_some(text)
}

fn hex(text: &str, length: usize) -> bool {
    text.len() == length && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn hyphenated(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12]
            .iter()
            .zip(&parts)
            .all(|(length, part)| hex(part, *length))
}

fn is_thread_id(text: &str) -> bool {
    hex(text, 32)
        || hyphenated(text)
        || text
            .strip_prefix('{')
            .and_then(|rest| rest.strip_suffix('}'))
            .is_some_and(hyphenated)
        || text.strip_prefix("urn:uuid:").is_some_and(hyphenated)
}

fn is_string_array(value: Option<&JsonValue>) -> bool {
    matches!(value, Some(JsonValue::Array(items)) if items.iter().all(|item| matches!(item, JsonValue::String(_))))
}

fn is_env_policy(object: &JsonObject) -> bool {
    let inherit = matches!(
        json::get(object, "inherit"),
        Some(JsonValue::String(text)) if matches!(lossy(text).as_str(), "none" | "core" | "all")
    );
    let ignore = matches!(
        json::get(object, "ignoreDefaultExcludes"),
        Some(JsonValue::Bool(_))
    );
    let set = matches!(
        json::get(object, "set"),
        Some(JsonValue::Object(set)) if set.iter().all(|(_, value)| matches!(value, JsonValue::String(_)))
    );
    inherit
        && ignore
        && is_string_array(json::get(object, "exclude"))
        && is_string_array(json::get(object, "includeOnly"))
        && set
}

pub fn decode_process_start(params: Option<&JsonValue>) -> Result<ExecParams, RpcError> {
    let p = fields(params)?;
    let process_id = identifier(p, "processId", "invalid processId")?;
    let argv = match json::get(p, "argv") {
        Some(JsonValue::Array(items))
            if (1..=1024).contains(&items.len())
                && items.iter().all(
                    |item| matches!(item, JsonValue::String(text) if text.len() <= 65_536),
                ) =>
        {
            items
                .iter()
                .map(|item| match item {
                    JsonValue::String(text) => text.clone(),
                    _ => Text::default(),
                })
                .collect()
        }
        _ => return Err(invalid("argv must be non-empty string array")),
    };
    let cwd = file_uri(p, "cwd", "cwd must be a valid file:// URI")?;
    let env = match json::get(p, "env") {
        Some(JsonValue::Object(env)) => {
            if env.len() > 4096
                || env
                    .iter()
                    .any(|(_, value)| !matches!(value, JsonValue::String(_)))
            {
                return Err(invalid("invalid env key/value"));
            }
            env.iter()
                .map(|(key, value)| match value {
                    JsonValue::String(text) => (key.clone(), text.clone()),
                    _ => (key.clone(), Text::default()),
                })
                .collect()
        }
        _ => return Err(invalid("env must be an object")),
    };
    let arg0 = match json::get(p, "arg0") {
        None | Some(JsonValue::Null) => None,
        Some(JsonValue::String(text)) => Some(text.clone()),
        Some(_) => return Err(invalid("arg0 must be a string")),
    };
    let mut objects: Vec<Option<JsonObject>> = Vec::new();
    for field in [
        "metadata",
        "envPolicy",
        "shellSnapshot",
        "sandbox",
        "managedNetwork",
        "networkProxy",
    ] {
        objects.push(optional_object(
            p,
            field,
            &format!("{field} must be an object"),
        )?);
    }
    let metadata = match &objects[0] {
        None => None,
        Some(metadata) => {
            let thread_id = match json::get(metadata, "threadId") {
                None | Some(JsonValue::Null) => None,
                Some(JsonValue::String(text)) if is_thread_id(&lossy(text)) => Some(lossy(text)),
                Some(_) => return Err(invalid("invalid metadata.threadId")),
            };
            let tool_call_id = match json::get(metadata, "toolCallId") {
                None | Some(JsonValue::Null) => None,
                Some(JsonValue::String(text)) => Some(text.clone()),
                Some(_) => return Err(invalid("metadata.toolCallId must be a string")),
            };
            Some(ExecMetadata {
                thread_id,
                tool_call_id,
            })
        }
    };
    let env_policy = match &objects[1] {
        None => None,
        Some(object) if is_env_policy(object) => Some(object.clone()),
        Some(_) => return Err(invalid("invalid envPolicy")),
    };
    let tty = strict_flag(p, "tty")?;
    let pipe_stdin = strict_flag(p, "pipeStdin")?;
    let enforce_managed_network = strict_flag(p, "enforceManagedNetwork")?;
    let extensions = wire_process::decode_start_extensions(
        &process_id,
        json::get(p, "networkProxy"),
        json::get(p, "shellSnapshot"),
    )?;
    let mut objects = objects.into_iter().skip(3);
    Ok(ExecParams {
        process_id,
        argv,
        cwd,
        env,
        tty: tty.unwrap_or(false),
        pipe_stdin: pipe_stdin.unwrap_or(false),
        arg0,
        metadata,
        env_policy,
        shell_snapshot: extensions.shell_snapshot,
        sandbox: objects.next().flatten(),
        enforce_managed_network,
        managed_network: objects.next().flatten(),
        network_proxy: extensions.network_proxy,
    })
}

pub fn decode_process_read(params: Option<&JsonValue>) -> Result<ReadParams, RpcError> {
    let p = fields(params)?;
    Ok(ReadParams {
        process_id: identifier(p, "processId", "invalid processId")?,
        after_seq: bounded_integer(p, "afterSeq", None, "invalid afterSeq")?,
        max_bytes: bounded_integer(p, "maxBytes", Some(MAX_READ_BYTES), "invalid maxBytes")?,
        wait_ms: bounded_integer(p, "waitMs", Some(MAX_WAIT_MS), "invalid waitMs")?,
    })
}

pub fn decode_process_write(params: Option<&JsonValue>) -> Result<WriteParams, RpcError> {
    let p = fields(params)?;
    let process_id = identifier(p, "processId", "invalid processId")?;
    let write_id = identifier(p, "writeId", "writeId must be non-empty")?;
    let chunk = is_valid_base64(json::get(p, "chunk"))
        .ok_or_else(|| invalid("chunk must be valid standard base64"))?;
    Ok(WriteParams {
        process_id,
        chunk,
        write_id,
    })
}

pub fn decode_process_signal(params: Option<&JsonValue>) -> Result<SignalParams, RpcError> {
    let p = fields(params)?;
    let process_id = identifier(p, "processId", "invalid processId")?;
    match json::get(p, "signal") {
        Some(JsonValue::String(text)) if lossy(text) == "interrupt" => {
            Ok(SignalParams { process_id })
        }
        _ => Err(invalid("signal must be 'interrupt'")),
    }
}

pub fn decode_process_terminate(params: Option<&JsonValue>) -> Result<TerminateParams, RpcError> {
    let p = fields(params)?;
    Ok(TerminateParams {
        process_id: identifier(p, "processId", "invalid processId")?,
    })
}

const PATH_MESSAGE: &str = "path must be a valid file:// URI";
const FOLLOW_MESSAGE: &str = "followSymlinks must be a boolean";
const SANDBOX_MESSAGE: &str = "sandbox must be an object";

pub fn decode_read_file(params: Option<&JsonValue>) -> Result<FsReadFileParams, RpcError> {
    let p = fields(params)?;
    Ok(FsReadFileParams {
        path: file_uri(p, "path", PATH_MESSAGE)?,
        follow_symlinks: optional_flag(p, "followSymlinks", FOLLOW_MESSAGE)?,
        sandbox: optional_object(p, "sandbox", SANDBOX_MESSAGE)?,
    })
}

pub fn decode_write_file(params: Option<&JsonValue>) -> Result<FsWriteFileParams, RpcError> {
    let p = fields(params)?;
    let path = file_uri(p, "path", PATH_MESSAGE)?;
    let data_base64 = is_valid_base64(json::get(p, "dataBase64"))
        .ok_or_else(|| invalid("dataBase64 must be valid standard base64"))?;
    Ok(FsWriteFileParams {
        path,
        data_base64,
        follow_symlinks: optional_flag(p, "followSymlinks", FOLLOW_MESSAGE)?,
        sandbox: optional_object(p, "sandbox", SANDBOX_MESSAGE)?,
    })
}

pub fn decode_get_metadata(params: Option<&JsonValue>) -> Result<FsGetMetadataParams, RpcError> {
    let p = fields(params)?;
    Ok(FsGetMetadataParams {
        path: file_uri(p, "path", PATH_MESSAGE)?,
        follow_symlinks: optional_flag(p, "followSymlinks", FOLLOW_MESSAGE)?,
        sandbox: optional_object(p, "sandbox", SANDBOX_MESSAGE)?,
    })
}

pub fn decode_read_directory(
    params: Option<&JsonValue>,
) -> Result<FsReadDirectoryParams, RpcError> {
    let p = fields(params)?;
    Ok(FsReadDirectoryParams {
        path: file_uri(p, "path", PATH_MESSAGE)?,
        sandbox: optional_object(p, "sandbox", SANDBOX_MESSAGE)?,
    })
}

pub fn decode_canonicalize(params: Option<&JsonValue>) -> Result<FsCanonicalizeParams, RpcError> {
    let p = fields(params)?;
    Ok(FsCanonicalizeParams {
        path: file_uri(p, "path", PATH_MESSAGE)?,
        sandbox: optional_object(p, "sandbox", SANDBOX_MESSAGE)?,
    })
}

pub fn decode_initialize(params: Option<&JsonValue>) -> Result<(Text, Option<Text>), RpcError> {
    let Some(JsonValue::Object(p)) = params else {
        return Err(invalid("object expected"));
    };
    let client_name = match json::get(p, "clientName") {
        Some(JsonValue::String(text)) if (1..=256).contains(&text.len()) => text.clone(),
        _ => return Err(invalid("clientName is required")),
    };
    let resume = match json::get(p, "resumeSessionId") {
        None | Some(JsonValue::Null) => None,
        Some(JsonValue::String(text)) => Some(text.clone()),
        Some(_) => return Err(invalid("invalid resumeSessionId")),
    };
    Ok((client_name, resume))
}

pub fn encode_exec_result(result: &ExecResult) -> JsonValue {
    let sandbox_type = match &result.sandbox_type {
        Presence::Absent => None,
        Presence::Null => Some(JsonValue::Null),
        Presence::Value(kind) => Some(json::text(match kind {
            SandboxType::None => "none",
            SandboxType::MacosSeatbelt => "macosSeatbelt",
            SandboxType::LinuxSeccomp => "linuxSeccomp",
            SandboxType::WindowsRestrictedToken => "windowsRestrictedToken",
            SandboxType::WindowsMxc => "windowsMxc",
        })),
    };
    ObjectBuilder::new()
        .field("processId", json::lossless(&result.process_id))
        .optional("sandboxType", sandbox_type)
        .finish()
}

fn presence_text(presence: &Presence<String>) -> Option<JsonValue> {
    match presence {
        Presence::Absent => None,
        Presence::Null => Some(JsonValue::Null),
        Presence::Value(value) => Some(json::text(value)),
    }
}

pub fn encode_read_result(result: &ReadResult) -> JsonValue {
    let chunks = result
        .chunks
        .iter()
        .map(|chunk| {
            ObjectBuilder::new()
                .field("seq", json::uint(chunk.seq))
                .field("stream", json::text(chunk.stream.name()))
                .field("chunk", json::text(&chunk.chunk))
                .finish()
        })
        .collect();
    let exit_code = match &result.exit_code {
        Presence::Absent => None,
        Presence::Null => Some(JsonValue::Null),
        Presence::Value(code) => Some(json::int(*code)),
    };
    ObjectBuilder::new()
        .field("chunks", JsonValue::Array(chunks))
        .field("nextSeq", json::uint(result.next_seq))
        .field("exited", JsonValue::Bool(result.exited))
        .optional("exitCode", exit_code)
        .field("closed", JsonValue::Bool(result.closed))
        .optional("failure", presence_text(&result.failure))
        .optional("sandboxDenied", result.sandbox_denied.map(JsonValue::Bool))
        .finish()
}

pub fn encode_write_result(result: &WriteResult) -> JsonValue {
    ObjectBuilder::new()
        .field(
            "status",
            json::text(match result.status {
                WriteStatus::Accepted => "accepted",
                WriteStatus::UnknownProcess => "unknownProcess",
                WriteStatus::StdinClosed => "stdinClosed",
                WriteStatus::Starting => "starting",
            }),
        )
        .finish()
}

pub fn encode_terminate_result(result: &TerminateResult) -> JsonValue {
    ObjectBuilder::new()
        .field("running", JsonValue::Bool(result.running))
        .finish()
}

pub fn encode_read_file_result(result: &FsReadFileResult) -> JsonValue {
    ObjectBuilder::new()
        .field("dataBase64", json::text(&result.data_base64))
        .finish()
}

pub fn encode_metadata_result(result: &FsGetMetadataResult) -> JsonValue {
    ObjectBuilder::new()
        .field("isDirectory", JsonValue::Bool(result.is_directory))
        .field("isFile", JsonValue::Bool(result.is_file))
        .field("isSymlink", JsonValue::Bool(result.is_symlink))
        .field("size", json::uint(result.size))
        .field("createdAtMs", json::int(result.created_at_ms))
        .field("modifiedAtMs", json::int(result.modified_at_ms))
        .finish()
}

pub fn encode_read_directory_result(result: &FsReadDirectoryResult) -> JsonValue {
    let entries = result
        .entries
        .iter()
        .map(|entry| {
            ObjectBuilder::new()
                .field("fileName", json::text(&entry.file_name))
                .field("isDirectory", JsonValue::Bool(entry.is_directory))
                .field("isFile", JsonValue::Bool(entry.is_file))
                .finish()
        })
        .collect();
    ObjectBuilder::new()
        .field("entries", JsonValue::Array(entries))
        .finish()
}

pub fn encode_canonicalize_result(result: &FsCanonicalizeResult) -> JsonValue {
    ObjectBuilder::new()
        .field("path", json::text(&result.path))
        .finish()
}

pub fn encode_status() -> JsonValue {
    ObjectBuilder::new()
        .field("status", json::text("ready"))
        .finish()
}

pub fn encode_environment_info(info: &EnvironmentInfo) -> JsonValue {
    let shell = ObjectBuilder::new()
        .field("name", json::lossless(&info.shell.name))
        .field("path", json::lossless(&info.shell.path))
        .finish();
    ObjectBuilder::new()
        .field("shell", shell)
        .optional(
            "executorVersion",
            info.executor_version.as_deref().map(json::text),
        )
        .optional("providerId", info.provider_id.as_deref().map(json::text))
        .optional("cwd", presence_text(&info.cwd))
        .optional("userHomeDir", presence_text(&info.user_home_dir))
        .optional("platformOs", presence_text(&info.platform_os))
        .optional(
            "prependPathDirs",
            info.prepend_path_dirs.as_deref().map(json::texts),
        )
        .optional(
            "temporaryDirectories",
            info.temporary_directories.as_deref().map(json::texts),
        )
        .optional("tempDir", presence_text(&info.temp_dir))
        .field("capabilities", encode_capabilities(&info.capabilities))
        .finish()
}

fn encode_capabilities(capabilities: &EnvironmentCapabilities) -> JsonValue {
    let flags = [
        ("networkProxyLaunch", capabilities.network_proxy_launch),
        (
            "networkProxyReviewDomains",
            capabilities.network_proxy_review_domains,
        ),
        ("credentialMasking", capabilities.credential_masking),
        (
            "credentialMaskingCustomProviders",
            capabilities.credential_masking_custom_providers,
        ),
        (
            "capabilityDiscoverySandbox",
            capabilities.capability_discovery_sandbox,
        ),
        ("fsWatchMissing", capabilities.fs_watch_missing),
        (
            "capabilityDiscoveryV2",
            capabilities.capability_discovery_v2,
        ),
        (
            "environmentConfigRead",
            capabilities.environment_config_read,
        ),
        ("httpHeaderEnvVars", capabilities.http_header_env_vars),
        (
            "sandboxedFileStreaming",
            capabilities.sandboxed_file_streaming,
        ),
        ("fileWriteStreaming", capabilities.file_write_streaming),
        ("shellSnapshotV2", capabilities.shell_snapshot_v2),
        ("windowsMxc", capabilities.windows_mxc),
        (
            "linuxRootWritePreservesDevices",
            capabilities.linux_root_write_preserves_devices,
        ),
        (
            "linuxApprovedRootWritePreservesRestrictions",
            capabilities.linux_approved_root_write_preserves_restrictions,
        ),
    ];
    let mut builder = ObjectBuilder::new();
    for (name, flag) in flags {
        builder = builder.optional(name, flag.map(JsonValue::Bool));
    }
    for (name, value) in &capabilities.extra {
        builder = builder.field(name, value.clone());
    }
    builder.finish()
}

pub fn unbacked_capability(
    capabilities: &EnvironmentCapabilities,
    features: &BackendFeatures,
) -> Option<&'static str> {
    let advertised = |flag: Option<bool>| flag == Some(true);
    let checks = [
        (
            "networkProxyLaunch",
            advertised(capabilities.network_proxy_launch),
            features.network_proxy,
        ),
        (
            "networkProxyReviewDomains",
            advertised(capabilities.network_proxy_review_domains),
            features.network_proxy,
        ),
        (
            "credentialMasking",
            advertised(capabilities.credential_masking),
            features.credential_masking,
        ),
        (
            "credentialMaskingCustomProviders",
            advertised(capabilities.credential_masking_custom_providers),
            features.credential_masking_custom_providers,
        ),
        (
            "capabilityDiscoverySandbox",
            advertised(capabilities.capability_discovery_sandbox),
            features.capability_roots,
        ),
        (
            "capabilityDiscoveryV2",
            advertised(capabilities.capability_discovery_v2),
            features.capability_discovery_v2,
        ),
        (
            "environmentConfigRead",
            advertised(capabilities.environment_config_read),
            features.environment_config_read,
        ),
        (
            "httpHeaderEnvVars",
            advertised(capabilities.http_header_env_vars),
            features.http_request,
        ),
        (
            "sandboxedFileStreaming",
            advertised(capabilities.sandboxed_file_streaming),
            features.file_streaming,
        ),
        (
            "fileWriteStreaming",
            advertised(capabilities.file_write_streaming),
            features.file_write_streaming,
        ),
        (
            "shellSnapshotV2",
            advertised(capabilities.shell_snapshot_v2),
            features.shell_snapshot,
        ),
    ];
    checks
        .into_iter()
        .find(|(_, advertised, backed)| *advertised && !*backed)
        .map(|(name, _, _)| name)
}
