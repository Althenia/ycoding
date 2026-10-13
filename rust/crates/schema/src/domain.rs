use crate::{JsonObject, JsonValue, LosslessString, stringify_json};
use std::fmt;

#[derive(Clone, Debug, PartialEq)]
pub enum PathSegment {
    Key(LosslessString),
    Index(usize),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct JsonPath(pub Vec<PathSegment>);

impl JsonPath {
    pub fn key(&self, key: impl Into<LosslessString>) -> Self {
        let mut path = self.clone();
        path.0.push(PathSegment::Key(key.into()));
        path
    }

    pub fn index(&self, index: usize) -> Self {
        let mut path = self.clone();
        path.0.push(PathSegment::Index(index));
        path
    }

    pub fn error(&self, kind: DecodeErrorKind) -> DecodeError {
        DecodeError {
            path: self.clone(),
            kind,
        }
    }
}

impl fmt::Display for JsonPath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "$")?;
        for segment in &self.0 {
            match segment {
                PathSegment::Key(key) => write!(
                    formatter,
                    "[{}]",
                    stringify_json(&JsonValue::String(key.clone()))
                )?,
                PathSegment::Index(index) => write!(formatter, "[{index}]")?,
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum DecodeErrorKind {
    Expected(&'static str),
    Missing,
    Literal(Vec<JsonValue>),
    Prefix(&'static str),
    NumberRange {
        minimum: f64,
        maximum: f64,
        integer: bool,
    },
    Length {
        minimum: usize,
        maximum: usize,
    },
    InvalidTimestamp,
}

#[derive(Clone, Debug, PartialEq, thiserror::Error)]
#[error("{path}: {kind:?}")]
pub struct DecodeError {
    pub path: JsonPath,
    pub kind: DecodeErrorKind,
}

pub trait DomainDecode: Sized {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError>;

    fn decode(value: &JsonValue) -> Result<Self, DecodeError> {
        Self::decode_at(value, &JsonPath::default())
    }
}

pub trait DomainEncode {
    fn encode(&self) -> JsonValue;
}

#[derive(Clone, Debug, PartialEq)]
pub enum Presence<T> {
    Absent,
    Null,
    Value(T),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Nullable<T> {
    Null,
    Value(T),
}

impl<T: DomainDecode> DomainDecode for Nullable<T> {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        match value {
            JsonValue::Null => Ok(Self::Null),
            value => T::decode_at(value, path).map(Self::Value),
        }
    }
}

impl<T: DomainEncode> DomainEncode for Nullable<T> {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Null => JsonValue::Null,
            Self::Value(value) => value.encode(),
        }
    }
}

pub struct ObjectDecoder<'a> {
    object: &'a JsonObject,
    path: &'a JsonPath,
}

impl<'a> ObjectDecoder<'a> {
    pub fn new(value: &'a JsonValue, path: &'a JsonPath) -> Result<Self, DecodeError> {
        let JsonValue::Object(object) = value else {
            return Err(path.error(DecodeErrorKind::Expected("object")));
        };
        Ok(Self { object, path })
    }

    pub fn field<T: DomainDecode>(&self, key: &str) -> Result<T, DecodeError> {
        let path = self.path.key(key);
        let value = self
            .object
            .get(&key.into())
            .ok_or_else(|| path.error(DecodeErrorKind::Missing))?;
        T::decode_at(value, &path)
    }

    pub fn optional<T: DomainDecode>(&self, key: &str) -> Result<Option<T>, DecodeError> {
        self.object
            .get(&key.into())
            .map(|value| T::decode_at(value, &self.path.key(key)))
            .transpose()
    }

    pub fn presence<T: DomainDecode>(&self, key: &str) -> Result<Presence<T>, DecodeError> {
        match self.object.get(&key.into()) {
            None => Ok(Presence::Absent),
            Some(JsonValue::Null) => Ok(Presence::Null),
            Some(value) => T::decode_at(value, &self.path.key(key)).map(Presence::Value),
        }
    }

    pub fn literal(&self, key: &str, expected: &JsonValue) -> Result<(), DecodeError> {
        let value: JsonValue = self.field(key)?;
        literal(&value, std::slice::from_ref(expected), &self.path.key(key)).map(|_| ())
    }

    pub fn tag(&self, key: &str, allowed: &[&str]) -> Result<LosslessString, DecodeError> {
        literal_enum(&self.field::<JsonValue>(key)?, allowed, &self.path.key(key))
    }
}

#[derive(Default)]
pub struct ObjectEncoder(JsonObject);

impl ObjectEncoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn field(mut self, key: &str, value: &(impl DomainEncode + ?Sized)) -> Self {
        self.0.insert(key.into(), value.encode());
        self
    }

    pub fn optional<T: DomainEncode>(self, key: &str, value: &Option<T>) -> Self {
        match value {
            Some(value) => self.field(key, value),
            None => self,
        }
    }

    pub fn presence<T: DomainEncode>(self, key: &str, value: &Presence<T>) -> Self {
        match value {
            Presence::Absent => self,
            Presence::Null => self.field(key, &JsonValue::Null),
            Presence::Value(value) => self.field(key, value),
        }
    }

    pub fn finish(self) -> JsonValue {
        JsonValue::Object(self.0)
    }
}

