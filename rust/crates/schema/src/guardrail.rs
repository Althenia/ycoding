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
#[derive(Clone, Debug, PartialEq)]
pub struct Source {
    pub message_id: crate::session_message_id::Id,
    pub call_id: LosslessString,
}
impl DomainDecode for Source {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            message_id: o.field("messageID")?,
            call_id: o.field("callID")?,
        })
    }
}
impl DomainEncode for Source {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("messageID", &self.message_id)
            .field("callID", &self.call_id)
            .finish()
    }
}
crate::schema::literal_enum_type!(DecisionChoice,{ApproveAll=>"approve_all",Approve=>"approve",Reject=>"reject",Escalate=>"escalate"});
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Confidence(f64);
impl Confidence {
    pub fn new(value: f64) -> Result<Self, DecodeError> {
        Self::decode_at(&JsonValue::Number(value), &JsonPath::default())
    }
    pub fn get(self) -> f64 {
        self.0
    }
}
impl DomainDecode for Confidence {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        crate::domain::number_range(v, 0.0, 1.0, p).map(Self)
    }
}
impl DomainEncode for Confidence {
    fn encode(&self) -> JsonValue {
        JsonValue::Number(self.0)
    }
}
pub(crate) fn has_non_whitespace(text: &LosslessString) -> bool {
    text.code_units().any(|unit| {
        !matches!(
            unit,
            0x0009..=0x000d
                | 0x0020
                | 0x00a0
                | 0x1680
                | 0x2000..=0x200a
                | 0x2028
                | 0x2029
                | 0x202f
                | 0x205f
                | 0x3000
                | 0xfeff
        )
    })
}
#[derive(Clone, Debug, PartialEq)]
pub struct Grade {
    pub choice: DecisionChoice,
    pub confidence: Confidence,
    pub evidence: LosslessString,
}
impl DomainDecode for Grade {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let path = p.key("evidence");
        let evidence =
            crate::domain::bounded_string(&o.field::<JsonValue>("evidence")?, 0, 500, &path)?;
        if !has_non_whitespace(&evidence) {
            return Err(path.error(DecodeErrorKind::Expected("non-blank evidence")));
        }
        Ok(Self {
            choice: o.field("choice")?,
            confidence: o.field("confidence")?,
            evidence,
        })
    }
}
impl DomainEncode for Grade {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("choice", &self.choice)
            .field("confidence", &self.confidence)
            .field("evidence", &self.evidence)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Escalation {
    pub choice: Option<DecisionChoice>,
    pub confidence: Option<Confidence>,
    pub grades: Option<Vec<Grade>>,
}
impl DomainDecode for Escalation {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            choice: o.optional("choice")?,
            confidence: o.optional("confidence")?,
            grades: o.optional("grades")?,
        })
    }
}
impl DomainEncode for Escalation {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("choice", &self.choice)
            .optional("confidence", &self.confidence)
            .optional("grades", &self.grades)
            .finish()
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
    pub escalation: Option<Escalation>,
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
            escalation: o.optional("escalation")?,
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
            .optional("escalation", &self.escalation)
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
    pub dismissals: Option<Vec<Dismissal>>,
    pub decisions: Option<Vec<StatusDecision>>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Dismissal {
    pub session_id: crate::session_id::SessionId,
    pub created: crate::schema::NonNegativeInt,
    pub event_id: LosslessString,
    pub rule_id: LosslessString,
    pub confidence: f64,
    pub source: Option<Source>,
}
impl DomainDecode for Dismissal {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            created: o.field("created")?,
            event_id: o.field("eventID")?,
            rule_id: o.field("ruleID")?,
            confidence: crate::domain::number_range(
                &o.field::<JsonValue>("confidence")?,
                0.9,
                1.0,
                &p.key("confidence"),
            )?,
            source: o.optional("source")?,
        })
    }
}
impl DomainEncode for Dismissal {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("created", &self.created)
            .field("eventID", &self.event_id)
            .field("ruleID", &self.rule_id)
            .field("confidence", &self.confidence)
            .optional("source", &self.source)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct StatusDecision {
    pub session_id: crate::session_id::SessionId,
    pub created: crate::schema::NonNegativeInt,
    pub request_id: LosslessString,
    pub reply: Reply,
    pub choice: Option<DecisionChoice>,
    pub confidence: Option<Confidence>,
    pub grades: Option<Vec<Grade>>,
    pub rule_ids: Option<Vec<LosslessString>>,
    pub source: Option<Source>,
}
impl DomainDecode for StatusDecision {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            created: o.field("created")?,
            request_id: o.field("requestID")?,
            reply: o.field("reply")?,
            choice: o.optional("choice")?,
            confidence: o.optional("confidence")?,
            grades: o.optional("grades")?,
            rule_ids: o.optional("ruleIDs")?,
            source: o.optional("source")?,
        })
    }
}
impl DomainEncode for StatusDecision {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("created", &self.created)
            .field("requestID", &self.request_id)
            .field("reply", &self.reply)
            .optional("choice", &self.choice)
            .optional("confidence", &self.confidence)
            .optional("grades", &self.grades)
            .optional("ruleIDs", &self.rule_ids)
            .optional("source", &self.source)
            .finish()
    }
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
            dismissals: o.optional("dismissals")?,
            decisions: o.optional("decisions")?,
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
            .optional("dismissals", &self.dismissals)
            .optional("decisions", &self.decisions)
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
    pub decided_by: Option<DecidedBy>,
    pub choice: Option<DecisionChoice>,
    pub confidence: Option<Confidence>,
    pub grades: Option<Vec<Grade>>,
}
crate::schema::literal_enum_type!(DecidedBy,{DecisionModel=>"decision-model"});
impl DomainDecode for RepliedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            root_session_id: o.field("rootSessionID")?,
            session_id: o.field("sessionID")?,
            request_id: o.field("requestID")?,
            reply: o.field("reply")?,
            decided_by: o.optional("decidedBy")?,
            choice: o.optional("choice")?,
            confidence: o.optional("confidence")?,
            grades: o.optional("grades")?,
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
            .optional("decidedBy", &self.decided_by)
            .optional("choice", &self.choice)
            .optional("confidence", &self.confidence)
            .optional("grades", &self.grades)
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
#[derive(Clone, Debug, PartialEq)]
pub struct DeferredData {
    pub root_session_id: crate::session_id::SessionId,
    pub session_id: crate::session_id::SessionId,
    pub request_id: RequestId,
    pub item_id: crate::session_review::Id,
}
impl DomainDecode for DeferredData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            root_session_id: o.field("rootSessionID")?,
            session_id: o.field("sessionID")?,
            request_id: o.field("requestID")?,
            item_id: o.field("itemID")?,
        })
    }
}
impl DomainEncode for DeferredData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("rootSessionID", &self.root_session_id)
            .field("sessionID", &self.session_id)
            .field("requestID", &self.request_id)
            .field("itemID", &self.item_id)
            .finish()
    }
}
pub struct Deferred;
impl crate::event::EventType for Deferred {
    const TYPE: &'static str = "guardrail.deferred";
    type Data = DeferredData;
}
