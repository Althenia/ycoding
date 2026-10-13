use crate::session::{key, projector, store::Service};
use std::ops::Bound;
use ycoding_schema::ObjectEncoder;
use ycoding_store::{
    Error, IndexOrder, IndexQuery, KeyPart, Write,
    session::{Event, EventTable, NewEvent, SequenceTable},
    tuple_key,
};

impl Service {
    pub async fn reconcile_interrupted(&self, now: i64) -> Result<usize, Error> {
        self.client
            .submit(move |tx| {
                let mut cursor = None;
                let mut reconciled = 0;
                loop {
                    let sequences = tx.scan::<SequenceTable>(
                        cursor.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                        Bound::Unbounded,
                        128,
                    )?;
                    if sequences.is_empty() {
                        return Ok(reconciled);
                    }
                    cursor = sequences.last().map(|row| key(&row.aggregate_id));
                    for sequence in sequences {
                        let lifecycle = latest(
                            tx,
                            &sequence.aggregate_id,
                            &[
                                "session.execution.started.1",
                                "session.execution.succeeded.1",
                                "session.execution.failed.1",
                                "session.execution.interrupted.1",
                            ],
                        )?;
                        if lifecycle.as_ref().and_then(|event| event.type_.as_str())
                            != Some("session.execution.started.1")
                        {
                            continue;
                        }
                        let step = latest(tx, &sequence.aggregate_id, &["session.step.started.1"])?;
                        let closed = latest(
                            tx,
                            &sequence.aggregate_id,
                            &["session.step.ended.1", "session.step.failed.1"],
                        )?;
                        let error = ObjectEncoder::new()
                            .field("type", "interrupted")
                            .field("message", "The server stopped before this run finished")
                            .finish();
                        if let Some(step) = step
                            && closed.is_none_or(|closed| closed.seq <= step.seq)
                        {
                            let decoded = projector::decode(&step)?;
                            let assistant =
                                decoded.0.data.0.get(&"assistantMessageID".into()).ok_or(
                                    Error::Rejected("unterminated Step has no assistant identity"),
                                )?;
                            projector::append(
                                tx,
                                &NewEvent {
                                    id: projector::random_event_id()?.as_lossless().clone(),
                                    aggregate_id: sequence.aggregate_id.clone(),
                                    created: now,
                                    type_: "session.step.failed.1".into(),
                                    data: ObjectEncoder::new()
                                        .field("sessionID", &sequence.aggregate_id)
                                        .field("assistantMessageID", assistant)
                                        .field("error", &error)
                                        .finish(),
                                },
                            )?;
                        }
                        projector::append(
                            tx,
                            &NewEvent {
                                id: projector::random_event_id()?.as_lossless().clone(),
                                aggregate_id: sequence.aggregate_id.clone(),
                                created: now,
                                type_: "session.execution.failed.1".into(),
                                data: ObjectEncoder::new()
                                    .field("sessionID", &sequence.aggregate_id)
                                    .field("error", &error)
                                    .finish(),
                            },
                        )?;
                        reconciled += 1;
                    }
                }
            })?
            .await
    }
}

fn latest(
    tx: &mut Write<'_>,
    aggregate: &ycoding_schema::LosslessString,
    types: &[&str],
) -> Result<Option<Event>, Error> {
    types
        .iter()
        .map(|type_| {
            let prefix = tuple_key(&[
                KeyPart::String(aggregate),
                KeyPart::String(&(*type_).into()),
            ]);
            Ok(tx
                .index_range::<EventTable>(
                    "event_aggregate_type_seq_idx",
                    IndexQuery {
                        lower: Bound::Unbounded,
                        upper: Bound::Unbounded,
                        prefix: Some(&prefix),
                        order: IndexOrder::Descending,
                        after: None,
                        limit: 1,
                    },
                )?
                .into_iter()
                .next()
                .map(|row| row.record))
        })
        .collect::<Result<Vec<_>, Error>>()
        .map(|events| events.into_iter().flatten().max_by_key(|event| event.seq))
}
