#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fuse {
    On,
    Off,
    Removed,
    Absent,
}

pub use super::types::Code;
use super::types::{Action, NativeError, Outcome, Target};
use serde_json::{Value, json};
use std::{
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    sync::{oneshot, watch},
    task::JoinHandle,
};
use tokio_tungstenite::tungstenite;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub fn media_source_window(source: &str, window_id: u64) -> bool {
    source == format!("window:{window_id}:0")
}
pub fn content_point(
    bounds: Rect,
    content: Rect,
    scale: f64,
    x: f64,
    y: f64,
) -> Result<(f64, f64), super::types::NativeError> {
    let point = (
        x / scale - (content.x - bounds.x),
        y / scale - (content.y - bounds.y),
    );
    if !point.0.is_finite()
        || !point.1.is_finite()
        || point.0 < 0.
        || point.1 < 0.
        || point.0 >= content.width
        || point.1 >= content.height
    {
        return Err(super::types::NativeError::new(
            super::types::Code::InvalidRequest,
            "Pixel coordinate is outside the target content area",
            super::types::Outcome::NotStarted,
        ));
    }
    Ok(point)
}

pub fn inspect_fuse(bytes: &[u8]) -> Fuse {
    let sentinel = b"dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
    let Some(index) = bytes
        .windows(sentinel.len())
        .position(|window| window == sentinel)
    else {
        return Fuse::Absent;
    };
    let start = index + sentinel.len();
    if start + 2 > bytes.len()
        || bytes[start] != 1
        || bytes[start + 1] < 4
        || start + 2 + usize::from(bytes[start + 1]) > bytes.len()
    {
        return Fuse::Absent;
    }
    match bytes[start + 5] {
        b'1' => Fuse::On,
        b'0' => Fuse::Off,
        b'r' => Fuse::Removed,
        _ => Fuse::Absent,
    }
}

#[derive(Clone, Debug)]
pub struct Window {
    pub id: u64,
    pub title: String,
    pub bounds: Rect,
    pub on_screen: bool,
}
#[derive(Clone, Debug)]
pub enum Operation {
    Capture,
    Action(Action),
}
#[derive(Clone, Debug, PartialEq)]
pub enum BridgeResult {
    Capture {
        image: String,
        width: u32,
        height: u32,
        scale: f64,
    },
    Action {
        changed: bool,
    },
}

pub trait Runtime: Send + Sync {
    fn app_path(&self, pid: u32) -> Result<Option<PathBuf>, String>;
    fn fuse_bytes(&self, app: &Path) -> Result<Vec<u8>, String>;
    fn owned_ports(&self, pid: u32) -> Result<Vec<u16>, String>;
    fn signal(&self, pid: u32) -> Result<(), String>;
    fn framework_exists(&self, app: &Path) -> Result<bool, String>;
}
pub struct NativeRuntime;
impl Runtime for NativeRuntime {
    fn app_path(&self, pid: u32) -> Result<Option<PathBuf>, String> {
        let output = std::process::Command::new("/bin/ps")
            .args(["-o", "comm=", "-p", &pid.to_string()])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Ok(None);
        }
        let command = String::from_utf8_lossy(&output.stdout);
        let command = command.trim();
        Ok(command
            .find(".app/")
            .map(|end| PathBuf::from(&command[..end + 4])))
    }
    fn fuse_bytes(&self, app: &Path) -> Result<Vec<u8>, String> {
        let path = app.join("Contents/Frameworks/Electron Framework.framework/Electron Framework");
        if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > 512 * 1024 * 1024 {
            return Err("Electron framework exceeds 512 MiB".into());
        }
        std::fs::read(path).map_err(|e| e.to_string())
    }
    fn owned_ports(&self, pid: u32) -> Result<Vec<u16>, String> {
        let output = std::process::Command::new("/usr/sbin/lsof")
            .args(["-nP", "-a", "-p", &pid.to_string(), "-iTCP", "-sTCP:LISTEN"])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Ok(Vec::new());
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let (_, after) = line.split_once("127.0.0.1:")?;
                let (port, tail) = after.split_once(char::is_whitespace)?;
                if tail.trim() == "(LISTEN)" {
                    return port.parse().ok();
                }
                None
            })
            .collect())
    }
    fn signal(&self, pid: u32) -> Result<(), String> {
        #[cfg(unix)]
        {
            let pid = i32::try_from(pid).map_err(|_| "Invalid process ID".to_string())?;
            // A positive, range-checked PID names one process; no pointer or process-group target is passed.
            let result = unsafe { libc::kill(pid, libc::SIGUSR1) };
            if result == 0 {
                return Ok(());
            }
            Err(std::io::Error::last_os_error().to_string())
        }
        #[cfg(not(unix))]
        {
            let _ = pid;
            Err("Electron inspector signals require Unix".into())
        }
    }
    fn framework_exists(&self, app: &Path) -> Result<bool, String> {
        app.join("Contents/Frameworks/Electron Framework.framework/Electron Framework")
            .try_exists()
            .map_err(|e| e.to_string())
    }
}

