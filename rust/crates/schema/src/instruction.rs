use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonObject, JsonPath, JsonValue,
    LosslessString,
};
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct Key(LosslessString);
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct Hash(LosslessString);
fn text(value: &LosslessString) -> Option<&str> {
    value.as_str()
}
impl DomainDecode for Key {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let s = LosslessString::decode_at(v, p)?;
        let valid = text(&s).is_some_and(|x| {
            let b = x.as_bytes();
            let Some(i) = b.iter().position(|c| *c == b'/') else {
                return false;
            };
            i > 0
                && i + 1 < b.len()
                && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
                && (b[i + 1].is_ascii_lowercase() || b[i + 1].is_ascii_digit())
                && b.iter().enumerate().all(|(n, c)| {
                    if n == i {
                        true
                    } else if n > i {
                        c.is_ascii_lowercase() || c.is_ascii_digit() || b"._/-".contains(c)
                    } else {
                        c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(c)
                    }
                })
        });
        if valid {
            Ok(Self(s))
        } else {
            Err(p.error(DecodeErrorKind::Expected("instruction key")))
        }
    }
}
impl DomainEncode for Key {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
impl DomainDecode for Hash {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let s = LosslessString::decode_at(v, p)?;
        if text(&s).is_some_and(|x| {
            x.len() == 64
                && x.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }) {
            Ok(Self(s))
        } else {
            Err(p.error(DecodeErrorKind::Expected(
                "64-character lowercase hexadecimal hash",
            )))
        }
    }
}
impl DomainEncode for Hash {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Removed;
impl DomainDecode for Removed {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        crate::domain::literal_enum(v, &["removed"], p).map(|_| Self)
    }
}
impl DomainEncode for Removed {
    fn encode(&self) -> JsonValue {
        JsonValue::String("removed".into())
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Values(pub JsonObject);
impl DomainDecode for Values {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let JsonValue::Object(map) = v else {
            return Err(p.error(DecodeErrorKind::Expected("object")));
        };
        let mut kept = JsonObject::default();
        for (key, value) in map.iter() {
            if Key::decode_at(&JsonValue::String(key.clone()), &p.key(key.clone())).is_err() {
                continue;
            }
            Hash::decode_at(value, &p.key(key.clone()))?;
            kept.insert(key.clone(), value.clone());
        }
        Ok(Self(kept))
    }
}
impl DomainEncode for Values {
    fn encode(&self) -> JsonValue {
        JsonValue::Object(self.0.clone())
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Delta(pub JsonObject);
impl DomainDecode for Delta {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let JsonValue::Object(map) = v else {
            return Err(p.error(DecodeErrorKind::Expected("object")));
        };
        for (key, value) in map.iter() {
            let path = p.key(key.clone());
            if matches!(value, JsonValue::String(_)) && Removed::decode_at(value, &path).is_ok() {
                continue;
            }
            Hash::decode_at(value, &path)?;
        }
        Ok(Self(map.clone()))
    }
}
impl DomainEncode for Delta {
    fn encode(&self) -> JsonValue {
        JsonValue::Object(self.0.clone())
    }
}
