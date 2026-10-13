use super::{history::Entry, key, projector::record_error, store::Service};
use std::ops::Bound;
use ycoding_schema::{JsonObject, JsonPath, ObjectDecoder, instruction, session, session_message};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, KeyPart, Snapshot, Write,
    session::{
        Document, Event, EventTable, InstructionState, InstructionStateTable, Session, SessionTable,
    },
    tuple_key,
};

const UPDATE: &str = "session.instructions.updated.2";
const RELEVANT: &[&str] = &[
    UPDATE,
    "session.compaction.ended.1",
    "session.compaction.ended.2",
    "session.moved.1",
    "session.revert.committed.1",
];

enum Reader<'a, 'b> {
    Snapshot(&'a Snapshot),
    Transaction(&'a mut Write<'b>),
}

impl Reader<'_, '_> {
    fn session(&mut self, id: &session::Id) -> Result<Option<Session>, Error> {
        match self {
            Self::Snapshot(snapshot) => snapshot.get::<SessionTable>(&key(id.as_lossless())),
            Self::Transaction(tx) => tx.get::<SessionTable>(&key(id.as_lossless())),
        }
    }

    fn events(&mut self, id: &session::Id, type_: &str) -> Result<Vec<Event>, Error> {
        let prefix = tuple_key(&[
            KeyPart::String(id.as_lossless()),
            KeyPart::String(&type_.into()),
        ]);
        let mut after = None;
        let mut events = Vec::new();
        loop {
            let query = IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: after.as_ref(),
                limit: 128,
            };
            let rows = match self {
                Self::Snapshot(snapshot) => {
                    snapshot.index_range::<EventTable>("event_aggregate_type_seq_idx", query)?
                }
                Self::Transaction(tx) => {
                    tx.index_range::<EventTable>("event_aggregate_type_seq_idx", query)?
                }
            };
            if rows.is_empty() {
                return Ok(events);
            }
            after = rows.last().map(|row| row.cursor.clone());
            events.extend(rows.into_iter().map(|row| row.record));
        }
    }
}

fn lineage(
    reader: &mut Reader<'_, '_>,
    id: &session::Id,
    through: Option<i64>,
    visited: &mut Vec<session::Id>,
) -> Result<Vec<(session::Id, Option<i64>)>, Error> {
    if visited.contains(id) {
        return Err(Error::Rejected("cyclic Session instruction lineage"));
    }
    visited.push(id.clone());
    let row = reader.session(id)?;
    let mut segments = match row.and_then(|row| row.fork_session_id.zip(row.fork_seq)) {
        Some((parent, seq)) => lineage(
            reader,
            &session::Id::new(parent).map_err(record_error)?,
            Some(through.map_or(seq, |through| through.min(seq))),
            visited,
        )?,
        None => Vec::new(),
    };
    segments.push((id.clone(), through));
    Ok(segments)
}

fn events(
    reader: &mut Reader<'_, '_>,
    id: &session::Id,
    types: &[&str],
    after: Option<i64>,
) -> Result<Vec<Event>, Error> {
    let mut events = Vec::new();
    for (id, through) in lineage(reader, id, None, &mut Vec::new())? {
        let mut rows = Vec::new();
        for type_ in types {
            rows.extend(reader.events(&id, type_)?);
        }
        rows.retain(|event| {
            through.is_none_or(|through| event.seq <= through)
                && after.is_none_or(|after| event.seq > after)
        });
        rows.sort_by_key(|event| event.seq);
        events.extend(rows);
    }
    Ok(events)
}

fn delta(event: &Event) -> Result<instruction::Delta, Error> {
    let path = JsonPath::default();
    ObjectDecoder::new(&event.data, &path)
        .map_err(record_error)?
        .field("delta")
        .map_err(record_error)
}