pub fn literal(
    value: &JsonValue,
    allowed: &[JsonValue],
    path: &JsonPath,
) -> Result<JsonValue, DecodeError> {
    if let Some(literal) = allowed.iter().find(|literal| *literal == value) {
        return Ok(literal.clone());
    }
    Err(path.error(DecodeErrorKind::Literal(allowed.to_vec())))
}

pub fn literal_enum(
    value: &JsonValue,
    allowed: &[&str],
    path: &JsonPath,
) -> Result<LosslessString, DecodeError> {
    let text = LosslessString::decode_at(value, path)?;
    if allowed
        .iter()
        .any(|allowed| text == LosslessString::from(*allowed))
    {
        return Ok(text);
    }
    Err(path.error(DecodeErrorKind::Literal(
        allowed
            .iter()
            .map(|text| JsonValue::String((*text).into()))
            .collect(),
    )))
}

pub fn branded_string(
    value: &JsonValue,
    prefix: &'static str,
    path: &JsonPath,
) -> Result<LosslessString, DecodeError> {
    let text = LosslessString::decode_at(value, path)?;
    if text
        .code_units()
        .take(prefix.encode_utf16().count())
        .eq(prefix.encode_utf16())
    {
        return Ok(text);
    }
    Err(path.error(DecodeErrorKind::Prefix(prefix)))
}

pub fn bounded_string(
    value: &JsonValue,
    minimum: usize,
    maximum: usize,
    path: &JsonPath,
) -> Result<LosslessString, DecodeError> {
    let text = LosslessString::decode_at(value, path)?;
    if (minimum..=maximum).contains(&text.len()) {
        return Ok(text);
    }
    Err(path.error(DecodeErrorKind::Length { minimum, maximum }))
}

pub fn finite_number(value: &JsonValue, path: &JsonPath) -> Result<f64, DecodeError> {
    let number = f64::decode_at(value, path)?;
    if number.is_finite() {
        return Ok(number);
    }
    Err(path.error(DecodeErrorKind::Expected("finite number")))
}

pub fn number_range(
    value: &JsonValue,
    minimum: f64,
    maximum: f64,
    path: &JsonPath,
) -> Result<f64, DecodeError> {
    let number = f64::decode_at(value, path)?;
    if number >= minimum && number <= maximum {
        return Ok(number);
    }
    Err(path.error(DecodeErrorKind::NumberRange {
        minimum,
        maximum,
        integer: false,
    }))
}

