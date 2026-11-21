use super::prompt_cache::{canonical_json, sha256};
use ycoding_schema::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder, parse_json, schema::NonNegativeInt, session_message,
};

fn digest_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn strict<'a>(
    value: &'a JsonValue,
    path: &'a JsonPath,
    known: &[&str],
) -> Result<ObjectDecoder<'a>, DecodeError> {
    let JsonValue::Object(object) = value else {
        return Err(path.error(DecodeErrorKind::Expected("object")));
    };
    for (key, _) in object.iter() {
        if !known.contains(&key.as_str().unwrap_or_default()) {
            return Err(path
                .key(key.as_str().unwrap_or_default())
                .error(DecodeErrorKind::Expected("no excess properties")));
        }
    }
    ObjectDecoder::new(value, path)
}

fn digest_field(object: &ObjectDecoder, path: &JsonPath) -> Result<LosslessString, DecodeError> {
    let value: LosslessString = object.field("digest")?;
    match value.as_str() {
        Some(text) if digest_valid(text) => Ok(value),
        _ => Err(path
            .key("digest")
            .error(DecodeErrorKind::Expected("64 lowercase hex digits"))),
    }
}

fn nonempty_field(
    object: &ObjectDecoder,
    path: &JsonPath,
    key: &str,
) -> Result<LosslessString, DecodeError> {
    let value: LosslessString = object.field(key)?;
    match value.as_str() {
        Some(text) if !text.is_empty() => Ok(value),
        _ => Err(path
            .key(key)
            .error(DecodeErrorKind::Expected("nonempty string"))),
    }
}

pub fn payload_digest(value: &JsonValue) -> String {
    sha256(&canonical_json(value))
}

#[derive(Clone, Debug, PartialEq)]
pub struct CoveredThrough {
    pub message_id: session_message::Id,
    pub seq: NonNegativeInt,
}

impl DomainDecode for CoveredThrough {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = strict(value, path, &["messageID", "seq"])?;
        Ok(Self {
            message_id: object.field("messageID")?,
            seq: object.field("seq")?,
        })
    }
}

impl DomainEncode for CoveredThrough {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("messageID", &self.message_id)
            .field("seq", &self.seq)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MessageSelector {
    pub message_id: session_message::Id,
    pub digest: LosslessString,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PartSelector {
    pub message_id: session_message::Id,
    pub ordinal: NonNegativeInt,
    pub part_kind: LosslessString,
    pub digest: LosslessString,
}

#[derive(Clone, Debug, PartialEq)]
pub enum TargetSelector {
    Message(MessageSelector),
    Part(PartSelector),
}

impl TargetSelector {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Message(_) => "message",
            Self::Part(_) => "part",
        }
    }
}

fn decode_selector(
    value: &JsonValue,
    path: &JsonPath,
    extra: &[&str],
) -> Result<TargetSelector, DecodeError> {
    let JsonValue::Object(_) = value else {
        return Err(path.error(DecodeErrorKind::Expected("object")));
    };
    let peek = ObjectDecoder::new(value, path)?;
    let kind: LosslessString = peek.field("kind")?;
    match kind.as_str() {
        Some("message") => {
            let known = ["kind", "messageID", "digest"];
            let all = known.into_iter().chain(extra.iter().copied());
            let object = strict(value, path, &all.collect::<Vec<_>>())?;
            Ok(TargetSelector::Message(MessageSelector {
                message_id: object.field("messageID")?,
                digest: digest_field(&object, path)?,
            }))
        }
        Some("part") => {
            let known = ["kind", "messageID", "ordinal", "partKind", "digest"];
            let object = strict(
                value,
                path,
                &known
                    .into_iter()
                    .chain(extra.iter().copied())
                    .collect::<Vec<_>>(),
            )?;
            Ok(TargetSelector::Part(PartSelector {
                message_id: object.field("messageID")?,
                ordinal: object.field("ordinal")?,
                part_kind: nonempty_field(&object, path, "partKind")?,
                digest: digest_field(&object, path)?,
            }))
        }
        _ => Err(path
            .key("kind")
            .error(DecodeErrorKind::Expected("message or part"))),
    }
}

fn encode_selector(selector: &TargetSelector) -> JsonValue {
    match selector {
        TargetSelector::Message(selector) => ObjectEncoder::new()
            .field("kind", &LosslessString::from("message"))
            .field("messageID", &selector.message_id)
            .field("digest", &selector.digest)
            .finish(),
        TargetSelector::Part(selector) => ObjectEncoder::new()
            .field("kind", &LosslessString::from("part"))
            .field("messageID", &selector.message_id)
            .field("ordinal", &selector.ordinal)
            .field("partKind", &selector.part_kind)
            .field("digest", &selector.digest)
            .finish(),
    }
}

impl DomainDecode for TargetSelector {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        decode_selector(value, path, &[])
    }
}

impl DomainEncode for TargetSelector {
    fn encode(&self) -> JsonValue {
        encode_selector(self)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderStateSelector {
    pub message_id: session_message::Id,
    pub ordinal: NonNegativeInt,
    pub part_kind: LosslessString,
    pub digest: LosslessString,
}

impl DomainDecode for ProviderStateSelector {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = strict(
            value,
            path,
            &["kind", "messageID", "ordinal", "partKind", "digest"],
        )?;
        let kind: LosslessString = object.field("kind")?;
        if kind.as_str() != Some("provider_state") {
            return Err(path
                .key("kind")
                .error(DecodeErrorKind::Expected("provider_state")));
        }
        Ok(Self {
            message_id: object.field("messageID")?,
            ordinal: object.field("ordinal")?,
            part_kind: nonempty_field(&object, path, "partKind")?,
            digest: digest_field(&object, path)?,
        })
    }
}

impl DomainEncode for ProviderStateSelector {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("kind", &LosslessString::from("provider_state"))
            .field("messageID", &self.message_id)
            .field("ordinal", &self.ordinal)
            .field("partKind", &self.part_kind)
            .field("digest", &self.digest)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Exclusion {
    ExactDuplicate {
        target: TargetSelector,
        evidence: TargetSelector,
    },
    SupersededAuthority {
        target: TargetSelector,
        authority_kind: LosslessString,
        authority_key: LosslessString,
        target_revision: NonNegativeInt,
        evidence: TargetSelector,
        evidence_revision: NonNegativeInt,
    },
    TerminalIntermediate {
        target: TargetSelector,
        terminal_event_id: LosslessString,
    },
    StaleToolResult {
        target: TargetSelector,
        tool: LosslessString,
        resource_key: LosslessString,
        target_revision: NonNegativeInt,
        evidence: TargetSelector,
        evidence_revision: NonNegativeInt,
    },
}

impl Exclusion {
    pub fn reason(&self) -> &'static str {
        match self {
            Self::ExactDuplicate { .. } => "exact_duplicate",
            Self::SupersededAuthority { .. } => "superseded_authority",
            Self::TerminalIntermediate { .. } => "terminal_intermediate",
            Self::StaleToolResult { .. } => "stale_tool_result",
        }
    }
    pub fn target(&self) -> &TargetSelector {
        match self {
            Self::ExactDuplicate { target, .. }
            | Self::SupersededAuthority { target, .. }
            | Self::TerminalIntermediate { target, .. }
            | Self::StaleToolResult { target, .. } => target,
        }
    }
}

fn decode_exclusion(
    value: &JsonValue,
    path: &JsonPath,
    extra: &[&str],
) -> Result<Exclusion, DecodeError> {
    let peek = ObjectDecoder::new(value, path)?;
    let reason: LosslessString = peek.field("reason")?;
    let known: Vec<&str> = match reason.as_str() {
        Some("exact_duplicate") => vec!["reason", "target", "evidence"],
        Some("superseded_authority") => vec![
            "reason",
            "target",
            "authorityKind",
            "authorityKey",
            "targetRevision",
            "evidence",
            "evidenceRevision",
        ],
        Some("terminal_intermediate") => vec!["reason", "target", "terminalEventID"],
        Some("stale_tool_result") => vec![
            "reason",
            "target",
            "tool",
            "resourceKey",
            "targetRevision",
            "evidence",
            "evidenceRevision",
        ],
        _ => {
            return Err(path.key("reason").error(DecodeErrorKind::Expected(
                "exact_duplicate, superseded_authority, terminal_intermediate or stale_tool_result",
            )));
        }
    };
    let object = strict(
        value,
        path,
        &known
            .into_iter()
            .chain(extra.iter().copied())
            .collect::<Vec<_>>(),
    )?;
    let target = decode_selector(
        object
            .optional::<JsonValue>("target")?
            .as_ref()
            .ok_or_else(|| path.key("target").error(DecodeErrorKind::Missing))?,
        &path.key("target"),
        extra,
    )?;
    match reason.as_str() {
        Some("exact_duplicate") => Ok(Exclusion::ExactDuplicate {
            target,
            evidence: decode_selector(
                object
                    .optional::<JsonValue>("evidence")?
                    .as_ref()
                    .ok_or_else(|| path.key("evidence").error(DecodeErrorKind::Missing))?,
                &path.key("evidence"),
                extra,
            )?,
        }),
        Some("superseded_authority") => Ok(Exclusion::SupersededAuthority {
            target,
            authority_kind: nonempty_field(&object, path, "authorityKind")?,
            authority_key: nonempty_field(&object, path, "authorityKey")?,
            target_revision: object.field("targetRevision")?,
            evidence: decode_selector(
                object
                    .optional::<JsonValue>("evidence")?
                    .as_ref()
                    .ok_or_else(|| path.key("evidence").error(DecodeErrorKind::Missing))?,
                &path.key("evidence"),
                extra,
            )?,
            evidence_revision: object.field("evidenceRevision")?,
        }),
        Some("terminal_intermediate") => Ok(Exclusion::TerminalIntermediate {
            target,
            terminal_event_id: object.field("terminalEventID")?,
        }),
        _ => Ok(Exclusion::StaleToolResult {
            target,
            tool: nonempty_field(&object, path, "tool")?,
            resource_key: nonempty_field(&object, path, "resourceKey")?,
            target_revision: object.field("targetRevision")?,
            evidence: decode_selector(
                object
                    .optional::<JsonValue>("evidence")?
                    .as_ref()
                    .ok_or_else(|| path.key("evidence").error(DecodeErrorKind::Missing))?,
                &path.key("evidence"),
                extra,
            )?,
            evidence_revision: object.field("evidenceRevision")?,
        }),
    }
}

impl DomainDecode for Exclusion {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        decode_exclusion(value, path, &[])
    }
}

