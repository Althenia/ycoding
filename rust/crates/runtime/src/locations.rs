use crate::{convert, dispatch::Failure};
use std::{
    collections::BTreeMap,
    ops::Bound,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};
use ycoding_core::event_feed::Feed;
use ycoding_core::platform::{git, project_identity};
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
    factory: Option<Arc<crate::production::Factory>>,
    feed: Feed,
    autonomy: autonomy::Service,
    services: Mutex<BTreeMap<Key, Cached>>,
    retired: Mutex<Vec<Arc<ServiceSet>>>,
    closed: std::sync::atomic::AtomicBool,
}

struct Cached {
    services: Arc<ServiceSet>,
    released: Arc<Mutex<Instant>>,
}

#[derive(Clone)]
pub struct Locations(Arc<Inner>);

#[derive(Clone)]
pub(crate) struct WeakLocations(std::sync::Weak<Inner>);

impl WeakLocations {
    pub(crate) fn upgrade(&self) -> Option<Locations> {
        self.0.upgrade().map(Locations)
    }
}

pub struct LocationServices {
    inner: Arc<ServiceSet>,
    released: Arc<Mutex<Instant>>,
}

impl std::ops::Deref for LocationServices {
    type Target = ServiceSet;
    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

impl Drop for LocationServices {
    fn drop(&mut self) {
        *self.released.lock().unwrap_or_else(PoisonError::into_inner) = Instant::now();
    }
}

pub struct ServiceSet {
    pub info: location::Info,
    pub permissions: Permissions,
    pub saved: SavedPermissions,
    pub questions: Questions,
    pub forms: Forms,
    pub guardrails: Guardrails,
    pub prediction: Option<prediction::Service>,
    pub prompts: Option<prompt_generator::Service>,
    pub agents: Arc<agent::Service>,
    pub production: Option<crate::production::Composed>,
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
            factory: None,
            feed,
            autonomy,
            services: Mutex::new(BTreeMap::new()),
            retired: Mutex::new(Vec::new()),
            closed: std::sync::atomic::AtomicBool::new(false),
        }))
    }

    pub(crate) fn with_factory(mut self, factory: Arc<crate::production::Factory>) -> Self {
        Arc::get_mut(&mut self.0)
            .expect("new Location map is unshared")
            .factory = Some(factory);
        self
    }

    pub fn pricing(
        &self,
        reference: &ycoding_core::session::usage_read::PricingRef,
    ) -> Option<ycoding_core::session::usage_read::Pricing> {
        let services = self
            .location(&reference.directory, reference.workspace_id.as_ref())
            .ok()?;
        let composed = services.production.as_ref()?;
        let saved = composed.credentials.all().ok()?;
        let model = composed.models.catalog().get(
            &ycoding_core::ycoding_schema::provider::Id(reference.provider.clone()),
            &reference.model,
            reference
                .profile
                .as_ref()
                .map(|profile| ycoding_core::ycoding_schema::model::ProfileName(profile.clone()))
                .as_ref(),
            &saved,
        )?;
        Some(ycoding_core::session::usage_read::Pricing {
            provider: model.cost,
            router: vec![],
        })
    }

    pub(crate) fn evict_idle(&self, now: Instant) -> Result<usize, Failure> {
        let mut cache = self
            .0
            .services
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let before = cache.len();
        let evicted = cache.keys().filter(|key| {
            let cached = &cache[*key];
            !(
            Arc::strong_count(&cached.services) > 1
                || cached.services.production.as_ref().is_some_and(|composed| composed.in_use())
                || now.saturating_duration_since(
                    *cached
                        .released
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner),
                ) < Duration::from_secs(60 * 60))
        }).cloned().collect::<Vec<_>>();
        let mut removed = evicted.iter().filter_map(|key| cache.remove(key)).map(|cached| cached.services).collect::<Vec<_>>();
        let count = before - cache.len();
        drop(cache);
        let mut retired = self.0.retired.lock().unwrap_or_else(PoisonError::into_inner);
        removed.extend(retired.extract_if(.., |services| Arc::strong_count(services) == 1 && !services.production.as_ref().is_some_and(|composed| composed.in_use())));
        drop(retired);
        self.close_sets(removed)?;
        Ok(count)
    }

    pub(crate) fn downgrade(&self) -> WeakLocations {
        WeakLocations(Arc::downgrade(&self.0))
    }

    pub fn reload(&self, info: &location::Info) -> Result<(), Failure> {
        self.replace(info, None).map(drop)
    }

    // Replaces the generation only while `generation` is still current, so a retired
    // generation's watcher cannot rebuild a Location it no longer owns.
    pub(crate) fn reload_generation(&self, info: &location::Info, generation: u64) -> Result<bool, Failure> {
        self.replace(info, Some(generation))
    }

    fn replace(&self, info: &location::Info, generation: Option<u64>) -> Result<bool, Failure> {
        if self.0.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(Failure::Unavailable("Location map is closed".into()));
        }
        let directory = canonical(info.directory.as_lossless())?;
        let key = (directory.clone(), info.workspace_id.as_ref().map(|id| id.as_lossless().clone()));
        let mut cache = self.0.services.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(current) = cache.get_mut(&key) else {
            return Err(Failure::Unavailable("Location is not acquired".into()));
        };
        if generation.is_some_and(|generation| {
            current.services.production.as_ref().map(|composed| composed.generation) != Some(generation)
        }) {
            return Ok(false);
        }
        let built = Arc::new(self.build(&directory, key.1.as_ref(), Project {
            id: current.services.info.project.id.clone(),
            directory: current.services.info.project.directory.as_lossless().clone(),
        }, false)?);
        let old = std::mem::replace(&mut current.services, built);
        self.0.retired.lock().unwrap_or_else(PoisonError::into_inner).push(old);
        drop(cache);
        self.0.feed.emit(ycoding_core::event_feed::Data::ConfigUpdated(Box::new(ycoding_core::ycoding_schema::config::Empty)), Some(location::Ref {
            directory: info.directory.clone(), workspace_id: info.workspace_id.clone(),
        })).map_err(|_| Failure::Unavailable("configuration update publication failed".into()))?;
        Ok(true)
    }

    pub(crate) fn close(&self) -> Result<(), Failure> {
        self.0.closed.store(true, std::sync::atomic::Ordering::Release);
        let cache = std::mem::take(&mut *self.0.services.lock().unwrap_or_else(PoisonError::into_inner));
        let mut removed = cache.into_values().map(|cached| cached.services).collect::<Vec<_>>();
        removed.extend(std::mem::take(&mut *self.0.retired.lock().unwrap_or_else(PoisonError::into_inner)));
        self.close_sets(removed)
    }

    fn close_sets(&self, removed: Vec<Arc<ServiceSet>>) -> Result<(), Failure> {
        let mut failure = None;
        if let Some(factory) = &self.0.factory {
            for services in removed {
                if let Err(error) = factory.close(&services) {
                    failure.get_or_insert(error);
                }
            }
        }
        failure.map_or(Ok(()), Err)
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
            let resolved = self.resolve(directory)?;
            let snapshot = self.0.client.snapshot().map_err(unavailable)?;
            // A recorded Project that differs from the filesystem identity keeps its ID so
            // Sessions, permissions and artifacts already bound to it stay attached.
            if let Some(project) = recorded_project(&snapshot, directory, workspace)
                .map_err(unavailable)?
                .filter(|project| project.as_str() != Some(resolved.id.as_str()))
            {
                return Ok(Project {
                    directory: project_worktree(&snapshot, &project)?,
                    id: ProjectId::new(project).map_err(|_| unrepresentable())?,
                });
            }
            Ok(Project {
                directory: resolved
                    .directory
                    .to_str()
                    .map(LosslessString::from)
                    .ok_or_else(unrepresentable)?,
                id: ProjectId::new(resolved.id).map_err(|_| unrepresentable())?,
            })
        })
    }

    fn acquire(
        &self,
        directory: &LosslessString,
        workspace: Option<&LosslessString>,
        project: impl FnOnce(&LosslessString) -> Result<Project, Failure>,
    ) -> Result<Arc<LocationServices>, Failure> {
        if self.0.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(Failure::Unavailable("Location map is closed".into()));
        }
        let directory = canonical(directory)?;
        let key = (directory.clone(), workspace.cloned());
        let mut cache = self
            .0
            .services
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(cached) = cache.get(&key) {
            return Ok(Arc::new(LocationServices {
                inner: cached.services.clone(),
                released: cached.released.clone(),
            }));
        }
        let project = project(&directory)?;
        let built = Arc::new(self.build(&directory, workspace, project, true)?);
        let released = Arc::new(Mutex::new(Instant::now()));
        cache.insert(
            key,
            Cached {
                services: built.clone(),
                released: released.clone(),
            },
        );
        Ok(Arc::new(LocationServices {
            inner: built,
            released,
        }))
    }

    fn build(
        &self,
        directory: &LosslessString,
        workspace: Option<&LosslessString>,
        project: Project,
        boot: bool,
    ) -> Result<ServiceSet, Failure> {
        let prepared = self
            .0
            .factory
            .as_ref()
            .map(|factory| factory.prepare(directory, workspace, project.id.as_lossless(), &project.directory))
            .transpose()?;
        let mut configuration = prepared
            .as_ref()
            .map(|prepared| prepared.configuration.clone())
            .unwrap_or_else(|| self.0.configuration.clone());
        let agents = configuration.agents.clone();
        let authority = Authority {
            store: self.0.client.clone(),
            agents: Arc::new(move |id| {
                agents
                    .resolve(id)
                    .map(|agent| (agent.id.clone(), agent.permissions.clone()))
            }),
        };
        let feed = self.0.feed.clone();
        let sink = configuration.publisher.clone();
        let event_location = location::Ref {
            directory: AbsolutePath::new(directory.clone()).map_err(|_| unrepresentable())?,
            workspace_id: workspace
                .map(|id| WorkspaceId::new(id.clone()))
                .transpose()
                .map_err(|_| unrepresentable())?,
        };
        let publisher: Publisher = Arc::new(move |event| {
            let mut publication = crate::services::ephemeral(&event)?;
            publication.location = Some(event_location.clone());
            sink(event)?;
            feed.publish(publication);
            Ok(())
        });
        let permissions =
            Permissions::new(authority.clone(), project.id.clone(), publisher.clone());
        let guardrails = Guardrails::new(
            authority.clone(),
            permissions.clone(),
            Settings {
                paths: Paths {
                    workdir: if prepared.is_some() {
                        physical_path(Path::new(directory.as_str().ok_or_else(unrepresentable)?))?
                    } else {
                        directory.clone()
                    },
                    project: if prepared.is_some() {
                        physical_path(Path::new(
                            project.directory.as_str().ok_or_else(unrepresentable)?,
                        ))?
                    } else {
                        project.directory.clone()
                    },
                    ..configuration.guardrails.paths.clone()
                },
                ..configuration.guardrails.clone()
            },
            publisher.clone(),
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
        let mut services = ServiceSet {
            prediction: None,
            prompts: None,
            info,
            saved: SavedPermissions {
                store: self.0.client.clone(),
            },
            permissions,
            questions: Questions::new(authority.clone(), publisher.clone()),
            forms: Forms::new(authority, publisher),
            guardrails,
            agents: configuration.agents.clone(),
            production: None,
            snapshots: configuration.snapshots.clone(),
        };
        if let Some(prepared) = prepared {
            let composed = self
                .0
                .factory
                .as_ref()
                .expect("prepared by factory")
                .compose(&services, prepared, boot)?;
            let helpers = HelperEnvironment {
                generate: Arc::new(composed.runner.clone()),
                memory: composed.memory.clone(),
            };
            configuration.helpers = Some(Arc::new(move |_| Some(helpers.clone())));
            services.production = Some(composed);
        }
        let dependencies = configuration
            .helpers
            .as_ref()
            .and_then(|helpers| helpers(&services.info))
            .map(|helpers| Dependencies {
                store: self.0.sessions.clone(),
                agents: services.agents.clone(),
                generate: helpers.generate,
                memory: helpers.memory,
                permissions: services.permissions.clone(),
                feed: self.0.feed.clone(),
                location: location::Ref {
                    directory: services.info.directory.clone(),
                    workspace_id: services.info.workspace_id.clone(),
                },
            });
        services.prediction = dependencies
            .clone()
            .map(|dependencies| prediction::Service::new(dependencies, self.0.autonomy.clone()));
        services.prompts = dependencies.map(prompt_generator::Service::new);
        Ok(services)
    }
}

