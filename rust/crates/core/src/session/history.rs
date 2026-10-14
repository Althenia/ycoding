use super::{
    history_pruning::{Floor, checkpoint_message, retained_floor},
    info, key,
    model_history::Plan,
    store::Service,
};
use std::ops::{Bound, RangeBounds};
use ycoding_schema::{
    DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder, session, session_message,
};
use ycoding_store::{
    Error, IndexCursor, IndexEntry, IndexOrder, IndexQuery, KeyPart, Snapshot,
    session::{self as tables, EventTable, Message, MessageTable, SessionTable},
    tuple_key,
};

const OBSERVATION_PAGE: usize = 100;
const OBSERVATION_SOURCES: usize = 3;

#[derive(Clone, Debug, PartialEq)]
pub struct Window {
    pub messages: Vec<session_message::Info>,
    pub before: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub seq: i64,
    pub message: session_message::Info,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SessionSnapshot {
    pub session: session::Info,
    pub messages: Vec<session_message::Info>,
    pub before: Option<String>,
    pub watermark: Option<i64>,
    pub generation_speed: Option<ycoding_schema::session_cache_diagnostics::GenerationSpeedHistory>,
}

impl Service {
    pub fn snapshot(
        &self,
        id: &session::Id,
        limit: usize,
        before: Option<&str>,
    ) -> Result<SessionSnapshot, Error> {
        let snapshot = self.client.snapshot()?;
        let row = snapshot
            .get::<SessionTable>(&key(id.as_lossless()))?
            .ok_or(Error::Domain {
                kind: "not_found",
                message: "Session not found",
            })?;
        let window = window(
            &snapshot,
            id,
            limit,
            before.map(|value| cursor(id, value)).transpose()?,
        )?;
        let sequence = tables::latest_sequence(&snapshot, id.as_lossless())?;
        let session = info::from_row(&row)?;
        Ok(SessionSnapshot {
            generation_speed: if super::diagnostics::has_measured_assistant(
                &window.messages,
                session.revert.as_ref().map(|revert| &revert.message_id),
            )? {
                super::diagnostics::generation_speed(&super::provider_request::recent_steps_in(
                    &snapshot, id,
                )?)
            } else {
                None
            },
            session,
            messages: window.messages,
            before: window.before,
            watermark: (sequence >= 0).then_some(sequence),
        })
    }

    pub fn context(&self, id: &session::Id) -> Result<Vec<session_message::Info>, Error> {
        load(&self.client.snapshot()?, id)
    }

    pub fn transcript(&self, id: &session::Id) -> Result<Vec<session_message::Info>, Error> {
        transcript(&self.client.snapshot()?, id)
    }

    pub fn latest(
        &self,
        id: &session::Id,
        type_: &str,
    ) -> Result<Option<session_message::Info>, Error> {
        latest(&self.client.snapshot()?, id, type_)
    }

    pub fn recent(
        &self,
        id: &session::Id,
        limit: usize,
    ) -> Result<Vec<session_message::Info>, Error> {
        recent(&self.client.snapshot()?, id, limit)
    }

    pub fn unsettled_tool_messages(
        &self,
        id: &session::Id,
    ) -> Result<Vec<session_message::Info>, Error> {
        unsettled_tool_messages(&self.client.snapshot()?, id)
    }

    pub fn observation_state(&self, id: &session::Id) -> Result<ObservationState, Error> {
        observation_state(&self.client.snapshot()?, id)
    }
}

pub fn latest_compaction(snapshot: &Snapshot, id: &session::Id) -> Result<Option<i64>, Error> {
    let prefix = tuple_key(&[
        KeyPart::String(id.as_lossless()),
        KeyPart::String(&"compaction".into()),
    ]);
    let mut after = None;
    loop {
        let rows = snapshot.index_range::<MessageTable>(
            "session_message_session_type_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Descending,
                after: after.as_ref(),
                limit: 128,
            },
        )?;
        if let Some(row) = rows.iter().find(|row| matches!(&row.record.data, JsonValue::Object(data) if data.get(&"status".into()) == Some(&JsonValue::String("completed".into())) && matches!(data.get(&"reason".into()), Some(JsonValue::String(_))) && matches!(data.get(&"summary".into()), Some(JsonValue::String(_))))) { return Ok(Some(row.record.seq)) }
        if rows.is_empty() {
            return Ok(None);
        }
        after = rows.last().map(|row| row.cursor.clone());
    }
}

