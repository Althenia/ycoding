use crate::schema::NonNegativeInt;
use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, ObjectDecoder, ObjectEncoder,
};

#[derive(Clone, Debug, PartialEq)]
pub struct Receipt {
    pub id: crate::event::Id,
    pub seq: crate::event::Seq,
    pub created: NonNegativeInt,
    pub session_id: crate::session_id::SessionId,
    pub input_id: crate::session_message_id::Id,
    pub assistant_message_id: crate::session_message_id::Id,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Page {
    pub data: Vec<Receipt>,
    pub next: Option<crate::session_id::SessionId>,
}

impl DomainDecode for Receipt {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            id: object.field("id")?,
            seq: object.field("seq")?,
            created: object.field("created")?,
            session_id: object.field("sessionID")?,
            input_id: object.field("inputID")?,
            assistant_message_id: object.field("assistantMessageID")?,
        })
    }
}
impl DomainEncode for Receipt {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("seq", &self.seq)
            .field("created", &self.created)
            .field("sessionID", &self.session_id)
            .field("inputID", &self.input_id)
            .field("assistantMessageID", &self.assistant_message_id)
            .finish()
    }
}
impl DomainDecode for Page {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            data: object.field("data")?,
            next: object.optional("next")?,
        })
    }
}
impl DomainEncode for Page {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("data", &self.data)
            .optional("next", &self.next)
            .finish()
    }
}
