use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder, agent, domain, model, provider, schema::NonNegativeInt,
};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Id(pub LosslessString);
impl DomainDecode for Id {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        domain::branded_string(value, "inc_", path).map(Self)
    }
}
impl DomainEncode for Id {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}

macro_rules! literal_type {
    ($name:ident[$($value:literal),+]) => {
        #[derive(Clone, Debug, PartialEq, Eq)]
        pub struct $name(pub LosslessString);
        impl DomainDecode for $name {
            fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
                domain::literal_enum(value, &[$($value),+], path).map(Self)
            }
        }
        impl DomainEncode for $name {
            fn encode(&self) -> JsonValue {
                self.0.encode()
            }
        }
    };
}
literal_type!(Kind["fallback", "guardrail-escalated", "guardrail-rejected"]);
literal_type!(DecidedBy["decision-model", "human"]);
literal_type!(Group["model", "agent"]);

#[derive(Clone, Debug, PartialEq)]
pub struct ReportRow {
    pub provider_id: provider::Id,
    pub model_id: model::Id,
    pub agent: Option<agent::Id>,
    pub fallbacks: NonNegativeInt,
    pub escalated: NonNegativeInt,
    pub rejected: NonNegativeInt,
    pub last: NonNegativeInt,
}
impl DomainDecode for ReportRow {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            provider_id: object.field("providerID")?,
            model_id: object.field("modelID")?,
            agent: object.optional("agent")?,
            fallbacks: object.field("fallbacks")?,
            escalated: object.field("escalated")?,
            rejected: object.field("rejected")?,
            last: object.field("last")?,
        })
    }
}
impl DomainEncode for ReportRow {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("providerID", &self.provider_id)
            .field("modelID", &self.model_id)
            .optional("agent", &self.agent)
            .field("fallbacks", &self.fallbacks)
            .field("escalated", &self.escalated)
            .field("rejected", &self.rejected)
            .field("last", &self.last)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub rows: Vec<ReportRow>,
    pub groups: NonNegativeInt,
}
impl DomainDecode for Report {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            rows: object.field("rows")?,
            groups: object.field("groups")?,
        })
    }
}
impl DomainEncode for Report {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("rows", &self.rows)
            .field("groups", &self.groups)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub id: Id,
    pub time: NonNegativeInt,
    pub kind: Kind,
    pub category: LosslessString,
    pub rule_ids: Vec<LosslessString>,
    pub agent: agent::Id,
    pub variant: Option<model::VariantId>,
    pub profile: Option<model::ProfileName>,
    pub target: Option<model::Ref>,
    pub decided_by: Option<DecidedBy>,
}
impl DomainDecode for Item {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            id: object.field("id")?,
            time: object.field("time")?,
            kind: object.field("kind")?,
            category: object.field("category")?,
            rule_ids: object.field("ruleIDs")?,
            agent: object.field("agent")?,
            variant: object.optional("variant")?,
            profile: object.optional("profile")?,
            target: object.optional("target")?,
            decided_by: object.optional("decidedBy")?,
        })
    }
}
impl DomainEncode for Item {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("time", &self.time)
            .field("kind", &self.kind)
            .field("category", &self.category)
            .field("ruleIDs", &self.rule_ids)
            .field("agent", &self.agent)
            .optional("variant", &self.variant)
            .optional("profile", &self.profile)
            .optional("target", &self.target)
            .optional("decidedBy", &self.decided_by)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Recent {
    pub items: Vec<Item>,
}
impl DomainDecode for Recent {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            items: ObjectDecoder::new(value, path)?.field("items")?,
        })
    }
}
impl DomainEncode for Recent {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().field("items", &self.items).finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Guidance {
    pub text: Option<LosslessString>,
    pub cleared_at: Option<NonNegativeInt>,
    pub enabled: bool,
}
impl DomainDecode for Guidance {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            text: object.optional("text")?,
            cleared_at: object.optional("clearedAt")?,
            enabled: object.field("enabled")?,
        })
    }
}
impl DomainEncode for Guidance {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("text", &self.text)
            .optional("clearedAt", &self.cleared_at)
            .field("enabled", &self.enabled)
            .finish()
    }
}
