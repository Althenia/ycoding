use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
#[derive(Clone, Debug, PartialEq)]
pub struct ReadyData {
    pub name: LosslessString,
    pub branch: Option<LosslessString>,
}
impl DomainDecode for ReadyData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            name: o.field("name")?,
            branch: o.optional("branch")?,
        })
    }
}
impl DomainEncode for ReadyData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("name", &self.name)
            .optional("branch", &self.branch)
            .finish()
    }
}
pub struct Ready;
impl crate::event::EventType for Ready {
    const TYPE: &'static str = "worktree.ready";
    type Data = ReadyData;
}
pub type ReadyPayload = crate::event::EphemeralPayload<Ready>;
#[derive(Clone, Debug, PartialEq)]
pub struct FailedData {
    pub message: LosslessString,
}
impl DomainDecode for FailedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            message: ObjectDecoder::new(v, p)?.field("message")?,
        })
    }
}
impl DomainEncode for FailedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("message", &self.message)
            .finish()
    }
}
pub struct Failed;
impl crate::event::EventType for Failed {
    const TYPE: &'static str = "worktree.failed";
    type Data = FailedData;
}
pub type FailedPayload = crate::event::EphemeralPayload<Failed>;
