use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder,
};
pub const MAX_COLS: i64 = 500;
pub const MAX_ROWS: i64 = 200;
pub const MAX_RUNTIME_SECONDS: i64 = 7200;
pub const DEFAULT_RUNTIME_SECONDS: i64 = 1800;
pub const MAX_RETAINED_BYTES: i64 = 2 * 1024 * 1024;
pub const MAX_INPUT_BYTES: i64 = 64 * 1024;
pub const MAX_ACTIVE: usize = 8;
pub const MAX_ATTACHMENTS: usize = 8;
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct Id(LosslessString);
impl DomainDecode for Id {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        crate::domain::branded_string(v, "pty", p).map(Self)
    }
}
impl DomainEncode for Id {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
pub type Generation = crate::schema::PositiveInt;
pub type Offset = crate::schema::NonNegativeInt;
crate::schema::literal_enum_type!(Actor,{Agent=>"agent",User=>"user"});
crate::schema::literal_enum_type!(ControlOwner,{Agent=>"agent",User=>"user",Paused=>"paused"});
crate::schema::literal_enum_type!(Access,{Inspect=>"inspect",Control=>"control"});
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Size {
    pub rows: crate::schema::PositiveInt,
    pub cols: crate::schema::PositiveInt,
}
impl DomainDecode for Size {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let rows: crate::schema::PositiveInt = o.field("rows")?;
        let cols: crate::schema::PositiveInt = o.field("cols")?;
        if rows.get() > MAX_ROWS {
            return Err(p.key("rows").error(DecodeErrorKind::NumberRange {
                minimum: 1.0,
                maximum: MAX_ROWS as f64,
                integer: true,
            }));
        }
        if cols.get() > MAX_COLS {
            return Err(p.key("cols").error(DecodeErrorKind::NumberRange {
                minimum: 1.0,
                maximum: MAX_COLS as f64,
                integer: true,
            }));
        }
        Ok(Self { rows, cols })
    }
}
impl DomainEncode for Size {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("rows", &self.rows)
            .field("cols", &self.cols)
            .finish()
    }
}
crate::schema::literal_enum_type!(Status,{Running=>"running",Exited=>"exited"});
crate::schema::literal_enum_type!(ExitReason,{Exit=>"exit",Timeout=>"timeout",Terminated=>"terminated"});
#[derive(Clone, Debug, PartialEq)]
pub struct Control {
    pub owner: ControlOwner,
    pub fence: crate::schema::PositiveInt,
}
impl DomainDecode for Control {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            owner: o.field("owner")?,
            fence: o.field("fence")?,
        })
    }
}
impl DomainEncode for Control {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("owner", &self.owner)
            .field("fence", &self.fence)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Output {
    pub start_offset: Offset,
    pub end_offset: Offset,
    pub truncated: bool,
}
impl DomainDecode for Output {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            start_offset: o.field("startOffset")?,
            end_offset: o.field("endOffset")?,
            truncated: o.field("truncated")?,
        })
    }
}
impl DomainEncode for Output {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("startOffset", &self.start_offset)
            .field("endOffset", &self.end_offset)
            .field("truncated", &self.truncated)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Limits {
    pub max_runtime_seconds: crate::schema::PositiveInt,
    pub max_retained_bytes: crate::schema::PositiveInt,
    pub max_input_bytes: crate::schema::PositiveInt,
}
impl DomainDecode for Limits {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let max_runtime_seconds: crate::schema::PositiveInt = o.field("maxRuntimeSeconds")?;
        let max_retained_bytes: crate::schema::PositiveInt = o.field("maxRetainedBytes")?;
        let max_input_bytes: crate::schema::PositiveInt = o.field("maxInputBytes")?;
        if max_runtime_seconds.get() > MAX_RUNTIME_SECONDS {
            return Err(p
                .key("maxRuntimeSeconds")
                .error(DecodeErrorKind::NumberRange {
                    minimum: 1.0,
                    maximum: MAX_RUNTIME_SECONDS as f64,
                    integer: true,
                }));
        }
        if max_retained_bytes.get() > MAX_RETAINED_BYTES {
            return Err(p
                .key("maxRetainedBytes")
                .error(DecodeErrorKind::NumberRange {
                    minimum: 1.0,
                    maximum: MAX_RETAINED_BYTES as f64,
                    integer: true,
                }));
        }
        if max_input_bytes.get() > MAX_INPUT_BYTES {
            return Err(p.key("maxInputBytes").error(DecodeErrorKind::NumberRange {
                minimum: 1.0,
                maximum: MAX_INPUT_BYTES as f64,
                integer: true,
            }));
        }
        Ok(Self {
            max_runtime_seconds,
            max_retained_bytes,
            max_input_bytes,
        })
    }
}
impl DomainEncode for Limits {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("maxRuntimeSeconds", &self.max_runtime_seconds)
            .field("maxRetainedBytes", &self.max_retained_bytes)
            .field("maxInputBytes", &self.max_input_bytes)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub id: Id,
    pub title: LosslessString,
    pub command: LosslessString,
    pub args: Vec<LosslessString>,
    pub cwd: LosslessString,
    pub session_id: crate::session_id::SessionId,
    pub status: Status,
    pub pid: crate::schema::NonNegativeInt,
    pub exit_code: Option<crate::schema::NonNegativeInt>,
    pub exit_reason: Option<ExitReason>,
    pub generation: Generation,
    pub size: Size,
    pub control: Control,
    pub output: Output,
    pub limits: Limits,
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            title: o.field("title")?,
            command: o.field("command")?,
            args: o.field("args")?,
            cwd: o.field("cwd")?,
            session_id: o.field("sessionID")?,
            status: o.field("status")?,
            pid: o.field("pid")?,
            exit_code: o.optional("exitCode")?,
            exit_reason: o.optional("exitReason")?,
            generation: o.field("generation")?,
            size: o.field("size")?,
            control: o.field("control")?,
            output: o.field("output")?,
            limits: o.field("limits")?,
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("title", &self.title)
            .field("command", &self.command)
            .field("args", &self.args)
            .field("cwd", &self.cwd)
            .field("sessionID", &self.session_id)
            .field("status", &self.status)
            .field("pid", &self.pid)
            .optional("exitCode", &self.exit_code)
            .optional("exitReason", &self.exit_reason)
            .field("generation", &self.generation)
            .field("size", &self.size)
            .field("control", &self.control)
            .field("output", &self.output)
            .field("limits", &self.limits)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct InfoData {
    pub info: Info,
}
impl DomainDecode for InfoData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            info: ObjectDecoder::new(v, p)?.field("info")?,
        })
    }
}
impl DomainEncode for InfoData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().field("info", &self.info).finish()
    }
}
pub struct Created;
impl crate::event::EventType for Created {
    const TYPE: &'static str = "pty.created";
    type Data = InfoData;
}
pub struct Updated;
impl crate::event::EventType for Updated {
    const TYPE: &'static str = "pty.updated";
    type Data = InfoData;
}
crate::schema::literal_enum_type!(ExitEventReason,{Exit=>"exit",Timeout=>"timeout"});
#[derive(Clone, Debug, PartialEq)]
pub struct ExitedData {
    pub id: Id,
    pub exit_code: crate::schema::NonNegativeInt,
    pub reason: ExitEventReason,
}
impl DomainDecode for ExitedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            exit_code: o.field("exitCode")?,
            reason: o.field("reason")?,
        })
    }
}
impl DomainEncode for ExitedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("exitCode", &self.exit_code)
            .field("reason", &self.reason)
            .finish()
    }
}
pub struct Exited;
impl crate::event::EventType for Exited {
    const TYPE: &'static str = "pty.exited";
    type Data = ExitedData;
}
#[derive(Clone, Debug, PartialEq)]
pub struct DeletedData {
    pub id: Id,
}
impl DomainDecode for DeletedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            id: ObjectDecoder::new(v, p)?.field("id")?,
        })
    }
}
impl DomainEncode for DeletedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().field("id", &self.id).finish()
    }
}
pub struct Deleted;
impl crate::event::EventType for Deleted {
    const TYPE: &'static str = "pty.deleted";
    type Data = DeletedData;
}
#[derive(Clone, Debug, PartialEq)]
pub struct CreateInput {
    pub session_id: crate::session_id::SessionId,
    pub command: Option<LosslessString>,
    pub args: Option<Vec<LosslessString>>,
    pub cwd: Option<LosslessString>,
    pub title: Option<LosslessString>,
    pub env: Option<crate::JsonObject>,
    pub size: Option<Size>,
    pub max_runtime_seconds: Option<crate::schema::PositiveInt>,
    pub max_retained_bytes: Option<crate::schema::PositiveInt>,
}
impl DomainDecode for CreateInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let max_runtime_seconds: Option<crate::schema::PositiveInt> =
            o.optional("maxRuntimeSeconds")?;
        let max_retained_bytes: Option<crate::schema::PositiveInt> =
            o.optional("maxRetainedBytes")?;
        if max_runtime_seconds.is_some_and(|x| x.get() > MAX_RUNTIME_SECONDS) {
            return Err(p
                .key("maxRuntimeSeconds")
                .error(DecodeErrorKind::NumberRange {
                    minimum: 1.0,
                    maximum: MAX_RUNTIME_SECONDS as f64,
                    integer: true,
                }));
        }
        if max_retained_bytes.is_some_and(|x| x.get() > MAX_RETAINED_BYTES) {
            return Err(p
                .key("maxRetainedBytes")
                .error(DecodeErrorKind::NumberRange {
                    minimum: 1.0,
                    maximum: MAX_RETAINED_BYTES as f64,
                    integer: true,
                }));
        }
        Ok(Self {
            session_id: o.field("sessionID")?,
            command: o.optional("command")?,
            args: o.optional("args")?,
            cwd: o.optional("cwd")?,
            title: o.optional("title")?,
            env: o.optional("env")?,
            size: o.optional("size")?,
            max_runtime_seconds,
            max_retained_bytes,
        })
    }
}
impl DomainEncode for CreateInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .optional("command", &self.command)
            .optional("args", &self.args)
            .optional("cwd", &self.cwd)
            .optional("title", &self.title)
            .optional("env", &self.env)
            .optional("size", &self.size)
            .optional("maxRuntimeSeconds", &self.max_runtime_seconds)
            .optional("maxRetainedBytes", &self.max_retained_bytes)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct UpdateInput {
    pub session_id: crate::session_id::SessionId,
    pub generation: Generation,
    pub expected_fence: crate::schema::PositiveInt,
    pub actor: Actor,
    pub title: Option<LosslessString>,
    pub size: Option<Size>,
}
impl DomainDecode for UpdateInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            generation: o.field("generation")?,
            expected_fence: o.field("expectedFence")?,
            actor: o.field("actor")?,
            title: o.optional("title")?,
            size: o.optional("size")?,
        })
    }
}
impl DomainEncode for UpdateInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("generation", &self.generation)
            .field("expectedFence", &self.expected_fence)
            .field("actor", &self.actor)
            .optional("title", &self.title)
            .optional("size", &self.size)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct OwnerInput {
    pub session_id: crate::session_id::SessionId,
}
impl DomainDecode for OwnerInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            session_id: ObjectDecoder::new(v, p)?.field("sessionID")?,
        })
    }
}
impl DomainEncode for OwnerInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .finish()
    }
}
crate::schema::literal_enum_type!(ControlAction,{Take=>"take",Pause=>"pause",Agent=>"agent"});
#[derive(Clone, Debug, PartialEq)]
pub struct ControlInput {
    pub session_id: crate::session_id::SessionId,
    pub generation: Generation,
    pub expected_fence: crate::schema::PositiveInt,
    pub action: ControlAction,
}
impl DomainDecode for ControlInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            generation: o.field("generation")?,
            expected_fence: o.field("expectedFence")?,
            action: o.field("action")?,
        })
    }
}
impl DomainEncode for ControlInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("generation", &self.generation)
            .field("expectedFence", &self.expected_fence)
            .field("action", &self.action)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ConnectInput {
    pub session_id: crate::session_id::SessionId,
    pub access: Access,
    pub generation: Generation,
    pub expected_fence: Option<crate::schema::PositiveInt>,
}
impl DomainDecode for ConnectInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            access: o.field("access")?,
            generation: o.field("generation")?,
            expected_fence: o.optional("expectedFence")?,
        })
    }
}
impl DomainEncode for ConnectInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("access", &self.access)
            .field("generation", &self.generation)
            .optional("expectedFence", &self.expected_fence)
            .finish()
    }
}
