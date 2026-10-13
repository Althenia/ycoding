use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, ObjectDecoder, ObjectEncoder,
};
#[derive(Clone, Debug, PartialEq)]
pub struct UpdatedData {
    pub project_id: crate::project_id::ProjectId,
}
impl DomainDecode for UpdatedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            project_id: ObjectDecoder::new(v, p)?.field("projectID")?,
        })
    }
}
impl DomainEncode for UpdatedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("projectID", &self.project_id)
            .finish()
    }
}
pub struct Updated;
impl crate::event::EventType for Updated {
    const TYPE: &'static str = "project.directories.updated";
    type Data = UpdatedData;
}
pub type UpdatedPayload = crate::event::EphemeralPayload<Updated>;
