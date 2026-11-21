use crate::platform::filesystem;
use std::{
    fs::{self, File},
    io::{self, BufRead, BufReader, Read},
    path::Path,
};
use ycoding_schema::{JsonValue, LosslessString, ObjectEncoder};

pub const MAX_READ_LINES: usize = 2000;
pub const MAX_READ_BYTES: usize = 50 * 1024;
pub const MAX_MEDIA_INGEST_BYTES: usize = 20 * 1024 * 1024;
#[derive(Clone, Copy, Default)]
pub struct Page {
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}
#[derive(Debug)]
pub enum ReadError {
    Io(io::Error),
    Binary(String),
    MediaLimit(String),
    MalformedUtf8(String),
    Offset(usize),
    PathKind(String),
}
impl From<io::Error> for ReadError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
impl std::fmt::Display for ReadError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => error.fmt(output),
            Self::Binary(resource) => write!(output, "Cannot read binary file: {resource}"),
            Self::MediaLimit(resource) => write!(
                output,
                "Media exceeds {MAX_MEDIA_INGEST_BYTES} byte ingestion limit: {resource}"
            ),
            Self::MalformedUtf8(resource) => write!(output, "File is not valid UTF-8: {resource}"),
            Self::Offset(offset) => write!(output, "Offset {offset} is out of range"),
            Self::PathKind(resource) => write!(output, "Path is not a file: {resource}"),
        }
    }
}
impl std::error::Error for ReadError {}

pub fn read(path: &Path, resource: &str, page: Page) -> Result<JsonValue, ReadError> {
    let real = fs::canonicalize(path)?;
    let file = File::open(&real)?;
    let info = file.metadata()?;
    if !info.is_file() {
        return Err(ReadError::PathKind(resource.into()));
    }
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let first = reader.fill_buf()?;
    let image = if first.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if first.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if first.starts_with(b"GIF8") {
        Some("image/gif")
    } else if first.starts_with(b"RIFF") && first.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    };
    if let Some(mime) = image {
        if info.len() > MAX_MEDIA_INGEST_BYTES as u64 {
            return Err(ReadError::MediaLimit(resource.into()));
        }
        let mut bytes = Vec::new();
        reader
            .take((MAX_MEDIA_INGEST_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_MEDIA_INGEST_BYTES {
            return Err(ReadError::MediaLimit(resource.into()));
        }
        return Ok(content(&real, mime, base64(&bytes).into(), "base64"));
    }
    let extension = Path::new(resource)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if first.starts_with(b"%PDF")
        || [
            "zip", "tar", "gz", "exe", "dll", "so", "class", "jar", "war", "7z", "doc", "docx",
            "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "bin", "dat", "obj", "o", "a",
            "lib", "wasm", "pyc", "pyo",
        ]
        .contains(&extension.as_str())
    {
        return Err(ReadError::Binary(resource.into()));
    }
    let mime = filesystem::mime_type(
        real.to_str()
            .ok_or_else(|| io::Error::other("Path is not UTF-8"))?,
    );
    if info.len() <= MAX_READ_BYTES as u64 && page.offset.is_none() && page.limit.is_none() {
        if binary(first) {
            return Err(ReadError::Binary(resource.into()));
        }
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes)?;
        if bytes.contains(&0) {
            return Err(ReadError::Binary(resource.into()));
        }
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| ReadError::MalformedUtf8(resource.into()))?
            .strip_prefix('\u{feff}')
            .unwrap_or(std::str::from_utf8(&bytes).unwrap());
        return Ok(content(&real, mime, text.into(), "utf8"));
    }
    let offset = page.offset.unwrap_or(1);
    let limit = page.limit.unwrap_or(MAX_READ_LINES).min(MAX_READ_LINES);
    let mut lines = Vec::<LosslessString>::new();
    let mut line = 1;
    let mut size = 0;
    let mut next = None;
    let mut pending = Vec::<u16>::new();
    let mut carry = Vec::<u8>::new();
    let mut initial = true;
    loop {
        let bytes = reader.fill_buf()?;
        if bytes.is_empty() {
            if !carry.is_empty() {
                return Err(ReadError::MalformedUtf8(resource.into()));
            }
            if !pending.is_empty() {
                append(
                    &mut pending,
                    &mut lines,
                    &mut line,
                    offset,
                    limit,
                    &mut size,
                    &mut next,
                );
            }
            break;
        }
        if lines.len() >= limit || size >= MAX_READ_BYTES {
            next = Some(line);
            break;
        }
        let length = bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |index| index + 1);
        let bytes = &bytes[..length];
        if binary(bytes) {
            return Err(ReadError::Binary(resource.into()));
        }
        let newline = bytes.last() == Some(&b'\n');
        carry.extend_from_slice(bytes);
        let (text, consumed) = match std::str::from_utf8(&carry) {
            Ok(text) => (text, carry.len()),
            Err(error) if error.error_len().is_none() && !newline => (
                std::str::from_utf8(&carry[..error.valid_up_to()]).unwrap(),
                error.valid_up_to(),
            ),
            Err(_) => return Err(ReadError::MalformedUtf8(resource.into())),
        };
        let text = if initial {
            initial = false;
            text.strip_prefix('\u{feff}').unwrap_or(text)
        } else {
            text
        };
        let text = text.strip_suffix('\n').unwrap_or(text);
        pending.extend(
            text.encode_utf16()
                .take(2001usize.saturating_sub(pending.len())),
        );
        carry.drain(..consumed);
        reader.consume(length);
        if newline
            && !append(
                &mut pending,
                &mut lines,
                &mut line,
                offset,
                limit,
                &mut size,
                &mut next,
            )
        {
            break;
        }
    }
    if lines.is_empty() && offset != 1 {
        return Err(ReadError::Offset(offset));
    }
    let content = LosslessString::from_utf16(
        lines
            .iter()
            .enumerate()
            .flat_map(|(index, line)| {
                if index == 0 {
                    line.code_units().collect::<Vec<_>>()
                } else {
                    std::iter::once(10).chain(line.code_units()).collect()
                }
            })
            .collect(),
    );
    let mut output = ObjectEncoder::new()
        .field("type", "text-page")
        .field("content", &content)
        .field("mime", mime)
        .field("offset", &(offset as f64))
        .field("truncated", &next.is_some());
    if let Some(next) = next {
        output = output.field("next", &(next as f64));
    }
    Ok(output.finish())
}