impl DomainEncode for Exclusion {
    fn encode(&self) -> JsonValue {
        match self {
            Self::ExactDuplicate { target, evidence } => ObjectEncoder::new()
                .field("reason", &LosslessString::from("exact_duplicate"))
                .field("target", target)
                .field("evidence", evidence)
                .finish(),
            Self::SupersededAuthority {
                target,
                authority_kind,
                authority_key,
                target_revision,
                evidence,
                evidence_revision,
            } => ObjectEncoder::new()
                .field("reason", &LosslessString::from("superseded_authority"))
                .field("target", target)
                .field("authorityKind", authority_kind)
                .field("authorityKey", authority_key)
                .field("targetRevision", target_revision)
                .field("evidence", evidence)
                .field("evidenceRevision", evidence_revision)
                .finish(),
            Self::TerminalIntermediate {
                target,
                terminal_event_id,
            } => ObjectEncoder::new()
                .field("reason", &LosslessString::from("terminal_intermediate"))
                .field("target", target)
                .field("terminalEventID", terminal_event_id)
                .finish(),
            Self::StaleToolResult {
                target,
                tool,
                resource_key,
                target_revision,
                evidence,
                evidence_revision,
            } => ObjectEncoder::new()
                .field("reason", &LosslessString::from("stale_tool_result"))
                .field("target", target)
                .field("tool", tool)
                .field("resourceKey", resource_key)
                .field("targetRevision", target_revision)
                .field("evidence", evidence)
                .field("evidenceRevision", evidence_revision)
                .finish(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ProtectedStateSource {
    Instructions,
    Todos,
    Goal,
    Autonomy,
    Permissions,
    Guardrails,
    ProjectArtifacts,
    PendingWork,
    Orchestration,
}

impl ProtectedStateSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Instructions => "instructions",
            Self::Todos => "todos",
            Self::Goal => "goal",
            Self::Autonomy => "autonomy",
            Self::Permissions => "permissions",
            Self::Guardrails => "guardrails",
            Self::ProjectArtifacts => "project_artifacts",
            Self::PendingWork => "pending_work",
            Self::Orchestration => "orchestration",
        }
    }
}

impl DomainDecode for ProtectedStateSource {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let text: LosslessString = LosslessString::decode_at(value, path)?;
        match text.as_str() {
            Some("instructions") => Ok(Self::Instructions),
            Some("todos") => Ok(Self::Todos),
            Some("goal") => Ok(Self::Goal),
            Some("autonomy") => Ok(Self::Autonomy),
            Some("permissions") => Ok(Self::Permissions),
            Some("guardrails") => Ok(Self::Guardrails),
            Some("project_artifacts") => Ok(Self::ProjectArtifacts),
            Some("pending_work") => Ok(Self::PendingWork),
            Some("orchestration") => Ok(Self::Orchestration),
            _ => Err(path.error(DecodeErrorKind::Expected("protected-state source"))),
        }
    }
}

impl DomainEncode for ProtectedStateSource {
    fn encode(&self) -> JsonValue {
        JsonValue::String(self.as_str().into())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProtectedStateEntry {
    pub source: ProtectedStateSource,
    pub revision: NonNegativeInt,
    pub digest: LosslessString,
}

impl DomainDecode for ProtectedStateEntry {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = strict(value, path, &["source", "revision", "digest"])?;
        Ok(Self {
            source: object.field("source")?,
            revision: object.field("revision")?,
            digest: digest_field(&object, path)?,
        })
    }
}

impl DomainEncode for ProtectedStateEntry {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("source", &self.source)
            .field("revision", &self.revision)
            .field("digest", &self.digest)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub base_context_revision: NonNegativeInt,
    pub covered_through: CoveredThrough,
    pub protected_state: Vec<ProtectedStateEntry>,
    pub exclusions: Vec<Exclusion>,
}

impl DomainDecode for Candidate {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = strict(
            value,
            path,
            &[
                "schemaVersion",
                "baseContextRevision",
                "coveredThrough",
                "protectedState",
                "exclusions",
            ],
        )?;
        let version: f64 = object.field("schemaVersion")?;
        if version != 1.0 {
            return Err(path
                .key("schemaVersion")
                .error(DecodeErrorKind::Expected("1")));
        }
        Ok(Self {
            base_context_revision: object.field("baseContextRevision")?,
            covered_through: object.field("coveredThrough")?,
            protected_state: object.field("protectedState")?,
            exclusions: object.field("exclusions")?,
        })
    }
}

pub fn decode_candidate(input: &str) -> Result<Candidate, DecodeError> {
    let value = parse_json(input)
        .map_err(|_| JsonPath::default().error(DecodeErrorKind::Expected("JSON")))?;
    Candidate::decode(&value)
}

#[derive(Clone, Debug, PartialEq)]
pub struct RollingSummary {
    pub text: LosslessString,
    pub covered_through: CoveredThrough,
    pub digest: LosslessString,
}

impl DomainDecode for RollingSummary {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = strict(value, path, &["text", "coveredThrough", "digest"])?;
        let text: LosslessString = object.field("text")?;
        if text.as_str().is_none_or(str::is_empty) {
            return Err(path
                .key("text")
                .error(DecodeErrorKind::Expected("nonempty string")));
        }
        Ok(Self {
            text,
            covered_through: object.field("coveredThrough")?,
            digest: digest_field(&object, path)?,
        })
    }
}

