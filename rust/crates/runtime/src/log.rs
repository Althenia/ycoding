use crate::{
    convert::wire,
    message::{self, Unrepresentable},
};
use ycoding_core::ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonValue, LosslessString, session, session_delivery,
    session_event, session_pending,
};
use ycoding_protocol::v5;

type R<T> = Result<T, Unrepresentable>;

pub struct Record {
    pub item: v5::SessionLogItem,
    pub event_id: String,
    pub created_ms: i64,
    pub seq: u64,
    pub version: u32,
}

pub fn record(
    entry: &ycoding_core::session::log::Entry,
    session: &session::Id,
    source_epoch: &LosslessString,
) -> R<Record> {
    use v5::session_log_item::Kind;
    let item = match entry.event.0.event_type.as_str() {
        Some("session.input.admitted") => Kind::Value15(admitted(entry, session, source_epoch)?),
        Some("session.input.promoted") => Kind::Value14(promoted(entry, session, source_epoch)?),
        Some("session.input.consumed") => Kind::Value16(consumed(entry, session, source_epoch)?),
        _ => return Err(Unrepresentable("session log event")),
    };
    Ok(Record {
        item: v5::SessionLogItem { kind: Some(item) },
        event_id: name_of(&entry.event.0.id),
        created_ms: entry.event.0.created.epoch_millis(),
        seq: u64::try_from(entry.seq).map_err(|_| Unrepresentable("event seq"))?,
        version: entry.version as u32,
    })
}

fn name_of(id: &ycoding_core::ycoding_schema::event::Id) -> String {
    String::from_utf16_lossy(&id.as_lossless().code_units().collect::<Vec<_>>())
}

pub fn synced(
    session: &session::Id,
    watermark: Option<i64>,
    source_epoch: &LosslessString,
) -> v5::SessionLogItem {
    v5::SessionLogItem {
        kind: Some(v5::session_log_item::Kind::Value52(
            v5::SessionLogItemValue52 {
                r#type: 1,
                aggregate_id: wire(session.as_lossless()),
                seq: watermark.map(|watermark| watermark as u64),
                source_epoch: wire(source_epoch),
            },
        )),
    }
}

struct Envelope {
    id: v5::LosslessString,
    created: f64,
    source_epoch: v5::LosslessString,
    aggregate_id: v5::LosslessString,
    seq: u64,
    version: i64,
}

fn envelope(
    entry: &ycoding_core::session::log::Entry,
    session: &session::Id,
    source_epoch: &LosslessString,
) -> R<Envelope> {
    Ok(Envelope {
        id: wire(entry.event.0.id.as_lossless()),
        created: entry.event.0.created.epoch_millis() as f64,
        source_epoch: wire(source_epoch),
        aggregate_id: wire(session.as_lossless()),
        seq: u64::try_from(entry.seq).map_err(|_| Unrepresentable("event seq"))?,
        version: entry.version,
    })
}

fn admitted(
    entry: &ycoding_core::session::log::Entry,
    session: &session::Id,
    source_epoch: &LosslessString,
) -> R<v5::SessionLogItemValue15> {
    let envelope = envelope(entry, session, source_epoch)?;
    let data = data_object(&entry.event.0)?;
    Ok(v5::SessionLogItemValue15 {
        id: envelope.id,
        created: envelope.created,
        metadata: None,
        source_epoch: envelope.source_epoch,
        r#type: 1,
        durable: v5::SessionLogItemValue15Durable {
            aggregate_id: envelope.aggregate_id,
            seq: envelope.seq,
            version: envelope.version,
        },
        location: None,
        data: v5::SessionLogItemValue15Data {
            session_id: text_of(&data, "sessionID")?,
            input_id: text_of(&data, "inputID")?,
            input: pending_message(message_of(&data, "input")?)?,
        },
    })
}

fn promoted(
    entry: &ycoding_core::session::log::Entry,
    session: &session::Id,
    source_epoch: &LosslessString,
) -> R<v5::SessionLogItemValue14> {
    let envelope = envelope(entry, session, source_epoch)?;
    let data = data_object(&entry.event.0)?;
    Ok(v5::SessionLogItemValue14 {
        id: envelope.id,
        created: envelope.created,
        metadata: None,
        source_epoch: envelope.source_epoch,
        r#type: 1,
        durable: v5::SessionLogItemValue14Durable {
            aggregate_id: envelope.aggregate_id,
            seq: envelope.seq,
            version: envelope.version,
        },
        location: None,
        data: v5::SessionLogItemValue14Data {
            session_id: text_of(&data, "sessionID")?,
            input_id: text_of(&data, "inputID")?,
        },
    })
}

fn consumed(
    entry: &ycoding_core::session::log::Entry,
    session: &session::Id,
    source_epoch: &LosslessString,
) -> R<v5::SessionLogItemValue16> {
    let envelope = envelope(entry, session, source_epoch)?;
    let data = data_object(&entry.event.0)?;
    let ids = match data.get(&LosslessString::from("inputIDs")) {
        Some(JsonValue::Array(ids)) => ids
            .iter()
            .map(|id| match id {
                JsonValue::String(id) => Ok(wire(id)),
                _ => Err(Unrepresentable("inputIDs")),
            })
            .collect::<R<Vec<_>>>()?,
        _ => return Err(Unrepresentable("inputIDs")),
    };
    Ok(v5::SessionLogItemValue16 {
        id: envelope.id,
        created: envelope.created,
        metadata: None,
        source_epoch: envelope.source_epoch,
        r#type: 1,
        durable: v5::SessionLogItemValue16Durable {
            aggregate_id: envelope.aggregate_id,
            seq: envelope.seq,
            version: envelope.version,
        },
        location: None,
        data: v5::SessionLogItemValue16Data {
            session_id: text_of(&data, "sessionID")?,
            input_i_ds: v5::SessionLogItemValue16DataInputIDs { items: ids },
        },
    })
}

fn data_object(event: &session_event::Event) -> R<JsonObject> {
    match event.data.encode() {
        JsonValue::Object(object) => Ok(object),
        _ => Err(Unrepresentable("event data")),
    }
}

fn text_of(object: &JsonObject, key: &str) -> R<v5::LosslessString> {
    match object.get(&LosslessString::from(key)) {
        Some(JsonValue::String(text)) => Ok(wire(text)),
        _ => Err(Unrepresentable("event field")),
    }
}

fn message_of(object: &JsonObject, key: &str) -> R<session_pending::Message> {
    let value = object
        .get(&LosslessString::from(key))
        .ok_or(Unrepresentable("event field"))?;
    session_pending::Message::decode(value).map_err(|_| Unrepresentable("pending input"))
}

fn pending_message(input: session_pending::Message) -> R<v5::SessionPendingMessage> {
    use v5::session_pending_message::Kind;
    let kind = match input {
        session_pending::Message::User(message) => Kind::Value1(v5::SessionPendingUserMessage {
            r#type: 1,
            data: message::user_data(&message.data.encode())?,
            delivery: delivery(&message.delivery)?,
        }),
        session_pending::Message::Synthetic(message) => {
            Kind::Value2(v5::SessionPendingSyntheticMessage {
                r#type: 1,
                data: message::synthetic_data(&message.data.encode())?,
                delivery: delivery(&message.delivery)?,
            })
        }
    };
    Ok(v5::SessionPendingMessage { kind: Some(kind) })
}

fn delivery(delivery: &session_delivery::Delivery) -> R<i32> {
    match delivery.encode() {
        JsonValue::String(name) => message::delivery(name.as_str()),
        _ => Err(Unrepresentable("delivery")),
    }
}
