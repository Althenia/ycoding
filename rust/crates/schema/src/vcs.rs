use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
crate::schema::literal_enum_type!(Mode,{Working=>"working",Branch=>"branch"});
crate::schema::literal_enum_type!(FileStatusKind,{Added=>"added",Deleted=>"deleted",Modified=>"modified"});
#[derive(Clone, Debug, PartialEq)]
pub struct FileStatus {
    pub file: LosslessString,
    pub additions: crate::schema::NonNegativeInt,
    pub deletions: crate::schema::NonNegativeInt,
    pub status: FileStatusKind,
}
impl DomainDecode for FileStatus {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            file: o.field("file")?,
            additions: o.field("additions")?,
            deletions: o.field("deletions")?,
            status: o.field("status")?,
        })
    }
}
impl DomainEncode for FileStatus {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("file", &self.file)
            .field("additions", &self.additions)
            .field("deletions", &self.deletions)
            .field("status", &self.status)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Branch {
    pub current: Option<LosslessString>,
    pub default: Option<LosslessString>,
}
impl DomainDecode for Branch {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            current: o.optional("current")?,
            default: o.optional("default")?,
        })
    }
}
impl DomainEncode for Branch {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("current", &self.current)
            .optional("default", &self.default)
            .finish()
    }
}
