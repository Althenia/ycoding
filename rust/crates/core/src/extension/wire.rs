use super::{Error, v5};
use prost::Message;
use ycoding_schema::{
    JsonObject, JsonValue, LosslessString,
    llm::{ToolContent, ToolFileContent, ToolTextContent},
};

pub const REVISION: u32 = 5;
pub const FRAME_BYTES: usize = 1_048_576;
pub const STARTUP_BYTES: usize = 16_384;
pub const MAX_DEPTH: usize = 64;
pub const MAX_FIELDS: usize = 8192;
pub const MAX_SUBSCRIPTIONS: usize = 8;
pub const MAX_EVENT_FAMILIES: usize = 16;
pub const MAX_EVENT_DELIVERIES: usize = 8;
pub const EVENT_BYTES: usize = 65_536;
include!(concat!(env!("OUT_DIR"), "/extension_rules.rs"));

impl std::fmt::Debug for v5::AuthCallback {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthCallback")
            .field("authorization", &self.authorization)
            .finish_non_exhaustive()
    }
}
impl std::fmt::Debug for v5::AuthSubmit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthSubmit")
            .field("authorization", &self.authorization)
            .finish_non_exhaustive()
    }
}
impl std::fmt::Debug for v5::AuthRefresh {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthRefresh")
            .field("integration", &self.integration)
            .field("method", &self.method)
            .finish_non_exhaustive()
    }
}
impl std::fmt::Debug for v5::AuthLabel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthLabel")
            .field("integration", &self.integration)
            .field("method", &self.method)
            .finish_non_exhaustive()
    }
}
impl std::fmt::Debug for v5::AuthReply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthReply")
            .field("request", &self.request)
            .finish_non_exhaustive()
    }
}

pub fn encode<M: Message>(message: &M) -> Result<Vec<u8>, Error> {
    let bytes = message.encode_to_vec();
    if bytes.is_empty() || bytes.len() > FRAME_BYTES {
        return Err(Error::Protocol);
    }
    let mut frame = (bytes.len() as u32).to_le_bytes().to_vec();
    frame.extend(bytes);
    Ok(frame)
}

pub fn decode<M: Message + Default>(bytes: &[u8], name: &str) -> Result<M, Error> {
    if bytes.is_empty() || bytes.len() > FRAME_BYTES {
        return Err(Error::Protocol);
    }
    inspect(bytes, name, 0, &mut 0)?;
    let message = M::decode(bytes).map_err(|_| Error::Protocol)?;
    if message.encode_to_vec() != bytes {
        return Err(Error::Protocol);
    }
    Ok(message)
}

fn varint(bytes: &[u8], offset: &mut usize) -> Result<u64, Error> {
    let mut value = 0;
    for shift in (0..70).step_by(7) {
        let byte = *bytes.get(*offset).ok_or(Error::Protocol)?;
        *offset += 1;
        if shift == 63 && byte > 1 {
            return Err(Error::Protocol);
        }
        value |= u64::from(byte & 127) << shift;
        if byte < 128 {
            return Ok(value);
        }
    }
    Err(Error::Protocol)
}

fn inspect(bytes: &[u8], name: &str, depth: usize, fields: &mut usize) -> Result<(), Error> {
    if depth > MAX_DEPTH {
        return Err(Error::Protocol);
    }
    let rule = MESSAGE_FIELDS
        .iter()
        .find(|(item, _)| *item == name)
        .ok_or(Error::Protocol)?
        .1;
    let mut offset = 0;
    while offset < bytes.len() {
        *fields += 1;
        if *fields > MAX_FIELDS {
            return Err(Error::Protocol);
        }
        let key = varint(bytes, &mut offset)?;
        if key >> 3 == 0 {
            return Err(Error::Protocol);
        }
        let count = match key & 7 {
            0 => {
                varint(bytes, &mut offset)?;
                0
            }
            1 => 8,
            2 => usize::try_from(varint(bytes, &mut offset)?).map_err(|_| Error::Protocol)?,
            5 => 4,
            _ => return Err(Error::Protocol),
        };
        let end = offset
            .checked_add(count)
            .filter(|end| *end <= bytes.len())
            .ok_or(Error::Protocol)?;
        if let Some((_, child)) = rule.iter().find(|(tag, _)| u64::from(*tag) == key >> 3) {
            if key & 7 != 2 {
                return Err(Error::Protocol);
            }
            inspect(&bytes[offset..end], child, depth + 1, fields)?;
        }
        offset = end;
    }
    Ok(())
}

#[derive(Default)]
pub struct Decoder {
    bytes: Vec<u8>,
}
impl Decoder {
    pub fn push(&mut self, bytes: &[u8], limit: usize) -> Result<Vec<v5::ChildFrame>, Error> {
        if self.bytes.len() + bytes.len() > FRAME_BYTES + 65540 {
            return Err(Error::Protocol);
        }
        self.bytes.extend_from_slice(bytes);
        let mut frames = Vec::new();
        let mut offset = 0;
        while self.bytes.len() - offset >= 4 {
            let count = u32::from_le_bytes(
                self.bytes[offset..offset + 4]
                    .try_into()
                    .map_err(|_| Error::Protocol)?,
            ) as usize;
            if count == 0 || count > limit {
                return Err(Error::Protocol);
            }
            if self.bytes.len() - offset - 4 < count {
                break;
            }
            frames.push(decode(
                &self.bytes[offset + 4..offset + 4 + count],
                ".ycoding.extension.v5.ChildFrame",
            )?);
            offset += 4 + count;
        }
        self.bytes.drain(..offset);
        Ok(frames)
    }
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}

