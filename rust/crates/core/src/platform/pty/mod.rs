use crate::resources::config::Configuration;
use std::{
    collections::{HashMap, VecDeque},
    io,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{Notify, broadcast, mpsc, oneshot, watch},
    task::JoinHandle,
};
use ycoding_schema::{
    DomainDecode, JsonValue,
    pty::{
        self, Access, Actor, ControlInput, ControlOwner, CreateInput, Id, Info, Status, UpdateInput,
    },
    schema::{NonNegativeInt, PositiveInt},
    session_id::SessionId,
};
pub mod protocol;
pub mod ticket;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(unix)]
use unix::{Native, Terminal};
#[cfg(windows)]
use windows::{Native, Terminal};
#[derive(Clone, Debug)]
pub struct OutputChunk {
    pub generation: u64,
    pub start_offset: u64,
    pub end_offset: u64,
    pub data: Vec<u8>,
}
#[derive(Clone, Debug)]
pub struct EndEvent {
    pub generation: u64,
    pub reason: String,
    pub exit_code: Option<i32>,
}
#[derive(Clone, Debug)]
pub enum Delivery {
    Chunk(OutputChunk),
    End(EndEvent),
}
pub struct Replay {
    pub generation: u64,
    pub start_offset: u64,
    pub end_offset: u64,
    pub gap: bool,
    pub data: Vec<u8>,
}
struct Subscriber {
    active: bool,
    detached: bool,
    pending: VecDeque<OutputChunk>,
    bytes: usize,
    end: Option<EndEvent>,
}
struct Subscription {
    state: Mutex<Subscriber>,
    notify: Notify,
}
pub struct Attachment {
    pub replay: Replay,
    subscriber: Arc<Subscription>,
    session: Arc<Active>,
    access: Access,
    generation: Option<u64>,
    fence: Option<u64>,
    token: String,
}
impl Attachment {
    pub fn activate(&mut self) {
        self.subscriber
            .state
            .lock()
            .expect("subscriber lock poisoned")
            .active = true;
        self.subscriber.notify.notify_one();
    }
    pub async fn recv(&mut self) -> io::Result<Delivery> {
        loop {
            let notified = self.subscriber.notify.notified();
            {
                let mut state = self.subscriber.state.lock().map_err(poison)?;
                if state.active {
                    if let Some(chunk) = state.pending.pop_front() {
                        state.bytes -= chunk.data.len();
                        return Ok(Delivery::Chunk(chunk));
                    }
                    if let Some(end) = state.end.take() {
                        state.detached = true;
                        return Ok(Delivery::End(end));
                    }
                }
                if state.detached {
                    return Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "PTY attachment detached",
                    ));
                }
            }
            notified.await;
        }
    }
    pub async fn write(&self, data: &str) -> io::Result<bool> {
        if self.access != Access::Control || data.len() > pty::MAX_INPUT_BYTES as usize {
            return Ok(false);
        }
        let valid = {
            let state = self.session.state.lock().map_err(poison)?;
            valid_fence(
                &state.info,
                self.generation.unwrap_or(0),
                self.fence.unwrap_or(0),
                Actor::User,
            ) && state.info.status == Status::Running
        };
        if !valid {
            return Ok(false);
        }
        write(
            &self.session,
            self.generation.unwrap_or(0),
            self.fence.unwrap_or(0),
            Actor::User,
            data,
        )
        .await?;
        Ok(true)
    }
    pub fn detach(&self) {
        if let Ok(mut state) = self.subscriber.state.lock() {
            state.detached = true;
            state.pending.clear();
            state.end = None;
        }
        if let Ok(mut state) = self.session.state.lock() {
            state.subscribers.remove(&self.token);
        }
        self.subscriber.notify.notify_one();
    }
}
impl Drop for Attachment {
    fn drop(&mut self) {
        self.detach();
    }
}
enum Request {
    Write {
        generation: u64,
        fence: u64,
        actor: Actor,
        bytes: Vec<u8>,
        reply: oneshot::Sender<io::Result<()>>,
    },
    Kill(&'static str),
}
struct ActiveState {
    info: Info,
    retained: VecDeque<u8>,
    subscribers: HashMap<String, Arc<Subscription>>,
}
struct Active {
    state: Mutex<ActiveState>,
    terminal: Arc<Terminal>,
    control: mpsc::Sender<Request>,
    abandon: Notify,
    done: watch::Sender<Option<Result<Info, String>>>,
    task: tokio::sync::Mutex<Option<JoinHandle<io::Result<()>>>>,
}
struct State {
    sessions: HashMap<Id, Arc<Active>>,
    exited: VecDeque<Id>,
}
#[derive(Clone, Debug)]
pub enum Event {
    Created(Info),
    Updated(Info),
    Exited(pty::ExitedData),
    Deleted(Id),
}
pub struct Pty {
    pub event_source: crate::event_feed::EventSource,
    directory: PathBuf,
    state: Arc<Mutex<State>>,
    events: broadcast::Sender<Event>,
    selection: super::shell::select::Options,
    creating: tokio::sync::Mutex<()>,
}
impl Pty {
    pub fn directory(&self) -> &std::path::Path {
        &self.directory
    }
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            event_source: Default::default(),
            state: Arc::new(Mutex::new(State {
                sessions: HashMap::new(),
                exited: VecDeque::new(),
            })),
            events: broadcast::channel(128).0,
            selection: super::shell::select::Options::default(),
            creating: tokio::sync::Mutex::new(()),
        }
    }
    pub fn with_shell_options(mut self, selection: super::shell::select::Options) -> Self {
        self.selection = selection;
        self
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }
    pub async fn create(
        &self,
        input: CreateInput,
        config: Option<&Configuration>,
    ) -> io::Result<Info> {
        let _creating = self.creating.lock().await;
        let (info, session, native, requests) = {
            {
                let state = self.state.lock().map_err(poison)?;
                if state
                    .sessions
                    .values()
                    .filter(|session| {
                        session
                            .state
                            .lock()
                            .is_ok_and(|state| state.info.status == Status::Running)
                    })
                    .count()
                    >= pty::MAX_ACTIVE
                {
                    return Err(limit("active"));
                }
            }
            let mut env: std::collections::BTreeMap<_, _> = std::env::vars().collect();
            let command = input
                .command
                .filter(|command| !command.is_empty())
                .map(|command| command.to_utf8().map_err(io::Error::other))
                .transpose()?
                .unwrap_or_else(|| {
                    let configured =
                        config
                            .and_then(|config| config.latest("shell"))
                            .and_then(|value| match value {
                                JsonValue::String(value) => value.as_str(),
                                _ => None,
                            });
                    super::shell::select::preferred(configured, &env, &self.selection)
                        .to_string_lossy()
                        .into_owned()
                });
            let mut args = input
                .args
                .unwrap_or_default()
                .into_iter()
                .map(|arg| arg.to_utf8().map_err(io::Error::other))
                .collect::<io::Result<Vec<_>>>()?;
            if super::shell::select::login(&command) {
                args.push("-l".into());
            }
            if let Some(values) = input.env {
                for (key, value) in values.iter() {
                    let JsonValue::String(value) = value else {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidInput,
                            "PTY environment must contain strings",
                        ));
                    };
                    env.insert(
                        key.to_utf8().map_err(io::Error::other)?,
                        value.to_utf8().map_err(io::Error::other)?,
                    );
                }
            }
            env.insert("TERM".into(), "xterm-256color".into());
            env.insert("YCODING_TERMINAL".into(), "1".into());
            #[cfg(windows)]
            for key in ["LC_ALL", "LC_CTYPE", "LANG"] {
                env.insert(key.into(), "C.UTF-8".into());
            }
            let cwd = input
                .cwd
                .filter(|cwd| !cwd.is_empty())
                .map(|cwd| cwd.to_utf8().map(PathBuf::from).map_err(io::Error::other))
                .transpose()?
                .unwrap_or_else(|| self.directory.clone());
            let size = input.size.unwrap_or(pty::Size {
                rows: PositiveInt::new(24).map_err(io::Error::other)?,
                cols: PositiveInt::new(80).map_err(io::Error::other)?,
            });
            let mut process_command = super::process::Command::new(command.clone(), args.clone());
            process_command.env = env;
            process_command.cwd = Some(cwd.clone());
            #[cfg(unix)]
            let native = unix::spawn(
                process_command,
                size.cols.get() as u16,
                size.rows.get() as u16,
            )
            .await?;
            #[cfg(windows)]
            let native = windows::spawn(
                process_command,
                size.cols.get() as u16,
                size.rows.get() as u16,
            )?;
            let id_text = super::identifier("pty")?;
            let info = Info {
                id: Id::decode(&JsonValue::String(id_text.clone().into()))
                    .map_err(io::Error::other)?,
                title: input
                    .title
                    .filter(|title| !title.is_empty())
                    .unwrap_or_else(|| {
                        format!("Terminal {}", &id_text[id_text.len() - 4..]).into()
                    }),
                command: command.into(),
                args: args.into_iter().map(Into::into).collect(),
                cwd: cwd.to_string_lossy().into_owned().into(),
                session_id: input.session_id,
                status: Status::Running,
                pid: NonNegativeInt::new(i64::from(native.pid)).map_err(io::Error::other)?,
                exit_code: None,
                exit_reason: None,
                generation: PositiveInt::new(1).map_err(io::Error::other)?,
                size,
                control: pty::Control {
                    owner: ControlOwner::Agent,
                    fence: PositiveInt::new(1).map_err(io::Error::other)?,
                },
                output: pty::Output {
                    start_offset: NonNegativeInt::new(0).map_err(io::Error::other)?,
                    end_offset: NonNegativeInt::new(0).map_err(io::Error::other)?,
                    truncated: false,
                },
                limits: pty::Limits {
                    max_runtime_seconds: input.max_runtime_seconds.unwrap_or(
                        PositiveInt::new(pty::DEFAULT_RUNTIME_SECONDS).map_err(io::Error::other)?,
                    ),
                    max_retained_bytes: input.max_retained_bytes.unwrap_or(
                        PositiveInt::new(pty::MAX_RETAINED_BYTES).map_err(io::Error::other)?,
                    ),
                    max_input_bytes: PositiveInt::new(pty::MAX_INPUT_BYTES)
                        .map_err(io::Error::other)?,
                },
            };
            let (control, requests) = mpsc::channel(16);
            let session = Arc::new(Active {
                state: Mutex::new(ActiveState {
                    info: info.clone(),
                    retained: VecDeque::new(),
                    subscribers: HashMap::new(),
                }),
                terminal: native.terminal.clone(),
                control,
                abandon: Notify::new(),
                done: watch::channel(None).0,
                task: tokio::sync::Mutex::new(None),
            });
            let mut state = self.state.lock().map_err(poison)?;
            state.sessions.insert(info.id.clone(), session.clone());
            (info, session, native, requests)
        };
        self.event_source
            .emit(crate::event_feed::Data::PtyCreated(Box::new(
                pty::InfoData { info: info.clone() },
            )))
            .map_err(io::Error::other)?;
        let _ = self.events.send(Event::Created(info.clone()));
        let weak = Arc::downgrade(&self.state);
        let events = self.events.clone();
        let event_source = self.event_source.clone();
        let active = session.clone();
        *session.task.lock().await = Some(tokio::spawn(async move {
            let result = drive(&active, native, requests).await;
            match result {
                Ok(info) => {
                    active.done.send_replace(Some(Ok(info.clone())));
                    if info.exit_reason != Some(pty::ExitReason::Terminated) {
                        let exited = pty::ExitedData {
                            id: info.id.clone(),
                            exit_code: info.exit_code.expect("terminal PTY has an exit code"),
                            reason: if info.exit_reason == Some(pty::ExitReason::Timeout) {
                                pty::ExitEventReason::Timeout
                            } else {
                                pty::ExitEventReason::Exit
                            },
                        };
                        event_source
                            .emit(crate::event_feed::Data::PtyExited(Box::new(exited.clone())))
                            .map_err(io::Error::other)?;
                        let _ = events.send(Event::Exited(exited));
                    }
                    if let Some(state) = weak.upgrade() {
                        let evicted = {
                            let mut state = state.lock().map_err(poison)?;
                            state.exited.push_back(info.id);
                            if state.exited.len() > 25 {
                                let id = state.exited.pop_front().expect("PTY retention exceeded");
                                state.sessions.remove(&id)
                            } else {
                                None
                            }
                        };
                        if let Some(evicted) = evicted {
                            event_source
                                .emit(crate::event_feed::Data::PtyDeleted(Box::new(
                                    pty::DeletedData {
                                        id: evicted.state.lock().map_err(poison)?.info.id.clone(),
                                    },
                                )))
                                .map_err(io::Error::other)?;
                            let _ = events.send(Event::Deleted(
                                evicted.state.lock().map_err(poison)?.info.id.clone(),
                            ));
                        }
                    }
                    Ok(())
                }
                Err(error) => {
                    active.done.send_replace(Some(Err(error.to_string())));
                    Err(error)
                }
            }
        }));
        Ok(info)
    }
    fn owned(&self, id: &Id, owner: &SessionId) -> io::Result<Arc<Active>> {
        let session = self
            .state
            .lock()
            .map_err(poison)?
            .sessions
            .get(id)
            .cloned()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "PTY not found"))?;
        if session.state.lock().map_err(poison)?.info.session_id != *owner {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "PTY ownership mismatch",
            ));
        }
        Ok(session)
    }
    pub fn get(&self, id: &Id, owner: &SessionId) -> io::Result<Info> {
        Ok(self
            .owned(id, owner)?
            .state
            .lock()
            .map_err(poison)?
            .info
            .clone())
    }
    pub fn list(&self, owner: &SessionId) -> io::Result<Vec<Info>> {
        self.state
            .lock()
            .map_err(poison)?
            .sessions
            .values()
            .map(|session| {
                session
                    .state
                    .lock()
                    .map(|state| state.info.clone())
                    .map_err(poison)
            })
            .collect::<io::Result<Vec<_>>>()
            .map(|sessions| {
                sessions
                    .into_iter()
                    .filter(|info| info.session_id == *owner)
                    .collect()
            })
    }
    pub fn attach(
        &self,
        id: &Id,
        owner: &SessionId,
        generation: Option<u64>,
        offset: u64,
        access: Access,
        fence: Option<u64>,
    ) -> io::Result<Attachment> {
        let session = self.owned(id, owner)?;
        let mut state = session.state.lock().map_err(poison)?;
        if state.info.status != Status::Running {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "PTY exited"));
        }
        if state.subscribers.len() >= pty::MAX_ATTACHMENTS {
            return Err(limit("attachments"));
        }
        if access == Access::Control
            && !valid_fence(
                &state.info,
                generation.unwrap_or(0),
                fence.unwrap_or(0),
                Actor::User,
            )
        {
            return Err(fence_error());
        }
        let start = state.info.output.start_offset.get() as u64;
        let end = state.info.output.end_offset.get() as u64;
        let gap = generation
            .is_some_and(|generation| generation != state.info.generation.get() as u64)
            || offset < start
            || offset > end;
        let replay = Replay {
            generation: state.info.generation.get() as u64,
            start_offset: if gap { start } else { offset },
            end_offset: end,
            gap,
            data: if gap {
                Vec::new()
            } else {
                state
                    .retained
                    .iter()
                    .skip((offset - start) as usize)
                    .copied()
                    .collect()
            },
        };
        let subscriber = Arc::new(Subscription {
            state: Mutex::new(Subscriber {
                active: false,
                detached: false,
                pending: VecDeque::new(),
                bytes: 0,
                end: None,
            }),
            notify: Notify::new(),
        });
        let token = super::identifier("attachment_")?;
        state.subscribers.insert(token.clone(), subscriber.clone());
        drop(state);
        Ok(Attachment {
            replay,
            subscriber,
            session,
            access,
            generation,
            fence,
            token,
        })
    }
    pub async fn wait(&self, id: &Id, owner: &SessionId) -> io::Result<Info> {
        let mut done = self.owned(id, owner)?.done.subscribe();
        loop {
            if let Some(result) = done.borrow().clone() {
                return result.map_err(io::Error::other);
            }
            done.changed().await.map_err(io::Error::other)?;
        }
    }
    pub async fn update(&self, id: &Id, input: UpdateInput) -> io::Result<Info> {
        let session = self.owned(id, &input.session_id)?;
        let mut state = session.state.lock().map_err(poison)?;
        if !valid_fence(
            &state.info,
            input.generation.get() as u64,
            input.expected_fence.get() as u64,
            input.actor,
        ) {
            return Err(fence_error());
        }
        if let Some(title) = input.title.filter(|title| !title.is_empty()) {
            state.info.title = title;
        }
        if let Some(size) = input.size
            && state.info.status == Status::Running
        {
            session
                .terminal
                .resize(size.cols.get() as u16, size.rows.get() as u16)?;
            state.info.size = size;
        }
        let info = state.info.clone();
        self.event_source
            .emit(crate::event_feed::Data::PtyUpdated(Box::new(
                pty::InfoData { info: info.clone() },
            )))
            .map_err(io::Error::other)?;
        let _ = self.events.send(Event::Updated(info.clone()));
        Ok(info)
    }
    pub fn control(&self, id: &Id, input: ControlInput) -> io::Result<Info> {
        let session = self.owned(id, &input.session_id)?;
        let mut state = session.state.lock().map_err(poison)?;
        if state.info.generation != input.generation
            || state.info.control.fence != input.expected_fence
        {
            return Err(fence_error());
        }
        let owner = match (input.action, state.info.control.owner) {
            (pty::ControlAction::Take, owner) if owner != ControlOwner::User => ControlOwner::User,
            (pty::ControlAction::Pause, ControlOwner::User) => ControlOwner::Paused,
            (pty::ControlAction::Agent, ControlOwner::Paused) => ControlOwner::Agent,
            _ => return Err(fence_error()),
        };
        state.info.control = pty::Control {
            owner,
            fence: PositiveInt::new(state.info.control.fence.get() + 1)
                .map_err(io::Error::other)?,
        };
        let info = state.info.clone();
        self.event_source
            .emit(crate::event_feed::Data::PtyUpdated(Box::new(
                pty::InfoData { info: info.clone() },
            )))
            .map_err(io::Error::other)?;
        let _ = self.events.send(Event::Updated(info.clone()));
        Ok(info)
    }
    pub async fn write(
        &self,
        id: &Id,
        owner: &SessionId,
        generation: u64,
        fence: u64,
        actor: Actor,
        data: &str,
    ) -> io::Result<()> {
        write(
            self.owned(id, owner)?.as_ref(),
            generation,
            fence,
            actor,
            data,
        )
        .await
    }
    pub async fn remove(&self, id: &Id, owner: &SessionId) -> io::Result<()> {
        let session = self.owned(id, owner)?;
        if session.state.lock().map_err(poison)?.info.status == Status::Running {
            session
                .control
                .send(Request::Kill("terminated"))
                .await
                .map_err(io::Error::other)?;
        }
        join(&session).await?;
        {
            let mut state = self.state.lock().map_err(poison)?;
            state.sessions.remove(id);
            state.exited.retain(|exited| exited != id);
        }
        self.event_source
            .emit(crate::event_feed::Data::PtyDeleted(Box::new(
                pty::DeletedData { id: id.clone() },
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
        for session in &sessions {
            if session.state.lock().map_err(poison)?.info.status == Status::Running {
                session
                    .control
                    .send(Request::Kill("service_shutdown"))
                    .await
                    .map_err(io::Error::other)?;
            }
        }
        for session in &sessions {
            join(session).await?;
        }
        self.state.lock().map_err(poison)?.sessions.clear();
        Ok(())
    }
}
impl Drop for Pty {
    fn drop(&mut self) {
        if let Ok(state) = self.state.lock() {
            for session in state.sessions.values() {
                let _ = session.control.try_send(Request::Kill("service_shutdown"));
                if session
                    .state
                    .lock()
                    .is_ok_and(|state| state.info.status == Status::Running)
                {
                    session.abandon.notify_one();
                }
            }
        }
    }
}
async fn join(session: &Active) -> io::Result<()> {
    if let Some(task) = session.task.lock().await.take() {
        task.await.map_err(io::Error::other)??;
    }
    Ok(())
}
async fn write(
    session: &Active,
    generation: u64,
    fence: u64,
    actor: Actor,
    data: &str,
) -> io::Result<()> {
    {
        let state = session.state.lock().map_err(poison)?;
        if !valid_fence(&state.info, generation, fence, actor) {
            return Err(fence_error());
        }
        if data.len() > pty::MAX_INPUT_BYTES as usize {
            return Err(limit("input"));
        }
        if state.info.status != Status::Running {
            return Ok(());
        }
    }
    let (reply, receive) = oneshot::channel();
    session
        .control
        .send(Request::Write {
            generation,
            fence,
            actor,
            bytes: data.as_bytes().to_vec(),
            reply,
        })
        .await
        .map_err(io::Error::other)?;
    receive.await.map_err(io::Error::other)?
}
fn valid_fence(info: &Info, generation: u64, fence: u64, actor: Actor) -> bool {
    info.generation.get() as u64 == generation
        && info.control.fence.get() as u64 == fence
        && matches!(
            (actor, info.control.owner),
            (Actor::Agent, ControlOwner::Agent) | (Actor::User, ControlOwner::User)
        )
}
fn fence_error() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "PTY writer fence mismatch")
}
fn limit(resource: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::OutOfMemory,
        format!("PTY resource limit: {resource}"),
    )
}
fn poison<T>(_: std::sync::PoisonError<T>) -> io::Error {
    io::Error::other("PTY state lock poisoned")
}