#[derive(Clone, Debug)]
pub struct Endpoint {
    pub port: u16,
    pub targets: Vec<DebugTarget>,
}
#[derive(Clone, Debug)]
pub struct DebugTarget {
    pub kind: String,
    pub id: Option<String>,
    pub title: Option<String>,
    pub websocket: String,
}
pub struct Bridge {
    runtime: Arc<dyn Runtime>,
    http: reqwest::Client,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}
impl Bridge {
    pub fn new(runtime: Arc<dyn Runtime>) -> Result<Self, NativeError> {
        Ok(Self {
            runtime,
            http: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_millis(800))
                .build()
                .map_err(|_| unavailable())?,
            tasks: Mutex::new(Vec::new()),
        })
    }
    pub async fn owned_endpoint(&self, pid: u32) -> Result<Option<Endpoint>, NativeError> {
        let runtime = self.runtime.clone();
        let ports = tokio::task::spawn_blocking(move || runtime.owned_ports(pid))
            .await
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())?;
        for port in ports {
            if let Some(endpoint) = endpoint(&self.http, port).await {
                return Ok(Some(endpoint));
            }
        }
        Ok(None)
    }
    pub async fn is_electron(&self, pid: u32) -> Result<bool, NativeError> {
        let runtime = self.runtime.clone();
        tokio::task::spawn_blocking(move || {
            let app = runtime.app_path(pid).map_err(|_| unavailable())?;
            match app {
                Some(app) => runtime.framework_exists(&app).map_err(|_| unavailable()),
                None => Ok(false),
            }
        })
        .await
        .map_err(|_| unavailable())?
    }
    pub async fn perform(
        &self,
        target: Target,
        window: Window,
        operation: Operation,
        signal: Option<watch::Receiver<bool>>,
    ) -> Result<Option<BridgeResult>, NativeError> {
        let runtime = self.runtime.clone();
        let http = self.http.clone();
        let handle = tokio::runtime::Handle::current();
        let (sender, receiver) = oneshot::channel();
        let task = tokio::task::spawn_blocking(move || {
            let result = perform(
                runtime.as_ref(),
                &http,
                &handle,
                target,
                window,
                operation,
                signal,
            );
            let _ = sender.send(result);
        });
        self.tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(task);
        receiver.await.map_err(|_| unavailable())?
    }
    pub async fn shutdown(&self) -> Result<(), NativeError> {
        let tasks = std::mem::take(&mut *self.tasks.lock().unwrap_or_else(|e| e.into_inner()));
        for task in tasks {
            task.await.map_err(|_| {
                NativeError::new(
                    Code::UnknownOutcome,
                    "Electron bridge task failed",
                    Outcome::Unknown,
                )
            })?;
        }
        Ok(())
    }
}

