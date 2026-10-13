use rusqlite::types::ValueRef;
use ycoding_schema::{DomainDecode, DomainEncode, JsonValue, LosslessString};

pub(super) struct Row<'a, 'b> {
    pub(super) value: &'a rusqlite::Row<'b>,
    pub(super) table: &'static str,
    pub(super) number: u64,
}

impl Row<'_, '_> {
    pub(super) fn field<T: Field>(&self, column: &'static str) -> Result<T, super::Error> {
        let value = self.value.get_ref(column).map_err(super::Error::Sqlite)?;
        T::read(value).map_err(|reason| super::Error::Row {
            table: self.table,
            row: self.number,
            column: Some(column),
            reason: reason.to_owned(),
        })
    }
}

pub(super) trait Field: Sized {
    fn read(value: ValueRef<'_>) -> Result<Self, &'static str>;
}

fn wrong_type(value: ValueRef<'_>) -> &'static str {
    match value {
        ValueRef::Null => "unrepresentable null",
        ValueRef::Integer(_) => "unrepresentable integer",
        ValueRef::Real(_) => "unrepresentable real",
        ValueRef::Text(_) => "unrepresentable text",
        ValueRef::Blob(_) => "unrepresentable blob",
    }
}
impl Field for i64 {
    fn read(value: ValueRef<'_>) -> Result<Self, &'static str> {
        match value {
            ValueRef::Integer(value) => Ok(value),
            _ => Err(wrong_type(value)),
        }
    }
}
impl Field for f64 {
    fn read(value: ValueRef<'_>) -> Result<Self, &'static str> {
        match value {
            ValueRef::Real(value) => Ok(value),
            _ => Err(wrong_type(value)),
        }
    }
}
impl Field for LosslessString {
    fn read(value: ValueRef<'_>) -> Result<Self, &'static str> {
        match value {
            ValueRef::Text(value) => Ok(Self::from(String::from_utf8_lossy(value).as_ref())),
            _ => Err(wrong_type(value)),
        }
    }
}
impl<T: Field> Field for Option<T> {
    fn read(value: ValueRef<'_>) -> Result<Self, &'static str> {
        match value {
            ValueRef::Null => Ok(None),
            _ => T::read(value).map(Some),
        }
    }
}
impl Field for JsonValue {
    fn read(value: ValueRef<'_>) -> Result<Self, &'static str> {
        let ValueRef::Text(text) = value else {
            return Err(wrong_type(value));
        };
        let text = String::from_utf8_lossy(text);
        ycoding_schema::parse_json(text.as_ref()).map_err(|_| "invalid lossless JSON document")
    }
}
impl<T: DomainDecode + DomainEncode> Field for crate::session::Document<T> {
    fn read(value: ValueRef<'_>) -> Result<Self, &'static str> {
        Self::new(JsonValue::read(value)?).map_err(|_| "invalid schema document")
    }
}
impl Field for Vec<LosslessString> {
    fn read(value: ValueRef<'_>) -> Result<Self, &'static str> {
        let JsonValue::Array(values) = JsonValue::read(value)? else {
            return Err("expected JSON string array");
        };
        values
            .into_iter()
            .map(|value| match value {
                JsonValue::String(value) => Ok(value),
                _ => Err("expected JSON string array"),
            })
            .collect()
    }
}
impl Field for crate::resources::Secret {
    fn read(value: ValueRef<'_>) -> Result<Self, &'static str> {
        Self::new(JsonValue::read(value)?).map_err(|_| "invalid credential document")
    }
}
