use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
pub const MAX_MESSAGE_LENGTH: usize = 200;
crate::schema::literal_enum_type!(State,{Off=>"off",On=>"on",Unsupported=>"unsupported",Error=>"error"});
crate::schema::literal_enum_type!(LidState,{Off=>"off",On=>"on",Held=>"held",Unsupported=>"unsupported",Error=>"error"});
crate::schema::literal_enum_type!(SystemState,{Off=>"off",On=>"on",Held=>"held",Setup=>"setup",Unsupported=>"unsupported",Error=>"error"});
#[derive(Clone, Debug, PartialEq)]
pub struct Status {
    pub state: State,
    pub message: Option<LosslessString>,
    pub manual: Option<bool>,
    pub lid: Option<LidState>,
    pub defer_hold: Option<bool>,
    pub system: Option<SystemState>,
    pub display: Option<State>,
    pub activity: Option<State>,
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
            defer_hold: o.optional("deferHold")?,
            system: o.optional("system")?,
            display: o.optional("display")?,
            activity: o.optional("activity")?,
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
            .optional("deferHold", &self.defer_hold)
            .optional("system", &self.system)
            .optional("display", &self.display)
            .optional("activity", &self.activity)
            .finish()
    }
}
