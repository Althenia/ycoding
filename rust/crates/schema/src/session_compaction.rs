use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct Id(LosslessString);
impl DomainDecode for Id {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> std::result::Result<Self, DecodeError> {
        crate::domain::branded_string(v, "cmp_", p).map(Self)
    }
}
impl DomainEncode for Id {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
crate::schema::literal_enum_type!(Trigger,{Consider=>"consider",Advised=>"advised",Mandatory=>"mandatory",Manual=>"manual"});
crate::schema::literal_enum_type!(FailureCode,{Cancelled=>"cancelled",Superseded=>"superseded",InvalidManifest=>"invalid_manifest",ProtectedStateChanged=>"protected_state_changed",ContextLimitUnresolved=>"context_limit_unresolved",MigrationFailed=>"migration_failed",ProviderFailed=>"provider_failed"});
#[derive(Clone, Debug, PartialEq)]
pub struct Boundary {
    pub message_id: crate::session_message_id::Id,
    pub seq: crate::schema::NonNegativeInt,
}
impl DomainDecode for Boundary {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> std::result::Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            message_id: o.field("messageID")?,
            seq: o.field("seq")?,
        })
    }
}
impl DomainEncode for Boundary {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("messageID", &self.message_id)
            .field("seq", &self.seq)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Metrics {
    pub excluded_messages: crate::schema::NonNegativeInt,
    pub excluded_parts: crate::schema::NonNegativeInt,
    pub input_tokens: crate::schema::NonNegativeInt,
    pub retained_tokens: crate::schema::NonNegativeInt,
}
impl DomainDecode for Metrics {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> std::result::Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            excluded_messages: o.field("excludedMessages")?,
            excluded_parts: o.field("excludedParts")?,
            input_tokens: o.field("inputTokens")?,
            retained_tokens: o.field("retainedTokens")?,
        })
    }
}
impl DomainEncode for Metrics {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("excludedMessages", &self.excluded_messages)
            .field("excludedParts", &self.excluded_parts)
            .field("inputTokens", &self.input_tokens)
            .field("retainedTokens", &self.retained_tokens)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Pressure {
    pub estimated_input_tokens: crate::schema::NonNegativeInt,
    pub safe_input_tokens: crate::schema::NonNegativeInt,
}
impl DomainDecode for Pressure {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> std::result::Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            estimated_input_tokens: o.field("estimatedInputTokens")?,
            safe_input_tokens: o.field("safeInputTokens")?,
        })
    }
}
impl DomainEncode for Pressure {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("estimatedInputTokens", &self.estimated_input_tokens)
            .field("safeInputTokens", &self.safe_input_tokens)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Admission {
    pub id: Id,
    pub session_id: crate::session_id::SessionId,
    pub trigger: Trigger,
    pub requested_through: Boundary,
    pub time_created: crate::schema::DateTimeUtcFromMillis,
}
impl DomainDecode for Admission {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> std::result::Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("status", &JsonValue::String("pending".into()))?;
        Ok(Self {
            id: o.field("id")?,
            session_id: o.field("sessionID")?,
            trigger: o.field("trigger")?,
            requested_through: o.field("requestedThrough")?,
            time_created: o.field("timeCreated")?,
        })
    }
}
impl DomainEncode for Admission {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("sessionID", &self.session_id)
            .field("trigger", &self.trigger)
            .field("status", &LosslessString::from("pending"))
            .field("requestedThrough", &self.requested_through)
            .field("timeCreated", &self.time_created)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Result {
    pub id: Id,
    pub session_id: crate::session_id::SessionId,
    pub trigger: Trigger,
    pub status: ResultStatus,
    pub requested_through: Boundary,
    pub time_created: crate::schema::DateTimeUtcFromMillis,
    pub failure: Option<FailureCode>,
}
crate::schema::literal_enum_type!(ResultStatus,{Ended=>"ended",Failed=>"failed"});
impl DomainDecode for Result {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> std::result::Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            session_id: o.field("sessionID")?,
            trigger: o.field("trigger")?,
            status: o.field("status")?,
            requested_through: o.field("requestedThrough")?,
            time_created: o.field("timeCreated")?,
            failure: o.optional("failure")?,
        })
    }
}
impl DomainEncode for Result {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("sessionID", &self.session_id)
            .field("trigger", &self.trigger)
            .field("status", &self.status)
            .field("requestedThrough", &self.requested_through)
            .field("timeCreated", &self.time_created)
            .optional("failure", &self.failure)
            .finish()
    }
}
crate::schema::literal_enum_type!(HistoryStatus,{Pending=>"pending",Running=>"running",Completed=>"completed",Failed=>"failed"});
#[derive(Clone, Debug, PartialEq)]
pub struct HistoryJob {
    pub job_id: Id,
    pub trigger: Trigger,
    pub status: HistoryStatus,
    pub created: crate::schema::NonNegativeInt,
    pub metrics: Option<Metrics>,
    pub code: Option<FailureCode>,
}
impl DomainDecode for HistoryJob {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> std::result::Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            job_id: o.field("jobID")?,
            trigger: o.field("trigger")?,
            status: o.field("status")?,
            created: o.field("created")?,
            metrics: o.optional("metrics")?,
            code: o.optional("code")?,
        })
    }
}
impl DomainEncode for HistoryJob {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("jobID", &self.job_id)
            .field("trigger", &self.trigger)
            .field("status", &self.status)
            .field("created", &self.created)
            .optional("metrics", &self.metrics)
            .optional("code", &self.code)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct History {
    pub data: Vec<HistoryJob>,
    pub truncated: bool,
    pub completed_before: crate::schema::NonNegativeInt,
    pub completed_count: crate::schema::NonNegativeInt,
    pub total_saved_tokens: crate::schema::Int,
}
impl DomainDecode for History {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> std::result::Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            data: o.field("data")?,
            truncated: o.field("truncated")?,
            completed_before: o.field("completedBefore")?,
            completed_count: o.field("completedCount")?,
            total_saved_tokens: o.field("totalSavedTokens")?,
        })
    }
}
impl DomainEncode for History {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("data", &self.data)
            .field("truncated", &self.truncated)
            .field("completedBefore", &self.completed_before)
            .field("completedCount", &self.completed_count)
            .field("totalSavedTokens", &self.total_saved_tokens)
            .finish()
    }
}
