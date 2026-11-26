use crate::session::{key, projector, store::Service};
use std::ops::Bound;
use ycoding_schema::{
    JsonValue, LosslessString, ObjectEncoder,
    session_message::{AssistantContent, Info, ToolState},
};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, KeyPart, Write,
    session::{Event, EventTable, MessageTable, NewEvent, SequenceTable},
    tuple_key,
};

impl Service {
    pub async fn reconcile_interrupted(&self, now: i64) -> Result<usize, Error> {
        let mut cursor: Option<Vec<u8>> = None;
        let mut reconciled = 0;
        loop {
            let (settled, next) = self
                .client
                .submit(move |tx| {
                    const PAGE: usize = 128;
                    let sequences = tx.scan::<SequenceTable>(
                        cursor.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                        Bound::Unbounded,
                        PAGE,
                    )?;
                    let next = (sequences.len() == PAGE)
                        .then(|| key(&sequences.last().unwrap().aggregate_id));
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
                        let Some(lifecycle) = lifecycle.filter(|event| {
                            event.type_.as_str() == Some("session.execution.started.1")
                        }) else {
                            continue;
                        };
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
                            && step.seq > lifecycle.seq
                            && closed.is_none_or(|closed| closed.seq <= step.seq)
                        {
                            let decoded = projector::decode(&step)?;
                            let Some(JsonValue::String(assistant)) =
                                decoded.0.data.0.get(&"assistantMessageID".into())
                            else {
                                return Err(Error::Rejected(
                                    "unterminated Step has no assistant identity",
                                ));
                            };
                            settle_unfinished_tools(tx, &sequence.aggregate_id, assistant, now)?;
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
                        return Ok((1, Some(key(&sequence.aggregate_id))));
                    }
                    Ok((0, next))
                })?
                .await?;
            reconciled += settled;
            if next.is_none() {
                return Ok(reconciled);
            }
            cursor = next;
        }
    }
}

fn settle_unfinished_tools(
    tx: &mut Write<'_>,
    session: &LosslessString,
    assistant: &LosslessString,
    now: i64,
) -> Result<(), Error> {
    let Some(row) = tx
        .get::<MessageTable>(&key(assistant))?
        .filter(|row| &row.session_id == session && row.type_.as_str() == Some("assistant"))
    else {
        return Ok(());
    };
    let Info::Assistant(message) = row.info()? else {
        return Ok(());
    };
    for part in message.content {
        let AssistantContent::Tool(tool) = part else {
            continue;
        };
        let (kind, message, executed) = match tool.state {
            ToolState::Streaming(_) => (
                "tool.input-json",
                "Tool call arguments were incomplete when the service restarted and were not executed. Retry the call if it is still needed.",
                false,
            ),
            ToolState::Running(_) => (
                "aborted",
                "The server stopped before the tool result was recorded. Its effect is unknown and it was not retried. Check what happened before trying again.",
                tool.executed == Some(true),
            ),
            _ => continue,
        };
        projector::append(
            tx,
            &NewEvent {
                id: projector::random_event_id()?.as_lossless().clone(),
                aggregate_id: session.clone(),
                created: now,
                type_: "session.tool.failed.1".into(),
                data: ObjectEncoder::new()
                    .field("sessionID", session)
                    .field("assistantMessageID", assistant)
                    .field("callID", &tool.id)
                    .field("executed", &executed)
                    .field(
                        "error",
                        &ObjectEncoder::new()
                            .field("type", kind)
                            .field("message", message)
                            .finish(),
                    )
                    .finish(),
            },
        )?;
    }
    Ok(())
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
