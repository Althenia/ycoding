use crate::session_id::SessionId;
use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
crate::schema::string_type!(Id, "per");
#[derive(Clone, Debug, PartialEq)]
pub struct Reply(pub LosslessString);
#[derive(Clone, Debug, PartialEq)]
pub struct Effect(pub LosslessString);
#[derive(Clone, Debug, PartialEq)]
pub struct Source {
    pub message_id: LosslessString,
    pub call_id: LosslessString,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub id: Id,
    pub session_id: SessionId,
    pub action: LosslessString,
    pub resources: Vec<LosslessString>,
    pub save: Option<Vec<LosslessString>>,
    pub metadata: Option<crate::JsonObject>,
    pub source: Option<Source>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Rule {
    pub action: LosslessString,
    pub resource: LosslessString,
    pub effect: Effect,
}
pub type Ruleset = Vec<Rule>;
impl DomainDecode for Reply {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        crate::domain::literal_enum(v, &["once", "always", "reject"], p).map(Self)
    }
}
impl DomainEncode for Reply {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
impl DomainDecode for Effect {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        crate::domain::literal_enum(v, &["allow", "deny", "ask"], p).map(Self)
    }
}
impl DomainEncode for Effect {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
impl DomainDecode for Source {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("tool".into()))?;
        Ok(Self {
            message_id: o.field("messageID")?,
            call_id: o.field("callID")?,
        })
    }
}
impl DomainEncode for Source {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "tool")
            .field("messageID", &self.message_id)
            .field("callID", &self.call_id)
            .finish()
    }
}
impl DomainDecode for Request {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            session_id: o.field("sessionID")?,
            action: o.field("action")?,
            resources: o.field("resources")?,
            save: o.optional("save")?,
            metadata: o.optional("metadata")?,
            source: o.optional("source")?,
        })
    }
}
impl DomainEncode for Request {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("sessionID", &self.session_id)
            .field("action", &self.action)
            .field("resources", &self.resources)
            .optional("save", &self.save)
            .optional("metadata", &self.metadata)
            .optional("source", &self.source)
            .finish()
    }
}
impl DomainDecode for Rule {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            action: o.field("action")?,
            resource: o.field("resource")?,
            effect: o.field("effect")?,
        })
    }
}
impl DomainEncode for Rule {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("action", &self.action)
            .field("resource", &self.resource)
            .field("effect", &self.effect)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct RepliedData {
    pub session_id: SessionId,
    pub request_id: Id,
    pub reply: Reply,
}
impl DomainDecode for RepliedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            request_id: o.field("requestID")?,
            reply: o.field("reply")?,
        })
    }
}
impl DomainEncode for RepliedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("requestID", &self.request_id)
            .field("reply", &self.reply)
            .finish()
    }
}
pub struct Asked;
impl crate::event::EventType for Asked {
    const TYPE: &'static str = "permission.asked";
    type Data = Request;
}
pub struct Replied;
impl crate::event::EventType for Replied {
    const TYPE: &'static str = "permission.replied";
    type Data = RepliedData;
}
pub fn definitions() -> [crate::event::Definition; 2] {
    [
        crate::event::Definition::ephemeral::<Asked>(),
        crate::event::Definition::ephemeral::<Replied>(),
    ]
}
