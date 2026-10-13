use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
};
macro_rules! string_domain {
    ($name:ident, $check:expr) => {
        #[derive(Clone, Debug, PartialEq, Eq)]
        pub struct $name(LosslessString);
        impl DomainDecode for $name {
            fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
                let value = LosslessString::decode_at(v, p)?;
                if ($check)(&value) {
                    Ok(Self(value))
                } else {
                    Err(p.error(DecodeErrorKind::Expected(stringify!($name))))
                }
            }
        }
        impl DomainEncode for $name {
            fn encode(&self) -> JsonValue {
                self.0.encode()
            }
        }
        impl $name {
            pub fn as_lossless(&self) -> &LosslessString {
                &self.0
            }
        }
    };
}
fn safe_id(value: &LosslessString, prefix: Option<&str>) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    if let Some(prefix) = prefix {
        let Some(suffix) = value.strip_prefix(&format!("{prefix}_")) else {
            return false;
        };
        return !suffix.is_empty()
            && suffix.len() <= 60
            && suffix
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && suffix.as_bytes()[0] != b'-'
            && suffix.as_bytes()[suffix.len() - 1] != b'-';
    }
    value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        && !matches!(
            value,
            "aux"
                | "com1"
                | "com2"
                | "com3"
                | "com4"
                | "com5"
                | "com6"
                | "com7"
                | "com8"
                | "com9"
                | "con"
                | "lpt1"
                | "lpt2"
                | "lpt3"
                | "lpt4"
                | "lpt5"
                | "lpt6"
                | "lpt7"
                | "lpt8"
                | "lpt9"
                | "nul"
                | "prn"
        )
}
fn bounded_text(
    value: &LosslessString,
    max_scalars: usize,
    max_bytes: usize,
    nonempty: bool,
) -> bool {
    let units: Vec<u16> = value.code_units().collect();
    let mut scalars = 0;
    let mut bytes = 0;
    let mut i = 0;
    while i < units.len() {
        let unit = units[i];
        let width = if (0xd800..=0xdbff).contains(&unit)
            && units
                .get(i + 1)
                .is_some_and(|next| (0xdc00..=0xdfff).contains(next))
        {
            i += 2;
            4
        } else if unit <= 0x7f {
            i += 1;
            1
        } else if unit <= 0x7ff {
            i += 1;
            2
        } else {
            i += 1;
            3
        };
        scalars += 1;
        bytes += width;
    }
    (!nonempty || !units.is_empty()) && scalars <= max_scalars && bytes <= max_bytes
}
string_domain!(Id, |v: &LosslessString| safe_id(v, None));
string_domain!(ScopeId, |v: &LosslessString| safe_id(v, Some("pas")));
string_domain!(VersionId, |v: &LosslessString| safe_id(v, Some("pav")));
string_domain!(DeletionId, |v: &LosslessString| safe_id(v, Some("pad")));
string_domain!(ActivationId, |v: &LosslessString| safe_id(v, Some("paa")));
string_domain!(ObservationId, |v: &LosslessString| safe_id(v, Some("pao")));
pub type Revision = crate::schema::NonNegativeInt;
pub type TimestampMillis = crate::schema::NonNegativeInt;
string_domain!(Digest, |v: &LosslessString| v.as_str().is_some_and(|s| s
    .len()
    == 64
    && s.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))));
