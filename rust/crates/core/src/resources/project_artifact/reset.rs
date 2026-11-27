use super::{filesystem, package};
use std::{
    fs, io,
    path::{Path, PathBuf},
};
use ycoding_schema::{DomainDecode, JsonPath, JsonValue, LosslessString, ObjectDecoder};

const SCOPE_MARKER: &str = ".ycoding-scope.json";
const GENERATED_MARKER: &str = ".ycoding-generated.json";
const MANAGED_MARKER: &str = ".ycoding-project-artifact.json";
const QUARANTINE_PREFIX: &str = ".ycoding-cleanup-generated-";

pub struct Roots {
    pub data: PathBuf,
    pub config: PathBuf,
    pub cache: PathBuf,
    pub standard: Vec<PathBuf>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    ScopeStore,
    GeneratedSkill,
    Quarantine,
    ManagedSkill,
    ManagedFile,
    DiscoveryCache,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub kind: Kind,
    pub path: PathBuf,
    root: PathBuf,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub removed: Vec<PathBuf>,
    pub failed: Vec<PathBuf>,
}

pub fn plan(roots: &Roots) -> Vec<Item> {
    let mut items = Vec::new();
    let stores = roots.data.join("project-artifacts");
    items.extend(
        children(&stores)
            .filter(|path| is_real_dir(path) && is_real_file(&path.join(SCOPE_MARKER)))
            .map(|path| item(Kind::ScopeStore, path, &stores)),
    );
    let generated = roots.config.join("generated");
    items.extend(
        children(&generated)
            .filter(|path| generated_skill(path))
            .map(|path| item(Kind::GeneratedSkill, path, &generated)),
    );
    items.extend(
        children(&roots.config)
            .filter(|path| {
                is_real_dir(path)
                    && path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with(QUARANTINE_PREFIX))
            })
            .map(|path| item(Kind::Quarantine, path, &roots.config)),
    );
    for root in &roots.standard {
        items.extend(children(root).filter_map(|path| managed(root, path)));
    }
    let skills = roots.cache.join("skills");
    if is_real_dir(&skills) {
        items.push(item(Kind::DiscoveryCache, skills, &roots.cache));
    }
    items
}

pub fn apply(items: &[Item]) -> Report {
    let mut report = Report::default();
    for item in items {
        match remove(item) {
            Ok(()) => report.removed.push(item.path.clone()),
            Err(_) => report.failed.push(item.path.clone()),
        }
    }
    report
}

pub fn run(roots: &Roots) -> Report {
    apply(&plan(roots))
}

fn item(kind: Kind, path: PathBuf, root: &Path) -> Item {
    Item {
        kind,
        path,
        root: root.into(),
    }
}

fn children(directory: &Path) -> impl Iterator<Item = PathBuf> {
    let mut paths = fs::read_dir(directory)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    paths.sort();
    paths.into_iter()
}

fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|info| info.is_dir() && !info.is_symlink())
}

fn is_real_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|info| info.is_file() && !info.is_symlink())
}

fn managed(root: &Path, path: PathBuf) -> Option<Item> {
    if is_real_dir(&path) {
        let name = path.file_name()?.to_str()?;
        let marker = read_marker(&path.join(MANAGED_MARKER))?;
        let content = path.join(crate::resources::skill::spec::FILE);
        return (marker.kind.as_lossless().as_str() == Some("skill")
            && marker.id.as_lossless().as_str() == Some(name)
            && digest_matches(&content, &marker))
        .then(|| item(Kind::ManagedSkill, path, root));
    }
    let name = path.file_name()?.to_str()?.strip_suffix(".md")?.to_owned();
    let marker = read_marker(&root.join(format!(".{name}.ycoding-project-artifact.json")))?;
    (matches!(
        marker.kind.as_lossless().as_str(),
        Some("command" | "agent")
    ) && marker.id.as_lossless().as_str() == Some(name.as_str())
        && digest_matches(&path, &marker))
    .then(|| item(Kind::ManagedFile, path, root))
}

fn read_marker(path: &Path) -> Option<package::Marker> {
    if !is_real_file(path) {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    package::Marker::decode(&ycoding_schema::parse_json(&text).ok()?).ok()
}

fn digest_matches(content: &Path, marker: &package::Marker) -> bool {
    is_real_file(content)
        && fs::read(content).is_ok_and(|bytes| {
            package::sha256(&String::from_utf8_lossy(&bytes).as_ref().into())
                == marker.content_digest
        })
}

fn generated_skill(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some((prefix, suffix)) = name.rsplit_once('-') else {
        return false;
    };
    let lower = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    if prefix.is_empty()
        || !lower(prefix.as_bytes()[0])
        || !lower(prefix.as_bytes()[prefix.len() - 1])
        || !prefix.bytes().all(|byte| lower(byte) || byte == b'-')
        || suffix.len() != 12
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return false;
    }
    let marker = path.join(GENERATED_MARKER);
    is_real_dir(path)
        && is_real_file(&marker)
        && fs::read(&marker)
            .ok()
            .and_then(|bytes| ownership_suffix(&bytes))
            .as_deref()
            == Some(suffix)
}

fn ownership_suffix(content: &[u8]) -> Option<String> {
    let value = ycoding_schema::parse_json(&String::from_utf8_lossy(content)).ok()?;
    let path = JsonPath::default();
    let object = ObjectDecoder::new(&value, &path).ok()?;
    object.literal("generated", &JsonValue::Bool(true)).ok()?;
    let location: LosslessString = object.field("locationID").ok()?;
    let artifact: LosslessString = object.field("artifactID").ok()?;
    let version: LosslessString = object.field("versionID").ok()?;
    if location.is_empty() || artifact.is_empty() || version.is_empty() {
        return None;
    }
    Some(
        package::sha256(&crate::resources::discovery::join(
            &[location, artifact],
            "\0",
        ))
        .as_lossless()
        .as_str()?[..12]
            .to_owned(),
    )
}

fn remove(item: &Item) -> io::Result<()> {
    match item.kind {
        Kind::ManagedSkill => {
            for name in [crate::resources::skill::spec::FILE, MANAGED_MARKER] {
                remove_path(&item.root, &item.path.join(name), false)?;
            }
            match fs::remove_dir(&item.path) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(error) if error.kind() == io::ErrorKind::DirectoryNotEmpty => Ok(()),
                other => other,
            }
        }
        Kind::ManagedFile => {
            let name = item
                .path
                .file_stem()
                .and_then(|name| name.to_str())
                .ok_or_else(|| io::Error::other("unnamed managed file"))?;
            remove_path(&item.root, &item.path, false)?;
            remove_path(
                &item.root,
                &item
                    .root
                    .join(format!(".{name}.ycoding-project-artifact.json")),
                false,
            )
        }
        _ => remove_path(&item.root, &item.path, true),
    }
}

fn remove_path(root: &Path, path: &Path, recursive: bool) -> io::Result<()> {
    if fs::symlink_metadata(path).is_err_and(|error| error.kind() == io::ErrorKind::NotFound) {
        return Ok(());
    }
    filesystem::remove(root, path, recursive, &Default::default())
        .map_err(|error| io::Error::other(error.to_string()))
}
