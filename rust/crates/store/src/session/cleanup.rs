use super::{ExclusionTable, FileChangeTable, SessionTable};
use crate::{
    Error, IndexOrder, IndexQuery, KeyPart, Snapshot, TableSpec, Write,
    resources::{RequestTable, UsageTable},
    tuple_key,
};
use std::{cmp::Ordering, ops::Bound};
use ycoding_schema::LosslessString;

pub const CLEANUP_BATCH: usize = 200;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CleanupSession {
    pub updated: i64,
    pub id: LosslessString,
}
impl Ord for CleanupSession {
    fn cmp(&self, other: &Self) -> Ordering {
        self.updated
            .cmp(&other.updated)
            .then_with(|| {
                String::from_utf16_lossy(&self.id.code_units().collect::<Vec<_>>()).cmp(
                    &String::from_utf16_lossy(&other.id.code_units().collect::<Vec<_>>()),
                )
            })
            .then_with(|| self.id.cmp(&other.id))
    }
}
impl PartialOrd for CleanupSession {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

pub fn cleanup_sessions(
    snapshot: &Snapshot,
    cutoff: i64,
    after: Option<&CleanupSession>,
) -> Result<Vec<CleanupSession>, Error> {
    let mut candidates = Vec::new();
    let mut primary = None;
    loop {
        let rows = snapshot.scan::<SessionTable>(
            primary.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            CLEANUP_BATCH,
        )?;
        let Some(last) = rows.last() else {
            return Ok(candidates);
        };
        primary = Some(SessionTable::primary_key(last));
        for row in rows.into_iter().filter(|row| row.time_updated < cutoff) {
            let candidate = CleanupSession {
                updated: row.time_updated,
                id: row.id,
            };
            if after.is_some_and(|after| &candidate <= after) {
                continue;
            }
            let position = candidates
                .binary_search(&candidate)
                .unwrap_or_else(|position| position);
            if position >= CLEANUP_BATCH {
                continue;
            }
            candidates.insert(position, candidate);
            candidates.truncate(CLEANUP_BATCH);
        }
    }
}

#[derive(Clone, Copy)]
pub enum Projection {
    Exclusions,
    Files,
    Usage,
}

#[derive(Debug, Default)]
pub struct ProjectionDeletes {
    pub exclusions: usize,
    pub files: usize,
    pub requests: usize,
    pub usage: usize,
}

pub fn cleanup_projections(
    tx: &mut Write<'_>,
    snapshot: &Snapshot,
    sessions: &[CleanupSession],
    cutoff: i64,
    active: &[LosslessString],
    projection: Projection,
) -> Result<ProjectionDeletes, Error> {
    let mut deleted = ProjectionDeletes::default();
    for session in sessions {
        if active.contains(&session.id) {
            continue;
        }
        let prefix = tuple_key(&[KeyPart::String(&session.id)]);
        let Some(current) = tx.get::<SessionTable>(&prefix)? else {
            continue;
        };
        if current.time_updated != session.updated || current.time_updated >= cutoff {
            continue;
        }
        match projection {
            Projection::Exclusions => {
                deleted.exclusions +=
                    prune_primary::<ExclusionTable>(tx, snapshot, &prefix, |tx, identity| {
                        tx.delete::<ExclusionTable>(identity)
                    })?
            }
            Projection::Files => {
                deleted.files +=
                    prune_primary::<FileChangeTable>(tx, snapshot, &prefix, |tx, identity| {
                        tx.delete::<FileChangeTable>(identity)
                    })?
            }
            Projection::Usage => {
                deleted.usage +=
                    prune_primary::<UsageTable>(tx, snapshot, &prefix, UsageTable::delete)?;
                let mut after = None;
                loop {
                    let rows = snapshot.index_range::<RequestTable>(
                        "session_provider_request_session_request_idx",
                        IndexQuery {
                            lower: Bound::Unbounded,
                            upper: Bound::Unbounded,
                            prefix: Some(&prefix),
                            order: IndexOrder::Ascending,
                            after: after.as_ref(),
                            limit: 128,
                        },
                    )?;
                    let Some(last) = rows.last() else {
                        break;
                    };
                    after = Some(last.cursor.clone());
                    for row in rows {
                        deleted.requests += usize::from(prune_record::<RequestTable>(
                            tx,
                            &row.record,
                            RequestTable::delete,
                        )?);
                    }
                }
            }
        }
    }
    Ok(deleted)
}

fn prune_primary<T: TableSpec>(
    tx: &mut Write<'_>,
    snapshot: &Snapshot,
    prefix: &[u8],
    delete: impl Fn(&mut Write<'_>, &[u8]) -> Result<bool, Error>,
) -> Result<usize, Error> {
    let mut upper = prefix.to_vec();
    while upper.last() == Some(&u8::MAX) {
        upper.pop();
    }
    let last = upper
        .last_mut()
        .ok_or(Error::Rejected("cleanup requires a bounded tuple prefix"))?;
    *last += 1;
    let mut after = None;
    let mut deleted = 0;
    loop {
        let rows = snapshot.scan::<T>(
            after
                .as_deref()
                .map_or(Bound::Included(prefix), Bound::Excluded),
            Bound::Excluded(&upper),
            128,
        )?;
        let Some(last) = rows.last() else {
            return Ok(deleted);
        };
        after = Some(T::primary_key(last));
        for row in rows {
            deleted += usize::from(prune_record::<T>(tx, &row, &delete)?);
        }
    }
}

fn prune_record<T: TableSpec>(
    tx: &mut Write<'_>,
    initial: &T::Record,
    delete: impl Fn(&mut Write<'_>, &[u8]) -> Result<bool, Error>,
) -> Result<bool, Error> {
    let identity = T::primary_key(initial);
    let Some(current) = tx.get::<T>(&identity)? else {
        return Ok(false);
    };
    if T::encode(&current)? != T::encode(initial)? {
        return Ok(false);
    }
    delete(tx, &identity)
}