async fn endpoint(http: &reqwest::Client, port: u16) -> Option<Endpoint> {
    let response = http
        .get(format!("http://127.0.0.1:{port}/json/list"))
        .send()
        .await
        .ok()?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > 1_000_000)
    {
        return None;
    }
    let text = response.text().await.ok()?;
    if text.encode_utf16().count() > 1_000_000 {
        return None;
    }
    let value: Value = serde_json::from_str(&text).ok()?;
    let targets = value.as_array()?;
    if targets.len() > 64 {
        return None;
    }
    let targets = targets
        .iter()
        .filter_map(|target| {
            let kind = target.get("type")?.as_str()?;
            let websocket = target.get("webSocketDebuggerUrl")?.as_str()?;
            let url = url::Url::parse(websocket).ok()?;
            if url.scheme() != "ws"
                || url.host_str() != Some("127.0.0.1")
                || url.port() != Some(port)
            {
                return None;
            }
            Some(DebugTarget {
                kind: kind.into(),
                id: target.get("id").and_then(Value::as_str).map(String::from),
                title: target
                    .get("title")
                    .and_then(Value::as_str)
                    .map(String::from),
                websocket: websocket.into(),
            })
        })
        .collect::<Vec<_>>();
    if targets.is_empty() {
        return None;
    }
    Some(Endpoint { port, targets })
}

