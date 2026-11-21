use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder, mcp_events,
    schema::{Int, NonNegativeInt, PositiveInt},
    session_id::SessionId,
    session_message_id::Id as MessageId,
};

macro_rules! text {
    ($name:ident, $max:expr, $display:expr) => {
        #[derive(Clone, Debug, PartialEq, Eq)]
        pub struct $name(pub LosslessString);
        impl DomainDecode for $name {
            fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
                let value = LosslessString::decode_at(value, path)?;
                if value.is_empty()
                    || value.len() > $max
                    || ($display
                        && value
                            .code_units()
                            .any(|unit| unit <= 31 || (127..=159).contains(&unit)))
                {
                    return Err(path.error(DecodeErrorKind::Expected("bounded nonempty text")));
                }
                Ok(Self(value))
            }
        }
        impl DomainEncode for $name {
            fn encode(&self) -> JsonValue {
                self.0.encode()
            }
        }
    };
}
text!(Identity, usize::MAX, false);
text!(DeviceIdentity, 256, false);
text!(DisplayName, 256, true);
text!(DisplayMessage, 500, true);
text!(RejectionLabel, 128, true);
text!(RejectionMessage, 1000, true);
crate::schema::record_type!(Rejection {} { code: Int => "code", error_code: RejectionLabel => "errorCode", error_type: RejectionLabel => "errorType", message: RejectionMessage => "message" });

pub(crate) fn strict(
    value: &JsonValue,
    path: &JsonPath,
    allowed: &[&str],
) -> Result<(), DecodeError> {
    let JsonValue::Object(object) = value else {
        return Err(path.error(DecodeErrorKind::Expected("object")));
    };
    for (key, _) in object.iter() {
        if !allowed
            .iter()
            .any(|name| key == &LosslessString::from(*name))
        {
            return Err(path
                .key(key.clone())
                .error(DecodeErrorKind::Expected("no excess property")));
        }
    }
    Ok(())
}

crate::schema::record_type!(Access { enabled: bool => "enabled", revision: NonNegativeInt => "revision" } {});
#[derive(Clone, Debug, PartialEq)]
pub struct AccessSet {
    pub enabled: bool,
    pub expected_revision: NonNegativeInt,
}
impl DomainDecode for AccessSet {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        strict(value, path, &["enabled", "expectedRevision"])?;
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            enabled: object.field("enabled")?,
            expected_revision: object.field("expectedRevision")?,
        })
    }
}
impl DomainEncode for AccessSet {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("enabled", &self.enabled)
            .field("expectedRevision", &self.expected_revision)
            .finish()
    }
}
crate::schema::literal_enum_type!(ConnectionState, { Unavailable => "unavailable", Off => "off", Connecting => "connecting", Connected => "connected", Error => "error" });
crate::schema::record_type!(Configuration { ready: bool => "ready" } { profile: DisplayName => "profile", message: DisplayMessage => "message" });
crate::schema::record_type!(Connection { state: ConnectionState => "state" } { hostname: DisplayName => "hostname", name: DisplayName => "name", message: DisplayMessage => "message" });
crate::schema::literal_enum_type!(ComputerState, { Attached => "attached", Detached => "detached", Unavailable => "unavailable", Removed => "removed" });
crate::schema::literal_enum_type!(ComputerReadiness, { Connected => "connected", Offline => "offline", Unknown => "unknown" });
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusIdentifier(pub LosslessString);
impl DomainDecode for StatusIdentifier {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let value = LosslessString::decode_at(value, path)?;
        let valid = value.len() <= 64
            && value.code_units().enumerate().all(|(index, unit)| {
                let lower = (97..=122).contains(&unit);
                if index == 0 {
                    lower
                } else {
                    lower || (48..=57).contains(&unit) || unit == 95 || unit == 45
                }
            })
            && !value.is_empty();
        if !valid {
            return Err(path.error(DecodeErrorKind::Expected("status identifier")));
        }
        Ok(Self(value))
    }
}
impl DomainEncode for StatusIdentifier {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
crate::schema::record_type!(DotEnvironmentCapability { kind: StatusIdentifier => "type", status: StatusIdentifier => "status" } {});
const MAX_ENVIRONMENT_CAPABILITIES: usize = 16;
#[derive(Clone, Debug, PartialEq)]
pub struct DotEnvironment {
    pub status: StatusIdentifier,
    pub capabilities: Vec<DotEnvironmentCapability>,
}
impl DomainDecode for DotEnvironment {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let capabilities: Vec<DotEnvironmentCapability> = object.field("capabilities")?;
        if capabilities.len() > MAX_ENVIRONMENT_CAPABILITIES {
            return Err(path
                .key("capabilities")
                .error(DecodeErrorKind::Expected("at most 16 capabilities")));
        }
        Ok(Self {
            status: object.field("status")?,
            capabilities,
        })
    }
}
impl DomainEncode for DotEnvironment {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("status", &self.status)
            .field("capabilities", &self.capabilities)
            .finish()
    }
}
text!(ComputerIdentity, 256, false);
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComputerRevision(pub LosslessString);
impl DomainDecode for ComputerRevision {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let value = LosslessString::decode_at(value, path)?;
        if value.len() != 64
            || !value
                .code_units()
                .all(|unit| (48..=57).contains(&unit) || (97..=102).contains(&unit))
        {
            return Err(path.error(DecodeErrorKind::Expected("lowercase SHA-256 hex digest")));
        }
        Ok(Self(value))
    }
}
impl DomainEncode for ComputerRevision {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComputerTarget {
    pub dot_id: ComputerIdentity,
    pub thread_id: ComputerIdentity,
    pub environment_id: ComputerIdentity,
    pub revision: ComputerRevision,
}
impl DomainDecode for ComputerTarget {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        strict(
            value,
            path,
            &["dotID", "threadID", "environmentID", "revision"],
        )?;
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            dot_id: object.field("dotID")?,
            thread_id: object.field("threadID")?,
            environment_id: object.field("environmentID")?,
            revision: object.field("revision")?,
        })
    }
}
impl DomainEncode for ComputerTarget {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("dotID", &self.dot_id)
            .field("threadID", &self.thread_id)
            .field("environmentID", &self.environment_id)
            .field("revision", &self.revision)
            .finish()
    }
}
crate::schema::record_type!(Computer { state: ComputerState => "state" } { name: DisplayName => "name", target: ComputerTarget => "target", readiness: ComputerReadiness => "readiness", usable_for_tasks: bool => "usableForTasks", dot_environment: DotEnvironment => "dotEnvironment", message: DisplayMessage => "message" });
crate::schema::record_type!(NativeStatus { access: Access => "access", configuration: Configuration => "configuration", connection: Connection => "connection" } { computer: Computer => "computer" });
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComputerAttach {
    pub replace_others: bool,
    pub expected_target: Option<ComputerTarget>,
}
impl DomainDecode for ComputerAttach {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        strict(value, path, &["replaceOthers", "expectedTarget"])?;
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            replace_others: object.field("replaceOthers")?,
            expected_target: object.optional("expectedTarget")?,
        })
    }
}
impl DomainEncode for ComputerAttach {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("replaceOthers", &self.replace_others)
            .optional("expectedTarget", &self.expected_target)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComputerDetach {
    pub expected_target: Option<ComputerTarget>,
}
impl DomainDecode for ComputerDetach {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        strict(value, path, &["expectedTarget"])?;
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            expected_target: object.optional("expectedTarget")?,
        })
    }
}
impl DomainEncode for ComputerDetach {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("expectedTarget", &self.expected_target)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComputerRemove {
    pub expected_target: Option<ComputerTarget>,
}
impl DomainDecode for ComputerRemove {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        strict(value, path, &["expectedTarget"])?;
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            expected_target: object.optional("expectedTarget")?,
        })
    }
}
impl DomainEncode for ComputerRemove {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("expectedTarget", &self.expected_target)
            .finish()
    }
}
crate::schema::record_type!(Target { profile: Identity => "profile", dot_id: Identity => "dotID", thread_id: Identity => "threadID", generation: Identity => "generation", label: LosslessString => "label" } {});
crate::schema::record_type!(DelegationRef { id: Identity => "id", revision: PositiveInt => "revision" } {});
crate::schema::record_type!(RoutineReceipt { delegation: DelegationRef => "delegation", task_input_id: MessageId => "taskInputID", instruction: RoutineInstruction => "instruction" } {});

