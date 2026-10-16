mod lid;

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
        ["-i".to_string(), "-w".to_string(), pid.to_string()],
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
        Self::make(
            supported,
            command,
            if supported {
                lid::Controller::new(file, native)
            } else {
                lid::Controller::unsupported()
            },
            reapply,
        )
    }
    fn make(
        supported: bool,
        command: Arc<dyn Fn() -> Command + Send + Sync>,
        lid: lid::Controller,
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
    Status {
        state: if supported {
            State::Off
        } else {
            State::Unsupported
        },
        message: (!supported).then(|| "Keep machine awake is available on macOS only.".into()),
        manual: None,
        lid: Some(if supported {
            LidState::Off
        } else {
            LidState::Unsupported
        }),
        sleep_hold: Some(false),
    }
}
fn error(message: impl Into<ycoding_schema::LosslessString>) -> Status {
    Status {
        state: State::Error,
        message: Some(message.into()),
        ..initial(true)
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
    reapply: Duration,
) {
    let mut active: Option<Process> = None;
    let mut manual = false;
    let mut holds = BTreeSet::new();
    let mut base = initial(supported);
    let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + reapply, reapply);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let request = if let Some(process) = active.as_mut() {
            tokio::select! {
                request = requests.recv() => request,
                exit = process.wait() => {
                    active = None;
                    base = exited(exit);
                    lid.apply(false);
                    publish(&status, &base, manual, &holds, lid.state);
                    continue;
                }
                _ = interval.tick() => {
                    lid.apply(true);
                    publish(&status, &base, manual, &holds, lid.state);
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
                publish(&status, &base, false, &holds, lid.state);
                let _ = reply.send(status.borrow().clone());
                return;
            }
            Request::Update(change, reply) => (change, reply),
        };
        let cancelable = matches!(change, Change::Manual(_));
        if cancelable && reply.is_closed() {
            continue;
        }
        match change {
            Change::Manual(enabled) => manual = enabled,
            Change::Hold(root) => {
                holds.insert(root);
            }
            Change::Release(root) => {
                holds.remove(&root);
            }
            Change::Recover => {
                if active.is_none() && supported {
                    lid.apply(false);
                }
                publish(&status, &base, manual, &holds, lid.state);
                let _ = reply.send(status.borrow().clone());
                continue;
            }
        }
        if !supported {
            publish(&status, &base, manual, &holds, LidState::Unsupported);
            let _ = reply.send(status.borrow().clone());
            continue;
        }
        if !manual && holds.is_empty() {
            base = stop(&mut active).await;
            lid.apply(false);
            publish(&status, &base, manual, &holds, lid.state);
            let _ = reply.send(status.borrow().clone());
            continue;
        }
        if active.is_some() {
            if lid.state != LidState::On {
                lid.apply(true);
            }
            publish(&status, &base, manual, &holds, lid.state);
            let _ = reply.send(status.borrow().clone());
            continue;
        }
        let spawned = tokio::select! {
            _ = reply.closed(), if cancelable => continue,
            spawned = process::spawn(command()) => spawned,
        };
        let mut child = match spawned {
            Ok(child) => child,
            Err(_) => {
                base = error("The sleep inhibitor could not be started.");
                publish(&status, &base, manual, &holds, lid.state);
                let _ = reply.send(status.borrow().clone());
                continue;
            }
        };
        let next = tokio::select! {
            _ = reply.closed(), if cancelable => { let _ = child.kill(process::KillOptions::default()).await; continue; }
            exit = child.wait() => exited(exit),
            _ = tokio::time::sleep(Duration::from_millis(300)) => Status { state: State::On, message: None, ..initial(true) },
        };
        if next.state == State::On {
            active = Some(child);
            lid.apply(true);
        }
        base = next;
        publish(&status, &base, manual, &holds, lid.state);
        if reply.send(status.borrow().clone()).is_err() && cancelable {
            base = stop(&mut active).await;
            lid.apply(false);
            publish(&status, &base, manual, &holds, lid.state);
        }
    }
}

fn publish(
    status: &watch::Sender<Status>,
    base: &Status,
    manual: bool,
    holds: &BTreeSet<String>,
    lid: LidState,
) {
    let mut next = base.clone();
    next.manual = (!holds.is_empty()).then_some(manual);
    next.sleep_hold = Some(!holds.is_empty());
    next.lid = Some(lid);
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
