use super::super::wire::encode_base64;
use super::{
    error::{RpcError, echo},
    json::{self, NumberStyle, ObjectBuilder, lossy},
    types::*,
};
use url::Url;
use ycoding_core::ycoding_schema::{JsonObject, JsonValue};

const U64_LIMIT: f64 = 18_446_744_073_709_551_616.0;
const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PAD: u8 = b'=';

fn os_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        std::env::consts::OS
    }
}

fn invalid(message: impl Into<Text>) -> RpcError {
    RpcError::invalid_params(message)
}

pub fn invalid_type(value: &JsonValue, expected: &str) -> RpcError {
    invalid(format!(
        "invalid type: {}, expected {expected}",
        json::unexpected(value, NumberStyle::IntegralBelowU64)
    ))
}

fn morsel(byte: u8) -> Option<u32> {
    BASE64_ALPHABET
        .iter()
        .position(|candidate| *candidate == byte)
        .map(|index| index as u32)
}

pub fn decode_base64(value: &str) -> Result<Vec<u8>, RpcError> {
    let bytes = value.as_bytes();
    let length = bytes.len();
    let invalid_byte = |index: usize| {
        invalid(format!(
            "Invalid symbol {}, offset {}.",
            bytes[index], index
        ))
    };
    let remainder = length % 4;
    if remainder == 1 && bytes[length - 1] != PAD && morsel(bytes[length - 1]).is_none() {
        return Err(invalid_byte(length - 1));
    }
    let suffix_start = length.saturating_sub(remainder + if remainder == 0 { 4 } else { 0 });
    for (index, byte) in bytes.iter().enumerate().take(suffix_start) {
        if morsel(*byte).is_none() {
            return Err(invalid_byte(index));
        }
    }
    let mut morsels: Vec<u32> = Vec::new();
    let mut first_pad: Option<usize> = None;
    for (index, byte) in bytes.iter().enumerate().skip(suffix_start) {
        if *byte == PAD {
            if index - suffix_start < 2 {
                return Err(invalid_byte(index));
            }
            first_pad.get_or_insert(index);
            continue;
        }
        if let Some(pad) = first_pad {
            return Err(invalid_byte(pad));
        }
        match morsel(*byte) {
            Some(value) => morsels.push(value),
            None => return Err(invalid_byte(index)),
        }
    }
    if length > 0 && morsels.len() < 2 {
        return Err(invalid(format!(
            "Invalid input length: {}",
            suffix_start + morsels.len()
        )));
    }
    let pads = first_pad.map_or(0, |pad| length - pad);
    if !(pads + morsels.len()).is_multiple_of(4) {
        return Err(invalid("Invalid padding"));
    }
    let trailing_bits = match morsels.len() {
        2 => morsels[1] & 0x0f,
        3 => morsels[2] & 0x03,
        _ => 0,
    };
    if trailing_bits != 0 {
        let index = suffix_start + morsels.len() - 1;
        return Err(invalid(format!(
            "Invalid last symbol {}, offset {}.",
            bytes[index], index
        )));
    }
    let mut decoded = Vec::with_capacity(length / 4 * 3);
    let mut accumulator = 0u32;
    let mut bits = 0u32;
    for byte in bytes.iter().take(suffix_start) {
        accumulator = (accumulator << 6) | morsel(*byte).unwrap_or(0);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            decoded.push((accumulator >> bits) as u8);
            accumulator &= (1 << bits) - 1;
        }
    }
    for value in &morsels {
        accumulator = (accumulator << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            decoded.push((accumulator >> bits) as u8);
            accumulator &= (1 << bits) - 1;
        }
    }
    Ok(decoded)
}

fn has_null_byte(pathname: &str) -> bool {
    if !pathname.contains("%00") {
        return false;
    }
    let allowed = pathname.strip_prefix("/%00/bad/path/").is_some_and(|rest| {
        !rest.is_empty()
            && rest
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    });
    !allowed
}

fn uppercase_drive_letter(path: &str) -> String {
    let slashes = path.bytes().take_while(|byte| *byte == b'/').count();
    let rest = &path[slashes..];
    let bytes = rest.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_lowercase() {
        return path.to_string();
    }
    let after_colon = if bytes.get(1) == Some(&b':') {
        2
    } else if bytes.len() >= 4 && bytes[1..4].eq_ignore_ascii_case(b"%3a") {
        4
    } else {
        return path.to_string();
    };
    if after_colon < rest.len() && bytes[after_colon] != b'/' {
        return path.to_string();
    }
    format!(
        "{}{}{}",
        &path[..slashes],
        (bytes[0] as char).to_ascii_uppercase(),
        &rest[1..]
    )
}

