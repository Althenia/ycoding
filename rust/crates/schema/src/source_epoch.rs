use crate::{DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString};

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct SourceEpoch(LosslessString);
impl SourceEpoch {
    pub fn new(value: impl Into<LosslessString>) -> Result<Self, DecodeError> {
        Self::decode(&JsonValue::String(value.into()))
    }
    pub fn as_lossless(&self) -> &LosslessString {
        &self.0
    }
}
impl DomainDecode for SourceEpoch {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        crate::domain::bounded_string(value, 1, usize::MAX, path).map(Self)
    }
}
impl DomainEncode for SourceEpoch {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