impl Locations {
    pub fn cached(&self) -> Vec<(LosslessString, Option<LosslessString>)> {
        self.0
            .services
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .keys()
            .cloned()
            .collect()
    }

    pub fn evict(
        &self,
        directory: &LosslessString,
        workspace: Option<&LosslessString>,
    ) -> Result<(), Failure> {
        let key = (canonical(directory)?, workspace.cloned());
        self.0
            .services
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&key);
        Ok(())
    }

    pub async fn record(&self, info: &location::Info, opened: bool) -> Result<(), Failure> {
        let directory = info.directory.as_lossless().clone();
        if opened && !Path::new(directory.as_str().ok_or_else(unrepresentable)?).is_dir() {
            return Ok(());
        }
        let locations = self.clone();
        let target = directory.clone();
        let resolved = tokio::task::spawn_blocking(move || locations.resolve(&target))
            .await
            .map_err(|_| Failure::Unavailable("Project identity resolution failed".into()))??;
        let now = crate::ids::now_millis();
        self.0
            .sessions
            .record_project(
                ycoding_core::ycoding_store::project::Project {
                    id: info.project.id.as_lossless().clone(),
                    worktree: info.project.directory.as_lossless().clone(),
                    vcs: resolved
                        .vcs
                        .filter(|_| info.project.id.as_lossless().as_str() == Some(&resolved.id))
                        .map(|vcs| vcs.kind.as_str().into()),
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: now,
                    time_updated: now,
                    time_initialized: None,
                    sandboxes: vec![],
                    commands: None,
                },
                opened.then_some(directory),
            )
            .await
            .map_err(unavailable)
    }

    fn resolve(&self, directory: &LosslessString) -> Result<project_identity::Resolved, Failure> {
        project_identity::resolve(
            &self.0.configuration.snapshots.git,
            Path::new(directory.as_str().ok_or_else(unrepresentable)?),
        )
        .map_err(|_| Failure::Unavailable("Project identity resolution failed".into()))
    }
}