#[derive(Clone, Debug, PartialEq)]
pub enum RoutineInstruction {
    Continue,
    Presentation {
        format: Option<LosslessString>,
        detail: Option<LosslessString>,
    },
}
impl DomainDecode for RoutineInstruction {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        match object.field::<LosslessString>("operation")?.as_str() {
            Some("continue") => {
                strict(value, path, &["operation"])?;
                Ok(Self::Continue)
            }
            Some("presentation") => {
                strict(value, path, &["operation", "preferences"])?;
                let raw: JsonValue = object.field("preferences")?;
                let preferences_path = path.key("preferences");
                let preferences = ObjectDecoder::new(&raw, &preferences_path)?;
                let format = preferences.optional::<LosslessString>("format")?;
                let detail = preferences.optional::<LosslessString>("detail")?;
                if format.is_none() && detail.is_none() {
                    return Err(preferences_path
                        .error(DecodeErrorKind::Expected("presentation preference")));
                }
                if let Some(value) = &format {
                    crate::domain::literal_enum(
                        &value.encode(),
                        &["prose", "bullets"],
                        &preferences_path.key("format"),
                    )?;
                }
                if let Some(value) = &detail {
                    crate::domain::literal_enum(
                        &value.encode(),
                        &["concise", "standard", "detailed"],
                        &preferences_path.key("detail"),
                    )?;
                }
                Ok(Self::Presentation { format, detail })
            }
            _ => Err(path
                .key("operation")
                .error(DecodeErrorKind::Expected("routine operation"))),
        }
    }
}
impl DomainEncode for RoutineInstruction {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Continue => ObjectEncoder::new().field("operation", "continue").finish(),
            Self::Presentation { format, detail } => ObjectEncoder::new()
                .field("operation", "presentation")
                .field(
                    "preferences",
                    &ObjectEncoder::new()
                        .optional("format", format)
                        .optional("detail", detail)
                        .finish(),
                )
                .finish(),
        }
    }
}

