use crate::domain;
use crate::money::UsdPerMillionTokens;
use crate::provider::{self, Id as ProviderId};
use crate::schema::{Finite, Int};
use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder,
};
fn nonempty(v: &JsonValue, p: &JsonPath) -> Result<LosslessString, DecodeError> {
    let s = LosslessString::decode_at(v, p)?;
    if s.is_empty() {
        Err(p.error(DecodeErrorKind::Length {
            minimum: 1,
            maximum: usize::MAX,
        }))
    } else {
        Ok(s)
    }
}
fn headers(v: &JsonValue, p: &JsonPath) -> Result<crate::JsonObject, DecodeError> {
    let object = crate::JsonObject::decode_at(v, p)?;
    for (key, value) in object.iter() {
        LosslessString::decode_at(value, &p.key(key.clone()))?;
    }
    Ok(object)
}
pub type Id = LosslessString;
pub type VariantId = LosslessString;
pub type Family = LosslessString;
#[derive(Clone, Debug, PartialEq)]
pub struct Daybreak(pub LosslessString);
#[derive(Clone, Debug, PartialEq)]
pub struct Api(pub LosslessString);
impl DomainDecode for Daybreak {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        domain::literal_enum(v, &["daybreak_blue", "daybreak_red"], p).map(Self)
    }
}
impl DomainEncode for Daybreak {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
impl DomainDecode for Api {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        domain::literal_enum(v, &["chat", "responses"], p).map(Self)
    }
}
impl DomainEncode for Api {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ProfileName(pub LosslessString);
impl DomainDecode for ProfileName {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        nonempty(v, p).map(Self)
    }
}
impl DomainEncode for ProfileName {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Ref {
    pub id: Id,
    pub provider_id: ProviderId,
    pub variant: Option<VariantId>,
    pub profile: Option<ProfileName>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Capabilities {
    pub tools: bool,
    pub input: Vec<LosslessString>,
    pub output: Vec<LosslessString>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Tier {
    pub size: Int,
}
#[derive(Clone, Debug, PartialEq)]
pub struct CacheCost {
    pub read: UsdPerMillionTokens,
    pub write: UsdPerMillionTokens,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Cost {
    pub tier: Option<Tier>,
    pub input: UsdPerMillionTokens,
    pub output: UsdPerMillionTokens,
    pub cache: CacheCost,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Variant {
    pub id: VariantId,
    pub settings: Option<provider::Settings>,
    pub headers: Option<crate::JsonObject>,
    pub body: Option<provider::Settings>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Profile {
    pub name: ProfileName,
    pub active: bool,
    pub variants: Option<Vec<VariantId>>,
    pub daybreak: Option<Vec<Daybreak>>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Time {
    pub released: Finite,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Limit {
    pub context: Int,
    pub input: Option<Int>,
    pub output: Int,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub id: Id,
    pub model_id: Id,
    pub provider_id: ProviderId,
    pub family: Option<Family>,
    pub name: LosslessString,
    pub package: Option<provider::Package>,
    pub settings: Option<provider::Settings>,
    pub headers: Option<crate::JsonObject>,
    pub body: Option<provider::Settings>,
    pub capabilities: Capabilities,
    pub variants: Vec<Variant>,
    pub profiles: Option<Vec<Profile>>,
    pub time: Time,
    pub cost: Vec<Cost>,
    pub status: LosslessString,
    pub enabled: bool,
    pub daybreak: Option<Vec<Daybreak>>,
    pub api: Option<Api>,
    pub limit: Limit,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Default {
    pub info: Info,
    pub selection: Ref,
}
impl DomainDecode for Ref {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            provider_id: o.field("providerID")?,
            variant: o.optional("variant")?,
            profile: o.optional("profile")?,
        })
    }
}
impl DomainEncode for Ref {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("providerID", &self.provider_id)
            .optional("variant", &self.variant)
            .optional("profile", &self.profile)
            .finish()
    }
}
impl DomainDecode for Capabilities {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            tools: o.field("tools")?,
            input: o.field("input")?,
            output: o.field("output")?,
        })
    }
}
impl DomainEncode for Capabilities {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("tools", &self.tools)
            .field("input", &self.input)
            .field("output", &self.output)
            .finish()
    }
}
impl DomainDecode for Tier {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("context".into()))?;
        Ok(Self {
            size: o.field("size")?,
        })
    }
}
impl DomainEncode for Tier {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "context")
            .field("size", &self.size)
            .finish()
    }
}
impl DomainDecode for CacheCost {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            read: o.field("read")?,
            write: o.field("write")?,
        })
    }
}
impl DomainEncode for CacheCost {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("read", &self.read)
            .field("write", &self.write)
            .finish()
    }
}
impl DomainDecode for Cost {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            tier: o.optional("tier")?,
            input: o.field("input")?,
            output: o.field("output")?,
            cache: o.field("cache")?,
        })
    }
}
impl DomainEncode for Cost {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("tier", &self.tier)
            .field("input", &self.input)
            .field("output", &self.output)
            .field("cache", &self.cache)
            .finish()
    }
}
impl DomainDecode for Variant {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            settings: o.optional("settings")?,
            headers: o
                .optional::<JsonValue>("headers")?
                .map(|v| headers(&v, &p.key("headers")))
                .transpose()?,
            body: o.optional("body")?,
        })
    }
}
impl DomainEncode for Variant {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .optional("settings", &self.settings)
            .optional("headers", &self.headers)
            .optional("body", &self.body)
            .finish()
    }
}
impl DomainDecode for Profile {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let daybreak = o.optional("daybreak")?;
        Ok(Self {
            name: ProfileName(nonempty(&o.field::<JsonValue>("name")?, &p.key("name"))?),
            active: o.field("active")?,
            variants: o.optional("variants")?,
            daybreak,
        })
    }
}
impl DomainEncode for Profile {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("name", &self.name)
            .field("active", &self.active)
            .optional("variants", &self.variants)
            .optional("daybreak", &self.daybreak)
            .finish()
    }
}
impl DomainDecode for Time {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            released: o.field("released")?,
        })
    }
}
impl DomainEncode for Time {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("released", &self.released)
            .finish()
    }
}
impl DomainDecode for Limit {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            context: o.field("context")?,
            input: o.optional("input")?,
            output: o.field("output")?,
        })
    }
}
impl DomainEncode for Limit {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("context", &self.context)
            .optional("input", &self.input)
            .field("output", &self.output)
            .finish()
    }
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            model_id: o.field("modelID")?,
            provider_id: o.field("providerID")?,
            family: o.optional("family")?,
            name: o.field("name")?,
            package: o.optional("package")?,
            settings: o.optional("settings")?,
            headers: o
                .optional::<JsonValue>("headers")?
                .map(|v| headers(&v, &p.key("headers")))
                .transpose()?,
            body: o.optional("body")?,
            capabilities: o.field("capabilities")?,
            variants: o.field("variants")?,
            profiles: o.optional("profiles")?,
            time: o.field("time")?,
            cost: o.field("cost")?,
            status: o.tag("status", &["alpha", "beta", "deprecated", "active"])?,
            enabled: o.field("enabled")?,
            daybreak: o.optional("daybreak")?,
            api: o.optional("api")?,
            limit: o.field("limit")?,
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("modelID", &self.model_id)
            .field("providerID", &self.provider_id)
            .optional("family", &self.family)
            .field("name", &self.name)
            .optional("package", &self.package)
            .optional("settings", &self.settings)
            .optional("headers", &self.headers)
            .optional("body", &self.body)
            .field("capabilities", &self.capabilities)
            .field("variants", &self.variants)
            .optional("profiles", &self.profiles)
            .field("time", &self.time)
            .field("cost", &self.cost)
            .field("status", &self.status)
            .field("enabled", &self.enabled)
            .optional("daybreak", &self.daybreak)
            .optional("api", &self.api)
            .field("limit", &self.limit)
            .finish()
    }
}
impl DomainDecode for Default {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            info: Info::decode_at(v, p)?,
            selection: Ref::decode_at(v, p)?,
        })
    }
}
impl DomainEncode for Default {
    fn encode(&self) -> JsonValue {
        let JsonValue::Object(mut object) = self.info.encode() else {
            unreachable!()
        };
        object.insert("selection".into(), self.selection.encode());
        JsonValue::Object(object)
    }
}
