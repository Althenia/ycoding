use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
pub type Id = LosslessString;
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub id: Id,
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            id: ObjectDecoder::new(v, p)?.field("id")?,
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().field("id", &self.id).finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct AddedData {
    pub id: Id,
}
impl DomainDecode for AddedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            id: ObjectDecoder::new(v, p)?.field("id")?,
        })
    }
}
impl DomainEncode for AddedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().field("id", &self.id).finish()
    }
}
pub struct Added;
impl crate::event::EventType for Added {
    const TYPE: &'static str = "plugin.added";
    type Data = AddedData;
}
pub type AddedPayload = crate::event::EphemeralPayload<Added>;
pub struct Updated;
impl crate::event::EventType for Updated {
    const TYPE: &'static str = "plugin.updated";
    type Data = crate::server_event::ConnectedData;
}
pub type UpdatedPayload = crate::event::EphemeralPayload<Updated>;
