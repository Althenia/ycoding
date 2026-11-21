use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder,
};
pub const MAX_OBSERVATION_ELEMENTS: usize = 200;
pub const MAX_OBSERVATION_TEXTS: usize = 100;
pub const MAX_OBSERVATION_FRAMES: usize = 32;
pub const MAX_TYPE_BYTES: usize = 8 * 1024;
pub const MAX_DIALOG_TEXT_BYTES: usize = 4 * 1024;
pub const MAX_LOCATOR_LENGTH: usize = 512;
pub const MAX_SELECT_OPTIONS: usize = 32;
pub const MAX_URL_PATTERN_BYTES: usize = 2048;
pub const MAX_WAIT_TEXT_BYTES: usize = 1024;
pub const MAX_CAPTURE_BYTES: usize = 1024 * 1024;
pub const MAX_TITLE_LENGTH: usize = 512;
pub const MAX_NAME_LENGTH: usize = 1024;
pub const MAX_WAIT_MS: i64 = 30_000;
pub const MAX_CLIPBOARD_BYTES: usize = 64 * 1024;
pub const MAX_LOG_ENTRIES: usize = 100;
pub const MAX_UPLOAD_FILES: usize = 8;
pub const MAX_HISTORY_RESULTS: usize = 100;
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
pub(crate) fn bounded_utf8(
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
    pub group_id: Option<crate::schema::NonNegativeInt>,
    pub deliverable: Option<bool>,
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
            group_id: o.optional("groupID")?,
            deliverable: o.optional("deliverable")?,
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
            .optional("groupID", &self.group_id)
            .optional("deliverable", &self.deliverable)
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
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Tristate {
    Boolean(bool),
    Mixed,
}
impl DomainDecode for Tristate {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        match v {
            JsonValue::Bool(value) => Ok(Self::Boolean(*value)),
            JsonValue::String(value) if value.as_str() == Some("mixed") => Ok(Self::Mixed),
            _ => Err(p.error(DecodeErrorKind::Expected("boolean or mixed"))),
        }
    }
}
impl DomainEncode for Tristate {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Boolean(value) => JsonValue::Bool(*value),
            Self::Mixed => JsonValue::String("mixed".into()),
        }
    }
}
fn sensitive_field(o: &ObjectDecoder<'_>, p: &JsonPath) -> Result<Option<bool>, DecodeError> {
    let value: Option<bool> = o.optional("sensitive")?;
    if value == Some(false) {
        return Err(p
            .key("sensitive")
            .error(DecodeErrorKind::Literal(vec![JsonValue::Bool(true)])));
    }
    Ok(value)
}
fn bounded_optional(
    o: &ObjectDecoder<'_>,
    p: &JsonPath,
    key: &str,
    maximum: usize,
) -> Result<Option<LosslessString>, DecodeError> {
    let value: Option<LosslessString> = o.optional(key)?;
    if value.as_ref().is_some_and(|x| x.len() > maximum) {
        return Err(p.key(key).error(DecodeErrorKind::Length {
            minimum: 0,
            maximum,
        }));
    }
    Ok(value)
}
fn ref_field(o: &ObjectDecoder<'_>, p: &JsonPath) -> Result<Option<LosslessString>, DecodeError> {
    let value: Option<LosslessString> = o.optional("ref")?;
    if value.as_ref().is_some_and(|x| !valid_ref(x)) {
        return Err(p
            .key("ref")
            .error(DecodeErrorKind::Expected("browser element reference")));
    }
    Ok(value)
}
fn locator_field(
    o: &ObjectDecoder<'_>,
    p: &JsonPath,
) -> Result<Option<LosslessString>, DecodeError> {
    let value: Option<LosslessString> = o.optional("locator")?;
    if value
        .as_ref()
        .is_some_and(|x| !(1..=MAX_LOCATOR_LENGTH).contains(&x.len()))
    {
        return Err(p.key("locator").error(DecodeErrorKind::Length {
            minimum: 1,
            maximum: MAX_LOCATOR_LENGTH,
        }));
    }
    Ok(value)
}
#[derive(Clone, Debug, PartialEq)]
pub struct Element {
    pub r#ref: LosslessString,
    pub role: LosslessString,
    pub name: LosslessString,
    pub description: Option<LosslessString>,
    pub disabled: Option<bool>,
    pub checked: Option<Tristate>,
    pub pressed: Option<Tristate>,
    pub expanded: Option<bool>,
    pub selected: Option<bool>,
    pub value: Option<LosslessString>,
    pub sensitive: Option<bool>,
    pub locator: Option<LosslessString>,
    pub destination: Option<Page>,
    pub frame: Option<Page>,
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
            checked: o.optional("checked")?,
            pressed: o.optional("pressed")?,
            expanded: o.optional("expanded")?,
            selected: o.optional("selected")?,
            value: bounded_optional(&o, p, "value", MAX_NAME_LENGTH)?,
            sensitive: sensitive_field(&o, p)?,
            locator: bounded_optional(&o, p, "locator", MAX_LOCATOR_LENGTH)?,
            destination: o.optional("destination")?,
            frame: o.optional("frame")?,
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
            .optional("checked", &self.checked)
            .optional("pressed", &self.pressed)
            .optional("expanded", &self.expanded)
            .optional("selected", &self.selected)
            .optional("value", &self.value)
            .optional("sensitive", &self.sensitive)
            .optional("locator", &self.locator)
            .optional("destination", &self.destination)
            .optional("frame", &self.frame)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ObservationDelta {
    pub base_revision: ObservationRevision,
    pub removed: Vec<LosslessString>,
}
impl DomainDecode for ObservationDelta {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let removed: Vec<LosslessString> = o.field("removed")?;
        if removed.len() > MAX_OBSERVATION_ELEMENTS {
            return Err(p.key("removed").error(DecodeErrorKind::Length {
                minimum: 0,
                maximum: MAX_OBSERVATION_ELEMENTS,
            }));
        }
        for (index, item) in removed.iter().enumerate() {
            if item.len() > MAX_LOCATOR_LENGTH {
                return Err(p
                    .key("removed")
                    .index(index)
                    .error(DecodeErrorKind::Length {
                        minimum: 0,
                        maximum: MAX_LOCATOR_LENGTH,
                    }));
            }
        }
        Ok(Self {
            base_revision: o.field("baseRevision")?,
            removed,
        })
    }
}
impl DomainEncode for ObservationDelta {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("baseRevision", &self.base_revision)
            .field("removed", &self.removed)
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
    pub texts: Option<Vec<Text>>,
    pub frames: Option<Vec<Frame>>,
    pub delta: Option<ObservationDelta>,
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
        let texts: Option<Vec<Text>> = o.optional("texts")?;
        let frames: Option<Vec<Frame>> = o.optional("frames")?;
        for (name, length, maximum) in [
            (
                "texts",
                texts.as_ref().map_or(0, Vec::len),
                MAX_OBSERVATION_TEXTS,
            ),
            (
                "frames",
                frames.as_ref().map_or(0, Vec::len),
                MAX_OBSERVATION_FRAMES,
            ),
        ] {
            if length > maximum {
                return Err(p.key(name).error(DecodeErrorKind::Length {
                    minimum: 0,
                    maximum,
                }));
            }
        }
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
            texts,
            frames,
            delta: o.optional("delta")?,
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
            .optional("texts", &self.texts)
            .optional("frames", &self.frames)
            .optional("delta", &self.delta)
            .field("truncated", &self.truncated)
            .finish()
    }
}
crate::schema::record_type!(Frame { page: Page => "page", observed: bool => "observed" } {});
#[derive(Clone, Debug, PartialEq)]
pub struct Text {
    pub role: LosslessString,
    pub name: LosslessString,
    pub frame: Option<Page>,
}
impl DomainDecode for Text {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            role: crate::domain::bounded_string(
                &object.field::<JsonValue>("role")?,
                0,
                64,
                &path.key("role"),
            )?,
            name: crate::domain::bounded_string(
                &object.field::<JsonValue>("name")?,
                0,
                MAX_NAME_LENGTH,
                &path.key("name"),
            )?,
            frame: object.optional("frame")?,
        })
    }
}
impl DomainEncode for Text {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("role", &self.role)
            .field("name", &self.name)
            .optional("frame", &self.frame)
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
    pub r#ref: Option<LosslessString>,
    pub locator: Option<LosslessString>,
}
impl DomainDecode for Click {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("click".into()))?;
        Ok(Self {
            r#ref: ref_field(&o, p)?,
            locator: locator_field(&o, p)?,
        })
    }
}
impl DomainEncode for Click {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("click"))
            .optional("ref", &self.r#ref)
            .optional("locator", &self.locator)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Type {
    pub r#ref: Option<LosslessString>,
    pub locator: Option<LosslessString>,
    pub text: LosslessString,
}
impl DomainDecode for Type {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("type".into()))?;
        Ok(Self {
            r#ref: ref_field(&o, p)?,
            locator: locator_field(&o, p)?,
            text: bounded_utf8(o.field("text")?, &p.key("text"), MAX_TYPE_BYTES)?,
        })
    }
}
impl DomainEncode for Type {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("type"))
            .optional("ref", &self.r#ref)
            .optional("locator", &self.locator)
            .field("text", &self.text)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Fill {
    pub r#ref: Option<LosslessString>,
    pub locator: Option<LosslessString>,
    pub text: LosslessString,
}
impl DomainDecode for Fill {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("fill".into()))?;
        Ok(Self {
            r#ref: ref_field(&o, p)?,
            locator: locator_field(&o, p)?,
            text: bounded_utf8(o.field("text")?, &p.key("text"), MAX_TYPE_BYTES)?,
        })
    }
}
impl DomainEncode for Fill {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("fill"))
            .optional("ref", &self.r#ref)
            .optional("locator", &self.locator)
            .field("text", &self.text)
            .finish()
    }
}
fn option_list(
    o: &ObjectDecoder<'_>,
    p: &JsonPath,
    key: &str,
) -> Result<Option<Vec<LosslessString>>, DecodeError> {
    let value: Option<Vec<LosslessString>> = o.optional(key)?;
    if let Some(items) = &value {
        if items.is_empty() || items.len() > MAX_SELECT_OPTIONS {
            return Err(p.key(key).error(DecodeErrorKind::Length {
                minimum: 1,
                maximum: MAX_SELECT_OPTIONS,
            }));
        }
        for (index, item) in items.iter().enumerate() {
            if item.len() > MAX_NAME_LENGTH {
                return Err(p.key(key).index(index).error(DecodeErrorKind::Length {
                    minimum: 0,
                    maximum: MAX_NAME_LENGTH,
                }));
            }
        }
    }
    Ok(value)
}
#[derive(Clone, Debug, PartialEq)]
pub struct Select {
    pub r#ref: Option<LosslessString>,
    pub locator: Option<LosslessString>,
    pub values: Option<Vec<LosslessString>>,
    pub labels: Option<Vec<LosslessString>>,
    pub indexes: Option<Vec<crate::schema::NonNegativeInt>>,
}
impl DomainDecode for Select {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("select".into()))?;
        let values = option_list(&o, p, "values")?;
        let labels = option_list(&o, p, "labels")?;
        let indexes: Option<Vec<crate::schema::NonNegativeInt>> = o.optional("indexes")?;
        if indexes
            .as_ref()
            .is_some_and(|items| items.is_empty() || items.len() > MAX_SELECT_OPTIONS)
        {
            return Err(p.key("indexes").error(DecodeErrorKind::Length {
                minimum: 1,
                maximum: MAX_SELECT_OPTIONS,
            }));
        }
        if [values.is_some(), labels.is_some(), indexes.is_some()]
            .into_iter()
            .filter(|present| *present)
            .count()
            != 1
        {
            return Err(p.error(DecodeErrorKind::Expected(
                "exactly one of values, labels, or indexes",
            )));
        }
        Ok(Self {
            r#ref: ref_field(&o, p)?,
            locator: locator_field(&o, p)?,
            values,
            labels,
            indexes,
        })
    }
}
impl DomainEncode for Select {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("select"))
            .optional("ref", &self.r#ref)
            .optional("locator", &self.locator)
            .optional("values", &self.values)
            .optional("labels", &self.labels)
            .optional("indexes", &self.indexes)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Check {
    pub r#ref: Option<LosslessString>,
    pub locator: Option<LosslessString>,
    pub checked: bool,
}
impl DomainDecode for Check {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("check".into()))?;
        Ok(Self {
            r#ref: ref_field(&o, p)?,
            locator: locator_field(&o, p)?,
            checked: o.field("checked")?,
        })
    }
}
impl DomainEncode for Check {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("check"))
            .optional("ref", &self.r#ref)
            .optional("locator", &self.locator)
            .field("checked", &self.checked)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Hover {
    pub r#ref: Option<LosslessString>,
    pub locator: Option<LosslessString>,
}
impl DomainDecode for Hover {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("hover".into()))?;
        Ok(Self {
            r#ref: ref_field(&o, p)?,
            locator: locator_field(&o, p)?,
        })
    }
}
impl DomainEncode for Hover {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("hover"))
            .optional("ref", &self.r#ref)
            .optional("locator", &self.locator)
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
pub struct Clip {
    pub x: crate::schema::Int,
    pub y: crate::schema::Int,
    pub width: crate::schema::Int,
    pub height: crate::schema::Int,
}
impl DomainDecode for Clip {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let coordinate = |key: &str| -> Result<crate::schema::Int, DecodeError> {
            let value: crate::schema::Int = o.field(key)?;
            if !(0..=100_000).contains(&value.get()) {
                return Err(p.key(key).error(DecodeErrorKind::NumberRange {
                    minimum: 0.0,
                    maximum: 100_000.0,
                    integer: true,
                }));
            }
            Ok(value)
        };
        let size = |key: &str| -> Result<crate::schema::Int, DecodeError> {
            let value: crate::schema::Int = o.field(key)?;
            if !(1..=100_000).contains(&value.get()) {
                return Err(p.key(key).error(DecodeErrorKind::NumberRange {
                    minimum: 1.0,
                    maximum: 100_000.0,
                    integer: true,
                }));
            }
            Ok(value)
        };
        Ok(Self {
            x: coordinate("x")?,
            y: coordinate("y")?,
            width: size("width")?,
            height: size("height")?,
        })
    }
}
impl DomainEncode for Clip {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("x", &self.x)
            .field("y", &self.y)
            .field("width", &self.width)
            .field("height", &self.height)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Capture {
    pub r#ref: Option<LosslessString>,
    pub clip: Option<Clip>,
    pub full_page: Option<bool>,
}
impl DomainDecode for Capture {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("capture".into()))?;
        Ok(Self {
            r#ref: ref_field(&o, p)?,
            clip: o.optional("clip")?,
            full_page: o.optional("fullPage")?,
        })
    }
}
impl DomainEncode for Capture {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("capture"))
            .optional("ref", &self.r#ref)
            .optional("clip", &self.clip)
            .optional("fullPage", &self.full_page)
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
pub struct GroupControl {
    pub tab_ids: Vec<TabId>,
}
impl DomainDecode for GroupControl {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("group_control".into()))?;
        let tab_ids: Vec<TabId> = o.field("tabIDs")?;
        if !(1..=8).contains(&tab_ids.len()) {
            return Err(p.key("tabIDs").error(DecodeErrorKind::Length {
                minimum: 1,
                maximum: 8,
            }));
        }
        Ok(Self { tab_ids })
    }
}
impl DomainEncode for GroupControl {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("group_control"))
            .field("tabIDs", &self.tab_ids)
            .finish()
    }
}
macro_rules! marker_action {
    ($name:ident, $kind:literal) => {
        #[derive(Clone, Debug, PartialEq)]
        pub struct $name;
        impl DomainDecode for $name {
            fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
                ObjectDecoder::new(value, path)?.literal("type", &$kind.encode())?;
                Ok(Self)
            }
        }
        impl DomainEncode for $name {
            fn encode(&self) -> JsonValue {
                ObjectEncoder::new().field("type", $kind).finish()
            }
        }
    };
}
marker_action!(Back, "back");
marker_action!(Forward, "forward");
marker_action!(Reload, "reload");
marker_action!(ClipboardRead, "clipboard_read");
marker_action!(Export, "export");
marker_action!(WebMcpList, "webmcp_list");
crate::schema::literal_enum_type!(Modifier, { Alt => "Alt", Control => "Control", Meta => "Meta", Shift => "Shift" });
#[derive(Clone, Debug, PartialEq)]
pub struct Key {
    pub key: LosslessString,
    pub modifiers: Option<Vec<Modifier>>,
}
impl DomainDecode for Key {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        object.literal("type", &"key".encode())?;
        let modifiers: Option<Vec<Modifier>> = object.optional("modifiers")?;
        if modifiers.as_ref().is_some_and(|items| items.len() > 4) {
            return Err(path.key("modifiers").error(DecodeErrorKind::Length {
                minimum: 0,
                maximum: 4,
            }));
        }
        Ok(Self {
            key: crate::domain::bounded_string(
                &object.field::<JsonValue>("key")?,
                1,
                32,
                &path.key("key"),
            )?,
            modifiers,
        })
    }
}
impl DomainEncode for Key {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "key")
            .field("key", &self.key)
            .optional("modifiers", &self.modifiers)
            .finish()
    }
}
fn timeout(
    object: &ObjectDecoder<'_>,
    path: &JsonPath,
) -> Result<Option<crate::schema::NonNegativeInt>, DecodeError> {
    let value = object.optional::<crate::schema::NonNegativeInt>("timeoutMs")?;
    if value.is_some_and(|value| value.get() > MAX_WAIT_MS) {
        return Err(path
            .key("timeoutMs")
            .error(DecodeErrorKind::Expected("browser wait timeout")));
    }
    Ok(value)
}
crate::schema::literal_enum_type!(WaitState,{Attached=>"attached",Visible=>"visible",Hidden=>"hidden",Detached=>"detached"});
crate::schema::literal_enum_type!(LoadState,{DomContentLoaded=>"domcontentloaded",Load=>"load",NetworkIdle=>"networkidle"});
fn wait_text(
    object: &ObjectDecoder<'_>,
    path: &JsonPath,
    key: &str,
    max: usize,
) -> Result<Option<LosslessString>, DecodeError> {
    let value = object
        .optional::<JsonValue>(key)?
        .map(|value| bounded_utf8(value, &path.key(key), max))
        .transpose()?;
    if value.as_ref().is_some_and(|text| text.is_empty()) {
        return Err(path.key(key).error(DecodeErrorKind::Length {
            minimum: 1,
            maximum: max,
        }));
    }
    Ok(value)
}
#[derive(Clone, Debug, PartialEq)]
pub struct Wait {
    pub r#ref: Option<LosslessString>,
    pub locator: Option<LosslessString>,
    pub state: Option<WaitState>,
    pub url: Option<LosslessString>,
    pub load: Option<LoadState>,
    pub text: Option<LosslessString>,
    pub timeout_ms: Option<crate::schema::NonNegativeInt>,
}
impl DomainDecode for Wait {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        object.literal("type", &"wait".encode())?;
        let r#ref = ref_field(&object, path)?;
        let locator = locator_field(&object, path)?;
        let state: Option<WaitState> = object.optional("state")?;
        let url = wait_text(&object, path, "url", MAX_URL_PATTERN_BYTES)?;
        let load: Option<LoadState> = object.optional("load")?;
        let text = wait_text(&object, path, "text", MAX_WAIT_TEXT_BYTES)?;
        let target = r#ref.is_some() || locator.is_some();
        let conditions = [target, url.is_some(), load.is_some(), text.is_some()]
            .into_iter()
            .filter(|present| *present)
            .count();
        if conditions > 1 || (state.is_some() && !target) {
            return Err(path.error(DecodeErrorKind::Expected(
                "at most one wait condition: ref or locator with optional state, url, load, or text",
            )));
        }
        Ok(Self {
            r#ref,
            locator,
            state,
            url,
            load,
            text,
            timeout_ms: timeout(&object, path)?,
        })
    }
}
impl DomainEncode for Wait {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "wait")
            .optional("ref", &self.r#ref)
            .optional("locator", &self.locator)
            .optional("state", &self.state)
            .optional("url", &self.url)
            .optional("load", &self.load)
            .optional("text", &self.text)
            .optional("timeoutMs", &self.timeout_ms)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Dialog {
    pub accept: Option<bool>,
    pub text: Option<LosslessString>,
}
impl DomainDecode for Dialog {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        object.literal("type", &"dialog".encode())?;
        Ok(Self {
            accept: object.optional("accept")?,
            text: object
                .optional::<JsonValue>("text")?
                .map(|value| bounded_utf8(value, &path.key("text"), MAX_DIALOG_TEXT_BYTES))
                .transpose()?,
        })
    }
}
impl DomainEncode for Dialog {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "dialog")
            .optional("accept", &self.accept)
            .optional("text", &self.text)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ClipboardWrite {
    pub text: LosslessString,
}
impl DomainDecode for ClipboardWrite {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        object.literal("type", &"clipboard_write".encode())?;
        Ok(Self {
            text: bounded_utf8(
                object.field("text")?,
                &path.key("text"),
                MAX_CLIPBOARD_BYTES,
            )?,
        })
    }
}
impl DomainEncode for ClipboardWrite {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "clipboard_write")
            .field("text", &self.text)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Upload {
    pub r#ref: Option<LosslessString>,
    pub locator: Option<LosslessString>,
    pub paths: Vec<LosslessString>,
}
impl DomainDecode for Upload {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        object.literal("type", &"upload".encode())?;
        let r#ref = ref_field(&object, path)?;
        let locator = locator_field(&object, path)?;
        let paths = object.field::<Vec<LosslessString>>("paths")?;
        if paths.is_empty() || paths.len() > MAX_UPLOAD_FILES {
            return Err(path.key("paths").error(DecodeErrorKind::Length {
                minimum: 1,
                maximum: MAX_UPLOAD_FILES,
            }));
        }
        for (index, value) in paths.iter().enumerate() {
            bounded_utf8(value.encode(), &path.key("paths").index(index), 4096)?;
        }
        Ok(Self {
            r#ref,
            locator,
            paths,
        })
    }
}
impl DomainEncode for Upload {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "upload")
            .optional("ref", &self.r#ref)
            .optional("locator", &self.locator)
            .field("paths", &self.paths)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Download {
    pub timeout_ms: Option<crate::schema::NonNegativeInt>,
}
impl DomainDecode for Download {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        object.literal("type", &"download".encode())?;
        Ok(Self {
            timeout_ms: timeout(&object, path)?,
        })
    }
}
impl DomainEncode for Download {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "download")
            .optional("timeoutMs", &self.timeout_ms)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Logs {
    pub limit: Option<crate::schema::PositiveInt>,
}
impl DomainDecode for Logs {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        object.literal("type", &"logs".encode())?;
        let limit = object.optional::<crate::schema::PositiveInt>("limit")?;
        if limit.is_some_and(|value| value.get() > MAX_LOG_ENTRIES as i64) {
            return Err(path
                .key("limit")
                .error(DecodeErrorKind::Expected("browser log limit")));
        }
        Ok(Self { limit })
    }
}
impl DomainEncode for Logs {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "logs")
            .optional("limit", &self.limit)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct WebMcpInvoke {
    pub name: LosslessString,
    pub arguments: Option<crate::domain::Json>,
}
impl DomainDecode for WebMcpInvoke {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        object.literal("type", &"webmcp_invoke".encode())?;
        Ok(Self {
            name: crate::domain::bounded_string(
                &object.field::<JsonValue>("name")?,
                1,
                128,
                &path.key("name"),
            )?,
            arguments: object.optional("arguments")?,
        })
    }
}
impl DomainEncode for WebMcpInvoke {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "webmcp_invoke")
            .field("name", &self.name)
            .optional("arguments", &self.arguments)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Navigate(Navigate),
    Click(Click),
    Type(Type),
    Fill(Fill),
    Select(Select),
    Check(Check),
    Hover(Hover),
    Scroll(Scroll),
    Capture(Capture),
    Group(Group),
    Ungroup(Ungroup),
    GroupControl(GroupControl),
    Back(Back),
    Forward(Forward),
    Reload(Reload),
    Key(Key),
    Wait(Wait),
    ClipboardRead(ClipboardRead),
    ClipboardWrite(ClipboardWrite),
    Upload(Upload),
    Download(Download),
    Logs(Logs),
    Export(Export),
    WebMcpList(WebMcpList),
    WebMcpInvoke(WebMcpInvoke),
    Dialog(Dialog),
}
impl DomainDecode for Action {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        match o
            .tag(
                "type",
                &[
                    "navigate",
                    "click",
                    "type",
                    "fill",
                    "select",
                    "check",
                    "hover",
                    "scroll",
                    "capture",
                    "group",
                    "ungroup",
                    "group_control",
                    "back",
                    "forward",
                    "reload",
                    "key",
                    "wait",
                    "clipboard_read",
                    "clipboard_write",
                    "upload",
                    "download",
                    "logs",
                    "export",
                    "webmcp_list",
                    "webmcp_invoke",
                    "dialog",
                ],
            )?
            .as_str()
        {
            Some("navigate") => Navigate::decode_at(v, p).map(Self::Navigate),
            Some("click") => Click::decode_at(v, p).map(Self::Click),
            Some("type") => Type::decode_at(v, p).map(Self::Type),
            Some("fill") => Fill::decode_at(v, p).map(Self::Fill),
            Some("select") => Select::decode_at(v, p).map(Self::Select),
            Some("check") => Check::decode_at(v, p).map(Self::Check),
            Some("hover") => Hover::decode_at(v, p).map(Self::Hover),
            Some("scroll") => Scroll::decode_at(v, p).map(Self::Scroll),
            Some("capture") => Capture::decode_at(v, p).map(Self::Capture),
            Some("group") => Group::decode_at(v, p).map(Self::Group),
            Some("ungroup") => Ungroup::decode_at(v, p).map(Self::Ungroup),
            Some("group_control") => GroupControl::decode_at(v, p).map(Self::GroupControl),
            Some("back") => Back::decode_at(v, p).map(Self::Back),
            Some("forward") => Forward::decode_at(v, p).map(Self::Forward),
            Some("reload") => Reload::decode_at(v, p).map(Self::Reload),
            Some("key") => Key::decode_at(v, p).map(Self::Key),
            Some("wait") => Wait::decode_at(v, p).map(Self::Wait),
            Some("clipboard_read") => ClipboardRead::decode_at(v, p).map(Self::ClipboardRead),
            Some("clipboard_write") => ClipboardWrite::decode_at(v, p).map(Self::ClipboardWrite),
            Some("upload") => Upload::decode_at(v, p).map(Self::Upload),
            Some("download") => Download::decode_at(v, p).map(Self::Download),
            Some("logs") => Logs::decode_at(v, p).map(Self::Logs),
            Some("export") => Export::decode_at(v, p).map(Self::Export),
            Some("webmcp_list") => WebMcpList::decode_at(v, p).map(Self::WebMcpList),
            Some("webmcp_invoke") => WebMcpInvoke::decode_at(v, p).map(Self::WebMcpInvoke),
            Some("dialog") => Dialog::decode_at(v, p).map(Self::Dialog),
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
            Self::Fill(x) => x.encode(),
            Self::Select(x) => x.encode(),
            Self::Check(x) => x.encode(),
            Self::Hover(x) => x.encode(),
            Self::Scroll(x) => x.encode(),
            Self::Capture(x) => x.encode(),
            Self::Group(x) => x.encode(),
            Self::Ungroup(x) => x.encode(),
            Self::GroupControl(x) => x.encode(),
            Self::Back(x) => x.encode(),
            Self::Forward(x) => x.encode(),
            Self::Reload(x) => x.encode(),
            Self::Key(x) => x.encode(),
            Self::Wait(x) => x.encode(),
            Self::ClipboardRead(x) => x.encode(),
            Self::ClipboardWrite(x) => x.encode(),
            Self::Upload(x) => x.encode(),
            Self::Download(x) => x.encode(),
            Self::Logs(x) => x.encode(),
            Self::Export(x) => x.encode(),
            Self::WebMcpList(x) => x.encode(),
            Self::WebMcpInvoke(x) => x.encode(),
            Self::Dialog(x) => x.encode(),
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
    pub diff: Option<bool>,
}
impl DomainDecode for ObserveInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            tab_id: o.field("tabID")?,
            generation: o.field("generation")?,
            call_id: o.field("callID")?,
            diff: o.optional("diff")?,
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
            .optional("diff", &self.diff)
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
#[derive(Clone, Debug, PartialEq)]
pub struct DownloadInfo {
    pub filename: LosslessString,
    pub state: LosslessString,
    pub bytes_received: Option<crate::schema::NonNegativeInt>,
    pub total_bytes: Option<crate::schema::NonNegativeInt>,
    pub mime: Option<LosslessString>,
}
impl DomainDecode for DownloadInfo {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            filename: crate::domain::bounded_string(
                &object.field::<JsonValue>("filename")?,
                0,
                1024,
                &path.key("filename"),
            )?,
            state: crate::domain::bounded_string(
                &object.field::<JsonValue>("state")?,
                0,
                32,
                &path.key("state"),
            )?,
            bytes_received: object.optional("bytesReceived")?,
            total_bytes: object.optional("totalBytes")?,
            mime: object
                .optional::<JsonValue>("mime")?
                .map(|value| crate::domain::bounded_string(&value, 0, 128, &path.key("mime")))
                .transpose()?,
        })
    }
}
impl DomainEncode for DownloadInfo {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("filename", &self.filename)
            .field("state", &self.state)
            .optional("bytesReceived", &self.bytes_received)
            .optional("totalBytes", &self.total_bytes)
            .optional("mime", &self.mime)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct LogEntry {
    pub level: LosslessString,
    pub text: LosslessString,
    pub frame: Option<Page>,
}
impl DomainDecode for LogEntry {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            level: crate::domain::bounded_string(
                &object.field::<JsonValue>("level")?,
                0,
                16,
                &path.key("level"),
            )?,
            text: crate::domain::bounded_string(
                &object.field::<JsonValue>("text")?,
                0,
                MAX_NAME_LENGTH,
                &path.key("text"),
            )?,
            frame: object.optional("frame")?,
        })
    }
}
impl DomainEncode for LogEntry {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("level", &self.level)
            .field("text", &self.text)
            .optional("frame", &self.frame)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct SavedFile {
    pub path: LosslessString,
    pub bytes: crate::schema::NonNegativeInt,
}
impl DomainDecode for SavedFile {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            path: crate::domain::bounded_string(
                &object.field::<JsonValue>("path")?,
                0,
                4096,
                &path.key("path"),
            )?,
            bytes: object.field("bytes")?,
        })
    }
}
impl DomainEncode for SavedFile {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("path", &self.path)
            .field("bytes", &self.bytes)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct WebMcpTool {
    pub name: LosslessString,
    pub description: Option<LosslessString>,
}
impl DomainDecode for WebMcpTool {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let description = object.optional::<LosslessString>("description")?;
        if description
            .as_ref()
            .is_some_and(|value| value.len() > MAX_NAME_LENGTH)
        {
            return Err(path.key("description").error(DecodeErrorKind::Length {
                minimum: 0,
                maximum: MAX_NAME_LENGTH,
            }));
        }
        Ok(Self {
            name: crate::domain::bounded_string(
                &object.field::<JsonValue>("name")?,
                0,
                128,
                &path.key("name"),
            )?,
            description,
        })
    }
}
impl DomainEncode for WebMcpTool {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("name", &self.name)
            .optional("description", &self.description)
            .finish()
    }
}
crate::schema::literal_enum_type!(DialogKind,{Alert=>"alert",Confirm=>"confirm",Prompt=>"prompt",BeforeUnload=>"beforeunload"});
#[derive(Clone, Debug, PartialEq)]
pub struct DialogInfo {
    pub kind: DialogKind,
    pub message: LosslessString,
    pub default_prompt: Option<LosslessString>,
}
impl DomainDecode for DialogInfo {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            kind: object.field("kind")?,
            message: crate::domain::bounded_string(
                &object.field::<JsonValue>("message")?,
                0,
                MAX_NAME_LENGTH,
                &path.key("message"),
            )?,
            default_prompt: bounded_optional(&object, path, "defaultPrompt", MAX_NAME_LENGTH)?,
        })
    }
}
impl DomainEncode for DialogInfo {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("kind", &self.kind)
            .field("message", &self.message)
            .optional("defaultPrompt", &self.default_prompt)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct SelectedOption {
    pub value: Option<LosslessString>,
    pub label: LosslessString,
    pub index: crate::schema::NonNegativeInt,
}
impl DomainDecode for SelectedOption {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            value: bounded_optional(&object, path, "value", MAX_NAME_LENGTH)?,
            label: crate::domain::bounded_string(
                &object.field::<JsonValue>("label")?,
                0,
                MAX_NAME_LENGTH,
                &path.key("label"),
            )?,
            index: object.field("index")?,
        })
    }
}
impl DomainEncode for SelectedOption {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("value", &self.value)
            .field("label", &self.label)
            .field("index", &self.index)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ControlState {
    pub checked: Option<Tristate>,
    pub value: Option<LosslessString>,
    pub selected: Option<Vec<SelectedOption>>,
    pub sensitive: Option<bool>,
}
impl DomainDecode for ControlState {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let selected: Option<Vec<SelectedOption>> = object.optional("selected")?;
        if selected
            .as_ref()
            .is_some_and(|items| items.len() > MAX_SELECT_OPTIONS)
        {
            return Err(path.key("selected").error(DecodeErrorKind::Length {
                minimum: 0,
                maximum: MAX_SELECT_OPTIONS,
            }));
        }
        Ok(Self {
            checked: object.optional("checked")?,
            value: bounded_optional(&object, path, "value", MAX_NAME_LENGTH)?,
            selected,
            sensitive: sensitive_field(&object, path)?,
        })
    }
}
impl DomainEncode for ControlState {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("checked", &self.checked)
            .optional("value", &self.value)
            .optional("selected", &self.selected)
            .optional("sensitive", &self.sensitive)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ActionResult {
    pub call_id: CallId,
    pub tab: Tab,
    pub status: ResultStatus,
    pub message: Option<LosslessString>,
    pub capture: Option<CaptureOutput>,
    pub group_id: Option<crate::schema::NonNegativeInt>,
    pub text: Option<LosslessString>,
    pub download: Option<DownloadInfo>,
    pub logs: Option<Vec<LogEntry>>,
    pub saved_file: Option<SavedFile>,
    pub webmcp_tools: Option<Vec<WebMcpTool>>,
    pub dialog: Option<DialogInfo>,
    pub control: Option<ControlState>,
    pub frame: Option<Page>,
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
        let text = o
            .optional::<LosslessString>("text")?
            .map(|value| bounded_utf8(value.encode(), &p.key("text"), MAX_CLIPBOARD_BYTES))
            .transpose()?;
        let logs = o.optional::<Vec<LogEntry>>("logs")?;
        let webmcp_tools = o.optional::<Vec<WebMcpTool>>("webmcpTools")?;
        for (name, count) in [
            ("logs", logs.as_ref().map(Vec::len)),
            ("webmcpTools", webmcp_tools.as_ref().map(Vec::len)),
        ] {
            if count.is_some_and(|count| count > MAX_LOG_ENTRIES) {
                return Err(p.key(name).error(DecodeErrorKind::Length {
                    minimum: 0,
                    maximum: MAX_LOG_ENTRIES,
                }));
            }
        }
        Ok(Self {
            call_id: o.field("callID")?,
            tab: o.field("tab")?,
            status: o.field("status")?,
            message,
            capture: o.optional("capture")?,
            group_id: o.optional("groupID")?,
            text,
            download: o.optional("download")?,
            logs,
            saved_file: o.optional("savedFile")?,
            webmcp_tools,
            dialog: o.optional("dialog")?,
            control: o.optional("control")?,
            frame: o.optional("frame")?,
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
            .optional("text", &self.text)
            .optional("download", &self.download)
            .optional("logs", &self.logs)
            .optional("savedFile", &self.saved_file)
            .optional("webmcpTools", &self.webmcp_tools)
            .optional("dialog", &self.dialog)
            .optional("control", &self.control)
            .optional("frame", &self.frame)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct HistoryInput {
    pub session_id: crate::session_id::SessionId,
    pub generation: Generation,
    pub call_id: CallId,
    pub query: Option<LosslessString>,
    pub limit: Option<crate::schema::PositiveInt>,
    pub start_time: Option<crate::schema::NonNegativeInt>,
    pub end_time: Option<crate::schema::NonNegativeInt>,
}
impl DomainDecode for HistoryInput {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let limit = object.optional::<crate::schema::PositiveInt>("limit")?;
        if limit.is_some_and(|value| value.get() > MAX_HISTORY_RESULTS as i64) {
            return Err(path
                .key("limit")
                .error(DecodeErrorKind::Expected("browser history limit")));
        }
        Ok(Self {
            session_id: object.field("sessionID")?,
            generation: object.field("generation")?,
            call_id: object.field("callID")?,
            query: object
                .optional::<JsonValue>("query")?
                .map(|value| crate::domain::bounded_string(&value, 0, 256, &path.key("query")))
                .transpose()?,
            limit,
            start_time: object.optional("startTime")?,
            end_time: object.optional("endTime")?,
        })
    }
}
impl DomainEncode for HistoryInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("generation", &self.generation)
            .field("callID", &self.call_id)
            .optional("query", &self.query)
            .optional("limit", &self.limit)
            .optional("startTime", &self.start_time)
            .optional("endTime", &self.end_time)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct HistoryEntry {
    pub url: LosslessString,
    pub title: LosslessString,
    pub last_visit_time: crate::schema::NonNegativeInt,
    pub visit_count: Option<crate::schema::NonNegativeInt>,
}
impl DomainDecode for HistoryEntry {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            url: bounded_utf8(object.field("url")?, &path.key("url"), 2048)?,
            title: crate::domain::bounded_string(
                &object.field::<JsonValue>("title")?,
                0,
                MAX_TITLE_LENGTH,
                &path.key("title"),
            )?,
            last_visit_time: object.field("lastVisitTime")?,
            visit_count: object.optional("visitCount")?,
        })
    }
}
impl DomainEncode for HistoryEntry {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("url", &self.url)
            .field("title", &self.title)
            .field("lastVisitTime", &self.last_visit_time)
            .optional("visitCount", &self.visit_count)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct HistoryResult {
    pub entries: Vec<HistoryEntry>,
}
impl DomainDecode for HistoryResult {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let entries = ObjectDecoder::new(value, path)?.field::<Vec<HistoryEntry>>("entries")?;
        if entries.len() > MAX_HISTORY_RESULTS {
            return Err(path.key("entries").error(DecodeErrorKind::Length {
                minimum: 0,
                maximum: MAX_HISTORY_RESULTS,
            }));
        }
        Ok(Self { entries })
    }
}
impl DomainEncode for HistoryResult {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("entries", &self.entries)
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
