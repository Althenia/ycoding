use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, ObjectDecoder, ObjectEncoder,
};
pub struct ConnectedData;
impl DomainDecode for ConnectedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        ObjectDecoder::new(v, p)?;
        Ok(Self)
    }
}
impl DomainEncode for ConnectedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().finish()
    }
}
pub struct Connected;
impl crate::event::EventType for Connected {
    const TYPE: &'static str = "server.connected";
    type Data = ConnectedData;
}
pub type ConnectedPayload = crate::event::EphemeralPayload<Connected>;
pub struct DisposedData;
impl DomainDecode for DisposedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        ObjectDecoder::new(v, p)?;
        Ok(Self)
    }
}
impl DomainEncode for DisposedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().finish()
    }
}
pub struct Disposed;
impl crate::event::EventType for Disposed {
    const TYPE: &'static str = "global.disposed";
    type Data = DisposedData;
}
pub type DisposedPayload = crate::event::EphemeralPayload<Disposed>;
