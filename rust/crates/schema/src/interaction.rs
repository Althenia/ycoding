use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder,
};

pub const DEFAULT_SCRIPT_TIMEOUT_MS: u64 = 10_000;
pub type Revision = crate::schema::PositiveInt;

fn invalid(path: &JsonPath, expected: &'static str) -> DecodeError {
    path.error(DecodeErrorKind::Expected(expected))
}
fn uuid(value: &JsonValue, path: &JsonPath) -> Result<LosslessString, DecodeError> {
    let value = LosslessString::decode_at(value, path)?;
    let valid = value.len() == 36
        && value
            .code_units()
            .enumerate()
            .all(|(index, unit)| match index {
                8 | 13 | 18 | 23 => unit == 45,
                14 => unit == 52,
                19 => matches!(unit, 56 | 57 | 97 | 98),
                _ => matches!(unit, 48..=57 | 97..=102),
            });
    if !valid {
        return Err(invalid(path, "lowercase UUID v4"));
    }
    Ok(value)
}
macro_rules! uuid_type {
    ($name:ident) => {
        #[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
        pub struct $name(pub LosslessString);
        impl DomainDecode for $name {
            fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
                uuid(value, path).map(Self)
            }
        }
        impl DomainEncode for $name {
            fn encode(&self) -> JsonValue {
                self.0.encode()
            }
        }
    };
}
uuid_type!(Id);
uuid_type!(Generation);
crate::schema::literal_enum_type!(Platform, { Chrome => "chrome", Macos => "macos" });
crate::schema::literal_enum_type!(Refusal, { Unsupported => "unsupported", Stale => "stale", Sensitive => "sensitive", Captcha => "captcha", Policy => "policy", Permission => "permission", TargetLost => "target_lost", ConfirmationRequired => "confirmation_required", Busy => "busy" });
crate::schema::literal_enum_type!(PauseReason, { ForegroundRequired => "foreground_required", FileChooser => "file_chooser", Dialog => "dialog", Captcha => "captcha", Sensitive => "sensitive", UserTakeover => "user_takeover" });
crate::schema::literal_enum_type!(StopReason, { Stopped => "stopped", Rejected => "rejected", Expired => "expired", Disconnected => "disconnected", TargetLost => "target_lost", Uncertain => "uncertain", Permission => "permission", Shutdown => "shutdown" });
crate::schema::literal_enum_type!(ScriptMode, { Script => "script", Code => "code" });
crate::schema::literal_enum_type!(Cleanup, { Pending => "pending", Complete => "complete", Failed => "failed" });
crate::schema::literal_enum_type!(ConsoleLevel, { Log => "log", Info => "info", Warn => "warn", Error => "error", Debug => "debug" });
crate::schema::literal_enum_type!(MimeType, { Png => "image/png", Jpeg => "image/jpeg" });
crate::schema::literal_enum_type!(OwnedMode, { Owned => "owned", Isolated => "isolated" });

