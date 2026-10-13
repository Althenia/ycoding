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

pub(super) struct Composition {
    handle: Handle,
    closed: AtomicBool,
    owner: Mutex<Option<(oneshot::Sender<()>, JoinHandle<Result<(), Failure>>)>>,
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
                let analytics = reports
                    .map(|(client, directory)| {
                        let engine = ycoding_core::ycoding_store::analytics::reports::start(
                            client.clone(),
                            directory,
                        )
                        .map_err(|_| unavailable("analytics owner"))?;
                        let pending = client
                            .snapshot()
                            .map_err(|_| unavailable("analytics purge fence"))?
                            .get::<ycoding_core::ycoding_store::analytics::DeliveryTable>(&[])
                            .map_err(|_| unavailable("analytics purge fence"))?
                            .is_some_and(|delivery| {
                                delivery.purge_all || !delivery.purges.is_empty()
                            });
                        if pending {
                            engine.purge().map_err(|_| unavailable("analytics purge"))?;
                        }
                        engine
                            .rebuild()
                            .map_err(|_| unavailable("analytics rebuild"))?;
                        Ok::<_, Failure>(engine)
                    })
                    .transpose();
                let analytics = match analytics {
                    Ok(analytics) => analytics,
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return Ok(());
                    }
                };
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
                if let Some(analytics) = analytics {
                    analytics
                        .shutdown()
                        .map_err(|_| unavailable("analytics shutdown"))?;
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
