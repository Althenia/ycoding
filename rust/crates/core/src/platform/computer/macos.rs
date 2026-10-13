use super::{Future, types::*};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{io::AsyncReadExt, sync::oneshot, task::JoinHandle};

pub const HELPER_APPLICATION: &str = "YCoding Computer Use.app";
pub const HELPER_BINARY: &str = "ycoding-computer-use";
pub const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

pub fn application_path(executable: &Path, checkout: &Path) -> PathBuf {
    if executable.file_stem().is_some_and(|name| name == "bun") {
        return checkout
            .join("packages/core/.cache/computer-use")
            .join(HELPER_APPLICATION);
    }
    executable
        .parent()
        .unwrap_or(Path::new("."))
        .join(HELPER_APPLICATION)
}

pub trait Launcher: Send + Sync {
    fn launch<'a>(
        &'a self,
        application: &'a Path,
        request: &'a Path,
        response: &'a Path,
    ) -> Future<'a, Result<(), NativeError>>;
}
pub struct LaunchServices;
impl Launcher for LaunchServices {
    fn launch<'a>(
        &'a self,
        application: &'a Path,
        request: &'a Path,
        response: &'a Path,
    ) -> Future<'a, Result<(), NativeError>> {
        Box::pin(async move {
            let mut command = tokio::process::Command::new("/usr/bin/open");
            command
                .args(["-n", "-g", "-a"])
                .arg(application)
                .arg("--args")
                .arg(request)
                .arg(response)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            let result = tokio::time::timeout(Duration::from_secs(10), command.status()).await;
            if matches!(result,Ok(Ok(status)) if status.success()) {
                return Ok(());
            }
            Err(NativeError::new(
                Code::HelperUnavailable,
                "Native helper launch did not settle successfully",
                Outcome::NotStarted,
            ))
        })
    }
}

pub struct NativeClient {
    platform: String,
    application: PathBuf,
    launcher: Arc<dyn Launcher>,
    timeout: Duration,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}
impl NativeClient {
    pub fn new(
        platform: impl Into<String>,
        application: PathBuf,
        launcher: Arc<dyn Launcher>,
        timeout: Duration,
    ) -> Self {
        Self {
            platform: platform.into(),
            application,
            launcher,
            timeout,
            tasks: Mutex::new(Vec::new()),
        }
    }
    pub async fn invoke(&self, request: Request) -> Result<Success, NativeError> {
        if self.platform != "darwin" {
            return Err(NativeError::new(
                Code::UnsupportedPlatform,
                format!("Native computer use has no provider for {}", self.platform),
                Outcome::NotStarted,
            ));
        }
        let launcher = self.launcher.clone();
        let application = self.application.clone();
        let timeout = self.timeout;
        let (sender, receiver) = oneshot::channel();
        let task = tokio::spawn(async move {
            let result = handoff(launcher.as_ref(), &application, request, timeout).await;
            let _ = sender.send(result);
        });
        self.tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(task);
        receiver.await.map_err(|_| {
            NativeError::new(
                Code::UnknownOutcome,
                "Native helper settlement task failed",
                Outcome::Unknown,
            )
        })?
    }
    pub async fn shutdown(&self) -> Result<(), NativeError> {
        let tasks = std::mem::take(&mut *self.tasks.lock().unwrap_or_else(|e| e.into_inner()));
        for task in tasks {
            task.await.map_err(|_| {
                NativeError::new(
                    Code::UnknownOutcome,
                    "Native helper settlement task failed",
                    Outcome::Unknown,
                )
            })?;
        }
        Ok(())
    }
}

struct Directory(PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0) {
            eprintln!("Native helper handoff cleanup failed: {error}");
        }
    }
}

