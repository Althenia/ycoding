use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder,
};
pub const MAX_VALUE_BYTES: usize = 8192;
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct Key(LosslessString);
impl DomainDecode for Key {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let s = LosslessString::decode_at(v, p)?;
        if s.as_str().is_some_and(|x| {
            x.as_bytes()
                .first()
                .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
                && x.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
        }) {
            Ok(Self(s))
        } else {
            Err(p.error(DecodeErrorKind::Expected("instruction entry key")))
        }
    }
}
impl DomainEncode for Key {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub key: Key,
    pub value: crate::domain::Json,
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            key: o.field("key")?,
            value: o.field("value")?,
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("key", &self.key)
            .field("value", &self.value)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ValueTooLargeError {
    pub actual_bytes: crate::schema::Int,
    pub max_bytes: crate::schema::Int,
    pub message: LosslessString,
}
impl DomainDecode for ValueTooLargeError {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal(
            "_tag",
            &JsonValue::String("InstructionEntryValueTooLargeError".into()),
        )?;
        Ok(Self {
            actual_bytes: o.field("actualBytes")?,
            max_bytes: o.field("maxBytes")?,
            message: o.field("message")?,
        })
    }
}
impl DomainEncode for ValueTooLargeError {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field(
                "_tag",
                &LosslessString::from("InstructionEntryValueTooLargeError"),
            )
            .field("actualBytes", &self.actual_bytes)
            .field("maxBytes", &self.max_bytes)
            .field("message", &self.message)
            .finish()
    }
}
