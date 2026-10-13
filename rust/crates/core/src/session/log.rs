use super::{key, store::Service};
use std::ops::Bound;
use ycoding_schema::{session, session_event};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, KeyPart,
    session::{self as tables, Event, EventTable, SessionTable},
    tuple_key,
};

pub const MAX_PAGE: usize = 512;

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub seq: i64,
    pub version: i64,
    pub event: session_event::DurableEvent,
}

impl Entry {
    pub fn from_event(row: &Event) -> Result<Self, Error> {
        super::projector::decode(row).map(|event| Self {
            seq: row.seq,
            version: version(&row.type_),
            event,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Page {
    pub events: Vec<Entry>,
    pub watermark: Option<i64>,
}

impl Service {
    pub fn log(&self, id: &session::Id, after: Option<i64>, limit: usize) -> Result<Page, Error> {
        if !(1..=MAX_PAGE).contains(&limit)
            || after.is_some_and(|after| !(0..=9_007_199_254_740_991).contains(&after))
        {
            return Err(Error::Domain {
                kind: "invalid_cursor",
                message: "invalid session log cursor or window limit",
            });
        }
        let snapshot = self.client.snapshot()?;
        if snapshot
            .get::<SessionTable>(&key(id.as_lossless()))?
            .is_none()
        {
            return Err(Error::Domain {
                kind: "not_found",
                message: "Session not found",
            });
        }
        let prefix = key(id.as_lossless());
        let lower =
            after.map(|after| tuple_key(&[KeyPart::String(id.as_lossless()), KeyPart::I64(after)]));
        let mut cursor = None;
        let mut events = Vec::new();
        while events.len() < limit {
            let rows = snapshot.index_range::<EventTable>(
                "event_aggregate_seq_idx",
                IndexQuery {
                    lower: lower
                        .as_ref()
                        .map_or(Bound::Unbounded, |bound| Bound::Excluded(bound.as_slice())),
                    upper: Bound::Unbounded,
                    prefix: Some(&prefix),
                    order: IndexOrder::Ascending,
                    after: cursor.as_ref(),
                    limit: (limit - events.len()).min(128),
                },
            )?;
            if rows.is_empty() {
                break;
            }
            cursor = rows.last().map(|row| row.cursor.clone());
            events.extend(
                rows.into_iter()
                    .map(|row| Entry::from_event(&row.record))
                    .collect::<Result<Vec<_>, Error>>()?,
            );
        }
        let sequence = tables::latest_sequence(&snapshot, id.as_lossless())?;
        Ok(Page {
            events,
            watermark: (sequence >= 0).then_some(sequence),
        })
    }
}

fn version(type_: &ycoding_schema::LosslessString) -> i64 {
    type_
        .as_str()
        .and_then(|value| value.rsplit_once('.'))
        .and_then(|(_, version)| version.parse().ok())
        .unwrap_or(1)
}
