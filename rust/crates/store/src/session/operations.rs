use super::codec::key;
use super::{
    ContextStateTable, Event, EventTable, ExclusionTable, FileChangeTable, InstructionEntryTable,
    InstructionStateTable, JobTable, ManifestTable, Message, MessageTable, Notification,
    NotificationTable, Pending, PendingTable, RevisionTable, Sequence, SequenceTable, SessionTable,
    Task, TaskTable, TodoStateTable, TodoTable,
};
use crate::project::remove_children;
use crate::{
    Error, IndexCursor, IndexEntry, IndexOrder, IndexQuery, KeyPart, Snapshot, TableSpec, Write,
    tuple_key,
};
use std::ops::Bound;
use ycoding_schema::{JsonValue, LosslessString};

fn reject(tx: &mut Write<'_>, kind: &'static str, message: &'static str) -> Error {
    tx.reject(Error::Domain { kind, message })
}

#[derive(Clone, Debug)]
pub struct NewEvent {
    pub id: LosslessString,
    pub aggregate_id: LosslessString,
    pub created: i64,
    pub type_: LosslessString,
    pub data: JsonValue,
}
#[derive(Clone, Debug)]
pub struct Replay {
    pub seq: i64,
    pub owner_id: Option<LosslessString>,
    pub strict_owner: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Append {
    Appended(Event),
    Replayed(Event),
    Ignored,
}

pub fn append(
    tx: &mut Write<'_>,
    event: &NewEvent,
    replay: Option<&Replay>,
) -> Result<Append, Error> {
    let previous = tx.get::<SequenceTable>(&key(&event.aggregate_id))?;
    let latest = previous.as_ref().map_or(-1, |row| row.seq);
    let owner = previous.as_ref().and_then(|row| row.owner_id.as_ref());
    if let Some(replay) = replay {
        if replay.strict_owner
            && owner.is_some_and(|owner| !owner.is_empty())
            && owner != replay.owner_id.as_ref()
        {
            return Err(reject(
                tx,
                "replay_owner",
                "aggregate replay owner mismatch",
            ));
        }
        if replay.seq <= latest {
            let stored = tx
                .index::<EventTable>(
                    "event_aggregate_seq_idx",
                    &tuple_key(&[
                        KeyPart::String(&event.aggregate_id),
                        KeyPart::I64(replay.seq),
                    ]),
                    None,
                    1,
                )?
                .into_iter()
                .next();
            if let Some(stored) = stored.filter(|row| {
                row.id == event.id
                    && row.type_ == event.type_
                    && row.created == event.created
                    && equal_json(&row.data, &event.data)
            }) {
                if owner.is_none()
                    && replay
                        .owner_id
                        .as_ref()
                        .is_some_and(|owner| !owner.is_empty())
                {
                    SequenceTable::put(
                        tx,
                        &Sequence {
                            aggregate_id: event.aggregate_id.clone(),
                            seq: latest,
                            owner_id: replay.owner_id.clone(),
                        },
                    )?;
                }
                return Ok(Append::Replayed(stored));
            }
            return Err(reject(
                tx,
                "replay_diverged",
                "stored aggregate sequence differs from replay",
            ));
        }
        if owner.is_some_and(|owner| !owner.is_empty()) && owner != replay.owner_id.as_ref() {
            return Ok(Append::Ignored);
        }
    }
    let next = latest
        .checked_add(1)
        .ok_or_else(|| reject(tx, "sequence_overflow", "aggregate sequence exhausted"))?;
    if replay.is_some_and(|replay| replay.seq != next) {
        return Err(reject(
            tx,
            "sequence_mismatch",
            "replay must advance exactly one sequence",
        ));
    }
    if tx.get::<EventTable>(&key(&event.id))?.is_some() {
        return Err(reject(
            tx,
            "event_identity",
            "event identity already exists",
        ));
    }
    let stored = Event {
        id: event.id.clone(),
        aggregate_id: event.aggregate_id.clone(),
        seq: next,
        created: event.created,
        type_: event.type_.clone(),
        data: event.data.clone(),
    };
    SequenceTable::put(
        tx,
        &Sequence {
            aggregate_id: event.aggregate_id.clone(),
            seq: next,
            owner_id: owner.cloned().or_else(|| {
                replay
                    .and_then(|replay| replay.owner_id.clone())
                    .filter(|owner| previous.is_none() || !owner.is_empty())
            }),
        },
    )?;
    EventTable::insert(tx, &stored)?;
    tx.record_event(stored.clone());
    Ok(Append::Appended(stored))
}

pub fn reserve_sequence(
    tx: &mut Write<'_>,
    aggregate: &LosslessString,
    seq: i64,
) -> Result<(), Error> {
    let previous = tx.get::<SequenceTable>(&key(aggregate))?;
    SequenceTable::put(
        tx,
        &Sequence {
            aggregate_id: aggregate.clone(),
            seq: previous.as_ref().map_or(seq, |row| row.seq.max(seq)),
            owner_id: previous.and_then(|row| row.owner_id),
        },
    )
}

pub fn latest_sequence(snapshot: &Snapshot, aggregate: &LosslessString) -> Result<i64, Error> {
    Ok(snapshot
        .get::<SequenceTable>(&key(aggregate))?
        .map_or(-1, |row| row.seq))
}

pub fn claim_sequence(
    tx: &mut Write<'_>,
    aggregate: &LosslessString,
    owner: &LosslessString,
) -> Result<(), Error> {
    if let Some(mut row) = tx.get::<SequenceTable>(&key(aggregate))? {
        row.owner_id = Some(owner.clone());
        SequenceTable::put(tx, &row)?;
    }
    Ok(())
}

pub fn delete_aggregate(tx: &mut Write<'_>, aggregate: &LosslessString) -> Result<bool, Error> {
    let prefix = key(aggregate);
    loop {
        let rows = tx.index_range::<EventTable>(
            "event_aggregate_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: None,
                limit: 128,
            },
        )?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            tx.delete::<EventTable>(&EventTable::primary_key(&row.record))?;
        }
    }
    tx.delete::<SequenceTable>(&prefix)
}

