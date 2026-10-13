use super::codec::{key, require};
use super::document::{self, Kind, document, field, number, parse, set, text};
use super::tables::{
    ApprovalTable, CheckpointTable, ChildTable, FindingTable, JobTable, Meeting, MeetingTable,
    PlanTable, ProposalTable, Record, Reference, ReferenceTable, Segment, SegmentTable,
};
use crate::{Error, IndexOrder, IndexQuery, KeyPart, Snapshot, TableSpec, Write, tuple_key};
use std::collections::hash_map::RandomState;
use std::hash::BuildHasher;
use std::ops::Bound;
use ycoding_schema::{JsonObject, JsonValue, LosslessString, stringify_json};

pub fn create_meeting(
    tx: &mut Write<'_>,
    input: &JsonValue,
    now: &str,
) -> Result<JsonValue, Error> {
    let mut value = document(Kind::Create, input).map_err(|error| tx.reject(error))?;
    set(&mut value, "status", JsonValue::String("ready".into()))?;
    set(&mut value, "createdAt", JsonValue::String(now.into()))?;
    set(&mut value, "updatedAt", JsonValue::String(now.into()))?;
    let value = document(Kind::Meeting, &value).map_err(|error| tx.reject(error))?;
    let id = text(&value, "id")?;
    if let Some(existing) = tx.get::<MeetingTable>(&key(id))? {
        let existing = parse(Kind::Meeting, &existing.data)?;
        if text(&existing, "title")? != text(&value, "title")?
            || text(&existing, "sessionID")? != text(&value, "sessionID")?
        {
            return Err(tx.reject(Error::Rejected("changed meeting replay")));
        }
        return Ok(existing);
    }
    MeetingTable::put(
        tx,
        &Meeting {
            id: id.clone(),
            data: stringify_json(&value).into(),
        },
    )?;
    Ok(value)
}

pub fn get_meeting(snapshot: &Snapshot, id: &LosslessString) -> Result<Option<JsonValue>, Error> {
    snapshot
        .get::<MeetingTable>(&key(id))?
        .map(|row| parse(Kind::Meeting, &row.data))
        .transpose()
}

pub fn list_meetings(
    snapshot: &Snapshot,
    query: &str,
    limit: u64,
) -> Result<Vec<JsonValue>, Error> {
    result_limit(limit)?;
    let query = sqlite_lower(&query.into());
    let mut values = scan::<MeetingTable>(snapshot)?
        .into_iter()
        .map(|row| parse(Kind::Meeting, &row.data))
        .collect::<Result<Vec<_>, _>>()?;
    values.retain(|value| {
        query.is_empty()
            || text(value, "title").is_ok_and(|title| {
                sqlite_lower(title)
                    .windows(query.len())
                    .any(|window| window == query)
            })
    });
    values.sort_by(|a, b| {
        text(b, "updatedAt")
            .unwrap()
            .cmp(text(a, "updatedAt").unwrap())
            .then_with(|| binary(text(a, "id").unwrap()).cmp(&binary(text(b, "id").unwrap())))
    });
    values.truncate(limit.min(usize::MAX as u64) as usize);
    Ok(values)
}

pub fn update_meeting(
    tx: &mut Write<'_>,
    id: &LosslessString,
    patch: &JsonValue,
    now: &str,
) -> Result<JsonValue, Error> {
    let patch = document(Kind::Patch, patch).map_err(|error| tx.reject(error))?;
    let existing = tx
        .get::<MeetingTable>(&key(id))?
        .ok_or_else(|| tx.reject(Error::Rejected("unknown meeting")))?;
    let mut value = parse(Kind::Meeting, &existing.data)?;
    let JsonValue::Object(patch) = patch else {
        return Err(tx.reject(document::invalid()));
    };
    for (name, replacement) in patch.iter() {
        set(
            &mut value,
            name.as_str().ok_or_else(document::invalid)?,
            replacement.clone(),
        )?;
    }
    set(&mut value, "updatedAt", JsonValue::String(now.into()))?;
    let value = document(Kind::Meeting, &value).map_err(|error| tx.reject(error))?;
    MeetingTable::put(
        tx,
        &Meeting {
            id: id.clone(),
            data: stringify_json(&value).into(),
        },
    )?;
    Ok(value)
}

