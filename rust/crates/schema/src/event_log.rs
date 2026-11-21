use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
#[derive(Clone, Debug, PartialEq)]
pub struct Synced {
    pub aggregate_id: LosslessString,
    pub seq: Option<crate::event::Seq>,
}
impl DomainDecode for Synced {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("log.synced".into()))?;
        Ok(Self {
            aggregate_id: o.field("aggregateID")?,
            seq: o.optional("seq")?,
        })
    }
}
impl DomainEncode for Synced {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("log.synced"))
            .field("aggregateID", &self.aggregate_id)
            .optional("seq", &self.seq)
            .finish()
    }
}
