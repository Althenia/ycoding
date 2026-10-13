use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
crate::schema::literal_enum_type!(Status,{Added=>"added",Deleted=>"deleted",Modified=>"modified"});
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub file: LosslessString,
    pub patch: LosslessString,
    pub additions: crate::schema::NonNegativeInt,
    pub deletions: crate::schema::NonNegativeInt,
    pub status: Status,
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            file: o.field("file")?,
            patch: o.field("patch")?,
            additions: o.field("additions")?,
            deletions: o.field("deletions")?,
            status: o.field("status")?,
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("file", &self.file)
            .field("patch", &self.patch)
            .field("additions", &self.additions)
            .field("deletions", &self.deletions)
            .field("status", &self.status)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct LegacyInfo {
    pub file: Option<LosslessString>,
    pub patch: Option<LosslessString>,
    pub additions: crate::schema::Finite,
    pub deletions: crate::schema::Finite,
    pub status: Option<Status>,
}
impl DomainDecode for LegacyInfo {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            file: o.optional("file")?,
            patch: o.optional("patch")?,
            additions: o.field("additions")?,
            deletions: o.field("deletions")?,
            status: o.optional("status")?,
        })
    }
}
impl DomainEncode for LegacyInfo {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("file", &self.file)
            .optional("patch", &self.patch)
            .field("additions", &self.additions)
            .field("deletions", &self.deletions)
            .optional("status", &self.status)
            .finish()
    }
}