async fn handoff(
    launcher: &dyn Launcher,
    application: &Path,
    request: Request,
    timeout: Duration,
) -> Result<Success, NativeError> {
    let failure = || {
        NativeError::new(
            if request.operation.mutating() {
                Code::UnknownOutcome
            } else {
                Code::HelperUnavailable
            },
            if request.operation.mutating() {
                "Native helper settlement is unknown; inspect the target before any further mutation"
            } else {
                "Native computer helper is unavailable or returned invalid output"
            },
            if request.operation.mutating() {
                Outcome::Unknown
            } else {
                Outcome::NotStarted
            },
        )
    };
    let directory = std::env::temp_dir()
        .join(super::super::identifier("ycoding-computer-").map_err(|_| failure())?);
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&directory).map_err(|_| failure())?;
    let directory = Directory(directory);
    let request_path = directory.0.join("request.json");
    let response_path = directory.0.join("response.json");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    {
        use std::io::Write;
        options
            .open(&request_path)
            .and_then(|mut file| file.write_all(request.encode().to_string().as_bytes()))
            .map_err(|_| failure())?;
    }
    let (changes, mut events) = tokio::sync::mpsc::channel(16);
    let mut watcher =
        notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
            let _ = changes.try_send(event);
        })
        .map_err(|_| failure())?;
    notify::Watcher::watch(
        &mut watcher,
        &directory.0,
        notify::RecursiveMode::NonRecursive,
    )
    .map_err(|_| failure())?;
    launcher
        .launch(application, &request_path, &response_path)
        .await
        .map_err(|_| failure())?;
    let read = async {
        loop {
            match tokio::fs::File::open(&response_path).await {
                Ok(file) => {
                    let mut bytes = Vec::new();
                    file.take((MAX_RESPONSE_BYTES + 1) as u64)
                        .read_to_end(&mut bytes)
                        .await
                        .map_err(|_| failure())?;
                    if bytes.len() > MAX_RESPONSE_BYTES {
                        return Err(failure());
                    }
                    return Ok(String::from_utf8_lossy(&bytes).into_owned());
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(failure()),
            }
            match events.recv().await {
                Some(Ok(_)) => {}
                _ => return Err(failure()),
            }
        }
    };
    let output = tokio::time::timeout(timeout, read)
        .await
        .map_err(|_| failure())??;
    decode_response(&output, request.operation).map_err(|error| {
        if error.code == Code::InvalidResponse
            && error.message == "Native computer helper returned invalid output"
        {
            failure()
        } else {
            error
        }
    })
}

pub fn decode_response(output: &str, expected: Operation) -> Result<Success, NativeError> {
    let invalid = || {
        NativeError::new(
            Code::InvalidResponse,
            "Native computer helper returned invalid output",
            Outcome::Unknown,
        )
    };
    let value: Value = serde_json::from_str(output).map_err(|_| invalid())?;
    let object = value.as_object().ok_or_else(invalid)?;
    match object.get("status").and_then(Value::as_str) {
        Some("error") => {
            let code = object
                .get("code")
                .and_then(Value::as_str)
                .and_then(Code::parse)
                .ok_or_else(invalid)?;
            let message = object
                .get("message")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?
                .into();
            let outcome = match object.get("outcome") {
                None => None,
                Some(Value::String(value)) if value == "not_started" => Some(Outcome::NotStarted),
                Some(Value::String(value)) if value == "unknown" => Some(Outcome::Unknown),
                _ => return Err(invalid()),
            };
            Err(NativeError {
                code,
                message,
                outcome,
            })
        }
        Some("ok") => {
            let action = object
                .get("action")
                .and_then(Value::as_str)
                .and_then(Operation::parse)
                .ok_or_else(invalid)?;
            let revision = object
                .get("revision")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?
                .into();
            validate_success(&value).map_err(|_| invalid())?;
            if action != expected {
                return Err(NativeError::new(
                    Code::InvalidResponse,
                    "Native computer helper returned a mismatched action",
                    Outcome::Unknown,
                ));
            }
            Ok(Success {
                action,
                revision,
                detail: value,
            })
        }
        _ => Err(invalid()),
    }
}

