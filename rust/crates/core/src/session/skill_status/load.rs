use super::status::{finish, fold};
use crate::session::{history, store::Service};
use std::ops::Bound;
use ycoding_schema::{JsonValue, instruction, session, session_skill_status::Info};
use ycoding_store::{Error, IndexOrder};

const PAGE: usize = 128;
const STATUS_TYPES: [&str; 4] = ["skill", "agent-switched", "compaction", "assistant"];

impl Service {
    /// Folds skill status from only the rows that can change it, decoding no unrelated payload.
    pub fn skills(
        &self,
        id: &session::Id,
        instruction_keys: &[instruction::Key],
    ) -> Result<Vec<Info>, Error> {
        let snapshot = self.client.snapshot()?;
        let mut relevant = Vec::new();
        for type_ in STATUS_TYPES {
            let mut after = None;
            loop {
                let rows = history::type_rows(
                    &snapshot,
                    id,
                    type_,
                    Bound::Unbounded,
                    Bound::Unbounded,
                    IndexOrder::Ascending,
                    after.as_ref(),
                    PAGE,
                )?;
                if rows.is_empty() {
                    break;
                }
                after = rows.last().map(|row| row.cursor.clone());
                for row in rows
                    .iter()
                    .filter(|row| changes_status(type_, &row.record.data))
                {
                    relevant.push((row.record.seq, row.record.info()?));
                }
            }
        }
        relevant.sort_by_key(|(seq, _)| *seq);
        let mut statuses = Vec::new();
        for (_, message) in &relevant {
            fold(&mut statuses, message);
        }
        Ok(finish(statuses, instruction_keys))
    }
}

fn changes_status(type_: &str, data: &JsonValue) -> bool {
    let JsonValue::Object(data) = data else {
        return true;
    };
    match type_ {
        "compaction" => data.get(&"status".into()) == Some(&JsonValue::String("completed".into())),
        "assistant" => {
            matches!(data.get(&"skillDeactivations".into()), Some(JsonValue::Array(items)) if !items.is_empty())
                || matches!(data.get(&"content".into()), Some(JsonValue::Array(parts)) if parts.iter().any(completed_skill_tool))
        }
        _ => true,
    }
}

fn completed_skill_tool(part: &JsonValue) -> bool {
    let JsonValue::Object(part) = part else {
        return false;
    };
    part.get(&"type".into()) == Some(&JsonValue::String("tool".into()))
        && part.get(&"name".into()) == Some(&JsonValue::String("skill".into()))
        && matches!(
            part.get(&"state".into()),
            Some(JsonValue::Object(state))
                if state.get(&"status".into()) == Some(&JsonValue::String("completed".into()))
        )
}