crate::schema::record_type!(EnvelopeScope { epoch: Identity => "epoch", grant_id: Identity => "grantID" } {});
crate::schema::record_type!(TaskEnvelopeFields { coordinator: mcp_events::ContextPrincipal => "coordinator", scope: EnvelopeScope => "scope", exchange_id: DeviceIdentity => "exchangeID", message_id: MessageId => "messageID", target_session_id: SessionId => "targetSessionID" } {});
#[derive(Clone, Debug, PartialEq)]
pub struct TaskEnvelope(pub TaskEnvelopeFields);
impl DomainDecode for TaskEnvelope {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        object.literal("kind", &"task".encode())?;
        object.literal("origin", &"plugin".encode())?;
        TaskEnvelopeFields::decode_at(value, path).map(Self)
    }
}
impl DomainEncode for TaskEnvelope {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("coordinator", &self.0.coordinator)
            .field("scope", &self.0.scope)
            .field("exchangeID", &self.0.exchange_id)
            .field("messageID", &self.0.message_id)
            .field("kind", "task")
            .field("origin", "plugin")
            .field("targetSessionID", &self.0.target_session_id)
            .finish()
    }
}
crate::schema::literal_enum_type!(ReportKind, { Progress => "progress", Blocker => "blocker", DecisionRequest => "decision_request", Completion => "completion" });
crate::schema::record_type!(ReportEnvelopeFields { coordinator: mcp_events::ContextPrincipal => "coordinator", scope: EnvelopeScope => "scope", exchange_id: DeviceIdentity => "exchangeID", message_id: MessageId => "messageID", kind: ReportKind => "kind", source_session_id: SessionId => "sourceSessionID", reply_to_message_id: MessageId => "replyToMessageID" } {});
#[derive(Clone, Debug, PartialEq)]
pub struct ReportEnvelope(pub ReportEnvelopeFields);
impl DomainDecode for ReportEnvelope {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        ObjectDecoder::new(value, path)?.literal("origin", &"agent".encode())?;
        ReportEnvelopeFields::decode_at(value, path).map(Self)
    }
}
impl DomainEncode for ReportEnvelope {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("coordinator", &self.0.coordinator)
            .field("scope", &self.0.scope)
            .field("exchangeID", &self.0.exchange_id)
            .field("messageID", &self.0.message_id)
            .field("kind", &self.0.kind)
            .field("origin", "agent")
            .field("sourceSessionID", &self.0.source_session_id)
            .field("replyToMessageID", &self.0.reply_to_message_id)
            .finish()
    }
}
crate::schema::record_type!(ExchangeScope { root_session_id: SessionId => "rootSessionID" } { group_id: Identity => "groupID", owner_session_id: SessionId => "ownerSessionID" });
crate::schema::record_type!(ExchangeRecord {
    exchange_id: DeviceIdentity => "exchangeID", session_id: SessionId => "sessionID", target_session_id: SessionId => "targetSessionID",
    input_id: MessageId => "inputID", expected_attachment: Target => "expectedAttachment", account_digest: Identity => "accountDigest",
    fingerprint: Identity => "fingerprint", source: mcp_events::RequestContext => "source", grant_id: Identity => "grantID", scope: ExchangeScope => "scope",
} { routine: RoutineReceipt => "routine", delegated: DelegatedReceipt => "delegated" });
crate::schema::record_type!(ExchangeOutput { delivery_id: Identity => "deliveryID", message_id: MessageId => "messageID", text: LosslessString => "text", envelope: ReportEnvelope => "envelope" } {});
crate::schema::record_type!(BindingRecord { id: DeviceIdentity => "id", target: Target => "target", account_digest: Identity => "accountDigest" } {});

#[derive(Clone, Debug, PartialEq)]
pub struct DecisionTarget(pub crate::JsonObject);
impl DomainDecode for DecisionTarget {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let kind: LosslessString = object.field("kind")?;
        let fingerprint: LosslessString = object.field("fingerprint")?;
        if fingerprint.len() != 64
            || !fingerprint
                .code_units()
                .all(|unit| matches!(unit, 48..=57 | 97..=102))
        {
            return Err(path
                .key("fingerprint")
                .error(DecodeErrorKind::Expected("lowercase SHA-256 digest")));
        }
        let (key, id) = match kind.as_str() {
            Some("permission") => (
                "requestID",
                object.field::<crate::permission::Id>("requestID")?.encode(),
            ),
            Some("guardrail") => (
                "requestID",
                object
                    .field::<crate::guardrail::RequestId>("requestID")?
                    .encode(),
            ),
            Some("form") => (
                "formID",
                object.field::<crate::form::Id>("formID")?.encode(),
            ),
            Some("question") => (
                "requestID",
                object.field::<crate::question::Id>("requestID")?.encode(),
            ),
            Some("subagent_question") => (
                "questionID",
                object
                    .field::<crate::session_orchestration::QuestionId>("questionID")?
                    .encode(),
            ),
            Some("review") => (
                "itemID",
                object
                    .field::<crate::session_review::Id>("itemID")?
                    .encode(),
            ),
            _ => {
                return Err(path
                    .key("kind")
                    .error(DecodeErrorKind::Expected("decision target")));
            }
        };
        strict(value, path, &["kind", key, "fingerprint"])?;
        let JsonValue::Object(value) = ObjectEncoder::new()
            .field("kind", &kind)
            .field(key, &id)
            .field("fingerprint", &fingerprint)
            .finish()
        else {
            unreachable!()
        };
        Ok(Self(value))
    }
}
impl DomainEncode for DecisionTarget {
    fn encode(&self) -> JsonValue {
        JsonValue::Object(self.0.clone())
    }
}
crate::schema::record_type!(DelegatedReceipt { delegation: DelegationRef => "delegation", instruction: DelegatedInstruction => "instruction" } {});