#[derive(Debug)]
pub struct PruneBatch {
    pub deleted: usize,
    pub next: Option<IndexCursor>,
}

pub fn prune_messages(
    tx: &mut Write<'_>,
    session: &LosslessString,
    below: i64,
    after: Option<&IndexCursor>,
    limit: usize,
    retain: impl Fn(&Message) -> bool,
) -> Result<PruneBatch, Error> {
    prune_below::<MessageTable>(
        tx,
        "session_message_session_seq_idx",
        session,
        below,
        after,
        limit.min(50),
        retain,
    )
}

pub fn prune_events(
    tx: &mut Write<'_>,
    aggregate: &LosslessString,
    below: i64,
    after: Option<&IndexCursor>,
    limit: usize,
    retain: impl Fn(&Event) -> bool,
) -> Result<PruneBatch, Error> {
    prune_below::<EventTable>(
        tx,
        "event_aggregate_seq_idx",
        aggregate,
        below,
        after,
        limit.min(100),
        retain,
    )
}

fn prune_below<T: TableSpec>(
    tx: &mut Write<'_>,
    index: &str,
    owner: &LosslessString,
    below: i64,
    after: Option<&IndexCursor>,
    limit: usize,
    retain: impl Fn(&T::Record) -> bool,
) -> Result<PruneBatch, Error> {
    if limit == 0 {
        return Err(tx.reject(Error::Rejected("pruning batch limit must be positive")));
    }
    let prefix = key(owner);
    let upper = tuple_key(&[KeyPart::String(owner), KeyPart::I64(below)]);
    let mut next = after.cloned();
    let mut deleted = 0;
    let mut bytes = 0usize;
    for count in 0..limit {
        let Some(row) = tx
            .index_range::<T>(
                index,
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Excluded(&upper),
                    prefix: Some(&prefix),
                    order: IndexOrder::Ascending,
                    after: next.as_ref(),
                    limit: 1,
                },
            )?
            .into_iter()
            .next()
        else {
            return Ok(PruneBatch {
                deleted,
                next: None,
            });
        };
        let size = T::encode(&row.record)?.len();
        if count > 0 && bytes.saturating_add(size) > 2 * 1024 * 1024 {
            break;
        }
        bytes = bytes.saturating_add(size);
        next = Some(row.cursor);
        if !retain(&row.record) {
            tx.delete::<T>(&T::primary_key(&row.record))?;
            deleted += 1;
        }
    }
    Ok(PruneBatch { deleted, next })
}

