use super::{
    ceiling,
    identity::Launch,
    view::{self, Rendered, TEAM_VIEW_BYTES, task_from_row, truncate_utf8},
};
use crate::{
    process::guardrails::{Guardrails, Reservation},
    session::{
        autonomy, key,
        projector::random_event_id,
        prompt_cache::sha256,
        run_coordinator::{self, RunFuture},
        store,
    },
};
use std::{
    collections::BTreeMap,
    ops::Bound,
    sync::{Arc, Mutex},
};
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, ObjectEncoder, agent, domain, model, permission,
    session, session_message,
    session_orchestration::{Answer, Change, Question, QuestionId, Task},
    session_pending, stringify_json,
};
use ycoding_store::{
    IndexOrder, IndexQuery,
    session::{NewEvent, TaskTable},
};

const PROGRESS_BYTES: usize = 4 * 1024;
const QUESTION_BYTES: usize = 8 * 1024;
const EXCERPT_BYTES: usize = 16 * 1024;
const RESTART_LOST: &str =
    "The service restarted while the child task was active. Provider execution was not resumed.";

pub trait Execution: Send + Sync + 'static {
    fn wake(&self, id: &session::Id) -> run_coordinator::Outcome;
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
    Conflict(String),
    InvalidRequest(String),
    Store(ycoding_store::Error),
    Execution(run_coordinator::Error),
    Cancelled,
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SessionNotFound(_) => write!(formatter, "Session not found"),
            Self::NotFound { .. } | Self::TaskNotFound(_) => write!(formatter, "Task not found"),
            Self::Forbidden { .. } => write!(formatter, "Task belongs to another parent"),
            Self::QuestionNotFound { .. } => write!(formatter, "Question not found"),
            Self::DepthLimit(limit) => write!(formatter, "Subagent depth limit reached ({limit})"),
            Self::Conflict(message) | Self::InvalidRequest(message) => {
                write!(formatter, "{message}")
            }
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

pub struct Prepared {
    pub agent: agent::Id,
    pub caller_permissions: permission::Ruleset,
    pub model: model::Ref,
    pub profile_binding: Option<ycoding_schema::session_event::ProfileBinding>,
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
}

impl Service {
    pub fn new(sessions: store::Service, execution: Arc<dyn Execution>) -> Self {
        Self {
            autonomy: autonomy::Service::new(sessions.client.clone()),
            sessions,
            execution,
            locks: Arc::default(),
            held: Arc::default(),
        }
    }

