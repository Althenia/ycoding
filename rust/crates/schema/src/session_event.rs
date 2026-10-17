use crate::session_message;
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
pub type ArtifactProvenance = session_message::ArtifactProvenance;
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
        durable("session.model.selected", 1),
        durable("session.daybreak.set", 1),
        durable("session.project-artifacts-ended", 1),
        durable("session.guardrail.dismissed", 1),
        durable("session.guardrail.escalated", 1),
        durable("session.guardrail.decided", 1),
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
        durable("session.input.consumed", 1),
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
            "session.review.deferred" | "session.guardrail.escalated" | "session.guardrail.decided",
            "confidence",
        ) => canonical::<guardrail::Confidence>(value, path),
        (
            "session.review.deferred" | "session.guardrail.escalated" | "session.guardrail.decided",
            "grades",
        ) => canonical::<Vec<guardrail::Grade>>(value, path),
        ("session.guardrail.escalated" | "session.guardrail.decided", "choice") => {
            canonical::<guardrail::DecisionChoice>(value, path)
        }
        ("session.guardrail.decided", "reply") => canonical::<guardrail::Reply>(value, path),
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
            ("location", false),
            ("parentID", true),
            ("agent", true),
            ("model", true),
            ("permissionCeiling", true),
            ("title", false),
            ("subpath", true),
            ("created", false),
        ],
        "session.agent.selected" => &[("sessionID", false), ("agent", false), ("artifact", true)],
        "session.model.selected" => &[("sessionID", false), ("model", false)],
        "session.profile.bound" => &[("sessionID", false), ("binding", true)],
        "session.guardrail.approved" => &[("sessionID", false), ("directories", false)],
        "session.daybreak.set" => &[("sessionID", false), ("daybreak", true)],
        "session.project-artifacts-ended" => &[
            ("sessionID", false),
            ("oldProjectID", false),
            ("newProjectID", false),
        ],
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
            ("cost", true),
            ("tokens", false),
            ("time", false),
            ("usageAnchor", true),
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
        "session.execution.failed" => &[("sessionID", false), ("error", false)],
        "session.execution.interrupted" => &[("sessionID", false), ("reason", false)],
        "session.work.completed" => &[
            ("sessionID", false),
            ("inputID", false),
            ("assistantMessageID", false),
        ],
        "session.instructions.updated" => &[("sessionID", false), ("delta", false)],
        "session.context.observed" => &[("sessionID", false), ("source", false), ("text", false)],
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
            ("conflicts", true),
            ("artifact", true),
        ],
        "session.skill.deactivated" => &[
            ("sessionID", false),
            ("id", false),
            ("activationMessageID", false),
            ("reason", false),
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
            ("choice", true),
            ("grades", true),
            ("confidence", true),
            ("ruleIDs", true),
            ("source", true),
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
            Some(&["session-state", "team-view", "step-limit"])
        }
        ("session.execution.interrupted", "reason") => Some(&["user", "shutdown", "superseded"]),
        ("session.skill.deactivated", "reason") => Some(&["conflict_resolved"]),
        ("session.review.withdrawn", "reason") => Some(&["reverted", "task_closed"]),
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
        _ => None,
    };
    if let Some(literals) = literals {
        return crate::domain::literal_enum(value, literals, path).map(|_| ());
    }
    match (event_type, key) {
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
        ("session.agent.selected", "artifact") | ("session.skill.activated", "artifact") => {
            validate_as::<ArtifactProvenance>(value, path)
        }
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
event_data_type!(
    ProjectArtifactsEnded,
    "session.project-artifacts-ended",
    Some(1)
);
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
