pub mod ledger;
pub mod memory;
pub mod paging;
pub mod queue;
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
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
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
    schema::{Finite, NonNegativeInt, PositiveInt},
    shell::{CreateInput, Id, Info, Status, Time},
};
#[derive(Clone, Debug)]
pub enum Event {
    Created(Box<Info>),
    Updated(Box<Info>),
    Exited(ycoding_schema::shell::ExitedData),
    Deleted(Id),
}
pub type EnqueueError = queue::Error;
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
    limits: queue::Limits,
}
struct Active {
    info: Mutex<Info>,
    file: PathBuf,
    size: AtomicUsize,
    control: OnceLock<Control>,
    done: Mutex<watch::Sender<Option<Settlement>>>,
    removing: AtomicBool,
    task: tokio::sync::Mutex<Option<JoinHandle<io::Result<()>>>>,
    cancelled: AtomicBool,
    lifecycle: tokio::sync::Mutex<()>,
    pending_timeout: Mutex<Option<u64>>,
    resident_bits: AtomicU64,
    peak_kib: AtomicU64,
    periodic: AtomicBool,
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
            cancelled: AtomicBool::new(false),
            lifecycle: tokio::sync::Mutex::new(()),
            pending_timeout: Mutex::new(None),
            resident_bits: AtomicU64::new(0),
            peak_kib: AtomicU64::new(0),
            periodic: AtomicBool::new(false),
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
    fn observe(&self, resident_kib: u64, periodic: bool) {
        self.resident_bits
            .store((resident_kib as f64 / 1024.0).to_bits(), Ordering::Release);
        self.peak_kib.fetch_max(resident_kib, Ordering::AcqRel);
        if periodic {
            self.periodic.store(true, Ordering::Release);
        }
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
    state_directory: PathBuf,
    queue: OnceLock<queue::Queue>,
    probe: Arc<dyn MemoryProbe>,
    quiet: Mutex<std::collections::HashSet<Id>>,
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
            state_directory: roots.state.clone(),
            queue: OnceLock::new(),
            probe: Arc::new(NativeProbe),
            quiet: Mutex::default(),
        })
    }
    pub fn with_queue(self, queue: queue::Queue) -> Self {
        let _ = self.queue.set(queue);
        self
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
                limits: queue_limits(config),
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
            queue_position: None,
            time: Time {
                started: Finite::new(super::now()).map_err(io::Error::other)?,
                queued: None,
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
            settle_session(
                &parts,
                &session,
                &mut process,
                stream,
                output,
                memory,
                false,
            )
            .await
        }));
        Ok(info)
    }
    pub async fn enqueue(
        &self,
        prepared: &mut Prepared,
        session_id: &str,
        admission: Option<Arc<dyn queue::Admission>>,
    ) -> Result<Info, EnqueueError> {
        let state = self.take(prepared)?;
        let queue = self.queue().await?;
        let id_text = super::identifier("sh_")?;
        let id =
            Id::decode(&JsonValue::String(id_text.clone().into())).map_err(io::Error::other)?;
        let file = self.output_directory.join(format!("{id_text}.out"));
        tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file)
            .await?;
        let cwd = state
            .process
            .cwd
            .clone()
            .unwrap_or_else(|| self.directory.clone());
        let command = state.input.command.to_utf8().map_err(io::Error::other)?;
        let metadata = state.input.metadata.clone().unwrap_or_default();
        let info = Info {
            id: id.clone(),
            status: Status::Queued,
            command: state.input.command.clone(),
            cwd: cwd.to_string_lossy().into_owned().into(),
            shell: state.shell.clone().into(),
            file: file.to_string_lossy().into_owned().into(),
            pid: None,
            exit: None,
            tool_call_id: tool_call_id(&metadata),
            metadata,
            queue_position: None,
            time: Time {
                started: Finite::new(super::now()).map_err(io::Error::other)?,
                queued: None,
                completed: None,
            },
        };
        if let Some(owner) = &self.ledger_owner
            && let Err(error) = self.ledger.record(&id, 0, None, owner).await
        {
            let _ = tokio::fs::remove_file(&file).await;
            return Err(io::Error::other(error).into());
        }
        let active = Active::new(info, file.clone());
        let resident = active.clone();
        let ticket = queue
            .enqueue(queue::Request {
                id: id_text,
                session_id: session_id.to_owned(),
                command: command.clone(),
                cwd: cwd.clone(),
                admission,
                memory_limit_mb: state.memory_limit_mb,
                resident_mb: Some(Arc::new(move || {
                    f64::from_bits(resident.resident_bits.load(Ordering::Acquire))
                })),
                limits: state.limits,
            })
            .await;
        let ticket = match ticket {
            Ok(ticket) => ticket,
            Err(error) => {
                let _ = self.ledger.release(&id).await;
                let _ = tokio::fs::remove_file(&file).await;
                return Err(error);
            }
        };
        let queued = {
            let mut info = active.info.lock().map_err(poison)?;
            info.queue_position =
                Some(PositiveInt::new(ticket.position() as i64).map_err(io::Error::other)?);
            info.clone()
        };
        self.state
            .lock()
            .map_err(poison)?
            .sessions
            .insert(id.clone(), active.clone());
        let parts = self.parts();
        parts.created(&queued)?;
        let task = tokio::spawn(run_queued(
            parts,
            active.clone(),
            state,
            command,
            cwd,
            queue,
            ticket,
        ));
        *active.task.lock().await = Some(task);
        Ok(queued)
    }
    async fn queue(&self) -> io::Result<queue::Queue> {
        if let Some(queue) = self.queue.get() {
            return Ok(queue.clone());
        }
        let opened = queue::Queue::open(queue::Options::new(
            self.state_directory.join("shell-queue"),
        ))
        .await?;
        Ok(self.queue.get_or_init(|| opened).clone())
    }
    pub async fn cancel_queued_quiet(&self, id: &Id) -> io::Result<bool> {
        self.quiet.lock().map_err(poison)?.insert(id.clone());
        let cancelled = self.cancel_queued(id).await;
        if !matches!(cancelled, Ok(true)) {
            self.quiet.lock().map_err(poison)?.remove(id);
        }
        cancelled
    }
    pub fn take_quiet(&self, id: &Id) -> bool {
        self.quiet.lock().is_ok_and(|mut quiet| quiet.remove(id))
    }
    pub async fn cancel_queued(&self, id: &Id) -> io::Result<bool> {
        let Ok(session) = self.require(id) else {
            return Ok(false);
        };
        self.cancel_queued_session(id, &session).await
    }
    async fn cancel_queued_session(&self, id: &Id, session: &Arc<Active>) -> io::Result<bool> {
        if session.status()? != Status::Queued {
            return Ok(false);
        }
        session.cancelled.store(true, Ordering::Release);
        let _lifecycle = session.lifecycle.lock().await;
        if session.status()? != Status::Queued {
            return Ok(false);
        }
        if let Some(task) = session.task.lock().await.take() {
            task.abort();
            let _ = task.await;
        }
        let killed = {
            let mut info = session.info.lock().map_err(poison)?;
            info.status = Status::Killed;
            info.queue_position = None;
            info.time.completed = Some(Finite::new(super::now()).map_err(io::Error::other)?);
            info.clone()
        };
        session.settle(Ok(killed));
        {
            let mut state = self.state.lock().map_err(poison)?;
            state.sessions.remove(id);
            state.exited.retain(|exited| exited != id);
        }
        self.ledger.release(id).await.map_err(io::Error::other)?;
        let _ = tokio::fs::remove_file(&session.file).await;
        self.parts().deleted(id)?;
        Ok(true)
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
    pub async fn wait(&self, id: &Id) -> io::Result<Info> {
        wait(self.require(id)?.as_ref()).await
    }
    pub async fn get(&self, id: &Id) -> io::Result<Info> {
        let session = self.require(id)?;
        let info = session.info.lock().map_err(poison)?.clone();
        if !matches!(info.status, Status::Running | Status::Queued) || session.settled() {
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
                (matches!(info.status, Status::Running | Status::Queued) && !session.settled())
                    .then(|| info.clone())
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
        if session.status()? == Status::Queued {
            *session.pending_timeout.lock().map_err(poison)? = Some(duration);
            if session.status()? == Status::Queued {
                return Ok(());
            }
            let Some(pending) = session.pending_timeout.lock().map_err(poison)?.take() else {
                return Ok(());
            };
            return session
                .control()?
                .set_timeout(Duration::from_millis(pending))
                .await;
        }
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
        if self.cancel_queued_session(id, &session).await? {
            return Ok(());
        }
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
            let id = session.info.lock().map_err(poison)?.id.clone();
            if session.status()? == Status::Queued {
                self.cancel_queued_session(&id, session).await?;
            }
        }
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
                matches!(
                    session.info.lock().map_err(poison)?.status,
                    Status::Running | Status::Queued
                ) && !session.settled()
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
                match session.info.lock().map(|info| info.status) {
                    Ok(Status::Running) => {
                        if let Some(control) = session.control.get() {
                            control.terminate_now();
                        }
                    }
                    Ok(Status::Queued) => {
                        session.cancelled.store(true, Ordering::Release);
                        if let Ok(task) = session.task.try_lock()
                            && let Some(task) = task.as_ref()
                        {
                            task.abort();
                        }
                    }
                    _ => {}
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
    sampled: bool,
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
        if memory.is_none() && !sampled {
            return std::future::pending::<io::Result<()>>().await;
        }
        let initial = match probe.sample(control.pid()).await {
            Ok(Some(initial)) => initial,
            Ok(None) => return std::future::pending::<io::Result<()>>().await,
            Err(error) if memory.is_some() => return Err(error),
            Err(_) => return std::future::pending::<io::Result<()>>().await,
        };
        session.observe(initial.1, false);
        let interval = Duration::from_millis(if memory.is_some() { 250 } else { 1_000 });
        loop {
            tokio::time::sleep(interval).await;
            match probe.sample(control.pid()).await {
                Ok(Some((current, resident))) if current == initial.0 => {
                    session.observe(resident, true);
                    if memory.is_some_and(|limit| resident > limit * 1024) {
                        return match control.terminate(Termination::MemoryLimit).await {
                            Ok(()) => Ok(()),
                            Err(_) => std::future::pending::<io::Result<()>>().await,
                        };
                    }
                }
                Ok(_) => {
                    session.resident_bits.store(0, Ordering::Release);
                    return std::future::pending::<io::Result<()>>().await;
                }
                Err(error) => {
                    session.resident_bits.store(0, Ordering::Release);
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
    fn updated(&self, info: &Info) -> io::Result<()> {
        self.event_source
            .emit(crate::event_feed::Data::ShellUpdated(Box::new(
                ycoding_schema::shell::UpdatedData { info: info.clone() },
            )))
            .map_err(io::Error::other)?;
        let _ = self.events.send(Event::Updated(Box::new(info.clone())));
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
    fn position(&self, session: &Active, position: usize) {
        let Ok(position) = PositiveInt::new(position as i64) else {
            return;
        };
        let updated = {
            let Ok(mut info) = session.info.lock() else {
                return;
            };
            if info.status != Status::Queued {
                return;
            }
            info.queue_position = Some(position);
            info.clone()
        };
        if let Err(error) = self.updated(&updated) {
            tracing::warn!(%error, "could not publish a shell queue position");
        }
    }
    async fn abandon(&self, session: &Active, error: io::Error) {
        let Ok(id) = session.info.lock().map(|info| info.id.clone()) else {
            return;
        };
        tracing::warn!(%error, "Queued shell command could not start");
        if let Some(state) = self.state.upgrade()
            && let Ok(mut state) = state.lock()
        {
            state.sessions.remove(&id);
            state.exited.retain(|exited| exited != &id);
        }
        let _ = self.ledger.release(&id).await;
        session.fail(&error);
        let _ = tokio::fs::remove_file(&session.file).await;
        let _ = self.deleted(&id);
    }
}
async fn settle_session(
    parts: &Parts,
    session: &Arc<Active>,
    process: &mut process::Process,
    stream: tokio::fs::File,
    output: tokio::sync::mpsc::Receiver<process::Chunk>,
    memory: Option<u64>,
    sampled: bool,
) -> io::Result<()> {
    let result = drive(
        session,
        process,
        stream,
        output,
        memory,
        &parts.probe,
        sampled,
    )
    .await;
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
async fn run_queued(
    parts: Parts,
    session: Arc<Active>,
    state: Preparation,
    command: String,
    cwd: PathBuf,
    queue: queue::Queue,
    mut ticket: queue::Ticket,
) -> io::Result<()> {
    if ticket
        .admitted(|position| parts.position(&session, position))
        .await
        .is_err()
    {
        parts
            .abandon(
                &session,
                io::Error::other("The shell queue entry was removed before it was admitted"),
            )
            .await;
        return Ok(());
    }
    let lifecycle = session.lifecycle.lock().await;
    if session.cancelled.load(Ordering::Acquire) {
        return Ok(());
    }
    let Preparation {
        process: spec,
        memory_limit_mb,
        limits,
        ..
    } = state;
    let id = session.info.lock().map_err(poison)?.id.clone();
    let stream = match tokio::fs::OpenOptions::new()
        .write(true)
        .open(&session.file)
        .await
    {
        Ok(stream) => stream,
        Err(error) => {
            parts.abandon(&session, error).await;
            return Ok(());
        }
    };
    let mut process = match process::spawn(spec).await {
        Ok(process) => process,
        Err(error) => {
            parts.abandon(&session, error).await;
            return Ok(());
        }
    };
    let Some(output) = process.take_output() else {
        let _ = process.terminate(Termination::Killed).await;
        let _ = process.wait().await;
        parts
            .abandon(&session, io::Error::other("Process output already taken"))
            .await;
        return Ok(());
    };
    if let Err(error) = parts
        .ledger
        .started(&id, process.pid(), process.leader_started())
        .await
    {
        drop(output);
        let _ = process.terminate(Termination::Killed).await;
        let _ = process.wait().await;
        parts.abandon(&session, io::Error::other(error)).await;
        return Ok(());
    }
    let _ = session.control.set(process.control());
    let started = {
        let mut info = session.info.lock().map_err(poison)?;
        info.status = Status::Running;
        info.queue_position = None;
        info.time.queued = Some(info.time.started);
        info.time.started = Finite::new(super::now()).map_err(io::Error::other)?;
        info.pid = Some(NonNegativeInt::new(i64::from(process.pid())).map_err(io::Error::other)?);
        info.clone()
    };
    let pending = session.pending_timeout.lock().map_err(poison)?.take();
    if let Some(duration) = pending {
        session
            .control()?
            .set_timeout(Duration::from_millis(duration))
            .await?;
    }
    if let Err(error) = parts.updated(&started) {
        tracing::warn!(%error, "could not publish a started queued shell");
    }
    drop(lifecycle);
    let result = settle_session(
        &parts,
        &session,
        &mut process,
        stream,
        output,
        memory_limit_mb,
        true,
    )
    .await;
    drop(ticket);
    let peak_kib = session.peak_kib.load(Ordering::Acquire);
    if peak_kib > 0 {
        let finished = session.info.lock().map_err(poison)?.clone();
        let peak = memory::Peak {
            command,
            cwd,
            memory_limit_mb,
            reserve_mb: limits.memory_reserve_mb,
            peak_mb: peak_kib as f64 / 1024.0,
            can_lower: finished.status == Status::Exited
                && finished.exit.is_some_and(|exit| exit.get() == 0.0)
                && session.periodic.load(Ordering::Acquire),
        };
        drop(tokio::task::spawn_blocking(move || {
            if let Err(error) = queue.record_peak(peak) {
                tracing::warn!(%error, "Shell memory peak could not be recorded");
            }
        }));
    }
    result
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
fn queue_limits(config: &Configuration) -> queue::Limits {
    let mut limits = queue::Limits::default();
    let Some(JsonValue::Object(object)) = config.latest("shell_queue") else {
        return limits;
    };
    let number = |key: &str| match object.get(&key.into()) {
        Some(JsonValue::Number(value)) if value.is_finite() => Some(*value),
        _ => None,
    };
    if let Some(value) = number("max_running").filter(|value| *value >= 1.0) {
        limits.max_running = value as usize;
    }
    if let Some(value) = number("max_running_per_session").filter(|value| *value >= 1.0) {
        limits.max_running_per_session = value as usize;
    }
    if let Some(value) = number("max_queued_per_session").filter(|value| *value >= 1.0) {
        limits.max_queued_per_session = value as usize;
    }
    if let Some(value) = number("memory_reserve_mb").filter(|value| *value >= 0.0) {
        limits.memory_reserve_mb = value as u64;
    }
    if let Some(value) = number("max_load").filter(|value| *value > 0.0) {
        limits.max_load = value;
    }
    limits
}
