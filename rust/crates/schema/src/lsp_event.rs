use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, ObjectDecoder, ObjectEncoder,
};
pub struct UpdatedData;
impl DomainDecode for UpdatedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        ObjectDecoder::new(v, p)?;
        Ok(Self)
    }
}
impl DomainEncode for UpdatedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().finish()
    }
}
pub struct Updated;
impl crate::event::EventType for Updated {
    const TYPE: &'static str = "lsp.updated";
    type Data = UpdatedData;
}
pub type UpdatedPayload = crate::event::EphemeralPayload<Updated>;
