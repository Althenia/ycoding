use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder,
};
use crate::{
    schema::{DateTimeUtcFromMillis, NonNegativeInt},
    session_delivery::Delivery,
};

#[derive(Clone, Debug, PartialEq)]
pub struct UserData {
    pub text: LosslessString,
    pub files: Option<Vec<crate::prompt::FileAttachment>>,
    pub agents: Option<Vec<crate::prompt::AgentAttachment>>,
    pub metadata: Option<crate::JsonObject>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SyntheticData {
    pub text: LosslessString,
    pub description: Option<LosslessString>,
    pub metadata: Option<crate::JsonObject>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Message {
    User(UserMessage),
    Synthetic(SyntheticMessage),
}

#[derive(Clone, Debug, PartialEq)]
pub struct UserMessage {
    pub data: UserData,
    pub delivery: Delivery,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SyntheticMessage {
    pub data: SyntheticData,
    pub delivery: Delivery,
}

#[derive(Clone, Debug, PartialEq)]
pub struct User {
    pub admitted_seq: NonNegativeInt,
    pub id: crate::session_message_id::Id,
    pub session_id: crate::session_id::SessionId,
    pub time_created: DateTimeUtcFromMillis,
    pub data: UserData,
    pub delivery: Delivery,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Synthetic {
    pub admitted_seq: NonNegativeInt,
    pub id: crate::session_message_id::Id,
    pub session_id: crate::session_id::SessionId,
    pub time_created: DateTimeUtcFromMillis,
    pub data: SyntheticData,
    pub delivery: Delivery,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Compaction {
    pub admitted_seq: NonNegativeInt,
    pub id: crate::session_message_id::Id,
    pub session_id: crate::session_id::SessionId,
    pub time_created: DateTimeUtcFromMillis,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Info {
    User(User),
    Synthetic(Synthetic),
}

#[derive(Clone, Debug, PartialEq)]
pub enum LegacyInfo {
    User(User),
    Synthetic(Synthetic),
    Compaction(Compaction),
}

impl DomainDecode for UserData {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            text: object.field("text")?,
            files: object.optional("files")?,
            agents: object.optional("agents")?,
            metadata: object.optional("metadata")?,
        })
    }
}
impl DomainEncode for UserData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("text", &self.text)
            .optional("files", &self.files)
            .optional("agents", &self.agents)
            .optional("metadata", &self.metadata)
            .finish()
    }
}
impl DomainDecode for SyntheticData {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            text: object.field("text")?,
            description: object.optional("description")?,
            metadata: object.optional("metadata")?,
        })
    }
}
impl DomainEncode for SyntheticData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("text", &self.text)
            .optional("description", &self.description)
            .optional("metadata", &self.metadata)
            .finish()
    }
}
impl DomainDecode for UserMessage {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        object.literal("type", &JsonValue::String("user".into()))?;
        Ok(Self {
            data: object.field("data")?,
            delivery: object.field("delivery")?,
        })
    }
}
impl DomainEncode for UserMessage {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "user")
            .field("data", &self.data)
            .field("delivery", &self.delivery)
            .finish()
    }
}
impl DomainDecode for SyntheticMessage {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        object.literal("type", &JsonValue::String("synthetic".into()))?;
        Ok(Self {
            data: object.field("data")?,
            delivery: object.field("delivery")?,
        })
    }
}
impl DomainEncode for SyntheticMessage {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "synthetic")
            .field("data", &self.data)
            .field("delivery", &self.delivery)
            .finish()
    }
}
impl DomainDecode for Message {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        match ObjectDecoder::new(value, path)?
            .tag("type", &["user", "synthetic"])?
            .as_str()
        {
            Some("user") => UserMessage::decode_at(value, path).map(Self::User),
            Some("synthetic") => SyntheticMessage::decode_at(value, path).map(Self::Synthetic),
            _ => Err(path.error(DecodeErrorKind::Expected("pending message"))),
        }
    }
}
impl DomainEncode for Message {
    fn encode(&self) -> JsonValue {
        match self {
            Self::User(value) => value.encode(),
            Self::Synthetic(value) => value.encode(),
        }
    }
}
impl DomainDecode for User {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        object.literal("type", &JsonValue::String("user".into()))?;
        Ok(Self {
            admitted_seq: object.field("admittedSeq")?,
            id: object.field("id")?,
            session_id: object.field("sessionID")?,
            time_created: object.field("timeCreated")?,
            data: object.field("data")?,
            delivery: object.field("delivery")?,
        })
    }
}
impl DomainEncode for User {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("admittedSeq", &self.admitted_seq)
            .field("id", &self.id)
            .field("sessionID", &self.session_id)
            .field("timeCreated", &self.time_created)
            .field("type", "user")
            .field("data", &self.data)
            .field("delivery", &self.delivery)
            .finish()
    }
}
impl DomainDecode for Synthetic {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        object.literal("type", &JsonValue::String("synthetic".into()))?;
        Ok(Self {
            admitted_seq: object.field("admittedSeq")?,
            id: object.field("id")?,
            session_id: object.field("sessionID")?,
            time_created: object.field("timeCreated")?,
            data: object.field("data")?,
            delivery: object.field("delivery")?,
        })
    }
}
impl DomainEncode for Synthetic {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("admittedSeq", &self.admitted_seq)
            .field("id", &self.id)
            .field("sessionID", &self.session_id)
            .field("timeCreated", &self.time_created)
            .field("type", "synthetic")
            .field("data", &self.data)
            .field("delivery", &self.delivery)
            .finish()
    }
}
impl DomainDecode for Compaction {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        object.literal("type", &JsonValue::String("compaction".into()))?;
        Ok(Self {
            admitted_seq: object.field("admittedSeq")?,
            id: object.field("id")?,
            session_id: object.field("sessionID")?,
            time_created: object.field("timeCreated")?,
        })
    }
}
impl DomainEncode for Compaction {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("admittedSeq", &self.admitted_seq)
            .field("id", &self.id)
            .field("sessionID", &self.session_id)
            .field("timeCreated", &self.time_created)
            .field("type", "compaction")
            .finish()
    }
}
impl DomainDecode for Info {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        match ObjectDecoder::new(value, path)?
            .tag("type", &["user", "synthetic"])?
            .as_str()
        {
            Some("user") => User::decode_at(value, path).map(Self::User),
            Some("synthetic") => Synthetic::decode_at(value, path).map(Self::Synthetic),
            _ => Err(path.error(DecodeErrorKind::Expected("pending info"))),
        }
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        match self {
            Self::User(value) => value.encode(),
            Self::Synthetic(value) => value.encode(),
        }
    }
}
impl DomainDecode for LegacyInfo {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        match ObjectDecoder::new(value, path)?
            .tag("type", &["user", "synthetic", "compaction"])?
            .as_str()
        {
            Some("user") => User::decode_at(value, path).map(Self::User),
            Some("synthetic") => Synthetic::decode_at(value, path).map(Self::Synthetic),
            Some("compaction") => Compaction::decode_at(value, path).map(Self::Compaction),
            _ => Err(path.error(DecodeErrorKind::Expected("legacy pending info"))),
        }
    }
}
impl DomainEncode for LegacyInfo {
    fn encode(&self) -> JsonValue {
        match self {
            Self::User(value) => value.encode(),
            Self::Synthetic(value) => value.encode(),
            Self::Compaction(value) => value.encode(),
        }
    }
}
