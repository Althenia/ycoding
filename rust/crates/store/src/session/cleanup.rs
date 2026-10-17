use super::{ExclusionTable, FileChangeTable, SessionTable};
use crate::{
    Error, IndexCursor, IndexOrder, IndexQuery, KeyPart, Snapshot, TableSpec, Write,
    resources::{RequestTable, UsageAnalyticsRequestTable, UsageTable},
    tuple_key,
};
use std::{cmp::Ordering, ops::Bound};
use ycoding_schema::LosslessString;

pub const CLEANUP_BATCH: usize = 200;
pub const CLEANUP_ROWS: usize = 100;

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

#[derive(Debug, Default)]
pub struct Batch {
    pub deleted: ProjectionDeletes,
    pub finished: bool,
}

#[derive(Debug, Default)]
pub struct CleanupCursor {
    stage: usize,
    primary: Option<Vec<u8>>,
    index: Option<IndexCursor>,
}

#[derive(Clone, Copy)]
enum Stage {
    Exclusions,
    Files,
    Usage,
    Requests,
}

impl Projection {
    fn stages(self) -> &'static [Stage] {
        match self {
            Self::Exclusions => &[Stage::Exclusions],
            Self::Files => &[Stage::Files],
            Self::Usage => &[Stage::Usage, Stage::Requests],
        }
    }
}

pub fn cleanup_batch(
    tx: &mut Write<'_>,
    snapshot: &Snapshot,
    session: &CleanupSession,
    cutoff: i64,
    active: &[LosslessString],
    projection: Projection,
    cursor: &mut CleanupCursor,
) -> Result<Batch, Error> {
    let mut batch = Batch::default();
    let prefix = tuple_key(&[KeyPart::String(&session.id)]);
    let current = tx.get::<SessionTable>(&prefix)?;
    let Some(current) = current.filter(|current| {
        !active.contains(&session.id)
            && current.time_updated == session.updated
            && current.time_updated < cutoff
    }) else {
        batch.finished = true;
        return Ok(batch);
    };
    let mut budget = CLEANUP_ROWS;
    while budget > 0 {
        let Some(stage) = projection.stages().get(cursor.stage).copied() else {
            batch.finished = true;
            break;
        };
        let (examined, deleted, exhausted) = match stage {
            Stage::Exclusions => prune_primary::<ExclusionTable>(
                tx,
                snapshot,
                &prefix,
                cursor,
                budget,
                |tx, identity| tx.delete::<ExclusionTable>(identity),
            )?,
            Stage::Files => prune_primary::<FileChangeTable>(
                tx,
                snapshot,
                &prefix,
                cursor,
                budget,
                |tx, identity| tx.delete::<FileChangeTable>(identity),
            )?,
            Stage::Usage => prune_primary::<UsageTable>(
                tx,
                snapshot,
                &prefix,
                cursor,
                budget,
                UsageTable::delete,
            )?,
            Stage::Requests => prune_requests(tx, snapshot, &prefix, cursor, budget)?,
        };
        match stage {
            Stage::Exclusions => batch.deleted.exclusions += deleted,
            Stage::Files => batch.deleted.files += deleted,
            Stage::Usage => batch.deleted.usage += deleted,
            Stage::Requests => batch.deleted.requests += deleted,
        }
        budget -= examined;
        if exhausted {
            cursor.stage += 1;
            cursor.primary = None;
            cursor.index = None;
        }
    }
    if batch.deleted.requests > 0 {
        let mut row = current;
        row.usage_pruned_through = Some(
            row.usage_pruned_through
                .map_or(cutoff, |through| through.max(cutoff)),
        );
        SessionTable::put(tx, &row)?;
    }
    Ok(batch)
}

pub fn delete_expired_facts(tx: &mut Write<'_>, cutoff: i64) -> Result<usize, Error> {
    let upper = tuple_key(&[KeyPart::I64(cutoff)]);
    let rows = tx.index_range::<UsageAnalyticsRequestTable>(
        "usage_analytics_request_time_created_id_idx",
        IndexQuery {
            lower: Bound::Unbounded,
            upper: Bound::Excluded(&upper),
            prefix: None,
            order: IndexOrder::Ascending,
            after: None,
            limit: CLEANUP_ROWS,
        },
    )?;
    for row in &rows {
        UsageAnalyticsRequestTable::delete(
            tx,
            &UsageAnalyticsRequestTable::primary_key(&row.record),
        )?;
    }
    Ok(rows.len())
}

