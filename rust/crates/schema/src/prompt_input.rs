use crate::prompt::Mention;
use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
#[derive(Clone, Debug, PartialEq)]
pub struct FileAttachment {
    pub uri: LosslessString,
    pub name: Option<LosslessString>,
    pub description: Option<LosslessString>,
    pub mention: Option<Mention>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Prompt {
    pub text: LosslessString,
    pub files: Option<Vec<FileAttachment>>,
    pub agents: Option<Vec<crate::prompt::AgentAttachment>>,
}
impl DomainDecode for FileAttachment {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            uri: o.field("uri")?,
            name: o.optional("name")?,
            description: o.optional("description")?,
            mention: o.optional("mention")?,
        })
    }
}
impl DomainEncode for FileAttachment {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("uri", &self.uri)
            .optional("name", &self.name)
            .optional("description", &self.description)
            .optional("mention", &self.mention)
            .finish()
    }
}
impl DomainDecode for Prompt {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            text: o.field("text")?,
            files: o.optional("files")?,
            agents: o.optional("agents")?,
        })
    }
}
impl DomainEncode for Prompt {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("text", &self.text)
            .optional("files", &self.files)
            .optional("agents", &self.agents)
            .finish()
    }
}
