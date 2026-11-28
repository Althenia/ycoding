use super::{
    ceiling,
    identity::Launch,
    view::{self, Rendered, TEAM_VIEW_BYTES, task_from_row, truncate_utf8},
};
use crate::{
    coordination::{
        decisions::{Claim as Reconsidering, Reconsider, Reconsidered},
        runtime::DecisionOutcome,
    },
    platform::shell::ledger,
    process::guardrails::{Guardrails, Reservation, decision::Evaluator, is_whitespace},
    session::{
        autonomy, coordination_model, key, model_switch, pending,
        projector::{self, random_event_id},
        prompt_cache::sha256,
        review::{ChildAnswer, Claim, DeliveryError},
        review_fold::{self, WithdrawReason, Withdrawals},
        run_coordinator::{self, RunFuture},
        shared_context, step_boundary, store,
        usage_attribution::{self, Attribution},
    },
    tools::{
        code_mode::Cancellation,
        policy::{
            ANSWER_THRESHOLD,
            goal_answer::{GOAL_VIA, GoalReconsider},
        },
    },
};
use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Bound,
    sync::{Arc, Mutex, OnceLock, Weak},
    time::Duration,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, agent, domain, guardrail,
    model, permission, session, session_message,
    session_orchestration::{Answer, Change, Question, QuestionId, Task},
    session_pending,
    session_review::{Kind, Origin, Reason},
    stringify_json, usage_anchor,
};
use ycoding_store::{
    IndexOrder, IndexQuery, Write,
    session::{NewEvent, SessionTable, TaskTable},
};

const BLOCKED_MESSAGE_BYTES: usize = 4 * 1024;
const PROGRESS_BYTES: usize = 4 * 1024;
const QUESTION_BYTES: usize = 8 * 1024;
const EXCERPT_BYTES: usize = 16 * 1024;
const ATTEMPTS: usize = 16;
const RESTART_LOST: &str =
    "The service restarted while the child task was active. Provider execution was not resumed.";

type QuestionEvaluator = Arc<dyn Fn(&session::Id) -> Option<Arc<dyn Evaluator>> + Send + Sync>;

enum SleepAnswer {
    Answer(LosslessString),
    Deferred {
        reason: Reason,
        choice: Option<LosslessString>,
        confidence: Option<guardrail::Confidence>,
    },
}

impl SleepAnswer {
    fn deferred(reason: Reason) -> Self {
        Self::Deferred {
            reason,
            choice: None,
            confidence: None,
        }
    }
}

type ReconciliationStates = BTreeMap<usize, Weak<tokio::sync::Mutex<bool>>>;

fn reconciliation_state(client: &ycoding_store::Client) -> Arc<tokio::sync::Mutex<bool>> {
    static STATES: OnceLock<Mutex<ReconciliationStates>> = OnceLock::new();
    let mut states = STATES
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    states.retain(|_, state| state.strong_count() > 0);
    let key = std::ptr::from_ref(client.metadata()).addr();
    if let Some(state) = states.get(&key).and_then(Weak::upgrade) {
        return state;
    }
    let state = Arc::new(tokio::sync::Mutex::new(false));
    states.insert(key, Arc::downgrade(&state));
    let retained = state.clone();
    client.observe_events(move |_| {
        let _ = &retained;
        true
    });
    state
}

pub trait Execution: Send + Sync + 'static {
    fn wake(&self, id: &session::Id) -> run_coordinator::Outcome;
    fn resume(&self, id: &session::Id) -> RunFuture;
    fn interrupt(&self, id: &session::Id) -> RunFuture;
}

#[derive(Debug)]
pub enum Error {
    SessionNotFound(session::Id),
    NotFound {
        parent_id: session::Id,
        child_id: session::Id,
    },
    Forbidden {
        parent_id: session::Id,
        child_id: session::Id,
    },
    TaskNotFound(session::Id),
    QuestionNotFound {
        child_id: session::Id,
        question_id: QuestionId,
    },
    DepthLimit(usize),
    Blocked(Blocked),
    Conflict(String),
    InvalidRequest(String),
    ModelBlocked(Box<ycoding_schema::session::ModelSwitchBlocked>),
    ProfileUnavailable {
        provider_id: LosslessString,
        profile: LosslessString,
    },
    CompactionConflict(String),
    ModelResolution(String),
    Authorization(String),
    Store(ycoding_store::Error),
    Execution(run_coordinator::Error),
    Cancelled,
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SessionNotFound(id) => {
                write!(
                    formatter,
                    "Session not found: {}",
                    text_of(id.as_lossless())
                )
            }
            Self::NotFound {
                parent_id,
                child_id,
            } => write!(
                formatter,
                "Child task not found for parent {}: {}",
                text_of(parent_id.as_lossless()),
                text_of(child_id.as_lossless())
            ),
            Self::TaskNotFound(id) => {
                write!(
                    formatter,
                    "Child task not found: {}",
                    text_of(id.as_lossless())
                )
            }
            Self::Forbidden {
                parent_id,
                child_id,
            } => write!(
                formatter,
                "Control of child {} by session {} is not permitted",
                text_of(child_id.as_lossless()),
                text_of(parent_id.as_lossless())
            ),
            Self::QuestionNotFound {
                child_id,
                question_id,
            } => write!(
                formatter,
                "Open question {} not found for child {}",
                text_of(&question_id.0),
                text_of(child_id.as_lossless())
            ),
            Self::DepthLimit(limit) => write!(formatter, "Subagent depth limit reached ({limit})"),
            Self::Blocked(blocked) => write!(formatter, "{}", blocked.message),
            Self::Conflict(message) | Self::InvalidRequest(message) => {
                write!(formatter, "{message}")
            }
            Self::ModelBlocked(blocked) => write!(
                formatter,
                "Model switch blocked: current context ({} tokens) exceeds the target model's safe input ({} tokens); reduce context by {} tokens and retry",
                blocked.current_context_tokens.get(),
                blocked.target_safe_input_tokens.get(),
                blocked.required_reduction_tokens.get()
            ),
            Self::ProfileUnavailable {
                provider_id,
                profile,
            } => write!(
                formatter,
                "Profile unavailable for {}: {}. Select the profile again.",
                text_of(provider_id),
                text_of(profile)
            ),
            Self::CompactionConflict(message)
            | Self::ModelResolution(message)
            | Self::Authorization(message) => write!(formatter, "{message}"),
            Self::Store(error) => write!(formatter, "{error}"),
            Self::Execution(error) => write!(formatter, "{error}"),
            Self::Cancelled => write!(formatter, "Subagent launch cancelled"),
        }
    }
}

impl std::error::Error for Error {}

impl From<ycoding_store::Error> for Error {
    fn from(error: ycoding_store::Error) -> Self {
        Self::Store(error)
    }
}

