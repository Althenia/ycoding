use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder,
};
pub const MAX_OBSERVATION_ELEMENTS: usize = 200;
pub const MAX_TYPE_BYTES: usize = 8 * 1024;
pub const MAX_CAPTURE_BYTES: usize = 1024 * 1024;
pub const MAX_TITLE_LENGTH: usize = 512;
pub const MAX_NAME_LENGTH: usize = 1024;
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct TabId(LosslessString);
impl DomainDecode for TabId {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        crate::domain::branded_string(v, "btab_", p).map(Self)
    }
}
impl DomainEncode for TabId {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
pub type Generation = crate::schema::PositiveInt;
pub type DocumentGeneration = crate::schema::PositiveInt;
pub type ObservationRevision = crate::schema::NonNegativeInt;
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CallId(LosslessString);
impl DomainDecode for CallId {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let x = LosslessString::decode_at(v, p)?;
        if (1..=512).contains(&x.len()) {
            Ok(Self(x))
        } else {
            Err(p.error(DecodeErrorKind::Length {
                minimum: 1,
                maximum: 512,
            }))
        }
    }
}
impl DomainEncode for CallId {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
fn js_utf8_len(value: &LosslessString) -> usize {
    let mut n = 0;
    let mut it = value.code_units().peekable();
    while let Some(u) = it.next() {
        if (0xd800..=0xdbff).contains(&u) {
            if it.peek().is_some_and(|v| (0xdc00..=0xdfff).contains(v)) {
                it.next();
                n += 4
            } else {
                n += 3
            }
        } else if (0xdc00..=0xdfff).contains(&u) {
            n += 3
        } else if u <= 0x7f {
            n += 1
        } else if u <= 0x7ff {
            n += 2
        } else {
            n += 3
        }
    }
    n
}
fn bounded_utf8(
    value: JsonValue,
    path: &JsonPath,
    max: usize,
) -> Result<LosslessString, DecodeError> {
    let s = LosslessString::decode_at(&value, path)?;
    if js_utf8_len(&s) <= max {
        Ok(s)
    } else {
        Err(path.error(DecodeErrorKind::Length {
            minimum: 0,
            maximum: max,
        }))
    }
}
fn line_terminator(unit: u16) -> bool {
    matches!(unit, 0x000a | 0x000d | 0x2028 | 0x2029)
}
fn regex_units(value: &LosslessString) -> Vec<u16> {
    let mut units: Vec<_> = value.code_units().collect();
    if units.last().is_some_and(|u| line_terminator(*u)) {
        units.pop();
        if units.last() == Some(&0x000d) && value.code_units().last() == Some(0x000a) {
            units.pop();
        }
    }
    units
}
fn origin_valid(value: &LosslessString) -> bool {
    let units = regex_units(value);
    let rest = if units.starts_with(&"http://".encode_utf16().collect::<Vec<_>>()) {
        &units[7..]
    } else if units.starts_with(&"https://".encode_utf16().collect::<Vec<_>>()) {
        &units[8..]
    } else {
        return false;
    };
    if rest.is_empty() {
        return false;
    }
    let end = if rest[0] == b'[' as u16 {
        let Some(close) = rest.iter().position(|u| *u == b']' as u16) else {
            return false;
        };
        if close <= 1
            || !rest[1..close].iter().all(|u| {
                (*u as u8 as char).is_ascii_hexdigit() || *u == b':' as u16 || *u == b'.' as u16
            })
        {
            return false;
        }
        close + 1
    } else {
        let host_end = rest
            .iter()
            .position(|u| {
                *u == b'/' as u16
                    || *u == b'?' as u16
                    || *u == b'#' as u16
                    || *u == b'@' as u16
                    || *u == b':' as u16
            })
            .unwrap_or(rest.len());
        if host_end == 0 {
            return false;
        }
        if rest[..host_end].iter().any(|u| {
            *u == b'/' as u16
                || *u == b'?' as u16
                || *u == b'#' as u16
                || *u == b'@' as u16
                || *u == b':' as u16
        }) {
            return false;
        }
        host_end
    };
    if end == rest.len() {
        return true;
    }
    if rest[end] != b':' as u16 {
        return false;
    }
    let port = &rest[end + 1..];
    !port.is_empty()
        && port
            .iter()
            .all(|u| (*u >= b'0' as u16) && (*u <= b'9' as u16))
}
fn safe_path(value: &LosslessString) -> bool {
    let units: Vec<_> = value.code_units().collect();
    units.first() == Some(&(b'/' as u16))
        && !units.iter().any(|u| *u == b'?' as u16 || *u == b'#' as u16)
}
#[derive(Clone, Debug, PartialEq)]
pub struct Page {
    pub origin: LosslessString,
    pub path: LosslessString,
}
impl DomainDecode for Page {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let origin: LosslessString = o.field("origin")?;
        let path: LosslessString = o.field("path")?;
        if !origin_valid(&origin) {
            return Err(p
                .key("origin")
                .error(DecodeErrorKind::Expected("browser origin")));
        }
        if !safe_path(&path) {
            return Err(p.key("path").error(DecodeErrorKind::Expected("safe path")));
        }
        Ok(Self { origin, path })
    }
}
impl DomainEncode for Page {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("origin", &self.origin)
            .field("path", &self.path)
            .finish()
    }
}
crate::schema::literal_enum_type!(TabStatus,{Shared=>"shared",Paused=>"paused",Unavailable=>"unavailable"});
crate::schema::literal_enum_type!(PauseReason,{UserActive=>"user_active",Requested=>"requested",Uncertain=>"uncertain",Disconnected=>"disconnected"});
crate::schema::literal_enum_type!(Mode,{Owned=>"owned",Profile=>"profile"});
crate::schema::literal_enum_type!(Lease,{Self_=>"self",Other=>"other"});
#[derive(Clone, Debug, PartialEq)]
pub struct Tab {
    pub id: TabId,
    pub session_id: crate::session_id::SessionId,
    pub title: LosslessString,
    pub page: Page,
    pub status: TabStatus,
    pub generation: Generation,
    pub document_generation: DocumentGeneration,
    pub observation_revision: ObservationRevision,
    pub pause_reason: Option<PauseReason>,
    pub uncertain_call_id: Option<CallId>,
    pub mode: Option<Mode>,
    pub lease: Option<Lease>,
}
impl DomainDecode for Tab {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let title: LosslessString = o.field("title")?;
        if title.len() > MAX_TITLE_LENGTH {
            return Err(p.key("title").error(DecodeErrorKind::Length {
                minimum: 0,
                maximum: MAX_TITLE_LENGTH,
            }));
        }
        Ok(Self {
            id: o.field("id")?,
            session_id: o.field("sessionID")?,
            title,
            page: o.field("page")?,
            status: o.field("status")?,
            generation: o.field("generation")?,
            document_generation: o.field("documentGeneration")?,
            observation_revision: o.field("observationRevision")?,
            pause_reason: o.optional("pauseReason")?,
            uncertain_call_id: o.optional("uncertainCallID")?,
            mode: o.optional("mode")?,
            lease: o.optional("lease")?,
        })
    }
}
impl DomainEncode for Tab {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("sessionID", &self.session_id)
            .field("title", &self.title)
            .field("page", &self.page)
            .field("status", &self.status)
            .field("generation", &self.generation)
            .field("documentGeneration", &self.document_generation)
            .field("observationRevision", &self.observation_revision)
            .optional("pauseReason", &self.pause_reason)
            .optional("uncertainCallID", &self.uncertain_call_id)
            .optional("mode", &self.mode)
            .optional("lease", &self.lease)
            .finish()
    }
}
crate::schema::literal_enum_type!(BridgeState,{Unavailable=>"unavailable",Pairing=>"pairing",Connected=>"connected",Paused=>"paused"});
#[derive(Clone, Debug, PartialEq)]
pub struct Status {
    pub state: BridgeState,
    pub paired: Option<bool>,
    pub profile_granted: Option<bool>,
    pub generation: Option<Generation>,
    pub pairing_expires_at: Option<crate::schema::NonNegativeInt>,
    pub extension_id: Option<LosslessString>,
    pub pending_call_id: Option<CallId>,
}
impl DomainDecode for Status {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let extension_id: Option<LosslessString> = o.optional("extensionID")?;
        if extension_id.as_ref().is_some_and(|x| {
            !x.as_str()
                .is_some_and(|s| s.len() == 32 && s.bytes().all(|b| (b'a'..=b'p').contains(&b)))
        }) {
            return Err(p
                .key("extensionID")
                .error(DecodeErrorKind::Expected("extension ID")));
        }
        Ok(Self {
            state: o.field("state")?,
            paired: o.optional("paired")?,
            profile_granted: o.optional("profileGranted")?,
            generation: o.optional("generation")?,
            pairing_expires_at: o.optional("pairingExpiresAt")?,
            extension_id,
            pending_call_id: o.optional("pendingCallID")?,
        })
    }
}
impl DomainEncode for Status {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("state", &self.state)
            .optional("paired", &self.paired)
            .optional("profileGranted", &self.profile_granted)
            .optional("generation", &self.generation)
            .optional("pairingExpiresAt", &self.pairing_expires_at)
            .optional("extensionID", &self.extension_id)
            .optional("pendingCallID", &self.pending_call_id)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Pairing {
    pub secret: LosslessString,
    pub expires_at: crate::schema::NonNegativeInt,
}
impl DomainDecode for Pairing {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let secret: LosslessString = o.field("secret")?;
        if !(32..=128).contains(&secret.len()) {
            return Err(p.key("secret").error(DecodeErrorKind::Length {
                minimum: 32,
                maximum: 128,
            }));
        }
        Ok(Self {
            secret,
            expires_at: o.field("expiresAt")?,
        })
    }
}
impl DomainEncode for Pairing {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("secret", &self.secret)
            .field("expiresAt", &self.expires_at)
            .finish()
    }
}
fn valid_ref(v: &LosslessString) -> bool {
    let Some(s) = v.as_str() else { return false };
    let b = s.as_bytes();
    (2..=5).contains(&b.len())
        && b[0] == b'b'
        && b[1].is_ascii_digit()
        && b[1] != b'0'
        && b[2..].iter().all(|x| x.is_ascii_digit())
}
#[derive(Clone, Debug, PartialEq)]
pub struct Element {
    pub r#ref: LosslessString,
    pub role: LosslessString,
    pub name: LosslessString,
    pub description: Option<LosslessString>,
    pub disabled: Option<bool>,
    pub destination: Option<Page>,
}
impl DomainDecode for Element {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let r#ref: LosslessString = o.field("ref")?;
        if !valid_ref(&r#ref) {
            return Err(p
                .key("ref")
                .error(DecodeErrorKind::Expected("browser element reference")));
        }
        let role: LosslessString = o.field("role")?;
        let name: LosslessString = o.field("name")?;
        if role.len() > 64 {
            return Err(p.key("role").error(DecodeErrorKind::Length {
                minimum: 0,
                maximum: 64,
            }));
        }
        if name.len() > MAX_NAME_LENGTH {
            return Err(p.key("name").error(DecodeErrorKind::Length {
                minimum: 0,
                maximum: MAX_NAME_LENGTH,
            }));
        }
        let description: Option<LosslessString> = o.optional("description")?;
        if description
            .as_ref()
            .is_some_and(|x| x.len() > MAX_NAME_LENGTH)
        {
            return Err(p.key("description").error(DecodeErrorKind::Length {
                minimum: 0,
                maximum: MAX_NAME_LENGTH,
            }));
        }
        Ok(Self {
            r#ref,
            role,
            name,
            description,
            disabled: o.optional("disabled")?,
            destination: o.optional("destination")?,
        })
    }
}
impl DomainEncode for Element {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("ref", &self.r#ref)
            .field("role", &self.role)
            .field("name", &self.name)
            .optional("description", &self.description)
            .optional("disabled", &self.disabled)
            .optional("destination", &self.destination)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Observation {
    pub tab_id: TabId,
    pub generation: Generation,
    pub document_generation: DocumentGeneration,
    pub revision: ObservationRevision,
    pub title: LosslessString,
    pub page: Page,
    pub elements: Vec<Element>,
    pub truncated: bool,
}
impl DomainDecode for Observation {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let title: LosslessString = o.field("title")?;
        if title.len() > MAX_TITLE_LENGTH {
            return Err(p.key("title").error(DecodeErrorKind::Length {
                minimum: 0,
                maximum: MAX_TITLE_LENGTH,
            }));
        }
        let elements: Vec<Element> = o.field("elements")?;
        if elements.len() > MAX_OBSERVATION_ELEMENTS {
            return Err(p.key("elements").error(DecodeErrorKind::Length {
                minimum: 0,
                maximum: MAX_OBSERVATION_ELEMENTS,
            }));
        }
        Ok(Self {
            tab_id: o.field("tabID")?,
            generation: o.field("generation")?,
            document_generation: o.field("documentGeneration")?,
            revision: o.field("revision")?,
            title,
            page: o.field("page")?,
            elements,
            truncated: o.field("truncated")?,
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
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Navigate {
    pub url: LosslessString,
}
impl DomainDecode for Navigate {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("navigate".into()))?;
        Ok(Self {
            url: bounded_utf8(o.field("url")?, &p.key("url"), 8 * 1024)?,
        })
    }
}
impl DomainEncode for Navigate {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("navigate"))
            .field("url", &self.url)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Click {
    pub r#ref: LosslessString,
}
impl DomainDecode for Click {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("click".into()))?;
        let r#ref: LosslessString = o.field("ref")?;
        if !valid_ref(&r#ref) {
            return Err(p
                .key("ref")
                .error(DecodeErrorKind::Expected("browser element reference")));
        }
        Ok(Self { r#ref })
    }
}
impl DomainEncode for Click {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("click"))
            .field("ref", &self.r#ref)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Type {
    pub r#ref: LosslessString,
    pub text: LosslessString,
}
impl DomainDecode for Type {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("type".into()))?;
        let r#ref: LosslessString = o.field("ref")?;
        if !valid_ref(&r#ref) {
            return Err(p
                .key("ref")
                .error(DecodeErrorKind::Expected("browser element reference")));
        }
        Ok(Self {
            r#ref,
            text: bounded_utf8(o.field("text")?, &p.key("text"), MAX_TYPE_BYTES)?,
        })
    }
}
impl DomainEncode for Type {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("type"))
            .field("ref", &self.r#ref)
            .field("text", &self.text)
            .finish()
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Scroll {
    pub delta_y: crate::schema::Int,
}
impl DomainDecode for Scroll {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("scroll".into()))?;
        let delta_y: crate::schema::Int = o.field("deltaY")?;
        if !(-10000..=10000).contains(&delta_y.get()) {
            return Err(p.key("deltaY").error(DecodeErrorKind::NumberRange {
                minimum: -10000.0,
                maximum: 10000.0,
                integer: true,
            }));
        }
        Ok(Self { delta_y })
    }
}
impl DomainEncode for Scroll {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("scroll"))
            .field("deltaY", &self.delta_y)
            .finish()
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Capture;
impl DomainDecode for Capture {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        ObjectDecoder::new(v, p)?.literal("type", &JsonValue::String("capture".into()))?;
        Ok(Self)
    }
}
impl DomainEncode for Capture {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("capture"))
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Group {
    pub tab_ids: Vec<TabId>,
    pub title: LosslessString,
}
impl DomainDecode for Group {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("group".into()))?;
        let tab_ids: Vec<TabId> = o.field("tabIDs")?;
        let title: LosslessString = o.field("title")?;
        if !(1..=8).contains(&tab_ids.len()) {
            return Err(p.key("tabIDs").error(DecodeErrorKind::Length {
                minimum: 1,
                maximum: 8,
            }));
        }
        if !(1..=64).contains(&title.len()) {
            return Err(p.key("title").error(DecodeErrorKind::Length {
                minimum: 1,
                maximum: 64,
            }));
        }
        Ok(Self { tab_ids, title })
    }
}
impl DomainEncode for Group {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("group"))
            .field("tabIDs", &self.tab_ids)
            .field("title", &self.title)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Ungroup {
    pub tab_ids: Vec<TabId>,
    pub group_id: crate::schema::NonNegativeInt,
}
impl DomainDecode for Ungroup {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("ungroup".into()))?;
        let tab_ids: Vec<TabId> = o.field("tabIDs")?;
        if !(1..=8).contains(&tab_ids.len()) {
            return Err(p.key("tabIDs").error(DecodeErrorKind::Length {
                minimum: 1,
                maximum: 8,
            }));
        }
        Ok(Self {
            tab_ids,
            group_id: o.field("groupID")?,
        })
    }
}
impl DomainEncode for Ungroup {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("ungroup"))
            .field("tabIDs", &self.tab_ids)
            .field("groupID", &self.group_id)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Navigate(Navigate),
    Click(Click),
    Type(Type),
    Scroll(Scroll),
    Capture(Capture),
    Group(Group),
    Ungroup(Ungroup),
}
impl DomainDecode for Action {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        match o
            .tag(
                "type",
                &[
                    "navigate", "click", "type", "scroll", "capture", "group", "ungroup",
                ],
            )?
            .as_str()
        {
            Some("navigate") => Navigate::decode_at(v, p).map(Self::Navigate),
            Some("click") => Click::decode_at(v, p).map(Self::Click),
            Some("type") => Type::decode_at(v, p).map(Self::Type),
            Some("scroll") => Scroll::decode_at(v, p).map(Self::Scroll),
            Some("capture") => Capture::decode_at(v, p).map(Self::Capture),
            Some("group") => Group::decode_at(v, p).map(Self::Group),
            Some("ungroup") => Ungroup::decode_at(v, p).map(Self::Ungroup),
            _ => Err(p.error(DecodeErrorKind::Expected("browser action"))),
        }
    }
}
impl DomainEncode for Action {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Navigate(x) => x.encode(),
            Self::Click(x) => x.encode(),
            Self::Type(x) => x.encode(),
            Self::Scroll(x) => x.encode(),
            Self::Capture(x) => x.encode(),
            Self::Group(x) => x.encode(),
            Self::Ungroup(x) => x.encode(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ActionInput {
    pub session_id: crate::session_id::SessionId,
    pub tab_id: TabId,
    pub generation: Generation,
    pub document_generation: DocumentGeneration,
    pub observation_revision: ObservationRevision,
    pub call_id: CallId,
    pub action: Action,
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
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ObserveInput {
    pub session_id: crate::session_id::SessionId,
    pub tab_id: TabId,
    pub generation: Generation,
    pub call_id: CallId,
}
impl DomainDecode for ObserveInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            tab_id: o.field("tabID")?,
            generation: o.field("generation")?,
            call_id: o.field("callID")?,
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
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct OpenInput {
    pub session_id: crate::session_id::SessionId,
    pub generation: Generation,
    pub url: LosslessString,
    pub call_id: CallId,
}
impl DomainDecode for OpenInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            generation: o.field("generation")?,
            url: bounded_utf8(o.field("url")?, &p.key("url"), 8 * 1024)?,
            call_id: o.field("callID")?,
        })
    }
}
impl DomainEncode for OpenInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("generation", &self.generation)
            .field("url", &self.url)
            .field("callID", &self.call_id)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct CloseInput {
    pub session_id: crate::session_id::SessionId,
    pub tab_id: TabId,
    pub generation: Generation,
    pub call_id: CallId,
}
impl DomainDecode for CloseInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            tab_id: o.field("tabID")?,
            generation: o.field("generation")?,
            call_id: o.field("callID")?,
        })
    }
}
impl DomainEncode for CloseInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("tabID", &self.tab_id)
            .field("generation", &self.generation)
            .field("callID", &self.call_id)
            .finish()
    }
}
pub type ReleaseInput = CloseInput;
fn base64(value: &LosslessString) -> bool {
    let units: Vec<_> = value.code_units().collect();
    let end = if units.last().is_some_and(|u| line_terminator(*u)) {
        units.len() - 1
    } else {
        units.len()
    };
    let bytes = &units[..end];
    let mut padding = 0;
    for u in bytes.iter().rev() {
        if *u == b'=' as u16 {
            padding += 1
        } else {
            break;
        }
    }
    padding <= 2
        && bytes[..bytes.len() - padding].iter().all(|u| {
            (*u >= b'A' as u16 && *u <= b'Z' as u16)
                || (*u >= b'a' as u16 && *u <= b'z' as u16)
                || (*u >= b'0' as u16 && *u <= b'9' as u16)
                || *u == b'+' as u16
                || *u == b'/' as u16
        })
}
#[derive(Clone, Debug, PartialEq)]
pub struct CaptureOutput {
    pub data: LosslessString,
    pub bytes: crate::schema::NonNegativeInt,
}
impl DomainDecode for CaptureOutput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("mediaType", &JsonValue::String("image/png".into()))?;
        let data: LosslessString = o.field("data")?;
        if data.len() > ((MAX_CAPTURE_BYTES * 4).div_ceil(3) + 8) || !base64(&data) {
            return Err(p
                .key("data")
                .error(DecodeErrorKind::Expected("base64 capture data")));
        }
        let bytes: crate::schema::NonNegativeInt = o.field("bytes")?;
        if bytes.get() > MAX_CAPTURE_BYTES as i64 {
            return Err(p.key("bytes").error(DecodeErrorKind::NumberRange {
                minimum: 0.0,
                maximum: MAX_CAPTURE_BYTES as f64,
                integer: true,
            }));
        }
        Ok(Self { data, bytes })
    }
}
impl DomainEncode for CaptureOutput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("mediaType", &LosslessString::from("image/png"))
            .field("data", &self.data)
            .field("bytes", &self.bytes)
            .finish()
    }
}
crate::schema::literal_enum_type!(ResultStatus,{Completed=>"completed",Paused=>"paused",Rejected=>"rejected",Uncertain=>"uncertain"});
crate::schema::literal_enum_type!(InputKind,{Trusted=>"trusted",Scripted=>"scripted"});
#[derive(Clone, Debug, PartialEq)]
pub struct ActionResult {
    pub call_id: CallId,
    pub tab: Tab,
    pub status: ResultStatus,
    pub message: Option<LosslessString>,
    pub capture: Option<CaptureOutput>,
    pub group_id: Option<crate::schema::NonNegativeInt>,
    pub input: Option<InputKind>,
}
impl DomainDecode for ActionResult {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let message: Option<LosslessString> = o.optional("message")?;
        if message.as_ref().is_some_and(|x| x.len() > 1024) {
            return Err(p.key("message").error(DecodeErrorKind::Length {
                minimum: 0,
                maximum: 1024,
            }));
        }
        Ok(Self {
            call_id: o.field("callID")?,
            tab: o.field("tab")?,
            status: o.field("status")?,
            message,
            capture: o.optional("capture")?,
            group_id: o.optional("groupID")?,
            input: o.optional("input")?,
        })
    }
}
impl DomainEncode for ActionResult {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("callID", &self.call_id)
            .field("tab", &self.tab)
            .field("status", &self.status)
            .optional("message", &self.message)
            .optional("capture", &self.capture)
            .optional("groupID", &self.group_id)
            .optional("input", &self.input)
            .finish()
    }
}
crate::schema::literal_enum_type!(ControlAction,{Pause=>"pause",Resume=>"resume"});
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ControlInput {
    pub action: ControlAction,
}
impl DomainDecode for ControlInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            action: ObjectDecoder::new(v, p)?.field("action")?,
        })
    }
}
impl DomainEncode for ControlInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().field("action", &self.action).finish()
    }
}
