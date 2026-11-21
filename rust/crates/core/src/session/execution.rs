pub mod interrupted;
#[cfg(test)]
mod plugin_admission_tests;

use super::{
    autonomy,
    completion::Completion,
    orchestration,
    pending::Request,
    review_fold,
    run_coordinator::{
        Coordinator, Drain, DrainRequest, Error, InterruptReason, Outcome, RunFuture,
        TransitionGuard,
    },
    store::Service,
};
use crate::{event_feed, job, platform::shell::ledger, tools::builtin::shell::JobShells};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    ops::Bound,
    pin::Pin,
    sync::{Arc, Mutex, OnceLock},
};
use ycoding_schema::{
    LosslessString, ObjectEncoder, location, session, session_error, session_message,
    session_pending, session_review::Kind, session_status_event,
};
use ycoding_store::{
    IndexOrder, IndexQuery,
    session::{NewEvent, Pending, PendingTable, TaskTable},
};

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
    fn get(&self, session: &session::Info) -> Result<Arc<dyn Runner>, Error>;
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
    status: Arc<OnceLock<event_feed::Feed>>,
    successors: Arc<Mutex<SuccessorDrain>>,
}

impl Execution {
    pub fn install(
        store: Service,
        locations: Arc<dyn Locations>,
        jobs: job::Jobs,
        steer: Option<Arc<dyn autonomy::Steer>>,
    ) -> Result<&'static Self, Error> {
        let status = Arc::new(OnceLock::new());
        let successors = Arc::new(Mutex::new(SuccessorDrain::default()));
        let coordinator = Coordinator::new(Arc::new(RuntimeDrain {
            store: store.clone(),
            locations: locations.clone(),
            jobs: jobs.clone(),
            steer,
            orchestration: orchestration::Service::new(store.clone(), Arc::new(ProcessExecution)),
            active: Arc::new(Mutex::new(std::collections::BTreeMap::new())),
            status: status.clone(),
            successors: successors.clone(),
        }));
        EXECUTION
            .set(Self {
                store,
                locations,
                jobs,
                coordinator,
                status,
                successors,
            })
            .map_err(|_| Error::AlreadyInstalled)?;
        Ok(EXECUTION.get().expect("installed process-global execution"))
    }

    pub fn global() -> Option<&'static Self> {
        EXECUTION.get()
    }

    pub fn bind_status(&self, feed: event_feed::Feed) -> Result<(), String> {
        self.status
            .set(feed)
            .map_err(|_| "Session status feed is already bound".to_owned())
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
        self.successors
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .woken
            .insert(id.clone());
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
        self.successors
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .request_stop(id);
        self.coordinator.interrupt(id, InterruptReason::User).await
    }
    pub fn request_interrupt(&self, id: &session::Id) -> Outcome {
        self.require(id)?;
        self.successors
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .request_stop(id);
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

    pub async fn transition(&self, id: &session::Id) -> Result<TransitionGuard, Error> {
        self.require(id)?;
        self.coordinator.transition(id).await
    }

    pub async fn prompt(&self, request: Request, resume: Option<bool>) -> Result<Pending, Error> {
        self.prompt_with_origin(request, resume, autonomy::Origin::User)
            .await
    }

    pub async fn prompt_with_origin(
        &self,
        request: Request,
        resume: Option<bool>,
        origin: autonomy::Origin,
    ) -> Result<Pending, Error> {
        self.prompt_checked(request, resume, origin, None, None)
            .await
    }

    pub(crate) async fn prompt_plugin(
        &self,
        request: Request,
        resume: Option<bool>,
        runner: &super::runner::Local,
    ) -> Result<Pending, Error> {
        self.prompt_checked(
            request,
            resume,
            autonomy::Origin::Plugin,
            None,
            Some((runner.location(), runner)),
        )
        .await
    }

    pub async fn prompt_native(
        &self,
        request: Request,
        resume: Option<bool>,
        admission: crate::dots::Admission,
    ) -> Result<Pending, Error> {
        admission.validate(&self.store, Some(&request.session_id))?;
        self.prompt_checked(
            request,
            resume,
            autonomy::Origin::User,
            Some(super::pending::CheckedAdmission::Native(Box::new(
                admission,
            ))),
            None,
        )
        .await
    }

    pub async fn prompt_coordination(
        &self,
        request: Request,
        resume: Option<bool>,
        admission: crate::coordination::Admission,
    ) -> Result<Pending, Error> {
        let claim = admission.clone();
        let target = request.clone();
        self.store
            .client
            .submit(move |tx| super::pending::validate_coordination_in(tx, &target, &claim))?
            .await?;
        self.prompt_checked(
            request,
            resume,
            autonomy::Origin::Runtime,
            Some(super::pending::CheckedAdmission::Coordination(Box::new(
                admission,
            ))),
            None,
        )
        .await
    }

    async fn prompt_checked(
        &self,
        mut request: Request,
        resume: Option<bool>,
        origin: autonomy::Origin,
        admission: Option<super::pending::CheckedAdmission>,
        scoped_runner: Option<(&location::Ref, &dyn Runner)>,
    ) -> Result<Pending, Error> {
        let prior = self.store.pending(&request.id)?.is_some()
            || self.store.message(&request.id)?.is_some();
        if !prior && let session_pending::Message::User(user) = &mut request.input {
            // Only orchestration's internal snapshot composer can establish this
            // provenance. Strip caller claims before skill preparation; admission
            // reconciliation still returns the original durable record on retries.
            let mut admitted = ycoding_schema::JsonObject::new();
            for (key, value) in user
                .data
                .metadata
                .as_ref()
                .into_iter()
                .flat_map(|metadata| metadata.iter())
            {
                if !matches!(
                    key.as_str(),
                    Some(
                        "sharedContext"
                            | "nativeSource"
                            | "inputOrigin"
                            | "coordination"
                            | "remoteMcp"
                    )
                ) {
                    admitted.insert(key.clone(), value.clone());
                }
            }
            use ycoding_schema::DomainEncode;
            admitted.insert(
                "inputOrigin".into(),
                match origin {
                    autonomy::Origin::User => "direct",
                    autonomy::Origin::Subagent => "subagent",
                    autonomy::Origin::Plugin => "plugin",
                    autonomy::Origin::Review => "review",
                    autonomy::Origin::Runtime => "runtime",
                }
                .encode(),
            );
            if let Some(super::pending::CheckedAdmission::Native(native)) = &admission
                && let Some(source) = native.source()
            {
                admitted.insert("nativeSource".into(), source.encode());
            }
            user.data.metadata = Some(admitted);
        }
        if !prior
            && matches!(
                &request.input,
                session_pending::Message::User(user)
                    if user.data.text.code_units().any(|unit| unit == u16::from(b'$'))
            )
            && let Some(session) = self.store.get(&request.session_id)?
        {
            request.input =
                match scoped_runner.filter(|(location, _)| *location == &session.location) {
                    Some((_, runner)) => runner.prepare_input(request.input).await?,
                    None => {
                        self.locations
                            .get(&session)?
                            .prepare_input(request.input)
                            .await?
                    }
                };
        }
        let id = request.session_id.clone();
        let admitted = autonomy::Service::new(self.store.client.clone())
            .admit_checked(&self.store, request, None, origin, admission)
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

const FAILED_SUCCESSOR_LIMIT: u8 = 3;

#[derive(Default)]
struct SuccessorDrain {
    failed: BTreeMap<session::Id, (u8, BTreeSet<LosslessString>)>,
    stop_requested: BTreeSet<session::Id>,
    snapshots: BTreeMap<session::Id, BTreeSet<LosslessString>>,
    woken: BTreeSet<session::Id>,
}

impl SuccessorDrain {
    fn begin(&mut self, id: &session::Id, ids: BTreeSet<LosslessString>) {
        self.woken.remove(id);
        self.stop_requested.remove(id);
        self.snapshots.insert(id.clone(), ids);
    }

    fn request_stop(&mut self, id: &session::Id) {
        self.stop_requested.insert(id.clone());
    }

    fn clear(&mut self, id: &session::Id) {
        self.failed.remove(id);
        self.snapshots.remove(id);
        self.stop_requested.remove(id);
    }

    fn retry(
        &mut self,
        id: &session::Id,
        has_task: bool,
        current: &BTreeSet<LosslessString>,
    ) -> bool {
        let snapshot = self.snapshots.remove(id);
        if self.stop_requested.contains(id) {
            return false;
        }
        let Some(snapshot) = snapshot.filter(|snapshot| !snapshot.is_empty()) else {
            return false;
        };
        if has_task {
            return false;
        }
        if current.is_empty() {
            self.failed.remove(id);
            return false;
        }
        if snapshot.iter().any(|pending| !current.contains(pending)) {
            return false;
        }
        let count = match self.failed.get(id) {
            Some((count, ids)) if ids == current => *count + 1,
            _ => 1,
        };
        self.failed.insert(id.clone(), (count, current.clone()));
        count <= FAILED_SUCCESSOR_LIMIT
    }
}

fn pending_input_ids(
    store: &Service,
    id: &session::Id,
) -> Result<BTreeSet<LosslessString>, ycoding_store::Error> {
    let snapshot = store.client.snapshot()?;
    let prefix = super::key(id.as_lossless());
    let mut after = None;
    let mut ids = BTreeSet::new();
    loop {
        let rows = snapshot.index_range::<PendingTable>(
            "session_pending_session_admitted_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: after.as_ref(),
                limit: 128,
            },
        )?;
        if rows.is_empty() {
            return Ok(ids);
        }
        after = rows.last().map(|row| row.cursor.clone());
        ids.extend(
            rows.into_iter()
                .filter(|row| row.record.type_.as_str() != Some("compaction"))
                .map(|row| row.record.id),
        );
    }
}

fn retry_failed_pending(
    store: &Service,
    successors: &Mutex<SuccessorDrain>,
    id: &session::Id,
) -> Result<bool, ycoding_store::Error> {
    let has_task = store
        .client
        .snapshot()?
        .get::<TaskTable>(&super::key(id.as_lossless()))?
        .is_some();
    let current = pending_input_ids(store, id)?;
    Ok(successors
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .retry(id, has_task, &current))
}

struct RuntimeDrain {
    store: Service,
    locations: Arc<dyn Locations>,
    jobs: job::Jobs,
    steer: Option<Arc<dyn autonomy::Steer>>,
    orchestration: orchestration::Service,
    active: Arc<Mutex<std::collections::BTreeMap<session::Id, Arc<dyn Runner>>>>,
    status: Arc<OnceLock<event_feed::Feed>>,
    successors: Arc<Mutex<SuccessorDrain>>,
}
impl Drain for RuntimeDrain {
    fn drain(&self, request: DrainRequest) -> RunFuture {
        let store = self.store.clone();
        let locations = self.locations.clone();
        let active = self.active.clone();
        let successors = self.successors.clone();
        Box::pin(async move {
            successors
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .begin(
                    &request.session_id,
                    pending_input_ids(&store, &request.session_id)?,
                );
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
            {
                if task.state.as_str() != Some("running") {
                    tracing::warn!(
                        sessionID = %String::from_utf16_lossy(&request.session_id.as_lossless().code_units().collect::<Vec<_>>()),
                        state = %String::from_utf16_lossy(&task.state.code_units().collect::<Vec<_>>()),
                        "Session drain skipped for non-running managed task"
                    );
                    return Ok(());
                }
                if let Some(owner_pid) = task.owner_pid
                    && ledger::current_owner().is_none_or(|owner| {
                        i64::from(owner.pid) != owner_pid
                            || task.owner_started.as_ref().and_then(LosslessString::as_str)
                                != Some(owner.started.as_str())
                    })
                {
                    tracing::warn!(
                        sessionID = %String::from_utf16_lossy(&request.session_id.as_lossless().code_units().collect::<Vec<_>>()),
                        ownerPid = owner_pid,
                        "Session drain skipped for a managed task claimed by another process"
                    );
                    return Ok(());
                }
            }
            if !request.force && !store.has_eligible_pending(&request.session_id)? {
                return Ok(());
            }
            let runner = locations.get(&session)?;
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
        let status = self.status.clone();
        Box::pin(async move {
            recovery_gate(&store, &id)?;
            lifecycle(&store, &id, None).await?;
            publish_status(&store, &status, &id);
            orchestration
                .dispatch_restart_losses(&id)
                .await
                .map_err(orchestration_error)?;
            Ok(())
        })
    }

    fn after_settled(&self, id: session::Id) -> RunFuture {
        let store = self.store.clone();
        let status = self.status.clone();
        Box::pin(async move {
            publish_status(&store, &status, &id);
            Ok(())
        })
    }

    fn settled(&self, id: session::Id, outcome: Outcome) -> RunFuture {
        let store = self.store.clone();
        let jobs = self.jobs.clone();
        let active = self.active.clone();
        let steer = self.steer.clone();
        let orchestration = self.orchestration.clone();
        let successors = self.successors.clone();
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
            let advanced = if !matches!(terminal, Terminal::Interrupted(_)) {
                match steer {
                    Some(steer) => {
                        let result = async {
                            let error = match &terminal {
                                Terminal::Failed(error) => Some(error.clone()),
                                _ => latest_assistant_error(&store, &id)?,
                            };
                            if let Some(error) = error {
                                autonomy::prepare_failure(
                                    &autonomy::Service::new(store.client.clone()),
                                    &store,
                                    steer.as_ref(),
                                    &id,
                                    &error,
                                    latest_assistant_text(&store, &id)?,
                                )
                                .await
                            } else {
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
            if let Err(error) = settle_task(&store, &id, &terminal, successors.clone()).await {
                tracing::error!(sessionID = %String::from_utf16_lossy(&id.as_lossless().code_units().collect::<Vec<_>>()), error = %error, "Failed to settle managed child task");
            }
            if let Err(error) = orchestration.dispatch_notifications().await {
                tracing::error!(sessionID = %String::from_utf16_lossy(&id.as_lossless().code_units().collect::<Vec<_>>()), error = %error, "Failed to dispatch subagent notifications");
            }
            if matches!(terminal, Terminal::Failed(_)) {
                match retry_failed_pending(&store, &successors, &id) {
                    Ok(true) => {
                        if let Err(error) = orchestration::Execution::wake(&ProcessExecution, &id) {
                            tracing::warn!(sessionID = %String::from_utf16_lossy(&id.as_lossless().code_units().collect::<Vec<_>>()), error = %error, "Failed to schedule a successor drain for pending inputs");
                        }
                    }
                    Ok(false) => {}
                    Err(error) => {
                        tracing::warn!(sessionID = %String::from_utf16_lossy(&id.as_lossless().code_units().collect::<Vec<_>>()), error = %error, "Failed to schedule a successor drain for pending inputs");
                    }
                }
            } else {
                successors
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .clear(&id);
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

fn publish_status(store: &Service, status: &OnceLock<event_feed::Feed>, id: &session::Id) {
    let Some(feed) = status.get() else {
        return;
    };
    let Ok(Some(session)) = store.get(id) else {
        return;
    };
    let busy = Execution::global().is_some_and(|execution| execution.active().contains(id));
    let data = event_feed::Data::SessionStatus(Box::new(session_status_event::StatusData {
        session_id: id.clone(),
        status: if busy {
            session_status_event::Info::Busy
        } else {
            session_status_event::Info::Idle
        },
    }));
    if let Err(error) = feed.emit(data, Some(session.location)) {
        tracing::warn!(error = %error, "Failed to publish Session status");
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

pub struct ProcessExecution;

impl super::goal_decisions::Execution for ProcessExecution {
    fn active(&self) -> Vec<session::Id> {
        Execution::global().map_or_else(Vec::new, Execution::active)
    }

    fn wake(&self, id: &session::Id) -> Result<(), String> {
        Execution::global()
            .ok_or(Error::Closed)
            .and_then(|execution| execution.wake(id))
            .map_err(|error| error.to_string())
    }
}

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

fn latest_assistant_error(
    store: &Service,
    id: &session::Id,
) -> Result<Option<session_error::Error>, ycoding_store::Error> {
    let Some(session_message::Info::Assistant(assistant)) = store.latest(id, "assistant")? else {
        return Ok(None);
    };
    Ok(assistant.error)
}

fn latest_assistant_excerpt(
    store: &Service,
    id: &session::Id,
) -> Result<Option<LosslessString>, ycoding_store::Error> {
    let Some(session_message::Info::Assistant(assistant)) = store.latest(id, "assistant")? else {
        return Ok(None);
    };
    let text = super::runner::unfinished_ending::excerpt_text(&assistant)
        .to_utf8()
        .map_err(|error| ycoding_store::Error::Record(Box::new(error)))?;
    Ok(Some(orchestration::truncate_utf8(&text, 16 * 1024).into()))
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
    successors: Arc<Mutex<SuccessorDrain>>,
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
            excerpt: latest_assistant_excerpt(store, id)?,
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
    let id = id.clone();
    let succeeded = matches!(terminal, Terminal::Succeeded);
    store
        .client
        .submit(move |tx| {
            let successors = successors.lock().unwrap_or_else(|error| error.into_inner());
            let key = super::key(&event.aggregate_id);
            if !tx
                .get::<TaskTable>(&key)?
                .is_some_and(|task| task.state.as_str() == Some("running"))
            {
                return Ok(());
            }
            if succeeded
                && (successors.woken.contains(&id)
                    || !tx
                        .index_range::<PendingTable>(
                            "session_pending_session_admitted_seq_idx",
                            IndexQuery {
                                lower: Bound::Unbounded,
                                upper: Bound::Unbounded,
                                prefix: Some(&key),
                                order: IndexOrder::Ascending,
                                after: None,
                                limit: 1,
                            },
                        )?
                        .is_empty())
            {
                return Ok(());
            }
            super::projector::append(tx, &event)?;
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

#[cfg(test)]
mod successor_tests {
    use super::SuccessorDrain;
    use std::collections::BTreeSet;
    use ycoding_schema::{LosslessString, session};

    fn id() -> session::Id {
        session::Id::new("ses_u4").unwrap()
    }

    fn ids(values: &[&str]) -> BTreeSet<LosslessString> {
        values
            .iter()
            .map(|value| LosslessString::from(*value))
            .collect()
    }

    #[test]
    fn failed_successor_wakes_are_bounded_to_three_for_the_same_pending_set() {
        let mut drain = SuccessorDrain::default();
        for expected in [true, true, true, false] {
            drain.begin(&id(), ids(&["msg_one"]));
            assert_eq!(drain.retry(&id(), false, &ids(&["msg_one"])), expected);
        }
    }

    #[test]
    fn promote_then_fail_does_not_schedule_a_successor() {
        let mut drain = SuccessorDrain::default();
        drain.begin(&id(), ids(&["msg_one", "msg_two"]));
        assert!(!drain.retry(&id(), false, &ids(&["msg_two"])));
    }

    #[test]
    fn explicit_stop_and_managed_tasks_do_not_schedule_successors() {
        let mut drain = SuccessorDrain::default();
        drain.begin(&id(), ids(&["msg_one"]));
        drain.request_stop(&id());
        assert!(!drain.retry(&id(), false, &ids(&["msg_one"])));
        drain.begin(&id(), ids(&["msg_one"]));
        assert!(!drain.retry(&id(), true, &ids(&["msg_one"])));
    }

    #[test]
    fn changed_pending_set_resets_the_failure_budget() {
        let mut drain = SuccessorDrain::default();
        drain.begin(&id(), ids(&["msg_one"]));
        assert!(drain.retry(&id(), false, &ids(&["msg_one"])));
        drain.begin(&id(), ids(&["msg_one", "msg_two"]));
        assert!(drain.retry(&id(), false, &ids(&["msg_one", "msg_two"])));
        drain.begin(&id(), ids(&["msg_one", "msg_two"]));
        assert!(drain.retry(&id(), false, &ids(&["msg_one", "msg_two"])));
    }
}