fn text(value: &JsonValue, path: &JsonPath, max: usize) -> Result<LosslessString, DecodeError> {
    let value = crate::domain::bounded_string(value, 0, max, path)?;
    if value.code_units().any(|unit| unit < 32 || unit == 127) {
        return Err(invalid(path, "text without control characters"));
    }
    Ok(value)
}
fn whitespace(unit: u16) -> bool {
    matches!(unit, 9..=13 | 32 | 160 | 5760 | 8192..=8202 | 8232 | 8233 | 8239 | 8287 | 12288 | 65279)
}
fn url(value: &JsonValue, path: &JsonPath, origin: bool) -> Result<LosslessString, DecodeError> {
    let value = crate::domain::bounded_string(value, 0, 2048, path)?;
    let units: Vec<_> = value.code_units().collect();
    let rest = if units.starts_with(&[104, 116, 116, 112, 58, 47, 47]) {
        &units[7..]
    } else if units.starts_with(&[104, 116, 116, 112, 115, 58, 47, 47]) {
        &units[8..]
    } else {
        return Err(invalid(path, "HTTP URL"));
    };
    let authority_end = rest
        .iter()
        .position(|unit| matches!(unit, 47 | 63 | 35))
        .unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.is_empty()
        || rest.iter().any(|unit| whitespace(*unit) || *unit == 92)
        || authority.contains(&64)
    {
        return Err(invalid(path, "HTTP URL without credentials or whitespace"));
    }
    let port = if authority[0] == 91 {
        let end = authority
            .iter()
            .position(|unit| *unit == 93)
            .ok_or_else(|| invalid(path, "bracketed host"))?;
        if end <= 1
            || !authority[1..end]
                .iter()
                .all(|unit| matches!(unit,48..=57 | 65..=70 | 97..=102 | 58 | 46))
        {
            return Err(invalid(path, "bracketed host"));
        }
        &authority[end + 1..]
    } else {
        let end = authority
            .iter()
            .position(|unit| *unit == 58)
            .unwrap_or(authority.len());
        if end == 0 {
            return Err(invalid(path, "host"));
        }
        &authority[end..]
    };
    if !port.is_empty()
        && (port[0] != 58
            || !(2..=6).contains(&port.len())
            || !port[1..].iter().all(|unit| matches!(unit, 48..=57)))
    {
        return Err(invalid(path, "numeric port of one to five digits"));
    }
    if origin && authority_end != rest.len() {
        return Err(invalid(path, "HTTP origin"));
    }
    Ok(value)
}
#[derive(Clone, Debug, PartialEq)]
pub struct Pathname(pub LosslessString);
impl DomainDecode for Pathname {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let value = crate::domain::bounded_string(value, 0, 2048, path)?;
        if value.code_units().next() != Some(47)
            || value
                .code_units()
                .any(|unit| whitespace(unit) || matches!(unit, 0..=31 | 127 | 63 | 35 | 92))
        {
            return Err(invalid(path, "pathname without query or fragment"));
        }
        Ok(Self(value))
    }
}
impl DomainEncode for Pathname {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Unavailable,
    Pending {
        platform: Platform,
        generation: Generation,
    },
    Active {
        platform: Platform,
        generation: Generation,
        label: LosslessString,
    },
    Paused {
        platform: Platform,
        generation: Generation,
        label: LosslessString,
        reason: PauseReason,
    },
    Stopped {
        platform: Platform,
        generation: Generation,
        reason: StopReason,
        cleanup: Cleanup,
    },
}
impl DomainDecode for Status {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let state: LosslessString = object.field("state")?;
        if state.as_str() == Some("unavailable") {
            return Ok(Self::Unavailable);
        }
        let platform = object.field("platform")?;
        let generation = object.field("generation")?;
        match state.as_str() {
            Some("pending") => Ok(Self::Pending {
                platform,
                generation,
            }),
            Some("active") => Ok(Self::Active {
                platform,
                generation,
                label: text(&object.field("label")?, &path.key("label"), 256)?,
            }),
            Some("paused") => Ok(Self::Paused {
                platform,
                generation,
                label: text(&object.field("label")?, &path.key("label"), 256)?,
                reason: object.field("reason")?,
            }),
            Some("stopped") => Ok(Self::Stopped {
                platform,
                generation,
                reason: object.field("reason")?,
                cleanup: object.field("cleanup")?,
            }),
            _ => Err(invalid(&path.key("state"), "Interaction state")),
        }
    }
}
impl DomainEncode for Status {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Unavailable => ObjectEncoder::new().field("state", "unavailable").finish(),
            Self::Pending {
                platform,
                generation,
            } => ObjectEncoder::new()
                .field("state", "pending")
                .field("platform", platform)
                .field("generation", generation)
                .finish(),
            Self::Active {
                platform,
                generation,
                label,
            } => ObjectEncoder::new()
                .field("state", "active")
                .field("platform", platform)
                .field("generation", generation)
                .field("label", label)
                .finish(),
            Self::Paused {
                platform,
                generation,
                label,
                reason,
            } => ObjectEncoder::new()
                .field("state", "paused")
                .field("platform", platform)
                .field("generation", generation)
                .field("label", label)
                .field("reason", reason)
                .finish(),
            Self::Stopped {
                platform,
                generation,
                reason,
                cleanup,
            } => ObjectEncoder::new()
                .field("state", "stopped")
                .field("platform", platform)
                .field("generation", generation)
                .field("reason", reason)
                .field("cleanup", cleanup)
                .finish(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Request {
    Macos,
    ChromeTab {
        explicit_mode: bool,
    },
    ChromeOwned {
        mode: OwnedMode,
        url: LosslessString,
    },
}
impl DomainDecode for Request {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let platform: Platform = object.field("platform")?;
        let mode: Option<LosslessString> = object.optional("mode")?;
        let input_url: Option<JsonValue> = object.optional("url")?;
        match (platform, mode.as_ref().and_then(LosslessString::as_str)) {
            (Platform::Macos, None) if input_url.is_none() => Ok(Self::Macos),
            (Platform::Chrome, None | Some("tab")) if input_url.is_none() => Ok(Self::ChromeTab {
                explicit_mode: mode.is_some(),
            }),
            (Platform::Chrome, Some("owned" | "isolated")) => Ok(Self::ChromeOwned {
                mode: object.field("mode")?,
                url: url(&object.field("url")?, &path.key("url"), false)?,
            }),
            _ => Err(invalid(path, "Interaction selection")),
        }
    }
}
impl DomainEncode for Request {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Macos => ObjectEncoder::new().field("platform", "macos").finish(),
            Self::ChromeTab { explicit_mode } => ObjectEncoder::new()
                .field("platform", "chrome")
                .optional(
                    "mode",
                    &explicit_mode.then_some(LosslessString::from("tab")),
                )
                .finish(),
            Self::ChromeOwned { mode, url } => ObjectEncoder::new()
                .field("platform", "chrome")
                .field("mode", mode)
                .field("url", url)
                .finish(),
        }
    }
}
crate::schema::record_type!(Fence {generation: Generation => "generation"} {});
#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    pub mime_type: MimeType,
    pub base64: LosslessString,
    pub width: crate::schema::PositiveInt,
    pub height: crate::schema::PositiveInt,
}
impl DomainDecode for Frame {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let base64: LosslessString = object.field("base64")?;
        if !(8..=218456).contains(&base64.len())
            || !crate::prompt::valid_base64(&base64)
            || base64
                .code_units()
                .take(218455)
                .all(|unit| matches!(unit,65..=90 | 97..=122 | 48..=57 | 43 | 47))
                && base64.len() >= 218455
        {
            return Err(invalid(
                &path.key("base64"),
                "base64 image of at most 163840 bytes",
            ));
        }
        let width: crate::schema::PositiveInt = object.field("width")?;
        let height: crate::schema::PositiveInt = object.field("height")?;
        if width.get() > 960 || height.get() > 720 {
            return Err(invalid(path, "preview dimensions at most 960 by 720"));
        }
        Ok(Self {
            mime_type: object.field("mimeType")?,
            base64,
            width,
            height,
        })
    }
}
impl DomainEncode for Frame {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("mimeType", &self.mime_type)
            .field("base64", &self.base64)
            .field("width", &self.width)
            .field("height", &self.height)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Preview {
    Unavailable {
        generation: Generation,
    },
    Ready {
        generation: Generation,
        frame: Frame,
    },
}
impl DomainDecode for Preview {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let state: LosslessString = object.field("state")?;
        let generation = object.field("generation")?;
        match state.as_str() {
            Some("unavailable") => Ok(Self::Unavailable { generation }),
            Some("ready") => Ok(Self::Ready {
                generation,
                frame: object.field("frame")?,
            }),
            _ => Err(invalid(path, "preview state")),
        }
    }
}
impl DomainEncode for Preview {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Unavailable { generation } => ObjectEncoder::new()
                .field("state", "unavailable")
                .field("generation", generation)
                .finish(),
            Self::Ready { generation, frame } => ObjectEncoder::new()
                .field("state", "ready")
                .field("generation", generation)
                .field("frame", frame)
                .finish(),
        }
    }
}
crate::schema::record_type!(ChangedData {session_id:crate::session_id::SessionId=>"sessionID",generation:Generation=>"generation"} {});
pub struct Changed;
impl crate::event::EventType for Changed {
    const TYPE: &'static str = "session.interaction.changed";
    type Data = ChangedData;
}

