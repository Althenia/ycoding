use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
#[derive(Clone, Debug, PartialEq)]
pub struct ConnectToken {
    pub ticket: LosslessString,
    pub expires_in: crate::schema::PositiveInt,
    pub access: crate::pty::Access,
    pub generation: crate::pty::Generation,
    pub fence: Option<crate::schema::PositiveInt>,
}
impl DomainDecode for ConnectToken {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            ticket: o.field("ticket")?,
            expires_in: o.field("expires_in")?,
            access: o.field("access")?,
            generation: o.field("generation")?,
            fence: o.optional("fence")?,
        })
    }
}
impl DomainEncode for ConnectToken {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("ticket", &self.ticket)
            .field("expires_in", &self.expires_in)
            .field("access", &self.access)
            .field("generation", &self.generation)
            .optional("fence", &self.fence)
            .finish()
    }
}
