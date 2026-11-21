use super::{key, projector::record_error, store::Service};
use crate::instructions::{self, Observation, Source};
use std::{ops::Bound, sync::Arc};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, instruction, instruction_entry, session,
    stringify_json,
};
use ycoding_store::{
    Error,
    session::{Document, InstructionEntry, InstructionEntryTable},
};

#[derive(Debug)]
pub enum EntryError {
    Store(Error),
    ValueTooLarge(instruction_entry::ValueTooLargeError),
}
impl std::fmt::Display for EntryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(error) => write!(formatter, "{error}"),
            Self::ValueTooLarge(error) => write!(
                formatter,
                "Instruction entry value is {} bytes; the limit is {} bytes",
                error.actual_bytes.get(),
                error.max_bytes.get()
            ),
        }
    }
}
impl std::error::Error for EntryError {}
impl From<Error> for EntryError {
    fn from(error: Error) -> Self {
        Self::Store(error)
    }
}

impl Service {
    pub fn instruction_entries(
        &self,
        id: &session::Id,
    ) -> Result<Vec<instruction_entry::Info>, Error> {
        rows(self, id)?
            .into_iter()
            .filter(|row| row.removed == 0)
            .map(|row| {
                Ok(instruction_entry::Info {
                    key: instruction_entry::Key::decode(&row.key.encode()).map_err(record_error)?,
                    value: ycoding_schema::domain::Json::decode(
                        &row.value
                            .map(|value| value.value().clone())
                            .unwrap_or(JsonValue::Null),
                    )
                    .map_err(record_error)?,
                })
            })
            .collect()
    }
    pub async fn put_instruction_entry(
        &self,
        id: &session::Id,
        entry: instruction_entry::Info,
        now: i64,
    ) -> Result<(), EntryError> {
        let value = entry.value.encode();
        let actual = stringify_json(&value).len();
        if actual > instruction_entry::MAX_VALUE_BYTES {
            return Err(EntryError::ValueTooLarge(
                instruction_entry::ValueTooLargeError {
                    actual_bytes: ycoding_schema::schema::Int::new(actual as i64)
                        .map_err(record_error)?,
                    max_bytes: ycoding_schema::schema::Int::new(
                        instruction_entry::MAX_VALUE_BYTES as i64,
                    )
                    .map_err(record_error)?,
                    message: format!(
                        "Instruction entry value is {actual} bytes; the limit is {} bytes",
                        instruction_entry::MAX_VALUE_BYTES
                    )
                    .into(),
                },
            ));
        }
        let session = id.as_lossless().clone();
        let entry_key = entry.key.encode();
        let JsonValue::String(entry_key) = entry_key else {
            unreachable!("entry key encodes a string")
        };
        self.client
            .submit(move |tx| {
                let primary = ycoding_store::tuple_key(&[
                    ycoding_store::KeyPart::String(&session),
                    ycoding_store::KeyPart::String(&entry_key),
                ]);
                let existing = tx.get::<InstructionEntryTable>(&primary)?;
                if existing.as_ref().is_some_and(|row| {
                    row.removed == 0
                        && row.value.as_ref().map(|value| value.value()) == Some(&value)
                }) {
                    return Ok(());
                }
                InstructionEntryTable::put(
                    tx,
                    &InstructionEntry {
                        session_id: session,
                        key: entry_key,
                        value: Some(Document::new(value)?),
                        removed: 0,
                        time_created: existing.map_or(now, |row| row.time_created),
                        time_updated: now,
                    },
                )
            })?
            .await?;
        Ok(())
    }
    pub async fn remove_instruction_entry(
        &self,
        id: &session::Id,
        entry: &instruction_entry::Key,
        now: i64,
    ) -> Result<(), Error> {
        let JsonValue::String(entry) = entry.encode() else {
            unreachable!("entry key encodes a string")
        };
        let primary = ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(id.as_lossless()),
            ycoding_store::KeyPart::String(&entry),
        ]);
        self.client
            .submit(move |tx| {
                if let Some(mut row) = tx.get::<InstructionEntryTable>(&primary)?
                    && row.removed == 0
                {
                    row.removed = 1;
                    row.value = None;
                    row.time_updated = now;
                    InstructionEntryTable::put(tx, &row)?;
                }
                Ok(())
            })?
            .await
    }
    pub fn instruction_entry_sources(&self, id: &session::Id) -> Result<Vec<Source>, Error> {
        rows(self, id)?
            .into_iter()
            .map(|row| {
                let key =
                    instruction_entry::Key::decode(&row.key.encode()).map_err(record_error)?;
                let JsonValue::String(entry_key) = key.encode() else {
                    unreachable!("entry key encodes a string")
                };
                let source_key = instruction::Key::decode(&JsonValue::String(instructions::join(
                    &["api/".into(), entry_key.clone()],
                    "",
                )))
                .map_err(record_error)?;
                let value = if row.removed == 1 {
                    Observation::Removed
                } else {
                    Observation::Value(
                        row.value
                            .map(|value| value.value().clone())
                            .unwrap_or(JsonValue::Null),
                    )
                };
                let initial_key = entry_key.clone();
                let changed_key = entry_key.clone();
                Ok(Source {
                    key: source_key,
                    read: Arc::new(move || {
                        let value = value.clone();
                        Box::pin(async move { Ok(value) })
                    }),
                    initial: Arc::new(move |value| Some(block(&initial_key, value))),
                    changed: Arc::new(move |_, value| {
                        Some(instructions::join(
                            &[
                                "The context under \"".into(),
                                changed_key.clone(),
                                "\" changed and supersedes the previous value:\n".into(),
                                block(&changed_key, value),
                            ],
                            "",
                        ))
                    }),
                    removed: Some(Arc::new(move |_| {
                        Some(instructions::join(
                            &[
                                "The context under \"".into(),
                                entry_key.clone(),
                                "\" no longer applies. Disregard it.".into(),
                            ],
                            "",
                        ))
                    })),
                })
            })
            .collect()
    }
}

