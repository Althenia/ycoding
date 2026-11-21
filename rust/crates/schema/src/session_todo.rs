use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
crate::schema::literal_enum_type!(Status,{Pending=>"pending",InProgress=>"in_progress",Completed=>"completed",Cancelled=>"cancelled"});
crate::schema::literal_enum_type!(Priority,{High=>"high",Medium=>"medium",Low=>"low"});
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub content: LosslessString,
    pub status: Status,
    pub priority: Priority,
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            content: o.field("content")?,
            status: o.field("status")?,
            priority: o.field("priority")?,
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("content", &self.content)
            .field("status", &self.status)
            .field("priority", &self.priority)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct UpdatedData {
    pub session_id: crate::session_id::SessionId,
    pub todos: Vec<Info>,
}
impl DomainDecode for UpdatedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            todos: o.field("todos")?,
        })
    }
}
impl DomainEncode for UpdatedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("todos", &self.todos)
            .finish()
    }
}
pub struct Updated;
impl crate::event::EventType for Updated {
    const TYPE: &'static str = "todo.updated";
    type Data = UpdatedData;
}
pub type UpdatedPayload = crate::event::EphemeralPayload<Updated>;
