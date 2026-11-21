use super::{
    completion::{ACTIVE_TASKS, goal_active},
    orchestration,
    store::Service,
};
use crate::{job, platform::shell::ledger::Ledger};
use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Bound,
};
use ycoding_schema::{LosslessString, session};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, KeyPart, Snapshot, TableSpec,
    session::{EventTable, NotificationTable, PendingTable, SessionTable, TaskTable},
    tuple_key,
};

const EXECUTION_STARTED: &str = "session.execution.started.1";
const EXECUTION_FAILED: &str = "session.execution.failed.1";
const PAGE: usize = 128;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Outstanding {
    pub sessions: BTreeSet<LosslessString>,
    pub running: BTreeSet<LosslessString>,
    pub waiting: BTreeSet<LosslessString>,
    pub failed: BTreeSet<LosslessString>,
    pub lost: BTreeSet<LosslessString>,
}

pub fn read(
    sessions: &Service,
    orchestration: &orchestration::Service,
    jobs: &job::Jobs,
    active: &[session::Id],
    include_failures: bool,
) -> Result<Outstanding, Error> {
    let snapshot = sessions.client.snapshot()?;
    let shell_jobs = jobs.outstanding_sessions();
    let mut owed = BTreeSet::new();
    let mut running = BTreeSet::new();
    let mut waiting = BTreeSet::new();
    visit::<TaskTable>(&snapshot, |task| {
        if ACTIVE_TASKS
            .iter()
            .any(|state| task.state.as_str() == Some(*state))
        {
            owed.insert(task.session_id.clone());
        }
        if task.state.as_str() == Some("waiting") {
            waiting.insert(task.session_id.clone());
        }
        if ["starting", "running", "cancelling"]
            .iter()
            .any(|state| task.state.as_str() == Some(*state))
        {
            running.insert(task.session_id);
        }
        Ok(())
    })?;
    visit::<NotificationTable>(&snapshot, |notice| {
        if notice.delivered == 0 {
            owed.insert(notice.parent_id);
        }
        Ok(())
    })?;
    visit::<SessionTable>(&snapshot, |row| {
        if goal_active(row.autonomy.as_ref()) {
            owed.insert(row.id);
        }
        Ok(())
    })?;
    visit::<PendingTable>(&snapshot, |pending| {
        owed.insert(pending.session_id);
        Ok(())
    })?;
    owed.extend(shell_jobs.iter().map(|id| id.as_lossless().clone()));
    owed.extend(active.iter().map(|id| id.as_lossless().clone()));
    running.extend(active.iter().map(|id| id.as_lossless().clone()));
    running.extend(
        jobs.list()
            .into_iter()
            .filter(|info| info.kind == "shell" && info.status == job::Status::Running)
            .filter_map(|info| {
                let id = info.metadata?.get("sessionID")?.as_str()?.to_owned();
                session::Id::new(id).ok()
            })
            .map(|id| id.as_lossless().clone()),
    );
    let mut parents = BTreeMap::new();
    let owed = ancestors(&snapshot, &mut parents, owed)?;
    let running = ancestors(&snapshot, &mut parents, running)?;
    let waiting = ancestors(&snapshot, &mut parents, waiting)?;

    let mut lost = Ledger::new(sessions.client.clone())
        .lost_sessions()?
        .into_iter()
        .collect::<BTreeSet<_>>();
    lost.extend(orchestration.lost_sessions()?);

    let failed = if include_failures {
        failed_roots(&snapshot, &mut parents)?
    } else {
        BTreeSet::new()
    };
    Ok(Outstanding {
        sessions: owed,
        running,
        waiting,
        failed,
        lost,
    })
}

#[derive(Clone)]
enum Parent {
    Missing,
    Root,
    Session(LosslessString),
}

fn parent(
    snapshot: &Snapshot,
    parents: &mut BTreeMap<LosslessString, Parent>,
    id: &LosslessString,
) -> Result<Parent, Error> {
    if let Some(parent) = parents.get(id) {
        return Ok(parent.clone());
    }
    let parent = match snapshot.get::<SessionTable>(&tuple_key(&[KeyPart::String(id)]))? {
        None => Parent::Missing,
        Some(row) => row.parent_id.map_or(Parent::Root, Parent::Session),
    };
    parents.insert(id.clone(), parent.clone());
    Ok(parent)
}

fn ancestors(
    snapshot: &Snapshot,
    parents: &mut BTreeMap<LosslessString, Parent>,
    ids: BTreeSet<LosslessString>,
) -> Result<BTreeSet<LosslessString>, Error> {
    let mut family = BTreeSet::new();
    for id in ids {
        let mut current = id;
        while family.insert(current.clone()) {
            match parent(snapshot, parents, &current)? {
                Parent::Session(next) => current = next,
                Parent::Root | Parent::Missing => break,
            }
        }
    }
    Ok(family)
}

fn failed_roots(
    snapshot: &Snapshot,
    parents: &mut BTreeMap<LosslessString, Parent>,
) -> Result<BTreeSet<LosslessString>, Error> {
    let mut history = Vec::new();
    visit::<SessionTable>(snapshot, |row| {
        let started = latest(snapshot, &row.id, EXECUTION_STARTED)?;
        let failed = latest(snapshot, &row.id, EXECUTION_FAILED)?;
        let newest = match (started, failed) {
            (Some(started), Some(failed)) => Some(if failed.seq > started.seq {
                failed
            } else {
                started
            }),
            (started, failed) => started.or(failed),
        };
        if let Some(event) = newest {
            history.push(event);
        }
        Ok(())
    })?;
    history.sort_by(|left, right| (left.created, &left.id).cmp(&(right.created, &right.id)));
    let mut failed = BTreeSet::new();
    for event in history {
        let mut seen = BTreeSet::new();
        let mut root = event.aggregate_id.clone();
        loop {
            if !seen.insert(root.clone()) {
                break;
            }
            match parent(snapshot, parents, &root)? {
                Parent::Session(next) => root = next,
                Parent::Missing => break,
                Parent::Root => {
                    if event.type_.as_str() == Some(EXECUTION_FAILED) {
                        failed.insert(root);
                    } else {
                        failed.remove(&root);
                    }
                    break;
                }
            }
        }
    }
    Ok(failed)
}

fn latest(
    snapshot: &Snapshot,
    session: &LosslessString,
    type_: &str,
) -> Result<Option<ycoding_store::session::Event>, Error> {
    let prefix = tuple_key(&[KeyPart::String(session), KeyPart::String(&type_.into())]);
    Ok(snapshot
        .index_range::<EventTable>(
            "event_aggregate_type_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Descending,
                after: None,
                limit: 1,
            },
        )?
        .pop()
        .map(|entry| entry.record))
}

fn visit<T: TableSpec>(
    snapshot: &Snapshot,
    mut visit: impl FnMut(T::Record) -> Result<(), Error>,
) -> Result<(), Error> {
    let mut after: Option<Vec<u8>> = None;
    loop {
        let page = snapshot.scan::<T>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            PAGE,
        )?;
        let Some(last) = page.last() else {
            return Ok(());
        };
        after = Some(T::primary_key(last));
        for row in page {
            visit(row)?;
        }
    }
}
