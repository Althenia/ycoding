mod lid;
mod manual;

use super::process::{self, Command, Input, Output, Process};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
use ycoding_schema::keep_awake::{LidState, State, Status};

pub fn macos_inhibitor(pid: u32) -> Command {
    let mut command = Command::new(
        "/usr/bin/caffeinate",
        [
            "-d".to_string(),
            "-i".to_string(),
            "-w".to_string(),
            pid.to_string(),
        ],
    );
    command.stdin = Input::Ignore;
    command.stdout = Output::Ignore;
    command.stderr = Output::Ignore;
    command
}

struct Worker {
    sender: mpsc::Sender<Request>,
    task: JoinHandle<()>,
}
struct Inner {
    supported: bool,
    command: Arc<dyn Fn() -> Command + Send + Sync>,
    status: watch::Sender<Status>,
    worker: Mutex<Option<Worker>>,
    lid: Mutex<Option<lid::Controller>>,
    preference: Option<PathBuf>,
    reapply: Duration,
    closed: std::sync::atomic::AtomicBool,
}
#[derive(Clone)]
pub struct Service(Arc<Inner>);
enum Request {
    Update(Change, oneshot::Sender<Status>),
    Close(oneshot::Sender<Status>),
}
enum Change {
    Manual(bool),
    Hold(String),
    Release(String),
    Recover,
}

impl Default for Service {
    fn default() -> Self {
        Self::new()
    }
}
impl Service {
    pub fn new() -> Self {
        Self::with_command(
            cfg!(target_os = "macos"),
            Arc::new(|| macos_inhibitor(std::process::id())),
        )
    }
    pub async fn open(file: PathBuf) -> Self {
        let service = Self::with_lid(
            cfg!(target_os = "macos"),
            Arc::new(|| macos_inhibitor(std::process::id())),
            file,
            lid::native(),
            Duration::from_secs(30),
        );
        service.recover().await;
        service
    }
    pub fn with_command(supported: bool, command: Arc<dyn Fn() -> Command + Send + Sync>) -> Self {
        Self::make(
            supported,
            command,
            lid::Controller::unsupported(),
            None,
            Duration::from_secs(30),
        )
    }
    pub fn with_lid(
        supported: bool,
        command: Arc<dyn Fn() -> Command + Send + Sync>,
        file: PathBuf,
        native: Box<dyn FnMut(bool) -> LidState + Send>,
        reapply: Duration,
    ) -> Self {
        let preference = supported.then(|| file.with_file_name(manual::FILE));
        Self::make(
            supported,
            command,
            if supported {
                lid::Controller::new(file, native)
            } else {
                lid::Controller::unsupported()
            },
            preference,
            reapply,
        )
    }
    fn make(
        supported: bool,
        command: Arc<dyn Fn() -> Command + Send + Sync>,
        lid: lid::Controller,
        preference: Option<PathBuf>,
        reapply: Duration,
    ) -> Self {
        let mut status = initial(supported);
        status.lid = Some(if supported {
            lid.state
        } else {
            LidState::Unsupported
        });
        Self(Arc::new(Inner {
            supported,
            command,
            status: watch::channel(status).0,
            worker: Mutex::new(None),
            lid: Mutex::new(Some(lid)),
            preference,
            reapply,
            closed: std::sync::atomic::AtomicBool::new(false),
        }))
    }
    pub fn get(&self) -> Status {
        self.0.status.borrow().clone()
    }
    pub async fn set(&self, enabled: bool) -> Status {
        self.update(Change::Manual(enabled)).await
    }
    pub async fn hold(&self, root: &str) -> Status {
        self.update(Change::Hold(root.to_owned())).await
    }
    pub async fn release(&self, root: &str) -> Status {
        self.update(Change::Release(root.to_owned())).await
    }
    pub async fn recover(&self) -> Status {
        self.update(Change::Recover).await
    }
    async fn update(&self, change: Change) -> Status {
        let sender = {
            let mut worker = self.0.worker.lock().unwrap_or_else(PoisonError::into_inner);
            if self.0.closed.load(std::sync::atomic::Ordering::Acquire) {
                return self.get();
            }
            worker
                .get_or_insert_with(|| {
                    let (sender, receiver) = mpsc::channel(8);
                    Worker {
                        sender,
                        task: tokio::spawn(run(
                            receiver,
                            self.0.status.clone(),
                            self.0.command.clone(),
                            self.0.supported,
                            self.0
                                .lid
                                .lock()
                                .unwrap_or_else(PoisonError::into_inner)
                                .take()
                                .expect("keep-awake worker owns lid controller"),
                            self.0.preference.clone(),
                            self.0.reapply,
                        )),
                    }
                })
                .sender
                .clone()
        };
        let (reply, receive) = oneshot::channel();
        if sender.send(Request::Update(change, reply)).await.is_err() {
            return self.get();
        }
        receive.await.unwrap_or_else(|_| self.get())
    }
    pub async fn close(&self) {
        let worker = {
            let mut worker = self.0.worker.lock().unwrap_or_else(PoisonError::into_inner);
            self.0
                .closed
                .store(true, std::sync::atomic::Ordering::Release);
            worker.take()
        };
        if let Some(worker) = worker {
            let (reply, receive) = oneshot::channel();
            let _ = worker.sender.send(Request::Close(reply)).await;
            let _ = receive.await;
            let _ = worker.task.await;
        }
    }
}

