use crate::schema::Finite;
use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, ObjectDecoder, ObjectEncoder,
};

#[derive(Clone, Debug, PartialEq)]
pub struct Cache {
    pub read: Finite,
    pub write: Finite,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub input: Finite,
    pub output: Finite,
    pub reasoning: Finite,
    pub cache: Cache,
}
impl DomainDecode for Cache {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            read: object.field("read")?,
            write: object.field("write")?,
        })
    }
}
impl DomainEncode for Cache {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("read", &self.read)
            .field("write", &self.write)
            .finish()
    }
}
impl DomainDecode for Info {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            input: object.field("input")?,
            output: object.field("output")?,
            reasoning: object.field("reasoning")?,
            cache: object.field("cache")?,
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("input", &self.input)
            .field("output", &self.output)
            .field("reasoning", &self.reasoning)
            .field("cache", &self.cache)
            .finish()
    }
}