pub fn clear_optional_fields(
    tx: &mut Write<'_>,
    id: &LosslessString,
    fields: &[&str],
    now: &str,
) -> Result<JsonValue, Error> {
    if fields
        .iter()
        .any(|name| !["captureID", "error"].contains(name))
    {
        return Err(tx.reject(Error::Rejected("invalid meeting patch")));
    }
    let existing = tx
        .get::<MeetingTable>(&key(id))?
        .ok_or_else(|| tx.reject(Error::Rejected("unknown meeting")))?;
    let JsonValue::Object(value) = parse(Kind::Meeting, &existing.data)? else {
        return Err(tx.reject(document::invalid()));
    };
    let mut output = JsonObject::new();
    for (name, value) in value
        .iter()
        .filter(|(name, _)| !fields.iter().any(|field| name == &(*field).into()))
    {
        output.insert(name.clone(), value.clone());
    }
    let mut value = JsonValue::Object(output);
    set(&mut value, "updatedAt", JsonValue::String(now.into()))?;
    let value = document(Kind::Meeting, &value).map_err(|error| tx.reject(error))?;
    MeetingTable::put(
        tx,
        &Meeting {
            id: id.clone(),
            data: stringify_json(&value).into(),
        },
    )?;
    Ok(value)
}

pub fn put_segment(tx: &mut Write<'_>, input: &JsonValue) -> Result<(), Error> {
    let value = document(Kind::Segment, input).map_err(|error| tx.reject(error))?;
    let id = text(&value, "id")?.clone();
    let mut original_text = text(&value, "text")?.clone();
    if let Some(existing) = tx.get::<SegmentTable>(&key(&id))? {
        let mut replay = parse(Kind::Segment, &existing.data)?;
        let promoted = existing.state.as_str() == Some("temporary")
            && text(&value, "state")?.as_str() == Some("final");
        set(
            &mut replay,
            "text",
            JsonValue::String(existing.original_text.clone()),
        )?;
        if promoted {
            set(&mut replay, "state", JsonValue::String("final".into()))?
        }
        if stringify_json(&replay) != stringify_json(&value) {
            return Err(tx.reject(Error::Rejected("changed segment replay or raw text")));
        }
        if !promoted {
            return Ok(());
        }
        original_text = existing.original_text;
    }
    let meeting_id = text(&value, "meetingID")?.clone();
    let sequence = number(&value, "sequence")? as i64;
    let state = text(&value, "state")?.clone();
    if state.as_str() == Some("final") && sequence < next_sequence_tx(tx, &meeting_id)? {
        return Err(tx.reject(Error::Rejected(
            "final segment sequence must be unique and monotonic",
        )));
    }
    SegmentTable::put(
        tx,
        &Segment {
            id,
            meeting_id,
            sequence,
            state,
            original_text,
            data: stringify_json(&value).into(),
        },
    )
}

pub fn next_sequence(snapshot: &Snapshot, meeting_id: &LosslessString) -> Result<i64, Error> {
    let prefix = key(meeting_id);
    let values = snapshot.index_range::<SegmentTable>(
        "final_sequence",
        IndexQuery {
            lower: Bound::Unbounded,
            upper: Bound::Unbounded,
            prefix: Some(&prefix),
            order: IndexOrder::Descending,
            after: None,
            limit: 1,
        },
    )?;
    Ok(values.first().map_or(0, |value| value.record.sequence) + 1)
}

pub fn next_sequence_tx(tx: &mut Write<'_>, meeting_id: &LosslessString) -> Result<i64, Error> {
    let prefix = key(meeting_id);
    let values = tx.index_range::<SegmentTable>(
        "final_sequence",
        IndexQuery {
            lower: Bound::Unbounded,
            upper: Bound::Unbounded,
            prefix: Some(&prefix),
            order: IndexOrder::Descending,
            after: None,
            limit: 1,
        },
    )?;
    Ok(values.first().map_or(0, |value| value.record.sequence) + 1)
}

pub fn segments(
    snapshot: &Snapshot,
    meeting_id: &LosslessString,
    after: i64,
    limit: u64,
) -> Result<Vec<JsonValue>, Error> {
    if !(-1..=9_007_199_254_740_991).contains(&after) {
        return Err(Error::Rejected("invalid segment cursor"));
    }
    result_limit(limit)?;
    let prefix = key(meeting_id);
    let lower = tuple_key(&[KeyPart::String(meeting_id), KeyPart::I64(after)]);
    let mut cursor = None;
    let mut rows = Vec::new();
    let wanted = limit.min(usize::MAX as u64) as usize;
    loop {
        let page = snapshot.index_range::<SegmentTable>(
            "segment_order",
            IndexQuery {
                lower: Bound::Excluded(&lower),
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: cursor.as_ref(),
                limit: if wanted == 0 { 0 } else { 128 },
            },
        )?;
        if page.is_empty() {
            break;
        }
        cursor = page.last().map(|entry| entry.cursor.clone());
        rows.extend(page.into_iter().map(|entry| entry.record));
        if rows.len() >= wanted
            && rows
                .last()
                .is_some_and(|last| last.sequence > rows[wanted - 1].sequence)
        {
            break;
        }
    }
    rows.sort_by(|a, b| {
        a.sequence
            .cmp(&b.sequence)
            .then_with(|| binary(&a.id).cmp(&binary(&b.id)))
    });
    rows.truncate(wanted);
    rows.into_iter()
        .map(|row| parse(Kind::Segment, &row.data))
        .collect()
}

