use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder,
};
#[derive(Clone, Debug, PartialEq)]
pub struct LocalSource {
    pub path: crate::schema::AbsolutePath,
    pub description: Option<LosslessString>,
    pub hidden: Option<bool>,
}
impl DomainDecode for LocalSource {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("local".into()))?;
        Ok(Self {
            path: o.field("path")?,
            description: o.optional("description")?,
            hidden: o.optional("hidden")?,
        })
    }
}
impl DomainEncode for LocalSource {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("local"))
            .field("path", &self.path)
            .optional("description", &self.description)
            .optional("hidden", &self.hidden)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct GitSource {
    pub repository: LosslessString,
    pub branch: Option<LosslessString>,
    pub description: Option<LosslessString>,
    pub hidden: Option<bool>,
}
impl DomainDecode for GitSource {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("git".into()))?;
        Ok(Self {
            repository: o.field("repository")?,
            branch: o.optional("branch")?,
            description: o.optional("description")?,
            hidden: o.optional("hidden")?,
        })
    }
}
impl DomainEncode for GitSource {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("git"))
            .field("repository", &self.repository)
            .optional("branch", &self.branch)
            .optional("description", &self.description)
            .optional("hidden", &self.hidden)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    Local(LocalSource),
    Git(GitSource),
}
impl DomainDecode for Source {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        match o.tag("type", &["local", "git"])?.as_str() {
            Some("local") => LocalSource::decode_at(v, p).map(Self::Local),
            Some("git") => GitSource::decode_at(v, p).map(Self::Git),
            _ => Err(p.error(DecodeErrorKind::Expected("reference source"))),
        }
    }
}
impl DomainEncode for Source {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Local(x) => x.encode(),
            Self::Git(x) => x.encode(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub name: LosslessString,
    pub path: crate::schema::AbsolutePath,
    pub description: Option<LosslessString>,
    pub hidden: Option<bool>,
    pub source: Source,
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            name: o.field("name")?,
            path: o.field("path")?,
            description: o.optional("description")?,
            hidden: o.optional("hidden")?,
            source: o.field("source")?,
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("name", &self.name)
            .field("path", &self.path)
            .optional("description", &self.description)
            .optional("hidden", &self.hidden)
            .field("source", &self.source)
            .finish()
    }
}