pub(crate) fn physical_path(path: &Path) -> Result<LosslessString, Failure> {
    std::fs::canonicalize(path)
        .map_err(|_| Failure::Unavailable("Location guardrail directory is unavailable".into()))?
        .to_str()
        .map(LosslessString::from)
        .ok_or_else(unrepresentable)
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

#[cfg(test)]
mod tests {
    use super::*;
    use ycoding_core::process::guardrails::Limits;
    use ycoding_core::ycoding_store::{Catalog, Metadata, Options, Store, TableDeclaration};

    #[test]
    fn idle_ttl_starts_when_the_last_location_lease_is_released() {
        let directory = std::env::temp_dir().join(format!(
            "location-ttl-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        const CATALOG: Catalog = Catalog::new(
            1,
            &[
                TableDeclaration::of::<SessionTable>(),
                TableDeclaration::of::<DirectoryTable>(),
                TableDeclaration::of::<ProjectTable>(),
                TableDeclaration::of::<ycoding_core::ycoding_store::analytics::DeliveryTable>(),
                TableDeclaration::of::<ycoding_core::ycoding_store::analytics::IntentTable>(),
            ],
        );
        let store = Store::initialize(
            directory.join("store.redb"),
            Options::core(),
            CATALOG,
            Metadata::new([1; 16], 1),
        )
        .unwrap();
        let path: LosslessString = directory.to_str().unwrap().into();
        let recorded = path.clone();
        store
            .submit(move |tx| {
                ProjectTable::insert(
                    tx,
                    &ycoding_core::ycoding_store::project::Project {
                        id: "prj_ttl".into(),
                        worktree: recorded,
                        vcs: None,
                        name: None,
                        icon_url: None,
                        icon_url_override: None,
                        icon_color: None,
                        time_created: 1,
                        time_updated: 1,
                        time_initialized: None,
                        sandboxes: vec![],
                        commands: None,
                    },
                )
            })
            .unwrap()
            .wait()
            .unwrap();
        let client = store.client();
        let configuration = Configuration {
            agents: Arc::new(agent::Service::new(vec![agent::empty("god".into())])),
            publisher: Arc::new(|_| Ok(())),
            helpers: None,
            guardrails: Settings {
                paths: Paths {
                    workdir: path.clone(),
                    project: path.clone(),
                    home: path.clone(),
                    tmpdir: None,
                    trusted_paths: vec![],
                },
                global_roots: vec![],
                custom: Arc::new(Vec::new),
                enabled: true,
                limits: Limits::default(),
            },
            snapshots: SnapshotSettings {
                git: Arc::new(git::Service::new(1024)),
                data: directory,
                enabled: false,
            },
        };
        let locations = Locations::new(
            client.clone(),
            SessionStore::new(client.clone()),
            configuration,
            Feed::attach(&client),
            autonomy::Service::new(client),
        );
        let lease = locations.location(&path, None).unwrap();
        assert_eq!(
            locations.evict_idle(Instant::now() + Duration::from_secs(7200)).unwrap(),
            0,
            "leased services cannot be evicted"
        );
        drop(lease);
        let released = Instant::now();
        assert_eq!(
            locations.evict_idle(released + Duration::from_secs(3599)).unwrap(),
            0
        );
        assert_eq!(
            locations.evict_idle(released + Duration::from_secs(3601)).unwrap(),
            1,
            "TTL must start at release, not at the next sweep"
        );
    }
}
