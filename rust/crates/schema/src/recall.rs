use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder, domain, schema::NonNegativeInt,
    session_message::ArtifactProvenance,
};

crate::schema::literal_enum_type!(CueKind,{Explicit=>"explicit",Command=>"command",Path=>"path",Symbol=>"symbol",ToolCall=>"tool_call",ToolResult=>"tool_result",ToolError=>"tool_error",Workspace=>"workspace",Lifecycle=>"lifecycle",Compaction=>"compaction",Recovery=>"recovery",MemoryRevision=>"memory_revision",SkillRevision=>"skill_revision"});
crate::schema::literal_enum_type!(Trigger,{Prompt=>"prompt",Cue=>"cue",Explicit=>"explicit",Compaction=>"compaction",Recovery=>"recovery",Delegation=>"delegation"});
crate::schema::literal_enum_type!(Kind,{Memory=>"memory",Skill=>"skill"});
crate::schema::literal_enum_type!(Method,{Explicit=>"explicit",Cue=>"cue",Exact=>"exact",Bm25=>"bm25",Semantic=>"semantic",Rrf=>"rrf"});
crate::schema::literal_enum_type!(Stage,{Candidate=>"candidate",Rejected=>"rejected",Selected=>"selected",Injected=>"injected",Restored=>"restored"});
crate::schema::literal_enum_type!(Rejection,{Denied=>"denied",Disabled=>"disabled",Stale=>"stale",OutOfScope=>"out_of_scope",OverBudget=>"over_budget",Duplicate=>"duplicate",Conflict=>"conflict",BelowThreshold=>"below_threshold",ManualOnly=>"manual_only",Missing=>"missing",Untrusted=>"untrusted"});
crate::schema::literal_enum_type!(Abstention,{NoMatch=>"no_match",BelowThreshold=>"below_threshold",ExplicitUnavailable=>"explicit_unavailable",OutOfBudget=>"out_of_budget",Offline=>"offline"});
crate::schema::literal_enum_type!(Outcome,{Injected=>"injected",Abstained=>"abstained",Restored=>"restored"});
crate::schema::literal_enum_type!(Trust,{Trusted=>"trusted",Unverified=>"unverified"});
crate::schema::literal_enum_type!(Freshness,{Fresh=>"fresh",Stale=>"stale",Unknown=>"unknown"});
crate::schema::literal_enum_type!(Lifecycle,{Active=>"active",Draft=>"draft",Deprecated=>"deprecated",Superseded=>"superseded",Archived=>"archived",Unknown=>"unknown"});

pub fn bounded(
    value: &JsonValue,
    minimum: usize,
    maximum: usize,
    path: &JsonPath,
) -> Result<LosslessString, DecodeError> {
    domain::bounded_string(value, minimum, maximum, path)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Scores {
    pub bm25: Option<f64>,
    pub semantic: Option<f64>,
    pub rrf: Option<f64>,
    pub rank: Option<NonNegativeInt>,
}
impl DomainDecode for Scores {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let finite = |key: &str| -> Result<Option<f64>, DecodeError> {
            o.optional::<JsonValue>(key)?
                .map(|value| domain::finite_number(&value, &p.key(key)))
                .transpose()
        };
        Ok(Self {
            bm25: finite("bm25")?,
            semantic: finite("semantic")?,
            rrf: finite("rrf")?,
            rank: o.optional("rank")?,
        })
    }
}
impl DomainEncode for Scores {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("bm25", &self.bm25)
            .optional("semantic", &self.semantic)
            .optional("rrf", &self.rrf)
            .optional("rank", &self.rank)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Source {
    pub id: LosslessString,
    pub revision: LosslessString,
}
impl DomainDecode for Source {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: bounded(&o.field("id")?, 1, 512, &p.key("id"))?,
            revision: bounded(&o.field("revision")?, 1, 128, &p.key("revision"))?,
        })
    }
}
impl DomainEncode for Source {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("revision", &self.revision)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Okf {
    pub kind: LosslessString,
    pub trust: Trust,
    pub freshness: Freshness,
    pub lifecycle: Lifecycle,
}
impl DomainDecode for Okf {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            kind: bounded(&o.field("type")?, 1, 128, &p.key("type"))?,
            trust: o.field("trust")?,
            freshness: o.field("freshness")?,
            lifecycle: o.field("lifecycle")?,
        })
    }
}
impl DomainEncode for Okf {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &self.kind)
            .field("trust", &self.trust)
            .field("freshness", &self.freshness)
            .field("lifecycle", &self.lifecycle)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub kind: Kind,
    pub id: LosslessString,
    pub stage: Stage,
    pub method: Method,
    pub scores: Option<Scores>,
    pub reason: LosslessString,
    pub rejection: Option<Rejection>,
    pub source: Source,
    pub okf: Option<Okf>,
    pub artifact: Option<ArtifactProvenance>,
    pub tokens: Option<NonNegativeInt>,
}
impl DomainDecode for Item {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            kind: o.field("kind")?,
            id: bounded(&o.field("id")?, 1, 256, &p.key("id"))?,
            stage: o.field("stage")?,
            method: o.field("method")?,
            scores: o.optional("scores")?,
            reason: bounded(&o.field("reason")?, 0, 200, &p.key("reason"))?,
            rejection: o.optional("rejection")?,
            source: o.field("source")?,
            okf: o.optional("okf")?,
            artifact: o.optional("artifact")?,
            tokens: o.optional("tokens")?,
        })
    }
}
impl DomainEncode for Item {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("kind", &self.kind)
            .field("id", &self.id)
            .field("stage", &self.stage)
            .field("method", &self.method)
            .optional("scores", &self.scores)
            .field("reason", &self.reason)
            .optional("rejection", &self.rejection)
            .field("source", &self.source)
            .optional("okf", &self.okf)
            .optional("artifact", &self.artifact)
            .optional("tokens", &self.tokens)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Items(pub Vec<Item>);
impl DomainDecode for Items {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let items = Vec::<Item>::decode_at(v, p)?;
        if items.len() > 64 {
            return Err(p.error(DecodeErrorKind::Expected("at most 64 recall items")));
        }
        Ok(Self(items))
    }
}
impl DomainEncode for Items {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Methods(pub Vec<Method>);
impl DomainDecode for Methods {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let methods = Vec::<Method>::decode_at(v, p)?;
        if methods.len() > 6 {
            return Err(p.error(DecodeErrorKind::Expected("at most 6 retrieval methods")));
        }
        Ok(Self(methods))
    }
}
impl DomainEncode for Methods {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
