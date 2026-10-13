use ycoding_schema::{JsonObject, JsonValue, LosslessString};

pub fn object(
    fields: impl IntoIterator<Item = (impl Into<LosslessString>, JsonValue)>,
) -> JsonValue {
    let mut object = JsonObject::new();
    for (key, value) in fields {
        object.insert(key.into(), value);
    }
    JsonValue::Object(object)
}
pub fn get<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&key.into()),
        _ => None,
    }
}
pub fn string(value: &JsonValue) -> Option<&LosslessString> {
    match value {
        JsonValue::String(text) => Some(text),
        _ => None,
    }
}
pub fn text(value: &JsonValue) -> Option<&str> {
    string(value).and_then(LosslessString::as_str)
}
pub fn number(value: &JsonValue) -> Option<f64> {
    match value {
        JsonValue::Number(number) => Some(*number),
        _ => None,
    }
}
pub fn boolean(value: &JsonValue) -> Option<bool> {
    if let JsonValue::Bool(value) = value {
        Some(*value)
    } else {
        None
    }
}
pub fn js_string(value: &JsonValue) -> LosslessString {
    match value {
        JsonValue::String(value) => value.clone(),
        JsonValue::Object(_) => "[object Object]".into(),
        JsonValue::Array(values) => {
            let mut result = LosslessString::default();
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    concat(&mut result, &",".into());
                }
                if !matches!(value, JsonValue::Null) {
                    concat(&mut result, &js_string(value));
                }
            }
            result
        }
        _ => ycoding_schema::stringify_json(value).into(),
    }
}
pub fn array(value: &JsonValue) -> Option<&[JsonValue]> {
    match value {
        JsonValue::Array(values) => Some(values),
        _ => None,
    }
}
pub fn set(value: &mut JsonValue, key: impl Into<LosslessString>, field: JsonValue) {
    if let JsonValue::Object(object) = value {
        object.insert(key.into(), field);
    }
}
pub fn remove(value: &JsonValue, keys: &[&str]) -> JsonValue {
    match value {
        JsonValue::Object(fields) => object(
            fields
                .iter()
                .filter(|(key, _)| !keys.contains(&key.as_str().unwrap_or("")))
                .cloned(),
        ),
        _ => value.clone(),
    }
}
pub fn merge(left: &JsonValue, right: &JsonValue) -> JsonValue {
    let (JsonValue::Object(_), JsonValue::Object(fields)) = (left, right) else {
        return right.clone();
    };
    let mut merged = left.clone();
    for (key, value) in fields.iter() {
        let next = match &merged {
            JsonValue::Object(object) => object.get(key).map(|prior| merge(prior, value)),
            _ => None,
        };
        set(
            &mut merged,
            key.clone(),
            next.unwrap_or_else(|| value.clone()),
        );
    }
    merged
}
pub fn empty() -> JsonValue {
    JsonValue::Object(JsonObject::new())
}
pub fn s(value: impl Into<LosslessString>) -> JsonValue {
    JsonValue::String(value.into())
}
pub fn concat(left: &mut LosslessString, right: &LosslessString) {
    *left = LosslessString::from_utf16(left.code_units().chain(right.code_units()).collect());
}
pub fn contains(haystack: &LosslessString, needle: &LosslessString) -> bool {
    let needle = needle.code_units().collect::<Vec<_>>();
    needle.is_empty()
        || haystack
            .code_units()
            .collect::<Vec<_>>()
            .windows(needle.len())
            .any(|value| value == needle)
}
pub fn nonblank(value: &LosslessString) -> bool {
    value.code_units().any(|unit| !matches!(unit, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028..=0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff))
}
pub fn parse_tool_input(raw: &LosslessString) -> Result<JsonValue, ()> {
    if raw.is_empty() {
        return ycoding_schema::parse_json("{}").map_err(|_| ());
    }
    let mut text = String::new();
    let mut quoted = false;
    let mut escaped = false;
    for unit in char::decode_utf16(raw.code_units()) {
        match unit {
            Ok(ch) => {
                text.push(ch);
                if escaped {
                    escaped = false;
                } else if ch == '\\' && quoted {
                    escaped = true;
                } else if ch == '"' {
                    quoted = !quoted;
                }
            }
            Err(unit) => {
                if quoted && !escaped {
                    text.push_str(&format!("\\u{:04x}", unit.unpaired_surrogate()));
                } else {
                    return Err(());
                }
            }
        }
    }
    ycoding_schema::parse_json(&text).map_err(|_| ())
}
