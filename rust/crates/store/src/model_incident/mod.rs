use crate::session::codec;
mod tables;
pub use tables::*;

use crate::{
    Error, IndexOrder, IndexQuery, KeyPart, Snapshot, TableDeclaration, TableSpec, Write, tuple_key,
};
use std::ops::Bound;

pub const TABLES: &[TableDeclaration] = &[
    TableDeclaration::of::<IncidentTable>(),
    TableDeclaration::of::<GuidanceClearTable>(),
];
pub const CLEANUP_ROWS: usize = 1_000;
pub const TIME_INDEX: &str = "model_incident_time_created_id_idx";
pub const MODEL_INDEX: &str = "model_incident_model_time_idx";
pub const MODEL_AGENT_INDEX: &str = "model_incident_model_agent_time_idx";
pub const GUIDANCE_INDEX: &str = "model_incident_guidance_idx";
pub const REQUEST_INDEX: &str = "model_incident_request_idx";

pub fn delete_expired(tx: &mut Write<'_>, cutoff: i64) -> Result<usize, Error> {
    let upper = tuple_key(&[KeyPart::I64(cutoff)]);
    let rows = tx.index_range::<IncidentTable>(TIME_INDEX, expired(&upper, CLEANUP_ROWS))?;
    for row in &rows {
        tx.delete::<IncidentTable>(&IncidentTable::primary_key(&row.record))?;
    }
    Ok(rows.len())
}

pub fn has_expired(snapshot: &Snapshot, cutoff: i64) -> Result<bool, Error> {
    let upper = tuple_key(&[KeyPart::I64(cutoff)]);
    Ok(!snapshot
        .index_range::<IncidentTable>(TIME_INDEX, expired(&upper, 1))?
        .is_empty())
}

fn expired(upper: &[u8], limit: usize) -> IndexQuery<'_> {
    IndexQuery {
        lower: Bound::Unbounded,
        upper: Bound::Excluded(upper),
        prefix: None,
        order: IndexOrder::Ascending,
        after: None,
        limit,
    }
}
