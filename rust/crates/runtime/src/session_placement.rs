use crate::dispatch::Failure;
use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
};
use ycoding_core::{platform::filesystem::normalize, ycoding_schema::LosslessString};

const STANDALONE_ROOT: &str = "standalone-sessions";

pub(crate) fn unavailable() -> Failure {
    Failure::Invalid("Session scope is unavailable".into())
}

pub(crate) fn path(directory: &LosslessString) -> Result<PathBuf, Failure> {
    let directory = directory.to_utf8().map_err(|_| unavailable())?;
    Ok(normalize(
        &std::path::absolute(directory).map_err(|_| unavailable())?,
    ))
}

pub(crate) fn reserved(state: &Path, directory: &Path) -> Result<(), Failure> {
    let root =
        normalize(&std::path::absolute(state).map_err(|_| unavailable())?).join(STANDALONE_ROOT);
    if directory.starts_with(root) {
        return Err(unavailable());
    }
    Ok(())
}

pub(crate) fn standalone_root(state: &Path) -> Result<PathBuf, Failure> {
    let root = std::fs::canonicalize(state)
        .map_err(|_| unavailable())?
        .join(STANDALONE_ROOT);
    match std::fs::canonicalize(&root) {
        Ok(physical) if physical == root => Ok(root),
        Err(error) if error.kind() == ErrorKind::NotFound && absent(&root)? => Ok(root),
        _ => Err(unavailable()),
    }
}

pub(crate) fn physical(directory: &Path) -> Result<PathBuf, Failure> {
    let mut current = directory;
    let mut suffix = Vec::new();
    loop {
        match std::fs::canonicalize(current) {
            Ok(real) => {
                return Ok(suffix
                    .iter()
                    .rev()
                    .fold(real, |path: PathBuf, name| path.join(name)));
            }
            Err(error) if error.kind() == ErrorKind::NotFound && absent(current)? => {}
            Err(_) => return Err(unavailable()),
        }
        let (Some(parent), Some(name)) = (current.parent(), current.file_name()) else {
            return Err(unavailable());
        };
        suffix.push(name);
        current = parent;
    }
}

pub(crate) fn bound(state: &Path, directory: &LosslessString) -> Result<PathBuf, Failure> {
    let directory = path(directory)?;
    reserved(state, &directory)?;
    let root = standalone_root(state)?;
    let canonical = physical(&directory)?;
    if canonical.starts_with(root) {
        return Err(unavailable());
    }
    Ok(canonical)
}

fn absent(path: &Path) -> Result<bool, Failure> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Err(unavailable()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(true),
        Err(_) => Err(unavailable()),
    }
}