impl From<run_coordinator::Error> for Error {
    fn from(error: run_coordinator::Error) -> Self {
        Self::Execution(error)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Blocked {
    pub reason: ycoding_schema::coordination::SubagentRequestBlockedReason,
    pub message: String,
}

impl Blocked {
    pub fn error(
        reason: ycoding_schema::coordination::SubagentRequestBlockedReason,
        message: impl Into<String>,
    ) -> Error {
        Error::Blocked(Self {
            reason,
            message: message.into(),
        })
    }
}

pub struct BlockedRequest<'a> {
    pub agent: &'a str,
    pub message_id: &'a str,
    pub call_id: &'a str,
}

pub type LaunchGate = Arc<dyn Fn(&session::Id) -> Option<String> + Send + Sync>;

pub struct Prepared {
    pub agent: agent::Id,
    pub caller_permissions: permission::Ruleset,
    pub model: model::Ref,
    pub profile_binding: Option<ycoding_schema::session_event::ProfileBinding>,
}

pub type SwitchAuthorize<'a> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), Error>> + Send + 'a>>;

pub struct SwitchModel<'a> {
    pub parent_id: &'a session::Id,
    pub child_id: &'a session::Id,
    pub expected_model: &'a model::Ref,
    pub model: &'a model::Ref,
    pub resolver: &'a super::preflight::ModelSwitch,
    pub authorize: Option<tokio::sync::Mutex<SwitchAuthorize<'a>>>,
    pub permitted: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

pub struct LaunchInput {
    pub parent_id: session::Id,
    pub parent_assistant_message_id: session_message::Id,
    pub tool_call_id: String,
    pub description: String,
    pub prompt: String,
    pub depth_limit: usize,
    pub prepared: Prepared,
    pub guardrails: Guardrails,
}

pub enum Settlement {
    Completed {
        excerpt: Option<String>,
    },
    Failed {
        error: String,
        excerpt: Option<String>,
    },
    Lost {
        excerpt: Option<String>,
    },
}

pub struct Asked {
    pub question: Question,
    pub auto_answered: bool,
}

#[derive(Clone)]
pub struct Service {
    pub(super) sessions: store::Service,
    pub(super) execution: Arc<dyn Execution>,
    autonomy: autonomy::Service,
    locks: Arc<Mutex<BTreeMap<LosslessString, Arc<tokio::sync::Mutex<()>>>>>,
    held: Arc<Mutex<BTreeMap<LosslessString, Reservation>>>,
    reconciled: Arc<tokio::sync::Mutex<bool>>,
    reviews: Option<crate::tools::policy::Reviews>,
    question_evaluator: QuestionEvaluator,
    reconsidering: Arc<Mutex<BTreeSet<LosslessString>>>,
    launch_gate: LaunchGate,
}

#[derive(Clone, Debug)]
pub struct QuestionSnapshot {
    pub task: Task,
    pub fingerprint: LosslessString,
}

pub type Atomic = Arc<dyn Fn(&mut Write<'_>) -> Result<bool, ycoding_store::Error> + Send + Sync>;

struct Automatic {
    via: &'static str,
    revision: i64,
    fingerprint: LosslessString,
    authority: autonomy::Snapshot,
    atomic: Atomic,
}

struct OpenQuestion {
    row: ycoding_store::session::Task,
    task: Task,
    review: i64,
}

impl Service {
    pub fn new(sessions: store::Service, execution: Arc<dyn Execution>) -> Self {
        ledger::current_owner();
        let reconciled = reconciliation_state(&sessions.client);
        Self {
            autonomy: autonomy::Service::new(sessions.client.clone()),
            sessions,
            execution,
            locks: Arc::default(),
            held: Arc::default(),
            reconciled,
            reviews: None,
            question_evaluator: Arc::new(|_| None),
            reconsidering: Arc::default(),
            launch_gate: Arc::new(|_| None),
        }
    }

    pub fn with_launch_gate(mut self, gate: LaunchGate) -> Self {
        self.launch_gate = gate;
        self
    }

    pub fn check_launch_gate(&self, parent_id: &session::Id) -> Result<(), Error> {
        match (self.launch_gate)(parent_id) {
            Some(message) => Err(Blocked::error(
                ycoding_schema::coordination::SubagentRequestBlockedReason::ProjectPaused,
                message,
            )),
            None => Ok(()),
        }
    }

    pub async fn record_blocked(
        &self,
        parent_id: &session::Id,
        request: &BlockedRequest<'_>,
        blocked: &Blocked,
    ) -> Result<(), Error> {
        let data = ycoding_schema::coordination::SubagentRequestBlockedData {
            session_id: parent_id.clone(),
            agent: request.agent.into(),
            reason: blocked.reason,
            message: truncate_utf8(&blocked.message, BLOCKED_MESSAGE_BYTES).into(),
        };
        let digest = sha256(&format!(
            "{}\0{}\0{}",
            text(parent_id.as_lossless()),
            request.message_id,
            request.call_id
        ));
        let event = NewEvent {
            id: format!("evt_blocked_{}", &digest[..24]).into(),
            aggregate_id: parent_id.as_lossless().clone(),
            created: now(),
            type_: "coordination.subagent.request.blocked.1".into(),
            data: data.encode(),
        };
        self.sessions
            .client
            .submit(move |tx| ycoding_store::session::append(tx, &event, None).map(|_| ()))?
            .await?;
        Ok(())
    }

    pub fn with_question_policy(mut self, evaluator: QuestionEvaluator) -> Self {
        self.question_evaluator = evaluator;
        self
    }

    pub fn with_reviews(mut self, reviews: crate::tools::policy::Reviews) -> Self {
        self.reviews = Some(reviews);
        self
    }

    pub fn with_review_limit(mut self, limit: usize) -> Self {
        if let Some(reviews) = &mut self.reviews {
            reviews.limit = limit;
        }
        self
    }

    pub fn get(&self, parent_id: &session::Id, child_id: &session::Id) -> Result<Task, Error> {
        self.present(&self.owned(parent_id, child_id)?)
    }
    pub fn managed(&self, child_id: &session::Id) -> Result<bool, Error> {
        Ok(self.task(child_id)?.is_some())
    }

    fn switchable(
        &self,
        parent_id: &session::Id,
        child_id: &session::Id,
    ) -> Result<ycoding_store::session::Task, Error> {
        let row = self.owned(parent_id, child_id)?;
        let state = state_of(&row);
        if state == "starting" || state == "cancelling" {
            return Err(Error::Conflict(
                "Wait for the child's lifecycle transition before selecting a model".into(),
            ));
        }
        if let Some(owner_pid) = row.owner_pid {
            let owner = ledger::current_owner();
            let foreign = owner.is_none_or(|owner| {
                i64::from(owner.pid) != owner_pid
                    || row.owner_started.as_ref().map(LosslessString::as_str)
                        != Some(Some(owner.started.as_str()))
            });
            if foreign {
                return Err(Error::Conflict(
                    "The child is owned by another runtime process".into(),
                ));
            }
        }
        let parent = self
            .sessions
            .get(parent_id)?
            .ok_or_else(|| Error::SessionNotFound(parent_id.clone()))?;
        let child = self
            .sessions
            .get(child_id)?
            .ok_or_else(|| Error::SessionNotFound(child_id.clone()))?;
        if parent.time.archived.is_some() || child.time.archived.is_some() {
            return Err(Error::Conflict(
                "Archived Sessions cannot change a child model".into(),
            ));
        }
        if coordination_model::current(&self.sessions, child_id)?.is_some() {
            return Err(Error::Conflict(
                "The child has an active coordination model override".into(),
            ));
        }
        Ok(row)
    }

    pub async fn switch_model(&self, mut input: SwitchModel<'_>) -> Result<Task, Error> {
        let boundary = step_boundary::for_client(&self.sessions.client);
        let _selection = boundary.selection(input.child_id);
        self.switchable(input.parent_id, input.child_id)?;
        let expected_binding = self.sessions.profile_binding(input.child_id)?;
        let resolved = input.resolver.resolve(input.model, None)?;
        let _boundary = boundary.boundary_guard(input.child_id).await;
        let _lock = self.lock(input.child_id.as_lossless()).await;
        self.switchable(input.parent_id, input.child_id)?;
        if let Some(authorize) = input.authorize.take() {
            authorize.into_inner().await?;
        }
        self.select_model_at_boundary(&input, &resolved, expected_binding.as_ref())
            .await
    }

    async fn select_model_at_boundary(
        &self,
        input: &SwitchModel<'_>,
        resolved: &super::preflight::ResolvedSwitch,
        expected_binding: Option<&ycoding_schema::session_event::ProfileBinding>,
    ) -> Result<Task, Error> {
        let conflict = || {
            Error::Conflict(
                "The child or expected model changed before selection; read the child and retry"
                    .into(),
            )
        };
        let session = self
            .sessions
            .get(input.child_id)?
            .ok_or_else(|| Error::SessionNotFound(input.child_id.clone()))?;
        if session.model.as_ref() != Some(input.expected_model) {
            return Err(conflict());
        }
        if let Some(profile) = &input.model.profile {
            let valid = resolved.binding.as_ref().is_some_and(|binding| {
                binding.provider_id == input.model.provider_id && binding.profile == *profile
            });
            if !valid {
                return Err(Error::ProfileUnavailable {
                    provider_id: input.model.provider_id.0.clone(),
                    profile: profile.0.clone(),
                });
            }
        }
        let committed = input
            .resolver
            .resolve(input.model, resolved.binding.as_ref())?;
        if committed.digest != resolved.digest {
            return Err(conflict());
        }
        if committed.budget <= 0 {
            return Err(Error::CompactionConflict(
                "Target model has no positive input budget".into(),
            ));
        }
        let tokens = input.resolver.context_tokens(&session, input.model)?;
        if let model_switch::Outcome::Blocked(blocked) = model_switch::decide_tokens(
            session.model.as_ref(),
            input.model,
            tokens,
            committed.budget,
        ) {
            return Err(Error::ModelBlocked(blocked));
        }
        if self.switchable(input.parent_id, input.child_id).is_err()
            || input
                .permitted
                .as_ref()
                .is_some_and(|permitted| !permitted())
        {
            return Err(conflict());
        }
        let same = session.model.as_ref() == Some(input.model)
            && input.model.profile.is_none()
            && expected_binding.is_none();
        let target_binding = resolved.binding.clone();
        let publish_binding = target_binding.is_some() || expected_binding.is_some();
        let expected_model = input.expected_model.clone();
        let model = input.model.clone();
        let expected = expected_binding.cloned();
        let child_id = input.child_id.clone();
        let parent_id = input.parent_id.clone();
        let location = session.location.clone();
        let now = now();
        let committed = self
            .sessions
            .client
            .submit(move |tx| {
                let Some(row) = tx.get::<SessionTable>(&key(child_id.as_lossless()))? else {
                    return Ok(false);
                };
                if row.time_archived.is_some() {
                    return Ok(false);
                }
                let current = row
                    .model
                    .as_ref()
                    .map(|document| document.domain())
                    .transpose()
                    .map_err(|error| ycoding_store::Error::Record(Box::new(error)))?;
                if current.as_ref() != Some(&expected_model) {
                    return Ok(false);
                }
                let binding = row
                    .profile_binding
                    .as_ref()
                    .map(|document| document.domain())
                    .transpose()
                    .map_err(|error| ycoding_store::Error::Record(Box::new(error)))?;
                if binding != expected {
                    return Ok(false);
                }
                if row.directory != *location.directory.as_lossless()
                    || row.workspace_id.as_ref()
                        != location.workspace_id.as_ref().map(|id| id.as_lossless())
                {
                    return Ok(false);
                }
                let Some(task) = tx.get::<TaskTable>(&key(child_id.as_lossless()))? else {
                    return Ok(false);
                };
                if task.parent_id != *parent_id.as_lossless()
                    || task.state.as_str() == Some("starting")
                    || task.state.as_str() == Some("cancelling")
                {
                    return Ok(false);
                }
                if same {
                    return Ok(true);
                }
                projector::append(
                    tx,
                    &NewEvent {
                        id: random_event_id()?.as_lossless().clone(),
                        aggregate_id: child_id.as_lossless().clone(),
                        created: now,
                        type_: "session.model.selected.1".into(),
                        data: ObjectEncoder::new()
                            .field("sessionID", &child_id)
                            .field("model", &model)
                            .finish(),
                    },
                )?;
                if publish_binding {
                    projector::append(
                        tx,
                        &NewEvent {
                            id: random_event_id()?.as_lossless().clone(),
                            aggregate_id: child_id.as_lossless().clone(),
                            created: now,
                            type_: "session.profile.bound.1".into(),
                            data: ObjectEncoder::new()
                                .field("sessionID", &child_id)
                                .optional("binding", &target_binding)
                                .finish(),
                        },
                    )?;
                }
                Ok(true)
            })?
            .await?;
        if !committed {
            return Err(conflict());
        }
        self.current(input.child_id)
    }
    pub fn release_reservation(&self, child_id: &session::Id) {
        self.held
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(child_id.as_lossless());
    }

    pub fn list(&self, parent_id: &session::Id) -> Result<Vec<Task>, Error> {
        self.require_session(parent_id)?;
        let mut rows = self.children(parent_id)?;
        rows.sort_by(|left, right| {
            (left.time_created, &left.session_id).cmp(&(right.time_created, &right.session_id))
        });
        rows.iter()
            .map(|row| self.present(row))
            .collect::<Result<Vec<_>, _>>()
    }

    pub fn depth(&self, session_id: &session::Id) -> Result<usize, Error> {
        let mut depth = 0;
        let mut seen = std::collections::BTreeSet::new();
        let mut current = self
            .sessions
            .get(session_id)?
            .ok_or_else(|| Error::SessionNotFound(session_id.clone()))?;
        while let Some(parent_id) = current.parent_id.clone() {
            if !seen.insert(parent_id.clone()) {
                break;
            }
            current = self
                .sessions
                .get(&parent_id)?
                .ok_or(Error::SessionNotFound(parent_id))?;
            depth += 1;
        }
        Ok(depth)
    }

    pub fn team_view(&self, parent_id: &session::Id) -> Result<Rendered, Error> {
        self.require_session(parent_id)?;
        let tasks = self.tasks(parent_id)?;
        Ok(view::render_team_view(&tasks, TEAM_VIEW_BYTES)?)
    }

    pub fn team_observation(&self, parent_id: &session::Id) -> Result<Option<Rendered>, Error> {
        self.require_session(parent_id)?;
        let tasks = self.tasks(parent_id)?;
        Ok((!tasks.is_empty()).then(|| view::render_team_observation(&tasks, TEAM_VIEW_BYTES)))
    }

    pub async fn launch(&self, input: LaunchInput) -> Result<Task, Error> {
        self.launch_with_cancellation(input, &crate::tools::code_mode::Cancellation::default())
            .await
    }

    pub async fn launch_with_cancellation(
        &self,
        input: LaunchInput,
        cancellation: &crate::tools::code_mode::Cancellation,
    ) -> Result<Task, Error> {
        self.launch_attributed(input, cancellation, &Attribution::Unset)
            .await
    }

    pub async fn launch_attributed(
        &self,
        input: LaunchInput,
        cancellation: &crate::tools::code_mode::Cancellation,
        attribution: &Attribution,
    ) -> Result<Task, Error> {
        self.launch_attributed_with_context(input, cancellation, attribution, None)
            .await
    }

    pub async fn launch_attributed_with_context(
        &self,
        input: LaunchInput,
        cancellation: &crate::tools::code_mode::Cancellation,
        attribution: &Attribution,
        selected: Option<&shared_context::Selection>,
    ) -> Result<Task, Error> {
        let ids = Launch::new(
            &input.parent_id,
            &input.parent_assistant_message_id,
            &input.tool_call_id,
        );
        let _guard = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(Error::Cancelled),
            guard = self.lock(ids.child_id.as_lossless()) => guard,
        };
        let parent = self
            .sessions
            .get(&input.parent_id)?
            .ok_or_else(|| Error::SessionNotFound(input.parent_id.clone()))?;
        if self.depth(&input.parent_id)? >= input.depth_limit {
            return Err(Error::DepthLimit(input.depth_limit));
        }
        let anchor = self
            .dispatch_anchor(input.parent_id.as_lossless(), attribution)
            .await?;
        let prompt_digest = selected.map_or_else(
            || sha256(&input.prompt),
            |selected| {
                sha256(&crate::session::prompt_cache::canonical_json(
                    &ObjectEncoder::new()
                        .field("version", &1.0)
                        .field("prompt", input.prompt.as_str())
                        .field("messageIDs", &selected.message_ids)
                        .finish(),
                ))
            },
        );
        if let Some(existing) = self.task(&ids.child_id)? {
            let model = existing.model.domain()?;
            let same = existing.parent_id == *input.parent_id.as_lossless()
                && existing.agent == input.prepared.agent
                && model == input.prepared.model
                && existing.prompt_digest.as_str() == Some(prompt_digest.as_str())
                && existing.background != 0
                && existing.delivery.as_str() == Some("steer");
            if !same {
                return Err(Error::Conflict(format!(
                    "Conflicting launch retry for {}",
                    text(ids.child_id.as_lossless())
                )));
            }
            if existing.state.as_str() == Some("starting") {
                let prompt = self.launch_prompt(&ids, &input, selected)?;
                let reservation = self.reserve(&input, cancellation).await?;
                let stored = existing
                    .usage_anchor
                    .as_ref()
                    .and_then(|anchor| anchor.domain().ok());
                let task = self.start(&ids, prompt, stored).await?;
                self.hold(&ids, reservation);
                return Ok(task);
            }
            return self.present(&existing);
        }
        let prompt = self.launch_prompt(&ids, &input, selected)?;
        let reservation = self.reserve(&input, cancellation).await?;
        let now = now();
        let ceiling = ceiling::inherit(
            parent.permission_ceiling.as_ref(),
            Some(&input.prepared.caller_permissions),
        );
        self.sessions
            .create(NewEvent {
                id: random_event_id()?.as_lossless().clone(),
                aggregate_id: ids.child_id.as_lossless().clone(),
                created: now,
                type_: "session.created.2".into(),
                data: ObjectEncoder::new()
                    .field("sessionID", &ids.child_id)
                    .field("projectID", &parent.project_id)
                    .field("location", &parent.location)
                    .optional("subpath", &parent.subpath)
                    .field("title", input.description.as_str())
                    .field("created", &(now as f64))
                    .field("parentID", &input.parent_id)
                    .field("agent", &input.prepared.agent)
                    .field("model", &input.prepared.model)
                    .optional(
                        "permissionCeiling",
                        &(!ceiling.is_empty()).then_some(ceiling),
                    )
                    .finish(),
            })
            .await?;
        if let Some(binding) = &input.prepared.profile_binding
            && self.sessions.profile_binding(&ids.child_id)?.as_ref() != Some(binding)
        {
            self.sessions
                .publish(NewEvent {
                    id: random_event_id()?.as_lossless().clone(),
                    aggregate_id: ids.child_id.as_lossless().clone(),
                    created: now,
                    type_: "session.profile.bound.1".into(),
                    data: ObjectEncoder::new()
                        .field("sessionID", &ids.child_id)
                        .field("binding", binding)
                        .finish(),
                })
                .await?;
        }
        self.publish(
            &ids.child_id,
            Change::Launched {
                parent_id: input.parent_id.clone(),
                parent_assistant_message_id: input.parent_assistant_message_id.clone(),
                tool_call_id: input.tool_call_id.as_str().into(),
                input_id: ids.input_id.clone(),
                description: input.description.as_str().into(),
                agent: input.prepared.agent.clone(),
                model: Box::new(input.prepared.model.clone()),
                prompt_digest: prompt_digest.as_str().into(),
                background: true,
                delivery: ycoding_schema::session_delivery::Delivery::Steer,
                usage_anchor: anchor.clone(),
            },
            Some(ids.launch_event_id.as_lossless().clone()),
        )
        .await?;
        let task = self.start(&ids, prompt, anchor).await?;
        self.hold(&ids, reservation);
        Ok(task)
    }

    pub async fn send(
        &self,
        parent_id: &session::Id,
        child_id: &session::Id,
        message_id: &session_message::Id,
        text: &str,
        delivery: &str,
    ) -> Result<Task, Error> {
        self.send_attributed(
            parent_id,
            child_id,
            message_id,
            text,
            delivery,
            &Attribution::Unset,
        )
        .await
    }

    pub async fn send_attributed(
        &self,
        parent_id: &session::Id,
        child_id: &session::Id,
        message_id: &session_message::Id,
        text: &str,
        delivery: &str,
        attribution: &Attribution,
    ) -> Result<Task, Error> {
        let _guard = self.lock(child_id.as_lossless()).await;
        let row = self.owned(parent_id, child_id)?;
        if review_fold::stopped_recovery(&self.sessions.client.snapshot()?, child_id)?.is_some() {
            return Err(Error::Conflict(
                "Continue the stopped recovery through its native control.".into(),
            ));
        }
        let state = state_of(&row);
        if state != "running" && state != "supervising" && !TERMINAL.contains(&state.as_str()) {
            return Err(Error::Conflict(format!("Cannot send to task in {state}")));
        }
        let caused_by = self
            .dispatch_anchor(parent_id.as_lossless(), attribution)
            .await?;
        let input = synthetic(
            format!(
                "Parent message:\n{}",
                json_text(
                    &ObjectEncoder::new()
                        .field("text", text)
                        .field("delivery", delivery)
                        .finish()
                )
            ),
            "Parent subagent message",
            ObjectEncoder::new()
                .field("source", "subagent_parent")
                .field("parentID", parent_id)
                .field("childID", child_id)
                .field("kind", "message")
                .finish(),
            delivery,
        )?;
        let wake = self.admit(child_id, message_id, input, caused_by).await?;
        if state == "running" {
            if wake {
                self.execution.wake(child_id)?;
            }
            if !self
                .task(child_id)?
                .is_some_and(|current| TERMINAL.contains(&state_of(&current).as_str()))
            {
                return self.current(child_id);
            }
        }
        if self.sessions.pending(message_id)?.is_none() {
            return self.present(&row);
        }
        self.publish(child_id, Change::Started, None).await?;
        if wake {
            self.execution.wake(child_id)?;
        }
        self.current(child_id)
    }

    pub async fn answer(
        &self,
        parent_id: &session::Id,
        child_id: &session::Id,
        question_id: &QuestionId,
        text: Option<&str>,
        data: Option<domain::Json>,
    ) -> Result<Task, Error> {
        self.answer_attributed(
            parent_id,
            child_id,
            question_id,
            text,
            data,
            &Attribution::Unset,
        )
        .await
    }

    pub async fn answer_attributed(
        &self,
        parent_id: &session::Id,
        child_id: &session::Id,
        question_id: &QuestionId,
        text: Option<&str>,
        data: Option<domain::Json>,
        attribution: &Attribution,
    ) -> Result<Task, Error> {
        let _guard = self.lock(child_id.as_lossless()).await;
        let row = self.open_question(parent_id, child_id, question_id)?;
        if text.is_none() && data.is_none() {
            return Err(Error::InvalidRequest(
                "An answer requires text or data".into(),
            ));
        }
        let caused_by = self
            .dispatch_anchor(parent_id.as_lossless(), attribution)
            .await?;
        let text = text.map(LosslessString::from);
        for _ in 0..ATTEMPTS {
            let fence = {
                let snapshot = self.sessions.client.snapshot()?;
                if review_fold::owns_question(&snapshot, child_id, question_id)? {
                    return Err(Error::Conflict(format!(
                        "Question {} awaits review",
                        text_of(&question_id.0)
                    )));
                }
                review_fold::latest_at(&snapshot, child_id.as_lossless())?
            };
            match self
                .commit_answer(
                    &row,
                    parent_id,
                    question_id,
                    text.clone(),
                    data.clone(),
                    caused_by.clone(),
                    Gate::Fence(fence),
                    None,
                )
                .await
            {
                Err(error) if review_fold::is_changed(&error) => continue,
                Err(error) => return Err(answer_error(child_id, error)),
                Ok(wake) => {
                    if wake {
                        self.execution.wake(child_id)?;
                    }
                    return self.current(child_id);
                }
            }
        }
        Err(Error::Conflict(format!(
            "Question {} changed during answer delivery",
            text_of(&question_id.0)
        )))
    }

    pub async fn answer_review(&self, answer: ChildAnswer) -> Result<(), DeliveryError> {
        let child_id = answer.child_id.clone();
        let _guard = self.lock(child_id.as_lossless()).await;
        let row = self
            .open_question(&answer.parent_id, &child_id, &answer.question_id)
            .map_err(delivery_error)?;
        let caused_by = self
            .dispatch_anchor(answer.parent_id.as_lossless(), &Attribution::Unset)
            .await
            .map_err(delivery_error)?;
        let wake = self
            .commit_answer(
                &row,
                &answer.parent_id,
                &answer.question_id,
                Some(answer.text.clone()),
                answer.data.clone(),
                caused_by,
                Gate::Claim(answer.claim.clone()),
                None,
            )
            .await
            .map_err(|error| delivery_error(answer_error(&child_id, error)))?;
        if wake {
            self.execution
                .wake(&child_id)
                .map_err(|error| delivery_error(error.into()))?;
        }
        Ok(())
    }

    pub(crate) async fn answer_native(
        &self,
        parent_id: &session::Id,
        child_id: &session::Id,
        question_id: &QuestionId,
        (text, data): (Option<LosslessString>, Option<domain::Json>),
        fingerprint: &LosslessString,
        gate: &crate::dots::authority::Gate,
    ) -> Result<Task, Error> {
        let _guard = self.lock(child_id.as_lossless()).await;
        let row = self.open_question(parent_id, child_id, question_id)?;
        if text.is_none() && data.is_none() {
            return Err(Error::InvalidRequest(
                "An answer requires text or data".into(),
            ));
        }
        let caused_by = self
            .dispatch_anchor(parent_id.as_lossless(), &Attribution::Unset)
            .await?;
        for _ in 0..ATTEMPTS {
            let fence = {
                let snapshot = self.sessions.client.snapshot()?;
                if review_fold::owns_question(&snapshot, child_id, question_id)? {
                    return Err(Error::Conflict(format!(
                        "Question {} awaits review",
                        text_of(&question_id.0)
                    )));
                }
                review_fold::latest_at(&snapshot, child_id.as_lossless())?
            };
            match self
                .commit_answer(
                    &row,
                    parent_id,
                    question_id,
                    text.clone(),
                    data.clone(),
                    caused_by.clone(),
                    Gate::Native {
                        fence,
                        fingerprint: fingerprint.clone(),
                        gate: gate.clone(),
                    },
                    None,
                )
                .await
            {
                Err(error) if review_fold::is_changed(&error) => continue,
                Err(error) => return Err(answer_error(child_id, error)),
                Ok(wake) => {
                    if wake {
                        self.execution.wake(child_id)?;
                    }
                    return self.current(child_id);
                }
            }
        }
        Err(Error::Conflict(format!(
            "Question {} changed during answer delivery",
            text_of(&question_id.0)
        )))
    }

    fn open_question(
        &self,
        parent_id: &session::Id,
        child_id: &session::Id,
        question_id: &QuestionId,
    ) -> Result<ycoding_store::session::Task, Error> {
        let row = self.owned(parent_id, child_id)?;
        if row.question_id.as_ref() != Some(&question_id.0) {
            return Err(Error::QuestionNotFound {
                child_id: child_id.clone(),
                question_id: question_id.clone(),
            });
        }
        if state_of(&row) != "waiting" {
            return Err(Error::Conflict(format!(
                "Question {} is not open",
                text_of(&question_id.0)
            )));
        }
        Ok(row)
    }

    #[allow(clippy::too_many_arguments)]
    async fn commit_answer(
        &self,
        row: &ycoding_store::session::Task,
        parent_id: &session::Id,
        question_id: &QuestionId,
        text: Option<LosslessString>,
        data: Option<domain::Json>,
        caused_by: Option<usage_anchor::Ref>,
        gate: Gate,
        automatic: Option<Automatic>,
    ) -> Result<bool, ycoding_store::Error> {
        let child_id = session::Id::new(row.session_id.clone())
            .map_err(|error| ycoding_store::Error::Record(Box::new(error)))?;
        let ids =
            launch_ids(row).map_err(|_| ycoding_store::Error::Rejected("invalid task identity"))?;
        let body = ObjectEncoder::new()
            .field("questionID", &question_id.0)
            .optional("text", &text)
            .optional("data", &data)
            .finish();
        let input = synthetic(
            format!("Parent answer:\n{}", json_text(&body)),
            if automatic.is_some() {
                "Autonomous subagent answer"
            } else {
                "Parent subagent answer"
            },
            ObjectEncoder::new()
                .field("source", "subagent_parent")
                .field("parentID", parent_id)
                .field("childID", &child_id)
                .field("kind", "answer")
                .field("questionID", &question_id.0)
                .optional("automatic", &automatic.as_ref().map(|_| true))
                .optional(
                    "via",
                    &automatic
                        .as_ref()
                        .map(|automatic| LosslessString::from(automatic.via)),
                )
                .finish(),
            "steer",
        )
        .map_err(|_| ycoding_store::Error::Rejected("invalid answer input"))?;
        let created = now();
        let request = pending::Request {
            id: ids.answer(text_of(&question_id.0)),
            session_id: child_id.clone(),
            input,
            event_id: random_event_id()?,
            created,
        };
        let change = Change::QuestionAnswered {
            answer: Answer {
                question_id: question_id.clone(),
                text,
                data,
            },
        };
        let event_id = random_event_id()?.as_lossless().clone();
        let question = question_id.0.clone();
        self.sessions
            .client
            .submit(move |tx| {
                let child = child_id.as_lossless();
                if let Some(automatic) = &automatic {
                    let authority = match autonomy::inherited_in_tx(tx, &child_id) {
                        Ok(authority) => Some(authority),
                        Err(autonomy::Error::NotFound(_)) => None,
                        Err(autonomy::Error::Store(error)) => return Err(error),
                    };
                    if authority.as_ref() != Some(&automatic.authority) || !(automatic.atomic)(tx)?
                    {
                        return Err(tx.reject(ycoding_store::Error::Domain {
                            kind: "authority_changed",
                            message: "Autonomous authority changed before commit",
                        }));
                    }
                }
                match &gate {
                    Gate::Fence(fence) | Gate::Native { fence, .. } => {
                        if review_fold::latest_in(tx, child)? != *fence {
                            return Err(review_fold::changed(tx));
                        }
                    }
                    Gate::Claim(claim) => {
                        claim.commit(tx, created)?;
                    }
                }
                let selected_model = tx
                    .get::<SessionTable>(&key(child))?
                    .and_then(|row| row.model)
                    .map(|document| document.value().clone());
                let task = tx.get::<TaskTable>(&key(child))?;
                let open = task.as_ref().is_some_and(|task| {
                    task.state.as_str() == Some("waiting")
                        && task.question_id.as_ref() == Some(&question)
                        && automatic.as_ref().is_none_or(|automatic| {
                            task.revision == automatic.revision
                                && question_fingerprint(
                                    task,
                                    selected_model
                                        .as_ref()
                                        .unwrap_or_else(|| task.model.value()),
                                ) == automatic.fingerprint
                        })
                });
                if !open {
                    return Err(tx.reject(ycoding_store::Error::Domain {
                        kind: "question_closed",
                        message: "The question is no longer open",
                    }));
                }
                let owner_id = child_id.clone();
                let native_receipt = match &gate {
                    Gate::Native {
                        fingerprint,
                        gate: native_gate,
                        ..
                    } => Some((fingerprint.clone(), native_gate.clone())),
                    _ => None,
                };
                let finish = move |tx: &mut Write<'_>| -> Result<bool, ycoding_store::Error> {
                    let child = child_id.as_lossless();
                    pending::admit_in(tx, &request, &caused_by)?;
                    projector::append(
                        tx,
                        &NewEvent {
                            id: event_id,
                            aggregate_id: child.clone(),
                            created,
                            type_: "session.task.updated.1".into(),
                            data: ObjectEncoder::new()
                                .field("sessionID", &child_id)
                                .field("change", &change)
                                .finish(),
                        },
                    )?;
                    if let Some((fingerprint, native_gate)) = &native_receipt {
                        native_gate.append_receipt(
                            tx,
                            &child_id,
                            ObjectEncoder::new()
                                .field("kind", "subagent_question")
                                .field("questionID", &question)
                                .field("fingerprint", fingerprint)
                                .finish(),
                            None,
                        )?;
                    }
                    Ok(tx
                        .get::<SessionTable>(&key(child))?
                        .is_some_and(|session| session.revert.is_none()))
                };
                match &gate {
                    Gate::Native {
                        fingerprint,
                        gate: native_gate,
                        ..
                    } => {
                        let current = task.as_ref().is_some_and(|task| {
                            question_fingerprint(
                                task,
                                selected_model
                                    .as_ref()
                                    .unwrap_or_else(|| task.model.value()),
                            ) == *fingerprint
                        });
                        if !current {
                            return Err(review_fold::changed(tx));
                        }
                        native_gate.with(tx, Some(&owner_id), finish)
                    }
                    _ => finish(tx),
                }
            })?
            .await
    }

