use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};

use super::{Error, v5};

type Rebuild = Arc<
    dyn Fn(v5::TransformStage) -> Pin<Box<dyn Future<Output = Result<(), Error>> + Send + 'static>>
        + Send
        + Sync,
>;
type Waiter = oneshot::Sender<Result<(), Error>>;
type RebuildFuture = Pin<Box<dyn Future<Output = Result<(), Error>> + Send + 'static>>;

const REQUEST_CAPACITY: usize = 64;
const STAGES: [v5::TransformStage; 5] = [
    v5::TransformStage::Agents,
    v5::TransformStage::Commands,
    v5::TransformStage::References,
    v5::TransformStage::Skills,
    v5::TransformStage::Catalog,
];

#[derive(Clone)]
pub struct Reloader {
    inner: Arc<Inner>,
}

struct Inner {
    senders: Vec<mpsc::Sender<Waiter>>,
    stop: watch::Receiver<bool>,
}

impl Reloader {
    pub fn start(
        debounce: Duration,
        stop: watch::Receiver<bool>,
        rebuild: Rebuild,
    ) -> (Self, Vec<JoinHandle<()>>) {
        let mut senders = Vec::with_capacity(STAGES.len());
        let mut tasks = Vec::with_capacity(STAGES.len());
        for stage in STAGES {
            let (sender, receiver) = mpsc::channel(REQUEST_CAPACITY);
            senders.push(sender);
            tasks.push(tokio::spawn(worker(
                stage,
                debounce,
                stop.clone(),
                receiver,
                rebuild.clone(),
            )));
        }
        (
            Self {
                inner: Arc::new(Inner { senders, stop }),
            },
            tasks,
        )
    }

    pub async fn request(&self, stage: v5::TransformStage) -> Result<(), Error> {
        self.queue(stage)?.await.unwrap_or(Err(Error::Stopped))
    }

    pub(crate) fn enqueue(&self, stage: v5::TransformStage) -> Result<(), Error> {
        self.queue(stage).map(|_| ())
    }

    fn queue(
        &self,
        stage: v5::TransformStage,
    ) -> Result<oneshot::Receiver<Result<(), Error>>, Error> {
        let index = match stage {
            v5::TransformStage::Agents => 0,
            v5::TransformStage::Commands => 1,
            v5::TransformStage::References => 2,
            v5::TransformStage::Skills => 3,
            v5::TransformStage::Catalog => 4,
            _ => return Err(Error::Unauthorized),
        };
        if *self.inner.stop.borrow() || self.inner.stop.has_changed().is_err() {
            return Err(Error::Stopped);
        }
        let (settle, result) = oneshot::channel();
        match self.inner.senders[index].try_send(settle) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => return Err(Error::Capacity),
            Err(mpsc::error::TrySendError::Closed(_)) => return Err(Error::Stopped),
        }
        Ok(result)
    }
}

async fn worker(
    stage: v5::TransformStage,
    debounce: Duration,
    mut stop: watch::Receiver<bool>,
    mut requests: mpsc::Receiver<Waiter>,
    rebuild: Rebuild,
) {
    let mut pending: Vec<Waiter> = Vec::new();
    let mut running: Option<(Vec<Waiter>, RebuildFuture)> = None;
    let mut deadline: Option<tokio::time::Instant> = None;
    let mut requests_open = true;
    loop {
        if *stop.borrow() {
            break;
        }
        if !requests_open && pending.is_empty() && running.is_none() {
            return;
        }
        tokio::select! {
            biased;
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    break;
                }
            }
            request = requests.recv(), if requests_open => {
                match request {
                    Some(waiter) => {
                        pending.push(waiter);
                        deadline = Some(tokio::time::Instant::now() + debounce);
                    }
                    None => {
                        requests_open = false;
                        if pending.is_empty() && running.is_none() {
                            return;
                        }
                    }
                }
            }
            _ = async {
                match deadline {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            }, if running.is_none() && !pending.is_empty() && deadline.is_some() => {
                let waiters = std::mem::take(&mut pending);
                deadline = None;
                running = Some((waiters, rebuild(stage)));
            }
            result = async {
                match running.as_mut() {
                    Some((_, future)) => future.as_mut().await,
                    None => std::future::pending().await,
                }
            }, if running.is_some() => {
                if let Some((waiters, _)) = running.take() {
                    for waiter in waiters {
                        let _ = waiter.send(result);
                    }
                }
                if pending.is_empty() {
                    deadline = None;
                } else if deadline.is_none() {
                    deadline = Some(tokio::time::Instant::now() + debounce);
                }
                if !requests_open && pending.is_empty() {
                    return;
                }
            }
        }
    }
    let mut waiters = pending;
    if let Some((mut running_waiters, future)) = running.take() {
        drop(future);
        waiters.append(&mut running_waiters);
    }
    requests.close();
    while let Ok(waiter) = requests.try_recv() {
        waiters.push(waiter);
    }
    for waiter in waiters {
        let _ = waiter.send(Err(Error::Stopped));
    }
}
