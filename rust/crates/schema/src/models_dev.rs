use crate::event::{Definition, EventType};
use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, ObjectDecoder, ObjectEncoder,
};
pub struct Refreshed;
impl EventType for Refreshed {
    const TYPE: &'static str = "models-dev.refreshed";
    type Data = Empty;
}
#[derive(Clone, Debug, PartialEq)]
pub struct Empty;
impl DomainDecode for Empty {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let _ = ObjectDecoder::new(v, p)?;
        Ok(Self)
    }
}
impl DomainEncode for Empty {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().finish()
    }
}
pub fn definitions() -> [Definition; 1] {
    [Refreshed::definition()]
}
impl Refreshed {
    pub fn definition() -> Definition {
        Definition::ephemeral::<Self>()
    }
}
