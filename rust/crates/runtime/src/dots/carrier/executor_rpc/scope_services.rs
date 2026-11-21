use crate::locations::Locations;
use std::{ops::Bound, path::Path, sync::Arc, time::Duration};
use ycoding_core::{
    cca::error::{Authorize, BoxFuture, ExecutorError},
    dots::native::{
        executor_authorization::{ReviewDirectories, deferred_authorization},
        executor_scope::{CatalogProject, CurrentCheck, OpenedDirectory, ScopeServices},
    },
    platform::{git, project_identity},
    session::{lifecycle::Change, store::Service as SessionStore},
    ycoding_schema::{LosslessString, session},
    ycoding_store::{KeyPart, project::ProjectTable, tuple_key},
};

const PAGE: usize = 256;

fn unavailable() -> ExecutorError {
    ExecutorError::new(-32603, "Executor scope unavailable")
}

pub fn rename_change(title: &LosslessString) -> Change {
    Change::Rename(title.clone())
}

pub fn catalog_project(
    id: LosslessString,
    worktree: String,
    name: Option<LosslessString>,
) -> CatalogProject {
    CatalogProject { id, worktree, name }
}

pub struct RuntimeScopeServices {
    locations: Locations,
    sessions: SessionStore,
    git: Arc<git::Service>,
    review_directories: Option<ReviewDirectories>,
    timeout: Option<Duration>,
}

impl RuntimeScopeServices {
    pub fn new(
        locations: Locations,
        sessions: SessionStore,
        git: Arc<git::Service>,
        review_directories: Option<ReviewDirectories>,
        timeout: Option<Duration>,
    ) -> Self {
        Self {
            locations,
            sessions,
            git,
            review_directories,
            timeout,
        }
    }
}

impl ScopeServices for RuntimeScopeServices {
    fn open_directory(
        &self,
        directory: &str,
    ) -> BoxFuture<'_, Result<OpenedDirectory, ExecutorError>> {
        let directory = LosslessString::from(directory);
        Box::pin(async move {
            let services = self
                .locations
                .location(&directory, None)
                .map_err(|_| unavailable())?;
            Ok(OpenedDirectory {
                directory: services
                    .info
                    .directory
                    .as_lossless()
                    .to_utf8()
                    .map_err(|_| unavailable())?,
                project_id: services.info.project.id.as_lossless().clone(),
            })
        })
    }

    fn project_root(&self, directory: &str) -> Option<String> {
        let resolved = project_identity::resolve(&self.git, Path::new(directory)).ok()?;
        resolved.directory.to_str().map(str::to_owned)
    }

    fn projects(&self) -> BoxFuture<'_, Result<Vec<CatalogProject>, ExecutorError>> {
        Box::pin(async move {
            let snapshot = self
                .locations
                .client()
                .snapshot()
                .map_err(|_| unavailable())?;
            let mut catalog = Vec::new();
            let mut after: Option<Vec<u8>> = None;
            loop {
                let rows = snapshot
                    .scan::<ProjectTable>(
                        after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                        Bound::Unbounded,
                        PAGE,
                    )
                    .map_err(|_| unavailable())?;
                let Some(last) = rows.last() else {
                    break;
                };
                let next = tuple_key(&[KeyPart::String(&last.id)]);
                let finished = rows.len() < PAGE;
                for row in rows {
                    let Ok(worktree) = row.worktree.to_utf8() else {
                        continue;
                    };
                    catalog.push(catalog_project(row.id, worktree, row.name));
                }
                if finished {
                    break;
                }
                after = Some(next);
            }
            Ok(catalog)
        })
    }

    fn rename_session(
        &self,
        session: &session::Id,
        title: &LosslessString,
    ) -> BoxFuture<'_, Result<(), ExecutorError>> {
        let (session, change) = (session.clone(), rename_change(title));
        Box::pin(async move {
            match self.sessions.change(&session, change).await {
                Ok(true) => Ok(()),
                Ok(false) | Err(_) => Err(unavailable()),
            }
        })
    }

    fn authorization(
        &self,
        session: &session::Info,
        current: CurrentCheck,
    ) -> BoxFuture<'_, Result<Arc<dyn Authorize>, ExecutorError>> {
        let id = session.id.clone();
        Box::pin(async move {
            let (_, services) = self.locations.session(&id).map_err(|_| unavailable())?;
            let locations = self.locations.clone();
            let held = services.clone();
            let upstream = current;
            let check: CurrentCheck = Arc::new(move || {
                let (locations, held, upstream) =
                    (locations.clone(), held.clone(), upstream.clone());
                Box::pin(async move {
                    upstream().await?;
                    if locations.is_current(&held) {
                        Ok(())
                    } else {
                        Err(unavailable())
                    }
                })
            });
            deferred_authorization(
                id,
                services.permissions.clone(),
                services.guardrails.clone(),
                check,
                self.review_directories.clone(),
                self.timeout,
            )
        })
    }
}