impl DomainEncode for RollingSummary {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("text", &self.text)
            .field("coveredThrough", &self.covered_through)
            .field("digest", &self.digest)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RetainedItem {
    pub message_id: session_message::Id,
    pub seq: NonNegativeInt,
    pub digest: LosslessString,
}

impl DomainDecode for RetainedItem {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = strict(value, path, &["messageID", "seq", "digest"])?;
        Ok(Self {
            message_id: object.field("messageID")?,
            seq: object.field("seq")?,
            digest: digest_field(&object, path)?,
        })
    }
}

impl DomainEncode for RetainedItem {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("messageID", &self.message_id)
            .field("seq", &self.seq)
            .field("digest", &self.digest)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RemoteStored {
    pub provider: LosslessString,
    pub model_id: LosslessString,
    pub variant: Option<LosslessString>,
    pub digest: LosslessString,
    pub item_id: LosslessString,
    pub retained: Vec<RetainedItem>,
}

impl DomainDecode for RemoteStored {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = strict(
            value,
            path,
            &[
                "provider", "modelID", "variant", "digest", "itemID", "retained",
            ],
        )?;
        Ok(Self {
            provider: nonempty_field(&object, path, "provider")?,
            model_id: nonempty_field(&object, path, "modelID")?,
            variant: object.optional("variant")?,
            digest: digest_field(&object, path)?,
            item_id: nonempty_field(&object, path, "itemID")?,
            retained: object.field("retained")?,
        })
    }
}

