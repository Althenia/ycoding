use super::{Error, field, list, malformed, string};
use crate::dots::access::ConversationProblem;
use ycoding_schema::{JsonValue, LosslessString, ObjectEncoder};

pub(super) fn identity(value: &JsonValue) -> Result<String, Error> {
    let JsonValue::String(value) = value else {
        return Err(malformed());
    };
    if value.is_empty() || value.len() > 256 {
        return Err(malformed());
    }
    value.to_utf8().map_err(|_| malformed())
}

fn optional(value: &JsonValue, key: &str, limit: usize) -> Option<LosslessString> {
    match field(value, key) {
        JsonValue::String(value) => Some(slice(value, limit)),
        _ => None,
    }
}

fn required<'a>(value: &'a JsonValue, key: &str) -> Result<&'a LosslessString, Error> {
    match field(value, key) {
        JsonValue::String(value) => Ok(value),
        _ => Err(malformed()),
    }
}

fn slice(value: &LosslessString, limit: usize) -> LosslessString {
    LosslessString::from_utf16(value.code_units().take(limit).collect())
}

fn strict_optional(
    value: &JsonValue,
    key: &str,
    limit: usize,
) -> Result<Option<LosslessString>, Error> {
    match field(value, key) {
        JsonValue::Null => Ok(None),
        JsonValue::String(value) => Ok(Some(slice(value, limit))),
        _ => Err(malformed()),
    }
}

fn label(value: &JsonValue, key: &str, limit: usize) -> Option<LosslessString> {
    let JsonValue::String(value) = field(value, key) else {
        return None;
    };
    let clean = value
        .code_units()
        .map(|unit| {
            if unit <= 31 || (127..=159).contains(&unit) {
                32
            } else {
                unit
            }
        })
        .collect::<Vec<_>>();
    let clean = crate::dots::access::trim_units(&clean);
    (!clean.is_empty())
        .then(|| LosslessString::from_utf16(clean.iter().copied().take(limit).collect()))
}

pub(super) fn details(value: &JsonValue) -> ObjectEncoder {
    let status = field(value, "status");
    let state = match string(status, "type") {
        Some("idle") => Some("idle"),
        Some("notLoaded") => Some("not-loaded"),
        Some("systemError") => Some("error"),
        Some("active") => {
            let flags = field(status, "activeFlags");
            match flags {
                JsonValue::Array(flags)
                    if flags.contains(&JsonValue::String("waitingOnApproval".into())) =>
                {
                    Some("waiting-approval")
                }
                JsonValue::Array(flags)
                    if flags.contains(&JsonValue::String("waitingOnUserInput".into())) =>
                {
                    Some("waiting-input")
                }
                _ => Some("active"),
            }
        }
        _ => None,
    };
    let updated = match field(value, "updatedAt") {
        JsonValue::Number(value) if value.is_finite() && *value >= 0.0 => Some(value.floor()),
        _ => None,
    };
    ObjectEncoder::new()
        .optional("name", &label(value, "name", 256))
        .optional("preview", &label(value, "preview", 500))
        .optional("status", &state.map(LosslessString::from))
        .optional("updatedAt", &updated)
}

fn timestamp(value: &JsonValue, key: &str) -> Result<String, Error> {
    let value = string(value, key)
        .filter(|value| !value.is_empty() && value.len() <= 64)
        .ok_or_else(malformed)?;
    chrono::DateTime::parse_from_rfc3339(value).map_err(|_| malformed())?;
    Ok(value.into())
}

pub(super) fn task(value: &JsonValue) -> Result<JsonValue, Error> {
    let title = required(value, "title")?;
    let status = string(value, "status")
        .filter(|value| identifier(value, false))
        .ok_or_else(malformed)?;
    Ok(ObjectEncoder::new()
        .field("taskID", identity(field(value, "id"))?.as_str())
        .field("title", &slice(title, 500))
        .field("status", status)
        .optional("description", &strict_optional(value, "description", 4000)?)
        .optional(
            "latestUpdate",
            &strict_optional(value, "latest_update", 4000)?,
        )
        .optional("emoji", &strict_optional(value, "emoji", 16)?)
        .field("createdAt", timestamp(value, "created_at")?.as_str())
        .field("updatedAt", timestamp(value, "updated_at")?.as_str())
        .finish())
}

pub(super) fn update(value: &JsonValue, task: &str) -> Result<JsonValue, Error> {
    if string(value, "task_id") != Some(task) {
        return Err(malformed());
    }
    Ok(ObjectEncoder::new()
        .field("updateID", identity(field(value, "id"))?.as_str())
        .field("text", &slice(required(value, "text")?, 8000))
        .field("createdAt", timestamp(value, "created_at")?.as_str())
        .finish())
}

