use super::{key, projector};
use std::ops::Bound;
use ycoding_schema::{DomainEncode, JsonValue, LosslessString, ObjectEncoder};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, KeyPart, Write,
    session::{EventTable, NewEvent, Pending, PendingTable},
    tuple_key,
};

fn field<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(value) => value.get(&name.into()),
        _ => None,
    }
}
fn string<'a>(value: &'a JsonValue, name: &str) -> Option<&'a LosslessString> {
    match field(value, name) {
        Some(JsonValue::String(value)) => Some(value),
        _ => None,
    }
}
fn delegation(value: &JsonValue) -> Option<&LosslessString> {
    field(value, "routine")
        .or_else(|| {
            field(value, "delegated").filter(|value| {
                field(value, "instruction")
                    .and_then(|value| string(value, "operation"))
                    .and_then(LosslessString::as_str)
                    == Some("task")
            })
        })
        .and_then(|value| field(value, "delegation"))
        .and_then(|value| string(value, "id"))
}

pub(crate) fn reject(tx: &mut Write<'_>, pending: &Pending, now: i64) -> Result<bool, Error> {
    if pending.type_.as_str() != Some("user") {
        return Ok(false);
    }
    let Some(metadata) = field(&pending.data, "metadata") else {
        return Ok(false);
    };
    if string(metadata, "inputOrigin").and_then(LosslessString::as_str) != Some("plugin") {
        return Ok(false);
    }
    let Some(association) = field(metadata, "dotsExchange") else {
        return Ok(false);
    };
    let (Some(anchor), Some(exchange), Some(delegation_id)) = (
        string(association, "sessionID"),
        string(association, "exchangeID"),
        delegation(association),
    ) else {
        return Ok(false);
    };
    let prefix = tuple_key(&[
        KeyPart::String(anchor),
        KeyPart::String(&"session.dots.exchange.created.1".into()),
    ]);
    let mut after = None;
    loop {
        let events = tx.index_range::<EventTable>(
            "event_aggregate_type_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: after.as_ref(),
                limit: 128,
            },
        )?;
        if events.iter().any(|event| {
            string(&event.record.data, "inputID") == Some(&pending.id)
                && string(&event.record.data, "targetSessionID") == Some(&pending.session_id)
                && string(&event.record.data, "sessionID") == Some(anchor)
                && string(&event.record.data, "exchangeID") == Some(exchange)
                && delegation(&event.record.data) == Some(delegation_id)
        }) {
            projector::append(
                tx,
                &NewEvent {
                    id: projector::random_event_id()?.as_lossless().clone(),
                    aggregate_id: pending.session_id.clone(),
                    created: now,
                    type_: "session.dots.instruction.rejected.1".into(),
                    data: ObjectEncoder::new()
                        .field("sessionID", &pending.session_id)
                        .field("inputID", &pending.id)
                        .field("anchorSessionID", anchor)
                        .field("exchangeID", exchange)
                        .field("delegationID", delegation_id)
                        .field("reason", "delegation_invalid")
                        .finish(),
                },
            )?;
            return Ok(true);
        }
        let Some(last) = events.last() else {
            return Ok(false);
        };
        after = Some(last.cursor.clone());
    }
}

pub(crate) fn apply(
    tx: &mut Write<'_>,
    event: &ycoding_store::session::Event,
) -> Result<(), Error> {
    let Some(id) = string(&event.data, "inputID") else {
        return Err(Error::Rejected("Rejected input is missing an identity"));
    };
    let Some(pending) = tx.get::<PendingTable>(&key(id))? else {
        return Ok(());
    };
    if pending.session_id != event.aggregate_id || pending.type_.as_str() != Some("user") {
        return Ok(());
    }
    let Some(metadata) = field(&pending.data, "metadata") else {
        return Ok(());
    };
    let Some(association) = field(metadata, "dotsExchange") else {
        return Ok(());
    };
    if string(metadata, "inputOrigin").and_then(LosslessString::as_str) == Some("plugin")
        && string(association, "sessionID") == string(&event.data, "anchorSessionID")
        && string(association, "exchangeID") == string(&event.data, "exchangeID")
        && delegation(association).map(DomainEncode::encode)
            == field(&event.data, "delegationID").cloned()
    {
        tx.delete::<PendingTable>(&key(id))?;
    }
    Ok(())
}
