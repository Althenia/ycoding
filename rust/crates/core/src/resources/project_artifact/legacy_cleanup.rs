use super::{filesystem, package};
use crate::resources::discovery;
use std::{
    fs, io,
    path::{Path, PathBuf},
};
use ycoding_schema::{JsonPath, JsonValue, LosslessString, ObjectDecoder};

pub struct Input<'a> {
    pub root: &'a Path,
    pub cursor: Option<&'a str>,
    pub limit: Option<usize>,
}
type RemoveHook<'a> = &'a dyn Fn(&Path) -> io::Result<()>;
#[derive(Default)]
pub struct Dependencies<'a> {
    pub before_remove: Option<RemoveHook<'a>>,
    pub remove: Option<RemoveHook<'a>>,
}
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Status {
    Partial,
    Complete,
    Failed,
}
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ErrorCode {
    RootUnavailable,
    EntryUnavailable,
    RemoveFailed,
}
#[derive(Debug, PartialEq)]
pub struct Report {
    pub status: Status,
    pub cursor: Option<String>,
    pub scanned: usize,
    pub removed: usize,
    pub skipped: usize,
    pub failed: usize,
    pub error_code: Option<ErrorCode>,
}
pub struct Service {
    root: PathBuf,
}
impl Service {
    pub fn new(config: &Path) -> Self {
        Self {
            root: config.join("generated"),
        }
    }
    pub fn run(&self, cursor: Option<&str>, limit: Option<usize>) -> Report {
        run(
            Input {
                root: &self.root,
                cursor,
                limit,
            },
            Dependencies::default(),
        )
    }
}
pub fn run(input: Input<'_>, dependencies: Dependencies<'_>) -> Report {
    let Ok(root) = discovery::absolute(input.root) else {
        return unavailable(ErrorCode::RootUnavailable);
    };
    let Some(parent) = root.parent() else {
        return unavailable(ErrorCode::RootUnavailable);
    };
    let Some(root_identity) = directory_identity(&root) else {
        return unavailable(ErrorCode::RootUnavailable);
    };
    let Some(parent_identity) = directory_identity(parent) else {
        return unavailable(ErrorCode::RootUnavailable);
    };
    if fs::canonicalize(&root).ok().as_ref() != Some(&root) {
        return unavailable(ErrorCode::RootUnavailable);
    }
    let Ok(listed) = fs::read_dir(&root) else {
        return unavailable(ErrorCode::EntryUnavailable);
    };
    let Ok(mut entries) = listed.collect::<Result<Vec<_>, _>>() else {
        return unavailable(ErrorCode::EntryUnavailable);
    };
    entries.retain(|entry| {
        input.cursor.is_none_or(|cursor| {
            entry
                .file_name()
                .to_string_lossy()
                .encode_utf16()
                .cmp(cursor.encode_utf16())
                .is_gt()
        })
    });
    entries.sort_by(|left, right| {
        left.file_name()
            .to_string_lossy()
            .encode_utf16()
            .cmp(right.file_name().to_string_lossy().encode_utf16())
    });
    let remaining = entries.len();
    let mut report = Report {
        status: Status::Complete,
        cursor: input.cursor.map(str::to_owned),
        scanned: 0,
        removed: 0,
        skipped: 0,
        failed: 0,
        error_code: None,
    };
    for entry in entries
        .into_iter()
        .take(input.limit.unwrap_or(256).clamp(1, 256))
    {
        report.scanned += 1;
        match inspect(&root, root_identity, parent_identity, &entry, &dependencies) {
            Ok(true) => report.removed += 1,
            Ok(false) => report.skipped += 1,
            Err(error) => {
                report.failed += 1;
                report.error_code = Some(error);
                break;
            }
        }
        report.cursor = Some(entry.file_name().to_string_lossy().into_owned());
    }
    if report.failed > 0 || remaining > report.scanned {
        report.status = Status::Partial;
    }
    report
}
fn inspect(
    root: &Path,
    root_identity: Identity,
    parent_identity: Identity,
    entry: &fs::DirEntry,
    dependencies: &Dependencies<'_>,
) -> Result<bool, ErrorCode> {
    let name = entry.file_name();
    let Some(name) = name.to_str() else {
        return Ok(false);
    };
    let Some((prefix, suffix)) = name.rsplit_once('-') else {
        return Ok(false);
    };
    if prefix.is_empty()
        || !prefix.as_bytes()[0].is_ascii_lowercase() && !prefix.as_bytes()[0].is_ascii_digit()
        || !prefix.as_bytes()[prefix.len() - 1].is_ascii_lowercase()
            && !prefix.as_bytes()[prefix.len() - 1].is_ascii_digit()
        || !prefix
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        || suffix.len() != 12
        || !suffix.bytes().all(lower_hex)
    {
        return Ok(false);
    }
    let listed_type = entry.file_type().map_err(|_| ErrorCode::EntryUnavailable)?;
    if !listed_type.is_dir() || listed_type.is_symlink() {
        return Ok(false);
    }
    let child = root.join(name);
    let child_info = fs::symlink_metadata(&child).map_err(|_| ErrorCode::EntryUnavailable)?;
    if !child_info.is_dir() || child_info.is_symlink() {
        return Ok(false);
    }
    let marker_path = child.join(".ycoding-generated.json");
    let Ok(marker_info) = fs::symlink_metadata(&marker_path) else {
        return Ok(false);
    };
    if !marker_info.is_file() || marker_info.is_symlink() {
        return Ok(false);
    }
    let content = fs::read(&marker_path).map_err(|_| ErrorCode::EntryUnavailable)?;
    if ownership_suffix(&content).as_deref() != Some(suffix) {
        return Ok(false);
    }
    if let Some(before_remove) = dependencies.before_remove {
        before_remove(&child).map_err(|_| ErrorCode::EntryUnavailable)?;
    }
    let parent = root.parent().ok_or(ErrorCode::EntryUnavailable)?;
    if directory_identity(root) != Some(root_identity)
        || directory_identity(parent) != Some(parent_identity)
        || directory_identity(&child) != identity(&child_info)
        || fs::symlink_metadata(&marker_path)
            .ok()
            .filter(|info| info.is_file() && !info.is_symlink())
            .and_then(|info| identity(&info))
            != identity(&marker_info)
        || fs::read(&marker_path).ok().as_ref() != Some(&content)
    {
        return Err(ErrorCode::EntryUnavailable);
    }
    let child_identity = identity(&child_info).ok_or(ErrorCode::EntryUnavailable)?;
    let quarantine = parent.join(format!(
        ".ycoding-cleanup-{}-{name}-{}-{}",
        root.file_name()
            .ok_or(ErrorCode::EntryUnavailable)?
            .to_string_lossy(),
        child_identity.device,
        child_identity.inode
    ));
    if fs::symlink_metadata(&quarantine).is_ok() {
        return Err(ErrorCode::EntryUnavailable);
    }
    filesystem::move_across(root, parent, &child, &quarantine, &Default::default())
        .map_err(|_| ErrorCode::RemoveFailed)?;
    if directory_identity(&quarantine) != Some(child_identity)
        || directory_identity(root) != Some(root_identity)
        || directory_identity(parent) != Some(parent_identity)
    {
        return Err(ErrorCode::EntryUnavailable);
    }
    let removed = match dependencies.remove {
        Some(remove) => remove(&quarantine).is_ok(),
        None => filesystem::remove(parent, &quarantine, true, &Default::default()).is_ok(),
    };
    if removed {
        return Ok(true);
    }
    if fs::symlink_metadata(&child).is_err_and(|error| error.kind() == io::ErrorKind::NotFound) {
        let _ = filesystem::move_across(parent, root, &quarantine, &child, &Default::default());
    }
    Err(ErrorCode::RemoveFailed)
}
fn ownership_suffix(content: &[u8]) -> Option<String> {
    let value = ycoding_schema::parse_json(&String::from_utf8_lossy(content)).ok()?;
    let path = JsonPath::default();
    let object = ObjectDecoder::new(&value, &path).ok()?;
    object.literal("generated", &JsonValue::Bool(true)).ok()?;
    let location: LosslessString = object.field("locationID").ok()?;
    let artifact: LosslessString = object.field("artifactID").ok()?;
    let version: LosslessString = object.field("versionID").ok()?;
    let digest: Option<LosslessString> = object.optional("versionDigest").ok()?;
    if location.is_empty()
        || artifact.is_empty()
        || version.is_empty()
        || digest.is_some_and(|digest| {
            digest
                .as_str()
                .is_none_or(|digest| digest.len() != 64 || !digest.bytes().all(lower_hex))
        })
    {
        return None;
    }
    Some(
        package::sha256(&discovery::join(&[location, artifact], "\0"))
            .as_lossless()
            .as_str()?[..12]
            .to_owned(),
    )
}
fn lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}
#[derive(Clone, Copy, PartialEq)]
struct Identity {
    device: u64,
    inode: u64,
}
fn directory_identity(path: &Path) -> Option<Identity> {
    fs::symlink_metadata(path)
        .ok()
        .filter(|info| info.is_dir() && !info.is_symlink())
        .and_then(|info| identity(&info))
}
#[cfg(unix)]
fn identity(info: &fs::Metadata) -> Option<Identity> {
    use std::os::unix::fs::MetadataExt;
    Some(Identity {
        device: info.dev(),
        inode: info.ino(),
    })
}
#[cfg(not(unix))]
fn identity(_: &fs::Metadata) -> Option<Identity> {
    None
}
fn unavailable(error: ErrorCode) -> Report {
    Report {
        status: Status::Failed,
        cursor: None,
        scanned: 0,
        removed: 0,
        skipped: 0,
        failed: 1,
        error_code: Some(error),
    }
}
