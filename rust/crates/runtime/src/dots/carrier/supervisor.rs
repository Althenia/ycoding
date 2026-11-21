mod diagnostic;
mod enroll;
mod ports;
mod run;
mod sessions;

#[cfg(test)]
mod lifecycle_tests;
#[cfg(test)]
mod sessions_tests;
#[cfg(test)]
mod tests;

pub(in crate::dots::carrier) use self::ports::Transport;
pub(crate) use self::{
    diagnostic::{Diagnostic, Diagnostics, Sink, Summary},
    ports::{Ambient, Borrowed, Boxed, Name, Source},
    sessions::{
        Connection, DETACHED_TTL_MS, Link, Opener, Peer, Registry as Sessions, Rejection, Resources,
    },
};
#[cfg(test)]
pub(crate) use self::{
    ports::{Acceptors, Registry},
    sessions::{ALREADY_ATTACHED, INTERNAL_ERROR, INVALID_REQUEST},
};

use super::{cancelled, executor, relay};
use futures_util::{FutureExt, future::Shared as SharedFuture};
use std::{
    panic::AssertUnwindSafe,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::{sync::watch, task::JoinHandle};
use ycoding_core::{
    cca::error::ExecutorError,
    dots::{access, enrollment, native},
};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PrepareError {
    Held { reason: &'static str },
    Failed(ExecutorError),
}

pub(crate) type Prepare = Box<dyn FnOnce() -> Boxed<Result<(), PrepareError>> + Send>;

#[derive(Debug)]
pub(crate) struct ServeFailed;

pub(crate) struct Opened {
    pub channel: relay::Channel,
    pub sessions: Arc<Sessions>,
    pub environment_id: String,
    pub summary: Summary,
    pub diagnostics: Diagnostics,
}

pub(crate) type Serve = Arc<dyn Fn(Opened) -> Boxed<Result<(), ServeFailed>> + Send + Sync>;

pub(in crate::dots::carrier) struct Settings {
    pub source: Source,
    pub transport: Transport,
    pub ambient: Ambient,
    pub post: enrollment::ExecutorPost,
    pub installation: executor::Installation,
    pub state_path: PathBuf,
    pub hostname: String,
    pub home: PathBuf,
    pub data: PathBuf,
    pub detached_ttl_ms: u64,
    pub diagnostic: Sink,
    pub prepare: Prepare,
    pub serve: Serve,
}

struct Shared {
    source: Source,
    transport: Transport,
    ambient: Ambient,
    post: enrollment::ExecutorPost,
    installation: executor::Installation,
    state_path: PathBuf,
    hostname: String,
    roots: Vec<executor::Root>,
    detached_ttl_ms: u64,
    diagnostics: Diagnostics,
    serve: Serve,
    connection: Arc<Mutex<ConnectionObservation>>,
}

struct ConnectionObservation {
    configuration: Option<native::Configuration>,
    status: access::TransportStatus,
}

impl ConnectionObservation {
    fn new() -> Self {
        Self {
            configuration: None,
            status: off_status(),
        }
    }
}

fn off_status() -> access::TransportStatus {
    access::TransportStatus {
        state: "off".into(),
        hostname: None,
        name: None,
        problem: None,
    }
}

impl Shared {
    fn observe_connection(&self, status: access::TransportStatus) {
        self.connection
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .status = status;
    }
}

struct Run {
    cancel: watch::Sender<bool>,
    task: JoinHandle<Result<(), CleanupError>>,
    sessions: Arc<Sessions>,
}

struct Control {
    selected: Option<native::Configuration>,
    run: Option<Run>,
}

impl Control {
    async fn halt(&mut self) -> Result<(), CleanupError> {
        let mut failures = Vec::new();
        if let Some(run) = self.run.as_mut() {
            run.cancel.send_replace(true);
            match (&mut run.task).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => failures.extend(error.failures),
                Err(_) => {
                    failures.push(CleanupFailure::RunJoin);
                    if let Err(error) = run.sessions.shutdown().await {
                        failures.extend(error.failures);
                    }
                }
            }
        }
        self.run = None;
        CleanupError::result(failures)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CleanupFailure {
    Rendezvous(super::rendezvous::CleanupFailed),
    FollowerJoin,
    RunJoin,
    ResourceClose,
    ResourceJoin,
    TimerJoin,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CleanupError {
    pub failures: Vec<CleanupFailure>,
}

impl CleanupError {
    fn result(failures: Vec<CleanupFailure>) -> Result<(), Self> {
        if failures.is_empty() {
            Ok(())
        } else {
            Err(Self { failures })
        }
    }
}

pub(crate) struct Supervisor {
    subscription: Mutex<Option<native::Subscription>>,
    stop: watch::Sender<bool>,
    completion: SharedFuture<Boxed<Result<(), CleanupError>>>,
    connection: Arc<Mutex<ConnectionObservation>>,
    configuration: Arc<dyn Fn() -> Result<native::Configuration, access::Error> + Send + Sync>,
}

impl Supervisor {
    pub(in crate::dots::carrier) async fn start(
        settings: Settings,
    ) -> Result<Arc<Self>, PrepareError> {
        (settings.prepare)().await?;
        let connection = Arc::new(Mutex::new(ConnectionObservation::new()));
        let configuration = settings.source.configuration.clone();
        let shared = Arc::new(Shared {
            roots: executor::capability_roots(&settings.home, &settings.data),
            diagnostics: Diagnostics::new(settings.diagnostic),
            source: settings.source,
            transport: settings.transport,
            ambient: settings.ambient,
            post: settings.post,
            installation: settings.installation,
            state_path: settings.state_path,
            hostname: settings.hostname,
            detached_ttl_ms: settings.detached_ttl_ms,
            serve: settings.serve,
            connection: connection.clone(),
        });
        let (changes, observed) = watch::channel(0u64);
        let subscription = (shared.source.subscribe)(Arc::new(move || {
            changes.send_modify(|count| *count += 1);
        }));
        let (stop, stopped) = watch::channel(false);
        let final_connection = connection.clone();
        let follower = tokio::spawn(async move {
            let mut control = Control {
                selected: None,
                run: None,
            };
            let outcome = AssertUnwindSafe(Self::follow(shared, &mut control, observed, stopped))
                .catch_unwind()
                .await;
            let mut failures = match outcome {
                Ok(Ok(())) => Vec::new(),
                Ok(Err(error)) => error.failures,
                Err(_) => vec![CleanupFailure::FollowerJoin],
            };
            if let Err(error) = control.halt().await {
                failures.extend(error.failures);
            }
            final_connection
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .status = if failures.is_empty() {
                off_status()
            } else {
                access::TransportStatus {
                    state: "error".into(),
                    ..off_status()
                }
            };
            CleanupError::result(failures)
        });
        let completion: Boxed<Result<(), CleanupError>> = Box::pin(async move {
            follower.await.unwrap_or_else(|_| {
                Err(CleanupError {
                    failures: vec![CleanupFailure::FollowerJoin],
                })
            })
        });
        let supervisor = Arc::new(Self {
            subscription: Mutex::new(Some(subscription)),
            stop,
            completion: completion.shared(),
            connection,
            configuration,
        });
        Ok(supervisor)
    }

    pub(crate) fn connection_status(&self) -> access::TransportStatus {
        if *self.stop.borrow() {
            return off_status();
        }
        let configuration = match (self.configuration)() {
            Ok(configuration @ native::Configuration::Enabled { .. }) => configuration,
            Ok(native::Configuration::Disabled) => return off_status(),
            Err(_) => {
                return access::TransportStatus {
                    state: "error".into(),
                    problem: Some(access::Problem::Configuration),
                    ..off_status()
                };
            }
        };
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if connection.configuration.as_ref() != Some(&configuration) {
            return access::TransportStatus::connecting();
        }
        connection.status.clone()
    }

    pub(crate) async fn shutdown(&self) -> Result<(), CleanupError> {
        drop(
            self.subscription
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take(),
        );
        self.stop.send_replace(true);
        self.completion.clone().await
    }

    async fn follow(
        shared: Arc<Shared>,
        control: &mut Control,
        mut changes: watch::Receiver<u64>,
        mut stopped: watch::Receiver<bool>,
    ) -> Result<(), CleanupError> {
        loop {
            if *stopped.borrow() {
                break;
            }
            Self::reconcile(&shared, control, &stopped).await?;
            tokio::select! {
                biased;
                _ = cancelled(&mut stopped) => break,
                changed = changes.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    changes.borrow_and_update();
                }
            }
        }
        Ok(())
    }

    async fn reconcile(
        shared: &Arc<Shared>,
        control: &mut Control,
        stopped: &watch::Receiver<bool>,
    ) -> Result<(), CleanupError> {
        let selected = (shared.source.configuration)()
            .ok()
            .filter(|configuration| matches!(configuration, native::Configuration::Enabled { .. }));
        if selected == control.selected {
            return Ok(());
        }
        control.halt().await?;
        {
            let mut connection = shared
                .connection
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            connection.configuration = selected.clone();
            connection.status = off_status();
        }
        if *stopped.borrow() {
            return Ok(());
        }
        control.selected = selected.clone();
        let Some(configuration) = selected else {
            return Ok(());
        };
        shared.observe_connection(access::TransportStatus::connecting());
        let (cancel, observed) = watch::channel(false);
        let sessions = Sessions::new(
            shared.ambient.clock.clone(),
            shared.detached_ttl_ms,
            shared.diagnostics.clone(),
        );
        let task = tokio::spawn(run::serve(
            shared.clone(),
            configuration,
            observed,
            sessions.clone(),
        ));
        control.run = Some(Run {
            cancel,
            task,
            sessions,
        });
        Ok(())
    }
}
