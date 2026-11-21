use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
#[derive(Clone, Debug, PartialEq)]
pub struct PromptAppendData {
    pub text: LosslessString,
}
impl DomainDecode for PromptAppendData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            text: ObjectDecoder::new(v, p)?.field("text")?,
        })
    }
}
impl DomainEncode for PromptAppendData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().field("text", &self.text).finish()
    }
}
pub struct PromptAppend;
impl crate::event::EventType for PromptAppend {
    const TYPE: &'static str = "tui.prompt.append";
    type Data = PromptAppendData;
}
pub type PromptAppendPayload = crate::event::EphemeralPayload<PromptAppend>;
#[derive(Clone, Debug, PartialEq)]
pub struct CommandExecuteData {
    pub command: LosslessString,
}
impl DomainDecode for CommandExecuteData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            command: ObjectDecoder::new(v, p)?.field("command")?,
        })
    }
}
impl DomainEncode for CommandExecuteData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("command", &self.command)
            .finish()
    }
}
pub struct CommandExecute;
impl crate::event::EventType for CommandExecute {
    const TYPE: &'static str = "tui.command.execute";
    type Data = CommandExecuteData;
}
pub type CommandExecutePayload = crate::event::EphemeralPayload<CommandExecute>;
crate::schema::literal_enum_type!(ToastVariant,{Info=>"info",Success=>"success",Warning=>"warning",Error=>"error"});
#[derive(Clone, Debug, PartialEq)]
pub struct ToastShowData {
    pub title: Option<LosslessString>,
    pub message: LosslessString,
    pub variant: ToastVariant,
    pub duration: crate::schema::PositiveInt,
}
impl DomainDecode for ToastShowData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            title: o.optional("title")?,
            message: o.field("message")?,
            variant: o.field("variant")?,
            duration: o.optional("duration")?.unwrap_or(
                crate::schema::PositiveInt::new(5000)
                    .map_err(|_| p.error(crate::DecodeErrorKind::Expected("positive integer")))?,
            ),
        })
    }
}
impl DomainEncode for ToastShowData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("title", &self.title)
            .field("message", &self.message)
            .field("variant", &self.variant)
            .field("duration", &self.duration)
            .finish()
    }
}
pub struct ToastShow;
impl crate::event::EventType for ToastShow {
    const TYPE: &'static str = "tui.toast.show";
    type Data = ToastShowData;
}
pub type ToastShowPayload = crate::event::EphemeralPayload<ToastShow>;
#[derive(Clone, Debug, PartialEq)]
pub struct SessionSelectData {
    pub session_id: crate::session_id::SessionId,
}
impl DomainDecode for SessionSelectData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            session_id: ObjectDecoder::new(v, p)?.field("sessionID")?,
        })
    }
}
impl DomainEncode for SessionSelectData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .finish()
    }
}
pub struct SessionSelect;
impl crate::event::EventType for SessionSelect {
    const TYPE: &'static str = "tui.session.select";
    type Data = SessionSelectData;
}
pub type SessionSelectPayload = crate::event::EphemeralPayload<SessionSelect>;
