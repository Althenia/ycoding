use crate::Error;
use ycoding_schema::{JsonObject, JsonValue, LosslessString};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Value<'a> {
    Varint(u64),
    Fixed64(&'a [u8]),
    Bytes(&'a [u8]),
    Fixed32(&'a [u8]),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Field<'a> {
    pub number: u32,
    pub value: Value<'a>,
}
impl<'a> Field<'a> {
    pub fn write(&self, out: &mut Vec<u8>) -> Result<(), Error> {
        match self.value {
            Value::Varint(value) => write_varint(out, self.number, value),
            Value::Bytes(bytes) => write_bytes(out, self.number, bytes),
            Value::Fixed32(bytes) | Value::Fixed64(bytes) => {
                tag(out, self.number, self.wire_type())?;
                out.extend_from_slice(bytes);
                Ok(())
            }
        }
    }
    pub fn wire_type(&self) -> u8 {
        match self.value {
            Value::Varint(_) => 0,
            Value::Fixed64(_) => 1,
            Value::Bytes(_) => 2,
            Value::Fixed32(_) => 5,
        }
    }
    pub fn bytes(&self) -> Result<&'a [u8], Error> {
        match self.value {
            Value::Bytes(bytes) => Ok(bytes),
            _ => Err(Error::output(
                "Cursor protobuf field has an invalid wire type",
            )),
        }
    }
    pub fn varint(&self) -> Result<u64, Error> {
        match self.value {
            Value::Varint(value) => Ok(value),
            _ => Err(Error::output(
                "Cursor protobuf field has an invalid wire type",
            )),
        }
    }
    pub fn uint32(&self) -> Result<u32, Error> {
        self.varint().map(|value| value as u32)
    }
    pub fn text(&self) -> Result<String, Error> {
        Ok(String::from_utf8_lossy(self.bytes()?).into_owned())
    }
}

fn read_varint(bytes: &[u8], offset: &mut usize, maximum: u64) -> Result<u64, Error> {
    let mut value = 0u64;
    for shift in (0..70).step_by(7) {
        let byte = bytes
            .get(*offset)
            .ok_or_else(|| Error::output("Cursor protobuf varint is truncated"))?;
        *offset += 1;
        if shift == 63 && *byte > 1 {
            return Err(Error::output("Cursor protobuf varint exceeds uint64"));
        }
        value |= u64::from(byte & 127) << shift;
        if value > maximum {
            return Err(Error::output(
                "Cursor protobuf varint exceeds its wire width",
            ));
        }
        if byte & 128 == 0 {
            return Ok(value);
        }
    }
    Err(Error::output("Cursor protobuf varint is unterminated"))
}

pub fn fields(bytes: &[u8]) -> Result<Vec<Field<'_>>, Error> {
    let mut offset = 0;
    let mut fields = Vec::new();
    while offset < bytes.len() {
        let tag = read_varint(bytes, &mut offset, u64::from(u32::MAX))? as u32;
        let number = tag >> 3;
        if number == 0 || number > 0x1fff_ffff {
            return Err(Error::output("Cursor protobuf field number is invalid"));
        }
        let width = match tag & 7 {
            0 => {
                let value = read_varint(bytes, &mut offset, u64::MAX)?;
                fields.push(Field {
                    number,
                    value: Value::Varint(value),
                });
                continue;
            }
            1 => 8,
            2 => read_varint(bytes, &mut offset, u64::from(u32::MAX))? as usize,
            5 => 4,
            _ => return Err(Error::output("Cursor protobuf wire type is unsupported")),
        };
        let end = offset
            .checked_add(width)
            .ok_or_else(|| Error::output("Cursor protobuf field length overflow"))?;
        let data = bytes
            .get(offset..end)
            .ok_or_else(|| Error::output("Cursor protobuf field is truncated"))?;
        fields.push(Field {
            number,
            value: match tag & 7 {
                1 => Value::Fixed64(data),
                5 => Value::Fixed32(data),
                _ => Value::Bytes(data),
            },
        });
        offset = end;
    }
    Ok(fields)
}

fn varint(out: &mut Vec<u8>, mut value: u64) {
    while value > 127 {
        out.push((value as u8 & 127) | 128);
        value >>= 7;
    }
    out.push(value as u8);
}
fn tag(out: &mut Vec<u8>, field: u32, wire: u8) -> Result<(), Error> {
    if field == 0 || field > 0x1fff_ffff {
        return Err(Error::invalid("Cursor protobuf field number is invalid"));
    }
    varint(out, u64::from((field << 3) | u32::from(wire)));
    Ok(())
}
pub fn write_varint(out: &mut Vec<u8>, field: u32, value: u64) -> Result<(), Error> {
    tag(out, field, 0)?;
    varint(out, value);
    Ok(())
}
pub fn write_bytes(out: &mut Vec<u8>, field: u32, bytes: &[u8]) -> Result<(), Error> {
    let length = u32::try_from(bytes.len())
        .map_err(|_| Error::invalid("Cursor protobuf field exceeds uint32 length"))?;
    tag(out, field, 2)?;
    varint(out, u64::from(length));
    out.extend_from_slice(bytes);
    Ok(())
}
pub fn write_string(out: &mut Vec<u8>, field: u32, text: &LosslessString) -> Result<(), Error> {
    let mut bytes = Vec::new();
    let units = text.code_units().collect::<Vec<_>>();
    let mut offset = 0;
    while offset < units.len() {
        let unit = units[offset];
        offset += 1;
        let point = if (0xd800..=0xdbff).contains(&unit)
            && units
                .get(offset)
                .is_some_and(|next| (0xdc00..=0xdfff).contains(next))
        {
            let point =
                0x10000 + ((u32::from(unit) - 0xd800) << 10) + (u32::from(units[offset]) - 0xdc00);
            offset += 1;
            point
        } else {
            u32::from(unit)
        };
        match point {
            0..=0x7f => bytes.push(point as u8),
            0x80..=0x7ff => {
                bytes.extend_from_slice(&[(0xc0 | (point >> 6)) as u8, (0x80 | (point & 63)) as u8])
            }
            0x800..=0xffff => bytes.extend_from_slice(&[
                (0xe0 | (point >> 12)) as u8,
                (0x80 | ((point >> 6) & 63)) as u8,
                (0x80 | (point & 63)) as u8,
            ]),
            _ => bytes.extend_from_slice(&[
                (0xf0 | (point >> 18)) as u8,
                (0x80 | ((point >> 12) & 63)) as u8,
                (0x80 | ((point >> 6) & 63)) as u8,
                (0x80 | (point & 63)) as u8,
            ]),
        }
    }
    write_bytes(out, field, &bytes)
}

pub fn encode_value(value: &JsonValue) -> Result<Vec<u8>, Error> {
    let mut out = Vec::new();
    match value {
        JsonValue::Null => write_varint(&mut out, 1, 0)?,
        JsonValue::Number(value) => {
            tag(&mut out, 2, 1)?;
            out.extend_from_slice(&value.to_le_bytes());
        }
        JsonValue::String(value) => {
            let text = char::decode_utf16(value.code_units())
                .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER))
                .collect::<String>();
            write_bytes(&mut out, 3, text.as_bytes())?;
        }
        JsonValue::Bool(value) => write_varint(&mut out, 4, u64::from(*value))?,
        JsonValue::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            let mut data = Vec::new();
            for (key, value) in entries {
                let key = char::decode_utf16(key.code_units())
                    .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER))
                    .collect::<String>();
                let mut entry = Vec::new();
                write_bytes(&mut entry, 1, key.as_bytes())?;
                write_bytes(&mut entry, 2, &encode_value(value)?)?;
                write_bytes(&mut data, 1, &entry)?;
            }
            write_bytes(&mut out, 5, &data)?;
        }
        JsonValue::Array(values) => {
            let mut data = Vec::new();
            for value in values {
                write_bytes(&mut data, 1, &encode_value(value)?)?;
            }
            write_bytes(&mut out, 6, &data)?;
        }
    }
    Ok(out)
}

