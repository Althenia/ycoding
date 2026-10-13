use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonObject, JsonPath, JsonValue,
    LosslessString, ObjectDecoder, ObjectEncoder, domain,
};
use crate::{
    agent, llm, model, money,
    schema::{DateTimeUtcFromMillis, NonNegativeInt, PositiveInt, RelativePath},
    session_cache_diagnostics, session_compaction, session_error, session_message_id, shell, skill,
    snapshot, token_usage,
};

pub type Id = session_message_id::Id;
pub type ProviderState = JsonObject;

#[derive(Clone, Debug, PartialEq)]
pub struct ArtifactProvenance {
    pub scope_id: LosslessString,
    pub version_id: LosslessString,
    pub kind: LosslessString,
    pub id: LosslessString,
    pub source_scope: LosslessString,
}
#[derive(Clone, Debug, PartialEq)]
pub struct BaseTime {
    pub created: DateTimeUtcFromMillis,
}
#[derive(Clone, Debug, PartialEq)]
pub struct UserTime {
    pub created: DateTimeUtcFromMillis,
    pub consumed: Option<DateTimeUtcFromMillis>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct CompletedTime {
    pub created: DateTimeUtcFromMillis,
    pub completed: Option<DateTimeUtcFromMillis>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ToolTime {
    pub created: DateTimeUtcFromMillis,
    pub ran: Option<DateTimeUtcFromMillis>,
    pub completed: Option<DateTimeUtcFromMillis>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct SkillDeactivation {
    pub skill: skill::Id,
    pub reason: LosslessString,
}
#[derive(Clone, Debug, PartialEq)]
pub struct AgentSelected {
    pub id: Id,
    pub metadata: Option<JsonObject>,
    pub time: BaseTime,
    pub agent: agent::Id,
    pub artifact: Option<ArtifactProvenance>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ModelSelected {
    pub id: Id,
    pub metadata: Option<JsonObject>,
    pub time: BaseTime,
    pub model: model::Ref,
    pub previous: Option<model::Ref>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct User {
    pub id: Id,
    pub metadata: Option<JsonObject>,
    pub time: UserTime,
    pub text: LosslessString,
    pub files: Option<Vec<crate::prompt::FileAttachment>>,
    pub agents: Option<Vec<crate::prompt::AgentAttachment>>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Synthetic {
    pub id: Id,
    pub metadata: Option<JsonObject>,
    pub time: BaseTime,
    pub text: LosslessString,
    pub description: Option<LosslessString>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct System {
    pub id: Id,
    pub metadata: Option<JsonObject>,
    pub time: BaseTime,
    pub text: LosslessString,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Skill {
    pub id: Id,
    pub metadata: Option<JsonObject>,
    pub time: BaseTime,
    pub skill: skill::Id,
    pub name: skill::Name,
    pub text: LosslessString,
    pub conflicts: Option<skill::Conflicts>,
    pub skill_deactivations: Option<Vec<SkillDeactivation>>,
    pub artifact: Option<ArtifactProvenance>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Shell {
    pub id: Id,
    pub metadata: Option<JsonObject>,
    pub time: CompletedTime,
    pub shell_id: shell::Id,
    pub command: LosslessString,
    pub status: shell::Status,
    pub exit: Option<f64>,
    pub output: Option<shell::Output>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ToolStateStreaming {
    pub input: LosslessString,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ToolStateRunning {
    pub input: JsonObject,
    pub structured: JsonObject,
    pub content: Vec<llm::ToolContent>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ToolStateCompleted {
    pub input: JsonObject,
    pub content: Vec<llm::ToolContent>,
    pub structured: JsonObject,
    pub result: Option<JsonValue>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ToolStateError {
    pub input: JsonObject,
    pub content: Vec<llm::ToolContent>,
    pub structured: JsonObject,
    pub error: session_error::Error,
    pub result: Option<JsonValue>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum ToolState {
    Streaming(ToolStateStreaming),
    Running(ToolStateRunning),
    Completed(ToolStateCompleted),
    Error(ToolStateError),
}
#[derive(Clone, Debug, PartialEq)]
pub struct AssistantTool {
    pub id: LosslessString,
    pub name: LosslessString,
    pub executed: Option<bool>,
    pub provider_state: Option<ProviderState>,
    pub provider_result_state: Option<ProviderState>,
    pub state: ToolState,
    pub time: ToolTime,
}
#[derive(Clone, Debug, PartialEq)]
pub struct AssistantText {
    pub text: LosslessString,
    pub phase: Option<LosslessString>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct AssistantReasoning {
    pub text: LosslessString,
    pub state: Option<ProviderState>,
    pub time: Option<CompletedTime>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum AssistantContent {
    Text(AssistantText),
    Reasoning(AssistantReasoning),
    Tool(Box<AssistantTool>),
}
#[derive(Clone, Debug, PartialEq)]
pub struct AssistantRetry {
    pub attempt: PositiveInt,
    pub at: DateTimeUtcFromMillis,
    pub error: session_error::Error,
}
#[derive(Clone, Debug, PartialEq)]
pub struct SnapshotRange {
    pub start: Option<snapshot::Id>,
    pub end: Option<snapshot::Id>,
    pub files: Option<Vec<RelativePath>>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Diagnostics {
    pub context_limit: Option<NonNegativeInt>,
    pub context_breakdown: Option<session_cache_diagnostics::ContextBreakdown>,
    pub provider_cache: Option<session_cache_diagnostics::ProviderCache>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Assistant {
    pub id: Id,
    pub metadata: Option<JsonObject>,
    pub time: CompletedTime,
    pub agent: agent::Id,
    pub model: model::Ref,
    pub content: Vec<AssistantContent>,
    pub skill_deactivations: Option<Vec<SkillDeactivation>>,
    pub snapshot: Option<SnapshotRange>,
    pub finish: Option<llm::FinishReason>,
    pub cost: Option<money::Usd>,
    pub tokens: Option<token_usage::Info>,
    pub diagnostics: Option<Diagnostics>,
    pub error: Option<session_error::Error>,
    pub retry: Option<AssistantRetry>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct CompactionBase {
    pub id: Id,
    pub metadata: Option<JsonObject>,
    pub time: BaseTime,
}
#[derive(Clone, Debug, PartialEq)]
pub struct CompactionRunningV1 {
    pub base: CompactionBase,
    pub reason: LosslessString,
    pub summary: LosslessString,
    pub recent: LosslessString,
}
#[derive(Clone, Debug, PartialEq)]
pub struct CompactionCompletedV1 {
    pub base: CompactionBase,
    pub reason: LosslessString,
    pub summary: LosslessString,
    pub recent: LosslessString,
    pub messages: Option<NonNegativeInt>,
    pub tokens: Option<token_usage::Info>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct CompactionFailedV1 {
    pub base: CompactionBase,
    pub reason: LosslessString,
    pub error: session_error::Error,
}
#[derive(Clone, Debug, PartialEq)]
pub struct CompactionPending {
    pub base: CompactionBase,
    pub job_id: session_compaction::Id,
    pub trigger: session_compaction::Trigger,
    pub pressure: Option<session_compaction::Pressure>,
    pub summary: Option<LosslessString>,
    pub recent: Option<LosslessString>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct CompactionRunning {
    pub base: CompactionBase,
    pub job_id: session_compaction::Id,
    pub trigger: session_compaction::Trigger,
    pub pressure: Option<session_compaction::Pressure>,
    pub summary: Option<LosslessString>,
    pub recent: Option<LosslessString>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct CompactionCompleted {
    pub base: CompactionBase,
    pub job_id: session_compaction::Id,
    pub trigger: session_compaction::Trigger,
    pub pressure: Option<session_compaction::Pressure>,
    pub revision: NonNegativeInt,
    pub boundary: session_compaction::Boundary,
    pub metrics: session_compaction::Metrics,
    pub summary: Option<LosslessString>,
    pub recent: Option<LosslessString>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct CompactionFailed {
    pub base: CompactionBase,
    pub job_id: session_compaction::Id,
    pub trigger: session_compaction::Trigger,
    pub pressure: Option<session_compaction::Pressure>,
    pub code: session_compaction::FailureCode,
    pub error: session_error::Error,
    pub summary: Option<LosslessString>,
    pub recent: Option<LosslessString>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Compaction {
    Pending(CompactionPending),
    RunningV1(CompactionRunningV1),
    Running(CompactionRunning),
    CompletedV1(CompactionCompletedV1),
    Completed(CompactionCompleted),
    FailedV1(CompactionFailedV1),
    Failed(CompactionFailed),
}
#[derive(Clone, Debug, PartialEq)]
pub enum Info {
    AgentSelected(AgentSelected),
    ModelSelected(ModelSelected),
    User(User),
    Synthetic(Synthetic),
    System(System),
    Skill(Skill),
    Shell(Shell),
    Assistant(Box<Assistant>),
    Compaction(Compaction),
}
pub type Type = LosslessString;

fn decode_metadata(
    object: &ObjectDecoder<'_>,
    name: &str,
) -> Result<Option<JsonObject>, DecodeError> {
    object.optional(name)
}
fn base_encode<T: DomainEncode>(
    id: &Id,
    metadata: &Option<JsonObject>,
    time: &T,
    tag: &str,
) -> ObjectEncoder {
    ObjectEncoder::new()
        .field("id", id)
        .optional("metadata", metadata)
        .field("time", time)
        .field("type", tag)
}
fn decode_tag<'a>(
    value: &'a JsonValue,
    path: &'a JsonPath,
    tag: &str,
) -> Result<ObjectDecoder<'a>, DecodeError> {
    let object = ObjectDecoder::new(value, path)?;
    object.literal("type", &JsonValue::String(tag.into()))?;
    Ok(object)
}
fn decode_status<'a>(
    value: &'a JsonValue,
    path: &'a JsonPath,
    tag: &str,
) -> Result<ObjectDecoder<'a>, DecodeError> {
    let object = ObjectDecoder::new(value, path)?;
    object.literal("status", &JsonValue::String(tag.into()))?;
    Ok(object)
}

impl DomainDecode for ArtifactProvenance {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let scope_id: LosslessString = o.field("scopeID")?;
        let version_id: LosslessString = o.field("versionID")?;
        let kind: LosslessString = o.field("kind")?;
        let id: LosslessString = o.field("id")?;
        let source_scope: LosslessString = o.field("sourceScope")?;
        if !matches!(
            kind.as_str(),
            Some("skill" | "command" | "agent" | "plugin")
        ) {
            return Err(p.key("kind").error(DecodeErrorKind::Literal(
                ["skill", "command", "agent", "plugin"]
                    .iter()
                    .map(|s| JsonValue::String((*s).into()))
                    .collect(),
            )));
        }
        if !matches!(source_scope.as_str(), Some("project" | "global")) {
            return Err(p.key("sourceScope").error(DecodeErrorKind::Literal(
                ["project", "global"]
                    .iter()
                    .map(|s| JsonValue::String((*s).into()))
                    .collect(),
            )));
        }
        if !valid_brand(scope_id.as_str(), "pas_")
            || !valid_brand(version_id.as_str(), "pav_")
            || !valid_artifact_id(id.as_str())
        {
            return Err(p.error(DecodeErrorKind::Expected("artifact provenance IDs")));
        }
        Ok(Self {
            scope_id,
            version_id,
            kind,
            id,
            source_scope,
        })
    }
}
impl DomainEncode for ArtifactProvenance {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("scopeID", &self.scope_id)
            .field("versionID", &self.version_id)
            .field("kind", &self.kind)
            .field("id", &self.id)
            .field("sourceScope", &self.source_scope)
            .finish()
    }
}
fn valid_brand(value: Option<&str>, prefix: &str) -> bool {
    value.is_some_and(|s| {
        let suffix = s.strip_prefix(prefix).unwrap_or("");
        !suffix.is_empty()
            && suffix.len() <= 60
            && suffix.is_ascii()
            && suffix
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && suffix.as_bytes()[0].is_ascii_alphanumeric()
            && suffix.as_bytes()[suffix.len() - 1].is_ascii_alphanumeric()
    })
}
fn valid_artifact_id(value: Option<&str>) -> bool {
    value.is_some_and(|s| {
        let valid = !s.is_empty()
            && s.len() <= 64
            && s.is_ascii()
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && s.as_bytes()[0].is_ascii_alphanumeric()
            && s.as_bytes()[s.len() - 1].is_ascii_alphanumeric();
        valid
            && !matches!(
                s,
                "aux"
                    | "con"
                    | "nul"
                    | "prn"
                    | "com1"
                    | "com2"
                    | "com3"
                    | "com4"
                    | "com5"
                    | "com6"
                    | "com7"
                    | "com8"
                    | "com9"
                    | "lpt1"
                    | "lpt2"
                    | "lpt3"
                    | "lpt4"
                    | "lpt5"
                    | "lpt6"
                    | "lpt7"
                    | "lpt8"
                    | "lpt9"
            )
    })
}

impl DomainDecode for BaseTime {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            created: ObjectDecoder::new(v, p)?.field("created")?,
        })
    }
}
impl DomainEncode for BaseTime {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("created", &self.created)
            .finish()
    }
}
impl DomainDecode for UserTime {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            created: o.field("created")?,
            consumed: o.optional("consumed")?,
        })
    }
}
impl DomainEncode for UserTime {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("created", &self.created)
            .optional("consumed", &self.consumed)
            .finish()
    }
}
impl DomainDecode for CompletedTime {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            created: o.field("created")?,
            completed: o.optional("completed")?,
        })
    }
}
impl DomainEncode for CompletedTime {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("created", &self.created)
            .optional("completed", &self.completed)
            .finish()
    }
}
impl DomainDecode for ToolTime {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            created: o.field("created")?,
            ran: o.optional("ran")?,
            completed: o.optional("completed")?,
        })
    }
}
impl DomainEncode for ToolTime {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("created", &self.created)
            .optional("ran", &self.ran)
            .optional("completed", &self.completed)
            .finish()
    }
}

impl DomainDecode for SkillDeactivation {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let reason = o.tag("reason", &["conflict_resolved"])?;
        Ok(Self {
            skill: o.field("skill")?,
            reason,
        })
    }
}
impl DomainEncode for SkillDeactivation {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("skill", &self.skill)
            .field("reason", &self.reason)
            .finish()
    }
}
macro_rules! base_message {
    ($name:ty,$tag:literal,$read:expr,$write:expr) => {
        impl DomainDecode for $name {
            fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
                let o = decode_tag(v, p, $tag)?;
                ($read)(o, v, p)
            }
        }
        impl DomainEncode for $name {
            fn encode(&self) -> JsonValue {
                ($write)(self)
            }
        }
    };
}
base_message!(
    AgentSelected,
    "agent-switched",
    |o: ObjectDecoder<'_>, _: &JsonValue, _: &JsonPath| Ok(AgentSelected {
        id: o.field("id")?,
        metadata: decode_metadata(&o, "metadata")?,
        time: o.field("time")?,
        agent: o.field("agent")?,
        artifact: o.optional("artifact")?
    }),
    |s: &AgentSelected| base_encode(&s.id, &s.metadata, &s.time, "agent-switched")
        .field("agent", &s.agent)
        .optional("artifact", &s.artifact)
        .finish()
);
base_message!(
    ModelSelected,
    "model-switched",
    |o: ObjectDecoder<'_>, _: &JsonValue, _: &JsonPath| Ok(ModelSelected {
        id: o.field("id")?,
        metadata: o.optional("metadata")?,
        time: o.field("time")?,
        model: o.field("model")?,
        previous: o.optional("previous")?
    }),
    |s: &ModelSelected| base_encode(&s.id, &s.metadata, &s.time, "model-switched")
        .field("model", &s.model)
        .optional("previous", &s.previous)
        .finish()
);
base_message!(
    User,
    "user",
    |o: ObjectDecoder<'_>, _: &JsonValue, _: &JsonPath| Ok(User {
        id: o.field("id")?,
        metadata: o.optional("metadata")?,
        time: o.field("time")?,
        text: o.field("text")?,
        files: o.optional("files")?,
        agents: o.optional("agents")?
    }),
    |s: &User| ObjectEncoder::new()
        .field("id", &s.id)
        .optional("metadata", &s.metadata)
        .field("time", &s.time)
        .field("text", &s.text)
        .optional("files", &s.files)
        .optional("agents", &s.agents)
        .field("type", "user")
        .finish()
);
base_message!(
    Synthetic,
    "synthetic",
    |o: ObjectDecoder<'_>, _: &JsonValue, _: &JsonPath| Ok(Synthetic {
        id: o.field("id")?,
        metadata: o.optional("metadata")?,
        time: o.field("time")?,
        text: o.field("text")?,
        description: o.optional("description")?
    }),
    |s: &Synthetic| ObjectEncoder::new()
        .field("id", &s.id)
        .optional("metadata", &s.metadata)
        .field("time", &s.time)
        .field("text", &s.text)
        .optional("description", &s.description)
        .field("type", "synthetic")
        .finish()
);
base_message!(
    System,
    "system",
    |o: ObjectDecoder<'_>, _: &JsonValue, _: &JsonPath| Ok(System {
        id: o.field("id")?,
        metadata: o.optional("metadata")?,
        time: o.field("time")?,
        text: o.field("text")?
    }),
    |s: &System| base_encode(&s.id, &s.metadata, &s.time, "system")
        .field("text", &s.text)
        .finish()
);
base_message!(
    Skill,
    "skill",
    |o: ObjectDecoder<'_>, _: &JsonValue, _: &JsonPath| Ok(Skill {
        id: o.field("id")?,
        metadata: o.optional("metadata")?,
        time: o.field("time")?,
        skill: o.field("skill")?,
        name: o.field("name")?,
        text: o.field("text")?,
        conflicts: o.optional("conflicts")?,
        skill_deactivations: o.optional("skillDeactivations")?,
        artifact: o.optional("artifact")?
    }),
    |s: &Skill| base_encode(&s.id, &s.metadata, &s.time, "skill")
        .field("skill", &s.skill)
        .field("name", &s.name)
        .field("text", &s.text)
        .optional("conflicts", &s.conflicts)
        .optional("skillDeactivations", &s.skill_deactivations)
        .optional("artifact", &s.artifact)
        .finish()
);
base_message!(
    Shell,
    "shell",
    |o: ObjectDecoder<'_>, _: &JsonValue, _: &JsonPath| Ok(Shell {
        id: o.field("id")?,
        metadata: o.optional("metadata")?,
        time: o.field("time")?,
        shell_id: o.field("shellID")?,
        command: o.field("command")?,
        status: o.field("status")?,
        exit: o.optional("exit")?,
        output: o.optional("output")?
    }),
    |s: &Shell| base_encode(&s.id, &s.metadata, &s.time, "shell")
        .field("shellID", &s.shell_id)
        .field("command", &s.command)
        .field("status", &s.status)
        .optional("exit", &s.exit)
        .optional("output", &s.output)
        .finish()
);

