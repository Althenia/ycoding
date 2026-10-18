use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder, Presence, schema::NonNegativeInt, session,
};

macro_rules! literals {
    ($name:ident {$($variant:ident => $value:literal),+ $(,)?}) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum $name {$($variant),+}
        impl $name {pub const fn as_str(self)-> &'static str {match self {$(Self::$variant=>$value),+}}}
        impl DomainDecode for $name {
            fn decode_at(value:&JsonValue,path:&JsonPath)->Result<Self,DecodeError>{
                let value=crate::domain::literal_enum(value,&[$($value),+],path)?;
                match value.as_str() {$(Some($value)=>Ok(Self::$variant),)+ _=>unreachable!()}
            }
        }
        impl DomainEncode for $name {fn encode(&self)->JsonValue{self.as_str().encode()}}
    };
}

literals!(Name {GuardrailChanged=>"session.guardrail.changed",PermissionChanged=>"session.permission.changed",QuestionChanged=>"session.question.changed",FormChanged=>"session.form.changed",Progress=>"session.progress",Completed=>"session.completed",Error=>"session.error"});
literals!(State {Pending=>"pending",Resolved=>"resolved",Cancelled=>"cancelled",Deferred=>"deferred",Started=>"started",Running=>"running",Completed=>"completed",Failed=>"failed",Interrupted=>"interrupted"});
literals!(FailureCategory {InvalidParams=>"invalid_params",CallbackEndpoint=>"callback_endpoint",Unauthorized=>"unauthorized",Unavailable=>"unavailable"});
literals!(FailureReason {InvalidName=>"invalid_name",InvalidArguments=>"invalid_arguments",InvalidDelivery=>"invalid_delivery",InvalidSecret=>"invalid_secret",InvalidTtl=>"invalid_ttl",InvalidCursor=>"invalid_cursor",SessionNotFound=>"session_not_found",ChallengeFailed=>"challenge_failed",Timeout=>"timeout",EndpointUnreachable=>"endpoint_unreachable",EndpointRejected=>"endpoint_rejected",PayloadTooLarge=>"payload_too_large",UnauthorizedPrincipal=>"unauthorized_principal",GrantExpired=>"grant_expired",GrantRevoked=>"grant_revoked",PrincipalScopeMismatch=>"principal_scope_mismatch",AuthorizationUnavailable=>"authorization_unavailable",SecureStorageUnavailable=>"secure_storage_unavailable",ServiceUnavailable=>"service_unavailable"});