#[derive(Clone, Debug, PartialEq)]
pub struct Json(JsonValue);
impl Json {
    pub fn new(value: JsonValue) -> Result<Self, DecodeError> {
        validate_json(&value, &JsonPath::default())?;
        Ok(Self(value))
    }
    pub fn as_value(&self) -> &JsonValue {
        &self.0
    }
    pub fn into_value(self) -> JsonValue {
        self.0
    }
}
impl DomainDecode for Json {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        validate_json(value, path)?;
        Ok(Self(value.clone()))
    }
}
impl DomainEncode for Json {
    fn encode(&self) -> JsonValue {
        self.0.clone()
    }
}
fn validate_json(value: &JsonValue, path: &JsonPath) -> Result<(), DecodeError> {
    let mut pending = vec![(value, path.clone())];
    while let Some((value, path)) = pending.pop() {
        match value {
            JsonValue::Number(number) if !number.is_finite() => {
                return Err(path.error(DecodeErrorKind::Expected("finite number")));
            }
            JsonValue::Array(values) => pending.extend(
                values
                    .iter()
                    .enumerate()
                    .rev()
                    .map(|(index, value)| (value, path.index(index))),
            ),
            JsonValue::Object(object) => pending.extend(
                object
                    .iter()
                    .rev()
                    .map(|(key, value)| (value, path.key(key.clone()))),
            ),
            _ => {}
        }
    }
    Ok(())
}

pub fn integer_range(
    value: &JsonValue,
    minimum: i64,
    maximum: i64,
    path: &JsonPath,
) -> Result<f64, DecodeError> {
    let number = f64::decode_at(value, path)?;
    if number.is_finite()
        && number.fract() == 0.0
        && number.abs() <= 9_007_199_254_740_991.0
        && number >= minimum as f64
        && number <= maximum as f64
    {
        return Ok(number);
    }
    Err(path.error(DecodeErrorKind::NumberRange {
        minimum: minimum as f64,
        maximum: maximum as f64,
        integer: true,
    }))
}

impl DomainDecode for LosslessString {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        match value {
            JsonValue::String(text) => Ok(text.clone()),
            _ => Err(path.error(DecodeErrorKind::Expected("string"))),
        }
    }
}
impl DomainEncode for LosslessString {
    fn encode(&self) -> JsonValue {
        JsonValue::String(self.clone())
    }
}
impl DomainEncode for str {
    fn encode(&self) -> JsonValue {
        JsonValue::String(self.into())
    }
}
impl DomainDecode for f64 {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        match value {
            JsonValue::Number(number) => Ok(*number),
            _ => Err(path.error(DecodeErrorKind::Expected("number"))),
        }
    }
}
impl DomainEncode for f64 {
    fn encode(&self) -> JsonValue {
        JsonValue::Number(*self)
    }
}
impl DomainDecode for bool {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        match value {
            JsonValue::Bool(value) => Ok(*value),
            _ => Err(path.error(DecodeErrorKind::Expected("boolean"))),
        }
    }
}
impl DomainEncode for bool {
    fn encode(&self) -> JsonValue {
        JsonValue::Bool(*self)
    }
}
impl DomainDecode for JsonValue {
    fn decode_at(value: &JsonValue, _: &JsonPath) -> Result<Self, DecodeError> {
        Ok(value.clone())
    }
}
impl DomainEncode for JsonValue {
    fn encode(&self) -> JsonValue {
        self.clone()
    }
}
impl DomainDecode for JsonObject {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        match value {
            JsonValue::Object(object) => Ok(object.clone()),
            _ => Err(path.error(DecodeErrorKind::Expected("object"))),
        }
    }
}
impl DomainEncode for JsonObject {
    fn encode(&self) -> JsonValue {
        JsonValue::Object(self.clone())
    }
}
impl<T: DomainDecode> DomainDecode for Vec<T> {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let JsonValue::Array(values) = value else {
            return Err(path.error(DecodeErrorKind::Expected("array")));
        };
        values
            .iter()
            .enumerate()
            .map(|(index, value)| T::decode_at(value, &path.index(index)))
            .collect()
    }
}
impl<T: DomainEncode> DomainEncode for Vec<T> {
    fn encode(&self) -> JsonValue {
        JsonValue::Array(self.iter().map(DomainEncode::encode).collect())
    }
}
