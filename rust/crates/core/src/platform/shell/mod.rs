pub mod ledger;
pub mod paging;
pub mod select;
use super::{
    process::{
        self, Command, Control, GroupSystem, KillOptions, KillSignal, NativeGroupSystem,
        Termination,
    },
    sandbox::{Mode, Selection},
};
use crate::resources::config::{Configuration, Roots};
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    io,
    path::PathBuf,
    pin::Pin,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::AsyncWriteExt,
    sync::{broadcast, watch},
    task::JoinHandle,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue,
    schema::{Finite, NonNegativeInt},
    shell::{CreateInput, Id, Info, Status, Time},
};
#[derive(Clone, Debug)]
pub enum Event {
    Created(Box<Info>),
    Exited(ycoding_schema::shell::ExitedData),
    Deleted(Id),
}
pub type MemorySampleFuture<'a> =
    Pin<Box<dyn Future<Output = io::Result<Option<(String, u64)>>> + Send + 'a>>;
pub trait MemoryProbe: Send + Sync + std::fmt::Debug {
    fn sample(&self, pid: u32) -> MemorySampleFuture<'_>;
}
#[derive(Debug)]
struct NativeProbe;
impl MemoryProbe for NativeProbe {
    fn sample(&self, pid: u32) -> MemorySampleFuture<'_> {
        Box::pin(process::process_group_memory(pid))
    }
}
pub struct Prepared {
    pub warnings: Vec<String>,
    pub memory_limit_mb: Option<u64>,
    state: Option<Preparation>,
    owner: Arc<()>,
}
struct Preparation {
    process: Command,
    input: CreateInput,
    shell: String,
    memory_limit_mb: Option<u64>,
}
struct Active {
    info: Mutex<Info>,
    file: PathBuf,
    size: AtomicUsize,
    control: OnceLock<Control>,
    done: Mutex<watch::Sender<Option<Settlement>>>,
    removing: AtomicBool,
    task: tokio::sync::Mutex<Option<JoinHandle<io::Result<()>>>>,
    lifetime: Mutex<Option<Box<dyn Send>>>,
}
impl Active {
    fn new(info: Info, file: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            info: Mutex::new(info),
            file,
            size: AtomicUsize::new(0),
            control: OnceLock::new(),
            done: Mutex::new(watch::channel(None).0),
            removing: AtomicBool::new(false),
            task: tokio::sync::Mutex::new(None),
            lifetime: Mutex::new(None),
        })
    }
    fn control(&self) -> io::Result<&Control> {
        self.control
            .get()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Shell process has not started"))
    }
    fn status(&self) -> io::Result<Status> {
        Ok(self.info.lock().map_err(poison)?.status)
    }
    fn done(&self) -> std::sync::MutexGuard<'_, watch::Sender<Option<Settlement>>> {
        self.done
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    fn settled(&self) -> bool {
        self.done().borrow().is_some()
    }
    fn settle(&self, settlement: Settlement) -> bool {
        self.done().send_if_modified(|value| {
            if value.is_some() {
                return false;
            }
            *value = Some(settlement);
            true
        })
    }
    fn fail(&self, error: &io::Error) {
        let mut done = self.done();
        done.send_replace(Some(Err((error.kind(), error.to_string()))));
        *done = watch::channel(None).0;
    }
}
const TERMINATION: KillOptions = KillOptions {
    signal: KillSignal::Term,
    force_kill_after: Some(Duration::from_secs(3)),
};
struct State {
    sessions: HashMap<Id, Arc<Active>>,
    exited: VecDeque<Id>,
}
type Settlement = Result<Info, (io::ErrorKind, String)>;
pub struct Shell {
    pub event_source: crate::event_feed::EventSource,
    directory: PathBuf,
    output_directory: PathBuf,
    owner: Arc<()>,
    state: Arc<Mutex<State>>,
    events: broadcast::Sender<Event>,
    ledger: ledger::Ledger,
    ledger_owner: Option<ledger::Process>,
    selection: select::Options,
    system: Arc<dyn GroupSystem>,
    probe: Arc<dyn MemoryProbe>,
}
impl Shell {
    pub fn directory(&self) -> &std::path::Path {
        &self.directory
    }
    pub async fn new(
        roots: &Roots,
        directory: PathBuf,
        project: &str,
        store: ycoding_store::Client,
    ) -> io::Result<Self> {
        if project.is_empty()
            || PathBuf::from(project).components().count() != 1
            || matches!(project, "." | "..")
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid project identity",
            ));
        }
        let output_directory = roots.data.join("shell").join(project);
        tokio::fs::create_dir_all(&output_directory).await?;
        Ok(Self {
            event_source: Default::default(),
            directory,
            output_directory,
            owner: Arc::new(()),
            state: Arc::new(Mutex::new(State {
                sessions: HashMap::new(),
                exited: VecDeque::new(),
            })),
            events: broadcast::channel(128).0,
            ledger: ledger::Ledger::new(store),
            ledger_owner: ledger::identify(std::process::id()).await,
            selection: select::Options::default(),
            system: Arc::new(NativeGroupSystem),
            probe: Arc::new(NativeProbe),
        })
    }
    pub fn with_memory_probe(mut self, probe: Arc<dyn MemoryProbe>) -> Self {
        self.probe = probe;
        self
    }
    pub fn with_process_system(mut self, system: Arc<dyn GroupSystem>) -> Self {
        self.system = system;
        self
    }
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<Event> {
        self.events.subscribe()
    }
    pub fn with_shell_options(mut self, selection: select::Options) -> Self {
        self.selection = selection;
        self
    }
    pub fn prepare(&self, input: CreateInput, config: &Configuration) -> io::Result<Prepared> {
        let mut env: std::collections::BTreeMap<_, _> = std::env::vars().collect();
        let configured = config.latest("shell").and_then(|value| match value {
            JsonValue::String(value) => value.as_str(),
            _ => None,
        });
        let shell = select::preferred(configured, &env, &self.selection)
            .to_string_lossy()
            .into_owned();
        let memory_limit_mb = input
            .memory_limit_mb
            .map(|value| value.encode())
            .or_else(|| config.latest("shell_memory_limit_mb").cloned())
            .and_then(|value| match value {
                JsonValue::Number(value) => (value != 0.0).then_some(value as u64),
                _ => None,
            });
        if memory_limit_mb.is_some() && cfg!(windows) {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Shell process-tree memory limits are unavailable on Windows",
            ));
        }
        if let Some(memory) = memory_limit_mb {
            env.insert("GOMEMLIMIT".into(), format!("{memory}MiB"));
            env.insert(
                "NODE_OPTIONS".into(),
                format!(
                    "{}--max-old-space-size={memory}",
                    env.get("NODE_OPTIONS")
                        .map(|value| format!("{value} "))
                        .unwrap_or_default()
                ),
            );
        }
        env.insert("TERM".into(), "xterm-256color".into());
        env.insert("YCODING_TERMINAL".into(), "1".into());
        let mut command = Command::new(
            shell.clone(),
            select::args(&shell, &input.command.to_utf8().map_err(io::Error::other)?),
        );
        command.env = env;
        command.stdin = process::Input::Ignore;
        command.kill.force_kill_after = Some(Duration::from_secs(3));
        command.timeout = Duration::from_millis(input.timeout.get() as u64);
        command.cwd = Some(
            input
                .cwd
                .as_ref()
                .map(|cwd| cwd.to_utf8().map(PathBuf::from).map_err(io::Error::other))
                .transpose()?
                .unwrap_or_else(|| self.directory.clone()),
        );
        let mode = match config.latest("shell_sandbox") {
            Some(JsonValue::String(value)) if value.as_str() == Some("required") => Mode::Required,
            Some(JsonValue::String(value)) if value.as_str() == Some("optional") => Mode::Optional,
            _ => Mode::Disabled,
        };
        let mut selected = Selection::prepare(command, mode)?;
        selected.command.system = self.system.clone();
        selected.command.group_cleanup = true;
        Ok(Prepared {
            warnings: selected.warnings,
            memory_limit_mb,
            state: Some(Preparation {
                process: selected.command,
                input,
                shell,
                memory_limit_mb,
            }),
            owner: self.owner.clone(),
        })
    }
    fn take(&self, prepared: &mut Prepared) -> io::Result<Preparation> {
        if !Arc::ptr_eq(&self.owner, &prepared.owner) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid shell preparation capability",
            ));
        }
        prepared.state.take().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Shell preparation capability already consumed",
            )
        })
    }
    fn parts(&self) -> Parts {
        Parts {
            state: Arc::downgrade(&self.state),
            events: self.events.clone(),
            event_source: self.event_source.clone(),
            ledger: self.ledger.clone(),
            probe: self.probe.clone(),
        }
    }
    pub async fn create(&self, prepared: &mut Prepared) -> io::Result<Info> {
        let state = self.take(prepared)?;
        let id_text = super::identifier("sh_")?;
        let id =
            Id::decode(&JsonValue::String(id_text.clone().into())).map_err(io::Error::other)?;
        let file = self.output_directory.join(format!("{id_text}.out"));
        let stream = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file)
            .await?;
        let cwd = state
            .process
            .cwd
            .clone()
            .unwrap_or_else(|| self.directory.clone());
        let mut process = match process::spawn(state.process).await {
            Ok(process) => process,
            Err(error) => {
                drop(stream);
                tokio::fs::remove_file(&file).await?;
                return Err(error);
            }
        };
        let output = process
            .take_output()
            .ok_or_else(|| io::Error::other("Process output already taken"))?;
        if let Some(owner) = &self.ledger_owner
            && let Err(error) = self
                .ledger
                .record(&id, process.pid(), process.leader_started(), owner)
                .await
        {
            drop(output);
            process.terminate(Termination::Killed).await?;
            process.wait().await?;
            drop(stream);
            tokio::fs::remove_file(&file).await?;
            return Err(io::Error::other(error));
        }
        let metadata = state.input.metadata.unwrap_or_default();
        let mut info = Info {
            id: id.clone(),
            status: Status::Running,
            command: state.input.command,
            cwd: cwd.to_string_lossy().into_owned().into(),
            shell: state.shell.into(),
            file: file.to_string_lossy().into_owned().into(),
            pid: None,
            exit: None,
            tool_call_id: tool_call_id(&metadata),
            metadata,
            time: Time {
                started: Finite::new(super::now()).map_err(io::Error::other)?,
                completed: None,
            },
        };
        info.pid = Some(NonNegativeInt::new(i64::from(process.pid())).map_err(io::Error::other)?);
        let created = info.clone();
        let active = Active::new(info.clone(), file);
        let _ = active.control.set(process.control());
        self.state
            .lock()
            .map_err(poison)?
            .sessions
            .insert(id, active.clone());
        let parts = self.parts();
        parts.created(&created)?;
        let memory = state.memory_limit_mb;
        let session = active.clone();
        *active.task.lock().await = Some(tokio::spawn(async move {
            settle_session(&parts, &session, &mut process, stream, output, memory).await
        }));
        Ok(info)
    }
    fn require(&self, id: &Id) -> io::Result<Arc<Active>> {
        self.state
            .lock()
            .map_err(poison)?
            .sessions
            .get(id)
            .cloned()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Shell not found"))
    }
    pub(crate) fn retain_until_exit(&self, id: &Id, lease: impl Send + 'static) -> io::Result<()> {
        let session = self.require(id)?;
        let info = session.info.lock().map_err(poison)?;
        // A cleanup failure wakes waiters while the process may remain live.
        // Admission ownership follows confirmed process settlement, not that waiter.
        if info.status == Status::Running {
            let mut lifetime = session.lifetime.lock().map_err(poison)?;
            if lifetime.is_some() {
                return Err(io::Error::other("Shell lifetime lease already assigned"));
            }
            *lifetime = Some(Box::new(lease));
        }
        Ok(())
    }
    pub async fn wait(&self, id: &Id) -> io::Result<Info> {
        wait(self.require(id)?.as_ref()).await
    }
    pub async fn get(&self, id: &Id) -> io::Result<Info> {
        let session = self.require(id)?;
        let info = session.info.lock().map_err(poison)?.clone();
        if info.status != Status::Running || session.settled() {
            return wait(&session).await;
        }
        Ok(info)
    }
    pub fn list(&self) -> Vec<Info> {
        self.state
            .lock()
            .expect("shell state lock poisoned")
            .sessions
            .values()
            .filter_map(|session| {
                let info = session.info.lock().expect("shell info lock poisoned");
                (info.status == Status::Running && !session.settled()).then(|| info.clone())
            })
            .collect()
    }
    pub async fn output(&self, id: &Id, cursor: usize, limit: usize) -> io::Result<paging::Page> {
        let session = self.require(id)?;
        let settled = session.settled();
        let size = session.size.load(Ordering::Acquire);
        paging::read(&session.file, cursor, limit, size, settled).await
    }
    pub async fn timeout(&self, id: &Id, duration: u64) -> io::Result<()> {
        let session = self.require(id)?;
        if session.status()? != Status::Running {
            return Ok(());
        }
        session
            .control()?
            .set_timeout(Duration::from_millis(duration))
            .await
    }
    pub async fn remove(&self, id: &Id) -> io::Result<()> {
        let session = self.require(id)?;
        if session.info.lock().map_err(poison)?.status == Status::Running {
            session.removing.store(true, Ordering::Release);
            if let Err(error) = session.control()?.kill(TERMINATION).await {
                session.removing.store(false, Ordering::Release);
                session.fail(&error);
                return Err(error);
            }
            join(&session).await?;
            let killed = {
                let mut info = session.info.lock().map_err(poison)?;
                if info.status == Status::Running {
                    info.status = Status::Killed;
                    info.exit = None;
                    info.time.completed =
                        Some(Finite::new(super::now()).map_err(io::Error::other)?);
                }
                session.lifetime.lock().map_err(poison)?.take();
                info.clone()
            };
            session.settle(Ok(killed));
        } else {
            join(&session).await?;
        }
        {
            let mut state = self.state.lock().map_err(poison)?;
            if state.sessions.remove(id).is_none() {
                return Ok(());
            }
            state.exited.retain(|exited| exited != id);
        }
        self.ledger.release(id).await.map_err(io::Error::other)?;
        tokio::fs::remove_file(&session.file).await?;
        self.event_source
            .emit(crate::event_feed::Data::ShellDeleted(Box::new(
                ycoding_schema::shell::DeletedData { id: id.clone() },
            )))
            .map_err(io::Error::other)?;
        let _ = self.events.send(Event::Deleted(id.clone()));
        Ok(())
    }
    pub async fn shutdown(&self) -> io::Result<()> {
        let sessions = self
            .state
            .lock()
            .map_err(poison)?
            .sessions
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut failure = None;
        let mut settled = Vec::new();
        for session in &sessions {
            if session.status()? == Status::Killed && session.settled() {
                continue;
            }
            let running = session.info.lock().map_err(poison)?.status == Status::Running;
            if running && let Err(error) = session.control()?.kill(TERMINATION).await {
                session.fail(&error);
                failure.get_or_insert(error);
                continue;
            }
            settled.push(session);
        }
        for session in settled {
            if let Err(error) = join(session).await {
                failure.get_or_insert(error);
            }
        }
        if let Some(error) = failure {
            return Err(error);
        }
        self.state.lock().map_err(poison)?.sessions.clear();
        Ok(())
    }
    pub async fn notice_owed(
        &self,
        id: &Id,
        session_id: ycoding_schema::session_id::SessionId,
    ) -> io::Result<()> {
        self.ledger
            .notice_owed(id, session_id)
            .await
            .map_err(io::Error::other)
    }
    pub async fn notice_admitted(&self, id: &Id) -> io::Result<()> {
        let live = match self.require(id) {
            Ok(session) => {
                matches!(session.info.lock().map_err(poison)?.status, Status::Running)
                    && !session.settled()
            }
            Err(_) => false,
        };
        if live {
            return self
                .ledger
                .notice_cleared(id)
                .await
                .map_err(io::Error::other);
        }
        self.ledger
            .notice_admitted(id)
            .await
            .map_err(io::Error::other)
    }
}