impl DomainEncode for RemoteStored {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("provider", &self.provider)
            .field("modelID", &self.model_id)
            .optional("variant", &self.variant)
            .field("digest", &self.digest)
            .field("itemID", &self.item_id)
            .field(
                "retained",
                &JsonValue::Array(self.retained.iter().map(DomainEncode::encode).collect()),
            )
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolCall {
    pub call_id: String,
    pub role: ToolCallRole,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ToolCallRole {
    Call,
    Result,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntermediateKind {
    AssistantReasoning,
    ToolProgress,
    RetryNotice,
    FailedPartialProviderOutput,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ContextItem {
    pub message_id: session_message::Id,
    pub position: i64,
    pub terminal_seq: i64,
    pub input_kind: String,
    pub payload: JsonValue,
    pub tokens: i64,
    pub dependency_group: Option<String>,
    pub tool_call: Option<ToolCall>,
    pub kind: ContextItemKind,
    pub ordinal: i64,
    pub part_kind: String,
    pub execution_group: String,
    pub intermediate_kind: Option<IntermediateKind>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContextItemKind {
    Message,
    Part,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SettlementEvidence {
    Running {
        execution_group: String,
    },
    Terminal {
        execution_group: String,
        terminal_event_id: LosslessString,
        outcome: SettlementOutcome,
        successful_tool_effect: bool,
        file_change: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettlementOutcome {
    Succeeded,
    Failed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AuthorityEvidence {
    pub selector: TargetSelector,
    pub authority_kind: String,
    pub authority_key: String,
    pub revision: i64,
    pub tool: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolResourceAuthority {
    pub tool: String,
    pub authority_kind: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolResultEvidence {
    pub selector: TargetSelector,
    pub tool: String,
    pub resource_key: String,
    pub revision: i64,
    pub status: SettlementOutcome,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderLinkEvidence {
    pub message_id: session_message::Id,
    pub ordinal: i64,
    pub part_kind: String,
    pub digest: LosslessString,
    pub terminal_seq: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RuntimeEvidence {
    pub base_context_revision: i64,
    pub covered_through: CoveredThrough,
    pub items: Vec<ContextItem>,
    pub settlements: Vec<SettlementEvidence>,
    pub authorities: Vec<AuthorityEvidence>,
    pub resource_authorities: Vec<ToolResourceAuthority>,
    pub tool_results: Vec<ToolResultEvidence>,
    pub recent_tail: Vec<TargetSelector>,
    pub protected_targets: Vec<TargetSelector>,
    pub provider_links: Vec<ProviderLinkEvidence>,
    pub protected_state: Vec<ProtectedStateEntry>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModelTokens {
    pub before: i64,
    pub after: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ValidationInput {
    pub candidate: Candidate,
    pub evidence: RuntimeEvidence,
    pub summary: Option<RollingSummary>,
    pub model_tokens: Option<ModelTokens>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum IssueCode {
    BaseRevisionChanged,
    CoveredBoundaryChanged,
    DuplicateTarget,
    EvidenceAfterBoundary,
    EvidenceExcluded,
    EmptyRetainedHistory,
    InvalidExactDuplicate,
    InvalidRuntimeEvidence,
    InvalidStaleToolResult,
    InvalidSupersededAuthority,
    InvalidTerminalIntermediate,
    NoTokenReduction,
    NonChronologicalLowering,
    PartUnsettled,
    ProtectedRecentTail,
    ProtectedStateChanged,
    ProtectedTarget,
    SelectorMismatch,
    TargetAfterBoundary,
    DependencyClosure,
    UndeclaredToolAuthority,
}

impl IssueCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BaseRevisionChanged => "base_revision_changed",
            Self::CoveredBoundaryChanged => "covered_boundary_changed",
            Self::DuplicateTarget => "duplicate_target",
            Self::EvidenceAfterBoundary => "evidence_after_boundary",
            Self::EvidenceExcluded => "evidence_excluded",
            Self::EmptyRetainedHistory => "empty_retained_history",
            Self::InvalidExactDuplicate => "invalid_exact_duplicate",
            Self::InvalidRuntimeEvidence => "invalid_runtime_evidence",
            Self::InvalidStaleToolResult => "invalid_stale_tool_result",
            Self::InvalidSupersededAuthority => "invalid_superseded_authority",
            Self::InvalidTerminalIntermediate => "invalid_terminal_intermediate",
            Self::NoTokenReduction => "no_token_reduction",
            Self::NonChronologicalLowering => "non_chronological_lowering",
            Self::PartUnsettled => "part_unsettled",
            Self::ProtectedRecentTail => "protected_recent_tail",
            Self::ProtectedStateChanged => "protected_state_changed",
            Self::ProtectedTarget => "protected_target",
            Self::SelectorMismatch => "selector_mismatch",
            Self::TargetAfterBoundary => "target_after_boundary",
            Self::DependencyClosure => "dependency_closure",
            Self::UndeclaredToolAuthority => "undeclared_tool_authority",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Issue {
    pub code: IssueCode,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ValidatedLocalExclusion {
    pub exclusion: Exclusion,
    pub target_key: String,
    pub dependency_group: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderRebaseExclusion {
    pub target: ProviderStateSelector,
    pub target_key: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ValidatedExclusion {
    Local(Box<ValidatedLocalExclusion>),
    ProviderRebase(ProviderRebaseExclusion),
}

impl ValidatedExclusion {
    pub fn reason(&self) -> &'static str {
        match self {
            Self::Local(exclusion) => exclusion.exclusion.reason(),
            Self::ProviderRebase(_) => "provider_rebase",
        }
    }
    pub fn target_key(&self) -> &str {
        match self {
            Self::Local(exclusion) => &exclusion.target_key,
            Self::ProviderRebase(exclusion) => &exclusion.target_key,
        }
    }
    pub fn target_kind(&self) -> &'static str {
        match self {
            Self::Local(exclusion) => exclusion.exclusion.target().kind(),
            Self::ProviderRebase(_) => "provider_state",
        }
    }
    pub fn target(&self) -> JsonValue {
        match self {
            Self::Local(exclusion) => exclusion.exclusion.target().encode(),
            Self::ProviderRebase(exclusion) => exclusion.target.encode(),
        }
    }
    pub fn dependency_group(&self) -> Option<&str> {
        match self {
            Self::Local(exclusion) => exclusion.dependency_group.as_deref(),
            Self::ProviderRebase(_) => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Manifest {
    pub base_context_revision: NonNegativeInt,
    pub covered_through: CoveredThrough,
    pub protected_state: Vec<ProtectedStateEntry>,
    pub exclusions: Vec<ValidatedExclusion>,
    pub summary: Option<RollingSummary>,
    pub remote: Option<RemoteStored>,
    pub remote_item: Option<JsonValue>,
    pub input_tokens: i64,
    pub retained_tokens: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RemoteInput {
    pub base_context_revision: NonNegativeInt,
    pub covered_through: CoveredThrough,
    pub protected_state: Vec<ProtectedStateEntry>,
    pub retained: Vec<RetainedItem>,
    pub provider: LosslessString,
    pub model_id: LosslessString,
    pub variant: Option<LosslessString>,
    pub input_tokens: i64,
    pub retained_tokens: i64,
    pub item: JsonValue,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RemoteError {
    pub message: String,
}

fn item_string(item: &JsonValue, key: &str) -> Option<String> {
    let JsonValue::Object(object) = item else {
        return None;
    };
    match object.get(&LosslessString::from(key)) {
        Some(JsonValue::String(value)) => value.as_str().map(str::to_string),
        _ => None,
    }
}

pub fn remote(input: RemoteInput) -> Result<Manifest, RemoteError> {
    let invalid = || RemoteError {
        message: "Invalid Codex remote compaction item".into(),
    };
    if item_string(&input.item, "type").as_deref() != Some("compaction") {
        return Err(invalid());
    }
    let id = item_string(&input.item, "id").filter(|id| !id.is_empty());
    if id.is_none() {
        return Err(invalid());
    }
    if item_string(&input.item, "encrypted_content")
        .as_deref()
        .is_none_or(str::is_empty)
    {
        return Err(invalid());
    }
    Ok(Manifest {
        base_context_revision: input.base_context_revision,
        covered_through: input.covered_through,
        protected_state: input.protected_state,
        exclusions: Vec::new(),
        summary: None,
        remote: Some(RemoteStored {
            provider: input.provider,
            model_id: input.model_id,
            variant: input.variant,
            digest: payload_digest(&input.item).into(),
            item_id: id.expect("checked present").into(),
            retained: input.retained,
        }),
        remote_item: Some(input.item),
        input_tokens: input.input_tokens,
        retained_tokens: input.retained_tokens,
    })
}

pub fn selector(item: &ContextItem) -> TargetSelector {
    let digest = payload_digest(&item.payload).into();
    match item.kind {
        ContextItemKind::Message => TargetSelector::Message(MessageSelector {
            message_id: item.message_id.clone(),
            digest,
        }),
        ContextItemKind::Part => TargetSelector::Part(PartSelector {
            message_id: item.message_id.clone(),
            ordinal: NonNegativeInt::new(item.ordinal).expect("selector ordinal is validated"),
            part_kind: item.part_kind.as_str().into(),
            digest,
        }),
    }
}

pub fn target_key(target: &JsonValue) -> String {
    sha256(&canonical_json(target))
}

fn message_name(id: &session_message::Id) -> String {
    id.as_lossless().to_utf8().unwrap_or_default()
}

fn selector_identity(selector: &TargetSelector) -> String {
    match selector {
        TargetSelector::Message(selector) => {
            format!("message\0{}", message_name(&selector.message_id))
        }
        TargetSelector::Part(selector) => format!(
            "part\0{}\0{}\0{}",
            message_name(&selector.message_id),
            selector.ordinal.get(),
            selector.part_kind.as_str().unwrap_or_default()
        ),
    }
}

fn item_identity(item: &ContextItem) -> String {
    match item.kind {
        ContextItemKind::Message => format!("message\0{}", message_name(&item.message_id)),
        ContextItemKind::Part => format!(
            "part\0{}\0{}\0{}",
            message_name(&item.message_id),
            item.ordinal,
            item.part_kind
        ),
    }
}

fn summary_selector(summary: &RollingSummary) -> TargetSelector {
    TargetSelector::Message(MessageSelector {
        message_id: summary.covered_through.message_id.clone(),
        digest: summary.digest.clone(),
    })
}

pub fn validate(input: &ValidationInput) -> Result<Manifest, Vec<Issue>> {
    let mut issues = Vec::new();
    let indexed = index_evidence(&input.evidence, &mut issues);
    let candidate_protected =
        normalize_protected_state(&input.candidate.protected_state, &mut issues);
    let current_protected = normalize_protected_state(&input.evidence.protected_state, &mut issues);
    if input.candidate.base_context_revision.get() != input.evidence.base_context_revision {
        add_issue(
            &mut issues,
            IssueCode::BaseRevisionChanged,
            "The candidate base context revision is no longer active",
        );
    }
    if !same_boundary(
        &input.candidate.covered_through,
        &input.evidence.covered_through,
    ) {
        add_issue(
            &mut issues,
            IssueCode::CoveredBoundaryChanged,
            "The candidate covered boundary no longer matches runtime evidence",
        );
    }
    if canonical_json(&JsonValue::Array(
        candidate_protected
            .iter()
            .map(DomainEncode::encode)
            .collect(),
    )) != canonical_json(&JsonValue::Array(
        current_protected.iter().map(DomainEncode::encode).collect(),
    )) {
        add_issue(
            &mut issues,
            IssueCode::ProtectedStateChanged,
            "The protected-state snapshot changed after candidate generation",
        );
    }
    let recent_tail = input
        .evidence
        .recent_tail
        .iter()
        .map(selector_identity)
        .collect::<std::collections::HashSet<_>>();
    let protected_targets = input
        .evidence
        .protected_targets
        .iter()
        .map(selector_identity)
        .collect::<std::collections::HashSet<_>>();
    let summarized = validate_summary(
        input.summary.as_ref(),
        &input.evidence,
        &indexed,
        &recent_tail,
        &protected_targets,
        &mut issues,
    );
    let mut target_identities = summarized
        .items
        .iter()
        .map(item_identity)
        .collect::<std::collections::HashSet<_>>();
    let mut resolved = Vec::new();
    for exclusion in &input.candidate.exclusions {
        let identity = selector_identity(exclusion.target());
        if target_identities.contains(&identity) {
            add_issue(
                &mut issues,
                IssueCode::DuplicateTarget,
                &format!("Target {identity} appears more than once"),
            );
        }
        target_identities.insert(identity.clone());
        let Some(item) = resolve_selector(exclusion.target(), &indexed, &mut issues) else {
            continue;
        };
        validate_item_boundary(
            item,
            indexed.boundary_position,
            &input.evidence.covered_through,
            true,
            &mut issues,
        );
        validate_part_settlement(item, &indexed, &mut issues);
        if recent_tail.contains(&identity) {
            add_issue(
                &mut issues,
                IssueCode::ProtectedRecentTail,
                &format!("Target {identity} belongs to the protected recent tail"),
            );
        }
        if protected_targets.contains(&identity) {
            add_issue(
                &mut issues,
                IssueCode::ProtectedTarget,
                &format!("Target {identity} is protected live state"),
            );
        }
        validate_reason(
            exclusion,
            item,
            input,
            &indexed,
            &target_identities,
            &mut issues,
        );
        resolved.push((exclusion.clone(), item.clone()));
    }
    validate_evidence_retention(
        &input.candidate.exclusions,
        &target_identities,
        &indexed,
        &mut issues,
    );
    validate_dependency_closure(&input.evidence.items, &target_identities, &mut issues);
    let canonical_input_tokens = input
        .evidence
        .items
        .iter()
        .map(|item| valid_tokens(item, &mut issues))
        .sum::<i64>();
    let mut excluded_identities = summarized
        .items
        .iter()
        .map(item_identity)
        .collect::<std::collections::HashSet<_>>();
    let mut excluded_items = summarized.items.clone();
    for (_, item) in &resolved {
        if excluded_identities.insert(item_identity(item)) {
            excluded_items.push((*item).clone());
        }
    }
    let canonical_retained_tokens = canonical_input_tokens
        - excluded_items
            .iter()
            .map(|item| valid_tokens(item, &mut issues))
            .sum::<i64>()
        + summarized
            .summary
            .as_ref()
            .map(|summary| {
                super::context_pressure::estimate(summary.text.as_str().unwrap_or_default())
            })
            .unwrap_or(0);
    if input
        .model_tokens
        .as_ref()
        .is_some_and(|tokens| tokens.before < 0 || tokens.after < 0)
    {
        add_issue(
            &mut issues,
            IssueCode::InvalidRuntimeEvidence,
            "Model-view token evidence must be non-negative integers",
        );
    }
    let input_tokens = input
        .model_tokens
        .as_ref()
        .map_or(canonical_input_tokens, |tokens| tokens.before);
    let retained_tokens = input
        .model_tokens
        .as_ref()
        .map_or(canonical_retained_tokens, |tokens| tokens.after);
    if retained_tokens >= input_tokens {
        add_issue(
            &mut issues,
            IssueCode::NoTokenReduction,
            "The candidate does not reduce the measured model-input tokens",
        );
    }
    if excluded_items.len() >= input.evidence.items.len() && summarized.summary.is_none() {
        add_issue(
            &mut issues,
            IssueCode::EmptyRetainedHistory,
            "The candidate would leave no retained chronological history",
        );
    }
    if !issues.is_empty() {
        return Err(deduplicate_issues(issues));
    }
    let mut ordered = resolved
        .into_iter()
        .map(|(exclusion, item)| {
            let key = target_key(&exclusion.target().encode());
            let position = item.position;
            (exclusion, item, position, key)
        })
        .collect::<Vec<_>>();
    ordered.sort_by(|left, right| left.2.cmp(&right.2).then_with(|| left.3.cmp(&right.3)));
    let mut exclusions = ordered
        .into_iter()
        .map(|(exclusion, item, _, key)| {
            ValidatedExclusion::Local(Box::new(ValidatedLocalExclusion {
                exclusion,
                target_key: key,
                dependency_group: item.dependency_group.clone(),
            }))
        })
        .collect::<Vec<_>>();
    exclusions.extend(
        derive_provider_rebase(
            &input.evidence.provider_links,
            &input.evidence.covered_through,
        )
        .into_iter()
        .map(ValidatedExclusion::ProviderRebase),
    );
    Ok(Manifest {
        base_context_revision: input.candidate.base_context_revision,
        covered_through: input.candidate.covered_through.clone(),
        protected_state: candidate_protected,
        exclusions,
        summary: summarized.summary,
        remote: None,
        remote_item: None,
        input_tokens,
        retained_tokens,
    })
}

struct IndexedEvidence<'a> {
    items: std::collections::HashMap<String, &'a ContextItem>,
    settlements: std::collections::HashMap<String, &'a SettlementEvidence>,
    authorities: std::collections::HashMap<String, &'a AuthorityEvidence>,
    tool_results: std::collections::HashMap<String, &'a ToolResultEvidence>,
    boundary_position: Option<i64>,
}

fn index_evidence<'a>(
    evidence: &'a RuntimeEvidence,
    issues: &mut Vec<Issue>,
) -> IndexedEvidence<'a> {
    let mut items = std::collections::HashMap::new();
    for (index, item) in evidence.items.iter().enumerate() {
        if item.position < 0 || item.terminal_seq < 0 {
            add_issue(
                issues,
                IssueCode::InvalidRuntimeEvidence,
                "Context item ordering evidence must be non-negative integers",
            );
        }
        if let Some(previous) = index
            .checked_sub(1)
            .and_then(|prior| evidence.items.get(prior))
            && (previous.position >= item.position || previous.terminal_seq > item.terminal_seq)
        {
            add_issue(
                issues,
                IssueCode::NonChronologicalLowering,
                "Runtime context items are not in canonical chronological order",
            );
        }
        let identity = item_identity(item);
        if items.contains_key(&identity) {
            add_issue(
                issues,
                IssueCode::InvalidRuntimeEvidence,
                &format!("Runtime item {identity} appears more than once"),
            );
        }
        items.insert(identity, item);
    }
    let mut settlements = std::collections::HashMap::new();
    for value in &evidence.settlements {
        let key = match value {
            SettlementEvidence::Running { execution_group }
            | SettlementEvidence::Terminal {
                execution_group, ..
            } => execution_group.clone(),
        };
        if settlements.contains_key(&key) {
            add_issue(
                issues,
                IssueCode::InvalidRuntimeEvidence,
                &format!("Runtime settlement {key} appears more than once"),
            );
        }
        settlements.insert(key, value);
    }
    let mut authorities = std::collections::HashMap::new();
    for value in &evidence.authorities {
        let key = selector_identity(&value.selector);
        if authorities.contains_key(&key) {
            add_issue(
                issues,
                IssueCode::InvalidRuntimeEvidence,
                &format!("Runtime authority {key} appears more than once"),
            );
        }
        authorities.insert(key, value);
    }
    let mut tool_results = std::collections::HashMap::new();
    for value in &evidence.tool_results {
        let key = selector_identity(&value.selector);
        if tool_results.contains_key(&key) {
            add_issue(
                issues,
                IssueCode::InvalidRuntimeEvidence,
                &format!("Runtime tool result {key} appears more than once"),
            );
        }
        tool_results.insert(key, value);
    }
    let mut boundary_position = None;
    let mut found = false;
    for item in &evidence.items {
        if item.message_id == evidence.covered_through.message_id
            && item.terminal_seq <= evidence.covered_through.seq.get()
        {
            found = true;
            boundary_position = Some(boundary_position.unwrap_or(0).max(item.position));
        }
    }
    if !found {
        add_issue(
            issues,
            IssueCode::CoveredBoundaryChanged,
            "The covered complete-message boundary is absent from runtime evidence",
        );
    }
    IndexedEvidence {
        items,
        settlements,
        authorities,
        tool_results,
        boundary_position,
    }
}

struct Summarized {
    summary: Option<RollingSummary>,
    items: Vec<ContextItem>,
}

fn validate_summary(
    summary: Option<&RollingSummary>,
    evidence: &RuntimeEvidence,
    indexed: &IndexedEvidence,
    recent_tail: &std::collections::HashSet<String>,
    protected_targets: &std::collections::HashSet<String>,
    issues: &mut Vec<Issue>,
) -> Summarized {
    let empty = Summarized {
        summary: None,
        items: Vec::new(),
    };
    let Some(summary) = summary else { return empty };
    if summary.text.as_str().is_none_or(str::is_empty) {
        add_issue(
            issues,
            IssueCode::InvalidRuntimeEvidence,
            "The rolling summary metadata is invalid",
        );
        return Summarized {
            summary: None,
            items: Vec::new(),
        };
    }
    let Some(boundary) = resolve_selector(&summary_selector(summary), indexed, issues) else {
        return Summarized {
            summary: None,
            items: Vec::new(),
        };
    };
    if boundary.terminal_seq != summary.covered_through.seq.get() {
        add_issue(
            issues,
            IssueCode::SelectorMismatch,
            "The rolling summary boundary sequence does not match canonical history",
        );
    }
    validate_item_boundary(
        boundary,
        indexed.boundary_position,
        &evidence.covered_through,
        true,
        issues,
    );
    let items = evidence
        .items
        .iter()
        .filter(|item| item.position <= boundary.position)
        .cloned()
        .collect::<Vec<_>>();
    for item in &items {
        let identity = item_identity(item);
        if recent_tail.contains(&identity) {
            add_issue(
                issues,
                IssueCode::ProtectedRecentTail,
                &format!("Summary target {identity} belongs to the protected recent tail"),
            );
        }
        if protected_targets.contains(&identity) {
            add_issue(
                issues,
                IssueCode::ProtectedTarget,
                &format!("Summary target {identity} is protected live state"),
            );
        }
    }
    Summarized {
        summary: Some(summary.clone()),
        items,
    }
}

fn resolve_selector<'a>(
    target: &TargetSelector,
    indexed: &IndexedEvidence<'a>,
    issues: &mut Vec<Issue>,
) -> Option<&'a ContextItem> {
    let identity = selector_identity(target);
    let mut mismatch = || {
        add_issue(
            issues,
            IssueCode::SelectorMismatch,
            &format!("Selector {identity} does not match canonical runtime content"),
        );
    };
    let Some(item) = indexed.items.get(&identity) else {
        mismatch();
        return None;
    };
    if selector(item) != *target {
        mismatch();
    }
    Some(item)
}

fn validate_item_boundary(
    item: &ContextItem,
    boundary_position: Option<i64>,
    boundary: &CoveredThrough,
    is_target: bool,
    issues: &mut Vec<Issue>,
) {
    if item.terminal_seq <= boundary.seq.get()
        && boundary_position.is_none_or(|position| item.position <= position)
    {
        return;
    }
    let identity = item_identity(item);
    if is_target {
        add_issue(
            issues,
            IssueCode::TargetAfterBoundary,
            &format!("target {identity} falls after the covered complete-message boundary"),
        );
    } else {
        add_issue(
            issues,
            IssueCode::EvidenceAfterBoundary,
            &format!("evidence {identity} falls after the covered complete-message boundary"),
        );
    }
}

fn validate_part_settlement(
    item: &ContextItem,
    indexed: &IndexedEvidence,
    issues: &mut Vec<Issue>,
) {
    if item.kind != ContextItemKind::Part {
        return;
    }
    if !matches!(
        indexed.settlements.get(&item.execution_group),
        Some(SettlementEvidence::Terminal { .. })
    ) {
        add_issue(
            issues,
            IssueCode::PartUnsettled,
            &format!("Part {} belongs to a nonterminal Step", item_identity(item)),
        );
    }
}

fn validate_reason(
    exclusion: &Exclusion,
    target: &ContextItem,
    input: &ValidationInput,
    indexed: &IndexedEvidence,
    target_identities: &std::collections::HashSet<String>,
    issues: &mut Vec<Issue>,
) {
    if let Exclusion::TerminalIntermediate {
        terminal_event_id, ..
    } = exclusion
    {
        validate_terminal_intermediate(target, indexed, terminal_event_id, issues);
        return;
    }
    let evidence_selector = match exclusion {
        Exclusion::ExactDuplicate { evidence, .. }
        | Exclusion::SupersededAuthority { evidence, .. }
        | Exclusion::StaleToolResult { evidence, .. } => evidence,
        Exclusion::TerminalIntermediate { .. } => unreachable!("handled above"),
    };
    let Some(retained) = resolve_selector(evidence_selector, indexed, issues) else {
        return;
    };
    validate_item_boundary(
        retained,
        indexed.boundary_position,
        &input.evidence.covered_through,
        false,
        issues,
    );
    validate_part_settlement(retained, indexed, issues);
    if retained.position <= target.position {
        let code = match exclusion {
            Exclusion::ExactDuplicate { .. } => IssueCode::InvalidExactDuplicate,
            Exclusion::SupersededAuthority { .. } => IssueCode::InvalidSupersededAuthority,
            Exclusion::StaleToolResult { .. } => IssueCode::InvalidStaleToolResult,
            Exclusion::TerminalIntermediate { .. } => IssueCode::InvalidTerminalIntermediate,
        };
        add_issue(
            issues,
            code,
            &format!(
                "{} evidence must be chronologically later than its target",
                exclusion.reason()
            ),
        );
    }
    if target_identities.contains(&selector_identity(evidence_selector)) {
        add_issue(
            issues,
            IssueCode::EvidenceExcluded,
            "Predicate evidence must remain in the active context",
        );
    }
    match exclusion {
        Exclusion::ExactDuplicate { .. } => {
            if target.input_kind != retained.input_kind
                || payload_digest(&target.payload) != payload_digest(&retained.payload)
                || item_identity(target) == item_identity(retained)
            {
                add_issue(
                    issues,
                    IssueCode::InvalidExactDuplicate,
                    "Exact-duplicate evidence must be a later retained item with the same lowerer kind and payload digest",
                );
            }
        }
        Exclusion::SupersededAuthority {
            authority_kind,
            authority_key,
            target_revision,
            evidence_revision,
            ..
        } => validate_superseded_authority(
            &PredicateEvidence {
                target,
                retained,
                evidence: &input.evidence,
                indexed,
                name: authority_kind.as_str().unwrap_or_default(),
                key: authority_key.as_str().unwrap_or_default(),
                target_revision: target_revision.get(),
                evidence_revision: evidence_revision.get(),
            },
            &mut *issues,
        ),
        Exclusion::StaleToolResult {
            tool,
            resource_key,
            target_revision,
            evidence_revision,
            ..
        } => validate_stale_tool_result(
            &PredicateEvidence {
                target,
                retained,
                evidence: &input.evidence,
                indexed,
                name: tool.as_str().unwrap_or_default(),
                key: resource_key.as_str().unwrap_or_default(),
                target_revision: target_revision.get(),
                evidence_revision: evidence_revision.get(),
            },
            &mut *issues,
        ),
        Exclusion::TerminalIntermediate { .. } => {}
    }
}

struct PredicateEvidence<'a> {
    target: &'a ContextItem,
    retained: &'a ContextItem,
    evidence: &'a RuntimeEvidence,
    indexed: &'a IndexedEvidence<'a>,
    name: &'a str,
    key: &'a str,
    target_revision: i64,
    evidence_revision: i64,
}

fn validate_superseded_authority(check: &PredicateEvidence, issues: &mut Vec<Issue>) {
    let target_fact = check.indexed.authorities.get(&item_identity(check.target));
    let retained_fact = check
        .indexed
        .authorities
        .get(&item_identity(check.retained));
    let declared = match target_fact.and_then(|fact| fact.tool.as_deref()) {
        None => matches!(
            check.name,
            "instructions"
                | "todos"
                | "goals"
                | "autonomy"
                | "permissions"
                | "guardrails"
                | "project_artifacts"
        ),
        Some(tool) => check
            .evidence
            .resource_authorities
            .iter()
            .any(|entry| entry.tool == tool && entry.authority_kind == check.name),
    };
    let tool_matches = target_fact.and_then(|fact| fact.tool.as_deref())
        == retained_fact.and_then(|fact| fact.tool.as_deref());
    let valid = target_fact.is_some()
        && retained_fact.is_some()
        && declared
        && target_fact.is_some_and(|fact| fact.authority_kind == check.name)
        && retained_fact.is_some_and(|fact| fact.authority_kind == check.name)
        && target_fact.is_some_and(|fact| fact.authority_key == check.key)
        && retained_fact.is_some_and(|fact| fact.authority_key == check.key)
        && target_fact.is_some_and(|fact| fact.revision == check.target_revision)
        && retained_fact.is_some_and(|fact| fact.revision == check.evidence_revision)
        && check.evidence_revision > check.target_revision
        && tool_matches;
    if !valid {
        add_issue(
            issues,
            IssueCode::InvalidSupersededAuthority,
            "Authority evidence must match the declared kind/key and have a strictly greater durable revision",
        );
    }
}

fn validate_terminal_intermediate(
    target: &ContextItem,
    indexed: &IndexedEvidence,
    terminal_event_id: &LosslessString,
    issues: &mut Vec<Issue>,
) {
    if target.kind != ContextItemKind::Part || target.intermediate_kind.is_none() {
        add_issue(
            issues,
            IssueCode::InvalidTerminalIntermediate,
            "Terminal-intermediate targets must be allowlisted parts",
        );
        return;
    }
    let matched = indexed
        .settlements
        .get(&target.execution_group)
        .and_then(|settlement| match settlement {
            SettlementEvidence::Terminal {
                terminal_event_id: terminal,
                outcome,
                successful_tool_effect,
                file_change,
                ..
            } if terminal == terminal_event_id => {
                Some((*outcome, *successful_tool_effect, *file_change))
            }
            _ => None,
        });
    let Some((outcome, successful_tool_effect, file_change)) = matched else {
        add_issue(
            issues,
            IssueCode::InvalidTerminalIntermediate,
            "Terminal-intermediate evidence must be the exact terminal event for the target execution group",
        );
        return;
    };
    if target.intermediate_kind == Some(IntermediateKind::FailedPartialProviderOutput)
        && (outcome != SettlementOutcome::Failed || successful_tool_effect || file_change)
    {
        add_issue(
            issues,
            IssueCode::InvalidTerminalIntermediate,
            "Failed partial provider output is protected after a successful tool effect or file change",
        );
    }
}

fn validate_stale_tool_result(check: &PredicateEvidence, issues: &mut Vec<Issue>) {
    if !check
        .evidence
        .resource_authorities
        .iter()
        .any(|entry| entry.tool == check.name)
    {
        add_issue(
            issues,
            IssueCode::UndeclaredToolAuthority,
            &format!(
                "Tool {} does not declare a versioned resource authority",
                check.name
            ),
        );
    }
    let target_fact = check.indexed.tool_results.get(&item_identity(check.target));
    let retained_fact = check
        .indexed
        .tool_results
        .get(&item_identity(check.retained));
    let valid = target_fact.is_some_and(|fact| fact.status == SettlementOutcome::Succeeded)
        && retained_fact.is_some_and(|fact| fact.status == SettlementOutcome::Succeeded)
        && target_fact.is_some_and(|fact| fact.tool == check.name)
        && retained_fact.is_some_and(|fact| fact.tool == check.name)
        && target_fact.is_some_and(|fact| fact.resource_key == check.key)
        && retained_fact.is_some_and(|fact| fact.resource_key == check.key)
        && target_fact.is_some_and(|fact| fact.revision == check.target_revision)
        && retained_fact.is_some_and(|fact| fact.revision == check.evidence_revision)
        && check.evidence_revision > check.target_revision;
    if !valid {
        add_issue(
            issues,
            IssueCode::InvalidStaleToolResult,
            "Stale tool-result evidence must be successful, resource-identical, and strictly newer",
        );
    }
}

fn validate_evidence_retention(
    exclusions: &[Exclusion],
    targets: &std::collections::HashSet<String>,
    indexed: &IndexedEvidence,
    issues: &mut Vec<Issue>,
) {
    for exclusion in exclusions {
        let evidence_selector = match exclusion {
            Exclusion::ExactDuplicate { evidence, .. }
            | Exclusion::SupersededAuthority { evidence, .. }
            | Exclusion::StaleToolResult { evidence, .. } => evidence,
            Exclusion::TerminalIntermediate { .. } => continue,
        };
        let identity = selector_identity(evidence_selector);
        if targets.contains(&identity) {
            add_issue(
                issues,
                IssueCode::EvidenceExcluded,
                &format!("Evidence {identity} is also excluded"),
            );
        }
        if let Some(item) = indexed.items.get(&identity)
            && selector(item) != *evidence_selector
        {
            add_issue(
                issues,
                IssueCode::SelectorMismatch,
                &format!("Evidence selector {identity} does not match canonical runtime content"),
            );
        }
    }
}

fn validate_dependency_closure(
    items: &[ContextItem],
    targets: &std::collections::HashSet<String>,
    issues: &mut Vec<Issue>,
) {
    let mut groups: std::collections::HashMap<&str, Vec<&ContextItem>> =
        std::collections::HashMap::new();
    for item in items.iter().filter(|item| item.dependency_group.is_some()) {
        groups
            .entry(item.dependency_group.as_deref().expect("filtered present"))
            .or_default()
            .push(item);
    }
    for (group, members) in &groups {
        let excluded = members
            .iter()
            .filter(|item| targets.contains(&item_identity(item)))
            .count();
        if excluded > 0 && excluded != members.len() {
            add_issue(
                issues,
                IssueCode::DependencyClosure,
                &format!("Dependency group {group} is only partially excluded"),
            );
        }
    }
    let mut calls: std::collections::HashMap<&str, Vec<&ContextItem>> =
        std::collections::HashMap::new();
    for item in items.iter().filter(|item| item.tool_call.is_some()) {
        calls
            .entry(
                item.tool_call
                    .as_ref()
                    .expect("filtered present")
                    .call_id
                    .as_str(),
            )
            .or_default()
            .push(item);
    }
    for (call_id, members) in &calls {
        let excluded = members
            .iter()
            .filter(|item| targets.contains(&item_identity(item)))
            .count();
        let roles = members
            .iter()
            .filter_map(|item| item.tool_call.as_ref().map(|call| call.role))
            .collect::<std::collections::HashSet<_>>();
        if excluded > 0
            && (excluded != members.len()
                || !roles.contains(&ToolCallRole::Call)
                || !roles.contains(&ToolCallRole::Result))
        {
            add_issue(
                issues,
                IssueCode::DependencyClosure,
                &format!("Tool call {call_id} does not retain call/result closure"),
            );
        }
    }
}

fn valid_tokens(item: &ContextItem, issues: &mut Vec<Issue>) -> i64 {
    if item.tokens >= 0 {
        return item.tokens;
    }
    add_issue(
        issues,
        IssueCode::InvalidRuntimeEvidence,
        &format!(
            "Token count for {} is not a non-negative integer",
            item_identity(item)
        ),
    );
    0
}

fn derive_provider_rebase(
    links: &[ProviderLinkEvidence],
    boundary: &CoveredThrough,
) -> Vec<ProviderRebaseExclusion> {
    let mut selected = links
        .iter()
        .filter(|link| link.terminal_seq <= boundary.seq.get())
        .collect::<Vec<_>>();
    selected.sort_by(|left, right| {
        left.terminal_seq
            .cmp(&right.terminal_seq)
            .then_with(|| message_name(&left.message_id).cmp(&message_name(&right.message_id)))
            .then_with(|| left.ordinal.cmp(&right.ordinal))
            .then_with(|| left.part_kind.cmp(&right.part_kind))
            .then_with(|| {
                left.digest
                    .as_str()
                    .unwrap_or_default()
                    .cmp(right.digest.as_str().unwrap_or_default())
            })
    });
    let mut seen = std::collections::HashSet::new();
    let mut exclusions = Vec::new();
    for link in selected {
        let target = ProviderStateSelector {
            message_id: link.message_id.clone(),
            ordinal: NonNegativeInt::new(link.ordinal).expect("provider link ordinal is validated"),
            part_kind: link.part_kind.as_str().into(),
            digest: link.digest.clone(),
        };
        let key = target_key(&target.encode());
        if seen.insert(key.clone()) {
            exclusions.push(ProviderRebaseExclusion {
                target,
                target_key: key,
            });
        }
    }
    exclusions
}

fn normalize_protected_state(
    values: &[ProtectedStateEntry],
    issues: &mut Vec<Issue>,
) -> Vec<ProtectedStateEntry> {
    let mut seen = std::collections::HashSet::new();
    for value in values {
        if !seen.insert(value.source) {
            add_issue(
                issues,
                IssueCode::InvalidRuntimeEvidence,
                &format!(
                    "Protected-state source {} appears more than once",
                    value.source.as_str()
                ),
            );
        }
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|left, right| left.source.as_str().cmp(right.source.as_str()));
    sorted
}

fn same_boundary(left: &CoveredThrough, right: &CoveredThrough) -> bool {
    left.message_id == right.message_id && left.seq == right.seq
}

fn add_issue(issues: &mut Vec<Issue>, code: IssueCode, message: &str) {
    issues.push(Issue {
        code,
        message: message.into(),
    });
}

fn deduplicate_issues(issues: Vec<Issue>) -> Vec<Issue> {
    let mut seen = std::collections::HashSet::new();
    issues
        .into_iter()
        .filter(|issue| seen.insert((issue.code, issue.message.clone())))
        .collect()
}

fn encode_exclusion(exclusion: &ValidatedExclusion) -> JsonValue {
    match exclusion {
        ValidatedExclusion::Local(exclusion) => {
            let JsonValue::Object(mut base) = exclusion.exclusion.encode() else {
                unreachable!("exclusion encodes an object");
            };
            base.insert(
                LosslessString::from("targetKey"),
                JsonValue::String(LosslessString::from(exclusion.target_key.as_str())),
            );
            if let Some(group) = &exclusion.dependency_group {
                base.insert(
                    LosslessString::from("dependencyGroup"),
                    JsonValue::String(LosslessString::from(group.as_str())),
                );
            }
            JsonValue::Object(base)
        }
        ValidatedExclusion::ProviderRebase(exclusion) => ObjectEncoder::new()
            .field("reason", &LosslessString::from("provider_rebase"))
            .field("target", &exclusion.target)
            .field(
                "targetKey",
                &LosslessString::from(exclusion.target_key.as_str()),
            )
            .finish(),
    }
}

impl DomainEncode for Manifest {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("schemaVersion", &1.0)
            .field("baseContextRevision", &self.base_context_revision)
            .field("coveredThrough", &self.covered_through)
            .field(
                "protectedState",
                &JsonValue::Array(
                    self.protected_state
                        .iter()
                        .map(DomainEncode::encode)
                        .collect(),
                ),
            )
            .field(
                "exclusions",
                &JsonValue::Array(self.exclusions.iter().map(encode_exclusion).collect()),
            )
            .optional("summary", &self.summary)
            .optional("remote", &self.remote)
            .field("inputTokens", &(self.input_tokens as f64))
            .field("retainedTokens", &(self.retained_tokens as f64))
            .finish()
    }
}

fn nonnegative_field(
    object: &ObjectDecoder,
    path: &JsonPath,
    key: &str,
) -> Result<i64, DecodeError> {
    let value: f64 = object.field(key)?;
    if value < 0.0 || value.fract() != 0.0 {
        return Err(path
            .key(key)
            .error(DecodeErrorKind::Expected("non-negative integer")));
    }
    Ok(value as i64)
}

impl DomainDecode for Manifest {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let version: f64 = object.field("schemaVersion")?;
        if version != 1.0 {
            return Err(path
                .key("schemaVersion")
                .error(DecodeErrorKind::Expected("1")));
        }
        let exclusions = object.field::<Vec<JsonValue>>("exclusions")?;
        let mut decoded = Vec::with_capacity(exclusions.len());
        for (index, value) in exclusions.iter().enumerate() {
            decoded.push(decode_validated_exclusion(
                value,
                &path.key("exclusions").index(index),
            )?);
        }
        Ok(Self {
            base_context_revision: object.field("baseContextRevision")?,
            covered_through: object.field("coveredThrough")?,
            protected_state: object.field("protectedState")?,
            exclusions: decoded,
            summary: object.optional("summary")?,
            remote: object.optional("remote")?,
            remote_item: None,
            input_tokens: nonnegative_field(&object, path, "inputTokens")?,
            retained_tokens: nonnegative_field(&object, path, "retainedTokens")?,
        })
    }
}

fn decode_validated_exclusion(
    value: &JsonValue,
    path: &JsonPath,
) -> Result<ValidatedExclusion, DecodeError> {
    let object = ObjectDecoder::new(value, path)?;
    let reason: LosslessString = object.field("reason")?;
    let target_key: LosslessString = object.field("targetKey")?;
    if target_key.as_str().is_none_or(|key| !digest_valid(key)) {
        return Err(path
            .key("targetKey")
            .error(DecodeErrorKind::Expected("64 lowercase hex digits")));
    }
    let key = target_key.as_str().expect("validated digest").to_string();
    match reason.as_str() {
        Some("provider_rebase") => Ok(ValidatedExclusion::ProviderRebase(
            ProviderRebaseExclusion {
                target: object.field("target")?,
                target_key: key,
            },
        )),
        Some(_) => {
            let exclusion = decode_exclusion(value, path, &["targetKey", "dependencyGroup"])?;
            let dependency_group: Option<LosslessString> = object.optional("dependencyGroup")?;
            Ok(ValidatedExclusion::Local(Box::new(
                ValidatedLocalExclusion {
                    exclusion,
                    target_key: key,
                    dependency_group: dependency_group
                        .and_then(|group| group.as_str().map(str::to_string)),
                },
            )))
        }
        None => Err(path
            .key("reason")
            .error(DecodeErrorKind::Expected("exclusion reason"))),
    }
}

pub fn manifest_json(manifest: &Manifest) -> String {
    canonical_json(&manifest.encode())
}

pub fn manifest_digest(manifest: &Manifest) -> String {
    sha256(&manifest_json(manifest))
}

#[derive(Clone, Debug, PartialEq)]
pub struct PackCandidate {
    pub dependency_group: String,
    pub order: i64,
    pub tokens: i64,
    pub content: JsonValue,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PackInput {
    pub candidates: Vec<PackCandidate>,
    pub max_input_tokens: i64,
    pub fixed_input_tokens: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PackedBatch {
    pub candidates: Vec<PackCandidate>,
    pub input_tokens: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PackError {
    pub message: String,
}

pub fn pack_candidates(input: &PackInput) -> Result<Vec<PackedBatch>, PackError> {
    let error = |message: String| PackError { message };
    if input.max_input_tokens <= 0 {
        return Err(error("maxInputTokens must be a positive integer".into()));
    }
    if input.fixed_input_tokens < 0 || input.fixed_input_tokens > input.max_input_tokens {
        return Err(error(
            "fixedInputTokens must fit the selected model budget".into(),
        ));
    }
    for candidate in &input.candidates {
        if candidate.dependency_group.is_empty() {
            return Err(error(
                "Every pack candidate must name a dependency group".into(),
            ));
        }
        if candidate.order < 0 {
            return Err(error(
                "Pack candidate order must be a non-negative integer".into(),
            ));
        }
        if candidate.tokens < 0 {
            return Err(error(
                "Pack candidate tokens must be a non-negative integer".into(),
            ));
        }
    }
    let mut grouped: std::collections::HashMap<String, Vec<PackCandidate>> =
        std::collections::HashMap::new();
    for candidate in &input.candidates {
        grouped
            .entry(candidate.dependency_group.clone())
            .or_default()
            .push(candidate.clone());
    }
    let mut groups = grouped
        .into_iter()
        .map(|(dependency_group, mut candidates)| {
            candidates.sort_by(|left, right| {
                left.order.cmp(&right.order).then_with(|| {
                    canonical_json(&left.content).cmp(&canonical_json(&right.content))
                })
            });
            let order = candidates
                .iter()
                .map(|candidate| candidate.order)
                .min()
                .unwrap_or(0);
            let tokens: i64 = candidates.iter().map(|candidate| candidate.tokens).sum();
            (dependency_group, candidates, order, tokens)
        })
        .collect::<Vec<_>>();
    groups.sort_by(|left, right| left.2.cmp(&right.2).then_with(|| left.0.cmp(&right.0)));
    for (dependency_group, _, _, tokens) in &groups {
        if input.fixed_input_tokens + tokens > input.max_input_tokens {
            return Err(error(format!(
                "dependency group {dependency_group} exceeds the selected model budget"
            )));
        }
    }
    let mut batches = Vec::new();
    for (_, candidates, _, tokens) in groups {
        let fits = batches.last().is_some_and(|batch: &PackedBatch| {
            batch.input_tokens + tokens <= input.max_input_tokens
        });
        if fits {
            let batch = batches.last_mut().expect("checked present");
            batch.candidates.extend(candidates);
            batch.input_tokens += tokens;
            continue;
        }
        batches.push(PackedBatch {
            candidates,
            input_tokens: input.fixed_input_tokens + tokens,
        });
    }
    Ok(batches)
}

pub fn parse_manifest(value: &JsonValue) -> Result<Manifest, DecodeError> {
    Manifest::decode(value)
}
