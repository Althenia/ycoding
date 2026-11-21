use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
#[derive(Clone, Debug, PartialEq)]
pub struct RetryAction {
    pub reason: LosslessString,
    pub provider: LosslessString,
    pub title: LosslessString,
    pub message: LosslessString,
    pub label: LosslessString,
    pub link: Option<LosslessString>,
}
impl DomainDecode for RetryAction {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            reason: o.field("reason")?,
            provider: o.field("provider")?,
            title: o.field("title")?,
            message: o.field("message")?,
            label: o.field("label")?,
            link: o.optional("link")?,
        })
    }
}
impl DomainEncode for RetryAction {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("reason", &self.reason)
            .field("provider", &self.provider)
            .field("title", &self.title)
            .field("message", &self.message)
            .field("label", &self.label)
            .optional("link", &self.link)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct RetryInfo {
    pub attempt: crate::schema::NonNegativeInt,
    pub message: LosslessString,
    pub action: Option<RetryAction>,
    pub next: crate::schema::NonNegativeInt,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Info {
    Idle,
    Retry(Box<RetryInfo>),
    Busy,
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        match o.tag("type", &["idle", "retry", "busy"])?.as_str() {
            Some("idle") => Ok(Self::Idle),
            Some("retry") => Ok(Self::Retry(Box::new(RetryInfo {
                attempt: o.field("attempt")?,
                message: o.field("message")?,
                action: o.optional("action")?,
                next: o.field("next")?,
            }))),
            Some("busy") => Ok(Self::Busy),
            _ => unreachable!("validated status tag"),
        }
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Idle => ObjectEncoder::new()
                .field("type", &LosslessString::from("idle"))
                .finish(),
            Self::Retry(retry) => ObjectEncoder::new()
                .field("type", &LosslessString::from("retry"))
                .field("attempt", &retry.attempt)
                .field("message", &retry.message)
                .optional("action", &retry.action)
                .field("next", &retry.next)
                .finish(),
            Self::Busy => ObjectEncoder::new()
                .field("type", &LosslessString::from("busy"))
                .finish(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct StatusData {
    pub session_id: crate::session_id::SessionId,
    pub status: Info,
}
impl DomainDecode for StatusData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            status: o.field("status")?,
        })
    }
}
impl DomainEncode for StatusData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("status", &self.status)
            .finish()
    }
}
pub struct Status;
impl crate::event::EventType for Status {
    const TYPE: &'static str = "session.status";
    type Data = StatusData;
}
pub type StatusPayload = crate::event::EphemeralPayload<Status>;
#[derive(Clone, Debug, PartialEq)]
pub struct IdleData {
    pub session_id: crate::session_id::SessionId,
}
impl DomainDecode for IdleData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            session_id: ObjectDecoder::new(v, p)?.field("sessionID")?,
        })
    }
}
impl DomainEncode for IdleData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .finish()
    }
}
pub struct Idle;
impl crate::event::EventType for Idle {
    const TYPE: &'static str = "session.idle";
    type Data = IdleData;
}
pub type IdlePayload = crate::event::EphemeralPayload<Idle>;
