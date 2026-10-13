use std::cmp::Ordering;
use std::hash::{Hash, Hasher};
use std::string::FromUtf16Error;

#[derive(Clone, Debug)]
pub struct LosslessString(Repr);

#[derive(Clone, Debug)]
enum Repr {
    Utf8(String),
    Utf16(Vec<u16>),
}

impl LosslessString {
    pub fn from_utf16(units: Vec<u16>) -> Self {
        match String::from_utf16(&units) {
            Ok(text) => Self(Repr::Utf8(text)),
            Err(_) => Self(Repr::Utf16(units)),
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match &self.0 {
            Repr::Utf8(text) => Some(text),
            Repr::Utf16(_) => None,
        }
    }

    pub fn as_utf16_units(&self) -> Option<&[u16]> {
        match &self.0 {
            Repr::Utf8(_) => None,
            Repr::Utf16(units) => Some(units),
        }
    }

    pub fn to_utf8(&self) -> Result<String, FromUtf16Error> {
        match &self.0 {
            Repr::Utf8(text) => Ok(text.clone()),
            Repr::Utf16(units) => String::from_utf16(units),
        }
    }

    pub fn code_units(&self) -> CodeUnits<'_> {
        CodeUnits(match &self.0 {
            Repr::Utf8(text) => Units::Utf8(text.encode_utf16()),
            Repr::Utf16(units) => Units::Utf16(units.iter()),
        })
    }

    pub fn len(&self) -> usize {
        match &self.0 {
            Repr::Utf8(text) => text.encode_utf16().count(),
            Repr::Utf16(units) => units.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        match &self.0 {
            Repr::Utf8(text) => text.is_empty(),
            Repr::Utf16(units) => units.is_empty(),
        }
    }
}

impl From<String> for LosslessString {
    fn from(text: String) -> Self {
        Self(Repr::Utf8(text))
    }
}

impl From<&str> for LosslessString {
    fn from(text: &str) -> Self {
        Self::from(text.to_owned())
    }
}

impl Default for LosslessString {
    fn default() -> Self {
        Self::from(String::new())
    }
}

impl TryFrom<LosslessString> for String {
    type Error = FromUtf16Error;

    fn try_from(text: LosslessString) -> Result<Self, Self::Error> {
        match text.0 {
            Repr::Utf8(text) => Ok(text),
            Repr::Utf16(units) => Self::from_utf16(&units),
        }
    }
}

impl PartialEq for LosslessString {
    fn eq(&self, other: &Self) -> bool {
        self.code_units().eq(other.code_units())
    }
}

impl Eq for LosslessString {}

impl PartialOrd for LosslessString {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for LosslessString {
    fn cmp(&self, other: &Self) -> Ordering {
        self.code_units().cmp(other.code_units())
    }
}

impl Hash for LosslessString {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.len().hash(state);
        self.code_units().for_each(|unit| unit.hash(state));
    }
}

#[derive(Clone)]
pub struct CodeUnits<'a>(Units<'a>);

#[derive(Clone)]
enum Units<'a> {
    Utf8(std::str::EncodeUtf16<'a>),
    Utf16(std::slice::Iter<'a, u16>),
}

impl Iterator for CodeUnits<'_> {
    type Item = u16;

    fn next(&mut self) -> Option<Self::Item> {
        match &mut self.0 {
            Units::Utf8(units) => units.next(),
            Units::Utf16(units) => units.next().copied(),
        }
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        match &self.0 {
            Units::Utf8(units) => units.size_hint(),
            Units::Utf16(units) => units.size_hint(),
        }
    }
}

impl std::iter::FusedIterator for CodeUnits<'_> {}