pub fn text(value: &LosslessString) -> v5::Text {
    v5::Text {
        encoding: Some(match value.as_str() {
            Some(value) => v5::text::Encoding::Utf8(value.into()),
            None => {
                v5::text::Encoding::Utf16Le(value.code_units().flat_map(u16::to_le_bytes).collect())
            }
        }),
    }
}
pub fn read_text(value: v5::Text) -> Result<LosslessString, Error> {
    match value.encoding.ok_or(Error::Protocol)? {
        v5::text::Encoding::Utf8(value) => Ok(value.into()),
        v5::text::Encoding::Utf16Le(bytes) => {
            if bytes.len() % 2 != 0 {
                return Err(Error::Protocol);
            }
            let value = LosslessString::from_utf16(
                bytes
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                    .collect(),
            );
            if value.as_str().is_some() {
                return Err(Error::Protocol);
            }
            Ok(value)
        }
    }
}
pub fn value(value: &JsonValue) -> v5::Value {
    v5::Value {
        kind: Some(match value {
            JsonValue::Null => v5::value::Kind::Null(v5::Null {}),
            JsonValue::Bool(value) => v5::value::Kind::Boolean(*value),
            JsonValue::Number(value) => v5::value::Kind::Number(*value),
            JsonValue::String(value) => v5::value::Kind::String(text(value)),
            JsonValue::Array(items) => v5::value::Kind::List(v5::List {
                items: items.iter().map(self::value).collect(),
            }),
            JsonValue::Object(entries) => v5::value::Kind::Object(v5::Object {
                entries: entries
                    .iter()
                    .map(|(key, item)| v5::Entry {
                        key: text(key),
                        value: self::value(item),
                    })
                    .collect(),
            }),
        }),
    }
}
pub fn check_value(value: &JsonValue) -> Result<(), Error> {
    let mut pending = vec![(value, 0)];
    let mut fields = 0;
    let mut bytes = 0;
    while let Some((value, depth)) = pending.pop() {
        fields += 1;
        bytes += 16;
        if depth > MAX_DEPTH / 3 || fields > MAX_FIELDS / 3 {
            return Err(Error::Protocol);
        }
        match value {
            JsonValue::Number(value) if !value.is_finite() => return Err(Error::Protocol),
            JsonValue::String(value) => bytes += value.code_units().count() * 3,
            JsonValue::Array(items) => pending.extend(items.iter().map(|item| (item, depth + 1))),
            JsonValue::Object(object) => {
                for (key, item) in object.iter() {
                    bytes += key.code_units().count() * 3;
                    pending.push((item, depth + 1));
                }
            }
            _ => (),
        }
        if bytes > FRAME_BYTES {
            return Err(Error::Protocol);
        }
    }
    Ok(())
}
pub fn read_value(value: v5::Value) -> Result<JsonValue, Error> {
    Ok(match value.kind.ok_or(Error::Protocol)? {
        v5::value::Kind::Null(_) => JsonValue::Null,
        v5::value::Kind::Boolean(value) => JsonValue::Bool(value),
        v5::value::Kind::Number(value) if value.is_finite() => JsonValue::Number(value),
        v5::value::Kind::Number(_) => return Err(Error::Protocol),
        v5::value::Kind::String(value) => JsonValue::String(read_text(value)?),
        v5::value::Kind::List(list) => JsonValue::Array(
            list.items
                .into_iter()
                .map(read_value)
                .collect::<Result<_, _>>()?,
        ),
        v5::value::Kind::Object(object) => {
            let mut result = JsonObject::new();
            for entry in object.entries {
                let key = read_text(entry.key)?;
                if result.get(&key).is_some() {
                    return Err(Error::Protocol);
                }
                result.insert(key, read_value(entry.value)?);
            }
            JsonValue::Object(result)
        }
    })
}
pub fn read_output(output: v5::Output) -> Result<ycoding_ai::llm::ToolOutput, Error> {
    Ok(ycoding_ai::llm::ToolOutput {
        structured: read_value(output.structured)?,
        content: output
            .content
            .into_iter()
            .map(|item| {
                Ok(match item.kind.ok_or(Error::Protocol)? {
                    v5::content::Kind::Text(value) => ToolContent::Text(ToolTextContent {
                        text: read_text(value)?,
                    }),
                    v5::content::Kind::File(file) => ToolContent::File(ToolFileContent {
                        uri: read_text(file.uri)?,
                        mime: read_text(file.mime)?,
                        name: file.name.map(read_text).transpose()?,
                    }),
                })
            })
            .collect::<Result<_, Error>>()?,
    })
}
