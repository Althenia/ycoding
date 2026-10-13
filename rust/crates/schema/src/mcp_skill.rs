use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonObject, JsonPath, JsonValue,
    LosslessString, ObjectDecoder, ObjectEncoder,
};
pub const EXTENSION_ID: &str = "io.modelcontextprotocol/skills";
pub const LIST_METHOD: &str = "skills/list";
pub const GET_METHOD: &str = "skills/get";
pub const DIRECTORY_READ_METHOD: &str = "resources/directory/read";
pub const SKILL_MD: &str = "SKILL.md";
pub const MAX_RESOURCES_PER_SKILL: usize = 512;
pub const MAX_TOTAL_BYTES_PER_SKILL: i64 = 16 * 1024 * 1024;
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct Digest(LosslessString);
impl DomainDecode for Digest {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let s = LosslessString::decode_at(v, p)?;
        let ok = s.as_str().is_some_and(|x| {
            x.len() == 71
                && x.starts_with("sha256:")
                && x[7..]
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        });
        if ok {
            Ok(Self(s))
        } else {
            Err(p.error(DecodeErrorKind::Expected("sha256 digest")))
        }
    }
}
impl DomainEncode for Digest {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ResourceEntry {
    pub uri: LosslessString,
    pub digest: Digest,
    pub size: crate::schema::NonNegativeInt,
}
impl DomainDecode for ResourceEntry {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            uri: o.field("uri")?,
            digest: o.field("digest")?,
            size: o.field("size")?,
        })
    }
}
impl DomainEncode for ResourceEntry {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("uri", &self.uri)
            .field("digest", &self.digest)
            .field("size", &self.size)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Resources {
    Dynamic,
    Entries(Vec<ResourceEntry>),
}
impl DomainDecode for Resources {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        if matches!(v,JsonValue::String(x)if x.as_str()==Some("dynamic")) {
            return Ok(Self::Dynamic);
        }
        Vec::<ResourceEntry>::decode_at(v, p).map(Self::Entries)
    }
}
impl DomainEncode for Resources {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Dynamic => JsonValue::String("dynamic".into()),
            Self::Entries(x) => x.encode(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Frontmatter {
    pub name: LosslessString,
    pub description: LosslessString,
    pub extra: JsonObject,
}
impl DomainDecode for Frontmatter {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let name = o.field("name")?;
        let description = o.field("description")?;
        let JsonValue::Object(all) = v else {
            unreachable!()
        };
        let mut extra = JsonObject::new();
        for (k, val) in all.iter() {
            if k == &LosslessString::from("name") || k == &LosslessString::from("description") {
                continue;
            }
            crate::domain::Json::decode_at(val, &p.key(k.clone()))?;
            extra.insert(k.clone(), val.clone());
        }
        Ok(Self {
            name,
            description,
            extra,
        })
    }
}
impl DomainEncode for Frontmatter {
    fn encode(&self) -> JsonValue {
        let mut out = ObjectEncoder::new()
            .field("name", &self.name)
            .field("description", &self.description)
            .finish();
        if let JsonValue::Object(ref mut o) = out {
            for (k, v) in self.extra.iter() {
                o.insert(k.clone(), v.clone());
            }
        }
        out
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub server: LosslessString,
    pub uri: LosslessString,
    pub frontmatter: Frontmatter,
    pub resources: Resources,
}
impl DomainDecode for Entry {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            server: o.field("server")?,
            uri: o.field("uri")?,
            frontmatter: o.field("frontmatter")?,
            resources: o.field("resources")?,
        })
    }
}
impl DomainEncode for Entry {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("server", &self.server)
            .field("uri", &self.uri)
            .field("frontmatter", &self.frontmatter)
            .field("resources", &self.resources)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Capability {
    pub directory_read: Option<bool>,
}
impl DomainDecode for Capability {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            directory_read: ObjectDecoder::new(v, p)?.optional("directoryRead")?,
        })
    }
}
impl DomainEncode for Capability {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("directoryRead", &self.directory_read)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum File {
    Text {
        server: LosslessString,
        uri: LosslessString,
        size: crate::schema::NonNegativeInt,
        mime_type: Option<LosslessString>,
        text: LosslessString,
    },
    Blob {
        server: LosslessString,
        uri: LosslessString,
        size: crate::schema::NonNegativeInt,
        mime_type: Option<LosslessString>,
        blob: LosslessString,
    },
}
impl DomainDecode for File {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        if let Ok(text) = o.field::<LosslessString>("text") {
            return Ok(Self::Text {
                server: o.field("server")?,
                uri: o.field("uri")?,
                size: o.field("size")?,
                mime_type: o.optional("mimeType")?,
                text,
            });
        }
        Ok(Self::Blob {
            server: o.field("server")?,
            uri: o.field("uri")?,
            size: o.field("size")?,
            mime_type: o.optional("mimeType")?,
            blob: o.field("blob")?,
        })
    }
}
impl DomainEncode for File {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Text {
                server,
                uri,
                size,
                mime_type,
                text,
            } => ObjectEncoder::new()
                .field("server", server)
                .field("uri", uri)
                .field("size", size)
                .optional("mimeType", mime_type)
                .field("text", text)
                .finish(),
            Self::Blob {
                server,
                uri,
                size,
                mime_type,
                blob,
            } => ObjectEncoder::new()
                .field("server", server)
                .field("uri", uri)
                .field("size", size)
                .optional("mimeType", mime_type)
                .field("blob", blob)
                .finish(),
        }
    }
}
crate::schema::literal_enum_type!(Reason,{DecodeError=>"decode-error",Dynamic=>"dynamic",ExtensionUnsupported=>"extension-unsupported",MalformedUri=>"malformed-uri",NotFound=>"not-found",OriginMismatch=>"origin-mismatch",UriMismatch=>"uri-mismatch",NameMismatch=>"name-mismatch",MissingSkillMd=>"missing-skill-md",DuplicateResource=>"duplicate-resource",ResourceOutsideSkill=>"resource-outside-skill",LimitResources=>"limit-resources",LimitBytes=>"limit-bytes",UnlistedResource=>"unlisted-resource",SizeMismatch=>"size-mismatch",DigestMismatch=>"digest-mismatch",FrontmatterMismatch=>"frontmatter-mismatch",FrontmatterMissing=>"frontmatter-missing"});
