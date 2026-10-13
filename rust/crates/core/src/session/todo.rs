use super::{key, prompt_cache::sha256, store::Service};
use std::ops::Bound;
use ycoding_schema::{
    DomainEncode, JsonValue, LosslessString, ObjectEncoder, session, session_todo, stringify_json,
};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, TableSpec,
    session::{SessionTable, Todo as TodoRow, TodoState, TodoStateTable, TodoTable},
};

#[derive(Clone, Debug, PartialEq)]
pub struct Todo {
    pub content: LosslessString,
    pub status: LosslessString,
    pub priority: LosslessString,
}

impl Service {
    pub fn todos(&self, id: &session::Id) -> Result<Vec<Todo>, Error> {
        let mut rows = self.client.snapshot()?.index::<TodoTable>(
            "session_todo_session_idx",
            &key(id.as_lossless()),
            None,
            usize::MAX,
        )?;
        rows.sort_by_key(|row| row.position);
        Ok(rows
            .into_iter()
            .map(|row| Todo {
                content: row.content,
                status: row.status,
                priority: row.priority,
            })
            .collect())
    }

    pub async fn update_todos(
        &self,
        id: &session::Id,
        todos: &[session_todo::Info],
    ) -> Result<(), Error> {
        let session_id = id.as_lossless().clone();
        let rows = todos
            .iter()
            .zip(0_i64..)
            .map(|(todo, position)| (todo.clone(), position))
            .collect::<Vec<_>>();
        let digest = sha256(&stringify_json(&JsonValue::Array(
            rows.iter()
                .map(|(todo, position)| {
                    ObjectEncoder::new()
                        .field("content", &todo.content)
                        .field("status", &todo.status)
                        .field("priority", &todo.priority)
                        .field("position", &(*position as f64))
                        .finish()
                })
                .collect(),
        )));
        let now = chrono::Utc::now().timestamp_millis();
        self.client
            .submit(move |tx| {
                let primary = key(&session_id);
                if tx.get::<SessionTable>(&primary)?.is_none() {
                    return Err(Error::Domain {
                        kind: "not_found",
                        message: "Session not found",
                    });
                }
                for stale in tx.index_range::<TodoTable>(
                    "session_todo_session_idx",
                    IndexQuery {
                        lower: Bound::Unbounded,
                        upper: Bound::Unbounded,
                        prefix: Some(&primary),
                        order: IndexOrder::Ascending,
                        after: None,
                        limit: usize::MAX,
                    },
                )? {
                    tx.delete::<TodoTable>(&TodoTable::primary_key(&stale.record))?;
                }
                for (todo, position) in &rows {
                    TodoTable::insert(
                        tx,
                        &TodoRow {
                            session_id: session_id.clone(),
                            content: todo.content.clone(),
                            status: literal(&todo.status)?,
                            priority: literal(&todo.priority)?,
                            position: *position,
                            time_created: now,
                            time_updated: now,
                        },
                    )?;
                }
                let revision = tx
                    .get::<TodoStateTable>(&primary)?
                    .map_or(1, |state| state.revision + 1);
                TodoStateTable::put(
                    tx,
                    &TodoState {
                        session_id,
                        revision,
                        digest: digest.into(),
                        time_updated: now,
                    },
                )
            })?
            .await
    }
}

fn literal(value: &impl DomainEncode) -> Result<LosslessString, Error> {
    match value.encode() {
        JsonValue::String(text) => Ok(text),
        _ => Err(Error::Rejected("Todo literal is not a string")),
    }
}
