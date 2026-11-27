use crate::recall;
use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder,
};

#[derive(Clone, Debug, PartialEq)]
pub struct Data(pub crate::JsonObject);
impl DomainDecode for Data {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let object = crate::JsonObject::decode_at(v, p)?;
        if object.is_empty() {
            return Err(p.error(crate::DecodeErrorKind::Expected("non-empty event data")));
        }
        Ok(Self(object))
    }
}
impl DomainEncode for Data {
    fn encode(&self) -> JsonValue {
        JsonValue::Object(self.0.clone())
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Source {
    pub start: crate::schema::NonNegativeInt,
    pub end: crate::schema::NonNegativeInt,
    pub text: LosslessString,
}
impl DomainDecode for Source {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            start: o.field("start")?,
            end: o.field("end")?,
            text: o.field("text")?,
        })
    }
}
impl DomainEncode for Source {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("start", &self.start)
            .field("end", &self.end)
            .field("text", &self.text)
            .finish()
    }
}
fn durable(event_type: &str, version: i64) -> crate::event::Definition {
    crate::event::Definition {
        event_type: event_type.into(),
        durability: crate::event::Durability::Durable {
            version: crate::event::Version::new(version).expect("schema event version is positive"),
            aggregate: "sessionID".into(),
        },
    }
}
fn ephemeral(event_type: &str) -> crate::event::Definition {
    crate::event::Definition {
        event_type: event_type.into(),
        durability: crate::event::Durability::Ephemeral,
    }
}
pub fn definitions() -> Vec<crate::event::Definition> {
    vec![
        durable("session.created", 2),
        durable("session.agent.selected", 1),
        durable("session.dots.access.changed", 1),
        durable("session.model.selected", 1),
        durable("session.daybreak.set", 1),
        durable("session.guardrail.dismissed", 1),
        durable("session.guardrail.escalated", 1),
        durable("session.guardrail.decided", 1),
        durable("session.decision.audited", 1),
        durable("session.permission.assessed", 1),
        durable("session.review.deferred", 1),
        durable("session.review.decided", 1),
        durable("session.review.withdrawn", 1),
        durable("session.review.consumed", 1),
        durable("session.moved", 1),
        durable("session.renamed", 1),
        ephemeral("session.usage.updated"),
        ephemeral("session.prediction.updated"),
        ephemeral("session.diagnostics.updated"),
        durable("session.deleted", 2),
        durable("session.archived", 2),
        durable("session.unarchived", 2),
        durable("session.pinned", 1),
        durable("session.unpinned", 1),
        durable("session.forked", 2),
        durable("session.input.promoted", 1),
        durable("session.input.admitted", 1),
        durable("session.input.withdrawn", 1),
        durable("session.input.steered", 1),
        durable("session.input.consumed", 1),
        durable("session.input.deleted", 1),
        durable("session.dots.exchange.created", 1),
        durable("session.dots.binding.bound", 1),
        durable("session.dots.binding.unbound", 1),
        durable("session.dots.device-delegation.created", 1),
        durable("session.dots.device-delegation.revoked", 1),
        durable("session.dots.decision.settled", 1),
        durable("session.dots.instruction.rejected", 1),
        durable("session.dots.report.recorded", 1),
        durable("session.execution.started", 1),
        durable("session.execution.succeeded", 1),
        durable("session.execution.failed", 1),
        durable("session.execution.interrupted", 1),
        durable("session.work.completed", 1),
        durable("session.instructions.updated", 2),
        durable("session.context.observed", 1),
        durable("session.task.updated", 1),
        durable("session.synthetic", 1),
        durable("session.skill.activated", 1),
        durable("session.skill.deactivated", 1),
        durable("session.cue.detected", 1),
        durable("session.recall.recorded", 1),
        durable("session.shell.started", 1),
        durable("session.shell.ended", 1),
        durable("session.step.started", 1),
        durable("session.step.ended", 1),
        durable("session.step.failed", 1),
        durable("session.step.rerouted", 1),
        durable("session.text.started", 1),
        ephemeral("session.text.delta"),
        durable("session.text.ended", 1),
        durable("session.reasoning.started", 1),
        ephemeral("session.reasoning.delta"),
        durable("session.reasoning.ended", 1),
        durable("session.tool.input.started", 1),
        ephemeral("session.tool.input.delta"),
        durable("session.tool.input.ended", 1),
        durable("session.tool.called", 1),
        ephemeral("session.tool.progress"),
        durable("session.tool.invocation-settled", 1),
        durable("session.tool.success", 1),
        durable("session.tool.failed", 1),
        durable("session.file-change.recorded", 1),
        durable("session.retry.scheduled", 1),
        durable("session.compaction.admitted", 2),
        durable("session.compaction.started", 2),
        ephemeral("session.compaction.delta"),
        durable("session.compaction.ended", 2),
        durable("session.compaction.failed", 2),
        durable("session.revert.staged", 1),
        durable("session.revert.cleared", 1),
        durable("session.revert.committed", 1),
    ]
}
pub fn durable_definitions() -> Vec<crate::event::Definition> {
    let mut result: Vec<_> = definitions()
        .into_iter()
        .filter(|d| matches!(d.durability, crate::event::Durability::Durable { .. }))
        .collect();
    result.extend([
        durable("session.tool.progress", 1),
        durable("session.compaction.admitted", 1),
        durable("session.compaction.started", 1),
        durable("session.compaction.ended", 1),
        durable("session.compaction.replaced", 1),
        durable("session.compaction.failed", 1),
        durable("session.usage.recorded", 1),
        durable("session.provider.request.recorded", 1),
        durable("session.profile.bound", 1),
        durable("session.guardrail.approved", 1),
    ]);
    result
}
pub fn public_durable_definitions() -> Vec<crate::event::Definition> {
    definitions()
        .into_iter()
        .filter(|d| matches!(d.durability, crate::event::Durability::Durable { .. }))
        .collect()
}
pub fn all_event_types() -> Vec<LosslessString> {
    let mut result: Vec<_> = definitions().into_iter().map(|d| d.event_type).collect();
    result.extend(
        [
            "session.usage.recorded",
            "session.provider.request.recorded",
            "session.profile.bound",
            "session.guardrail.approved",
        ]
        .into_iter()
        .map(LosslessString::from),
    );
    result
}

