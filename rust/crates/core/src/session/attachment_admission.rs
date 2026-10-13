use super::store::Service;
use crate::platform::filesystem::{collation, trim};
use crate::resources::{attachment_store, image};
use std::{ops::Bound, path::Path};
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString,
    prompt::{FileAttachment, ManagedAttachmentContent, Mention},
};
use ycoding_store::{Error, session::EventTable};

pub const MAX_ATTACHMENT_BYTES: usize = attachment_store::MAX_BYTES;

pub struct Input {
    pub uri: LosslessString,
    pub name: Option<LosslessString>,
    pub description: Option<LosslessString>,
    pub mention: Option<Mention>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum MaterializeError {
    Attachment(String),
    Store(String),
}

struct Resolved {
    bytes: Vec<u8>,
    start: Option<f64>,
    end: Option<f64>,
    name: Option<String>,
    mime: Option<&'static str>,
}

impl Service {
    pub fn materialize_attachment(
        &self,
        attachments: &attachment_store::Store,
        limits: image::Limits,
        input: Input,
    ) -> Result<FileAttachment, MaterializeError> {
        let uri = input
            .uri
            .to_utf8()
            .map_err(|_| MaterializeError::Attachment("Invalid attachment URI".into()))?;
        if uri.starts_with("ycoding-attachment://") {
            let (content, mime) = match attachments
                .resolve_uri(&uri)
                .and_then(|content| attachments.read(&content).map(|bytes| (content, bytes)))
            {
                Ok((content, bytes)) => (content, LosslessString::from(detect(&bytes))),
                Err(error) => {
                    let Some(recorded) = self.recorded_attachment(&uri)? else {
                        return Err(MaterializeError::Attachment(error.to_string()));
                    };
                    tracing::warn!(
                        reason = %error,
                        "Admitting a recorded attachment whose stored copy is unavailable"
                    );
                    recorded
                }
            };
            return Ok(FileAttachment {
                content,
                mime,
                name: input.name,
                description: input.description,
                mention: input.mention,
            });
        }
        let resolved = if uri.starts_with("data:") {
            Resolved {
                bytes: data_url(&uri)?,
                start: None,
                end: None,
                name: None,
                mime: None,
            }
        } else {
            file(&uri)?
        };
        admit(
            attachments,
            limits,
            &uri,
            uri.starts_with("data:"),
            resolved,
            input,
        )
    }
}

pub fn materialize_upload(
    attachments: &attachment_store::Store,
    limits: image::Limits,
    bytes: Vec<u8>,
    input: Input,
) -> Result<FileAttachment, MaterializeError> {
    let uri = input
        .uri
        .to_utf8()
        .map_err(|_| MaterializeError::Attachment("Invalid attachment URI".into()))?;
    let resolved = Resolved {
        bytes,
        start: None,
        end: None,
        name: None,
        mime: None,
    };
    admit(attachments, limits, &uri, true, resolved, input)
}

fn admit(
    attachments: &attachment_store::Store,
    limits: image::Limits,
    uri: &str,
    inline: bool,
    resolved: Resolved,
    input: Input,
) -> Result<FileAttachment, MaterializeError> {
    if resolved.bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(limit(uri));
    }
    let mime = resolved.mime.unwrap_or_else(|| detect(&resolved.bytes));
    let bytes = match resolved.start.filter(|_| mime == "text/plain") {
        Some(start) => {
            let text = String::from_utf8_lossy(&resolved.bytes);
            let lines = text.split('\n').collect::<Vec<_>>();
            let from = clamp(start - 1.0, lines.len());
            let to = resolved
                .end
                .map_or(lines.len(), |end| clamp(end, lines.len()));
            lines
                .get(from..to.max(from))
                .unwrap_or_default()
                .join("\n")
                .into_bytes()
        }
        None => resolved.bytes,
    };
    let label = input.name.as_ref().map_or_else(
        || {
            if inline {
                "inline attachment".into()
            } else {
                uri.to_owned()
            }
        },
        |name| String::from_utf16_lossy(&name.code_units().collect::<Vec<_>>()),
    );
    let (bytes, mime) = if mime.starts_with("image/") {
        let content = image::Content {
            uri: label.clone(),
            name: None,
            content: image::base64(&bytes),
            mime: mime.into(),
        };
        let normalized = image::normalize(&label, &content, limits)
            .map_err(|error| MaterializeError::Attachment(error.to_string()))?;
        (image::decode_base64(&normalized.content), normalized.mime)
    } else {
        (bytes, mime.to_owned())
    };
    Ok(FileAttachment {
        content: attachments
            .import(&bytes)
            .map_err(|error| MaterializeError::Attachment(error.to_string()))?,
        mime: mime.as_str().into(),
        name: input.name.or(resolved.name.map(Into::into)),
        description: input.description,
        mention: input.mention,
    })
}

