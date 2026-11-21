use super::git::{Error, Repository, Service, error, path_text};
use ring::digest::{SHA256, digest};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Worktree {
    pub directory: PathBuf,
    pub main: bool,
}

pub fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn validate_name(name: &str, directory: &Path) -> Result<(), Error> {
    if !valid_name(name) {
        return Err(error("create", directory, "Invalid worktree branch name"));
    }
    Ok(())
}

pub fn create(
    service: &Service,
    repository: &Repository,
    directory: &Path,
    branch: Option<&str>,
) -> Result<Repository, Error> {
    let target = path_text(directory, "create")?;
    let args = if let Some(branch) = branch {
        validate_name(branch, directory)?;
        vec!["worktree", "add", "-b", branch, target, "HEAD"]
    } else {
        vec!["worktree", "add", "--detach", target, "HEAD"]
    };
    service.checked("create", &repository.worktree, &args, None, None)?;
    service
        .discover(directory)?
        .ok_or_else(|| error("create", directory, "Created worktree could not be opened"))
}

pub fn remove(
    service: &Service,
    repository: &Repository,
    directory: &Path,
    force: bool,
) -> Result<(), Error> {
    let target = path_text(directory, "remove")?;
    let args = if force {
        vec!["worktree", "remove", "--force", target]
    } else {
        vec!["worktree", "remove", target]
    };
    service
        .checked("remove", &repository.common_directory, &args, None, None)
        .map_err(|mut error| {
            let message = error.message.to_ascii_lowercase();
            error.force_required = message.contains("contains modified or untracked files")
                || message.contains("is dirty");
            error.directory = directory.into();
            error
        })?;
    Ok(())
}

pub fn list(service: &Service, repository: &Repository) -> Result<Vec<Worktree>, Error> {
    Ok(service
        .checked(
            "list",
            &repository.worktree,
            &["worktree", "list", "--porcelain"],
            None,
            None,
        )?
        .text()
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .enumerate()
        .map(|(index, directory)| Worktree {
            directory: super::filesystem::normalize(&repository.worktree.join(directory.trim())),
            main: index == 0,
        })
        .collect())
}

pub fn managed_destination(
    data: &Path,
    repository: &Repository,
    name: &str,
) -> Result<PathBuf, Error> {
    validate_name(name, data)?;
    let common = fs::canonicalize(&repository.common_directory)
        .map_err(|e| error("create", data, e.to_string()))?;
    let hash: String = digest(&SHA256, path_text(&common, "create")?.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(data
        .join("worktrees")
        .join(format!("repo_{hash}"))
        .join(name))
}

pub fn create_managed(
    service: &Service,
    repository: &Repository,
    data: &Path,
    name: &str,
) -> Result<Repository, Error> {
    let target = managed_destination(data, repository, name)?;
    if target.exists() {
        return Err(error(
            "create",
            &target,
            format!("A worktree named {name} already exists"),
        ));
    }
    fs::create_dir_all(
        target
            .parent()
            .ok_or_else(|| error("create", &target, "No worktree parent"))?,
    )
    .map_err(|e| error("create", &target, e.to_string()))?;
    create(service, repository, &target, Some(name))
}