impl DomainDecode for ToolStateStreaming {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = decode_status(v, p, "streaming")?;
        Ok(Self {
            input: o.field("input")?,
        })
    }
}
impl DomainEncode for ToolStateStreaming {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("status", "streaming")
            .field("input", &self.input)
            .finish()
    }
}
impl DomainDecode for ToolStateRunning {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = decode_status(v, p, "running")?;
        Ok(Self {
            input: o.field("input")?,
            structured: o.field("structured")?,
            content: o.field("content")?,
        })
    }
}
impl DomainEncode for ToolStateRunning {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("status", "running")
            .field("input", &self.input)
            .field("structured", &self.structured)
            .field("content", &self.content)
            .finish()
    }
}
impl DomainDecode for ToolStateCompleted {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = decode_status(v, p, "completed")?;
        Ok(Self {
            input: o.field("input")?,
            content: o.field("content")?,
            structured: o.field("structured")?,
            result: o.optional("result")?,
        })
    }
}
impl DomainEncode for ToolStateCompleted {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("status", "completed")
            .field("input", &self.input)
            .field("content", &self.content)
            .field("structured", &self.structured)
            .optional("result", &self.result)
            .finish()
    }
}
impl DomainDecode for ToolStateError {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = decode_status(v, p, "error")?;
        Ok(Self {
            input: o.field("input")?,
            content: o.field("content")?,
            structured: o.field("structured")?,
            error: o.field("error")?,
            result: o.optional("result")?,
        })
    }
}
impl DomainEncode for ToolStateError {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("status", "error")
            .field("input", &self.input)
            .field("content", &self.content)
            .field("structured", &self.structured)
            .field("error", &self.error)
            .optional("result", &self.result)
            .finish()
    }
}
impl DomainDecode for ToolState {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        match ObjectDecoder::new(v, p)?
            .tag("status", &["streaming", "running", "completed", "error"])?
            .as_str()
        {
            Some("streaming") => ToolStateStreaming::decode_at(v, p).map(Self::Streaming),
            Some("running") => ToolStateRunning::decode_at(v, p).map(Self::Running),
            Some("completed") => ToolStateCompleted::decode_at(v, p).map(Self::Completed),
            Some("error") => ToolStateError::decode_at(v, p).map(Self::Error),
            _ => Err(p.error(DecodeErrorKind::Expected("tool state"))),
        }
    }
}
impl DomainEncode for ToolState {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Streaming(v) => v.encode(),
            Self::Running(v) => v.encode(),
            Self::Completed(v) => v.encode(),
            Self::Error(v) => v.encode(),
        }
    }
}
impl DomainDecode for AssistantTool {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = decode_tag(v, p, "tool")?;
        Ok(Self {
            id: o.field("id")?,
            name: o.field("name")?,
            executed: o.optional("executed")?,
            provider_state: o.optional("providerState")?,
            provider_result_state: o.optional("providerResultState")?,
            state: o.field("state")?,
            time: o.field("time")?,
        })
    }
}
impl DomainEncode for AssistantTool {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "tool")
            .field("id", &self.id)
            .field("name", &self.name)
            .optional("executed", &self.executed)
            .optional("providerState", &self.provider_state)
            .optional("providerResultState", &self.provider_result_state)
            .field("state", &self.state)
            .field("time", &self.time)
            .finish()
    }
}
impl DomainDecode for AssistantText {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = decode_tag(v, p, "text")?;
        let phase = o
            .optional::<LosslessString>("phase")?
            .map(|value| {
                domain::literal_enum(
                    &value.encode(),
                    &["commentary", "final_answer"],
                    &p.key("phase"),
                )
            })
            .transpose()?;
        Ok(Self {
            text: o.field("text")?,
            phase,
        })
    }
}
impl DomainEncode for AssistantText {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "text")
            .field("text", &self.text)
            .optional("phase", &self.phase)
            .finish()
    }
}
impl DomainDecode for AssistantReasoning {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = decode_tag(v, p, "reasoning")?;
        Ok(Self {
            text: o.field("text")?,
            state: o.optional("state")?,
            time: o.optional("time")?,
        })
    }
}
impl DomainEncode for AssistantReasoning {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "reasoning")
            .field("text", &self.text)
            .optional("state", &self.state)
            .optional("time", &self.time)
            .finish()
    }
}
impl DomainDecode for AssistantContent {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        match ObjectDecoder::new(v, p)?
            .tag("type", &["text", "reasoning", "tool"])?
            .as_str()
        {
            Some("text") => AssistantText::decode_at(v, p).map(Self::Text),
            Some("reasoning") => AssistantReasoning::decode_at(v, p).map(Self::Reasoning),
            Some("tool") => AssistantTool::decode_at(v, p).map(|value| Self::Tool(Box::new(value))),
            _ => Err(p.error(DecodeErrorKind::Expected("assistant content"))),
        }
    }
}
impl DomainEncode for AssistantContent {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Text(v) => v.encode(),
            Self::Reasoning(v) => v.encode(),
            Self::Tool(v) => v.encode(),
        }
    }
}
impl DomainDecode for AssistantRetry {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            attempt: o.field("attempt")?,
            at: o.field("at")?,
            error: o.field("error")?,
        })
    }
}
impl DomainEncode for AssistantRetry {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("attempt", &self.attempt)
            .field("at", &self.at)
            .field("error", &self.error)
            .finish()
    }
}
impl DomainDecode for SnapshotRange {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            start: o.optional("start")?,
            end: o.optional("end")?,
            files: o.optional("files")?,
        })
    }
}
impl DomainEncode for SnapshotRange {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("start", &self.start)
            .optional("end", &self.end)
            .optional("files", &self.files)
            .finish()
    }
}
impl DomainDecode for Diagnostics {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            context_limit: o.optional("contextLimit")?,
            context_breakdown: o.optional("contextBreakdown")?,
            provider_cache: o.optional("providerCache")?,
        })
    }
}
impl DomainEncode for Diagnostics {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("contextLimit", &self.context_limit)
            .optional("contextBreakdown", &self.context_breakdown)
            .optional("providerCache", &self.provider_cache)
            .finish()
    }
}
impl DomainDecode for Assistant {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = decode_tag(v, p, "assistant")?;
        Ok(Self {
            id: o.field("id")?,
            metadata: o.optional("metadata")?,
            time: o.field("time")?,
            agent: o.field("agent")?,
            model: o.field("model")?,
            content: o.field("content")?,
            skill_deactivations: o.optional("skillDeactivations")?,
            snapshot: o.optional("snapshot")?,
            finish: o.optional("finish")?,
            cost: o.optional("cost")?,
            tokens: o.optional("tokens")?,
            diagnostics: o.optional("diagnostics")?,
            error: o.optional("error")?,
            retry: o.optional("retry")?,
        })
    }
}
impl DomainEncode for Assistant {
    fn encode(&self) -> JsonValue {
        base_encode(&self.id, &self.metadata, &self.time, "assistant")
            .field("agent", &self.agent)
            .field("model", &self.model)
            .field("content", &self.content)
            .optional("skillDeactivations", &self.skill_deactivations)
            .optional("snapshot", &self.snapshot)
            .optional("finish", &self.finish)
            .optional("cost", &self.cost)
            .optional("tokens", &self.tokens)
            .optional("diagnostics", &self.diagnostics)
            .optional("error", &self.error)
            .optional("retry", &self.retry)
            .finish()
    }
}