struct Socket {
    socket: tungstenite::WebSocket<TcpStream>,
    sequence: u64,
}
impl Socket {
    fn connect(input: &str) -> Result<Self, NativeError> {
        let url = url::Url::parse(input).map_err(|_| unavailable())?;
        if url.scheme() != "ws" || url.host_str() != Some("127.0.0.1") {
            return Err(unavailable());
        }
        let port = url.port().ok_or_else(unavailable)?;
        let address = SocketAddr::from(([127, 0, 0, 1], port));
        let stream = TcpStream::connect_timeout(&address, Duration::from_millis(1500))
            .map_err(|_| unavailable())?;
        stream
            .set_read_timeout(Some(Duration::from_millis(1500)))
            .map_err(|_| unavailable())?;
        stream
            .set_write_timeout(Some(Duration::from_millis(1500)))
            .map_err(|_| unavailable())?;
        let (socket, _) = tungstenite::client(input, stream).map_err(|_| unavailable())?;
        Ok(Self {
            socket,
            sequence: 0,
        })
    }
    fn fire(&mut self, method: &str, params: Value) -> Result<u64, NativeError> {
        self.sequence += 1;
        self.socket
            .send(tungstenite::Message::Text(
                json!({"id":self.sequence,"method":method,"params":params})
                    .to_string()
                    .into(),
            ))
            .map_err(|_| unavailable())?;
        Ok(self.sequence)
    }
    fn send(&mut self, method: &str, params: Value) -> Result<Value, NativeError> {
        let id = self.fire(method, params)?;
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(unavailable());
            }
            self.socket
                .get_mut()
                .set_read_timeout(Some(remaining))
                .map_err(|_| unavailable())?;
            let message = self.socket.read().map_err(|_| unavailable())?;
            if message.is_ping() || message.is_pong() {
                continue;
            }
            let text = message.to_text().map_err(|_| unavailable())?;
            if text.encode_utf16().count() > 24_000_000 {
                return Err(unavailable());
            }
            let Ok(response) = serde_json::from_str::<Value>(text) else {
                continue;
            };
            if response.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if response.get("error").is_some_and(|error| !error.is_null()) {
                return Err(unavailable());
            }
            return Ok(response.get("result").cloned().unwrap_or(Value::Null));
        }
    }
    fn evaluate(&mut self, expression: String) -> Result<Value, NativeError> {
        let response=self.send("Runtime.evaluate",json!({"expression":expression,"includeCommandLineAPI":true,"awaitPromise":true,"returnByValue":true}))?;
        if response
            .get("exceptionDetails")
            .is_some_and(|value| !value.is_null())
        {
            return Err(missing());
        }
        Ok(response
            .get("result")
            .and_then(|value| value.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }
}
impl Drop for Socket {
    fn drop(&mut self) {
        let _ = self.socket.close(None);
    }
}
fn unavailable() -> NativeError {
    NativeError::new(
        Code::BackgroundUnavailable,
        "No owned Electron debug route is available",
        Outcome::NotStarted,
    )
}
fn missing() -> NativeError {
    NativeError::new(
        Code::TargetNotFound,
        "No exact Electron window matches the Core Graphics window",
        Outcome::NotStarted,
    )
}
fn exact(bounds: Rect, title: &str, candidate: Rect, candidate_title: &str) -> bool {
    title == candidate_title
        && (bounds.x - candidate.x).abs() <= 1.
        && (bounds.y - candidate.y).abs() <= 1.
        && (bounds.width - candidate.width).abs() <= 1.
        && (bounds.height - candidate.height).abs() <= 1.
}
fn rect(value: &Value) -> Option<Rect> {
    let rect = Rect {
        x: value.get("x")?.as_f64()?,
        y: value.get("y")?.as_f64()?,
        width: value.get("width")?.as_f64()?,
        height: value.get("height")?.as_f64()?,
    };
    if [rect.x, rect.y, rect.width, rect.height]
        .iter()
        .all(|value| value.is_finite())
        && rect.width > 0.
        && rect.height > 0.
    {
        return Some(rect);
    }
    None
}
fn placement(socket: &mut Socket) -> Result<Option<(Rect, Rect)>, NativeError> {
    let value = socket
        .evaluate("({screenX,screenY,outerWidth,outerHeight,innerWidth,innerHeight})".into())?;
    let parts = [
        "screenX",
        "screenY",
        "outerWidth",
        "outerHeight",
        "innerWidth",
        "innerHeight",
    ]
    .map(|name| value.get(name).and_then(Value::as_f64));
    let [
        Some(x),
        Some(y),
        Some(outer_width),
        Some(outer_height),
        Some(inner_width),
        Some(inner_height),
    ] = parts
    else {
        return Ok(None);
    };
    if ![x, y, outer_width, outer_height, inner_width, inner_height]
        .iter()
        .all(|value| value.is_finite())
    {
        return Ok(None);
    }
    Ok(Some((
        Rect {
            x,
            y,
            width: outer_width,
            height: outer_height,
        },
        Rect {
            x: x + (outer_width - inner_width) / 2.,
            y: y + outer_height - inner_height,
            width: inner_width,
            height: inner_height,
        },
    )))
}

fn perform(
    runtime: &dyn Runtime,
    http: &reqwest::Client,
    handle: &tokio::runtime::Handle,
    target: Target,
    window: Window,
    operation: Operation,
    signal: Option<watch::Receiver<bool>>,
) -> Result<Option<BridgeResult>, NativeError> {
    if signal.as_ref().is_some_and(|signal| *signal.borrow()) {
        return Err(unavailable());
    }
    let Target::Desktop { pid, window_id, .. } = target else {
        return Err(missing());
    };
    let Some(app) = runtime.app_path(pid).map_err(|_| unavailable())? else {
        return Ok(None);
    };
    let Ok(bytes) = runtime.fuse_bytes(&app) else {
        return Ok(None);
    };
    let fuse = inspect_fuse(&bytes);
    let owned = |runtime: &dyn Runtime| -> Result<Option<Endpoint>, NativeError> {
        for port in runtime.owned_ports(pid).map_err(|_| unavailable())? {
            if let Some(endpoint) = handle.block_on(endpoint(http, port)) {
                return Ok(Some(endpoint));
            }
        }
        Ok(None)
    };
    if let Some(endpoint) = owned(runtime)? {
        let pages = endpoint
            .targets
            .iter()
            .filter(|target| {
                target.kind == "page"
                    && target.id.as_ref().is_some_and(|s| !s.is_empty())
                    && target.title.as_ref().is_some_and(|s| !s.is_empty())
            })
            .collect::<Vec<_>>();
        if !pages.is_empty() {
            for page in pages {
                if !runtime
                    .owned_ports(pid)
                    .map_err(|_| unavailable())?
                    .contains(&endpoint.port)
                {
                    return Err(unavailable());
                }
                let mut socket = Socket::connect(&page.websocket)?;
                let Some((bounds, content)) = placement(&mut socket)? else {
                    continue;
                };
                if !exact(
                    window.bounds,
                    &window.title,
                    bounds,
                    page.title.as_deref().unwrap_or(""),
                ) {
                    continue;
                }
                let mut dispatched = false;
                let result = renderer_work(
                    &mut socket,
                    bounds,
                    content,
                    &operation,
                    &signal,
                    &mut dispatched,
                );
                return result.map(Some).map_err(|error| {
                    if dispatched {
                        NativeError::new(
                            Code::UnknownOutcome,
                            "Electron input may have been dispatched; inspect before retrying",
                            Outcome::Unknown,
                        )
                    } else {
                        error
                    }
                });
            }
            return Err(missing());
        }
    }
    if fuse != Fuse::On {
        return Ok(None);
    }
    let initial = runtime.owned_ports(pid).map_err(|_| unavailable())?;
    runtime.signal(pid).map_err(|_| unavailable())?;
    let deadline = Instant::now() + Duration::from_secs(3);
    let endpoint = loop {
        let mut found = None;
        for port in runtime.owned_ports(pid).map_err(|_| unavailable())? {
            if initial.contains(&port) {
                continue;
            }
            if let Some(endpoint) = handle
                .block_on(endpoint(http, port))
                .filter(|endpoint| endpoint.targets.iter().any(|target| target.kind == "node"))
            {
                found = Some(endpoint);
                break;
            }
        }
        if let Some(endpoint) = found {
            break endpoint;
        }
        if Instant::now() >= deadline {
            return Err(NativeError::new(
                Code::InspectorCloseFailed,
                "Inspector startup or cleanup could not be confirmed",
                Outcome::Unknown,
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let inspector = endpoint
        .targets
        .iter()
        .find(|target| target.kind == "node")
        .ok_or_else(unavailable)?;
    if !runtime
        .owned_ports(pid)
        .map_err(|_| unavailable())?
        .contains(&endpoint.port)
    {
        return Err(unavailable());
    }
    let mut dispatched = false;
    let result = match Socket::connect(&inspector.websocket) {
        Ok(mut socket) => {
            let result = inspector_work(
                &mut socket,
                window_id,
                &window,
                &operation,
                &signal,
                &mut dispatched,
            );
            let close = socket.fire(
                "Runtime.evaluate",
                json!({"expression":"require('inspector').close()","includeCommandLineAPI":true}),
            );
            if close.is_ok() {
                std::thread::sleep(Duration::from_millis(20));
            }
            drop(socket);
            result
        }
        Err(error) => Err(error),
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    while runtime
        .owned_ports(pid)
        .map_err(|_| unavailable())?
        .contains(&endpoint.port)
        && Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(50));
    }
    if runtime
        .owned_ports(pid)
        .map_err(|_| unavailable())?
        .contains(&endpoint.port)
    {
        return Err(NativeError::new(
            Code::InspectorCloseFailed,
            "Electron inspector did not close after the call",
            Outcome::Unknown,
        ));
    }
    result.map(Some).map_err(|error| {
        if dispatched {
            NativeError::new(
                Code::UnknownOutcome,
                "Electron input may have been dispatched; inspect before retrying",
                Outcome::Unknown,
            )
        } else {
            error
        }
    })
}

fn dispatch(
    signal: &Option<watch::Receiver<bool>>,
    dispatched: &mut bool,
) -> Result<(), NativeError> {
    if signal.as_ref().is_some_and(|signal| *signal.borrow()) {
        return Err(if *dispatched {
            NativeError::new(
                Code::UnknownOutcome,
                "Electron input was interrupted",
                Outcome::Unknown,
            )
        } else {
            unavailable()
        });
    }
    *dispatched = true;
    Ok(())
}
fn key_name(key: &str) -> String {
    match key {
        "enter" | "return" => "Enter",
        "tab" => "Tab",
        "escape" => "Escape",
        "space" => " ",
        "delete" => "Backspace",
        "forward_delete" => "Delete",
        "up" => "ArrowUp",
        "down" => "ArrowDown",
        "left" => "ArrowLeft",
        "right" => "ArrowRight",
        "page_up" => "PageUp",
        "page_down" => "PageDown",
        "home" => "Home",
        "end" => "End",
        _ => {
            return if key.starts_with('f') && super::types::valid_key(key) {
                key.to_uppercase()
            } else {
                key.into()
            };
        }
    }
    .into()
}
fn renderer_capture(
    socket: &mut Socket,
    bounds: Rect,
    content: Rect,
) -> Result<BridgeResult, NativeError> {
    let response = socket.send(
        "Page.captureScreenshot",
        json!({"format":"png","captureBeyondViewport":false}),
    )?;
    let data = response
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(unavailable)?;
    render(&format!("data:image/png;base64,{data}"), bounds, content)
}
fn renderer_work(
    socket: &mut Socket,
    bounds: Rect,
    content: Rect,
    operation: &Operation,
    signal: &Option<watch::Receiver<bool>>,
    dispatched: &mut bool,
) -> Result<BridgeResult, NativeError> {
    let before = renderer_capture(socket, bounds, content)?;
    if matches!(operation, Operation::Capture) {
        return Ok(before);
    }
    let Operation::Action(action) = operation else {
        return Err(unavailable());
    };
    let BridgeResult::Capture { scale, .. } = before else {
        return Err(unavailable());
    };
    match action {
        Action::Click {
            element: None,
            x: Some(x),
            y: Some(y),
            button,
            count,
        } => {
            let (x, y) = content_point(bounds, content, scale, f64::from(*x), f64::from(*y))?;
            for count in 1..=count.unwrap_or(1) {
                dispatch(signal, dispatched)?;
                socket.send("Input.dispatchMouseEvent",json!({"type":"mousePressed","x":x,"y":y,"button":button.as_deref().unwrap_or("left"),"clickCount":count}))?;
                socket.send("Input.dispatchMouseEvent",json!({"type":"mouseReleased","x":x,"y":y,"button":button.as_deref().unwrap_or("left"),"clickCount":count}))?;
            }
        }
        Action::Drag {
            from_x,
            from_y,
            to_x,
            to_y,
        } => {
            let from = content_point(
                bounds,
                content,
                scale,
                f64::from(*from_x),
                f64::from(*from_y),
            )?;
            let to = content_point(bounds, content, scale, f64::from(*to_x), f64::from(*to_y))?;
            dispatch(signal, dispatched)?;
            socket.send(
                "Input.dispatchMouseEvent",
                json!({"type":"mousePressed","x":from.0,"y":from.1,"button":"left","clickCount":1}),
            )?;
            for step in 1..=5 {
                socket.send("Input.dispatchMouseEvent",json!({"type":"mouseMoved","x":from.0+(to.0-from.0)*f64::from(step)/5.,"y":from.1+(to.1-from.1)*f64::from(step)/5.,"button":"left","buttons":1}))?;
            }
            socket.send(
                "Input.dispatchMouseEvent",
                json!({"type":"mouseReleased","x":to.0,"y":to.1,"button":"left","clickCount":1}),
            )?;
        }
        Action::Type {
            element: None,
            text,
        } => {
            dispatch(signal, dispatched)?;
            socket.send("Input.insertText", json!({"text":text}))?;
        }
        Action::Key {
            element: None,
            key,
            modifiers,
        } => {
            let flags = modifiers.iter().fold(0, |flags, modifier| {
                flags
                    | match modifier.as_str() {
                        "option" => 1,
                        "control" => 2,
                        "command" => 4,
                        "shift" => 8,
                        _ => 0,
                    }
            });
            let key = key_name(key);
            dispatch(signal, dispatched)?;
            let mut params = json!({"type":"keyDown","key":key,"modifiers":flags});
            if key.encode_utf16().count() == 1 && flags == 0 {
                params["text"] = json!(key);
            }
            socket.send("Input.dispatchKeyEvent", params)?;
            socket.send(
                "Input.dispatchKeyEvent",
                json!({"type":"keyUp","key":key,"modifiers":flags}),
            )?;
        }
        Action::ScrollPixels {
            x,
            y,
            delta_x,
            delta_y,
        } => {
            let (x, y) = content_point(bounds, content, scale, f64::from(*x), f64::from(*y))?;
            dispatch(signal, dispatched)?;
            socket.send(
                "Input.dispatchMouseEvent",
                json!({"type":"mouseWheel","x":x,"y":y,"deltaX":delta_x,"deltaY":delta_y}),
            )?;
        }
        _ => return Err(unavailable()),
    }
    let after = renderer_capture(socket, bounds, content)?;
    Ok(BridgeResult::Action {
        changed: before != after,
    })
}

fn inspector_selector(window_id: u64) -> String {
    format!(
        "(()=>{{const win=require('electron').BrowserWindow.getAllWindows().find(w=>w.getMediaSourceId()==='window:{window_id}:0');return win||null}})()"
    )
}
fn inspector_capture(
    socket: &mut Socket,
    selector: &str,
    bounds: Rect,
    content: Rect,
) -> Result<BridgeResult, NativeError> {
    socket.evaluate(format!("(async()=>{{const w={selector};if(!w)return null;await w.webContents.capturePage();w.webContents.invalidate();return null}})()"))?;
    let value=socket.evaluate(format!("(async()=>{{const w={selector};if(!w)return null;let last='';for(let i=0;i<5;i++){{await new Promise(r=>setTimeout(r,150));const next=(await w.webContents.capturePage()).toDataURL();if(next===last)return next;last=next}}return last}})()"))?;
    render(value.as_str().ok_or_else(missing)?, bounds, content)
}
fn inspector_work(
    socket: &mut Socket,
    window_id: u64,
    window: &Window,
    operation: &Operation,
    signal: &Option<watch::Receiver<bool>>,
    dispatched: &mut bool,
) -> Result<BridgeResult, NativeError> {
    let selector = inspector_selector(window_id);
    let value=socket.evaluate(format!("(()=>{{const w={selector};return w?{{bounds:w.getBounds(),content:w.getContentBounds()}}:null}})()"))?;
    let bounds = value.get("bounds").and_then(rect).ok_or_else(missing)?;
    let content = value.get("content").and_then(rect).ok_or_else(missing)?;
    if !exact(window.bounds, &window.title, bounds, &window.title) {
        return Err(missing());
    }
    let before = inspector_capture(socket, &selector, bounds, content)?;
    if matches!(operation, Operation::Capture) {
        return Ok(before);
    }
    let Operation::Action(action) = operation else {
        return Err(unavailable());
    };
    let BridgeResult::Capture { scale, .. } = before else {
        return Err(unavailable());
    };
    let mut send = |event: Value| -> Result<(), NativeError> {
        dispatch(signal, dispatched)?;
        let delivered=socket.evaluate(format!("(()=>{{const w={selector};if(!w)return false;w.webContents.sendInputEvent({event});return true}})()"))?;
        if delivered != Value::Bool(true) {
            return Err(missing());
        }
        Ok(())
    };
    match action {
        Action::Click {
            element: None,
            x: Some(x),
            y: Some(y),
            button,
            count,
        } => {
            let (x, y) = content_point(bounds, content, scale, f64::from(*x), f64::from(*y))?;
            for count in 1..=count.unwrap_or(1) {
                for kind in ["mouseMove", "mouseDown", "mouseUp"] {
                    send(
                        json!({"type":kind,"x":x,"y":y,"button":button.as_deref().unwrap_or("left"),"clickCount":count}),
                    )?;
                }
            }
        }
        Action::Drag {
            from_x,
            from_y,
            to_x,
            to_y,
        } => {
            let from = content_point(
                bounds,
                content,
                scale,
                f64::from(*from_x),
                f64::from(*from_y),
            )?;
            let to = content_point(bounds, content, scale, f64::from(*to_x), f64::from(*to_y))?;
            send(json!({"type":"mouseDown","x":from.0,"y":from.1,"button":"left","clickCount":1}))?;
            for step in 1..=5 {
                send(
                    json!({"type":"mouseDrag","x":from.0+(to.0-from.0)*f64::from(step)/5.,"y":from.1+(to.1-from.1)*f64::from(step)/5.,"button":"left"}),
                )?;
            }
            send(json!({"type":"mouseUp","x":to.0,"y":to.1,"button":"left","clickCount":1}))?;
        }
        Action::Type {
            element: None,
            text,
        } => {
            if text.len() > 4096 {
                return Err(unavailable());
            }
            dispatch(signal, dispatched)?;
            let text = serde_json::to_string(text).map_err(|_| unavailable())?;
            if socket.evaluate(format!("(()=>{{const w={selector};if(!w)return false;w.webContents.insertText({text});return true}})()"))?!=Value::Bool(true) {return Err(missing());}
        }
        Action::Key {
            element: None,
            key,
            modifiers,
        } => {
            let key = key_name(key);
            let key = key.strip_prefix("Arrow").unwrap_or(&key);
            let key = if key == "Enter" { "Return" } else { key };
            let modifiers = modifiers
                .iter()
                .map(|modifier| match modifier.as_str() {
                    "command" => "meta",
                    "option" => "alt",
                    other => other,
                })
                .collect::<Vec<_>>();
            for kind in ["keyDown", "char", "keyUp"] {
                send(json!({"type":kind,"keyCode":key,"modifiers":modifiers}))?;
            }
        }
        Action::ScrollPixels {
            x,
            y,
            delta_x,
            delta_y,
        } => {
            let (x, y) = content_point(bounds, content, scale, f64::from(*x), f64::from(*y))?;
            send(json!({"type":"mouseWheel","x":x,"y":y,"deltaX":delta_x,"deltaY":delta_y}))?;
        }
        _ => return Err(unavailable()),
    }
    for _ in 0..3 {
        if inspector_capture(socket, &selector, bounds, content)? != before {
            return Ok(BridgeResult::Action { changed: true });
        }
    }
    Ok(BridgeResult::Action { changed: false })
}

fn render(data_url: &str, bounds: Rect, content: Rect) -> Result<BridgeResult, NativeError> {
    if data_url.len() > 20_000_000
        || (!data_url.starts_with("data:image/png;base64,")
            && !data_url.starts_with("data:image/jpeg;base64,"))
    {
        return Err(unavailable());
    }
    let bytes = decode_base64(data_url.split_once(',').ok_or_else(unavailable)?.1);
    let source = photon_rs::native::open_image_from_bytes(&bytes).map_err(|_| unavailable())?;
    let scale = 1.0_f64.min(1280. / bounds.width.max(bounds.height));
    let width = (bounds.width * scale).floor().max(1.) as u32;
    let height = (bounds.height * scale).floor().max(1.) as u32;
    let content_width = (content.width * scale).floor().max(1.) as u32;
    let content_height = (content.height * scale).floor().max(1.) as u32;
    let resized = photon_rs::transform::resize(
        &source,
        content_width,
        content_height,
        photon_rs::transform::SamplingFilter::Lanczos3,
    );
    let image = resized.get_raw_pixels();
    let mut pixels = vec![0; width as usize * height as usize * 4];
    for pixel in pixels.as_chunks_mut::<4>().0 {
        pixel[3] = 255;
    }
    let offset_x = ((content.x - bounds.x) * scale + 0.5).floor() as i64;
    let offset_y = ((content.y - bounds.y) * scale + 0.5).floor() as i64;
    for y in 0..i64::from(content_height) {
        let row = y + offset_y;
        if row < 0 || row >= i64::from(height) {
            continue;
        }
        let start = 0.max(offset_x);
        let end = i64::from(width).min(offset_x + i64::from(content_width));
        if start >= end {
            continue;
        }
        let source = ((y * i64::from(content_width) + start - offset_x) * 4) as usize;
        let destination = ((row * i64::from(width) + start) * 4) as usize;
        let length = ((end - start) * 4) as usize;
        pixels[destination..destination + length].copy_from_slice(&image[source..source + length]);
    }
    let output = photon_rs::PhotonImage::new(pixels, width, height);
    for quality in [60, 45, 30, 20] {
        let bytes = output.get_bytes_jpeg(quality);
        if bytes.len() <= 600_000 {
            return Ok(BridgeResult::Capture {
                image: base64(&bytes),
                width,
                height,
                scale,
            });
        }
    }
    Err(unavailable())
}
fn decode_base64(text: &str) -> Vec<u8> {
    let mut output = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0;
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        buffer = buffer.wrapping_shl(6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
        }
    }
    output
}
fn base64(bytes: &[u8]) -> String {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        output.push(alphabet[(value >> 18) as usize] as char);
        output.push(alphabet[((value >> 12) & 63) as usize] as char);
        output.push(if chunk.len() > 1 {
            alphabet[((value >> 6) & 63) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            alphabet[(value & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}
