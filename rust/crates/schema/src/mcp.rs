use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder,
};
#[derive(Clone, Debug, PartialEq)]
pub struct TimeoutConfig {
    pub startup: Option<crate::schema::PositiveInt>,
    pub catalog: Option<crate::schema::PositiveInt>,
    pub execution: Option<crate::schema::PositiveInt>,
}
impl DomainDecode for TimeoutConfig {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            startup: o.optional("startup")?,
            catalog: o.optional("catalog")?,
            execution: o.optional("execution")?,
        })
    }
}
impl DomainEncode for TimeoutConfig {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("startup", &self.startup)
            .optional("catalog", &self.catalog)
            .optional("execution", &self.execution)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct LocalConfig {
    pub command: Vec<LosslessString>,
    pub cwd: Option<LosslessString>,
    pub environment: Option<crate::JsonObject>,
    pub disabled: Option<bool>,
    pub codemode: Option<bool>,
    pub timeout: Option<TimeoutConfig>,
}
impl DomainDecode for LocalConfig {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("local".into()))?;
        let environment: Option<crate::JsonObject> = o.optional("environment")?;
        if let Some(map) = &environment {
            for (k, x) in map.iter() {
                LosslessString::decode_at(x, &p.key("environment").key(k.clone()))?;
            }
        }
        Ok(Self {
            command: o.field("command")?,
            cwd: o.optional("cwd")?,
            environment,
            disabled: o.optional("disabled")?,
            codemode: o.optional("codemode")?,
            timeout: o.optional("timeout")?,
        })
    }
}
impl DomainEncode for LocalConfig {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("local"))
            .field("command", &self.command)
            .optional("cwd", &self.cwd)
            .optional("environment", &self.environment)
            .optional("disabled", &self.disabled)
            .optional("codemode", &self.codemode)
            .optional("timeout", &self.timeout)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct OAuthConfig {
    pub client_id: Option<LosslessString>,
    pub client_secret: Option<LosslessString>,
    pub scope: Option<LosslessString>,
    pub callback_port: Option<crate::schema::Int>,
    pub redirect_uri: Option<LosslessString>,
}
impl DomainDecode for OAuthConfig {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let callback_port: Option<crate::schema::Int> = o.optional("callback_port")?;
        if callback_port.is_some_and(|x| !(1..=65535).contains(&x.get())) {
            return Err(p.key("callback_port").error(DecodeErrorKind::NumberRange {
                minimum: 1.0,
                maximum: 65535.0,
                integer: true,
            }));
        }
        Ok(Self {
            client_id: o.optional("client_id")?,
            client_secret: o.optional("client_secret")?,
            scope: o.optional("scope")?,
            callback_port,
            redirect_uri: o.optional("redirect_uri")?,
        })
    }
}
impl DomainEncode for OAuthConfig {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("client_id", &self.client_id)
            .optional("client_secret", &self.client_secret)
            .optional("scope", &self.scope)
            .optional("callback_port", &self.callback_port)
            .optional("redirect_uri", &self.redirect_uri)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum OAuth {
    Disabled,
    Config(OAuthConfig),
}
impl DomainDecode for OAuth {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        if matches!(v, JsonValue::Bool(false)) {
            return Ok(Self::Disabled);
        }
        OAuthConfig::decode_at(v, p).map(Self::Config)
    }
}
impl DomainEncode for OAuth {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Disabled => JsonValue::Bool(false),
            Self::Config(x) => x.encode(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct RemoteConfig {
    pub url: LosslessString,
    pub headers: Option<crate::JsonObject>,
    pub oauth: Option<OAuth>,
    pub disabled: Option<bool>,
    pub codemode: Option<bool>,
    pub timeout: Option<TimeoutConfig>,
}
impl DomainDecode for RemoteConfig {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("remote".into()))?;
        let headers: Option<crate::JsonObject> = o.optional("headers")?;
        if let Some(map) = &headers {
            for (k, x) in map.iter() {
                LosslessString::decode_at(x, &p.key("headers").key(k.clone()))?;
            }
        }
        Ok(Self {
            url: o.field("url")?,
            headers,
            oauth: o.optional("oauth")?,
            disabled: o.optional("disabled")?,
            codemode: o.optional("codemode")?,
            timeout: o.optional("timeout")?,
        })
    }
}
impl DomainEncode for RemoteConfig {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("remote"))
            .field("url", &self.url)
            .optional("headers", &self.headers)
            .optional("oauth", &self.oauth)
            .optional("disabled", &self.disabled)
            .optional("codemode", &self.codemode)
            .optional("timeout", &self.timeout)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum ServerConfig {
    Local(LocalConfig),
    Remote(RemoteConfig),
}
impl DomainDecode for ServerConfig {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        match o.tag("type", &["local", "remote"])?.as_str() {
            Some("local") => LocalConfig::decode_at(v, p).map(Self::Local),
            Some("remote") => RemoteConfig::decode_at(v, p).map(Self::Remote),
            _ => Err(p.error(DecodeErrorKind::Expected("MCP server config"))),
        }
    }
}
impl DomainEncode for ServerConfig {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Local(x) => x.encode(),
            Self::Remote(x) => x.encode(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Connected,
    Pending,
    Disabled,
    Failed(LosslessString),
    NeedsAuth,
    NeedsClientRegistration(LosslessString),
}
impl DomainDecode for Status {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        match o
            .tag(
                "status",
                &[
                    "connected",
                    "pending",
                    "disabled",
                    "failed",
                    "needs_auth",
                    "needs_client_registration",
                ],
            )?
            .as_str()
        {
            Some("connected") => Ok(Self::Connected),
            Some("pending") => Ok(Self::Pending),
            Some("disabled") => Ok(Self::Disabled),
            Some("failed") => Ok(Self::Failed(o.field("error")?)),
            Some("needs_auth") => Ok(Self::NeedsAuth),
            Some("needs_client_registration") => {
                Ok(Self::NeedsClientRegistration(o.field("error")?))
            }
            _ => Err(p.error(DecodeErrorKind::Expected("MCP status"))),
        }
    }
}
impl DomainEncode for Status {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Connected => ObjectEncoder::new()
                .field("status", &LosslessString::from("connected"))
                .finish(),
            Self::Pending => ObjectEncoder::new()
                .field("status", &LosslessString::from("pending"))
                .finish(),
            Self::Disabled => ObjectEncoder::new()
                .field("status", &LosslessString::from("disabled"))
                .finish(),
            Self::Failed(x) => ObjectEncoder::new()
                .field("status", &LosslessString::from("failed"))
                .field("error", x)
                .finish(),
            Self::NeedsAuth => ObjectEncoder::new()
                .field("status", &LosslessString::from("needs_auth"))
                .finish(),
            Self::NeedsClientRegistration(x) => ObjectEncoder::new()
                .field("status", &LosslessString::from("needs_client_registration"))
                .field("error", x)
                .finish(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Server {
    pub name: LosslessString,
    pub status: Status,
    pub integration_id: Option<crate::integration_id::IntegrationId>,
}
impl DomainDecode for Server {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            name: o.field("name")?,
            status: o.field("status")?,
            integration_id: o.optional("integrationID")?,
        })
    }
}
impl DomainEncode for Server {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("name", &self.name)
            .field("status", &self.status)
            .optional("integrationID", &self.integration_id)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Resource {
    pub server: LosslessString,
    pub name: LosslessString,
    pub uri: LosslessString,
    pub description: Option<LosslessString>,
    pub mime_type: Option<LosslessString>,
}
impl DomainDecode for Resource {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            server: o.field("server")?,
            name: o.field("name")?,
            uri: o.field("uri")?,
            description: o.optional("description")?,
            mime_type: o.optional("mimeType")?,
        })
    }
}
impl DomainEncode for Resource {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("server", &self.server)
            .field("name", &self.name)
            .field("uri", &self.uri)
            .optional("description", &self.description)
            .optional("mimeType", &self.mime_type)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ResourceTemplate {
    pub server: LosslessString,
    pub name: LosslessString,
    pub uri_template: LosslessString,
    pub description: Option<LosslessString>,
    pub mime_type: Option<LosslessString>,
}
impl DomainDecode for ResourceTemplate {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            server: o.field("server")?,
            name: o.field("name")?,
            uri_template: o.field("uriTemplate")?,
            description: o.optional("description")?,
            mime_type: o.optional("mimeType")?,
        })
    }
}
impl DomainEncode for ResourceTemplate {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("server", &self.server)
            .field("name", &self.name)
            .field("uriTemplate", &self.uri_template)
            .optional("description", &self.description)
            .optional("mimeType", &self.mime_type)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ResourceCatalog {
    pub resources: Vec<Resource>,
    pub templates: Vec<ResourceTemplate>,
}
impl DomainDecode for ResourceCatalog {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            resources: o.field("resources")?,
            templates: o.field("templates")?,
        })
    }
}
impl DomainEncode for ResourceCatalog {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("resources", &self.resources)
            .field("templates", &self.templates)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum ResourceContentPart {
    Text {
        uri: LosslessString,
        text: LosslessString,
        mime_type: Option<LosslessString>,
    },
    Blob {
        uri: LosslessString,
        blob: LosslessString,
        mime_type: Option<LosslessString>,
    },
}
impl DomainDecode for ResourceContentPart {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        match o.tag("type", &["text", "blob"])?.as_str() {
            Some("text") => Ok(Self::Text {
                uri: o.field("uri")?,
                text: o.field("text")?,
                mime_type: o.optional("mimeType")?,
            }),
            Some("blob") => Ok(Self::Blob {
                uri: o.field("uri")?,
                blob: o.field("blob")?,
                mime_type: o.optional("mimeType")?,
            }),
            _ => Err(p.error(DecodeErrorKind::Expected("resource content part"))),
        }
    }
}
impl DomainEncode for ResourceContentPart {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Text {
                uri,
                text,
                mime_type,
            } => ObjectEncoder::new()
                .field("type", &LosslessString::from("text"))
                .field("uri", uri)
                .field("text", text)
                .optional("mimeType", mime_type)
                .finish(),
            Self::Blob {
                uri,
                blob,
                mime_type,
            } => ObjectEncoder::new()
                .field("type", &LosslessString::from("blob"))
                .field("uri", uri)
                .field("blob", blob)
                .optional("mimeType", mime_type)
                .finish(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ResourceContent {
    pub server: LosslessString,
    pub uri: LosslessString,
    pub contents: Vec<ResourceContentPart>,
}
impl DomainDecode for ResourceContent {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            server: o.field("server")?,
            uri: o.field("uri")?,
            contents: o.field("contents")?,
        })
    }
}
impl DomainEncode for ResourceContent {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("server", &self.server)
            .field("uri", &self.uri)
            .field("contents", &self.contents)
            .finish()
    }
}
