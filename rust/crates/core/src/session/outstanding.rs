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
    let session_rows = all::<SessionTable>(&snapshot)?;
    let shell_jobs = jobs.outstanding_sessions();
    let mut owed = BTreeSet::new();
    owed.extend(
        all::<TaskTable>(&snapshot)?
            .into_iter()
            .filter(|task| {
                ACTIVE_TASKS
                    .iter()
                    .any(|state| task.state.as_str() == Some(*state))
            })
            .map(|task| task.parent_id),
    );
    owed.extend(
        all::<NotificationTable>(&snapshot)?
            .into_iter()
            .filter(|notice| notice.delivered == 0)
            .map(|notice| notice.parent_id),
    );
    owed.extend(
        session_rows
            .iter()
            .filter(|row| goal_active(row.autonomy.as_ref()))
            .map(|row| row.id.clone()),
    );
    owed.extend(
        all::<PendingTable>(&snapshot)?
            .into_iter()
            .map(|pending| pending.session_id),
    );
    owed.extend(shell_jobs.iter().map(|id| id.as_lossless().clone()));
    owed.extend(active.iter().map(|id| id.as_lossless().clone()));

    let mut running = active
        .iter()
        .map(|id| id.as_lossless().clone())
        .collect::<BTreeSet<_>>();
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

    let mut lost = Ledger::new(sessions.client.clone())
        .lost_sessions()?
        .into_iter()
        .collect::<BTreeSet<_>>();
    lost.extend(orchestration.lost_sessions()?);

    let failed = if include_failures {
        failed_roots(&snapshot, &session_rows)?
    } else {
        BTreeSet::new()
    };
    Ok(Outstanding {
        sessions: owed,
        running,
        failed,
        lost,
    })
}

fn failed_roots(
    snapshot: &Snapshot,
    session_rows: &[ycoding_store::session::Session],
) -> Result<BTreeSet<LosslessString>, Error> {
    let parents = session_rows
        .iter()
        .map(|row| (row.id.clone(), row.parent_id.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut history = Vec::new();
    for row in session_rows {
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
    }
    history.sort_by(|left, right| (left.created, &left.id).cmp(&(right.created, &right.id)));
    let mut failed = BTreeSet::new();
    for event in history {
        let mut seen = BTreeSet::new();
        let mut root = event.aggregate_id.clone();
        while let Some(Some(parent)) = parents.get(&root) {
            if !seen.insert(root.clone()) {
                break;
            }
            root = parent.clone();
        }
        if !parents.contains_key(&root) || seen.contains(&root) {
            continue;
        }
        if event.type_.as_str() == Some(EXECUTION_FAILED) {
            failed.insert(root);
        } else {
            failed.remove(&root);
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

fn all<T: TableSpec>(snapshot: &Snapshot) -> Result<Vec<T::Record>, Error> {
    let mut rows = Vec::new();
    let mut after: Option<Vec<u8>> = None;
    loop {
        let page = snapshot.scan::<T>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            PAGE,
        )?;
        let Some(last) = page.last() else {
            return Ok(rows);
        };
        after = Some(T::primary_key(last));
        rows.extend(page);
    }
}
