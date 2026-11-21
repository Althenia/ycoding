use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
crate::schema::literal_enum_type!(State,{Off=>"off",Connecting=>"connecting",On=>"on",Error=>"error"});
#[derive(Clone, Debug, PartialEq)]
pub struct Status {
    pub state: State,
    pub message: Option<LosslessString>,
}
impl DomainDecode for Status {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            state: o.field("state")?,
            message: o.optional("message")?,
        })
    }
}
impl DomainEncode for Status {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("state", &self.state)
            .optional("message", &self.message)
            .finish()
    }
}