#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub id: crate::event::Id,
    pub created: crate::schema::DateTimeUtcFromMillis,
    pub metadata: Option<crate::JsonObject>,
    pub source_epoch: Option<crate::source_epoch::SourceEpoch>,
    pub event_type: LosslessString,
    pub durable: Option<crate::event::DurableEnvelope>,
    pub location: Option<crate::location::Ref>,
    pub data: Data,
}
impl DomainDecode for Event {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        decode_event(value, path, all_definitions())
    }
}
impl DomainEncode for Event {
    fn encode(&self) -> JsonValue {
        encode_event(self)
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct DurableEvent(pub Event);
impl DomainDecode for DurableEvent {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        decode_event(value, path, durable_definitions()).map(Self)
    }
}
impl DomainEncode for DurableEvent {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct PublicDurableEvent(pub Event);
impl DomainDecode for PublicDurableEvent {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        decode_event(value, path, public_durable_definitions()).map(Self)
    }
}
impl DomainEncode for PublicDurableEvent {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
fn decode_event(
    value: &JsonValue,
    path: &JsonPath,
    definitions: Vec<crate::event::Definition>,
) -> Result<Event, DecodeError> {
    let object = ObjectDecoder::new(value, path)?;
    let event_type: LosslessString = object.field("type")?;
    let durable_value = object.optional::<JsonValue>("durable")?;
    let definition = definitions
        .into_iter()
        .find(|definition| {
            if definition.event_type != event_type {
                return false;
            }
            match (&definition.durability, &durable_value) {
                (crate::event::Durability::Durable { version, .. }, Some(value)) => {
                    ObjectDecoder::new(value, &path.key("durable"))
                        .and_then(|durable| durable.field::<crate::event::Version>("version"))
                        .is_ok_and(|actual| actual == *version)
                }
                (crate::event::Durability::Ephemeral, _) => true,
                _ => false,
            }
        })
        .ok_or_else(|| {
            path.key("type").error(DecodeErrorKind::Expected(
                "known Session event type and version",
            ))
        })?;
    let durable = match definition.durability {
        crate::event::Durability::Durable { version, .. } => {
            let value = durable_value
                .as_ref()
                .expect("durable event envelope was selected");
            ObjectDecoder::new(value, &path.key("durable"))?
                .literal("version", &JsonValue::Number(version.get() as f64))?;
            Some(crate::event::DurableEnvelope::decode_at(
                value,
                &path.key("durable"),
            )?)
        }
        crate::event::Durability::Ephemeral => None,
    };
    let data = decode_event_data(
        &event_type,
        durable.as_ref().map(|value| value.version.get()),
        &object.field("data")?,
        &path.key("data"),
    )?;
    Ok(Event {
        id: object.field("id")?,
        created: object.field("created")?,
        metadata: object.optional("metadata")?,
        source_epoch: object.optional("sourceEpoch")?,
        event_type,
        durable,
        location: object.optional("location")?,
        data,
    })
}
fn encode_event(event: &Event) -> JsonValue {
    let mut object = crate::ObjectEncoder::new()
        .field("id", &event.id)
        .field("created", &event.created)
        .optional("metadata", &event.metadata)
        .optional("sourceEpoch", &event.source_epoch)
        .field("type", &event.event_type);
    if let Some(durable) = &event.durable {
        object = object.field("durable", durable);
    }
    object
        .optional("location", &event.location)
        .field("data", &event.data)
        .finish()
}
fn all_definitions() -> Vec<crate::event::Definition> {
    let mut result = definitions();
    result.extend([
        durable("session.usage.recorded", 1),
        durable("session.provider.request.recorded", 1),
        durable("session.profile.bound", 1),
        durable("session.guardrail.approved", 1),
    ]);
    result
}
pub type FileAttachment = crate::prompt::FileAttachment;
#[derive(Clone, Debug, PartialEq)]
pub struct ProfileBinding {
    pub provider_id: crate::provider::Id,
    pub integration_id: crate::integration_id::IntegrationId,
    pub profile: crate::model::ProfileName,
    pub credential_id: crate::credential::Id,
    pub account_generation: crate::schema::NonNegativeInt,
}
impl DomainDecode for ProfileBinding {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            provider_id: o.field("providerID")?,
            integration_id: o.field("integrationID")?,
            profile: o.field("profile")?,
            credential_id: o.field("credentialID")?,
            account_generation: o.field("accountGeneration")?,
        })
    }
}
impl DomainEncode for ProfileBinding {
    fn encode(&self) -> JsonValue {
        crate::ObjectEncoder::new()
            .field("providerID", &self.provider_id)
            .field("integrationID", &self.integration_id)
            .field("profile", &self.profile)
            .field("credentialID", &self.credential_id)
            .field("accountGeneration", &self.account_generation)
            .finish()
    }
}
fn decode_event_data(
    event_type: &LosslessString,
    version: Option<i64>,
    value: &JsonValue,
    path: &JsonPath,
) -> Result<Data, DecodeError> {
    let fields = fields_for(event_type.as_str().unwrap_or(""), version)
        .ok_or_else(|| path.error(DecodeErrorKind::Expected("known Session event data")))?;
    let object = ObjectDecoder::new(value, path)?;
    let mut data = crate::JsonObject::new();
    for (key, optional) in fields {
        if *optional {
            if let Some(value) = object.optional::<JsonValue>(key)? {
                if matches!(value, JsonValue::Null)
                    && !(key == &"result"
                        && matches!(
                            event_type.as_str(),
                            Some("session.tool.success" | "session.tool.failed")
                        ))
                {
                    return Err(path
                        .key(*key)
                        .error(DecodeErrorKind::Expected("non-null optional field")));
                }
                data.insert(
                    (*key).into(),
                    checked_field(event_type.as_str().unwrap_or(""), key, value, path)?,
                );
            } else if let Some(value) = default_field(event_type.as_str().unwrap_or(""), key) {
                data.insert((*key).into(), value);
            }
        } else {
            let value = object.field(key)?;
            data.insert(
                (*key).into(),
                checked_field(event_type.as_str().unwrap_or(""), key, value, path)?,
            );
        }
    }
    Ok(Data(data))
}

fn default_field(event_type: &str, key: &str) -> Option<JsonValue> {
    match (event_type, key) {
        ("session.created", "scope") => Some(JsonValue::String("bound".into())),
        _ => None,
    }
}

fn checked_field(
    event_type: &str,
    key: &str,
    value: JsonValue,
    path: &JsonPath,
) -> Result<JsonValue, DecodeError> {
    let path = path.key(key);
    match canonical_field(event_type, key, &value, &path)? {
        Some(canonical) => Ok(canonical),
        None => validate_event_field(event_type, key, &value, &path).map(|_| value),
    }
}

fn canonical<T: DomainDecode + DomainEncode>(
    value: &JsonValue,
    path: &JsonPath,
) -> Result<Option<JsonValue>, DecodeError> {
    T::decode_at(value, path).map(|decoded| Some(decoded.encode()))
}

