use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder, domain,
};
use crate::{provider, schema::NonNegativeInt};
macro_rules! literal_type{($name:ident[$($item:literal),+])=>{#[derive(Clone,Debug,PartialEq)]pub struct $name(pub LosslessString);impl DomainDecode for $name{fn decode_at(v:&JsonValue,p:&JsonPath)->Result<Self,DecodeError>{domain::literal_enum(v,&[$($item),+],p).map(Self)}}impl DomainEncode for $name{fn encode(&self)->JsonValue{self.0.encode()}}}}
literal_type!(Status["available","stale","unsupported","unauthorized","error"]);
literal_type!(Source["provider_api","local_client_rpc","response_headers","response_stream","provider_internal_api","local_session"]);
literal_type!(Stability["stable","client_contract","observed","best_effort"]);
literal_type!(Unit["percent","usd","requests","tokens","count"]);
fn nonempty(v: &JsonValue, p: &JsonPath) -> Result<LosslessString, DecodeError> {
    let s = LosslessString::decode_at(v, p)?;
    if s.is_empty() {
        return Err(p.error(crate::DecodeErrorKind::Length {
            minimum: 1,
            maximum: usize::MAX,
        }));
    }
    Ok(s)
}
fn nonnegative(v: &JsonValue, p: &JsonPath) -> Result<f64, DecodeError> {
    domain::number_range(v, 0.0, f64::MAX, p)
}
#[derive(Clone, Debug, PartialEq)]
pub struct Window {
    pub id: LosslessString,
    pub label: LosslessString,
    pub unit: LosslessString,
    pub used: Option<f64>,
    pub limit: Option<f64>,
    pub remaining: Option<f64>,
    pub unlimited: Option<bool>,
    pub reset_at: Option<NonNegativeInt>,
    pub period_seconds: Option<NonNegativeInt>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub provider_id: provider::Id,
    pub label: LosslessString,
    pub profile: Option<LosslessString>,
    pub status: LosslessString,
    pub source: LosslessString,
    pub stability: LosslessString,
    pub updated_at: NonNegativeInt,
    pub windows: Vec<Window>,
    pub message: Option<LosslessString>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Observation {
    pub provider_id: provider::Id,
    pub label: LosslessString,
    pub source: LosslessString,
    pub stability: LosslessString,
    pub observed_at: NonNegativeInt,
    pub windows: Vec<Window>,
}
impl DomainDecode for Window {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let id: LosslessString = o.field("id")?;
        let label: LosslessString = o.field("label")?;
        let check = |value: Option<f64>, key: &str| -> Result<Option<f64>, DecodeError> {
            value
                .map(|number| nonnegative(&JsonValue::Number(number), &p.key(key)))
                .transpose()
        };
        Ok(Self {
            id: nonempty(&id.encode(), &p.key("id"))?,
            label: nonempty(&label.encode(), &p.key("label"))?,
            unit: o.tag("unit", &["percent", "usd", "requests", "tokens", "count"])?,
            used: check(o.optional("used")?, "used")?,
            limit: check(o.optional("limit")?, "limit")?,
            remaining: check(o.optional("remaining")?, "remaining")?,
            unlimited: o.optional("unlimited")?,
            reset_at: o.optional("resetAt")?,
            period_seconds: o.optional("periodSeconds")?,
        })
    }
}
impl DomainEncode for Window {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("label", &self.label)
            .field("unit", &self.unit)
            .optional("used", &self.used)
            .optional("limit", &self.limit)
            .optional("remaining", &self.remaining)
            .optional("unlimited", &self.unlimited)
            .optional("resetAt", &self.reset_at)
            .optional("periodSeconds", &self.period_seconds)
            .finish()
    }
}
impl DomainDecode for Snapshot {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let label: LosslessString = o.field("label")?;
        Ok(Self {
            provider_id: o.field("providerID")?,
            label: nonempty(&label.encode(), &p.key("label"))?,
            profile: o.optional("profile")?,
            status: o.tag(
                "status",
                &["available", "stale", "unsupported", "unauthorized", "error"],
            )?,
            source: o.tag(
                "source",
                &[
                    "provider_api",
                    "local_client_rpc",
                    "response_headers",
                    "response_stream",
                    "provider_internal_api",
                    "local_session",
                ],
            )?,
            stability: o.tag(
                "stability",
                &["stable", "client_contract", "observed", "best_effort"],
            )?,
            updated_at: o.field("updatedAt")?,
            windows: o.field("windows")?,
            message: o.optional("message")?,
        })
    }
}
impl DomainEncode for Snapshot {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("providerID", &self.provider_id)
            .field("label", &self.label)
            .optional("profile", &self.profile)
            .field("status", &self.status)
            .field("source", &self.source)
            .field("stability", &self.stability)
            .field("updatedAt", &self.updated_at)
            .field("windows", &self.windows)
            .optional("message", &self.message)
            .finish()
    }
}
impl DomainDecode for Observation {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let label: LosslessString = o.field("label")?;
        Ok(Self {
            provider_id: o.field("providerID")?,
            label: nonempty(&label.encode(), &p.key("label"))?,
            source: o.tag(
                "source",
                &[
                    "provider_api",
                    "local_client_rpc",
                    "response_headers",
                    "response_stream",
                    "provider_internal_api",
                    "local_session",
                ],
            )?,
            stability: o.tag(
                "stability",
                &["stable", "client_contract", "observed", "best_effort"],
            )?,
            observed_at: o.field("observedAt")?,
            windows: o.field("windows")?,
        })
    }
}
impl DomainEncode for Observation {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("providerID", &self.provider_id)
            .field("label", &self.label)
            .field("source", &self.source)
            .field("stability", &self.stability)
            .field("observedAt", &self.observed_at)
            .field("windows", &self.windows)
            .finish()
    }
}