pub fn load(snapshot: &Snapshot, id: &session::Id) -> Result<Vec<session_message::Info>, Error> {
    entries(snapshot, id).map(|entries| entries.into_iter().map(|entry| entry.message).collect())
}

pub fn entries(snapshot: &Snapshot, id: &session::Id) -> Result<Vec<Entry>, Error> {
    entries_after(snapshot, id, None)
}

/// Reads only rows with a sequence above `after`, so covered payloads stay undecoded.
pub(crate) fn entries_after(
    snapshot: &Snapshot,
    id: &session::Id,
    after: Option<i64>,
) -> Result<Vec<Entry>, Error> {
    let lower = lower_bound(snapshot, id, after)?;
    let mut after = None;
    let mut messages = Vec::new();
    loop {
        let rows = tables::messages(
            snapshot,
            id.as_lossless(),
            lower,
            Bound::Unbounded,
            IndexOrder::Ascending,
            after.as_ref(),
            128,
        )?;
        if rows.is_empty() {
            return Ok(messages);
        }
        after = rows.last().map(|row| row.cursor.clone());
        messages.extend(
            rows.iter()
                .map(|row| {
                    Ok(Entry {
                        seq: row.record.seq,
                        message: row.record.info()?,
                    })
                })
                .collect::<Result<Vec<_>, Error>>()?,
        );
    }
}

pub fn transcript(
    snapshot: &Snapshot,
    id: &session::Id,
) -> Result<Vec<session_message::Info>, Error> {
    let floor = retained_floor(snapshot, id)?;
    let mut entries = Vec::new();
    let mut after = None;
    loop {
        let rows = tables::messages(
            snapshot,
            id.as_lossless(),
            floor.lower,
            Bound::Unbounded,
            IndexOrder::Ascending,
            after.as_ref(),
            128,
        )?;
        let Some(last) = rows.last() else {
            break;
        };
        after = Some(last.cursor.clone());
        for row in rows {
            entries.push(Entry {
                seq: row.record.seq,
                message: row.record.info()?,
            });
        }
    }
    merge(entries, retained_notices(snapshot, id, &floor)?)
}

fn retained_notices(
    snapshot: &Snapshot,
    id: &session::Id,
    floor: &Floor,
) -> Result<Vec<Entry>, Error> {
    let mut notices = floor
        .checkpoint
        .as_ref()
        .map(checkpoint_message)
        .transpose()?
        .into_iter()
        .collect::<Vec<_>>();
    notices.extend(
        super::instruction_state::notices(snapshot, id)?
            .into_iter()
            .filter(|notice| (floor.lower, Bound::Unbounded).contains(&notice.seq)),
    );
    Ok(notices)
}

fn merge(
    mut entries: Vec<Entry>,
    notices: Vec<Entry>,
) -> Result<Vec<session_message::Info>, Error> {
    let ids = entries
        .iter()
        .map(|entry| message_id(&entry.message))
        .collect::<Result<std::collections::BTreeSet<_>, _>>()?;
    for notice in notices {
        if !ids.contains(&message_id(&notice.message)?) {
            entries.push(notice);
        }
    }
    entries.sort_by_key(|entry| entry.seq);
    Ok(entries.into_iter().map(|entry| entry.message).collect())
}

pub(super) fn message_id(message: &session_message::Info) -> Result<session_message::Id, Error> {
    let value = message.encode();
    ObjectDecoder::new(&value, &JsonPath::default())
        .map_err(super::projector::record_error)?
        .field("id")
        .map_err(super::projector::record_error)
}

