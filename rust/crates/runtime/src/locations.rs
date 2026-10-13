use crate::{convert, dispatch::Failure};
use std::{
    collections::BTreeMap,
    ops::Bound,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
};
use ycoding_core::event_feed::Feed;
use ycoding_core::platform::git;
use ycoding_core::process::guardrails::{Guardrails, Paths, Settings};
use ycoding_core::resources::{agent, memory};
use ycoding_core::session::{
    autonomy,
    helper_generation::{Dependencies, Generate},
    prediction, prompt_generator,
    snapshot::GitSnapshots,
    store::Service as SessionStore,
};
use ycoding_core::tools::policy::{
    Authority, Publisher,
    forms::Forms,
    permissions::{Permissions, SavedPermissions},
    questions::Questions,
};
use ycoding_core::ycoding_schema::{
    LosslessString, location, project_id::ProjectId, schema::AbsolutePath, session,
    workspace_id::WorkspaceId,
};
use ycoding_core::ycoding_store::{
    Client, Error, KeyPart, Snapshot, TableSpec,
    project::{DirectoryTable, ProjectTable},
    session::SessionTable,
    tuple_key,
};

#[derive(Clone)]
pub struct SnapshotSettings {
    pub git: Arc<git::Service>,
    pub data: PathBuf,
    pub enabled: bool,
}

#[derive(Clone)]
pub struct HelperEnvironment {
    pub generate: Arc<dyn Generate>,
    pub memory: Arc<memory::Service>,
}

pub type HelperProvider = Arc<dyn Fn(&location::Info) -> Option<HelperEnvironment> + Send + Sync>;

#[derive(Clone)]
pub struct Configuration {
    pub agents: Arc<agent::Service>,
    pub publisher: Publisher,
    pub guardrails: Settings,
    pub snapshots: SnapshotSettings,
    pub helpers: Option<HelperProvider>,
}

type Key = (LosslessString, Option<LosslessString>);

struct Inner {
    client: Client,
    sessions: SessionStore,
    configuration: Configuration,
    feed: Feed,
    autonomy: autonomy::Service,
    services: Mutex<BTreeMap<Key, Arc<LocationServices>>>,
}

#[derive(Clone)]
pub struct Locations(Arc<Inner>);

pub struct LocationServices {
    pub info: location::Info,
    pub permissions: Permissions,
    pub saved: SavedPermissions,
    pub questions: Questions,
    pub forms: Forms,
    pub guardrails: Guardrails,
    pub prediction: Option<prediction::Service>,
    pub prompts: Option<prompt_generator::Service>,
    snapshots: SnapshotSettings,
}

impl LocationServices {
    pub fn snapshots(&self, session: &session::Info) -> GitSnapshots {
        GitSnapshots::new(
            self.snapshots.git.clone(),
            self.snapshots.data.clone(),
            convert::readable(session.project_id.as_lossless()),
            PathBuf::from(convert::readable(self.info.project.directory.as_lossless())),
            PathBuf::from(convert::readable(self.info.directory.as_lossless())),
            self.snapshots.enabled,
        )
    }
}

struct Project {
    id: ProjectId,
    directory: LosslessString,
}

impl Locations {
    pub fn new(
        client: Client,
        sessions: SessionStore,
        configuration: Configuration,
        feed: Feed,
        autonomy: autonomy::Service,
    ) -> Self {
        Self(Arc::new(Inner {
            client,
            sessions,
            configuration,
            feed,
            autonomy,
            services: Mutex::new(BTreeMap::new()),
        }))
    }

    pub fn session(
        &self,
        id: &session::Id,
    ) -> Result<(session::Info, Arc<LocationServices>), Failure> {
        let info = self
            .0
            .sessions
            .get(id)
            .map_err(unavailable)?
            .ok_or_else(|| Failure::SessionNotFound(convert::readable(id.as_lossless())))?;
        let services = self.acquire(
            info.location.directory.as_lossless(),
            info.location
                .workspace_id
                .as_ref()
                .map(WorkspaceId::as_lossless),
            |_| {
                let snapshot = self.0.client.snapshot().map_err(unavailable)?;
                Ok(Project {
                    directory: project_worktree(&snapshot, info.project_id.as_lossless())?,
                    id: info.project_id.clone(),
                })
            },
        )?;
        Ok((info, services))
    }

    pub fn location(
        &self,
        directory: &LosslessString,
        workspace: Option<&LosslessString>,
    ) -> Result<Arc<LocationServices>, Failure> {
        self.acquire(directory, workspace, |directory| {
            let snapshot = self.0.client.snapshot().map_err(unavailable)?;
            let project = recorded_project(&snapshot, directory, workspace)
                .map_err(unavailable)?
                .ok_or_else(|| {
                    Failure::Unavailable("no Project is recorded for the Location directory".into())
                })?;
            Ok(Project {
                directory: project_worktree(&snapshot, &project)?,
                id: ProjectId::new(project).map_err(|_| unrepresentable())?,
            })
        })
    }

    fn acquire(
        &self,
        directory: &LosslessString,
        workspace: Option<&LosslessString>,
        project: impl FnOnce(&LosslessString) -> Result<Project, Failure>,
    ) -> Result<Arc<LocationServices>, Failure> {
        let directory = canonical(directory)?;
        let key = (directory.clone(), workspace.cloned());
        if let Some(services) = self.cached(&key) {
            return Ok(services);
        }
        let project = project(&directory)?;
        let built = Arc::new(self.build(&directory, workspace, project)?);
        Ok(self
            .0
            .services
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(key)
            .or_insert(built)
            .clone())
    }

