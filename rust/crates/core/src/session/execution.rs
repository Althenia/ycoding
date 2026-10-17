pub mod interrupted;

use super::{
    autonomy,
    completion::Completion,
    orchestration,
    pending::Request,
    review_fold,
    run_coordinator::{
        Coordinator, Drain, DrainRequest, Error, InterruptReason, Outcome, RunFuture,
    },
    store::Service,
};
use crate::{job, tools::builtin::shell::JobShells};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, OnceLock},
};
use ycoding_schema::{
    ObjectEncoder, location, session, session_error, session_message, session_pending,
    session_review::Kind,
};
use ycoding_store::session::{NewEvent, Pending, TaskTable};

pub type PrepareInputFuture<'a> =
    Pin<Box<dyn Future<Output = Result<session_pending::Message, Error>> + Send + 'a>>;

pub trait Runner: Send + Sync + 'static {
    fn prepare_input(&self, input: session_pending::Message) -> PrepareInputFuture<'_> {
        Box::pin(async move { Ok(input) })
    }
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
    locations: Arc<dyn Locations>,
    jobs: job::Jobs,
    coordinator: Coordinator,
}

impl Execution {
    pub fn install(
        store: Service,
        locations: Arc<dyn Locations>,
        jobs: job::Jobs,
        steer: Option<Arc<dyn autonomy::Steer>>,
    ) -> Result<&'static Self, Error> {
        let coordinator = Coordinator::new(Arc::new(RuntimeDrain {
            store: store.clone(),
            locations: locations.clone(),
            jobs: jobs.clone(),
            steer,
            orchestration: orchestration::Service::new(store.clone(), Arc::new(ProcessExecution)),
            active: Arc::new(Mutex::new(std::collections::BTreeMap::new())),
        }));
        EXECUTION
            .set(Self {
                store,
                locations,
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

    pub fn coordinator(&self) -> &Coordinator {
        &self.coordinator
    }

    pub fn job_shells(&'static self) -> JobShells {
        JobShells::new(self.jobs.clone(), self.notice_delivery(None))
            .with_quiet_delivery(self.notice_delivery(Some(false)))
    }
    fn notice_delivery(
        &'static self,
        resume: Option<bool>,
    ) -> crate::tools::builtin::shell::Deliver {
        Arc::new(move |session_id, input| {
            Box::pin(async move {
                let event_id = super::projector::random_event_id().map_err(io_error)?;
                self.prompt_with_origin(
                    Request {
                        id: session_message::Id::from_event(&event_id),
                        session_id,
                        input,
                        event_id,
                        created: chrono::Utc::now().timestamp_millis(),
                    },
                    resume,
                    autonomy::Origin::Runtime,
                )
                .await
                .map(|_| ())
                .map_err(notice_error)
            })
        })
    }
    pub fn active(&self) -> Vec<session::Id> {
        self.coordinator.active()
    }

    pub fn wake(&self, id: &session::Id) -> Outcome {
        self.require(id)?;
        match recovery_gate(&self.store, id) {
            Err(Error::Runner(error)) if error.r#type.as_str() == Some("recovery_required") => {
                return Ok(());
            }
            result => result?,
        }
        self.coordinator.wake(id)
    }
    pub async fn resume(&self, id: &session::Id) -> Outcome {
        self.require(id)?;
        recovery_gate(&self.store, id)?;
        self.coordinator.run(id).await
    }
    pub async fn request_resume(&self, id: &session::Id) -> Outcome {
        self.require(id)?;
        recovery_gate(&self.store, id)?;
        self.coordinator.request_resume(id).await
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
        self.prompt_with_origin(request, resume, autonomy::Origin::User)
            .await
    }

    pub async fn prompt_with_origin(
        &self,
        mut request: Request,
        resume: Option<bool>,
        origin: autonomy::Origin,
    ) -> Result<Pending, Error> {
        let prior = self.store.pending(&request.id)?.is_some()
            || self.store.message(&request.id)?.is_some();
        if !prior
            && matches!(
                &request.input,
                session_pending::Message::User(user)
                    if user.data.text.code_units().any(|unit| unit == u16::from(b'$'))
            )
            && let Some(session) = self.store.get(&request.session_id)?
        {
            request.input = self
                .locations
                .get(&session.location)?
                .prepare_input(request.input)
                .await?;
        }
        let id = request.session_id.clone();
        let admitted = autonomy::Service::new(self.store.client.clone())
            .admit(&self.store, request, None, origin)
            .await
            .map_err(|error| match error {
                autonomy::Error::Store(error) => Error::from(error),
                autonomy::Error::NotFound(_) => Error::from(ycoding_store::Error::Domain {
                    kind: "not_found",
                    message: "Session not found",
                }),
            })?;
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
    steer: Option<Arc<dyn autonomy::Steer>>,
    orchestration: orchestration::Service,
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
            if let Some(task) = store
                .client
                .snapshot()?
                .get::<TaskTable>(&super::key(request.session_id.as_lossless()))?
                && task.state.as_str() != Some("running")
            {
                tracing::warn!(
                    sessionID = %String::from_utf16_lossy(&request.session_id.as_lossless().code_units().collect::<Vec<_>>()),
                    state = %String::from_utf16_lossy(&task.state.code_units().collect::<Vec<_>>()),
                    "Session drain skipped for non-running managed task"
                );
                return Ok(());
            }
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
        let orchestration = self.orchestration.clone();
        Box::pin(async move {
            recovery_gate(&store, &id)?;
            lifecycle(&store, &id, None).await?;
            orchestration
                .dispatch_restart_losses(&id)
                .await
                .map_err(orchestration_error)?;
            Ok(())
        })
    }

    fn settled(&self, id: session::Id, outcome: Outcome) -> RunFuture {
        let store = self.store.clone();
        let jobs = self.jobs.clone();
        let active = self.active.clone();
        let steer = self.steer.clone();
        let orchestration = self.orchestration.clone();
        Box::pin(async move {
            if matches!(&outcome, Err(Error::Runner(error)) if error.r#type.as_str() == Some("recovery_required"))
            {
                return Ok(());
            }
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
            let advanced = if terminal == Terminal::Succeeded {
                match steer {
                    Some(steer) => {
                        let result = async {
                            let text = latest_assistant_text(&store, &id)?;
                            autonomy::prepare_continuation(
                                &autonomy::Service::new(store.client.clone()),
                                &store,
                                steer.as_ref(),
                                &id,
                                text,
                                jobs.outstanding_sessions().contains(&id),
                            )
                            .await
                        }
                        .await;
                        match result {
                            Ok(advanced) => advanced,
                            Err(error) => {
                                tracing::warn!(sessionID = %String::from_utf16_lossy(&id.as_lossless().code_units().collect::<Vec<_>>()), error = %error, "Failed to continue the autonomous goal");
                                None
                            }
                        }
                    }
                    None => None,
                }
            } else {
                None
            };
            lifecycle(&store, &id, Some(terminal.clone())).await?;
            if terminal == Terminal::Succeeded {
                let coordinated =
                    Arc::new(|| Execution::global().map_or_else(Vec::new, Execution::active));
                Completion::new(store.clone(), jobs)
                    .complete(&id, coordinated)
                    .await?;
            }
            if let Err(error) = settle_task(&store, &id, &terminal).await {
                tracing::error!(sessionID = %String::from_utf16_lossy(&id.as_lossless().code_units().collect::<Vec<_>>()), error = %error, "Failed to settle managed child task");
            }
            if let Err(error) = orchestration.dispatch_notifications().await {
                tracing::error!(sessionID = %String::from_utf16_lossy(&id.as_lossless().code_units().collect::<Vec<_>>()), error = %error, "Failed to dispatch subagent notifications");
            }
            if let Some(advanced) = advanced {
                match advanced.admit(&store, &id).await {
                    Ok(admitted) if admitted.wake => {
                        orchestration::Execution::wake(&ProcessExecution, &id)?
                    }
                    Ok(_) => {}
                    Err(error) => {
                        tracing::warn!(sessionID = %String::from_utf16_lossy(&id.as_lossless().code_units().collect::<Vec<_>>()), error = %error, "Failed to queue autonomous goal continuation")
                    }
                }
            }
            Ok(())
        })
    }
}

fn recovery_gate(store: &Service, id: &session::Id) -> Outcome {
    let snapshot = store.client.snapshot()?;
    if snapshot
        .get::<TaskTable>(&super::key(id.as_lossless()))?
        .is_none()
    {
        return Ok(());
    }
    if review_fold::fold(&snapshot, &[id.as_lossless().clone()])?
        .iter()
        .any(|item| {
            item.deferral.kind == Kind::Recovery && (item.is_open() || item.is_stopped_recovery())
        })
    {
        return Err(Error::Runner(session_error::Error {
            r#type: "recovery_required".into(),
            message:
                "Only the user can continue this subagent through its restart recovery review."
                    .into(),
        }));
    }
    Ok(())
}

struct ProcessExecution;

impl orchestration::Execution for ProcessExecution {
    fn wake(&self, id: &session::Id) -> Outcome {
        Execution::global().ok_or(Error::Closed)?.wake(id)
    }

    fn resume(&self, id: &session::Id) -> RunFuture {
        let id = id.clone();
        Box::pin(async move {
            Execution::global()
                .ok_or(Error::Closed)?
                .request_resume(&id)
                .await
        })
    }

    fn interrupt(&self, id: &session::Id) -> RunFuture {
        let id = id.clone();
        Box::pin(async move {
            Execution::global()
                .ok_or(Error::Closed)?
                .interrupt(&id)
                .await
        })
    }
}

fn latest_assistant_text(
    store: &Service,
    id: &session::Id,
) -> Result<Option<String>, ycoding_store::Error> {
    let Some(session_message::Info::Assistant(assistant)) = store.latest(id, "assistant")? else {
        return Ok(None);
    };
    assistant
        .content
        .into_iter()
        .try_fold(String::new(), |mut text, part| {
            if let session_message::AssistantContent::Text(part) = part {
                text.push_str(
                    &part
                        .text
                        .to_utf8()
                        .map_err(|error| ycoding_store::Error::Record(Box::new(error)))?,
                );
            }
            Ok(text)
        })
        .map(Some)
}

async fn settle_task(
    store: &Service,
    id: &session::Id,
    terminal: &Terminal,
) -> Result<(), ycoding_store::Error> {
    if !store
        .client
        .snapshot()?
        .get::<TaskTable>(&super::key(id.as_lossless()))?
        .is_some_and(|task| task.state.as_str() == Some("running"))
    {
        return Ok(());
    }
    let change = match terminal {
        Terminal::Interrupted(_) => return Ok(()),
        Terminal::Succeeded => ycoding_schema::session_orchestration::Change::Completed {
            excerpt: latest_assistant_text(store, id)?
                .map(|text| orchestration::truncate_utf8(&text, 16 * 1024).into()),
        },
        Terminal::Failed(error) => {
            let message = error
                .message
                .to_utf8()
                .map_err(|error| ycoding_store::Error::Record(Box::new(error)))?;
            let error = orchestration::truncate_utf8(&message, 16 * 1024);
            ycoding_schema::session_orchestration::Change::Failed {
                error: error.into(),
                excerpt: Some(error.into()),
            }
        }
    };
    let event = NewEvent {
        id: super::projector::random_event_id()?.as_lossless().clone(),
        aggregate_id: id.as_lossless().clone(),
        created: chrono::Utc::now().timestamp_millis(),
        type_: "session.task.updated.1".into(),
        data: ObjectEncoder::new()
            .field("sessionID", id)
            .field("change", &change)
            .finish(),
    };
    store
        .client
        .submit(move |tx| {
            if tx
                .get::<TaskTable>(&super::key(&event.aggregate_id))?
                .is_some_and(|task| task.state.as_str() == Some("running"))
            {
                super::projector::append(tx, &event)?;
            }
            Ok(())
        })?
        .await
}

fn orchestration_error(error: orchestration::Error) -> Error {
    match error {
        orchestration::Error::Store(error) => error.into(),
        orchestration::Error::Execution(error) => error,
        error => Error::Runner(session_error::Error {
            r#type: "unknown".into(),
            message: error.to_string().into(),
        }),
    }
}

fn notice_error(error: Error) -> std::io::Error {
    let missing = match &error {
        Error::Store(store) => matches!(
            store.as_ref(),
            ycoding_store::Error::Domain {
                kind: "not_found",
                ..
            }
        ),
        Error::Runner(runner) => runner.r#type.as_str() == Some("not_found"),
        _ => false,
    };
    std::io::Error::new(
        if missing {
            std::io::ErrorKind::NotFound
        } else {
            std::io::ErrorKind::Other
        },
        error.to_string(),
    )
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
