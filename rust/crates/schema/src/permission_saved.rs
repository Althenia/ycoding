use crate::project_id::ProjectId;
use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct Id(pub LosslessString);
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub id: Id,
    pub project_id: ProjectId,
    pub action: LosslessString,
    pub resource: LosslessString,
}
impl DomainDecode for Id {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        LosslessString::decode_at(v, p).map(Self)
    }
}
impl DomainEncode for Id {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            project_id: o.field("projectID")?,
            action: o.field("action")?,
            resource: o.field("resource")?,
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("projectID", &self.project_id)
            .field("action", &self.action)
            .field("resource", &self.resource)
            .finish()
    }
}