    pub fn question_labels(task: &Task) -> Vec<LosslessString> {
        question_options(
            task.question
                .as_ref()
                .and_then(|question| question.data.as_ref()),
        )
    }

    pub fn question_snapshots(
        &self,
        parent_id: &session::Id,
    ) -> Result<Vec<QuestionSnapshot>, Error> {
        self.require_session(parent_id)?;
        let snapshot = self.sessions.client.snapshot()?;
        let mut rows = self
            .children(parent_id)?
            .into_iter()
            .filter(|row| {
                state_of(row) == "waiting" && row.question_id.is_some() && row.question.is_some()
            })
            .collect::<Vec<_>>();
        rows.sort_by(|left, right| {
            (left.time_created, &left.session_id).cmp(&(right.time_created, &right.session_id))
        });
        let mut found = Vec::new();
        for row in rows {
            let child_id = session_id(&row.session_id)?;
            let Some(question_id) = row.question_id.clone().map(QuestionId) else {
                continue;
            };
            if review_fold::owns_question(&snapshot, &child_id, &question_id)? {
                continue;
            }
            found.push(QuestionSnapshot {
                task: self.present(&row)?,
                fingerprint: question_fingerprint(&row, &self.fingerprint_model(&row)),
            });
        }
        Ok(found)
    }

