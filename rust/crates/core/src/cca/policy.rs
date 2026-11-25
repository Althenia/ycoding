use super::encoding::{ascii_lower, percent_decode, percent_encode_component};
use super::value::{
    JsonObject, LosslessString, Value as JsonValue, ascii_lower as lower_units, object_get,
    os_text, stringify_json, utf8_len,
};
use std::{collections::BTreeMap, io};

pub const MAX_PATH_LENGTH: usize = 4096;
pub const MAX_ENV_ENTRIES: usize = 256;
pub const MAX_ENV_BYTES: usize = 65_536;
pub const MAX_ARGV: usize = 512;
pub const MAX_ARG_BYTES: usize = 32_768;
pub const MAX_SANDBOX_ENTRIES: usize = 1024;
pub const SEP: char = std::path::MAIN_SEPARATOR;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyCode {
    InvalidPath,
    OutsideRoots,
    InvalidSandbox,
    InvalidEnv,
    InvalidArgv,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicyError {
    pub code: PolicyCode,
    pub message: LosslessString,
}
impl PolicyError {
    pub fn new(code: PolicyCode, message: impl Into<LosslessString>) -> Self {
        let message: LosslessString = message.into();
        Self {
            code,
            message: LosslessString::from_utf16(message.code_units().take(256).collect()),
        }
    }
}
fn invalid_path(message: impl Into<LosslessString>) -> PolicyError {
    PolicyError::new(PolicyCode::InvalidPath, message)
}
fn outside_roots() -> PolicyError {
    PolicyError::new(
        PolicyCode::OutsideRoots,
        "path is outside the allowed roots",
    )
}
fn invalid_sandbox(message: &str) -> PolicyError {
    PolicyError::new(PolicyCode::InvalidSandbox, message)
}
fn bad_sandbox() -> PolicyError {
    invalid_sandbox("invalid sandbox request")
}

pub fn is_sep(character: char) -> bool {
    character == '/' || (cfg!(windows) && character == '\\')
}
fn root_len(path: &str) -> usize {
    let bytes = path.as_bytes();
    if cfg!(windows) && bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return if bytes.len() >= 3 && is_sep(bytes[2] as char) {
            3
        } else {
            2
        };
    }
    if bytes.first().is_some_and(|byte| is_sep(*byte as char)) {
        1
    } else {
        0
    }
}
pub fn is_absolute(path: &str) -> bool {
    let root = root_len(path);
    if cfg!(windows) {
        root >= 3 || (root == 1)
    } else {
        root == 1
    }
}
pub fn root_of(path: &str) -> String {
    let root = root_len(path);
    if root == 0 {
        String::new()
    } else {
        path[..root].to_owned()
    }
}
pub fn dirname(path: &str) -> String {
    let root = root_len(path);
    let bytes = path.as_bytes();
    let mut end = path.len();
    while end > root && is_sep(bytes[end - 1] as char) {
        end -= 1;
    }
    if end == root {
        return if root == 0 {
            ".".to_owned()
        } else {
            path[..root].to_owned()
        };
    }
    let mut start = end;
    while start > root && !is_sep(bytes[start - 1] as char) {
        start -= 1;
    }
    if start <= root {
        return if root == 0 {
            ".".to_owned()
        } else {
            path[..root].to_owned()
        };
    }
    let mut cut = start - 1;
    while cut > root && is_sep(bytes[cut - 1] as char) {
        cut -= 1;
    }
    path[..cut].to_owned()
}
pub fn basename(path: &str) -> String {
    let root = root_len(path);
    let bytes = path.as_bytes();
    let mut end = path.len();
    while end > root && is_sep(bytes[end - 1] as char) {
        end -= 1;
    }
    let mut start = end;
    while start > root && !is_sep(bytes[start - 1] as char) {
        start -= 1;
    }
    path[start..end].to_owned()
}
pub fn normalize(path: &str) -> String {
    let root = root_len(path);
    let rooted = root > 0;
    let mut parts: Vec<&str> = vec![];
    for part in path[root..].split(is_sep) {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !rooted {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let body = parts.join(&SEP.to_string());
    if rooted {
        let prefix = if cfg!(windows) {
            path[..root].replace('/', "\\")
        } else {
            path[..root].to_owned()
        };
        if body.is_empty() {
            prefix
        } else if prefix.ends_with(SEP) {
            format!("{prefix}{body}")
        } else {
            format!("{prefix}{SEP}{body}")
        }
    } else if body.is_empty() {
        ".".to_owned()
    } else {
        body
    }
}
pub fn join<S: AsRef<str>>(base: &str, parts: &[S]) -> String {
    let mut text = base.to_owned();
    for part in parts {
        let part = part.as_ref();
        if part.is_empty() {
            continue;
        }
        text.push(SEP);
        text.push_str(part);
    }
    normalize(&text)
}
pub fn resolve(base: &str, relative: &str) -> String {
    if is_absolute(relative) {
        normalize(relative)
    } else {
        normalize(&format!("{base}{SEP}{relative}"))
    }
}
pub fn within(target: &str, root: &str) -> bool {
    if root == root_of(root) {
        return target.starts_with(root);
    }
    target == root
        || target.starts_with(&if root.ends_with(SEP) {
            root.to_owned()
        } else {
            format!("{root}{SEP}")
        })
}
pub fn inside_roots(resolved: &str, canonical_roots: &[String]) -> bool {
    canonical_roots.iter().any(|root| {
        resolved == root
            || resolved.starts_with(&if root.ends_with(SEP) {
                root.clone()
            } else {
                format!("{root}{SEP}")
            })
    })
}
pub fn ancestors(target: &str) -> Vec<String> {
    let mut chain = vec![target.to_owned()];
    let mut current = target.to_owned();
    while dirname(&current) != current {
        current = dirname(&current);
        chain.push(current.clone());
    }
    chain
}

pub fn has_control(text: &str) -> bool {
    text.chars()
        .any(|character| (character as u32) < 0x20 || character as u32 == 0x7f)
}
fn check_path_text(value: &str) -> Result<(), PolicyError> {
    if value.is_empty() || value.encode_utf16().count() > MAX_PATH_LENGTH || has_control(value) {
        return Err(invalid_path(
            "path must be a bounded non-empty string without control characters",
        ));
    }
    Ok(())
}
fn drive_native(path: &str) -> Option<(char, String)> {
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        if bytes.len() == 2 {
            return Some((bytes[0] as char, String::new()));
        }
        if bytes[2] == b'\\' || bytes[2] == b'/' {
            return Some((bytes[0] as char, path[3..].to_owned()));
        }
    }
    None
}
fn decode_segment(segment: &str) -> Result<String, PolicyError> {
    let decoded = percent_decode(segment)
        .ok_or_else(|| invalid_path("path URI contains invalid percent-encoding"))?;
    if has_control(&decoded) || decoded.contains('/') || decoded.contains('\\') {
        return Err(invalid_path(
            "path URI segment contains a forbidden character",
        ));
    }
    if decoded == "." || decoded == ".." {
        return Err(invalid_path("path URI must not contain dot segments"));
    }
    Ok(decoded)
}
fn check_plain_segment(segment: &str) -> Result<(), PolicyError> {
    if segment == "." || segment == ".." {
        return Err(invalid_path("path must not contain dot segments"));
    }
    Ok(())
}

pub fn parse_path_uri(uri: &str) -> Result<String, PolicyError> {
    check_path_text(uri)?;
    let lowered = ascii_lower(uri);
    if !lowered.starts_with("file://")
        || uri.contains('?')
        || uri.contains('#')
        || uri.contains('\\')
    {
        return Err(invalid_path(
            "path must be a file:// URI without query, fragment, or backslashes",
        ));
    }
    let rest = &uri["file://".len()..];
    let Some(slash) = rest.find('/') else {
        return Err(invalid_path("file:// URI must contain an absolute path"));
    };
    let authority = ascii_lower(&rest[..slash]);
    if !authority.is_empty() && authority != "localhost" {
        return Err(invalid_path(
            "file:// URI authority must be empty or localhost",
        ));
    }
    let segments = rest[slash..].split('/').collect::<Vec<_>>();
    for segment in &segments[1..segments.len() - 1] {
        if segment.is_empty() {
            return Err(invalid_path("path URI must not contain empty segments"));
        }
    }
    let mut decoded = vec![];
    for segment in &segments {
        decoded.push(if segment.is_empty() {
            String::new()
        } else {
            decode_segment(segment)?
        });
    }
    let joined = decoded.join("/");
    let bytes = joined.as_bytes();
    if bytes.len() >= 3
        && bytes[0] == b'/'
        && bytes[1].is_ascii_alphabetic()
        && bytes[2] == b':'
        && (bytes.len() == 3 || bytes[3] == b'/')
    {
        let tail = if bytes.len() > 4 {
            joined[4..].replace('/', "\\")
        } else {
            String::new()
        };
        return Ok(format!("{}:\\{}", bytes[1] as char, tail));
    }
    Ok(joined)
}

pub fn to_path_uri(path: &str) -> Result<String, PolicyError> {
    check_path_text(path)?;
    if let Some((drive, tail)) = drive_native(path) {
        let tail = tail.replace('\\', "/");
        let segments: Vec<&str> = if tail.is_empty() {
            vec![]
        } else {
            tail.split('/').collect()
        };
        for segment in &segments {
            if segment.is_empty() {
                return Err(invalid_path("path must not contain empty segments"));
            }
            check_plain_segment(segment)?;
        }
        let encoded = segments
            .iter()
            .map(|segment| percent_encode_component(segment))
            .collect::<Vec<_>>()
            .join("/");
        return Ok(format!(
            "file:///{drive}:{}",
            if segments.is_empty() {
                "/".to_owned()
            } else {
                format!("/{encoded}")
            }
        ));
    }
    if !path.starts_with('/') || path.contains('\\') {
        return Err(invalid_path("path must be absolute without backslashes"));
    }
    if path == "/" {
        return Ok("file:///".to_owned());
    }
    let segments = path.split('/').skip(1).collect::<Vec<_>>();
    for segment in &segments[..segments.len() - 1] {
        if segment.is_empty() {
            return Err(invalid_path("path must not contain empty segments"));
        }
        check_plain_segment(segment)?;
    }
    let last = segments[segments.len() - 1];
    if !last.is_empty() {
        check_plain_segment(last)?;
    }
    Ok(format!(
        "file:///{}",
        segments
            .iter()
            .map(|segment| if segment.is_empty() {
                String::new()
            } else {
                percent_encode_component(segment)
            })
            .collect::<Vec<_>>()
            .join("/")
    ))
}

fn check_absolute(candidate: &str) -> Result<(), PolicyError> {
    check_path_text(candidate)?;
    if !candidate.starts_with('/') && drive_native(candidate).is_none() {
        return Err(invalid_path("path must be absolute"));
    }
    for segment in candidate.split(['/', '\\']) {
        check_plain_segment(segment)?;
    }
    Ok(())
}

pub fn is_missing(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    )
}
pub fn os_error_text(error: &io::Error) -> Option<String> {
    error.raw_os_error().map(|_| error.to_string())
}
pub fn io_error_code(error: &io::Error) -> i32 {
    match error.kind() {
        io::ErrorKind::NotFound => -32004,
        io::ErrorKind::PermissionDenied | io::ErrorKind::InvalidInput => -32600,
        _ => {
            #[cfg(unix)]
            if matches!(error.raw_os_error(), Some(code) if code == libc::EPERM || code == libc::EACCES || code == libc::EINVAL)
            {
                return -32600;
            }
            -32603
        }
    }
}