pub const NAMES: [Name; 7] = [
    Name::GuardrailChanged,
    Name::PermissionChanged,
    Name::QuestionChanged,
    Name::FormChanged,
    Name::Progress,
    Name::Completed,
    Name::Error,
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub category: FailureCategory,
    pub reason: FailureReason,
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.category.as_str(), self.reason.as_str())
    }
}
impl std::error::Error for Failure {}
impl DomainDecode for Failure {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let o = object(value, path, &["_tag", "category", "reason"])?;
        o.literal("_tag", &"McpEvents.Failure".encode())?;
        Ok(Self {
            category: o.field("category")?,
            reason: o.field("reason")?,
        })
    }
}
impl DomainEncode for Failure {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("_tag", "McpEvents.Failure")
            .field("category", &self.category)
            .field("reason", &self.reason)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ContextPrincipal {
    pub owner_id: LosslessString,
    pub device_id: LosslessString,
    pub client_id: LosslessString,
}
#[derive(Clone, Debug, PartialEq)]
pub struct RequestContext {
    pub request_id: LosslessString,
    pub principal: ContextPrincipal,
    pub epoch: LosslessString,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Principal {
    pub owner_id: LosslessString,
    pub device_id: LosslessString,
    pub client_id: LosslessString,
    pub grant_id: LosslessString,
    pub epoch: LosslessString,
}

impl DomainDecode for ContextPrincipal {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let o = object(value, path, &["ownerID", "deviceID", "clientID"])?;
        Ok(Self {
            owner_id: bounded(&o, "ownerID", 1, 256, path)?,
            device_id: bounded(&o, "deviceID", 1, 256, path)?,
            client_id: client(&o, path)?,
        })
    }
}
impl DomainEncode for ContextPrincipal {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("ownerID", &self.owner_id)
            .field("deviceID", &self.device_id)
            .field("clientID", &self.client_id)
            .finish()
    }
}
impl DomainDecode for RequestContext {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let o = object(value, path, &["requestID", "principal", "epoch"])?;
        Ok(Self {
            request_id: bounded(&o, "requestID", 1, 256, path)?,
            principal: o.field("principal")?,
            epoch: bounded(&o, "epoch", 1, 256, path)?,
        })
    }
}
impl DomainEncode for RequestContext {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("requestID", &self.request_id)
            .field("principal", &self.principal)
            .field("epoch", &self.epoch)
            .finish()
    }
}
impl DomainDecode for Principal {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let o = object(
            value,
            path,
            &["ownerID", "deviceID", "clientID", "grantID", "epoch"],
        )?;
        Ok(Self {
            owner_id: bounded(&o, "ownerID", 1, 256, path)?,
            device_id: bounded(&o, "deviceID", 1, 256, path)?,
            client_id: client(&o, path)?,
            grant_id: bounded(&o, "grantID", 1, 256, path)?,
            epoch: bounded(&o, "epoch", 1, 256, path)?,
        })
    }
}
impl DomainEncode for Principal {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("ownerID", &self.owner_id)
            .field("deviceID", &self.device_id)
            .field("clientID", &self.client_id)
            .field("grantID", &self.grant_id)
            .field("epoch", &self.epoch)
            .finish()
    }
}
impl Principal {
    pub fn context(&self) -> ContextPrincipal {
        ContextPrincipal {
            owner_id: self.owner_id.clone(),
            device_id: self.device_id.clone(),
            client_id: self.client_id.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Arguments {
    pub session_id: session::Id,
    pub include_descendants: bool,
}
impl DomainDecode for Arguments {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let o = object(value, path, &["session_id", "include_descendants"])?;
        Ok(Self {
            session_id: o.field("session_id")?,
            include_descendants: o.optional("include_descendants")?.unwrap_or(false),
        })
    }
}
impl DomainEncode for Arguments {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("session_id", &self.session_id)
            .field("include_descendants", &self.include_descendants)
            .finish()
    }
}

#[derive(Clone, PartialEq)]
pub struct Delivery {
    pub mode: LosslessString,
    pub url: LosslessString,
    pub secret: LosslessString,
}
impl std::fmt::Debug for Delivery {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Delivery([redacted])")
    }
}
impl DomainDecode for Delivery {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let o = object(value, path, &["mode", "url", "secret"])?;
        o.literal("mode", &"webhook".encode())?;
        Ok(Self {
            mode: "webhook".into(),
            url: bounded(&o, "url", 1, 2048, path)?,
            secret: bounded(&o, "secret", 1, 256, path)?,
        })
    }
}
impl DomainEncode for Delivery {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("mode", &self.mode)
            .field("url", &self.url)
            .field("secret", &self.secret)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct UnsubscribeDelivery {
    pub mode: LosslessString,
    pub url: LosslessString,
}
impl DomainDecode for UnsubscribeDelivery {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let o = object(value, path, &["mode", "url"])?;
        o.literal("mode", &"webhook".encode())?;
        Ok(Self {
            mode: "webhook".into(),
            url: bounded(&o, "url", 1, 2048, path)?,
        })
    }
}
impl DomainEncode for UnsubscribeDelivery {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("mode", &self.mode)
            .field("url", &self.url)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Subscribe {
    pub name: Name,
    pub arguments: Arguments,
    pub delivery: Delivery,
    pub cursor: Presence<LosslessString>,
    pub ttl_ms: Presence<NonNegativeInt>,
}
impl DomainDecode for Subscribe {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let o = object(
            value,
            path,
            &["name", "arguments", "delivery", "cursor", "ttlMs"],
        )?;
        let cursor = o.presence::<LosslessString>("cursor")?;
        if let Presence::Value(cursor) = &cursor {
            check_length(cursor, 0, 1024, &path.key("cursor"))?;
        }
        Ok(Self {
            name: o.field("name")?,
            arguments: o.field("arguments")?,
            delivery: o.field("delivery")?,
            cursor,
            ttl_ms: o.presence("ttlMs")?,
        })
    }
}
impl DomainEncode for Subscribe {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("name", &self.name)
            .field("arguments", &self.arguments)
            .field("delivery", &self.delivery)
            .presence("cursor", &self.cursor)
            .presence("ttlMs", &self.ttl_ms)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Unsubscribe {
    pub name: Name,
    pub arguments: Arguments,
    pub delivery: UnsubscribeDelivery,
}
impl DomainDecode for Unsubscribe {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let o = object(value, path, &["name", "arguments", "delivery"])?;
        Ok(Self {
            name: o.field("name")?,
            arguments: o.field("arguments")?,
            delivery: o.field("delivery")?,
        })
    }
}
impl DomainEncode for Unsubscribe {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("name", &self.name)
            .field("arguments", &self.arguments)
            .field("delivery", &self.delivery)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Subscription {
    pub id: LosslessString,
    pub refresh_before: Option<LosslessString>,
    pub cursor: Option<LosslessString>,
    pub truncated: bool,
}
impl DomainDecode for Subscription {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let o = object(value, path, &["id", "refreshBefore", "cursor", "truncated"])?;
        Ok(Self {
            id: o.field("id")?,
            refresh_before: nullable(&o, "refreshBefore")?,
            cursor: nullable(&o, "cursor")?,
            truncated: o.field("truncated")?,
        })
    }
}
impl DomainEncode for Subscription {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field(
                "refreshBefore",
                &self
                    .refresh_before
                    .as_ref()
                    .map_or(JsonValue::Null, DomainEncode::encode),
            )
            .field(
                "cursor",
                &self
                    .cursor
                    .as_ref()
                    .map_or(JsonValue::Null, DomainEncode::encode),
            )
            .field("truncated", &self.truncated)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct EventData {
    pub session_id: session::Id,
    pub root_session_id: session::Id,
    pub state: State,
    pub request_id: Option<LosslessString>,
    pub item_id: Option<LosslessString>,
    pub task_id: Option<LosslessString>,
    pub category: Option<LosslessString>,
    pub reason: Option<LosslessString>,
}
impl DomainDecode for EventData {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let o = object(
            value,
            path,
            &[
                "session_id",
                "root_session_id",
                "state",
                "request_id",
                "item_id",
                "task_id",
                "category",
                "reason",
            ],
        )?;
        Ok(Self {
            session_id: o.field("session_id")?,
            root_session_id: o.field("root_session_id")?,
            state: o.field("state")?,
            request_id: identifier(&o, "request_id", false, path)?,
            item_id: identifier(&o, "item_id", false, path)?,
            task_id: identifier(&o, "task_id", false, path)?,
            category: identifier(&o, "category", true, path)?,
            reason: identifier(&o, "reason", true, path)?,
        })
    }
}
impl DomainEncode for EventData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("session_id", &self.session_id)
            .field("root_session_id", &self.root_session_id)
            .field("state", &self.state)
            .optional("request_id", &self.request_id)
            .optional("item_id", &self.item_id)
            .optional("task_id", &self.task_id)
            .optional("category", &self.category)
            .optional("reason", &self.reason)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Payload {
    pub event_id: LosslessString,
    pub name: Name,
    pub timestamp: LosslessString,
    pub data: EventData,
    pub cursor: Option<LosslessString>,
}
impl DomainDecode for Payload {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let o = object(
            value,
            path,
            &["eventId", "name", "timestamp", "data", "cursor"],
        )?;
        Ok(Self {
            event_id: bounded(&o, "eventId", 1, 256, path)?,
            name: o.field("name")?,
            timestamp: o.field("timestamp")?,
            data: o.field("data")?,
            cursor: nullable(&o, "cursor")?,
        })
    }
}
impl DomainEncode for Payload {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("eventId", &self.event_id)
            .field("name", &self.name)
            .field("timestamp", &self.timestamp)
            .field("data", &self.data)
            .field(
                "cursor",
                &self
                    .cursor
                    .as_ref()
                    .map_or(JsonValue::Null, DomainEncode::encode),
            )
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct EventDefinition {
    pub name: Name,
    pub description: LosslessString,
    pub delivery: Vec<LosslessString>,
    pub input_schema: JsonValue,
    pub payload_schema: JsonValue,
}
impl DomainDecode for EventDefinition {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let o = object(
            value,
            path,
            &[
                "name",
                "description",
                "delivery",
                "inputSchema",
                "payloadSchema",
            ],
        )?;
        let delivery = o.field::<Vec<LosslessString>>("delivery")?;
        if delivery
            .iter()
            .any(|value| value.as_str() != Some("webhook"))
        {
            return Err(path
                .key("delivery")
                .error(DecodeErrorKind::Expected("webhook delivery")));
        }
        let input_schema = o.field::<JsonValue>("inputSchema")?;
        let payload_schema = o.field::<JsonValue>("payloadSchema")?;
        if !matches!(&input_schema, JsonValue::Object(_))
            || !matches!(&payload_schema, JsonValue::Object(_))
        {
            return Err(path.error(DecodeErrorKind::Expected("JSON schema objects")));
        }
        Ok(Self {
            name: o.field("name")?,
            description: o.field("description")?,
            delivery,
            input_schema,
            payload_schema,
        })
    }
}
impl DomainEncode for EventDefinition {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("name", &self.name)
            .field("description", &self.description)
            .field("delivery", &self.delivery)
            .field("inputSchema", &self.input_schema)
            .field("payloadSchema", &self.payload_schema)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ListResult {
    pub events: Vec<EventDefinition>,
}
impl DomainDecode for ListResult {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let o = object(value, path, &["events"])?;
        Ok(Self {
            events: o.field("events")?,
        })
    }
}
impl DomainEncode for ListResult {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().field("events", &self.events).finish()
    }
}
pub fn definitions() -> ListResult {
    let input=crate::parse_json(r#"{"type":"object","properties":{"session_id":{"type":"string"},"include_descendants":{"type":"boolean","default":false}},"required":["session_id"],"additionalProperties":false}"#).expect("static Events input schema");
    let payload=crate::parse_json(r#"{"type":"object","properties":{"session_id":{"type":"string"},"root_session_id":{"type":"string"},"state":{"type":"string"},"request_id":{"type":"string"},"item_id":{"type":"string"},"task_id":{"type":"string"},"category":{"type":"string"},"reason":{"type":"string"}},"required":["session_id","root_session_id","state"],"additionalProperties":false}"#).expect("static Events payload schema");
    ListResult {
        events: NAMES
            .into_iter()
            .map(|name| EventDefinition {
                name,
                description: match name {
                    Name::GuardrailChanged => {
                        "A guardrail review for the session needs attention or settled."
                    }
                    Name::PermissionChanged => {
                        "A permission request for the session needs attention or settled."
                    }
                    Name::QuestionChanged => {
                        "A question for the session needs attention or settled."
                    }
                    Name::FormChanged => "A form for the session needs attention or settled.",
                    Name::Progress => "Execution or task state for the session changed materially.",
                    Name::Completed => "Work for the session completed.",
                    Name::Error => "Execution or a task for the session failed.",
                }
                .into(),
                delivery: vec!["webhook".into()],
                input_schema: input.clone(),
                payload_schema: payload.clone(),
            })
            .collect(),
    }
}

fn object<'a>(
    value: &'a JsonValue,
    path: &'a JsonPath,
    keys: &[&str],
) -> Result<ObjectDecoder<'a>, DecodeError> {
    let o = ObjectDecoder::new(value, path)?;
    if let JsonValue::Object(fields) = value {
        for (key, _) in fields.iter() {
            if !keys
                .iter()
                .any(|allowed| key == &LosslessString::from(*allowed))
            {
                return Err(path
                    .key(key.clone())
                    .error(DecodeErrorKind::Expected("known field")));
            }
        }
    }
    Ok(o)
}
fn bounded(
    o: &ObjectDecoder<'_>,
    key: &str,
    min: usize,
    max: usize,
    path: &JsonPath,
) -> Result<LosslessString, DecodeError> {
    let value = o.field(key)?;
    check_length(&value, min, max, &path.key(key))?;
    Ok(value)
}
fn check_length(
    value: &LosslessString,
    min: usize,
    max: usize,
    path: &JsonPath,
) -> Result<(), DecodeError> {
    if !(min..=max).contains(&value.len()) {
        return Err(path.error(DecodeErrorKind::Length {
            minimum: min,
            maximum: max,
        }));
    }
    Ok(())
}
fn client(o: &ObjectDecoder<'_>, path: &JsonPath) -> Result<LosslessString, DecodeError> {
    let value = bounded(o, "clientID", 1, 2048, path)?;
    if value.code_units().any(|unit| matches!(unit, 0 | 10 | 13)) {
        return Err(path
            .key("clientID")
            .error(DecodeErrorKind::Expected("client identifier")));
    }
    Ok(value)
}
fn nullable<T: DomainDecode>(o: &ObjectDecoder<'_>, key: &str) -> Result<Option<T>, DecodeError> {
    match o.field::<JsonValue>(key)? {
        JsonValue::Null => Ok(None),
        value => T::decode(&value).map(Some),
    }
}
fn identifier(
    o: &ObjectDecoder<'_>,
    key: &str,
    category: bool,
    path: &JsonPath,
) -> Result<Option<LosslessString>, DecodeError> {
    let value = o.optional::<LosslessString>(key)?;
    if let Some(value) = &value {
        let text = value.as_str().ok_or_else(|| {
            path.key(key)
                .error(DecodeErrorKind::Expected("bounded identifier"))
        })?;
        let max = if category { 64 } else { 128 };
        if text.is_empty()
            || text.len() > max
            || !text.bytes().enumerate().all(|(at, byte)| {
                if category {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || (at > 0 && matches!(byte, b'.' | b'_' | b'-'))
                } else {
                    byte.is_ascii_alphanumeric() || (at > 0 && matches!(byte, b'_' | b'-'))
                }
            })
        {
            return Err(path
                .key(key)
                .error(DecodeErrorKind::Expected("bounded identifier")));
        }
    }
    Ok(value)
}
