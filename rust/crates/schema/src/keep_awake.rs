use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
pub const MAX_MESSAGE_LENGTH: usize = 200;
crate::schema::literal_enum_type!(State,{Off=>"off",On=>"on",Unsupported=>"unsupported",Error=>"error"});
crate::schema::literal_enum_type!(LidState,{Off=>"off",On=>"on",Held=>"held",Unsupported=>"unsupported",Error=>"error"});
#[derive(Clone, Debug, PartialEq)]
pub struct Status {
    pub state: State,
    pub message: Option<LosslessString>,
    pub manual: Option<bool>,
    pub lid: Option<LidState>,
    pub sleep_hold: Option<bool>,
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
            manual: o.optional("manual")?,
            lid: o.optional("lid")?,
            sleep_hold: o.optional("sleepHold")?,
        })
    }
}
impl DomainEncode for Status {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("state", &self.state)
            .optional("message", &self.message)
            .optional("manual", &self.manual)
            .optional("lid", &self.lid)
            .optional("sleepHold", &self.sleep_hold)
            .finish()
    }
}
