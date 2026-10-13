use crate::integration::Id as IntegrationId;
use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct Id(pub LosslessString);
impl DomainDecode for Id {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        LosslessString::decode_at(value, path).map(Self)
    }
}
impl DomainEncode for Id {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct IntegrationRef {
    pub provider_id: Id,
    pub integration_id: IntegrationId,
}
impl DomainDecode for IntegrationRef {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            provider_id: o.field("providerID")?,
            integration_id: o.field("integrationID")?,
        })
    }
}
impl DomainEncode for IntegrationRef {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("providerID", &self.provider_id)
            .field("integrationID", &self.integration_id)
            .finish()
    }
}

pub type Package = LosslessString;
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Settings(pub crate::JsonObject);
impl DomainDecode for Settings {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let object = crate::JsonObject::decode_at(v, p)?;
        for (key, value) in object.iter() {
            crate::domain::Json::decode_at(value, &p.key(key.clone()))?;
        }
        Ok(Self(object))
    }
}
impl DomainEncode for Settings {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
fn settings(v: &JsonValue, p: &JsonPath) -> Result<Settings, DecodeError> {
    Settings::decode_at(v, p)
}
fn headers(v: &JsonValue, p: &JsonPath) -> Result<crate::JsonObject, DecodeError> {
    let object = crate::JsonObject::decode_at(v, p)?;
    for (key, value) in object.iter() {
        LosslessString::decode_at(value, &p.key(key.clone()))?;
    }
    Ok(object)
}
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub settings: Settings,
    pub headers: crate::JsonObject,
    pub body: Settings,
}
impl DomainDecode for Request {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            settings: settings(&o.field::<JsonValue>("settings")?, &p.key("settings"))?,
            headers: headers(&o.field::<JsonValue>("headers")?, &p.key("headers"))?,
            body: settings(&o.field::<JsonValue>("body")?, &p.key("body"))?,
        })
    }
}
impl DomainEncode for Request {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("settings", &self.settings)
            .field("headers", &self.headers)
            .field("body", &self.body)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Overlays {
    pub settings: Option<Settings>,
    pub headers: Option<crate::JsonObject>,
    pub body: Option<Settings>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub id: Id,
    pub integration_id: Option<IntegrationId>,
    pub name: LosslessString,
    pub disabled: Option<bool>,
    pub package: Package,
    pub overlays: Overlays,
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            integration_id: o.optional("integrationID")?,
            name: o.field("name")?,
            disabled: o.optional("disabled")?,
            package: o.field("package")?,
            overlays: Overlays {
                settings: o
                    .optional::<JsonValue>("settings")?
                    .map(|v| settings(&v, &p.key("settings")))
                    .transpose()?,
                headers: o
                    .optional::<JsonValue>("headers")?
                    .map(|v| headers(&v, &p.key("headers")))
                    .transpose()?,
                body: o
                    .optional::<JsonValue>("body")?
                    .map(|v| settings(&v, &p.key("body")))
                    .transpose()?,
            },
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .optional("integrationID", &self.integration_id)
            .field("name", &self.name)
            .optional("disabled", &self.disabled)
            .field("package", &self.package)
            .optional("settings", &self.overlays.settings)
            .optional("headers", &self.overlays.headers)
            .optional("body", &self.overlays.body)
            .finish()
    }
}
