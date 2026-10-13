use super::codec::key;
use super::{
    ConsentTable, Continuation, ContinuationGeneration, ContinuationGenerationTable,
    ContinuationTable, Kv, KvTable, Latency, LatencyTable, Request, RequestTable, Sequence,
    SequenceTable, StateBlob, StateBlobTable, StateLink, StateLinkTable, UsageTable,
};
use crate::{
    Error, IndexCursor, IndexOrder, IndexQuery, KeyPart, Snapshot, TableSpec, Write, analytics,
    session, tuple_key,
};
use std::ops::Bound;
use ycoding_schema::{LosslessString, domain};

pub fn set_kv(
    tx: &mut Write<'_>,
    key_: &LosslessString,
    value: &session::Document<domain::Json>,
    now: i64,
) -> Result<(), Error> {
    let old = tx.get::<KvTable>(&key(key_))?;
    KvTable::put(
        tx,
        &Kv {
            key: key_.clone(),
            value: value.clone(),
            time_created: old.map_or(now, |row| row.time_created),
            time_updated: now,
        },
    )
}
pub fn get_kv(
    snapshot: &Snapshot,
    key_: &LosslessString,
) -> Result<Option<session::Document<domain::Json>>, Error> {
    Ok(snapshot.get::<KvTable>(&key(key_))?.map(|row| row.value))
}
pub fn remove_kv(tx: &mut Write<'_>, key_: &LosslessString) -> Result<bool, Error> {
    tx.delete::<KvTable>(&key(key_))
}

pub fn seed_latency_sequence(tx: &mut Write<'_>, high_water: i64) -> Result<i64, Error> {
    let name = LosslessString::from(LatencyTable::NAME);
    let old = tx.get::<SequenceTable>(&key(&name))?;
    let high_water = largest_latency_id(
        tx,
        high_water
            .max(old.as_ref().map_or(0, |row| row.high_water))
            .max(0),
    )?;
    if old.is_some_and(|row| row.high_water == high_water) {
        return Ok(high_water);
    }
    SequenceTable::put(tx, &Sequence { name, high_water })?;
    Ok(high_water)
}

fn largest_latency_id(tx: &mut Write<'_>, minimum: i64) -> Result<i64, Error> {
    let mut maximum = minimum;
    loop {
        let lower = tuple_key(&[KeyPart::I64(maximum)]);
        let rows = tx.scan::<LatencyTable>(Bound::Excluded(&lower), Bound::Unbounded, 128)?;
        let Some(last) = rows.last() else {
            return Ok(maximum);
        };
        maximum = last.id;
    }
}

pub fn append_latency(
    tx: &mut Write<'_>,
    received_at: i64,
    sample: &session::Document<ycoding_schema::telemetry::Sample>,
) -> Result<Latency, Error> {
    let high_water = seed_latency_sequence(tx, 0)?;
    let id = high_water
        .checked_add(1)
        .ok_or_else(|| tx.reject(Error::Rejected("latency sequence exhausted")))?;
    let row = Latency {
        id,
        received_at,
        sample: sample.clone(),
    };
    LatencyTable::insert(tx, &row)?;
    Ok(row)
}

pub fn save_permission(
    tx: &mut Write<'_>,
    record: &crate::project::Permission,
) -> Result<bool, Error> {
    if tx
        .get::<crate::project::PermissionTable>(&key(&record.id))?
        .is_some()
        || !tx
            .index::<crate::project::PermissionTable>(
                "permission_project_action_resource_idx",
                &tuple_key(&[
                    KeyPart::String(&record.project_id),
                    KeyPart::String(&record.action),
                    KeyPart::String(&record.resource),
                ]),
                None,
                1,
            )?
            .is_empty()
    {
        return Ok(false);
    }
    crate::project::PermissionTable::insert(tx, record)?;
    Ok(true)
}

