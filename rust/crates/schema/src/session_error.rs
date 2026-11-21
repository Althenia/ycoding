use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
#[derive(Clone, Debug, PartialEq)]
pub struct Error {
    pub r#type: LosslessString,
    pub message: LosslessString,
}
impl DomainDecode for Error {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            r#type: object.field("type")?,
            message: object.field("message")?,
        })
    }
}
impl DomainEncode for Error {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &self.r#type)
            .field("message", &self.message)
            .finish()
    }
}
