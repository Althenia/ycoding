pub mod interrupted;

use super::{
    completion::Completion,
    pending::Request,
    run_coordinator::{
        Coordinator, Drain, DrainRequest, Error, InterruptReason, Outcome, RunFuture,
    },
    store::Service,
};
use crate::{job, tools::builtin::shell::JobShells};
use std::{
    future::Future,
    sync::{Arc, Mutex, OnceLock},
};
use ycoding_schema::{ObjectEncoder, location, session, session_error, session_message};
use ycoding_store::session::{NewEvent, Pending};

pub trait Runner: Send + Sync + 'static {
    fn drain(&self, request: DrainRequest) -> RunFuture;
    fn settled(&self, _id: session::Id, _outcome: Outcome) -> RunFuture {
        Box::pin(async { Ok(()) })
    }
}

pub trait Locations: Send + Sync + 'static {
    fn get(&self, location: &location::Ref) -> Result<Arc<dyn Runner>, Error>;
}

#[derive(Clone, Debug, PartialEq)]
pub enum Terminal {
    Succeeded,
    Interrupted(InterruptReason),
    Failed(session_error::Error),
}

pub fn terminal(outcome: &Outcome) -> Terminal {
    match outcome {
        Ok(()) => Terminal::Succeeded,
        Err(Error::Interrupted(reason)) => Terminal::Interrupted(*reason),
        Err(Error::Runner(error)) => Terminal::Failed(error.clone()),
        Err(error) => Terminal::Failed(session_error::Error {
            r#type: "unknown".into(),
            message: error.to_string().into(),
        }),
    }
}

static EXECUTION: OnceLock<Execution> = OnceLock::new();

pub struct Execution {
    store: Service,
    jobs: job::Jobs,
    coordinator: Coordinator,
}

impl Execution {
    pub fn install(
        store: Service,
        locations: Arc<dyn Locations>,
        jobs: job::Jobs,
    ) -> Result<&'static Self, Error> {
        let coordinator = Coordinator::new(Arc::new(RuntimeDrain {
            store: store.clone(),
            locations,
            jobs: jobs.clone(),
            active: Arc::new(Mutex::new(std::collections::BTreeMap::new())),
        }));
        EXECUTION
            .set(Self {
                store,
                jobs,
                coordinator,
            })
            .map_err(|_| Error::AlreadyInstalled)?;
        Ok(EXECUTION.get().expect("installed process-global execution"))
    }

    pub fn global() -> Option<&'static Self> {
        EXECUTION.get()
    }

    pub fn jobs(&self) -> &job::Jobs {
        &self.jobs
    }

    pub fn job_shells(&'static self) -> JobShells {
        JobShells::new(
            self.jobs.clone(),
            Arc::new(move |session_id, input| {
                Box::pin(async move {
                    let event_id = super::projector::random_event_id().map_err(io_error)?;
                    self.prompt(
                        Request {
                            id: session_message::Id::from_event(&event_id),
                            session_id,
                            input,
                            event_id,
                            created: chrono::Utc::now().timestamp_millis(),
                        },
                        None,
                    )
                    .await
                    .map(|_| ())
                    .map_err(io_error)
                })
            }),
        )
    }
    pub fn active(&self) -> Vec<session::Id> {
        self.coordinator.active()
    }

    pub fn wake(&self, id: &session::Id) -> Outcome {
        self.require(id)?;
        self.coordinator.wake(id)
    }
    pub async fn resume(&self, id: &session::Id) -> Outcome {
        self.require(id)?;
        self.coordinator.run(id).await
    }
    pub async fn interrupt(&self, id: &session::Id) -> Outcome {
        self.require(id)?;
        self.coordinator.interrupt(id, InterruptReason::User).await
    }
    pub fn request_interrupt(&self, id: &session::Id) -> Outcome {
        self.require(id)?;
        self.coordinator
            .request_interrupt(id, InterruptReason::User)
    }
    pub async fn await_idle(&self, id: &session::Id) {
        self.coordinator.await_idle(id).await
    }
    pub async fn shutdown(&self) -> Outcome {
        self.coordinator.shutdown().await
    }

    pub async fn with_transition<T>(
        &self,
        id: &session::Id,
        effect: impl Future<Output = T>,
    ) -> Result<T, Error> {
        self.require(id)?;
        self.coordinator.with_transition(id, effect).await
    }

    pub async fn prompt(&self, request: Request, resume: Option<bool>) -> Result<Pending, Error> {
        let id = request.session_id.clone();
        let admitted = self.store.admit_input(request).await?;
        if resume != Some(false) && admitted.wake {
            self.wake(&id)?;
        }
        Ok(admitted.pending)
    }

    pub async fn suspend_active(&self, now: i64) -> Outcome {
        self.store
            .suspend(&self.active(), now)
            .await
            .map_err(Error::from)
    }

    fn require(&self, id: &session::Id) -> Outcome {
        self.store.get(id)?.ok_or_else(|| {
            Error::Runner(session_error::Error {
                r#type: "not_found".into(),
                message: "Session not found".into(),
            })
        })?;
        Ok(())
    }
}

