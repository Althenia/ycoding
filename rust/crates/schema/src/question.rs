use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct Id(LosslessString);
impl DomainDecode for Id {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        crate::domain::branded_string(v, "que", p).map(Self)
    }
}
impl DomainEncode for Id {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Option {
    pub label: LosslessString,
    pub description: LosslessString,
}
impl DomainDecode for Option {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            label: o.field("label")?,
            description: o.field("description")?,
        })
    }
}
impl DomainEncode for Option {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("label", &self.label)
            .field("description", &self.description)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub question: LosslessString,
    pub header: LosslessString,
    pub options: Vec<Option>,
    pub multiple: std::option::Option<bool>,
    pub custom: std::option::Option<bool>,
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            question: o.field("question")?,
            header: o.field("header")?,
            options: o.field("options")?,
            multiple: o.optional("multiple")?,
            custom: o.optional("custom")?,
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("question", &self.question)
            .field("header", &self.header)
            .field("options", &self.options)
            .optional("multiple", &self.multiple)
            .optional("custom", &self.custom)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Prompt {
    pub question: LosslessString,
    pub header: LosslessString,
    pub options: Vec<Option>,
    pub multiple: std::option::Option<bool>,
}
impl DomainDecode for Prompt {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            question: o.field("question")?,
            header: o.field("header")?,
            options: o.field("options")?,
            multiple: o.optional("multiple")?,
        })
    }
}
impl DomainEncode for Prompt {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("question", &self.question)
            .field("header", &self.header)
            .field("options", &self.options)
            .optional("multiple", &self.multiple)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Tool {
    pub message_id: LosslessString,
    pub call_id: LosslessString,
}
impl DomainDecode for Tool {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            message_id: o.field("messageID")?,
            call_id: o.field("callID")?,
        })
    }
}
impl DomainEncode for Tool {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("messageID", &self.message_id)
            .field("callID", &self.call_id)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub id: Id,
    pub session_id: crate::session_id::SessionId,
    pub questions: Vec<Info>,
    pub tool: std::option::Option<Tool>,
}
impl DomainDecode for Request {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            session_id: o.field("sessionID")?,
            questions: o.field("questions")?,
            tool: o.optional("tool")?,
        })
    }
}
impl DomainEncode for Request {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("sessionID", &self.session_id)
            .field("questions", &self.questions)
            .optional("tool", &self.tool)
            .finish()
    }
}
pub type Answer = Vec<LosslessString>;
#[derive(Clone, Debug, PartialEq)]
pub struct Reply {
    pub answers: Vec<Answer>,
}
impl DomainDecode for Reply {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            answers: ObjectDecoder::new(v, p)?.field("answers")?,
        })
    }
}
impl DomainEncode for Reply {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("answers", &self.answers)
            .finish()
    }
}
pub struct Asked;
impl crate::event::EventType for Asked {
    const TYPE: &'static str = "question.asked";
    type Data = Request;
}
#[derive(Clone, Debug, PartialEq)]
pub struct RepliedData {
    pub session_id: crate::session_id::SessionId,
    pub request_id: Id,
    pub answers: Vec<Answer>,
}
impl DomainDecode for RepliedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            request_id: o.field("requestID")?,
            answers: o.field("answers")?,
        })
    }
}
impl DomainEncode for RepliedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("requestID", &self.request_id)
            .field("answers", &self.answers)
            .finish()
    }
}
pub struct Replied;
impl crate::event::EventType for Replied {
    const TYPE: &'static str = "question.replied";
    type Data = RepliedData;
}
#[derive(Clone, Debug, PartialEq)]
pub struct RejectedData {
    pub session_id: crate::session_id::SessionId,
    pub request_id: Id,
}
impl DomainDecode for RejectedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            request_id: o.field("requestID")?,
        })
    }
}
impl DomainEncode for RejectedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("requestID", &self.request_id)
            .finish()
    }
}
pub struct Rejected;
impl crate::event::EventType for Rejected {
    const TYPE: &'static str = "question.rejected";
    type Data = RejectedData;
}
#[derive(Clone, Debug, PartialEq)]
pub struct TimedOutData {
    pub session_id: crate::session_id::SessionId,
    pub request_id: Id,
}
impl DomainDecode for TimedOutData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            request_id: o.field("requestID")?,
        })
    }
}
impl DomainEncode for TimedOutData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("requestID", &self.request_id)
            .finish()
    }
}
pub struct TimedOut;
impl crate::event::EventType for TimedOut {
    const TYPE: &'static str = "question.timed_out";
    type Data = TimedOutData;
}
#[derive(Clone, Debug, PartialEq)]
pub struct DeferredData {
    pub session_id: crate::session_id::SessionId,
    pub request_id: Id,
    pub item_id: crate::session_review::Id,
}
impl DomainDecode for DeferredData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            request_id: o.field("requestID")?,
            item_id: o.field("itemID")?,
        })
    }
}
impl DomainEncode for DeferredData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("requestID", &self.request_id)
            .field("itemID", &self.item_id)
            .finish()
    }
}
pub struct Deferred;
impl crate::event::EventType for Deferred {
    const TYPE: &'static str = "question.deferred";
    type Data = DeferredData;
}
