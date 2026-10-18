use super::unavailable;
use crate::dispatch::Failure;
use std::{
    future::Future,
    sync::{
        Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
};
use tokio::{runtime::Handle, sync::oneshot};

type Owner = (oneshot::Sender<()>, JoinHandle<Result<(), Failure>>);

pub(super) struct Composition {
    handle: Handle,
    closed: AtomicBool,
    owner: Mutex<Option<Owner>>,
}

impl Composition {
    pub fn start() -> Result<Self, Failure> {
        Self::build(None)
    }
    pub fn start_reports(
        client: ycoding_core::ycoding_store::Client,
        directory: std::path::PathBuf,
    ) -> Result<Self, Failure> {
        Self::build(Some((client, directory)))
    }
    fn build(
        reports: Option<(ycoding_core::ycoding_store::Client, std::path::PathBuf)>,
    ) -> Result<Self, Failure> {
        let (ready, receiver) = std::sync::mpsc::sync_channel(1);
        let (stop, stopped) = oneshot::channel();
        let task = std::thread::Builder::new()
            .name("ycoding-composition".into())
            .spawn(move || {
                // Analytics is derived and rebuildable: starting its owner must never gate
                // readiness. Purge/rebuild run on the maintainer below; while they fail,
                // report reads return the analytics error instead of data.
                let analytics =
                    reports.and_then(|(client, directory)| start_analytics(client, directory));
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build();
                match runtime {
                    Ok(runtime) => {
                        if ready.send(Ok(runtime.handle().clone())).is_err() {
                            return Ok(());
                        }
                        runtime.block_on(async {
                            let _ = stopped.await;
                        });
                    }
                    Err(_) => {
                        let _ = ready.send(Err(unavailable("composition runtime")));
                    }
                }
                if let Some(mut maintainer) = analytics {
                    maintainer.stop();
                }
                Ok(())
            })
            .map_err(|_| unavailable("composition runtime"))?;
        let handle = receiver
            .recv()
            .map_err(|_| unavailable("composition runtime"))??;
        Ok(Self {
            handle,
            closed: AtomicBool::new(false),
            owner: Mutex::new(Some((stop, task))),
        })
    }

    pub fn run<T: Send>(
        &self,
        future: impl Future<Output = Result<T, Failure>> + Send,
    ) -> Result<T, Failure> {
        if self.closed.load(Ordering::Acquire) {
            return Err(unavailable("composition runtime"));
        }
        std::thread::scope(|scope| {
            scope
                .spawn(|| self.handle.block_on(future))
                .join()
                .map_err(|_| unavailable("composition task"))?
        })
    }

    pub fn close(&self) -> Result<(), Failure> {
        self.closed.store(true, Ordering::Release);
        let owner = self
            .owner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some((stop, task)) = owner {
            let _ = stop.send(());
            task.join()
                .map_err(|_| unavailable("composition runtime"))??;
        }
        Ok(())
    }
}

struct Maintainer {
    stop: std::sync::mpsc::Sender<()>,
    task: Option<JoinHandle<()>>,
}

impl Maintainer {
    fn stop(&mut self) {
        let _ = self.stop.send(());
        if let Some(task) = self.task.take() {
            let _ = task.join();
        }
    }
}

impl Drop for Maintainer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn start_analytics(
    client: ycoding_core::ycoding_store::Client,
    directory: std::path::PathBuf,
) -> Option<Maintainer> {
    let (stop, stopped) = std::sync::mpsc::channel();
    match std::thread::Builder::new()
        .name("ycoding-analytics-rebuild".into())
        .spawn(move || maintain(client, directory, stopped))
    {
        Ok(task) => Some(Maintainer {
            stop,
            task: Some(task),
        }),
        Err(error) => {
            tracing::error!(
                "analytics maintainer failed to start ({error}); report reads remain unavailable"
            );
            None
        }
    }
}

fn maintain(
    client: ycoding_core::ycoding_store::Client,
    directory: std::path::PathBuf,
    stopped: std::sync::mpsc::Receiver<()>,
) {
    let engine = loop {
        match ycoding_core::ycoding_store::analytics::reports::start(
            client.clone(),
            directory.clone(),
        ) {
            Ok(engine) => break engine,
            Err(error) => {
                tracing::error!(
                    "analytics owner failed to start ({error:?}); report reads remain unavailable"
                );
                if wait_stop(&stopped) {
                    return;
                }
            }
        }
    };
    let handle = engine.handle();
    let mut stop_requested = false;
    loop {
        match handle.maintain() {
            Ok(ycoding_core::ycoding_store::analytics::Maintenance::Complete) => break,
            Ok(ycoding_core::ycoding_store::analytics::Maintenance::Pending) => {
                if !matches!(
                    stopped.try_recv(),
                    Err(std::sync::mpsc::TryRecvError::Empty)
                ) {
                    stop_requested = true;
                    break;
                }
            }
            Err(error) => {
                tracing::error!(
                    "analytics purge/rebuild failed ({error:?}); report reads remain unavailable until it succeeds"
                );
                if wait_stop(&stopped) {
                    stop_requested = true;
                    break;
                }
            }
        }
    }
    if !stop_requested {
        // Keep the engine serving report reads until composition stops or drops us.
        let _ = stopped.recv();
    }
    if let Err(error) = engine.shutdown() {
        tracing::error!("analytics shutdown failed ({error:?})");
    }
}

fn wait_stop(stopped: &std::sync::mpsc::Receiver<()>) -> bool {
    match stopped.recv_timeout(std::time::Duration::from_secs(1)) {
        Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => true,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => false,
    }
}

impl Drop for Composition {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test(flavor = "current_thread")]
    async fn synchronous_acquisition_keeps_async_owners_alive_and_joins_them() {
        let runtime = Arc::new(Composition::start().unwrap());
        let (release, released) = oneshot::channel();
        let (finished, done) = oneshot::channel();
        let worker = runtime
            .run(async {
                Ok(tokio::spawn(async {
                    released.await.unwrap();
                    finished.send(()).unwrap();
                }))
            })
            .unwrap();
        release.send(()).unwrap();
        done.await.unwrap();
        worker.await.unwrap();
        runtime.close().unwrap();
        runtime.close().unwrap();
        assert!(runtime.run(async { Ok(()) }).is_err());
    }
}