fn rows(service: &Service, id: &session::Id) -> Result<Vec<InstructionEntry>, Error> {
    let snapshot = service.client.snapshot()?;
    let mut lower = key(id.as_lossless());
    let mut inclusive = true;
    let mut entries = Vec::new();
    loop {
        let rows = snapshot.scan::<InstructionEntryTable>(
            if inclusive {
                Bound::Included(&lower)
            } else {
                Bound::Excluded(&lower)
            },
            Bound::Unbounded,
            128,
        )?;
        if rows.is_empty() {
            return Ok(entries);
        }
        for row in rows {
            if row.session_id != *id.as_lossless() {
                return Ok(entries);
            }
            lower = ycoding_store::tuple_key(&[
                ycoding_store::KeyPart::String(&row.session_id),
                ycoding_store::KeyPart::String(&row.key),
            ]);
            entries.push(row);
        }
        inclusive = false;
    }
}
fn block(key: &LosslessString, value: &JsonValue) -> LosslessString {
    instructions::join(
        &[
            "<context key=\"".into(),
            key.clone(),
            "\">\n".into(),
            match value {
                JsonValue::String(text) => text.clone(),
                _ => pretty(value, 0).into(),
            },
            "\n</context>".into(),
        ],
        "",
    )
}
fn pretty(value: &JsonValue, depth: usize) -> String {
    let (open, close, lines) = match value {
        JsonValue::Array(values) if !values.is_empty() => (
            "[",
            "]",
            values
                .iter()
                .map(|value| pretty(value, depth + 1))
                .collect::<Vec<_>>(),
        ),
        JsonValue::Object(values) if !values.is_empty() => (
            "{",
            "}",
            values
                .iter()
                .map(|(key, value)| {
                    format!(
                        "{}: {}",
                        stringify_json(&JsonValue::String(key.clone())),
                        pretty(value, depth + 1)
                    )
                })
                .collect(),
        ),
        _ => return stringify_json(value),
    };
    format!(
        "{open}\n{}\n{}{close}",
        lines
            .iter()
            .map(|line| format!("{}{line}", "  ".repeat(depth + 1)))
            .collect::<Vec<_>>()
            .join(",\n"),
        "  ".repeat(depth)
    )
}