    fn open_question_snapshot(
        &self,
        parent_id: &session::Id,
        child_id: &session::Id,
        question_id: &QuestionId,
        fingerprint: &LosslessString,
    ) -> Result<Option<OpenQuestion>, Error> {
        let snapshot = self.sessions.client.snapshot()?;
        let Some(row) = snapshot
            .get::<TaskTable>(&key(child_id.as_lossless()))?
            .filter(|row| row.parent_id == *parent_id.as_lossless())
            .filter(|row| {
                state_of(row) == "waiting" && row.question_id.as_ref() == Some(&question_id.0)
            })
        else {
            return Ok(None);
        };
        let archived = snapshot
            .get::<SessionTable>(&key(child_id.as_lossless()))?
            .is_none_or(|session| session.time_archived.is_some());
        if archived
            || &question_fingerprint(&row, &self.fingerprint_model(&row)) != fingerprint
            || review_fold::owns_question(&snapshot, child_id, question_id)?
        {
            return Ok(None);
        }
        let review = review_fold::latest_at(&snapshot, child_id.as_lossless())?;
        let task = self.present(&row)?;
        Ok(Some(OpenQuestion { row, task, review }))
    }

    pub async fn reconsider_question(
        &self,
        parent_id: &session::Id,
        child_id: &session::Id,
        question_id: &QuestionId,
        input: Reconsider<Task>,
        atomic: Atomic,
    ) -> Result<Reconsidered, Error> {
        let fingerprint = &input.fingerprint;
        let stale = Reconsidered::stale(fingerprint);
        let escalated = |reason: &str| Ok(Reconsidered::escalated(fingerprint, reason));
        let Some(_claim) =
            Reconsidering::acquire(&self.reconsidering, child_id.as_lossless().clone())
        else {
            return escalated("native-assessment-in-progress");
        };
        let (held, authority, effective) = {
            let _guard = self.lock(child_id.as_lossless()).await;
            let Some(held) =
                self.open_question_snapshot(parent_id, child_id, question_id, fingerprint)?
            else {
                return Ok(stale);
            };
            if !(input.gate.validate)(held.task.clone()).await {
                return escalated("delegation-invalid");
            }
            let Ok(authority) = self.autonomy.snapshot_inherited(child_id) else {
                return Ok(stale);
            };
            let Ok(effective) = self.autonomy.effective(child_id) else {
                return Ok(stale);
            };
            (held, authority, effective)
        };
        if !effective.can_auto_answer() && !effective.can_yolo_answer() {
            return escalated("explicit-decision:manual-answers");
        }
        let Some(question) = held.task.question.clone() else {
            return Ok(stale);
        };
        let options = question_options(question.data.as_ref());
        let outcome = if effective.can_yolo_answer() {
            self.evaluate_answer(child_id, &question, &Attribution::Unset)
                .await
        } else {
            match recommended(&options) {
                Some(text) => SleepAnswer::Answer(text),
                None => SleepAnswer::deferred(if options.is_empty() {
                    Reason::FreeText
                } else {
                    Reason::Disabled
                }),
            }
        };
        let text = match outcome {
            SleepAnswer::Answer(text) => text,
            SleepAnswer::Deferred { reason, .. } => {
                return Ok(Reconsidered::escalated(
                    fingerprint,
                    crate::coordination::decisions::id_text(&reason),
                ));
            }
        };
        let via = if effective.can_yolo_answer() {
            "yolo"
        } else {
            "auto-answer"
        };
        self.settle_question(
            parent_id,
            child_id,
            question_id,
            &held,
            authority,
            text,
            via,
            fingerprint,
            &input.gate,
            atomic,
        )
        .await
    }

