use crate::{Error, KeyPart, TableSpec, Write, tuple_key};
use std::marker::PhantomData;
use ycoding_schema::{JsonValue, LosslessString};

#[derive(Clone, Debug, PartialEq)]
pub struct Document<T> {
    value: JsonValue,
    domain: PhantomData<T>,
}

impl<T: ycoding_schema::DomainDecode + ycoding_schema::DomainEncode> Document<T> {
    pub fn new(value: JsonValue) -> Result<Self, Error> {
        T::decode(&value).map_err(|error| Error::Record(Box::new(error)))?;
        Ok(Self {
            value,
            domain: PhantomData,
        })
    }
    pub fn from_domain(value: &T) -> Result<Self, Error> {
        Self::new(value.encode())
    }
    pub fn value(&self) -> &JsonValue {
        &self.value
    }
    pub fn domain(&self) -> Result<T, Error> {
        T::decode(&self.value).map_err(|error| Error::Record(Box::new(error)))
    }
}

pub(crate) trait Field: Sized {
    fn encode(&self, bytes: &mut Vec<u8>) -> Result<(), Error>;
    fn decode(input: &mut &[u8]) -> Result<Self, Error>;
}

fn take<'a>(input: &mut &'a [u8], count: usize) -> Result<&'a [u8], Error> {
    if input.len() < count {
        return Err(Error::Incompatible("truncated domain record"));
    }
    let (value, remaining) = input.split_at(count);
    *input = remaining;
    Ok(value)
}

impl Field for i64 {
    fn encode(&self, bytes: &mut Vec<u8>) -> Result<(), Error> {
        bytes.extend(self.to_be_bytes());
        Ok(())
    }
    fn decode(input: &mut &[u8]) -> Result<Self, Error> {
        Ok(Self::from_be_bytes(
            take(input, 8)?
                .try_into()
                .map_err(|_| Error::Incompatible("integer width"))?,
        ))
    }
}
impl Field for f64 {
    fn encode(&self, bytes: &mut Vec<u8>) -> Result<(), Error> {
        bytes.extend(self.to_bits().to_be_bytes());
        Ok(())
    }
    fn decode(input: &mut &[u8]) -> Result<Self, Error> {
        Ok(Self::from_bits(u64::from_be_bytes(
            take(input, 8)?
                .try_into()
                .map_err(|_| Error::Incompatible("real width"))?,
        )))
    }
}
impl Field for LosslessString {
    fn encode(&self, bytes: &mut Vec<u8>) -> Result<(), Error> {
        i64::try_from(self.len())
            .map_err(|_| Error::Rejected("string too large"))?
            .encode(bytes)?;
        self.code_units()
            .for_each(|unit| bytes.extend(unit.to_be_bytes()));
        Ok(())
    }
    fn decode(input: &mut &[u8]) -> Result<Self, Error> {
        let count = usize::try_from(i64::decode(input)?)
            .map_err(|_| Error::Incompatible("string length"))?;
        let bytes = take(
            input,
            count
                .checked_mul(2)
                .ok_or(Error::Incompatible("string length"))?,
        )?;
        Ok(Self::from_utf16(
            bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|unit| u16::from_be_bytes(*unit))
                .collect(),
        ))
    }
}
impl<T: Field> Field for Option<T> {
    fn encode(&self, bytes: &mut Vec<u8>) -> Result<(), Error> {
        bytes.push(u8::from(self.is_some()));
        if let Some(value) = self {
            value.encode(bytes)?;
        }
        Ok(())
    }
    fn decode(input: &mut &[u8]) -> Result<Self, Error> {
        match take(input, 1)?[0] {
            0 => Ok(None),
            1 => T::decode(input).map(Some),
            _ => Err(Error::Incompatible("option tag")),
        }
    }
}
impl<T: Field> Field for Vec<T> {
    fn encode(&self, bytes: &mut Vec<u8>) -> Result<(), Error> {
        i64::try_from(self.len())
            .map_err(|_| Error::Rejected("array too large"))?
            .encode(bytes)?;
        self.iter().try_for_each(|value| value.encode(bytes))
    }
    fn decode(input: &mut &[u8]) -> Result<Self, Error> {
        let count = usize::try_from(i64::decode(input)?)
            .map_err(|_| Error::Incompatible("array length"))?;
        if count > input.len() {
            return Err(Error::Incompatible("array length"));
        }
        (0..count).map(|_| T::decode(input)).collect()
    }
}
impl Field for JsonValue {
    fn encode(&self, bytes: &mut Vec<u8>) -> Result<(), Error> {
        match self {
            Self::Null => bytes.push(0),
            Self::Bool(value) => bytes.push(if *value { 2 } else { 1 }),
            Self::Number(value) => {
                bytes.push(3);
                value.encode(bytes)?;
            }
            Self::String(value) => {
                bytes.push(4);
                value.encode(bytes)?;
            }
            Self::Array(value) => {
                bytes.push(5);
                value.encode(bytes)?;
            }
            Self::Object(value) => {
                bytes.push(6);
                i64::try_from(value.len())
                    .map_err(|_| Error::Rejected("object too large"))?
                    .encode(bytes)?;
                for (key, value) in value.iter() {
                    key.encode(bytes)?;
                    value.encode(bytes)?;
                }
            }
        }
        Ok(())
    }
    fn decode(input: &mut &[u8]) -> Result<Self, Error> {
        match take(input, 1)?[0] {
            0 => Ok(Self::Null),
            1 => Ok(Self::Bool(false)),
            2 => Ok(Self::Bool(true)),
            3 => f64::decode(input).map(Self::Number),
            4 => LosslessString::decode(input).map(Self::String),
            5 => Vec::decode(input).map(Self::Array),
            6 => {
                let count = usize::try_from(i64::decode(input)?)
                    .map_err(|_| Error::Incompatible("object length"))?;
                if count > input.len() {
                    return Err(Error::Incompatible("object length"));
                }
                let mut value = ycoding_schema::JsonObject::new();
                for _ in 0..count {
                    let key = LosslessString::decode(input)?;
                    if value.insert(key, Self::decode(input)?).is_some() {
                        return Err(Error::Incompatible("duplicate object key"));
                    }
                }
                Ok(Self::Object(value))
            }
            _ => Err(Error::Incompatible("JSON tag")),
        }
    }
}
impl<T: ycoding_schema::DomainDecode + ycoding_schema::DomainEncode> Field for Document<T> {
    fn encode(&self, bytes: &mut Vec<u8>) -> Result<(), Error> {
        self.value.encode(bytes)
    }
    fn decode(input: &mut &[u8]) -> Result<Self, Error> {
        Self::new(JsonValue::decode(input)?)
    }
}

