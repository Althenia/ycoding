use super::process::{self, Command, Input, Output, Process};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
use ycoding_schema::keep_awake::{State, Status};

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
    closed: std::sync::atomic::AtomicBool,
}
#[derive(Clone)]
pub struct Service(Arc<Inner>);
enum Request {
    Set(bool, oneshot::Sender<Status>),
    Close(oneshot::Sender<Status>),
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
    pub fn with_command(supported: bool, command: Arc<dyn Fn() -> Command + Send + Sync>) -> Self {
        Self(Arc::new(Inner {
            supported,
            command,
            status: watch::channel(initial(supported)).0,
            worker: Mutex::new(None),
            closed: std::sync::atomic::AtomicBool::new(false),
        }))
    }
    pub fn get(&self) -> Status {
        self.0.status.borrow().clone()
    }
    pub async fn set(&self, enabled: bool) -> Status {
        if !self.0.supported {
            return initial(false);
        }
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
                        )),
                    }
                })
                .sender
                .clone()
        };
        let (reply, receive) = oneshot::channel();
        if sender.send(Request::Set(enabled, reply)).await.is_err() {
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
    }
}
fn error(message: impl Into<ycoding_schema::LosslessString>) -> Status {
    Status {
        state: State::Error,
        message: Some(message.into()),
    }
}
fn exited(exit: std::io::Result<process::Exit>) -> Status {
    error(match exit.ok().and_then(|exit| exit.code) {
        Some(code) => format!("The sleep inhibitor stopped unexpectedly (exit code {code})."),
        None => "The sleep inhibitor stopped unexpectedly (terminated by a signal).".to_string(),
    })
}
async fn stop(active: &mut Option<Process>, status: &watch::Sender<Status>) {
    if let Some(mut process) = active.take()
        && process.kill(process::KillOptions::default()).await.is_err()
    {
        status.send_replace(error("The sleep inhibitor could not be stopped."));
        return;
    }
    status.send_replace(initial(true));
}
async fn run(
    mut requests: mpsc::Receiver<Request>,
    status: watch::Sender<Status>,
    command: Arc<dyn Fn() -> Command + Send + Sync>,
) {
    let mut active: Option<Process> = None;
    loop {
        let request = if let Some(process) = active.as_mut() {
            tokio::select! {
                request = requests.recv() => request,
                exit = process.wait() => { active = None; status.send_replace(exited(exit)); continue; }
            }
        } else {
            requests.recv().await
        };
        let Some(request) = request else {
            stop(&mut active, &status).await;
            return;
        };
        match request {
            Request::Close(reply) => {
                stop(&mut active, &status).await;
                let _ = reply.send(status.borrow().clone());
                return;
            }
            Request::Set(false, reply) => {
                stop(&mut active, &status).await;
                let _ = reply.send(status.borrow().clone());
            }
            Request::Set(true, mut reply) => {
                if reply.is_closed() {
                    continue;
                }
                if active.is_some() {
                    let _ = reply.send(status.borrow().clone());
                    continue;
                }
                let spawned = tokio::select! {
                    _ = reply.closed() => continue,
                    spawned = process::spawn(command()) => spawned,
                };
                let mut child = match spawned {
                    Ok(child) => child,
                    Err(_) => {
                        status.send_replace(error("The sleep inhibitor could not be started."));
                        let _ = reply.send(status.borrow().clone());
                        continue;
                    }
                };
                let next = tokio::select! {
                    _ = reply.closed() => { let _ = child.kill(process::KillOptions::default()).await; continue; }
                    exit = child.wait() => exited(exit),
                    _ = tokio::time::sleep(Duration::from_millis(300)) => Status { state: State::On, message: None },
                };
                if next.state == State::On {
                    active = Some(child);
                }
                status.send_replace(next.clone());
                if reply.send(next).is_err() {
                    stop(&mut active, &status).await;
                }
            }
        }
    }
}