impl Service {
    fn recorded_attachment(
        &self,
        uri: &str,
    ) -> Result<Option<(ManagedAttachmentContent, LosslessString)>, MaterializeError> {
        let Some(digest) = attachment_store::managed_digest(uri) else {
            return Ok(None);
        };
        let store = |error: Error| MaterializeError::Store(error.to_string());
        let snapshot = self.client.snapshot().map_err(store)?;
        let mut after: Option<Vec<u8>> = None;
        loop {
            let rows = snapshot
                .scan::<EventTable>(
                    after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                    Bound::Unbounded,
                    256,
                )
                .map_err(store)?;
            let Some(last) = rows.last() else {
                return Ok(None);
            };
            after = Some(<EventTable as ycoding_store::TableSpec>::primary_key(last));
            for row in rows
                .iter()
                .filter(|row| row.type_.as_str() == Some("session.input.admitted.1"))
            {
                let Some(files) = field(&row.data, &["input", "data", "files"]) else {
                    continue;
                };
                let JsonValue::Array(files) = files else {
                    continue;
                };
                for file in files {
                    if field(file, &["content", "digest"]).and_then(|value| match value {
                        JsonValue::String(value) => value.as_str(),
                        _ => None,
                    }) != Some(digest)
                    {
                        continue;
                    }
                    let content = field(file, &["content"])
                        .map(ManagedAttachmentContent::decode)
                        .and_then(Result::ok);
                    let mime = field(file, &["mime"]).and_then(|value| match value {
                        JsonValue::String(value) => Some(value.clone()),
                        _ => None,
                    });
                    if let Some(pair) = content.zip(mime) {
                        return Ok(Some(pair));
                    }
                }
            }
        }
    }
}

pub fn detect(bytes: &[u8]) -> &'static str {
    let at = |offset: usize, prefix: &[u8]| {
        bytes
            .get(offset..)
            .is_some_and(|rest| rest.starts_with(prefix))
    };
    if at(0, &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        return "image/png";
    }
    if at(0, &[0xff, 0xd8, 0xff]) {
        return "image/jpeg";
    }
    if at(0, b"GIF8") {
        return "image/gif";
    }
    if at(0, b"BM") {
        return "image/bmp";
    }
    if at(0, b"%PDF-") {
        return "application/pdf";
    }
    if at(0, b"RIFF") && at(8, b"WEBP") {
        return "image/webp";
    }
    if at(4, b"ftyp") && (at(8, b"avif") || at(8, b"avis")) {
        return "image/avif";
    }
    if text(bytes) {
        "text/plain"
    } else {
        "application/octet-stream"
    }
}

fn text(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return true;
    }
    if bytes.contains(&0) {
        return false;
    }
    // A streaming fatal decoder tolerates one incomplete trailing sequence.
    if let Err(error) = std::str::from_utf8(bytes)
        && error.error_len().is_some()
    {
        return false;
    }
    let controls = bytes
        .iter()
        .filter(|byte| **byte < 9 || (**byte > 13 && **byte < 32))
        .count();
    controls as f64 / bytes.len() as f64 <= 0.3
}

fn file(uri: &str) -> Result<Resolved, MaterializeError> {
    let mut url = url::Url::parse(uri)
        .map_err(|_| MaterializeError::Attachment(format!("Invalid attachment URI: {uri}")))?;
    if url.scheme() != "file" {
        return Err(MaterializeError::Attachment(format!(
            "Unsupported attachment URI: {uri}"
        )));
    }
    let parameter = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .and_then(|(_, value)| positive_integer(&value))
    };
    let start = parameter("start");
    let end = parameter("end");
    url.set_query(None);
    url.set_fragment(None);
    let invalid = || MaterializeError::Attachment(format!("Invalid file URI: {uri}"));
    if url.path().to_ascii_lowercase().contains("%2f") {
        return Err(invalid());
    }
    let target = url.to_file_path().map_err(|_| invalid())?;
    let unreadable = || MaterializeError::Attachment(format!("Unable to read attachment: {uri}"));
    let info = std::fs::metadata(&target).map_err(|_| unreadable())?;
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .or_else(|| Some(String::new()));
    if info.is_dir() {
        return Ok(Resolved {
            bytes: listing(&target).map_err(|_| unreadable())?.into_bytes(),
            start: None,
            end: None,
            name,
            mime: Some("application/x-directory"),
        });
    }
    if !info.is_file() {
        return Err(MaterializeError::Attachment(format!(
            "Attachment is not a file: {uri}"
        )));
    }
    if info.len() > MAX_ATTACHMENT_BYTES as u64 {
        return Err(limit(uri));
    }
    Ok(Resolved {
        bytes: std::fs::read(&target).map_err(|_| unreadable())?,
        start,
        end,
        name,
        mime: None,
    })
}