fn canonical_field(
    event_type: &str,
    key: &str,
    value: &JsonValue,
    path: &JsonPath,
) -> Result<Option<JsonValue>, DecodeError> {
    use crate::{guardrail, session_review};
    match (event_type, key) {
        ("session.tool.invocation-settled", "invocation") => {
            canonical::<crate::tool_invocation::Settled>(value, path)
        }
        ("session.dots.exchange.created", "expectedAttachment") => {
            canonical::<crate::dots::Target>(value, path)
        }
        ("session.dots.exchange.created", "source") => {
            canonical::<crate::mcp_events::RequestContext>(value, path)
        }
        ("session.dots.exchange.created", "scope") => {
            canonical::<crate::dots::ExchangeScope>(value, path)
        }
        ("session.dots.exchange.created", "routine") => {
            canonical::<crate::dots::RoutineReceipt>(value, path)
        }
        ("session.dots.exchange.created", "delegated") => {
            canonical::<crate::dots::DelegatedReceipt>(value, path)
        }
        ("session.dots.binding.bound", "binding") => {
            canonical::<crate::dots::BindingRecord>(value, path)
        }
        ("session.dots.device-delegation.created", "grant") => {
            canonical::<crate::dots::DeviceDelegationInfo>(value, path)
        }
        ("session.dots.device-delegation.revoked", "principal") => {
            canonical::<crate::mcp_events::Principal>(value, path)
        }
        ("session.dots.decision.settled", "source") => {
            canonical::<crate::form::ExternalReplySource>(value, path)
        }
        ("session.dots.decision.settled", "target") => {
            canonical::<crate::dots::DecisionTarget>(value, path)
        }
        ("session.dots.report.recorded", "envelope") => {
            canonical::<crate::dots::ReportEnvelope>(value, path)
        }
        ("session.context.observed", "dots") => {
            canonical::<crate::dots::CoordinationContext>(value, path)
        }
        ("session.dots.exchange.created", "exchangeID")
        | ("session.dots.binding.unbound", "bindingID")
        | (
            "session.dots.device-delegation.created" | "session.dots.device-delegation.revoked",
            "exchangeID" | "delegationID",
        ) => canonical::<crate::dots::DeviceIdentity>(value, path),
        ("session.dots.exchange.created", "accountDigest" | "fingerprint" | "grantID")
        | ("session.dots.instruction.rejected", "exchangeID" | "delegationID")
        | ("session.dots.report.recorded", "deliveryID") => {
            canonical::<crate::dots::Identity>(value, path)
        }
        (
            "session.review.deferred"
            | "session.review.decided"
            | "session.review.withdrawn"
            | "session.review.consumed",
            "itemID",
        ) => canonical::<session_review::Id>(value, path),
        ("session.review.deferred", "kind") => canonical::<session_review::Kind>(value, path),
        ("session.review.deferred", "reason") => canonical::<session_review::Reason>(value, path),
        ("session.review.deferred", "choice") => canonical::<LosslessString>(value, path),
        ("session.review.deferred", "origin") => canonical::<session_review::Origin>(value, path),
        ("session.review.deferred", "payload") => canonical::<session_review::Payload>(value, path),
        ("session.review.decided", "decision") => {
            canonical::<session_review::Decision>(value, path)
        }
        (
            "session.review.deferred"
            | "session.guardrail.escalated"
            | "session.guardrail.decided"
            | "session.permission.assessed",
            "confidence",
        ) => canonical::<guardrail::Confidence>(value, path),
        (
            "session.review.deferred"
            | "session.guardrail.escalated"
            | "session.guardrail.decided"
            | "session.permission.assessed",
            "grades",
        ) => canonical::<Vec<guardrail::Grade>>(value, path),
        (
            "session.guardrail.escalated"
            | "session.guardrail.decided"
            | "session.permission.assessed",
            "choice",
        ) => canonical::<guardrail::DecisionChoice>(value, path),
        (
            "session.guardrail.escalated"
            | "session.guardrail.decided"
            | "session.permission.assessed"
            | "session.decision.audited",
            "authority",
        ) => canonical::<guardrail::Authority>(value, path),
        ("session.guardrail.escalated" | "session.permission.assessed", "reason") => {
            canonical::<guardrail::EscalationReason>(value, path)
        }
        ("session.permission.assessed", "reply") => {
            canonical::<crate::permission::Reply>(value, path)
        }
        ("session.permission.assessed", "requestID") => canonical::<LosslessString>(value, path),
        ("session.permission.assessed", "rationale") => {
            let text = crate::domain::bounded_string(value, 0, 500, path)?;
            if guardrail::has_non_whitespace(&text) {
                Ok(Some(text.encode()))
            } else {
                Err(path.error(DecodeErrorKind::Expected("non-blank rationale")))
            }
        }
        ("session.guardrail.decided", "rationale") => {
            let text = crate::domain::bounded_string(value, 0, 500, path)?;
            if guardrail::has_non_whitespace(&text) {
                Ok(Some(text.encode()))
            } else {
                Err(path.error(DecodeErrorKind::Expected("non-blank rationale")))
            }
        }
        ("session.decision.audited", "agent" | "fingerprint" | "invocationKey") => {
            canonical::<LosslessString>(value, path)
        }
        ("session.decision.audited", "model") => canonical::<crate::model::Ref>(value, path),
        ("session.decision.audited", "route") => {
            crate::domain::bounded_string(value, 0, 128, path).map(|text| Some(text.encode()))
        }
        ("session.decision.audited", "attempts") => {
            canonical::<crate::schema::NonNegativeInt>(value, path)
        }
        ("session.decision.audited", "answers") => canonical::<Vec<AuditedAnswer>>(value, path)
            .and_then(|answers| match &answers {
                Some(JsonValue::Array(items)) if items.len() > 32 => {
                    Err(path.error(DecodeErrorKind::Expected("at most 32 audited answers")))
                }
                _ => Ok(answers),
            }),
        ("session.guardrail.decided", "reply") => canonical::<guardrail::Reply>(value, path),
        ("session.guardrail.decided", "reason") => {
            canonical::<guardrail::ClosedReason>(value, path)
        }
        (
            "session.guardrail.dismissed"
            | "session.guardrail.escalated"
            | "session.guardrail.decided",
            "source",
        ) => canonical::<guardrail::Source>(value, path),
        ("session.guardrail.escalated" | "session.guardrail.decided", "ruleIDs") => {
            canonical::<Vec<LosslessString>>(value, path)
        }
        ("session.guardrail.escalated" | "session.guardrail.decided", "requestID") => {
            canonical::<LosslessString>(value, path)
        }
        ("session.guardrail.dismissed", "ruleID") => {
            crate::domain::branded_string(value, "standard.review.", path)
                .map(|id| Some(id.encode()))
        }
        ("session.cue.detected", "cueID") | ("session.recall.recorded", "cueID") => {
            recall::bounded(value, 1, 128, path).map(|text| Some(text.encode()))
        }
        ("session.recall.recorded", "key") => {
            recall::bounded(value, 1, 128, path).map(|text| Some(text.encode()))
        }
        ("session.cue.detected", "subject") => {
            recall::bounded(value, 0, 512, path).map(|text| Some(text.encode()))
        }
        ("session.cue.detected", "kind") => canonical::<recall::CueKind>(value, path),
        ("session.recall.recorded", "trigger") => canonical::<recall::Trigger>(value, path),
        ("session.recall.recorded", "methods") => canonical::<recall::Methods>(value, path),
        ("session.recall.recorded", "outcome") => canonical::<recall::Outcome>(value, path),
        ("session.recall.recorded", "abstention") => canonical::<recall::Abstention>(value, path),
        ("session.recall.recorded", "items") => canonical::<recall::Items>(value, path),
        ("session.recall.recorded", "elapsedMs" | "injectedTokens" | "budgetTokens") => {
            canonical::<crate::schema::NonNegativeInt>(value, path)
        }
        ("session.guardrail.dismissed", "confidence") => {
            crate::domain::number_range(value, 0.9, 1.0, path)
                .map(|number| Some(JsonValue::Number(number)))
        }
        _ => Ok(None),
    }
}

