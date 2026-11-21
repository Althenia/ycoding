use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
crate::schema::literal_enum_type!(EntryType,{File=>"file",Directory=>"directory"});
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub path: crate::schema::RelativePath,
    pub r#type: EntryType,
}
impl DomainDecode for Entry {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            path: o.field("path")?,
            r#type: o.field("type")?,
        })
    }
}
impl DomainEncode for Entry {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("path", &self.path)
            .field("type", &self.r#type)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Submatch {
    pub text: LosslessString,
    pub start: crate::schema::NonNegativeInt,
    pub end: crate::schema::NonNegativeInt,
}
impl DomainDecode for Submatch {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            text: o.field("text")?,
            start: o.field("start")?,
            end: o.field("end")?,
        })
    }
}
impl DomainEncode for Submatch {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("text", &self.text)
            .field("start", &self.start)
            .field("end", &self.end)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Match {
    pub entry: Entry,
    pub line: crate::schema::PositiveInt,
    pub offset: crate::schema::NonNegativeInt,
    pub text: LosslessString,
    pub submatches: Vec<Submatch>,
}
impl DomainDecode for Match {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            entry: o.field("entry")?,
            line: o.field("line")?,
            offset: o.field("offset")?,
            text: o.field("text")?,
            submatches: o.field("submatches")?,
        })
    }
}
impl DomainEncode for Match {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("entry", &self.entry)
            .field("line", &self.line)
            .field("offset", &self.offset)
            .field("text", &self.text)
            .field("submatches", &self.submatches)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct FindInput {
    pub query: LosslessString,
    pub r#type: Option<EntryType>,
    pub limit: Option<crate::schema::PositiveInt>,
}
impl DomainDecode for FindInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            query: o.field("query")?,
            r#type: o.optional("type")?,
            limit: o.optional("limit")?,
        })
    }
}
impl DomainEncode for FindInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("query", &self.query)
            .optional("type", &self.r#type)
            .optional("limit", &self.limit)
            .finish()
    }
}
crate::schema::literal_enum_type!(ChangedKind,{Add=>"add",Change=>"change",Unlink=>"unlink"});
#[derive(Clone, Debug, PartialEq)]
pub struct ChangedData {
    pub file: LosslessString,
    pub event: ChangedKind,
}
impl DomainDecode for ChangedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            file: o.field("file")?,
            event: o.field("event")?,
        })
    }
}
impl DomainEncode for ChangedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("file", &self.file)
            .field("event", &self.event)
            .finish()
    }
}
pub struct Changed;
impl crate::event::EventType for Changed {
    const TYPE: &'static str = "filesystem.changed";
    type Data = ChangedData;
}
pub type ChangedPayload = crate::event::EphemeralPayload<Changed>;
