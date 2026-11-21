use crate::credential::Id as CredentialId;
use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};

crate::schema::literal_enum_type!(CredentialKind,{Oauth=>"oauth",Key=>"key"});
crate::schema::literal_enum_type!(CredentialStatus,{Connected=>"connected",Expired=>"expired",RefreshFailed=>"refresh_failed"});
#[derive(Clone, Debug, PartialEq)]
pub struct CredentialInfo {
    pub id: CredentialId,
    pub label: LosslessString,
    pub active: bool,
    pub kind: Option<CredentialKind>,
    pub status: Option<CredentialStatus>,
    pub message: Option<LosslessString>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct EnvInfo {
    pub name: LosslessString,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Info {
    Credential(CredentialInfo),
    Env(EnvInfo),
}
impl DomainDecode for CredentialInfo {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("credential".into()))?;
        Ok(Self {
            id: o.field("id")?,
            label: o.field("label")?,
            active: o.field("active")?,
            kind: o.optional("kind")?,
            status: o.optional("status")?,
            message: o.optional("message")?,
        })
    }
}
impl DomainEncode for CredentialInfo {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "credential")
            .field("id", &self.id)
            .field("label", &self.label)
            .field("active", &self.active)
            .optional("kind", &self.kind)
            .optional("status", &self.status)
            .optional("message", &self.message)
            .finish()
    }
}
impl DomainDecode for EnvInfo {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("env".into()))?;
        Ok(Self {
            name: o.field("name")?,
        })
    }
}
impl DomainEncode for EnvInfo {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "env")
            .field("name", &self.name)
            .finish()
    }
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        match o.tag("type", &["credential", "env"])?.as_str() {
            Some("credential") => CredentialInfo::decode_at(v, p).map(Self::Credential),
            Some("env") => EnvInfo::decode_at(v, p).map(Self::Env),
            _ => unreachable!(),
        }
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Credential(value) => value.encode(),
            Self::Env(value) => value.encode(),
        }
    }
}
