use crate::event::EventType;
pub struct Updated;
impl EventType for Updated {
    const TYPE: &'static str = "catalog.updated";
    type Data = Empty;
}
#[derive(Clone, Debug, PartialEq)]
pub struct Empty;
impl crate::DomainDecode for Empty {
    fn decode_at(v: &crate::JsonValue, p: &crate::JsonPath) -> Result<Self, crate::DecodeError> {
        let _ = crate::ObjectDecoder::new(v, p)?;
        Ok(Self)
    }
}
impl crate::DomainEncode for Empty {
    fn encode(&self) -> crate::JsonValue {
        crate::ObjectEncoder::new().finish()
    }
}
pub fn definition() -> crate::event::Definition {
    crate::event::Definition::ephemeral::<Updated>()
}