pub async fn real_path(path: &str) -> io::Result<String> {
    tokio::fs::canonicalize(path)
        .await
        .map(|resolved| resolved.to_string_lossy().into_owned())
}

async fn failure_inside_roots(failed: &str, canonical_roots: &[String]) -> bool {
    let mut child = failed.to_owned();
    let mut ancestor = dirname(failed);
    loop {
        if let Ok(real) = real_path(&ancestor).await {
            if !inside_roots(&real, canonical_roots) {
                return false;
            }
            return !tokio::fs::symlink_metadata(&child)
                .await
                .map(|meta| meta.file_type().is_symlink())
                .unwrap_or(false);
        }
        if dirname(&ancestor) == ancestor {
            return false;
        }
        child = ancestor.clone();
        ancestor = dirname(&ancestor);
    }
}
async fn canonicalize_failure(
    failed: &str,
    error: &io::Error,
    canonical_roots: &[String],
) -> PolicyError {
    if !failure_inside_roots(failed, canonical_roots).await {
        return outside_roots();
    }
    invalid_path(os_error_text(error).unwrap_or_else(|| "path cannot be canonicalized".to_owned()))
}

pub async fn canonicalize_candidate(
    candidate: &str,
    allow_missing_final: bool,
    canonical_roots: &[String],
) -> Result<String, PolicyError> {
    match real_path(candidate).await {
        Ok(resolved) => return Ok(resolved),
        Err(error) => {
            if !is_missing(&error) {
                return Err(canonicalize_failure(candidate, &error, canonical_roots).await);
            }
            if !allow_missing_final {
                return Err(invalid_path("path does not exist"));
            }
        }
    }
    let mut missing: Vec<String> = vec![];
    let mut ancestor = candidate.to_owned();
    loop {
        let parent = dirname(&ancestor);
        if parent == ancestor {
            return Err(invalid_path("path has no existing ancestor"));
        }
        missing.insert(0, basename(&ancestor));
        ancestor = parent;
        match real_path(&ancestor).await {
            Ok(resolved) => {
                let parts = missing.iter().map(String::as_str).collect::<Vec<_>>();
                return Ok(join(&resolved, &parts));
            }
            Err(error) if is_missing(&error) => {}
            Err(error) => {
                return Err(canonicalize_failure(&ancestor, &error, canonical_roots).await);
            }
        }
    }
}