    pub async fn reconcile_autonomy(&self, child_id: &session::Id) -> Result<bool, Error> {
        if !self
            .autonomy
            .effective(child_id)
            .is_ok_and(|effective| effective.can_yolo_answer())
        {
            return Ok(false);
        }
        let Some(_claim) =
            Reconsidering::acquire(&self.reconsidering, child_id.as_lossless().clone())
        else {
            return Ok(false);
        };
        let Some(row) = self
            .sessions
            .client
            .snapshot()?
            .get::<TaskTable>(&key(child_id.as_lossless()))?
            .filter(|row| state_of(row) == "waiting")
        else {
            return Ok(false);
        };
        let Some(question_id) = row.question_id.clone().map(QuestionId) else {
            return Ok(false);
        };
        let parent_id = session::Id::new(row.parent_id.clone())
            .map_err(|error| Error::InvalidRequest(error.to_string()))?;
        let fingerprint = question_fingerprint(&row, &self.fingerprint_model(&row));
        let Some(held) =
            self.open_question_snapshot(&parent_id, child_id, &question_id, &fingerprint)?
        else {
            return Ok(false);
        };
        let authority =
            self.autonomy
                .snapshot_inherited(child_id)
                .map_err(|error| match error {
                    autonomy::Error::NotFound(_) => Error::TaskNotFound(child_id.clone()),
                    autonomy::Error::Store(error) => Error::Store(error),
                })?;
        if !self
            .autonomy
            .effective(child_id)
            .is_ok_and(|effective| effective.can_yolo_answer())
        {
            return Ok(false);
        }
        let Some(question) = held.task.question.as_ref() else {
            return Ok(false);
        };
        let SleepAnswer::Answer(text) = self
            .evaluate_answer(child_id, question, &Attribution::Unset)
            .await
        else {
            return Ok(false);
        };
        let gate = crate::coordination::decisions::Gate {
            validate: Arc::new(|_| Box::pin(async { true })),
            current: Arc::new(|| true),
        };
        Ok(self
            .settle_question(
                &parent_id,
                child_id,
                &question_id,
                &held,
                authority,
                text,
                "yolo",
                &fingerprint,
                &gate,
                Arc::new(|_| Ok(true)),
            )
            .await?
            .settled)
    }

