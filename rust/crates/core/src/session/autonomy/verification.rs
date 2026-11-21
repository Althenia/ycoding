use crate::session::family;
use std::ops::Bound;
use ycoding_schema::{DomainEncode, JsonValue, session, session_message};
use ycoding_store::{Client, IndexOrder, session::Message};

pub fn required_checks(objective: &str) -> Vec<String> {
    let mut commands = Vec::new();
    let mut plain = String::new();
    let mut rest = objective;
    while let Some(start) = rest.find('`') {
        plain.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('`').filter(|end| !after[..*end].contains('\n')) else {
            plain.push('`');
            rest = after;
            continue;
        };
        let command = normalize(&after[..end]);
        if command.contains(' ') || script(&command) {
            commands.push(command);
        }
        plain.push(' ');
        rest = &after[end + 1..];
    }
    plain.push_str(rest);
    let bytes = plain.as_bytes();
    let mut cursor = 0;
    while cursor < bytes.len() {
        if bytes[cursor] == b'.' && (cursor == 0 || !path_byte(bytes[cursor - 1])) {
            let end = bytes[cursor..]
                .iter()
                .position(|byte| !path_byte(*byte))
                .map_or(bytes.len(), |length| cursor + length);
            let candidate = plain[cursor..end].trim_end_matches('.');
            if script(candidate) {
                commands.push(candidate.to_owned());
            }
            cursor = end.max(cursor + 1);
        } else {
            cursor += 1;
        }
    }
    let mut unique = Vec::new();
    for command in commands {
        if !unique.contains(&command) {
            unique.push(command);
        }
    }
    unique
}

fn path_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'/' | b'-')
}
fn script(path: &str) -> bool {
    (path.starts_with("./") || path.starts_with("../"))
        && path.bytes().all(path_byte)
        && [".sh", ".bash", ".zsh", ".ps1", ".cmd", ".bat"]
            .iter()
            .any(|suffix| path.ends_with(suffix))
}
fn normalize(command: &str) -> String {
    command.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&key.into()),
        _ => None,
    }
}
fn string<'a>(value: &'a JsonValue, key: &str) -> Option<&'a str> {
    match field(value, key)? {
        JsonValue::String(value) => value.as_str(),
        _ => None,
    }
}
fn content(value: &JsonValue) -> &[JsonValue] {
    match field(value, "content") {
        Some(JsonValue::Array(parts)) => parts,
        _ => &[],
    }
}
fn status(part: &JsonValue) -> Option<&str> {
    string(field(part, "state")?, "status")
}
fn settled_at(part: &JsonValue) -> Option<f64> {
    let time = field(part, "time")?;
    match field(time, "completed").or_else(|| field(time, "created")) {
        Some(JsonValue::Number(time)) => Some(*time),
        _ => None,
    }
}
fn work(part: &JsonValue) -> bool {
    string(part, "type") == Some("tool") && string(part, "name").is_some_and(|name| name != "goal")
}
fn unsettled(part: &JsonValue) -> bool {
    matches!(status(part), Some("streaming" | "running"))
}
fn calls(part: &JsonValue) -> Vec<JsonValue> {
    if string(part, "type") != Some("tool") {
        return Vec::new();
    }
    let Some(state) = field(part, "state") else {
        return Vec::new();
    };
    if string(part, "name") == Some("execute") {
        return field(state, "structured")
            .and_then(|structured| field(structured, "toolCalls"))
            .and_then(|value| match value {
                JsonValue::Array(calls) => Some(calls.clone()),
                _ => None,
            })
            .unwrap_or_default();
    }
    let mut state = match state {
        JsonValue::Object(state) => state.clone(),
        _ => return Vec::new(),
    };
    if let Some(name) = field(part, "name") {
        state.insert("name".into(), name.clone());
    }
    vec![JsonValue::Object(state)]
}
fn change(call: &JsonValue) -> bool {
    string(call, "status") == Some("completed")
        && matches!(string(call, "name"), Some("edit" | "write" | "patch"))
}

fn rows(client: &Client, owner: &session::Id) -> Result<Vec<Message>, ycoding_store::Error> {
    let snapshot = client.snapshot()?;
    let family = family::members(
        &mut family::Reader::Snapshot(&snapshot),
        owner.as_lossless(),
    )?;
    let mut rows = Vec::new();
    for member in family {
        let mut after = None;
        loop {
            let page = ycoding_store::session::messages(
                &snapshot,
                &member,
                Bound::Unbounded,
                Bound::Unbounded,
                IndexOrder::Ascending,
                after.as_ref(),
                128,
            )?;
            if page.is_empty() {
                break;
            }
            after = page.last().map(|row| row.cursor.clone());
            rows.extend(page.into_iter().map(|row| row.record));
        }
    }
    Ok(rows)
}