#[derive(Clone, Debug, PartialEq)]
pub struct DelegatedInstruction(pub crate::JsonObject);
impl DomainDecode for DelegatedInstruction {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let operation = object.tag("operation", &["task", "decision"])?;
        let mut output = ObjectEncoder::new().field("operation", &operation);
        if operation.as_str() == Some("task") {
            strict(value, path, &["operation", "text"])?;
            let text: Identity = object.field("text")?;
            if text.0.len() > 32768 {
                return Err(path
                    .key("text")
                    .error(DecodeErrorKind::Expected("bounded task text")));
            }
            output = output.field("text", &text);
        } else {
            let target: DecisionTarget = object.field("target")?;
            let kind = target.0.get(&"kind".into()).and_then(|value| {
                if let JsonValue::String(value) = value {
                    value.as_str()
                } else {
                    None
                }
            });
            output = output.field("target", &target);
            match kind {
                Some("permission" | "guardrail") => {
                    strict(value, path, &["operation", "target", "reply"])?;
                    output = output.field("reply", &object.tag("reply", &["once", "reject"])?);
                }
                Some("form" | "question") => {
                    if let Some(cancelled) = object.optional::<bool>("cancelled")? {
                        strict(value, path, &["operation", "target", "cancelled"])?;
                        if !cancelled {
                            return Err(path
                                .key("cancelled")
                                .error(DecodeErrorKind::Expected("true")));
                        }
                        output = output.field("cancelled", &true);
                    } else {
                        strict(value, path, &["operation", "target", "answers"])?;
                        let answers = if kind == Some("form") {
                            object.field::<crate::form::Answer>("answers")?.encode()
                        } else {
                            object
                                .field::<Vec<crate::question::Answer>>("answers")?
                                .encode()
                        };
                        output = output.field("answers", &answers);
                    }
                }
                Some("subagent_question") => {
                    if let Some(dismissed) = object.optional::<bool>("dismissed")? {
                        strict(value, path, &["operation", "target", "dismissed"])?;
                        if !dismissed {
                            return Err(path
                                .key("dismissed")
                                .error(DecodeErrorKind::Expected("true")));
                        }
                        output = output.field("dismissed", &true);
                    } else {
                        strict(value, path, &["operation", "target", "text", "data"])?;
                        let text = object
                            .optional::<JsonValue>("text")?
                            .map(|value| {
                                crate::session_orchestration::bounded(
                                    &value,
                                    &path.key("text"),
                                    64 * 1024,
                                )
                            })
                            .transpose()?;
                        let data = object
                            .optional::<JsonValue>("data")?
                            .map(|value| {
                                crate::session_orchestration::answer_data(&value, &path.key("data"))
                            })
                            .transpose()?;
                        if text.is_none() && data.is_none() {
                            return Err(path.error(DecodeErrorKind::Expected("text or data")));
                        }
                        output = output.optional("text", &text).optional("data", &data);
                    }
                }
                Some("review") => {
                    strict(value, path, &["operation", "target", "decision"])?;
                    let decision: crate::session_review::Decision = object.field("decision")?;
                    let encoded = decision.encode();
                    if let JsonValue::Object(value) = &encoded
                        && value.get(&"reply".into()).is_some_and(|reply| {
                            reply != &"once".encode() && reply != &"reject".encode()
                        })
                    {
                        return Err(path
                            .key("decision")
                            .error(DecodeErrorKind::Expected("bounded delegated reply")));
                    }
                    output = output.field("decision", &decision);
                }
                _ => unreachable!(),
            }
        }
        let JsonValue::Object(object) = output.finish() else {
            unreachable!()
        };
        Ok(Self(object))
    }
}
impl DomainEncode for DelegatedInstruction {
    fn encode(&self) -> JsonValue {
        JsonValue::Object(self.0.clone())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DeviceDelegationScope {
    pub operations: Vec<LosslessString>,
}
impl DomainDecode for DeviceDelegationScope {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        strict(value, path, &["target", "operations"])?;
        let object = ObjectDecoder::new(value, path)?;
        object.literal("target", &"device".encode())?;
        let operations: Vec<LosslessString> = object.field("operations")?;
        if operations.is_empty()
            || operations.iter().enumerate().any(|(index, value)| {
                !matches!(value.as_str(), Some("task" | "decision"))
                    || operations[..index].contains(value)
            })
        {
            return Err(path
                .key("operations")
                .error(DecodeErrorKind::Expected("distinct delegated operations")));
        }
        Ok(Self { operations })
    }
}
impl DomainEncode for DeviceDelegationScope {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("target", "device")
            .field("operations", &self.operations)
            .finish()
    }
}
crate::schema::literal_enum_type!(DeviceBasis, { Device => "device" });
crate::schema::record_type!(DeviceDelegationInfo {
    id: Identity => "id", revision: PositiveInt => "revision", basis: DeviceBasis => "basis", anchor_session_id: SessionId => "anchorSessionID",
    binding_id: DeviceIdentity => "bindingID", principal: mcp_events::Principal => "principal", scope: DeviceDelegationScope => "scope", expires_at: PositiveInt => "expiresAt", active: bool => "active",
} {});

#[derive(Clone, Debug, PartialEq)]
pub struct CoordinationContext(pub crate::JsonObject);
impl DomainDecode for CoordinationContext {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let state = object.tag("state", &["enabled", "disabled"])?;
        let mut output = ObjectEncoder::new()
            .field("state", &state)
            .field("generation", &object.field::<PositiveInt>("generation")?)
            .optional("routine", &object.optional::<RoutineReceipt>("routine")?)
            .optional(
                "delegated",
                &object.optional::<DelegatedReceipt>("delegated")?,
            );
        if state.as_str() == Some("enabled") {
            object.literal("tool", &"dots_report".encode())?;
            output = output
                .field("tool", "dots_report")
                .field("envelope", &object.field::<TaskEnvelope>("envelope")?);
        } else {
            output = output.field(
                "reason",
                &object.tag(
                    "reason",
                    &[
                        "capability_disabled",
                        "no_task",
                        "task_settled",
                        "unavailable",
                        "tool_unavailable",
                    ],
                )?,
            );
        }
        let JsonValue::Object(object) = output.finish() else {
            unreachable!()
        };
        Ok(Self(object))
    }
}
impl DomainEncode for CoordinationContext {
    fn encode(&self) -> JsonValue {
        JsonValue::Object(self.0.clone())
    }
}

