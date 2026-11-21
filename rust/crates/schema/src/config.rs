use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
#[derive(Clone, Debug, PartialEq)]
pub struct DiagnosticReason(pub LosslessString);
impl DomainDecode for DiagnosticReason {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        crate::domain::literal_enum(v, &["invalid-json", "invalid-values", "removed-keys"], p)
            .map(Self)
    }
}
impl DomainEncode for DiagnosticReason {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Diagnostic {
    pub path: LosslessString,
    pub reason: DiagnosticReason,
    pub json_path: Option<LosslessString>,
    pub fail_closed: Option<bool>,
    pub message: LosslessString,
}
impl DomainDecode for Diagnostic {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            path: o.field("path")?,
            reason: o
                .tag(
                    "reason",
                    &["invalid-json", "invalid-values", "removed-keys"],
                )
                .map(DiagnosticReason)?,
            json_path: o.optional("jsonPath")?,
            fail_closed: o.optional("failClosed")?,
            message: o.field("message")?,
        })
    }
}
impl DomainEncode for Diagnostic {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("path", &self.path)
            .field("reason", &self.reason)
            .optional("jsonPath", &self.json_path)
            .optional("failClosed", &self.fail_closed)
            .field("message", &self.message)
            .finish()
    }
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
pub struct Updated;
impl crate::event::EventType for Updated {
    const TYPE: &'static str = "config.updated";
    type Data = Empty;
}
pub fn definition() -> crate::event::Definition {
    crate::event::Definition::ephemeral::<Updated>()
}