pub fn correct_segment(
    tx: &mut Write<'_>,
    id: &LosslessString,
    correction: &LosslessString,
) -> Result<(), Error> {
    let mut row = tx
        .get::<SegmentTable>(&key(id))?
        .ok_or_else(|| tx.reject(Error::Rejected("unknown segment")))?;
    let mut value = parse(Kind::Segment, &row.data)?;
    set(&mut value, "text", JsonValue::String(correction.clone()))?;
    row.data = stringify_json(&value).into();
    SegmentTable::put(tx, &row)
}

macro_rules! child_operations {
    ($read:ident, $put:ident, $table:ident) => {
        pub fn $read(
            snapshot: &Snapshot,
            meeting_id: &LosslessString,
        ) -> Result<Vec<JsonValue>, Error> {
            children::<$table>(snapshot, meeting_id)
        }
        pub fn $put(tx: &mut Write<'_>, value: &JsonValue) -> Result<(), Error> {
            write_child::<$table>(tx, value)
        }
    };
}
child_operations!(findings, put_finding, FindingTable);
child_operations!(checkpoints, put_checkpoint, CheckpointTable);
child_operations!(proposals, put_proposal, ProposalTable);
child_operations!(approvals, put_approval, ApprovalTable);
child_operations!(jobs, put_job, JobTable);

pub fn plan(snapshot: &Snapshot, meeting_id: &LosslessString) -> Result<Option<JsonValue>, Error> {
    Ok(children::<PlanTable>(snapshot, meeting_id)?
        .into_iter()
        .next())
}
pub fn put_plan(tx: &mut Write<'_>, value: &JsonValue) -> Result<(), Error> {
    write_child::<PlanTable>(tx, value)
}

pub fn references(
    snapshot: &Snapshot,
    meeting_id: &LosslessString,
) -> Result<Vec<JsonValue>, Error> {
    let prefix = key(meeting_id);
    let mut after = None;
    let mut values = Vec::new();
    loop {
        let page = snapshot.scan::<ReferenceTable>(
            after
                .as_deref()
                .map_or(Bound::Included(prefix.as_slice()), Bound::Excluded),
            Bound::Unbounded,
            128,
        )?;
        let finished = page.len() < 128 || page.iter().any(|row| &row.meeting_id != meeting_id);
        after = page.last().map(ReferenceTable::primary_key);
        values.extend(
            page.into_iter()
                .take_while(|row| &row.meeting_id == meeting_id),
        );
        if finished {
            break;
        }
    }
    values.sort_by(|a, b| {
        binary(&a.server)
            .cmp(&binary(&b.server))
            .then_with(|| binary(&a.target).cmp(&binary(&b.target)))
    });
    values
        .into_iter()
        .map(|row| parse(Kind::Reference, &row.data))
        .collect()
}

pub fn put_reference(
    tx: &mut Write<'_>,
    meeting_id: &LosslessString,
    input: &JsonValue,
) -> Result<(), Error> {
    let value = document(Kind::Reference, input).map_err(|error| tx.reject(error))?;
    ReferenceTable::put(
        tx,
        &Reference {
            meeting_id: meeting_id.clone(),
            server: text(&value, "server")?.clone(),
            target: text(&value, "target")?.clone(),
            data: stringify_json(&value).into(),
        },
    )
}

pub fn delete_meeting(tx: &mut Write<'_>, id: &LosslessString) -> Result<bool, Error> {
    let prefix = key(id);
    loop {
        let rows = tx.index_range::<SegmentTable>(
            "segment_order",
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
            tx.delete::<SegmentTable>(&key(&row.record.id))?;
        }
    }
    loop {
        let rows = tx
            .scan::<ReferenceTable>(Bound::Included(&prefix), Bound::Unbounded, 128)?
            .into_iter()
            .take_while(|row| &row.meeting_id == id)
            .collect::<Vec<_>>();
        if rows.is_empty() {
            break;
        }
        for row in rows {
            tx.delete::<ReferenceTable>(&ReferenceTable::primary_key(&row))?;
        }
    }
    delete_children::<FindingTable>(tx, id)?;
    delete_children::<CheckpointTable>(tx, id)?;
    delete_children::<ProposalTable>(tx, id)?;
    delete_children::<PlanTable>(tx, id)?;
    delete_children::<ApprovalTable>(tx, id)?;
    delete_children::<JobTable>(tx, id)?;
    tx.delete::<MeetingTable>(&key(id))
}

