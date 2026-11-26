use super::{
    credential_broker::CredentialBrokerEntry,
    encoding::random_hex,
    error::{AuthorizationInput, AuthorizeFn},
    network_proxy::{CUSTOM_CA_ENV_KEYS, PROXY_ACTIVE_ENV_KEY, Platform, is_managed_proxy_env_var},
    policy::{self, BuildProcessEnv},
    shell_snapshot_scripts as scripts,
    value::{JsonObject, LosslessString, Value, concat, os_text, stringify_json, utf8_len},
};
use std::{
    collections::BTreeMap,
    io,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{io::AsyncReadExt, sync::OnceCell};

pub const SNAPSHOT_FD: i32 = 10;
const MAX_CACHED_SNAPSHOTS: usize = 16;
const MAX_SNAPSHOT_BYTES: usize = 512 * 1024;
const MAX_FILE_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
const MAX_SNAPSHOT_CAPTURE_BYTES: usize = 8 * MAX_SNAPSHOT_BYTES;
const MAX_FILE_SNAPSHOT_CAPTURE_BYTES: usize = 8 * 1024 * 1024;
const MAX_SNAPSHOT_ENV_VALUE_BYTES: usize = 60 * 1024;
const MAX_SNAPSHOT_SCOPE_BYTES: usize = 256;
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);
const SNAPSHOT_RETRY_BACKOFF_MS: u128 = 1_000;
const MAX_SNAPSHOT_ATTEMPTS: u32 = 3;
const SOURCE_MARKER: &str = "CODEX_SNAPSHOT_SOURCE";
const THREAD_ID_ENV: &str = "CODEX_THREAD_ID";
const TOOL_CALL_ID_ENV: &str = "CODEX_TOOL_CALL_ID";
const SNAPSHOT_BROKERED_VALUE_ENV_PREFIX: &str = "CODEX_NETWORK_PROXY_SNAPSHOT_BROKERED_VALUE_";
const SNAPSHOT_BROKERED_UNSET_ENV_PREFIX: &str = "CODEX_NETWORK_PROXY_SNAPSHOT_BROKERED_UNSET_";
const CONFIGURED_VALUE_PREFIX: &str = "__CODEX_SHELL_SNAPSHOT_CONFIGURED_";
pub const SNAPSHOT_MASKING_FALLBACK_WARNING: &str =
    "Credential masking is unavailable for this shell snapshot; running with unmasked credentials.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellInfo {
    pub name: LosslessString,
    pub path: LosslessString,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellSnapshotRequest {
    pub scope_id: LosslessString,
    pub shell: ShellInfo,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellSnapshotError {
    pub code: i32,
    pub message: LosslessString,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptureError {
    pub reason: &'static str,
    pub message: String,
}
fn capture_error(reason: &'static str, message: impl Into<String>) -> CaptureError {
    CaptureError {
        reason,
        message: message.into(),
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnapshotShell {
    Bash,
    Zsh,
    Sh,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Replay {
    File,
    Environment,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedShellSnapshot {
    pub state: LosslessString,
    pub file_source: bool,
    pub environment: Vec<(LosslessString, LosslessString)>,
}

#[cfg(unix)]
pub type SnapshotFd = std::os::fd::OwnedFd;
#[cfg(not(unix))]
pub type SnapshotFd = ();

pub struct ShellSnapshotLaunch {
    pub argv: Vec<LosslessString>,
    pub env: Vec<(LosslessString, LosslessString)>,
    pub fd: Option<SnapshotFd>,
}
impl ShellSnapshotLaunch {
    pub fn release(&mut self) {
        self.fd.take();
    }
}

fn capture_script(shell: SnapshotShell, probe: bool, protected: bool) -> String {
    let body = match shell {
        SnapshotShell::Zsh => format!("{}{}", scripts::ZSH_STARTUP, scripts::ZSH_CAPTURE),
        SnapshotShell::Bash => format!("{}{}", scripts::BASH_STARTUP, scripts::BASH_CAPTURE),
        SnapshotShell::Sh => format!("{}{}", scripts::SH_STARTUP, scripts::SH_CAPTURE),
    };
    let marker = |flag: u8| format!("printf '\\0%s\\0%s\\0' '{SOURCE_MARKER}' {flag}");
    let prefix = if probe {
        format!(
            "if case '' in '') ;; esac 2>/dev/null </dev/fd/{SNAPSHOT_FD}; then {}; else {}; fi\n",
            marker(1),
            marker(0)
        )
    } else {
        format!("{}\n", marker(0))
    };
    let readonly = if protected && shell == SnapshotShell::Zsh {
        scripts::READONLY_EXPORT_CHECK
    } else {
        ""
    };
    format!("{prefix}{body}{readonly}")
}

fn env_get<'a>(
    env: &'a [(LosslessString, LosslessString)],
    key: &LosslessString,
) -> Option<&'a LosslessString> {
    env.iter()
        .rev()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value)
}

fn env_set(
    env: &mut Vec<(LosslessString, LosslessString)>,
    key: LosslessString,
    value: LosslessString,
) {
    match env.iter_mut().find(|(name, _)| name == &key) {
        Some((_, existing)) => *existing = value,
        None => env.push((key, value)),
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

fn starts_with(text: &LosslessString, prefix: &str) -> bool {
    text.len() >= prefix.len()
        && text
            .code_units()
            .zip(prefix.encode_utf16())
            .all(|(left, right)| left == right)
}

fn valid_shell_name(name: &LosslessString) -> bool {
    let mut units = name.code_units();
    let letter = |unit: u16| (65..=90).contains(&unit) || (97..=122).contains(&unit) || unit == 95;
    units.next().is_some_and(letter) && units.all(|unit| letter(unit) || (48..=57).contains(&unit))
}

fn managed_env(key: &LosslessString, value: &LosslessString, platform: Platform) -> bool {
    let Some(key) = key.as_str() else {
        return false;
    };
    if let Some(value) = value.as_str() {
        return is_managed_proxy_env_var(key, value, platform);
    }
    if CUSTOM_CA_ENV_KEYS.contains(&key) {
        let units = value.code_units().collect::<Vec<_>>();
        let name = units
            .rsplit(|unit| *unit == 47 || *unit == 92)
            .next()
            .unwrap_or_default();
        let prefix = "ca-bundle-".encode_utf16().collect::<Vec<_>>();
        let suffix = ".pem".encode_utf16().collect::<Vec<_>>();
        return name.len() == prefix.len() + 64 + suffix.len()
            && name.starts_with(&prefix)
            && name.ends_with(&suffix)
            && name[prefix.len()..name.len() - suffix.len()]
                .iter()
                .all(|unit| (48..=57).contains(unit) || (97..=102).contains(unit));
    }
    if platform == Platform::Darwin && key == "GIT_SSH_COMMAND" {
        return starts_with(value, "CODEX_PROXY_GIT_SSH_COMMAND=1 ");
    }
    is_managed_proxy_env_var(key, "", platform)
}

fn internal_key(key: &LosslessString) -> bool {
    [
        SNAPSHOT_BROKERED_VALUE_ENV_PREFIX,
        SNAPSHOT_BROKERED_UNSET_ENV_PREFIX,
        CONFIGURED_VALUE_PREFIX,
    ]
    .iter()
    .any(|prefix| starts_with(key, prefix))
}

fn build_brokered_credential_exports(
    env: &[(LosslessString, LosslessString)],
    remove_copies: bool,
) -> LosslessString {
    let names = |prefix: &str| {
        let mut names = env
            .iter()
            .filter(|(key, _)| starts_with(key, prefix))
            .map(|(copy, _)| {
                (
                    LosslessString::from_utf16(copy.code_units().skip(prefix.len()).collect()),
                    copy.clone(),
                )
            })
            .filter(|(key, _)| valid_shell_name(key))
            .collect::<Vec<_>>();
        names.sort_by(|(left, _), (right, _)| left.cmp(right));
        names
    };
    let mut blocks = vec![];
    let values = names(SNAPSHOT_BROKERED_VALUE_ENV_PREFIX).iter().map(|(key, copy)| {
        let (key, copy) = (key.as_str().expect("valid shell name"), copy.as_str().expect("valid shell copy"));
        let restore = format!("if [ -z \"${{{copy}+x}}\" ]; then exit 1; fi\nif [ -n \"${{{key}+x}}\" ] && [ -n \"${{{key}}}\" ] && [ \"${{{key}}}\" != \"${{{copy}}}\" ]; then export {key}=\"${{{copy}}}\" || exit 1; fi\nif [ -n \"${{{key}+x}}\" ] && [ -n \"${{{key}}}\" ] && [ \"${{{key}}}\" != \"${{{copy}}}\" ]; then exit 1; fi");
        if remove_copies { format!("{restore}\nunset {copy} || exit 1") } else { restore }
    }).collect::<Vec<_>>();
    if !values.is_empty() {
        blocks.push(values.join("\n"));
    }
    let unsets = names(SNAPSHOT_BROKERED_UNSET_ENV_PREFIX).iter().map(|(key, marker)| {
        let (key, marker) = (key.as_str().expect("valid shell name"), marker.as_str().expect("valid shell marker"));
        let restore = format!("if [ -z \"${{{marker}+x}}\" ]; then exit 1; fi\nif [ -n \"${{{key}+x}}\" ] && [ -n \"${{{key}}}\" ]; then unset {key} || exit 1; fi\nif [ -n \"${{{key}+x}}\" ] && [ -n \"${{{key}}}\" ]; then exit 1; fi");
        if remove_copies { format!("{restore}\nunset {marker} || exit 1") } else { restore }
    }).collect::<Vec<_>>();
    if !unsets.is_empty() {
        blocks.push(unsets.join("\n"));
    }
    if blocks.is_empty() {
        return "".into();
    }
    format!("case $- in\n  *x*) __CODEX_SNAPSHOT_BROKER_XTRACE=1; set +x ;;\n  *) __CODEX_SNAPSHOT_BROKER_XTRACE= ;;\nesac\n{}\nif [ -n \"$__CODEX_SNAPSHOT_BROKER_XTRACE\" ]; then\n  unset __CODEX_SNAPSHOT_BROKER_XTRACE\n  set -x\nelse\n  unset __CODEX_SNAPSHOT_BROKER_XTRACE\nfi", blocks.join("\n")).into()
}

fn take_record<'a>(remaining: &mut &'a [u8]) -> Option<&'a [u8]> {
    let boundary = remaining.iter().position(|byte| *byte == 0)?;
    let record = &remaining[..boundary];
    *remaining = &remaining[boundary + 1..];
    Some(record)
}
fn invalid_capture(message: &str) -> CaptureError {
    capture_error("invalid_capture", message)
}

pub fn parse_shell_snapshot(
    shell: SnapshotShell,
    output: &[u8],
    env_policy: Option<&Value>,
    replay: Replay,
) -> Result<ParsedShellSnapshot, CaptureError> {
    parse_with_access(
        shell,
        output,
        env_policy,
        replay,
        super::executor::ExecutorAccess::Ordinary,
    )
}

fn parse_with_access(
    shell: SnapshotShell,
    output: &[u8],
    env_policy: Option<&Value>,
    replay: Replay,
    access: super::executor::ExecutorAccess,
) -> Result<ParsedShellSnapshot, CaptureError> {
    let ordinary = access == super::executor::ExecutorAccess::Ordinary;
    let mut cursor: &[u8] = output;
    let state_record = take_record(&mut cursor);
    let marker = b"# Snapshot file";
    let state_text = state_record.and_then(|record| {
        let start = record
            .windows(marker.len())
            .position(|window| window == marker)?;
        String::from_utf8(record[start..].to_vec()).ok()
    });
    let aliases =
        take_record(&mut cursor).and_then(|record| String::from_utf8(record.to_vec()).ok());
    let (Some(state_text), Some(aliases)) = (state_text, aliases) else {
        return Err(invalid_capture("invalid shell snapshot capture"));
    };
    loop {
        let key = take_record(&mut cursor)
            .ok_or_else(|| invalid_capture("invalid shell snapshot capture"))?;
        if key.is_empty() {
            break;
        }
        take_record(&mut cursor)
            .ok_or_else(|| invalid_capture("invalid shell snapshot capture"))?;
    }
    if shell == SnapshotShell::Sh {
        loop {
            let entry = take_record(&mut cursor)
                .ok_or_else(|| invalid_capture("invalid shell snapshot capture"))?;
            if entry.is_empty() {
                break;
            }
        }
    }
    let raw_environment = cursor;
    let state = LosslessString::from(format!("{state_text}{aliases}"));
    if raw_environment.len() > MAX_SNAPSHOT_BYTES {
        return Err(capture_error(
            "environment_too_large",
            format!("shell snapshot environment exceeds {MAX_SNAPSHOT_BYTES} bytes"),
        ));
    }
    let state_limit = if replay == Replay::File {
        MAX_FILE_SNAPSHOT_BYTES
    } else {
        MAX_SNAPSHOT_BYTES - raw_environment.len()
    };
    if utf8_len(&state) > state_limit {
        return Err(capture_error(
            "state_too_large",
            format!("shell snapshot state exceeds {state_limit} bytes"),
        ));
    }
    let mut captured = vec![];
    for entry in raw_environment.split(|byte| *byte == 0) {
        if entry.is_empty() {
            continue;
        }
        let Ok(decoded) = std::str::from_utf8(entry) else {
            continue;
        };
        let Some(equals) = decoded.find('=') else {
            continue;
        };
        env_set(
            &mut captured,
            decoded[..equals].into(),
            decoded[equals + 1..].into(),
        );
    }
    captured = ordered_environment(&captured);
    if ordinary && env_get(&captured, &PROXY_ACTIVE_ENV_KEY.into()).is_some() {
        captured.retain(|(key, value)| !managed_env(key, value, Platform::current()));
    }
    let empty: BTreeMap<String, String> = BTreeMap::new();
    let native_captured = captured
        .iter()
        .map(|(key, value)| {
            (
                key.as_str().expect("decoded capture key").to_owned(),
                value.as_str().expect("decoded capture value").to_owned(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let environment = match env_policy.filter(|policy| !matches!(policy, Value::Null)) {
        None => policy::build_process_env_with_access(
            &BuildProcessEnv {
                base: &empty,
                env: &captured,
                env_policy: None,
                windows: false,
            },
            access,
        ),
        Some(policy) => {
            let adjusted = match policy {
                Value::Object(map) => {
                    let mut map = map.clone();
                    map.insert("inherit".into(), Value::String("all".into()));
                    Value::Object(map)
                }
                other => other.clone(),
            };
            policy::build_process_env_with_access(
                &BuildProcessEnv {
                    base: &native_captured,
                    env: &[],
                    env_policy: Some(&adjusted),
                    windows: false,
                },
                access,
            )
        }
    };
    let environment = environment.map_err(|_| {
        capture_error(
            "invalid_environment",
            "shell snapshot environment violates the environment policy",
        )
    })?;
    let mut ordered = vec![];
    for (key, _) in captured.iter().chain(environment.iter()) {
        if let Some(value) = env_get(&environment, key) {
            env_set(&mut ordered, key.clone(), value.clone());
        }
    }
    let mut environment = ordered_environment(&ordered);
    if ordinary {
        environment.retain(|(key, _)| {
            ![THREAD_ID_ENV, TOOL_CALL_ID_ENV, "PWD", "OLDPWD"]
                .iter()
                .any(|name| key.as_str() == Some(*name))
        });
    }
    Ok(ParsedShellSnapshot {
        state,
        file_source: replay == Replay::File,
        environment,
    })
}

#[cfg(unix)]
fn materialize(
    shell: SnapshotShell,
    state: &LosslessString,
    root: &Path,
) -> io::Result<SnapshotFd> {
    use std::{
        io::Write,
        os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    };
    let directory = root.join(format!("cca-shell-snapshot-{}", random_hex(8)));
    std::fs::DirBuilder::new().mode(0o700).create(&directory)?;
    let outcome = (|| -> io::Result<SnapshotFd> {
        let file = directory.join("state");
        let mut writer = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&file)?;
        let reader = std::fs::File::open(&file)?;
        std::fs::remove_file(&file)?;
        std::fs::remove_dir(&directory)?;
        if reader.metadata()?.nlink() != 0 {
            return Err(io::Error::other("shell snapshot transport is still linked"));
        }
        let close = match shell {
            SnapshotShell::Bash => format!("\\exec {SNAPSHOT_FD}<&-\n"),
            _ => format!(
                "__codex_snapshot_fd={SNAPSHOT_FD}\nexec {{__codex_snapshot_fd}}<&-\nunset __codex_snapshot_fd\n"
            ),
        };
        writer.write_all(os_text(&concat(&[&close.into(), state])).as_bytes())?;
        drop(writer);
        Ok(std::os::fd::OwnedFd::from(reader))
    })();
    let _ = std::fs::remove_dir_all(&directory);
    outcome
}
#[cfg(not(unix))]
fn materialize(
    _shell: SnapshotShell,
    _state: &LosslessString,
    _root: &Path,
) -> io::Result<SnapshotFd> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "shell snapshots are unsupported on this platform",
    ))
}

#[derive(Clone)]
pub struct PrepareInput {
    pub session_id: String,
    pub process_id: LosslessString,
    pub request: ShellSnapshotRequest,
    pub argv: Vec<LosslessString>,
    pub arg0: Option<LosslessString>,
    pub cwd: LosslessString,
    pub env: Vec<(LosslessString, LosslessString)>,
    pub request_env: Vec<(LosslessString, LosslessString)>,
    pub env_policy: Option<Value>,
    pub sandbox_key: Option<String>,
}

struct CaptureCell {
    result: OnceCell<Option<Arc<ParsedShellSnapshot>>>,
    retry_at: Mutex<Option<u128>>,
}
struct CacheEntry {
    key: String,
    attempts: u32,
    cell: Arc<CaptureCell>,
}

pub struct ShellSnapshotCache {
    access: super::executor::ExecutorAccess,
    authorize: AuthorizeFn,
    platform: Platform,
    temp_root: PathBuf,
    entries: Mutex<Vec<CacheEntry>>,
    running: Mutex<Vec<u32>>,
    closed: AtomicBool,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0)
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    unsafe {
        if libc::kill(-(pid as i32), libc::SIGKILL) == -1 {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
}
#[cfg(not(unix))]
fn kill_group(_pid: u32) {}

impl ShellSnapshotCache {
    pub fn new(authorize: AuthorizeFn, platform: Platform, temp_root: Option<PathBuf>) -> Self {
        Self::with_access(
            authorize,
            platform,
            temp_root,
            super::executor::ExecutorAccess::Ordinary,
        )
    }

    pub(super) fn with_access(
        authorize: AuthorizeFn,
        platform: Platform,
        temp_root: Option<PathBuf>,
        access: super::executor::ExecutorAccess,
    ) -> Self {
        Self {
            access,
            authorize,
            platform,
            temp_root: temp_root.unwrap_or_else(std::env::temp_dir),
            entries: Mutex::new(vec![]),
            running: Mutex::new(vec![]),
            closed: AtomicBool::new(false),
        }
    }

    #[cfg(unix)]
    async fn run_capture(
        &self,
        input: &PrepareInput,
        shell: SnapshotShell,
        protected: bool,
    ) -> Result<ParsedShellSnapshot, CaptureError> {
        use std::os::fd::AsRawFd;
        let mut metadata = JsonObject::new();
        metadata.insert("processId".into(), Value::String(input.process_id.clone()));
        metadata.insert("cwd".into(), Value::String(input.cwd.clone()));
        metadata.insert(
            "shellSnapshotScope".into(),
            Value::String(input.request.scope_id.clone()),
        );
        let mut authorization = AuthorizationInput::new(
            "shell",
            vec![concat(&[
                &input.request.shell.path,
                &" -lc <shell snapshot capture>".into(),
            ])],
        );
        authorization.metadata = Some(metadata);
        let grant = (self.authorize)(authorization).await.map_err(|_| {
            capture_error(
                "authorization_denied",
                "shell snapshot capture was not authorized",
            )
        })?;
        let outcome = async {
            let probe = if shell != SnapshotShell::Sh {
                materialize(shell, &"".into(), &self.temp_root).ok()
            } else {
                None
            };
            let limit = if probe.is_none() {
                MAX_SNAPSHOT_CAPTURE_BYTES
            } else {
                MAX_FILE_SNAPSHOT_CAPTURE_BYTES
            };
            let mut argv = input.argv.iter().map(os_text).collect::<Vec<_>>();
            argv[2] = capture_script(shell, probe.is_some(), protected);
            let mut env = ordered_environment(&input.env);
            if self.access == super::executor::ExecutorAccess::Ordinary {
                env.retain(|(key, _)| key.as_str() != Some(TOOL_CALL_ID_ENV));
            }
            if self.closed.load(Ordering::Acquire) {
                return Err(capture_error("closed", "shell snapshot cache closed"));
            }
            let mut command = tokio::process::Command::new(&argv[0]);
            command
                .args(&argv[1..])
                .current_dir(os_text(&input.cwd))
                .env_clear()
                .envs(
                    env.iter()
                        .map(|(key, value)| (os_text(key), os_text(value))),
                );
            if let Some(arg0) = &input.arg0 {
                command.arg0(os_text(arg0));
            }
            command
                .process_group(0)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null());
            if let Some(probe) = &probe {
                let raw = probe.as_raw_fd();
                unsafe {
                    command.pre_exec(move || {
                        if raw == SNAPSHOT_FD {
                            let flags = libc::fcntl(raw, libc::F_GETFD);
                            if flags == -1
                                || libc::fcntl(raw, libc::F_SETFD, flags & !libc::FD_CLOEXEC) == -1
                            {
                                return Err(io::Error::last_os_error());
                            }
                        } else if libc::dup2(raw, SNAPSHOT_FD) == -1 {
                            return Err(io::Error::last_os_error());
                        }
                        Ok(())
                    });
                }
            }
            let mut child = command
                .spawn()
                .map_err(|_| capture_error("spawn_failed", "cannot capture shell snapshot"))?;
            drop(probe);
            let pid = child.id().unwrap_or(0);
            self.running
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(pid);
            let mut stdout = child
                .stdout
                .take()
                .ok_or_else(|| capture_error("spawn_failed", "cannot capture shell snapshot"))?;
            let read = async {
                let mut output = vec![];
                let mut chunk = vec![0u8; 64 * 1024];
                loop {
                    let count = stdout.read(&mut chunk).await.map_err(|_| {
                        capture_error("spawn_failed", "cannot capture shell snapshot")
                    })?;
                    if count == 0 {
                        break;
                    }
                    if output.len() + count > limit {
                        return Err(capture_error(
                            "capture_too_large",
                            format!("shell snapshot capture exceeds {limit} bytes"),
                        ));
                    }
                    output.extend_from_slice(&chunk[..count]);
                }
                let status = child
                    .wait()
                    .await
                    .map_err(|_| capture_error("spawn_failed", "cannot capture shell snapshot"))?;
                if !status.success() {
                    return Err(capture_error(
                        "nonzero_exit",
                        format!(
                            "shell snapshot capture exited with {}",
                            status
                                .code()
                                .map_or_else(|| "signal".to_owned(), |code| code.to_string())
                        ),
                    ));
                }
                Ok(output)
            };
            let output = match tokio::time::timeout(SNAPSHOT_TIMEOUT, read).await {
                Ok(Ok(output)) => Ok(output),
                Ok(Err(error)) => {
                    kill_group(pid);
                    Err(error)
                }
                Err(_) => {
                    kill_group(pid);
                    Err(capture_error("timeout", "shell snapshot capture timed out"))
                }
            };
            self.running
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .retain(|candidate| *candidate != pid);
            let output = output?;
            let marker = format!("\0{SOURCE_MARKER}\0").into_bytes();
            let marker_at = output
                .windows(marker.len())
                .position(|window| window == marker.as_slice())
                .ok_or_else(|| invalid_capture("missing snapshot source probe"))?;
            let flagged = &output[marker_at + marker.len()..];
            if flagged.len() < 2 {
                return Err(invalid_capture("incomplete snapshot source probe"));
            }
            let replay = if flagged[0] == 0x31 && flagged[1] == 0 {
                Replay::File
            } else {
                Replay::Environment
            };
            if replay == Replay::Environment && output.len() > MAX_SNAPSHOT_CAPTURE_BYTES {
                return Err(capture_error(
                    "capture_too_large",
                    format!("shell snapshot capture exceeds {MAX_SNAPSHOT_CAPTURE_BYTES} bytes"),
                ));
            }
            parse_with_access(
                shell,
                &flagged[2..],
                input.env_policy.as_ref(),
                replay,
                self.access,
            )
        }
        .await;
        let _ = grant.release().await;
        outcome
    }
    #[cfg(not(unix))]
    async fn run_capture(
        &self,
        _input: &PrepareInput,
        _shell: SnapshotShell,
        _protected: bool,
    ) -> Result<ParsedShellSnapshot, CaptureError> {
        Err(capture_error(
            "spawn_failed",
            "cannot capture shell snapshot",
        ))
    }

    fn lookup(&self, key: &str) -> Arc<CaptureCell> {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let fresh = || {
            Arc::new(CaptureCell {
                result: OnceCell::new(),
                retry_at: Mutex::new(None),
            })
        };
        let Some(index) = entries.iter().position(|entry| entry.key == key) else {
            entries.push(CacheEntry {
                key: key.to_owned(),
                attempts: 1,
                cell: fresh(),
            });
            if entries.len() > MAX_CACHED_SNAPSHOTS {
                entries.remove(0);
            }
            return entries.last().expect("entry pushed").cell.clone();
        };
        let mut entry = entries.remove(index);
        let retry_at = *entry
            .cell
            .retry_at
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if retry_at.is_some_and(|at| entry.attempts < MAX_SNAPSHOT_ATTEMPTS && now_ms() >= at) {
            entry.attempts += 1;
            entry.cell = fresh();
        }
        let cell = entry.cell.clone();
        entries.push(entry);
        cell
    }

    fn build_launch(
        &self,
        input: &PrepareInput,
        shell: SnapshotShell,
        snapshot: &ParsedShellSnapshot,
        replay_env: Option<Vec<(LosslessString, LosslessString)>>,
    ) -> Option<ShellSnapshotLaunch> {
        let protected = replay_env.is_some();
        let mut env = replay_env.unwrap_or_else(|| {
            let mut env = ordered_environment(&input.env);
            for (key, value) in &snapshot.environment {
                env_set(&mut env, key.clone(), value.clone());
            }
            for (name, value) in ordered_environment(&input.request_env) {
                env_set(
                    &mut env,
                    name.clone(),
                    env_get(&input.env, &name).unwrap_or(&value).clone(),
                );
            }
            env
        });
        let mut fd = None;
        let restore;
        if snapshot.file_source && shell != SnapshotShell::Sh {
            fd = Some(materialize(shell, &snapshot.state, &self.temp_root).ok()?);
            restore = format!(". /dev/fd/{SNAPSHOT_FD}");
        } else {
            let text = os_text(&snapshot.state);
            let bytes = text.as_bytes();
            let mut names: Vec<String> = vec![];
            let mut offset = 0;
            while offset < bytes.len() {
                let mut end = (offset + MAX_SNAPSHOT_ENV_VALUE_BYTES).min(bytes.len());
                while end < bytes.len() && (bytes[end] & 0xc0) == 0x80 {
                    end -= 1;
                }
                let name = format!("__CODEX_SHELL_SNAPSHOT_STATE_{}", names.len());
                env_set(
                    &mut env,
                    name.clone().into(),
                    String::from_utf8(bytes[offset..end].to_vec())
                        .expect("UTF-8 chunk boundary")
                        .into(),
                );
                names.push(name);
                offset = end;
            }
            let joined = names
                .iter()
                .map(|name| {
                    if protected {
                        format!("${{{name}:?missing shell snapshot chunk}}")
                    } else {
                        format!("${{{name}}}")
                    }
                })
                .collect::<String>();
            restore = format!("eval \"unset {}\n{}\"", names.join(" "), joined);
        }
        let (flag, startup) = match shell {
            SnapshotShell::Bash => ("-pc", "set +o privileged\n"),
            SnapshotShell::Zsh => ("-fc", "setopt RCS\n"),
            SnapshotShell::Sh => ("-c", ""),
        };
        let mut argv = input.argv.clone();
        argv[1] = flag.into();
        let stderr = if protected { " 2>&1" } else { "" };
        let failure = if protected { "; exit 1" } else { "" };
        argv[2] = concat(&[&format!("{startup}if ! {restore} >/dev/null{stderr}; then printf 'failed to restore shell snapshot\\n' >&2{failure}; fi\n").into(), &input.argv[2]]);
        Some(ShellSnapshotLaunch {
            argv,
            env: ordered_environment(&env),
            fd,
        })
    }

    fn fallback_launch(&self, input: &PrepareInput) -> ShellSnapshotLaunch {
        let mut argv = input.argv.clone();
        argv[2] = concat(&[
            &format!("\\builtin printf '%s\\n' '{SNAPSHOT_MASKING_FALLBACK_WARNING}' >&2\n").into(),
            &input.argv[2],
        ]);
        ShellSnapshotLaunch {
            argv,
            env: ordered_environment(&input.env),
            fd: None,
        }
    }

    fn protected_launch(
        &self,
        input: &PrepareInput,
        shell: SnapshotShell,
        snapshot: &ParsedShellSnapshot,
        entry: &CredentialBrokerEntry,
    ) -> Result<ShellSnapshotLaunch, ShellSnapshotError> {
        let managed = ordered_environment(&input.env)
            .into_iter()
            .filter(|(key, value)| managed_env(key, value, self.platform))
            .collect::<Vec<_>>();
        let configured = ordered_environment(&input.request_env)
            .into_iter()
            .filter(|(key, value)| !internal_key(key) && !managed_env(key, value, self.platform))
            .collect::<Vec<_>>();
        let mut combined = ordered_environment(&snapshot.environment);
        for (key, value) in configured.iter().chain(managed.iter()) {
            env_set(&mut combined, key.clone(), value.clone());
        }
        combined.retain(|(key, _)| !internal_key(key));
        let masked = entry
            .broker
            .mask_environment(&ordered_environment(&combined))
            .map_err(|_| ShellSnapshotError {
                code: -32603,
                message: "failed to mask shell snapshot".into(),
            })?;
        let masked = masked.env;
        let mut replay_env = masked.clone();
        let mut exports = String::new();
        for key in entry.broker.brokered_keys(&masked) {
            let value = env_get(&masked, &key).cloned().unwrap_or_else(|| "".into());
            if managed_env(&key, &value, self.platform) {
                continue;
            }
            if !valid_shell_name(&key) {
                return Ok(self.fallback_launch(input));
            }
            let copy = concat(&[&SNAPSHOT_BROKERED_VALUE_ENV_PREFIX.into(), &key]);
            exports.push_str(&format!(
                "\\builtin export {}=\"${{{}}}\" || exit 1\n",
                key.as_str().expect("valid shell name"),
                copy.as_str().expect("valid shell copy")
            ));
            env_set(&mut replay_env, copy, value);
        }
        let mut keys = configured
            .iter()
            .map(|(key, _)| key)
            .filter(|key| valid_shell_name(key))
            .collect::<Vec<_>>();
        keys.sort();
        let mut overrides = String::new();
        for (index, key) in keys.iter().enumerate() {
            let Some(value) = env_get(&masked, key) else {
                continue;
            };
            let copy = format!("{CONFIGURED_VALUE_PREFIX}{index}");
            env_set(&mut replay_env, copy.clone().into(), value.clone());
            overrides.push_str(&format!("if [ -z \"${{{copy}+x}}\" ]; then exit 1; fi\n\\builtin export {}=\"${{{copy}}}\" || exit 1\n\\builtin unset {copy} || exit 1\n", key.as_str().expect("valid shell name")));
        }
        replay_env = ordered_environment(&replay_env);
        let before = build_brokered_credential_exports(&replay_env, false);
        let after = build_brokered_credential_exports(&replay_env, true);
        let state = concat(&[
            &before,
            &"\n".into(),
            &exports.into(),
            &entry.broker.mask_text(&snapshot.state),
            &"\n".into(),
            &overrides.into(),
            &"\n\\builtin test \"$?\" -eq 0 || exit 1\n".into(),
            &after,
            &"\n".into(),
        ]);
        let environment_bytes = replay_env
            .iter()
            .map(|(key, value)| utf8_len(key) + utf8_len(value) + 2)
            .sum::<usize>();
        if environment_bytes > MAX_SNAPSHOT_BYTES {
            return Ok(self.fallback_launch(input));
        }
        let limit = if snapshot.file_source {
            MAX_FILE_SNAPSHOT_BYTES
        } else {
            MAX_SNAPSHOT_BYTES - environment_bytes
        };
        if utf8_len(&state) > limit {
            return Ok(self.fallback_launch(input));
        }
        let snapshot = ParsedShellSnapshot {
            state,
            file_source: snapshot.file_source,
            environment: snapshot.environment.clone(),
        };
        Ok(self
            .build_launch(input, shell, &snapshot, Some(replay_env))
            .unwrap_or_else(|| self.fallback_launch(input)))
    }

    async fn prepare_protected(
        &self,
        input: &PrepareInput,
        shell: SnapshotShell,
        entry: &CredentialBrokerEntry,
    ) -> Result<Option<ShellSnapshotLaunch>, ShellSnapshotError> {
        let snapshot = match self.run_capture(input, shell, true).await {
            Ok(snapshot) => snapshot,
            Err(_) => return Ok(Some(self.fallback_launch(input))),
        };
        if self.closed.load(Ordering::Acquire) {
            return Ok(None);
        }
        self.protected_launch(input, shell, &snapshot, entry)
            .map(Some)
    }

    pub async fn prepare(
        &self,
        input: PrepareInput,
    ) -> Result<Option<ShellSnapshotLaunch>, ShellSnapshotError> {
        self.prepare_with_broker(input, None).await
    }

    pub(crate) async fn prepare_with_broker(
        &self,
        input: PrepareInput,
        broker: Option<Arc<CredentialBrokerEntry>>,
    ) -> Result<Option<ShellSnapshotLaunch>, ShellSnapshotError> {
        let fail = |code: i32, message: LosslessString| ShellSnapshotError { code, message };
        if self.closed.load(Ordering::Acquire) {
            return Err(fail(-32603, "Executor session closed".into()));
        }
        if self.platform == Platform::Windows {
            return Err(fail(
                -32602,
                "shell snapshots are unsupported on this platform".into(),
            ));
        }
        let scope_bytes = utf8_len(&input.request.scope_id);
        if scope_bytes == 0 || scope_bytes > MAX_SNAPSHOT_SCOPE_BYTES {
            return Err(fail(-32602, format!("shell snapshot scope must be non-empty and at most {MAX_SNAPSHOT_SCOPE_BYTES} bytes").into()));
        }
        if input.argv.len() < 3
            || input.argv[0] != input.request.shell.path
            || input.argv[1].as_str() != Some("-lc")
        {
            return Ok(None);
        }
        let shell = match input.request.shell.name.as_str() {
            Some("bash") => SnapshotShell::Bash,
            Some("zsh") => SnapshotShell::Zsh,
            Some("sh") => SnapshotShell::Sh,
            _ => {
                return Err(fail(
                    -32602,
                    concat(&[
                        &"shell snapshots are unsupported for shell `".into(),
                        &input.request.shell.name,
                        &"`".into(),
                    ]),
                ));
            }
        };
        if let Some(entry) = broker {
            return self.prepare_protected(&input, shell, &entry).await;
        }
        let key = stringify_json(&Value::Array(vec![
            Value::String(input.session_id.clone().into()),
            Value::String(input.request.scope_id.clone()),
            Value::String(input.request.shell.name.clone()),
            Value::String(input.request.shell.path.clone()),
            Value::String(input.cwd.clone()),
            input.env_policy.clone().unwrap_or(Value::Null),
            input
                .sandbox_key
                .clone()
                .map_or(Value::Null, |key| Value::String(key.into())),
        ]));
        let cell = self.lookup(&key);
        let snapshot = cell
            .result
            .get_or_init(|| async {
                match self.run_capture(&input, shell, false).await {
                    Ok(snapshot) => Some(Arc::new(snapshot)),
                    Err(_) => {
                        *cell
                            .retry_at
                            .lock()
                            .unwrap_or_else(|error| error.into_inner()) =
                            Some(now_ms() + SNAPSHOT_RETRY_BACKOFF_MS);
                        None
                    }
                }
            })
            .await
            .clone();
        let Some(snapshot) = snapshot else {
            return Ok(None);
        };
        if self.closed.load(Ordering::Acquire) {
            return Ok(None);
        }
        Ok(self.build_launch(&input, shell, &snapshot, None))
    }

    pub async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        for pid in self
            .running
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .drain(..)
        {
            kill_group(pid);
        }
        self.entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cca::{
        credential_broker::{CredentialBrokerCache, CredentialBrokerEntry, CredentialBrokerKey},
        error::{AuthorizationDenied, Grant},
    };
    use std::sync::atomic::AtomicUsize;

    fn input() -> PrepareInput {
        PrepareInput {
            session_id: "synthetic-session".into(),
            process_id: LosslessString::from_utf16(vec![112, 0xd800]),
            request: ShellSnapshotRequest {
                scope_id: "scope".into(),
                shell: ShellInfo {
                    name: "zsh".into(),
                    path: "/synthetic/zsh".into(),
                },
            },
            argv: vec![
                "/synthetic/zsh".into(),
                "-lc".into(),
                "run_synthetic_command".into(),
            ],
            arg0: None,
            cwd: "/".into(),
            env: vec![],
            request_env: vec![],
            env_policy: None,
            sandbox_key: None,
        }
    }

    fn broker() -> Arc<CredentialBrokerEntry> {
        CredentialBrokerCache::new()
            .broker_for(&CredentialBrokerKey {
                environment_id: None,
                conversation_id: None,
                providers: vec![],
            })
            .unwrap()
    }

    fn cache(root: PathBuf) -> ShellSnapshotCache {
        ShellSnapshotCache::new(
            Arc::new(|_| Box::pin(async { Ok(Grant::noop()) })),
            Platform::Linux,
            Some(root),
        )
    }

    fn snapshot(
        state: LosslessString,
        environment: Vec<(LosslessString, LosslessString)>,
    ) -> ParsedShellSnapshot {
        ParsedShellSnapshot {
            state,
            environment,
            file_source: false,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ordinary_cache_reuses_but_protected_denials_capture_fresh() {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let cache = ShellSnapshotCache::new(
            Arc::new(move |_| {
                seen.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {
                    tokio::task::yield_now().await;
                    Err(AuthorizationDenied::default())
                })
            }),
            Platform::Linux,
            None,
        );
        let (first, second) = tokio::join!(cache.prepare(input()), cache.prepare(input()));
        assert!(first.unwrap().is_none());
        assert!(second.unwrap().is_none());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let entry = broker();
        for _ in 0..2 {
            let launch = cache
                .prepare_with_broker(input(), Some(entry.clone()))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                launch.argv[2],
                concat(&[
                    &format!(
                        "\\builtin printf '%s\\n' '{SNAPSHOT_MASKING_FALLBACK_WARNING}' >&2\n"
                    )
                    .into(),
                    &input().argv[2]
                ])
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        cache.close().await;
        assert_eq!(
            cache
                .prepare_with_broker(input(), Some(entry))
                .await
                .err()
                .unwrap()
                .code,
            -32603
        );
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn successful_ordinary_capture_is_cached_but_protected_capture_uses_current_environment()
    {
        let cache = cache(std::env::temp_dir());
        let mut input = input();
        input.request.shell = ShellInfo {
            name: "sh".into(),
            path: "/bin/sh".into(),
        };
        input.argv[0] = "/bin/sh".into();
        input.env = vec![
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("SNAPSHOT_EPOCH".into(), "first".into()),
        ];
        let first = cache.prepare(input.clone()).await.unwrap().unwrap();
        input.env[1].1 = "second".into();
        let cached = cache.prepare(input.clone()).await.unwrap().unwrap();
        assert_eq!(
            env_get(&first.env, &"SNAPSHOT_EPOCH".into()),
            Some(&"first".into())
        );
        assert_eq!(
            env_get(&cached.env, &"SNAPSHOT_EPOCH".into()),
            Some(&"first".into())
        );
        let fresh = cache
            .prepare_with_broker(input.clone(), Some(broker()))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            env_get(&fresh.env, &"SNAPSHOT_EPOCH".into()),
            Some(&"second".into())
        );
        assert!(contains_units(
            &fresh.argv[2],
            &"missing shell snapshot chunk".into()
        ));
        cache.close().await;
    }

    #[test]
    fn readonly_export_check_is_specific_to_protected_zsh_capture() {
        assert!(
            capture_script(SnapshotShell::Zsh, true, true)
                .ends_with(scripts::READONLY_EXPORT_CHECK)
        );
        assert!(
            !capture_script(SnapshotShell::Zsh, true, false)
                .contains(scripts::READONLY_EXPORT_CHECK)
        );
        assert!(
            !capture_script(SnapshotShell::Bash, false, true)
                .contains(scripts::READONLY_EXPORT_CHECK)
        );
        assert!(scripts::READONLY_EXPORT_CHECK.contains("*readonly*) exit 74"));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn readonly_profile_exports_allow_ordinary_capture_but_force_protected_warning_fallback()
    {
        let root =
            std::env::temp_dir().join(format!("synthetic-readonly-snapshot-{}", random_hex(8)));
        tokio::fs::create_dir(&root).await.unwrap();
        tokio::fs::write(
            root.join(".zshrc"),
            "typeset -rx SNAPSHOT_READONLY=synthetic\n",
        )
        .await
        .unwrap();
        let cache = cache(root.clone());
        let mut input = input();
        input.request.shell.path = "/bin/zsh".into();
        input.argv[0] = "/bin/zsh".into();
        input.env = vec![
            ("HOME".into(), root.to_str().unwrap().into()),
            ("PATH".into(), "/usr/bin:/bin".into()),
        ];
        let ordinary = cache.prepare(input.clone()).await.unwrap().unwrap();
        assert!(contains_units(&ordinary.argv[2], &". /dev/fd/10".into()));
        let protected = cache
            .prepare_with_broker(input.clone(), Some(broker()))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            protected.argv[2],
            concat(&[
                &format!("\\builtin printf '%s\\n' '{SNAPSHOT_MASKING_FALLBACK_WARNING}' >&2\n")
                    .into(),
                &input.argv[2]
            ])
        );
        cache.close().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[test]
    fn protected_state_and_copies_are_masked_with_ordered_configured_and_managed_overrides() {
        let cache = cache(std::env::temp_dir());
        let entry = broker();
        let real = LosslessString::from(format!("sk-proj-{}", "q".repeat(64)));
        let lone = LosslessString::from_utf16(vec![0xd800]);
        let mut input = input();
        input.env = vec![
            ("CODEX_NETWORK_PROXY_ACTIVE".into(), "1".into()),
            ("HTTPS_PROXY".into(), "http://127.0.0.1:1234".into()),
        ];
        input.request_env = vec![
            ("2".into(), "two".into()),
            ("1".into(), "one".into()),
            ("OVERRIDE".into(), lone.clone()),
            ("CONFIGURED".into(), "after".into()),
        ];
        input.request_env.push((lone.clone(), "lone-key".into()));
        input
            .request_env
            .push(("HTTPS_PROXY".into(), "http://configured.example".into()));
        let managed_ca = concat(&[&lone, &format!("/ca-bundle-{}.pem", "a".repeat(64)).into()]);
        input.env.push(("SSL_CERT_FILE".into(), managed_ca.clone()));
        let capture = snapshot(
            concat(&[
                &"# Snapshot file\nshow() { printf '%s' '".into(),
                &real,
                &"'; }\n".into(),
            ]),
            vec![
                ("OPENAI_API_KEY".into(), real.clone()),
                ("COPY".into(), real.clone()),
                ("OVERRIDE".into(), "before".into()),
            ],
        );
        let launch = cache
            .protected_launch(&input, SnapshotShell::Zsh, &capture, &entry)
            .unwrap();
        let key = env_get(&launch.env, &"OPENAI_API_KEY".into()).unwrap();
        assert_ne!(key, &real);
        assert_eq!(env_get(&launch.env, &"COPY".into()), Some(key));
        assert_eq!(env_get(&launch.env, &"OVERRIDE".into()), Some(&lone));
        assert_eq!(
            env_get(&launch.env, &"HTTPS_PROXY".into()),
            Some(&"http://127.0.0.1:1234".into())
        );
        assert_eq!(
            env_get(&launch.env, &"SSL_CERT_FILE".into()),
            Some(&managed_ca)
        );
        assert_eq!(env_get(&launch.env, &lone), Some(&"lone-key".into()));
        assert_eq!(launch.env[0].0, LosslessString::from("1"));
        assert_eq!(launch.env[1].0, LosslessString::from("2"));
        assert_eq!(
            launch
                .env
                .iter()
                .take(6)
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>(),
            vec![
                "1".into(),
                "2".into(),
                "OPENAI_API_KEY".into(),
                "COPY".into(),
                "OVERRIDE".into(),
                "CONFIGURED".into()
            ]
        );
        let replay = launch
            .env
            .iter()
            .filter(|(key, _)| starts_with(key, "__CODEX_SHELL_SNAPSHOT_STATE_"))
            .map(|(_, value)| value.clone())
            .collect::<Vec<_>>();
        let text = super::super::value::join(&replay, "");
        assert!(!contains_units(&text, &real));
        assert!(contains_units(&text, key));
        assert!(contains_units(
            &text,
            &"\\builtin export CONFIGURED=".into()
        ));
        assert!(contains_units(
            &text,
            &"if [ -z \"${__CODEX_SHELL_SNAPSHOT_CONFIGURED_0+x}\" ]; then exit 1; fi".into()
        ));
        assert!(contains_units(
            &text,
            &"\\builtin unset __CODEX_SHELL_SNAPSHOT_CONFIGURED_0 || exit 1".into()
        ));
        assert!(contains_units(
            &text,
            &"\\builtin test \"$?\" -eq 0 || exit 1".into()
        ));
        assert_eq!(
            env_get(
                &launch.env,
                &"CODEX_NETWORK_PROXY_CREDENTIAL_BROKER_ACTIVE".into()
            ),
            Some(&"1".into())
        );
    }

    #[test]
    fn internal_environment_keys_are_removed_before_masking_and_copy_generation() {
        let cache = cache(std::env::temp_dir());
        let mut input = input();
        let internal = [
            SNAPSHOT_BROKERED_VALUE_ENV_PREFIX,
            SNAPSHOT_BROKERED_UNSET_ENV_PREFIX,
            CONFIGURED_VALUE_PREFIX,
        ];
        input.env = internal
            .iter()
            .map(|prefix| (format!("{prefix}POISON").into(), "poison".into()))
            .collect();
        input.request_env = input.env.clone();
        let capture = snapshot("# Snapshot file\n".into(), input.env.clone());
        let launch = cache
            .protected_launch(&input, SnapshotShell::Zsh, &capture, &broker())
            .unwrap();
        assert!(!launch.env.iter().any(|(key, value)| {
            internal
                .iter()
                .any(|prefix| key == &LosslessString::from(format!("{prefix}POISON")))
                || value == &LosslessString::from("poison")
        }));
    }

    #[test]
    fn placeholder_guards_sort_valid_names_and_restore_xtrace() {
        let environment = vec![
            (
                format!("{SNAPSHOT_BROKERED_VALUE_ENV_PREFIX}Z").into(),
                "z".into(),
            ),
            (
                format!("{SNAPSHOT_BROKERED_VALUE_ENV_PREFIX}A").into(),
                "a".into(),
            ),
            (
                format!("{SNAPSHOT_BROKERED_UNSET_ENV_PREFIX}GONE").into(),
                "1".into(),
            ),
            (
                format!("{SNAPSHOT_BROKERED_VALUE_ENV_PREFIX}BAD-NAME").into(),
                "bad".into(),
            ),
        ];
        let before = build_brokered_credential_exports(&environment, false)
            .as_str()
            .unwrap()
            .to_owned();
        let after = build_brokered_credential_exports(&environment, true)
            .as_str()
            .unwrap()
            .to_owned();
        assert!(before.find("VALUE_A+x").unwrap() < before.find("VALUE_Z+x").unwrap());
        assert!(before.contains(
            "if [ -z \"${CODEX_NETWORK_PROXY_SNAPSHOT_BROKERED_VALUE_A+x}\" ]; then exit 1; fi"
        ));
        assert!(before.contains("unset GONE || exit 1"));
        assert!(!before.contains("BAD-NAME"));
        assert!(!before.contains("unset CODEX_NETWORK_PROXY_SNAPSHOT_BROKERED_VALUE_A || exit 1"));
        assert!(after.contains("unset CODEX_NETWORK_PROXY_SNAPSHOT_BROKERED_VALUE_A || exit 1"));
        assert!(after.contains("set +x"));
        assert!(after.contains("set -x"));
        assert_eq!(
            build_brokered_credential_exports(&[], true),
            LosslessString::from("")
        );
    }

    #[test]
    fn ordinary_replay_keeps_nonfatal_restore_and_original_logical_units() {
        let cache = cache(std::env::temp_dir());
        let mut input = input();
        let lone = LosslessString::from_utf16(vec![0xd800]);
        input.argv[2] = lone.clone();
        input.env = vec![("ORIGINAL".into(), "original".into())];
        input.request_env = vec![
            ("ORIGINAL".into(), "request".into()),
            ("NEW".into(), lone.clone()),
        ];
        let capture = snapshot(
            "# Snapshot file\n".into(),
            vec![("ORIGINAL".into(), "capture".into())],
        );
        let launch = cache
            .build_launch(&input, SnapshotShell::Zsh, &capture, None)
            .unwrap();
        assert_eq!(
            env_get(&launch.env, &"ORIGINAL".into()),
            Some(&"original".into())
        );
        assert_eq!(env_get(&launch.env, &"NEW".into()), Some(&lone));
        assert!(
            launch.argv[2]
                .code_units()
                .collect::<Vec<_>>()
                .ends_with(&[0xd800])
        );
        assert!(launch.argv[2].as_str().is_none());
        assert!(!contains_units(&launch.argv[2], &"exit 1; fi".into()));
    }

    #[test]
    fn protected_replay_requires_chunks_and_exits_before_original_command_on_failure() {
        let cache = cache(std::env::temp_dir());
        let input = input();
        let launch = cache
            .protected_launch(
                &input,
                SnapshotShell::Zsh,
                &snapshot("# Snapshot file\n".into(), vec![]),
                &broker(),
            )
            .unwrap();
        let script = launch.argv[2].as_str().unwrap();
        assert!(script.contains(":?missing shell snapshot chunk}"));
        assert!(script.contains(">/dev/null 2>&1; then printf 'failed to restore shell snapshot\\n' >&2; exit 1; fi\nrun_synthetic_command"));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn failed_protected_state_prevents_the_command_while_ordinary_replay_continues() {
        let cache = cache(std::env::temp_dir());
        let mut input = input();
        input.argv[0] = "/bin/zsh".into();
        input.argv[2] = "printf '%s' 'synthetic-command-ran'".into();
        let capture = snapshot("false".into(), vec![]);
        let protected = cache
            .protected_launch(&input, SnapshotShell::Zsh, &capture, &broker())
            .unwrap();
        let ordinary = cache
            .build_launch(&input, SnapshotShell::Zsh, &capture, None)
            .unwrap();
        for (launch, success, stdout) in [
            (protected, false, b"".as_slice()),
            (ordinary, true, b"synthetic-command-ran".as_slice()),
        ] {
            let output = tokio::process::Command::new(os_text(&launch.argv[0]))
                .args(launch.argv.iter().skip(1).map(os_text))
                .env_clear()
                .envs(
                    launch
                        .env
                        .iter()
                        .map(|(key, value)| (os_text(key), os_text(value))),
                )
                .output()
                .await
                .unwrap();
            assert_eq!(output.status.success(), success);
            assert_eq!(output.stdout, stdout);
        }
    }

    #[test]
    fn materialization_and_size_failures_return_exact_warning_with_original_environment() {
        let missing_root =
            std::env::temp_dir().join(format!("synthetic-missing-{}", random_hex(8)));
        let cache = cache(missing_root);
        let mut input = input();
        input.env = vec![("ORIGINAL".into(), "unmasked".into())];
        for capture in [
            ParsedShellSnapshot {
                state: "# Snapshot file\n".into(),
                environment: vec![],
                file_source: true,
            },
            snapshot("x".repeat(MAX_SNAPSHOT_BYTES + 1).into(), vec![]),
            snapshot(
                "# Snapshot file\n".into(),
                vec![("LARGE".into(), "x".repeat(MAX_SNAPSHOT_BYTES).into())],
            ),
            snapshot(
                "# Snapshot file\n".into(),
                vec![
                    (
                        "OPENAI_API_KEY".into(),
                        format!("sk-proj-{}", "q".repeat(64)).into(),
                    ),
                    (
                        "BAD-NAME".into(),
                        format!("sk-proj-{}", "q".repeat(64)).into(),
                    ),
                ],
            ),
        ] {
            let launch = cache
                .protected_launch(&input, SnapshotShell::Zsh, &capture, &broker())
                .unwrap();
            assert_eq!(launch.env, input.env);
            assert_eq!(launch.argv[0..2], input.argv[0..2]);
            assert_eq!(
                launch.argv[2],
                concat(&[
                    &format!(
                        "\\builtin printf '%s\\n' '{SNAPSHOT_MASKING_FALLBACK_WARNING}' >&2\n"
                    )
                    .into(),
                    &input.argv[2]
                ])
            );
        }
    }

    #[test]
    fn protected_environment_replay_accepts_the_exact_byte_budget_and_rejects_one_more() {
        let cache = cache(std::env::temp_dir());
        let environment_bytes = "CODEX_NETWORK_PROXY_CREDENTIAL_BROKER_ACTIVE".len()
            + 1
            + 2
            + "CODEX_NETWORK_PROXY_BROKERED_CREDENTIALS".len()
            + 2
            + 2;
        let overhead = "\n\n\n\\builtin test \"$?\" -eq 0 || exit 1\n\n".len();
        let state_bytes = MAX_SNAPSHOT_BYTES - environment_bytes - overhead;
        let accepted = cache
            .protected_launch(
                &input(),
                SnapshotShell::Zsh,
                &snapshot("x".repeat(state_bytes).into(), vec![]),
                &broker(),
            )
            .unwrap();
        assert!(contains_units(
            &accepted.argv[2],
            &"missing shell snapshot chunk".into()
        ));
        let rejected = cache
            .protected_launch(
                &input(),
                SnapshotShell::Zsh,
                &snapshot("x".repeat(state_bytes + 1).into(), vec![]),
                &broker(),
            )
            .unwrap();
        assert!(contains_units(
            &rejected.argv[2],
            &SNAPSHOT_MASKING_FALLBACK_WARNING.into()
        ));
    }

    #[test]
    fn parsing_keeps_original_order_after_policy_and_preserves_policy_lone_units() {
        let mut policy = JsonObject::new();
        let mut set = JsonObject::new();
        set.insert(
            "ADDED".into(),
            Value::String(LosslessString::from_utf16(vec![0xd800])),
        );
        policy.insert("inherit".into(), Value::String("none".into()));
        policy.insert("ignoreDefaultExcludes".into(), Value::Bool(false));
        policy.insert(
            "exclude".into(),
            Value::Array(vec![Value::String("DROP".into())]),
        );
        policy.insert("set".into(), Value::Object(set));
        policy.insert("includeOnly".into(), Value::Array(vec![]));
        let parsed = parse_shell_snapshot(
            SnapshotShell::Zsh,
            b"# Snapshot file\n\0\0\0Z=first\0A=second\0DROP=no\0PWD=/tmp\0",
            Some(&Value::Object(policy)),
            Replay::Environment,
        )
        .unwrap();
        assert_eq!(
            parsed.environment,
            vec![
                ("Z".into(), "first".into()),
                ("A".into(), "second".into()),
                ("ADDED".into(), LosslessString::from_utf16(vec![0xd800]))
            ]
        );
    }

    #[test]
    fn unrestricted_capture_keeps_host_environment_values() {
        let parsed = parse_with_access(
            SnapshotShell::Zsh,
            b"# Snapshot file\n\0\0\0CODEX_TOOL_CALL_ID=synthetic\0CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE=value\0",
            None,
            Replay::Environment,
            super::super::executor::ExecutorAccess::UnrestrictedHost,
        )
        .unwrap();
        assert_eq!(
            parsed.environment,
            vec![
                ("CODEX_TOOL_CALL_ID".into(), "synthetic".into()),
                (
                    "CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE".into(),
                    "value".into()
                ),
            ]
        );
    }

    #[test]
    fn parsing_checks_state_and_environment_bytes_before_policy_filtering() {
        let large = "é".repeat(MAX_SNAPSHOT_BYTES / 2);
        let output = format!("# Snapshot file\n# {large}\n\0\0\0").into_bytes();
        assert_eq!(
            parse_shell_snapshot(SnapshotShell::Zsh, &output, None, Replay::Environment)
                .err()
                .unwrap()
                .reason,
            "state_too_large"
        );
        assert!(parse_shell_snapshot(SnapshotShell::Zsh, &output, None, Replay::File).is_ok());
        let output = format!(
            "# Snapshot file\n\0\0\0LARGE={}\0",
            "x".repeat(MAX_SNAPSHOT_BYTES)
        )
        .into_bytes();
        assert_eq!(
            parse_shell_snapshot(SnapshotShell::Zsh, &output, None, Replay::File)
                .err()
                .unwrap()
                .reason,
            "environment_too_large"
        );
        assert_eq!(
            parse_shell_snapshot(SnapshotShell::Zsh, b"missing\0\0\0", None, Replay::File)
                .err()
                .unwrap()
                .reason,
            "invalid_capture"
        );
    }

    #[cfg(unix)]
    #[test]
    fn file_transport_is_unlinked_and_writes_state_at_the_native_script_boundary() {
        use std::{
            io::Read,
            os::unix::fs::{MetadataExt, PermissionsExt},
        };
        let cache = cache(std::env::temp_dir());
        let snapshot = ParsedShellSnapshot {
            state: LosslessString::from_utf16(vec![0xd800]),
            file_source: true,
            environment: vec![],
        };
        let mut launch = cache
            .build_launch(&input(), SnapshotShell::Zsh, &snapshot, Some(vec![]))
            .unwrap();
        let mut file = std::fs::File::from(launch.fd.take().unwrap());
        assert_eq!(file.metadata().unwrap().nlink(), 0);
        assert_eq!(file.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        let mut text = String::new();
        file.read_to_string(&mut text).unwrap();
        assert_eq!(
            text,
            "__codex_snapshot_fd=10\nexec {__codex_snapshot_fd}<&-\nunset __codex_snapshot_fd\n\u{fffd}"
        );
        launch.release();
        launch.release();
    }

    #[test]
    fn chunks_are_utf8_bounded_and_replay_state_crosses_only_the_script_boundary() {
        let cache = cache(std::env::temp_dir());
        let state = format!(
            "{}é{}",
            "a".repeat(MAX_SNAPSHOT_ENV_VALUE_BYTES - 1),
            "b".repeat(10)
        );
        let launch = cache
            .build_launch(
                &input(),
                SnapshotShell::Zsh,
                &snapshot(state.clone().into(), vec![]),
                Some(vec![]),
            )
            .unwrap();
        let chunks = launch
            .env
            .iter()
            .filter(|(key, _)| starts_with(key, "__CODEX_SHELL_SNAPSHOT_STATE_"))
            .map(|(_, value)| value.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            super::super::value::join(&chunks, ""),
            LosslessString::from(state)
        );
        assert!(
            chunks
                .iter()
                .all(|chunk| utf8_len(chunk) <= MAX_SNAPSHOT_ENV_VALUE_BYTES)
        );
        let launch = cache
            .build_launch(
                &input(),
                SnapshotShell::Zsh,
                &snapshot(LosslessString::from_utf16(vec![0xd800]), vec![]),
                Some(vec![]),
            )
            .unwrap();
        assert_eq!(launch.env[0].1, LosslessString::from("\u{fffd}"));
    }

    fn contains_units(text: &LosslessString, needle: &LosslessString) -> bool {
        let needle = needle.code_units().collect::<Vec<_>>();
        text.code_units()
            .collect::<Vec<_>>()
            .windows(needle.len())
            .any(|part| part == needle)
    }
}
