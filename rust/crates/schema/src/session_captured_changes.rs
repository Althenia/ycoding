use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
crate::schema::literal_enum_type!(InputType,{User=>"user",Synthetic=>"synthetic",Assistant=>"assistant"});
#[derive(Clone, Debug, PartialEq)]
pub struct Metadata {
    pub kind: Option<LosslessString>,
    pub question_id: Option<LosslessString>,
}
impl DomainDecode for Metadata {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> std::result::Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            kind: o.optional("kind")?,
            question_id: o.optional("questionID")?,
        })
    }
}
impl DomainEncode for Metadata {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("kind", &self.kind)
            .optional("questionID", &self.question_id)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct File {
    pub file: Option<LosslessString>,
    pub patch: LosslessString,
    pub status: Option<LosslessString>,
}
impl DomainDecode for File {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> std::result::Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            file: o.optional("file")?,
            patch: o.field("patch")?,
            status: o.optional("status")?,
        })
    }
}
impl DomainEncode for File {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("file", &self.file)
            .field("patch", &self.patch)
            .optional("status", &self.status)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Task {
    pub session_id: Option<LosslessString>,
}
impl DomainDecode for Task {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> std::result::Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.optional("sessionID")?,
        })
    }
}
impl DomainEncode for Task {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("sessionID", &self.session_id)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ToolInput {
    pub question_id: Option<LosslessString>,
}
impl DomainDecode for ToolInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> std::result::Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            question_id: o.optional("questionID")?,
        })
    }
}
impl DomainEncode for ToolInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("questionID", &self.question_id)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Structured {
    pub files: Option<Vec<File>>,
    pub session_id: Option<LosslessString>,
    pub action: Option<LosslessString>,
    pub task: Option<Task>,
}
impl DomainDecode for Structured {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> std::result::Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            files: o.optional("files")?,
            session_id: o.optional("sessionID")?,
            action: o.optional("action")?,
            task: o.optional("task")?,
        })
    }
}
impl DomainEncode for Structured {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("files", &self.files)
            .optional("sessionID", &self.session_id)
            .optional("action", &self.action)
            .optional("task", &self.task)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ToolState {
    pub status: Option<LosslessString>,
    pub input: Option<ToolInput>,
    pub structured: Option<Structured>,
}
impl DomainDecode for ToolState {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> std::result::Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            status: o.optional("status")?,
            input: o.optional("input")?,
            structured: o.optional("structured")?,
        })
    }
}
impl DomainEncode for ToolState {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("status", &self.status)
            .optional("input", &self.input)
            .optional("structured", &self.structured)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Tool {
    pub id: Option<LosslessString>,
    pub name: LosslessString,
    pub state: ToolState,
}
impl DomainDecode for Tool {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> std::result::Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("tool".into()))?;
        Ok(Self {
            id: o.optional("id")?,
            name: o.field("name")?,
            state: o.field("state")?,
        })
    }
}
impl DomainEncode for Tool {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("tool"))
            .optional("id", &self.id)
            .field("name", &self.name)
            .field("state", &self.state)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Input {
    pub id: crate::session_message_id::Id,
    pub kind: InputType,
    pub metadata: Option<Metadata>,
    pub content: Option<Vec<Tool>>,
}
impl DomainDecode for Input {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> std::result::Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            kind: o.field("type")?,
            metadata: o.optional("metadata")?,
            content: o.optional("content")?,
        })
    }
}
impl DomainEncode for Input {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("type", &self.kind)
            .optional("metadata", &self.metadata)
            .optional("content", &self.content)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Page {
    pub data: Vec<Input>,
    pub next: Option<crate::schema::NonNegativeInt>,
}
impl DomainDecode for Page {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> std::result::Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            data: o.field("data")?,
            next: o.optional("next")?,
        })
    }
}
impl DomainEncode for Page {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("data", &self.data)
            .optional("next", &self.next)
            .finish()
    }
}