    pub async fn reconsider_question_goal(
        &self,
        parent_id: &session::Id,
        child_id: &session::Id,
        question_id: &QuestionId,
        input: GoalReconsider<Task, LosslessString>,
        atomic: Atomic,
    ) -> Result<Reconsidered, Error> {
        if self
            .autonomy
            .effective(child_id)
            .is_ok_and(|effective| effective.can_yolo_answer())
        {
            return self
                .reconsider_question(
                    parent_id,
                    child_id,
                    question_id,
                    Reconsider {
                        fingerprint: input.fingerprint,
                        source: input.source,
                        gate: input.gate,
                        decision: None,
                        answer: None,
                        confidence: None,
                    },
                    atomic,
                )
                .await;
        }
        let fingerprint = &input.fingerprint;
        let stale = Reconsidered::stale(fingerprint);
        let escalated = |reason: &str| Ok(Reconsidered::escalated(fingerprint, reason));
        let Some(_claim) =
            Reconsidering::acquire(&self.reconsidering, child_id.as_lossless().clone())
        else {
            return escalated("native-assessment-in-progress");
        };
        let (held, authority) = {
            let _guard = self.lock(child_id.as_lossless()).await;
            let Some(held) =
                self.open_question_snapshot(parent_id, child_id, question_id, fingerprint)?
            else {
                return Ok(stale);
            };
            if !(input.gate.validate)(held.task.clone()).await {
                return escalated("delegation-invalid");
            }
            let Ok(authority) = self.autonomy.snapshot_inherited(child_id) else {
                return Ok(stale);
            };
            (held, authority)
        };
        if input
            .confidence
            .is_some_and(|confidence| !confidence.is_finite() || confidence < ANSWER_THRESHOLD)
        {
            return escalated("low_confidence");
        }
        let Some(question) = held.task.question.clone() else {
            return Ok(stale);
        };
        let options = question_options(question.data.as_ref());
        let (text, via) = match input.answer.clone() {
            Some(text) if !text.code_units().all(is_whitespace) => (text, GOAL_VIA),
            _ => match recommended(&options) {
                Some(text) => (text, "auto-answer"),
                None => return escalated("refused"),
            },
        };
        self.settle_question(
            parent_id,
            child_id,
            question_id,
            &held,
            authority,
            text,
            via,
            fingerprint,
            &input.gate,
            atomic,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn settle_question(
        &self,
        parent_id: &session::Id,
        child_id: &session::Id,
        question_id: &QuestionId,
        held: &OpenQuestion,
        mut authority: autonomy::Snapshot,
        mut text: LosslessString,
        mut via: &'static str,
        fingerprint: &LosslessString,
        gate: &crate::coordination::decisions::Gate<Task>,
        atomic: Atomic,
    ) -> Result<Reconsidered, Error> {
        let stale = Reconsidered::stale(fingerprint);
        let escalated = |reason: &str| Ok(Reconsidered::escalated(fingerprint, reason));
        let caused_by = self
            .dispatch_anchor(child_id.as_lossless(), &Attribution::Unset)
            .await?;
        let _guard = self.lock(child_id.as_lossless()).await;
        let Some(latest) =
            self.open_question_snapshot(parent_id, child_id, question_id, fingerprint)?
        else {
            return Ok(stale);
        };
        if latest.row.revision != held.row.revision {
            return Ok(stale);
        }
        let ids = launch_ids(&latest.row)?;
        let answer_id = ids.answer(text_of(&question_id.0));
        if self.sessions.pending(&answer_id)?.is_some()
            || self.sessions.message(&answer_id)?.is_some()
        {
            return Ok(stale);
        }
        if !(gate.validate)(latest.task.clone()).await {
            return escalated("delegation-invalid");
        }
        let current = self
            .autonomy
            .snapshot_inherited(child_id)
            .map_err(autonomy_error)?;
        if current != authority {
            if !self
                .autonomy
                .effective(child_id)
                .map_err(autonomy_error)?
                .can_yolo_answer()
            {
                return escalated("stale-assessment");
            }
            let Some(question) = latest.task.question.as_ref() else {
                return Ok(stale);
            };
            let options = question_options(question.data.as_ref());
            text = recommended(&options)
                .or_else(|| {
                    options
                        .into_iter()
                        .find(|option| !option.code_units().all(is_whitespace))
                })
                .unwrap_or_else(|| crate::tools::policy::PROGRESSION.into());
            authority = current;
            via = "yolo";
        }
        if !(gate.current)() {
            return escalated("delegation-invalid");
        }
        match self
            .commit_answer(
                &latest.row,
                parent_id,
                question_id,
                Some(text),
                None,
                caused_by,
                Gate::Fence(latest.review),
                Some(Automatic {
                    via,
                    revision: held.row.revision,
                    fingerprint: fingerprint.clone(),
                    authority,
                    atomic,
                }),
            )
            .await
        {
            Ok(wake) => {
                if wake {
                    self.execution.wake(child_id)?;
                }
                Ok(Reconsidered::settled(
                    fingerprint,
                    DecisionOutcome::Allowed,
                    via,
                ))
            }
            Err(error) if review_fold::is_changed(&error) => escalated("stale-assessment"),
            Err(ycoding_store::Error::Domain {
                kind: "authority_changed",
                ..
            }) => escalated("stale-assessment"),
            Err(ycoding_store::Error::Domain {
                kind: "question_closed" | "input_identity",
                ..
            }) => Ok(stale),
            Err(error) => Err(Error::Store(error)),
        }
    }

    pub async fn cancel(
        &self,
        parent_id: &session::Id,
        child_id: &session::Id,
    ) -> Result<Task, Error> {
        let _guard = self.lock(child_id.as_lossless()).await;
        let row = self.owned(parent_id, child_id)?;
        let state = state_of(&row);
        if state == "cancelled" {
            return self.present(&row);
        }
        if !["starting", "running", "waiting", "supervising"].contains(&state.as_str()) {
            return Err(Error::Conflict(format!("Cannot cancel task in {state}")));
        }
        self.request_cancel(child_id).await?;
        match self.execution.interrupt(child_id).await {
            Ok(()) | Err(run_coordinator::Error::Interrupted(_)) => {}
            Err(error) => return Err(error.into()),
        }
        self.publish(child_id, Change::Cancelled, None).await?;
        self.current(child_id)
    }

    pub async fn resume(
        &self,
        parent_id: &session::Id,
        child_id: &session::Id,
    ) -> Result<Task, Error> {
        let _guard = self.lock(child_id.as_lossless()).await;
        let row = self.owned(parent_id, child_id)?;
        let state = state_of(&row);
        if state != "running" && state != "starting" {
            return Err(Error::Conflict(format!("Cannot resume task in {state}")));
        }
        if self.sessions.pending_list(child_id)?.is_empty() {
            return Err(Error::Conflict(format!(
                "No durable pending work for {}",
                text(child_id.as_lossless())
            )));
        }
        self.execution.wake(child_id)?;
        self.present(&row)
    }

    pub async fn progress(&self, child_id: &session::Id, text: &str) -> Result<Task, Error> {
        let _guard = self.lock(child_id.as_lossless()).await;
        let row = self
            .task(child_id)?
            .ok_or_else(|| Error::TaskNotFound(child_id.clone()))?;
        if state_of(&row) != "running" {
            return Err(Error::Conflict(format!(
                "Cannot report progress in {}",
                state_of(&row)
            )));
        }
        self.publish(
            child_id,
            Change::Progressed {
                progress: ycoding_schema::session_orchestration::Progress {
                    text: truncate_utf8(text, PROGRESS_BYTES).into(),
                    time: non_negative(now())?,
                },
            },
            None,
        )
        .await?;
        self.current(child_id)
    }

    pub async fn question(
        &self,
        child_id: &session::Id,
        text: &str,
        data: Option<domain::Json>,
    ) -> Result<Asked, Error> {
        self.question_attributed(child_id, text, data, &Attribution::Unset)
            .await
    }

    pub async fn question_attributed(
        &self,
        child_id: &session::Id,
        text: &str,
        data: Option<domain::Json>,
        attribution: &Attribution,
    ) -> Result<Asked, Error> {
        let _guard = self.lock(child_id.as_lossless()).await;
        let row = self
            .task(child_id)?
            .ok_or_else(|| Error::TaskNotFound(child_id.clone()))?;
        if state_of(&row) != "running" || row.question_id.is_some() {
            return Err(Error::Conflict(format!(
                "Cannot ask a question in {}",
                state_of(&row)
            )));
        }
        let hash = sha256(&format!(
            "{}\0{}\0{text}",
            text_of(child_id.as_lossless()),
            row.revision
        ));
        let mut question = Question {
            id: QuestionId(format!("qst_{}", &hash[..24]).into()),
            text: truncate_utf8(text, QUESTION_BYTES).into(),
            data,
            time: non_negative(now())?,
            deferred: None,
        };
        Question::decode(&question.encode())
            .map_err(|error| Error::InvalidRequest(error.to_string()))?;
        let effective = self
            .autonomy
            .effective(child_id)
            .map_err(|error| match error {
                autonomy::Error::NotFound(_) => Error::TaskNotFound(child_id.clone()),
                autonomy::Error::Store(error) => Error::Store(error),
            })?;
        let options = question_options(question.data.as_ref());
        let deterministic = effective
            .can_auto_answer()
            .then(|| recommended(&options))
            .flatten();
        let fence = self
            .autonomy
            .snapshot_inherited(child_id)
            .map_err(autonomy_error)?;
        let evaluated = match deterministic {
            Some(text) => SleepAnswer::Answer(text),
            None if effective.can_yolo_answer() => {
                self.evaluate_answer(child_id, &question, attribution).await
            }
            None if effective.can_auto_answer() && options.is_empty() => {
                SleepAnswer::deferred(Reason::FreeText)
            }
            None => SleepAnswer::deferred(Reason::Disabled),
        };
        let current = self
            .autonomy
            .snapshot_inherited(child_id)
            .map_err(autonomy_error)?;
        let current_effective = self.autonomy.effective(child_id).map_err(autonomy_error)?;
        let outcome = if current != fence {
            if current_effective.can_yolo_answer() {
                SleepAnswer::Answer(
                    recommended(&options)
                        .or_else(|| {
                            options
                                .into_iter()
                                .find(|option| !option.code_units().all(is_whitespace))
                        })
                        .unwrap_or_else(|| crate::tools::policy::PROGRESSION.into()),
                )
            } else {
                SleepAnswer::deferred(Reason::Disabled)
            }
        } else {
            evaluated
        };
        let asleep = current_effective.deferred;
        if asleep
            && let SleepAnswer::Deferred {
                reason,
                choice,
                confidence,
            } = &outcome
        {
            let reviews = self
                .reviews
                .as_ref()
                .ok_or_else(|| Error::Conflict("The review box is unavailable".into()))?;
            reviews
                .service
                .open(crate::session::review::OpenInput {
                    session_id: child_id.clone(),
                    kind: Kind::SubagentQuestion,
                    reason: *reason,
                    choice: choice.clone(),
                    confidence: *confidence,
                    grades: None,
                    origin: Origin::Question {
                        question_id: question.id.clone(),
                    },
                    payload: ycoding_schema::session_review::Payload::SubagentQuestion(
                        ycoding_schema::session_review::SubagentQuestionPayload {
                            text: question.text.clone(),
                            data: question.data.clone(),
                        },
                    ),
                    limit: reviews.limit,
                    conversion: false,
                    created: now(),
                })
                .await
                .map_err(|error| Error::Conflict(error.to_string()))?;
            question.deferred = Some(true);
            self.publish(
                child_id,
                Change::QuestionAsked {
                    question: question.clone(),
                },
                None,
            )
            .await?;
            return Ok(Asked {
                question,
                auto_answered: false,
            });
        }
        let answer_text = match outcome {
            SleepAnswer::Answer(text) => Some(text),
            SleepAnswer::Deferred { .. } => None,
        };
        let Some(answer_text) = answer_text else {
            self.publish(
                child_id,
                Change::QuestionAsked {
                    question: question.clone(),
                },
                None,
            )
            .await?;
            return Ok(Asked {
                question,
                auto_answered: false,
            });
        };
        let ids = launch_ids(&row)?;
        let body = ObjectEncoder::new()
            .field("questionID", &question.id.0)
            .field("text", &answer_text)
            .finish();
        let caused_by = self
            .dispatch_anchor(child_id.as_lossless(), attribution)
            .await?;
        let input = synthetic(
            format!("Parent answer:\n{}", json_text(&body)),
            "Autonomous subagent answer",
            ObjectEncoder::new()
                .field("source", "subagent_parent")
                .field("parentID", &row.parent_id)
                .field("childID", child_id)
                .field("kind", "answer")
                .field("questionID", &question.id.0)
                .field("automatic", &true)
                .field(
                    "via",
                    if current_effective.can_yolo_answer() {
                        "yolo"
                    } else {
                        "auto-answer"
                    },
                )
                .finish(),
            "steer",
        )?;
        let request = pending::Request {
            id: ids.answer(text_of(&question.id.0)),
            session_id: child_id.clone(),
            input,
            event_id: random_event_id()?,
            created: now(),
        };
        let owner = child_id.clone();
        let wake = self
            .sessions
            .client
            .submit(move |tx| {
                let authority = match autonomy::inherited_in_tx(tx, &owner) {
                    Ok(authority) => authority,
                    Err(autonomy::Error::NotFound(_)) => {
                        return Err(tx.reject(ycoding_store::Error::Domain {
                            kind: "authority_changed",
                            message: "Answer authority is unavailable",
                        }));
                    }
                    Err(autonomy::Error::Store(error)) => return Err(error),
                };
                if authority != current {
                    return Err(tx.reject(ycoding_store::Error::Domain {
                        kind: "authority_changed",
                        message: "Answer authority changed before admission",
                    }));
                }
                pending::admit_in(tx, &request, &caused_by)?;
                Ok(tx
                    .get::<SessionTable>(&key(owner.as_lossless()))?
                    .is_some_and(|session| session.revert.is_none()))
            })?
            .await
            .map_err(|error| match error {
                ycoding_store::Error::Domain {
                    kind: "authority_changed",
                    ..
                } => Error::Conflict("Answer authority changed before admission".into()),
                error => Error::Store(error),
            })?;
        if wake {
            self.execution.wake(child_id)?;
        }
        Ok(Asked {
            question,
            auto_answered: true,
        })
    }

    async fn evaluate_answer(
        &self,
        child_id: &session::Id,
        question: &Question,
        attribution: &Attribution,
    ) -> SleepAnswer {
        match self.assess_answer(child_id, question, attribution).await {
            answer @ SleepAnswer::Answer(_) => answer,
            SleepAnswer::Deferred { .. } => {
                let options = question_options(question.data.as_ref());
                SleepAnswer::Answer(
                    recommended(&options)
                        .or_else(|| {
                            options.into_iter().find(|option| {
                                option
                                    .to_utf8()
                                    .is_ok_and(|option| !option.trim().is_empty())
                            })
                        })
                        .unwrap_or_else(|| crate::tools::policy::PROGRESSION.into()),
                )
            }
        }
    }

    async fn assess_answer(
        &self,
        child_id: &session::Id,
        question: &Question,
        attribution: &Attribution,
    ) -> SleepAnswer {
        let options = question_options(question.data.as_ref());
        let Some(evaluator) = (self.question_evaluator)(child_id) else {
            return SleepAnswer::deferred(Reason::Unavailable);
        };
        let redacted = options
            .iter()
            .map(|value| {
                crate::process::guardrails::redact_value(&JsonValue::String(value.clone()))
            })
            .collect::<Vec<_>>();
        // Redaction can collapse distinct options; an ambiguous result must stay with the user.
        if options.len() > 255
            || redacted
                .iter()
                .enumerate()
                .any(|(index, value)| redacted[..index].contains(value))
        {
            return SleepAnswer::deferred(Reason::InvalidRequest);
        }
        let instructions = "Answer this subagent's question from the evidence given. Refuse when the evidence does not support an answer; an unsettled result uses a valid fallback.";
        let asked = if options.is_empty() {
            crate::tools::policy::text_question("subagent_question", instructions, 8192)
        } else {
            crate::tools::policy::option_question(
                "subagent_question",
                instructions,
                redacted
                    .iter()
                    .map(|value| ObjectEncoder::new().field("value", value).finish())
                    .collect(),
            )
        };
        let request = ObjectEncoder::new()
            .field(
                "state",
                &crate::process::guardrails::redact_value(
                    &ObjectEncoder::new()
                        .field("question", &question.text)
                        .field("options", &options)
                        .finish(),
                ),
            )
            .field("questions", &vec![asked])
            .finish();
        let judgment = match crate::resources::decision::judgment::Request::decode(&request) {
            Ok(request) => request,
            Err(error) => return SleepAnswer::deferred(error.review_reason()),
        };
        let request = ObjectEncoder::new()
            .field("provider", "agent")
            .field("request", &request)
            .finish();
        if stringify_json(&request).len() > crate::resources::decision::judgment::BYTE_LIMIT {
            return SleepAnswer::deferred(Reason::InputTooLarge);
        }
        let cancellation = Cancellation::default();
        let key = text_of(&question.id.0);
        let response = tokio::time::timeout(
            Duration::from_secs(60),
            evaluator.evaluate(
                request,
                crate::resources::decision::Invocation {
                    session_id: child_id,
                    input_id: None,
                    cancellation: &cancellation,
                    attribution: attribution.clone(),
                    purpose: Some(crate::resources::decision::Purpose::Answer),
                    authority: Some(guardrail::Authority::Yolo),
                    invocation_key: Some(key),
                },
            ),
        )
        .await;
        cancellation.cancel();
        let response = match response {
            Err(_) => return SleepAnswer::deferred(Reason::Timeout),
            Ok(Err(error)) => return SleepAnswer::deferred(error.review_reason()),
            Ok(Ok(response)) => response,
        };
        sleep_choice(&response, &options, &redacted, &judgment)
    }

    pub async fn settle(
        &self,
        child_id: &session::Id,
        settlement: Settlement,
    ) -> Result<Task, Error> {
        let _guard = self.lock(child_id.as_lossless()).await;
        let row = self
            .task(child_id)?
            .ok_or_else(|| Error::TaskNotFound(child_id.clone()))?;
        let state = state_of(&row);
        if TERMINAL.contains(&state.as_str()) {
            return self.present(&row);
        }
        if state != "running" && state != "supervising" {
            return Err(Error::Conflict(format!("Cannot settle task in {state}")));
        }
        let excerpt = |value: Option<String>| {
            value.map(|value| LosslessString::from(truncate_utf8(&value, EXCERPT_BYTES)))
        };
        let change = match settlement {
            Settlement::Completed { excerpt: value } => Change::Completed {
                excerpt: excerpt(value),
            },
            Settlement::Failed {
                error,
                excerpt: value,
            } => Change::Failed {
                error: truncate_utf8(&error, EXCERPT_BYTES).into(),
                excerpt: excerpt(value),
            },
            Settlement::Lost { excerpt: value } => Change::Lost {
                excerpt: excerpt(value),
            },
        };
        self.publish(child_id, change, None).await?;
        self.current(child_id)
    }

    pub async fn reconcile_stale(&self) -> Result<usize, Error> {
        self.reconcile_stale_with_processes(ledger::processes).await
    }

    pub async fn reconcile_stale_with_processes<P, F>(&self, processes: P) -> Result<usize, Error>
    where
        P: FnOnce() -> F,
        F: std::future::Future<Output = std::io::Result<Vec<ledger::Process>>>,
    {
        let mut reconciled = self.reconciled.lock().await;
        if *reconciled {
            return Ok(0);
        }
        let mut rows = self
            .sessions
            .client
            .snapshot()?
            .scan::<TaskTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)?
            .into_iter()
            .filter(|row| ACTIVE.contains(&state_of(row).as_str()))
            .collect::<Vec<_>>();
        rows.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        if rows.is_empty() {
            *reconciled = true;
            return Ok(0);
        }
        let snapshot = match processes().await {
            Ok(snapshot) => snapshot,
            Err(_) => {
                tracing::warn!("could not list processes; active child tasks were not reconciled");
                return Ok(0);
            }
        };
        let mut lost = 0;
        for row in &rows {
            if (row.state.as_str() == Some("waiting")
                && row.question_id.is_some()
                && row.question.is_some()
                && row.question_time.is_some())
                || ledger::alive(&snapshot, row.owner_pid, row.owner_started.as_ref())
            {
                continue;
            }
            let child_id = session_id(&row.session_id)?;
            let _guard = self.lock(&row.session_id).await;
            self.publish(
                &child_id,
                Change::Lost {
                    excerpt: Some(RESTART_LOST.into()),
                },
                Some(restart_lost_id(&row.session_id, row.revision + 1)),
            )
            .await?;
            lost += 1;
        }
        *reconciled = true;
        Ok(lost)
    }

    pub(crate) fn parent_of(&self, child_id: &session::Id) -> Result<Option<session::Id>, Error> {
        let snapshot = self.sessions.client.snapshot()?;
        let Some(row) = snapshot.get::<SessionTable>(&key(child_id.as_lossless()))? else {
            return Ok(None);
        };
        row.parent_id
            .filter(|parent| !parent.is_empty())
            .map(|parent| {
                session::Id::new(parent)
                    .map_err(|error| Error::Store(ycoding_store::Error::Record(Box::new(error))))
            })
            .transpose()
    }

    pub(super) fn task(
        &self,
        child_id: &session::Id,
    ) -> Result<Option<ycoding_store::session::Task>, Error> {
        Ok(self
            .sessions
            .client
            .snapshot()?
            .get::<TaskTable>(&key(child_id.as_lossless()))?)
    }

    pub(super) async fn lock(&self, id: &LosslessString) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = self
            .locks
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .entry(id.clone())
            .or_default()
            .clone();
        lock.lock_owned().await
    }

