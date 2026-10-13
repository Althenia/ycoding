use crate::schema::NonNegativeInt;
use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder, domain,
};
#[derive(Clone, Debug, PartialEq)]
pub struct Mention {
    pub start: f64,
    pub end: f64,
    pub text: LosslessString,
}
pub type PromptMention = Mention;
#[derive(Clone, Debug, PartialEq)]
pub struct ManagedAttachmentContent {
    pub digest: AttachmentDigest,
    pub bytes: NonNegativeInt,
    pub path: LosslessString,
}
#[derive(Clone, Debug, PartialEq)]
pub struct FileAttachment {
    pub content: ManagedAttachmentContent,
    pub mime: LosslessString,
    pub name: Option<LosslessString>,
    pub description: Option<LosslessString>,
    pub mention: Option<Mention>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct AgentAttachment {
    pub name: LosslessString,
    pub mention: Option<Mention>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Prompt {
    pub text: LosslessString,
    pub files: Option<Vec<FileAttachment>>,
    pub agents: Option<Vec<AgentAttachment>>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Base64(pub LosslessString);
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentDigest(pub LosslessString);
pub fn valid_base64(s: &LosslessString) -> bool {
    let Some(s) = s.as_str() else { return false };
    if s.len() % 4 != 0 {
        return false;
    }
    let bytes = s.as_bytes();
    let pad = bytes.iter().rev().take_while(|b| **b == b'=').count();
    if pad > 2 {
        return false;
    }
    bytes[..bytes.len() - pad]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || matches!(*b, b'+' | b'/'))
        && bytes[bytes.len() - pad..].iter().all(|b| *b == b'=')
        && ((pad == 0)
            || (pad == 1 && bytes.len() >= 4 && bytes[bytes.len() - 2] != b'=')
            || (pad == 2 && bytes.len() >= 4 && bytes[bytes.len() - 3] != b'='))
}
fn string_pattern(v: &JsonValue, p: &JsonPath, kind: &str) -> Result<LosslessString, DecodeError> {
    let s = LosslessString::decode_at(v, p)?;
    let valid = match kind {
        "digest" => s.as_str().is_some_and(|x| {
            x.len() == 64
                && x.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }),
        "path" => s.as_str().is_some_and(|x| {
            let Some(rest) = x.strip_prefix("attachments/sha256/") else {
                return false;
            };
            let Some((prefix, digest)) = rest.split_once('/') else {
                return false;
            };
            prefix.len() == 2
                && prefix
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                && digest.len() == 64
                && digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }),
        _ => false,
    };
    if valid {
        Ok(s)
    } else {
        Err(
            p.error(crate::DecodeErrorKind::Expected(if kind == "digest" {
                "lowercase sha256 digest"
            } else {
                "managed attachment path"
            })),
        )
    }
}
impl DomainDecode for Base64 {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let s = LosslessString::decode_at(v, p)?;
        if valid_base64(&s) {
            Ok(Self(s))
        } else {
            Err(p.error(crate::DecodeErrorKind::Expected("base64")))
        }
    }
}
impl DomainEncode for Base64 {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
impl DomainDecode for AttachmentDigest {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        string_pattern(v, p, "digest").map(Self)
    }
}
impl DomainEncode for AttachmentDigest {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
impl DomainDecode for Mention {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            start: domain::finite_number(&o.field::<JsonValue>("start")?, &p.key("start"))?,
            end: domain::finite_number(&o.field::<JsonValue>("end")?, &p.key("end"))?,
            text: o.field("text")?,
        })
    }
}
impl DomainEncode for Mention {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("start", &self.start)
            .field("end", &self.end)
            .field("text", &self.text)
            .finish()
    }
}
impl DomainDecode for ManagedAttachmentContent {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("managed".into()))?;
        Ok(Self {
            digest: AttachmentDigest::decode_at(
                &o.field::<JsonValue>("digest")?,
                &p.key("digest"),
            )?,
            bytes: o.field("bytes")?,
            path: string_pattern(&o.field::<JsonValue>("path")?, &p.key("path"), "path")?,
        })
    }
}
impl DomainEncode for ManagedAttachmentContent {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "managed")
            .field("digest", &self.digest)
            .field("bytes", &self.bytes)
            .field("path", &self.path)
            .finish()
    }
}
impl DomainDecode for FileAttachment {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            content: o.field("content")?,
            mime: o.field("mime")?,
            name: o.optional("name")?,
            description: o.optional("description")?,
            mention: o.optional("mention")?,
        })
    }
}
impl DomainEncode for FileAttachment {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("content", &self.content)
            .field("mime", &self.mime)
            .optional("name", &self.name)
            .optional("description", &self.description)
            .optional("mention", &self.mention)
            .finish()
    }
}
impl DomainDecode for AgentAttachment {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            name: o.field("name")?,
            mention: o.optional("mention")?,
        })
    }
}
impl DomainEncode for AgentAttachment {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("name", &self.name)
            .optional("mention", &self.mention)
            .finish()
    }
}
impl DomainDecode for Prompt {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            text: o.field("text")?,
            files: o.optional("files")?,
            agents: o.optional("agents")?,
        })
    }
}
impl DomainEncode for Prompt {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("text", &self.text)
            .optional("files", &self.files)
            .optional("agents", &self.agents)
            .finish()
    }
}
