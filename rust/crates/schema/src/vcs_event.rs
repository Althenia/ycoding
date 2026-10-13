use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
#[derive(Clone, Debug, PartialEq)]
pub struct BranchUpdatedData {
    pub branch: Option<LosslessString>,
}
impl DomainDecode for BranchUpdatedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            branch: ObjectDecoder::new(v, p)?.optional("branch")?,
        })
    }
}
impl DomainEncode for BranchUpdatedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("branch", &self.branch)
            .finish()
    }
}
pub struct BranchUpdated;
impl crate::event::EventType for BranchUpdated {
    const TYPE: &'static str = "vcs.branch.updated";
    type Data = BranchUpdatedData;
}
pub type BranchUpdatedPayload = crate::event::EphemeralPayload<BranchUpdated>;
