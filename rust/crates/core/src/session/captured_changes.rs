use super::{
    key,
    projector::record_error,
    read_json::{field, text},
    store::Service,
};
use std::ops::Bound;
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, ObjectEncoder, session, session_captured_changes,
};
use ycoding_store::{
    Error, IndexOrder,
    session::{Message, SessionTable, messages},
};

const MAX_LIMIT: usize = 200;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const PAGE: usize = 128;
const FILE_TOOLS: [&str; 3] = ["edit", "patch", "apply_patch"];
const SUBAGENT: &str = "subagent";
const SUBAGENT_CONTROL: &str = "subagent_control";

impl Service {
    pub fn captured_inputs(
        &self,
        id: &session::Id,
        after: Option<i64>,
        limit: usize,
    ) -> Result<session_captured_changes::Page, Error> {
        if !(1..=MAX_LIMIT).contains(&limit)
            || after.is_some_and(|after| !(0..=MAX_SAFE_INTEGER).contains(&after))
        {
            return Err(Error::Rejected("Invalid captured input page"));
        }
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
        let mut rows: Vec<Message> = Vec::new();
        let mut cursor = None;
        while rows.len() <= limit {
            let page = messages(
                &snapshot,
                id.as_lossless(),
                after.map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
                IndexOrder::Ascending,
                cursor.as_ref(),
                PAGE,
            )?;
            let Some(last) = page.last() else {
                break;
            };
            cursor = Some(last.cursor.clone());
            rows.extend(
                page.into_iter()
                    .map(|entry| entry.record)
                    .filter(|row| {
                        matches!(row.type_.as_str(), Some("user" | "synthetic" | "assistant"))
                    })
                    .take(limit + 1 - rows.len()),
            );
        }
        let next = (rows.len() > limit).then(|| rows[limit - 1].seq as f64);
        rows.truncate(limit);
        let page = ObjectEncoder::new()
            .field("data", &JsonValue::Array(rows.iter().map(input).collect()))
            .optional("next", &next)
            .finish();
        session_captured_changes::Page::decode(&page).map_err(record_error)
    }
}

fn input(row: &Message) -> JsonValue {
    let encoder = ObjectEncoder::new()
        .field("id", &row.id)
        .field("type", &row.type_);
    match row.type_.as_str() {
        Some("synthetic") => encoder
            .field(
                "metadata",
                &ObjectEncoder::new()
                    .optional("kind", &string(&row.data, &["metadata", "kind"]))
                    .optional(
                        "questionID",
                        &string(&row.data, &["metadata", "questionID"]),
                    )
                    .finish(),
            )
            .finish(),
        Some("assistant") => encoder
            .field(
                "content",
                &JsonValue::Array(match field(&row.data, &["content"]) {
                    Some(JsonValue::Array(parts)) => parts.iter().filter_map(tool).collect(),
                    _ => Vec::new(),
                }),
            )
            .finish(),
        _ => encoder.finish(),
    }
}

fn tool(part: &JsonValue) -> Option<JsonValue> {
    if string(part, &["type"]).is_none_or(|kind| kind.as_str() != Some("tool")) {
        return None;
    }
    let name = string(part, &["name"])?;
    let name_text = name.as_str()?;
    if !(FILE_TOOLS.contains(&name_text) || name_text == SUBAGENT || name_text == SUBAGENT_CONTROL)
    {
        return None;
    }
    let control = name_text == SUBAGENT_CONTROL;
    let files = FILE_TOOLS
        .contains(&name_text)
        .then(|| field(part, &["state", "structured", "files"]))
        .flatten()
        .and_then(|files| match files {
            JsonValue::Array(files) => Some(JsonValue::Array(
                files.iter().filter_map(file).collect::<Vec<_>>(),
            )),
            _ => None,
        });
    let structured = ObjectEncoder::new()
        .optional("files", &files)
        .optional(
            "sessionID",
            &(name_text == SUBAGENT)
                .then(|| string(part, &["state", "structured", "sessionID"]))
                .flatten(),
        )
        .optional(
            "action",
            &control
                .then(|| string(part, &["state", "structured", "action"]))
                .flatten(),
        )
        .optional(
            "task",
            &control.then(|| {
                ObjectEncoder::new()
                    .optional(
                        "sessionID",
                        &string(part, &["state", "structured", "task", "sessionID"]),
                    )
                    .finish()
            }),
        )
        .finish();
    let status = field(part, &["state", "status"])
        .filter(|status| **status != JsonValue::Null)
        .cloned();
    let id = field(part, &["id"])
        .filter(|id| **id != JsonValue::Null)
        .cloned();
    Some(
        ObjectEncoder::new()
            .field("type", &LosslessString::from("tool"))
            .optional("id", &id)
            .field("name", &name)
            .field(
                "state",
                &ObjectEncoder::new()
                    .optional("status", &status)
                    .optional(
                        "input",
                        &control.then(|| {
                            ObjectEncoder::new()
                                .optional(
                                    "questionID",
                                    &string(part, &["state", "input", "questionID"]),
                                )
                                .finish()
                        }),
                    )
                    .field("structured", &structured)
                    .finish(),
            )
            .finish(),
    )
}

fn file(entry: &JsonValue) -> Option<JsonValue> {
    let patch = string(entry, &["patch"])?;
    Some(
        ObjectEncoder::new()
            .optional("file", &string(entry, &["file"]))
            .field("patch", &patch)
            .optional("status", &string(entry, &["status"]))
            .finish(),
    )
}

fn string(value: &JsonValue, path: &[&str]) -> Option<LosslessString> {
    field(value, path).and_then(text).cloned()
}
