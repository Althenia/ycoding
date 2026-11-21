use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
#[derive(Clone, Debug, PartialEq)]
pub struct VersionData {
    pub version: LosslessString,
}
impl DomainDecode for VersionData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            version: ObjectDecoder::new(v, p)?.field("version")?,
        })
    }
}
impl DomainEncode for VersionData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("version", &self.version)
            .finish()
    }
}
pub struct Updated;
impl crate::event::EventType for Updated {
    const TYPE: &'static str = "installation.updated";
    type Data = VersionData;
}
pub type UpdatedPayload = crate::event::EphemeralPayload<Updated>;
pub struct UpdateAvailable;
impl crate::event::EventType for UpdateAvailable {
    const TYPE: &'static str = "installation.update-available";
    type Data = VersionData;
}
pub type UpdateAvailablePayload = crate::event::EphemeralPayload<UpdateAvailable>;
