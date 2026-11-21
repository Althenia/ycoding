pub use ycoding_schema::{
    JsonError, JsonObject, JsonValue as Value, LosslessString, parse_json, stringify_json,
};

pub(crate) fn os_text(text: &LosslessString) -> String {
    text.as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| String::from_utf16_lossy(&text.code_units().collect::<Vec<_>>()))
}

pub fn concat(parts: &[&LosslessString]) -> LosslessString {
    LosslessString::from_utf16(parts.iter().flat_map(|part| part.code_units()).collect())
}

pub fn join(parts: &[LosslessString], separator: &str) -> LosslessString {
    let mut units = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            units.extend(separator.encode_utf16());
        }
        units.extend(part.code_units());
    }
    LosslessString::from_utf16(units)
}

pub fn utf8_len(text: &LosslessString) -> usize {
    char::decode_utf16(text.code_units())
        .map(|character| character.unwrap_or(char::REPLACEMENT_CHARACTER).len_utf8())
        .sum()
}

pub fn ascii_lower(text: &LosslessString) -> LosslessString {
    LosslessString::from_utf16(
        text.code_units()
            .map(|unit| {
                if (0x41..=0x5a).contains(&unit) {
                    unit + 0x20
                } else {
                    unit
                }
            })
            .collect(),
    )
}

pub fn trim(text: &LosslessString) -> LosslessString {
    let units = text.code_units().collect::<Vec<_>>();
    let whitespace = |unit: &u16| matches!(*unit, 0x9..=0xd | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff);
    let start = units
        .iter()
        .position(|unit| !whitespace(unit))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|unit| !whitespace(unit))
        .map_or(start, |index| index + 1);
    LosslessString::from_utf16(units[start..end].to_vec())
}

pub(crate) fn from_serde(value: &serde_json::Value) -> Value {
    match value {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(flag) => Value::Bool(*flag),
        serde_json::Value::Number(number) => Value::Number(number.as_f64().unwrap_or(0.0)),
        serde_json::Value::String(text) => Value::String(LosslessString::from(text.as_str())),
        serde_json::Value::Array(items) => Value::Array(items.iter().map(from_serde).collect()),
        serde_json::Value::Object(map) => {
            let mut object = JsonObject::new();
            for (key, item) in map {
                object.insert(LosslessString::from(key.as_str()), from_serde(item));
            }
            Value::Object(object)
        }
    }
}

pub fn object_get<'a>(object: &'a JsonObject, key: &str) -> Option<&'a Value> {
    object.get(&LosslessString::from(key))
}
