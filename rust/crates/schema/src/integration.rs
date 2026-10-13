use crate::connection;
use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};

pub type Id = crate::integration_id::IntegrationId;
pub type MethodId = crate::integration_id::IntegrationMethodId;
#[derive(Clone, Debug, PartialEq)]
pub struct When {
    pub key: LosslessString,
    pub op: LosslessString,
    pub value: LosslessString,
}
#[derive(Clone, Debug, PartialEq)]
pub struct TextPrompt {
    pub key: LosslessString,
    pub message: LosslessString,
    pub placeholder: Option<LosslessString>,
    pub when: Option<When>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct SelectOption {
    pub label: LosslessString,
    pub value: LosslessString,
    pub hint: Option<LosslessString>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct SelectPrompt {
    pub key: LosslessString,
    pub message: LosslessString,
    pub options: Vec<SelectOption>,
    pub when: Option<When>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Prompt {
    Text(TextPrompt),
    Select(SelectPrompt),
}
#[derive(Clone, Debug, PartialEq)]
pub struct OAuthMethod {
    pub id: MethodId,
    pub label: LosslessString,
    pub prompts: Option<Vec<Prompt>>,
    pub remote: Option<bool>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct CommandMethod {
    pub id: MethodId,
    pub label: LosslessString,
    pub command: Vec<LosslessString>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct KeyMethod {
    pub label: Option<LosslessString>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct EnvMethod {
    pub names: Vec<LosslessString>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Method {
    OAuth(OAuthMethod),
    Command(CommandMethod),
    Key(KeyMethod),
    Env(EnvMethod),
}
#[derive(Clone, Debug, PartialEq)]
pub struct Ref {
    pub id: Id,
    pub name: LosslessString,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub id: Id,
    pub name: LosslessString,
    pub methods: Vec<Method>,
    pub connections: Vec<connection::Info>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct AttemptTime {
    pub created: f64,
    pub expires: f64,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Attempt {
    pub attempt_id: AttemptId,
    pub url: LosslessString,
    pub instructions: LosslessString,
    pub mode: LosslessString,
    pub manual_code: Option<bool>,
    pub time: AttemptTime,
}
#[derive(Clone, Debug, PartialEq)]
pub struct CommandAttempt {
    pub attempt_id: AttemptId,
    pub time: AttemptTime,
}
#[derive(Clone, Debug, PartialEq)]
pub enum AttemptStatus {
    Pending(AttemptTime),
    Complete(AttemptTime),
    Failed {
        message: LosslessString,
        time: AttemptTime,
    },
    Expired(AttemptTime),
}
#[derive(Clone, Debug, PartialEq)]
pub enum CommandAttemptStatus {
    Pending {
        message: Option<LosslessString>,
        time: AttemptTime,
    },
    Complete(AttemptTime),
    Failed {
        message: LosslessString,
        time: AttemptTime,
    },
    Expired(AttemptTime),
}
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct AttemptId(pub LosslessString);
#[derive(Clone, Debug, PartialEq)]
pub struct Inputs(pub crate::JsonObject);
impl DomainDecode for Inputs {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let object = crate::JsonObject::decode_at(v, p)?;
        for (key, value) in object.iter() {
            LosslessString::decode_at(value, &p.key(key.clone()))?;
        }
        Ok(Self(object))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ConnectionUpdatedData {
    pub integration_id: Id,
}
impl DomainDecode for ConnectionUpdatedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            integration_id: o.field("integrationID")?,
        })
    }
}
impl DomainEncode for ConnectionUpdatedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("integrationID", &self.integration_id)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Empty;
impl DomainDecode for Empty {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let _ = ObjectDecoder::new(v, p)?;
        Ok(Self)
    }
}
impl DomainEncode for Empty {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().finish()
    }
}
pub struct Updated;
impl crate::event::EventType for Updated {
    const TYPE: &'static str = "integration.updated";
    type Data = Empty;
}
pub struct ConnectionUpdated;
impl crate::event::EventType for ConnectionUpdated {
    const TYPE: &'static str = "integration.connection.updated";
    type Data = ConnectionUpdatedData;
}
pub fn definitions() -> [crate::event::Definition; 2] {
    [
        crate::event::Definition::ephemeral::<Updated>(),
        crate::event::Definition::ephemeral::<ConnectionUpdated>(),
    ]
}
impl DomainEncode for Inputs {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
impl DomainDecode for AttemptId {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        LosslessString::decode_at(v, p).map(Self)
    }
}
impl DomainEncode for AttemptId {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
impl DomainDecode for AttemptTime {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            created: o.field("created")?,
            expires: o.field("expires")?,
        })
    }
}
impl DomainEncode for AttemptTime {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("created", &self.created)
            .field("expires", &self.expires)
            .finish()
    }
}
impl DomainDecode for SelectOption {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            label: o.field("label")?,
            value: o.field("value")?,
            hint: o.optional("hint")?,
        })
    }
}
impl DomainEncode for SelectOption {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("label", &self.label)
            .field("value", &self.value)
            .optional("hint", &self.hint)
            .finish()
    }
}
impl DomainDecode for When {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            key: o.field("key")?,
            op: o.tag("op", &["eq", "neq"])?,
            value: o.field("value")?,
        })
    }
}
impl DomainDecode for Prompt {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        match o.tag("type", &["text", "select"])?.as_str() {
            Some("text") => Ok(Self::Text(TextPrompt {
                key: o.field("key")?,
                message: o.field("message")?,
                placeholder: o.optional("placeholder")?,
                when: o.optional("when")?,
            })),
            Some("select") => Ok(Self::Select(SelectPrompt {
                key: o.field("key")?,
                message: o.field("message")?,
                options: o.field("options")?,
                when: o.optional("when")?,
            })),
            _ => unreachable!(),
        }
    }
}
impl DomainDecode for TextPrompt {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("text".into()))?;
        Ok(Self {
            key: o.field("key")?,
            message: o.field("message")?,
            placeholder: o.optional("placeholder")?,
            when: o.optional("when")?,
        })
    }
}
impl DomainEncode for TextPrompt {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "text")
            .field("key", &self.key)
            .field("message", &self.message)
            .optional("placeholder", &self.placeholder)
            .optional("when", &self.when)
            .finish()
    }
}
impl DomainDecode for SelectPrompt {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("select".into()))?;
        Ok(Self {
            key: o.field("key")?,
            message: o.field("message")?,
            options: o.field("options")?,
            when: o.optional("when")?,
        })
    }
}
impl DomainEncode for SelectPrompt {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "select")
            .field("key", &self.key)
            .field("message", &self.message)
            .field("options", &self.options)
            .optional("when", &self.when)
            .finish()
    }
}
impl DomainEncode for Prompt {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Text(x) => ObjectEncoder::new()
                .field("type", "text")
                .field("key", &x.key)
                .field("message", &x.message)
                .optional("placeholder", &x.placeholder)
                .optional("when", &x.when)
                .finish(),
            Self::Select(x) => ObjectEncoder::new()
                .field("type", "select")
                .field("key", &x.key)
                .field("message", &x.message)
                .field("options", &x.options)
                .optional("when", &x.when)
                .finish(),
        }
    }
}
impl DomainEncode for When {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("key", &self.key)
            .field("op", &self.op)
            .field("value", &self.value)
            .finish()
    }
}
impl DomainDecode for Method {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        match o.tag("type", &["oauth", "command", "key", "env"])?.as_str() {
            Some("oauth") => Ok(Self::OAuth(OAuthMethod {
                id: o.field("id")?,
                label: o.field("label")?,
                prompts: o.optional("prompts")?,
                remote: o.optional("remote")?,
            })),
            Some("command") => Ok(Self::Command(CommandMethod {
                id: o.field("id")?,
                label: o.field("label")?,
                command: o.field("command")?,
            })),
            Some("key") => Ok(Self::Key(KeyMethod {
                label: o.optional("label")?,
            })),
            Some("env") => Ok(Self::Env(EnvMethod {
                names: o.field("names")?,
            })),
            _ => unreachable!(),
        }
    }
}
impl DomainEncode for Method {
    fn encode(&self) -> JsonValue {
        match self {
            Self::OAuth(x) => ObjectEncoder::new()
                .field("id", &x.id)
                .field("type", "oauth")
                .field("label", &x.label)
                .optional("prompts", &x.prompts)
                .optional("remote", &x.remote)
                .finish(),
            Self::Command(x) => ObjectEncoder::new()
                .field("id", &x.id)
                .field("type", "command")
                .field("label", &x.label)
                .field("command", &x.command)
                .finish(),
            Self::Key(x) => ObjectEncoder::new()
                .field("type", "key")
                .optional("label", &x.label)
                .finish(),
            Self::Env(x) => ObjectEncoder::new()
                .field("type", "env")
                .field("names", &x.names)
                .finish(),
        }
    }
}
impl DomainDecode for Ref {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            name: o.field("name")?,
        })
    }
}
impl DomainEncode for Ref {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("name", &self.name)
            .finish()
    }
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            name: o.field("name")?,
            methods: o.field("methods")?,
            connections: o.field("connections")?,
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("name", &self.name)
            .field("methods", &self.methods)
            .field("connections", &self.connections)
            .finish()
    }
}
impl DomainDecode for OAuthMethod {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("oauth".into()))?;
        Ok(Self {
            id: o.field("id")?,
            label: o.field("label")?,
            prompts: o.optional("prompts")?,
            remote: o.optional("remote")?,
        })
    }
}
impl DomainEncode for OAuthMethod {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("type", "oauth")
            .field("label", &self.label)
            .optional("prompts", &self.prompts)
            .optional("remote", &self.remote)
            .finish()
    }
}
impl DomainDecode for CommandMethod {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("command".into()))?;
        Ok(Self {
            id: o.field("id")?,
            label: o.field("label")?,
            command: o.field("command")?,
        })
    }
}
impl DomainEncode for CommandMethod {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("type", "command")
            .field("label", &self.label)
            .field("command", &self.command)
            .finish()
    }
}
impl DomainDecode for KeyMethod {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("key".into()))?;
        Ok(Self {
            label: o.optional("label")?,
        })
    }
}
impl DomainEncode for KeyMethod {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "key")
            .optional("label", &self.label)
            .finish()
    }
}
impl DomainDecode for EnvMethod {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("env".into()))?;
        Ok(Self {
            names: o.field("names")?,
        })
    }
}
impl DomainEncode for EnvMethod {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "env")
            .field("names", &self.names)
            .finish()
    }
}
impl DomainDecode for Attempt {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            attempt_id: o.field("attemptID")?,
            url: o.field("url")?,
            instructions: o.field("instructions")?,
            mode: o.tag("mode", &["auto", "code"])?,
            manual_code: o.optional("manualCode")?,
            time: o.field("time")?,
        })
    }
}
impl DomainEncode for Attempt {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("attemptID", &self.attempt_id)
            .field("url", &self.url)
            .field("instructions", &self.instructions)
            .field("mode", &self.mode)
            .optional("manualCode", &self.manual_code)
            .field("time", &self.time)
            .finish()
    }
}
impl DomainDecode for CommandAttempt {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            attempt_id: o.field("attemptID")?,
            time: o.field("time")?,
        })
    }
}
impl DomainEncode for CommandAttempt {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("attemptID", &self.attempt_id)
            .field("time", &self.time)
            .finish()
    }
}
impl DomainDecode for AttemptStatus {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        match o
            .tag("status", &["pending", "complete", "failed", "expired"])?
            .as_str()
        {
            Some("pending") => Ok(Self::Pending(o.field("time")?)),
            Some("complete") => Ok(Self::Complete(o.field("time")?)),
            Some("failed") => Ok(Self::Failed {
                message: o.field("message")?,
                time: o.field("time")?,
            }),
            Some("expired") => Ok(Self::Expired(o.field("time")?)),
            _ => unreachable!(),
        }
    }
}
impl DomainEncode for AttemptStatus {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Pending(time) => ObjectEncoder::new()
                .field("status", "pending")
                .field("time", time)
                .finish(),
            Self::Complete(time) => ObjectEncoder::new()
                .field("status", "complete")
                .field("time", time)
                .finish(),
            Self::Failed { message, time } => ObjectEncoder::new()
                .field("status", "failed")
                .field("message", message)
                .field("time", time)
                .finish(),
            Self::Expired(time) => ObjectEncoder::new()
                .field("status", "expired")
                .field("time", time)
                .finish(),
        }
    }
}
impl DomainDecode for CommandAttemptStatus {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        match o
            .tag("status", &["pending", "complete", "failed", "expired"])?
            .as_str()
        {
            Some("pending") => Ok(Self::Pending {
                message: o.optional("message")?,
                time: o.field("time")?,
            }),
            Some("complete") => Ok(Self::Complete(o.field("time")?)),
            Some("failed") => Ok(Self::Failed {
                message: o.field("message")?,
                time: o.field("time")?,
            }),
            Some("expired") => Ok(Self::Expired(o.field("time")?)),
            _ => unreachable!(),
        }
    }
}
impl DomainEncode for CommandAttemptStatus {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Pending { message, time } => ObjectEncoder::new()
                .field("status", "pending")
                .optional("message", message)
                .field("time", time)
                .finish(),
            Self::Complete(time) => ObjectEncoder::new()
                .field("status", "complete")
                .field("time", time)
                .finish(),
            Self::Failed { message, time } => ObjectEncoder::new()
                .field("status", "failed")
                .field("message", message)
                .field("time", time)
                .finish(),
            Self::Expired(time) => ObjectEncoder::new()
                .field("status", "expired")
                .field("time", time)
                .finish(),
        }
    }
}
