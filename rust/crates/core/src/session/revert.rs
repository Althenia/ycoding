use super::{key, projector, store::Service};
use std::{fmt, ops::Bound};
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, ObjectEncoder, file_diff, schema::RelativePath,
    session, session_message, session_revert, snapshot,
};
use ycoding_store::{
    Error as StoreError, IndexOrder, IndexQuery, KeyPart, Snapshot, TableSpec, Write,
    session::{
        EventTable, InstructionStateTable, MessageTable, NewEvent, PendingTable, Session,
        SessionTable,
    },
    tuple_key,
};

pub type Plan = Vec<(RelativePath, snapshot::Id)>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotFailure {
    pub operation: &'static str,
    pub message: String,
}

#[derive(Debug)]
pub enum Error {
    MessageNotFound {
        session_id: session::Id,
        message_id: session_message::Id,
    },
    HistoryPruned {
        session_id: session::Id,
        message_id: session_message::Id,
    },
    SessionNotFound {
        session_id: session::Id,
    },
    Busy {
        session_id: session::Id,
    },
    Wake(String),
    Snapshot(SnapshotFailure),
    Store(StoreError),
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MessageNotFound { .. } => {
                formatter.write_str("Revert boundary message not found")
            }
            Self::HistoryPruned {
                session_id,
                message_id,
            } => write!(
                formatter,
                "Message {} is not in the retained history of session {}; history through the compaction checkpoint was removed",
                String::from_utf16_lossy(
                    &message_id.as_lossless().code_units().collect::<Vec<_>>()
                ),
                String::from_utf16_lossy(
                    &session_id.as_lossless().code_units().collect::<Vec<_>>()
                )
            ),
            Self::SessionNotFound { .. } => formatter.write_str("Session not found"),
            Self::Busy { session_id } => {
                write!(formatter, "Session {session_id:?} is busy")
            }
            Self::Wake(message) => write!(formatter, "Session wake failed: {message}"),
            Self::Snapshot(failure) => {
                write!(
                    formatter,
                    "Snapshot {} failed: {}",
                    failure.operation, failure.message
                )
            }
            Self::Store(error) => write!(formatter, "{error:?}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<StoreError> for Error {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

impl From<SnapshotFailure> for Error {
    fn from(failure: SnapshotFailure) -> Self {
        Self::Snapshot(failure)
    }
}

pub trait Snapshots {
    fn capture(&self) -> Option<snapshot::Id>;

    fn files(
        &self,
        from: &snapshot::Id,
        to: &snapshot::Id,
    ) -> Result<Vec<RelativePath>, SnapshotFailure>;

    fn restore(&self, files: &[(RelativePath, snapshot::Id)]) -> Result<(), SnapshotFailure>;

    fn diff(
        &self,
        from: &snapshot::Id,
        to: &snapshot::Id,
        paths: &[RelativePath],
    ) -> Result<Vec<file_diff::Info>, SnapshotFailure>;
}

pub trait Runs {
    fn active(&self) -> Vec<session::Id>;

    fn wake(&self, id: &session::Id) -> Result<(), String>;
}

impl Runs for super::execution::Execution {
    fn active(&self) -> Vec<session::Id> {
        super::execution::Execution::active(self)
    }

    fn wake(&self, id: &session::Id) -> Result<(), String> {
        super::execution::Execution::wake(self, id).map_err(|error| error.to_string())
    }
}

pub async fn stage_idle(
    service: &Service,
    runs: &dyn Runs,
    snapshots: &dyn Snapshots,
    session_id: &session::Id,
    message_id: &session_message::Id,
    files: bool,
    now: i64,
) -> Result<session_revert::Revert, Error> {
    let session = idle(service, runs, session_id)?;
    stage(service, snapshots, &session, message_id, files, now).await
}

pub async fn clear_idle(
    service: &Service,
    runs: &dyn Runs,
    snapshots: &dyn Snapshots,
    session_id: &session::Id,
    now: i64,
) -> Result<(), Error> {
    let session = idle(service, runs, session_id)?;
    clear(service, snapshots, &session, now).await?;
    runs.wake(session_id).map_err(Error::Wake)
}

pub async fn commit_idle(
    service: &Service,
    runs: &dyn Runs,
    session_id: &session::Id,
    now: i64,
) -> Result<(), Error> {
    let session = idle(service, runs, session_id)?;
    Ok(commit(service, &session, now).await?)
}

pub fn committed_after(
    snapshot: &Snapshot,
    session_id: &session::Id,
    seq: i64,
) -> Result<bool, StoreError> {
    let (prefix, lower) = committed_bounds(session_id, seq);
    Ok(!snapshot
        .index_range::<EventTable>(
            "event_aggregate_type_seq_idx",
            committed_query(&prefix, &lower),
        )?
        .is_empty())
}

pub(crate) fn committed_after_in(
    tx: &mut Write<'_>,
    session_id: &session::Id,
    seq: i64,
) -> Result<bool, StoreError> {
    let (prefix, lower) = committed_bounds(session_id, seq);
    Ok(!tx
        .index_range::<EventTable>(
            "event_aggregate_type_seq_idx",
            committed_query(&prefix, &lower),
        )?
        .is_empty())
}

fn committed_bounds(session_id: &session::Id, seq: i64) -> (Vec<u8>, Vec<u8>) {
    let committed = LosslessString::from("session.revert.committed.1");
    (
        tuple_key(&[
            KeyPart::String(session_id.as_lossless()),
            KeyPart::String(&committed),
        ]),
        tuple_key(&[
            KeyPart::String(session_id.as_lossless()),
            KeyPart::String(&committed),
            KeyPart::I64(seq),
        ]),
    )
}

fn committed_query<'a>(prefix: &'a [u8], lower: &'a [u8]) -> IndexQuery<'a> {
    IndexQuery {
        lower: Bound::Excluded(lower),
        upper: Bound::Unbounded,
        prefix: Some(prefix),
        order: IndexOrder::Descending,
        after: None,
        limit: 1,
    }
}

fn idle(
    service: &Service,
    runs: &dyn Runs,
    session_id: &session::Id,
) -> Result<session::Info, Error> {
    let session = service
        .get(session_id)?
        .ok_or_else(|| Error::SessionNotFound {
            session_id: session_id.clone(),
        })?;
    if runs.active().contains(session_id) {
        return Err(Error::Busy {
            session_id: session_id.clone(),
        });
    }
    Ok(session)
}

pub fn plan(
    snapshot: &Snapshot,
    session_id: &session::Id,
    message_id: &session_message::Id,
) -> Result<Plan, Error> {
    let boundary = snapshot.get::<MessageTable>(&key(message_id.as_lossless()))?;
    super::history_pruning::validate_target(session_id, boundary.as_ref(), || {
        super::history_pruning::checkpoint(snapshot, session_id)
    })
    .map_err(|error| match error {
        StoreError::Domain {
            kind: "history_pruned",
            ..
        } => Error::HistoryPruned {
            session_id: session_id.clone(),
            message_id: message_id.clone(),
        },
        StoreError::Domain {
            kind: "message_not_found",
            ..
        } => Error::MessageNotFound {
            session_id: session_id.clone(),
            message_id: message_id.clone(),
        },
        error => Error::Store(error),
    })?;
    let boundary = boundary.expect("validated boundary");
    let assistant = LosslessString::from("assistant");
    let prefix = tuple_key(&[
        KeyPart::String(session_id.as_lossless()),
        KeyPart::String(&assistant),
    ]);
    let lower = tuple_key(&[
        KeyPart::String(session_id.as_lossless()),
        KeyPart::String(&assistant),
        KeyPart::I64(boundary.seq),
    ]);
    let mut files = Plan::new();
    let mut after = None;
    loop {
        let rows = snapshot.index_range::<MessageTable>(
            "session_message_session_type_seq_idx",
            IndexQuery {
                lower: Bound::Excluded(&lower),
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: after.as_ref(),
                limit: 128,
            },
        )?;
        if rows.is_empty() {
            return Ok(files);
        }
        after = rows.last().map(|row| row.cursor.clone());
        for row in &rows {
            let session_message::Info::Assistant(message) = row.record.info()? else {
                continue;
            };
            let Some(range) = message.snapshot else {
                continue;
            };
            let Some(start) = range.start else {
                continue;
            };
            for file in range.files.into_iter().flatten() {
                if !files.iter().any(|(existing, _)| existing == &file) {
                    files.push((file, start.clone()));
                }
            }
        }
    }
}

pub async fn stage(
    service: &Service,
    snapshots: &dyn Snapshots,
    session: &session::Info,
    message_id: &session_message::Id,
    files: bool,
    now: i64,
) -> Result<session_revert::Revert, Error> {
    let next = plan(&service.client.snapshot()?, &session.id, message_id)?;
    let original = match session
        .revert
        .as_ref()
        .and_then(|revert| revert.snapshot.clone())
    {
        Some(original) => Some(original),
        None => snapshots.capture(),
    };
    let mut restore = Plan::new();
    if let Some(original) = &original {
        for file in session
            .revert
            .iter()
            .flat_map(|revert| revert.files.iter().flatten())
        {
            set(&mut restore, relative(&file.file)?, original.clone());
        }
    }
    if files {
        for (file, tree) in &next {
            set(&mut restore, file.clone(), tree.clone());
        }
    }
    if !restore.is_empty() {
        snapshots.restore(&restore)?;
    }
    let paths = if files {
        next.into_iter().map(|(file, _)| file).collect()
    } else {
        Vec::new()
    };
    let diffs = match &original {
        Some(original) => {
            let current = snapshots.capture().unwrap_or_else(|| original.clone());
            snapshots.diff(original, &current, &paths)?
        }
        None => Vec::new(),
    };
    let revert = session_revert::Revert {
        message_id: message_id.clone(),
        snapshot: original,
        files: Some(diffs),
    };
    publish(
        service,
        &session.id,
        now,
        "session.revert.staged.1",
        ObjectEncoder::new()
            .field("sessionID", &session.id)
            .field("revert", &revert)
            .finish(),
    )
    .await?;
    Ok(revert)
}

pub async fn clear(
    service: &Service,
    snapshots: &dyn Snapshots,
    session: &session::Info,
    now: i64,
) -> Result<(), Error> {
    let Some(revert) = &session.revert else {
        return Ok(());
    };
    if let Some(original) = &revert.snapshot {
        let files = revert
            .files
            .iter()
            .flatten()
            .map(|file| Ok((relative(&file.file)?, original.clone())))
            .collect::<Result<Plan, StoreError>>()?;
        snapshots.restore(&files)?;
    }
    publish(
        service,
        &session.id,
        now,
        "session.revert.cleared.1",
        ObjectEncoder::new()
            .field("sessionID", &session.id)
            .finish(),
    )
    .await?;
    Ok(())
}

pub async fn commit(
    service: &Service,
    session: &session::Info,
    now: i64,
) -> Result<(), StoreError> {
    let Some(revert) = &session.revert else {
        return Ok(());
    };
    publish(
        service,
        &session.id,
        now,
        "session.revert.committed.1",
        ObjectEncoder::new()
            .field("sessionID", &session.id)
            .field("to", &revert.message_id)
            .finish(),
    )
    .await
}

pub(crate) fn apply_staged(
    row: &mut Session,
    revert: &session_revert::Revert,
    created: i64,
) -> Result<(), StoreError> {
    row.revert = Some(ycoding_store::session::Document::from_domain(revert)?);
    row.time_updated = created;
    Ok(())
}

pub(crate) fn apply_cleared(row: &mut Session, created: i64) {
    row.revert = None;
    row.time_updated = created;
}

pub(crate) fn apply_committed(
    tx: &mut Write<'_>,
    session: &LosslessString,
    to: &session_message::Id,
    created: i64,
) -> Result<(), StoreError> {
    let boundary = tx
        .get::<MessageTable>(&key(to.as_lossless()))?
        .filter(|row| &row.session_id == session)
        .ok_or(StoreError::Rejected("Revert boundary message not found"))?;
    remove_from::<MessageTable>(tx, "session_message_session_seq_idx", session, boundary.seq)?;
    remove_from::<PendingTable>(
        tx,
        "session_pending_session_admitted_seq_idx",
        session,
        boundary.seq,
    )?;
    let mut row = tx
        .get::<SessionTable>(&key(session))?
        .ok_or(StoreError::Rejected("Session not found"))?;
    apply_cleared(&mut row, created);
    SessionTable::put(tx, &row)?;
    tx.delete::<InstructionStateTable>(&key(session))?;
    Ok(())
}

fn remove_from<T: TableSpec>(
    tx: &mut Write<'_>,
    index: &str,
    session: &LosslessString,
    from: i64,
) -> Result<(), StoreError> {
    let prefix = key(session);
    let lower = tuple_key(&[KeyPart::String(session), KeyPart::I64(from)]);
    loop {
        let rows = tx.index_range::<T>(
            index,
            IndexQuery {
                lower: Bound::Included(&lower),
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: None,
                limit: 128,
            },
        )?;
        if rows.is_empty() {
            return Ok(());
        }
        for row in rows {
            tx.delete::<T>(&T::primary_key(&row.record))?;
        }
    }
}

fn set(files: &mut Plan, file: RelativePath, tree: snapshot::Id) {
    match files.iter_mut().find(|(existing, _)| existing == &file) {
        Some(entry) => entry.1 = tree,
        None => files.push((file, tree)),
    }
}

fn relative(file: &LosslessString) -> Result<RelativePath, StoreError> {
    RelativePath::decode(&JsonValue::String(file.clone()))
        .map_err(|error| StoreError::Record(Box::new(error)))
}

async fn publish(
    service: &Service,
    session: &session::Id,
    now: i64,
    type_: &str,
    data: JsonValue,
) -> Result<(), StoreError> {
    service
        .publish(NewEvent {
            id: projector::random_event_id()?.as_lossless().clone(),
            aggregate_id: session.as_lossless().clone(),
            created: now,
            type_: type_.into(),
            data,
        })
        .await?;
    Ok(())
}