fn fields_for(event_type: &str, version: Option<i64>) -> Option<&'static [(&'static str, bool)]> {
    let fields: &'static [(&'static str, bool)] = match event_type {
        "session.created" => &[
            ("sessionID", false),
            ("projectID", false),
            ("scope", true),
            ("location", false),
            ("parentID", true),
            ("agent", true),
            ("model", true),
            ("permissionCeiling", true),
            ("title", false),
            ("subpath", true),
            ("origin", true),
            ("created", false),
        ],
        "session.agent.selected" => &[("sessionID", false), ("agent", false)],
        "session.model.selected" => &[("sessionID", false), ("model", false)],
        "session.profile.bound" => &[("sessionID", false), ("binding", true)],
        "session.guardrail.approved" => &[("sessionID", false), ("directories", false)],
        "session.daybreak.set" => &[("sessionID", false), ("daybreak", true)],
        "session.moved" => &[
            ("sessionID", false),
            ("location", false),
            ("projectID", true),
            ("subpath", true),
        ],
        "session.renamed" => &[("sessionID", false), ("title", false)],
        "session.usage.recorded" => &[
            ("sessionID", false),
            ("source", false),
            ("cost", false),
            ("tokens", false),
        ],
        "session.provider.request.recorded" => &[
            ("id", false),
            ("sessionID", false),
            ("inputID", true),
            ("usageAnchor", true),
            ("assistantMessageID", true),
            ("connectionIdentityDigest", true),
            ("source", false),
            ("agent", false),
            ("model", false),
            ("routeID", false),
            ("promptCacheKey", false),
            ("systemDigest", false),
            ("toolDigest", false),
            ("request", false),
            ("attempts", false),
            ("invalidation", false),
            ("continuation", false),
            ("cacheReadReported", true),
            ("timing", true),
            ("outcome", true),
            ("cost", true),
            ("tokens", false),
            ("time", false),
        ],
        "session.usage.updated" => &[("sessionID", false), ("cost", false), ("tokens", false)],
        "session.prediction.updated" => &[
            ("sessionID", false),
            ("sourceMessageID", false),
            ("text", false),
        ],
        "session.diagnostics.updated" => &[("sessionID", false), ("diagnostics", false)],
        "session.deleted"
        | "session.archived"
        | "session.unarchived"
        | "session.pinned"
        | "session.unpinned"
        | "session.execution.started"
        | "session.execution.succeeded" => &[("sessionID", false)],
        "session.forked" => &[
            ("sessionID", false),
            ("parentID", false),
            ("parentSeq", false),
            ("from", true),
        ],
        "session.input.promoted" => &[("sessionID", false), ("inputID", false)],
        "session.input.admitted" => &[
            ("sessionID", false),
            ("inputID", false),
            ("input", false),
            ("causedBy", true),
        ],
        "session.input.consumed" => &[("sessionID", false), ("inputIDs", false)],
        "session.input.withdrawn" | "session.input.steered" | "session.input.deleted" => {
            &[("sessionID", false), ("inputID", false)]
        }
        "session.execution.failed" => &[("sessionID", false), ("error", false)],
        "session.execution.interrupted" => &[("sessionID", false), ("reason", false)],
        "session.work.completed" => &[
            ("sessionID", false),
            ("inputID", false),
            ("assistantMessageID", false),
        ],
        "session.instructions.updated" => &[("sessionID", false), ("delta", false)],
        "session.context.observed" => &[
            ("sessionID", false),
            ("source", false),
            ("text", false),
            ("dots", true),
        ],
        "session.dots.access.changed" => &[
            ("sessionID", false),
            ("enabled", false),
            ("revision", false),
        ],
        "session.dots.exchange.created" => &[
            ("exchangeID", false),
            ("sessionID", false),
            ("targetSessionID", false),
            ("inputID", false),
            ("expectedAttachment", false),
            ("accountDigest", false),
            ("fingerprint", false),
            ("source", false),
            ("grantID", false),
            ("routine", true),
            ("delegated", true),
            ("scope", false),
        ],
        "session.dots.binding.bound" => &[("sessionID", false), ("binding", false)],
        "session.dots.binding.unbound" => &[("sessionID", false), ("bindingID", false)],
        "session.dots.device-delegation.created" => &[
            ("sessionID", false),
            ("exchangeID", false),
            ("fingerprint", false),
            ("grant", false),
        ],
        "session.dots.device-delegation.revoked" => &[
            ("sessionID", false),
            ("exchangeID", false),
            ("fingerprint", false),
            ("delegationID", false),
            ("revision", false),
            ("principal", false),
        ],
        "session.dots.decision.settled" => &[
            ("sessionID", false),
            ("source", false),
            ("target", false),
            ("reply", true),
        ],
        "session.dots.instruction.rejected" => &[
            ("sessionID", false),
            ("inputID", false),
            ("anchorSessionID", false),
            ("exchangeID", false),
            ("delegationID", false),
            ("reason", false),
        ],
        "session.dots.report.recorded" => &[
            ("sessionID", false),
            ("deliveryID", false),
            ("messageID", false),
            ("text", false),
            ("envelope", false),
            ("callID", false),
        ],
        "session.tool.invocation-settled" => &[
            ("sessionID", false),
            ("assistantMessageID", false),
            ("callID", false),
            ("invocation", false),
        ],
        "session.task.updated" => &[("sessionID", false), ("change", false)],
        "session.synthetic" => &[
            ("sessionID", false),
            ("text", false),
            ("description", true),
            ("metadata", true),
        ],
        "session.skill.activated" => &[
            ("sessionID", false),
            ("id", false),
            ("name", false),
            ("text", false),
            ("directory", true),
            ("conflicts", true),
        ],
        "session.skill.deactivated" => &[
            ("sessionID", false),
            ("id", false),
            ("activationMessageID", false),
            ("reason", false),
        ],
        "session.cue.detected" => &[
            ("sessionID", false),
            ("cueID", false),
            ("kind", false),
            ("subject", true),
            ("messageID", true),
        ],
        "session.recall.recorded" => &[
            ("sessionID", false),
            ("key", false),
            ("trigger", false),
            ("cueID", true),
            ("methods", false),
            ("outcome", false),
            ("abstention", true),
            ("items", false),
            ("elapsedMs", false),
            ("injectedTokens", false),
            ("budgetTokens", true),
        ],
        "session.shell.started" => &[("sessionID", false), ("shell", false)],
        "session.shell.ended" => &[("sessionID", false), ("shell", false), ("output", false)],
        "session.step.started" => &[
            ("sessionID", false),
            ("assistantMessageID", false),
            ("agent", false),
            ("model", false),
            ("snapshot", true),
        ],
        "session.step.ended" => &[
            ("sessionID", false),
            ("assistantMessageID", false),
            ("finish", false),
            ("cost", false),
            ("tokens", false),
            ("contextLimit", true),
            ("contextBreakdown", true),
            ("providerCache", true),
            ("snapshot", true),
            ("files", true),
        ],
        "session.step.failed" => &[
            ("sessionID", false),
            ("assistantMessageID", false),
            ("error", false),
            ("cost", true),
            ("tokens", true),
            ("contextLimit", true),
            ("contextBreakdown", true),
            ("providerCache", true),
            ("snapshot", true),
            ("files", true),
        ],
        "session.text.started" => &[
            ("sessionID", false),
            ("assistantMessageID", false),
            ("ordinal", false),
            ("phase", true),
        ],
        "session.text.delta" => &[
            ("sessionID", false),
            ("assistantMessageID", false),
            ("ordinal", false),
            ("delta", false),
        ],
        "session.text.ended" => &[
            ("sessionID", false),
            ("assistantMessageID", false),
            ("ordinal", false),
            ("text", false),
            ("phase", true),
        ],
        "session.reasoning.started" => &[
            ("sessionID", false),
            ("assistantMessageID", false),
            ("ordinal", false),
            ("state", true),
        ],
        "session.reasoning.delta" => &[
            ("sessionID", false),
            ("assistantMessageID", false),
            ("ordinal", false),
            ("delta", false),
        ],
        "session.reasoning.ended" => &[
            ("sessionID", false),
            ("assistantMessageID", false),
            ("ordinal", false),
            ("text", false),
            ("state", true),
        ],
        "session.tool.input.started" => &[
            ("sessionID", false),
            ("assistantMessageID", false),
            ("callID", false),
            ("name", false),
        ],
        "session.tool.input.delta" => &[
            ("sessionID", false),
            ("assistantMessageID", false),
            ("callID", false),
            ("delta", false),
        ],
        "session.tool.input.ended" => &[
            ("sessionID", false),
            ("assistantMessageID", false),
            ("callID", false),
            ("text", false),
        ],
        "session.tool.called" => &[
            ("sessionID", false),
            ("assistantMessageID", false),
            ("callID", false),
            ("input", false),
            ("executed", false),
            ("state", true),
        ],
        "session.tool.progress" => &[
            ("sessionID", false),
            ("assistantMessageID", false),
            ("callID", false),
            ("structured", false),
            ("content", false),
        ],
        "session.tool.success" => &[
            ("sessionID", false),
            ("assistantMessageID", false),
            ("callID", false),
            ("structured", false),
            ("content", false),
            ("result", true),
            ("executed", false),
            ("resultState", true),
        ],
        "session.tool.failed" => &[
            ("sessionID", false),
            ("assistantMessageID", false),
            ("callID", false),
            ("error", false),
            ("result", true),
            ("executed", false),
            ("resultState", true),
        ],
        "session.file-change.recorded" => &[("sessionID", false), ("change", false)],
        "session.retry.scheduled" => &[
            ("sessionID", false),
            ("assistantMessageID", false),
            ("attempt", false),
            ("at", false),
            ("error", false),
        ],
        "session.compaction.admitted" if version == Some(1) => {
            &[("sessionID", false), ("inputID", false)]
        }
        "session.compaction.admitted" => &[
            ("sessionID", false),
            ("jobID", false),
            ("pressure", true),
            ("usageAnchor", true),
        ],
        "session.compaction.started" if version == Some(1) => &[
            ("sessionID", false),
            ("reason", false),
            ("recent", false),
            ("inputID", true),
        ],
        "session.compaction.started" => &[("sessionID", false), ("jobID", false)],
        "session.compaction.delta" => &[("sessionID", false), ("text", false)],
        "session.compaction.ended" if version == Some(1) => &[
            ("sessionID", false),
            ("reason", false),
            ("text", false),
            ("recent", false),
            ("messages", true),
            ("tokens", true),
        ],
        "session.compaction.ended" => &[
            ("sessionID", false),
            ("jobID", false),
            ("revision", false),
            ("boundary", false),
            ("metrics", false),
        ],
        "session.compaction.failed" if version == Some(1) => &[
            ("sessionID", false),
            ("reason", false),
            ("error", false),
            ("inputID", true),
        ],
        "session.compaction.failed" => &[
            ("sessionID", false),
            ("jobID", false),
            ("code", false),
            ("error", false),
        ],
        "session.compaction.replaced" => &[
            ("sessionID", false),
            ("summaryMessageID", false),
            ("through", false),
            ("summaryRevision", false),
            ("deletedMessageCount", false),
            ("remainingMessageCount", false),
        ],
        "session.revert.staged" => &[("sessionID", false), ("revert", false)],
        "session.revert.cleared" => &[("sessionID", false)],
        "session.revert.committed" => &[("sessionID", false), ("to", false)],
        "session.review.deferred" => &[
            ("sessionID", false),
            ("itemID", false),
            ("kind", false),
            ("reason", false),
            ("choice", true),
            ("confidence", true),
            ("grades", true),
            ("origin", false),
            ("payload", false),
        ],
        "session.review.decided" => &[("sessionID", false), ("itemID", false), ("decision", false)],
        "session.review.withdrawn" => &[("sessionID", false), ("itemID", false), ("reason", false)],
        "session.review.consumed" => &[("sessionID", false), ("itemID", false)],
        "session.step.rerouted" => &[
            ("sessionID", false),
            ("assistantMessageID", false),
            ("model", false),
            ("error", false),
        ],
        "session.guardrail.dismissed" => &[
            ("sessionID", false),
            ("reviewSessionID", false),
            ("ruleID", false),
            ("confidence", false),
            ("source", true),
        ],
        "session.guardrail.escalated" => &[
            ("sessionID", false),
            ("requestID", false),
            ("authority", true),
            ("reason", true),
            ("choice", true),
            ("confidence", true),
            ("grades", true),
            ("ruleIDs", true),
            ("source", true),
        ],
        "session.guardrail.decided" => &[
            ("sessionID", false),
            ("reviewSessionID", false),
            ("requestID", false),
            ("reply", false),
            ("authority", true),
            ("choice", true),
            ("grades", true),
            ("confidence", true),
            ("ruleIDs", true),
            ("source", true),
            ("actor", true),
            ("reason", true),
            ("coordinatorSessionID", true),
            ("groupID", true),
            ("rationale", true),
        ],
        "session.decision.audited" => &[
            ("sessionID", false),
            ("purpose", false),
            ("authority", true),
            ("agent", false),
            ("model", true),
            ("route", true),
            ("outcome", false),
            ("reason", true),
            ("fingerprint", false),
            ("invocationKey", true),
            ("attempts", false),
            ("answers", true),
        ],
        "session.permission.assessed" => &[
            ("sessionID", false),
            ("requestID", false),
            ("outcome", false),
            ("via", false),
            ("reply", true),
            ("authority", true),
            ("reason", true),
            ("choice", true),
            ("confidence", true),
            ("grades", true),
            ("source", true),
            ("actor", true),
            ("coordinatorSessionID", true),
            ("groupID", true),
            ("rationale", true),
        ],
        _ => return None,
    };
    Some(fields)
}

