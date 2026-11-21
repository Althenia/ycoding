use super::git;
use crate::resources::discovery::repository::{self, Reference};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidRepository {
        repository: String,
        message: String,
    },
    InvalidBranch {
        branch: String,
        message: String,
    },
    CloneFailed {
        repository: String,
        message: String,
    },
    FetchFailed {
        repository: String,
        message: String,
    },
    CheckoutFailed {
        repository: String,
        branch: String,
        message: String,
    },
    ResetFailed {
        repository: String,
        message: String,
    },
    LockFailed {
        local_path: PathBuf,
        message: String,
    },
    CacheOperation {
        operation: &'static str,
        path: PathBuf,
        message: String,
    },
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::InvalidRepository { message, .. }
            | Self::InvalidBranch { message, .. }
            | Self::CloneFailed { message, .. }
            | Self::FetchFailed { message, .. }
            | Self::CheckoutFailed { message, .. }
            | Self::ResetFailed { message, .. }
            | Self::LockFailed { message, .. }
            | Self::CacheOperation { message, .. } => message,
        };
        f.write_str(message)
    }
}
impl std::error::Error for Error {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Cached,
    Cloned,
    Refreshed,
}

pub struct EnsureInput<'a> {
    pub reference: &'a Reference,
    pub refresh: bool,
    pub branch: Option<&'a str>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ensured {
    pub repository: String,
    pub host: String,
    pub remote: String,
    pub local_path: PathBuf,
    pub status: Status,
    pub head: Option<String>,
    pub branch: Option<String>,
}

pub struct Service {
    repos: PathBuf,
    state: PathBuf,
    git: Arc<git::Service>,
}

pub fn parse_remote(input: &str, github_base: Option<&str>) -> Result<Reference, Error> {
    repository::parse_remote(input, github_base).map_err(|error| Error::InvalidRepository {
        repository: input.into(),
        message: error.to_string(),
    })
}

pub fn validate_branch(branch: &str) -> Result<(), Error> {
    repository::validate_branch(branch).map_err(|error| Error::InvalidBranch {
        branch: branch.into(),
        message: error.to_string(),
    })
}

impl Service {
    pub fn new(repos: PathBuf, state: PathBuf, git: Arc<git::Service>) -> Self {
        Self { repos, state, git }
    }

    pub fn ensure(&self, input: EnsureInput<'_>) -> Result<Ensured, Error> {
        if let Some(branch) = input.branch.filter(|branch| !branch.is_empty()) {
            validate_branch(branch)?;
        }
        let local_path = input.reference.cache_path(&self.repos);
        let lock_error = |message: String| Error::LockFailed {
            local_path: local_path.clone(),
            message,
        };
        let _lock = acquire(&self.state, &local_path).map_err(|e| lock_error(e.to_string()))?;
        let operation_error = |operation, error: std::io::Error| Error::CacheOperation {
            operation,
            path: local_path.clone(),
            message: error.to_string(),
        };
        fs::create_dir_all(local_path.parent().unwrap_or(&local_path))
            .map_err(|e| operation_error("ensure cache directory", e))?;
        let existing = self
            .git
            .discover(&local_path)
            .map_err(|e| lock_error(e.message))?;
        let origin = existing
            .as_ref()
            .map(|repo| self.git.remote(repo, "origin"))
            .transpose()
            .map_err(|e| lock_error(e.message))?
            .flatten();
        let clone_target = repository::parse(&input.reference.remote, None)
            .unwrap_or_else(|| input.reference.clone());
        let reuse = existing.is_some()
            && origin
                .as_deref()
                .and_then(|origin| repository::parse(origin, None))
                .is_some_and(|origin| origin.same(&clone_target));
        if local_path.exists() && !reuse {
            let metadata = fs::symlink_metadata(&local_path)
                .map_err(|e| operation_error("remove stale cache", e))?;
            if metadata.is_dir() {
                fs::remove_dir_all(&local_path)
            } else {
                fs::remove_file(&local_path)
            }
            .map_err(|e| operation_error("remove stale cache", e))?;
        }
        let current_branch = if reuse {
            existing
                .as_ref()
                .map(|repo| self.git.branch(repo))
                .transpose()
                .map_err(|e| lock_error(e.message))?
                .flatten()
        } else {
            None
        };
        let branch = input.branch.filter(|branch| !branch.is_empty());
        let status = if !reuse {
            Status::Cloned
        } else if input.refresh
            || branch.is_some_and(|branch| Some(branch) != current_branch.as_deref())
        {
            Status::Refreshed
        } else {
            Status::Cached
        };
        if status == Status::Cloned {
            self.git
                .clone_repository(&input.reference.remote, &local_path, branch, None)
                .map_err(|e| Error::CloneFailed {
                    repository: input.reference.label.clone(),
                    message: e.message,
                })?;
        }
        if status == Status::Refreshed {
            let existing = existing.as_ref().ok_or_else(|| Error::FetchFailed {
                repository: input.reference.label.clone(),
                message: "Repository is unavailable".into(),
            })?;
            self.git
                .fetch_remotes(existing, true)
                .map_err(|e| Error::FetchFailed {
                    repository: input.reference.label.clone(),
                    message: e.message,
                })?;
            if let Some(branch) = branch {
                self.git
                    .fetch_branch(existing, "origin", branch, true)
                    .map_err(|e| Error::FetchFailed {
                        repository: input.reference.label.clone(),
                        message: e.message,
                    })?;
                self.git
                    .checkout_remote_branch(existing, "origin", branch, true)
                    .map_err(|e| Error::CheckoutFailed {
                        repository: input.reference.label.clone(),
                        branch: branch.into(),
                        message: e.message,
                    })?;
            }
            let target = match branch {
                Some(branch) => format!("origin/{branch}"),
                None => {
                    let remote_head = self
                        .git
                        .default_remote_branch(existing, "origin")
                        .map_err(|e| lock_error(e.message))?;
                    let branch = match remote_head {
                        Some(branch) => Some(branch),
                        None => self
                            .git
                            .branch(existing)
                            .map_err(|e| lock_error(e.message))?,
                    };
                    branch.map_or_else(|| "HEAD".into(), |branch| format!("origin/{branch}"))
                }
            };
            self.git
                .reset_hard(existing, &target)
                .map_err(|e| Error::ResetFailed {
                    repository: input.reference.label.clone(),
                    message: e.message,
                })?;
        }
        let checkout = self
            .git
            .discover(&local_path)
            .map_err(|e| lock_error(e.message))?;
        let head = checkout
            .as_ref()
            .map(|repo| self.git.head(repo))
            .transpose()
            .map_err(|e| lock_error(e.message))?
            .flatten();
        let branch = checkout
            .as_ref()
            .map(|repo| self.git.branch(repo))
            .transpose()
            .map_err(|e| lock_error(e.message))?
            .flatten();
        Ok(Ensured {
            repository: input.reference.label.clone(),
            host: input.reference.host.clone(),
            remote: input.reference.remote.clone(),
            local_path,
            status,
            head,
            branch,
        })
    }
}

fn acquire(state: &Path, local_path: &Path) -> std::io::Result<fs::File> {
    let root = state.join("locks/repository-cache");
    fs::create_dir_all(&root)?;
    let key = format!("repository-cache:{}", local_path.display());
    let hash = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, key.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(root.join(format!("{hash}.lock")))?;
    let started = Instant::now();
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(fs::TryLockError::WouldBlock) => {}
            Err(fs::TryLockError::Error(error)) => return Err(error),
        }
        if started.elapsed() >= Duration::from_secs(300) {
            return Err(std::io::Error::other(format!("LockTimeoutError: {key}")));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
