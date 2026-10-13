use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
#[derive(Clone, Debug, PartialEq)]
pub struct ProviderMetadata(pub crate::JsonObject);
impl DomainDecode for ProviderMetadata {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let object = crate::JsonObject::decode_at(v, p)?;
        for (key, value) in object.iter() {
            crate::JsonObject::decode_at(value, &p.key(key.clone()))?;
        }
        Ok(Self(object))
    }
}
impl DomainEncode for ProviderMetadata {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ToolTextContent {
    pub text: LosslessString,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ToolFileContent {
    pub uri: LosslessString,
    pub mime: LosslessString,
    pub name: Option<LosslessString>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum ToolContent {
    Text(ToolTextContent),
    File(ToolFileContent),
}
#[derive(Clone, Debug, PartialEq)]
pub struct FinishReason(pub LosslessString);
impl DomainDecode for FinishReason {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let s = LosslessString::decode_at(v, p)?;
        if [
            "stop",
            "length",
            "tool-calls",
            "content-filter",
            "error",
            "unknown",
        ]
        .contains(&s.as_str().unwrap_or(""))
        {
            Ok(Self(s))
        } else {
            Err(p.error(crate::DecodeErrorKind::Literal(
                [
                    "stop",
                    "length",
                    "tool-calls",
                    "content-filter",
                    "error",
                    "unknown",
                ]
                .iter()
                .map(|s| JsonValue::String((*s).into()))
                .collect(),
            )))
        }
    }
}
impl DomainEncode for FinishReason {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
impl DomainDecode for ToolContent {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        match o.tag("type", &["text", "file"])?.as_str() {
            Some("text") => Ok(Self::Text(ToolTextContent {
                text: o.field("text")?,
            })),
            Some("file") => Ok(Self::File(ToolFileContent {
                uri: o.field("uri")?,
                mime: o.field("mime")?,
                name: o.optional("name")?,
            })),
            _ => unreachable!(),
        }
    }
}
impl DomainDecode for ToolTextContent {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("text".into()))?;
        Ok(Self {
            text: o.field("text")?,
        })
    }
}
impl DomainEncode for ToolTextContent {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "text")
            .field("text", &self.text)
            .finish()
    }
}
impl DomainDecode for ToolFileContent {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("file".into()))?;
        Ok(Self {
            uri: o.field("uri")?,
            mime: o.field("mime")?,
            name: o.optional("name")?,
        })
    }
}
impl DomainEncode for ToolFileContent {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", "file")
            .field("uri", &self.uri)
            .field("mime", &self.mime)
            .optional("name", &self.name)
            .finish()
    }
}
impl DomainEncode for ToolContent {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Text(x) => ObjectEncoder::new()
                .field("type", "text")
                .field("text", &x.text)
                .finish(),
            Self::File(x) => ObjectEncoder::new()
                .field("type", "file")
                .field("uri", &x.uri)
                .field("mime", &x.mime)
                .optional("name", &x.name)
                .finish(),
        }
    }
}
