use super::unavailable;
use crate::dispatch::Failure;
use std::{
    future::Future,
    sync::{
        Arc, Mutex, PoisonError,
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
    reports: Arc<Mutex<Option<Maintainer>>>,
    inputs: Arc<Mutex<Option<Inputs>>>,
    wake: Wake,
}

#[derive(Clone)]
pub(super) struct Wake {
    sender: std::sync::mpsc::SyncSender<()>,
    mirror: std::sync::mpsc::SyncSender<()>,
    presentations: std::sync::mpsc::SyncSender<()>,
    stopped: Arc<AtomicBool>,
    shutdown: Arc<tokio::sync::Notify>,
}

impl Wake {
    pub fn notify(&self) -> bool {
        if self.stopped.load(Ordering::Acquire) {
            return false;
        }
        let _ = self.mirror.try_send(());
        self.notify_usage()
    }

    fn notify_usage(&self) -> bool {
        if self.stopped.load(Ordering::Acquire) {
            return false;
        }
        !matches!(
            self.sender.try_send(()),
            Err(std::sync::mpsc::TrySendError::Disconnected(_))
        )
    }

    fn notify_presentations(&self) {
        if !self.stopped.load(Ordering::Acquire) {
            let _ = self.presentations.try_send(());
        }
    }
}

#[derive(Clone)]
struct Inputs {
    views: ycoding_core::usage_view::Service,
    quota: ycoding_core::resources::model::quota::Service,
    locations: Arc<std::sync::OnceLock<crate::locations::WeakLocations>>,
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
        let (sender, incoming) = std::sync::mpsc::sync_channel(1);
        let (mirror, mirror_incoming) = std::sync::mpsc::sync_channel(1);
        let (presentations, presentation_incoming) = std::sync::mpsc::sync_channel(1);
        let wake = Wake {
            sender,
            mirror,
            presentations,
            stopped: Arc::new(AtomicBool::new(false)),
            shutdown: Arc::default(),
        };
        let inputs = Arc::new(Mutex::new(None));
        let maintainers = Arc::new(Mutex::new(None));
        let source = inputs.clone();
        let owners = maintainers.clone();
        let signal = wake.clone();
        let task = std::thread::Builder::new()
            .name("ycoding-composition".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build();
                match runtime {
                    Ok(runtime) => {
                        if let Some((client, directory)) = reports {
                            *owners.lock().unwrap_or_else(PoisonError::into_inner) =
                                start_analytics(
                                    client,
                                    directory,
                                    source,
                                    signal,
                                    (incoming, mirror_incoming, presentation_incoming),
                                    runtime.handle().clone(),
                                );
                        }
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
                if let Some(mut maintainer) =
                    owners.lock().unwrap_or_else(PoisonError::into_inner).take()
                {
                    maintainer.stop()?;
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
            reports: maintainers,
            inputs,
            wake,
        })
    }

    pub fn bind_reports(
        &self,
        client: &ycoding_core::ycoding_store::Client,
        views: ycoding_core::usage_view::Service,
        quota: ycoding_core::resources::model::quota::Service,
        locations: Arc<std::sync::OnceLock<crate::locations::WeakLocations>>,
    ) {
        *self.inputs.lock().unwrap_or_else(PoisonError::into_inner) = Some(Inputs {
            views,
            quota: quota.clone(),
            locations,
        });
        let wake = self.wake.clone();
        client.observe_commits(move |_| wake.notify());
        let wake = self.wake.clone();
        quota.observe_changes(move || wake.notify());
        self.wake.notify();
    }

    pub fn wake(&self) -> Wake {
        self.wake.clone()
    }

    pub fn stop_reports(&self) -> Result<(), Failure> {
        self.wake.stopped.store(true, Ordering::Release);
        if let Some(inputs) = self
            .inputs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            inputs.views.invalidate();
            inputs.quota.retire_publications();
        }
        let owner = self
            .reports
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(mut owner) = owner {
            owner.stop()?;
        }
        Ok(())
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
        let reports = self.stop_reports();
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
        reports
    }
}

struct Maintainer {
    wake: Wake,
    task: Option<JoinHandle<()>>,
}

impl Maintainer {
    fn stop(&mut self) -> Result<(), Failure> {
        self.wake.stopped.store(true, Ordering::Release);
        self.wake.shutdown.notify_waiters();
        let _ = self.wake.sender.try_send(());
        let _ = self.wake.mirror.try_send(());
        let _ = self.wake.presentations.try_send(());
        if let Some(task) = self.task.take() {
            task.join()
                .map_err(|_| unavailable("analytics maintainer"))?;
        }
        Ok(())
    }
}

impl Drop for Maintainer {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

type Receiver = std::sync::mpsc::Receiver<()>;

fn start_analytics(
    client: ycoding_core::ycoding_store::Client,
    directory: std::path::PathBuf,
    inputs: Arc<Mutex<Option<Inputs>>>,
    wake: Wake,
    incoming: (Receiver, Receiver, Receiver),
    runtime: Handle,
) -> Option<Maintainer> {
    let signal = wake.clone();
    match std::thread::Builder::new()
        .name("ycoding-analytics-rebuild".into())
        .spawn(move || maintain(client, directory, inputs, signal, incoming, runtime))
    {
        Ok(task) => Some(Maintainer {
            wake,
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
    inputs: Arc<Mutex<Option<Inputs>>>,
    wake: Wake,
    (incoming, mirror_incoming, presentation_incoming): (Receiver, Receiver, Receiver),
    runtime: Handle,
) {
    let engine = loop {
        if wake.stopped.load(Ordering::Acquire) {
            return;
        }
        match ycoding_core::ycoding_store::analytics::reports::start(
            client.clone(),
            directory.clone(),
        ) {
            Ok(engine) => break engine,
            Err(error) => {
                tracing::error!(
                    "analytics owner failed to start ({error:?}); report reads remain unavailable"
                );
                let _ = incoming.recv_timeout(std::time::Duration::from_secs(1));
            }
        }
    };
    let handle = engine.handle();
    use ycoding_core::ycoding_store::{
        analytics::{Maintenance, PresentationChange},
        usage_cells,
    };
    let signal = wake.clone();
    handle.observe_presentations(move |change| match change {
        PresentationChange::Queued => signal.notify_presentations(),
        PresentationChange::SummaryReady => {
            signal.notify_usage();
        }
    });
    std::thread::scope(|scope| {
        let presentation_inputs = inputs.clone();
        let presentations = std::thread::Builder::new()
            .name("ycoding-usage-presentations".into())
            .spawn_scoped(scope, || {
                maintain_presentations(&handle, presentation_inputs, &wake, presentation_incoming)
            });
        if let Err(error) = presentations {
            tracing::error!("Usage presentation preparation failed to start ({error})");
        }
        let usage = std::thread::Builder::new()
            .name("ycoding-usage-preparation".into())
            .spawn_scoped(scope, || {
                maintain_usage(&client, inputs, &wake, incoming, runtime)
            });
        if let Err(error) = usage {
            tracing::error!("Usage preparation failed to start ({error})");
        }
        while !wake.stopped.load(Ordering::Acquire) {
            let result = (|| {
                if !usage_cells::ready(&client.snapshot()?)? {
                    return Ok(None);
                }
                handle.maintain().map(Some)
            })();
            match result {
                Ok(Some(Maintenance::Pending)) => continue,
                Ok(_) => {}
                Err(error) => tracing::error!("Analytics maintenance failed ({error})"),
            }
            if matches!(
                mirror_incoming.recv_timeout(std::time::Duration::from_secs(30)),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
            ) {
                break;
            }
        }
    });
    if let Err(error) = engine.shutdown() {
        tracing::error!("analytics shutdown failed ({error:?})");
    }
}

fn maintain_presentations(
    handle: &ycoding_core::ycoding_store::analytics::Handle,
    inputs: Arc<Mutex<Option<Inputs>>>,
    wake: &Wake,
    incoming: Receiver,
) {
    while incoming.recv().is_ok() && !wake.stopped.load(Ordering::Acquire) {
        let source = inputs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(source) = source
            && let Err(error) = source.views.register_standard(crate::ids::now_millis())
        {
            tracing::error!("Usage standard recipes unavailable ({error})");
        }
        if let Err(error) = handle.prepare_presentations() {
            tracing::error!("Usage presentation worker unavailable ({error})");
        }
    }
}

fn maintain_usage(
    client: &ycoding_core::ycoding_store::Client,
    inputs: Arc<Mutex<Option<Inputs>>>,
    wake: &Wake,
    incoming: Receiver,
    runtime: Handle,
) {
    loop {
        if wake.stopped.load(Ordering::Acquire) {
            break;
        }
        let source = inputs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let Some(source) = source else {
            if incoming.recv().is_err() {
                break;
            }
            continue;
        };
        if let Some(locations) = source
            .locations
            .get()
            .and_then(|locations| locations.upgrade())
        {
            for (services, refresh) in locations.prepare_usage_locations() {
                let Some(composed) = &services.production else {
                    continue;
                };
                let reference = ycoding_core::ycoding_schema::location::Ref {
                    directory: services.info.directory.clone(),
                    workspace_id: services.info.workspace_id.clone(),
                };
                let result = if refresh {
                    source
                        .quota
                        .request_refresh(&reference, composed.generation)
                } else {
                    source
                        .quota
                        .request_preparation(&reference, composed.generation)
                };
                if let Err(error) = result {
                    tracing::error!("Usage Location preparation failed ({error})");
                }
            }
        }
        let result = match ycoding_core::ycoding_store::usage_cells::maintain(client) {
            Ok(false) => continue,
            Ok(true) => source.views.publish(),
            Err(error) => Err(error),
        };
        match result {
            Ok(false) => {}
            Err(error) => {
                tracing::error!("Usage publication failed ({error}); reads remain unavailable")
            }
            Ok(true) => {
                wake.notify_presentations();
                if let Some(locations) = source
                    .locations
                    .get()
                    .and_then(|locations| locations.upgrade())
                {
                    let sets = locations.current_sets();
                    source.quota.retain_publications(
                        &sets
                            .iter()
                            .filter_map(|set| {
                                set.production.as_ref().map(|composed| {
                                    (
                                        ycoding_core::ycoding_schema::location::Ref {
                                            directory: set.info.directory.clone(),
                                            workspace_id: set.info.workspace_id.clone(),
                                        },
                                        composed.generation,
                                    )
                                })
                            })
                            .collect::<Vec<_>>(),
                    );
                    for set in sets {
                        if wake.stopped.load(Ordering::Acquire) {
                            break;
                        }
                        let Some(composed) = &set.production else {
                            continue;
                        };
                        let reference = ycoding_core::ycoding_schema::location::Ref {
                            directory: set.info.directory.clone(),
                            workspace_id: set.info.workspace_id.clone(),
                        };
                        if !source.quota.requested(&reference, composed.generation) {
                            continue;
                        }
                        let providers = composed
                            .models
                            .catalog()
                            .providers
                            .iter()
                            .map(|record| record.provider.id.clone())
                            .collect::<Vec<_>>();
                        let now = match ycoding_core::ycoding_schema::schema::NonNegativeInt::new(
                            crate::ids::now_millis(),
                        ) {
                            Ok(now) => now,
                            Err(_) => {
                                tracing::error!("Quota publication clock unavailable");
                                break;
                            }
                        };
                        let published = runtime.block_on(async {
                            let stopped = wake.shutdown.notified();
                            tokio::pin!(stopped);
                            stopped.as_mut().enable();
                            if wake.stopped.load(Ordering::Acquire) {
                                return None;
                            }
                            tokio::select! { biased;
                                _ = stopped => None,
                                result = source.quota.publish(&source.views, &reference,
                                    composed.generation, &providers, now) => Some(result),
                            }
                        });
                        match published {
                            None => break,
                            Some(Ok(true)) => {}
                            Some(Ok(false)) => {
                                wake.notify();
                            }
                            Some(Err(error)) => {
                                tracing::error!("Quota publication failed ({error})")
                            }
                        }
                        source.quota.retain_publications(
                            &locations
                                .current_sets()
                                .iter()
                                .filter_map(|set| {
                                    set.production.as_ref().map(|composed| {
                                        (
                                            ycoding_core::ycoding_schema::location::Ref {
                                                directory: set.info.directory.clone(),
                                                workspace_id: set.info.workspace_id.clone(),
                                            },
                                            composed.generation,
                                        )
                                    })
                                })
                                .collect::<Vec<_>>(),
                        );
                    }
                }
            }
        }
        if matches!(
            incoming.recv_timeout(std::time::Duration::from_secs(30)),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
        ) {
            break;
        }
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