fn identifier(value: &str, upper: bool) -> bool {
    let mut chars = value.bytes();
    value.len() <= 64
        && chars
            .next()
            .is_some_and(|ch| ch.is_ascii_lowercase() || (upper && ch.is_ascii_uppercase()))
        && chars.all(|ch| {
            ch.is_ascii_lowercase()
                || (upper && ch.is_ascii_uppercase())
                || ch.is_ascii_digit()
                || ch == b'_'
                || (!upper && ch == b'-')
        })
}

fn item(value: &JsonValue) -> Result<JsonValue, Error> {
    let kind = string(value, "type")
        .filter(|value| identifier(value, true))
        .ok_or_else(malformed)?;
    let output = ObjectEncoder::new()
        .field("itemID", identity(field(value, "id"))?.as_str())
        .field("type", kind);
    Ok(match kind {
        "userMessage" | "agentMessage" => {
            let content = if kind == "agentMessage" {
                required(value, "text")?.clone()
            } else {
                let mut units = Vec::new();
                let mut joined = false;
                for part in list(value, "content")? {
                    if !matches!(part, JsonValue::Object(_)) {
                        return Err(malformed());
                    }
                    if string(part, "type") != Some("text") {
                        continue;
                    }
                    if joined {
                        units.push(10);
                    }
                    joined = true;
                    units.extend(required(part, "text")?.code_units());
                }
                LosslessString::from_utf16(units)
            };
            output
                .field("text", &slice(&content, 65536))
                .optional("truncated", &(content.len() > 65536).then_some(true))
                .finish()
        }
        "commandExecution" => {
            let exit = match field(value, "exitCode") {
                JsonValue::Null => None,
                JsonValue::Number(number) if number.is_finite() && number.fract() == 0.0 => {
                    Some(*number)
                }
                _ => return Err(malformed()),
            };
            output
                .field("command", &slice(required(value, "command")?, 8192))
                .optional("exitCode", &exit)
                .finish()
        }
        "fileChange" => {
            let paths = list(value, "changes")?
                .iter()
                .take(100)
                .map(|change| required(change, "path").map(|path| slice(path, 4096)))
                .collect::<Result<Vec<_>, _>>()?;
            output.field("paths", &paths).finish()
        }
        _ => ObjectEncoder::new()
            .field("itemID", identity(field(value, "id"))?.as_str())
            .field("type", "other")
            .field("itemType", kind)
            .finish(),
    })
}

pub(super) fn turn(value: &JsonValue) -> Result<JsonValue, Error> {
    let items = list(value, "items")?;
    if items.len() > 500 {
        return Err(malformed());
    }
    let status = string(value, "status")
        .filter(|status| ["inProgress", "completed", "interrupted", "failed"].contains(status));
    Ok(ObjectEncoder::new()
        .field("turnID", identity(field(value, "id"))?.as_str())
        .optional("status", &status.map(LosslessString::from))
        .field(
            "items",
            &items.iter().map(item).collect::<Result<Vec<_>, _>>()?,
        )
        .finish())
}

pub(super) fn pending(id: &str, method: &str, params: &JsonValue) -> JsonValue {
    let kind = match method {
        "item/commandExecution/requestApproval" => "command-approval",
        "item/fileChange/requestApproval" => "file-change-approval",
        "item/permissions/requestApproval" => "permissions-approval",
        _ => "user-input",
    };
    let questions = match field(params, "questions") {
        JsonValue::Array(values) if kind == "user-input" => Some(
            values
                .iter()
                .take(16)
                .filter_map(|value| {
                    let id = required(value, "id")
                        .ok()
                        .filter(|id| !id.is_empty() && id.len() <= 256)?;
                    let question = required(value, "question").ok()?;
                    let options = match field(value, "options") {
                        JsonValue::Array(values) => Some(
                            values
                                .iter()
                                .take(32)
                                .filter_map(|option| {
                                    Some(
                                        ObjectEncoder::new()
                                            .field(
                                                "label",
                                                &slice(required(option, "label").ok()?, 256),
                                            )
                                            .optional(
                                                "description",
                                                &optional(option, "description", 1000),
                                            )
                                            .finish(),
                                    )
                                })
                                .collect::<Vec<_>>(),
                        ),
                        _ => None,
                    };
                    Some(
                        ObjectEncoder::new()
                            .field("questionID", id)
                            .field("question", &slice(question, 2000))
                            .optional("header", &optional(value, "header", 256))
                            .optional("options", &options)
                            .finish(),
                    )
                })
                .collect::<Vec<_>>(),
        ),
        _ => None,
    };
    ObjectEncoder::new()
        .field("requestID", id)
        .field("threadID", field(params, "threadId"))
        .field("kind", kind)
        .optional(
            "turnID",
            &string(params, "turnId")
                .filter(|value| !value.is_empty() && value.len() <= 256)
                .map(LosslessString::from),
        )
        .optional("reason", &optional(params, "reason", 2000))
        .optional("command", &optional(params, "command", 8192))
        .optional("cwd", &optional(params, "cwd", 4096))
        .optional("questions", &questions)
        .finish()
}