async fn drive(
    session: &Arc<Active>,
    mut native: Native,
    mut requests: mpsc::Receiver<Request>,
) -> io::Result<Info> {
    let terminal = native.terminal.clone();
    type Input = (u64, u64, Actor, Vec<u8>, oneshot::Sender<io::Result<()>>);
    let (input, mut input_requests) = mpsc::channel::<Input>(16);
    let input_terminal = terminal.clone();
    let input_session = Arc::downgrade(session);
    let input_task = tokio::spawn(async move {
        while let Some((generation, fence, actor, bytes, reply)) = input_requests.recv().await {
            let valid = input_session.upgrade().is_some_and(|session| {
                session
                    .state
                    .lock()
                    .is_ok_and(|state| valid_fence(&state.info, generation, fence, actor))
            });
            let result = if valid {
                input_terminal.write(&bytes).await
            } else {
                Err(fence_error())
            };
            let _ = reply.send(result);
        }
    });
    let duration = Duration::from_secs(
        session
            .state
            .lock()
            .map_err(poison)?
            .info
            .limits
            .max_runtime_seconds
            .get() as u64,
    );
    let deadline = tokio::time::sleep(duration);
    tokio::pin!(deadline);
    let mut buffer = vec![0; 65536];
    let mut held = Vec::new();
    let mut exit = None;
    let mut reading = true;
    let mut reason = "exit";
    let result = async {
        while exit.is_none() || reading {
            tokio::select! {
                read = terminal.read(&mut buffer), if reading => {
                    let count = read?; reading = count != 0;
                    held.extend_from_slice(&buffer[..count]);
                    let end = super::shell::paging::page_end(&held, held.len(), !reading);
                    let data = String::from_utf8_lossy(&held[..end]).into_owned().into_bytes();
                    held.drain(..end);
                    if !data.is_empty() { append(session, data)?; }
                }
                code = native.wait(), if exit.is_none() => { exit = Some(code?); }
                request = requests.recv(), if exit.is_none() => {
                    match request {
                        Some(Request::Write { generation, fence, actor, bytes, reply }) => {
                            let valid = valid_fence(&session.state.lock().map_err(poison)?.info, generation, fence, actor);
                            if !valid { let _ = reply.send(Err(fence_error())); continue; }
                            if let Err(error) = input.try_send((generation, fence, actor, bytes, reply)) { let (_, _, _, _, reply) = error.into_inner(); let _ = reply.send(Err(limit("input"))); }
                        }
                        Some(Request::Kill(termination)) => { reason = termination; exit = Some(native.kill().await?); }
                        None => { reason = "service_shutdown"; exit = Some(native.kill().await?); }
                    }
                }
                () = &mut deadline, if exit.is_none() => { reason = "timeout"; exit = Some(native.kill().await?); }
                () = session.abandon.notified(), if exit.is_none() => { reason = "service_shutdown"; exit = Some(native.kill().await?); }
            }
        }
        let exit = exit.ok_or_else(|| io::Error::other("PTY exit settlement missing"))?;
        native.finish().await?;
        let mut state = session.state.lock().map_err(poison)?;
        state.info.status = Status::Exited; state.info.exit_code = Some(NonNegativeInt::new(i64::from(exit)).map_err(io::Error::other)?);
        state.info.exit_reason = Some(match reason { "timeout" => pty::ExitReason::Timeout, "terminated" | "service_shutdown" => pty::ExitReason::Terminated, _ => pty::ExitReason::Exit });
        let end = EndEvent { generation: state.info.generation.get() as u64, reason: reason.into(), exit_code: (reason == "exit" || reason == "timeout").then_some(exit) };
        for subscriber in state.subscribers.values() { subscriber.state.lock().map_err(poison)?.end = Some(end.clone()); subscriber.notify.notify_one(); }
        state.subscribers.clear(); Ok(state.info.clone())
    }.await;
    if result.is_err() {
        native.kill().await?;
    }
    input_task.abort();
    if let Err(error) = input_task.await
        && !error.is_cancelled()
    {
        return Err(io::Error::other(error));
    }
    result
}
fn append(session: &Active, data: Vec<u8>) -> io::Result<()> {
    let mut state = session.state.lock().map_err(poison)?;
    let start = state.info.output.end_offset.get() as u64;
    let end = start + data.len() as u64;
    let chunk = OutputChunk {
        generation: state.info.generation.get() as u64,
        start_offset: start,
        end_offset: end,
        data,
    };
    state.info.output.end_offset = NonNegativeInt::new(end as i64).map_err(io::Error::other)?;
    state.subscribers.retain(|_, subscriber| {
        let mut subscriber_state = subscriber.state.lock().expect("subscriber lock poisoned");
        if subscriber_state.detached {
            return false;
        }
        subscriber_state.bytes += chunk.data.len();
        if subscriber_state.bytes > pty::MAX_RETAINED_BYTES as usize
            || subscriber_state.pending.len() >= 128
        {
            subscriber_state.pending.clear();
            subscriber_state.bytes = 0;
            subscriber_state.end = Some(EndEvent {
                generation: chunk.generation,
                reason: "overflow".into(),
                exit_code: None,
            });
            subscriber.notify.notify_one();
            return false;
        }
        subscriber_state.pending.push_back(chunk.clone());
        subscriber.notify.notify_one();
        true
    });
    state.retained.extend(chunk.data);
    let excess = state
        .retained
        .len()
        .saturating_sub(state.info.limits.max_retained_bytes.get() as usize);
    state.retained.drain(..excess);
    state.info.output.start_offset =
        NonNegativeInt::new((end - state.retained.len() as u64) as i64)
            .map_err(io::Error::other)?;
    state.info.output.truncated = state.info.output.start_offset.get() > 0;
    Ok(())
}