#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    ChromeTab {
        id: Id,
        label: LosslessString,
        origin: LosslessString,
        pathname: Pathname,
    },
    ChromeOwned {
        kind: ChromeOwnedKind,
        id: Id,
        label: LosslessString,
        origin: LosslessString,
        pathname: Pathname,
        url: LosslessString,
    },
    MacosWindow {
        id: Id,
        label: LosslessString,
        bundle_id: LosslessString,
    },
}
crate::schema::literal_enum_type!(ChromeOwnedKind,{Owned=>"chrome-owned",Isolated=>"chrome-isolated"});
impl DomainDecode for Target {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let kind: LosslessString = object.field("kind")?;
        let id = object.field("id")?;
        let label = text(&object.field("label")?, &path.key("label"), 256)?;
        if kind.as_str() == Some("macos-window") {
            let bundle_id = crate::domain::bounded_string(
                &object.field("bundleID")?,
                0,
                256,
                &path.key("bundleID"),
            )?;
            let valid = bundle_id.as_str().is_some_and(|value| {
                value.split('.').count() > 1
                    && value.split('.').all(|part| {
                        !part.is_empty()
                            && part
                                .bytes()
                                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                    })
            });
            if !valid {
                return Err(invalid(&path.key("bundleID"), "bundle identifier"));
            }
            return Ok(Self::MacosWindow {
                id,
                label,
                bundle_id,
            });
        }
        let origin = url(&object.field("origin")?, &path.key("origin"), true)?;
        let pathname = object.field("pathname")?;
        match kind.as_str() {
            Some("chrome-tab") => Ok(Self::ChromeTab {
                id,
                label,
                origin,
                pathname,
            }),
            Some("chrome-owned" | "chrome-isolated") => Ok(Self::ChromeOwned {
                kind: object.field("kind")?,
                id,
                label,
                origin,
                pathname,
                url: url(&object.field("url")?, &path.key("url"), false)?,
            }),
            _ => Err(invalid(&path.key("kind"), "Interaction target kind")),
        }
    }
}
impl DomainEncode for Target {
    fn encode(&self) -> JsonValue {
        match self {
            Self::ChromeTab {
                id,
                label,
                origin,
                pathname,
            } => ObjectEncoder::new()
                .field("kind", "chrome-tab")
                .field("id", id)
                .field("label", label)
                .field("origin", origin)
                .field("pathname", pathname)
                .finish(),
            Self::ChromeOwned {
                kind,
                id,
                label,
                origin,
                pathname,
                url,
            } => ObjectEncoder::new()
                .field("kind", kind)
                .field("id", id)
                .field("label", label)
                .field("origin", origin)
                .field("pathname", pathname)
                .field("url", url)
                .finish(),
            Self::MacosWindow {
                id,
                label,
                bundle_id,
            } => ObjectEncoder::new()
                .field("kind", "macos-window")
                .field("id", id)
                .field("label", label)
                .field("bundleID", bundle_id)
                .finish(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum ChromeAction {
    Click {
        element_id: Id,
    },
    Fill {
        element_id: Id,
        text: LosslessString,
    },
    Scroll {
        delta_y: crate::schema::Int,
    },
    Navigate {
        url: LosslessString,
    },
}
#[derive(Clone, Debug, PartialEq)]
pub enum MacosAction {
    Press {
        element_id: Id,
    },
    SetValue {
        element_id: Id,
        text: LosslessString,
    },
    Scroll {
        delta_y: crate::schema::Int,
    },
}
#[derive(Clone, Debug, PartialEq)]
pub enum ActionKind {
    Chrome(ChromeAction),
    Macos(MacosAction),
}
#[derive(Clone, Debug, PartialEq)]
pub struct Action {
    pub kind: ActionKind,
    pub destructive: Option<True>,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct True;
impl DomainDecode for True {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        crate::domain::literal(value, &[JsonValue::Bool(true)], path).map(|_| Self)
    }
}
impl DomainEncode for True {
    fn encode(&self) -> JsonValue {
        JsonValue::Bool(true)
    }
}
fn delta(object: &ObjectDecoder<'_>, path: &JsonPath) -> Result<crate::schema::Int, DecodeError> {
    let value = object.field("deltaY")?;
    crate::domain::integer_range(&value, -10_000, 10_000, &path.key("deltaY"))?;
    crate::schema::Int::decode(&value)
}
impl DomainDecode for Action {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let platform: Platform = object.field("platform")?;
        let type_: LosslessString = object.field("type")?;
        let kind = match (platform, type_.as_str()) {
            (Platform::Chrome, Some("click")) => ActionKind::Chrome(ChromeAction::Click {
                element_id: object.field("elementID")?,
            }),
            (Platform::Chrome, Some("fill")) => ActionKind::Chrome(ChromeAction::Fill {
                element_id: object.field("elementID")?,
                text: text(&object.field("text")?, &path.key("text"), 4096)?,
            }),
            (Platform::Chrome, Some("scroll")) => ActionKind::Chrome(ChromeAction::Scroll {
                delta_y: delta(&object, path)?,
            }),
            (Platform::Chrome, Some("navigate")) => ActionKind::Chrome(ChromeAction::Navigate {
                url: url(&object.field("url")?, &path.key("url"), false)?,
            }),
            (Platform::Macos, Some("press")) => ActionKind::Macos(MacosAction::Press {
                element_id: object.field("elementID")?,
            }),
            (Platform::Macos, Some("setValue")) => ActionKind::Macos(MacosAction::SetValue {
                element_id: object.field("elementID")?,
                text: text(&object.field("text")?, &path.key("text"), 4096)?,
            }),
            (Platform::Macos, Some("scroll")) => ActionKind::Macos(MacosAction::Scroll {
                delta_y: delta(&object, path)?,
            }),
            _ => return Err(invalid(path, "Interaction action")),
        };
        Ok(Self {
            kind,
            destructive: object.optional("destructive")?,
        })
    }
}
impl DomainEncode for Action {
    fn encode(&self) -> JsonValue {
        let object = ObjectEncoder::new()
            .field(
                "platform",
                match &self.kind {
                    ActionKind::Chrome(_) => "chrome",
                    ActionKind::Macos(_) => "macos",
                },
            )
            .optional("destructive", &self.destructive);
        match &self.kind {
            ActionKind::Chrome(ChromeAction::Click { element_id }) => object
                .field("type", "click")
                .field("elementID", element_id)
                .finish(),
            ActionKind::Chrome(ChromeAction::Fill { element_id, text }) => object
                .field("type", "fill")
                .field("elementID", element_id)
                .field("text", text)
                .finish(),
            ActionKind::Chrome(ChromeAction::Scroll { delta_y })
            | ActionKind::Macos(MacosAction::Scroll { delta_y }) => object
                .field("type", "scroll")
                .field("deltaY", delta_y)
                .finish(),
            ActionKind::Chrome(ChromeAction::Navigate { url }) => {
                object.field("type", "navigate").field("url", url).finish()
            }
            ActionKind::Macos(MacosAction::Press { element_id }) => object
                .field("type", "press")
                .field("elementID", element_id)
                .finish(),
            ActionKind::Macos(MacosAction::SetValue { element_id, text }) => object
                .field("type", "setValue")
                .field("elementID", element_id)
                .field("text", text)
                .finish(),
        }
    }
}
crate::schema::record_type!(Element {id:Id=>"id",role:Label=>"role",label:Label=>"label",editable:bool=>"editable"} {});
#[derive(Clone, Debug, PartialEq)]
pub struct ChromeActionValue(pub Action);
impl DomainDecode for ChromeActionValue {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let action = Action::decode_at(value, path)?;
        if !matches!(action.kind, ActionKind::Chrome(_)) {
            return Err(invalid(path, "Chrome action"));
        }
        Ok(Self(action))
    }
}
impl DomainEncode for ChromeActionValue {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct MacosActionValue(pub Action);
impl DomainDecode for MacosActionValue {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let action = Action::decode_at(value, path)?;
        if !matches!(action.kind, ActionKind::Macos(_)) {
            return Err(invalid(path, "macOS action"));
        }
        Ok(Self(action))
    }
}
impl DomainEncode for MacosActionValue {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Label(pub LosslessString);
impl DomainDecode for Label {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        text(value, path, 256).map(Self)
    }
}
impl DomainEncode for Label {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Observation {
    pub revision: Revision,
    pub pathname: Option<Pathname>,
    pub elements: Vec<Element>,
}
impl DomainDecode for Observation {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let elements: Vec<Element> = object.field("elements")?;
        if elements.len() > 200 {
            return Err(invalid(&path.key("elements"), "at most 200 elements"));
        }
        Ok(Self {
            revision: object.field("revision")?,
            pathname: object.optional("pathname")?,
            elements,
        })
    }
}
impl DomainEncode for Observation {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("revision", &self.revision)
            .optional("pathname", &self.pathname)
            .field("elements", &self.elements)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum ActionResult {
    Applied,
    Refused { reason: Refusal },
    Uncertain,
    Paused { reason: PauseReason },
}
impl DomainDecode for ActionResult {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let outcome: LosslessString = object.field("outcome")?;
        match outcome.as_str() {
            Some("applied") => Ok(Self::Applied),
            Some("refused") => Ok(Self::Refused {
                reason: object.field("reason")?,
            }),
            Some("uncertain") => Ok(Self::Uncertain),
            Some("paused") => Ok(Self::Paused {
                reason: object.field("reason")?,
            }),
            _ => Err(invalid(path, "action outcome")),
        }
    }
}
impl DomainEncode for ActionResult {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Applied => ObjectEncoder::new().field("outcome", "applied").finish(),
            Self::Refused { reason } => ObjectEncoder::new()
                .field("outcome", "refused")
                .field("reason", reason)
                .finish(),
            Self::Uncertain => ObjectEncoder::new().field("outcome", "uncertain").finish(),
            Self::Paused { reason } => ObjectEncoder::new()
                .field("outcome", "paused")
                .field("reason", reason)
                .finish(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ScriptRequest {
    pub mode: ScriptMode,
    pub source: LosslessString,
    pub timeout_ms: Option<crate::schema::Int>,
}
impl DomainDecode for ScriptRequest {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let source =
            crate::domain::bounded_string(&object.field("source")?, 1, 65536, &path.key("source"))?;
        let timeout_ms: Option<crate::schema::Int> = object.optional("timeoutMs")?;
        if let Some(timeout) = timeout_ms {
            crate::domain::integer_range(&timeout.encode(), 100, 60_000, &path.key("timeoutMs"))?;
        }
        Ok(Self {
            mode: object.field("mode")?,
            source,
            timeout_ms,
        })
    }
}
impl DomainEncode for ScriptRequest {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("mode", &self.mode)
            .field("source", &self.source)
            .optional("timeoutMs", &self.timeout_ms)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ConsoleEntry {
    pub level: ConsoleLevel,
    pub text: LosslessString,
}
impl DomainDecode for ConsoleEntry {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            level: object.field("level")?,
            text: crate::domain::bounded_string(
                &object.field("text")?,
                0,
                2048,
                &path.key("text"),
            )?,
        })
    }
}
impl DomainEncode for ConsoleEntry {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("level", &self.level)
            .field("text", &self.text)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ScriptError {
    pub name: LosslessString,
    pub message: LosslessString,
    pub stack: Option<LosslessString>,
}
impl DomainDecode for ScriptError {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            name: crate::domain::bounded_string(&object.field("name")?, 0, 128, &path.key("name"))?,
            message: crate::domain::bounded_string(
                &object.field("message")?,
                0,
                2048,
                &path.key("message"),
            )?,
            stack: object
                .optional::<JsonValue>("stack")?
                .map(|value| crate::domain::bounded_string(&value, 0, 8192, &path.key("stack")))
                .transpose()?,
        })
    }
}
impl DomainEncode for ScriptError {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("name", &self.name)
            .field("message", &self.message)
            .optional("stack", &self.stack)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum ScriptOutcome {
    Completed {
        value: Option<crate::domain::Json>,
        value_truncated: Option<True>,
    },
    Error {
        error: ScriptError,
    },
    Timeout,
    Stopped,
}
#[derive(Clone, Debug, PartialEq)]
pub enum ScriptResult {
    Settled {
        outcome: ScriptOutcome,
        logs: Vec<ConsoleEntry>,
        logs_truncated: Option<True>,
    },
    Refused {
        reason: Refusal,
    },
    Paused {
        reason: PauseReason,
    },
}
impl DomainDecode for ScriptResult {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let outcome: LosslessString = object.field("outcome")?;
        match outcome.as_str() {
            Some("refused") => {
                return Ok(Self::Refused {
                    reason: object.field("reason")?,
                });
            }
            Some("paused") => {
                return Ok(Self::Paused {
                    reason: object.field("reason")?,
                });
            }
            _ => {}
        }
        let outcome = match outcome.as_str() {
            Some("completed") => {
                let value: Option<crate::domain::Json> = object.optional("value")?;
                if value
                    .as_ref()
                    .is_some_and(|value| crate::stringify_json(&value.encode()).len() > 65536)
                {
                    return Err(invalid(
                        &path.key("value"),
                        "JSON value of at most 65536 serialized bytes",
                    ));
                }
                ScriptOutcome::Completed {
                    value,
                    value_truncated: object.optional("valueTruncated")?,
                }
            }
            Some("error") => ScriptOutcome::Error {
                error: object.field("error")?,
            },
            Some("timeout") => ScriptOutcome::Timeout,
            Some("stopped") => ScriptOutcome::Stopped,
            _ => return Err(invalid(path, "script outcome")),
        };
        let logs: Vec<ConsoleEntry> = object.field("logs")?;
        if logs.len() > 200 {
            return Err(invalid(&path.key("logs"), "at most 200 console entries"));
        }
        Ok(Self::Settled {
            outcome,
            logs,
            logs_truncated: object.optional("logsTruncated")?,
        })
    }
}
impl DomainEncode for ScriptResult {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Refused { reason } => ObjectEncoder::new()
                .field("outcome", "refused")
                .field("reason", reason)
                .finish(),
            Self::Paused { reason } => ObjectEncoder::new()
                .field("outcome", "paused")
                .field("reason", reason)
                .finish(),
            Self::Settled {
                outcome,
                logs,
                logs_truncated,
            } => {
                let object = match outcome {
                    ScriptOutcome::Completed {
                        value,
                        value_truncated,
                    } => ObjectEncoder::new()
                        .field("outcome", "completed")
                        .optional("value", value)
                        .optional("valueTruncated", value_truncated),
                    ScriptOutcome::Error { error } => ObjectEncoder::new()
                        .field("outcome", "error")
                        .field("error", error),
                    ScriptOutcome::Timeout => ObjectEncoder::new().field("outcome", "timeout"),
                    ScriptOutcome::Stopped => ObjectEncoder::new().field("outcome", "stopped"),
                };
                object
                    .field("logs", logs)
                    .optional("logsTruncated", logs_truncated)
                    .finish()
            }
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Capture {
    pub generation: Generation,
    pub frame: Frame,
    pub title: Option<LosslessString>,
    pub url: Option<LosslessString>,
}
impl DomainDecode for Capture {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            generation: object.field("generation")?,
            frame: object.field("frame")?,
            title: object
                .optional::<JsonValue>("title")?
                .map(|value| text(&value, &path.key("title"), 256))
                .transpose()?,
            url: object
                .optional::<JsonValue>("url")?
                .map(|value| url(&value, &path.key("url"), false))
                .transpose()?,
        })
    }
}
impl DomainEncode for Capture {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("generation", &self.generation)
            .field("frame", &self.frame)
            .optional("title", &self.title)
            .optional("url", &self.url)
            .finish()
    }
}
