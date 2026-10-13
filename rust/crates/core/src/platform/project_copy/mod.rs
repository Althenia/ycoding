use super::{
    git::{Error, Service, error},
    worktree,
};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListEntry {
    pub directory: PathBuf,
    pub copy: bool,
}

pub fn create(
    git: &Service,
    source: &Path,
    parent: &Path,
    name: &str,
    branch: Option<&str>,
) -> Result<PathBuf, Error> {
    let repository = git
        .discover(source)?
        .ok_or_else(|| error("create", source, "Project directory is unavailable"))?;
    if name.is_empty()
        || Path::new(name).components().count() != 1
        || Path::new(name).is_absolute()
        || name == "."
        || name == ".."
    {
        return Err(error("create", parent, "Invalid copy name"));
    }
    fs::create_dir_all(parent).map_err(|cause| error("create", parent, cause.to_string()))?;
    for suffix in 1..=10 {
        let target = parent.join(if suffix == 1 {
            name.to_string()
        } else {
            format!("{name}-{suffix}")
        });
        if target.exists() {
            if branch.is_some() {
                return Err(error("create", &target, "Destination exists"));
            }
            continue;
        }
        worktree::create(git, &repository, &target, branch)?;
        return fs::canonicalize(&target)
            .map_err(|cause| error("create", &target, cause.to_string()));
    }
    Err(error(
        "create",
        &parent.join(format!("{name}-10")),
        "Destination exists",
    ))
}

pub fn remove(git: &Service, directory: &Path, force: bool) -> Result<(), Error> {
    let repository = git
        .discover(directory)?
        .ok_or_else(|| error("remove", directory, "Project directory is unavailable"))?;
    worktree::remove(git, &repository, directory, force)
}

pub fn list(git: &Service, directory: &Path) -> Result<Vec<ListEntry>, Error> {
    let repository = git
        .discover(directory)?
        .ok_or_else(|| error("list", directory, "Project directory is unavailable"))?;
    Ok(worktree::list(git, &repository)?
        .iter()
        .filter_map(|entry| {
            fs::canonicalize(&entry.directory)
                .ok()
                .filter(|path| path.is_dir())
                .map(|directory| ListEntry {
                    directory,
                    copy: !entry.main,
                })
        })
        .collect())
}