fn validate_success(value: &Value) -> Result<(), ()> {
    let o = value.as_object().ok_or(())?;
    for name in ["accessible", "exited", "truncated"] {
        if o.get(name).is_some_and(|v| !v.is_boolean()) {
            return Err(());
        }
    }
    for name in ["image", "value"] {
        if o.get(name).is_some_and(|v| !v.is_string()) {
            return Err(());
        }
    }
    for name in ["width", "height", "scale"] {
        if o.get(name).is_some_and(|v| !v.is_number()) {
            return Err(());
        }
    }
    for name in ["pid", "tabIndex"] {
        if o.get(name).is_some_and(|v| !v.is_i64() && !v.is_u64()) {
            return Err(());
        }
    }
    if o.get("effect").is_some_and(|v| {
        !v.as_str()
            .is_some_and(|s| matches!(s, "changed" | "unchanged" | "unverified"))
    }) {
        return Err(());
    }
    if let Some(elements) = o.get("elements") {
        for element in elements.as_array().ok_or(())? {
            for name in ["role", "label"] {
                if !element.get(name).is_some_and(Value::is_string) {
                    return Err(());
                }
            }
            for name in ["enabled", "focused"] {
                if !element.get(name).is_some_and(Value::is_boolean) {
                    return Err(());
                }
            }
            if element.get("value").is_some_and(|v| !v.is_string()) {
                return Err(());
            }
            let frame = element.get("frame").and_then(Value::as_array).ok_or(())?;
            if frame.len() != 4 || !frame.iter().all(Value::is_number) {
                return Err(());
            }
            if !element
                .get("path")
                .and_then(Value::as_array)
                .is_some_and(|v| v.iter().all(|n| n.is_i64() || n.is_u64()))
            {
                return Err(());
            }
            if !element
                .get("actions")
                .and_then(Value::as_array)
                .is_some_and(|v| {
                    v.iter().all(|n| {
                        n.as_str().is_some_and(|s| {
                            matches!(
                                s,
                                "press" | "confirm" | "increment" | "decrement" | "show_menu"
                            )
                        })
                    })
                })
            {
                return Err(());
            }
        }
    }
    if let Some(windows) = o.get("windows") {
        validate_windows(windows)?;
    }
    if let Some(apps) = o.get("apps") {
        for app in apps.as_array().ok_or(())? {
            for name in ["bundle_id", "name"] {
                if !app.get(name).is_some_and(Value::is_string) {
                    return Err(());
                }
            }
            if !app.get("pid").is_some_and(|v| v.is_i64() || v.is_u64()) {
                return Err(());
            }
            for name in ["is_active", "is_hidden"] {
                if !app.get(name).is_some_and(Value::is_boolean) {
                    return Err(());
                }
            }
            validate_windows(app.get("windows").ok_or(())?)?;
        }
    }
    if let Some(windows) = o.get("browserWindows") {
        for window in windows.as_array().ok_or(())? {
            for name in ["window_id", "revision"] {
                if !window.get(name).is_some_and(Value::is_string) {
                    return Err(());
                }
            }
            if !window
                .get("index")
                .is_some_and(|v| v.is_i64() || v.is_u64())
            {
                return Err(());
            }
            for tab in window.get("tabs").and_then(Value::as_array).ok_or(())? {
                for name in ["title", "url"] {
                    if !tab.get(name).is_some_and(Value::is_string) {
                        return Err(());
                    }
                }
                if !tab.get("index").is_some_and(|v| v.is_i64() || v.is_u64())
                    || !tab.get("active").is_some_and(Value::is_boolean)
                {
                    return Err(());
                }
            }
        }
    }
    for name in ["display", "originalFrame"] {
        if let Some(frame) = o.get(name) {
            validate_frame(frame)?;
            if name == "display" && !frame.get("id").is_some_and(|v| v.is_i64() || v.is_u64()) {
                return Err(());
            }
        }
    }
    Ok(())
}
fn validate_frame(frame: &Value) -> Result<(), ()> {
    if ["x", "y", "width", "height"]
        .into_iter()
        .all(|name| frame.get(name).is_some_and(Value::is_number))
    {
        return Ok(());
    }
    Err(())
}
fn validate_windows(windows: &Value) -> Result<(), ()> {
    for window in windows.as_array().ok_or(())? {
        if !window
            .get("window_id")
            .is_some_and(|v| v.is_i64() || v.is_u64())
            || !window.get("title").is_some_and(Value::is_string)
            || !window.get("on_screen").is_some_and(Value::is_boolean)
            || !window
                .get("placement")
                .and_then(Value::as_str)
                .is_some_and(|s| {
                    matches!(
                        s,
                        "current_space" | "other_space" | "full_screen" | "unplaced" | "unknown"
                    )
                })
        {
            return Err(());
        }
        validate_frame(window.get("bounds").ok_or(())?)?;
    }
    Ok(())
}