macro_rules! strict_type {
    ($name:ident($inner:ident), [$($key:literal),+]) => {
        #[derive(Clone, Debug, PartialEq)]
        pub struct $name(pub $inner);
        impl DomainDecode for $name {
            fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
                strict(value, path, &[$($key),+])?;
                $inner::decode_at(value, path).map(Self)
            }
        }
        impl DomainEncode for $name {
            fn encode(&self) -> JsonValue {
                self.0.encode()
            }
        }
    };
}

fn merged(base: JsonValue, extra: JsonValue) -> JsonValue {
    let (JsonValue::Object(mut base), JsonValue::Object(extra)) = (base, extra) else {
        unreachable!()
    };
    for (key, value) in extra.iter() {
        base.insert(key.clone(), value.clone());
    }
    JsonValue::Object(base)
}

fn non_empty<T: DomainDecode>(
    object: &ObjectDecoder<'_>,
    path: &JsonPath,
    key: &str,
) -> Result<Option<Vec<T>>, DecodeError> {
    let values = object.optional::<Vec<T>>(key)?;
    if values.as_ref().is_some_and(Vec::is_empty) {
        return Err(path
            .key(key)
            .error(DecodeErrorKind::Expected("non-empty array")));
    }
    Ok(values)
}

fn distinct<T: PartialEq>(values: &[T]) -> bool {
    values
        .iter()
        .enumerate()
        .all(|(index, value)| !values[..index].contains(value))
}

crate::schema::literal_enum_type!(State, { Disconnected => "disconnected", Connecting => "connecting", Connected => "connected", Failed => "failed" });
crate::schema::literal_enum_type!(RuntimeState, { Paused => "paused", Unpaused => "unpaused", Unknown => "unknown" });
crate::schema::literal_enum_type!(DeliveryStatus, { Accepted => "accepted", Unknown => "unknown" });
crate::schema::literal_enum_type!(ExchangeState, { Pending => "pending", Running => "running", Completed => "completed", Failed => "failed", Unknown => "unknown" });
crate::schema::literal_enum_type!(ErrorCode, {
    FeatureDisabled => "feature_disabled", InvalidInput => "invalid_input", SessionNotFound => "session_not_found",
    ProfileUnavailable => "profile_unavailable", ProfileChanged => "profile_changed", AuthenticationFailed => "authentication_failed",
    TargetUnavailable => "target_unavailable", TargetInUse => "target_in_use", TargetChanged => "target_changed", NotBound => "not_bound",
    ConnectionUnavailable => "connection_unavailable", AttachmentInvalid => "attachment_invalid", SendFailed => "send_failed",
    RuntimeUnknown => "runtime_unknown", ControlFailed => "control_failed", ExchangeConflict => "exchange_conflict",
    ExchangeNotFound => "exchange_not_found", TargetForbidden => "target_forbidden", AuthorizationFailed => "authorization_failed",
    ExchangeOutcomeUnknown => "exchange_outcome_unknown"
});
crate::schema::literal_enum_type!(Channel, { Task => "task" });
crate::schema::literal_enum_type!(DeliveryMode, { Steer => "steer", Queue => "queue" });
crate::schema::literal_enum_type!(PresentationFormat, { Prose => "prose", Bullets => "bullets" });
crate::schema::literal_enum_type!(PresentationDetail, { Concise => "concise", Standard => "standard", Detailed => "detailed" });
crate::schema::literal_enum_type!(RoutineOperation, { Continue => "continue", Presentation => "presentation" });
crate::schema::literal_enum_type!(SessionOperation, { Task => "task", Decision => "decision" });
crate::schema::literal_enum_type!(SessionBasis, { Session => "session" });
crate::schema::literal_enum_type!(ReviewKind, { DotsTaskDelegation => "dots-task-delegation" });
crate::schema::literal_enum_type!(ReviewLifetime, { Binding => "binding" });
crate::schema::literal_enum_type!(PeerOrigin, { DotsPeer => "dots-peer" });
crate::schema::literal_enum_type!(DecisionState, { Pending => "pending", Settled => "settled", Stale => "stale", Unknown => "unknown" });
crate::schema::literal_enum_type!(DelegatedReply, { Once => "once", Reject => "reject" });

#[derive(Clone, Debug, PartialEq)]
pub struct Status {
    pub enabled: bool,
    pub target: Option<Target>,
    pub state: State,
    pub error: Option<LosslessString>,
    pub runtime_state: Option<RuntimeState>,
}
impl DomainDecode for Status {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            enabled: object.field("enabled")?,
            target: object.optional("target")?,
            state: object.field("state")?,
            error: object.optional("error")?,
            runtime_state: object.optional("runtimeState")?,
        })
    }
}
impl DomainEncode for Status {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("enabled", &self.enabled)
            .optional("target", &self.target)
            .field("state", &self.state)
            .optional("error", &self.error)
            .optional("runtimeState", &self.runtime_state)
            .finish()
    }
}
crate::schema::record_type!(Control { expected_target: Target => "expectedTarget" } {});

