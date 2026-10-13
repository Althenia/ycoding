use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder,
};
pub type Id = LosslessString;
pub type Name = LosslessString;
#[derive(Clone, Debug, PartialEq)]
pub struct Conflicts {
    pub skills: Vec<Id>,
    pub instructions: Vec<crate::instruction::Key>,
}
impl DomainDecode for Conflicts {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            skills: o.field("skills")?,
            instructions: o.field("instructions")?,
        })
    }
}
impl DomainEncode for Conflicts {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("skills", &self.skills)
            .field("instructions", &self.instructions)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct DirectorySource {
    pub path: crate::schema::AbsolutePath,
}
impl DomainDecode for DirectorySource {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("directory".into()))?;
        Ok(Self {
            path: o.field("path")?,
        })
    }
}
impl DomainEncode for DirectorySource {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("directory"))
            .field("path", &self.path)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct UrlSource {
    pub url: LosslessString,
}
impl DomainDecode for UrlSource {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("url".into()))?;
        Ok(Self {
            url: o.field("url")?,
        })
    }
}
impl DomainEncode for UrlSource {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("url"))
            .field("url", &self.url)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub id: Id,
    pub name: Name,
    pub description: Option<LosslessString>,
    pub slash: Option<bool>,
    pub autoinvoke: Option<bool>,
    pub conflicts: Option<Conflicts>,
    pub location: crate::schema::AbsolutePath,
    pub content: LosslessString,
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            name: o.field("name")?,
            description: o.optional("description")?,
            slash: o.optional("slash")?,
            autoinvoke: o.optional("autoinvoke")?,
            conflicts: o.optional("conflicts")?,
            location: o.field("location")?,
            content: o.field("content")?,
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("name", &self.name)
            .optional("description", &self.description)
            .optional("slash", &self.slash)
            .optional("autoinvoke", &self.autoinvoke)
            .optional("conflicts", &self.conflicts)
            .field("location", &self.location)
            .field("content", &self.content)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct EmbeddedSource {
    pub skill: Info,
}
impl DomainDecode for EmbeddedSource {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("embedded".into()))?;
        Ok(Self {
            skill: o.field("skill")?,
        })
    }
}
impl DomainEncode for EmbeddedSource {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &LosslessString::from("embedded"))
            .field("skill", &self.skill)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    Directory(DirectorySource),
    Url(UrlSource),
    Embedded(EmbeddedSource),
}
impl DomainDecode for Source {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        match o.tag("type", &["directory", "url", "embedded"])?.as_str() {
            Some("directory") => DirectorySource::decode_at(v, p).map(Self::Directory),
            Some("url") => UrlSource::decode_at(v, p).map(Self::Url),
            Some("embedded") => EmbeddedSource::decode_at(v, p).map(Self::Embedded),
            _ => Err(p.error(DecodeErrorKind::Expected("skill source"))),
        }
    }
}
impl DomainEncode for Source {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Directory(x) => x.encode(),
            Self::Url(x) => x.encode(),
            Self::Embedded(x) => x.encode(),
        }
    }
}
impl Source {
    pub fn equals(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Directory(a), Self::Directory(b)) => a.path == b.path,
            (Self::Url(a), Self::Url(b)) => a.url == b.url,
            (Self::Embedded(a), Self::Embedded(b)) => a.skill.id == b.skill.id,
            _ => false,
        }
    }
    pub fn key(&self) -> LosslessString {
        match self {
            Self::Directory(x) => {
                format!("directory:{}", x.path.as_lossless().as_str().unwrap_or("")).into()
            }
            Self::Url(x) => format!("url:{}", x.url.as_str().unwrap_or("")).into(),
            Self::Embedded(x) => format!("embedded:{}", x.skill.id.as_str().unwrap_or("")).into(),
        }
    }
}
