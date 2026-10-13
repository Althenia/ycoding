use super::{
    admission::{Admission, Mode},
    bridge::{Error, SessionCheck, safe_page},
};
use crate::platform::computer::Future;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::{
    sync::{oneshot, watch},
    task::JoinHandle,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, browser, isolated_browser,
    session_id::SessionId, stringify_json,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Predispatch,
    Postdispatch,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutorError {
    pub message: String,
    pub phase: Phase,
}
impl std::fmt::Display for ExecutorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for ExecutorError {}
#[derive(Clone, Debug)]
pub struct Availability {
    pub available: bool,
    pub reason: Option<String>,
}
#[derive(Clone, Debug)]
pub struct Launch {
    pub instance_id: isolated_browser::InstanceId,
    pub tab_id: browser::TabId,
    pub url: LosslessString,
}
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub title: LosslessString,
    pub url: LosslessString,
    pub document_generation: browser::DocumentGeneration,
    pub revision: browser::ObservationRevision,
    pub elements: Vec<browser::Element>,
    pub truncated: bool,
}
#[derive(Clone, Debug)]
pub struct ActionOutput {
    pub snapshot: Snapshot,
    pub capture: Option<browser::CaptureOutput>,
    pub rejected: Option<LosslessString>,
}
pub trait Runtime: Send + Sync {
    fn observe(&self) -> Future<'_, Result<Snapshot, ExecutorError>>;
    fn action<'a>(
        &'a self,
        action: browser::Action,
        origins: Vec<String>,
        cancel: watch::Receiver<bool>,
    ) -> Future<'a, Result<ActionOutput, ExecutorError>>;
    fn pause(&self) -> Future<'_, Result<(), ExecutorError>>;
    fn resume(&self) -> Future<'_, Result<(), ExecutorError>>;
    fn close(&self) -> Future<'_, Result<(), ExecutorError>>;
    fn closed(&self) -> Future<'_, ()>;
}
pub trait Executor: Send + Sync {
    fn availability(&self) -> Future<'_, Availability> {
        super::chrome::installed_availability()
    }
    fn launch(
        &self,
        input: Launch,
        cancel: watch::Receiver<bool>,
    ) -> Future<'_, Result<Arc<dyn Runtime>, ExecutorError>>;
}
pub struct Options {
    pub operation_timeout: Duration,
    pub settlement_limit: usize,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            operation_timeout: Duration::from_secs(30),
            settlement_limit: 256,
        }
    }
}
struct Pending {
    call: browser::CallId,
    fingerprint: String,
    mutation: bool,
    cancel: watch::Sender<bool>,
    sender: oneshot::Sender<isolated_browser::ActionResult>,
}
struct InstanceState {
    tab: browser::Tab,
    state: isolated_browser::State,
    reason: Option<LosslessString>,
    elements: Vec<browser::Element>,
    runtime: Option<Arc<dyn Runtime>>,
    pending: Option<Pending>,
    settlements: HashMap<String, (String, isolated_browser::ActionResult)>,
}
struct Instance {
    id: isolated_browser::InstanceId,
    session: SessionId,
    state: Mutex<InstanceState>,
    cancelled: watch::Sender<bool>,
    close: tokio::sync::Mutex<Option<Result<(), ExecutorError>>>,
}
struct State {
    instances: HashMap<SessionId, Arc<Instance>>,
    tasks: Vec<JoinHandle<()>>,
    closed: bool,
}
pub struct Service {
    executor: Arc<dyn Executor>,
    admission: Arc<Admission>,
    sessions: SessionCheck,
    options: Options,
    state: Mutex<State>,
}
impl Service {
    pub fn new(
        executor: Arc<dyn Executor>,
        admission: Arc<Admission>,
        sessions: SessionCheck,
        options: Options,
    ) -> Arc<Self> {
        Arc::new(Self {
            executor,
            admission,
            sessions,
            options,
            state: Mutex::new(State {
                instances: HashMap::new(),
                tasks: Vec::new(),
                closed: false,
            }),
        })
    }
    fn check(&self, session: &SessionId) -> Result<(), Error> {
        if !(self.sessions)(session) {
            return Err(Error::Ownership(
                "Session does not exist, is archived, or belongs to another Location".into(),
            ));
        }
        if self.state.lock().unwrap_or_else(|e| e.into_inner()).closed {
            return Err(Error::Unavailable(
                "Isolated browser service is closed".into(),
            ));
        }
        Ok(())
    }
    fn instance(
        &self,
        session: &SessionId,
        id: Option<&isolated_browser::InstanceId>,
    ) -> Result<Arc<Instance>, Error> {
        self.check(session)?;
        let instance = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .instances
            .get(session)
            .cloned()
            .ok_or_else(|| {
                Error::Unavailable("No isolated browser is active for this Session".into())
            })?;
        if id.is_some_and(|id| id != &instance.id) {
            return Err(Error::Ownership(
                "Isolated browser instance is stale or belongs to another Session".into(),
            ));
        }
        Ok(instance)
    }
    pub async fn status(&self, session: &SessionId) -> Result<isolated_browser::Status, Error> {
        self.check(session)?;
        let instance = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .instances
            .get(session)
            .cloned();
        if let Some(instance) = instance {
            return Ok(status(&instance));
        }
        let available = self.executor.availability().await;
        Ok(isolated_browser::Status {
            state: if available.available {
                isolated_browser::State::Stopped
            } else {
                isolated_browser::State::Unavailable
            },
            reason: available.reason.map(LosslessString::from),
            instance_id: None,
            tab: None,
        })
    }
    pub fn list(&self, session: &SessionId) -> Result<Vec<browser::Tab>, Error> {
        self.check(session)?;
        Ok(self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .instances
            .get(session)
            .map(|instance| {
                vec![
                    instance
                        .state
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .tab
                        .clone(),
                ]
            })
            .unwrap_or_default())
    }
    pub async fn start(
        self: &Arc<Self>,
        session: &SessionId,
        input: isolated_browser::StartInput,
    ) -> Result<isolated_browser::Status, Error> {
        self.check(session)?;
        if self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .instances
            .contains_key(session)
        {
            return Err(Error::Busy(
                "Stop the current isolated browser before starting another".into(),
            ));
        }
        let available = self.executor.availability().await;
        if !available.available {
            return Err(Error::Unavailable(
                available
                    .reason
                    .unwrap_or_else(|| "Isolated Chrome is unavailable".into()),
            ));
        }
        let page = safe_page(&input.url)?;
        let id = isolated_browser::InstanceId::decode(&JsonValue::String(
            super::super::identifier("ibrowser_")
                .map_err(|e| Error::Unavailable(e.to_string()))?
                .into(),
        ))?;
        let tab_id = browser::TabId::decode(&JsonValue::String(
            super::super::identifier("btab_")
                .map_err(|e| Error::Unavailable(e.to_string()))?
                .into(),
        ))?;
        let instance = Arc::new(Instance {
            id: id.clone(),
            session: session.clone(),
            cancelled: watch::channel(false).0,
            close: tokio::sync::Mutex::new(None),
            state: Mutex::new(InstanceState {
                tab: browser::Tab {
                    id: tab_id.clone(),
                    session_id: session.clone(),
                    title: "".into(),
                    page,
                    status: browser::TabStatus::Unavailable,
                    generation: DomainDecode::decode(&JsonValue::Number(1.))?,
                    document_generation: DomainDecode::decode(&JsonValue::Number(1.))?,
                    observation_revision: DomainDecode::decode(&JsonValue::Number(0.))?,
                    pause_reason: None,
                    uncertain_call_id: None,
                    mode: None,
                    lease: None,
                },
                state: isolated_browser::State::Starting,
                reason: None,
                elements: Vec::new(),
                runtime: None,
                pending: None,
                settlements: HashMap::new(),
            }),
        });
        let (send, receive) = oneshot::channel();
        let weak = Arc::downgrade(self);
        let executor = self.executor.clone();
        let timeout = self.options.operation_timeout;
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.closed || state.instances.contains_key(session) {
                return Err(Error::Busy(
                    "Stop the current isolated browser before starting another".into(),
                ));
            }
            if !self.admission.claim(&name(session)?, Mode::Isolated) {
                return Err(Error::Busy(
                    "Stop selected-tab browser control before starting an isolated browser".into(),
                ));
            }
            state.instances.insert(session.clone(), instance.clone());
            let instance = instance.clone();
            state.tasks.push(tokio::spawn(async move {
                let launched = executor
                    .launch(
                        Launch {
                            instance_id: id,
                            tab_id,
                            url: input.url,
                        },
                        instance.cancelled.subscribe(),
                    )
                    .await;
                let result = match launched {
                    Err(error) => Err(Error::Unavailable(error.message)),
                    Ok(runtime) => {
                        instance
                            .state
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .runtime = Some(runtime.clone());
                        if *instance.cancelled.borrow() {
                            close_runtime(&instance)
                                .await
                                .map_err(executor_error)
                                .and(Err(Error::Unavailable(
                                    "Isolated browser startup was stopped".into(),
                                )))
                        } else {
                            let observed = tokio::time::timeout(timeout, runtime.observe())
                                .await
                                .map_err(|_| {
                                    Error::Unavailable(
                                        "Isolated browser startup observation timed out".into(),
                                    )
                                })
                                .and_then(|result| result.map_err(executor_error));
                            match observed {
                                Err(error) => {
                                    let cleanup = close_runtime(&instance).await;
                                    cleanup.map_err(executor_error).and(Err(error))
                                }
                                Ok(observed) => {
                                    if *instance.cancelled.borrow() {
                                        close_runtime(&instance).await.map_err(executor_error).and(
                                            Err(Error::Unavailable(
                                                "Isolated browser startup was stopped".into(),
                                            )),
                                        )
                                    } else {
                                        let result = {
                                            let mut state = instance
                                                .state
                                                .lock()
                                                .unwrap_or_else(|e| e.into_inner());
                                            apply(&mut state, &observed, true).map(|()| {
                                                state.state = isolated_browser::State::Ready;
                                                state.tab.status = browser::TabStatus::Shared;
                                            })
                                        };
                                        match result {
                                            Err(error) => {
                                                let cleanup = close_runtime(&instance).await;
                                                cleanup.map_err(executor_error).and(Err(error))
                                            }
                                            Ok(()) => Ok(status(&instance)),
                                        }
                                    }
                                }
                            }
                        }
                    }
                };
                if let Some(service) = weak.upgrade() {
                    if result.is_err() {
                        service.remove(&instance);
                    }
                    if result.is_ok() {
                        let mut state = service.state.lock().unwrap_or_else(|e| e.into_inner());
                        if state
                            .instances
                            .get(&instance.session)
                            .is_some_and(|current| Arc::ptr_eq(current, &instance))
                        {
                            let instance = instance.clone();
                            state.tasks.push(tokio::spawn(async move {
                                watch_runtime(instance).await;
                            }));
                        }
                    }
                }
                let _ = send.send(result);
            }));
        }
        let mut guard = StartGuard {
            service: Arc::downgrade(self),
            instance,
            settled: false,
        };
        let result = receive
            .await
            .map_err(|_| Error::Unavailable("Isolated browser startup task failed".into()))?;
        guard.settled = true;
        result
    }
    fn remove(&self, instance: &Arc<Instance>) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state
            .instances
            .get(&instance.session)
            .is_some_and(|current| Arc::ptr_eq(current, instance))
        {
            state.instances.remove(&instance.session);
            if let Ok(name) = name(&instance.session) {
                self.admission.release(&name, Mode::Isolated);
            }
        }
        instance.cancelled.send_replace(true);
    }
    pub async fn observe(
        &self,
        input: isolated_browser::ObserveInput,
    ) -> Result<isolated_browser::Observation, Error> {
        let instance = self.instance(&input.session_id, Some(&input.instance_id))?;
        let runtime = {
            let state = instance.state.lock().unwrap_or_else(|e| e.into_inner());
            require_ready(&state)?;
            if state.tab.id != input.tab_id {
                return Err(Error::Ownership(
                    "Isolated browser tab is stale or belongs to another Session".into(),
                ));
            }
            if state.tab.generation != input.generation {
                return Err(Error::Fence("Isolated browser generation is stale".into()));
            }
            state
                .runtime
                .clone()
                .ok_or_else(|| Error::Unavailable("Isolated Chrome is unavailable".into()))?
        };
        let observed = tokio::time::timeout(self.options.operation_timeout, runtime.observe())
            .await
            .map_err(|_| Error::Unavailable("Isolated browser observation timed out".into()))?
            .map_err(executor_error)?;
        let mut state = instance.state.lock().unwrap_or_else(|e| e.into_inner());
        apply(&mut state, &observed, true)?;
        Ok(isolated_browser::Observation {
            instance_id: instance.id.clone(),
            tab_id: state.tab.id.clone(),
            generation: state.tab.generation,
            document_generation: state.tab.document_generation,
            revision: state.tab.observation_revision,
            title: state.tab.title.clone(),
            page: state.tab.page.clone(),
            elements: state.elements.clone(),
            truncated: observed.truncated,
        })
    }
    pub async fn action(
        &self,
        input: isolated_browser::ActionInput,
    ) -> Result<isolated_browser::ActionResult, Error> {
        let instance = self.instance(&input.session_id, Some(&input.instance_id))?;
        let fingerprint = stringify_json(&input.encode());
        let (sender, receiver) = oneshot::channel();
        let (runtime, origins, signal, mutation) = {
            let mut state = instance.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.tab.id != input.tab_id {
                return Err(Error::Ownership(
                    "Isolated browser tab is stale or belongs to another Session".into(),
                ));
            }
            if let Some((prior, result)) = state
                .settlements
                .get(&stringify_json(&input.call_id.encode()))
            {
                if prior != &fingerprint {
                    return Err(Error::Fence(
                        "Isolated browser call ID was already used for another action".into(),
                    ));
                }
                return Ok(result.clone());
            }
            if state.settlements.len() >= self.options.settlement_limit {
                return Err(Error::Busy("Isolated browser call identity capacity is exhausted; stop it before continuing".into()));
            }
            require_ready(&state)?;
            if state.tab.generation != input.generation
                || state.tab.document_generation != input.document_generation
                || state.tab.observation_revision != input.observation_revision
            {
                return Err(Error::Fence(
                    "Isolated browser observation is stale; observe again".into(),
                ));
            }
            let element = match &input.action {
                browser::Action::Click(action) => Some(&action.r#ref),
                browser::Action::Type(action) => Some(&action.r#ref),
                _ => None,
            }
            .map(|reference| {
                state
                    .elements
                    .iter()
                    .find(|element| &element.r#ref == reference)
                    .ok_or_else(|| Error::Fence("Semantic element reference is stale".into()))
            })
            .transpose()?;
            if element.is_some_and(|element| element.disabled == Some(true)) {
                return Err(Error::Fence("Semantic element is disabled".into()));
            }
            let destination = match &input.action {
                browser::Action::Navigate(action) => Some(safe_page(&action.url)?),
                browser::Action::Click(_) => {
                    element.and_then(|element| element.destination.clone())
                }
                _ => None,
            };
            let mut origins = vec![
                state
                    .tab
                    .page
                    .origin
                    .to_utf8()
                    .map_err(|e| Error::InvalidFrame(e.to_string()))?,
            ];
            if let Some(destination) = destination {
                let origin = destination
                    .origin
                    .to_utf8()
                    .map_err(|e| Error::InvalidFrame(e.to_string()))?;
                if !origins.contains(&origin) {
                    origins.push(origin);
                }
            }
            let mutation = matches!(
                input.action,
                browser::Action::Navigate(_) | browser::Action::Click(_) | browser::Action::Type(_)
            );
            let (cancel, signal) = watch::channel(false);
            let runtime = state
                .runtime
                .clone()
                .ok_or_else(|| Error::Unavailable("Isolated Chrome is unavailable".into()))?;
            state.pending = Some(Pending {
                call: input.call_id.clone(),
                fingerprint,
                mutation,
                cancel,
                sender,
            });
            (runtime, origins, signal, mutation)
        };
        let mut guard = ActionGuard {
            instance: instance.clone(),
            call: input.call_id.clone(),
            settled: false,
        };
        let timeout = self.options.operation_timeout;
        let task_instance = instance.clone();
        self.state.lock().unwrap_or_else(|e|e.into_inner()).tasks.push(tokio::spawn(async move {
            let mut cancelled=signal.clone();
            let output=tokio::select! {
                biased;
                _=cancelled.wait_for(|cancelled|*cancelled)=>Err(ExecutorError {message:"Isolated browser action was canceled".into(),phase:if mutation {Phase::Postdispatch}else{Phase::Predispatch}}),
                result=tokio::time::timeout(timeout,runtime.action(input.action,origins,signal))=>result.unwrap_or_else(|_|Err(ExecutorError {message:"Isolated browser action timed out".into(),phase:if mutation {Phase::Postdispatch}else{Phase::Predispatch}})),
            };
            let uncertain=matches!(&output,Err(error) if error.phase==Phase::Postdispatch && mutation);
            {
                let mut state=task_instance.state.lock().unwrap_or_else(|e|e.into_inner());
                if state.pending.as_ref().is_some_and(|pending|pending.call==input.call_id) {
                    let result=match output {
                        Ok(output)=>match apply(&mut state,&output.snapshot,false) {Ok(())=>result(&task_instance,&state,&input.call_id,if output.rejected.is_some(){isolated_browser::ActionStatus::Rejected}else{isolated_browser::ActionStatus::Completed},output.rejected,output.capture),Err(error)=>result(&task_instance,&state,&input.call_id,isolated_browser::ActionStatus::Rejected,Some(error.to_string().into()),None)},
                        Err(error)=>{
                            if uncertain {pause_uncertain(&mut state,&input.call_id,"A dispatched browser mutation did not settle");}
                            result(&task_instance,&state,&input.call_id,if uncertain{isolated_browser::ActionStatus::Uncertain}else{isolated_browser::ActionStatus::Rejected},Some(bounded(error.message.into(),1024)),None)
                        }
                    };
                    settle(&mut state,result);
                }
            }
            if uncertain && let Err(error)=close_runtime(&task_instance).await {
                task_instance.state.lock().unwrap_or_else(|e|e.into_inner()).reason=Some(bounded(error.message.into(),1024));
            }
        }));
        let result = receiver.await.map_err(|_| {
            Error::Unavailable("Isolated browser action settlement task failed".into())
        })?;
        guard.settled = true;
        Ok(result)
    }
    pub async fn control(
        &self,
        session: &SessionId,
        resume: bool,
    ) -> Result<isolated_browser::Status, Error> {
        let instance = self.instance(session, None)?;
        let runtime = {
            let state = instance.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.pending.is_some() {
                return Err(Error::Fence(
                    "Cannot change control while an isolated browser action is settling".into(),
                ));
            }
            state
                .runtime
                .clone()
                .ok_or_else(|| Error::Unavailable("Isolated Chrome is unavailable".into()))?
        };
        if resume {
            runtime.resume().await.map_err(executor_error)?;
        } else {
            runtime.pause().await.map_err(executor_error)?;
        }
        {
            let mut state = instance.state.lock().unwrap_or_else(|e| e.into_inner());
            state.state = if resume {
                isolated_browser::State::Ready
            } else {
                isolated_browser::State::Paused
            };
            state.reason = None;
            state.tab.status = if resume {
                browser::TabStatus::Shared
            } else {
                browser::TabStatus::Paused
            };
            state.tab.pause_reason = if resume {
                None
            } else {
                Some(browser::PauseReason::Requested)
            };
            if resume {
                state.tab.observation_revision = DomainDecode::decode(&JsonValue::Number(0.))?;
                state.elements.clear();
                state.tab.uncertain_call_id = None;
            }
        }
        Ok(status(&instance))
    }
    pub async fn stop(&self, session: &SessionId) -> Result<(), Error> {
        self.check(session)?;
        self.release_session(session).await
    }
    pub async fn release_session(&self, session: &SessionId) -> Result<(), Error> {
        let instance = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .instances
            .get(session)
            .cloned();
        if let Some(instance) = instance {
            self.remove(&instance);
            {
                let mut state = instance.state.lock().unwrap_or_else(|e| e.into_inner());
                cancel_pending(
                    &instance,
                    &mut state,
                    "The isolated browser was stopped while the action was settling",
                    false,
                );
            }
            close_runtime(&instance).await.map_err(executor_error)?;
        }
        self.admission.release(&name(session)?, Mode::Isolated);
        Ok(())
    }
    pub async fn shutdown(&self) -> Result<(), Error> {
        let sessions = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.closed = true;
            state.instances.keys().cloned().collect::<Vec<_>>()
        };
        let mut failure = None;
        for session in sessions {
            if let Err(error) = self.release_session(&session).await
                && failure.is_none()
            {
                failure = Some(error);
            }
        }
        let tasks = std::mem::take(&mut self.state.lock().unwrap_or_else(|e| e.into_inner()).tasks);
        for task in tasks {
            if let Err(error) = task.await
                && failure.is_none()
            {
                failure = Some(Error::Unavailable(error.to_string()));
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}
struct StartGuard {
    service: Weak<Service>,
    instance: Arc<Instance>,
    settled: bool,
}
impl Drop for StartGuard {
    fn drop(&mut self) {
        if !self.settled
            && let Some(service) = self.service.upgrade()
        {
            service.remove(&self.instance);
        }
    }
}
struct ActionGuard {
    instance: Arc<Instance>,
    call: browser::CallId,
    settled: bool,
}
impl Drop for ActionGuard {
    fn drop(&mut self) {
        if !self.settled {
            let mut state = self
                .instance
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if state
                .pending
                .as_ref()
                .is_some_and(|pending| pending.call == self.call)
            {
                cancel_pending(
                    &self.instance,
                    &mut state,
                    "The browser action caller canceled before settlement",
                    true,
                );
            }
        }
    }
}
fn name(session: &SessionId) -> Result<String, Error> {
    session
        .as_lossless()
        .to_utf8()
        .map_err(|e| Error::Ownership(e.to_string()))
}
fn executor_error(error: ExecutorError) -> Error {
    Error::Unavailable(error.message)
}
fn bounded(value: LosslessString, max: usize) -> LosslessString {
    if value.len() <= max {
        return value;
    }
    LosslessString::from_utf16(value.code_units().take(max).collect())
}
fn status(instance: &Instance) -> isolated_browser::Status {
    let state = instance.state.lock().unwrap_or_else(|e| e.into_inner());
    isolated_browser::Status {
        state: state.state,
        reason: state.reason.clone(),
        instance_id: Some(instance.id.clone()),
        tab: Some(state.tab.clone()),
    }
}
fn require_ready(state: &InstanceState) -> Result<(), Error> {
    if state.pending.is_some() {
        return Err(Error::Busy(
            "An isolated browser action is still settling".into(),
        ));
    }
    if state.state != isolated_browser::State::Ready || state.runtime.is_none() {
        return Err(Error::Fence("Isolated browser control is paused".into()));
    }
    Ok(())
}
fn apply(state: &mut InstanceState, snapshot: &Snapshot, elements: bool) -> Result<(), Error> {
    state.tab.page = safe_page(&snapshot.url)?;
    state.tab.title = bounded(snapshot.title.clone(), 512);
    state.tab.document_generation = snapshot.document_generation;
    state.tab.observation_revision = snapshot.revision;
    state.elements.clear();
    if elements {
        for element in &snapshot.elements {
            if let Some(current) = state
                .elements
                .iter_mut()
                .find(|current| current.r#ref == element.r#ref)
            {
                *current = element.clone();
                continue;
            }
            state.elements.push(element.clone());
        }
    }
    Ok(())
}
fn result(
    instance: &Instance,
    state: &InstanceState,
    call: &browser::CallId,
    status: isolated_browser::ActionStatus,
    message: Option<LosslessString>,
    capture: Option<browser::CaptureOutput>,
) -> isolated_browser::ActionResult {
    isolated_browser::ActionResult {
        instance_id: instance.id.clone(),
        call_id: call.clone(),
        tab: state.tab.clone(),
        status,
        message,
        capture,
    }
}
fn settle(state: &mut InstanceState, result: isolated_browser::ActionResult) {
    if let Some(pending) = state.pending.take() {
        state
            .settlements
            .entry(stringify_json(&pending.call.encode()))
            .or_insert((pending.fingerprint, result.clone()));
        let _ = pending.sender.send(result);
    }
}
fn pause_uncertain(state: &mut InstanceState, call: &browser::CallId, reason: &str) {
    state.state = isolated_browser::State::Paused;
    state.reason = Some(reason.into());
    state.tab.status = browser::TabStatus::Paused;
    state.tab.pause_reason = Some(browser::PauseReason::Uncertain);
    state.tab.uncertain_call_id = Some(call.clone());
}
fn cancel_pending(instance: &Instance, state: &mut InstanceState, message: &str, pause: bool) {
    if let Some(pending) = &state.pending {
        let call = pending.call.clone();
        let mutation = pending.mutation;
        pending.cancel.send_replace(true);
        if mutation && pause {
            pause_uncertain(
                state,
                &call,
                "A browser mutation was canceled before settlement",
            );
        }
        let result = result(
            instance,
            state,
            &call,
            if mutation {
                isolated_browser::ActionStatus::Uncertain
            } else {
                isolated_browser::ActionStatus::Rejected
            },
            Some(message.into()),
            None,
        );
        settle(state, result);
    }
}
async fn close_runtime(instance: &Instance) -> Result<(), ExecutorError> {
    let mut closed = instance.close.lock().await;
    if let Some(result) = &*closed {
        return result.clone();
    }
    let runtime = instance
        .state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .runtime
        .clone();
    let Some(runtime) = runtime else {
        return Ok(());
    };
    let result = runtime.close().await;
    *closed = Some(result.clone());
    result
}
async fn watch_runtime(instance: Arc<Instance>) {
    let runtime = instance
        .state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .runtime
        .clone();
    let Some(runtime) = runtime else {
        return;
    };
    let mut cancelled = instance.cancelled.subscribe();
    tokio::select! {()=runtime.closed()=>{{let mut state=instance.state.lock().unwrap_or_else(|e|e.into_inner());state.state=isolated_browser::State::Unavailable;state.reason=Some("Isolated Chrome disconnected".into());state.tab.status=browser::TabStatus::Unavailable;state.tab.pause_reason=Some(browser::PauseReason::Disconnected);state.elements.clear();cancel_pending(&instance,&mut state,"Isolated Chrome disconnected while the action was settling",false);}if let Err(error)=close_runtime(&instance).await{instance.state.lock().unwrap_or_else(|e|e.into_inner()).reason=Some(bounded(error.message.into(),1024));}},()=async {let _=cancelled.wait_for(|cancelled|*cancelled).await;}=>{}}
}
impl super::boundary::Isolated for Arc<Service> {
    fn status<'a>(
        &'a self,
        session: &'a SessionId,
    ) -> Future<'a, Result<isolated_browser::Status, String>> {
        Box::pin(async move {
            Service::status(self, session)
                .await
                .map_err(|e| e.to_string())
        })
    }
    fn list<'a>(&'a self, session: &'a SessionId) -> Future<'a, Result<Vec<browser::Tab>, String>> {
        Box::pin(async move { Service::list(self, session).map_err(|e| e.to_string()) })
    }
    fn observe<'a>(
        &'a self,
        input: isolated_browser::ObserveInput,
    ) -> Future<'a, Result<isolated_browser::Observation, String>> {
        Box::pin(async move {
            Service::observe(self, input)
                .await
                .map_err(|e| e.to_string())
        })
    }
    fn action<'a>(
        &'a self,
        input: isolated_browser::ActionInput,
    ) -> Future<'a, Result<isolated_browser::ActionResult, String>> {
        Box::pin(async move {
            Service::action(self, input)
                .await
                .map_err(|e| e.to_string())
        })
    }
    fn control<'a>(
        &'a self,
        session: &'a SessionId,
        resume: bool,
    ) -> Future<'a, Result<isolated_browser::Status, String>> {
        Box::pin(async move {
            Service::control(self, session, resume)
                .await
                .map_err(|e| e.to_string())
        })
    }
    fn stop<'a>(&'a self, session: &'a SessionId) -> Future<'a, Result<(), String>> {
        Box::pin(async move {
            Service::stop(self, session)
                .await
                .map_err(|e| e.to_string())
        })
    }
}