#[derive(Clone, Debug, PartialEq)]
pub struct Send {
    pub id: Identity,
    pub text: LosslessString,
    pub files: Option<Vec<crate::prompt_input::FileAttachment>>,
    pub causal_message_id: Option<Identity>,
    pub expected_target: Target,
}
impl DomainDecode for Send {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            id: object.field("id")?,
            text: object.field("text")?,
            files: object.optional("files")?,
            causal_message_id: object.optional("causalMessageID")?,
            expected_target: object.field("expectedTarget")?,
        })
    }
}
impl DomainEncode for Send {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("text", &self.text)
            .optional("files", &self.files)
            .optional("causalMessageID", &self.causal_message_id)
            .field("expectedTarget", &self.expected_target)
            .finish()
    }
}
crate::schema::record_type!(Delivery { message_id: Identity => "messageID", status: DeliveryStatus => "status" } { turn_id: Identity => "turnID" });

#[derive(Clone, Debug, PartialEq)]
pub struct PresentationPreferences {
    pub format: Option<PresentationFormat>,
    pub detail: Option<PresentationDetail>,
}
impl DomainDecode for PresentationPreferences {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let preferences = Self {
            format: object.optional("format")?,
            detail: object.optional("detail")?,
        };
        if preferences.format.is_none() && preferences.detail.is_none() {
            return Err(path.error(DecodeErrorKind::Expected(
                "at least one presentation preference",
            )));
        }
        Ok(preferences)
    }
}
impl DomainEncode for PresentationPreferences {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("format", &self.format)
            .optional("detail", &self.detail)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DelegationScope {
    pub operations: Vec<RoutineOperation>,
    pub format: Option<Vec<PresentationFormat>>,
    pub detail: Option<Vec<PresentationDetail>>,
}
impl DomainDecode for DelegationScope {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let scope = Self {
            operations: non_empty(&object, path, "operations")?
                .ok_or_else(|| path.key("operations").error(DecodeErrorKind::Missing))?,
            format: non_empty(&object, path, "format")?,
            detail: non_empty(&object, path, "detail")?,
        };
        let presentation = scope.operations.contains(&RoutineOperation::Presentation);
        let values = scope.format.is_some() || scope.detail.is_some();
        if !distinct(&scope.operations) || (presentation != values) {
            return Err(path.error(DecodeErrorKind::Expected(
                "distinct operations and presentation values only with presentation admission",
            )));
        }
        Ok(scope)
    }
}
impl DomainEncode for DelegationScope {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("operations", &self.operations)
            .optional("format", &self.format)
            .optional("detail", &self.detail)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SessionDelegationScope {
    pub operations: Vec<SessionOperation>,
}
impl DomainDecode for SessionDelegationScope {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        strict(value, path, &["operations"])?;
        let object = ObjectDecoder::new(value, path)?;
        let operations: Vec<SessionOperation> = non_empty(&object, path, "operations")?
            .ok_or_else(|| path.key("operations").error(DecodeErrorKind::Missing))?;
        if !distinct(&operations) || !operations.contains(&SessionOperation::Task) {
            return Err(path.key("operations").error(DecodeErrorKind::Expected(
                "distinct operations including task",
            )));
        }
        Ok(Self { operations })
    }
}
impl DomainEncode for SessionDelegationScope {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("operations", &self.operations)
            .finish()
    }
}

