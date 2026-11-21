use crate::integration_id::IntegrationMethodId;
use crate::schema::NonNegativeInt;
use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct Id(pub LosslessString);
impl DomainDecode for Id {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        LosslessString::decode_at(v, p).map(Self)
    }
}
impl DomainEncode for Id {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct OAuth {
    pub method_id: IntegrationMethodId,
    pub refresh: LosslessString,
    pub access: LosslessString,
    pub expires: NonNegativeInt,
    pub metadata: Option<crate::JsonObject>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Key {
    pub key: LosslessString,
    pub metadata: Option<crate::JsonObject>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    OAuth(OAuth),
    Key(Key),
}
impl DomainDecode for OAuth {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("oauth".into()))?;
        Ok(Self {
            method_id: o.field("methodID")?,
            refresh: o.field("refresh")?,
            access: o.field("access")?,
            expires: o.field("expires")?,
            metadata: o.optional("metadata")?,
        })
    }
}
impl DomainEncode for OAuth {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "oauth")
            .field("methodID", &self.method_id)
            .field("refresh", &self.refresh)
            .field("access", &self.access)
            .field("expires", &self.expires)
            .optional("metadata", &self.metadata)
            .finish()
    }
}
impl DomainDecode for Key {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("key".into()))?;
        Ok(Self {
            key: o.field("key")?,
            metadata: o.optional("metadata")?,
        })
    }
}
impl DomainEncode for Key {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "key")
            .field("key", &self.key)
            .optional("metadata", &self.metadata)
            .finish()
    }
}
impl DomainDecode for Value {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        match o.tag("type", &["oauth", "key"])?.as_str() {
            Some("oauth") => Ok(Self::OAuth(OAuth {
                method_id: o.field("methodID")?,
                refresh: o.field("refresh")?,
                access: o.field("access")?,
                expires: o.field("expires")?,
                metadata: o.optional("metadata")?,
            })),
            Some("key") => Ok(Self::Key(Key {
                key: o.field("key")?,
                metadata: o.optional("metadata")?,
            })),
            _ => unreachable!(),
        }
    }
}
impl DomainEncode for Value {
    fn encode(&self) -> JsonValue {
        match self {
            Self::OAuth(x) => ObjectEncoder::new()
                .field("type", "oauth")
                .field("methodID", &x.method_id)
                .field("refresh", &x.refresh)
                .field("access", &x.access)
                .field("expires", &x.expires)
                .optional("metadata", &x.metadata)
                .finish(),
            Self::Key(x) => ObjectEncoder::new()
                .field("type", "key")
                .field("key", &x.key)
                .optional("metadata", &x.metadata)
                .finish(),
        }
    }
}
