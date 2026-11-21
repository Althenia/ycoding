use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, ObjectDecoder,
    ObjectEncoder, session_id, session_message_id,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ref {
    pub session_id: session_id::SessionId,
    pub input_id: session_message_id::Id,
}

impl DomainDecode for Ref {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let anchor = Self {
            session_id: object.field("sessionID")?,
            input_id: object.field("inputID")?,
        };
        match value {
            JsonValue::Object(fields) if fields.len() == 2 => Ok(anchor),
            _ => Err(path.error(DecodeErrorKind::Expected(
                "object with only sessionID and inputID",
            ))),
        }
    }
}

impl DomainEncode for Ref {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("inputID", &self.input_id)
            .finish()
    }
}