crate::schema::record_type!(DelegationStatusInputFields { expected_attachment: Target => "expectedAttachment", target_session_id: SessionId => "targetSessionID" } {});
strict_type!(
    DelegationStatusInput(DelegationStatusInputFields),
    ["expectedAttachment", "targetSessionID"]
);
crate::schema::record_type!(RoutineDelegationCreateFields {
    expected_attachment: Target => "expectedAttachment", target_session_id: SessionId => "targetSessionID",
    proposal_id: DeviceIdentity => "proposalID", source_exchange_id: DeviceIdentity => "sourceExchangeID",
    task_input_id: MessageId => "taskInputID", scope: DelegationScope => "scope", expires_at: PositiveInt => "expiresAt",
} {});
strict_type!(
    RoutineDelegationCreate(RoutineDelegationCreateFields),
    [
        "expectedAttachment",
        "targetSessionID",
        "proposalID",
        "sourceExchangeID",
        "taskInputID",
        "scope",
        "expiresAt"
    ]
);
crate::schema::record_type!(SessionDelegationCreateFields {
    expected_attachment: Target => "expectedAttachment", target_session_id: SessionId => "targetSessionID",
    proposal_id: DeviceIdentity => "proposalID", source_exchange_id: DeviceIdentity => "sourceExchangeID",
    basis: SessionBasis => "basis", scope: SessionDelegationScope => "scope", expires_at: PositiveInt => "expiresAt",
} {});
strict_type!(
    SessionDelegationCreate(SessionDelegationCreateFields),
    [
        "expectedAttachment",
        "targetSessionID",
        "proposalID",
        "sourceExchangeID",
        "basis",
        "scope",
        "expiresAt"
    ]
);
#[derive(Clone, Debug, PartialEq)]
pub enum DelegationCreate {
    Routine(RoutineDelegationCreate),
    Session(SessionDelegationCreate),
}
impl DomainDecode for DelegationCreate {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        RoutineDelegationCreate::decode_at(value, path)
            .map(Self::Routine)
            .or_else(|_| SessionDelegationCreate::decode_at(value, path).map(Self::Session))
    }
}
impl DomainEncode for DelegationCreate {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Routine(value) => value.encode(),
            Self::Session(value) => value.encode(),
        }
    }
}
crate::schema::record_type!(DelegationRevokeFields { id: Identity => "id", revision: PositiveInt => "revision", expected_attachment: Target => "expectedAttachment" } {});
strict_type!(
    DelegationRevoke(DelegationRevokeFields),
    ["id", "revision", "expectedAttachment"]
);
crate::schema::record_type!(RoutineDelegationInfo {
    id: Identity => "id", revision: PositiveInt => "revision", source_exchange_id: DeviceIdentity => "sourceExchangeID",
    target_session_id: SessionId => "targetSessionID", task_input_id: MessageId => "taskInputID",
    principal: mcp_events::Principal => "principal", scope: DelegationScope => "scope", expires_at: PositiveInt => "expiresAt", active: bool => "active",
} {});
crate::schema::record_type!(SessionDelegationInfo {
    id: Identity => "id", revision: PositiveInt => "revision", source_exchange_id: DeviceIdentity => "sourceExchangeID",
    target_session_id: SessionId => "targetSessionID", basis: SessionBasis => "basis",
    principal: mcp_events::Principal => "principal", scope: SessionDelegationScope => "scope", expires_at: PositiveInt => "expiresAt", active: bool => "active",
} {});
#[derive(Clone, Debug, PartialEq)]
pub enum DelegationInfo {
    Routine(RoutineDelegationInfo),
    Session(SessionDelegationInfo),
}
impl DomainDecode for DelegationInfo {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        RoutineDelegationInfo::decode_at(value, path)
            .map(Self::Routine)
            .or_else(|_| SessionDelegationInfo::decode_at(value, path).map(Self::Session))
    }
}
impl DomainEncode for DelegationInfo {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Routine(value) => value.encode(),
            Self::Session(value) => value.encode(),
        }
    }
}
crate::schema::record_type!(DelegationReview {
    kind: ReviewKind => "kind", proposal_id: DeviceIdentity => "proposalID", source_exchange_id: DeviceIdentity => "sourceExchangeID",
    principal: mcp_events::Principal => "principal", target_session_id: SessionId => "targetSessionID", task_input_id: MessageId => "taskInputID",
    task: LosslessString => "task", expected_attachment: Target => "expectedAttachment", scope: DelegationScope => "scope",
    expires_at: PositiveInt => "expiresAt", lifetime: ReviewLifetime => "lifetime", fingerprint: Identity => "fingerprint",
} {});
crate::schema::record_type!(DelegationStatusSource { source_exchange_id: DeviceIdentity => "sourceExchangeID", principal: mcp_events::Principal => "principal" } {});
crate::schema::record_type!(DelegationStatusTask { task_input_id: MessageId => "taskInputID", text: LosslessString => "text" } {});
crate::schema::record_type!(DelegationStatus {
    sources: Vec<DelegationStatusSource> => "sources", tasks: Vec<DelegationStatusTask> => "tasks", grants: Vec<DelegationInfo> => "grants",
} {});
crate::schema::record_type!(ExchangeRead { exchange_id: DeviceIdentity => "exchangeID" } {});

#[derive(Clone, Debug, PartialEq)]
pub enum Envelope {
    Task(TaskEnvelope),
    Report(ReportEnvelope),
}
impl DomainDecode for Envelope {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        TaskEnvelope::decode_at(value, path)
            .map(Self::Task)
            .or_else(|_| ReportEnvelope::decode_at(value, path).map(Self::Report))
    }
}
impl DomainEncode for Envelope {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Task(value) => value.encode(),
            Self::Report(value) => value.encode(),
        }
    }
}