pub fn ensure_generation(
    tx: &mut Write<'_>,
    row: &ContinuationGeneration,
) -> Result<ContinuationGeneration, Error> {
    if let Some(old) = tx.get::<ContinuationGenerationTable>(&key(&row.session_id))? {
        return Ok(old);
    }
    ContinuationGenerationTable::insert(tx, row)?;
    Ok(row.clone())
}
pub fn invalidate_continuation(
    tx: &mut Write<'_>,
    session: &LosslessString,
    revision: i64,
    now: i64,
) -> Result<ContinuationGeneration, Error> {
    let previous = tx.get::<ContinuationGenerationTable>(&key(session))?;
    let generation = previous
        .map_or(Some(1), |row| row.generation.checked_add(1))
        .ok_or_else(|| tx.reject(Error::Rejected("continuation generation exhausted")))?;
    let row = ContinuationGeneration {
        session_id: session.clone(),
        generation,
        context_revision: revision,
        time_updated: now,
    };
    ContinuationGenerationTable::put(tx, &row)?;
    tx.delete::<ContinuationTable>(&key(session))?;
    Ok(row)
}
pub fn remember_continuation(tx: &mut Write<'_>, row: &Continuation) -> Result<bool, Error> {
    let authority = ensure_generation(
        tx,
        &ContinuationGeneration {
            session_id: row.session_id.clone(),
            generation: row.continuation_generation,
            context_revision: row.context_revision,
            time_updated: row.time_updated,
        },
    )?;
    if authority.generation != row.continuation_generation
        || authority.context_revision != row.context_revision
    {
        return Ok(false);
    }
    ContinuationTable::put(tx, row)?;
    Ok(true)
}

pub fn capture_state(tx: &mut Write<'_>, blob: &StateBlob, link: &StateLink) -> Result<(), Error> {
    StateBlobTable::encode(blob).map_err(|error| tx.reject(error))?;
    if blob.digest != link.blob_digest {
        return Err(tx.reject(Error::Rejected("capture blob identity mismatch")));
    }
    if tx.get::<StateBlobTable>(&key(&blob.digest))?.is_none() {
        StateBlobTable::insert(tx, blob)?;
    }
    StateLinkTable::put(tx, link)
}
pub fn state_blob_references(tx: &mut Write<'_>, digest: &LosslessString) -> Result<usize, Error> {
    let mut after: Option<Vec<u8>> = None;
    let mut count = 0usize;
    loop {
        let rows = tx.index::<StateLinkTable>(
            "session_provider_state_link_blob_idx",
            &key(digest),
            after.as_deref(),
            128,
        )?;
        if rows.is_empty() {
            return Ok(count);
        }
        after = rows.last().map(StateLinkTable::primary_key);
        count = count.checked_add(rows.len()).ok_or_else(|| {
            tx.reject(Error::Rejected("provider state reference count exhausted"))
        })?;
    }
}
pub fn delete_state_blob(tx: &mut Write<'_>, digest: &LosslessString) -> Result<bool, Error> {
    if state_blob_references(tx, digest)? != 0 {
        return Err(tx.reject(Error::Domain {
            kind: "foreign_restrict",
            message: "provider state blob is referenced",
        }));
    }
    tx.delete::<StateBlobTable>(&key(digest))
}
pub fn rebase_state(
    tx: &mut Write<'_>,
    session: &LosslessString,
    through_seq: i64,
) -> Result<(), Error> {
    let prefix = key(session);
    let upper = tuple_key(&[KeyPart::String(session), KeyPart::I64(through_seq)]);
    let mut after: Option<IndexCursor> = None;
    loop {
        let messages = tx.index_range::<crate::session::MessageTable>(
            "session_message_session_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Included(&upper),
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: after.as_ref(),
                limit: 128,
            },
        )?;
        if messages.is_empty() {
            return Ok(());
        }
        after = messages.last().map(|row| row.cursor.clone());
        crate::project::remove_children::<StateLinkTable>(tx, |row| {
            &row.session_id == session
                && messages
                    .iter()
                    .any(|message| message.record.id == row.message_id)
        })?;
    }
}

pub fn request_by_number(
    snapshot: &Snapshot,
    session: &LosslessString,
    number: i64,
) -> Result<Option<Request>, Error> {
    Ok(snapshot
        .index::<RequestTable>(
            "session_provider_request_session_request_idx",
            &tuple_key(&[KeyPart::String(session), KeyPart::I64(number)]),
            None,
            1,
        )?
        .into_iter()
        .next())
}
pub fn requests(
    snapshot: &Snapshot,
    session: &LosslessString,
    order: IndexOrder,
    after: Option<&IndexCursor>,
    limit: usize,
) -> Result<Vec<crate::IndexEntry<Request>>, Error> {
    snapshot.index_range::<RequestTable>(
        "session_provider_request_session_request_idx",
        IndexQuery {
            lower: Bound::Unbounded,
            upper: Bound::Unbounded,
            prefix: Some(&key(session)),
            order,
            after,
            limit,
        },
    )
}

