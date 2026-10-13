use super::{
    info, key,
    projector::{append, random_event_id, record_error},
    store::Service,
};
use std::ops::Bound;
use ycoding_schema::{LosslessString, ObjectDecoder, ObjectEncoder, session, session_message};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, KeyPart, Write,
    session::{
        self as tables, ContextState, ContextStateTable, Event, MessageTable, NewEvent,
        PendingTable, Revision, RevisionTable, SessionTable,
    },
    tuple_key,
};

impl Service {
    pub async fn fork(
        &self,
        parent: &session::Id,
        boundary: Option<session_message::Id>,
    ) -> Result<session::Info, Error> {
        let parent = parent.clone();
        let event_id = random_event_id()?;
        let id = session::Id::new(format!(
            "ses_{}",
            event_id
                .as_lossless()
                .as_str()
                .ok_or(Error::Rejected("invalid generated event ID"))?
                .trim_start_matches("evt_")
        ))
        .map_err(record_error)?;
        self.client
            .submit(move |tx| {
                let row =
                    tx.get::<SessionTable>(&key(parent.as_lossless()))?
                        .ok_or(Error::Domain {
                            kind: "not_found",
                            message: "Session not found",
                        })?;
                let through = match &boundary {
                    Some(boundary) => {
                        tx.get::<MessageTable>(&key(boundary.as_lossless()))?
                            .filter(|message| &message.session_id == parent.as_lossless())
                            .ok_or(Error::Domain {
                                kind: "message_not_found",
                                message: "Message not found",
                            })?
                            .seq
                            - 1
                    }
                    None => tx
                        .get::<tables::SequenceTable>(&key(parent.as_lossless()))?
                        .map_or(-1, |row| row.seq),
                };
                let now = chrono::Utc::now().timestamp_millis();
                append(
                    tx,
                    &NewEvent {
                        id: event_id.as_lossless().clone(),
                        aggregate_id: id.as_lossless().clone(),
                        created: now,
                        type_: "session.forked.2".into(),
                        data: ObjectEncoder::new()
                            .field("sessionID", &id)
                            .field("parentID", &parent)
                            .field("parentSeq", &(through as f64))
                            .optional("from", &boundary)
                            .finish(),
                    },
                )?;
                if let Some(binding) = row.profile_binding {
                    append(
                        tx,
                        &NewEvent {
                            id: random_event_id()?.as_lossless().clone(),
                            aggregate_id: id.as_lossless().clone(),
                            created: now,
                            type_: "session.profile.bound.1".into(),
                            data: ObjectEncoder::new()
                                .field("sessionID", &id)
                                .field("binding", binding.value())
                                .finish(),
                        },
                    )?;
                }
                info::from_row(
                    &tx.get::<SessionTable>(&key(id.as_lossless()))?
                        .ok_or(Error::Rejected("fork projection missing"))?,
                )
            })?
            .await
    }
}

