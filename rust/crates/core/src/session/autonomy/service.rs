use super::state::{Effective, Goal, GoalChange, State, YoloLevel};
use crate::session::key;
use std::collections::BTreeSet;
use ycoding_schema::session;
use ycoding_store::{
    Client,
    session::{SessionTable, TaskTable},
};

#[derive(Debug)]
pub enum Error {
    NotFound(session::Id),
    Store(ycoding_store::Error),
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(_) => write!(formatter, "Session not found"),
            Self::Store(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<ycoding_store::Error> for Error {
    fn from(error: ycoding_store::Error) -> Self {
        Self::Store(error)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub state: State,
    pub sequence: i64,
    pub digest: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Applied {
    pub state: State,
    pub applied: bool,
}

#[derive(Clone)]
pub struct Service {
    client: Client,
}

impl Service {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    pub fn get(&self, id: &session::Id) -> Result<State, Error> {
        self.snapshot(id).map(|snapshot| snapshot.state)
    }

    pub fn snapshot(&self, id: &session::Id) -> Result<Snapshot, Error> {
        let row = self
            .client
            .snapshot()?
            .get::<SessionTable>(&key(id.as_lossless()))?
            .ok_or_else(|| Error::NotFound(id.clone()))?;
        let state = State::read(row.autonomy.as_ref());
        Ok(Snapshot {
            digest: state.digest(),
            sequence: row.autonomy_revision,
            state,
        })
    }

    pub fn effective(&self, id: &session::Id) -> Result<Effective, Error> {
        let snapshot = self.client.snapshot()?;
        let session = snapshot
            .get::<SessionTable>(&key(id.as_lossless()))?
            .ok_or_else(|| Error::NotFound(id.clone()))?;
        let mut effective = State::read(session.autonomy.as_ref()).effective();
        let mut seen = BTreeSet::new();
        let mut current = id.as_lossless().clone();
        while seen.insert(current.clone()) {
            let Some(task) = snapshot.get::<TaskTable>(&key(&current))? else {
                break;
            };
            let Some(parent) = snapshot.get::<SessionTable>(&key(&task.parent_id))? else {
                break;
            };
            effective = effective.inherit(State::read(parent.autonomy.as_ref()).effective());
            current = task.parent_id;
        }
        Ok(effective)
    }

    pub async fn set_yolo(&self, id: &session::Id, level: YoloLevel) -> Result<State, Error> {
        self.apply(id, None, move |state| state.set_yolo(level))
            .await
    }

    pub async fn set_goal(&self, id: &session::Id, goal: Goal) -> Result<State, Error> {
        self.apply(id, None, move |state| Some(state.replace_goal(goal)))
            .await
    }

    pub async fn set_goal_if_current(
        &self,
        id: &session::Id,
        expected_sequence: i64,
        yolo: Option<YoloLevel>,
        goal: Goal,
    ) -> Result<Applied, Error> {
        self.mutate(id, Some(expected_sequence), move |state| {
            let mut next = state.replace_goal(goal);
            next.yolo = yolo.unwrap_or(state.yolo);
            Some(next)
        })
        .await
    }

    pub async fn resume_goal_if_current(
        &self,
        id: &session::Id,
        expected_sequence: i64,
        yolo: Option<YoloLevel>,
    ) -> Result<Applied, Error> {
        self.mutate(id, Some(expected_sequence), move |state| {
            state.resume_goal(yolo)
        })
        .await
    }

    pub async fn change(
        &self,
        id: &session::Id,
        yolo: Option<YoloLevel>,
        goal: Option<GoalChange>,
    ) -> Result<State, Error> {
        self.apply(id, None, move |state| state.change(yolo, goal.as_ref()))
            .await
    }

    pub async fn stop(&self, id: &session::Id) -> Result<State, Error> {
        self.apply(id, None, |state| Some(state.stop_goal())).await
    }

    pub async fn report(&self, id: &session::Id) -> Result<State, Error> {
        self.apply(id, None, State::report).await
    }

    pub async fn complete(&self, id: &session::Id) -> Result<State, Error> {
        self.apply(id, None, State::complete).await
    }

    pub async fn advance(&self, id: &session::Id) -> Result<State, Error> {
        self.apply(id, None, State::advance).await
    }

    pub async fn advance_if_current(
        &self,
        id: &session::Id,
        expected_sequence: i64,
    ) -> Result<Applied, Error> {
        self.mutate(id, Some(expected_sequence), State::advance)
            .await
    }

    async fn apply(
        &self,
        id: &session::Id,
        expected: Option<i64>,
        transition: impl FnOnce(&State) -> Option<State> + Send + 'static,
    ) -> Result<State, Error> {
        self.mutate(id, expected, transition)
            .await
            .map(|applied| applied.state)
    }

    async fn mutate(
        &self,
        id: &session::Id,
        expected: Option<i64>,
        transition: impl FnOnce(&State) -> Option<State> + Send + 'static,
    ) -> Result<Applied, Error> {
        let session_id = id.as_lossless().clone();
        let now = chrono::Utc::now().timestamp_millis();
        self.client
            .submit(move |tx| {
                let Some(mut row) = tx.get::<SessionTable>(&key(&session_id))? else {
                    return Ok(None);
                };
                let state = State::read(row.autonomy.as_ref());
                if expected.is_some_and(|sequence| sequence != row.autonomy_revision) {
                    return Ok(Some(Applied {
                        state,
                        applied: false,
                    }));
                }
                let Some(next) = transition(&state) else {
                    return Ok(Some(Applied {
                        state,
                        applied: false,
                    }));
                };
                row.autonomy = Some(next.encode());
                row.autonomy_revision += 1;
                row.time_updated = now;
                SessionTable::put(tx, &row)?;
                Ok(Some(Applied {
                    state: next,
                    applied: true,
                }))
            })?
            .await?
            .ok_or_else(|| Error::NotFound(id.clone()))
    }
}