impl Drop for Shell {
    fn drop(&mut self) {
        if let Ok(state) = self.state.lock() {
            for session in state.sessions.values() {
                if let Ok(Status::Running) = session.info.lock().map(|info| info.status)
                    && let Some(control) = session.control.get()
                {
                    control.terminate_now();
                }
            }
        }
    }
}
async fn wait(session: &Active) -> io::Result<Info> {
    let mut done = session.done().subscribe();
    loop {
        if let Some(result) = done.borrow().clone() {
            return result.map_err(|(kind, message)| io::Error::new(kind, message));
        }
        done.changed().await.map_err(io::Error::other)?;
    }
}
async fn join(session: &Active) -> io::Result<()> {
    if let Some(task) = session.task.lock().await.take() {
        task.await.map_err(io::Error::other)??;
    }
    Ok(())
}
async fn drive(
    session: &Active,
    process: &mut process::Process,
    mut file: tokio::fs::File,
    mut output: tokio::sync::mpsc::Receiver<process::Chunk>,
    memory: Option<u64>,
    probe: &Arc<dyn MemoryProbe>,
) -> io::Result<Option<Info>> {
    let control = process.control();
    let capture = async {
        let mut failure = None;
        while let Some(chunk) = output.recv().await {
            if failure.is_some() {
                continue;
            }
            match file.write_all(&chunk.bytes).await {
                Ok(()) => {
                    session.size.fetch_add(chunk.bytes.len(), Ordering::Release);
                }
                Err(error) => {
                    failure = Some(error);
                    let _ = control.terminate(Termination::Killed).await;
                }
            }
        }
        if let Some(error) = failure {
            return Err(error);
        }
        file.flush().await
    };
    let monitor = async {
        if memory.is_none() {
            return std::future::pending::<io::Result<()>>().await;
        }
        let initial = match probe.sample(control.pid()).await {
            Ok(Some(initial)) => initial,
            Ok(None) => return std::future::pending::<io::Result<()>>().await,
            Err(error) if memory.is_some() => return Err(error),
            Err(_) => return std::future::pending::<io::Result<()>>().await,
        };
        let interval = Duration::from_millis(250);
        loop {
            tokio::time::sleep(interval).await;
            match probe.sample(control.pid()).await {
                Ok(Some((current, resident))) if current == initial.0 => {
                    if memory.is_some_and(|limit| resident > limit * 1024) {
                        return match control.terminate(Termination::MemoryLimit).await {
                            Ok(()) => Ok(()),
                            Err(_) => std::future::pending::<io::Result<()>>().await,
                        };
                    }
                }
                Ok(_) => {
                    return std::future::pending::<io::Result<()>>().await;
                }
                Err(error) => {
                    if memory.is_none() {
                        return std::future::pending::<io::Result<()>>().await;
                    }
                    return match control.terminate(Termination::MemoryLimit).await {
                        Ok(()) => Err(error),
                        Err(_) => std::future::pending::<io::Result<()>>().await,
                    };
                }
            }
        }
    };
    let settle = async {
        tokio::pin!(monitor);
        tokio::select! {
            exit = process.wait() => exit,
            monitored = &mut monitor => {
                if let Err(error) = monitored { process.wait().await?; return Err(error); }
                process.wait().await
            }
        }
    };
    let mut failures = control.teardown();
    let joined = async { tokio::join!(settle, capture) };
    tokio::pin!(joined);
    let mut watching = true;
    let (exit, capture) = loop {
        tokio::select! {
            done = &mut joined => break done,
            changed = failures.changed(), if watching => match changed {
                Ok(()) => {
                    let failure = failures.borrow_and_update().failure.clone();
                    if let Some((kind, message)) = failure {
                        session.fail(&io::Error::new(kind, message));
                    }
                }
                Err(_) => watching = false,
            },
        }
    };
    let exit = exit?;
    capture?;
    if session.removing.load(Ordering::Acquire) {
        return Ok(None);
    }
    let mut info = session.info.lock().map_err(poison)?;
    info.status = match exit.reason {
        Termination::Exit => Status::Exited,
        Termination::Timeout => Status::Timeout,
        Termination::MemoryLimit => Status::MemoryLimit,
        Termination::Cancelled | Termination::Killed => Status::Killed,
    };
    info.exit = (exit.reason == Termination::Exit)
        .then_some(exit.code)
        .flatten()
        .map(|code| Finite::new(f64::from(code)).map_err(io::Error::other))
        .transpose()?;
    info.time.completed = Some(Finite::new(super::now()).map_err(io::Error::other)?);
    session.lifetime.lock().map_err(poison)?.take();
    Ok(Some(info.clone()))
}
fn poison<T>(_: std::sync::PoisonError<T>) -> io::Error {
    io::Error::other("Shell state lock poisoned")
}
#[derive(Clone)]
struct Parts {
    state: std::sync::Weak<Mutex<State>>,
    events: broadcast::Sender<Event>,
    event_source: crate::event_feed::EventSource,
    ledger: ledger::Ledger,
    probe: Arc<dyn MemoryProbe>,
}
impl Parts {
    fn created(&self, info: &Info) -> io::Result<()> {
        self.event_source
            .emit(crate::event_feed::Data::ShellCreated(Box::new(
                ycoding_schema::shell::CreatedData { info: info.clone() },
            )))
            .map_err(io::Error::other)?;
        let _ = self.events.send(Event::Created(Box::new(info.clone())));
        Ok(())
    }
    fn deleted(&self, id: &Id) -> io::Result<()> {
        self.event_source
            .emit(crate::event_feed::Data::ShellDeleted(Box::new(
                ycoding_schema::shell::DeletedData { id: id.clone() },
            )))
            .map_err(io::Error::other)?;
        let _ = self.events.send(Event::Deleted(id.clone()));
        Ok(())
    }
}
async fn settle_session(
    parts: &Parts,
    session: &Arc<Active>,
    process: &mut process::Process,
    stream: tokio::fs::File,
    output: tokio::sync::mpsc::Receiver<process::Chunk>,
    memory: Option<u64>,
) -> io::Result<()> {
    let result = drive(session, process, stream, output, memory, &parts.probe).await;
    match result {
        Ok(None) => Ok(()),
        Ok(Some(info)) => {
            if !session.settle(Ok(info.clone())) {
                return Ok(());
            }
            let exited = ycoding_schema::shell::ExitedData {
                id: info.id.clone(),
                exit: info.exit,
                status: info.status,
            };
            parts
                .event_source
                .emit(crate::event_feed::Data::ShellExited(Box::new(
                    exited.clone(),
                )))
                .map_err(io::Error::other)?;
            let _ = parts.events.send(Event::Exited(exited));
            let evicted = if let Some(state) = parts.state.upgrade() {
                let mut state = state.lock().map_err(poison)?;
                state.exited.push_back(info.id);
                if state.exited.len() > 25 {
                    let oldest = state.exited.pop_front().expect("exited retention exceeded");
                    state.sessions.remove(&oldest)
                } else {
                    None
                }
            } else {
                None
            };
            if let Some(evicted) = evicted {
                let id = evicted.info.lock().map_err(poison)?.id.clone();
                parts.ledger.release(&id).await.map_err(io::Error::other)?;
                tokio::fs::remove_file(&evicted.file).await?;
                parts.deleted(&id)?;
            }
            Ok(())
        }
        Err(error) => {
            session.removing.store(false, Ordering::Release);
            session.fail(&error);
            Err(error)
        }
    }
}
fn tool_call_id(
    metadata: &ycoding_schema::shell::Metadata,
) -> Option<ycoding_schema::LosslessString> {
    metadata
        .get(&"toolCallID".into())
        .and_then(|value| match value {
            JsonValue::String(value) if !value.is_empty() => Some(value.clone()),
            _ => None,
        })
}
