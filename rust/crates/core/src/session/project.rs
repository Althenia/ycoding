use super::store::Service;
use std::{cmp::Ordering, collections::HashMap, ops::Bound, path::Path};
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, project as contract, schema::NonNegativeInt,
};
use ycoding_store::{
    Error, KeyPart,
    project::{Directory, DirectoryTable, Project, ProjectTable},
    session::{self, SessionTable},
    tuple_key,
};

pub struct InventoryQuery {
    pub limit: usize,
    pub search: Option<LosslessString>,
    pub after: Option<contract::InventoryAnchor>,
}

pub struct InventoryPage {
    pub data: Vec<contract::InventoryEntry>,
    pub next: Option<contract::InventoryAnchor>,
}

struct InventoryCandidate {
    project_id: LosslessString,
    project_name: Option<LosslessString>,
    project_worktree: LosslessString,
    directory: LosslessString,
    strategy: Option<LosslessString>,
    sessions: u64,
    time_active: i64,
}

impl Service {
    pub fn project_list(&self) -> Result<Vec<contract::Info>, Error> {
        let mut rows = self.client.snapshot()?.scan::<ProjectTable>(
            Bound::Unbounded,
            Bound::Unbounded,
            usize::MAX,
        )?;
        rows.sort_by(|left, right| {
            right
                .time_updated
                .cmp(&left.time_updated)
                .then_with(|| text_order(&left.id, &right.id))
        });
        rows.iter().map(project_info).collect()
    }

    pub fn project_directories(
        &self,
        project_id: &LosslessString,
    ) -> Result<Vec<contract::Directory>, Error> {
        let mut rows = self
            .client
            .snapshot()?
            .scan::<DirectoryTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)?
            .into_iter()
            .filter(|row| row.project_id == *project_id)
            .collect::<Vec<_>>();
        rows.sort_by(|left, right| {
            right
                .time_created
                .cmp(&left.time_created)
                .then_with(|| text_order(&left.directory, &right.directory))
        });
        rows.iter().map(project_directory).collect()
    }

    pub fn project_inventory(&self, query: &InventoryQuery) -> Result<InventoryPage, Error> {
        let snapshot = self.client.snapshot()?;
        let projects =
            snapshot.scan::<ProjectTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)?;
        let directories =
            snapshot.scan::<DirectoryTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)?;
        let sessions =
            snapshot.scan::<SessionTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)?;
        let projects = projects
            .iter()
            .map(|project| (project.id.clone(), project))
            .collect::<HashMap<_, _>>();
        let mut candidates = Vec::<InventoryCandidate>::new();
        let mut indexes = HashMap::<(LosslessString, LosslessString), usize>::new();
        for (project_id, directory, strategy, time_active, is_session) in directories
            .into_iter()
            .map(|row| {
                (
                    row.project_id,
                    row.directory,
                    row.strategy,
                    row.time_created,
                    false,
                )
            })
            .chain(
                sessions
                    .into_iter()
                    .map(|row| (row.project_id, row.directory, None, row.time_updated, true)),
            )
        {
            let Some(project) = projects.get(&project_id) else {
                continue;
            };
            let key = (project_id.clone(), directory.clone());
            if let Some(index) = indexes.get(&key) {
                let candidate = &mut candidates[*index];
                if strategy.as_ref().is_some_and(|strategy| {
                    candidate
                        .strategy
                        .as_ref()
                        .is_none_or(|current| text_order(current, strategy).is_lt())
                }) {
                    candidate.strategy = strategy;
                }
                candidate.sessions += u64::from(is_session);
                candidate.time_active = candidate.time_active.max(time_active);
                continue;
            }
            indexes.insert(key, candidates.len());
            candidates.push(InventoryCandidate {
                project_id,
                project_name: project.name.clone(),
                project_worktree: project.worktree.clone(),
                directory,
                strategy,
                sessions: u64::from(is_session),
                time_active,
            });
        }

        if let Some(search) = query.search.as_ref().filter(|search| !search.is_empty()) {
            let search = text(search).trim().to_ascii_lowercase();
            candidates.retain(|candidate| {
                text(&candidate.directory)
                    .to_ascii_lowercase()
                    .contains(&search)
                    || candidate
                        .project_name
                        .as_ref()
                        .is_some_and(|name| text(name).to_ascii_lowercase().contains(&search))
            });
        }
        candidates.sort_by(|left, right| {
            text_order(&left.project_worktree, &right.project_worktree)
                .then_with(|| text_order(&left.project_id, &right.project_id))
                .then_with(|| text_order(&left.directory, &right.directory))
        });
        if let Some(anchor) = &query.after {
            candidates.retain(|candidate| {
                text_order(
                    &candidate.project_worktree,
                    anchor.project_worktree.as_lossless(),
                )
                .then_with(|| text_order(&candidate.project_id, anchor.project_id.as_lossless()))
                .then_with(|| text_order(&candidate.directory, anchor.directory.as_lossless()))
                    == Ordering::Greater
            });
        }
        let has_more = candidates.len() > query.limit;
        candidates.truncate(query.limit);
        let next = if has_more {
            candidates
                .last()
                .map(|candidate| {
                    Ok::<_, Error>(contract::InventoryAnchor {
                        project_worktree: ycoding_schema::schema::AbsolutePath::new(
                            candidate.project_worktree.clone(),
                        )
                        .map_err(|error| Error::Record(Box::new(error)))?,
                        project_id: contract::Id::new(candidate.project_id.clone())
                            .map_err(|error| Error::Record(Box::new(error)))?,
                        directory: ycoding_schema::schema::AbsolutePath::new(
                            candidate.directory.clone(),
                        )
                        .map_err(|error| Error::Record(Box::new(error)))?,
                    })
                })
                .transpose()?
        } else {
            None
        };
        let data = candidates
            .into_iter()
            .map(|candidate| {
                let sessions = i64::try_from(candidate.sessions).map_err(|_| {
                    Error::Rejected("project session count exceeds supported range")
                })?;
                let time_active = candidate.time_active.max(0);
                let available = Path::new(&text(&candidate.directory)).is_dir();
                Ok(contract::InventoryEntry {
                    project_id: contract::Id::new(candidate.project_id)
                        .map_err(|error| Error::Record(Box::new(error)))?,
                    project_name: candidate.project_name,
                    project_worktree: ycoding_schema::schema::AbsolutePath::new(
                        candidate.project_worktree,
                    )
                    .map_err(|error| Error::Record(Box::new(error)))?,
                    directory: ycoding_schema::schema::AbsolutePath::new(candidate.directory)
                        .map_err(|error| Error::Record(Box::new(error)))?,
                    strategy: candidate.strategy,
                    sessions: NonNegativeInt::new(sessions)
                        .map_err(|error| Error::Record(Box::new(error)))?,
                    time_active: NonNegativeInt::new(time_active)
                        .map_err(|error| Error::Record(Box::new(error)))?,
                    available,
                })
            })
            .collect::<Result<Vec<_>, Error>>()?;
        Ok(InventoryPage { data, next })
    }

    pub async fn project_forget(
        &self,
        project_id: &LosslessString,
        directory: &LosslessString,
    ) -> Result<bool, Error> {
        let sessions = self
            .client
            .snapshot()?
            .scan::<SessionTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)?
            .into_iter()
            .filter(|row| row.project_id == *project_id && row.directory == *directory)
            .map(|row| row.id)
            .collect::<Vec<_>>();
        let project_id = project_id.clone();
        let directory = directory.clone();
        let created = chrono::Utc::now().timestamp_millis();
        self.client
            .submit(move |tx| {
                for id in sessions {
                    if tx.get::<SessionTable>(&super::key(&id))?.is_none() {
                        continue;
                    }
                    let family = super::removal::family(tx, &id)?;
                    super::removal::delete(tx, &family, created)?;
                    for member in family {
                        session::delete(tx, &member)?;
                    }
                }
                tx.delete::<DirectoryTable>(&tuple_key(&[
                    KeyPart::String(&project_id),
                    KeyPart::String(&directory),
                ]))
            })?
            .await
    }

    pub async fn record_project(
        &self,
        project: Project,
        directory: Option<LosslessString>,
    ) -> Result<(), Error> {
        self.client
            .submit(move |tx| {
                if tx.get::<ProjectTable>(&super::key(&project.id))?.is_none() {
                    ProjectTable::insert(tx, &project)?;
                }
                let Some(directory) = directory else {
                    return Ok(());
                };
                let key = tuple_key(&[KeyPart::String(&project.id), KeyPart::String(&directory)]);
                if tx.get::<DirectoryTable>(&key)?.is_none() {
                    tx.put::<DirectoryTable>(&Directory {
                        project_id: project.id.clone(),
                        directory,
                        type_: None,
                        strategy: None,
                        time_created: project.time_created,
                    })?;
                }
                Ok(())
            })?
            .await
    }
}