pub fn messages(
    snapshot: &Snapshot,
    session: &LosslessString,
    lower: Bound<i64>,
    upper: Bound<i64>,
    order: IndexOrder,
    after: Option<&IndexCursor>,
    limit: usize,
) -> Result<Vec<IndexEntry<Message>>, Error> {
    let prefix = key(session);
    let lower = lower.map(|seq| tuple_key(&[KeyPart::String(session), KeyPart::I64(seq)]));
    let upper = upper.map(|seq| tuple_key(&[KeyPart::String(session), KeyPart::I64(seq)]));
    snapshot.index_range::<MessageTable>(
        "session_message_session_seq_idx",
        IndexQuery {
            lower: lower.as_ref().map(Vec::as_slice),
            upper: upper.as_ref().map(Vec::as_slice),
            prefix: Some(&prefix),
            order,
            after,
            limit,
        },
    )
}

pub fn pending(
    snapshot: &Snapshot,
    session: &LosslessString,
    delivery: Option<&LosslessString>,
    after: Option<&IndexCursor>,
    limit: usize,
) -> Result<Vec<IndexEntry<Pending>>, Error> {
    let prefix = tuple_key(&[
        KeyPart::String(session),
        delivery.map_or(KeyPart::Null, KeyPart::String),
    ]);
    snapshot.index_range::<PendingTable>(
        "session_pending_session_delivery_seq_idx",
        IndexQuery {
            lower: Bound::Unbounded,
            upper: Bound::Unbounded,
            prefix: Some(&prefix),
            order: IndexOrder::Ascending,
            after,
            limit,
        },
    )
}

#[derive(Clone, Debug, PartialEq)]
pub enum Admission {
    Pending(Pending),
    Promoted(Message),
}

pub fn admit(tx: &mut Write<'_>, record: &Pending) -> Result<Admission, Error> {
    if let Some(existing) = tx.get::<PendingTable>(&key(&record.id))? {
        if existing.session_id != record.session_id || existing.type_ != record.type_ {
            return Err(reject(
                tx,
                "input_identity",
                "input identity belongs to another session or kind",
            ));
        }
        return Ok(Admission::Pending(existing));
    }
    if let Some(existing) = tx.get::<MessageTable>(&key(&record.id))? {
        if existing.session_id != record.session_id || existing.type_ != record.type_ {
            return Err(reject(
                tx,
                "input_identity",
                "input identity belongs to another session or kind",
            ));
        }
        return Ok(Admission::Promoted(existing));
    }
    PendingTable::insert(tx, record)?;
    Ok(Admission::Pending(record.clone()))
}

pub fn promote(tx: &mut Write<'_>, message: &Message) -> Result<Pending, Error> {
    let prefix = key(&message.session_id);
    let mut after = None;
    loop {
        let rows = tx.index_range::<PendingTable>(
            "session_pending_session_admitted_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: after.as_ref(),
                limit: 128,
            },
        )?;
        if rows
            .iter()
            .any(|row| row.record.type_.as_str() == Some("compaction"))
        {
            return Err(reject(
                tx,
                "input_lifecycle",
                "compaction admission blocks message promotion",
            ));
        }
        if rows.is_empty() {
            break;
        }
        after = rows.last().map(|row| row.cursor.clone());
    }
    let stored = tx
        .get::<PendingTable>(&key(&message.id))?
        .ok_or_else(|| reject(tx, "input_lifecycle", "pending input is missing"))?;
    if stored.session_id != message.session_id
        || stored.type_ != message.type_
        || !matches!(stored.type_.as_str(), Some("user" | "synthetic"))
        || stored
            .delivery
            .as_ref()
            .is_none_or(LosslessString::is_empty)
    {
        return Err(reject(
            tx,
            "input_lifecycle",
            "pending input cannot promote to this message",
        ));
    }
    MessageTable::insert(tx, message)?;
    tx.delete::<PendingTable>(&key(&message.id))?;
    Ok(stored)
}