pub fn retain(tx: &mut Write<'_>, days: f64, now_ms: i64) -> Result<(), Error> {
    if !days.is_finite() || days < 0.0 {
        return Err(tx.reject(Error::Rejected("invalid retention days")));
    }
    let millis = (now_ms as f64 - days * 86_400_000.0).trunc();
    if !millis.is_finite() || millis.abs() > 8_640_000_000_000_000.0 {
        return Err(tx.reject(Error::Rejected("invalid retention date")));
    }
    let cutoff = LosslessString::from(iso_date(millis as i64));
    for row in scan_tx::<MeetingTable>(tx)? {
        let value = parse(Kind::Meeting, &row.data)?;
        if text(&value, "updatedAt")? >= &cutoff
            || matches!(
                text(&value, "status")?.as_str(),
                Some("recording" | "stopping")
            )
        {
            continue;
        }
        delete_meeting(tx, &row.id)?;
    }
    Ok(())
}

pub fn recover(tx: &mut Write<'_>, now: &str) -> Result<(), Error> {
    if !document::timestamp(now) {
        return Err(tx.reject(document::invalid()));
    }
    for row in scan_tx::<MeetingTable>(tx)? {
        let value = parse(Kind::Meeting, &row.data)?;
        if matches!(
            text(&value, "status")?.as_str(),
            Some("recording" | "stopping")
        ) {
            let detail = field(&value, "error")
                .ok()
                .and_then(|value| {
                    if let JsonValue::String(value) = value {
                        Some(value)
                    } else {
                        None
                    }
                })
                .filter(|value| !value.is_empty());
            let mut units = detail
                .map(|value| {
                    value
                        .code_units()
                        .chain("; ".encode_utf16())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            units.extend(
                "Capture interrupted; volatile raw audio is unavailable after restart"
                    .encode_utf16(),
            );
            let mut patch = JsonObject::new();
            patch.insert("status".into(), JsonValue::String("interrupted".into()));
            patch.insert(
                "error".into(),
                JsonValue::String(LosslessString::from_utf16(units)),
            );
            update_meeting(tx, &row.id, &JsonValue::Object(patch), now)?;
        }
        for job in children_tx::<JobTable>(tx, &row.id)? {
            let mut value = parse(Kind::Job, &job.data)?;
            if text(&value, "status")?.as_str() != Some("running") {
                continue;
            }
            set(
                &mut value,
                "status",
                JsonValue::String("interrupted".into()),
            )?;
            set(&mut value, "updatedAt", JsonValue::String(now.into()))?;
            set(
                &mut value,
                "error",
                JsonValue::String("Processing interrupted by restart".into()),
            )?;
            put_job(tx, &value)?;
        }
        for proposal in children_tx::<ProposalTable>(tx, &row.id)? {
            let mut value = parse(Kind::Proposal, &proposal.data)?;
            if text(&value, "status")?.as_str() != Some("applying") {
                continue;
            }
            set(&mut value, "status", JsonValue::String("uncertain".into()))?;
            set(
                &mut value,
                "error",
                JsonValue::String("External write outcome must be checked before retry".into()),
            )?;
            put_proposal(tx, &value)?;
        }
    }
    Ok(())
}

fn write_child<T: ChildTable>(tx: &mut Write<'_>, input: &JsonValue) -> Result<(), Error> {
    let value = document(T::KIND, input).map_err(|error| tx.reject(error))?;
    let meeting_id = text(&value, "meetingID")?.clone();
    let id = text(
        &value,
        if matches!(T::KIND, Kind::Plan) {
            "meetingID"
        } else {
            "id"
        },
    )?
    .clone();
    let data = LosslessString::from(stringify_json(&value));
    let existing = tx.get::<T>(&key(&id))?;
    if existing
        .as_ref()
        .is_some_and(|row| row.meeting_id != meeting_id)
    {
        return Err(tx.reject(Error::Rejected("record id belongs to another meeting")));
    }
    if matches!(T::KIND, Kind::Approval) && existing.as_ref().is_some_and(|row| row.data != data) {
        return Err(tx.reject(Error::Rejected("approval history cannot change on replay")));
    }
    let position = match existing {
        Some(row) => row.position,
        None => {
            let rows = scan_tx::<T>(tx)?;
            match rows
                .iter()
                .map(|row| row.position)
                .max()
                .unwrap_or(0)
                .checked_add(1)
            {
                Some(position) => position,
                None => {
                    let random = RandomState::new();
                    (0..100)
                        .map(|attempt| (random.hash_one((&id, attempt)) & i64::MAX as u64) as i64)
                        .find(|position| {
                            *position > 0 && !rows.iter().any(|row| row.position == *position)
                        })
                        .ok_or_else(|| tx.reject(Error::Rejected("record order exhausted")))?
                }
            }
        }
    };
    require::<MeetingTable>(tx, &key(&meeting_id))?;
    tx.put::<T>(&Record {
        id,
        meeting_id,
        position,
        data,
    })
}

fn children<T: ChildTable>(
    snapshot: &Snapshot,
    meeting_id: &LosslessString,
) -> Result<Vec<JsonValue>, Error> {
    let mut after = None;
    let mut values = Vec::new();
    loop {
        let page =
            snapshot.index::<T>(T::INDEXES[0].name, &key(meeting_id), after.as_deref(), 128)?;
        if page.is_empty() {
            break;
        }
        after = page.last().map(T::primary_key);
        values.extend(page);
    }
    values.sort_by_key(|row| row.position);
    values
        .into_iter()
        .map(|row| parse(T::KIND, &row.data))
        .collect()
}

fn delete_children<T: ChildTable>(
    tx: &mut Write<'_>,
    meeting_id: &LosslessString,
) -> Result<(), Error> {
    loop {
        let rows = tx.index::<T>(T::INDEXES[0].name, &key(meeting_id), None, 128)?;
        if rows.is_empty() {
            return Ok(());
        }
        for row in rows {
            tx.delete::<T>(&T::primary_key(&row))?;
        }
    }
}

fn children_tx<T: ChildTable>(
    tx: &mut Write<'_>,
    meeting_id: &LosslessString,
) -> Result<Vec<Record>, Error> {
    let mut after = None;
    let mut values = Vec::new();
    loop {
        let page = tx.index::<T>(T::INDEXES[0].name, &key(meeting_id), after.as_deref(), 128)?;
        if page.is_empty() {
            return Ok(values);
        }
        after = page.last().map(T::primary_key);
        values.extend(page);
    }
}

fn scan<T: TableSpec>(snapshot: &Snapshot) -> Result<Vec<T::Record>, Error> {
    let mut after = None;
    let mut values = Vec::new();
    loop {
        let page = snapshot.scan::<T>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            128,
        )?;
        if page.is_empty() {
            return Ok(values);
        }
        after = page.last().map(T::primary_key);
        values.extend(page);
    }
}

fn scan_tx<T: TableSpec>(tx: &mut Write<'_>) -> Result<Vec<T::Record>, Error> {
    let mut after = None;
    let mut values = Vec::new();
    loop {
        let page = tx.scan::<T>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            128,
        )?;
        if page.is_empty() {
            return Ok(values);
        }
        after = page.last().map(T::primary_key);
        values.extend(page);
    }
}

