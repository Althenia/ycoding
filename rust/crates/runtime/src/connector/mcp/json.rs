use super::NESTING_DEPTH;
use ycoding_core::ycoding_schema::{JsonObject, JsonValue, LosslessString, parse_json};
use ycoding_protocol::domain_json::Domain;

pub(super) enum Unparsed {
    Nesting,
    Invalid,
}

pub(super) fn parse(body: &str) -> Result<JsonValue, Unparsed> {
    if !within_nesting(body) {
        return Err(Unparsed::Nesting);
    }
    if body.is_empty() {
        return Err(Unparsed::Invalid);
    }
    parse_json(body).map_err(|_| Unparsed::Invalid)
}

fn within_nesting(body: &str) -> bool {
    let mut depth = 0usize;
    let mut string = false;
    let mut escaped = false;
    for byte in body.bytes() {
        if string {
            match byte {
                _ if escaped => escaped = false,
                b'\\' => escaped = true,
                b'"' => string = false,
                _ => {}
            }
            continue;
        }
        match byte {
            b'"' => string = true,
            b'[' | b'{' => {
                depth += 1;
                if depth > NESTING_DEPTH {
                    return false;
                }
            }
            b']' | b'}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    true
}

pub(super) fn get<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&key.into()),
        _ => None,
    }
}

pub(super) fn text(value: &JsonValue) -> Option<&str> {
    match value {
        JsonValue::String(text) => text.as_str(),
        _ => None,
    }
}

pub(super) fn string(value: &str) -> JsonValue {
    JsonValue::String(value.into())
}

pub(super) fn object<const N: usize>(entries: [(&str, JsonValue); N]) -> JsonValue {
    let mut object = JsonObject::new();
    for (key, value) in entries {
        object.insert(key.into(), value);
    }
    JsonValue::Object(object)
}

pub(super) fn extend(value: JsonValue, entries: Vec<(&str, JsonValue)>) -> JsonValue {
    let JsonValue::Object(mut object) = value else {
        return value;
    };
    for (key, value) in entries {
        object.insert(key.into(), value);
    }
    JsonValue::Object(object)
}

pub(crate) fn domain(value: &JsonValue) -> Domain {
    match value {
        JsonValue::Null => Domain::Null,
        JsonValue::Bool(flag) => Domain::Bool(*flag),
        JsonValue::Number(number) => Domain::Number(*number),
        JsonValue::String(text) => Domain::Text(text.code_units().collect()),
        JsonValue::Array(items) => Domain::List(items.iter().map(domain).collect()),
        JsonValue::Object(object) => Domain::Object(
            object
                .iter()
                .map(|(key, value)| (key.code_units().collect(), domain(value)))
                .collect(),
        ),
    }
}

pub(crate) fn value(domain: &Domain) -> JsonValue {
    match domain {
        Domain::Null => JsonValue::Null,
        Domain::Bool(flag) => JsonValue::Bool(*flag),
        Domain::Number(number) => JsonValue::Number(*number),
        Domain::Text(units) => JsonValue::String(LosslessString::from_utf16(units.clone())),
        Domain::Bytes(bytes) => string(&base64(bytes)),
        Domain::List(items) => JsonValue::Array(items.iter().map(value).collect()),
        Domain::Object(entries) => {
            let mut object = JsonObject::new();
            for (key, item) in entries {
                object.insert(LosslessString::from_utf16(key.clone()), value(item));
            }
            JsonValue::Object(object)
        }
    }
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub(super) fn base64_len(bytes: usize) -> usize {
    bytes.div_ceil(3) * 4
}

pub(crate) fn base64(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(base64_len(bytes.len()));
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..4 {
            output.push(if index > chunk.len() {
                '='
            } else {
                ALPHABET[(value >> (18 - index * 6) & 63) as usize] as char
            });
        }
    }
    output
}

pub(crate) fn unbase64(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut output = Vec::with_capacity(bytes.len() / 4 * 3);
    for (position, chunk) in bytes.chunks(4).enumerate() {
        let last = position + 1 == bytes.len() / 4;
        let padding = chunk.iter().rev().take_while(|byte| **byte == b'=').count();
        if padding > 2 || (padding > 0 && !last) {
            return None;
        }
        let mut value = 0u32;
        for byte in &chunk[..4 - padding] {
            value = (value << 6) | ALPHABET.iter().position(|item| item == byte)? as u32;
        }
        value <<= 6 * padding as u32;
        output.extend(&value.to_be_bytes()[1..4 - padding]);
    }
    Some(output)
}