    pub fn get(&self, parent_id: &session::Id, child_id: &session::Id) -> Result<Task, Error> {
        Ok(task_from_row(&self.owned(parent_id, child_id)?)?)
    }
    pub fn managed(&self, child_id: &session::Id) -> Result<bool, Error> {
        Ok(self.task(child_id)?.is_some())
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
        Ok(rows
            .iter()
            .map(task_from_row)
            .collect::<Result<Vec<_>, _>>()?)
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
        let prompt_digest = sha256(&input.prompt);
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
                let reservation = self.reserve(&input, cancellation).await?;
                let task = self.start(&ids, &input.prompt).await?;
                self.hold(&ids, reservation);
                return Ok(task);
            }
            return Ok(task_from_row(&existing)?);
        }
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
            },
            Some(ids.launch_event_id.as_lossless().clone()),
        )
        .await?;
        let task = self.start(&ids, &input.prompt).await?;
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
        let _guard = self.lock(child_id.as_lossless()).await;
        let row = self.owned(parent_id, child_id)?;
        let state = state_of(&row);
        if state != "running" && !TERMINAL.contains(&state.as_str()) {
            return Err(Error::Conflict(format!("Cannot send to task in {state}")));
        }
        let wake = self
            .admit_synthetic(
                child_id,
                message_id,
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
            )
            .await?;
        if TERMINAL.contains(&state.as_str()) {
            if self.sessions.pending(message_id)?.is_none() {
                return Ok(task_from_row(&row)?);
            }
            self.publish(child_id, Change::Started, None).await?;
        }
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
        let _guard = self.lock(child_id.as_lossless()).await;
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
        if text.is_none() && data.is_none() {
            return Err(Error::InvalidRequest(
                "An answer requires text or data".into(),
            ));
        }
        let ids = launch_ids(&row)?;
        let body = ObjectEncoder::new()
            .field("questionID", &question_id.0)
            .optional("text", &text.map(LosslessString::from))
            .optional("data", &data)
            .finish();
        let wake = self
            .admit_synthetic(
                child_id,
                &ids.answer(text_of(&question_id.0)),
                format!("Parent answer:\n{}", json_text(&body)),
                "Parent subagent answer",
                ObjectEncoder::new()
                    .field("source", "subagent_parent")
                    .field("parentID", parent_id)
                    .field("childID", child_id)
                    .field("kind", "answer")
                    .field("questionID", &question_id.0)
                    .finish(),
                "steer",
            )
            .await?;
        self.publish(
            child_id,
            Change::QuestionAnswered {
                answer: Answer {
                    question_id: question_id.clone(),
                    text: text.map(Into::into),
                    data,
                },
            },
            None,
        )
        .await?;
        if wake {
            self.execution.wake(child_id)?;
        }
        self.current(child_id)
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
            return Ok(task_from_row(&row)?);
        }
        if !["starting", "running", "waiting"].contains(&state.as_str()) {
            return Err(Error::Conflict(format!("Cannot cancel task in {state}")));
        }
        self.publish(child_id, Change::CancelRequested, None)
            .await?;
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
        Ok(task_from_row(&row)?)
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
        let question = Question {
            id: QuestionId(format!("qst_{}", &hash[..24]).into()),
            text: truncate_utf8(text, QUESTION_BYTES).into(),
            data,
            time: non_negative(now())?,
        };
        let automatic = self
            .autonomy
            .effective(child_id)
            .map_err(|error| match error {
                autonomy::Error::NotFound(_) => Error::TaskNotFound(child_id.clone()),
                autonomy::Error::Store(error) => Error::Store(error),
            })?
            .can_auto_answer();
        if !automatic {
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
        let ids = launch_ids(&row)?;
        let body = ObjectEncoder::new()
            .field("questionID", &question.id.0)
            .field("text", autonomy::AUTOMATIC_ANSWER)
            .finish();
        let wake = self
            .admit_synthetic(
                child_id,
                &ids.answer(text_of(&question.id.0)),
                format!("Parent answer:\n{}", json_text(&body)),
                "Autonomous subagent answer",
                ObjectEncoder::new()
                    .field("source", "subagent_parent")
                    .field("parentID", &row.parent_id)
                    .field("childID", child_id)
                    .field("kind", "answer")
                    .field("questionID", &question.id.0)
                    .finish(),
                "steer",
            )
            .await?;
        if wake {
            self.execution.wake(child_id)?;
        }
        Ok(Asked {
            question,
            auto_answered: true,
        })
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
            return Ok(task_from_row(&row)?);
        }
        if state != "running" {
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
        let mut rows = self
            .sessions
            .client
            .snapshot()?
            .scan::<TaskTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)?
            .into_iter()
            .filter(|row| ACTIVE.contains(&state_of(row).as_str()))
            .collect::<Vec<_>>();
        rows.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        for row in &rows {
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
        }
        Ok(rows.len())
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

    pub(super) async fn admit_synthetic(
        &self,
        session_id: &session::Id,
        id: &session_message::Id,
        text: String,
        description: &str,
        metadata: JsonValue,
        delivery: &str,
    ) -> Result<bool, Error> {
        let input = session_pending::Message::decode(
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
        .map_err(|error| Error::InvalidRequest(error.to_string()))?;
        self.admit(session_id, id, input).await
    }

    async fn admit(
        &self,
        session_id: &session::Id,
        id: &session_message::Id,
        input: session_pending::Message,
    ) -> Result<bool, Error> {
        self.sessions
            .admit_input(crate::session::pending::Request {
                id: id.clone(),
                session_id: session_id.clone(),
                input,
                event_id: random_event_id()?,
                created: now(),
            })
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

    async fn start(&self, ids: &Launch, prompt: &str) -> Result<Task, Error> {
        let input = session_pending::Message::decode(
            &ObjectEncoder::new()
                .field("type", "user")
                .field("data", &ObjectEncoder::new().field("text", prompt).finish())
                .field("delivery", "steer")
                .finish(),
        )
        .map_err(|error| Error::InvalidRequest(error.to_string()))?;
        self.admit(&ids.child_id, &ids.input_id, input).await?;
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
        Ok(task_from_row(&row)?)
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
        Ok(self
            .children(parent_id)?
            .iter()
            .map(task_from_row)
            .collect::<Result<Vec<_>, _>>()?)
    }
}

pub(super) const ACTIVE: [&str; 4] = ["starting", "running", "waiting", "cancelling"];
pub(super) const TERMINAL: [&str; 4] = ["cancelled", "completed", "failed", "lost"];

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