fn validate_event_field(
    event_type: &str,
    key: &str,
    value: &JsonValue,
    path: &JsonPath,
) -> Result<(), DecodeError> {
    let literals: Option<&[&str]> = match (event_type, key) {
        ("session.usage.recorded", "source") => Some(&[
            "title",
            "compaction",
            "goal",
            "decision",
            "prediction",
            "prompt",
        ]),
        ("session.context.observed", "source") => {
            Some(&["session-state", "team-view", "step-limit", "dots"])
        }
        ("session.created", "origin") => Some(&["dots-executor"]),
        ("session.created", "scope") => Some(&["bound", "standalone"]),
        ("session.dots.instruction.rejected", "reason") => Some(&["delegation_invalid"]),
        ("session.dots.decision.settled", "reply") => Some(&["once", "reject"]),
        ("session.execution.interrupted", "reason") => Some(&["user", "shutdown", "superseded"]),
        ("session.skill.deactivated", "reason") => Some(&["conflict_resolved"]),
        ("session.review.withdrawn", "reason") => Some(&["reverted", "task_closed", "autonomy"]),
        ("session.decision.audited", "purpose") => {
            Some(&["permission", "guardrail", "answer", "advisory"])
        }
        ("session.decision.audited", "outcome") => Some(&["succeeded", "failed", "cancelled"]),
        ("session.decision.audited", "reason") => Some(&[
            "unavailable",
            "invalid-request",
            "provider-failed",
            "timeout",
            "input-too-large",
            "invalid-output",
            "refused",
            "truncated-output",
            "unsupported-output",
        ]),
        ("session.permission.assessed", "outcome") => Some(&["allow", "deny", "escalate"]),
        ("session.permission.assessed", "via") => {
            Some(&["auto-permission", "baseline", "yolo", "coordination"])
        }
        ("session.permission.assessed", "actor") => Some(&["coordinator"]),
        ("session.guardrail.decided", "actor") => Some(&["coordinator"]),
        ("session.text.started" | "session.text.ended", "phase") => {
            Some(&["commentary", "final_answer"])
        }
        ("session.daybreak.set", "daybreak") => Some(&["daybreak_blue", "daybreak_red"]),
        ("session.step.ended", "finish") => Some(&[
            "stop",
            "length",
            "tool-calls",
            "content-filter",
            "error",
            "unknown",
        ]),
        (
            "session.compaction.started" | "session.compaction.ended" | "session.compaction.failed",
            "reason",
        ) => Some(&["auto", "manual"]),
        ("session.provider.request.recorded", "source") => Some(&[
            "step",
            "title",
            "goal",
            "compaction",
            "decision",
            "prediction",
            "prompt",
        ]),
        ("session.provider.request.recorded", "invalidation") => Some(&[
            "first-request",
            "compaction-reset",
            "model-switched",
            "model-variant-switched",
            "stable-hit",
            "prefix-changed",
            "system-prefix-changed",
            "tool-prefix-changed",
            "below-minimum",
            "provider-not-reported",
            "cache-disabled",
            "retry-fallback",
        ]),
        ("session.provider.request.recorded", "continuation") => {
            Some(&["full", "continued", "fallback"])
        }
        ("session.provider.request.recorded", "outcome") => {
            Some(&["completed", "failed", "cancelled"])
        }
        _ => None,
    };
    if let Some(literals) = literals {
        return crate::domain::literal_enum(value, literals, path).map(|_| ());
    }
    match (event_type, key) {
        ("session.dots.access.changed", "enabled") => validate_as::<bool>(value, path),
        ("session.dots.access.changed", "revision") => {
            validate_as::<crate::schema::NonNegativeInt>(value, path)
        }
        ("session.dots.device-delegation.revoked", "revision") => {
            validate_as::<crate::schema::PositiveInt>(value, path)
        }
        (
            "session.dots.device-delegation.created" | "session.dots.device-delegation.revoked",
            "fingerprint",
        ) => {
            let value = LosslessString::decode_at(value, path)?;
            if value.len() == 64
                && value
                    .code_units()
                    .all(|unit| matches!(unit, 48..=57 | 97..=102))
            {
                Ok(())
            } else {
                Err(path.error(DecodeErrorKind::Expected("lowercase SHA-256 digest")))
            }
        }
        (_, "anchorSessionID" | "targetSessionID") => {
            validate_as::<crate::session_id::SessionId>(value, path)
        }
        ("session.dots.report.recorded", "messageID") => {
            validate_as::<crate::session_message_id::Id>(value, path)
        }
        (
            _,
            "title" | "text" | "callID" | "routeID" | "promptCacheKey" | "systemDigest"
            | "toolDigest" | "recent" | "summary",
        )
        | (
            "session.text.delta" | "session.reasoning.delta" | "session.tool.input.delta",
            "delta",
        ) => validate_as::<LosslessString>(value, path),
        ("session.profile.bound", "binding") => validate_as::<ProfileBinding>(value, path),
        ("session.guardrail.approved", "directories") => {
            validate_as::<Vec<LosslessString>>(value, path)
        }
        (
            "session.input.admitted"
            | "session.compaction.admitted"
            | "session.provider.request.recorded",
            "causedBy" | "usageAnchor",
        ) => validate_as::<crate::usage_anchor::Ref>(value, path),
        ("session.task.updated", "change") => {
            validate_as::<crate::session_orchestration::Change>(value, path)
        }
        ("session.provider.request.recorded", "id") => {
            validate_as::<crate::provider_request::Id>(value, path)
        }
        ("session.provider.request.recorded", "request" | "attempts") => {
            validate_as::<crate::schema::PositiveInt>(value, path)
        }
        ("session.provider.request.recorded", "time") => {
            validate_as::<crate::schema::DateTimeUtcFromMillis>(value, path)
        }
        ("session.provider.request.recorded", "cacheReadReported") => {
            validate_as::<bool>(value, path)
        }
        (_, "sessionID" | "parentID" | "reviewSessionID") => {
            validate_as::<crate::session_id::SessionId>(value, path)
        }
        ("session.permission.assessed", "coordinatorSessionID") => {
            validate_as::<crate::session_id::SessionId>(value, path)
        }
        ("session.permission.assessed", "groupID") => validate_as::<LosslessString>(value, path),
        ("session.guardrail.decided", "coordinatorSessionID") => {
            validate_as::<crate::session_id::SessionId>(value, path)
        }
        ("session.guardrail.decided", "groupID") => validate_as::<LosslessString>(value, path),
        (_, "projectID" | "oldProjectID" | "newProjectID") => {
            validate_as::<crate::project::Id>(value, path)
        }
        (_, "agent") => validate_as::<crate::agent::Id>(value, path),
        (_, "model") => validate_as::<crate::model::Ref>(value, path),
        ("session.created", "location") | ("session.moved", "location") => {
            validate_as::<crate::location::Ref>(value, path)
        }
        ("session.created", "permissionCeiling") => {
            validate_as::<crate::permission::Ruleset>(value, path)
        }
        ("session.created", "created") => validate_as::<crate::schema::NonNegativeInt>(value, path),
        ("session.daybreak.set", "daybreak") => validate_as::<crate::model::Daybreak>(value, path),
        ("session.usage.recorded" | "session.usage.updated", "cost") => {
            validate_as::<crate::money::Usd>(value, path)
        }
        ("session.usage.recorded" | "session.usage.updated", "tokens") => {
            validate_as::<crate::token_usage::Info>(value, path)
        }
        ("session.prediction.updated", "sourceMessageID") => {
            validate_as::<crate::session_message_id::Id>(value, path)
        }
        ("session.diagnostics.updated", "diagnostics") => {
            validate_as::<crate::session_cache_diagnostics::Info>(value, path)
        }
        ("session.forked", "parentSeq") => {
            crate::domain::integer_range(value, -1, 9_007_199_254_740_991, path).map(|_| ())
        }
        (
            _,
            "inputID"
            | "assistantMessageID"
            | "sourceMessageID"
            | "activationMessageID"
            | "summaryMessageID"
            | "messageID"
            | "to"
            | "from",
        ) => validate_as::<crate::session_message_id::Id>(value, path),
        ("session.input.admitted", "input") => {
            validate_as::<crate::session_pending::Message>(value, path)
        }
        ("session.input.consumed", "inputIDs") => {
            let values = Vec::<crate::session_message_id::Id>::decode_at(value, path)?;
            if values.is_empty() {
                Err(path.error(DecodeErrorKind::Length {
                    minimum: 1,
                    maximum: usize::MAX,
                }))
            } else {
                Ok(())
            }
        }
        (
            "session.execution.failed"
            | "session.execution.interrupted"
            | "session.step.failed"
            | "session.tool.failed"
            | "session.retry.scheduled"
            | "session.step.rerouted"
            | "session.compaction.failed",
            "error",
        ) => validate_as::<crate::session_error::Error>(value, path),
        ("session.instructions.updated", "delta") => {
            validate_as::<crate::instruction::Delta>(value, path)
        }
        ("session.synthetic", "metadata")
        | ("session.tool.called", "state")
        | ("session.reasoning.started" | "session.reasoning.ended", "state")
        | ("session.tool.success" | "session.tool.failed", "resultState") => {
            validate_as::<crate::JsonObject>(value, path)
        }
        ("session.skill.activated", "id") | ("session.skill.deactivated", "id") => {
            validate_as::<crate::skill::Id>(value, path)
        }
        ("session.skill.activated", "name") => validate_as::<crate::skill::Name>(value, path),
        ("session.skill.activated", "directory") => validate_as::<LosslessString>(value, path),
        ("session.skill.activated", "conflicts") => {
            validate_as::<crate::skill::Conflicts>(value, path)
        }
        ("session.shell.started" | "session.shell.ended", "shell") => {
            validate_as::<crate::shell::Info>(value, path)
        }
        ("session.shell.ended", "output") => validate_as::<crate::shell::Output>(value, path),
        ("session.step.started", "snapshot")
        | ("session.step.ended" | "session.step.failed", "snapshot") => {
            validate_as::<crate::snapshot::Id>(value, path)
        }
        ("session.step.ended" | "session.step.failed", "finish") => {
            validate_as::<crate::llm::FinishReason>(value, path)
        }
        ("session.step.ended" | "session.step.failed", "cost") => {
            validate_as::<crate::money::Usd>(value, path)
        }
        ("session.step.ended" | "session.step.failed", "tokens") => {
            validate_as::<crate::token_usage::Info>(value, path)
        }
        ("session.step.ended" | "session.step.failed", "contextLimit") => {
            validate_as::<crate::schema::NonNegativeInt>(value, path)
        }
        ("session.step.ended" | "session.step.failed", "contextBreakdown") => {
            validate_as::<crate::session_cache_diagnostics::ContextBreakdown>(value, path)
        }
        ("session.step.ended" | "session.step.failed", "providerCache") => {
            validate_as::<crate::session_cache_diagnostics::ProviderCache>(value, path)
        }
        ("session.step.ended" | "session.step.failed", "files") => {
            validate_as::<Vec<crate::schema::RelativePath>>(value, path)
        }
        (
            "session.text.started"
            | "session.text.delta"
            | "session.text.ended"
            | "session.reasoning.started"
            | "session.reasoning.delta"
            | "session.reasoning.ended"
            | "session.tool.input.started"
            | "session.tool.input.delta"
            | "session.tool.input.ended",
            "ordinal",
        ) => validate_as::<crate::schema::NonNegativeInt>(value, path),
        ("session.tool.called", "input")
        | ("session.tool.progress" | "session.tool.success", "structured") => {
            validate_as::<crate::JsonObject>(value, path)
        }
        ("session.tool.progress" | "session.tool.success", "content") => {
            validate_as::<Vec<crate::llm::ToolContent>>(value, path)
        }
        ("session.tool.called" | "session.tool.success" | "session.tool.failed", "executed") => {
            validate_as::<bool>(value, path)
        }
        ("session.file-change.recorded", "change") => validate_as::<FileChangeInfo>(value, path),
        ("session.retry.scheduled", "attempt") => {
            validate_as::<crate::schema::PositiveInt>(value, path)
        }
        ("session.retry.scheduled", "at") => {
            validate_as::<crate::schema::NonNegativeInt>(value, path)
        }
        ("session.compaction.admitted", "jobID")
        | (
            "session.compaction.started" | "session.compaction.ended" | "session.compaction.failed",
            "jobID",
        ) => validate_as::<crate::session_compaction::Id>(value, path),
        ("session.compaction.admitted", "pressure") => {
            validate_as::<crate::session_compaction::Pressure>(value, path)
        }
        ("session.compaction.ended", "revision") => {
            validate_as::<crate::schema::NonNegativeInt>(value, path)
        }
        ("session.compaction.ended", "boundary") => {
            validate_as::<crate::session_compaction::Boundary>(value, path)
        }
        ("session.compaction.ended", "metrics") => {
            validate_as::<crate::session_compaction::Metrics>(value, path)
        }
        ("session.compaction.failed", "code") => {
            validate_as::<crate::session_compaction::FailureCode>(value, path)
        }
        ("session.revert.staged", "revert") => {
            validate_as::<crate::session_revert::Revert>(value, path)
        }
        _ => Ok(()),
    }
}
fn validate_as<T: DomainDecode>(value: &JsonValue, path: &JsonPath) -> Result<(), DecodeError> {
    T::decode_at(value, path).map(|_| ())
}
#[derive(Clone, Debug, PartialEq)]
struct FileChangeInfo {
    path: crate::schema::RelativePath,
    patch: LosslessString,
    additions: crate::schema::NonNegativeInt,
    deletions: crate::schema::NonNegativeInt,
}
impl DomainDecode for FileChangeInfo {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            path: object.field("path")?,
            patch: object.field("patch")?,
            additions: object.field("additions")?,
            deletions: object.field("deletions")?,
        })
    }
}
impl DomainEncode for FileChangeInfo {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("path", &self.path)
            .field("patch", &self.patch)
            .field("additions", &self.additions)
            .field("deletions", &self.deletions)
            .finish()
    }
}
macro_rules! event_data_type {
    ($name:ident, $event_type:literal, $version:expr) => {
        #[derive(Clone, Debug, PartialEq)]
        pub struct $name(pub Data);
        impl DomainDecode for $name {
            fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
                decode_event_data(&$event_type.into(), $version, value, path).map(Self)
            }
        }
        impl DomainEncode for $name {
            fn encode(&self) -> JsonValue {
                self.0.encode()
            }
        }
    };
}
event_data_type!(Created, "session.created", Some(2));
event_data_type!(AgentSelected, "session.agent.selected", Some(1));
event_data_type!(ModelSelected, "session.model.selected", Some(1));
event_data_type!(ProfileBound, "session.profile.bound", Some(1));
event_data_type!(GuardrailApproved, "session.guardrail.approved", Some(1));
event_data_type!(DaybreakSet, "session.daybreak.set", Some(1));
event_data_type!(Moved, "session.moved", Some(1));
event_data_type!(Renamed, "session.renamed", Some(1));
event_data_type!(UsageRecorded, "session.usage.recorded", Some(1));
event_data_type!(
    ProviderRequestRecorded,
    "session.provider.request.recorded",
    Some(1)
);
event_data_type!(UsageUpdated, "session.usage.updated", None);
event_data_type!(PredictionUpdated, "session.prediction.updated", None);
event_data_type!(DiagnosticsUpdated, "session.diagnostics.updated", None);
event_data_type!(Deleted, "session.deleted", Some(2));
event_data_type!(Archived, "session.archived", Some(2));
event_data_type!(Unarchived, "session.unarchived", Some(2));
event_data_type!(Pinned, "session.pinned", Some(1));
event_data_type!(Unpinned, "session.unpinned", Some(1));
event_data_type!(Forked, "session.forked", Some(2));
event_data_type!(InputPromoted, "session.input.promoted", Some(1));
event_data_type!(InputAdmitted, "session.input.admitted", Some(1));
event_data_type!(InputConsumed, "session.input.consumed", Some(1));
event_data_type!(InputDeleted, "session.input.deleted", Some(1));
event_data_type!(InputWithdrawn, "session.input.withdrawn", Some(1));
event_data_type!(InputSteered, "session.input.steered", Some(1));
event_data_type!(DotsAccessChanged, "session.dots.access.changed", Some(1));
event_data_type!(
    DotsExchangeCreated,
    "session.dots.exchange.created",
    Some(1)
);
event_data_type!(DotsBindingBound, "session.dots.binding.bound", Some(1));
event_data_type!(DotsBindingUnbound, "session.dots.binding.unbound", Some(1));
event_data_type!(
    DotsDeviceDelegationCreated,
    "session.dots.device-delegation.created",
    Some(1)
);
event_data_type!(
    DotsDeviceDelegationRevoked,
    "session.dots.device-delegation.revoked",
    Some(1)
);
event_data_type!(
    DotsDecisionSettled,
    "session.dots.decision.settled",
    Some(1)
);
event_data_type!(
    DotsInstructionRejected,
    "session.dots.instruction.rejected",
    Some(1)
);
event_data_type!(DotsReportRecorded, "session.dots.report.recorded", Some(1));
event_data_type!(
    ToolInvocationSettled,
    "session.tool.invocation-settled",
    Some(1)
);
event_data_type!(ExecutionStarted, "session.execution.started", Some(1));
event_data_type!(ExecutionSucceeded, "session.execution.succeeded", Some(1));
event_data_type!(ExecutionFailed, "session.execution.failed", Some(1));
event_data_type!(
    ExecutionInterrupted,
    "session.execution.interrupted",
    Some(1)
);
event_data_type!(WorkCompleted, "session.work.completed", Some(1));
event_data_type!(InstructionsUpdated, "session.instructions.updated", Some(2));
event_data_type!(ContextObserved, "session.context.observed", Some(1));
event_data_type!(TaskUpdated, "session.task.updated", Some(1));
event_data_type!(Synthetic, "session.synthetic", Some(1));
event_data_type!(SkillActivated, "session.skill.activated", Some(1));
event_data_type!(SkillDeactivated, "session.skill.deactivated", Some(1));
event_data_type!(CueDetected, "session.cue.detected", Some(1));
event_data_type!(RecallRecorded, "session.recall.recorded", Some(1));
event_data_type!(ShellStarted, "session.shell.started", Some(1));
event_data_type!(ShellEnded, "session.shell.ended", Some(1));
event_data_type!(StepStarted, "session.step.started", Some(1));
event_data_type!(StepEnded, "session.step.ended", Some(1));
event_data_type!(StepFailed, "session.step.failed", Some(1));
event_data_type!(TextStarted, "session.text.started", Some(1));
event_data_type!(TextDelta, "session.text.delta", None);
event_data_type!(TextEnded, "session.text.ended", Some(1));
event_data_type!(ReasoningStarted, "session.reasoning.started", Some(1));
event_data_type!(ReasoningDelta, "session.reasoning.delta", None);
event_data_type!(ReasoningEnded, "session.reasoning.ended", Some(1));
event_data_type!(ToolInputStarted, "session.tool.input.started", Some(1));
event_data_type!(ToolInputDelta, "session.tool.input.delta", None);
event_data_type!(ToolInputEnded, "session.tool.input.ended", Some(1));
event_data_type!(ToolCalled, "session.tool.called", Some(1));
event_data_type!(ToolProgress, "session.tool.progress", Some(1));
event_data_type!(ToolSuccess, "session.tool.success", Some(1));
event_data_type!(ToolFailed, "session.tool.failed", Some(1));
event_data_type!(FileChangeRecorded, "session.file-change.recorded", Some(1));
event_data_type!(RetryScheduled, "session.retry.scheduled", Some(1));
event_data_type!(CompactionAdmitted, "session.compaction.admitted", Some(2));
event_data_type!(CompactionStarted, "session.compaction.started", Some(2));
event_data_type!(CompactionDelta, "session.compaction.delta", None);
event_data_type!(CompactionEnded, "session.compaction.ended", Some(2));
event_data_type!(CompactionFailed, "session.compaction.failed", Some(2));
event_data_type!(RevertStaged, "session.revert.staged", Some(1));
event_data_type!(RevertCleared, "session.revert.cleared", Some(1));
event_data_type!(RevertCommitted, "session.revert.committed", Some(1));
event_data_type!(ReviewDeferred, "session.review.deferred", Some(1));
event_data_type!(ReviewDecided, "session.review.decided", Some(1));
event_data_type!(ReviewWithdrawn, "session.review.withdrawn", Some(1));
event_data_type!(ReviewConsumed, "session.review.consumed", Some(1));
event_data_type!(StepRerouted, "session.step.rerouted", Some(1));
event_data_type!(GuardrailDismissed, "session.guardrail.dismissed", Some(1));
event_data_type!(GuardrailEscalated, "session.guardrail.escalated", Some(1));
event_data_type!(GuardrailDecided, "session.guardrail.decided", Some(1));
event_data_type!(DecisionAudited, "session.decision.audited", Some(1));
event_data_type!(PermissionAssessed, "session.permission.assessed", Some(1));

