use super::{FailureCause, Goal, GoalWait, Service, State};
use crate::session::{
    pending::{Admitted, Request},
    projector::random_event_id,
    prompt_cache::{canonical_json, sha256},
    store,
};
use std::{future::Future, ops::Bound, pin::Pin};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, ObjectEncoder, session, session_error, session_message,
    session_pending,
};
use ycoding_store::{
    IndexOrder, IndexQuery, KeyPart,
    session::{EventTable, TaskTable},
    tuple_key,
};

const ACTIVE_TASKS: [&str; 5] = [
    "starting",
    "running",
    "waiting",
    "supervising",
    "cancelling",
];

pub struct SteerRequest {
    pub session_id: session::Id,
    pub goal: Goal,
    pub latest_assistant_text: Option<String>,
}

pub type SteerFuture<'a> = Pin<Box<dyn Future<Output = Option<String>> + Send + 'a>>;

pub trait Steer: Send + Sync {
    fn steer(&self, request: SteerRequest) -> SteerFuture<'_>;
}

#[derive(Debug)]
pub enum Error {
    Autonomy(super::Error),
    Store(ycoding_store::Error),
}

impl From<super::Error> for Error {
    fn from(error: super::Error) -> Self {
        Self::Autonomy(error)
    }
}

impl From<ycoding_store::Error> for Error {
    fn from(error: ycoding_store::Error) -> Self {
        Self::Store(error)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Autonomy(error) => write!(formatter, "{error}"),
            Self::Store(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for Error {}

pub async fn continue_goal(
    autonomy: &Service,
    sessions: &store::Service,
    steer: &dyn Steer,
    session_id: &session::Id,
    latest_assistant_text: Option<String>,
    active_shell: bool,
) -> Result<Option<Admitted>, Error> {
    let Some(prepared) = prepare_continuation(
        autonomy,
        sessions,
        steer,
        session_id,
        latest_assistant_text,
        active_shell,
    )
    .await?
    else {
        return Ok(None);
    };
    Ok(Some(prepared.admit(sessions, session_id).await?))
}

pub(crate) struct PreparedContinuation {
    goal: Goal,
    text: String,
    recovery: Option<(String, String)>,
}

pub(crate) async fn prepare_continuation(
    autonomy: &Service,
    sessions: &store::Service,
    steer: &dyn Steer,
    session_id: &session::Id,
    latest_assistant_text: Option<String>,
    active_shell: bool,
) -> Result<Option<PreparedContinuation>, Error> {
    let snapshot = autonomy.snapshot(session_id)?;
    let Some(goal) = snapshot.state.goal.filter(Goal::is_active) else {
        return Ok(None);
    };
    if sessions
        .get(session_id)?
        .is_none_or(|session| session.scope == session::Scope::Standalone)
    {
        return Ok(None);
    }
    let wait = if has_active_child(sessions, session_id)? {
        Some(GoalWait::Child)
    } else if crate::session::review_fold::family_open(
        &sessions.client.snapshot()?,
        session_id.as_lossless(),
    )?
    .0 > 0
    {
        Some(GoalWait::Review)
    } else if active_shell {
        Some(GoalWait::Shell)
    } else {
        None
    };
    if let Some(wait) = wait {
        autonomy
            .record_wait(session_id, snapshot.sequence, wait)
            .await?;
        return Ok(None);
    }
    let Some(text) = steer
        .steer(SteerRequest {
            session_id: session_id.clone(),
            goal,
            latest_assistant_text,
        })
        .await
    else {
        return Ok(None);
    };
    let advanced = autonomy
        .advance_if_current(session_id, snapshot.sequence)
        .await?;
    let State { goal, .. } = advanced.state;
    let Some(goal) = goal.filter(|goal| advanced.applied && goal.is_active()) else {
        return Ok(None);
    };
    Ok(Some(PreparedContinuation {
        goal,
        text,
        recovery: None,
    }))
}

pub(crate) async fn prepare_failure(
    autonomy: &Service,
    sessions: &store::Service,
    steer: &dyn Steer,
    session_id: &session::Id,
    error: &session_error::Error,
    latest_assistant_text: Option<String>,
) -> Result<Option<PreparedContinuation>, Error> {
    let snapshot = autonomy.snapshot(session_id)?;
    if !snapshot.state.goal.as_ref().is_some_and(Goal::is_active) {
        return Ok(None);
    }
    let Some(session) = sessions
        .get(session_id)?
        .filter(|session| session.scope != session::Scope::Standalone)
    else {
        return Ok(None);
    };
    let assistant = match sessions.latest(session_id, "assistant")? {
        Some(session_message::Info::Assistant(assistant)) => Some(assistant),
        _ => None,
    };
    let class = error.r#type.to_utf8().unwrap_or_default();
    let unit = if class.starts_with("tool.") {
        assistant
            .as_ref()
            .and_then(|assistant| {
                assistant.content.iter().rev().find_map(|part| match part {
                    session_message::AssistantContent::Tool(tool)
                        if matches!(tool.state, session_message::ToolState::Error(_)) =>
                    {
                        Some(format!("tool/{}", tool.name.to_utf8().unwrap_or_default()))
                    }
                    _ => None,
                })
            })
            .unwrap_or_else(|| "tool".into())
    } else {
        assistant
            .as_ref()
            .map(|assistant| &assistant.model)
            .or(session.model.as_ref())
            .map(|model| {
                format!(
                    "model/{}/{}",
                    model.provider_id.0.to_utf8().unwrap_or_default(),
                    model.id.to_utf8().unwrap_or_default()
                )
            })
            .unwrap_or_else(|| "session".into())
    };
    let fingerprint = format!("{class}:{unit}");
    let condition = failure_condition(sessions, &session, &snapshot.state)?;
    let recorded = autonomy
        .record_failure(
            session_id,
            snapshot.sequence,
            FailureCause {
                fingerprint: fingerprint.as_str().into(),
                class: class.as_str().into(),
                unit: unit.as_str().into(),
            },
            condition.clone(),
        )
        .await?;
    let Some(goal) = recorded.state.goal.filter(|goal| {
        recorded.applied
            && goal
                .failure
                .as_ref()
                .is_some_and(|failure| failure.recovering)
    }) else {
        return Ok(None);
    };
    let fallback = format!(
        "Recover from the failed step ({class} on {unit}): inspect the current state, then resume the unfinished work toward the goal with an approach that avoids the same failure."
    );
    let text = steer
        .steer(SteerRequest {
            session_id: session_id.clone(),
            goal: goal.clone(),
            latest_assistant_text,
        })
        .await
        .unwrap_or(fallback);
    Ok(Some(PreparedContinuation {
        goal,
        text,
        recovery: Some((fingerprint, condition)),
    }))
}

fn failure_condition(
    sessions: &store::Service,
    session: &session::Info,
    state: &State,
) -> Result<String, Error> {
    let snapshot = sessions.client.snapshot()?;
    let prefix = tuple_key(&[
        KeyPart::String(session.id.as_lossless()),
        KeyPart::String(&"session.input.admitted.1".into()),
    ]);
    let mut after = None;
    let mut input = 0;
    loop {
        let page = snapshot.index_range::<EventTable>(
            "event_aggregate_type_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Descending,
                after: after.as_ref(),
                limit: 128,
            },
        )?;
        if page.is_empty() {
            break;
        }
        if let Some(event) = page.iter().find(|event| !super::verification::field(&event.record.data, "inputID").is_some_and(|value| matches!(value, ycoding_schema::JsonValue::String(id) if id.as_str().is_some_and(|id| id.starts_with("msg_goal_"))))) { input = event.record.seq; break; }
        after = page.last().map(|event| event.cursor.clone());
    }
    Ok(sha256(&canonical_json(
        &ObjectEncoder::new()
            .field("input", &(input as f64))
            .field(
                "agent",
                &session
                    .agent
                    .as_ref()
                    .map_or(JsonValue::Null, DomainEncode::encode),
            )
            .field(
                "model",
                &session
                    .model
                    .as_ref()
                    .map_or(JsonValue::Null, DomainEncode::encode),
            )
            .field(
                "decisions",
                &ObjectEncoder::new()
                    .field("permissions", state.permissions.as_str())
                    .field("guardrails", state.guardrails.as_str())
                    .field("answers", state.answers.as_str())
                    .finish(),
            )
            .field("defer", &state.defer)
            .finish(),
    )))
}

impl PreparedContinuation {
    pub(crate) async fn admit(
        self,
        sessions: &store::Service,
        session_id: &session::Id,
    ) -> Result<Admitted, Error> {
        let identity = match &self.recovery {
            Some((fingerprint, condition)) => format!(
                "{}\0recover\0{fingerprint}\0{condition}",
                session_id.as_lossless().as_str().unwrap_or_default()
            ),
            None => format!(
                "{}\0{}",
                session_id.as_lossless().as_str().unwrap_or_default(),
                self.goal.iteration
            ),
        };
        let id = session_message::Id::new(format!("msg_goal_{}", &sha256(&identity)[..24]))
            .map_err(|error| ycoding_store::Error::Record(Box::new(error)))?;
        let input = session_pending::Message::decode(
            &ObjectEncoder::new()
                .field("type", "synthetic")
                .field(
                    "data",
                    &ObjectEncoder::new()
                        .field("text", self.text.as_str())
                        .field(
                            "description",
                            if self.recovery.is_some() {
                                "Goal · recovery"
                            } else {
                                "Goal · steer"
                            },
                        )
                        .field(
                            "metadata",
                            &ObjectEncoder::new()
                                .field(
                                    "autonomy",
                                    &match &self.recovery {
                                        Some((fingerprint, _)) => ObjectEncoder::new()
                                            .field("goal", &true)
                                            .field("recovery", fingerprint.as_str())
                                            .finish(),
                                        None => ObjectEncoder::new()
                                            .field("goal", &true)
                                            .field("iteration", &(self.goal.iteration as f64))
                                            .finish(),
                                    },
                                )
                                .finish(),
                        )
                        .finish(),
                )
                .field("delivery", "steer")
                .finish(),
        )
        .map_err(|error| ycoding_store::Error::Record(Box::new(error)))?;
        Ok(sessions
            .admit_input(Request {
                id,
                session_id: session_id.clone(),
                input,
                event_id: random_event_id()?,
                created: chrono::Utc::now().timestamp_millis(),
            })
            .await?)
    }
}

fn has_active_child(sessions: &store::Service, parent: &session::Id) -> Result<bool, Error> {
    let snapshot = sessions.client.snapshot()?;
    for state in ACTIVE_TASKS {
        let prefix = tuple_key(&[
            KeyPart::String(parent.as_lossless()),
            KeyPart::String(&state.into()),
        ]);
        if !snapshot
            .index_range::<TaskTable>(
                "session_task_parent_state_updated_idx",
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Unbounded,
                    prefix: Some(&prefix),
                    order: IndexOrder::Ascending,
                    after: None,
                    limit: 1,
                },
            )?
            .is_empty()
        {
            return Ok(true);
        }
    }
    Ok(false)
}