struct RuntimeDrain {
    store: Service,
    locations: Arc<dyn Locations>,
    jobs: job::Jobs,
    active: Arc<Mutex<std::collections::BTreeMap<session::Id, Arc<dyn Runner>>>>,
}
impl Drain for RuntimeDrain {
    fn drain(&self, request: DrainRequest) -> RunFuture {
        let store = self.store.clone();
        let locations = self.locations.clone();
        let active = self.active.clone();
        Box::pin(async move {
            let session = store.get(&request.session_id)?.ok_or_else(|| {
                Error::Runner(session_error::Error {
                    r#type: "not_found".into(),
                    message: "Session not found".into(),
                })
            })?;
            if !request.force && !store.has_eligible_pending(&request.session_id)? {
                return Ok(());
            }
            let runner = locations.get(&session.location)?;
            active
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(request.session_id.clone(), runner.clone());
            runner.drain(request).await
        })
    }

    fn started(&self, id: session::Id) -> RunFuture {
        let store = self.store.clone();
        Box::pin(async move { lifecycle(&store, &id, None).await.map_err(Error::from) })
    }

    fn settled(&self, id: session::Id, outcome: Outcome) -> RunFuture {
        let store = self.store.clone();
        let jobs = self.jobs.clone();
        let active = self.active.clone();
        Box::pin(async move {
            let runner = active
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&id);
            let outcome = match runner {
                Some(runner) => runner
                    .settled(id.clone(), outcome.clone())
                    .await
                    .and(outcome),
                None => outcome,
            };
            let terminal = terminal(&outcome);
            lifecycle(&store, &id, Some(terminal.clone())).await?;
            if terminal == Terminal::Succeeded {
                // The coordinator keeps the settling Session active until this settlement returns,
                // which Completion requires before it records the work.
                let coordinated =
                    Arc::new(|| Execution::global().map_or_else(Vec::new, Execution::active));
                Completion::new(store, jobs)
                    .complete(&id, coordinated)
                    .await?;
            }
            Ok(())
        })
    }
}

fn io_error(error: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(error.to_string())
}

async fn lifecycle(
    store: &Service,
    id: &session::Id,
    terminal: Option<Terminal>,
) -> Result<(), ycoding_store::Error> {
    let mut data = ObjectEncoder::new().field("sessionID", id);
    let type_ = match &terminal {
        None => "session.execution.started.1",
        Some(Terminal::Succeeded) => "session.execution.succeeded.1",
        Some(Terminal::Interrupted(reason)) => {
            data = data.field(
                "reason",
                match reason {
                    InterruptReason::User => "user",
                    InterruptReason::Shutdown => "shutdown",
                    InterruptReason::Superseded => "superseded",
                },
            );
            "session.execution.interrupted.1"
        }
        Some(Terminal::Failed(error)) => {
            data = data.field("error", error);
            "session.execution.failed.1"
        }
    };
    let event = NewEvent {
        id: super::projector::random_event_id()?.as_lossless().clone(),
        aggregate_id: id.as_lossless().clone(),
        created: chrono::Utc::now().timestamp_millis(),
        type_: type_.into(),
        data: data.finish(),
    };
    let clear_suspended = !matches!(terminal, Some(Terminal::Interrupted(_)));
    store
        .client
        .submit(move |tx| {
            if clear_suspended
                && let Some(mut row) = tx
                    .get::<ycoding_store::session::SessionTable>(&super::key(&event.aggregate_id))?
            {
                row.time_suspended = None;
                ycoding_store::session::SessionTable::put(tx, &row)?;
            }
            super::projector::append(tx, &event)?;
            Ok(())
        })?
        .await
}