string_domain!(StorageId, |v: &LosslessString| v.as_str().is_some_and(
    |s| {
        let b = s.as_bytes();
        b.len() == 36
            && [8, 13, 18, 23].iter().all(|i| b[*i] == b'-')
            && b.iter().enumerate().all(|(i, c)| {
                [8, 13, 18, 23].contains(&i) || c.is_ascii_digit() || (b'a'..=b'f').contains(c)
            })
    }
));
string_domain!(DisplayName, |v: &LosslessString| bounded_text(
    v, 128, 512, false
));
string_domain!(Description, |v: &LosslessString| bounded_text(
    v, 512, 2048, false
));
string_domain!(SkillContent, |v: &LosslessString| bounded_text(
    v, 24576, 24576, false
));
string_domain!(CommandTemplate, |v: &LosslessString| bounded_text(
    v, 16384, 16384, false
));
string_domain!(AgentSystem, |v: &LosslessString| bounded_text(
    v, 16384, 16384, false
));
string_domain!(PluginDraft, |v: &LosslessString| bounded_text(
    v, 32768, 32768, false
));
string_domain!(ConfirmationToken, |v: &LosslessString| v
    .as_str()
    .is_some_and(|s| !s.is_empty()
        && s.len() <= 512
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')));
string_domain!(RenderedContent, |v: &LosslessString| bounded_text(
    v, 32768, 32768, true
));
string_domain!(ContentRelpath, |v: &LosslessString| v.as_str().is_some_and(
    |s| !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
        && !s.starts_with('/')
        && !s.starts_with('~')
        && !s.contains(':')
        && !s.split('/').any(|part| part == "..")
        && s.as_bytes()[0].is_ascii_alphanumeric()
));
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Kind(LosslessString);
impl DomainDecode for Kind {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let s = LosslessString::decode_at(v, p)?;
        if ["skill", "command", "agent", "plugin"].contains(&s.as_str().unwrap_or("")) {
            Ok(Self(s))
        } else {
            Err(p.error(DecodeErrorKind::Literal(
                ["skill", "command", "agent", "plugin"]
                    .into_iter()
                    .map(LosslessString::from)
                    .map(JsonValue::String)
                    .collect(),
            )))
        }
    }
}
impl DomainEncode for Kind {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stage(LosslessString);
impl DomainDecode for Stage {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let s = LosslessString::decode_at(v, p)?;
        if ["trial", "active", "degraded", "disabled", "quarantine"]
            .contains(&s.as_str().unwrap_or(""))
        {
            Ok(Self(s))
        } else {
            Err(p.error(DecodeErrorKind::Expected("ProjectArtifact.Stage")))
        }
    }
}
impl DomainEncode for Stage {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source(LosslessString);
impl DomainDecode for Source {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let s = LosslessString::decode_at(v, p)?;
        if ["agent", "user", "promotion", "fork", "restore"].contains(&s.as_str().unwrap_or("")) {
            Ok(Self(s))
        } else {
            Err(p.error(DecodeErrorKind::Expected("ProjectArtifact.Source")))
        }
    }
}
impl DomainEncode for Source {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
macro_rules! literal_type {
    ($name:ident, [$($value:literal),+ $(,)?]) => {
        #[derive(Clone, Debug, PartialEq, Eq)] pub struct $name(LosslessString);
        impl DomainDecode for $name {
            fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
                let value = LosslessString::decode_at(v, p)?;
                if [$($value),+].contains(&value.as_str().unwrap_or("")) { Ok(Self(value)) } else { Err(p.error(DecodeErrorKind::Literal([$($value),+].into_iter().map(LosslessString::from).map(JsonValue::String).collect()))) }
            }
        }
        impl DomainEncode for $name { fn encode(&self) -> JsonValue { self.0.encode() } }
    };
}
literal_type!(
    VersionState,
    [
        "trial",
        "active",
        "degraded",
        "disabled",
        "quarantine",
        "superseded"
    ]
);
literal_type!(
    ActivationSource,
    [
        "skill-tool",
        "session-skill",
        "command",
        "agent-selected",
        "subagent-launch",
        "manual"
    ]
);
literal_type!(TerminalOutcome, ["succeeded", "failed", "interrupted"]);
literal_type!(GoalStatus, ["none", "completed", "stopped", "exhausted"]);
literal_type!(
    FeedbackAction,
    [
        "disable", "delete", "revert", "restore", "enable", "promote"
    ]
);
literal_type!(FeedbackActor, ["user", "automatic-governor"]);
literal_type!(AutomaticWriteOperation, ["create", "update", "reconcile"]);
literal_type!(AutomaticWriteResult, ["created", "updated", "reconciled"]);
literal_type!(
    ErrorCode,
    [
        "ProjectIdentityUnavailable",
        "InvalidArtifact",
        "UnsafeContent",
        "UnsupportedKind",
        "InvalidScope",
        "ArtifactNotFound",
        "VersionNotFound",
        "DeletionNotFound",
        "ArtifactCollision",
        "ScopeCollision",
        "VersionConflict",
        "OwnershipMismatch",
        "DestinationExists",
        "ProjectAdoptionConflict",
        "ConfirmationExpired",
        "TrashExpired",
        "ContentTooLarge",
        "ScopeQuotaExceeded",
        "WriteRateExceeded",
        "ArtifactCooldown",
        "StorageUnavailable",
        "LockTimeout",
        "ReconciliationRequired"
    ]
);
#[derive(Clone, Debug, PartialEq)]
pub struct Confidence {
    pub sample_count: Revision,
    pub success_count: Revision,
    pub lower_bound: f64,
    pub upper_bound: f64,
    pub eligible: bool,
}
impl DomainDecode for Confidence {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = crate::ObjectDecoder::new(v, p)?;
        let sample_count: Revision = o.field("sampleCount")?;
        let success_count: Revision = o.field("successCount")?;
        let lower_bound: f64 = o.field("lowerBound")?;
        let upper_bound: f64 = o.field("upperBound")?;
        let eligible = o.field("eligible")?;
        if !lower_bound.is_finite()
            || !upper_bound.is_finite()
            || lower_bound < 0.0
            || lower_bound > 1.0
            || upper_bound < 0.0
            || upper_bound > 1.0
            || success_count.get() > sample_count.get()
            || lower_bound > upper_bound
        {
            return Err(p.error(DecodeErrorKind::Expected(
                "consistent confidence counts and bounds",
            )));
        }
        Ok(Self {
            sample_count,
            success_count,
            lower_bound,
            upper_bound,
            eligible,
        })
    }
}
impl DomainEncode for Confidence {
    fn encode(&self) -> JsonValue {
        crate::ObjectEncoder::new()
            .field("sampleCount", &self.sample_count)
            .field("successCount", &self.success_count)
            .field("lowerBound", &self.lower_bound)
            .field("upperBound", &self.upper_bound)
            .field("eligible", &self.eligible)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ProjectScope {
    pub id: ScopeId,
    pub project_id: crate::project::Id,
    pub storage_id: StorageId,
}
#[derive(Clone, Debug, PartialEq)]
pub struct GlobalScope {
    pub id: ScopeId,
    pub storage_id: StorageId,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Scope {
    Project(ProjectScope),
    Global(GlobalScope),
}
impl DomainDecode for Scope {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = crate::ObjectDecoder::new(v, p)?;
        match o.tag("type", &["project", "global"])?.as_str() {
            Some("project") => Ok(Self::Project(ProjectScope {
                id: o.field("id")?,
                project_id: o.field("projectID")?,
                storage_id: o.field("storageID")?,
            })),
            Some("global") => Ok(Self::Global(GlobalScope {
                id: o.field("id")?,
                storage_id: o.field("storageID")?,
            })),
            _ => unreachable!(),
        }
    }
}
impl DomainEncode for Scope {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Project(v) => crate::ObjectEncoder::new()
                .field("type", &LosslessString::from("project"))
                .field("id", &v.id)
                .field("projectID", &v.project_id)
                .field("storageID", &v.storage_id)
                .finish(),
            Self::Global(v) => crate::ObjectEncoder::new()
                .field("type", &LosslessString::from("global"))
                .field("id", &v.id)
                .field("storageID", &v.storage_id)
                .finish(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum ScopeSelector {
    Project,
    Global,
}
impl DomainDecode for ScopeSelector {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = crate::ObjectDecoder::new(v, p)?;
        match o.tag("type", &["project", "global"])?.as_str() {
            Some("project") => Ok(Self::Project),
            Some("global") => Ok(Self::Global),
            _ => unreachable!(),
        }
    }
}
impl DomainEncode for ScopeSelector {
    fn encode(&self) -> JsonValue {
        crate::ObjectEncoder::new()
            .field(
                "type",
                &LosslessString::from(match self {
                    Self::Project => "project",
                    Self::Global => "global",
                }),
            )
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct SkillDefinition {
    pub name: DisplayName,
    pub description: Description,
    pub content: SkillContent,
}
#[derive(Clone, Debug, PartialEq)]
pub struct CommandDefinition {
    pub name: DisplayName,
    pub description: Description,
    pub template: CommandTemplate,
}
#[derive(Clone, Debug, PartialEq)]
pub struct AgentDefinition {
    pub name: DisplayName,
    pub description: Description,
    pub system: AgentSystem,
    pub permissions: crate::permission::Ruleset,
}
#[derive(Clone, Debug, PartialEq)]
pub struct PluginDefinition {
    pub name: DisplayName,
    pub description: Description,
    pub draft: PluginDraft,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Definition {
    Skill(SkillDefinition),
    Command(CommandDefinition),
    Agent(AgentDefinition),
    Plugin(PluginDefinition),
}
impl DomainDecode for Definition {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = crate::ObjectDecoder::new(v, p)?;
        match o
            .tag("kind", &["skill", "command", "agent", "plugin"])?
            .as_str()
        {
            Some("skill") => Ok(Self::Skill(SkillDefinition {
                name: o.field("name")?,
                description: o.field("description")?,
                content: o.field("content")?,
            })),
            Some("command") => {
                o.literal("subtask", &JsonValue::Bool(false))?;
                Ok(Self::Command(CommandDefinition {
                    name: o.field("name")?,
                    description: o.field("description")?,
                    template: o.field("template")?,
                }))
            }
            Some("agent") => {
                o.literal("mode", &JsonValue::String("subagent".into()))?;
                Ok(Self::Agent(AgentDefinition {
                    name: o.field("name")?,
                    description: o.field("description")?,
                    system: o.field("system")?,
                    permissions: o.field("permissions")?,
                }))
            }
            Some("plugin") => Ok(Self::Plugin(PluginDefinition {
                name: o.field("name")?,
                description: o.field("description")?,
                draft: o.field("draft")?,
            })),
            _ => unreachable!(),
        }
    }
}
impl DomainEncode for Definition {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Skill(v) => crate::ObjectEncoder::new()
                .field("kind", &LosslessString::from("skill"))
                .field("name", &v.name)
                .field("description", &v.description)
                .field("content", &v.content)
                .finish(),
            Self::Command(v) => crate::ObjectEncoder::new()
                .field("kind", &LosslessString::from("command"))
                .field("name", &v.name)
                .field("description", &v.description)
                .field("template", &v.template)
                .field("subtask", &false)
                .finish(),
            Self::Agent(v) => crate::ObjectEncoder::new()
                .field("kind", &LosslessString::from("agent"))
                .field("name", &v.name)
                .field("description", &v.description)
                .field("system", &v.system)
                .field("mode", &LosslessString::from("subagent"))
                .field("permissions", &v.permissions)
                .finish(),
            Self::Plugin(v) => crate::ObjectEncoder::new()
                .field("kind", &LosslessString::from("plugin"))
                .field("name", &v.name)
                .field("description", &v.description)
                .field("draft", &v.draft)
                .finish(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ArtifactKey {
    pub scope: ScopeSelector,
    pub kind: Kind,
    pub id: Id,
}
impl DomainDecode for ArtifactKey {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = crate::ObjectDecoder::new(v, p)?;
        Ok(Self {
            scope: o.field("scope")?,
            kind: o.field("kind")?,
            id: o.field("id")?,
        })
    }
}
impl DomainEncode for ArtifactKey {
    fn encode(&self) -> JsonValue {
        crate::ObjectEncoder::new()
            .field("scope", &self.scope)
            .field("kind", &self.kind)
            .field("id", &self.id)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ArtifactIdentity {
    pub scope_id: ScopeId,
    pub kind: Kind,
    pub id: Id,
}
impl DomainDecode for ArtifactIdentity {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = crate::ObjectDecoder::new(v, p)?;
        Ok(Self {
            scope_id: o.field("scopeID")?,
            kind: o.field("kind")?,
            id: o.field("id")?,
        })
    }
}
impl DomainEncode for ArtifactIdentity {
    fn encode(&self) -> JsonValue {
        crate::ObjectEncoder::new()
            .field("scopeID", &self.scope_id)
            .field("kind", &self.kind)
            .field("id", &self.id)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ArtifactVersionIdentity {
    pub identity: ArtifactIdentity,
    pub version_id: VersionId,
}
impl DomainDecode for ArtifactVersionIdentity {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let identity = ArtifactIdentity::decode_at(v, p)?;
        let version_id = crate::ObjectDecoder::new(v, p)?.field("versionID")?;
        Ok(Self {
            identity,
            version_id,
        })
    }
}
impl DomainEncode for ArtifactVersionIdentity {
    fn encode(&self) -> JsonValue {
        let encoded = self.identity.encode();
        let JsonValue::Object(mut object) = encoded else {
            unreachable!()
        };
        object.insert("versionID".into(), self.version_id.encode());
        JsonValue::Object(object)
    }
}
impl DomainDecode for ProjectScope {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = crate::ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("project".into()))?;
        Ok(Self {
            id: o.field("id")?,
            project_id: o.field("projectID")?,
            storage_id: o.field("storageID")?,
        })
    }
}
impl DomainEncode for ProjectScope {
    fn encode(&self) -> JsonValue {
        crate::ObjectEncoder::new()
            .field("type", &LosslessString::from("project"))
            .field("id", &self.id)
            .field("projectID", &self.project_id)
            .field("storageID", &self.storage_id)
            .finish()
    }
}
impl DomainDecode for GlobalScope {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = crate::ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("global".into()))?;
        Ok(Self {
            id: o.field("id")?,
            storage_id: o.field("storageID")?,
        })
    }
}
impl DomainEncode for GlobalScope {
    fn encode(&self) -> JsonValue {
        crate::ObjectEncoder::new()
            .field("type", &LosslessString::from("global"))
            .field("id", &self.id)
            .field("storageID", &self.storage_id)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ProjectArtifactKey {
    pub scope: ProjectScopeSelector,
    pub kind: Kind,
    pub id: Id,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ProjectScopeSelector;
#[derive(Clone, Debug, PartialEq)]
pub struct GlobalScopeSelector;
impl DomainDecode for ProjectScopeSelector {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        crate::ObjectDecoder::new(v, p)?.literal("type", &JsonValue::String("project".into()))?;
        Ok(Self)
    }
}
impl DomainEncode for ProjectScopeSelector {
    fn encode(&self) -> JsonValue {
        crate::ObjectEncoder::new()
            .field("type", &LosslessString::from("project"))
            .finish()
    }
}
impl DomainDecode for GlobalScopeSelector {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        crate::ObjectDecoder::new(v, p)?.literal("type", &JsonValue::String("global".into()))?;
        Ok(Self)
    }
}
impl DomainEncode for GlobalScopeSelector {
    fn encode(&self) -> JsonValue {
        crate::ObjectEncoder::new()
            .field("type", &LosslessString::from("global"))
            .finish()
    }
}
impl DomainDecode for ProjectArtifactKey {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = crate::ObjectDecoder::new(v, p)?;
        Ok(Self {
            scope: o.field("scope")?,
            kind: o.field("kind")?,
            id: o.field("id")?,
        })
    }
}
impl DomainEncode for ProjectArtifactKey {
    fn encode(&self) -> JsonValue {
        crate::ObjectEncoder::new()
            .field("scope", &self.scope)
            .field("kind", &self.kind)
            .field("id", &self.id)
            .finish()
    }
}
macro_rules! record {
    ($name:ident { $($field:ident : $ty:ty => $key:literal, $mode:ident;)* }) => {
        #[derive(Clone, Debug, PartialEq)]
        pub struct $name { $(pub $field:$ty,)* }
        impl DomainDecode for $name {
            fn decode_at(v:&JsonValue,p:&JsonPath)->Result<Self,DecodeError>{validate_record(stringify!($name),v,p)?;let o=crate::ObjectDecoder::new(v,p)?;Ok(Self{$($field:decode_field!(&o,$key,$mode)?,)*})}
        }
        impl DomainEncode for $name {
            fn encode(&self)->JsonValue{let mut o=crate::ObjectEncoder::new();$(o=encode_field!(o,self.$field,$key,$mode);)*o.finish()}
        }
    };
}
macro_rules! decode_field {
    ($object:expr,$key:literal,required) => {
        $object.field($key)
    };
    ($object:expr,$key:literal,optional) => {
        $object.optional($key)
    };
}
macro_rules! encode_field {
    ($object:expr,$field:expr,$key:literal,required) => {
        $object.field($key, &$field)
    };
    ($object:expr,$field:expr,$key:literal,optional) => {
        $object.optional($key, &$field)
    };
}
literal_type!(
    CollisionType,
    [
        "existing-source",
        "cross-scope",
        "project-over-global-shadow"
    ]
);
record!(Provenance {
    source: Source => "source", required;
    creator_agent_id: Option<crate::agent::Id> => "creatorAgentID", optional;
    creator_session_id: Option<crate::session::Id> => "creatorSessionID", optional;
    insight_digest: Option<Digest> => "insightDigest", optional;
    origin_scope_id: Option<ScopeId> => "originScopeID", optional;
    origin_version_id: Option<VersionId> => "originVersionID", optional;
    origin_evidence_digest: Option<Digest> => "originEvidenceDigest", optional;
});
record!(Version {
    id: VersionId => "id", required;
    parent_version_id: Option<VersionId> => "parentVersionID", optional;
    state: VersionState => "state", required;
    content_digest: Digest => "contentDigest", required;
    content_relpath: ContentRelpath => "contentRelpath", required;
    provenance: Provenance => "provenance", required;
    time_created: TimestampMillis => "timeCreated", required;
    time_state_changed: TimestampMillis => "timeStateChanged", required;
});
record!(Artifact {
    scope: Scope => "scope", required;
    kind: Kind => "kind", required;
    id: Id => "id", required;
    revision: Revision => "revision", required;
    stage: Stage => "stage", required;
    current_version_id: VersionId => "currentVersionID", required;
    fallback_version_id: Option<VersionId> => "fallbackVersionID", optional;
    shadowed_scope_id: Option<ScopeId> => "shadowedScopeID", optional;
    last_used_at: Option<TimestampMillis> => "lastUsedAt", optional;
    time_created: TimestampMillis => "timeCreated", required;
    time_updated: TimestampMillis => "timeUpdated", required;
});
record!(ArtifactSummary {
    scope: Scope => "scope", required;
    kind: Kind => "kind", required;
    id: Id => "id", required;
    name: DisplayName => "name", required;
    description: Description => "description", required;
    stage: Stage => "stage", required;
    revision: Revision => "revision", required;
    current_version_id: VersionId => "currentVersionID", required;
    current_digest: Digest => "currentDigest", required;
    last_used_at: Option<TimestampMillis> => "lastUsedAt", optional;
    time_updated: TimestampMillis => "timeUpdated", required;
});
record!(CollisionDiagnostic {
    diagnostic_type: CollisionType => "type", required;
    kind: Kind => "kind", required;
    id: Id => "id", required;
    scope_id: Option<ScopeId> => "scopeID", optional;
    message: Description => "message", required;
});
record!(ArtifactDetails {
    artifact: Artifact => "artifact", required;
    definition: Definition => "definition", required;
    current_version: Version => "currentVersion", required;
    versions: Vec<Version> => "versions", required;
    diagnostics: Vec<CollisionDiagnostic> => "diagnostics", required;
});
record!(Metrics {
    score: f64 => "score", required;
    confidence: Confidence => "confidence", required;
    reward_units: f64 => "rewardUnits", required;
    penalty_units: f64 => "penaltyUnits", required;
    last_used_at: Option<TimestampMillis> => "lastUsedAt", optional;
});
record!(Trash {
    deletion_id: DeletionId => "deletionID", required;
    scope: Scope => "scope", required;
    kind: Kind => "kind", required;
    id: Id => "id", required;
    prior_stage: Stage => "priorStage", required;
    prior_version_id: VersionId => "priorVersionID", required;
    deleted_at: TimestampMillis => "deletedAt", required;
    purge_after: TimestampMillis => "purgeAfter", required;
});
literal_type!(Risk, ["declarative", "executable"]);
record!(Activation {
    id: ActivationId => "id", required;
    artifact: ArtifactVersionIdentity => "artifact", required;
    project_id: Option<crate::project::Id> => "projectID", optional;
    session_id: Option<crate::session::Id> => "sessionID", optional;
    agent_id: Option<crate::agent::Id> => "agentID", optional;
    source: ActivationSource => "source", required;
    message_id: Option<NonEmptyText> => "messageID", optional;
    call_id: Option<NonEmptyText> => "callID", optional;
    boundary_seq: Revision => "boundarySeq", required;
    activated_at: TimestampMillis => "activatedAt", required;
    deactivated_at: Option<TimestampMillis> => "deactivatedAt", optional;
});
record!(Observation {
    id: ObservationId => "id", required;
    artifact: ArtifactVersionIdentity => "artifact", required;
    project_id: Option<crate::project::Id> => "projectID", optional;
    session_id: Option<crate::session::Id> => "sessionID", optional;
    activation_set_digest: Digest => "activationSetDigest", required;
    active_artifact_count: Revision => "activeArtifactCount", required;
    external_confounded: bool => "externalConfounded", required;
    eligible: bool => "eligible", required;
    terminal_outcome: TerminalOutcome => "terminalOutcome", required;
    goal_status: GoalStatus => "goalStatus", required;
    repeat_fix: bool => "repeatFix", required;
    latency_ms: Option<TimestampMillis> => "latencyMs", optional;
    input_tokens: Option<Revision> => "inputTokens", optional;
    output_tokens: Option<Revision> => "outputTokens", optional;
    cache_read_tokens: Option<Revision> => "cacheReadTokens", optional;
    completed_tool_count: Option<Revision> => "completedToolCount", optional;
    failed_tool_count: Option<Revision> => "failedToolCount", optional;
    terminal_message_id: Option<NonEmptyText> => "terminalMessageID", optional;
    observed_at: TimestampMillis => "observedAt", required;
});
record!(Feedback {
    artifact: ArtifactVersionIdentity => "artifact", required;
    action: FeedbackAction => "action", required;
    actor: FeedbackActor => "actor", required;
    time_created: TimestampMillis => "timeCreated", required;
});
record!(AutomaticWrite {
    scope_id: ScopeId => "scopeID", required;
    session_id: crate::session::Id => "sessionID", required;
    insight_digest: Digest => "insightDigest", required;
    operation: AutomaticWriteOperation => "operation", required;
    result: AutomaticWriteResult => "result", required;
    version_id: VersionId => "versionID", required;
    content_digest: Digest => "contentDigest", required;
    time_created: TimestampMillis => "timeCreated", required;
});
record!(MutationExpectation {
    expected_revision: Revision => "expectedRevision", required;
    expected_version_id: VersionId => "expectedVersionID", required;
    expected_digest: Digest => "expectedDigest", required;
});
record!(CreateRequest {
    key: ArtifactKey => "key", required;
    definition: Definition => "definition", required;
});
record!(UpdateRequest {
    key: ArtifactKey => "key", required;
    definition: Definition => "definition", required;
    expected_revision: Revision => "expectedRevision", required;
    expected_version_id: VersionId => "expectedVersionID", required;
    expected_digest: Digest => "expectedDigest", required;
});
record!(DeleteRequest {
    key: ArtifactKey => "key", required;
    expected_revision: Revision => "expectedRevision", required;
    expected_version_id: VersionId => "expectedVersionID", required;
    expected_digest: Digest => "expectedDigest", required;
});
record!(RestoreRequest { deletion_id: DeletionId => "deletionID", required; });
record!(ListRequest {
    scope: ScopeSelector => "scope", required;
    kind: Option<Kind> => "kind", optional;
    stage: Option<Stage> => "stage", optional;
});
record!(PromotionPreviewRequest {
    key: ProjectArtifactKey => "key", required;
    expected_revision: Revision => "expectedRevision", required;
    expected_version_id: VersionId => "expectedVersionID", required;
    expected_digest: Digest => "expectedDigest", required;
});
record!(PromotionConfirmRequest { token: ConfirmationToken => "token", required; });
record!(PromotionPreview {
    artifact: ArtifactSummary => "artifact", required;
    metrics: Metrics => "metrics", required;
    destination: GlobalScope => "destination", required;
    risk: Risk => "risk", required;
    rendered_content: RenderedContent => "renderedContent", required;
    collision: Option<CollisionDiagnostic> => "collision", optional;
    token: ConfirmationToken => "token", required;
    expires_at: TimestampMillis => "expiresAt", required;
});
record!(ValidationError {
    code: ErrorCode => "code", required;
    message: Description => "message", required;
    field: Option<NonEmptyText> => "field", optional;
});
record!(UnsupportedKindError {
    code: UnsupportedKindCode => "code", required;
    kind: Kind => "kind", required;
    message: Description => "message", required;
});

string_domain!(NonEmptyText, |v: &LosslessString| !v.is_empty());
literal_type!(UnsupportedKindCode, ["UnsupportedKind"]);
fn validate_record(name: &str, value: &JsonValue, path: &JsonPath) -> Result<(), DecodeError> {
    if name == "Metrics" {
        let o = crate::ObjectDecoder::new(value, path)?;
        let score: f64 = o.field("score")?;
        let reward: f64 = o.field("rewardUnits")?;
        let penalty: f64 = o.field("penaltyUnits")?;
        if !score.is_finite()
            || !(-1.0..=1.0).contains(&score)
            || reward.is_nan()
            || reward < 0.0
            || penalty.is_nan()
            || penalty < 0.0
        {
            return Err(path.error(DecodeErrorKind::Expected("valid artifact metrics")));
        }
    }
    if name == "Trash" {
        let o = crate::ObjectDecoder::new(value, path)?;
        let deleted: TimestampMillis = o.field("deletedAt")?;
        let purge: TimestampMillis = o.field("purgeAfter")?;
        if purge.get() as f64 != deleted.get() as f64 + 30.0 * 86_400_000.0 {
            return Err(path.error(DecodeErrorKind::Expected(
                "purge timestamp 30 days after deletion",
            )));
        }
    }
    if name == "CreateRequest" || name == "UpdateRequest" {
        let o = crate::ObjectDecoder::new(value, path)?;
        let key: ArtifactKey = o.field("key")?;
        let definition: Definition = o.field("definition")?;
        if key.kind.as_lossless().as_str() != Some(definition.kind()) {
            return Err(path.error(DecodeErrorKind::Expected("matching artifact kinds")));
        }
    }
    Ok(())
}
impl Kind {
    pub fn as_lossless(&self) -> &LosslessString {
        &self.0
    }
}
impl Definition {
    fn kind(&self) -> &'static str {
        match self {
            Self::Skill(_) => "skill",
            Self::Command(_) => "command",
            Self::Agent(_) => "agent",
            Self::Plugin(_) => "plugin",
        }
    }
}
