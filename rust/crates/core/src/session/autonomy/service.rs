use super::state::{Effective, Goal, GoalChange, State, YoloLevel};
use crate::session::{family, key};
use std::{collections::BTreeSet, ops::Bound};
use ycoding_schema::{JsonValue, session};
use ycoding_store::{
    Client,
    session::{SessionTable, TaskTable},
};

const MIGRATION_BATCH: usize = 100;

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
    pub(super) client: Client,
}

impl Service {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    pub fn get(&self, id: &session::Id) -> Result<State, Error> {
        let mut state = self.snapshot(id)?.state;
        state.sleep = self.family_asleep(id)?;
        Ok(state)
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
        effective_in(&self.client.snapshot()?, id)
    }

    pub fn can_auto_answer(&self, id: &session::Id) -> Result<bool, Error> {
        Ok(self.snapshot(id)?.state.auto_answer == Some(true))
    }

    pub async fn set_auto_answer(&self, id: &session::Id, enabled: bool) -> Result<State, Error> {
        self.apply(id, None, move |state| state.set_auto_answer(enabled))
            .await
    }

    pub async fn migrate_stored_yolo(&self) -> Result<usize, Error> {
        let mut after: Option<Vec<u8>> = None;
        let mut migrated = 0;
        loop {
            let cursor = after.clone();
            let (count, last) = self
                .client
                .submit(move |tx| {
                    let lower = cursor.as_deref().map_or(Bound::Unbounded, Bound::Excluded);
                    let rows = tx.scan::<SessionTable>(lower, Bound::Unbounded, MIGRATION_BATCH)?;
                    let last = rows
                        .last()
                        .filter(|_| rows.len() == MIGRATION_BATCH)
                        .map(|row| key(&row.id));
                    let mut count = 0;
                    for mut row in rows {
                        let Some(JsonValue::Object(object)) = row.autonomy.as_mut() else {
                            continue;
                        };
                        if object.get(&"yolo".into()) != Some(&JsonValue::Number(3.0)) {
                            continue;
                        }
                        object.insert("yolo".into(), JsonValue::Number(2.0));
                        row.autonomy_revision += 1;
                        SessionTable::put(tx, &row)?;
                        count += 1;
                    }
                    Ok((count, last))
                })?
                .await?;
            migrated += count;
            let Some(last) = last else {
                return Ok(migrated);
            };
            after = Some(last);
        }
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
                let inherited =
                    match family::root(&mut family::Reader::Transaction(&mut *tx), &session_id)? {
                        Some(root) if root != session_id => {
                            Some(tx.get::<SessionTable>(&key(&root))?.is_some_and(|root| {
                                State::read(root.autonomy.as_ref()).is_asleep()
                            }))
                        }
                        _ => None,
                    };
                let reported = |state: State| match inherited {
                    Some(sleep) => State { sleep, ..state },
                    None => state,
                };
                if expected.is_some_and(|sequence| sequence != row.autonomy_revision) {
                    return Ok(Some(Applied {
                        state: reported(state),
                        applied: false,
                    }));
                }
                let Some(next) = transition(&state) else {
                    return Ok(Some(Applied {
                        state: reported(state),
                        applied: false,
                    }));
                };
                row.autonomy = Some(next.encode());
                row.autonomy_revision += 1;
                row.time_updated = now;
                SessionTable::put(tx, &row)?;
                Ok(Some(Applied {
                    state: reported(next),
                    applied: true,
                }))
            })?
            .await?
            .ok_or_else(|| Error::NotFound(id.clone()))
    }
}

pub(crate) fn effective_in(
    snapshot: &ycoding_store::Snapshot,
    id: &session::Id,
) -> Result<Effective, Error> {
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
    effective.asleep = super::sleep::asleep_in(snapshot, id)?;
    Ok(effective)
}
