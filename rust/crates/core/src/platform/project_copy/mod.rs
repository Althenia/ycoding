use super::{
    git::{Error, Service, error},
    worktree,
};
use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::tools::policy::{Event, Publisher};
use std::{collections::BTreeMap, ops::Bound, sync::Arc};
use ycoding_schema::{LosslessString, ObjectEncoder};
use ycoding_store::{
    Client, KeyPart,
    project::{Directory, DirectoryTable},
    tuple_key,
};

pub struct Copies {
    directory: super::filesystem::Location,
    git: Arc<Service>,
    store: Client,
    publisher: Publisher,
    mutation: tokio::sync::Mutex<()>,
}

impl Copies {
    pub fn directory(&self) -> &Path {
        self.directory.directory()
    }
    pub fn new(
        directory: &Path,
        git: Arc<Service>,
        store: Client,
        publisher: Publisher,
    ) -> std::io::Result<Self> {
        Ok(Self {
            directory: super::filesystem::Location::new(directory)?,
            git,
            store,
            publisher,
            mutation: tokio::sync::Mutex::new(()),
        })
    }

    fn rows(&self, project: &LosslessString) -> Result<Vec<Directory>, Error> {
        self.store
            .snapshot()
            .and_then(|snapshot| {
                snapshot.scan::<DirectoryTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
            })
            .map(|rows| {
                rows.into_iter()
                    .filter(|row| row.project_id == *project)
                    .collect()
            })
            .map_err(|cause| error("copy", self.directory.directory(), cause.to_string()))
    }

    fn changed(&self, project: &LosslessString, changed: bool) -> Result<(), Error> {
        if !changed {
            return Ok(());
        }
        (self.publisher)(Event {
            type_: "project.directories.updated".into(),
            data: ObjectEncoder::new().field("projectID", project).finish(),
        })
        .map_err(|cause| error("copy", self.directory.directory(), cause))
    }

    pub async fn create(
        &self,
        project: LosslessString,
        source: PathBuf,
        parent: PathBuf,
        name: Option<String>,
        strategy: String,
    ) -> Result<PathBuf, Error> {
        let _mutation = self.mutation.lock().await;
        if strategy != "git_worktree" {
            return Err(error(
                "create",
                &source,
                format!("Project copy strategy unavailable: {strategy}"),
            ));
        }
        let source = fs::canonicalize(&source).map_err(|_| {
            error(
                "create",
                &source,
                format!("Project copy directory unavailable: {}", source.display()),
            )
        })?;
        if !source.is_dir() {
            return Err(error(
                "create",
                &source,
                format!("Project copy directory unavailable: {}", source.display()),
            ));
        }
        if !self.rows(&project)?.iter().any(|row| {
            row.directory
                .as_str()
                .is_some_and(|value| Path::new(value) == source)
        }) {
            return Err(error(
                "create",
                &source,
                format!("Project copy source not found: {}", source.display()),
            ));
        }
        let name = name
            .map(Ok)
            .unwrap_or_else(|| super::identifier("copy"))
            .map_err(|cause| error("create", &parent, cause.to_string()))?;
        let git = self.git.clone();
        let directory = tokio::task::spawn_blocking(move || {
            fs::create_dir_all(&parent)
                .map_err(|cause| error("create", &parent, cause.to_string()))?;
            let repository = git.discover(&source)?.ok_or_else(|| {
                error(
                    "create",
                    &source,
                    format!("Project copy directory unavailable: {}", source.display()),
                )
            })?;
            for suffix in 1..=10 {
                let name = if suffix == 1 {
                    name.clone()
                } else {
                    format!("{name}-{suffix}")
                };
                let target = super::filesystem::normalize(&PathBuf::from(format!(
                    "{}/{}",
                    parent.display(),
                    name
                )));
                if target.exists() {
                    continue;
                }
                worktree::create(&git, &repository, &target, None)?;
                return fs::canonicalize(&target)
                    .map_err(|cause| error("create", &target, cause.to_string()));
            }
            let target = parent.join(format!("{name}-10"));
            Err(error(
                "create",
                &target,
                format!(
                    "Project copy destination already exists: {}",
                    target.display()
                ),
            ))
        })
        .await
        .map_err(|cause| error("create", self.directory.directory(), cause.to_string()))??;
        let row = Directory {
            project_id: project.clone(),
            directory: directory.to_string_lossy().into_owned().into(),
            type_: Some("copy".into()),
            strategy: Some(strategy.into()),
            time_created: super::now() as i64,
        };
        let changed = self
            .store
            .submit(move |tx| {
                let key = tuple_key(&[
                    KeyPart::String(&row.project_id),
                    KeyPart::String(&row.directory),
                ]);
                let old = tx.get::<DirectoryTable>(&key)?;
                if old.as_ref().is_some_and(|old| old.strategy == row.strategy) {
                    return Ok(false);
                }
                let row = Directory {
                    time_created: old.map(|row| row.time_created).unwrap_or(row.time_created),
                    ..row
                };
                tx.put::<DirectoryTable>(&row)?;
                Ok(true)
            })
            .map_err(|cause| error("create", &directory, cause.to_string()))?
            .await
            .map_err(|cause| error("create", &directory, cause.to_string()))?;
        self.changed(&project, changed)?;
        Ok(directory)
    }

