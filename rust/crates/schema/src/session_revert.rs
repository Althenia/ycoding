use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, ObjectDecoder, ObjectEncoder,
};

#[derive(Clone, Debug, PartialEq)]
pub struct Revert {
    pub message_id: crate::session_message_id::Id,
    pub snapshot: Option<crate::snapshot::Id>,
    pub files: Option<Vec<crate::file_diff::Info>>,
}

impl DomainDecode for Revert {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            message_id: object.field("messageID")?,
            snapshot: object.optional("snapshot")?,
            files: object.optional("files")?,
        })
    }
}

impl DomainEncode for Revert {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("messageID", &self.message_id)
            .optional("snapshot", &self.snapshot)
            .optional("files", &self.files)
            .finish()
    }
}
