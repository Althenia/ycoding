use crate::domain::finite_number;
use crate::{DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue};

macro_rules! string_type {
    ($name:ident, $prefix:literal) => {
        #[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
        pub struct $name(crate::LosslessString);
        impl $name {
            pub fn new(
                value: impl Into<crate::LosslessString>,
            ) -> Result<Self, crate::DecodeError> {
                use crate::DomainDecode;
                Self::decode(&crate::JsonValue::String(value.into()))
            }
            pub fn as_lossless(&self) -> &crate::LosslessString {
                &self.0
            }
            pub fn into_lossless(self) -> crate::LosslessString {
                self.0
            }
        }
        impl crate::DomainDecode for $name {
            fn decode_at(
                value: &crate::JsonValue,
                path: &crate::JsonPath,
            ) -> Result<Self, crate::DecodeError> {
                crate::domain::branded_string(value, $prefix, path).map(Self)
            }
        }
        impl crate::DomainEncode for $name {
            fn encode(&self) -> crate::JsonValue {
                crate::JsonValue::String(self.0.clone())
            }
        }
    };
}
pub(crate) use string_type;

macro_rules! integer_type {
    ($name:ident, $minimum:expr) => {
        #[derive(Clone, Copy, Debug, PartialEq)]
        pub struct $name(f64);
        impl $name {
            pub fn new(value: i64) -> Result<Self, crate::DecodeError> {
                use crate::DomainDecode;
                Self::decode(&crate::JsonValue::Number(value as f64))
            }
            pub fn get(self) -> i64 {
                self.0 as i64
            }
        }
        impl Eq for $name {}
        impl PartialOrd for $name {
            fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
                Some(self.cmp(other))
            }
        }
        impl Ord for $name {
            fn cmp(&self, other: &Self) -> std::cmp::Ordering {
                self.get().cmp(&other.get())
            }
        }
        impl std::hash::Hash for $name {
            fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
                std::hash::Hash::hash(&self.get(), state);
            }
        }
        impl crate::DomainDecode for $name {
            fn decode_at(
                value: &crate::JsonValue,
                path: &crate::JsonPath,
            ) -> Result<Self, crate::DecodeError> {
                crate::domain::integer_range(value, $minimum, 9_007_199_254_740_991, path).map(Self)
            }
        }
        impl crate::DomainEncode for $name {
            fn encode(&self) -> crate::JsonValue {
                crate::JsonValue::Number(self.0)
            }
        }
    };
}
pub(crate) use integer_type;

string_type!(RelativePath, "");
string_type!(AbsolutePath, "");
integer_type!(PositiveInt, 1);
integer_type!(NonNegativeInt, 0);
integer_type!(Int, -9_007_199_254_740_991);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Finite(f64);
impl Finite {
    pub fn new(value: f64) -> Result<Self, DecodeError> {
        Self::decode(&JsonValue::Number(value))
    }
    pub fn get(self) -> f64 {
        self.0
    }
}
impl DomainDecode for Finite {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        finite_number(value, path).map(Self)
    }
}
impl DomainEncode for Finite {
    fn encode(&self) -> JsonValue {
        JsonValue::Number(self.0)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct DateTimeUtcFromMillis(i64);
impl DateTimeUtcFromMillis {
    pub fn new(value: f64) -> Result<Self, DecodeError> {
        Self::decode(&JsonValue::Number(value))
    }
    pub fn epoch_millis(self) -> i64 {
        self.0
    }
}
impl DomainDecode for DateTimeUtcFromMillis {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let number = finite_number(value, path)?;
        if number.abs() > 8_640_000_000_000_000.0 {
            return Err(path.error(DecodeErrorKind::InvalidTimestamp));
        }
        Ok(Self(number.trunc() as i64))
    }
}
impl DomainEncode for DateTimeUtcFromMillis {
    fn encode(&self) -> JsonValue {
        JsonValue::Number(self.0 as f64)
    }
}

macro_rules! literal_enum_type {
    ($name:ident, { $($variant:ident => $literal:literal),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
        pub enum $name { $($variant),+ }
        impl $name {
            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $literal),+ }
            }
        }
        impl crate::DomainDecode for $name {
            fn decode_at(value: &crate::JsonValue, path: &crate::JsonPath) -> std::result::Result<Self, crate::DecodeError> {
                let value = crate::LosslessString::decode_at(value, path)?;
                match value.as_str() {
                    $(Some($literal) => Ok(Self::$variant),)+
                    _ => Err(path.error(crate::DecodeErrorKind::Literal(vec![$(crate::JsonValue::String($literal.into())),+]))),
                }
            }
        }
        impl crate::DomainEncode for $name {
            fn encode(&self) -> crate::JsonValue { crate::JsonValue::String(self.as_str().into()) }
        }
    };
}
pub(crate) use literal_enum_type;
