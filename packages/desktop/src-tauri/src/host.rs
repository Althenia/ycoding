use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Child;
#[cfg(not(feature = "isolated-smoke"))]
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
#[cfg(not(feature = "isolated-smoke"))]
use tauri::Emitter;
use tauri::{AppHandle, Manager, State, WebviewWindow};

#[cfg(feature = "isolated-smoke")]
mod channel;

type Reply = Result<Value, String>;
type Pending = mpsc::SyncSender<Reply>;

const OUTPUT_LINE_LIMIT: usize = 64 * 1024 * 1024;
const EVENT_LIMIT: usize = 1024 * 1024;
const MESSAGE_LIMIT: usize = 512;
const PROMPT_LIMIT: usize = 600_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    executable: String,
    version: String,
    files: Vec<ManifestFile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestFile {
    path: String,
    sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
enum Operation {
    Preferences,
    State,
    Connect,
    Disconnect,
    Sessions,
    Workspaces,
    Messages,
    CreateSession,
    Prompt,
    Interrupt,
    Requests,
    Reply,
    Models,
    SwitchModel,
    Pin,
    Session,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionTarget {
    #[serde(rename = "sessionID")]
    session_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionsPage {
    revision: u64,
    cursor: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionsSearch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    search: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum SessionsQuery {
    Page(SessionsPage),
    Search(SessionsSearch),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PinRequest {
    #[serde(rename = "sessionID")]
    session_id: String,
    revision: u64,
    pinned: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DirectorySource {
    directory: String,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum ModelSource {
    Session(String),
    Directory(DirectorySource),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelReference {
    id: String,
    #[serde(rename = "providerID")]
    provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    variant: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    profile: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelSwitch {
    #[serde(rename = "sessionID")]
    session_id: String,
    revision: u64,
    model: ModelReference,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Decision {
    Once,
    Always,
    Reject,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum RequestReply {
    Permission {
        #[serde(rename = "sessionID")]
        session_id: String,
        revision: u64,
        #[serde(rename = "requestID")]
        request_id: String,
        reply: Decision,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Form {
        #[serde(rename = "sessionID")]
        session_id: String,
        revision: u64,
        #[serde(rename = "formID")]
        form_id: String,
        answer: serde_json::Map<String, Value>,
    },
    FormCancel {
        #[serde(rename = "sessionID")]
        session_id: String,
        revision: u64,
        #[serde(rename = "formID")]
        form_id: String,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase", deny_unknown_fields)]
enum Selection {
    Own,
    Shared {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        server: Option<String>,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Idle,
    Connecting,
    Connected,
    Reconnecting,
    Error,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Own,
    Shared,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectionState {
    generation: u64,
    status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mode: Option<Mode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(
        default,
        rename = "backendPID",
        skip_serializing_if = "Option::is_none"
    )]
    backend_pid: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    notice: Option<String>,
}

#[derive(Debug, PartialEq)]
enum Routed {
    Emit(&'static str, Value),
    Reply(u64, Reply),
}

#[derive(Default)]
struct Replies {
    next: u64,
    closed: bool,
    pending: HashMap<u64, Pending>,
}

#[cfg_attr(not(any(test, feature = "isolated-smoke")), allow(dead_code))]
enum Lease {
    #[cfg_attr(feature = "isolated-smoke", allow(dead_code))]
    Child(Child),
    Inherited,
}

#[cfg_attr(not(any(test, feature = "isolated-smoke")), allow(dead_code))]
struct Control {
    open: Vec<u8>,
    closed: Vec<u8>,
}

type OnEnd = Box<dyn FnOnce() + Send>;

const WRITER_WAIT: Duration = Duration::from_secs(5);
const READER_WAIT: Duration = Duration::from_secs(12);
const CHILD_WAIT: Duration = Duration::from_secs(12);
const CHANNEL_TIMEOUT: &str = "The native channel did not close in time.";

struct Host {
    replies: Arc<Mutex<Replies>>,
    input: Mutex<Option<mpsc::SyncSender<Vec<u8>>>>,
    lease: Mutex<Option<Lease>>,
    reader: Mutex<Option<JoinHandle<()>>>,
    writer: Mutex<Option<JoinHandle<()>>>,
}

#[cfg(any(test, feature = "isolated-smoke"))]
fn control_lines(resources: &Path) -> Result<Control, String> {
    let resources = resources
        .to_str()
        .ok_or("The native resources path is not valid text.")?;
    let line = |value: Value| -> Result<Vec<u8>, String> {
        let mut bytes =
            serde_json::to_vec(&value).map_err(|_| "Invalid native channel marker.".to_owned())?;
        bytes.push(b'\n');
        Ok(bytes)
    };
    Ok(Control {
        open: line(json!({ "resources": resources, "state": "open", "type": "desktop.channel" }))?,
        closed: line(json!({ "state": "closed", "type": "desktop.channel" }))?,
    })
}

fn bounded_join(slot: &Mutex<Option<JoinHandle<()>>>, wait: Duration) -> Result<(), String> {
    let deadline = Instant::now() + wait;
    loop {
        {
            let mut guard = slot
                .lock()
                .map_err(|_| "Native worker cleanup failed.".to_owned())?;
            match guard.as_ref().map(|handle| handle.is_finished()) {
                None => return Ok(()),
                Some(true) => {
                    return match guard.take() {
                        Some(handle) => handle
                            .join()
                            .map_err(|_| "Native worker cleanup failed.".to_owned()),
                        None => Ok(()),
                    };
                }
                Some(false) => {}
            }
        }
        if Instant::now() >= deadline {
            return Err(CHANNEL_TIMEOUT.to_owned());
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn backend_files(root: &Path, relative: &Path, files: &mut Vec<String>) -> io::Result<()> {
    for entry in fs::read_dir(root.join(relative))? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let path = relative.join(entry.file_name());
        if kind.is_dir() {
            backend_files(root, &path, files)?;
        } else if kind.is_file() {
            files.push(
                path.to_str()
                    .ok_or_else(|| io::Error::other("non-UTF-8 backend path"))?
                    .to_owned(),
            );
        } else {
            return Err(io::Error::other("unsupported backend entry"));
        }
    }
    Ok(())
}

fn digest(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut bytes = [0_u8; 65_536];
    loop {
        let size = file.read(&mut bytes)?;
        if size == 0 {
            break;
        }
        digest.update(&bytes[..size]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn executable(resources: &Path) -> Result<PathBuf, String> {
    let checked = || -> Result<PathBuf, Box<dyn std::error::Error>> {
        let manifest: Manifest =
            serde_json::from_slice(&fs::read(resources.join("backend.json"))?)?;
        if manifest.executable != "backend/ycoding" || manifest.version.is_empty() {
            return Err("invalid manifest".into());
        }
        let listed: HashMap<&str, &str> = manifest
            .files
            .iter()
            .map(|file| (file.path.as_str(), file.sha256.as_str()))
            .collect();
        if listed.len() != manifest.files.len()
            || !listed.contains_key(manifest.executable.as_str())
        {
            return Err("invalid manifest".into());
        }
        let root = resources.canonicalize()?;
        let mut present = Vec::new();
        backend_files(&root, Path::new("backend"), &mut present)?;
        if present.len() != listed.len() {
            return Err("backend files differ".into());
        }
        for file in &present {
            if listed.get(file.as_str()).copied() != Some(digest(&root.join(file))?.as_str()) {
                return Err("digest mismatch".into());
            }
        }
        let binary = root.join(&manifest.executable);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if fs::metadata(&binary)?.permissions().mode() & 0o111 == 0 {
                return Err("not executable".into());
            }
        }
        Ok(binary)
    };
    checked().map_err(|_| "The bundled backend is missing or does not match its manifest. Rebuild the desktop app.".to_owned())
}

fn bounded(text: String) -> String {
    match text.char_indices().nth(MESSAGE_LIMIT) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text,
    }
}

fn route(message: Value) -> Option<Routed> {
    let Value::Object(mut fields) = message else {
        return None;
    };
    let kind = fields.remove("type")?;
    match kind.as_str()? {
        "state" if fields.len() == 1 => {
            let mut state: ConnectionState = serde_json::from_value(fields.remove("data")?).ok()?;
            state.version = state.version.map(bounded);
            state.error = state.error.map(bounded);
            state.notice = state.notice.map(bounded);
            Some(Routed::Emit(
                "desktop:state",
                serde_json::to_value(state).ok()?,
            ))
        }
        "event" if fields.len() == 1 => {
            let data = fields.remove("data")?;
            data.get("type")?.as_str()?;
            if serde_json::to_vec(&data).ok()?.len() > EVENT_LIMIT {
                return Some(Routed::Emit("desktop:resync", Value::Null));
            }
            Some(Routed::Emit("desktop:event", data))
        }
        "reply" if fields.len() == 2 => {
            let id = fields.remove("id")?.as_u64()?;
            if let Some(error) = fields.remove("error") {
                return Some(Routed::Reply(id, Err(bounded(error.as_str()?.to_owned()))));
            }
            Some(Routed::Reply(id, Ok(fields.remove("data")?)))
        }
        _ => None,
    }
}

fn fail_pending(replies: &Mutex<Replies>, message: &str) {
    if let Ok(mut state) = replies.lock() {
        state.closed = true;
        for (_, pending) in state.pending.drain() {
            let _ = pending.send(Err(message.to_owned()));
        }
    }
}

impl Host {
    #[cfg(not(feature = "isolated-smoke"))]
    fn start(app: AppHandle, mut command: Command) -> Result<Self, String> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| {
                "Could not launch the bundled native client. Rebuild the desktop app.".to_owned()
            })?;
        let stdin = child
            .stdin
            .take()
            .ok_or("Native client input is unavailable.")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Native client output is unavailable.")?;
        Self::attach(
            move |channel, data| app.emit(channel, data).is_ok(),
            stdin,
            stdout,
            Lease::Child(child),
            None,
            None,
        )
    }

    fn attach(
        emit: impl Fn(&'static str, Value) -> bool + Send + 'static,
        mut sink: impl Write + Send + 'static,
        source: impl Read + Send + 'static,
        lease: Lease,
        control: Option<Control>,
        on_end: Option<OnEnd>,
    ) -> Result<Self, String> {
        let replies = Arc::new(Mutex::new(Replies::default()));
        let (input, receiver) = mpsc::sync_channel::<Vec<u8>>(8);
        let writing = Arc::clone(&replies);
        let writer = thread::spawn(move || {
            let broken = "The native client input closed. Restart the app.";
            if let Some(control) = &control
                && sink
                    .write_all(&control.open)
                    .and_then(|_| sink.flush())
                    .is_err()
            {
                fail_pending(&writing, broken);
                return;
            }
            while let Ok(bytes) = receiver.recv() {
                if writing.lock().map_or(true, |state| state.closed) {
                    break;
                }
                if sink.write_all(&bytes).and_then(|_| sink.flush()).is_err() {
                    fail_pending(&writing, broken);
                    return;
                }
            }
            if let Some(control) = &control
                && sink
                    .write_all(&control.closed)
                    .and_then(|_| sink.flush())
                    .is_err()
            {
                fail_pending(&writing, broken);
            }
        });
        let reading = Arc::clone(&replies);
        let reader = thread::spawn(move || {
            let mut output = BufReader::new(source);
            loop {
                let mut bytes = Vec::new();
                let result = output
                    .by_ref()
                    .take(OUTPUT_LINE_LIMIT as u64 + 1)
                    .read_until(b'\n', &mut bytes);
                if !matches!(result, Ok(size) if size > 0)
                    || bytes.len() > OUTPUT_LINE_LIMIT
                    || bytes.last() != Some(&b'\n')
                {
                    break;
                }
                let Some(routed) = serde_json::from_slice::<Value>(&bytes).ok().and_then(route)
                else {
                    break;
                };
                if reading.lock().map_or(true, |state| state.closed) {
                    continue;
                }
                match routed {
                    Routed::Emit(channel, data) => {
                        if !emit(channel, data) {
                            break;
                        }
                    }
                    Routed::Reply(id, reply) => {
                        let pending = reading
                            .lock()
                            .ok()
                            .and_then(|mut state| state.pending.remove(&id));
                        if let Some(pending) = pending {
                            let _ = pending.send(reply);
                        }
                    }
                }
            }
            fail_pending(&reading, "The native client closed. Restart the app.");
            if let Some(end) = on_end {
                end();
            }
        });
        Ok(Self {
            replies,
            input: Mutex::new(Some(input)),
            lease: Mutex::new(Some(lease)),
            reader: Mutex::new(Some(reader)),
            writer: Mutex::new(Some(writer)),
        })
    }

    fn request(&self, operation: Operation, input: Value) -> Reply {
        let (sender, receiver) = mpsc::sync_channel(1);
        let id = {
            let mut state = self
                .replies
                .lock()
                .map_err(|_| "The native client state failed.")?;
            if state.closed {
                return Err("The native client is closed. Restart the app.".to_owned());
            }
            if state.pending.len() >= 16 {
                return Err("The native client is busy. Wait and retry.".to_owned());
            }
            state.next += 1;
            let id = state.next;
            state.pending.insert(id, sender);
            id
        };
        let sent = (|| -> Result<(), String> {
            let mut bytes =
                serde_json::to_vec(&json!({ "id": id, "operation": operation, "input": input }))
                    .map_err(|_| "Invalid desktop request.")?;
            bytes.push(b'\n');
            self.input
                .lock()
                .map_err(|_| "Native client input failed.")?
                .as_ref()
                .ok_or("Native client is closing.")?
                .try_send(bytes)
                .map_err(|_| "The native client request queue is full or closed.".to_owned())
        })();
        let reply = sent.and_then(|_| {
            receiver
                .recv_timeout(Duration::from_secs(60))
                .map_err(|_| "The native client request timed out. Cancel and retry.".to_owned())?
        });
        if let Ok(mut state) = self.replies.lock() {
            state.pending.remove(&id);
        }
        reply
    }

    fn close(&self) -> Result<(), String> {
        self.close_within(WRITER_WAIT, READER_WAIT)
    }

    fn close_within(&self, writer_wait: Duration, reader_wait: Duration) -> Result<(), String> {
        fail_pending(&self.replies, "The native window is closing.");
        self.input
            .lock()
            .map_err(|_| "Native input cleanup failed.")?
            .take();
        let inherited = self
            .lease
            .lock()
            .map_err(|_| "Native process cleanup failed.")?
            .as_ref()
            .is_some_and(|lease| matches!(lease, Lease::Inherited));
        if inherited {
            bounded_join(&self.writer, writer_wait)?;
            bounded_join(&self.reader, reader_wait)?;
            self.lease
                .lock()
                .map_err(|_| "Native process cleanup failed.")?
                .take();
            return Ok(());
        }
        if let Some(Lease::Child(mut child)) = self
            .lease
            .lock()
            .map_err(|_| "Native process cleanup failed.")?
            .take()
        {
            let deadline = Instant::now() + CHILD_WAIT;
            while child
                .try_wait()
                .map_err(|_| "Could not inspect the native client.")?
                .is_none()
            {
                if Instant::now() >= deadline {
                    child
                        .kill()
                        .map_err(|_| "Could not retire the native client.")?;
                    child
                        .wait()
                        .map_err(|_| "Could not join the native client.")?;
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
        }
        for worker in [&self.writer, &self.reader] {
            if let Some(worker) = worker
                .lock()
                .map_err(|_| "Native worker cleanup failed.")?
                .take()
            {
                worker.join().map_err(|_| "Native worker cleanup failed.")?;
            }
        }
        Ok(())
    }
}

#[derive(Default, PartialEq)]
enum Shutdown {
    #[default]
    Running,
    Closing,
    Ready,
}

struct DesktopState {
    host: Result<Arc<Host>, String>,
    shutdown: Mutex<Shutdown>,
}

async fn call(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    operation: Operation,
    input: Value,
) -> Reply {
    if window.label() != "main" {
        return Err("This operation belongs to the native main window.".to_owned());
    }
    let host = Arc::clone(state.host.as_ref().map_err(Clone::clone)?);
    tauri::async_runtime::spawn_blocking(move || host.request(operation, input))
        .await
        .map_err(|_| "The native request worker failed.".to_owned())?
}

#[tauri::command]
async fn desktop_preferences(window: WebviewWindow, state: State<'_, DesktopState>) -> Reply {
    call(window, state, Operation::Preferences, Value::Null).await
}

#[tauri::command]
async fn desktop_state(window: WebviewWindow, state: State<'_, DesktopState>) -> Reply {
    call(window, state, Operation::State, Value::Null).await
}

#[tauri::command]
async fn desktop_connect(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    selection: Selection,
) -> Reply {
    if matches!(&selection, Selection::Shared { server: Some(server) } if server.len() > 2048) {
        return Err("The shared endpoint is too long.".to_owned());
    }
    call(
        window,
        state,
        Operation::Connect,
        serde_json::to_value(selection).map_err(|_| "Invalid backend choice.")?,
    )
    .await
}

#[tauri::command]
async fn desktop_disconnect(window: WebviewWindow, state: State<'_, DesktopState>) -> Reply {
    call(window, state, Operation::Disconnect, Value::Null).await
}

#[tauri::command]
async fn desktop_sessions(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    query: SessionsQuery,
) -> Reply {
    let oversized = match &query {
        SessionsQuery::Page(page) => page.cursor.len() > 4096,
        SessionsQuery::Search(search) => {
            search.search.as_ref().is_some_and(|text| text.len() > 256)
        }
    };
    if oversized {
        return Err("Use a Session search of at most 256 bytes and refresh Sessions.".to_owned());
    }
    call(
        window,
        state,
        Operation::Sessions,
        serde_json::to_value(query).map_err(|_| "Invalid Session list request.")?,
    )
    .await
}

#[tauri::command]
async fn desktop_session(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    request: SessionTarget,
) -> Reply {
    if request.session_id.len() > 128 {
        return Err("Choose a Session.".to_owned());
    }
    call(
        window,
        state,
        Operation::Session,
        serde_json::to_value(request).map_err(|_| "Choose a Session.")?,
    )
    .await
}

#[tauri::command]
async fn desktop_pin(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    request: PinRequest,
) -> Reply {
    if request.session_id.len() > 128 {
        return Err("Choose a Session.".to_owned());
    }
    call(
        window,
        state,
        Operation::Pin,
        serde_json::to_value(request).map_err(|_| "Invalid pin request.")?,
    )
    .await
}

#[tauri::command]
async fn desktop_workspaces(window: WebviewWindow, state: State<'_, DesktopState>) -> Reply {
    call(window, state, Operation::Workspaces, Value::Null).await
}

#[tauri::command]
async fn desktop_messages(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    session_id: String,
) -> Reply {
    if session_id.len() > 128 {
        return Err("Choose a Session.".to_owned());
    }
    call(
        window,
        state,
        Operation::Messages,
        Value::String(session_id),
    )
    .await
}

#[tauri::command]
async fn desktop_create_session(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    directory: String,
    session_id: String,
) -> Reply {
    if directory.len() > 4096 || session_id.len() > 128 {
        return Err("Choose a previously opened repository.".to_owned());
    }
    call(
        window,
        state,
        Operation::CreateSession,
        json!({ "directory": directory, "sessionID": session_id }),
    )
    .await
}

#[tauri::command]
async fn desktop_prompt(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    session_id: String,
    prompt_id: String,
    text: String,
) -> Reply {
    if session_id.len() > 128 || prompt_id.len() > 128 {
        return Err("Invalid message.".to_owned());
    }
    if text.len() > PROMPT_LIMIT {
        return Err("The message is too long to send.".to_owned());
    }
    call(
        window,
        state,
        Operation::Prompt,
        json!({ "sessionID": session_id, "promptID": prompt_id, "text": text }),
    )
    .await
}

#[tauri::command]
async fn desktop_interrupt(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    session_id: String,
) -> Reply {
    if session_id.len() > 128 {
        return Err("Choose a Session.".to_owned());
    }
    call(
        window,
        state,
        Operation::Interrupt,
        Value::String(session_id),
    )
    .await
}

#[tauri::command]
async fn desktop_requests(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    session_id: String,
) -> Reply {
    if session_id.len() > 128 {
        return Err("Choose a Session.".to_owned());
    }
    call(
        window,
        state,
        Operation::Requests,
        Value::String(session_id),
    )
    .await
}

#[tauri::command]
async fn desktop_reply(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    reply: RequestReply,
) -> Reply {
    let reply = serde_json::to_value(reply).map_err(|_| "Invalid request answer.")?;
    if serde_json::to_vec(&reply)
        .map_err(|_| "Invalid request answer.")?
        .len()
        > PROMPT_LIMIT
    {
        return Err("The answer is too long to send.".to_owned());
    }
    call(window, state, Operation::Reply, reply).await
}

#[tauri::command]
async fn desktop_models(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    source: ModelSource,
) -> Reply {
    let oversized = match &source {
        ModelSource::Session(session_id) => session_id.len() > 128,
        ModelSource::Directory(directory) => directory.directory.len() > 4096,
    };
    if oversized {
        return Err("Choose a Session or a previously opened repository.".to_owned());
    }
    call(
        window,
        state,
        Operation::Models,
        serde_json::to_value(source).map_err(|_| "Invalid model source.")?,
    )
    .await
}

#[tauri::command]
async fn desktop_switch_model(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    request: ModelSwitch,
) -> Reply {
    let model = &request.model;
    if request.session_id.len() > 128
        || model.id.len() > 1024
        || model.provider_id.len() > 1024
        || model
            .variant
            .as_ref()
            .is_some_and(|variant| variant.len() > 1024)
        || model
            .profile
            .as_ref()
            .is_some_and(|profile| profile.len() > 256)
    {
        return Err("Choose a model from the current list.".to_owned());
    }
    call(
        window,
        state,
        Operation::SwitchModel,
        serde_json::to_value(request).map_err(|_| "Invalid model choice.")?,
    )
    .await
}

fn shutdown(app: &AppHandle) {
    let state = app.state::<DesktopState>();
    let Ok(mut phase) = state.shutdown.lock() else {
        return;
    };
    if *phase != Shutdown::Running {
        return;
    }
    *phase = Shutdown::Closing;
    let host = state.host.as_ref().ok().map(Arc::clone);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = match host {
            Some(host) => tauri::async_runtime::spawn_blocking(move || host.close())
                .await
                .map_err(|_| "Native shutdown worker failed.".to_owned())
                .and_then(|result| result),
            None => Ok(()),
        };
        if let Ok(mut phase) = handle.state::<DesktopState>().shutdown.lock() {
            *phase = Shutdown::Ready;
        }
        if result.is_err() {
            eprintln!("Native client cleanup failed.");
        }
        handle.exit(if result.is_ok() { 0 } else { 1 });
    });
}

#[cfg(not(feature = "isolated-smoke"))]
fn worker_command(app: &tauri::App) -> Result<Command, String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|_| "Native resources are unavailable.")?;
    let preferences = app
        .path()
        .app_config_dir()
        .map_err(|_| "Native preferences are unavailable.")?
        .join("backend-preferences.json");
    let mut command = Command::new(executable(&resources)?);
    command
        .arg("desktop-client")
        .arg("--resources")
        .arg(resources)
        .arg("--preferences")
        .arg(preferences);
    Ok(command)
}

pub(super) fn run() {
    let application = tauri::Builder::default()
        .setup(|app| {
            let host = {
                #[cfg(feature = "isolated-smoke")]
                let host = channel::start(app);
                #[cfg(not(feature = "isolated-smoke"))]
                let host = worker_command(app)
                    .and_then(|command| Host::start(app.handle().clone(), command));
                host.map(Arc::new)
            };
            app.manage(DesktopState {
                host,
                shutdown: Mutex::new(Shutdown::Running),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_preferences,
            desktop_state,
            desktop_connect,
            desktop_disconnect,
            desktop_sessions,
            desktop_workspaces,
            desktop_messages,
            desktop_create_session,
            desktop_prompt,
            desktop_interrupt,
            desktop_requests,
            desktop_reply,
            desktop_models,
            desktop_switch_model,
            desktop_pin,
            desktop_session
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                shutdown(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("native desktop configuration must be valid");
    application.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let ready = app
                .state::<DesktopState>()
                .shutdown
                .lock()
                .is_ok_and(|phase| *phase == Shutdown::Ready);
            if !ready {
                api.prevent_exit();
                shutdown(app);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_replies_are_typed_and_closed() {
        let permission = json!({ "kind": "permission", "sessionID": "ses_synthetic", "revision": 2, "requestID": "per_synthetic", "reply": "reject", "message": "Not this file" });
        let reply: RequestReply = serde_json::from_value(permission.clone()).unwrap();
        assert_eq!(serde_json::to_value(reply).unwrap(), permission);
        let cancel = json!({ "kind": "form-cancel", "sessionID": "ses_synthetic", "revision": 2, "formID": "frm_synthetic" });
        let reply: RequestReply = serde_json::from_value(cancel.clone()).unwrap();
        assert_eq!(serde_json::to_value(reply).unwrap(), cancel);
        for invalid in [
            json!({ "kind": "permission", "sessionID": "ses_synthetic", "revision": 2, "requestID": "per_synthetic", "reply": "allow" }),
            json!({ "kind": "permission", "sessionID": "ses_synthetic", "revision": 2, "requestID": "per_synthetic", "reply": "once", "autonomy": "yolo" }),
            json!({ "kind": "permission", "sessionID": "ses_synthetic", "requestID": "per_synthetic", "reply": "once" }),
            json!({ "kind": "guardrail", "sessionID": "ses_synthetic", "revision": 2, "requestID": "per_synthetic", "reply": "once" }),
            json!({ "kind": "form", "sessionID": "ses_synthetic", "revision": 2, "formID": "frm_synthetic", "answer": ["yes"] }),
        ] {
            assert!(serde_json::from_value::<RequestReply>(invalid).is_err());
        }
    }

    #[test]
    fn model_requests_are_typed_and_closed() {
        for source in [
            json!("ses_synthetic"),
            json!({ "directory": "/synthetic/repo" }),
        ] {
            let parsed: ModelSource = serde_json::from_value(source.clone()).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), source);
        }
        let request = json!({ "sessionID": "ses_synthetic", "revision": 4, "model": { "id": "synthetic-model", "providerID": "synthetic-provider", "variant": "fast", "profile": "work" } });
        let parsed: ModelSwitch = serde_json::from_value(request.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), request);
        for invalid in [
            json!({ "directory": "/synthetic/repo", "workspace": "wrk_other" }),
            json!({ "sessionID": "ses_synthetic" }),
            json!(4),
        ] {
            assert!(serde_json::from_value::<ModelSource>(invalid).is_err());
        }
        for invalid in [
            json!({ "sessionID": "ses_synthetic", "model": { "id": "synthetic-model", "providerID": "synthetic-provider" } }),
            json!({ "sessionID": "ses_synthetic", "revision": 4, "model": { "id": "synthetic-model", "providerID": "synthetic-provider", "headers": {} } }),
            json!({ "sessionID": "ses_synthetic", "revision": 4, "model": { "id": "synthetic-model", "providerID": "synthetic-provider" }, "interrupt": true }),
        ] {
            assert!(serde_json::from_value::<ModelSwitch>(invalid).is_err());
        }
    }

    #[test]
    fn session_list_read_and_pin_requests_are_typed_and_closed() {
        let target = json!({ "sessionID": "ses_synthetic" });
        let parsed: SessionTarget = serde_json::from_value(target.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), target);
        for invalid in [
            json!({}),
            json!({ "sessionID": 4 }),
            json!({ "sessionID": "ses_synthetic", "directory": "/synthetic/repo" }),
            json!("ses_synthetic"),
        ] {
            assert!(serde_json::from_value::<SessionTarget>(invalid).is_err());
        }
        for query in [
            json!({}),
            json!({ "search": "synthetic" }),
            json!({ "revision": 4, "cursor": "synthetic-cursor" }),
        ] {
            let parsed: SessionsQuery = serde_json::from_value(query.clone()).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), query);
        }
        for invalid in [
            json!({ "revision": 4 }),
            json!({ "cursor": "synthetic-cursor" }),
            json!({ "search": "synthetic", "revision": 4, "cursor": "synthetic-cursor" }),
            json!({ "revision": -1, "cursor": "synthetic-cursor" }),
            json!({ "search": 4 }),
            json!({ "limit": 200 }),
            json!({ "background": "exclude" }),
            json!("synthetic"),
        ] {
            assert!(serde_json::from_value::<SessionsQuery>(invalid).is_err());
        }
        let request = json!({ "sessionID": "ses_synthetic", "revision": 4, "pinned": true });
        let parsed: PinRequest = serde_json::from_value(request.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), request);
        for invalid in [
            json!({ "sessionID": "ses_synthetic", "revision": 4 }),
            json!({ "sessionID": "ses_synthetic", "revision": 4, "pinned": "true" }),
            json!({ "sessionID": "ses_synthetic", "pinned": false }),
            json!({ "sessionID": "ses_synthetic", "revision": 4, "pinned": true, "title": "synthetic" }),
        ] {
            assert!(serde_json::from_value::<PinRequest>(invalid).is_err());
        }
    }

    #[test]
    fn shared_selection_without_server_requests_managed_discovery() {
        let selection: Selection = serde_json::from_value(json!({ "mode": "shared" })).unwrap();
        assert_eq!(
            serde_json::to_value(selection).unwrap(),
            json!({ "mode": "shared" })
        );
    }

    fn synthetic_bundle(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "ycoding-desktop-host-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let files = [
            ("backend/ycoding", "synthetic executable"),
            (
                "backend/Helper.app/Contents/MacOS/helper",
                "synthetic helper",
            ),
            ("backend/extension/manifest.json", "{\"synthetic\":true}"),
        ];
        let mut listed = Vec::new();
        for (path, bytes) in files {
            let file = root.join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, bytes).unwrap();
            listed.push(json!({ "path": path, "sha256": digest(&file).unwrap() }));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                root.join("backend/ycoding"),
                fs::Permissions::from_mode(0o700),
            )
            .unwrap();
        }
        fs::write(
            root.join("backend.json"),
            serde_json::to_vec(
                &json!({ "executable": "backend/ycoding", "version": "synthetic", "files": listed }),
            )
            .unwrap(),
        )
        .unwrap();
        root
    }

    #[test]
    fn manifest_verification_covers_every_bundled_backend_file() {
        type Change = (&'static str, fn(&Path));
        let changes: [Change; 4] = [
            ("tampered", |root| {
                fs::write(root.join("backend/extension/manifest.json"), "{}").unwrap()
            }),
            ("extra", |root| {
                fs::write(root.join("backend/extension/injected.js"), "synthetic").unwrap()
            }),
            ("missing", |root| {
                fs::remove_file(root.join("backend/Helper.app/Contents/MacOS/helper")).unwrap()
            }),
            ("non-executable", |root| {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(
                        root.join("backend/ycoding"),
                        fs::Permissions::from_mode(0o600),
                    )
                    .unwrap();
                }
            }),
        ];
        for (name, change) in changes {
            let root = synthetic_bundle(name);
            assert_eq!(
                executable(&root).unwrap(),
                root.canonicalize().unwrap().join("backend/ycoding")
            );
            change(&root);
            assert!(executable(&root).is_err(), "{name} bundle was accepted");
            fs::remove_dir_all(&root).unwrap();
        }
    }

    #[test]
    fn routes_only_typed_bounded_worker_messages() {
        let long = "x".repeat(MESSAGE_LIMIT + 100);
        assert_eq!(
            route(json!({ "type": "reply", "id": 7, "error": long })),
            Some(Routed::Reply(
                7,
                Err(format!("{}…", "x".repeat(MESSAGE_LIMIT)))
            ))
        );
        assert_eq!(
            route(json!({ "type": "reply", "id": 8, "data": null })),
            Some(Routed::Reply(8, Ok(Value::Null)))
        );
        assert_eq!(
            route(
                json!({ "type": "state", "data": { "generation": 2, "status": "connected", "mode": "shared", "revision": 1, "version": "1.0.0", "backendPID": 42 } })
            ),
            Some(Routed::Emit(
                "desktop:state",
                json!({ "generation": 2, "status": "connected", "mode": "shared", "revision": 1, "version": "1.0.0", "backendPID": 42 })
            ))
        );
        assert_eq!(
            route(
                json!({ "type": "state", "data": { "generation": 2, "status": "connected", "password": "synthetic" } })
            ),
            None
        );
        assert_eq!(
            route(
                json!({ "type": "event", "data": { "type": "session.idle", "data": { "sessionID": "ses_synthetic" } } })
            ),
            Some(Routed::Emit(
                "desktop:event",
                json!({ "type": "session.idle", "data": { "sessionID": "ses_synthetic" } })
            ))
        );
        assert_eq!(
            route(
                json!({ "type": "event", "data": { "type": "session.updated", "data": { "text": "x".repeat(EVENT_LIMIT) } } })
            ),
            Some(Routed::Emit("desktop:resync", Value::Null))
        );
        assert_eq!(route(json!({ "type": "event", "data": {} })), None);
        assert_eq!(route(json!({ "type": "log", "data": "synthetic" })), None);
        assert_eq!(
            route(json!({ "type": "reply", "id": 9, "data": null, "extra": true })),
            None
        );
    }
}

#[cfg(test)]
mod channel_tests {
    use super::*;
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;
    use std::sync::atomic::{AtomicUsize, Ordering};

    type Events = Arc<Mutex<Vec<(&'static str, Value)>>>;

    const OPEN: &str = "{\"resources\":\"/synthetic/Resources\",\"state\":\"open\",\"type\":\"desktop.channel\"}\n";
    const CLOSED: &str = "{\"state\":\"closed\",\"type\":\"desktop.channel\"}\n";
    const CLOSED_MESSAGE: &str = "The native client closed. Restart the app.";
    const LONG: Duration = Duration::from_secs(10);

    struct Rig {
        host: Arc<Host>,
        peer: UnixStream,
        lines: BufReader<UnixStream>,
        events: Events,
        ended: Arc<AtomicUsize>,
    }

    fn marked() -> Option<Control> {
        Some(control_lines(Path::new("/synthetic/Resources")).unwrap())
    }

    fn rig(control: Option<Control>) -> Rig {
        let (ours, peer) = UnixStream::pair().unwrap();
        peer.set_read_timeout(Some(LONG)).unwrap();
        let lines = BufReader::new(peer.try_clone().unwrap());
        let events: Events = Arc::default();
        let ended = Arc::new(AtomicUsize::new(0));
        let recorder = Arc::clone(&events);
        let count = Arc::clone(&ended);
        let sink = ours.try_clone().unwrap();
        let host = Host::attach(
            move |channel, data| {
                recorder.lock().unwrap().push((channel, data));
                true
            },
            sink,
            ours,
            Lease::Inherited,
            control,
            Some(Box::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
            })),
        )
        .unwrap();
        Rig {
            host: Arc::new(host),
            peer,
            lines,
            events,
            ended,
        }
    }

    fn raw(lines: &mut BufReader<UnixStream>) -> String {
        let mut line = String::new();
        lines.read_line(&mut line).unwrap();
        line
    }

    fn say(peer: &UnixStream, text: &str) {
        let mut peer = peer;
        peer.write_all(text.as_bytes()).unwrap();
        peer.flush().unwrap();
    }

    fn ask(host: &Arc<Host>) -> JoinHandle<Reply> {
        let host = Arc::clone(host);
        thread::spawn(move || host.request(Operation::State, Value::Null))
    }

    fn closing(host: &Arc<Host>) -> JoinHandle<Result<(), String>> {
        let host = Arc::clone(host);
        thread::spawn(move || host.close_within(LONG, LONG))
    }

    fn gone(host: &Host) -> bool {
        host.writer.lock().unwrap().is_none() && host.reader.lock().unwrap().is_none()
    }

    #[test]
    fn f1_open_marker_is_the_first_line_with_the_exact_resources() {
        let mut rig = rig(marked());
        assert_eq!(raw(&mut rig.lines), OPEN);
        rig.peer.shutdown(Shutdown::Both).unwrap();
        rig.host.close_within(LONG, LONG).unwrap();
    }

    #[test]
    fn f2_clean_close_writes_the_closed_marker_and_joins_both_threads() {
        let mut rig = rig(marked());
        assert_eq!(raw(&mut rig.lines), OPEN);
        let closing = closing(&rig.host);
        assert_eq!(raw(&mut rig.lines), CLOSED);
        rig.peer.shutdown(Shutdown::Write).unwrap();
        closing.join().unwrap().unwrap();
        assert!(gone(&rig.host));
        assert_eq!(rig.ended.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn f3_an_open_peer_makes_close_fail_and_keeps_the_unfinished_handle() {
        let rig = rig(None);
        let started = Instant::now();
        let outcome = rig.host.close_within(LONG, Duration::from_millis(100));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(
            outcome,
            Err("The native channel did not close in time.".to_owned())
        );
        assert!(rig.host.reader.lock().unwrap().is_some());
        assert!(rig.host.writer.lock().unwrap().is_none());
        rig.peer.shutdown(Shutdown::Write).unwrap();
        rig.host.close_within(LONG, LONG).unwrap();
        assert!(gone(&rig.host));
        assert_eq!(rig.ended.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn f4_peer_eof_fails_the_inflight_request_and_a_later_close_adds_no_callback() {
        let mut rig = rig(None);
        let pending = ask(&rig.host);
        raw(&mut rig.lines);
        rig.peer.shutdown(Shutdown::Both).unwrap();
        assert_eq!(pending.join().unwrap(), Err(CLOSED_MESSAGE.to_owned()));
        rig.host.close_within(LONG, LONG).unwrap();
        assert_eq!(rig.ended.load(Ordering::SeqCst), 1);
        rig.host.close_within(LONG, LONG).unwrap();
        assert_eq!(rig.ended.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn f5_replies_resolve_events_route_and_nothing_routes_after_close() {
        let mut rig = rig(marked());
        assert_eq!(raw(&mut rig.lines), OPEN);
        let pending = ask(&rig.host);
        let request: Value = serde_json::from_str(&raw(&mut rig.lines)).unwrap();
        assert_eq!(request["id"], 1);
        say(
            &rig.peer,
            "{\"type\":\"event\",\"data\":{\"type\":\"session.idle\"}}\n{\"type\":\"reply\",\"id\":1,\"data\":null}\n",
        );
        assert_eq!(pending.join().unwrap(), Ok(Value::Null));
        assert_eq!(
            *rig.events.lock().unwrap(),
            vec![("desktop:event", json!({ "type": "session.idle" }))]
        );
        let closing = closing(&rig.host);
        assert_eq!(raw(&mut rig.lines), CLOSED);
        say(
            &rig.peer,
            "{\"type\":\"event\",\"data\":{\"type\":\"session.idle\"}}\n",
        );
        rig.peer.shutdown(Shutdown::Write).unwrap();
        closing.join().unwrap().unwrap();
        assert_eq!(rig.events.lock().unwrap().len(), 1);
    }

    #[test]
    fn f6_malformed_or_unknown_worker_lines_end_the_reader_and_fail_pending() {
        for bad in ["not json\n", "{\"type\":\"surprise\"}\n"] {
            let mut rig = rig(None);
            let pending = ask(&rig.host);
            raw(&mut rig.lines);
            say(&rig.peer, bad);
            assert_eq!(pending.join().unwrap(), Err(CLOSED_MESSAGE.to_owned()));
            rig.host.close_within(LONG, LONG).unwrap();
            assert!(gone(&rig.host));
            assert_eq!(rig.ended.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn f7_a_dead_peer_fails_the_request_visibly_and_close_joins_finished_threads() {
        let Rig {
            host,
            peer,
            lines,
            ended,
            ..
        } = rig(None);
        drop(lines);
        drop(peer);
        let outcome = host.request(Operation::State, Value::Null);
        let message = outcome.unwrap_err();
        assert!(
            [
                CLOSED_MESSAGE,
                "The native client input closed. Restart the app.",
                "The native client is closed. Restart the app.",
            ]
            .contains(&message.as_str())
        );
        host.close_within(LONG, LONG).unwrap();
        assert!(gone(&host));
        assert_eq!(ended.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn f8a_without_control_only_request_bytes_flow_and_no_process_is_involved() {
        let mut rig = rig(None);
        let pending = ask(&rig.host);
        let request: Value = serde_json::from_str(&raw(&mut rig.lines)).unwrap();
        assert_eq!(
            request,
            json!({ "id": 1, "operation": "state", "input": null })
        );
        say(&rig.peer, "{\"type\":\"reply\",\"id\":1,\"data\":null}\n");
        assert_eq!(pending.join().unwrap(), Ok(Value::Null));
        let closing = closing(&rig.host);
        rig.peer.shutdown(Shutdown::Write).unwrap();
        closing.join().unwrap().unwrap();
        assert_eq!(raw(&mut rig.lines), "");

        let control = control_lines(Path::new("/synthetic/Resources")).unwrap();
        assert_eq!(control.open, OPEN.as_bytes());
        assert_eq!(control.closed, CLOSED.as_bytes());
    }

    #[test]
    fn f8b_the_child_lease_close_sequence_is_unchanged_with_a_subprocess() {
        let mut child = std::process::Command::new("/bin/cat")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let host =
            Host::attach(|_, _| true, stdin, stdout, Lease::Child(child), None, None).unwrap();
        host.close().unwrap();
        assert!(gone(&host));
        assert!(host.lease.lock().unwrap().is_none());
    }
}
