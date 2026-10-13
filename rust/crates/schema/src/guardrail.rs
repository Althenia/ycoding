use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonObject, JsonPath, JsonValue,
    LosslessString, ObjectDecoder, ObjectEncoder,
};
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct RequestId(LosslessString);
impl DomainDecode for RequestId {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        crate::domain::branded_string(v, "grq_", p).map(Self)
    }
}
impl DomainEncode for RequestId {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
crate::schema::literal_enum_type!(RuleSource,{Standard=>"standard",Custom=>"custom"});
crate::schema::literal_enum_type!(RuleDecision,{Allow=>"allow",Ask=>"ask",HardReview=>"hard_review",Deny=>"deny"});
crate::schema::literal_enum_type!(Decision,{Allow=>"allow",Ask=>"ask",Deny=>"deny",CapExceeded=>"cap_exceeded"});
#[derive(Clone, Debug, PartialEq)]
pub struct Rule {
    pub id: LosslessString,
    pub source: RuleSource,
    pub decision: RuleDecision,
    pub actions: Vec<LosslessString>,
    pub resources: Vec<LosslessString>,
    pub reason: LosslessString,
    pub priority: crate::schema::Int,
}
impl DomainDecode for Rule {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let id: LosslessString = o.field("id")?;
        let reason: LosslessString = o.field("reason")?;
        let actions: Vec<LosslessString> = o.field("actions")?;
        let resources: Vec<LosslessString> = o.field("resources")?;
        if id.is_empty() {
            return Err(p.key("id").error(DecodeErrorKind::Length {
                minimum: 1,
                maximum: usize::MAX,
            }));
        }
        if reason.is_empty() {
            return Err(p.key("reason").error(DecodeErrorKind::Length {
                minimum: 1,
                maximum: usize::MAX,
            }));
        }
        if actions.is_empty() {
            return Err(p.key("actions").error(DecodeErrorKind::Length {
                minimum: 1,
                maximum: usize::MAX,
            }));
        }
        if resources.is_empty() {
            return Err(p.key("resources").error(DecodeErrorKind::Length {
                minimum: 1,
                maximum: usize::MAX,
            }));
        }
        Ok(Self {
            id,
            source: o.field("source")?,
            decision: o.field("decision")?,
            actions,
            resources,
            reason,
            priority: o.field("priority")?,
        })
    }
}
impl DomainEncode for Rule {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("source", &self.source)
            .field("decision", &self.decision)
            .field("actions", &self.actions)
            .field("resources", &self.resources)
            .field("reason", &self.reason)
            .field("priority", &self.priority)
            .finish()
    }
}
pub type Ruleset = Vec<Rule>;
crate::schema::literal_enum_type!(Metric,{Confidence=>"confidence",Probability=>"probability"});
#[derive(Clone, Debug, PartialEq)]
pub struct Risk {
    pub level: crate::schema::Int,
    pub label: LosslessString,
    pub score: crate::schema::Finite,
    pub metric: Metric,
}
impl DomainDecode for Risk {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let level: crate::schema::Int = o.field("level")?;
        if !(0..=4).contains(&level.get()) {
            return Err(p.key("level").error(DecodeErrorKind::NumberRange {
                minimum: 0.0,
                maximum: 4.0,
                integer: true,
            }));
        }
        Ok(Self {
            level,
            label: o.field("label")?,
            score: o.field("score")?,
            metric: o.field("metric")?,
        })
    }
}
impl DomainEncode for Risk {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("level", &self.level)
            .field("label", &self.label)
            .field("score", &self.score)
            .field("metric", &self.metric)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub id: RequestId,
    pub root_session_id: crate::session_id::SessionId,
    pub session_id: crate::session_id::SessionId,
    pub action: LosslessString,
    pub resources: Vec<LosslessString>,
    pub rule_ids: Vec<LosslessString>,
    pub reason: LosslessString,
    pub standard: bool,
    pub hard_review: Option<bool>,
    pub risk: Option<Risk>,
    pub metadata: Option<JsonObject>,
}
impl DomainDecode for Request {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let metadata: Option<JsonObject> = o.optional("metadata")?;
        if let Some(map) = &metadata {
            for (k, val) in map.iter() {
                crate::domain::Json::decode_at(val, &p.key("metadata").key(k.clone()))?;
            }
        }
        Ok(Self {
            id: o.field("id")?,
            root_session_id: o.field("rootSessionID")?,
            session_id: o.field("sessionID")?,
            action: o.field("action")?,
            resources: o.field("resources")?,
            rule_ids: o.field("ruleIDs")?,
            reason: o.field("reason")?,
            standard: o.field("standard")?,
            hard_review: o.optional("hardReview")?,
            risk: o.optional("risk")?,
            metadata,
        })
    }
}
impl DomainEncode for Request {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("rootSessionID", &self.root_session_id)
            .field("sessionID", &self.session_id)
            .field("action", &self.action)
            .field("resources", &self.resources)
            .field("ruleIDs", &self.rule_ids)
            .field("reason", &self.reason)
            .field("standard", &self.standard)
            .optional("hardReview", &self.hard_review)
            .optional("risk", &self.risk)
            .optional("metadata", &self.metadata)
            .finish()
    }
}
crate::schema::literal_enum_type!(Reply,{Once=>"once",Always=>"always",Reject=>"reject"});
crate::schema::literal_enum_type!(CounterScope,{Session=>"session",Family=>"family"});
#[derive(Clone, Debug, PartialEq)]
pub struct Counter {
    pub id: LosslessString,
    pub current: crate::schema::NonNegativeInt,
    pub limit: crate::schema::NonNegativeInt,
    pub scope: CounterScope,
}
impl DomainDecode for Counter {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            current: o.field("current")?,
            limit: o.field("limit")?,
            scope: o.field("scope")?,
        })
    }
}
impl DomainEncode for Counter {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("current", &self.current)
            .field("limit", &self.limit)
            .field("scope", &self.scope)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Status {
    pub root_session_id: crate::session_id::SessionId,
    pub profile: LosslessString,
    pub custom_rules: crate::schema::NonNegativeInt,
    pub approvals: crate::schema::NonNegativeInt,
    pub blocked: crate::schema::NonNegativeInt,
    pub counters: Vec<Counter>,
    pub invalid_files: Vec<LosslessString>,
}
impl DomainDecode for Status {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            root_session_id: o.field("rootSessionID")?,
            profile: o.field("profile")?,
            custom_rules: o.field("customRules")?,
            approvals: o.field("approvals")?,
            blocked: o.field("blocked")?,
            counters: o.field("counters")?,
            invalid_files: o.field("invalidFiles")?,
        })
    }
}
impl DomainEncode for Status {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("rootSessionID", &self.root_session_id)
            .field("profile", &self.profile)
            .field("customRules", &self.custom_rules)
            .field("approvals", &self.approvals)
            .field("blocked", &self.blocked)
            .field("counters", &self.counters)
            .field("invalidFiles", &self.invalid_files)
            .finish()
    }
}
pub struct Asked;
impl crate::event::EventType for Asked {
    const TYPE: &'static str = "guardrail.asked";
    type Data = Request;
}
#[derive(Clone, Debug, PartialEq)]
pub struct RepliedData {
    pub root_session_id: crate::session_id::SessionId,
    pub session_id: crate::session_id::SessionId,
    pub request_id: RequestId,
    pub reply: Reply,
}
impl DomainDecode for RepliedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            root_session_id: o.field("rootSessionID")?,
            session_id: o.field("sessionID")?,
            request_id: o.field("requestID")?,
            reply: o.field("reply")?,
        })
    }
}
impl DomainEncode for RepliedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("rootSessionID", &self.root_session_id)
            .field("sessionID", &self.session_id)
            .field("requestID", &self.request_id)
            .field("reply", &self.reply)
            .finish()
    }
}
pub struct Replied;
impl crate::event::EventType for Replied {
    const TYPE: &'static str = "guardrail.replied";
    type Data = RepliedData;
}
#[derive(Clone, Debug, PartialEq)]
pub struct DecidedData {
    pub root_session_id: crate::session_id::SessionId,
    pub session_id: crate::session_id::SessionId,
    pub action: LosslessString,
    pub rule_ids: Vec<LosslessString>,
    pub decision: Decision,
}
impl DomainDecode for DecidedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            root_session_id: o.field("rootSessionID")?,
            session_id: o.field("sessionID")?,
            action: o.field("action")?,
            rule_ids: o.field("ruleIDs")?,
            decision: o.field("decision")?,
        })
    }
}
impl DomainEncode for DecidedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("rootSessionID", &self.root_session_id)
            .field("sessionID", &self.session_id)
            .field("action", &self.action)
            .field("ruleIDs", &self.rule_ids)
            .field("decision", &self.decision)
            .finish()
    }
}
pub struct Decided;
impl crate::event::EventType for Decided {
    const TYPE: &'static str = "guardrail.decided";
    type Data = DecidedData;
}