pub fn window(
    snapshot: &Snapshot,
    id: &session::Id,
    limit: usize,
    before: Option<i64>,
) -> Result<Window, Error> {
    if !(1..=200).contains(&limit) {
        return Err(invalid_cursor());
    }
    let floor = retained_floor(snapshot, id)?;
    let rows = tables::messages(
        snapshot,
        id.as_lossless(),
        floor.lower,
        before.map_or(Bound::Unbounded, Bound::Excluded),
        IndexOrder::Descending,
        None,
        limit + 1,
    )?;
    let returned = &rows[..rows.len().min(limit)];
    let oldest = returned.last().map(|row| row.record.seq);
    let notices = retained_notices(snapshot, id, &floor)?
        .into_iter()
        .filter(|notice| {
            before.is_none_or(|before| notice.seq < before)
                && oldest.is_none_or(|oldest| notice.seq >= oldest || rows.len() <= limit)
        })
        .collect();
    Ok(Window {
        messages: merge(
            returned
                .iter()
                .rev()
                .map(|row| {
                    Ok(Entry {
                        seq: row.record.seq,
                        message: row.record.info()?,
                    })
                })
                .collect::<Result<Vec<_>, Error>>()?,
            notices,
        )?,
        before: (rows.len() > limit).then(|| {
            encode_cursor(
                id,
                returned.last().expect("nonempty limited window").record.seq,
            )
        }),
    })
}

fn owner(id: &session::Id) -> String {
    let utf8 = String::from_utf16_lossy(&id.as_lossless().code_units().collect::<Vec<_>>());
    ring::digest::digest(&ring::digest::SHA256, utf8.as_bytes()).as_ref()[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn encode_cursor(id: &session::Id, sequence: i64) -> String {
    encode_base64(format!("{}:{sequence}", owner(id)).as_bytes())
}

pub fn cursor(id: &session::Id, value: &str) -> Result<i64, Error> {
    if value.is_empty()
        || value.len() > 256
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(invalid_cursor());
    }
    let mut accumulator = 0u32;
    let mut bits = 0;
    let mut bytes = Vec::new();
    for byte in value.bytes() {
        let index = ALPHABET
            .iter()
            .position(|item| *item == byte)
            .ok_or_else(invalid_cursor)? as u32;
        accumulator = (accumulator << 6) | index;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((accumulator >> bits) as u8);
        }
    }
    if encode_base64(&bytes) != value {
        return Err(invalid_cursor());
    }
    let decoded = std::str::from_utf8(&bytes).map_err(|_| invalid_cursor())?;
    let (expected_owner, sequence) = decoded.split_once(':').ok_or_else(invalid_cursor)?;
    if expected_owner != owner(id)
        || sequence.is_empty()
        || (sequence.len() > 1 && sequence.starts_with('0'))
        || !sequence.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(invalid_cursor());
    }
    let sequence: i64 = sequence.parse().map_err(|_| invalid_cursor())?;
    if sequence > 9_007_199_254_740_991 {
        return Err(invalid_cursor());
    }
    Ok(sequence)
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn encode_base64(bytes: &[u8]) -> String {
    let mut output = String::new();
    let mut accumulator = 0u32;
    let mut bits = 0;
    for byte in bytes {
        accumulator = (accumulator << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            output.push(ALPHABET[((accumulator >> bits) & 63) as usize] as char);
        }
    }
    if bits > 0 {
        output.push(ALPHABET[((accumulator << (6 - bits)) & 63) as usize] as char);
    }
    output
}

fn invalid_cursor() -> Error {
    Error::Domain {
        kind: "invalid_cursor",
        message: "invalid Session history cursor or window limit",
    }
}

