use super::state::{
    DecisionChange, DecisionMode, Effective, Goal, GoalChange, Inherited, State, resolve,
};
use super::{FailureCause, GoalFailure, GoalRecovery, GoalRework, GoalWait, RecoverySeen};
use crate::session::{
    family, key,
    prompt_cache::{canonical_json, sha256},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Bound,
    sync::{Arc, Mutex, OnceLock, Weak},
};
use tokio::sync::mpsc;
use ycoding_schema::{JsonObject, JsonValue, session};
use ycoding_store::{
    Client, KeyPart, artifacts,
    resources::{Migration, MigrationTable},
    session::{SessionTable, TaskTable},
    tuple_key,
};

const MIGRATION_BATCH: usize = 100;
const MIGRATION: &str = "session-yolo-toggle-v1";
const DECISION_MIGRATION: &str = "session-decision-modes-v1";
const STABLE_MIGRATION: &str = "20261020120000_session-yolo-toggle";

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
pub struct Resolved {
    pub effective: Effective,
    pub inherited: Inherited,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Applied {
    pub state: State,
    pub applied: bool,
}

pub struct Changes(mpsc::UnboundedReceiver<session::Id>);

impl Changes {
    pub async fn next(&mut self) -> Option<session::Id> {
        self.0.recv().await
    }
}

#[derive(Default)]
struct Hub(Mutex<Vec<mpsc::UnboundedSender<session::Id>>>);

impl Hub {
    fn subscribe(&self) -> Changes {
        let (sender, receiver) = mpsc::unbounded_channel();
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(sender);
        Changes(receiver)
    }

    fn publish(&self, id: &session::Id) {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .retain(|subscriber| subscriber.send(id.clone()).is_ok());
    }
}

fn hub(client: &Client) -> Arc<Hub> {
    static REGISTRY: OnceLock<Mutex<BTreeMap<usize, Weak<Hub>>>> = OnceLock::new();
    let mut registry = REGISTRY
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    registry.retain(|_, hub| hub.strong_count() > 0);
    let identity = std::ptr::from_ref(client.metadata()).addr();
    if let Some(hub) = registry.get(&identity).and_then(Weak::upgrade) {
        return hub;
    }
    let hub = Arc::new(Hub::default());
    registry.insert(identity, Arc::downgrade(&hub));
    let retained = hub.clone();
    client.observe_events(move |_| {
        let _ = &retained;
        true
    });
    hub
}

#[derive(Clone)]
pub struct Service {
    pub(super) client: Client,
}

impl Service {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    pub fn changes(&self) -> Changes {
        hub(&self.client).subscribe()
    }

    pub(super) fn notify_tree(&self, id: &session::Id) -> Result<(), Error> {
        let snapshot = self.client.snapshot()?;
        let mut members = vec![id.as_lossless().clone()];
        let mut seen = BTreeSet::new();
        let hub = hub(&self.client);
        let mut cursor = 0;
        while cursor < members.len() {
            let member = members[cursor].clone();
            cursor += 1;
            if !seen.insert(member.clone()) {
                continue;
            }
            if let Ok(id) = session::Id::new(member.clone()) {
                hub.publish(&id);
            }
            let prefix = key(&member);
            let mut after = None;
            loop {
                let page = snapshot.index_range::<SessionTable>(
                    "session_parent_idx",
                    ycoding_store::IndexQuery {
                        lower: Bound::Unbounded,
                        upper: Bound::Unbounded,
                        prefix: Some(&prefix),
                        order: ycoding_store::IndexOrder::Ascending,
                        after: after.as_ref(),
                        limit: 128,
                    },
                )?;
                let Some(last) = page.last() else { break };
                after = Some(last.cursor.clone());
                members.extend(page.into_iter().map(|entry| entry.record.id));
            }
            let mut after = None;
            loop {
                let page = snapshot.index_range::<TaskTable>(
                    "session_task_parent_state_updated_idx",
                    ycoding_store::IndexQuery {
                        lower: Bound::Unbounded,
                        upper: Bound::Unbounded,
                        prefix: Some(&prefix),
                        order: ycoding_store::IndexOrder::Ascending,
                        after: after.as_ref(),
                        limit: 128,
                    },
                )?;
                let Some(last) = page.last() else { break };
                after = Some(last.cursor.clone());
                members.extend(page.into_iter().map(|entry| entry.record.session_id));
            }
        }
        Ok(())
    }

