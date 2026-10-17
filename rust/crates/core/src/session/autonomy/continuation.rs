use super::{Goal, Service, State};
use crate::session::{
    pending::{Admitted, Request},
    projector::random_event_id,
    prompt_cache::sha256,
    store,
};
use std::{future::Future, ops::Bound, pin::Pin};
use ycoding_schema::{DomainDecode, ObjectEncoder, session, session_message, session_pending};
use ycoding_store::{IndexOrder, IndexQuery, KeyPart, session::TaskTable, tuple_key};

const ACTIVE_TASKS: [&str; 4] = ["starting", "running", "waiting", "cancelling"];

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
    yolo: super::YoloLevel,
    text: String,
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
    if active_shell
        || has_active_child(sessions, session_id)?
        || crate::session::review_fold::family_open(
            &sessions.client.snapshot()?,
            session_id.as_lossless(),
        )?
        .0 > 0
    {
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
    let State { yolo, goal, .. } = advanced.state;
    let Some(goal) = goal.filter(|goal| advanced.applied && goal.is_active()) else {
        return Ok(None);
    };
    Ok(Some(PreparedContinuation { goal, yolo, text }))
}

impl PreparedContinuation {
    pub(crate) async fn admit(
        self,
        sessions: &store::Service,
        session_id: &session::Id,
    ) -> Result<Admitted, Error> {
        let id = session_message::Id::new(format!(
            "msg_goal_{}",
            &sha256(&format!(
                "{}\0{}",
                session_id.as_lossless().as_str().unwrap_or_default(),
                self.goal.iteration
            ))[..24]
        ))
        .map_err(|error| ycoding_store::Error::Record(Box::new(error)))?;
        let input = session_pending::Message::decode(
            &ObjectEncoder::new()
                .field("type", "synthetic")
                .field(
                    "data",
                    &ObjectEncoder::new()
                        .field("text", self.text.as_str())
                        .field("description", "Goal · steer")
                        .field(
                            "metadata",
                            &ObjectEncoder::new()
                                .field(
                                    "autonomy",
                                    &ObjectEncoder::new()
                                        .field("yolo", &f64::from(self.yolo.get()))
                                        .field("goal", &true)
                                        .field("iteration", &(self.goal.iteration as f64))
                                        .finish(),
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