fn append(
    pending: &mut Vec<u16>,
    lines: &mut Vec<LosslessString>,
    line: &mut usize,
    offset: usize,
    limit: usize,
    bytes: &mut usize,
    next: &mut Option<usize>,
) -> bool {
    let mut current = std::mem::take(pending);
    if current.last() == Some(&13) {
        current.pop();
    }
    if *line < offset {
        *line += 1;
        return true;
    }
    if lines.len() >= limit || *bytes >= MAX_READ_BYTES {
        *next = Some(*line);
        return false;
    }
    if current.len() > 2000 {
        current.truncate(2000);
        current.extend("... (line truncated to 2000 chars)".encode_utf16());
    }
    let size = String::from_utf16_lossy(&current).len() + usize::from(!lines.is_empty());
    if *bytes + size > MAX_READ_BYTES {
        *next = Some(*line);
        return false;
    }
    lines.push(LosslessString::from_utf16(current));
    *bytes += size;
    *line += 1;
    true
}
fn binary(bytes: &[u8]) -> bool {
    bytes.contains(&0)
        || (!bytes.is_empty()
            && bytes
                .iter()
                .filter(|byte| **byte < 9 || (**byte > 13 && **byte < 32))
                .count() as f64
                / bytes.len() as f64
                > 0.3)
}
fn content(path: &Path, mime: &str, text: LosslessString, encoding: &str) -> JsonValue {
    ObjectEncoder::new()
        .field("uri", url::Url::from_file_path(path).unwrap().as_str())
        .field("name", path.file_name().unwrap().to_string_lossy().as_ref())
        .field("content", &text)
        .field("encoding", encoding)
        .field("mime", mime)
        .finish()
}
pub fn list(
    path: &Path,
    page: Page,
    collator: &crate::tools::code_mode::Collation,
) -> Result<JsonValue, ReadError> {
    let root = fs::canonicalize(path)?;
    let mut entries = fs::read_dir(&root)?
        .filter_map(|item| {
            let item = match item {
                Ok(item) => item,
                Err(error) => return Some(Err(error)),
            };
            let real = fs::canonicalize(item.path()).ok()?;
            if !filesystem::contains(&root, &real) {
                return None;
            }
            let info = fs::metadata(real).ok()?;
            let kind = if info.is_dir() {
                "directory"
            } else if info.is_file() {
                "file"
            } else {
                return None;
            };
            let name = format!(
                "{}{}",
                item.file_name().to_string_lossy(),
                if info.is_dir() {
                    std::path::MAIN_SEPARATOR_STR
                } else {
                    ""
                }
            );
            Some(Ok((kind, name)))
        })
        .collect::<Result<Vec<_>, io::Error>>()?;
    entries.sort_by(|left, right| {
        (left.0 != "directory")
            .cmp(&(right.0 != "directory"))
            .then_with(|| {
                collator(
                    &left.1.encode_utf16().collect::<Vec<_>>(),
                    &right.1.encode_utf16().collect::<Vec<_>>(),
                )
            })
    });
    let offset = page.offset.unwrap_or(1);
    let selected = entries
        .iter()
        .skip(offset - 1)
        .take(page.limit.unwrap_or(MAX_READ_LINES).min(MAX_READ_LINES))
        .map(|(kind, name)| {
            ObjectEncoder::new()
                .field("path", name.as_str())
                .field("type", *kind)
                .finish()
        })
        .collect::<Vec<_>>();
    let truncated = offset - 1 + selected.len() < entries.len();
    let next = offset + selected.len();
    let mut output = ObjectEncoder::new()
        .field("entries", &JsonValue::Array(selected))
        .field("truncated", &truncated);
    if truncated {
        output = output.field("next", &(next as f64));
    }
    Ok(output.finish())
}
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    bytes
        .chunks(3)
        .flat_map(|chunk| {
            let value = (u32::from(chunk[0]) << 16)
                | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
                | u32::from(*chunk.get(2).unwrap_or(&0));
            [
                ALPHABET[((value >> 18) & 63) as usize] as char,
                ALPHABET[((value >> 12) & 63) as usize] as char,
                if chunk.len() > 1 {
                    ALPHABET[((value >> 6) & 63) as usize] as char
                } else {
                    '='
                },
                if chunk.len() > 2 {
                    ALPHABET[(value & 63) as usize] as char
                } else {
                    '='
                },
            ]
        })
        .collect()
}
