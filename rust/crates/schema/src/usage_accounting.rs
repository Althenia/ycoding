use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder, domain, money,
    provider_request::{CostProvenance, Source},
    schema::NonNegativeInt,
    session_id::SessionId,
    session_message_id, token_usage, usage_anchor,
};
use std::{collections::HashSet, hash::Hash};

macro_rules! literal_type {($name:ident[$($value:literal),+])=>{#[derive(Clone,Debug,PartialEq)]pub struct $name(pub LosslessString);impl DomainDecode for $name{fn decode_at(v:&JsonValue,p:&JsonPath)->Result<Self,DecodeError>{domain::literal_enum(v,&[$($value),+],p).map(Self)}}impl DomainEncode for $name{fn encode(&self)->JsonValue{self.0.encode()}}}}
literal_type!(Attribution["complete","partial","unattributed"]);
literal_type!(History["retained","partial"]);
literal_type!(Status["settled","so-far"]);

#[derive(Clone, Debug, PartialEq)]
pub struct Cost {
    pub total: Option<money::Usd>,
    pub known: Option<money::Usd>,
    pub priced_requests: NonNegativeInt,
    pub unpriced_requests: NonNegativeInt,
    pub provenance: Option<CostProvenance>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Breakdown {
    pub requests: NonNegativeInt,
    pub tokens: token_usage::Info,
    pub cost: Cost,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Helper {
    pub source: Source,
    pub requests: NonNegativeInt,
    pub tokens: token_usage::Info,
    pub cost: Cost,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PromptInput {
    pub input_ids: Vec<session_message_id::Id>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TaskInput {
    pub session_ids: Vec<SessionId>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PromptCost {
    pub anchor: usage_anchor::Ref,
    pub status: Status,
    pub attribution: Attribution,
    pub history: History,
    pub total: Breakdown,
    pub main: Breakdown,
    pub children: Breakdown,
    pub helpers: Vec<Helper>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PromptCosts {
    pub units: Vec<PromptCost>,
    pub unattributed: Breakdown,
    pub history: History,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TaskCost {
    pub session_id: SessionId,
    pub usage_anchor: Option<usage_anchor::Ref>,
    pub status: Status,
    pub attribution: Attribution,
    pub history: History,
    pub total: Breakdown,
    pub main: Breakdown,
    pub children: Breakdown,
    pub helpers: Vec<Helper>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TaskCosts {
    pub tasks: Vec<TaskCost>,
    pub total: Breakdown,
    pub history: History,
}

impl DomainDecode for Cost {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let cost = Self {
            total: o.optional("total")?,
            known: o.optional("known")?,
            priced_requests: o.field("pricedRequests")?,
            unpriced_requests: o.field("unpricedRequests")?,
            provenance: o.optional("provenance")?,
        };
        let priced = cost.known.is_some();
        if priced != cost.provenance.is_some()
            || priced != (cost.priced_requests.get() != 0)
            || (cost.total.is_some()
                && !(cost.unpriced_requests.get() == 0 && cost.total == cost.known))
        {
            return Err(p.error(DecodeErrorKind::Expected(
                "known price coverage and a total only for completely priced requests",
            )));
        }
        Ok(cost)
    }
}

impl DomainEncode for Cost {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("total", &self.total)
            .optional("known", &self.known)
            .field("pricedRequests", &self.priced_requests)
            .field("unpricedRequests", &self.unpriced_requests)
            .optional("provenance", &self.provenance)
            .finish()
    }
}

impl DomainDecode for Breakdown {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            requests: o.field("requests")?,
            tokens: o.field("tokens")?,
            cost: o.field("cost")?,
        })
    }
}

impl DomainEncode for Breakdown {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("requests", &self.requests)
            .field("tokens", &self.tokens)
            .field("cost", &self.cost)
            .finish()
    }
}

impl DomainDecode for Helper {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            source: o.field("source")?,
            requests: o.field("requests")?,
            tokens: o.field("tokens")?,
            cost: o.field("cost")?,
        })
    }
}

impl DomainEncode for Helper {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("source", &self.source)
            .field("requests", &self.requests)
            .field("tokens", &self.tokens)
            .field("cost", &self.cost)
            .finish()
    }
}

fn distinct<T: DomainDecode + Eq + Hash>(
    o: &ObjectDecoder<'_>,
    p: &JsonPath,
    key: &str,
) -> Result<Vec<T>, DecodeError> {
    let values: Vec<T> = o.field(key)?;
    let path = p.key(key);
    if values.is_empty() || values.len() > 100 {
        return Err(path.error(DecodeErrorKind::Length {
            minimum: 1,
            maximum: 100,
        }));
    }
    let mut seen = HashSet::new();
    if !values.iter().all(|value| seen.insert(value)) {
        return Err(path.error(DecodeErrorKind::Expected("distinct identities")));
    }
    Ok(values)
}

impl DomainDecode for PromptInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            input_ids: distinct(&o, p, "inputIDs")?,
        })
    }
}

impl DomainEncode for PromptInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("inputIDs", &self.input_ids)
            .finish()
    }
}

impl DomainDecode for TaskInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_ids: distinct(&o, p, "sessionIDs")?,
        })
    }
}

impl DomainEncode for TaskInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionIDs", &self.session_ids)
            .finish()
    }
}

impl DomainDecode for PromptCost {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            anchor: o.field("anchor")?,
            status: o.field("status")?,
            attribution: o.field("attribution")?,
            history: o.field("history")?,
            total: o.field("total")?,
            main: o.field("main")?,
            children: o.field("children")?,
            helpers: o.field("helpers")?,
        })
    }
}

impl DomainEncode for PromptCost {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("anchor", &self.anchor)
            .field("status", &self.status)
            .field("attribution", &self.attribution)
            .field("history", &self.history)
            .field("total", &self.total)
            .field("main", &self.main)
            .field("children", &self.children)
            .field("helpers", &self.helpers)
            .finish()
    }
}

impl DomainDecode for PromptCosts {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            units: o.field("units")?,
            unattributed: o.field("unattributed")?,
            history: o.field("history")?,
        })
    }
}

impl DomainEncode for PromptCosts {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("units", &self.units)
            .field("unattributed", &self.unattributed)
            .field("history", &self.history)
            .finish()
    }
}

impl DomainDecode for TaskCost {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            usage_anchor: o.optional("usageAnchor")?,
            status: o.field("status")?,
            attribution: o.field("attribution")?,
            history: o.field("history")?,
            total: o.field("total")?,
            main: o.field("main")?,
            children: o.field("children")?,
            helpers: o.field("helpers")?,
        })
    }
}

impl DomainEncode for TaskCost {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .optional("usageAnchor", &self.usage_anchor)
            .field("status", &self.status)
            .field("attribution", &self.attribution)
            .field("history", &self.history)
            .field("total", &self.total)
            .field("main", &self.main)
            .field("children", &self.children)
            .field("helpers", &self.helpers)
            .finish()
    }
}

impl DomainDecode for TaskCosts {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            tasks: o.field("tasks")?,
            total: o.field("total")?,
            history: o.field("history")?,
        })
    }
}

impl DomainEncode for TaskCosts {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("tasks", &self.tasks)
            .field("total", &self.total)
            .field("history", &self.history)
            .finish()
    }
}
