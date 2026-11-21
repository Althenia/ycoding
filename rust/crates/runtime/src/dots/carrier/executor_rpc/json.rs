use ycoding_core::ycoding_schema::{
    JsonObject, JsonValue, LosslessString, parse_json, stringify_json,
};

pub const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_ID_UNITS: usize = 256;
const MAX_JSON_NODES: usize = 262_144;
const MAX_JSON_DEPTH: usize = 128;
const SAFE_INTEGER_MAX: f64 = 9_007_199_254_740_991.0;
const U64_LIMIT: f64 = 18_446_744_073_709_551_616.0;

pub fn text(value: &str) -> JsonValue {
    JsonValue::String(LosslessString::from(value))
}

pub fn uint(value: u64) -> JsonValue {
    JsonValue::Number(value as f64)
}

pub fn int(value: i64) -> JsonValue {
    JsonValue::Number(value as f64)
}

pub fn texts(values: &[String]) -> JsonValue {
    JsonValue::Array(values.iter().map(|value| text(value)).collect())
}

pub fn lossless(value: &LosslessString) -> JsonValue {
    JsonValue::String(value.clone())
}

pub fn nullable_text(value: Option<&str>) -> JsonValue {
    value.map_or(JsonValue::Null, text)
}

#[derive(Default)]
pub struct ObjectBuilder(JsonObject);

impl ObjectBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn field(mut self, key: &str, value: JsonValue) -> Self {
        self.0.insert(LosslessString::from(key), value);
        self
    }

    pub fn optional(self, key: &str, value: Option<JsonValue>) -> Self {
        match value {
            Some(value) => self.field(key, value),
            None => self,
        }
    }

    pub fn finish(self) -> JsonValue {
        JsonValue::Object(self.0)
    }
}

pub fn get<'a>(object: &'a JsonObject, key: &str) -> Option<&'a JsonValue> {
    object.get(&LosslessString::from(key))
}

pub fn has(object: &JsonObject, key: &str) -> bool {
    get(object, key).is_some()
}

pub fn lossy(value: &LosslessString) -> String {
    char::decode_utf16(value.code_units())
        .map(|unit| unit.unwrap_or('\u{fffd}'))
        .collect()
}

pub fn truncated_units(value: &LosslessString, units: usize) -> Vec<u16> {
    value.code_units().take(units).collect()
}

pub fn is_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0
}

pub fn is_safe_integer(number: f64) -> bool {
    is_integer(number) && number.abs() <= SAFE_INTEGER_MAX
}

pub fn number_text(number: f64) -> String {
    stringify_json(&JsonValue::Number(number))
}

pub fn string_literal(value: &LosslessString) -> String {
    stringify_json(&JsonValue::String(value.clone()))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NumberStyle {
    Plain,
    Integral,
    IntegralBelowU64,
}

pub fn unexpected(value: &JsonValue, numbers: NumberStyle) -> String {
    match value {
        JsonValue::Null => "null".to_string(),
        JsonValue::Bool(flag) => format!("boolean `{flag}`"),
        JsonValue::Number(number) => match numbers {
            NumberStyle::Plain => "number".to_string(),
            NumberStyle::Integral => integral_text(*number, true),
            NumberStyle::IntegralBelowU64 => {
                integral_text(*number, is_integer(*number) && number.abs() < U64_LIMIT)
            }
        },
        JsonValue::String(value) => format!("string {}", string_literal(value)),
        JsonValue::Array(_) => "sequence".to_string(),
        JsonValue::Object(_) => "map".to_string(),
    }
}

fn integral_text(number: f64, integral: bool) -> String {
    if integral && is_integer(number) {
        format!("integer `{}`", number_text(number))
    } else {
        format!("floating point `{}`", number_text(number))
    }
}

pub fn decode_text(bytes: &[u8]) -> Option<&str> {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf][..]).unwrap_or(bytes);
    std::str::from_utf8(bytes).ok()
}

pub enum ParseFailure {
    Utf8,
    Json,
}

pub fn parse_bytes(bytes: &[u8]) -> Result<JsonValue, ParseFailure> {
    let text = decode_text(bytes).ok_or(ParseFailure::Utf8)?;
    parse_json(text).map_err(|_| ParseFailure::Json)
}

pub fn within_complexity(value: &JsonValue) -> bool {
    let mut nodes = 0usize;
    let mut stack: Vec<(&JsonValue, usize)> = vec![(value, 1)];
    while let Some((item, depth)) = stack.pop() {
        nodes += 1;
        if nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH {
            return false;
        }
        match item {
            JsonValue::Array(values) => {
                for value in values.iter().rev() {
                    stack.push((value, depth + 1));
                }
            }
            JsonValue::Object(object) => {
                for (_, value) in object.iter() {
                    stack.push((value, depth + 1));
                }
            }
            _ => {}
        }
    }
    true
}

#[derive(Clone, Debug, PartialEq)]
pub enum RequestId {
    Text(LosslessString),
    Integer(i64),
}

impl RequestId {
    pub fn unknown() -> Self {
        Self::Integer(-1)
    }

    pub fn from_value(value: &JsonValue) -> Option<Self> {
        match value {
            JsonValue::String(text) if text.len() <= MAX_ID_UNITS => Some(Self::Text(text.clone())),
            JsonValue::Number(number) if is_safe_integer(*number) => {
                Some(Self::Integer(*number as i64))
            }
            _ => None,
        }
    }

    pub fn to_json(&self) -> JsonValue {
        match self {
            Self::Text(text) => JsonValue::String(text.clone()),
            Self::Integer(number) => int(*number),
        }
    }
}

pub fn error_frame(id: &RequestId, code: i64, message: LosslessString) -> Vec<u8> {
    let error = ObjectBuilder::new()
        .field("code", int(code))
        .field("message", JsonValue::String(message))
        .finish();
    let frame = ObjectBuilder::new()
        .field("id", id.to_json())
        .field("error", error)
        .finish();
    stringify_json(&frame).into_bytes()
}

pub fn success_frame(id: &RequestId, result: JsonValue) -> Vec<u8> {
    let frame = ObjectBuilder::new()
        .field("id", id.to_json())
        .field("result", result)
        .finish();
    stringify_json(&frame).into_bytes()
}

pub fn notification_frame(method: &str, params: JsonValue) -> Vec<u8> {
    let frame = ObjectBuilder::new()
        .field("method", text(method))
        .field("params", params)
        .finish();
    stringify_json(&frame).into_bytes()
}

pub fn request_frame(id: u64, method: &str, params: JsonValue) -> Vec<u8> {
    let frame = ObjectBuilder::new()
        .field("id", uint(id))
        .field("method", text(method))
        .field("params", params)
        .finish();
    stringify_json(&frame).into_bytes()
}