pub fn path_uri(value: &str) -> Result<String, RpcError> {
    let url = Url::parse(value).map_err(|error| invalid(format!("invalid URI: {error}")))?;
    if url.scheme() != "file" {
        return Err(invalid(format!(
            "unsupported path URI scheme `{}`",
            url.scheme()
        )));
    }
    let href = url.as_str();
    let hash = href.find('#');
    if href[..hash.unwrap_or(href.len())].contains('?') {
        return Err(invalid("query parameters are not allowed in path URIs"));
    }
    if hash.is_some() {
        return Err(invalid("fragments are not allowed in path URIs"));
    }
    if has_null_byte(url.path()) {
        return Err(invalid(format!("'{href}' is invalid on '{}'", os_name())));
    }
    if let Some(path) = href.strip_prefix("file://")
        && path.starts_with('/')
    {
        return Ok(format!("file://{}", uppercase_drive_letter(path)));
    }
    Ok(href.to_string())
}

#[derive(Clone, Copy)]
enum Kind {
    Text,
    Path,
    U64,
    Usize,
    Flag,
    Bytes,
    Sandbox,
    Mode,
    Walk,
}

#[derive(Clone, Copy)]
enum Need {
    Required,
    Nullable,
    Omittable,
    DefaultRead,
}

struct Field {
    name: &'static str,
    kind: Kind,
    need: Need,
}

const fn field(name: &'static str, kind: Kind, need: Need) -> Field {
    Field { name, kind, need }
}

enum Value {
    Text(Text),
    Path(String),
    Number(u64),
    Flag(bool),
    Bytes(Vec<u8>),
    Object(JsonObject),
    Mode(OpenMode),
    Walk(WalkOptions),
}