    pub fn get(&self, id: &session::Id) -> Result<State, Error> {
        let mut state = self.snapshot(id)?.state;
        state.defer = self.family_deferred(id)?;
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

    pub fn resolve(&self, id: &session::Id) -> Result<Resolved, Error> {
        resolve_in(&self.client.snapshot()?, id)
    }

    pub fn can_auto_answer(&self, id: &session::Id) -> Result<bool, Error> {
        Ok(self.effective(id)?.can_auto_answer())
    }

    pub fn snapshot_inherited(&self, id: &session::Id) -> Result<Snapshot, Error> {
        inherited_in(&self.client.snapshot()?, id)
    }

    pub async fn set_decisions(
        &self,
        id: &session::Id,
        change: DecisionChange,
    ) -> Result<State, Error> {
        self.apply(id, None, move |state| state.set_decisions(change))
            .await
    }

    pub async fn migrate_stored_autonomy(&self) -> Result<usize, Error> {
        let stable = self
            .client
            .snapshot()?
            .get::<artifacts::MigrationTable>(&tuple_key(&[KeyPart::String(
                &STABLE_MIGRATION.into(),
            )]))?
            .is_some();
        let levels = self
            .migrate_rows(
                MIGRATION,
                Arc::new(move |object: &mut JsonObject| rewrite_levels(object, stable)),
            )
            .await?;
        let modes = self
            .migrate_rows(DECISION_MIGRATION, Arc::new(rewrite_decision_modes))
            .await?;
        Ok(levels + modes)
    }

    async fn migrate_rows(
        &self,
        ledger: &'static str,
        rewrite: Arc<dyn Fn(&mut JsonObject) -> bool + Send + Sync>,
    ) -> Result<usize, Error> {
        if self
            .client
            .snapshot()?
            .get::<MigrationTable>(&tuple_key(&[KeyPart::String(&ledger.into())]))?
            .is_some()
        {
            return Ok(0);
        }
        let now = chrono::Utc::now().timestamp_millis();
        let mut after: Option<Vec<u8>> = None;
        let mut migrated = 0;
        loop {
            let cursor = after.clone();
            let rewrite = rewrite.clone();
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
                        if !rewrite(object) {
                            continue;
                        }
                        row.autonomy_revision += 1;
                        SessionTable::put(tx, &row)?;
                        count += 1;
                    }
                    if last.is_none() {
                        MigrationTable::insert(
                            tx,
                            &Migration {
                                name: ledger.into(),
                                time_completed: now,
                            },
                        )?;
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

    pub async fn set_goal(&self, id: &session::Id, goal: Goal) -> Result<State, Error> {
        self.apply(id, None, move |state| Some(state.replace_goal(goal)))
            .await
    }

    pub async fn set_goal_if_current(
        &self,
        id: &session::Id,
        expected_sequence: i64,
        goal: Goal,
    ) -> Result<Applied, Error> {
        self.mutate(id, Some(expected_sequence), move |state| {
            Some(state.replace_goal(goal))
        })
        .await
    }

    pub async fn resume_goal_if_current(
        &self,
        id: &session::Id,
        expected_sequence: i64,
    ) -> Result<Applied, Error> {
        self.mutate(id, Some(expected_sequence), State::resume_goal)
            .await
    }

    pub async fn change(&self, id: &session::Id, goal: GoalChange) -> Result<State, Error> {
        self.apply(id, None, move |state| state.change(Some(&goal)))
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

    pub fn goal_owner(&self, id: &session::Id) -> Result<Option<session::Id>, Error> {
        let snapshot = self.client.snapshot()?;
        let mut current = id.as_lossless().clone();
        let mut seen = BTreeSet::new();
        while seen.insert(current.clone()) {
            let Some(row) = snapshot.get::<SessionTable>(&key(&current))? else {
                break;
            };
            if State::read(row.autonomy.as_ref())
                .goal
                .as_ref()
                .is_some_and(Goal::is_active)
            {
                return session::Id::new(current)
                    .map(Some)
                    .map_err(|error| Error::Store(ycoding_store::Error::Record(Box::new(error))));
            }
            let Some(parent) = row.parent_id else { break };
            current = parent;
        }
        Ok(None)
    }

    pub async fn rework(
        &self,
        id: &session::Id,
        unit: String,
        reason: String,
        opened: bool,
    ) -> Result<State, Error> {
        self.apply(id, None, move |state| {
            let mut goal = state.goal.clone().filter(Goal::is_active)?;
            let mut open = goal.rework_open.take().unwrap_or_default();
            let before = open.len();
            open.retain(|item| item.unit.as_str() != Some(unit.as_str()));
            if opened {
                goal.rework = Some(goal.rework.unwrap_or(0) + 1);
                open.push(GoalRework {
                    unit: unit.into(),
                    reason: reason.into(),
                });
                if open.len() > 16 {
                    open.drain(..open.len() - 16);
                }
            } else if before == open.len() {
                return None;
            }
            goal.rework_open = (!open.is_empty()).then_some(open);
            Some(state.replace_goal(goal))
        })
        .await
    }

    pub async fn record_stall(
        &self,
        id: &session::Id,
        cause: Option<FailureCause>,
    ) -> Result<State, Error> {
        self.apply(id, None, move |state| {
            let mut goal = state.goal.clone().filter(Goal::is_active)?;
            goal.stalls = Some(goal.stalls.unwrap_or(0) + 1);
            if let Some(cause) = cause {
                let count = goal
                    .failure
                    .as_ref()
                    .filter(|failure| failure.fingerprint == cause.fingerprint)
                    .map_or(1, |failure| failure.count + 1);
                goal.failure = Some(GoalFailure {
                    fingerprint: cause.fingerprint,
                    class: cause.class,
                    unit: cause.unit,
                    count,
                    recovering: true,
                });
            }
            Some(state.replace_goal(goal))
        })
        .await
    }

    pub async fn resolve_failure(
        &self,
        id: &session::Id,
        tool: Option<&str>,
    ) -> Result<State, Error> {
        let tool = tool.map(|tool| format!("tool/{tool}"));
        self.apply(id, None, move |state| {
            let mut goal = state.goal.clone()?;
            let failure = goal.failure.as_ref()?;
            let resolves = match &tool {
                Some(tool) => failure.unit.as_str() == Some(tool.as_str()),
                None => !failure.unit.as_str()?.starts_with("tool/"),
            };
            if !resolves {
                return None;
            }
            goal.failure = None;
            Some(state.replace_goal(goal))
        })
        .await
    }

    pub async fn record_wait(
        &self,
        id: &session::Id,
        expected: i64,
        wait: GoalWait,
    ) -> Result<Applied, Error> {
        self.mutate(id, Some(expected), move |state| {
            let mut goal = state.goal.clone().filter(Goal::is_active)?;
            if goal.wait == Some(wait) && goal.failure.is_none() {
                return None;
            }
            goal.wait = Some(wait);
            goal.failure = None;
            Some(state.replace_goal(goal))
        })
        .await
    }

    pub async fn record_failure(
        &self,
        id: &session::Id,
        expected: i64,
        cause: FailureCause,
        condition: String,
    ) -> Result<Applied, Error> {
        self.mutate(id, Some(expected), move |state| {
            let mut goal = state.goal.clone().filter(Goal::is_active)?;
            let mut seen = goal
                .recovery
                .take()
                .filter(|recovery| recovery.condition.as_str() == Some(condition.as_str()))
                .map_or_else(Vec::new, |recovery| recovery.seen);
            let previous = seen
                .iter()
                .find(|item| item.fingerprint == cause.fingerprint);
            let count = previous.map_or(1, |item| item.count + 1);
            let recovering = previous.is_none();
            if recovering {
                goal.rework = Some(goal.rework.unwrap_or(0) + 1);
            }
            seen.retain(|item| item.fingerprint != cause.fingerprint);
            seen.push(RecoverySeen {
                fingerprint: cause.fingerprint.clone(),
                count,
            });
            if seen.len() > 16 {
                seen.drain(..seen.len() - 16);
            }
            goal.failure = Some(GoalFailure {
                fingerprint: cause.fingerprint,
                class: cause.class,
                unit: cause.unit,
                count,
                recovering,
            });
            goal.recovery = Some(GoalRecovery {
                condition: condition.into(),
                seen,
            });
            goal.wait = None;
            Some(state.replace_goal(goal))
        })
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
        let applied = self
            .client
            .submit(move |tx| {
                let Some(mut row) = tx.get::<SessionTable>(&key(&session_id))? else {
                    return Ok(None);
                };
                let state = State::read(row.autonomy.as_ref());
                let inherited =
                    match family::root(&mut family::Reader::Transaction(&mut *tx), &session_id)? {
                        Some(root) if root != session_id => {
                            Some(tx.get::<SessionTable>(&key(&root))?.is_some_and(|root| {
                                State::read(root.autonomy.as_ref()).is_deferred()
                            }))
                        }
                        _ => None,
                    };
                let reported = |state: State| match inherited {
                    Some(defer) => State { defer, ..state },
                    None => state,
                };
                if expected.is_some_and(|sequence| sequence != row.autonomy_revision) {
                    return Ok(Some(Applied {
                        state: reported(state),
                        applied: false,
                    }));
                }
                let Some(mut next) = transition(&state) else {
                    return Ok(Some(Applied {
                        state: reported(state),
                        applied: false,
                    }));
                };
                if let Some(goal) = &mut next.goal {
                    goal.normalize_phase();
                }
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
            .ok_or_else(|| Error::NotFound(id.clone()))?;
        if applied.applied {
            self.notify_tree(id)?;
        }
        Ok(applied)
    }
}

pub(crate) fn effective_in(
    snapshot: &ycoding_store::Snapshot,
    id: &session::Id,
) -> Result<Effective, Error> {
    resolve_in(snapshot, id).map(|resolved| resolved.effective)
}

pub(crate) fn resolve_in(
    snapshot: &ycoding_store::Snapshot,
    id: &session::Id,
) -> Result<Resolved, Error> {
    let session = snapshot
        .get::<SessionTable>(&key(id.as_lossless()))?
        .ok_or_else(|| Error::NotFound(id.clone()))?;
    let mut chain = vec![(
        id.as_lossless().clone(),
        State::read(session.autonomy.as_ref()),
    )];
    let mut seen = BTreeSet::new();
    let mut current = id.as_lossless().clone();
    while seen.insert(current.clone()) {
        let Some(task) = snapshot.get::<TaskTable>(&key(&current))? else {
            break;
        };
        let Some(parent) = snapshot.get::<SessionTable>(&key(&task.parent_id))? else {
            break;
        };
        chain.push((
            task.parent_id.clone(),
            State::read(parent.autonomy.as_ref()),
        ));
        current = task.parent_id;
    }
    let root_id = family::root(&mut family::Reader::Snapshot(snapshot), id.as_lossless())?
        .unwrap_or_else(|| id.as_lossless().clone());
    let root = if root_id == *id.as_lossless() {
        chain[0].1.clone()
    } else {
        snapshot
            .get::<SessionTable>(&key(&root_id))?
            .map_or_else(State::default, |row| State::read(row.autonomy.as_ref()))
    };
    let states = chain.iter().map(|(_, state)| state).collect::<Vec<_>>();
    let (permissions, guardrails, answers) = resolve(&states, &root);
    let source = |pick: fn(&State) -> DecisionMode, resolved: DecisionMode| {
        if pick(&chain[0].1) == resolved {
            return None;
        }
        chain[1..]
            .iter()
            .find(|(_, state)| pick(state) == resolved)
            .map(|(ancestor, _)| ancestor.clone())
    };
    Ok(Resolved {
        inherited: Inherited {
            permissions: source(|state: &State| state.permissions, permissions),
            guardrails: (root_id != *id.as_lossless()).then(|| root_id.clone()),
            answers: source(|state: &State| state.answers, answers),
        },
        effective: Effective {
            permissions,
            guardrails,
            answers,
            goal_active: chain
                .iter()
                .any(|(_, state)| state.goal.as_ref().is_some_and(Goal::is_active)),
            deferred: super::defer::deferred_in(snapshot, id)?,
        },
    })
}

const RULE_FLAGS: &[&str] = &["autoPermission", "autoGuardrail"];

fn rewrite_levels(object: &mut JsonObject, stable: bool) -> bool {
    let Some(flags) = legacy_flags(object, stable) else {
        return false;
    };
    object.insert("mode".into(), JsonValue::String("normal".into()));
    object.insert("yolo".into(), JsonValue::Bool(false));
    for flag in flags {
        object.insert((*flag).into(), JsonValue::Bool(true));
    }
    true
}

fn rewrite_decision_modes(object: &mut JsonObject) -> bool {
    if object.get(&"permissions".into()).is_some() {
        return false;
    }
    let yolo = object.get(&"yolo".into()) == Some(&JsonValue::Bool(true));
    let mode = |flag: &str| {
        let auto = object.get(&flag.into()) == Some(&JsonValue::Bool(true));
        JsonValue::String(
            match (auto, yolo) {
                (true, _) => DecisionMode::Auto,
                (false, true) => DecisionMode::Yolo,
                (false, false) => DecisionMode::Manual,
            }
            .as_str()
            .into(),
        )
    };
    let (permissions, guardrails, answers) = (
        mode("autoPermission"),
        mode("autoGuardrail"),
        mode("autoAnswer"),
    );
    let mut next = JsonObject::new();
    for (name, value) in object.iter() {
        if !matches!(
            name.as_str(),
            Some("yolo" | "autoPermission" | "autoGuardrail" | "autoAnswer")
        ) {
            next.insert(name.clone(), value.clone());
        }
    }
    next.insert("mode".into(), JsonValue::String("normal".into()));
    next.insert("permissions".into(), permissions);
    next.insert("guardrails".into(), guardrails);
    next.insert("answers".into(), answers);
    *object = next;
    true
}

fn legacy_flags(
    object: &ycoding_schema::JsonObject,
    stable: bool,
) -> Option<&'static [&'static str]> {
    let mode = object.get(&"mode".into());
    let yolo = object.get(&"yolo".into());
    let integer = match yolo {
        Some(JsonValue::Number(number)) if number.is_finite() && number.fract() == 0.0 => {
            Some(*number)
        }
        _ => None,
    };
    let legacy_true = yolo == Some(&JsonValue::Bool(true)) && !stable;
    if mode == Some(&JsonValue::String("yolo".into()))
        || legacy_true
        || matches!(integer, Some(level) if level == 2.0 || level == 3.0)
    {
        return Some(RULE_FLAGS);
    }
    if integer == Some(1.0) {
        return Some(&RULE_FLAGS[..1]);
    }
    let other_mode = mode == Some(&JsonValue::String("goal".into()));
    let other_yolo = yolo.is_some_and(|value| {
        value != &JsonValue::Bool(false) && !(value == &JsonValue::Bool(true) && stable)
    });
    (other_mode || other_yolo).then_some(&[])
}

pub(crate) fn inherited_in(
    snapshot: &ycoding_store::Snapshot,
    id: &session::Id,
) -> Result<Snapshot, Error> {
    inherited_with(id, |current| {
        let Some(row) = snapshot.get::<SessionTable>(&key(current))? else {
            return Ok(None);
        };
        let task = snapshot.get::<TaskTable>(&key(current))?;
        Ok(Some((row, task)))
    })
}

pub(crate) fn inherited_in_tx(
    tx: &mut ycoding_store::Write<'_>,
    id: &session::Id,
) -> Result<Snapshot, Error> {
    inherited_with(id, |current| {
        let Some(row) = tx.get::<SessionTable>(&key(current))? else {
            return Ok(None);
        };
        let task = tx.get::<TaskTable>(&key(current))?;
        Ok(Some((row, task)))
    })
}

type Link = (
    ycoding_store::session::Session,
    Option<ycoding_store::session::Task>,
);

fn inherited_with(
    id: &session::Id,
    mut read: impl FnMut(&ycoding_schema::LosslessString) -> Result<Option<Link>, ycoding_store::Error>,
) -> Result<Snapshot, Error> {
    let mut chain = Vec::new();
    let mut seen = BTreeSet::new();
    let mut current = id.as_lossless().clone();
    while seen.insert(current.clone()) {
        let Some((row, task)) = read(&current)? else {
            if chain.is_empty() {
                return Err(Error::NotFound(id.clone()));
            }
            break;
        };
        chain.push((
            current.clone(),
            row.autonomy_revision,
            State::read(row.autonomy.as_ref()),
        ));
        let Some(task) = task else {
            break;
        };
        current = task.parent_id;
    }
    let digest = chain
        .iter()
        .rev()
        .fold(None::<String>, |parent, (session, sequence, state)| {
            Some(sha256(&canonical_json(&JsonValue::Array(vec![
                JsonValue::String(session.clone()),
                JsonValue::Number(*sequence as f64),
                state.encode(),
                parent.map_or(JsonValue::Null, |digest| {
                    JsonValue::String(digest.as_str().into())
                }),
            ]))))
        });
    let (_, sequence, state) = chain.swap_remove(0);
    Ok(Snapshot {
        state,
        sequence,
        digest: digest.unwrap_or_default(),
    })
}
