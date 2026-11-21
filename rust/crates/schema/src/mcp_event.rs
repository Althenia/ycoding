use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
#[derive(Clone, Debug, PartialEq)]
pub struct ServerData {
    pub server: LosslessString,
}
impl DomainDecode for ServerData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            server: ObjectDecoder::new(v, p)?.field("server")?,
        })
    }
}
impl DomainEncode for ServerData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().field("server", &self.server).finish()
    }
}
pub struct ToolsChanged;
impl crate::event::EventType for ToolsChanged {
    const TYPE: &'static str = "mcp.tools.changed";
    type Data = ServerData;
}
pub struct ResourcesChanged;
impl crate::event::EventType for ResourcesChanged {
    const TYPE: &'static str = "mcp.resources.changed";
    type Data = ServerData;
}
pub struct StatusChanged;
impl crate::event::EventType for StatusChanged {
    const TYPE: &'static str = "mcp.status.changed";
    type Data = ServerData;
}
#[derive(Clone, Debug, PartialEq)]
pub struct BrowserOpenFailedData {
    pub mcp_name: LosslessString,
    pub url: LosslessString,
}
impl DomainDecode for BrowserOpenFailedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            mcp_name: o.field("mcpName")?,
            url: o.field("url")?,
        })
    }
}
impl DomainEncode for BrowserOpenFailedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("mcpName", &self.mcp_name)
            .field("url", &self.url)
            .finish()
    }
}
pub struct BrowserOpenFailed;
impl crate::event::EventType for BrowserOpenFailed {
    const TYPE: &'static str = "mcp.browser.open.failed";
    type Data = BrowserOpenFailedData;
}