pub fn has_expired_facts(snapshot: &Snapshot, cutoff: i64) -> Result<bool, Error> {
    let upper = tuple_key(&[KeyPart::I64(cutoff)]);
    Ok(!snapshot
        .index_range::<UsageAnalyticsRequestTable>(
            "usage_analytics_request_time_created_id_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Excluded(&upper),
                prefix: None,
                order: IndexOrder::Ascending,
                after: None,
                limit: 1,
            },
        )?
        .is_empty())
}

fn prune_primary<T: TableSpec>(
    tx: &mut Write<'_>,
    snapshot: &Snapshot,
    prefix: &[u8],
    cursor: &mut CleanupCursor,
    budget: usize,
    delete: impl Fn(&mut Write<'_>, &[u8]) -> Result<bool, Error>,
) -> Result<(usize, usize, bool), Error> {
    let upper = prefix_end(prefix)?;
    let rows = snapshot.scan::<T>(
        cursor
            .primary
            .as_deref()
            .map_or(Bound::Included(prefix), Bound::Excluded),
        Bound::Excluded(&upper),
        budget,
    )?;
    let mut deleted = 0;
    for row in &rows {
        deleted += usize::from(prune_record::<T>(tx, row, &delete)?);
    }
    if let Some(last) = rows.last() {
        cursor.primary = Some(T::primary_key(last));
    }
    Ok((rows.len(), deleted, rows.len() < budget))
}

fn prefix_end(prefix: &[u8]) -> Result<Vec<u8>, Error> {
    let mut upper = prefix.to_vec();
    while upper.last() == Some(&u8::MAX) {
        upper.pop();
    }
    let last = upper
        .last_mut()
        .ok_or(Error::Rejected("cleanup requires a bounded tuple prefix"))?;
    *last += 1;
    Ok(upper)
}

pub fn has_cleanup_rows(
    snapshot: &Snapshot,
    session: &CleanupSession,
    projection: Projection,
) -> Result<bool, Error> {
    let prefix = tuple_key(&[KeyPart::String(&session.id)]);
    let upper = prefix_end(&prefix)?;
    for stage in projection.stages() {
        let found = match stage {
            Stage::Exclusions => has_primary::<ExclusionTable>(snapshot, &prefix, &upper)?,
            Stage::Files => has_primary::<FileChangeTable>(snapshot, &prefix, &upper)?,
            Stage::Usage => has_primary::<UsageTable>(snapshot, &prefix, &upper)?,
            Stage::Requests => !snapshot
                .index_range::<RequestTable>(
                    "session_provider_request_session_request_idx",
                    IndexQuery {
                        lower: Bound::Unbounded,
                        upper: Bound::Unbounded,
                        prefix: Some(&prefix),
                        order: IndexOrder::Ascending,
                        after: None,
                        limit: 1,
                    },
                )?
                .is_empty(),
        };
        if found {
            return Ok(true);
        }
    }
    Ok(false)
}

fn has_primary<T: TableSpec>(
    snapshot: &Snapshot,
    prefix: &[u8],
    upper: &[u8],
) -> Result<bool, Error> {
    Ok(!snapshot
        .scan::<T>(Bound::Included(prefix), Bound::Excluded(upper), 1)?
        .is_empty())
}

fn prune_requests(
    tx: &mut Write<'_>,
    snapshot: &Snapshot,
    prefix: &[u8],
    cursor: &mut CleanupCursor,
    budget: usize,
) -> Result<(usize, usize, bool), Error> {
    let rows = snapshot.index_range::<RequestTable>(
        "session_provider_request_session_request_idx",
        IndexQuery {
            lower: Bound::Unbounded,
            upper: Bound::Unbounded,
            prefix: Some(prefix),
            order: IndexOrder::Ascending,
            after: cursor.index.as_ref(),
            limit: budget,
        },
    )?;
    let mut deleted = 0;
    for row in &rows {
        deleted += usize::from(prune_record::<RequestTable>(
            tx,
            &row.record,
            RequestTable::delete,
        )?);
    }
    if let Some(last) = rows.last() {
        cursor.index = Some(last.cursor.clone());
    }
    Ok((rows.len(), deleted, rows.len() < budget))
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