fn result_limit(value: u64) -> Result<(), Error> {
    if value > 9_007_199_254_740_991 {
        return Err(Error::Rejected("invalid result limit"));
    }
    Ok(())
}

fn binary(value: &LosslessString) -> Vec<u8> {
    value
        .as_str()
        .expect("validated Meeting relational identity")
        .as_bytes()
        .to_vec()
}

fn sqlite_lower(value: &LosslessString) -> Vec<u16> {
    value
        .code_units()
        .map(|unit| {
            if (65..=90).contains(&unit) {
                unit + 32
            } else {
                unit
            }
        })
        .collect()
}

fn iso_date(millis: i64) -> String {
    let days = millis.div_euclid(86_400_000) + 719468;
    let era = days.div_euclid(146097);
    let day = days - era * 146097;
    let year = (day - day / 1460 + day / 36524 - day / 146096) / 365;
    let ordinal = day - (365 * year + year / 4 - year / 100);
    let month = (5 * ordinal + 2) / 153;
    let date = ordinal - (153 * month + 2) / 5 + 1;
    let month = month + if month < 10 { 3 } else { -9 };
    let year = year + era * 400 + i64::from(month <= 2);
    let time = millis.rem_euclid(86_400_000);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    format!(
        "{year}-{month:02}-{date:02}T{:02}:{:02}:{:02}.{:03}Z",
        time / 3_600_000,
        time / 60_000 % 60,
        time / 1000 % 60,
        time % 1000
    )
}