pub(crate) fn key(value: &LosslessString) -> Vec<u8> {
    tuple_key(&[KeyPart::String(value)])
}
pub(crate) fn text(value: &Option<LosslessString>) -> KeyPart<'_> {
    value.as_ref().map_or(KeyPart::Null, KeyPart::String)
}
pub(crate) fn integer(value: Option<i64>) -> KeyPart<'static> {
    value.map_or(KeyPart::Null, KeyPart::I64)
}
pub(crate) fn require<T: TableSpec>(tx: &mut Write<'_>, key: &[u8]) -> Result<(), Error> {
    if tx.get::<T>(key)?.is_none() {
        return Err(tx.reject(Error::Domain {
            kind: "foreign_reference",
            message: "referenced parent is missing",
        }));
    }
    Ok(())
}
pub(crate) fn check(valid: bool, name: &'static str) -> Result<(), Error> {
    if !valid {
        return Err(Error::Domain {
            kind: "check",
            message: name,
        });
    }
    Ok(())
}
pub(crate) fn digest(value: &LosslessString) -> bool {
    value.as_str().is_some_and(|value| {
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub(crate) fn optional_digest(value: &Option<LosslessString>) -> bool {
    value.as_ref().is_none_or(digest)
}
pub(crate) fn nonnegative(value: Option<i64>) -> bool {
    value.is_none_or(|value| value >= 0)
}
pub(crate) fn nonempty(value: &Option<LosslessString>) -> bool {
    value.as_ref().is_none_or(|value| !value.is_empty())
}
pub(crate) fn boundary(id: &Option<LosslessString>, seq: Option<i64>) -> bool {
    (id.is_none() && seq.is_none()) || (nonempty(id) && seq.is_some_and(|seq| seq >= 0))
}

macro_rules! table {
    ($table:ident, $record:ident, $name:literal, { $($field:ident: $ty:ty),* $(,)? }, $r:ident, $primary:expr, $indexes:expr, $index:ident, $index_key:expr, $validate:expr, $tx:ident, $references:block) => {
        #[derive(Clone, Debug, PartialEq)]
        pub struct $record { $(pub $field: $ty),* }
        pub struct $table;
        impl crate::TableSpec for $table {
            type Record = $record;
            const NAME: &'static str = $name;
            const INDEXES: &'static [crate::IndexDefinition] = $indexes;
            fn primary_key($r: &Self::Record) -> Vec<u8> { $primary }
            fn encode($r: &Self::Record) -> Result<Vec<u8>, crate::Error> {
                Self::validate($r)?;
                let mut bytes = vec![1];
                $(super::codec::Field::encode(&$r.$field, &mut bytes)?;)*
                Ok(bytes)
            }
            fn decode(mut input: &[u8]) -> Result<Self::Record, crate::Error> {
                if input.first() != Some(&1) { return Err(crate::Error::Incompatible("domain record version")); }
                input = &input[1..];
                let record = $record { $($field: <$ty as super::codec::Field>::decode(&mut input)?),* };
                if !input.is_empty() { return Err(crate::Error::Incompatible("trailing domain record bytes")); }
                Self::validate(&record)?;
                Ok(record)
            }
            fn index_key($index: &crate::IndexDefinition, $r: &Self::Record) -> Result<Option<Vec<u8>>, crate::Error> { $index_key }
        }
        impl $table {
            fn validate($r: &$record) -> Result<(), crate::Error> {
                let _ = $r;
                $validate
            }
            pub fn put($tx: &mut crate::Write<'_>, $r: &$record) -> Result<(), crate::Error> {
                $references
                $tx.put::<Self>($r)
            }
            pub fn insert(tx: &mut crate::Write<'_>, record: &$record) -> Result<(), crate::Error> {
                if tx.get::<Self>(&<Self as crate::TableSpec>::primary_key(record))?.is_some() {
                    return Err(tx.reject(crate::Error::Domain { kind: "primary_key", message: "primary identity already exists" }));
                }
                Self::put(tx, record)
            }
        }
    };
}
pub(crate) use table;