pub(crate) fn apply(
    tx: &mut Write<'_>,
    event: &Event,
    object: &ObjectDecoder<'_>,
) -> Result<(), Error> {
    let parent: session::Id = object.field("parentID").map_err(record_error)?;
    let from: Option<session_message::Id> = object.optional("from").map_err(record_error)?;
    let parent_seq: f64 = object.field("parentSeq").map_err(record_error)?;
    let mut row = tx
        .get::<SessionTable>(&key(parent.as_lossless()))?
        .ok_or(Error::Domain {
            kind: "not_found",
            message: "Fork parent Session not found",
        })?;
    let upper = from
        .as_ref()
        .map(|id| {
            tx.get::<MessageTable>(&key(id.as_lossless()))?
                .filter(|message| &message.session_id == parent.as_lossless())
                .map(|message| message.seq)
                .ok_or(Error::Domain {
                    kind: "message_not_found",
                    message: "Fork boundary message not found",
                })
        })
        .transpose()?;
    row.id = event.aggregate_id.clone();
    row.parent_id = None;
    row.fork_session_id = Some(parent.as_lossless().clone());
    row.fork_message_id = from.map(|id| id.as_lossless().clone());
    row.fork_seq = Some(parent_seq as i64);
    row.title = title(&row.title);
    row.permission = info::from_row(&row)?
        .permission_ceiling
        .as_ref()
        .map(tables::Document::from_domain)
        .transpose()?;
    row.daybreak = None;
    row.profile_binding = None;
    row.revert = None;
    row.autonomy = None;
    row.autonomy_revision = 0;
    row.orchestration_revision = 0;
    row.cost = 0.0;
    row.tokens_input = 0;
    row.tokens_output = 0;
    row.tokens_reasoning = 0;
    row.tokens_cache_read = 0;
    row.tokens_cache_write = 0;
    row.time_created = event.created;
    row.time_updated = event.created;
    row.time_active = None;
    row.time_archived = None;
    row.time_pinned = None;
    row.time_suspended = None;
    SessionTable::insert(tx, &row)?;
    let prefix = key(parent.as_lossless());
    let upper_key =
        upper.map(|seq| tuple_key(&[KeyPart::String(parent.as_lossless()), KeyPart::I64(seq)]));
    let mut after = None;
    loop {
        let page = tx.index_range::<MessageTable>(
            "session_message_session_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: upper_key
                    .as_deref()
                    .map_or(Bound::Unbounded, Bound::Excluded),
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: after.as_ref(),
                limit: 500,
            },
        )?;
        if page.is_empty() {
            break;
        }
        after = page.last().map(|entry| entry.cursor.clone());
        for entry in page {
            let mut message = entry.record;
            if message.type_.as_str() == Some("compaction")
                && super::read_json::field(&message.data, &["status"])
                    .and_then(super::read_json::text)
                    .and_then(LosslessString::as_str)
                    == Some("running")
            {
                continue;
            }
            let pending = tx.get::<PendingTable>(&key(&message.id))?;
            message.id = session_message::Id::from_event(&random_event_id()?)
                .as_lossless()
                .clone();
            message.session_id = event.aggregate_id.clone();
            MessageTable::insert(tx, &message)?;
            if let Some(mut pending) =
                pending.filter(|pending| pending.type_.as_str() != Some("compaction"))
            {
                pending.id = message.id;
                pending.session_id = event.aggregate_id.clone();
                PendingTable::insert(tx, &pending)?;
            }
        }
    }
    tables::reserve_sequence(tx, &event.aggregate_id, parent_seq as i64)?;
    RevisionTable::insert(
        tx,
        &Revision {
            session_id: event.aggregate_id.clone(),
            revision: 0,
            parent_revision: None,
            manifest_digest: None,
            covered_through_message_id: None,
            covered_through_seq: None,
            activation_event_id: None,
            activation_sequence: None,
            time_created: event.created,
        },
    )?;
    ContextStateTable::insert(
        tx,
        &ContextState {
            session_id: event.aggregate_id.clone(),
            status: "active".into(),
            revision: 0,
            manifest_digest: None,
            covered_through_message_id: None,
            covered_through_seq: None,
            activated_event_id: None,
            time_activated: None,
            error_code: None,
        },
    )?;
    super::instruction_state::apply(tx, event)
}

fn title(value: &LosslessString) -> LosslessString {
    if let Some(value) = value.as_str()
        && let Some((base, number)) = value
            .strip_suffix(')')
            .and_then(|value| value.rsplit_once(" (fork #"))
        && !base.is_empty()
        && !base.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
        && !number.is_empty()
        && number.bytes().all(|byte| byte.is_ascii_digit())
        && let Ok(number) = number.parse::<u64>()
        && let Some(next) = number.checked_add(1)
    {
        return format!("{base} (fork #{next})").into();
    }
    LosslessString::from_utf16(
        value
            .code_units()
            .chain(" (fork #1)".encode_utf16())
            .collect(),
    )
}
