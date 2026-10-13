use crate::Error;
use ycoding_schema::{JsonObject, JsonValue, LosslessString};

pub(super) fn invalid() -> Error {
    Error::Domain {
        kind: "meeting_record",
        message: "corrupt or invalid Meeting record",
    }
}

pub(super) fn text<'a>(value: &'a JsonValue, name: &str) -> Result<&'a LosslessString, Error> {
    match field(value, name)? {
        JsonValue::String(value) => Ok(value),
        _ => Err(invalid()),
    }
}

pub(super) fn field<'a>(value: &'a JsonValue, name: &str) -> Result<&'a JsonValue, Error> {
    let JsonValue::Object(value) = value else {
        return Err(invalid());
    };
    value.get(&name.into()).ok_or_else(invalid)
}

pub(super) fn number(value: &JsonValue, name: &str) -> Result<f64, Error> {
    match field(value, name)? {
        JsonValue::Number(value) => Ok(*value),
        _ => Err(invalid()),
    }
}

pub(super) fn set(value: &mut JsonValue, name: &str, field: JsonValue) -> Result<(), Error> {
    let JsonValue::Object(value) = value else {
        return Err(invalid());
    };
    value.insert(name.into(), field);
    Ok(())
}

pub(super) fn parse(kind: Kind, value: &LosslessString) -> Result<JsonValue, Error> {
    let value =
        ycoding_schema::parse_json(value.as_str().ok_or_else(invalid)?).map_err(|_| invalid())?;
    document(kind, &value)
}

#[derive(Clone, Copy)]
pub(super) enum Kind {
    Meeting,
    Segment,
    Finding,
    Reference,
    Proposal,
    Checkpoint,
    Plan,
    Approval,
    Job,
    Create,
    Patch,
}

