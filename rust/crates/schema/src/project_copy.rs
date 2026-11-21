use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder,
};
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct StrategyId(LosslessString);
impl DomainDecode for StrategyId {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let s = LosslessString::decode_at(v, p)?;
        let units: Vec<_> = s.code_units().collect();
        let start = units
            .iter()
            .position(|x| !js_space(*x))
            .unwrap_or(units.len());
        let end = units
            .iter()
            .rposition(|x| !js_space(*x))
            .map_or(start, |i| i + 1);
        if start == end {
            return Err(p.error(DecodeErrorKind::Expected("nonempty trimmed string")));
        }
        Ok(Self(LosslessString::from_utf16(units[start..end].to_vec())))
    }
}
fn js_space(c: u16) -> bool {
    matches!(c,0x0009..=0x000d|0x0020|0x00a0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)
}
impl DomainEncode for StrategyId {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct CreateInput {
    pub project_id: crate::project_id::ProjectId,
    pub strategy: StrategyId,
    pub source_directory: crate::schema::AbsolutePath,
    pub directory: crate::schema::AbsolutePath,
    pub name: Option<LosslessString>,
}
impl DomainDecode for CreateInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            project_id: o.field("projectID")?,
            strategy: o.field("strategy")?,
            source_directory: o.field("sourceDirectory")?,
            directory: o.field("directory")?,
            name: o.optional("name")?,
        })
    }
}
impl DomainEncode for CreateInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("projectID", &self.project_id)
            .field("strategy", &self.strategy)
            .field("sourceDirectory", &self.source_directory)
            .field("directory", &self.directory)
            .optional("name", &self.name)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct RemoveInput {
    pub project_id: crate::project_id::ProjectId,
    pub directory: crate::schema::AbsolutePath,
    pub force: bool,
}
impl DomainDecode for RemoveInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            project_id: o.field("projectID")?,
            directory: o.field("directory")?,
            force: o.field("force")?,
        })
    }
}
impl DomainEncode for RemoveInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("projectID", &self.project_id)
            .field("directory", &self.directory)
            .field("force", &self.force)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Copy {
    pub directory: crate::schema::AbsolutePath,
}
impl DomainDecode for Copy {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            directory: ObjectDecoder::new(v, p)?.field("directory")?,
        })
    }
}
impl DomainEncode for Copy {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("directory", &self.directory)
            .finish()
    }
}
