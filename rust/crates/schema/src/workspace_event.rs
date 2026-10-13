use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
crate::schema::literal_enum_type!(StatusKind,{Connected=>"connected",Connecting=>"connecting",Disconnected=>"disconnected",Error=>"error"});
#[derive(Clone, Debug, PartialEq)]
pub struct ConnectionStatus {
    pub workspace_id: crate::workspace_id::WorkspaceId,
    pub status: StatusKind,
}
impl DomainDecode for ConnectionStatus {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            workspace_id: o.field("workspaceID")?,
            status: o.field("status")?,
        })
    }
}
impl DomainEncode for ConnectionStatus {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("workspaceID", &self.workspace_id)
            .field("status", &self.status)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ReadyData {
    pub name: LosslessString,
}
impl DomainDecode for ReadyData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            name: ObjectDecoder::new(v, p)?.field("name")?,
        })
    }
}
impl DomainEncode for ReadyData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().field("name", &self.name).finish()
    }
}
pub struct Ready;
impl crate::event::EventType for Ready {
    const TYPE: &'static str = "workspace.ready";
    type Data = ReadyData;
}
pub type ReadyPayload = crate::event::EphemeralPayload<Ready>;
#[derive(Clone, Debug, PartialEq)]
pub struct FailedData {
    pub message: LosslessString,
}
impl DomainDecode for FailedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            message: ObjectDecoder::new(v, p)?.field("message")?,
        })
    }
}
impl DomainEncode for FailedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("message", &self.message)
            .finish()
    }
}
pub struct Failed;
impl crate::event::EventType for Failed {
    const TYPE: &'static str = "workspace.failed";
    type Data = FailedData;
}
pub type FailedPayload = crate::event::EphemeralPayload<Failed>;
#[derive(Clone, Debug, PartialEq)]
pub struct StatusData(pub ConnectionStatus);
impl DomainDecode for StatusData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        ConnectionStatus::decode_at(v, p).map(Self)
    }
}
impl DomainEncode for StatusData {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
pub struct Status;
impl crate::event::EventType for Status {
    const TYPE: &'static str = "workspace.status";
    type Data = StatusData;
}
pub type StatusPayload = crate::event::EphemeralPayload<Status>;
