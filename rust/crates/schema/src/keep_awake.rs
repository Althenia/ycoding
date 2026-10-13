use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
pub const MAX_MESSAGE_LENGTH: usize = 200;
crate::schema::literal_enum_type!(State,{Off=>"off",On=>"on",Unsupported=>"unsupported",Error=>"error"});
#[derive(Clone, Debug, PartialEq)]
pub struct Status {
    pub state: State,
    pub message: Option<LosslessString>,
}
impl DomainDecode for Status {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let m: Option<LosslessString> = o.optional("message")?;
        if m.as_ref().is_some_and(|s| s.len() > MAX_MESSAGE_LENGTH) {
            return Err(p.key("message").error(crate::DecodeErrorKind::Length {
                minimum: 0,
                maximum: MAX_MESSAGE_LENGTH,
            }));
        }
        Ok(Self {
            state: o.field("state")?,
            message: m,
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