crate::schema::record_type!(ExchangeFields {
    exchange_id: DeviceIdentity => "exchangeID", expected_attachment: Target => "expectedAttachment",
    target_session_id: SessionId => "targetSessionID", channel: Channel => "channel", delivery: DeliveryMode => "delivery",
} {});
#[derive(Clone, Debug, PartialEq)]
pub enum ExchangeCreate {
    Text {
        fields: ExchangeFields,
        text: LosslessString,
    },
    Routine {
        fields: ExchangeFields,
        receipt: RoutineReceipt,
    },
    Delegated {
        fields: ExchangeFields,
        receipt: DelegatedReceipt,
    },
}
impl DomainDecode for ExchangeCreate {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let fields = ExchangeFields::decode_at(value, path)?;
        let receipt = ["delegation", "taskInputID", "instruction"]
            .iter()
            .any(|key| {
                object
                    .optional::<JsonValue>(key)
                    .is_ok_and(|found| found.is_some())
            });
        if !receipt {
            let text: JsonValue = object.field("text")?;
            let text = crate::domain::bounded_string(&text, 1, 32768, &path.key("text"))?;
            return Ok(Self::Text { fields, text });
        }
        const COMMON: [&str; 5] = [
            "exchangeID",
            "expectedAttachment",
            "targetSessionID",
            "channel",
            "delivery",
        ];
        let allowed = |extra: &[&'static str]| {
            let mut keys = COMMON.to_vec();
            keys.extend_from_slice(extra);
            keys
        };
        let routine = strict(
            value,
            path,
            &allowed(&["delegation", "taskInputID", "instruction"]),
        )
        .and_then(|_| RoutineReceipt::decode_at(value, path));
        match routine {
            Ok(receipt) => Ok(Self::Routine { fields, receipt }),
            Err(_) => {
                strict(value, path, &allowed(&["delegation", "instruction"]))?;
                Ok(Self::Delegated {
                    fields,
                    receipt: DelegatedReceipt::decode_at(value, path)?,
                })
            }
        }
    }
}
impl DomainEncode for ExchangeCreate {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Text { fields, text } => merged(
                fields.encode(),
                ObjectEncoder::new().field("text", text).finish(),
            ),
            Self::Routine { fields, receipt } => merged(fields.encode(), receipt.encode()),
            Self::Delegated { fields, receipt } => merged(fields.encode(), receipt.encode()),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct VisibleTarget(pub Target);
impl DomainDecode for VisibleTarget {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let target = Target::decode_at(value, path)?;
        if !crate::guardrail::has_non_whitespace(&target.label) {
            return Err(path
                .key("label")
                .error(DecodeErrorKind::Expected("visible label")));
        }
        Ok(Self(target))
    }
}
impl DomainEncode for VisibleTarget {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
crate::schema::record_type!(ExchangeMetadata {
    session_id: SessionId => "sessionID", target_session_id: SessionId => "targetSessionID",
    exchange_id: DeviceIdentity => "exchangeID", attachment: VisibleTarget => "attachment",
} { envelope: TaskEnvelope => "envelope", routine: RoutineReceipt => "routine", delegated: DelegatedReceipt => "delegated" });

#[derive(Clone, Debug, PartialEq)]
pub struct DecisionCandidate {
    pub target: DecisionTarget,
    pub action: Option<LosslessString>,
    pub resources: Option<Vec<LosslessString>>,
    pub rule_ids: Option<Vec<LosslessString>>,
    pub title: Option<LosslessString>,
    pub fields: Option<crate::form::Fields>,
    pub questions: Option<Vec<crate::question::Info>>,
    pub subagent_question: Option<crate::session_orchestration::Question>,
    pub review: Option<crate::session_review::Item>,
}
fn bounded_text(
    object: &ObjectDecoder<'_>,
    path: &JsonPath,
    key: &str,
    maximum: usize,
) -> Result<Option<LosslessString>, DecodeError> {
    object
        .optional::<JsonValue>(key)?
        .map(|value| crate::domain::bounded_string(&value, 0, maximum, &path.key(key)))
        .transpose()
}
fn bounded_texts(
    object: &ObjectDecoder<'_>,
    path: &JsonPath,
    key: &str,
    maximum: usize,
) -> Result<Option<Vec<LosslessString>>, DecodeError> {
    object
        .optional::<Vec<JsonValue>>(key)?
        .map(|values| {
            values
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    crate::domain::bounded_string(value, 0, maximum, &path.key(key).index(index))
                })
                .collect()
        })
        .transpose()
}
impl DomainDecode for DecisionCandidate {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            target: object.field("target")?,
            action: bounded_text(&object, path, "action", 256)?,
            resources: bounded_texts(&object, path, "resources", 1000)?,
            rule_ids: bounded_texts(&object, path, "ruleIDs", 256)?,
            title: bounded_text(&object, path, "title", 256)?,
            fields: object.optional("fields")?,
            questions: object.optional("questions")?,
            subagent_question: object.optional("subagentQuestion")?,
            review: object.optional("review")?,
        })
    }
}
impl DomainEncode for DecisionCandidate {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("target", &self.target)
            .optional("action", &self.action)
            .optional("resources", &self.resources)
            .optional("ruleIDs", &self.rule_ids)
            .optional("title", &self.title)
            .optional("fields", &self.fields)
            .optional("questions", &self.questions)
            .optional("subagentQuestion", &self.subagent_question)
            .optional("review", &self.review)
            .finish()
    }
}
crate::schema::record_type!(DecisionOutcome { target: DecisionTarget => "target", state: DecisionState => "state" } { reply: DelegatedReply => "reply" });
crate::schema::record_type!(Exchange {
    envelope: TaskEnvelope => "envelope", exchange_id: DeviceIdentity => "exchangeID", session_id: SessionId => "sessionID",
    target_session_id: SessionId => "targetSessionID", input_id: MessageId => "inputID", channel: Channel => "channel",
    state: ExchangeState => "state", progress: Vec<ExchangeOutput> => "progress",
} { result: ExchangeOutput => "result", decisions: Vec<DecisionCandidate> => "decisions", decision_outcome: DecisionOutcome => "decisionOutcome" });

#[derive(Clone, Debug, PartialEq)]
pub struct Peer {
    pub origin: PeerOrigin,
    pub profile: Identity,
    pub dot_id: Identity,
    pub thread_id: Identity,
    pub turn_id: Option<Identity>,
    pub item_id: Identity,
    pub causal_message_id: Option<Identity>,
}
impl DomainDecode for Peer {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            origin: object.field("origin")?,
            profile: object.field("profile")?,
            dot_id: object.field("dotID")?,
            thread_id: object.field("threadID")?,
            turn_id: object.optional("turnID")?,
            item_id: object.field("itemID")?,
            causal_message_id: object.optional("causalMessageID")?,
        })
    }
}
impl DomainEncode for Peer {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("origin", &self.origin)
            .field("profile", &self.profile)
            .field("dotID", &self.dot_id)
            .field("threadID", &self.thread_id)
            .optional("turnID", &self.turn_id)
            .field("itemID", &self.item_id)
            .optional("causalMessageID", &self.causal_message_id)
            .finish()
    }
}

pub fn peer(metadata: &crate::JsonObject) -> Option<Peer> {
    Peer::decode(metadata.get(&"dots".into())?).ok()
}

pub fn routine(metadata: &crate::JsonObject) -> Option<RoutineReceipt> {
    let JsonValue::Object(exchange) = metadata.get(&"dotsExchange".into())? else {
        return None;
    };
    let value = exchange.get(&"routine".into())?;
    let path = JsonPath::default();
    strict(value, &path, &["delegation", "taskInputID", "instruction"]).ok()?;
    let JsonValue::Object(receipt) = value else {
        return None;
    };
    strict(
        receipt.get(&"delegation".into())?,
        &path,
        &["id", "revision"],
    )
    .ok()?;
    RoutineReceipt::decode_at(value, &path).ok()
}