    async fn request_cancel(&self, child_id: &session::Id) -> Result<(), Error> {
        for _ in 0..ATTEMPTS {
            let withdrawals = {
                let snapshot = self.sessions.client.snapshot()?;
                let items = review_fold::fold(&snapshot, &[child_id.as_lossless().clone()])?
                    .into_iter()
                    .filter(|item| {
                        item.is_open()
                            && item.deferral.kind == Kind::SubagentQuestion
                            && matches!(item.deferral.origin, Origin::Question { .. })
                    })
                    .map(|item| item.item_id)
                    .collect();
                Withdrawals::new(
                    &snapshot,
                    child_id,
                    items,
                    WithdrawReason::TaskClosed,
                    now(),
                )?
            };
            let event = NewEvent {
                id: random_event_id()?.as_lossless().clone(),
                aggregate_id: child_id.as_lossless().clone(),
                created: now(),
                type_: "session.task.updated.1".into(),
                data: ObjectEncoder::new()
                    .field("sessionID", child_id)
                    .field("change", &Change::CancelRequested)
                    .finish(),
            };
            match self
                .sessions
                .client
                .submit(move |tx| {
                    withdrawals.append(tx)?;
                    projector::append(tx, &event).map(|_| ())
                })?
                .await
            {
                Err(error) if review_fold::is_changed(&error) => continue,
                result => return Ok(result?),
            }
        }
        Err(Error::Conflict(format!(
            "Review state for {} kept changing during cancellation",
            text(child_id.as_lossless())
        )))
    }

    async fn dispatch_anchor(
        &self,
        session: &LosslessString,
        attribution: &Attribution,
    ) -> Result<Option<usage_anchor::Ref>, Error> {
        Ok(usage_attribution::dispatch(&self.sessions.client, session, attribution).await?)
    }

    pub(super) async fn admit(
        &self,
        session_id: &session::Id,
        id: &session_message::Id,
        input: session_pending::Message,
        caused_by: Option<usage_anchor::Ref>,
    ) -> Result<bool, Error> {
        self.sessions
            .admit_input_attributed(
                crate::session::pending::Request {
                    id: id.clone(),
                    session_id: session_id.clone(),
                    input,
                    event_id: random_event_id()?,
                    created: now(),
                },
                caused_by,
            )
            .await
            .map(|admitted| admitted.wake)
            .map_err(|error| match error {
                ycoding_store::Error::Domain {
                    kind: "input_identity",
                    ..
                } => Error::Conflict(format!(
                    "Conflicting input for {}",
                    text(session_id.as_lossless())
                )),
                error => Error::Store(error),
            })
    }

    pub(super) async fn publish(
        &self,
        child_id: &session::Id,
        change: Change,
        event_id: Option<LosslessString>,
    ) -> Result<(), Error> {
        let settles = matches!(
            change,
            Change::Cancelled
                | Change::Completed { .. }
                | Change::Failed { .. }
                | Change::Lost { .. }
        );
        self.sessions
            .publish(NewEvent {
                id: match event_id {
                    Some(id) => id,
                    None => random_event_id()?.as_lossless().clone(),
                },
                aggregate_id: child_id.as_lossless().clone(),
                created: now(),
                type_: "session.task.updated.1".into(),
                data: ObjectEncoder::new()
                    .field("sessionID", child_id)
                    .field("change", &change)
                    .finish(),
            })
            .await?;
        if settles {
            self.held
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(child_id.as_lossless());
        }
        Ok(())
    }

    async fn reserve(
        &self,
        input: &LaunchInput,
        cancellation: &crate::tools::code_mode::Cancellation,
    ) -> Result<Reservation, Error> {
        let call = super::preflight::ToolCall {
            agent: input.prepared.agent.clone(),
            message_id: input.parent_assistant_message_id.as_lossless().clone(),
            call_id: input.tool_call_id.clone().into(),
        };
        let reservation = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(Error::Cancelled),
            reservation = super::preflight::reserve(
            &input.guardrails,
            &input.parent_id,
            &input.prepared.agent,
            &input.description,
            &call,
            ) => reservation?,
        };
        if cancellation.is_cancelled() {
            return Err(Error::Cancelled);
        }
        Ok(reservation)
    }

    fn hold(&self, ids: &Launch, reservation: Reservation) {
        self.held
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .entry(ids.child_id.as_lossless().clone())
            .or_insert(reservation);
    }

    fn launch_prompt(
        &self,
        ids: &Launch,
        input: &LaunchInput,
        selected: Option<&shared_context::Selection>,
    ) -> Result<session_pending::UserData, Error> {
        if let Some(pending) = self.sessions.pending(&ids.input_id)? {
            if pending.session_id != *ids.child_id.as_lossless()
                || pending.type_.as_str() != Some("user")
            {
                return Err(Error::Conflict("Conflicting initial child input".into()));
            }
            return session_pending::UserData::decode(&pending.data)
                .map_err(|error| Error::InvalidRequest(error.to_string()));
        }
        if let Some((owner, message)) = self.sessions.message(&ids.input_id)? {
            if owner != ids.child_id {
                return Err(Error::Conflict("Conflicting initial child input".into()));
            }
            let session_message::Info::User(user) = message else {
                return Err(Error::Conflict("Conflicting initial child input".into()));
            };
            return Ok(session_pending::UserData {
                text: user.text,
                files: user.files,
                agents: user.agents,
                metadata: user.metadata,
            });
        }
        // An admitted snapshot remains authoritative even after its projected message is pruned.
        let snapshot = self.sessions.client.snapshot()?;
        let prefix = ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(ids.child_id.as_lossless()),
            ycoding_store::KeyPart::String(&"session.input.admitted.1".into()),
        ]);
        let mut after = None;
        loop {
            let events = snapshot.index_range::<ycoding_store::session::EventTable>(
                "event_aggregate_type_seq_idx",
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Unbounded,
                    prefix: Some(&prefix),
                    order: IndexOrder::Ascending,
                    after: after.as_ref(),
                    limit: 128,
                },
            )?;
            for event in &events {
                let JsonValue::Object(data) = &event.record.data else {
                    continue;
                };
                if data.get(&"inputID".into())
                    != Some(&JsonValue::String(ids.input_id.as_lossless().clone()))
                {
                    continue;
                }
                let message = data
                    .get(&"input".into())
                    .ok_or_else(|| Error::Conflict("Invalid initial child input".into()))?;
                let session_pending::Message::User(user) =
                    session_pending::Message::decode(message)
                        .map_err(|error| Error::InvalidRequest(error.to_string()))?
                else {
                    return Err(Error::Conflict("Conflicting initial child input".into()));
                };
                return Ok(user.data);
            }
            let Some(last) = events.last() else { break };
            after = Some(last.cursor.clone());
        }
        let Some(selected) = selected else {
            return Ok(session_pending::UserData {
                text: input.prompt.as_str().into(),
                files: None,
                agents: None,
                metadata: None,
            });
        };
        let context = shared_context::resolve(&input.parent_id, selected, |message_id| {
            self.sessions
                .message(message_id)
                .map(|message| {
                    message
                        .and_then(|(owner, message)| (owner == input.parent_id).then_some(message))
                })
                .map_err(|error| error.to_string())
        })
        .map_err(Error::InvalidRequest)?;
        shared_context::compose(&input.prompt, &context).map_err(Error::InvalidRequest)
    }

    async fn start(
        &self,
        ids: &Launch,
        prompt: session_pending::UserData,
        caused_by: Option<usage_anchor::Ref>,
    ) -> Result<Task, Error> {
        let input = session_pending::Message::decode(
            &ObjectEncoder::new()
                .field("type", "user")
                .field("data", &prompt)
                .field("delivery", "steer")
                .finish(),
        )
        .map_err(|error| Error::InvalidRequest(error.to_string()))?;
        self.admit(&ids.child_id, &ids.input_id, input, caused_by)
            .await?;
        self.publish(
            &ids.child_id,
            Change::Started,
            Some(ids.started_event_id.as_lossless().clone()),
        )
        .await?;
        self.execution.wake(&ids.child_id)?;
        self.current(&ids.child_id)
    }

    fn current(&self, child_id: &session::Id) -> Result<Task, Error> {
        let row = self
            .task(child_id)?
            .ok_or(Error::Store(ycoding_store::Error::Rejected(
                "Projected task missing",
            )))?;
        self.present(&row)
    }

    pub(super) fn present(&self, row: &ycoding_store::session::Task) -> Result<Task, Error> {
        let mut task = task_from_row(row)?;
        if let Some(info) = self.sessions.get(&task.session_id)?
            && let Some(model) = info.model
        {
            task.model = model;
        }
        Ok(task)
    }

    fn fingerprint_model(&self, row: &ycoding_store::session::Task) -> JsonValue {
        let Ok(id) = session::Id::new(row.session_id.clone()) else {
            return row.model.value().clone();
        };
        match self.sessions.get(&id) {
            Ok(Some(info)) => info
                .model
                .map_or_else(|| row.model.value().clone(), |model| model.encode()),
            _ => row.model.value().clone(),
        }
    }

    fn owned(
        &self,
        parent_id: &session::Id,
        child_id: &session::Id,
    ) -> Result<ycoding_store::session::Task, Error> {
        self.require_session(parent_id)?;
        if let Some(row) = self.task(child_id)?
            && row.parent_id == *parent_id.as_lossless()
        {
            return Ok(row);
        }
        if self.sessions.get(child_id)?.is_some() {
            return Err(Error::Forbidden {
                parent_id: parent_id.clone(),
                child_id: child_id.clone(),
            });
        }
        Err(Error::NotFound {
            parent_id: parent_id.clone(),
            child_id: child_id.clone(),
        })
    }

    pub(super) fn require_session(&self, id: &session::Id) -> Result<(), Error> {
        self.sessions
            .get(id)?
            .map(|_| ())
            .ok_or_else(|| Error::SessionNotFound(id.clone()))
    }

    pub(super) fn children(
        &self,
        parent_id: &session::Id,
    ) -> Result<Vec<ycoding_store::session::Task>, Error> {
        let snapshot = self.sessions.client.snapshot()?;
        let prefix = key(parent_id.as_lossless());
        let mut after = None;
        let mut rows = Vec::new();
        loop {
            let page = snapshot.index_range::<TaskTable>(
                "session_task_parent_state_updated_idx",
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Unbounded,
                    prefix: Some(&prefix),
                    order: IndexOrder::Ascending,
                    after: after.as_ref(),
                    limit: 128,
                },
            )?;
            if page.is_empty() {
                return Ok(rows);
            }
            after = page.last().map(|entry| entry.cursor.clone());
            rows.extend(page.into_iter().map(|entry| entry.record));
        }
    }

    fn tasks(&self, parent_id: &session::Id) -> Result<Vec<Task>, Error> {
        self.children(parent_id)?
            .iter()
            .map(|row| self.present(row))
            .collect::<Result<Vec<_>, _>>()
    }
}