fn compaction_base(v: &JsonValue, p: &JsonPath) -> Result<CompactionBase, DecodeError> {
    let o = ObjectDecoder::new(v, p)?;
    Ok(CompactionBase {
        id: o.field("id")?,
        metadata: o.optional("metadata")?,
        time: o.field("time")?,
    })
}
fn compaction_prefix(base: &CompactionBase) -> ObjectEncoder {
    ObjectEncoder::new()
        .field("type", "compaction")
        .field("id", &base.id)
        .optional("metadata", &base.metadata)
        .field("time", &base.time)
}
impl DomainDecode for CompactionPending {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = decode_tag(v, p, "compaction")?;
        o.literal("status", &JsonValue::String("pending".into()))?;
        Ok(Self {
            base: compaction_base(v, p)?,
            job_id: o.field("jobID")?,
            trigger: o.field("trigger")?,
            pressure: o.optional("pressure")?,
            summary: o.optional("summary")?,
            recent: o.optional("recent")?,
        })
    }
}
impl DomainEncode for CompactionPending {
    fn encode(&self) -> JsonValue {
        compaction_prefix(&self.base)
            .field("jobID", &self.job_id)
            .field("trigger", &self.trigger)
            .optional("pressure", &self.pressure)
            .field("status", "pending")
            .optional("summary", &self.summary)
            .optional("recent", &self.recent)
            .finish()
    }
}
impl DomainDecode for CompactionRunningV1 {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("compaction".into()))?;
        o.literal("status", &JsonValue::String("running".into()))?;
        Ok(Self {
            base: compaction_base(v, p)?,
            reason: o.tag("reason", &["auto", "manual"])?,
            summary: o.field("summary")?,
            recent: o.field("recent")?,
        })
    }
}
impl DomainEncode for CompactionRunningV1 {
    fn encode(&self) -> JsonValue {
        compaction_prefix(&self.base)
            .field("reason", &self.reason)
            .field("status", "running")
            .field("summary", &self.summary)
            .field("recent", &self.recent)
            .finish()
    }
}
impl DomainDecode for CompactionRunning {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("compaction".into()))?;
        o.literal("status", &JsonValue::String("running".into()))?;
        Ok(Self {
            base: compaction_base(v, p)?,
            job_id: o.field("jobID")?,
            trigger: o.field("trigger")?,
            pressure: o.optional("pressure")?,
            summary: o.optional("summary")?,
            recent: o.optional("recent")?,
        })
    }
}
impl DomainEncode for CompactionRunning {
    fn encode(&self) -> JsonValue {
        compaction_prefix(&self.base)
            .field("jobID", &self.job_id)
            .field("trigger", &self.trigger)
            .optional("pressure", &self.pressure)
            .field("status", "running")
            .optional("summary", &self.summary)
            .optional("recent", &self.recent)
            .finish()
    }
}
impl DomainDecode for CompactionCompletedV1 {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("compaction".into()))?;
        o.literal("status", &JsonValue::String("completed".into()))?;
        Ok(Self {
            base: compaction_base(v, p)?,
            reason: o.tag("reason", &["auto", "manual"])?,
            summary: o.field("summary")?,
            recent: o.field("recent")?,
            messages: o.optional("messages")?,
            tokens: o.optional("tokens")?,
        })
    }
}
impl DomainEncode for CompactionCompletedV1 {
    fn encode(&self) -> JsonValue {
        compaction_prefix(&self.base)
            .field("reason", &self.reason)
            .field("status", "completed")
            .field("summary", &self.summary)
            .field("recent", &self.recent)
            .optional("messages", &self.messages)
            .optional("tokens", &self.tokens)
            .finish()
    }
}
impl DomainDecode for CompactionCompleted {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("compaction".into()))?;
        o.literal("status", &JsonValue::String("completed".into()))?;
        Ok(Self {
            base: compaction_base(v, p)?,
            job_id: o.field("jobID")?,
            trigger: o.field("trigger")?,
            pressure: o.optional("pressure")?,
            revision: o.field("revision")?,
            boundary: o.field("boundary")?,
            metrics: o.field("metrics")?,
            summary: o.optional("summary")?,
            recent: o.optional("recent")?,
        })
    }
}
impl DomainEncode for CompactionCompleted {
    fn encode(&self) -> JsonValue {
        compaction_prefix(&self.base)
            .field("jobID", &self.job_id)
            .field("trigger", &self.trigger)
            .optional("pressure", &self.pressure)
            .field("status", "completed")
            .field("revision", &self.revision)
            .field("boundary", &self.boundary)
            .field("metrics", &self.metrics)
            .optional("summary", &self.summary)
            .optional("recent", &self.recent)
            .finish()
    }
}
impl DomainDecode for CompactionFailedV1 {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("compaction".into()))?;
        o.literal("status", &JsonValue::String("failed".into()))?;
        Ok(Self {
            base: compaction_base(v, p)?,
            reason: o.tag("reason", &["auto", "manual"])?,
            error: o.field("error")?,
        })
    }
}
impl DomainEncode for CompactionFailedV1 {
    fn encode(&self) -> JsonValue {
        compaction_prefix(&self.base)
            .field("reason", &self.reason)
            .field("status", "failed")
            .field("error", &self.error)
            .finish()
    }
}
impl DomainDecode for CompactionFailed {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("compaction".into()))?;
        o.literal("status", &JsonValue::String("failed".into()))?;
        Ok(Self {
            base: compaction_base(v, p)?,
            job_id: o.field("jobID")?,
            trigger: o.field("trigger")?,
            pressure: o.optional("pressure")?,
            code: o.field("code")?,
            error: o.field("error")?,
            summary: o.optional("summary")?,
            recent: o.optional("recent")?,
        })
    }
}
impl DomainEncode for CompactionFailed {
    fn encode(&self) -> JsonValue {
        compaction_prefix(&self.base)
            .field("jobID", &self.job_id)
            .field("trigger", &self.trigger)
            .optional("pressure", &self.pressure)
            .field("status", "failed")
            .field("code", &self.code)
            .field("error", &self.error)
            .optional("summary", &self.summary)
            .optional("recent", &self.recent)
            .finish()
    }
}
impl DomainDecode for Compaction {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = decode_tag(v, p, "compaction")?;
        match o
            .tag("status", &["pending", "running", "completed", "failed"])?
            .as_str()
        {
            Some("pending") => CompactionPending::decode_at(v, p).map(Self::Pending),
            Some("running") => match (
                CompactionRunningV1::decode_at(v, p),
                CompactionRunning::decode_at(v, p),
            ) {
                (Ok(a), Err(_)) => Ok(Self::RunningV1(a)),
                (Err(_), Ok(b)) => Ok(Self::Running(b)),
                _ => Err(p.error(DecodeErrorKind::Expected(
                    "exactly one running compaction schema",
                ))),
            },
            Some("completed") => match (
                CompactionCompletedV1::decode_at(v, p),
                CompactionCompleted::decode_at(v, p),
            ) {
                (Ok(a), Err(_)) => Ok(Self::CompletedV1(a)),
                (Err(_), Ok(b)) => Ok(Self::Completed(b)),
                _ => Err(p.error(DecodeErrorKind::Expected(
                    "exactly one completed compaction schema",
                ))),
            },
            Some("failed") => match (
                CompactionFailedV1::decode_at(v, p),
                CompactionFailed::decode_at(v, p),
            ) {
                (Ok(a), Err(_)) => Ok(Self::FailedV1(a)),
                (Err(_), Ok(b)) => Ok(Self::Failed(b)),
                _ => Err(p.error(DecodeErrorKind::Expected(
                    "exactly one failed compaction schema",
                ))),
            },
            _ => Err(p.error(DecodeErrorKind::Expected("compaction"))),
        }
    }
}
impl DomainEncode for Compaction {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Pending(v) => v.encode(),
            Self::RunningV1(v) => v.encode(),
            Self::Running(v) => v.encode(),
            Self::CompletedV1(v) => v.encode(),
            Self::Completed(v) => v.encode(),
            Self::FailedV1(v) => v.encode(),
            Self::Failed(v) => v.encode(),
        }
    }
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        match ObjectDecoder::new(v, p)?
            .tag(
                "type",
                &[
                    "agent-switched",
                    "model-switched",
                    "user",
                    "synthetic",
                    "system",
                    "skill",
                    "shell",
                    "assistant",
                    "compaction",
                ],
            )?
            .as_str()
        {
            Some("agent-switched") => AgentSelected::decode_at(v, p).map(Self::AgentSelected),
            Some("model-switched") => ModelSelected::decode_at(v, p).map(Self::ModelSelected),
            Some("user") => User::decode_at(v, p).map(Self::User),
            Some("synthetic") => Synthetic::decode_at(v, p).map(Self::Synthetic),
            Some("system") => System::decode_at(v, p).map(Self::System),
            Some("skill") => Skill::decode_at(v, p).map(Self::Skill),
            Some("shell") => Shell::decode_at(v, p).map(Self::Shell),
            Some("assistant") => {
                Assistant::decode_at(v, p).map(|value| Self::Assistant(Box::new(value)))
            }
            Some("compaction") => Compaction::decode_at(v, p).map(Self::Compaction),
            _ => Err(p.error(DecodeErrorKind::Expected("session message"))),
        }
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        match self {
            Self::AgentSelected(v) => v.encode(),
            Self::ModelSelected(v) => v.encode(),
            Self::User(v) => v.encode(),
            Self::Synthetic(v) => v.encode(),
            Self::System(v) => v.encode(),
            Self::Skill(v) => v.encode(),
            Self::Shell(v) => v.encode(),
            Self::Assistant(v) => v.encode(),
            Self::Compaction(v) => v.encode(),
        }
    }
}
