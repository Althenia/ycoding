use super::{
    key,
    projector::record_error,
    read_json::{field, number, text},
    store::Service,
};
use std::{cmp::Ordering, ops::Bound};
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, ObjectEncoder, session, session_compaction,
};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, KeyPart, Snapshot,
    session::{MessageTable, SessionTable},
    tuple_key,
};

const WINDOW: usize = 100;
const PAGE: usize = 128;

struct Job {
    id: String,
    created: Option<f64>,
    entry: JsonValue,
}

impl Service {
    pub fn compaction_history(
        &self,
        id: &session::Id,
    ) -> Result<session_compaction::History, Error> {
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
        let mut window: Vec<Job> = Vec::new();
        let (mut total, mut completed, mut saved) = (0_usize, 0_usize, 0_i64);
        for data in compaction_messages(&snapshot, id.as_lossless())? {
            let Some(JsonValue::String(job_id)) = field(&data, &["jobID"]) else {
                continue;
            };
            total += 1;
            let is_completed = status_is(&data, "completed");
            if is_completed {
                completed += 1;
                saved += match (
                    field(&data, &["metrics", "inputTokens"]).and_then(number),
                    field(&data, &["metrics", "retainedTokens"]).and_then(number),
                ) {
                    (Some(input), Some(retained)) => (input - retained) as i64,
                    _ => 0,
                };
            }
            window.push(Job {
                id: job_id.to_utf8().unwrap_or_default(),
                created: field(&data, &["time", "created"]).and_then(number),
                entry: entry(&data, job_id, is_completed),
            });
            if window.len() >= 2 * WINDOW {
                newest_first(&mut window);
            }
        }
        newest_first(&mut window);
        let completed_in_window = window
            .iter()
            .filter(|job| status_is(&job.entry, "completed"))
            .count();
        let history = ObjectEncoder::new()
            .field(
                "data",
                &JsonValue::Array(window.into_iter().rev().map(|job| job.entry).collect()),
            )
            .field("truncated", &(total > WINDOW))
            .field(
                "completedBefore",
                &((completed - completed_in_window) as f64),
            )
            .field("completedCount", &(completed as f64))
            .field("totalSavedTokens", &(saved as f64))
            .finish();
        session_compaction::History::decode(&history).map_err(record_error)
    }
}

fn compaction_messages(
    snapshot: &Snapshot,
    session: &LosslessString,
) -> Result<Vec<JsonValue>, Error> {
    let prefix = tuple_key(&[
        KeyPart::String(session),
        KeyPart::String(&"compaction".into()),
    ]);
    let mut data = Vec::new();
    let mut after = None;
    loop {
        let page = snapshot.index_range::<MessageTable>(
            "session_message_session_type_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: after.as_ref(),
                limit: PAGE,
            },
        )?;
        let Some(last) = page.last() else {
            return Ok(data);
        };
        after = Some(last.cursor.clone());
        data.extend(page.into_iter().map(|entry| entry.record.data));
    }
}

fn newest_first(window: &mut Vec<Job>) {
    window.sort_by(|left, right| {
        right
            .created
            .partial_cmp(&left.created)
            .unwrap_or(Ordering::Equal)
            .then_with(|| right.id.cmp(&left.id))
    });
    window.truncate(WINDOW);
}

fn entry(data: &JsonValue, job_id: &LosslessString, completed: bool) -> JsonValue {
    let failed = status_is(data, "failed");
    let get = |path: &[&str]| field(data, path).cloned().unwrap_or(JsonValue::Null);
    ObjectEncoder::new()
        .field("jobID", job_id)
        .field("trigger", &get(&["trigger"]))
        .field("status", &get(&["status"]))
        .field("created", &get(&["time", "created"]))
        .optional(
            "metrics",
            &completed.then(|| {
                ObjectEncoder::new()
                    .field("excludedMessages", &get(&["metrics", "excludedMessages"]))
                    .field("excludedParts", &get(&["metrics", "excludedParts"]))
                    .field("inputTokens", &get(&["metrics", "inputTokens"]))
                    .field("retainedTokens", &get(&["metrics", "retainedTokens"]))
                    .finish()
            }),
        )
        .optional("code", &failed.then(|| get(&["code"])))
        .finish()
}

fn status_is(value: &JsonValue, status: &str) -> bool {
    field(value, &["status"])
        .and_then(text)
        .and_then(LosslessString::as_str)
        == Some(status)
}