#[derive(Clone, Debug, PartialEq)]
struct AuditedAnswer {
    name: LosslessString,
    kind: LosslessString,
    confidence: crate::guardrail::Confidence,
    answer: Option<bool>,
    choice: Option<JsonValue>,
    score: Option<crate::schema::NonNegativeInt>,
    length: Option<crate::schema::NonNegativeInt>,
}
impl DomainDecode for AuditedAnswer {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let JsonValue::Object(fields) = value else {
            return Err(path.error(DecodeErrorKind::Expected("audited answer")));
        };
        if fields.iter().any(|entry| {
            ![
                "name",
                "type",
                "confidence",
                "answer",
                "choice",
                "score",
                "length",
            ]
            .iter()
            .any(|known| entry.0.as_str() == Some(*known))
        }) {
            return Err(path.error(DecodeErrorKind::Expected("known audited answer fields")));
        }
        let kind: LosslessString = object.field("type")?;
        if !["predicate", "choice", "score", "text", "refusal"]
            .iter()
            .any(|known| kind.as_str() == Some(*known))
        {
            return Err(path
                .key("type")
                .error(DecodeErrorKind::Expected("audited answer type")));
        }
        let choice = match object.optional::<JsonValue>("choice")? {
            None => None,
            Some(JsonValue::Bool(value)) => Some(JsonValue::Bool(value)),
            Some(value) => {
                Some(crate::domain::bounded_string(&value, 0, 200, &path.key("choice"))?.encode())
            }
        };
        Ok(Self {
            name: crate::domain::bounded_string(
                &object.field::<JsonValue>("name")?,
                0,
                64,
                &path.key("name"),
            )?,
            kind,
            confidence: object.field("confidence")?,
            answer: object.optional("answer")?,
            choice,
            score: object.optional("score")?,
            length: object.optional("length")?,
        })
    }
}
impl DomainEncode for AuditedAnswer {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("name", &self.name)
            .field("type", &self.kind)
            .field("confidence", &self.confidence)
            .optional("answer", &self.answer)
            .optional("choice", &self.choice)
            .optional("score", &self.score)
            .optional("length", &self.length)
            .finish()
    }
}