fn initial(supported: bool) -> Status {
    inhibitor_status(if supported {
        State::Off
    } else {
        State::Unsupported
    })
}
fn inhibitor_status(state: State) -> Status {
    let supported = state != State::Unsupported;
    Status {
        state,
        message: (!supported).then(|| "Keep machine awake is available on macOS only.".into()),
        manual: None,
        lid: Some(if supported {
            LidState::Off
        } else {
            LidState::Unsupported
        }),
        defer_hold: Some(false),
        system: None,
        display: Some(state),
        activity: None,
    }
}
fn error(message: impl Into<ycoding_schema::LosslessString>) -> Status {
    Status {
        message: Some(message.into()),
        ..inhibitor_status(State::Error)
    }
}
fn exited(exit: std::io::Result<process::Exit>) -> Status {
    error(match exit.ok().and_then(|exit| exit.code) {
        Some(code) => format!("The sleep inhibitor stopped unexpectedly (exit code {code})."),
        None => "The sleep inhibitor stopped unexpectedly (terminated by a signal).".to_string(),
    })
}
async fn stop(active: &mut Option<Process>) -> Status {
    if let Some(mut process) = active.take()
        && process.kill(process::KillOptions::default()).await.is_err()
    {
        return error("The sleep inhibitor could not be stopped.");
    }
    initial(true)
}
async fn run(
    mut requests: mpsc::Receiver<Request>,
    status: watch::Sender<Status>,
    command: Arc<dyn Fn() -> Command + Send + Sync>,
    supported: bool,
    mut lid: lid::Controller,
    preference: Option<PathBuf>,
    reapply: Duration,
) {
    let mut active: Option<Process> = None;
    let mut manual = false;
    let mut preference_error = None;
    let mut holds = BTreeSet::new();
    let mut base = initial(supported);
    let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + reapply, reapply);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let publish = |base: &Status, manual, holds: &BTreeSet<String>, lid, error: Option<&str>| {
        publish(
            &status,
            base,
            (preference.is_some() || !holds.is_empty()).then_some(manual),
            !holds.is_empty(),
            lid,
            error,
        );
    };
    loop {
        let request = if let Some(process) = active.as_mut() {
            tokio::select! {
                request = requests.recv() => request,
                exit = process.wait() => {
                    active = None;
                    base = exited(exit);
                    lid.apply(false);
                    publish(&base, manual, &holds, lid.state, preference_error);
                    continue;
                }
                _ = interval.tick() => {
                    lid.apply(true);
                    publish(&base, manual, &holds, lid.state, preference_error);
                    continue;
                }
            }
        } else {
            requests.recv().await
        };
        let Some(request) = request else {
            stop(&mut active).await;
            lid.apply(false);
            return;
        };
        let (change, mut reply) = match request {
            Request::Close(reply) => {
                base = if supported {
                    stop(&mut active).await
                } else {
                    initial(false)
                };
                lid.apply(false);
                holds.clear();
                publish(&base, manual, &holds, lid.state, None);
                let _ = reply.send(status.borrow().clone());
                return;
            }
            Request::Update(change, reply) => (change, reply),
        };
        let cancelable = matches!(change, Change::Manual(_));
        if cancelable && reply.is_closed() {
            continue;
        }
        let recovering = matches!(change, Change::Recover);
        let requested = match change {
            Change::Manual(enabled) => supported.then_some(enabled),
            Change::Hold(root) => {
                holds.insert(root);
                None
            }
            Change::Release(root) => {
                holds.remove(&root);
                None
            }
            Change::Recover => {
                if active.is_none() && supported {
                    lid.apply(false);
                }
                if let Some(path) = &preference {
                    match manual::read(path) {
                        Ok(saved) => {
                            manual = saved;
                            preference_error = None;
                        }
                        Err(_) => {
                            preference_error =
                                Some("The manual keep-awake setting could not be read.")
                        }
                    }
                }
                None
            }
        };
        let enabled = requested.unwrap_or(manual) || !holds.is_empty();
        let mut staged = None;
        let start = if supported && enabled && active.is_none() {
            let spawned = tokio::select! {
                biased;
                _ = reply.closed(), if cancelable => continue,
                spawned = process::spawn(command()) => spawned,
            };
            Some(match spawned {
                Ok(mut child) => {
                    let next = tokio::select! {
                        biased;
                        _ = reply.closed(), if cancelable => {
                            let _ = child.kill(process::KillOptions::default()).await;
                            continue;
                        }
                        exit = child.wait() => exited(exit),
                        _ = tokio::time::sleep(Duration::from_millis(300)) => inhibitor_status(State::On),
                    };
                    if next.state == State::On {
                        staged = Some(child);
                    }
                    next
                }
                Err(_) => error("The sleep inhibitor could not be started."),
            })
        } else {
            None
        };
        if let Some(requested) = requested {
            if preference
                .as_deref()
                .is_some_and(|path| manual::write(path, requested).is_err())
            {
                if staged.is_some() {
                    base = stop(&mut staged).await;
                }
                preference_error = Some("The manual keep-awake setting could not be saved.");
                publish(&base, manual, &holds, lid.state, preference_error);
                let _ = reply.send(status.borrow().clone());
                continue;
            }
            manual = requested;
            preference_error = None;
        }
        if supported {
            if !enabled {
                let was_active = active.is_some();
                base = stop(&mut active).await;
                if !recovering || was_active {
                    lid.apply(false);
                }
            } else {
                if let Some(next) = start {
                    active = staged;
                    base = next;
                }
                if active.is_some() && lid.state != LidState::On {
                    lid.apply(true);
                }
            }
        }
        publish(&base, manual, &holds, lid.state, preference_error);
        let _ = reply.send(status.borrow().clone());
    }
}

fn publish(
    status: &watch::Sender<Status>,
    base: &Status,
    manual: Option<bool>,
    deferred: bool,
    lid: LidState,
    preference_error: Option<&str>,
) {
    let mut next = base.clone();
    next.manual = manual;
    next.defer_hold = Some(deferred);
    next.lid = Some(lid);
    if let Some(message) = preference_error {
        next.state = State::Error;
        next.message = Some(message.into());
    }
    if next.message.is_none() {
        next.message = match lid {
            LidState::Held => Some("Lid control is held by another YCoding process.".into()),
            LidState::Error if next.state == State::On => Some(
                "Lid-closed keep-awake could not be armed; closing the lid may sleep this machine."
                    .into(),
            ),
            LidState::Error => Some(
                "Normal lid sleep could not be restored; check this machine's power state.".into(),
            ),
            _ => None,
        };
    }
    status.send_replace(next);
}