pub fn decode_value(bytes: &[u8]) -> Result<JsonValue, Error> {
    let fields = fields(bytes)?;
    let Some(field) = fields.first() else {
        return Ok(JsonValue::Null);
    };
    match field.number {
        1 => Ok(JsonValue::Null),
        2 => match field.value {
            Value::Fixed64(bytes) => Ok(JsonValue::Number(f64::from_le_bytes(
                bytes
                    .try_into()
                    .map_err(|_| Error::output("Cursor double is truncated"))?,
            ))),
            _ => Err(Error::output(
                "Cursor Value number has an invalid wire type",
            )),
        },
        3 => Ok(JsonValue::String(value_text(field.bytes()?).into())),
        4 => Ok(JsonValue::Bool(field.varint()? != 0)),
        5 => decode_entries(fields_for(field.bytes()?, 1)?),
        6 => Ok(JsonValue::Array(
            fields_for(field.bytes()?, 1)?
                .into_iter()
                .map(decode_value)
                .collect::<Result<_, _>>()?,
        )),
        _ => Ok(JsonValue::Null),
    }
}
fn fields_for(bytes: &[u8], number: u32) -> Result<Vec<&[u8]>, Error> {
    fields(bytes)?
        .into_iter()
        .filter(|field| field.number == number)
        .map(|field| field.bytes())
        .collect()
}
pub fn decode_entries<'a>(entries: impl IntoIterator<Item = &'a [u8]>) -> Result<JsonValue, Error> {
    let mut object = JsonObject::new();
    for entry in entries {
        let fields = fields(entry)?;
        let key = fields.iter().rev().find(|field| field.number == 1);
        if let Some(key) = key {
            let value = fields
                .iter()
                .rev()
                .find(|field| field.number == 2)
                .map(|field| decode_value(field.bytes()?))
                .transpose()?
                .unwrap_or(JsonValue::Null);
            object.insert(value_text(key.bytes()?).into(), value);
        }
    }
    Ok(JsonValue::Object(object))
}

fn value_text(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned()
}