/// First sequence a read may touch: the completed legacy checkpoint, or just past `after`.
pub(crate) fn lower_bound(
    snapshot: &Snapshot,
    id: &session::Id,
    after: Option<i64>,
) -> Result<Bound<i64>, Error> {
    let floor = latest_compaction(snapshot, id)?;
    Ok(floor
        .into_iter()
        .chain(after.map(|after| after + 1))
        .max()
        .map_or(Bound::Unbounded, Bound::Included))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn type_rows(
    snapshot: &Snapshot,
    id: &session::Id,
    type_: &str,
    lower: Bound<i64>,
    upper: Bound<i64>,
    order: IndexOrder,
    after: Option<&IndexCursor>,
    limit: usize,
) -> Result<Vec<IndexEntry<Message>>, Error> {
    let type_ = LosslessString::from(type_);
    let prefix = tuple_key(&[KeyPart::String(id.as_lossless()), KeyPart::String(&type_)]);
    let bound = |bound: Bound<i64>| {
        bound.map(|seq| {
            tuple_key(&[
                KeyPart::String(id.as_lossless()),
                KeyPart::String(&type_),
                KeyPart::I64(seq),
            ])
        })
    };
    let (lower, upper) = (bound(lower), bound(upper));
    snapshot.index_range::<MessageTable>(
        "session_message_session_type_seq_idx",
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

pub fn latest(
    snapshot: &Snapshot,
    id: &session::Id,
    type_: &str,
) -> Result<Option<session_message::Info>, Error> {
    let lower = retained_floor(snapshot, id)?.lower;
    type_rows(
        snapshot,
        id,
        type_,
        lower,
        Bound::Unbounded,
        IndexOrder::Descending,
        None,
        1,
    )?
    .first()
    .map(|row| row.record.info())
    .transpose()
}

pub fn recent(
    snapshot: &Snapshot,
    id: &session::Id,
    limit: usize,
) -> Result<Vec<session_message::Info>, Error> {
    let lower = retained_floor(snapshot, id)?.lower;
    tables::messages(
        snapshot,
        id.as_lossless(),
        lower,
        Bound::Unbounded,
        IndexOrder::Descending,
        None,
        limit,
    )?
    .iter()
    .rev()
    .map(|row| row.record.info())
    .collect()
}

pub fn unsettled_tool_messages(
    snapshot: &Snapshot,
    id: &session::Id,
) -> Result<Vec<session_message::Info>, Error> {
    let lower = retained_floor(snapshot, id)?.lower;
    let mut after = None;
    let mut unsettled = Vec::new();
    loop {
        let rows = type_rows(
            snapshot,
            id,
            "assistant",
            lower,
            Bound::Unbounded,
            IndexOrder::Ascending,
            after.as_ref(),
            128,
        )?;
        if rows.is_empty() {
            return Ok(unsettled);
        }
        after = rows.last().map(|row| row.cursor.clone());
        for row in rows
            .iter()
            .filter(|row| has_unsettled_tool(&row.record.data))
        {
            unsettled.push(row.record.info()?);
        }
    }
}

fn has_unsettled_tool(data: &JsonValue) -> bool {
    let JsonValue::Object(data) = data else {
        return false;
    };
    let Some(JsonValue::Array(content)) = data.get(&"content".into()) else {
        return false;
    };
    content.iter().any(|part| {
        let JsonValue::Object(part) = part else {
            return false;
        };
        part.get(&"type".into()) == Some(&JsonValue::String("tool".into()))
            && matches!(
                part.get(&"state".into()),
                Some(JsonValue::Object(state))
                    if matches!(state.get(&"status".into()), Some(JsonValue::String(status))
                        if matches!(status.as_str(), Some("streaming" | "running")))
            )
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    SessionState,
    TeamView,
    StepLimit,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SessionState => "session-state",
            Self::TeamView => "team-view",
            Self::StepLimit => "step-limit",
        }
    }

    fn parse(value: &JsonValue) -> Option<Self> {
        match value {
            JsonValue::String(value) => match value.as_str()? {
                "session-state" => Some(Self::SessionState),
                "team-view" => Some(Self::TeamView),
                "step-limit" => Some(Self::StepLimit),
                _ => None,
            },
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ObservationState {
    pub latest: Vec<(Source, LosslessString)>,
    pub present: Vec<Source>,
}

impl ObservationState {
    pub fn text(&self, source: Source) -> Option<&LosslessString> {
        self.latest
            .iter()
            .find(|(candidate, _)| *candidate == source)
            .map(|(_, text)| text)
    }

    pub fn has(&self, source: Source) -> bool {
        self.present.contains(&source)
    }
}

/// Newest trusted text per observation source, found by paging observation-bearing
/// rows newest-first through the model-visible window instead of loading history.
pub fn observation_state(snapshot: &Snapshot, id: &session::Id) -> Result<ObservationState, Error> {
    let plan = Plan::read(snapshot, id)?;
    let lower = lower_bound(snapshot, id, plan.floor())?;
    let mut state = ObservationState::default();
    let mut before = None;
    while state.latest.len() < OBSERVATION_SOURCES {
        let upper = before.map_or(Bound::Unbounded, Bound::Excluded);
        let mut rows = Vec::new();
        let mut full = false;
        for type_ in ["system", "synthetic"] {
            let page = type_rows(
                snapshot,
                id,
                type_,
                lower,
                upper,
                IndexOrder::Descending,
                None,
                OBSERVATION_PAGE,
            )?;
            full |= page.len() == OBSERVATION_PAGE;
            rows.extend(page.into_iter().map(|row| row.record));
        }
        rows.sort_by_key(|row| std::cmp::Reverse(row.seq));
        let exhausted = !full && rows.len() <= OBSERVATION_PAGE;
        rows.truncate(OBSERVATION_PAGE);
        before = rows.last().map(|row| row.seq);
        let selected = rows
            .iter()
            .filter(|row| observation_source(&row.data).is_some())
            .map(|row| {
                Ok(Entry {
                    seq: row.seq,
                    message: row.info()?,
                })
            })
            .collect::<Result<Vec<_>, Error>>()?;
        let mut visible = plan.visible(selected);
        visible.sort_by_key(|entry| std::cmp::Reverse(entry.seq));
        for entry in &visible {
            let Some((source, id_, text)) = candidate(&entry.message) else {
                continue;
            };
            if !state.present.contains(&source) {
                state.present.push(source);
            }
            if state.text(source).is_none() && trusted(snapshot, id, id_, source, text)? {
                state.latest.push((source, text.clone()));
            }
        }
        if exhausted {
            break;
        }
    }
    Ok(state)
}

fn observation_source(data: &JsonValue) -> Option<Source> {
    let JsonValue::Object(data) = data else {
        return None;
    };
    let Some(JsonValue::Object(metadata)) = data.get(&"metadata".into()) else {
        return None;
    };
    Source::parse(metadata.get(&"contextSource".into())?)
}

fn candidate(
    message: &session_message::Info,
) -> Option<(Source, &session_message::Id, &LosslessString)> {
    let (metadata, id, text, description) = match message {
        session_message::Info::System(message) => {
            (&message.metadata, &message.id, &message.text, None)
        }
        session_message::Info::Synthetic(message) => (
            &message.metadata,
            &message.id,
            &message.text,
            message.description.as_ref(),
        ),
        _ => return None,
    };
    let source = Source::parse(metadata.as_ref()?.get(&"contextSource".into())?)?;
    let team = source == Source::TeamView;
    let is_synthetic = matches!(message, session_message::Info::Synthetic(_));
    if team != is_synthetic {
        return None;
    }
    if team && description.and_then(|value| value.as_str()) != Some("TeamView update") {
        return None;
    }
    Some((source, id, text))
}

fn trusted(
    snapshot: &Snapshot,
    session: &session::Id,
    message: &session_message::Id,
    source: Source,
    text: &LosslessString,
) -> Result<bool, Error> {
    let Some(suffix) = message
        .as_lossless()
        .to_utf8()
        .ok()
        .and_then(|id| id.strip_prefix("msg_").map(str::to_owned))
    else {
        return Ok(false);
    };
    let Some(event) = snapshot.get::<EventTable>(&key(&format!("evt_{suffix}").into()))? else {
        return Ok(false);
    };
    let JsonValue::Object(data) = &event.data else {
        return Ok(false);
    };
    Ok(event.aggregate_id == *session.as_lossless()
        && event.type_.as_str() == Some("session.context.observed.1")
        && data.get(&"source".into()) == Some(&JsonValue::String(source.as_str().into()))
        && data.get(&"text".into()) == Some(&JsonValue::String(text.clone())))
}
