use std::{
    fmt,
    path::{Component, Path, PathBuf},
};
use ycoding_schema::{
    DecodeError, DomainDecode, JsonObject, JsonValue, model, schema::AbsolutePath,
};

mod files;
pub mod markdown;
pub mod repository;
pub mod wellknown;
pub(crate) use files::documents;
pub use files::{Kind, scan};
#[derive(Clone, Debug, PartialEq)]
pub enum WatchTarget {
    Directory(PathBuf),
    File(PathBuf),
}
pub struct WatchInputs {
    targets: Vec<WatchTarget>,
    revision: u64,
}
impl WatchInputs {
    pub fn new(entries: &[super::config::Entry]) -> Self {
        let mut targets = Vec::new();
        for entry in entries {
            if let super::config::Entry::Directory(path) = entry {
                let target = WatchTarget::Directory(path.clone());
                if !targets.contains(&target) {
                    targets.push(target);
                }
            }
        }
        for entry in entries {
            if let super::config::Entry::File(path) = entry {
                let target = WatchTarget::File(path.clone());
                if !targets.contains(&target) && !targets.iter().any(|target|matches!(target,WatchTarget::Directory(directory) if path.starts_with(directory))) { targets.push(target); }
            }
        }
        Self {
            targets,
            revision: 0,
        }
    }
    pub fn targets(&self) -> &[WatchTarget] {
        &self.targets
    }
    pub fn changed(&mut self, file: &Path) -> bool {
        let matched = self.targets.iter().any(|target| match target {
            WatchTarget::Directory(directory) => file.starts_with(directory),
            WatchTarget::File(path) => file == path,
        });
        if matched {
            self.revision += 1;
        }
        matched
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Diagnostic {
    pub path: String,
    pub reason: String,
    pub message: String,
}

#[derive(Debug)]
pub enum Error {
    Io {
        path: PathBuf,
        cause: std::io::Error,
    },
    Decode(DecodeError),
    InvalidPath(PathBuf),
    Rejected(&'static str),
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { path, cause } => write!(
                f,
                "Resource filesystem operation failed at {}: {cause}",
                path.display()
            ),
            Self::Decode(e) => e.fmt(f),
            Self::InvalidPath(path) => {
                write!(f, "Resource path is not valid Unicode: {}", path.display())
            }
            Self::Rejected(message) => f.write_str(message),
        }
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { cause, .. } => Some(cause),
            Self::Decode(cause) => Some(cause),
            Self::InvalidPath(_) | Self::Rejected(_) => None,
        }
    }
}
impl From<DecodeError> for Error {
    fn from(e: DecodeError) -> Self {
        Self::Decode(e)
    }
}

pub fn absolute_path(path: &Path) -> Result<AbsolutePath, Error> {
    let path = absolute(path)?;
    let text = path
        .to_str()
        .ok_or_else(|| Error::InvalidPath(path.clone()))?;
    Ok(AbsolutePath::decode(&JsonValue::String(text.into()))?)
}

pub fn absolute(path: &Path) -> Result<PathBuf, Error> {
    let path = if path.is_absolute() {
        path.into()
    } else {
        std::env::current_dir().map_err(|e| io(path, e))?.join(path)
    };
    Ok(path
        .components()
        .fold(PathBuf::new(), |mut result, component| {
            match component {
                Component::CurDir => {}
                Component::ParentDir => {
                    result.pop();
                }
                component => result.push(component),
            }
            result
        }))
}

pub fn resolve(path: &Path) -> Result<PathBuf, Error> {
    let path = absolute(path)?;
    match std::fs::canonicalize(&path) {
        Ok(path) => Ok(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(path),
        Err(e) => Err(io(&path, e)),
    }
}

pub fn read_text(path: &Path) -> Result<Option<String>, Error> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(
            String::from_utf8_lossy(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes))
                .into_owned(),
        )),
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
            ) =>
        {
            Ok(None)
        }
        Err(e) => Err(io(path, e)),
    }
}

pub(crate) fn io(path: &Path, cause: std::io::Error) -> Error {
    Error::Io {
        path: path.into(),
        cause,
    }
}
pub(crate) fn whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
pub(crate) fn trim(s: &str) -> &str {
    s.trim_matches(whitespace)
}
pub(crate) fn join(
    parts: &[ycoding_schema::LosslessString],
    separator: &str,
) -> ycoding_schema::LosslessString {
    let separator = separator.encode_utf16().collect::<Vec<_>>();
    let mut output = Vec::new();
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            output.extend(&separator);
        }
        output.extend(part.code_units());
    }
    ycoding_schema::LosslessString::from_utf16(output)
}
pub(crate) fn object(value: &JsonValue) -> Result<&JsonObject, Error> {
    match value {
        JsonValue::Object(o) => Ok(o),
        _ => Err(Error::Decode(
            ycoding_schema::JsonPath::default()
                .error(ycoding_schema::DecodeErrorKind::Expected("object")),
        )),
    }
}
pub(crate) fn selection(value: &JsonValue) -> Result<model::Ref, Error> {
    let mut value = object(value)?.clone();
    let id = value
        .get(&"model".into())
        .ok_or_else(|| {
            ycoding_schema::JsonPath::default()
                .key("model")
                .error(ycoding_schema::DecodeErrorKind::Missing)
        })?
        .clone();
    value.insert("id".into(), id);
    Ok(model::Ref::decode(&JsonValue::Object(value))?)
}
