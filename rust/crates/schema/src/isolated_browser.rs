use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder,
};
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct InstanceId(LosslessString);
impl DomainDecode for InstanceId {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        crate::domain::branded_string(v, "ibrowser_", p).map(Self)
    }
}
impl DomainEncode for InstanceId {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
crate::schema::literal_enum_type!(State,{Unavailable=>"unavailable",Starting=>"starting",Ready=>"ready",Paused=>"paused",Stopped=>"stopped"});
fn utf8_size(value: &LosslessString) -> usize {
    let mut size = 0;
    let mut units = value.code_units().peekable();
    while let Some(unit) = units.next() {
        if (0xd800..=0xdbff).contains(&unit)
            && units.peek().is_some_and(|v| (0xdc00..=0xdfff).contains(v))
        {
            units.next();
            size += 4
        } else if (0xd800..=0xdfff).contains(&unit) {
            size += 3
        } else if unit <= 0x7f {
            size += 1
        } else if unit <= 0x7ff {
            size += 2
        } else {
            size += 3
        }
    }
    size
}
fn bounded(value: JsonValue, path: &JsonPath) -> Result<LosslessString, DecodeError> {
    let s = LosslessString::decode_at(&value, path)?;
    if s.len() <= 8192 && utf8_size(&s) <= 8192 {
        Ok(s)
    } else {
        Err(path.error(DecodeErrorKind::Length {
            minimum: 0,
            maximum: 8192,
        }))
    }
}
fn parsed_url(value: &LosslessString) -> Option<url::Url> {
    let scalar: String = char::decode_utf16(value.code_units())
        .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect();
    url::Url::parse(&scalar).ok()
}
fn safe_url(value: &LosslessString) -> bool {
    parsed_url(value).is_some_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none_or(str::is_empty)
    })
}
fn decode_safe(value: JsonValue, path: &JsonPath) -> Result<LosslessString, DecodeError> {
    let s = bounded(value, path)?;
    if safe_url(&s) {
        Ok(s)
    } else {
        Err(path.error(DecodeErrorKind::Expected(
            "credential-free HTTP or HTTPS URL",
        )))
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Status {
    pub state: State,
    pub reason: Option<LosslessString>,
    pub instance_id: Option<InstanceId>,
    pub tab: Option<crate::browser::Tab>,
}
impl DomainDecode for Status {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("mode", &JsonValue::String("isolated".into()))?;
        let reason: Option<LosslessString> = o.optional("reason")?;
        if reason.as_ref().is_some_and(|x| x.len() > 1024) {
            return Err(p.key("reason").error(DecodeErrorKind::Length {
                minimum: 0,
                maximum: 1024,
            }));
        }
        Ok(Self {
            state: o.field("state")?,
            reason,
            instance_id: o.optional("instanceID")?,
            tab: o.optional("tab")?,
        })
    }
}
impl DomainEncode for Status {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("mode", &LosslessString::from("isolated"))
            .field("state", &self.state)
            .optional("reason", &self.reason)
            .optional("instanceID", &self.instance_id)
            .optional("tab", &self.tab)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct StartInput {
    pub url: LosslessString,
}
impl DomainDecode for StartInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            url: decode_safe(o.field("url")?, &p.key("url"))?,
        })
    }
}
impl DomainEncode for StartInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().field("url", &self.url).finish()
    }
}
pub type StartPayload = StartInput;
#[derive(Clone, Debug, PartialEq)]
pub struct ObserveInput {
    pub session_id: crate::session_id::SessionId,
    pub tab_id: crate::browser::TabId,
    pub generation: crate::browser::Generation,
    pub call_id: crate::browser::CallId,
    pub instance_id: InstanceId,
}
impl DomainDecode for ObserveInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            tab_id: o.field("tabID")?,
            generation: o.field("generation")?,
            call_id: o.field("callID")?,
            instance_id: o.field("instanceID")?,
        })
    }
}
impl DomainEncode for ObserveInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("tabID", &self.tab_id)
            .field("generation", &self.generation)
            .field("callID", &self.call_id)
            .field("instanceID", &self.instance_id)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ActionInput {
    pub session_id: crate::session_id::SessionId,
    pub tab_id: crate::browser::TabId,
    pub generation: crate::browser::Generation,
    pub document_generation: crate::browser::DocumentGeneration,
    pub observation_revision: crate::browser::ObservationRevision,
    pub call_id: crate::browser::CallId,
    pub action: crate::browser::Action,
    pub instance_id: InstanceId,
}
impl DomainDecode for ActionInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            tab_id: o.field("tabID")?,
            generation: o.field("generation")?,
            document_generation: o.field("documentGeneration")?,
            observation_revision: o.field("observationRevision")?,
            call_id: o.field("callID")?,
            action: o.field("action")?,
            instance_id: o.field("instanceID")?,
        })
    }
}
impl DomainEncode for ActionInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("tabID", &self.tab_id)
            .field("generation", &self.generation)
            .field("documentGeneration", &self.document_generation)
            .field("observationRevision", &self.observation_revision)
            .field("callID", &self.call_id)
            .field("action", &self.action)
            .field("instanceID", &self.instance_id)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Observation {
    pub tab_id: crate::browser::TabId,
    pub generation: crate::browser::Generation,
    pub document_generation: crate::browser::DocumentGeneration,
    pub revision: crate::browser::ObservationRevision,
    pub title: LosslessString,
    pub page: crate::browser::Page,
    pub elements: Vec<crate::browser::Element>,
    pub truncated: bool,
    pub instance_id: InstanceId,
}
impl DomainDecode for Observation {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("mode", &JsonValue::String("isolated".into()))?;
        Ok(Self {
            tab_id: o.field("tabID")?,
            generation: o.field("generation")?,
            document_generation: o.field("documentGeneration")?,
            revision: o.field("revision")?,
            title: o.field("title")?,
            page: o.field("page")?,
            elements: o.field("elements")?,
            truncated: o.field("truncated")?,
            instance_id: o.field("instanceID")?,
        })
    }
}
impl DomainEncode for Observation {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("tabID", &self.tab_id)
            .field("generation", &self.generation)
            .field("documentGeneration", &self.document_generation)
            .field("revision", &self.revision)
            .field("title", &self.title)
            .field("page", &self.page)
            .field("elements", &self.elements)
            .field("truncated", &self.truncated)
            .field("mode", &LosslessString::from("isolated"))
            .field("instanceID", &self.instance_id)
            .finish()
    }
}
crate::schema::literal_enum_type!(ActionStatus,{Completed=>"completed",Rejected=>"rejected",Uncertain=>"uncertain"});
#[derive(Clone, Debug, PartialEq)]
pub struct ActionResult {
    pub instance_id: InstanceId,
    pub call_id: crate::browser::CallId,
    pub tab: crate::browser::Tab,
    pub status: ActionStatus,
    pub message: Option<LosslessString>,
    pub capture: Option<crate::browser::CaptureOutput>,
}
impl DomainDecode for ActionResult {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("mode", &JsonValue::String("isolated".into()))?;
        let message: Option<LosslessString> = o.optional("message")?;
        if message.as_ref().is_some_and(|x| x.len() > 1024) {
            return Err(p.key("message").error(DecodeErrorKind::Length {
                minimum: 0,
                maximum: 1024,
            }));
        }
        Ok(Self {
            instance_id: o.field("instanceID")?,
            call_id: o.field("callID")?,
            tab: o.field("tab")?,
            status: o.field("status")?,
            message,
            capture: o.optional("capture")?,
        })
    }
}
impl DomainEncode for ActionResult {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("mode", &LosslessString::from("isolated"))
            .field("instanceID", &self.instance_id)
            .field("callID", &self.call_id)
            .field("tab", &self.tab)
            .field("status", &self.status)
            .optional("message", &self.message)
            .optional("capture", &self.capture)
            .finish()
    }
}
pub type ControlInput = crate::browser::ControlInput;