pub(crate) fn check_rejection(
    client: &Client,
    owner: &session::Id,
    objective: &str,
) -> Result<Option<(String, String)>, ycoding_store::Error> {
    let checks = required_checks(objective);
    if checks.is_empty() {
        return Ok(None);
    }
    let mut calls = rows(client, owner)?
        .into_iter()
        .filter(|row| row.type_.as_str() == Some("assistant"))
        .flat_map(|row| {
            content(&row.data)
                .iter()
                .flat_map(|part| {
                    calls(part)
                        .into_iter()
                        .map(|call| (settled_at(part).unwrap_or(row.time_created as f64), call))
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    calls.sort_by(|left, right| left.0.total_cmp(&right.0));
    let Some(last_change) = calls.iter().rposition(|(_, call)| change(call)) else {
        return Ok(None);
    };
    let mut unmet = Vec::new();
    for check in checks {
        let latest = calls.iter().rposition(|(_, call)| {
            string(call, "name") == Some("shell")
                && matches!(string(call, "status"), Some("completed" | "error"))
                && field(call, "input")
                    .and_then(|input| string(input, "command"))
                    .is_some_and(|command| runs(command, &check))
        });
        let state = match latest {
            None => Some("is unrun"),
            Some(index) if index < last_change => Some("is stale since the latest edit"),
            Some(index) if !passed(&calls[index].1) => Some("is failing"),
            Some(_) => None,
        };
        if let Some(state) = state {
            unmet.push((check, state));
        }
    }
    if unmet.is_empty() {
        return Ok(None);
    }
    Ok(Some((
        format!(
            "Goal cannot complete: {}.",
            unmet
                .iter()
                .map(|(check, state)| format!("Required check {check} {state}"))
                .collect::<Vec<_>>()
                .join("; ")
        ),
        format!(
            "Rerun {}. Only a passing run after the latest edit, in this Session or one of its descendant Sessions, clears it.",
            unmet
                .iter()
                .map(|(check, _)| check.as_str())
                .collect::<Vec<_>>()
                .join(" and ")
        ),
    )))
}

fn runs(command: &str, check: &str) -> bool {
    let command = normalize(command);
    if !check.starts_with("./") && !check.starts_with("../") {
        return command.contains(check);
    }
    let path = check.strip_prefix("./").unwrap_or(check);
    command.match_indices(path).any(|(start, _)| {
        let before = command[..start]
            .strip_suffix("./")
            .unwrap_or(&command[..start]);
        before
            .chars()
            .next_back()
            .is_none_or(|character| character.is_whitespace() || ";&|(".contains(character))
            && command[start + path.len()..]
                .chars()
                .next()
                .is_none_or(|character| character.is_whitespace() || ";&|)".contains(character))
    })
}
fn passed(call: &JsonValue) -> bool {
    let Some(structured) = field(call, "structured") else {
        return false;
    };
    string(call, "status") == Some("completed")
        && field(structured, "exit") == Some(&JsonValue::Number(0.0))
        && field(structured, "timeout") != Some(&JsonValue::Bool(true))
        && field(structured, "memoryLimit") != Some(&JsonValue::Bool(true))
}

pub(crate) fn repeats_rejection(
    client: &Client,
    owner: &session::Id,
    reason: &str,
) -> Result<bool, ycoding_store::Error> {
    let rows = rows(client, owner)?;
    let parts = rows
        .iter()
        .filter(|row| row.session_id == *owner.as_lossless())
        .flat_map(|row| content(&row.data).iter().map(move |part| (row.seq, part)))
        .collect::<Vec<_>>();
    let Some((sequence, previous)) = parts.iter().rev().find(|(_, part)| {
        let action = field(part, "state").and_then(|state| field(state, "input"));
        string(part, "name") == Some("goal")
            && status(part) == Some("error")
            && action.is_some_and(|input| {
                string(input, "action") == Some("complete")
                    || (string(input, "action") == Some("update")
                        && string(input, "status") == Some("completed"))
            })
    }) else {
        return Ok(false);
    };
    if !field(previous, "state")
        .and_then(|state| field(state, "error"))
        .and_then(|error| string(error, "message"))
        .is_some_and(|message| message.lines().any(|line| line == reason))
    {
        return Ok(false);
    }
    let since = settled_at(previous).unwrap_or(0.0);
    let owner_work = rows.iter().any(|row| {
        row.session_id == *owner.as_lossless()
            && row.seq > *sequence
            && row.type_.as_str() == Some("shell")
    }) || parts
        .iter()
        .any(|(seq, part)| work(part) && (*seq >= *sequence || unsettled(part)));
    let descendant_work = rows
        .iter()
        .filter(|row| row.session_id != *owner.as_lossless())
        .any(|row| {
            row.time_created as f64 > since
                || (row.type_.as_str() == Some("assistant")
                    && !matches!(
                        field(&row.data, "time").and_then(|time| field(time, "completed")),
                        Some(JsonValue::Number(_))
                    ))
                || content(&row.data).iter().any(|part| {
                    work(part) && (unsettled(part) || settled_at(part).unwrap_or(0.0) > since)
                })
        });
    Ok(!owner_work && !descendant_work)
}

pub fn verification(messages: &[session_message::Info]) -> &'static str {
    let calls = messages
        .iter()
        .filter_map(|message| match message {
            session_message::Info::Assistant(assistant) => Some(assistant),
            _ => None,
        })
        .flat_map(|assistant| {
            assistant
                .content
                .iter()
                .flat_map(|part| calls(&part.encode()))
        })
        .filter(|call| string(call, "status") == Some("completed"))
        .collect::<Vec<_>>();
    let Some(last) = calls.iter().rposition(|call| {
        change(call)
            || (string(call, "name") == Some("goal")
                && field(call, "input").is_some_and(|input| {
                    string(input, "action") == Some("rework")
                        && string(input, "state") == Some("opened")
                }))
    }) else {
        return "Verification: no file changes recorded in recent history.";
    };
    if calls
        .iter()
        .rposition(|call| string(call, "name") == Some("shell"))
        .is_some_and(|index| index > last)
    {
        "Verification: a check ran after the latest file change; confirm it passed before completion."
    } else {
        "Verification: files changed or rework opened after the latest check; the next step must run the checks that verify them."
    }
}
