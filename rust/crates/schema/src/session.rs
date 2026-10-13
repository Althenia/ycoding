use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
use crate::{
    agent, location, model, money, permission, project, schema, session_cache_diagnostics,
    session_message_id, session_revert, token_usage,
};
pub type Id = crate::session_id::SessionId;
pub type Event = crate::session_event::Event;
pub type Revert = session_revert::Revert;
pub type CacheMechanism = session_cache_diagnostics::Mechanism;
pub type ProviderCacheDiagnostics = session_cache_diagnostics::ProviderCache;
pub type CacheDiagnostics = session_cache_diagnostics::Info;
#[derive(Clone, Debug, PartialEq)]
pub struct Fork {
    pub session_id: Id,
    pub message_id: Option<session_message_id::Id>,
}
impl DomainDecode for Fork {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            message_id: o.optional("messageID")?,
        })
    }
}
impl DomainEncode for Fork {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .optional("messageID", &self.message_id)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Time {
    pub created: schema::DateTimeUtcFromMillis,
    pub updated: schema::DateTimeUtcFromMillis,
    pub active: Option<schema::DateTimeUtcFromMillis>,
    pub archived: Option<schema::DateTimeUtcFromMillis>,
    pub pinned: Option<schema::DateTimeUtcFromMillis>,
}
impl DomainDecode for Time {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            created: o.field("created")?,
            updated: o.field("updated")?,
            active: o.optional("active")?,
            archived: o.optional("archived")?,
            pinned: o.optional("pinned")?,
        })
    }
}
impl DomainEncode for Time {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("created", &self.created)
            .field("updated", &self.updated)
            .optional("active", &self.active)
            .optional("archived", &self.archived)
            .optional("pinned", &self.pinned)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub id: Id,
    pub parent_id: Option<Id>,
    pub fork: Option<Fork>,
    pub project_id: project::Id,
    pub agent: Option<agent::Id>,
    pub model: Option<model::Ref>,
    pub daybreak: Option<model::Daybreak>,
    pub permission_ceiling: Option<permission::Ruleset>,
    pub cost: money::Usd,
    pub tokens: token_usage::Info,
    pub time: Time,
    pub title: LosslessString,
    pub location: location::Ref,
    pub subpath: Option<schema::RelativePath>,
    pub revert: Option<Revert>,
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            parent_id: o.optional("parentID")?,
            fork: o.optional("fork")?,
            project_id: o.field("projectID")?,
            agent: o.optional("agent")?,
            model: o.optional("model")?,
            daybreak: o.optional("daybreak")?,
            permission_ceiling: o.optional("permissionCeiling")?,
            cost: o.field("cost")?,
            tokens: o.field("tokens")?,
            time: o.field("time")?,
            title: o.field("title")?,
            location: o.field("location")?,
            subpath: o.optional("subpath")?,
            revert: o.optional("revert")?,
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .optional("parentID", &self.parent_id)
            .optional("fork", &self.fork)
            .field("projectID", &self.project_id)
            .optional("agent", &self.agent)
            .optional("model", &self.model)
            .optional("daybreak", &self.daybreak)
            .optional("permissionCeiling", &self.permission_ceiling)
            .field("cost", &self.cost)
            .field("tokens", &self.tokens)
            .field("time", &self.time)
            .field("title", &self.title)
            .field("location", &self.location)
            .optional("subpath", &self.subpath)
            .optional("revert", &self.revert)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ListAnchor {
    pub id: Id,
    pub time: schema::Finite,
    pub direction: LosslessString,
}
impl DomainDecode for ListAnchor {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            time: o.field("time")?,
            direction: o.tag("direction", &["previous", "next"])?,
        })
    }
}
impl DomainEncode for ListAnchor {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("time", &self.time)
            .field("direction", &self.direction)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ModelSwitchBlocked {
    pub status: LosslessString,
    pub current_model: model::Ref,
    pub target_model: model::Ref,
    pub current_context_tokens: schema::NonNegativeInt,
    pub target_safe_input_tokens: schema::NonNegativeInt,
    pub required_reduction_tokens: schema::NonNegativeInt,
    pub maximum_safe_summary_boundary: Option<session_message_id::Id>,
    pub reason: LosslessString,
}
impl DomainDecode for ModelSwitchBlocked {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("status", &JsonValue::String("blocked".into()))?;
        o.literal(
            "reason",
            &JsonValue::String("context-window-exceeded".into()),
        )?;
        Ok(Self {
            status: "blocked".into(),
            current_model: o.field("currentModel")?,
            target_model: o.field("targetModel")?,
            current_context_tokens: o.field("currentContextTokens")?,
            target_safe_input_tokens: o.field("targetSafeInputTokens")?,
            required_reduction_tokens: o.field("requiredReductionTokens")?,
            maximum_safe_summary_boundary: o.optional("maximumSafeSummaryBoundary")?,
            reason: "context-window-exceeded".into(),
        })
    }
}
impl DomainEncode for ModelSwitchBlocked {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("status", &self.status)
            .field("currentModel", &self.current_model)
            .field("targetModel", &self.target_model)
            .field("currentContextTokens", &self.current_context_tokens)
            .field("targetSafeInputTokens", &self.target_safe_input_tokens)
            .field("requiredReductionTokens", &self.required_reduction_tokens)
            .optional(
                "maximumSafeSummaryBoundary",
                &self.maximum_safe_summary_boundary,
            )
            .field("reason", &self.reason)
            .finish()
    }
}