    fn cached(&self, key: &Key) -> Option<Arc<LocationServices>> {
        self.0
            .services
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(key)
            .cloned()
    }

    fn build(
        &self,
        directory: &LosslessString,
        workspace: Option<&LosslessString>,
        project: Project,
    ) -> Result<LocationServices, Failure> {
        let configuration = &self.0.configuration;
        let agents = configuration.agents.clone();
        let authority = Authority {
            store: self.0.client.clone(),
            agents: Arc::new(move |id| {
                agents
                    .resolve(id)
                    .map(|agent| (agent.id.clone(), agent.permissions.clone()))
            }),
        };
        let permissions = Permissions::new(
            authority.clone(),
            project.id.clone(),
            configuration.publisher.clone(),
        );
        let guardrails = Guardrails::new(
            authority.clone(),
            permissions.clone(),
            Settings {
                paths: Paths {
                    workdir: directory.clone(),
                    project: project.directory.clone(),
                    ..configuration.guardrails.paths.clone()
                },
                ..configuration.guardrails.clone()
            },
            configuration.publisher.clone(),
        );
        let info = location::Info {
            directory: AbsolutePath::new(directory.clone()).map_err(|_| unrepresentable())?,
            workspace_id: workspace
                .map(|workspace| WorkspaceId::new(workspace.clone()))
                .transpose()
                .map_err(|_| Failure::Invalid("invalid workspace ID".into()))?,
            project: location::Project {
                id: project.id,
                directory: AbsolutePath::new(project.directory).map_err(|_| unrepresentable())?,
            },
        };
        let dependencies = configuration
            .helpers
            .as_ref()
            .and_then(|helpers| helpers(&info))
            .map(|helpers| Dependencies {
                store: self.0.sessions.clone(),
                agents: configuration.agents.clone(),
                generate: helpers.generate,
                memory: helpers.memory,
                permissions: permissions.clone(),
                feed: self.0.feed.clone(),
                location: location::Ref {
                    directory: info.directory.clone(),
                    workspace_id: info.workspace_id.clone(),
                },
            });
        Ok(LocationServices {
            prediction: dependencies.clone().map(|dependencies| {
                prediction::Service::new(dependencies, self.0.autonomy.clone())
            }),
            prompts: dependencies.map(prompt_generator::Service::new),
            info,
            saved: SavedPermissions {
                store: self.0.client.clone(),
            },
            permissions,
            questions: Questions::new(authority.clone(), configuration.publisher.clone()),
            forms: Forms::new(authority, configuration.publisher.clone()),
            guardrails,
            snapshots: configuration.snapshots.clone(),
        })
    }
}

fn canonical(directory: &LosslessString) -> Result<LosslessString, Failure> {
    let text = directory
        .to_utf8()
        .map_err(|_| Failure::Invalid("Location directory is not valid UTF-8".into()))?;
    if !Path::new(&text).is_absolute() {
        return Err(Failure::Invalid(
            "Location directory must be absolute".into(),
        ));
    }
    let mut resolved = PathBuf::new();
    for component in Path::new(&text).components() {
        match component {
            Component::Prefix(_) | Component::RootDir => resolved.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            Component::Normal(name) => resolved.push(name),
        }
    }
    resolved
        .to_str()
        .map(LosslessString::from)
        .ok_or_else(|| Failure::Invalid("Location directory is not valid UTF-8".into()))
}

fn project_worktree(snapshot: &Snapshot, id: &LosslessString) -> Result<LosslessString, Failure> {
    snapshot
        .get::<ProjectTable>(&tuple_key(&[KeyPart::String(id)]))
        .map_err(unavailable)?
        .map(|row| row.worktree)
        .ok_or_else(|| Failure::Unavailable("the Location's Project is not recorded".into()))
}

fn recorded_project(
    snapshot: &Snapshot,
    directory: &LosslessString,
    workspace: Option<&LosslessString>,
) -> Result<Option<LosslessString>, Error> {
    if let Some(row) = find::<SessionTable>(snapshot, |row| {
        row.directory == *directory && row.workspace_id.as_ref() == workspace
    })? {
        return Ok(Some(row.project_id));
    }
    if let Some(row) = find::<DirectoryTable>(snapshot, |row| row.directory == *directory)? {
        return Ok(Some(row.project_id));
    }
    Ok(find::<ProjectTable>(snapshot, |row| row.worktree == *directory)?.map(|row| row.id))
}

fn find<T: TableSpec>(
    snapshot: &Snapshot,
    matches: impl Fn(&T::Record) -> bool,
) -> Result<Option<T::Record>, Error> {
    let mut after: Option<Vec<u8>> = None;
    loop {
        let rows = snapshot.scan::<T>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            128,
        )?;
        let Some(last) = rows.last() else {
            return Ok(None);
        };
        after = Some(T::primary_key(last));
        if let Some(row) = rows.into_iter().find(&matches) {
            return Ok(Some(row));
        }
    }
}

fn unavailable(_: Error) -> Failure {
    Failure::Unavailable("Session store unavailable".into())
}

fn unrepresentable() -> Failure {
    Failure::Unavailable("stored Location is not representable".into())
}
