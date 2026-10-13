pub mod ledger;
pub mod paging;
pub mod select;
use super::{
    process::{self, Command, Control, Termination},
    sandbox::{Mode, Selection},
};
use crate::resources::config::{Configuration, Roots};
use std::{
    collections::{HashMap, VecDeque},
    io,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
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
    control: Control,
    done: watch::Sender<Option<Settlement>>,
    task: tokio::sync::Mutex<Option<JoinHandle<io::Result<()>>>>,
}
struct State {
    sessions: HashMap<Id, Arc<Active>>,
    exited: VecDeque<Id>,
}
type Settlement = Result<Info, (io::ErrorKind, String)>;
pub struct Shell {
    directory: PathBuf,
    output_directory: PathBuf,
    owner: Arc<()>,
    state: Arc<Mutex<State>>,
    events: broadcast::Sender<Event>,
    ledger: ledger::Ledger,
    ledger_owner: Option<ledger::Process>,
    selection: select::Options,
}
impl Shell {
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
        })
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
        let selected = Selection::prepare(command, mode)?;
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
    pub async fn create(&self, prepared: &mut Prepared) -> io::Result<Info> {
        if !Arc::ptr_eq(&self.owner, &prepared.owner) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid shell preparation capability",
            ));
        }
        let state = prepared.state.take().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Shell preparation capability already consumed",
            )
        })?;
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
        if let Some(owner) = &self.ledger_owner {
            let started = ledger::identify(process.pid())
                .await
                .map(|identity| identity.started);
            if let Err(error) = self.ledger.record(&id, process.pid(), started, owner).await {
                drop(output);
                process.terminate(Termination::Killed).await?;
                process.wait().await?;
                drop(stream);
                tokio::fs::remove_file(&file).await?;
                return Err(io::Error::other(error));
            }
        }
        let metadata = state.input.metadata.unwrap_or_default();
        let info = Info {
            id: id.clone(),
            status: Status::Running,
            command: state.input.command,
            cwd: cwd.to_string_lossy().into_owned().into(),
            shell: state.shell.into(),
            file: file.to_string_lossy().into_owned().into(),
            pid: None,
            exit: None,
            tool_call_id: metadata
                .get(&"toolCallID".into())
                .and_then(|value| match value {
                    JsonValue::String(value) if !value.is_empty() => Some(value.clone()),
                    _ => None,
                }),
            metadata,
            time: Time {
                started: Finite::new(super::now()).map_err(io::Error::other)?,
                completed: None,
            },
        };
        let created = info.clone();
        let mut info = info;
        info.pid = Some(NonNegativeInt::new(i64::from(process.pid())).map_err(io::Error::other)?);
        let active = Arc::new(Active {
            info: Mutex::new(info.clone()),
            file,
            size: AtomicUsize::new(0),
            control: process.control(),
            done: watch::channel(None).0,
            task: tokio::sync::Mutex::new(None),
        });
        self.state
            .lock()
            .map_err(poison)?
            .sessions
            .insert(id, active.clone());
        let _ = self.events.send(Event::Created(Box::new(created)));
        let weak = Arc::downgrade(&self.state);
        let events = self.events.clone();
        let memory = state.memory_limit_mb;
        let session = active.clone();
        let ledger = self.ledger.clone();
        *active.task.lock().await = Some(tokio::spawn(async move {
            let result = drive(&session, &mut process, stream, output, memory).await;
            match result {
                Ok(info) => {
                    let settled = session.done.send_if_modified(|value| {
                        if value.is_some() {
                            return false;
                        }
                        *value = Some(Ok(info.clone()));
                        true
                    });
                    if !settled {
                        return Ok(());
                    }
                    let _ = events.send(Event::Exited(ycoding_schema::shell::ExitedData {
                        id: info.id.clone(),
                        exit: info.exit,
                        status: info.status,
                    }));
                    let evicted = if let Some(state) = weak.upgrade() {
                        let mut state = state.lock().map_err(poison)?;
                        state.exited.push_back(info.id);
                        if state.exited.len() > 25 {
                            let oldest =
                                state.exited.pop_front().expect("exited retention exceeded");
                            state.sessions.remove(&oldest)
                        } else {
                            None
                        }
                    } else {
                        None
                    };
                    if let Some(evicted) = evicted {
                        let id = evicted.info.lock().map_err(poison)?.id.clone();
                        ledger.release(&id).await.map_err(io::Error::other)?;
                        tokio::fs::remove_file(&evicted.file).await?;
                        let _ = events.send(Event::Deleted(
                            evicted.info.lock().map_err(poison)?.id.clone(),
                        ));
                    }
                    Ok(())
                }
                Err(error) => {
                    session.done.send_if_modified(|value| {
                        if value.is_some() {
                            return false;
                        }
                        *value = Some(Err((error.kind(), error.to_string())));
                        true
                    });
                    Err(error)
                }
            }
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
    pub async fn wait(&self, id: &Id) -> io::Result<Info> {
        wait(self.require(id)?.as_ref()).await
    }
    pub async fn get(&self, id: &Id) -> io::Result<Info> {
        let session = self.require(id)?;
        let info = session.info.lock().map_err(poison)?.clone();
        if info.status != Status::Running || session.done.borrow().is_some() {
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
                (info.status == Status::Running && session.done.borrow().is_none())
                    .then(|| info.clone())
            })
            .collect()
    }
    pub async fn output(&self, id: &Id, cursor: usize, limit: usize) -> io::Result<paging::Page> {
        let session = self.require(id)?;
        let settled = session.done.borrow().is_some();
        let size = session.size.load(Ordering::Acquire);
        paging::read(&session.file, cursor, limit, size, settled).await
    }
    pub async fn timeout(&self, id: &Id, duration: u64) -> io::Result<()> {
        let session = self.require(id)?;
        if session.info.lock().map_err(poison)?.status != Status::Running {
            return Ok(());
        }
        session
            .control
            .set_timeout(Duration::from_millis(duration))
            .await
    }
    pub async fn remove(&self, id: &Id) -> io::Result<()> {
        let session = self.require(id)?;
        self.ledger.release(id).await.map_err(io::Error::other)?;
        session.done.send_if_modified(|value| {
            if value.is_some() {
                return false;
            }
            *value = Some(Err((io::ErrorKind::NotFound, "Shell removed".into())));
            true
        });
        {
            let mut state = self.state.lock().map_err(poison)?;
            state.sessions.remove(id);
            state.exited.retain(|exited| exited != id);
        }
        if session.info.lock().map_err(poison)?.status == Status::Running {
            session.control.terminate(Termination::Killed).await?;
        }
        join(&session).await?;
        tokio::fs::remove_file(&session.file).await?;
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
        for session in &sessions {
            if session.info.lock().map_err(poison)?.status == Status::Running {
                session.control.terminate(Termination::Killed).await?;
            }
        }
        for session in &sessions {
            join(session).await?;
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
                if session
                    .info
                    .lock()
                    .is_ok_and(|info| info.status == Status::Running)
                {
                    session.control.terminate_now();
                }
            }
        }
    }
}
async fn wait(session: &Active) -> io::Result<Info> {
    let mut done = session.done.subscribe();
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
) -> io::Result<Info> {
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
                    control.terminate(Termination::Killed).await?;
                }
            }
        }
        if let Some(error) = failure {
            return Err(error);
        }
        file.flush().await
    };
    let monitor = async {
        let Some(limit) = memory else {
            return std::future::pending::<io::Result<()>>().await;
        };
        let Some((identity, _)) = process::process_group_memory(control.pid()).await? else {
            return std::future::pending::<io::Result<()>>().await;
        };
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            match process::process_group_memory(control.pid()).await {
                Ok(Some((current, resident))) if current == identity => {
                    if resident > limit * 1024 {
                        control.terminate(Termination::MemoryLimit).await?;
                        return Ok(());
                    }
                }
                Ok(_) => return std::future::pending::<io::Result<()>>().await,
                Err(error) => {
                    control.terminate(Termination::MemoryLimit).await?;
                    return Err(error);
                }
            }
        }
    };
    let settle = async {
        tokio::pin!(monitor);
        tokio::select! {
            exit = process.wait() => exit,
            monitored = &mut monitor => {
                if let Err(error) = monitored { control.terminate(Termination::MemoryLimit).await?; process.wait().await?; return Err(error); }
                process.wait().await
            }
        }
    };
    let (exit, capture) = tokio::join!(settle, capture);
    let exit = exit?;
    capture?;
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
    Ok(info.clone())
}
fn poison<T>(_: std::sync::PoisonError<T>) -> io::Error {
    io::Error::other("Shell state lock poisoned")
}
