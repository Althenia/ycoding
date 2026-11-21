use crate::{WireError, decode_lossless, decode_strict, limits, v5, validate_binary};
use prost::{Message, Name};

pub trait AssetMetadata: Message + Name {
    fn mime(&self) -> &v5::LosslessString;
    fn byte_count(&self) -> u64;
}
impl AssetMetadata for v5::FsReadResult {
    fn mime(&self) -> &v5::LosslessString {
        &self.data.mime
    }
    fn byte_count(&self) -> u64 {
        self.data.byte_count
    }
}
impl AssetMetadata for v5::SessionAttachmentReadResult {
    fn mime(&self) -> &v5::LosslessString {
        &self.data.mime
    }
    fn byte_count(&self) -> u64 {
        self.data.bytes
    }
}
pub struct Asset<M> {
    metadata: M,
    bytes: Vec<u8>,
}
impl<M: AssetMetadata> Asset<M> {
    pub fn new(metadata: M, bytes: Vec<u8>) -> Result<Self, WireError> {
        if bytes.len() as u64 != metadata.byte_count()
            || metadata.byte_count() > limits::BULK_MESSAGE_BYTES
        {
            return Err(WireError("asset length"));
        }
        if !valid_mime(&mime_text(metadata.mime())?) {
            return Err(WireError("asset MIME"));
        }
        Ok(Self { metadata, bytes })
    }
    pub fn into_wire(self) -> Result<(v5::AssetMetadataResult, Vec<u8>), WireError> {
        let payload = self.metadata.encode_to_vec();
        validate_binary(&M::full_name(), &payload)?;
        let result = v5::AssetMetadataResult {
            mime: self.metadata.mime().clone(),
            byte_count: self.metadata.byte_count(),
            metadata: v5::TypedPayload {
                type_name: M::full_name(),
                payload,
            },
        };
        validate_metadata(&result, &M::full_name(), false)?;
        Ok((result, self.bytes))
    }
}
pub(crate) fn validate_metadata(
    value: &v5::AssetMetadataResult,
    type_name: &str,
    opaque: bool,
) -> Result<(), WireError> {
    if value.metadata.type_name != type_name
        || value.metadata.payload.len() as u64 > limits::INLINE_BODY_BYTES
        || value.byte_count > limits::BULK_MESSAGE_BYTES
    {
        return Err(WireError("asset metadata"));
    }
    if !valid_mime(&mime_text(&value.mime)?) {
        return Err(WireError("asset MIME"));
    }
    if opaque {
        return Ok(());
    }
    let (mime, count) = if type_name == v5::FsReadResult::full_name() {
        let metadata = decode_strict::<v5::FsReadResult>(&value.metadata.payload)?;
        (metadata.data.mime, metadata.data.byte_count)
    } else if type_name == v5::SessionAttachmentReadResult::full_name() {
        let metadata = decode_strict::<v5::SessionAttachmentReadResult>(&value.metadata.payload)?;
        (metadata.data.mime, metadata.data.bytes)
    } else {
        return Err(WireError("unknown asset metadata type"));
    };
    if mime != value.mime || count != value.byte_count {
        return Err(WireError("asset metadata mismatch"));
    }
    Ok(())
}
fn mime_text(value: &v5::LosslessString) -> Result<String, WireError> {
    String::from_utf16(&decode_lossless(value, 256)?).map_err(|_| WireError("asset MIME"))
}
pub(crate) fn valid_mime(value: &str) -> bool {
    if value.len() > 256 || value.bytes().any(|byte| !(32..=126).contains(&byte)) {
        return false;
    }
    let bytes = value.as_bytes();
    let mut offset = 0;
    spaces(bytes, &mut offset);
    if !token(bytes, &mut offset) || bytes.get(offset) != Some(&b'/') {
        return false;
    }
    offset += 1;
    if !token(bytes, &mut offset) {
        return false;
    }
    loop {
        spaces(bytes, &mut offset);
        if offset == bytes.len() {
            return true;
        }
        if bytes[offset] != b';' {
            return false;
        }
        offset += 1;
        spaces(bytes, &mut offset);
        if !token(bytes, &mut offset) {
            return false;
        }
        spaces(bytes, &mut offset);
        if bytes.get(offset) != Some(&b'=') {
            return false;
        }
        offset += 1;
        spaces(bytes, &mut offset);
        if bytes.get(offset) != Some(&b'"') {
            if !token(bytes, &mut offset) {
                return false;
            }
            continue;
        }
        offset += 1;
        loop {
            let Some(byte) = bytes.get(offset) else {
                return false;
            };
            offset += 1;
            if *byte == b'"' {
                break;
            }
            if *byte == b'\\' {
                if offset == bytes.len() {
                    return false;
                }
                offset += 1;
            }
        }
    }
}
fn token(bytes: &[u8], offset: &mut usize) -> bool {
    let start = *offset;
    while bytes
        .get(*offset)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(byte))
    {
        *offset += 1;
    }
    *offset > start
}
fn spaces(bytes: &[u8], offset: &mut usize) {
    while bytes.get(*offset) == Some(&b' ') {
        *offset += 1;
    }
}