pub fn task_by_launch(
    snapshot: &Snapshot,
    parent: &LosslessString,
    assistant: &LosslessString,
    call: &LosslessString,
) -> Result<Option<Task>, Error> {
    Ok(snapshot
        .index::<TaskTable>(
            "session_task_launch_identity_idx",
            &tuple_key(&[
                KeyPart::String(parent),
                KeyPart::String(assistant),
                KeyPart::String(call),
            ]),
            None,
            1,
        )?
        .into_iter()
        .next())
}
pub fn notification_by_transition(
    snapshot: &Snapshot,
    task: &LosslessString,
    type_: &LosslessString,
    revision: i64,
) -> Result<Option<Notification>, Error> {
    Ok(snapshot
        .index::<NotificationTable>(
            "session_task_notification_transition_idx",
            &tuple_key(&[
                KeyPart::String(task),
                KeyPart::String(type_),
                KeyPart::I64(revision),
            ]),
            None,
            1,
        )?
        .into_iter()
        .next())
}

pub fn delete_task(tx: &mut Write<'_>, id: &LosslessString) -> Result<bool, Error> {
    remove_index_prefix::<NotificationTable>(
        tx,
        "session_task_notification_transition_idx",
        &key(id),
    )?;
    let removed = tx.delete::<TaskTable>(&key(id))?;
    if removed {
        crate::resources::source_changed(tx, "task", key(id), true)?;
    }
    Ok(removed)
}

pub fn delete(tx: &mut Write<'_>, id: &LosslessString) -> Result<bool, Error> {
    if tx.get::<SessionTable>(&key(id))?.is_none() {
        return Ok(false);
    }
    delete_task(tx, id)?;
    crate::resources::remove_session_children(tx, id)?;
    let prefix = key(id);
    loop {
        let rows = tx.index_range::<TaskTable>(
            "session_task_parent_state_updated_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: None,
                limit: 128,
            },
        )?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            delete_task(tx, &row.record.session_id)?;
        }
    }
    remove_children::<NotificationTable>(tx, |row| &row.parent_id == id)?;
    remove_index_prefix::<MessageTable>(tx, "session_message_session_seq_idx", &prefix)?;
    remove_index_prefix::<PendingTable>(tx, "session_pending_session_admitted_seq_idx", &prefix)?;
    remove_index_prefix::<TodoTable>(tx, "session_todo_session_idx", &prefix)?;
    tx.delete::<TodoStateTable>(&prefix)?;
    remove_primary_prefix::<FileChangeTable>(tx, &prefix)?;
    remove_children::<JobTable>(tx, |row| &row.session_id == id)?;
    remove_primary_prefix::<ExclusionTable>(tx, &prefix)?;
    tx.delete::<ContextStateTable>(&prefix)?;
    remove_primary_prefix::<RevisionTable>(tx, &prefix)?;
    remove_primary_prefix::<InstructionEntryTable>(tx, &prefix)?;
    tx.delete::<InstructionStateTable>(&prefix)?;
    tx.delete::<SessionTable>(&key(id))
}

