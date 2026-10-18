use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonObject, JsonPath, JsonValue,
    LosslessString, ObjectDecoder, ObjectEncoder,
};
pub const MAX_MEMORY_LIMIT_MB: i64 = 1_048_576;
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct Id(LosslessString);
impl DomainDecode for Id {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        crate::domain::branded_string(v, "sh_", p).map(Self)
    }
}
impl DomainEncode for Id {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
crate::schema::literal_enum_type!(Status,{Running=>"running",Exited=>"exited",Timeout=>"timeout",MemoryLimit=>"memory-limit",Killed=>"killed"});
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MemoryLimitMb(crate::schema::NonNegativeInt);
impl DomainDecode for MemoryLimitMb {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let n = crate::schema::NonNegativeInt::decode_at(v, p)?;
        if n.get() > MAX_MEMORY_LIMIT_MB {
            return Err(p.error(DecodeErrorKind::NumberRange {
                minimum: 0.0,
                maximum: MAX_MEMORY_LIMIT_MB as f64,
                integer: true,
            }));
        }
        Ok(Self(n))
    }
}
impl DomainEncode for MemoryLimitMb {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Time {
    pub started: crate::schema::Finite,
    pub completed: Option<crate::schema::Finite>,
}
impl DomainDecode for Time {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            started: o.field("started")?,
            completed: o.optional("completed")?,
        })
    }
}
impl DomainEncode for Time {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("started", &self.started)
            .optional("completed", &self.completed)
            .finish()
    }
}
pub type Metadata = JsonObject;
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub id: Id,
    pub status: Status,
    pub command: LosslessString,
    pub cwd: LosslessString,
    pub shell: LosslessString,
    pub file: LosslessString,
    pub pid: Option<crate::schema::NonNegativeInt>,
    pub exit: Option<crate::schema::Finite>,
    pub metadata: Metadata,
    pub tool_call_id: Option<LosslessString>,
    pub time: Time,
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let tool_call_id: Option<LosslessString> = o.optional("toolCallID")?;
        if tool_call_id.as_ref().is_some_and(LosslessString::is_empty) {
            return Err(p.key("toolCallID").error(DecodeErrorKind::Length {
                minimum: 1,
                maximum: usize::MAX,
            }));
        }
        Ok(Self {
            id: o.field("id")?,
            status: o.field("status")?,
            command: o.field("command")?,
            cwd: o.field("cwd")?,
            shell: o.field("shell")?,
            file: o.field("file")?,
            pid: o.optional("pid")?,
            exit: o.optional("exit")?,
            metadata: o.field("metadata")?,
            tool_call_id,
            time: o.field("time")?,
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("status", &self.status)
            .field("command", &self.command)
            .field("cwd", &self.cwd)
            .field("shell", &self.shell)
            .field("file", &self.file)
            .optional("pid", &self.pid)
            .optional("exit", &self.exit)
            .field("metadata", &self.metadata)
            .optional("toolCallID", &self.tool_call_id)
            .field("time", &self.time)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct CreatedData {
    pub info: Info,
}
impl DomainDecode for CreatedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            info: ObjectDecoder::new(v, p)?.field("info")?,
        })
    }
}
impl DomainEncode for CreatedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().field("info", &self.info).finish()
    }
}
pub struct Created;
impl crate::event::EventType for Created {
    const TYPE: &'static str = "shell.created";
    type Data = CreatedData;
}
#[derive(Clone, Debug, PartialEq)]
pub struct ExitedData {
    pub id: Id,
    pub exit: Option<crate::schema::Finite>,
    pub status: Status,
}
impl DomainDecode for ExitedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            exit: o.optional("exit")?,
            status: o.field("status")?,
        })
    }
}
impl DomainEncode for ExitedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .optional("exit", &self.exit)
            .field("status", &self.status)
            .finish()
    }
}
pub struct Exited;
impl crate::event::EventType for Exited {
    const TYPE: &'static str = "shell.exited";
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
    const TYPE: &'static str = "shell.deleted";
    type Data = DeletedData;
}
#[derive(Clone, Debug, PartialEq)]
pub struct CreateInput {
    pub command: LosslessString,
    pub cwd: Option<LosslessString>,
    pub timeout: crate::schema::NonNegativeInt,
    pub memory_limit_mb: Option<MemoryLimitMb>,
    pub metadata: Option<Metadata>,
}
impl DomainDecode for CreateInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            command: o.field("command")?,
            cwd: o.optional("cwd")?,
            timeout: o.field("timeout")?,
            memory_limit_mb: o.optional("memoryLimitMb")?,
            metadata: o.optional("metadata")?,
        })
    }
}
impl DomainEncode for CreateInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("command", &self.command)
            .optional("cwd", &self.cwd)
            .field("timeout", &self.timeout)
            .optional("memoryLimitMb", &self.memory_limit_mb)
            .optional("metadata", &self.metadata)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct OutputInput {
    pub cursor: Option<crate::schema::NonNegativeInt>,
    pub limit: Option<crate::schema::NonNegativeInt>,
}
impl DomainDecode for OutputInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            cursor: o.optional("cursor")?,
            limit: o.optional("limit")?,
        })
    }
}
impl DomainEncode for OutputInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("cursor", &self.cursor)
            .optional("limit", &self.limit)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Output {
    pub output: LosslessString,
    pub cursor: crate::schema::NonNegativeInt,
    pub size: crate::schema::NonNegativeInt,
    pub truncated: bool,
}
impl DomainDecode for Output {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            output: o.field("output")?,
            cursor: o.field("cursor")?,
            size: o.field("size")?,
            truncated: o.field("truncated")?,
        })
    }
}
impl DomainEncode for Output {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("output", &self.output)
            .field("cursor", &self.cursor)
            .field("size", &self.size)
            .field("truncated", &self.truncated)
            .finish()
    }
}
