use crate::session::codec;
use crate::session::codec::key;
use crate::{Error, TableDeclaration, TableSpec, Write, resources};
pub use tables::{Outbox, OutboxTable, Subscription, SubscriptionTable};
use ycoding_schema::LosslessString;

pub const TABLES: &[TableDeclaration] = &[
    TableDeclaration::of::<SubscriptionTable>(),
    TableDeclaration::of::<OutboxTable>(),
];

mod tables {
    use super::codec::{integer, key, table};
    use super::seed_sequence;
    use crate::{Error, IndexDefinition, KeyPart, tuple_key};
    use ycoding_schema::LosslessString;

    table!(SubscriptionTable, Subscription, "mcp_event_subscription", {
    id: LosslessString, identity_hash: LosslessString, owner_id: LosslessString, device_id: LosslessString,
    client_id: LosslessString, grant_id: LosslessString, epoch: LosslessString, name: LosslessString,
    session_id: LosslessString, include_descendants: i64, callback_url: LosslessString,
    secret_ciphertext: LosslessString, secret_fingerprint: LosslessString,
    previous_secret_ciphertext: Option<LosslessString>, previous_secret_until: Option<i64>,
    expires_at: i64, disabled: i64, pruned_through: i64, time_created: i64, time_updated: i64
}, r, key(&r.id), &[
    IndexDefinition::unique("mcp_event_subscription_identity_idx"),
    IndexDefinition::secondary("mcp_event_subscription_session_idx"),
    IndexDefinition::secondary("mcp_event_subscription_expiry_idx")
], index, match index.name {
    "mcp_event_subscription_identity_idx" => Ok(Some(key(&r.identity_hash))),
    "mcp_event_subscription_session_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.session_id), KeyPart::String(&r.name)]))),
    "mcp_event_subscription_expiry_idx" => Ok(Some(tuple_key(&[KeyPart::I64(r.expires_at)]))),
    _ => Err(Error::UnregisteredIndex)
}, Ok::<_, Error>(()), tx, { let _ = tx; });

    table!(OutboxTable, Outbox, "mcp_event_outbox", {
    seq: i64, id: LosslessString, subscription_id: LosslessString, dedupe_key: LosslessString,
    name: LosslessString, session_id: LosslessString, root_session_id: LosslessString, state: LosslessString,
    request_id: Option<LosslessString>, item_id: Option<LosslessString>, task_id: Option<LosslessString>,
    category: Option<LosslessString>, reason: Option<LosslessString>, time_created: i64, attempts: i64,
    next_attempt_at: i64, delivered_at: Option<i64>, dead: i64
}, r, tuple_key(&[KeyPart::I64(r.seq)]), &[
    IndexDefinition::unique("mcp_event_outbox_id_idx"),
    IndexDefinition::unique("mcp_event_outbox_dedupe_idx"),
    IndexDefinition::secondary("mcp_event_outbox_dispatch_idx"),
    IndexDefinition::secondary("mcp_event_outbox_subscription_seq_idx")
], index, match index.name {
    "mcp_event_outbox_id_idx" => Ok(Some(key(&r.id))),
    "mcp_event_outbox_dedupe_idx" => Ok(Some(key(&r.dedupe_key))),
    "mcp_event_outbox_dispatch_idx" => Ok(Some(tuple_key(&[integer(r.delivered_at), KeyPart::I64(r.dead), KeyPart::I64(r.next_attempt_at), KeyPart::I64(r.seq)]))),
    "mcp_event_outbox_subscription_seq_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.subscription_id), KeyPart::I64(r.seq)]))),
    _ => Err(Error::UnregisteredIndex)
}, Ok::<_, Error>(()), tx, { seed_sequence(tx, r.seq)?; });
}

pub fn next_sequence(tx: &mut Write<'_>) -> Result<i64, Error> {
    let high_water = seed_sequence(tx, 0)?;
    let next = high_water
        .checked_add(1)
        .ok_or_else(|| tx.reject(Error::Rejected("MCP Events outbox sequence exhausted")))?;
    seed_sequence(tx, next)
}

fn seed_sequence(tx: &mut Write<'_>, high_water: i64) -> Result<i64, Error> {
    let name = LosslessString::from(OutboxTable::NAME);
    let old = tx.get::<resources::SequenceTable>(&key(&name))?;
    let high_water = high_water
        .max(old.as_ref().map_or(0, |row| row.high_water))
        .max(0);
    if old.is_some_and(|row| row.high_water == high_water) {
        return Ok(high_water);
    }
    resources::SequenceTable::put(tx, &resources::Sequence { name, high_water })?;
    Ok(high_water)
}