pub fn delete_revision(
    tx: &mut Write<'_>,
    session: &LosslessString,
    revision: i64,
) -> Result<bool, Error> {
    let mut current = revision;
    let mut deleted = false;
    loop {
        let primary = tuple_key(&[KeyPart::String(session), KeyPart::I64(current)]);
        if tx.get::<RevisionTable>(&primary)?.is_none() {
            return Ok(deleted);
        }
        remove_children::<JobTable>(tx, |row| {
            &row.session_id == session && row.base_context_revision == current
        })?;
        crate::resources::remove_revision_children(tx, session, current)?;
        remove_primary_prefix::<ExclusionTable>(tx, &primary)?;
        remove_children::<ContextStateTable>(tx, |row| {
            &row.session_id == session && row.revision == current
        })?;
        tx.delete::<RevisionTable>(&primary)?;
        deleted = true;
        let Some(next) = current.checked_add(1) else {
            return Ok(deleted);
        };
        if !tx
            .get::<RevisionTable>(&tuple_key(&[KeyPart::String(session), KeyPart::I64(next)]))?
            .is_some_and(|row| row.parent_revision == Some(current))
        {
            return Ok(deleted);
        }
        current = next;
    }
}

fn remove_index_prefix<T: TableSpec>(
    tx: &mut Write<'_>,
    name: &str,
    prefix: &[u8],
) -> Result<(), Error> {
    loop {
        let rows = tx.index_range::<T>(
            name,
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(prefix),
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

fn remove_primary_prefix<T: TableSpec>(tx: &mut Write<'_>, prefix: &[u8]) -> Result<(), Error> {
    let mut upper = prefix.to_vec();
    loop {
        let byte = upper
            .pop()
            .ok_or_else(|| reject(tx, "key_prefix", "cascade requires a bounded tuple prefix"))?;
        if byte != u8::MAX {
            upper.push(byte + 1);
            break;
        }
    }
    loop {
        let rows = tx.scan::<T>(Bound::Included(prefix), Bound::Excluded(&upper), 128)?;
        if rows.is_empty() {
            return Ok(());
        }
        for row in rows {
            tx.delete::<T>(&T::primary_key(&row))?;
        }
    }
}

pub fn manifest_references(tx: &mut Write<'_>, digest: &LosslessString) -> Result<usize, Error> {
    fn count<T: TableSpec>(
        tx: &mut Write<'_>,
        matches: impl Fn(&T::Record) -> bool,
    ) -> Result<usize, Error> {
        let mut after: Option<Vec<u8>> = None;
        let mut count = 0;
        loop {
            let rows = tx.scan::<T>(
                after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
                128,
            )?;
            if rows.is_empty() {
                return Ok(count);
            }
            after = rows.last().map(T::primary_key);
            count += rows.iter().filter(|row| matches(row)).count();
        }
    }
    Ok(
        count::<JobTable>(tx, |row| row.manifest_digest.as_ref() == Some(digest))?
            + count::<RevisionTable>(tx, |row| row.manifest_digest.as_ref() == Some(digest))?
            + count::<ContextStateTable>(tx, |row| row.manifest_digest.as_ref() == Some(digest))?
            + count::<ExclusionTable>(tx, |row| &row.manifest_digest == digest)?,
    )
}

pub fn delete_manifest(tx: &mut Write<'_>, digest: &LosslessString) -> Result<bool, Error> {
    if manifest_references(tx, digest)? != 0 {
        return Err(reject(
            tx,
            "restrict",
            "compaction manifest is still referenced",
        ));
    }
    tx.delete::<ManifestTable>(&key(digest))
}

fn equal_json(left: &JsonValue, right: &JsonValue) -> bool {
    let mut pending = vec![(left, right)];
    while let Some((left, right)) = pending.pop() {
        match (left, right) {
            (JsonValue::Number(left), JsonValue::Number(right)) => {
                if left.to_bits() != right.to_bits() && !(left.is_nan() && right.is_nan()) {
                    return false;
                }
            }
            (JsonValue::Array(left), JsonValue::Array(right)) => {
                if left.len() != right.len() {
                    return false;
                }
                pending.extend(left.iter().zip(right));
            }
            (JsonValue::Object(left), JsonValue::Object(right)) => {
                if left.len() != right.len() {
                    return false;
                }
                for (key, value) in left.iter() {
                    let Some(other) = right.get(key) else {
                        return false;
                    };
                    pending.push((value, other));
                }
            }
            _ if left != right => return false,
            _ => {}
        }
    }
    true
}