    pub async fn remove(
        &self,
        project: LosslessString,
        directory: PathBuf,
        force: bool,
    ) -> Result<(), Error> {
        let _mutation = self.mutation.lock().await;
        let directory = fs::canonicalize(&directory).map_err(|_| {
            error(
                "remove",
                &directory,
                format!(
                    "Project copy directory unavailable: {}",
                    directory.display()
                ),
            )
        })?;
        let row = self
            .rows(&project)?
            .into_iter()
            .find(|row| {
                row.directory
                    .as_str()
                    .is_some_and(|value| Path::new(value) == directory)
            })
            .ok_or_else(|| {
                error(
                    "remove",
                    &directory,
                    format!("Invalid project copy directory: {}", directory.display()),
                )
            })?;
        let strategy = row.strategy.as_ref().ok_or_else(|| {
            error(
                "remove",
                &directory,
                format!("Invalid project copy directory: {}", directory.display()),
            )
        })?;
        if strategy.as_str() != Some("git_worktree") {
            return Err(error(
                "remove",
                &directory,
                format!(
                    "Project copy strategy unavailable: {}",
                    String::from_utf16_lossy(&strategy.code_units().collect::<Vec<_>>())
                ),
            ));
        }
        let git = self.git.clone();
        let target = directory.clone();
        tokio::task::spawn_blocking(move || remove(&git, &target, force))
            .await
            .map_err(|cause| error("remove", &directory, cause.to_string()))??;
        let removed = self
            .store
            .submit(move |tx| {
                tx.delete::<DirectoryTable>(&tuple_key(&[
                    KeyPart::String(&row.project_id),
                    KeyPart::String(&row.directory),
                ]))
            })
            .map_err(|cause| error("remove", &directory, cause.to_string()))?
            .await
            .map_err(|cause| error("remove", &directory, cause.to_string()))?;
        self.changed(&project, removed)
    }

    pub async fn refresh(&self, project: LosslessString) -> Result<(), Error> {
        let _mutation = self.mutation.lock().await;
        let rows = self.rows(&project)?;
        let mut discovered = BTreeMap::new();
        let mut missing = Vec::new();
        for row in rows {
            let path = PathBuf::from(row.directory.to_utf8().map_err(|cause| {
                error("refresh", self.directory.directory(), cause.to_string())
            })?);
            if !path.is_dir() {
                missing.push(row);
                continue;
            }
            if row.strategy.is_some() {
                continue;
            }
            let git = self.git.clone();
            let source = path.clone();
            let entries = tokio::task::spawn_blocking(move || {
                if git.discover(&source)?.is_none() {
                    return Ok(Vec::new());
                }
                list(&git, &source)
            })
            .await
            .map_err(|cause| error("refresh", &path, cause.to_string()))??;
            for entry in entries {
                discovered.insert(entry.directory.to_string_lossy().into_owned(), entry.copy);
            }
        }
        let changed = self
            .store
            .submit(move |tx| {
                let mut changed = false;
                for (directory, copy) in discovered {
                    let directory: LosslessString = directory.into();
                    let key = tuple_key(&[KeyPart::String(&project), KeyPart::String(&directory)]);
                    let old = tx.get::<DirectoryTable>(&key)?;
                    let strategy = copy.then(|| LosslessString::from("git_worktree"));
                    if old.as_ref().is_some_and(|old| old.strategy == strategy) {
                        continue;
                    }
                    tx.put::<DirectoryTable>(&Directory {
                        project_id: project.clone(),
                        directory,
                        type_: Some(if copy { "copy" } else { "root" }.into()),
                        strategy,
                        time_created: old
                            .map(|row| row.time_created)
                            .unwrap_or(super::now() as i64),
                    })?;
                    changed = true;
                }
                for row in missing {
                    changed |= tx.delete::<DirectoryTable>(&tuple_key(&[
                        KeyPart::String(&row.project_id),
                        KeyPart::String(&row.directory),
                    ]))?;
                }
                Ok((project, changed))
            })
            .map_err(|cause| error("refresh", self.directory.directory(), cause.to_string()))?
            .await
            .map_err(|cause| error("refresh", self.directory.directory(), cause.to_string()))?;
        self.changed(&changed.0, changed.1)
    }
}

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