fn fold(id: &session::Id, events: &[Event]) -> Result<Option<InstructionState>, Error> {
    let mut state: Option<InstructionState> = None;
    for event in events {
        match event.type_.as_str() {
            Some("session.moved.1" | "session.revert.committed.1") => state = None,
            Some("session.compaction.ended.1" | "session.compaction.ended.2") => {
                if let Some(state) = &mut state {
                    state.epoch_start = event.seq;
                    state.through_seq = event.seq;
                    state.initial_values = state.current_values.clone();
                }
            }
            Some(UPDATE) => {
                let current = state
                    .as_ref()
                    .map(|state| state.current_values.domain())
                    .transpose()?
                    .unwrap_or_else(|| instruction::Values(JsonObject::new()));
                let current = Document::from_domain(&crate::instructions::apply_hash_delta(
                    &current,
                    &delta(event)?,
                ))?;
                match &mut state {
                    Some(state) => {
                        state.through_seq = event.seq;
                        state.current_values = current;
                    }
                    None => {
                        state = Some(InstructionState {
                            session_id: id.as_lossless().clone(),
                            epoch_start: event.seq,
                            through_seq: event.seq,
                            initial_values: current.clone(),
                            current_values: current,
                        })
                    }
                }
            }
            _ => {}
        }
    }
    Ok(state)
}

pub fn read(snapshot: &Snapshot, id: &session::Id) -> Result<Option<InstructionState>, Error> {
    let rows = events(&mut Reader::Snapshot(snapshot), id, RELEVANT, None)?;
    let cached = snapshot.get::<InstructionStateTable>(&key(id.as_lossless()))?;
    if let Some(cached) = cached
        && rows
            .last()
            .is_none_or(|event| event.seq <= cached.through_seq)
    {
        return Ok(Some(cached));
    }
    fold(id, &rows)
}

pub fn notices(snapshot: &Snapshot, id: &session::Id) -> Result<Vec<Entry>, Error> {
    let Some(state) = read(snapshot, id)? else {
        return Ok(Vec::new());
    };
    events(
        &mut Reader::Snapshot(snapshot),
        id,
        &[UPDATE],
        Some(state.epoch_start),
    )?
    .into_iter()
    .map(|event| {
        let delta = delta(&event)?;
        if delta.0.is_empty() {
            return Ok(None);
        }
        Ok(Some(Entry {
            seq: event.seq,
            message: session_message::Info::System(session_message::System {
                id: session_message::Id::from_event(
                    &ycoding_schema::event::Id::new(event.id).map_err(record_error)?,
                ),
                metadata: None,
                text: format!(
                    "Instructions updated: {}",
                    delta
                        .0
                        .iter()
                        .map(|(key, _)| String::from_utf16_lossy(
                            &key.code_units().collect::<Vec<_>>()
                        ))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
                .into(),
                time: session_message::BaseTime {
                    created: ycoding_schema::schema::DateTimeUtcFromMillis::new(
                        event.created as f64,
                    )
                    .map_err(record_error)?,
                },
            }),
        }))
    })
    .collect::<Result<Vec<_>, Error>>()
    .map(|entries| entries.into_iter().flatten().collect())
}

pub(crate) fn updates(
    snapshot: &Snapshot,
    id: &session::Id,
    after: i64,
) -> Result<Vec<Event>, Error> {
    events(&mut Reader::Snapshot(snapshot), id, &[UPDATE], Some(after))
}

pub(crate) fn apply(tx: &mut Write<'_>, event: &Event) -> Result<(), Error> {
    let id = session::Id::new(event.aggregate_id.clone()).map_err(record_error)?;
    let rows = events(&mut Reader::Transaction(tx), &id, RELEVANT, None)?;
    let Some(state) = fold(&id, &rows)? else {
        return Ok(());
    };
    InstructionStateTable::put(tx, &state)
}

impl Service {
    pub async fn rebuild_instruction_state(
        &self,
        id: &session::Id,
    ) -> Result<Option<InstructionState>, Error> {
        let id = id.clone();
        self.client
            .submit(move |tx| {
                let rows = events(&mut Reader::Transaction(tx), &id, RELEVANT, None)?;
                let state = fold(&id, &rows)?;
                match &state {
                    Some(state) => InstructionStateTable::put(tx, state)?,
                    None => {
                        tx.delete::<InstructionStateTable>(&key(id.as_lossless()))?;
                    }
                }
                Ok(state)
            })?
            .await
    }
}