pub async fn resolve_contained(
    candidate: &str,
    roots: &[String],
    allow_missing_final: bool,
) -> Result<String, PolicyError> {
    check_absolute(candidate)?;
    if roots.is_empty() {
        return Err(invalid_path("at least one containing root is required"));
    }
    for root in roots {
        check_absolute(root)?;
    }
    let mut canonical_roots = vec![];
    for root in roots {
        match real_path(root).await {
            Ok(resolved) => canonical_roots.push(resolved),
            Err(_) => return Err(invalid_path("containing root cannot be canonicalized")),
        }
    }
    let resolved = canonicalize_candidate(candidate, allow_missing_final, &canonical_roots).await?;
    if inside_roots(&resolved, &canonical_roots) {
        Ok(resolved)
    } else {
        Err(outside_roots())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxAccess {
    None,
    Read,
    Write,
}
impl SandboxAccess {
    pub fn permits(self, need: SandboxAccess) -> bool {
        self == SandboxAccess::Write || (need == SandboxAccess::Read && self == SandboxAccess::Read)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EntryAccess {
    Access(SandboxAccess),
    Deny,
}
enum Entry {
    Path {
        native: String,
        access: EntryAccess,
    },
    Glob {
        pattern: LosslessString,
        access: EntryAccess,
    },
    Special {
        value: String,
        subpath: Option<String>,
        access: EntryAccess,
    },
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Profile {
    Managed,
    Disabled,
    External,
}
struct ParsedSandbox {
    profile: Profile,
    restricted: bool,
    network: String,
    entries: Vec<Entry>,
    override_mode: String,
    cwd: Option<String>,
    workspace_roots: Option<Vec<String>>,
    temporary_directories: Option<Vec<String>>,
}

fn record(value: &JsonValue) -> Result<&JsonObject, PolicyError> {
    match value {
        JsonValue::Object(object) => Ok(object),
        _ => Err(bad_sandbox()),
    }
}
fn string(value: &JsonValue) -> Option<&LosslessString> {
    match value {
        JsonValue::String(text) => Some(text),
        _ => None,
    }
}
fn text(value: &JsonValue) -> Option<&str> {
    string(value)?.as_str()
}
fn array(value: &JsonValue) -> Option<&Vec<JsonValue>> {
    match value {
        JsonValue::Array(items) => Some(items),
        _ => None,
    }
}
fn one_of(value: Option<&JsonValue>, allowed: &[&str]) -> Result<String, PolicyError> {
    match value.and_then(text) {
        Some(text) if allowed.contains(&text) => Ok(text.to_owned()),
        _ => Err(bad_sandbox()),
    }
}
fn present(value: Option<&JsonValue>) -> Option<&JsonValue> {
    value.filter(|value| !matches!(value, JsonValue::Null))
}
fn host_path(value: &JsonValue) -> Result<String, PolicyError> {
    let Some(text) = string(value) else {
        return Err(bad_sandbox());
    };
    let native = parse_path_uri(&os_text(text)).map_err(|_| bad_sandbox())?;
    if !is_absolute(&native) {
        return Err(invalid_sandbox(
            "sandbox path is not valid on this executor",
        ));
    }
    Ok(native)
}
fn host_paths(value: &JsonValue) -> Result<Vec<String>, PolicyError> {
    array(value)
        .ok_or_else(bad_sandbox)?
        .iter()
        .map(host_path)
        .collect()
}
fn relative_subpath(value: Option<&JsonValue>) -> Result<Option<String>, PolicyError> {
    let Some(value) = present(value) else {
        return Ok(None);
    };
    let Some(text) = string(value) else {
        return Err(bad_sandbox());
    };
    let text = os_text(text);
    if has_control(&text) || is_absolute(&text) || text.starts_with('/') {
        return Err(bad_sandbox());
    }
    if text.split(['/', '\\']).any(|segment| segment == "..") {
        return Err(bad_sandbox());
    }
    Ok(Some(text.to_owned()))
}
fn read_entry(value: &JsonValue) -> Result<Entry, PolicyError> {
    let entry = record(value)?;
    let access = match one_of(object_get(entry, "access"), &["read", "write", "deny"])?.as_str() {
        "read" => EntryAccess::Access(SandboxAccess::Read),
        "write" => EntryAccess::Access(SandboxAccess::Write),
        _ => EntryAccess::Deny,
    };
    let target = record(object_get(entry, "path").ok_or_else(bad_sandbox)?)?;
    match object_get(target, "type").and_then(text) {
        Some("path") => Ok(Entry::Path {
            native: host_path(object_get(target, "path").ok_or_else(bad_sandbox)?)?,
            access,
        }),
        Some("glob_pattern") => {
            let pattern = object_get(target, "pattern")
                .and_then(string)
                .ok_or_else(bad_sandbox)?;
            if pattern.is_empty() || pattern.code_units().any(|unit| unit < 0x20 || unit == 0x7f) {
                return Err(bad_sandbox());
            }
            Ok(Entry::Glob {
                pattern: pattern.clone(),
                access,
            })
        }
        Some("special") => {
            let special = record(object_get(target, "value").ok_or_else(bad_sandbox)?)?;
            let kind = object_get(special, "kind")
                .and_then(text)
                .ok_or_else(bad_sandbox)?;
            Ok(Entry::Special {
                value: kind.to_owned(),
                subpath: relative_subpath(object_get(special, "subpath"))?,
                access,
            })
        }
        _ => Err(bad_sandbox()),
    }
}
fn read_sandbox(value: &JsonValue) -> Result<ParsedSandbox, PolicyError> {
    let sandbox = record(value)?;
    let permissions = record(object_get(sandbox, "permissions").ok_or_else(bad_sandbox)?)?;
    let override_mode = match present(object_get(sandbox, "sandboxOverride")) {
        Some(item) => one_of(
            Some(item),
            &[
                "noOverride",
                "escalatedSandboxWithRestrictions",
                "bypassSandboxFirstAttempt",
            ],
        )?,
        None => "noOverride".to_owned(),
    };
    let context = match present(object_get(sandbox, "policyContext")) {
        Some(item) => Some(record(item)?),
        None => None,
    };
    let cwd_source = context.map_or(object_get(sandbox, "cwd"), |context| {
        object_get(context, "cwd")
    });
    let cwd = present(cwd_source).map(host_path).transpose()?;
    let roots_source = context.map_or(object_get(sandbox, "workspaceRoots"), |context| {
        object_get(context, "workspaceRoots")
    });
    let workspace_roots = present(roots_source).map(host_paths).transpose()?;
    let temporary_directories = present(object_get(sandbox, "temporaryDirectories"))
        .map(host_paths)
        .transpose()?;
    if let Some(home) = present(object_get(sandbox, "userHomeDir")) {
        host_path(home)?;
    }
    let base = |profile, restricted, network: &str, entries| ParsedSandbox {
        profile,
        restricted,
        network: network.to_owned(),
        entries,
        override_mode: override_mode.clone(),
        cwd: cwd.clone(),
        workspace_roots: workspace_roots.clone(),
        temporary_directories: temporary_directories.clone(),
    };
    match object_get(permissions, "type").and_then(text) {
        Some("disabled") => Ok(base(Profile::Disabled, false, "enabled", vec![])),
        Some("external") => {
            let network = one_of(
                object_get(permissions, "network"),
                &["restricted", "enabled"],
            )?;
            Ok(base(Profile::External, false, &network, vec![]))
        }
        Some("managed") => {
            let file_system =
                record(object_get(permissions, "file_system").ok_or_else(bad_sandbox)?)?;
            let network = one_of(
                object_get(permissions, "network"),
                &["restricted", "enabled"],
            )?;
            if object_get(file_system, "type").and_then(text) == Some("unrestricted") {
                return Ok(base(Profile::Managed, false, &network, vec![]));
            }
            if object_get(file_system, "type").and_then(text) != Some("restricted") {
                return Err(bad_sandbox());
            }
            let entries = object_get(file_system, "entries")
                .and_then(array)
                .ok_or_else(bad_sandbox)?;
            if entries.len() > MAX_SANDBOX_ENTRIES {
                return Err(invalid_sandbox("sandbox exceeds the entry limit"));
            }
            if let Some(depth) = present(object_get(file_system, "glob_scan_max_depth")) {
                match depth {
                    JsonValue::Number(depth)
                        if depth.fract() == 0.0
                            && (1.0..=9_007_199_254_740_991.0).contains(depth) => {}
                    _ => return Err(bad_sandbox()),
                }
            }
            let parsed = entries
                .iter()
                .map(read_entry)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(base(Profile::Managed, true, &network, parsed))
        }
        _ => Err(bad_sandbox()),
    }
}
pub(super) fn process_requires_sandbox(sandbox: Option<&JsonValue>) -> Result<bool, PolicyError> {
    let sandbox = present(sandbox).map(read_sandbox).transpose()?;
    Ok(sandbox.is_some_and(|sandbox| {
        sandbox.profile == Profile::External
            || sandbox.restricted
            || sandbox.network == "restricted"
            || sandbox.override_mode == "escalatedSandboxWithRestrictions"
    }))
}

pub(super) fn read_managed_network(value: &JsonValue) -> Result<(), PolicyError> {
    let context = record(value)?;
    let ports = object_get(context, "loopbackPorts")
        .and_then(array)
        .ok_or_else(bad_sandbox)?;
    if !ports.iter().all(|port| matches!(port, JsonValue::Number(port) if port.fract() == 0.0 && (0.0..=65_535.0).contains(port))) {
        return Err(bad_sandbox());
    }
    if !matches!(
        object_get(context, "allowLocalBinding"),
        Some(JsonValue::Bool(_))
    ) {
        return Err(bad_sandbox());
    }
    if let Some(sockets) = present(object_get(context, "allowUnixSockets"))
        && !array(sockets).is_some_and(|items| {
            items
                .iter()
                .all(|item| matches!(item, JsonValue::String(_)))
        })
    {
        return Err(bad_sandbox());
    }
    if let Some(flag) = present(object_get(context, "dangerouslyAllowAllUnixSockets"))
        && !matches!(flag, JsonValue::Bool(_))
    {
        return Err(bad_sandbox());
    }
    Ok(())
}
fn read_network_proxy(value: &JsonValue) -> Result<(), PolicyError> {
    record(object_get(record(value)?, "proxy").ok_or_else(bad_sandbox)?).map(|_| ())
}

fn absolute_pattern(pattern: &LosslessString) -> bool {
    let units = pattern.code_units().take(3).collect::<Vec<_>>();
    let separator = |unit| unit == 0x2f || (cfg!(windows) && unit == 0x5c);
    if cfg!(windows)
        && units.len() >= 2
        && ((0x41..=0x5a).contains(&units[0]) || (0x61..=0x7a).contains(&units[0]))
        && units[1] == 0x3a
    {
        return units.get(2).is_some_and(|unit| separator(*unit));
    }
    units.first().is_some_and(|unit| separator(*unit))
}

fn join_pattern(base: &str, tail: &[LosslessString]) -> LosslessString {
    let root = root_len(base);
    let mut units = base[root..].encode_utf16().collect::<Vec<_>>();
    for part in tail {
        units.push(SEP as u16);
        units.extend(part.code_units());
    }
    let mut parts: Vec<&[u16]> = vec![];
    for part in units.split(|unit| *unit == 0x2f || (cfg!(windows) && *unit == 0x5c)) {
        match part {
            [] | [0x2e] => {}
            [0x2e, 0x2e] => {
                if parts.last().is_some_and(|last| *last != [0x2e, 0x2e]) {
                    parts.pop();
                } else if root == 0 {
                    parts.push(part);
                }
            }
            other => parts.push(other),
        }
    }
    let mut result = base[..root]
        .encode_utf16()
        .map(|unit| {
            if cfg!(windows) && unit == 0x2f {
                0x5c
            } else {
                unit
            }
        })
        .collect::<Vec<_>>();
    for part in parts {
        if !result.is_empty() && result.last() != Some(&(SEP as u16)) {
            result.push(SEP as u16);
        }
        result.extend_from_slice(part);
    }
    if result.is_empty() {
        result.push(0x2e);
    }
    LosslessString::from_utf16(result)
}

fn escape_regexp(character: u16, extra: &[u16]) -> Vec<u16> {
    if ".+^$()|\\".encode_utf16().any(|unit| unit == character) || extra.contains(&character) {
        vec![0x5c, character]
    } else {
        vec![character]
    }
}
fn glob_source(pattern: &LosslessString) -> Vec<u16> {
    let characters = pattern.code_units().collect::<Vec<_>>();
    let mut source = Vec::new();
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if character == 0x2a && characters.get(index + 1) == Some(&0x2a) {
            index += 1;
            if characters.get(index + 1) == Some(&0x2f) {
                index += 1;
                source.extend("(?:.*/)?".encode_utf16());
            } else {
                source.extend(".*".encode_utf16());
            }
        } else if character == 0x2a {
            source.extend("[^/]*".encode_utf16());
        } else if character == 0x3f {
            source.extend("[^/]".encode_utf16());
        } else if character == 0x5b {
            let close = characters
                .iter()
                .enumerate()
                .skip(index + 2)
                .find(|(_, value)| **value == 0x5d)
                .map(|(position, _)| position);
            match close {
                None => source.extend("\\[".encode_utf16()),
                Some(close) => {
                    let mut body = characters[index + 1..close].to_vec();
                    if body.first() == Some(&0x21) {
                        body[0] = 0x5e;
                    }
                    source.push(0x5b);
                    for unit in body {
                        if unit == 0x5c {
                            source.push(0x5c);
                        }
                        source.push(unit);
                    }
                    source.push(0x5d);
                    index = close;
                }
            }
        } else if character == 0x7b {
            let close = characters
                .iter()
                .enumerate()
                .skip(index)
                .find(|(_, value)| **value == 0x7d)
                .map(|(position, _)| position);
            match close {
                None => source.extend("\\{".encode_utf16()),
                Some(close) => {
                    source.extend("(?:".encode_utf16());
                    for (part_index, part) in characters[index + 1..close]
                        .split(|unit| *unit == 0x2c)
                        .enumerate()
                    {
                        if part_index > 0 {
                            source.push(0x7c);
                        }
                        for unit in part {
                            match *unit {
                                0x2a => source.extend("[^/]*".encode_utf16()),
                                0x3f => source.extend("[^/]".encode_utf16()),
                                other => source.extend(escape_regexp(other, &[])),
                            }
                        }
                    }
                    source.push(0x29);
                    index = close;
                }
            }
        } else {
            source.extend(escape_regexp(character, &[0x5d, 0x7d]));
        }
        index += 1;
    }
    source
}

#[derive(Debug)]
pub struct Glob(std::sync::Mutex<crate::regexp::RegExp>);
impl Glob {
    pub fn compile(pattern: &LosslessString) -> Result<Glob, PolicyError> {
        let mut units = vec![0x5e];
        units.extend(glob_source(pattern));
        units.push(0x24);
        crate::regexp::RegExp::new(&units, "")
            .map(|compiled| Glob(std::sync::Mutex::new(compiled)))
            .map_err(|_| bad_sandbox())
    }
    pub fn is_match(&self, text: &str) -> bool {
        let units = text.encode_utf16().collect::<Vec<_>>();
        let mut compiled = self.0.lock().unwrap_or_else(|error| error.into_inner());
        compiled
            .test(&units, &mut crate::regexp::Budget::unlimited())
            .unwrap_or(false)
    }
}

#[derive(Clone, Debug)]
pub struct SandboxPolicy {
    pub sandboxed: bool,
    pub restricted: bool,
    grants: Vec<(String, SandboxAccess)>,
    denies: Vec<String>,
    globs: Vec<std::sync::Arc<Glob>>,
    deny_all: bool,
    pub metadata: JsonObject,
}
impl SandboxPolicy {
    pub fn access(&self, canonical_path: &str, requested_path: Option<&str>) -> SandboxAccess {
        if !self.restricted {
            return SandboxAccess::Write;
        }
        if self.deny_all {
            return SandboxAccess::None;
        }
        let mut candidates = vec![canonical_path];
        if let Some(requested) = requested_path
            && requested != canonical_path
        {
            candidates.push(requested);
        }
        for candidate in candidates {
            if self.denies.iter().any(|root| within(candidate, root)) {
                return SandboxAccess::None;
            }
            let chain = ancestors(candidate)
                .into_iter()
                .map(|item| item.replace('\\', "/"))
                .collect::<Vec<_>>();
            if self
                .globs
                .iter()
                .any(|glob| chain.iter().any(|item| glob.is_match(item)))
            {
                return SandboxAccess::None;
            }
        }
        let mut best: Option<&(String, SandboxAccess)> = None;
        for grant in &self.grants {
            if !within(canonical_path, &grant.0) {
                continue;
            }
            best = match best {
                None => Some(grant),
                Some(current)
                    if grant.0.len() > current.0.len()
                        || (grant.0.len() == current.0.len() && grant.1 == SandboxAccess::Read) =>
                {
                    Some(grant)
                }
                other => other,
            };
        }
        best.map_or(SandboxAccess::None, |grant| grant.1)
    }
}

#[derive(Default)]
pub struct SandboxIntent<'a> {
    pub sandbox: Option<&'a JsonValue>,
    pub enforce_managed_network: bool,
    pub managed_network: Option<&'a JsonValue>,
    pub network_proxy: Option<&'a JsonValue>,
}
#[derive(Default)]
pub struct ResolveSandboxOptions {
    pub cwd: Option<String>,
    pub readable_policy_cwd: bool,
    pub temporary_directories: Vec<String>,
}

pub async fn resolve_sandbox(
    input: &SandboxIntent<'_>,
    options: &ResolveSandboxOptions,
) -> Result<Option<SandboxPolicy>, PolicyError> {
    let managed_network = present(input.managed_network);
    if let Some(value) = managed_network {
        read_managed_network(value)?;
    }
    let network_proxy = present(input.network_proxy);
    if let Some(value) = network_proxy {
        read_network_proxy(value)?;
    }
    let sandbox = present(input.sandbox).map(read_sandbox).transpose()?;
    if sandbox.is_none()
        && managed_network.is_none()
        && network_proxy.is_none()
        && !input.enforce_managed_network
    {
        return Ok(None);
    }
    let mut metadata = JsonObject::new();
    if input.enforce_managed_network {
        metadata.insert(
            "sandboxManagedNetwork".into(),
            JsonValue::String("enforced".into()),
        );
    } else if managed_network.is_some() {
        metadata.insert(
            "sandboxManagedNetwork".into(),
            JsonValue::String("requested".into()),
        );
    }
    if network_proxy.is_some() {
        metadata.insert(
            "sandboxNetworkProxy".into(),
            JsonValue::String("requested".into()),
        );
    }
    let Some(sandbox) = sandbox else {
        return Ok(Some(SandboxPolicy {
            sandboxed: false,
            restricted: false,
            grants: vec![],
            denies: vec![],
            globs: vec![],
            deny_all: false,
            metadata,
        }));
    };
    metadata.insert(
        "sandboxProfile".into(),
        JsonValue::String(
            match sandbox.profile {
                Profile::Managed => "managed",
                Profile::Disabled => "disabled",
                Profile::External => "external",
            }
            .into(),
        ),
    );
    metadata.insert(
        "sandboxFileSystem".into(),
        JsonValue::String(
            if sandbox.restricted {
                "restricted"
            } else {
                "unrestricted"
            }
            .into(),
        ),
    );
    metadata.insert(
        "sandboxNetwork".into(),
        JsonValue::String(sandbox.network.clone().into()),
    );
    if sandbox.override_mode != "noOverride" {
        metadata.insert(
            "sandboxOverride".into(),
            JsonValue::String(sandbox.override_mode.clone().into()),
        );
    }
    let bypass = sandbox.override_mode == "bypassSandboxFirstAttempt";
    let sandboxed = !bypass
        && sandbox.profile == Profile::Managed
        && (sandbox.restricted || sandbox.network == "restricted");
    if !sandbox.restricted || bypass {
        return Ok(Some(SandboxPolicy {
            sandboxed,
            restricted: false,
            grants: vec![],
            denies: vec![],
            globs: vec![],
            deny_all: false,
            metadata,
        }));
    }
    let canonical = |native: String| async move {
        canonicalize_candidate(&native, true, &[])
            .await
            .unwrap_or(native)
    };
    let cwd = sandbox.cwd.clone().or_else(|| options.cwd.clone());
    let dynamic = sandbox.entries.iter().any(|entry| match entry {
        Entry::Special { value, .. } => value == "project_roots",
        Entry::Glob { pattern, .. } => !absolute_pattern(pattern),
        _ => false,
    });
    if dynamic && cwd.is_none() {
        return Err(invalid_sandbox(
            "file system sandbox context with dynamic permissions requires cwd",
        ));
    }
    let workspace_roots = sandbox
        .workspace_roots
        .clone()
        .unwrap_or_else(|| cwd.clone().into_iter().collect());
    let temporary = sandbox
        .temporary_directories
        .clone()
        .unwrap_or_else(|| options.temporary_directories.clone());
    let mut grants: Vec<(String, SandboxAccess)> = vec![];
    let mut denies: Vec<String> = vec![];
    let mut globs: Vec<std::sync::Arc<Glob>> = vec![];
    let mut deny_all = false;
    macro_rules! add {
        ($native:expr, $access:expr) => {{
            let root = canonical($native).await;
            match $access {
                EntryAccess::Deny => denies.push(root),
                EntryAccess::Access(access) => grants.push((root, access)),
            }
        }};
    }
    for entry in &sandbox.entries {
        match entry {
            Entry::Path { native, access } => add!(native.clone(), *access),
            Entry::Glob { pattern, access } => {
                if *access != EntryAccess::Deny {
                    continue;
                }
                let absolute = if absolute_pattern(pattern) {
                    pattern.clone()
                } else {
                    join_pattern(cwd.as_deref().unwrap_or("/"), std::slice::from_ref(pattern))
                };
                let units = absolute.code_units().collect::<Vec<_>>();
                let segments = units
                    .split(|unit| *unit == 0x2f)
                    .map(|segment| LosslessString::from_utf16(segment.to_vec()))
                    .collect::<Vec<_>>();
                match segments.iter().position(|segment| {
                    segment
                        .code_units()
                        .any(|unit| matches!(unit, 0x2a | 0x3f | 0x5b | 0x7b))
                }) {
                    None => add!(os_text(&absolute), EntryAccess::Deny),
                    Some(literal) => {
                        let head = super::value::join(&segments[..literal], "/");
                        let prefix = canonical(if head.is_empty() {
                            "/".to_owned()
                        } else {
                            os_text(&head)
                        })
                        .await;
                        let tail = segments[literal..].to_vec();
                        let combined = LosslessString::from_utf16(
                            join_pattern(&prefix, &tail)
                                .code_units()
                                .map(|unit| if unit == 0x5c { 0x2f } else { unit })
                                .collect(),
                        );
                        globs.push(std::sync::Arc::new(Glob::compile(&combined)?));
                    }
                }
            }
            Entry::Special {
                value,
                subpath,
                access,
            } => {
                let targets: Option<Vec<String>> = match value.as_str() {
                    "root" => Some(vec![root_of(cwd.as_deref().unwrap_or("/"))]),
                    "project_roots" => Some(
                        workspace_roots
                            .iter()
                            .map(|root| match subpath {
                                Some(sub) if !sub.is_empty() => join(root, &[sub]),
                                _ => root.clone(),
                            })
                            .collect(),
                    ),
                    "tmpdir" => Some(temporary.clone()),
                    "slash_tmp" => Some(if cfg!(windows) {
                        vec![]
                    } else {
                        vec!["/tmp".to_owned()]
                    }),
                    _ => None,
                };
                match targets {
                    None => {
                        if value != "minimal" && *access == EntryAccess::Deny {
                            deny_all = true;
                        }
                    }
                    Some(targets) => {
                        for target in targets {
                            add!(target, *access);
                        }
                    }
                }
            }
        }
    }
    if options.readable_policy_cwd
        && let Some(cwd) = &cwd
    {
        grants.push((canonical(cwd.clone()).await, SandboxAccess::Read));
    }
    let listed = |kind: SandboxAccess| {
        let mut seen = vec![];
        for (root, access) in &grants {
            if *access == kind && !seen.contains(root) {
                seen.push(root.clone());
            }
        }
        stringify_json(&JsonValue::Array(
            seen.into_iter()
                .map(|text| JsonValue::String(text.into()))
                .collect(),
        ))
    };
    metadata.insert(
        "sandboxWritableRoots".into(),
        JsonValue::String(listed(SandboxAccess::Write).into()),
    );
    metadata.insert(
        "sandboxReadableRoots".into(),
        JsonValue::String(listed(SandboxAccess::Read).into()),
    );
    if !denies.is_empty() || !globs.is_empty() || deny_all {
        metadata.insert(
            "sandboxDeniedPaths".into(),
            JsonValue::String("present".into()),
        );
    }
    Ok(Some(SandboxPolicy {
        sandboxed,
        restricted: true,
        grants,
        denies,
        globs,
        deny_all,
        metadata,
    }))
}

pub fn osc_secret_key(key: &str) -> bool {
    let upper = key.to_uppercase();
    [
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "API_KEY",
        "APIKEY",
        "PRIVATE_KEY",
        "CREDENTIAL",
    ]
    .iter()
    .any(|word| upper.contains(word))
}
fn broad_secret_key(key: &str) -> bool {
    let upper = key.to_uppercase();
    ["KEY", "SECRET", "TOKEN"]
        .iter()
        .any(|word| upper.contains(word))
}

const UNIX_CORE_ENV: &[&str] = &[
    "PATH", "SHELL", "TMPDIR", "TEMP", "TMP", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME",
    "USER",
];
const WINDOWS_CORE_ENV: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SHELL",
    "COMSPEC",
    "SYSTEMROOT",
    "WINDIR",
    "SYSTEMDRIVE",
    "USERNAME",
    "USERDOMAIN",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "PROGRAMDATA",
    "LOCALAPPDATA",
    "APPDATA",
    "TEMP",
    "TMP",
    "TMPDIR",
    "POWERSHELL",
    "PWSH",
];
const NON_INHERITABLE_ENV: &[&str] = &[
    "CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN",
    "NODE_REPL_AUTH_TOKEN",
    "CODEX_GUARDIAN_DECISIONS_API_KEY",
    "OPENAI_FEDERATION_RULE_ID",
    "OPENAI_IDENTITY_TOKEN_FILE",
    "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
];

pub fn env_pattern_matches(name: &LosslessString, pattern: &LosslessString) -> bool {
    let characters = |text: &LosslessString| {
        char::decode_utf16(text.code_units())
            .map(|character| match character {
                Ok(character) => character
                    .to_lowercase()
                    .collect::<String>()
                    .encode_utf16()
                    .collect::<Vec<_>>(),
                Err(error) => vec![error.unpaired_surrogate()],
            })
            .collect::<Vec<_>>()
    };
    let input = characters(name);
    let expression = characters(pattern);
    let (mut position, mut token) = (0usize, 0usize);
    let mut star: Option<usize> = None;
    let mut restart = 0usize;
    while position < input.len() {
        let current = expression.get(token);
        if current.is_some_and(|unit| unit == &[0x2a]) {
            star = Some(token);
            token += 1;
            restart = position;
        } else if current.is_some_and(|value| value == &[0x3f] || *value == input[position]) {
            position += 1;
            token += 1;
        } else if let Some(star_token) = star {
            token = star_token + 1;
            restart += 1;
            position = restart;
        } else {
            return false;
        }
    }
    while expression.get(token).is_some_and(|unit| unit == &[0x2a]) {
        token += 1;
    }
    token == expression.len()
}

#[derive(Clone, Debug)]
pub struct EnvPolicy {
    pub inherit: String,
    pub ignore_default_excludes: bool,
    pub exclude: Vec<LosslessString>,
    pub set: Vec<(LosslessString, LosslessString)>,
    pub include_only: Vec<LosslessString>,
}
fn invalid_env_policy() -> PolicyError {
    PolicyError::new(PolicyCode::InvalidEnv, "invalid environment policy")
}
pub fn read_env_policy(value: Option<&JsonValue>) -> Result<Option<EnvPolicy>, PolicyError> {
    let Some(value) = value.filter(|value| !matches!(value, JsonValue::Null)) else {
        return Ok(None);
    };
    let JsonValue::Object(policy) = value else {
        return Err(invalid_env_policy());
    };
    let inherit = match object_get(policy, "inherit") {
        Some(JsonValue::String(text)) => text
            .as_str()
            .filter(|text| matches!(*text, "none" | "core" | "all"))
            .ok_or_else(invalid_env_policy)?,
        _ => return Err(invalid_env_policy()),
    };
    let Some(JsonValue::Bool(ignore_default_excludes)) =
        object_get(policy, "ignoreDefaultExcludes")
    else {
        return Err(invalid_env_policy());
    };
    let strings = |key: &str| -> Result<Vec<LosslessString>, PolicyError> {
        let Some(JsonValue::Array(items)) = object_get(policy, key) else {
            return Err(invalid_env_policy());
        };
        items
            .iter()
            .map(|item| match item {
                JsonValue::String(text) => Ok(text.clone()),
                _ => Err(invalid_env_policy()),
            })
            .collect()
    };
    let Some(JsonValue::Object(set)) = object_get(policy, "set") else {
        return Err(invalid_env_policy());
    };
    let mut entries = vec![];
    for (key, item) in set.iter() {
        if let JsonValue::String(text) = item {
            entries.push((key.clone(), text.clone()));
        }
    }
    Ok(Some(EnvPolicy {
        inherit: inherit.to_owned(),
        ignore_default_excludes: *ignore_default_excludes,
        exclude: strings("exclude")?,
        set: entries,
        include_only: strings("includeOnly")?,
    }))
}

pub struct BuildProcessEnv<'a> {
    pub base: &'a BTreeMap<String, String>,
    pub env: &'a [(LosslessString, LosslessString)],
    pub env_policy: Option<&'a JsonValue>,
    pub windows: bool,
}

pub fn build_process_env(
    input: &BuildProcessEnv<'_>,
) -> Result<Vec<(LosslessString, LosslessString)>, PolicyError> {
    let policy = read_env_policy(input.env_policy)?;
    let core = if input.windows {
        WINDOWS_CORE_ENV
    } else {
        UNIX_CORE_ENV
    };
    let mut result: Vec<(LosslessString, LosslessString)> = vec![];
    let insert = |result: &mut Vec<(LosslessString, LosslessString)>,
                  key: &LosslessString,
                  value: &LosslessString| {
        if key.is_empty()
            || key
                .code_units()
                .any(|unit| unit == 0x3d || unit < 0x20 || unit == 0x7f)
            || value.code_units().any(|unit| unit == 0)
        {
            return;
        }
        if input.windows {
            let lowered = lower_units(key);
            result.retain(|(existing, _)| lower_units(existing) != lowered);
        }
        match result.iter_mut().find(|(existing, _)| existing == key) {
            Some((_, existing)) => *existing = value.clone(),
            None => result.push((key.clone(), value.clone())),
        }
    };
    if policy.as_ref().map(|policy| policy.inherit.as_str()) != Some("none") {
        for (key, value) in input.base {
            if policy
                .as_ref()
                .is_some_and(|policy| policy.inherit == "core")
                && !core
                    .iter()
                    .any(|allowed| ascii_lower(allowed) == ascii_lower(key))
            {
                continue;
            }
            if osc_secret_key(key) {
                continue;
            }
            if policy
                .as_ref()
                .is_some_and(|policy| !policy.ignore_default_excludes)
                && broad_secret_key(key)
            {
                continue;
            }
            insert(&mut result, &key.as_str().into(), &value.as_str().into());
        }
    }
    if let Some(policy) = &policy {
        result.retain(|(key, _)| {
            !policy
                .exclude
                .iter()
                .any(|pattern| env_pattern_matches(key, pattern))
        });
        for (key, value) in &policy.set {
            insert(&mut result, key, value);
        }
        if !policy.include_only.is_empty() {
            result.retain(|(key, _)| {
                policy
                    .include_only
                    .iter()
                    .any(|pattern| env_pattern_matches(key, pattern))
            });
        }
    }
    for (key, value) in input.env {
        insert(&mut result, key, value);
    }
    result.retain(|(key, _)| {
        key.as_str() != Some("CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE")
            && !NON_INHERITABLE_ENV
                .iter()
                .any(|name| LosslessString::from(ascii_lower(name)) == lower_units(key))
    });
    if result.len() > MAX_ENV_ENTRIES {
        return Err(PolicyError::new(
            PolicyCode::InvalidEnv,
            "environment exceeds the entry limit",
        ));
    }
    let bytes: usize = result
        .iter()
        .map(|(key, value)| utf8_len(key) + utf8_len(value))
        .sum();
    if bytes > MAX_ENV_BYTES {
        return Err(PolicyError::new(
            PolicyCode::InvalidEnv,
            "environment exceeds the byte limit",
        ));
    }
    Ok(result)
}

pub fn assert_argv(argv: &[LosslessString]) -> Result<(), PolicyError> {
    if argv.is_empty() || argv.len() > MAX_ARGV || argv[0].is_empty() {
        return Err(PolicyError::new(
            PolicyCode::InvalidArgv,
            "argv must contain a program and at most 512 arguments",
        ));
    }
    for argument in argv {
        if argument.code_units().any(|unit| unit == 0) || utf8_len(argument) > MAX_ARG_BYTES {
            return Err(PolicyError::new(
                PolicyCode::InvalidArgv,
                "argv entry is invalid or exceeds the byte limit",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod lossless_tests {
    use super::*;
    use crate::cca::value::parse_json;

    #[test]
    fn environment_selectors_do_not_match_replacement_characters() {
        let base = BTreeMap::new();
        let policy = parse_json(r#"{"inherit":"none","ignoreDefaultExcludes":true,"exclude":[],"set":{"X\ufffd":"kept"},"includeOnly":["X\ud800"]}"#).unwrap();
        let env = build_process_env(&BuildProcessEnv {
            base: &base,
            env: &[],
            env_policy: Some(&policy),
            windows: false,
        })
        .unwrap();
        assert!(env.is_empty());
        let policy = parse_json(r#"{"inherit":"none","ignoreDefaultExcludes":true,"exclude":[],"set":{"X\ud800":"original","X\ufffd":"replacement"},"includeOnly":["X\ud800"]}"#).unwrap();
        let env = build_process_env(&BuildProcessEnv {
            base: &base,
            env: &[],
            env_policy: Some(&policy),
            windows: false,
        })
        .unwrap();
        assert_eq!(
            env,
            vec![(
                LosslessString::from_utf16(vec![0x58, 0xd800]),
                "original".into()
            )]
        );
    }

    #[test]
    fn windows_environment_policy_assignments_keep_source_order() {
        let base = BTreeMap::new();
        for (set, key) in [
            (r#"{"path":"first","PATH":"last"}"#, "PATH"),
            (r#"{"PATH":"first","path":"last"}"#, "path"),
        ] {
            let policy = parse_json(&format!(r#"{{"inherit":"none","ignoreDefaultExcludes":true,"exclude":[],"set":{set},"includeOnly":[]}}"#)).unwrap();
            let env = build_process_env(&BuildProcessEnv {
                base: &base,
                env: &[],
                env_policy: Some(&policy),
                windows: true,
            })
            .unwrap();
            assert_eq!(env, vec![(key.into(), "last".into())]);
        }
    }

    #[test]
    fn policy_error_limit_counts_utf16_and_keeps_split_surrogate() {
        let error = PolicyError::new(PolicyCode::InvalidEnv, format!("{}😀", "a".repeat(255)));
        assert_eq!(error.message.len(), 256);
        assert_eq!(error.message.code_units().last(), Some(0xd83d));
    }

    #[tokio::test]
    async fn sandbox_authorization_metadata_keeps_canonical_insertion_order() {
        let sandbox = parse_json(r#"{"permissions":{"type":"disabled"}}"#).unwrap();
        let proxy = parse_json(r#"{"proxy":{}}"#).unwrap();
        let policy = resolve_sandbox(
            &SandboxIntent {
                sandbox: Some(&sandbox),
                enforce_managed_network: true,
                network_proxy: Some(&proxy),
                ..Default::default()
            },
            &ResolveSandboxOptions::default(),
        )
        .await
        .unwrap()
        .unwrap();
        let keys = policy
            .metadata
            .iter()
            .map(|(key, _)| key.as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            keys,
            [
                "sandboxManagedNetwork",
                "sandboxNetworkProxy",
                "sandboxProfile",
                "sandboxFileSystem",
                "sandboxNetwork"
            ]
        );
    }

    #[tokio::test]
    async fn sandbox_numbers_use_canonical_integer_bounds() {
        for (ports, valid) in [
            ("[0,65535]", true),
            ("[-1]", false),
            ("[65536]", false),
            ("[1.5]", false),
        ] {
            let network = parse_json(&format!(r#"{{"loopbackPorts":{ports},"allowLocalBinding":false,"allowUnixSockets":["\ud800"]}}"#)).unwrap();
            assert_eq!(
                resolve_sandbox(
                    &SandboxIntent {
                        managed_network: Some(&network),
                        ..Default::default()
                    },
                    &ResolveSandboxOptions::default()
                )
                .await
                .is_ok(),
                valid
            );
        }
        for (depth, valid) in [
            ("1", true),
            ("9007199254740991", true),
            ("0", false),
            ("1.5", false),
            ("9007199254740992", false),
        ] {
            let sandbox = parse_json(&r#"{"permissions":{"type":"managed","network":"enabled","file_system":{"type":"restricted","entries":[],"glob_scan_max_depth":DEPTH}}}"#.replace("DEPTH", depth)).unwrap();
            assert_eq!(
                resolve_sandbox(
                    &SandboxIntent {
                        sandbox: Some(&sandbox),
                        ..Default::default()
                    },
                    &ResolveSandboxOptions::default()
                )
                .await
                .is_ok(),
                valid
            );
        }
    }
}
