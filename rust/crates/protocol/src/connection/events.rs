use super::ProtocolError;
use crate::{limits, v5};

pub fn event_frame_bytes(
    batch: &v5::EventBatch,
    epoch: &str,
    ordinal: u64,
    tiny_receipt: u64,
) -> Result<u64, ProtocolError> {
    event_bytes(batch, None, epoch, ordinal, tiny_receipt)
}

pub fn event_reservation_bytes(batch: &v5::EventBatch, epoch: &str) -> Result<u64, ProtocolError> {
    event_frame_bytes(batch, epoch, u64::MAX, u64::MAX)
}

pub(super) fn merged_reservation_bytes(
    batch: &v5::EventBatch,
    event: &v5::EventRecord,
    epoch: &str,
) -> Result<u64, ProtocolError> {
    event_bytes(batch, Some(event), epoch, u64::MAX, u64::MAX)
}

pub(super) fn resync_reservation_bytes(
    scope: &v5::Scope,
    source: &str,
    message_id: Option<&str>,
    epoch: &str,
) -> Result<u64, ProtocolError> {
    let body = field(scope_bytes(scope)?)
        + field(source.len() as u64)
        + message_id.map_or(0, |id| field(id.len() as u64));
    Ok(header(epoch, v5::LedgerClass::Normal, u64::MAX, u64::MAX) + field(field(body)))
}

fn event_bytes(
    batch: &v5::EventBatch,
    extra: Option<&v5::EventRecord>,
    epoch: &str,
    ordinal: u64,
    tiny_receipt: u64,
) -> Result<u64, ProtocolError> {
    let body = field(batch.subscription_id.len() as u64)
        + field(scope_bytes(&batch.scope)?)
        + field(batch.source_epoch.len() as u64)
        + batch
            .events
            .iter()
            .chain(extra)
            .map(|record| field(record_bytes(record)))
            .sum::<u64>();
    Ok(header(epoch, v5::LedgerClass::Event, ordinal, tiny_receipt) + field(body))
}

fn header(epoch: &str, ledger: v5::LedgerClass, ordinal: u64, tiny_receipt: u64) -> u64 {
    scalar(limits::REVISION)
        + field(epoch.len() as u64)
        + scalar(ledger as u64)
        + scalar(ordinal)
        + scalar(tiny_receipt)
}

fn scope_bytes(scope: &v5::Scope) -> Result<u64, ProtocolError> {
    match &scope.target {
        Some(v5::scope::Target::Session(session)) => Ok(field(session.len() as u64)),
        Some(v5::scope::Target::Global(_)) => Ok(field(0)),
        _ => Err(ProtocolError::Direction),
    }
}

fn record_bytes(record: &v5::EventRecord) -> u64 {
    let payload =
        field(record.event.type_name.len() as u64) + field(record.event.payload.len() as u64);
    field(record.event_id.len() as u64)
        + scalar(record.created_ms as u64)
        + field(payload)
        + record.durable.as_ref().map_or(0, |durable| {
            field(
                field(durable.aggregate_id.len() as u64)
                    + scalar(durable.sequence)
                    + scalar(durable.version as u64),
            )
        })
}

fn field(bytes: u64) -> u64 {
    1 + varint(bytes) + bytes
}
fn scalar(value: u64) -> u64 {
    1 + varint(value)
}
fn varint(value: u64) -> u64 {
    u64::from((64 - value.leading_zeros()).div_ceil(7).max(1))
}
