use super::revert::{SnapshotFailure, Snapshots};
use crate::platform::git::{Repository, Service};
use ring::digest;
use std::{
    fmt::Display,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};
use ycoding_schema::{file_diff, schema::RelativePath, snapshot};

const MAXIMUM_UNTRACKED_FILE_BYTES: u64 = 2 * 1024 * 1024;
const DIFF_CONTEXT: usize = 3;

pub struct GitSnapshots {
    git: Arc<Service>,
    data: PathBuf,
    project_id: String,
    project_directory: PathBuf,
    directory: PathBuf,
    enabled: bool,
    repositories: OnceLock<Result<Repositories, SnapshotFailure>>,
}

struct Repositories {
    source: Repository,
    snapshot: Repository,
    scope: String,
}

impl GitSnapshots {
    pub fn new(
        git: Arc<Service>,
        data: PathBuf,
        project_id: String,
        project_directory: PathBuf,
        directory: PathBuf,
        enabled: bool,
    ) -> Self {
        Self {
            git,
            data,
            project_id,
            project_directory,
            directory,
            enabled,
            repositories: OnceLock::new(),
        }
    }

    fn repositories(&self, operation: &'static str) -> Result<&Repositories, SnapshotFailure> {
        self.repositories
            .get_or_init(|| self.discover())
            .as_ref()
            .map_err(|cause| SnapshotFailure {
                operation,
                message: cause.message.clone(),
            })
    }

    fn discover(&self) -> Result<Repositories, SnapshotFailure> {
        let source = self
            .git
            .discover(&self.project_directory)
            .map_err(|cause| failure("capture", cause))?
            .ok_or_else(|| failure("capture", "Project is not a Git repository"))?;
        let worktree =
            fs::canonicalize(&source.worktree).map_err(|cause| failure("capture", cause))?;
        let git_directory = snapshot_directory(&self.data, &self.project_id, &worktree);
        let snapshot = if git_directory.join("HEAD").exists() {
            Repository {
                worktree: worktree.clone(),
                git_directory: git_directory.clone(),
                common_directory: git_directory,
            }
        } else {
            self.git
                .create_repository(&worktree, &git_directory, Some(&source))
                .map_err(|cause| failure("capture", cause))?
        };
        let location =
            fs::canonicalize(&self.directory).map_err(|cause| failure("capture", cause))?;
        let relative = location
            .strip_prefix(&worktree)
            .map_err(|_| failure("capture", "Location is outside the project"))?;
        let scope = relative.to_string_lossy().replace('\\', "/");
        Ok(Repositories {
            source,
            snapshot,
            scope: if scope.is_empty() { ".".into() } else { scope },
        })
    }
}

impl Snapshots for GitSnapshots {
    fn capture(&self) -> Option<snapshot::Id> {
        if !self.enabled {
            return None;
        }
        let repositories = self.repositories("capture").ok()?;
        let tree = self
            .git
            .capture_tree(
                &repositories.snapshot,
                &[&repositories.scope],
                Some(&repositories.source),
                Some(MAXIMUM_UNTRACKED_FILE_BYTES),
            )
            .ok()?;
        snapshot::Id::new(tree).ok()
    }

    fn restore(&self, files: &[(RelativePath, snapshot::Id)]) -> Result<(), SnapshotFailure> {
        if !self.enabled {
            return Err(failure("restore", "Snapshots are disabled"));
        }
        let repositories = self.repositories("restore")?;
        let files = files
            .iter()
            .map(|(file, tree)| Ok((text(file.as_lossless())?, text(tree.as_lossless())?)))
            .collect::<Result<Vec<_>, SnapshotFailure>>()?;
        self.git
            .restore(&repositories.snapshot, &files)
            .map_err(|cause| failure("restore", cause))
    }

    fn files(
        &self,
        from: &snapshot::Id,
        to: &snapshot::Id,
    ) -> Result<Vec<RelativePath>, SnapshotFailure> {
        let repositories = self.repositories("files")?;
        let changed = self
            .git
            .tree_files(
                &repositories.snapshot,
                &text(from.as_lossless())?,
                &text(to.as_lossless())?,
            )
            .map_err(|cause| failure("files", cause))?;
        let ignored = self
            .git
            .ignored(
                &repositories.source,
                &changed.iter().map(String::as_str).collect::<Vec<_>>(),
            )
            .map_err(|cause| failure("files", cause))?;
        changed
            .into_iter()
            .filter(|file| !ignored.contains(file))
            .map(|file| RelativePath::new(file).map_err(|cause| failure("files", cause)))
            .collect()
    }

    fn diff(
        &self,
        from: &snapshot::Id,
        to: &snapshot::Id,
        paths: &[RelativePath],
    ) -> Result<Vec<file_diff::Info>, SnapshotFailure> {
        let repositories = self.repositories("diff")?;
        let (from, to) = (text(from.as_lossless())?, text(to.as_lossless())?);
        let changed = self
            .git
            .tree_files(&repositories.snapshot, &from, &to)
            .map_err(|cause| failure("diff", cause))?;
        let ignored = self
            .git
            .ignored(
                &repositories.source,
                &changed.iter().map(String::as_str).collect::<Vec<_>>(),
            )
            .map_err(|cause| failure("diff", cause))?;
        let selected = paths
            .iter()
            .map(|path| text(path.as_lossless()))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|path| !ignored.contains(path))
            .collect::<Vec<_>>();
        self.git
            .tree_diff(
                &repositories.snapshot,
                &from,
                &to,
                DIFF_CONTEXT,
                Some(&selected),
            )
            .map_err(|cause| failure("diff", cause))
    }
}

fn text(value: &ycoding_schema::LosslessString) -> Result<String, SnapshotFailure> {
    value
        .to_utf8()
        .map_err(|cause| failure("restore", format!("{cause:?}")))
}

fn failure(operation: &'static str, cause: impl Display) -> SnapshotFailure {
    SnapshotFailure {
        operation,
        message: cause.to_string(),
    }
}

fn fast_hash(input: &str) -> String {
    digest::digest(&digest::SHA1_FOR_LEGACY_USE_ONLY, input.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn snapshot_directory(data: &Path, project_id: &str, worktree: &Path) -> PathBuf {
    data.join("snapshot")
        .join(project_id)
        .join(fast_hash(&worktree.to_string_lossy()))
}
