use super::protobuf::{self, Field};
use crate::{Error, json};
use ycoding_schema::{JsonValue, LosslessString};

pub(crate) struct Call {
    pub id: String,
    pub name: &'static str,
    pub input: JsonValue,
    pub todos: Option<Vec<JsonValue>>,
}
pub(crate) fn snapshot(value: &JsonValue) -> Option<Vec<JsonValue>> {
    let JsonValue::Array(todos) = value else {
        return None;
    };
    Some(
        todos
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let string = |key| {
                    json::get(item, key)
                        .and_then(json::string)
                        .filter(|value| !value.is_empty())
                        .cloned()
                };
                let status = string("status")
                    .map(|value| {
                        value
                            .to_utf8()
                            .unwrap_or_default()
                            .to_lowercase()
                            .trim_start_matches("todo_status_")
                            .to_owned()
                    })
                    .unwrap_or_else(|| {
                        match json::get(item, "status").and_then(json::number) {
                            Some(2.0) => "in_progress",
                            Some(3.0) => "completed",
                            Some(4.0) => "cancelled",
                            _ => "pending",
                        }
                        .into()
                    });
                json::object([
                    (
                        "id",
                        json::s(
                            string("id").unwrap_or_else(|| format!("todo_{}", index + 1).into()),
                        ),
                    ),
                    (
                        "content",
                        json::s(
                            json::get(item, "content")
                                .and_then(json::string)
                                .cloned()
                                .unwrap_or_default(),
                        ),
                    ),
                    (
                        "status",
                        json::s(if status == "unspecified" {
                            "pending"
                        } else {
                            &status
                        }),
                    ),
                    (
                        "priority",
                        json::s(string("priority").unwrap_or_else(|| "medium".into())),
                    ),
                ])
            })
            .filter(|item| {
                json::get(item, "id")
                    .and_then(json::string)
                    .is_none_or(|id| id != &"plan".into())
            })
            .collect(),
    )
}
pub(crate) fn read_snapshot(output: &str) -> Option<Vec<JsonValue>> {
    let value = ycoding_schema::parse_json(output).ok()?;
    snapshot(json::get(&value, "todos").unwrap_or(&value))
}
pub(crate) fn completed(bytes: &[u8], prior: &[JsonValue]) -> Result<Option<Call>, Error> {
    let fields = protobuf::fields(bytes)?;
    let id = text(&fields, 1)?;
    if id.is_empty() {
        return Ok(None);
    }
    let Some(call) = fields.iter().rev().find(|field| field.number == 2) else {
        return Ok(None);
    };
    let call = protobuf::fields(call.bytes()?)?;
    let Some(variant) = call
        .iter()
        .find(|field| [9, 10, 17].contains(&field.number))
    else {
        return Ok(None);
    };
    if variant.number == 10 {
        return Ok(Some(Call {
            id,
            name: "todoread",
            input: json::empty(),
            todos: None,
        }));
    }
    let fields = protobuf::fields(variant.bytes()?)?;
    let args = fields
        .iter()
        .rev()
        .find(|field| field.number == 1)
        .map(|field| field.bytes())
        .transpose()?
        .map(protobuf::fields)
        .transpose()?;
    let result = fields
        .iter()
        .rev()
        .find(|field| field.number == 2)
        .map(|field| field.bytes())
        .transpose()?
        .map(protobuf::fields)
        .transpose()?
        .unwrap_or_default();
    let success = result
        .iter()
        .rev()
        .find(|field| field.number == 1)
        .map(|field| field.bytes())
        .transpose()?
        .map(protobuf::fields)
        .transpose()?
        .unwrap_or_default();
    let completed = success
        .iter()
        .filter(|field| field.number == 1)
        .map(|field| field.bytes())
        .collect::<Result<Vec<_>, _>>()?;
    let Some(args) = args else {
        if completed.is_empty() {
            return Ok(None);
        }
        let todos = parse_todos(&completed)?;
        return Ok(Some(Call {
            id,
            name: "todowrite",
            input: json::object([("todos", JsonValue::Array(todos.clone()))]),
            todos: Some(todos),
        }));
    };
    let todo_field = if variant.number == 17 { 2 } else { 1 };
    let patches = args
        .iter()
        .filter(|field| field.number == todo_field)
        .map(|field| field.bytes())
        .collect::<Result<Vec<_>, _>>()?;
    let merge = variant.number == 9
        && args
            .iter()
            .rev()
            .find(|field| field.number == 2)
            .map(|field| field.varint())
            .transpose()?
            .is_some_and(|value| value != 0);
    let mut todos = if !completed.is_empty() {
        parse_todos(&completed)?
    } else if merge {
        if prior.is_empty() {
            return Ok(None);
        }
        let mut todos = prior.iter().fold(Vec::new(), |mut todos, item| {
            if let Some(index) = todos
                .iter()
                .position(|known| json::get(known, "id") == json::get(item, "id"))
            {
                todos[index] = item.clone();
                return todos;
            }
            todos.push(item.clone());
            todos
        });
        for (index, bytes) in patches.iter().enumerate() {
            let fields = protobuf::fields(bytes)?;
            let patch = todo(&fields, index)?;
            let content = text(&fields, 2)?;
            let found = todos
                .iter()
                .position(|item| json::get(item, "id") == json::get(&patch, "id"))
                .or_else(|| {
                    (!content.trim().is_empty())
                        .then(|| {
                            todos.iter().position(|item| {
                                json::get(item, "content")
                                    .and_then(json::string)
                                    .is_some_and(|value| {
                                        value
                                            .to_utf8()
                                            .is_ok_and(|value| value.trim() == content.trim())
                                    })
                            })
                        })
                        .flatten()
                });
            if let Some(found) = found {
                if !content.is_empty() {
                    json::set(&mut todos[found], "content", json::s(content));
                }
                if fields.iter().any(|field| field.number == 3) {
                    json::set(
                        &mut todos[found],
                        "status",
                        json::get(&patch, "status")
                            .cloned()
                            .ok_or_else(|| Error::output("Cursor todo patch has no status"))?,
                    );
                }
                continue;
            }
            if !content.trim().is_empty() {
                todos.push(patch);
            }
        }
        todos
    } else {
        parse_todos(&patches)?
    };
    if variant.number == 17 {
        let plan = text(&args, 1)?.trim().to_owned();
        let overview = text(&args, 3)?.trim().to_owned();
        let name = text(&args, 4)?.trim().to_owned();
        let content = [
            if name.is_empty() {
                String::new()
            } else {
                format!("Plan: {name}")
            },
            overview,
            plan,
        ]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
        if !content.is_empty() {
            todos.insert(
                0,
                json::object([
                    ("id", json::s("plan")),
                    (
                        "content",
                        json::s(LosslessString::from_utf16(
                            content.encode_utf16().take(2000).collect(),
                        )),
                    ),
                    ("status", json::s("completed")),
                    ("priority", json::s("high")),
                ]),
            );
        }
        if todos.is_empty() {
            return Ok(None);
        }
    }
    Ok(Some(Call {
        id,
        name: "todowrite",
        input: json::object([("todos", JsonValue::Array(todos.clone()))]),
        todos: (variant.number == 9).then_some(todos),
    }))
}
fn parse_todos(items: &[&[u8]]) -> Result<Vec<JsonValue>, Error> {
    items
        .iter()
        .enumerate()
        .map(|(index, bytes)| todo(&protobuf::fields(bytes)?, index))
        .collect()
}
fn todo(fields: &[Field<'_>], index: usize) -> Result<JsonValue, Error> {
    let id = text(fields, 1)?;
    let status = fields
        .iter()
        .rev()
        .find(|field| field.number == 3)
        .map(|field| field.uint32())
        .transpose()?
        .unwrap_or(0);
    Ok(json::object([
        (
            "id",
            json::s(if id.is_empty() {
                format!("todo_{}", index + 1)
            } else {
                id
            }),
        ),
        ("content", json::s(text(fields, 2)?)),
        (
            "status",
            json::s(match status {
                2 => "in_progress",
                3 => "completed",
                4 => "cancelled",
                _ => "pending",
            }),
        ),
        ("priority", json::s("medium")),
    ]))
}
fn text(fields: &[Field<'_>], number: u32) -> Result<String, Error> {
    fields
        .iter()
        .rev()
        .find(|field| field.number == number)
        .map(|field| field.text())
        .transpose()
        .map(|value| value.unwrap_or_default())
}