fn listing(directory: &Path) -> std::io::Result<String> {
    let mut entries = std::fs::read_dir(directory)?
        .map(|entry| {
            let entry = entry?;
            let kind = entry.file_type()?;
            Ok((
                entry.file_name().to_string_lossy().into_owned(),
                kind.is_dir(),
                kind.is_dir() || kind.is_file(),
            ))
        })
        .collect::<std::io::Result<Vec<_>>>()?
        .into_iter()
        .filter(|(_, _, listed)| *listed)
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| {
        b.1.cmp(&a.1).then_with(|| {
            collation::compare(
                &a.0.encode_utf16().collect::<Vec<_>>(),
                &b.0.encode_utf16().collect::<Vec<_>>(),
            )
        })
    });
    Ok(entries
        .iter()
        .map(|(name, directory, _)| {
            if *directory {
                format!("{name}{}", std::path::MAIN_SEPARATOR)
            } else {
                name.clone()
            }
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

fn data_url(uri: &str) -> Result<Vec<u8>, MaterializeError> {
    let invalid = || MaterializeError::Attachment("Invalid attachment data URL".into());
    let comma = uri.find(',').ok_or_else(invalid)?;
    let metadata = uri.get(5..comma).unwrap_or_default();
    let payload = &uri[comma + 1..];
    if !metadata
        .split(';')
        .any(|part| part.eq_ignore_ascii_case("base64"))
    {
        return percent_decode(payload).ok_or_else(invalid);
    }
    let bytes = image::decode_base64(payload);
    if image::base64(&bytes) != payload {
        return Err(invalid());
    }
    Ok(bytes)
}

fn percent_decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            output.push(bytes[index]);
            index += 1;
            continue;
        }
        let hex = bytes.get(index + 1..index + 3)?;
        output.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
        index += 3;
    }
    String::from_utf8(output).ok().map(String::into_bytes)
}

// Mirrors JavaScript Number(value) for the integer forms a positive line bound can take.
fn positive_integer(value: &str) -> Option<f64> {
    let value = trim(value);
    let parsed = if value.is_empty() {
        0.0
    } else if let Some((radix, digits)) = [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ]
    .iter()
    .find_map(|(prefix, radix)| value.strip_prefix(prefix).map(|digits| (*radix, digits)))
    {
        let digits = digits
            .chars()
            .map(|digit| digit.to_digit(radix))
            .collect::<Option<Vec<_>>>()?;
        if digits.is_empty() {
            return None;
        }
        digits.iter().fold(0.0, |total, digit| {
            total * f64::from(radix) + f64::from(*digit)
        })
    } else if value
        .trim_start_matches(['+', '-'])
        .chars()
        .next()
        .is_some_and(|first| first.is_ascii_digit() || first == '.')
    {
        value.parse::<f64>().ok()?
    } else {
        return None;
    };
    (parsed.is_finite() && parsed.fract() == 0.0 && parsed > 0.0).then_some(parsed)
}

fn clamp(value: f64, length: usize) -> usize {
    if value <= 0.0 {
        return 0;
    }
    if value >= length as f64 {
        return length;
    }
    value as usize
}

fn limit(uri: &str) -> MaterializeError {
    MaterializeError::Attachment(format!(
        "Attachment exceeds the {MAX_ATTACHMENT_BYTES} byte limit: {uri}"
    ))
}

fn field<'a>(value: &'a JsonValue, path: &[&str]) -> Option<&'a JsonValue> {
    path.iter().try_fold(value, |value, key| match value {
        JsonValue::Object(object) => object.get(&(*key).into()),
        _ => None,
    })
}