struct Decoded(Vec<(&'static str, Value)>);

impl Decoded {
    fn take(&mut self, name: &str) -> Option<Value> {
        let index = self.0.iter().position(|(key, _)| *key == name)?;
        Some(self.0.remove(index).1)
    }

    fn text(&mut self, name: &str) -> Text {
        match self.take(name) {
            Some(Value::Text(text)) => text,
            _ => Text::default(),
        }
    }

    fn path(&mut self, name: &str) -> String {
        match self.take(name) {
            Some(Value::Path(path)) => path,
            _ => String::new(),
        }
    }

    fn number(&mut self, name: &str) -> u64 {
        match self.take(name) {
            Some(Value::Number(number)) => number,
            _ => 0,
        }
    }

    fn flag(&mut self, name: &str) -> Option<bool> {
        match self.take(name) {
            Some(Value::Flag(flag)) => Some(flag),
            _ => None,
        }
    }

    fn bytes(&mut self, name: &str) -> Vec<u8> {
        match self.take(name) {
            Some(Value::Bytes(bytes)) => bytes,
            _ => Vec::new(),
        }
    }

    fn sandbox(&mut self) -> Option<JsonObject> {
        match self.take("sandbox") {
            Some(Value::Object(object)) => Some(object),
            _ => None,
        }
    }
}

fn unsigned(value: &JsonValue, expected: &str) -> Result<u64, RpcError> {
    match value {
        JsonValue::Number(number) if json::is_integer(*number) && number.abs() <= U64_LIMIT => {
            if *number < 0.0 {
                Err(invalid(format!(
                    "invalid value: integer `{}`, expected {expected}",
                    json::number_text(*number)
                )))
            } else {
                Ok(*number as u64)
            }
        }
        other => Err(invalid_type(other, expected)),
    }
}

fn decode_value(kind: Kind, value: &JsonValue) -> Result<Value, RpcError> {
    match kind {
        Kind::Text => match value {
            JsonValue::String(text) => Ok(Value::Text(text.clone())),
            other => Err(invalid_type(other, "a string")),
        },
        Kind::Path => match value {
            JsonValue::String(text) => Ok(Value::Path(path_uri(&lossy(text))?)),
            other => Err(invalid_type(other, "a string")),
        },
        Kind::U64 => Ok(Value::Number(unsigned(value, "u64")?)),
        Kind::Usize => Ok(Value::Number(unsigned(value, "usize")?)),
        Kind::Flag => match value {
            JsonValue::Bool(flag) => Ok(Value::Flag(*flag)),
            other => Err(invalid_type(other, "a boolean")),
        },
        Kind::Bytes => match value {
            JsonValue::String(text) => Ok(Value::Bytes(decode_base64(&lossy(text))?)),
            other => Err(invalid_type(other, "a string")),
        },
        Kind::Sandbox => match value {
            JsonValue::Object(object) => Ok(Value::Object(object.clone())),
            other => Err(invalid_type(other, "struct WireFileSystemSandboxContext")),
        },
        Kind::Mode => match value {
            JsonValue::String(text) => match lossy(text).as_str() {
                "read" => Ok(Value::Mode(OpenMode::Read)),
                "replace" => Ok(Value::Mode(OpenMode::Replace)),
                _ => Err(invalid(echo(
                    "unknown variant `",
                    text,
                    "`, expected `read` or `replace`",
                ))),
            },
            other => Err(invalid_type(other, "string or map")),
        },
        Kind::Walk => {
            let mut decoded = decode_struct("WalkOptions", &WALK_OPTIONS, value)?;
            Ok(Value::Walk(WalkOptions {
                max_depth: decoded.number("maxDepth"),
                max_directories: decoded.number("maxDirectories"),
                max_entries: decoded.number("maxEntries"),
                follow_directory_symlinks: decoded.flag("followDirectorySymlinks").unwrap_or(false),
                prune_hidden_directories: decoded.flag("pruneHiddenDirectories"),
            }))
        }
    }
}

fn decode_struct(name: &str, fields: &[Field], value: &JsonValue) -> Result<Decoded, RpcError> {
    let JsonValue::Object(object) = value else {
        return Err(invalid_type(value, &format!("struct {name}")));
    };
    let mut decoded: Vec<(&'static str, Value)> = Vec::new();
    for (key, item) in object.iter() {
        let key = lossy(key);
        let Some(field) = fields.iter().find(|field| field.name == key) else {
            continue;
        };
        if matches!(field.need, Need::Nullable) && matches!(item, JsonValue::Null) {
            continue;
        }
        decoded.push((field.name, decode_value(field.kind, item)?));
    }
    for field in fields {
        if json::has(object, field.name) {
            continue;
        }
        match field.need {
            Need::Required => return Err(invalid(format!("missing field `{}`", field.name))),
            Need::DefaultRead => decoded.push((field.name, Value::Mode(OpenMode::Read))),
            Need::Nullable | Need::Omittable => {}
        }
    }
    Ok(Decoded(decoded))
}

const WALK_OPTIONS: [Field; 5] = [
    field("maxDepth", Kind::Usize, Need::Required),
    field("maxDirectories", Kind::Usize, Need::Required),
    field("maxEntries", Kind::Usize, Need::Required),
    field("followDirectorySymlinks", Kind::Flag, Need::Required),
    field("pruneHiddenDirectories", Kind::Flag, Need::Omittable),
];
const CREATE_DIRECTORY: [Field; 4] = [
    field("path", Kind::Path, Need::Required),
    field("recursive", Kind::Flag, Need::Nullable),
    field("followSymlinks", Kind::Flag, Need::Nullable),
    field("sandbox", Kind::Sandbox, Need::Nullable),
];
const OPEN: [Field; 4] = [
    field("handleId", Kind::Text, Need::Required),
    field("path", Kind::Path, Need::Required),
    field("mode", Kind::Mode, Need::DefaultRead),
    field("sandbox", Kind::Sandbox, Need::Nullable),
];
const READ_BLOCK: [Field; 3] = [
    field("handleId", Kind::Text, Need::Required),
    field("offset", Kind::U64, Need::Required),
    field("len", Kind::Usize, Need::Required),
];
const WRITE_BLOCK: [Field; 3] = [
    field("handleId", Kind::Text, Need::Required),
    field("offset", Kind::U64, Need::Required),
    field("chunk", Kind::Bytes, Need::Required),
];
const CLOSE: [Field; 1] = [field("handleId", Kind::Text, Need::Required)];
const WALK: [Field; 3] = [
    field("path", Kind::Path, Need::Required),
    field("options", Kind::Walk, Need::Required),
    field("sandbox", Kind::Sandbox, Need::Nullable),
];
const REMOVE: [Field; 5] = [
    field("path", Kind::Path, Need::Required),
    field("recursive", Kind::Flag, Need::Nullable),
    field("force", Kind::Flag, Need::Nullable),
    field("followSymlinks", Kind::Flag, Need::Nullable),
    field("sandbox", Kind::Sandbox, Need::Nullable),
];
const COPY: [Field; 4] = [
    field("sourcePath", Kind::Path, Need::Required),
    field("destinationPath", Kind::Path, Need::Required),
    field("recursive", Kind::Flag, Need::Required),
    field("sandbox", Kind::Sandbox, Need::Nullable),
];

pub fn decode_create_directory(params: &JsonValue) -> Result<CreateDirectoryParams, RpcError> {
    let mut decoded = decode_struct("WireFsCreateDirectoryParams", &CREATE_DIRECTORY, params)?;
    Ok(CreateDirectoryParams {
        path: decoded.path("path"),
        recursive: decoded.flag("recursive"),
        follow_symlinks: decoded.flag("followSymlinks"),
        sandbox: decoded.sandbox(),
    })
}

pub fn decode_open(params: &JsonValue) -> Result<OpenParams, RpcError> {
    let mut decoded = decode_struct("WireFsOpenParams", &OPEN, params)?;
    let mode = match decoded.take("mode") {
        Some(Value::Mode(mode)) => mode,
        _ => OpenMode::Read,
    };
    Ok(OpenParams {
        handle_id: decoded.text("handleId"),
        path: decoded.path("path"),
        mode,
        sandbox: decoded.sandbox(),
    })
}

pub fn decode_read_block(params: &JsonValue) -> Result<ReadBlockParams, RpcError> {
    let mut decoded = decode_struct("FsReadBlockParams", &READ_BLOCK, params)?;
    Ok(ReadBlockParams {
        handle_id: decoded.text("handleId"),
        offset: decoded.number("offset"),
        len: decoded.number("len"),
    })
}

pub fn decode_write_block(params: &JsonValue) -> Result<WriteBlockParams, RpcError> {
    let mut decoded = decode_struct("FsWriteBlockParams", &WRITE_BLOCK, params)?;
    Ok(WriteBlockParams {
        handle_id: decoded.text("handleId"),
        offset: decoded.number("offset"),
        chunk: decoded.bytes("chunk"),
    })
}

pub fn decode_close(params: &JsonValue) -> Result<CloseParams, RpcError> {
    let mut decoded = decode_struct("FsCloseParams", &CLOSE, params)?;
    Ok(CloseParams {
        handle_id: decoded.text("handleId"),
    })
}

pub fn decode_walk(params: &JsonValue) -> Result<WalkParams, RpcError> {
    let mut decoded = decode_struct("WireFsWalkParams", &WALK, params)?;
    let options = match decoded.take("options") {
        Some(Value::Walk(options)) => options,
        _ => WalkOptions {
            max_depth: 0,
            max_directories: 0,
            max_entries: 0,
            follow_directory_symlinks: false,
            prune_hidden_directories: None,
        },
    };
    Ok(WalkParams {
        path: decoded.path("path"),
        options,
        sandbox: decoded.sandbox(),
    })
}

pub fn decode_remove(params: &JsonValue) -> Result<RemoveParams, RpcError> {
    let mut decoded = decode_struct("WireFsRemoveParams", &REMOVE, params)?;
    Ok(RemoveParams {
        path: decoded.path("path"),
        recursive: decoded.flag("recursive"),
        force: decoded.flag("force"),
        follow_symlinks: decoded.flag("followSymlinks"),
        sandbox: decoded.sandbox(),
    })
}

pub fn decode_copy(params: &JsonValue) -> Result<CopyParams, RpcError> {
    let mut decoded = decode_struct("WireFsCopyParams", &COPY, params)?;
    Ok(CopyParams {
        source_path: decoded.path("sourcePath"),
        destination_path: decoded.path("destinationPath"),
        recursive: decoded.flag("recursive").unwrap_or(false),
        sandbox: decoded.sandbox(),
    })
}

pub fn encode_empty() -> JsonValue {
    ObjectBuilder::new().finish()
}

pub fn encode_open_result(result: &OpenResult) -> JsonValue {
    ObjectBuilder::new()
        .field("handleId", json::lossless(&result.handle_id))
        .finish()
}

pub fn encode_read_block_result(result: &ReadBlockResult) -> JsonValue {
    ObjectBuilder::new()
        .field("chunk", json::text(&encode_base64(&result.chunk)))
        .field("eof", JsonValue::Bool(result.eof))
        .finish()
}

pub fn encode_walk_result(result: &WalkResult) -> JsonValue {
    let entries = result
        .entries
        .iter()
        .map(|entry| {
            ObjectBuilder::new()
                .field("path", json::text(&entry.path))
                .field(
                    "kind",
                    json::text(match entry.kind {
                        WalkEntryKind::Directory => "directory",
                        WalkEntryKind::File => "file",
                    }),
                )
                .finish()
        })
        .collect();
    let errors = result
        .errors
        .iter()
        .map(|error| {
            ObjectBuilder::new()
                .field("path", json::text(&error.path))
                .field("message", json::lossless(&error.message))
                .finish()
        })
        .collect();
    ObjectBuilder::new()
        .field("entries", JsonValue::Array(entries))
        .field("errors", JsonValue::Array(errors))
        .field("truncated", JsonValue::Bool(result.truncated))
        .finish()
}
