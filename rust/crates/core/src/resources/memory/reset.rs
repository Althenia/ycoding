use super::{
    Error, GENERATED_INDEX, Scope, atomic, bundle::fresh_front, create_root, format::sha256,
};
use chrono::{DateTime, Utc};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

const MIGRATION_PREFIX: &str = ".ycoding-memory-migration-";
const RECALL: &str = "recall";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Locations {
    pub base: PathBuf,
    pub data: PathBuf,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub targets: Vec<PathBuf>,
    pub repositories: Vec<String>,
    pub digest: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    pub removed: Vec<PathBuf>,
    pub archive: PathBuf,
    pub initialized: Vec<PathBuf>,
}

fn kind(path: &Path) -> Result<Option<fs::Metadata>, Error> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(Some(meta)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
fn children(path: &Path) -> Result<Vec<PathBuf>, Error> {
    let mut entries = match fs::read_dir(path) {
        Ok(entries) => entries
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<Result<Vec<_>, _>>()?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.into()),
    };
    entries.sort();
    Ok(entries)
}

pub fn plan(locations: &Locations) -> Result<Plan, Error> {
    let mut targets = Vec::new();
    let mut repositories = Vec::new();
    let repository_root = locations.base.join("repository");
    for entry in children(&repository_root)? {
        if let Some(name) = entry.file_name().and_then(|name| name.to_str())
            && name.starts_with("repo_")
        {
            repositories.push(name.to_owned());
        }
    }
    for path in [
        repository_root,
        locations.base.join("knowledge"),
        locations.data.join(RECALL),
    ] {
        if kind(&path)?.is_some() {
            targets.push(path);
        }
    }
    if let Some(parent) = locations.base.parent() {
        for entry in children(parent)? {
            if entry
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(MIGRATION_PREFIX))
            {
                targets.push(entry);
            }
        }
    }
    targets.sort();
    targets.dedup();
    for target in &targets {
        let meta = kind(target)?.ok_or(Error::NotFound)?;
        if meta.file_type().is_symlink() {
            return Err(Error::UnsafePath);
        }
    }
    let mut inventory = String::new();
    for target in &targets {
        describe(target, &mut inventory)?;
    }
    Ok(Plan {
        digest: sha256(inventory),
        targets,
        repositories,
    })
}

fn describe(path: &Path, inventory: &mut String) -> Result<(), Error> {
    let meta = fs::symlink_metadata(path)?;
    let tag = if meta.file_type().is_symlink() {
        "l"
    } else if meta.is_dir() {
        "d"
    } else {
        "f"
    };
    inventory.push_str(&format!(
        "{tag}\0{}\0{}\n",
        path.display(),
        if meta.is_file() { meta.len() } else { 0 }
    ));
    if meta.is_dir() {
        for child in children(path)? {
            describe(&child, inventory)?;
        }
    }
    Ok(())
}

fn shape(inventory: &str) -> Vec<String> {
    let mut lines = inventory
        .lines()
        .map(|line| {
            let mut parts = line.split('\0');
            let tag = parts.next().unwrap_or("");
            let name = parts
                .next()
                .and_then(|path| Path::new(path).file_name())
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            format!("{tag}\0{name}\0{}", parts.next().unwrap_or(""))
        })
        .collect::<Vec<_>>();
    lines.sort();
    lines
}

fn copy(source: &Path, destination: &Path) -> Result<(), Error> {
    let meta = fs::symlink_metadata(source)?;
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.is_dir() {
        fs::create_dir_all(destination)?;
        for child in children(source)? {
            copy(
                &child,
                &destination.join(child.file_name().ok_or(Error::UnsafePath)?),
            )?;
        }
        return Ok(());
    }
    fs::copy(source, destination)?;
    Ok(())
}
fn label(locations: &Locations, target: &Path) -> PathBuf {
    target
        .strip_prefix(&locations.data)
        .map(Path::to_path_buf)
        .unwrap_or_else(|_| {
            PathBuf::from("external").join(
                target
                    .to_string_lossy()
                    .trim_start_matches('/')
                    .replace('/', "_"),
            )
        })
}

pub fn apply(
    locations: &Locations,
    expected_digest: &str,
    archive: &Path,
    now: DateTime<Utc>,
) -> Result<Report, Error> {
    let plan = plan(locations)?;
    if plan.digest != expected_digest {
        return Err(Error::StaleContent);
    }
    if !archive.is_absolute()
        || plan
            .targets
            .iter()
            .any(|target| archive.starts_with(target) || target.starts_with(archive))
        || locations.base.starts_with(archive)
        || archive.starts_with(&locations.base)
    {
        return Err(Error::UnsafePath);
    }
    if let Some(meta) = kind(archive)? {
        if !meta.is_dir() || !children(archive)?.is_empty() {
            return Err(Error::UnsafePath);
        }
    } else {
        fs::create_dir_all(archive)?;
    }
    for target in &plan.targets {
        copy(target, &archive.join(label(locations, target)))?;
    }
    let mut copied = String::new();
    let mut original = String::new();
    for target in &plan.targets {
        describe(&archive.join(label(locations, target)), &mut copied)?;
        describe(target, &mut original)?;
    }
    if shape(&copied) != shape(&original) {
        return Err(Error::Unavailable);
    }
    for target in &plan.targets {
        fs::remove_dir_all(target)?;
    }
    let mut initialized = Vec::new();
    let mut bundles = vec![(Scope::Knowledge, None, locations.base.join("knowledge"))];
    bundles.extend(plan.repositories.iter().map(|id| {
        (
            Scope::Repository,
            Some(id.as_str()),
            locations.base.join("repository").join(id),
        )
    }));
    for (scope, repository, root) in bundles {
        create_root(&root)?;
        let index = format!("{}{}\n", fresh_front(scope, repository), GENERATED_INDEX);
        atomic(&root, &root.join("index.md"), index)?;
        let log = format!(
            "# Memory log\n\n## {}\n* **Initialization**: Created the memory bundle.\n",
            now.format("%Y-%m-%d")
        );
        atomic(&root, &root.join("log.md"), log)?;
        initialized.push(root);
    }
    Ok(Report {
        removed: plan.targets,
        archive: archive.to_path_buf(),
        initialized,
    })
}