fn text_order(left: &LosslessString, right: &LosslessString) -> Ordering {
    char::decode_utf16(left.code_units())
        .map(|character| character.unwrap_or(char::REPLACEMENT_CHARACTER))
        .cmp(
            char::decode_utf16(right.code_units())
                .map(|character| character.unwrap_or(char::REPLACEMENT_CHARACTER)),
        )
        .then_with(|| left.cmp(right))
}

fn project_info(row: &Project) -> Result<contract::Info, Error> {
    let icon =
        (row.icon_url.is_some() || row.icon_url_override.is_some() || row.icon_color.is_some())
            .then(|| contract::Icon {
                url: row.icon_url.clone(),
                override_: row.icon_url_override.clone(),
                color: row.icon_color.clone(),
            });
    let time = contract::Time {
        created: nonnegative(row.time_created)?,
        updated: nonnegative(row.time_updated)?,
        initialized: row.time_initialized.map(nonnegative).transpose()?,
    };
    Ok(contract::Info {
        id: contract::Id::new(row.id.clone()).map_err(|error| Error::Record(Box::new(error)))?,
        worktree: row.worktree.clone(),
        vcs: row
            .vcs
            .as_ref()
            .map(|value| contract::Vcs::decode(&JsonValue::String(value.clone())))
            .transpose()
            .map_err(|error| Error::Record(Box::new(error)))?,
        name: row.name.clone(),
        icon,
        commands: row
            .commands
            .as_ref()
            .map(|commands| commands.domain())
            .transpose()?,
        time,
        sandboxes: row.sandboxes.clone(),
    })
}

fn project_directory(row: &Directory) -> Result<contract::Directory, Error> {
    Ok(contract::Directory {
        directory: ycoding_schema::schema::AbsolutePath::new(row.directory.clone())
            .map_err(|error| Error::Record(Box::new(error)))?,
        strategy: row.strategy.clone(),
    })
}

fn nonnegative(value: i64) -> Result<NonNegativeInt, Error> {
    NonNegativeInt::new(value).map_err(|error| Error::Record(Box::new(error)))
}

fn text(value: &LosslessString) -> String {
    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
}