pub(super) fn answer(
    method: &str,
    params: &JsonValue,
    input: &JsonValue,
) -> Result<JsonValue, Error> {
    let invalid = || Error::new(ConversationProblem::InvalidAnswer);
    if method == "item/permissions/requestApproval" {
        return Err(Error::new(ConversationProblem::Unsupported));
    }
    if method != "item/tool/requestUserInput" {
        let decision = string(input, "decision")
            .filter(|value| ["accept", "acceptForSession", "decline", "cancel"].contains(value))
            .ok_or_else(invalid)?;
        if !matches!(field(input, "answers"), JsonValue::Null) {
            return Err(invalid());
        }
        return Ok(ObjectEncoder::new().field("decision", decision).finish());
    }
    if !matches!(field(input, "decision"), JsonValue::Null) {
        return Err(invalid());
    }
    let JsonValue::Object(answers) = field(input, "answers") else {
        return Err(invalid());
    };
    if answers.is_empty() {
        return Err(invalid());
    }
    let known = list(params, "questions")?;
    let mut output = ycoding_schema::JsonObject::new();
    for (key, value) in answers.iter() {
        if !known
            .iter()
            .any(|question| field(question, "id") == &JsonValue::String(key.clone()))
        {
            return Err(invalid());
        }
        let JsonValue::Array(values) = value else {
            return Err(invalid());
        };
        if values.is_empty()
            || values.len() > 16
            || values
                .iter()
                .any(|value| !matches!(value, JsonValue::String(value) if value.len() <= 4000))
        {
            return Err(invalid());
        }
        output.insert(
            key.clone(),
            ObjectEncoder::new().field("answers", value).finish(),
        );
    }
    Ok(ObjectEncoder::new()
        .field("answers", &JsonValue::Object(output))
        .finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ycoding_schema::parse_json;

    #[test]
    fn optional_statuses_encode_as_strings_and_unknown_statuses_stay_absent() {
        let input =
            parse_json(r#"{"status":{"type":"active","activeFlags":["waitingOnApproval"]}}"#)
                .unwrap();
        assert_eq!(
            details(&input).finish(),
            parse_json(r#"{"status":"waiting-approval"}"#).unwrap()
        );
        assert_eq!(
            details(&JsonValue::Null).finish(),
            ObjectEncoder::new().finish()
        );
        let input = parse_json(r#"{"id":"turn_one","status":"completed","items":[]}"#).unwrap();
        assert_eq!(
            turn(&input).unwrap_or_else(|_| panic!("valid turn projection rejected")),
            parse_json(r#"{"turnID":"turn_one","status":"completed","items":[]}"#).unwrap()
        );
        let input = parse_json(r#"{"id":"turn_one","status":"unknown","items":[]}"#).unwrap();
        assert_eq!(
            turn(&input).unwrap_or_else(|_| panic!("valid turn projection rejected")),
            parse_json(r#"{"turnID":"turn_one","items":[]}"#).unwrap()
        );
    }

    #[test]
    fn pending_turn_identity_is_optional_and_bounded() {
        for (turn, included) in [
            ("t".repeat(256), true),
            ("t".repeat(257), false),
            (String::new(), false),
        ] {
            let params = ObjectEncoder::new()
                .field("threadId", "thread_one")
                .field("turnId", turn.as_str())
                .finish();
            let output = pending(
                "request_one",
                "item/commandExecution/requestApproval",
                &params,
            );
            if included {
                assert_eq!(field(&output, "turnID"), &JsonValue::String(turn.into()));
            } else {
                let JsonValue::Object(fields) = output else {
                    panic!("expected a projected request");
                };
                assert!(fields.get(&"turnID".into()).is_none());
            }
        }
    }
}