pub fn telemetry_allowed(snapshot: &Snapshot, _: &[u8]) -> Result<bool, Error> {
    Ok(snapshot
        .get::<ConsentTable>(&tuple_key(&[KeyPart::I64(1)]))?
        .is_some_and(|row| {
            row.enabled == 1
                && row.notice_version == ycoding_schema::telemetry::CURRENT_NOTICE_VERSION
        }))
}
pub fn require_telemetry_report(snapshot: &Snapshot) -> Result<(), Error> {
    if !telemetry_allowed(snapshot, &[])? {
        return Err(Error::Rejected("telemetry disabled"));
    }
    if snapshot
        .get::<analytics::DeliveryTable>(&[])?
        .is_some_and(|state| state.purge_all || !state.purges.is_empty())
    {
        return Err(Error::Rejected("telemetry purge pending"));
    }
    Ok(())
}
pub fn purge_telemetry(tx: &mut Write<'_>) -> Result<(), Error> {
    remove_sources::<LatencyTable>(tx, "web_latency", |_| true)?;
    let mut after: Option<Vec<u8>> = None;
    loop {
        let rows = tx.scan::<RequestTable>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            128,
        )?;
        if rows.is_empty() {
            break;
        }
        after = rows.last().map(RequestTable::primary_key);
        for mut row in rows.into_iter().filter(|row| row.timing.is_some()) {
            row.timing = None;
            RequestTable::put(tx, &row)?;
        }
    }
    analytics::privacy_changed(tx, Vec::new(), true)?;
    Ok(())
}

fn delete_source<T: TableSpec>(
    tx: &mut Write<'_>,
    source: &'static str,
    identity: &[u8],
) -> Result<bool, Error> {
    if !tx.delete::<T>(identity)? {
        return Ok(false);
    }
    super::source_changed(tx, source, identity.to_vec(), true)?;
    Ok(true)
}
impl RequestTable {
    pub fn delete(tx: &mut Write<'_>, identity: &[u8]) -> Result<bool, Error> {
        delete_source::<Self>(tx, "session_provider_request", identity)
    }
}
impl UsageTable {
    pub fn delete(tx: &mut Write<'_>, identity: &[u8]) -> Result<bool, Error> {
        delete_source::<Self>(tx, "session_usage", identity)
    }
}
impl LatencyTable {
    pub fn delete(tx: &mut Write<'_>, identity: &[u8]) -> Result<bool, Error> {
        delete_source::<Self>(tx, "web_latency", identity)
    }
}
impl ConsentTable {
    pub fn delete(tx: &mut Write<'_>) -> Result<bool, Error> {
        let deleted =
            delete_source::<Self>(tx, "telemetry_consent", &tuple_key(&[KeyPart::I64(1)]))?;
        if deleted {
            analytics::privacy_changed(tx, Vec::new(), false)?;
        }
        Ok(deleted)
    }
}
fn remove_sources<T: TableSpec>(
    tx: &mut Write<'_>,
    source: &'static str,
    matches: impl Fn(&T::Record) -> bool,
) -> Result<(), Error> {
    let mut after: Option<Vec<u8>> = None;
    loop {
        let rows = tx.scan::<T>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            128,
        )?;
        if rows.is_empty() {
            return Ok(());
        }
        after = rows.last().map(T::primary_key);
        for row in rows.into_iter().filter(&matches) {
            delete_source::<T>(tx, source, &T::primary_key(&row))?;
        }
    }
}
pub(crate) fn remove_session_children(
    tx: &mut Write<'_>,
    id: &LosslessString,
) -> Result<(), Error> {
    crate::project::remove_children::<StateLinkTable>(tx, |row| &row.session_id == id)?;
    tx.delete::<ContinuationGenerationTable>(&key(id))?;
    tx.delete::<ContinuationTable>(&key(id))?;
    remove_sources::<RequestTable>(tx, "session_provider_request", |row| &row.session_id == id)?;
    remove_sources::<UsageTable>(tx, "session_usage", |row| &row.session_id == id)?;
    super::source_changed(tx, "session", key(id), true)
}
pub(crate) fn remove_revision_children(
    tx: &mut Write<'_>,
    id: &LosslessString,
    revision: i64,
) -> Result<(), Error> {
    crate::project::remove_children::<StateLinkTable>(tx, |row| {
        &row.session_id == id && row.context_revision == revision
    })?;
    crate::project::remove_children::<ContinuationGenerationTable>(tx, |row| {
        &row.session_id == id && row.context_revision == revision
    })?;
    crate::project::remove_children::<ContinuationTable>(tx, |row| {
        &row.session_id == id && row.context_revision == revision
    })
}
