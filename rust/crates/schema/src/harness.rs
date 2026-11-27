use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    domain,
};

crate::schema::literal_enum_type!(Stage,{Baseline=>"baseline",Propose=>"propose",Probe=>"probe",Compose=>"compose",Adopt=>"adopt"});
crate::schema::literal_enum_type!(Mode,{Adaptive=>"adaptive",Parallel=>"parallel",Sequential=>"sequential",Disabled=>"disabled"});
pub fn outcome(value: &JsonValue, path: &JsonPath) -> Result<LosslessString, DecodeError> {
    domain::bounded_string(value, 1, 64, path)
}

pub fn identifier(value: &JsonValue, path: &JsonPath) -> Result<LosslessString, DecodeError> {
    domain::bounded_string(value, 1, 128, path)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Experiences(pub Vec<LosslessString>);
impl DomainDecode for Experiences {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let JsonValue::Array(items) = v else {
            return Err(p.error(DecodeErrorKind::Expected("array")));
        };
        if items.len() > 64 {
            return Err(p.error(DecodeErrorKind::Expected("at most 64 experiences")));
        }
        items
            .iter()
            .enumerate()
            .map(|(index, item)| identifier(item, &p.index(index)))
            .collect::<Result<Vec<_>, _>>()
            .map(Self)
    }
}
impl DomainEncode for Experiences {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
