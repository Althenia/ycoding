use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder, domain, model, money, provider, provider_request::CostCoverage, provider_usage,
    schema::NonNegativeInt,
};

macro_rules! literal_type {($name:ident[$($value:literal),+])=>{#[derive(Clone,Debug,PartialEq)]pub struct $name(pub LosslessString);impl DomainDecode for $name{fn decode_at(v:&JsonValue,p:&JsonPath)->Result<Self,DecodeError>{domain::literal_enum(v,&[$($value),+],p).map(Self)}}impl DomainEncode for $name{fn encode(&self)->JsonValue{self.0.encode()}}}}
literal_type!(LocalScope["backend","location"]);
literal_type!(QuotaState["estimated","insufficient","exhausted","unlimited"]);
literal_type!(Method["quota-delta-ema","window-mean"]);
literal_type!(Evidence["low","medium","insufficient"]);
literal_type!(PaceVerdict["ahead","cutting-it-close","will-run-out"]);

#[derive(Clone, Debug, PartialEq)]
pub struct LocalRate {
    pub provider_id: provider::Id,
    pub profile: Option<model::ProfileName>,
    pub model_id: Option<model::Id>,
    pub observed_from: NonNegativeInt,
    pub observed_to: NonNegativeInt,
    pub tokens_per_minute: f64,
    pub tokens_per_minute5: Option<f64>,
    pub tokens_per_minute60: Option<f64>,
    pub estimated_usd_per_hour: Option<money::Usd>,
    pub coverage: CostCoverage,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Quota {
    pub provider_id: provider::Id,
    pub profile: Option<model::ProfileName>,
    pub window_id: LosslessString,
    pub unit: provider_usage::Unit,
    pub source: provider_usage::Source,
    pub stability: provider_usage::Stability,
    pub updated_at: NonNegativeInt,
    pub state: QuotaState,
    pub method: Option<Method>,
    pub evidence: Evidence,
    pub reason: Option<LosslessString>,
    pub observed_from: Option<NonNegativeInt>,
    pub observed_to: Option<NonNegativeInt>,
    pub rate_per_hour: Option<f64>,
    pub exhaustion_at: Option<NonNegativeInt>,
    pub projected_used_at_reset: Option<f64>,
    pub pace: Option<Pace>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Pace {
    pub verdict: PaceVerdict,
    pub projected_used_at_reset: f64,
    pub exhaustion_at: Option<NonNegativeInt>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub as_of: NonNegativeInt,
    pub local_scope: LocalScope,
    pub local_rates: Option<Vec<LocalRate>>,
    pub quotas: Option<Vec<Quota>>,
}

fn rate(
    object: &ObjectDecoder<'_>,
    path: &JsonPath,
    key: &str,
) -> Result<Option<f64>, DecodeError> {
    object
        .optional::<JsonValue>(key)?
        .map(|value| domain::number_range(&value, 0.0, f64::MAX, &path.key(key)))
        .transpose()
}

fn required_rate(
    object: &ObjectDecoder<'_>,
    path: &JsonPath,
    key: &str,
) -> Result<f64, DecodeError> {
    domain::number_range(
        &object.field::<JsonValue>(key)?,
        0.0,
        f64::MAX,
        &path.key(key),
    )
}

impl DomainDecode for LocalRate {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            provider_id: o.field("providerID")?,
            profile: o.optional("profile")?,
            model_id: o.optional("modelID")?,
            observed_from: o.field("observedFrom")?,
            observed_to: o.field("observedTo")?,
            tokens_per_minute: required_rate(&o, p, "tokensPerMinute")?,
            tokens_per_minute5: rate(&o, p, "tokensPerMinute5")?,
            tokens_per_minute60: rate(&o, p, "tokensPerMinute60")?,
            estimated_usd_per_hour: o.optional("estimatedUSDPerHour")?,
            coverage: o.field("coverage")?,
        })
    }
}

impl DomainEncode for LocalRate {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("providerID", &self.provider_id)
            .optional("profile", &self.profile)
            .optional("modelID", &self.model_id)
            .field("observedFrom", &self.observed_from)
            .field("observedTo", &self.observed_to)
            .field("tokensPerMinute", &self.tokens_per_minute)
            .optional("tokensPerMinute5", &self.tokens_per_minute5)
            .optional("tokensPerMinute60", &self.tokens_per_minute60)
            .optional("estimatedUSDPerHour", &self.estimated_usd_per_hour)
            .field("coverage", &self.coverage)
            .finish()
    }
}

impl DomainDecode for Quota {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            provider_id: o.field("providerID")?,
            profile: o.optional("profile")?,
            window_id: o.field("windowID")?,
            unit: o.field("unit")?,
            source: o.field("source")?,
            stability: o.field("stability")?,
            updated_at: o.field("updatedAt")?,
            state: o.field("state")?,
            method: o.optional("method")?,
            evidence: o.field("evidence")?,
            reason: o.optional("reason")?,
            observed_from: o.optional("observedFrom")?,
            observed_to: o.optional("observedTo")?,
            rate_per_hour: rate(&o, p, "ratePerHour")?,
            exhaustion_at: o.optional("exhaustionAt")?,
            projected_used_at_reset: rate(&o, p, "projectedUsedAtReset")?,
            pace: o.optional("pace")?,
        })
    }
}

impl DomainEncode for Quota {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("providerID", &self.provider_id)
            .optional("profile", &self.profile)
            .field("windowID", &self.window_id)
            .field("unit", &self.unit)
            .field("source", &self.source)
            .field("stability", &self.stability)
            .field("updatedAt", &self.updated_at)
            .field("state", &self.state)
            .optional("method", &self.method)
            .field("evidence", &self.evidence)
            .optional("reason", &self.reason)
            .optional("observedFrom", &self.observed_from)
            .optional("observedTo", &self.observed_to)
            .optional("ratePerHour", &self.rate_per_hour)
            .optional("exhaustionAt", &self.exhaustion_at)
            .optional("projectedUsedAtReset", &self.projected_used_at_reset)
            .optional("pace", &self.pace)
            .finish()
    }
}

impl DomainDecode for Pace {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            verdict: o.field("verdict")?,
            projected_used_at_reset: required_rate(&o, p, "projectedUsedAtReset")?,
            exhaustion_at: o.optional("exhaustionAt")?,
        })
    }
}

impl DomainEncode for Pace {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("verdict", &self.verdict)
            .field("projectedUsedAtReset", &self.projected_used_at_reset)
            .optional("exhaustionAt", &self.exhaustion_at)
            .finish()
    }
}

impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            as_of: o.field("asOf")?,
            local_scope: o.field("localScope")?,
            local_rates: o.optional("localRates")?,
            quotas: o.optional("quotas")?,
        })
    }
}

impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("asOf", &self.as_of)
            .field("localScope", &self.local_scope)
            .optional("localRates", &self.local_rates)
            .optional("quotas", &self.quotas)
            .finish()
    }
}