pub(super) const ACTIVE: [&str; 5] = [
    "starting",
    "running",
    "waiting",
    "supervising",
    "cancelling",
];
pub(super) const TERMINAL: [&str; 4] = ["cancelled", "completed", "failed", "lost"];

pub(super) fn question_fingerprint(
    row: &ycoding_store::session::Task,
    model: &JsonValue,
) -> LosslessString {
    let question = row
        .question_id
        .as_ref()
        .zip(row.question.as_ref())
        .map(|(id, text)| {
            ObjectEncoder::new()
                .field("id", id)
                .field("text", text)
                .optional(
                    "data",
                    &row.question_data.as_ref().map(|data| data.value().clone()),
                )
                .optional("time", &row.question_time.map(|time| time as f64))
                .finish()
        });
    let progress = row
        .progress
        .as_ref()
        .zip(row.progress_time)
        .map(|(text, time)| {
            ObjectEncoder::new()
                .field("text", text)
                .field("time", &(time as f64))
                .finish()
        });
    sha256(&crate::session::prompt_cache::canonical_json(
        &ObjectEncoder::new()
            .field("sessionID", &row.session_id)
            .field("parentID", &row.parent_id)
            .field("description", &row.description)
            .field("agent", &row.agent)
            .field("model", model)
            .field("background", &(row.background != 0))
            .field("state", &row.state)
            .field("revision", &(row.revision as f64))
            .optional("progress", &progress)
            .field(
                "time",
                &ObjectEncoder::new()
                    .field("created", &(row.time_created as f64))
                    .field("updated", &(row.time_updated as f64))
                    .finish(),
            )
            .optional("question", &question)
            .finish(),
    ))
    .into()
}

pub(super) fn state_of(row: &ycoding_store::session::Task) -> String {
    row.state.as_str().unwrap_or_default().to_owned()
}

pub(super) fn restart_lost_id(session_id: &LosslessString, revision: i64) -> LosslessString {
    format!("evt_task_restart_lost_{}_{revision}", text_of(session_id)).into()
}

pub(super) fn launch_ids(row: &ycoding_store::session::Task) -> Result<Launch, Error> {
    Ok(Launch::new(
        &session_id(&row.parent_id)?,
        &session_message::Id::new(row.parent_assistant_message_id.clone())
            .map_err(|error| Error::Store(ycoding_store::Error::Record(Box::new(error))))?,
        text_of(&row.tool_call_id),
    ))
}

pub(super) fn session_id(id: &LosslessString) -> Result<session::Id, Error> {
    session::Id::new(id.clone())
        .map_err(|error| Error::Store(ycoding_store::Error::Record(Box::new(error))))
}

pub(super) fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub(super) fn non_negative(value: i64) -> Result<ycoding_schema::schema::NonNegativeInt, Error> {
    ycoding_schema::schema::NonNegativeInt::new(value)
        .map_err(|error| Error::Store(ycoding_store::Error::Record(Box::new(error))))
}

fn text_of(value: &LosslessString) -> &str {
    value.as_str().unwrap_or_default()
}

fn text(value: &LosslessString) -> &str {
    text_of(value)
}

fn json_text(value: &JsonValue) -> String {
    stringify_json(value)
}

enum Gate {
    Fence(i64),
    Claim(Claim),
    Native {
        fence: i64,
        fingerprint: LosslessString,
        gate: crate::dots::authority::Gate,
    },
}

pub(super) fn synthetic(
    text: String,
    description: &str,
    metadata: JsonValue,
    delivery: &str,
) -> Result<session_pending::Message, Error> {
    session_pending::Message::decode(
        &ObjectEncoder::new()
            .field("type", "synthetic")
            .field(
                "data",
                &ObjectEncoder::new()
                    .field("text", text.as_str())
                    .field("description", description)
                    .field("metadata", &metadata)
                    .finish(),
            )
            .field("delivery", delivery)
            .finish(),
    )
    .map_err(|error| Error::InvalidRequest(error.to_string()))
}

fn answer_error(child_id: &session::Id, error: ycoding_store::Error) -> Error {
    match error {
        ycoding_store::Error::Domain {
            kind: "input_identity",
            ..
        } => Error::Conflict(format!(
            "Conflicting input for {}",
            text(child_id.as_lossless())
        )),
        ycoding_store::Error::Domain {
            kind: "question_closed",
            message,
        } => Error::Conflict(message.into()),
        error => Error::Store(error),
    }
}

fn delivery_error(error: Error) -> DeliveryError {
    match error {
        Error::Store(error) => DeliveryError::Store(error),
        error => DeliveryError::Conflict(error.to_string()),
    }
}

fn autonomy_error(error: autonomy::Error) -> Error {
    match error {
        autonomy::Error::NotFound(id) => Error::TaskNotFound(id),
        autonomy::Error::Store(error) => Error::Store(error),
    }
}

fn recommended(options: &[LosslessString]) -> Option<LosslessString> {
    let suffix = " (Recommended)".encode_utf16().collect::<Vec<_>>();
    let marked = options
        .iter()
        .filter(|option| option.code_units().collect::<Vec<_>>().ends_with(&suffix))
        .collect::<Vec<_>>();
    match marked.as_slice() {
        [only] => Some((*only).clone()),
        _ => None,
    }
}

fn question_options(data: Option<&domain::Json>) -> Vec<LosslessString> {
    let Some(JsonValue::Object(data)) = data.map(domain::Json::as_value) else {
        return vec![];
    };
    let Some(JsonValue::Array(options)) = data.get(&"options".into()) else {
        return vec![];
    };
    options
        .iter()
        .filter_map(|option| match option {
            JsonValue::String(value) => Some(value.clone()),
            JsonValue::Object(option) => match option.get(&"label".into()) {
                Some(JsonValue::String(label)) => Some(label.clone()),
                _ => match option.get(&"value".into()) {
                    Some(JsonValue::String(value)) => Some(value.clone()),
                    _ => None,
                },
            },
            _ => None,
        })
        .collect()
}

fn sleep_choice(
    response: &JsonValue,
    options: &[LosslessString],
    redacted: &[JsonValue],
    judgment: &crate::resources::decision::judgment::Request,
) -> SleepAnswer {
    let JsonValue::Object(response) = response else {
        return SleepAnswer::deferred(Reason::InvalidOutput);
    };
    let Some(JsonValue::Object(response)) = response.get(&"response".into()) else {
        return SleepAnswer::deferred(Reason::InvalidOutput);
    };
    let Some(JsonValue::Array(answers)) = response.get(&"answers".into()) else {
        return SleepAnswer::deferred(Reason::InvalidOutput);
    };
    let answers = match judgment.parse(&stringify_json(
        &ObjectEncoder::new()
            .field(
                "decisions",
                &ObjectEncoder::new()
                    .field("version", &1.0)
                    .field("answers", answers)
                    .finish(),
            )
            .finish(),
    )) {
        Ok(answers) => answers,
        Err(error) => return SleepAnswer::deferred(error.review_reason()),
    };
    let [JsonValue::Object(answer)] = answers.as_slice() else {
        return SleepAnswer::deferred(Reason::InvalidOutput);
    };
    if answer.get(&"type".into()) == Some(&JsonValue::String("refusal".into())) {
        return SleepAnswer::deferred(Reason::Refused);
    }
    if options.is_empty() {
        return match (
            answer.get(&"text".into()),
            answer
                .get(&"confidence".into())
                .and_then(|value| guardrail::Confidence::decode(value).ok()),
        ) {
            (Some(JsonValue::String(text)), Some(confidence)) if confidence.get() >= 0.8 => {
                SleepAnswer::Answer(text.clone())
            }
            (Some(JsonValue::String(_)), Some(_)) => SleepAnswer::deferred(Reason::LowConfidence),
            _ => SleepAnswer::deferred(Reason::InvalidOutput),
        };
    }
    if answer.get(&"type".into()) != Some(&JsonValue::String("choice".into())) {
        return SleepAnswer::deferred(Reason::InvalidOutput);
    }
    let Some(index) = answer
        .get(&"choice".into())
        .and_then(|choice| redacted.iter().position(|value| value == choice))
    else {
        return SleepAnswer::deferred(Reason::InvalidOutput);
    };
    let Some(confidence) = answer
        .get(&"confidence".into())
        .and_then(|value| guardrail::Confidence::decode(value).ok())
    else {
        return SleepAnswer::deferred(Reason::InvalidOutput);
    };
    if confidence.get() >= 0.8 {
        return SleepAnswer::Answer(options[index].clone());
    }
    SleepAnswer::Deferred {
        reason: Reason::LowConfidence,
        choice: Some(options[index].clone()),
        confidence: Some(confidence),
    }
}