enum Rule {
    Text,
    Id,
    Time,
    Nonnegative,
    Sequence,
    Confidence,
    Boolean,
    Ids,
    References,
    Enum(&'static [&'static str]),
}
type Definition = (&'static str, Rule, bool);
const STATUSES: &[&str] = &[
    "ready",
    "recording",
    "stopping",
    "stopped",
    "interrupted",
    "error",
];

pub(super) fn document(kind: Kind, value: &JsonValue) -> Result<JsonValue, Error> {
    let definitions: &[Definition] = match kind {
        Kind::Meeting => &[
            ("id", Rule::Id, false),
            ("title", Rule::Text, false),
            ("sessionID", Rule::Id, false),
            ("status", Rule::Enum(STATUSES), false),
            ("createdAt", Rule::Time, false),
            ("updatedAt", Rule::Time, false),
            ("captureID", Rule::Id, true),
            ("error", Rule::Text, true),
        ],
        Kind::Create => &[
            ("id", Rule::Id, false),
            ("title", Rule::Text, false),
            ("sessionID", Rule::Id, false),
        ],
        Kind::Patch => &[
            ("status", Rule::Enum(STATUSES), true),
            ("captureID", Rule::Id, true),
            ("error", Rule::Text, true),
        ],
        Kind::Segment => &[
            ("id", Rule::Id, false),
            ("meetingID", Rule::Id, false),
            ("sequence", Rule::Sequence, false),
            ("source", Rule::Enum(&["remote", "microphone"]), false),
            ("speakerID", Rule::Id, false),
            ("startMs", Rule::Nonnegative, false),
            ("endMs", Rule::Nonnegative, false),
            ("rawText", Rule::Text, false),
            ("text", Rule::Text, false),
            ("state", Rule::Enum(&["temporary", "final"]), false),
            ("model", Rule::Id, false),
            ("createdAt", Rule::Time, false),
        ],
        Kind::Finding => &[
            ("id", Rule::Id, false),
            ("meetingID", Rule::Id, false),
            (
                "kind",
                Rule::Enum(&[
                    "topic",
                    "decision",
                    "proposal",
                    "requirement",
                    "action",
                    "risk",
                    "blocker",
                    "disagreement",
                    "question",
                    "claim",
                ]),
                false,
            ),
            ("summary", Rule::Text, false),
            ("sourceSegmentIds", Rule::Ids, false),
            ("speakerId", Rule::Id, true),
            ("owner", Rule::Text, true),
            ("deadline", Rule::Text, true),
            ("confidence", Rule::Confidence, false),
            (
                "status",
                Rule::Enum(&["unconfirmed", "confirmed", "rejected"]),
                false,
            ),
            ("createdAt", Rule::Time, false),
        ],
        Kind::Reference => &[
            ("server", Rule::Id, false),
            ("target", Rule::Id, false),
            ("revision", Rule::Text, false),
            ("content", Rule::Text, false),
            ("retrievedAt", Rule::Time, false),
        ],
        Kind::Proposal => &[
            ("id", Rule::Id, false),
            ("meetingID", Rule::Id, false),
            ("server", Rule::Id, false),
            ("target", Rule::Id, false),
            ("operation", Rule::Enum(&["replace"]), false),
            ("existingContent", Rule::Text, false),
            ("suggestedContent", Rule::Text, false),
            ("explanation", Rule::Text, false),
            ("sourceSegmentIds", Rule::Ids, false),
            ("references", Rule::References, false),
            ("expectedRevision", Rule::Text, false),
            ("confidence", Rule::Confidence, false),
            (
                "status",
                Rule::Enum(&[
                    "pending",
                    "approved",
                    "rejected",
                    "stale",
                    "applying",
                    "applied",
                    "uncertain",
                    "failed",
                    "manual",
                ]),
                false,
            ),
            ("createdAt", Rule::Time, false),
            ("error", Rule::Text, true),
        ],
        Kind::Checkpoint => &[
            ("id", Rule::Id, false),
            ("meetingID", Rule::Id, false),
            ("throughSequence", Rule::Sequence, false),
            ("summary", Rule::Text, false),
            ("final", Rule::Boolean, false),
            ("createdAt", Rule::Time, false),
            ("latencyMs", Rule::Nonnegative, false),
        ],
        Kind::Plan => &[
            ("meetingID", Rule::Id, false),
            ("content", Rule::Text, false),
            ("findingIds", Rule::Ids, false),
            ("sourceSegmentIds", Rule::Ids, false),
            (
                "status",
                Rule::Enum(&["proposed", "approved", "rejected"]),
                false,
            ),
            ("createdAt", Rule::Time, false),
        ],
        Kind::Approval => &[
            ("id", Rule::Id, false),
            ("meetingID", Rule::Id, false),
            ("targetID", Rule::Id, false),
            (
                "decision",
                Rule::Enum(&["approve", "reject", "correct"]),
                false,
            ),
            ("detail", Rule::Text, false),
            ("createdAt", Rule::Time, false),
        ],
        Kind::Job => &[
            ("id", Rule::Id, false),
            ("meetingID", Rule::Id, false),
            (
                "kind",
                Rule::Enum(&["transcription", "analysis", "knowledge"]),
                false,
            ),
            (
                "status",
                Rule::Enum(&["pending", "running", "done", "failed", "interrupted"]),
                false,
            ),
            ("attempts", Rule::Sequence, false),
            ("error", Rule::Text, true),
            ("updatedAt", Rule::Time, false),
        ],
    };
    let JsonValue::Object(object) = value else {
        return Err(invalid());
    };
    if object.iter().any(|(name, _)| {
        !definitions
            .iter()
            .any(|(expected, _, _)| name == &(*expected).into())
    }) {
        return Err(invalid());
    }
    let mut output = JsonObject::new();
    for (name, rule, optional) in definitions {
        let Some(value) = object.get(&(*name).into()) else {
            if *optional {
                continue;
            }
            return Err(invalid());
        };
        let valid = match (rule, value) {
            (Rule::Text, JsonValue::String(_)) => true,
            (Rule::Id, JsonValue::String(value)) => !value.is_empty(),
            (Rule::Time, JsonValue::String(value)) => value.as_str().is_some_and(timestamp),
            (Rule::Enum(values), JsonValue::String(value)) => {
                value.as_str().is_some_and(|value| values.contains(&value))
            }
            (Rule::Nonnegative, JsonValue::Number(value)) => value.is_finite() && *value >= 0.0,
            (Rule::Sequence, JsonValue::Number(value)) => {
                value.is_finite()
                    && *value >= 0.0
                    && value.fract() == 0.0
                    && *value <= 9_007_199_254_740_991.0
            }
            (Rule::Confidence, JsonValue::Number(value)) => {
                value.is_finite() && (0.0..=1.0).contains(value)
            }
            (Rule::Boolean, JsonValue::Bool(_)) => true,
            (Rule::Ids, JsonValue::Array(values)) => values
                .iter()
                .all(|value| matches!(value, JsonValue::String(value) if !value.is_empty())),
            (Rule::References, JsonValue::Array(values)) => {
                output.insert(
                    (*name).into(),
                    JsonValue::Array(
                        values
                            .iter()
                            .map(|value| document(Kind::Reference, value))
                            .collect::<Result<_, _>>()?,
                    ),
                );
                continue;
            }
            _ => false,
        };
        if !valid {
            return Err(invalid());
        }
        output.insert((*name).into(), value.clone());
    }
    let output = JsonValue::Object(output);
    if matches!(kind, Kind::Segment)
        && (number(&output, "endMs")? < number(&output, "startMs")?
            || text(&output, "rawText")?.code_units().all(js_space))
    {
        return Err(invalid());
    }
    Ok(output)
}

fn js_space(unit: u16) -> bool {
    matches!(unit, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

pub(super) fn timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 17
        || !bytes.is_ascii()
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
    {
        return false;
    }
    let integer = |range: std::ops::Range<usize>| {
        value.get(range).and_then(|value| {
            value
                .bytes()
                .all(|byte| byte.is_ascii_digit())
                .then(|| value.parse::<u32>().ok())
                .flatten()
        })
    };
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute)) = (
        integer(0..4),
        integer(5..7),
        integer(8..10),
        integer(11..13),
        integer(14..16),
    ) else {
        return false;
    };
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        _ => return false,
    };
    if day == 0 || day > days || hour > 23 || minute > 59 {
        return false;
    }
    let rest = &value[16..];
    let rest = if rest.starts_with(':') {
        if rest.len() < 3
            || !rest[1..3].bytes().all(|byte| byte.is_ascii_digit())
            || !rest[1..3].parse::<u32>().is_ok_and(|value| value <= 59)
        {
            return false;
        }
        &rest[3..]
    } else {
        rest
    };
    let rest = if let Some(rest) = rest.strip_prefix('.') {
        let digits = rest
            .bytes()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        if digits == 0 || bytes.get(16) != Some(&b':') {
            return false;
        }
        &rest[digits..]
    } else {
        rest
    };
    rest == "Z"
        || (rest.len() == 6
            && matches!(rest.as_bytes()[0], b'+' | b'-')
            && rest.as_bytes()[3] == b':'
            && rest[1..3].bytes().all(|byte| byte.is_ascii_digit())
            && rest[4..6].bytes().all(|byte| byte.is_ascii_digit())
            && rest[1..3].parse::<u32>().is_ok_and(|value| value <= 23)
            && rest[4..6].parse::<u32>().is_ok_and(|value| value <= 59))
}
