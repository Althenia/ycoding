use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, ObjectDecoder, ObjectEncoder,
};
#[derive(Clone, Debug, PartialEq)]
pub struct CompactedData {
    pub session_id: crate::session_id::SessionId,
}
impl DomainDecode for CompactedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            session_id: ObjectDecoder::new(v, p)?.field("sessionID")?,
        })
    }
}
impl DomainEncode for CompactedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .finish()
    }
}
pub struct Compacted;
impl crate::event::EventType for Compacted {
    const TYPE: &'static str = "session.compacted";
    type Data = CompactedData;
}
pub type CompactedPayload = crate::event::EphemeralPayload<Compacted>;
