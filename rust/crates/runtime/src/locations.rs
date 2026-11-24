use crate::{convert, dispatch::Failure};
use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Bound,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, PoisonError, RwLock, Weak},
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
    DomainDecode, DomainEncode, LosslessString, domain, form, guardrail, location,
    project_id::ProjectId, schema::AbsolutePath, session, workspace_id::WorkspaceId,
};
use ycoding_core::ycoding_store::{
    Client, Error, KeyPart, Snapshot, TableSpec,
    project::{DirectoryTable, ProjectTable},
    resources,
    session::{Document, SessionTable},
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
type Reviews = Arc<Mutex<BTreeMap<session::Id, BTreeSet<guardrail::RequestId>>>>;
const PENDING_FORMS: &str = "session/forms/clean-restart";

struct Inner {
    client: Client,
    sessions: SessionStore,
    configuration: Configuration,
    factory: Option<Arc<crate::production::Factory>>,
    feed: Feed,
    autonomy: autonomy::Service,
    review: ycoding_core::session::review::Service,
    services: Mutex<BTreeMap<Key, Cached>>,
    standalone: Mutex<BTreeMap<session::Id, Weak<LocationServices>>>,
    initializers: Mutex<BTreeMap<Key, Weak<Mutex<()>>>>,
    lifecycle: RwLock<()>,
    retired: Mutex<Vec<Arc<ServiceSet>>>,
    loads: std::sync::atomic::AtomicU64,
    closed: std::sync::atomic::AtomicBool,
    usage: Mutex<BTreeMap<Key, UsageAcquisition>>,
}

struct UsageAcquisition {
    at: Instant,
    started: bool,
    failure: Option<Failure>,
    refresh: bool,
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
    pub agents: ycoding_core::resources::domain_state::DomainState<agent::Service>,
    pub production: Option<crate::production::Composed>,
    pub(crate) standalone: Option<crate::production::standalone::Composed>,
    snapshots: SnapshotSettings,
    reviews: Reviews,
    loaded: u64,
}

#[derive(Clone)]
pub(crate) struct Pending {
    permissions: Permissions,
    questions: Questions,
    forms: Forms,
    guardrails: Guardrails,
    reviews: Reviews,
}

impl Pending {
    pub(crate) fn in_use(&self) -> bool {
        let sessions = self
            .reviews
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        !self.permissions.list().is_empty()
            || self.questions.has_pending()
            || self.forms.has_pending()
            || sessions.iter().any(|session| {
                self.guardrails
                    .for_session(session)
                    .is_ok_and(|requests| !requests.is_empty())
            })
    }
    pub(crate) fn cancel(&self, session: &session::Id) {
        for request in self.permissions.for_session(session) {
            self.permissions.cancel(&request.id);
        }
        self.questions.cancel_session(session);
        self.guardrails.cancel_session(session);
        if !self.forms.cancel_session(session).is_empty() {
            tracing::error!("pending Form cancellation failed");
        }
        let requests = self
            .reviews
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(session);
        if let Some(requests) = requests {
            for id in requests {
                self.guardrails.cancel(&id);
            }
        }
    }

    pub(crate) fn shutdown(&self) {
        self.permissions.shutdown();
        self.questions.shutdown();
        if !self.forms.shutdown().is_empty() {
            tracing::error!("pending Forms shutdown failed");
        }
        self.guardrails.shutdown();
        self.reviews
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }
}

impl ServiceSet {
    pub(crate) fn pending(&self) -> Pending {
        Pending {
            permissions: self.permissions.clone(),
            questions: self.questions.clone(),
            forms: self.forms.clone(),
            guardrails: self.guardrails.clone(),
            reviews: self.reviews.clone(),
        }
    }
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

struct BuildOptions<'a> {
    boot: bool,
    previous: Option<&'a crate::production::Composed>,
    force: bool,
    standalone: Option<crate::production::standalone::Prepared>,
}

impl Locations {
    pub(crate) fn memory_counts(&self) -> (usize, usize, usize) {
        let services = self
            .0
            .services
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let (bound, full) = (
            services.len(),
            services
                .values()
                .filter(|entry| entry.services.production.is_some())
                .count(),
        );
        drop(services);
        let standalone = self
            .0
            .standalone
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .filter(|entry| entry.strong_count() > 0)
            .count();
        (bound, standalone, full)
    }

    pub(crate) fn retire_directory(&self, directory: &LosslessString) -> Result<(), Failure> {
        let directory = canonical(directory)?;
        let _lifecycle = self
            .0
            .lifecycle
            .write()
            .unwrap_or_else(PoisonError::into_inner);
        let removed = self
            .0
            .services
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .extract_if(.., |(path, _), _| path == &directory)
            .map(|(_, cached)| cached.services)
            .collect::<Vec<_>>();
        let mut retired = self
            .0
            .retired
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        retired.extend(removed);
        drop(retired);
        let mut standalone = self
            .0
            .standalone
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let removed = standalone
            .extract_if(.., |_, entry| {
                entry
                    .upgrade()
                    .is_some_and(|services| services.info.directory.as_lossless() == &directory)
            })
            .filter_map(|(_, entry)| entry.upgrade())
            .map(|services| services.inner.clone())
            .collect::<Vec<_>>();
        drop(standalone);
        self.0
            .retired
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .extend(removed);
        Ok(())
    }

    pub(crate) fn identity(
        &self,
        directory: &LosslessString,
        workspace: Option<&LosslessString>,
    ) -> Result<location::Project, Failure> {
        workspace
            .map(|id| WorkspaceId::new(id.clone()))
            .transpose()
            .map_err(|_| unrepresentable())?;
        let project = self.project_identity(&canonical(directory)?, workspace)?;
        Ok(location::Project {
            id: project.id,
            directory: AbsolutePath::new(project.directory).map_err(|_| unrepresentable())?,
        })
    }

    pub(crate) fn info(
        &self,
        directory: &LosslessString,
        workspace: Option<&LosslessString>,
    ) -> Result<location::Info, Failure> {
        if self.0.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(Failure::Unavailable("Location map is closed".into()));
        }
        let directory = canonical(directory)?;
        Ok(location::Info {
            project: self.identity(&directory, workspace)?,
            directory: AbsolutePath::new(directory).map_err(|_| unrepresentable())?,
            workspace_id: workspace
                .cloned()
                .map(WorkspaceId::new)
                .transpose()
                .map_err(|_| unrepresentable())?,
        })
    }

    fn project_identity(
        &self,
        directory: &LosslessString,
        workspace: Option<&LosslessString>,
    ) -> Result<Project, Failure> {
        let resolved = self.resolve(directory)?;
        let snapshot = self.0.client.snapshot().map_err(unavailable)?;
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
    }

    pub fn new(
        client: Client,
        sessions: SessionStore,
        configuration: Configuration,
        feed: Feed,
        autonomy: autonomy::Service,
        review: ycoding_core::session::review::Service,
    ) -> Self {
        Self(Arc::new(Inner {
            client,
            sessions,
            configuration,
            factory: None,
            feed,
            autonomy,
            review,
            services: Mutex::new(BTreeMap::new()),
            standalone: Mutex::new(BTreeMap::new()),
            initializers: Mutex::new(BTreeMap::new()),
            lifecycle: RwLock::new(()),
            retired: Mutex::new(Vec::new()),
            loads: std::sync::atomic::AtomicU64::new(0),
            closed: std::sync::atomic::AtomicBool::new(false),
            usage: Mutex::default(),
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
    ) -> Result<Option<ycoding_core::session::usage_read::Pricing>, Error> {
        if self.0.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(Error::Closed);
        }
        let key = (
            canonical(&reference.directory)
                .map_err(|_| Error::Rejected("Invalid pricing Location"))?,
            reference.workspace_id.clone(),
        );
        let catalog = self.cached_lease(&key).and_then(|services| {
            services
                .production
                .as_ref()
                .map(|composed| composed.models.catalog())
        });
        self.0
            .factory
            .as_ref()
            .ok_or(Error::Incompatible("Location pricing unavailable"))?
            .pricing(reference, catalog)
    }

    pub(crate) fn evict_idle(&self, now: Instant) -> Result<usize, Failure> {
        let mut cache = self
            .0
            .services
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let before = cache.len();
        let evicted = cache
            .keys()
            .filter(|key| {
                let cached = &cache[*key];
                !(Arc::strong_count(&cached.services) > 1
                    || cached
                        .services
                        .production
                        .as_ref()
                        .is_some_and(|composed| composed.in_use())
                    || now.saturating_duration_since(
                        *cached
                            .released
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner),
                    ) < Duration::from_secs(60 * 60))
            })
            .cloned()
            .collect::<Vec<_>>();
        let mut removed = evicted
            .iter()
            .filter_map(|key| cache.remove(key))
            .map(|cached| cached.services)
            .collect::<Vec<_>>();
        let count = before - cache.len();
        drop(cache);
        let mut retired = self
            .0
            .retired
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        removed.extend(retired.extract_if(.., |services| {
            Arc::strong_count(services) == 1
                && !services
                    .production
                    .as_ref()
                    .is_some_and(|composed| composed.in_use())
        }));
        drop(retired);
        self.close_sets(removed)?;
        Ok(count)
    }

    pub(crate) fn downgrade(&self) -> WeakLocations {
        WeakLocations(Arc::downgrade(&self.0))
    }

    pub fn reload(&self, info: &location::Info) -> Result<(), Failure> {
        self.replace(info, None, true).map(drop)
    }

    // Replaces the generation only while `generation` is still current, so a retired
    // generation's watcher cannot rebuild a Location it no longer owns.
    pub(crate) fn reload_generation(
        &self,
        info: &location::Info,
        generation: u64,
    ) -> Result<bool, Failure> {
        self.replace(info, Some(generation), false)
    }

    fn replace(
        &self,
        info: &location::Info,
        generation: Option<u64>,
        force: bool,
    ) -> Result<bool, Failure> {
        if self.0.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(Failure::Unavailable("Location map is closed".into()));
        }
        let _lifecycle = self
            .0
            .lifecycle
            .read()
            .unwrap_or_else(PoisonError::into_inner);
        if self.0.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(Failure::Unavailable("Location map is closed".into()));
        }
        let directory = canonical(info.directory.as_lossless())?;
        let key = (
            directory.clone(),
            info.workspace_id
                .as_ref()
                .map(|id| id.as_lossless().clone()),
        );
        let initializer = self.initializer(&key);
        let initializing = initializer.lock().unwrap_or_else(PoisonError::into_inner);
        if self.0.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(Failure::Unavailable("Location map is closed".into()));
        }
        let current = self
            .0
            .services
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&key)
            .map(|cached| cached.services.clone())
            .ok_or_else(|| Failure::Unavailable("Location is not acquired".into()))?;
        if generation.is_some_and(|generation| {
            current
                .production
                .as_ref()
                .map(|composed| composed.generation)
                != Some(generation)
        }) {
            return Ok(false);
        }
        let mut replacement = self.build(
            &directory,
            key.1.as_ref(),
            Project {
                id: current.info.project.id.clone(),
                directory: current.info.project.directory.as_lossless().clone(),
            },
            BuildOptions {
                boot: false,
                previous: current.production.as_ref(),
                force,
                standalone: None,
            },
        )?;
        replacement.loaded = current.loaded;
        let built = Arc::new(replacement);
        let mut cache = self
            .0
            .services
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let Some(current) = cache.get_mut(&key) else {
            drop(cache);
            drop(initializing);
            self.close_sets(vec![built])?;
            return if generation.is_some() {
                Ok(false)
            } else {
                Err(Failure::Unavailable("Location is not acquired".into()))
            };
        };
        let old = std::mem::replace(&mut current.services, built);
        self.0
            .retired
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(old);
        drop(cache);
        drop(initializing);
        let reference = location::Ref {
            directory: info.directory.clone(),
            workspace_id: info.workspace_id.clone(),
        };
        if let Some(factory) = &self.0.factory {
            factory.usage_changed(Some(&reference));
        }
        for data in [
            ycoding_core::event_feed::Data::CatalogUpdated(Box::new(
                ycoding_core::ycoding_schema::catalog::Empty,
            )),
            ycoding_core::event_feed::Data::AgentUpdated(Box::new(
                ycoding_core::ycoding_schema::agent::Empty,
            )),
            ycoding_core::event_feed::Data::CommandUpdated(Box::new(
                ycoding_core::ycoding_schema::command::Empty,
            )),
            ycoding_core::event_feed::Data::ReferenceUpdated(Box::new(
                ycoding_core::ycoding_schema::models_dev::Empty,
            )),
            ycoding_core::event_feed::Data::SkillUpdated(Box::new(
                ycoding_core::ycoding_schema::models_dev::Empty,
            )),
            ycoding_core::event_feed::Data::PluginUpdated(Box::new(
                ycoding_core::ycoding_schema::models_dev::Empty,
            )),
        ] {
            self.0
                .feed
                .emit(data, Some(reference.clone()))
                .map_err(|_| Failure::Unavailable("catalog update publication failed".into()))?;
        }
        self.0
            .feed
            .emit(
                ycoding_core::event_feed::Data::ConfigUpdated(Box::new(
                    ycoding_core::ycoding_schema::config::Empty,
                )),
                Some(location::Ref {
                    directory: info.directory.clone(),
                    workspace_id: info.workspace_id.clone(),
                }),
            )
            .map_err(|_| Failure::Unavailable("configuration update publication failed".into()))?;
        Ok(true)
    }

    pub(crate) async fn checkpoint_forms(&self) -> Result<(), Failure> {
        let mut pending = self
            .sets()
            .iter()
            .flat_map(|services| services.forms.list_ordered(None))
            .filter(|(_, form)| session::Id::new(form.session_id.clone()).is_ok())
            .collect::<Vec<_>>();
        if pending.is_empty() {
            return Ok(());
        }
        pending.sort_by_key(|(order, _)| *order);
        let forms = pending
            .into_iter()
            .map(|(_, form)| form)
            .collect::<Vec<_>>();
        let document = Document::<domain::Json>::new(forms.encode()).map_err(unavailable)?;
        let now = crate::ids::now_millis();
        self.0
            .client
            .submit(move |tx| resources::set_kv(tx, &PENDING_FORMS.into(), &document, now))
            .map_err(unavailable)?
            .await
            .map_err(unavailable)
    }

    pub(crate) async fn restore_forms(&self) -> Result<(), Failure> {
        let snapshot = self.0.client.snapshot().map_err(unavailable)?;
        let Some(document) =
            resources::get_kv(&snapshot, &PENDING_FORMS.into()).map_err(unavailable)?
        else {
            return Ok(());
        };
        drop(snapshot);
        let forms = Vec::<form::Info>::decode(document.value())
            .map_err(|_| Failure::Unavailable("Pending Form checkpoint is invalid".into()))?;
        for form in forms {
            let id = session::Id::new(form.session_id.clone())
                .map_err(|_| Failure::Unavailable("Pending Form owner is invalid".into()))?;
            let (session, services) = match self.session(&id) {
                Ok(owner) => owner,
                Err(Failure::SessionNotFound(_)) => continue,
                Err(error) => return Err(error),
            };
            if session.time.archived.is_none()
                && session.scope == ycoding_core::ycoding_schema::session_scope::Scope::Bound
            {
                services
                    .forms
                    .restore(form)
                    .map_err(|_| Failure::Unavailable("Pending Form restoration failed".into()))?;
            }
        }
        self.0
            .client
            .submit(|tx| resources::remove_kv(tx, &PENDING_FORMS.into()))
            .map_err(unavailable)?
            .await
            .map_err(unavailable)?;
        Ok(())
    }

    pub(crate) fn close(&self) -> Result<(), Failure> {
        self.0
            .closed
            .store(true, std::sync::atomic::Ordering::Release);
        self.0
            .usage
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
        let lifecycle = self
            .0
            .lifecycle
            .write()
            .unwrap_or_else(PoisonError::into_inner);
        let cache = std::mem::take(
            &mut *self
                .0
                .services
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
        );
        let mut removed = cache
            .into_values()
            .map(|cached| cached.services)
            .collect::<Vec<_>>();
        removed.extend(std::mem::take(
            &mut *self
                .0
                .retired
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
        ));
        let standalone = std::mem::take(
            &mut *self
                .0
                .standalone
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
        );
        for services in standalone
            .into_values()
            .filter_map(|services| services.upgrade())
        {
            services.pending().shutdown();
            if let Some(standalone) = &services.standalone {
                standalone.state.close();
            }
        }
        drop(lifecycle);
        self.close_sets(removed)
    }

    fn close_sets(&self, removed: Vec<Arc<ServiceSet>>) -> Result<(), Failure> {
        let mut failure = None;
        for services in removed {
            let standalone = services.standalone.is_some();
            let mut disposed = true;
            services.pending().shutdown();
            if let Some(factory) = &self.0.factory
                && let Err(error) = factory.close(&services)
            {
                disposed = false;
                failure.get_or_insert(error);
            }
            drop(services);
            if standalone || !disposed {
                continue;
            }
            let memory = ycoding_core::observability::memory::Scalar::sample();
            let (bound_locations, standalone_locations, full_locations) = self.memory_counts();
            tracing::info!(
                rss_bytes = memory.rss_bytes,
                rss_status = memory.rss_status,
                peak_rss_bytes = memory.peak_rss_bytes,
                bound_locations,
                standalone_locations,
                full_locations,
                "location services disposed"
            );
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
        if info.scope == ycoding_core::ycoding_schema::session_scope::Scope::Standalone {
            let services = self.standalone_session(&info)?;
            return Ok((info, services));
        }
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

    pub(crate) fn standalone_session(
        &self,
        info: &session::Info,
    ) -> Result<Arc<LocationServices>, Failure> {
        let _lifecycle = self
            .0
            .lifecycle
            .read()
            .unwrap_or_else(PoisonError::into_inner);
        if self.0.closed.load(std::sync::atomic::Ordering::Acquire)
            || info.scope != ycoding_core::ycoding_schema::session_scope::Scope::Standalone
        {
            return Err(Failure::Unavailable(
                "Standalone Session is unavailable".into(),
            ));
        }
        let mut cache = self
            .0
            .standalone
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(services) = cache.get(&info.id).and_then(Weak::upgrade) {
            if let Some(standalone) = &services.standalone {
                standalone
                    .state
                    .assert_current()
                    .map_err(|_| Failure::Unavailable("Standalone configuration changed".into()))?;
            }
            return Ok(services);
        }
        cache.retain(|_, services| services.strong_count() > 0);
        let factory = self.0.factory.as_ref().ok_or_else(|| {
            Failure::Unavailable("Standalone runner factory is unavailable".into())
        })?;
        let prepared = factory.prepare_standalone(&info.location)?;
        let set = self.build(
            info.location.directory.as_lossless(),
            info.location
                .workspace_id
                .as_ref()
                .map(|id| id.as_lossless()),
            Project {
                id: info.project_id.clone(),
                directory: info.location.directory.as_lossless().clone(),
            },
            BuildOptions {
                boot: false,
                previous: None,
                force: false,
                standalone: Some(prepared),
            },
        )?;
        let services = Arc::new(LocationServices {
            inner: Arc::new(set),
            released: Arc::new(Mutex::new(Instant::now())),
        });
        cache.insert(info.id.clone(), Arc::downgrade(&services));
        Ok(services)
    }
    pub(crate) fn is_current(&self, services: &LocationServices) -> bool {
        !self.0.closed.load(std::sync::atomic::Ordering::Acquire)
            && self
                .0
                .services
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(&(
                    services.info.directory.as_lossless().clone(),
                    services
                        .info
                        .workspace_id
                        .as_ref()
                        .map(|id| id.as_lossless().clone()),
                ))
                .is_some_and(|current| Arc::ptr_eq(&current.services, &services.inner))
    }

    pub fn location(
        &self,
        directory: &LosslessString,
        workspace: Option<&LosslessString>,
    ) -> Result<Arc<LocationServices>, Failure> {
        self.acquire(directory, workspace, |directory| {
            // A recorded Project that differs from the filesystem identity keeps its ID so
            // Sessions, permissions and artifacts already bound to it stay attached.
            self.project_identity(directory, workspace)
        })
    }

    pub(crate) fn loaded_location(
        &self,
        directory: &LosslessString,
        workspace: Option<&LosslessString>,
    ) -> Result<Arc<LocationServices>, Failure> {
        self.find_loaded_location(directory, workspace)?
            .ok_or_else(|| Failure::Unavailable("Location publication is unavailable".into()))
    }

    pub(crate) fn loaded_project_session(
        &self,
        id: &session::Id,
    ) -> Result<Option<Arc<LocationServices>>, Failure> {
        let info = self
            .0
            .sessions
            .get(id)
            .map_err(unavailable)?
            .ok_or_else(|| Failure::SessionNotFound(convert::readable(id.as_lossless())))?;
        if info.scope == ycoding_core::ycoding_schema::session_scope::Scope::Standalone {
            return Ok(None);
        }
        self.find_loaded_location(
            info.location.directory.as_lossless(),
            info.location
                .workspace_id
                .as_ref()
                .map(WorkspaceId::as_lossless),
        )
    }

    fn find_loaded_location(
        &self,
        directory: &LosslessString,
        workspace: Option<&LosslessString>,
    ) -> Result<Option<Arc<LocationServices>>, Failure> {
        if self.0.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(Failure::Unavailable("Location map is closed".into()));
        }
        Ok(self.cached_lease(&(canonical(directory)?, workspace.cloned())))
    }

    pub(crate) fn prepare_usage_location(
        &self,
        directory: &LosslessString,
        workspace: Option<&LosslessString>,
        refresh: bool,
    ) -> Result<Option<Arc<LocationServices>>, Failure> {
        if self.0.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(Failure::Unavailable("Location map is closed".into()));
        }
        let key = (canonical(directory)?, workspace.cloned());
        let mut usage = self.0.usage.lock().unwrap_or_else(PoisonError::into_inner);
        if self.0.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(Failure::Unavailable("Location map is closed".into()));
        }
        if let Some(acquisition) = usage.get_mut(&key) {
            acquisition.refresh |= refresh;
            if let Some(failure) = &acquisition.failure {
                if acquisition.at.elapsed() < Duration::from_secs(30) {
                    return Err(failure.clone());
                }
                acquisition.failure = None;
                acquisition.started = false;
                acquisition.at = Instant::now();
            } else {
                return Ok(None);
            }
        } else {
            if let Some(services) = self.cached_lease(&key) {
                return Ok(Some(services));
            }
            if usage.len() >= 32 {
                let oldest = usage
                    .iter()
                    .filter(|(_, value)| value.failure.is_some())
                    .min_by_key(|(_, value)| value.at)
                    .map(|(key, _)| key.clone());
                let Some(oldest) = oldest else {
                    return Err(Failure::Unavailable(
                        "Usage Location preparation queue is full".into(),
                    ));
                };
                usage.remove(&oldest);
            }
            usage.insert(
                key,
                UsageAcquisition {
                    at: Instant::now(),
                    started: false,
                    failure: None,
                    refresh,
                },
            );
        }
        drop(usage);
        if let Some(factory) = &self.0.factory {
            factory.wake_usage();
        }
        Ok(None)
    }

    pub(crate) fn prepare_usage_locations(&self) -> Vec<(Arc<LocationServices>, bool)> {
        let mut prepared = Vec::new();
        for _ in 0..32 {
            if self.0.closed.load(std::sync::atomic::Ordering::Acquire) {
                break;
            }
            let key = {
                let mut usage = self.0.usage.lock().unwrap_or_else(PoisonError::into_inner);
                usage.iter_mut().find_map(|(key, value)| {
                    if value.started || value.failure.is_some() {
                        return None;
                    }
                    value.started = true;
                    Some(key.clone())
                })
            };
            let Some(key) = key else {
                break;
            };
            let result = self.location(&key.0, key.1.as_ref());
            let mut usage = self.0.usage.lock().unwrap_or_else(PoisonError::into_inner);
            match result {
                Ok(services) => {
                    if let Some(requested) = usage.remove(&key) {
                        prepared.push((services, requested.refresh));
                    }
                }
                Err(failure) => {
                    if let Some(value) = usage.get_mut(&key) {
                        value.failure = Some(failure);
                        value.at = Instant::now();
                        value.started = false;
                    }
                }
            }
        }
        prepared
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
        let _lifecycle = self
            .0
            .lifecycle
            .read()
            .unwrap_or_else(PoisonError::into_inner);
        if self.0.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(Failure::Unavailable("Location map is closed".into()));
        }
        let directory = canonical(directory)?;
        let key = (directory.clone(), workspace.cloned());
        if let Some(cached) = self.cached_lease(&key) {
            return Ok(cached);
        }
        let initializer = self.initializer(&key);
        let _initializing = initializer.lock().unwrap_or_else(PoisonError::into_inner);
        if self.0.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(Failure::Unavailable("Location map is closed".into()));
        }
        if let Some(cached) = self.cached_lease(&key) {
            return Ok(cached);
        }
        let project = project(&directory)?;
        let mut set = self.build(
            &directory,
            workspace,
            project,
            BuildOptions {
                boot: true,
                previous: None,
                force: false,
                standalone: None,
            },
        )?;
        set.loaded = self
            .0
            .loads
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let built = Arc::new(set);
        let released = Arc::new(Mutex::new(Instant::now()));
        self.0
            .services
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(
                key,
                Cached {
                    services: built.clone(),
                    released: released.clone(),
                },
            );
        if let Some(factory) = &self.0.factory {
            factory.usage_changed(Some(&location::Ref {
                directory: built.info.directory.clone(),
                workspace_id: built.info.workspace_id.clone(),
            }));
        }
        Ok(Arc::new(LocationServices {
            inner: built,
            released,
        }))
    }

    fn initializer(&self, key: &Key) -> Arc<Mutex<()>> {
        let mut initializers = self
            .0
            .initializers
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        initializers.retain(|_, entry| entry.strong_count() > 0);
        match initializers.get(key).and_then(Weak::upgrade) {
            Some(initializer) => initializer,
            None => {
                let initializer = Arc::new(Mutex::new(()));
                initializers.insert(key.clone(), Arc::downgrade(&initializer));
                initializer
            }
        }
    }

    fn cached_lease(&self, key: &Key) -> Option<Arc<LocationServices>> {
        self.0
            .services
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(key)
            .map(|cached| {
                Arc::new(LocationServices {
                    inner: cached.services.clone(),
                    released: cached.released.clone(),
                })
            })
    }

    fn build(
        &self,
        directory: &LosslessString,
        workspace: Option<&LosslessString>,
        project: Project,
        options: BuildOptions<'_>,
    ) -> Result<ServiceSet, Failure> {
        let BuildOptions {
            boot,
            previous,
            force,
            standalone,
        } = options;
        let started = Instant::now();
        let before = ycoding_core::observability::memory::Scalar::sample();
        let prepared = self
            .0
            .factory
            .as_ref()
            .filter(|_| standalone.is_none())
            .map(|factory| {
                if !force {
                    return factory.prepare(
                        directory,
                        workspace,
                        project.id.as_lossless(),
                        &project.directory,
                    );
                }
                factory.prepare_refresh(
                    directory,
                    workspace,
                    project.id.as_lossless(),
                    &project.directory,
                    force,
                )
            })
            .transpose()?;
        let mut configuration = standalone
            .as_ref()
            .map(|prepared| prepared.configuration.clone())
            .or_else(|| {
                prepared
                    .as_ref()
                    .map(|prepared| prepared.configuration.clone())
            })
            .unwrap_or_else(|| self.0.configuration.clone());
        let agents = ycoding_core::resources::domain_state::DomainState::new(
            (*configuration.agents).clone(),
        );
        let authority = Authority {
            store: self.0.client.clone(),
            agents: Arc::new({
                let agents = agents.clone();
                let standalone = standalone.as_ref().map(|prepared| prepared.state.clone());
                move |id| {
                    if standalone
                        .as_ref()
                        .is_some_and(|state| state.assert_current().is_err())
                    {
                        return None;
                    }
                    agents
                        .snapshot()
                        .resolve(id)
                        .map(|agent| (agent.id.clone(), agent.permissions.clone()))
                }
            }),
        };
        let feed = self.0.feed.clone();
        let reviews = Reviews::default();
        let requested = reviews.clone();
        let sink = configuration.publisher.clone();
        let event_location = location::Ref {
            directory: AbsolutePath::new(directory.clone()).map_err(|_| unrepresentable())?,
            workspace_id: workspace
                .map(|id| WorkspaceId::new(id.clone()))
                .transpose()
                .map_err(|_| unrepresentable())?,
        };
        let publisher: Publisher = Arc::new(move |event| {
            if event.type_ == "guardrail.asked" {
                let request = guardrail::Request::decode(&event.data)
                    .map_err(|_| "invalid guardrail request publication".to_owned())?;
                requested
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .entry(request.session_id)
                    .or_default()
                    .insert(request.id);
            }
            if event.type_ == "guardrail.replied" {
                let reply = guardrail::RepliedData::decode(&event.data)
                    .map_err(|_| "invalid guardrail reply publication".to_owned())?;
                let mut reviews = requested.lock().unwrap_or_else(PoisonError::into_inner);
                if reviews.get_mut(&reply.session_id).is_some_and(|requests| {
                    requests.remove(&reply.request_id);
                    requests.is_empty()
                }) {
                    reviews.remove(&reply.session_id);
                }
            }
            let mut publication = crate::services::ephemeral(&event)?;
            publication.location = Some(event_location.clone());
            sink(event)?;
            feed.publish(publication);
            Ok(())
        });
        let review = ycoding_core::tools::policy::Reviews {
            service: self.0.review.clone(),
            limit: configuration.guardrails.limits.reviews as usize,
        };
        let decision_context = Arc::new(
            ycoding_core::coordination::decision_context::Service::new(self.0.client.clone()),
        );
        let permissions =
            Permissions::new(authority.clone(), project.id.clone(), publisher.clone())
                .with_reviews(review.clone(), directory.clone())
                .with_context(decision_context.clone());
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
        )
        .with_reviews(review.clone())
        .with_context(decision_context);
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
            questions: Questions::new(authority.clone(), publisher.clone())
                .with_reviews(review.clone()),
            forms: Forms::new(authority, publisher.clone()).with_reviews(review),
            guardrails,
            agents,
            production: None,
            standalone: None,
            snapshots: configuration.snapshots.clone(),
            reviews,
            loaded: 0,
        };
        if let Some(prepared) = prepared {
            let composed = self
                .0
                .factory
                .as_ref()
                .expect("prepared by factory")
                .compose(&services, prepared, boot, previous)?;
            services.agents = composed.agents.clone();
            let helpers = HelperEnvironment {
                generate: Arc::new(composed.runner.clone()),
                memory: composed.memory.clone(),
            };
            configuration.helpers = Some(Arc::new(move |_| Some(helpers.clone())));
            services.production = Some(composed);
        }
        if let Some(prepared) = standalone {
            services.standalone = Some(
                self.0
                    .factory
                    .as_ref()
                    .expect("standalone factory")
                    .compose_standalone(&services, prepared.state, publisher)?,
            );
            let memory = ycoding_core::observability::memory::Scalar::sample();
            tracing::info!(
                scope = "standalone",
                duration_ms = started.elapsed().as_millis() as u64,
                rss_before_bytes = before.rss_bytes,
                rss_bytes = memory.rss_bytes,
                rss_status = memory.rss_status,
                peak_rss_bytes = memory.peak_rss_bytes,
                "location services booted"
            );
            return Ok(services);
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
        let memory = ycoding_core::observability::memory::Scalar::sample();
        tracing::info!(
            scope = "bound",
            duration_ms = started.elapsed().as_millis() as u64,
            rss_before_bytes = before.rss_bytes,
            rss_bytes = memory.rss_bytes,
            rss_status = memory.rss_status,
            peak_rss_bytes = memory.peak_rss_bytes,
            "location services booted"
        );
        Ok(services)
    }

    pub(crate) fn reload_current(&self) -> Result<(), Failure> {
        if self.0.factory.is_none() {
            return Ok(());
        }
        let current = self
            .0
            .services
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .filter_map(|cached| {
                cached
                    .services
                    .production
                    .as_ref()
                    .map(|composed| (cached.services.info.clone(), composed.generation))
            })
            .collect::<Vec<_>>();
        let mut failure = None;
        for (info, generation) in current {
            if let Err(error) = self.reload_generation(&info, generation) {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }

    pub(crate) async fn credentials_changed(&self) -> Result<(), Failure> {
        let locations = self.clone();
        tokio::task::spawn_blocking(move || locations.reload_current())
            .await
            .map_err(|_| Failure::Unavailable("credential refresh worker failed".into()))?
    }

    pub(crate) fn policy_sets(&self, info: &location::Info) -> Vec<Arc<ServiceSet>> {
        let mut sets = self
            .0
            .services
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .filter(|cached| {
                cached.services.info.directory == info.directory
                    && cached.services.info.workspace_id == info.workspace_id
            })
            .map(|cached| cached.services.clone())
            .collect::<Vec<_>>();
        sets.extend(
            self.0
                .retired
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .iter()
                .filter(|services| {
                    services.info.directory == info.directory
                        && services.info.workspace_id == info.workspace_id
                })
                .cloned(),
        );
        sets
    }

    pub(crate) fn client(&self) -> &Client {
        &self.0.client
    }

    pub(crate) fn current_sets(&self) -> Vec<Arc<ServiceSet>> {
        self.0
            .services
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .map(|cached| cached.services.clone())
            .collect()
    }

    pub(crate) fn loaded_groups(&self) -> Vec<Vec<Arc<ServiceSet>>> {
        let mut groups = std::collections::BTreeMap::<u64, Vec<Arc<ServiceSet>>>::new();
        for cached in self
            .0
            .services
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
        {
            groups
                .entry(cached.services.loaded)
                .or_default()
                .push(cached.services.clone());
        }
        for retired in self
            .0
            .retired
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
        {
            groups
                .entry(retired.loaded)
                .or_default()
                .push(retired.clone());
        }
        groups.into_values().collect()
    }

    fn sets(&self) -> Vec<Arc<ServiceSet>> {
        let mut sets = self
            .0
            .services
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .map(|cached| cached.services.clone())
            .collect::<Vec<_>>();
        sets.extend(
            self.0
                .retired
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .iter()
                .cloned(),
        );
        sets
    }

    pub(crate) async fn cancel_session(&self, session: &session::Id) -> Result<(), Failure> {
        match &self.0.factory {
            Some(factory) => factory.cancel_session(session).await,
            None => self.release_controls(session).await,
        }
    }

    pub(crate) async fn release_controls(&self, session: &session::Id) -> Result<(), Failure> {
        let locations = self.clone();
        let cancelling = session.clone();
        let isolated = tokio::task::spawn_blocking(move || {
            let mut isolated = Vec::new();
            for services in locations.sets() {
                services.pending().cancel(&cancelling);
                if let Some(composed) = &services.production
                    && !isolated
                        .iter()
                        .any(|current| Arc::ptr_eq(current, &composed.isolated))
                {
                    isolated.push(composed.isolated.clone());
                }
            }
            isolated
        })
        .await
        .map_err(|_| Failure::Unavailable("Session ownership cancellation worker failed".into()))?;
        let mut failure = None;
        for isolated in isolated {
            if isolated.release_session(session).await.is_err() {
                failure.get_or_insert_with(|| {
                    Failure::Unavailable("Session isolated browser release failed".into())
                });
            }
        }
        failure.map_or(Ok(()), Err)
    }
}

impl Locations {
    pub(crate) fn resolve_move(
        &self,
        target: &location::Ref,
    ) -> Result<(location::Info, Option<ProjectId>), Failure> {
        let resolved = self.resolve(target.directory.as_lossless())?;
        let previous = resolved
            .previous
            .map(ProjectId::new)
            .transpose()
            .map_err(|_| unrepresentable())?;
        Ok((
            location::Info {
                directory: target.directory.clone(),
                workspace_id: target.workspace_id.clone(),
                project: location::Project {
                    id: ProjectId::new(resolved.id).map_err(|_| unrepresentable())?,
                    directory: AbsolutePath::new(
                        resolved.directory.to_str().ok_or_else(unrepresentable)?,
                    )
                    .map_err(|_| unrepresentable())?,
                },
            },
            previous,
        ))
    }

    pub(crate) fn move_location(
        &self,
        info: &location::Info,
    ) -> Result<Arc<LocationServices>, Failure> {
        self.acquire(
            info.directory.as_lossless(),
            info.workspace_id.as_ref().map(WorkspaceId::as_lossless),
            |_| {
                Ok(Project {
                    id: info.project.id.clone(),
                    directory: info.project.directory.as_lossless().clone(),
                })
            },
        )
    }

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
        if self.0.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Ok(());
        }
        let _lifecycle = self
            .0
            .lifecycle
            .read()
            .unwrap_or_else(PoisonError::into_inner);
        let initializer = self.initializer(&key);
        let initializing = initializer.lock().unwrap_or_else(PoisonError::into_inner);
        let removed = self
            .0
            .services
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&key);
        if let Some(removed) = removed {
            let mut sets = self.policy_sets(&removed.services.info);
            sets.push(removed.services.clone());
            self.0
                .retired
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(removed.services);
            drop(initializing);
            let mut failure = None;
            for services in sets {
                services.pending().shutdown();
                if let Some(factory) = &self.0.factory
                    && let Err(error) = factory.evict(&services)
                {
                    failure.get_or_insert(error);
                }
            }
            return failure.map_or(Ok(()), Err);
        }
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
    struct Refused;

    impl ycoding_core::session::review::Delivery for Refused {
        fn wake(&self, _: &session::Id) {}
        fn answer_child<'a>(
            &'a self,
            _: ycoding_core::session::review::ChildAnswer,
        ) -> ycoding_core::session::review::DeliveryFuture<'a> {
            Box::pin(async {
                Err(ycoding_core::session::review::DeliveryError::Conflict(
                    "no delivery in this fixture".into(),
                ))
            })
        }
        fn resolve_recovery<'a>(
            &'a self,
            _: ycoding_core::session::review::RecoveryResolution,
        ) -> ycoding_core::session::review::DeliveryFuture<'a> {
            Box::pin(async {
                Err(ycoding_core::session::review::DeliveryError::Conflict(
                    "no delivery in this fixture".into(),
                ))
            })
        }
    }

    use super::*;
    use ycoding_core::process::guardrails::Limits;
    use ycoding_core::ycoding_store::{Catalog, Metadata, Options, Store, TableDeclaration};

    #[test]
    fn identity_resolution_keeps_the_recorded_project_without_loading_services() {
        let (_store, locations, path) = fixture();
        let project = locations.identity(&path, None).unwrap();
        assert_eq!(project.id.as_lossless().as_str(), Some("prj_ttl"));
        assert_eq!(project.directory.as_lossless(), &path);
        assert!(locations.cached().is_empty());
        locations.retire_directory(&path).unwrap();
        assert!(locations.cached().is_empty());
        locations.close().unwrap();
    }

    #[test]
    fn retiring_a_directory_preserves_leases_and_unrelated_cache_identities() {
        let (_store, locations, path) = fixture();
        let nested = format!("{}/nested", path.as_str().unwrap());
        let neighboring = format!("{}-neighbor", path.as_str().unwrap());
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir_all(&neighboring).unwrap();
        let held = locations.location(&path, None).unwrap();
        let workspace = locations
            .location(&path, Some(&"wrk_retirement".into()))
            .unwrap();
        let child = locations.location(&nested.into(), None).unwrap();
        let neighbor = locations.location(&neighboring.into(), None).unwrap();
        let original = Arc::downgrade(&held.inner);
        locations.retire_directory(&path).unwrap();
        assert_eq!(locations.cached().len(), 2);
        let replacement = locations.location(&path, None).unwrap();
        assert!(!std::ptr::eq::<ServiceSet>(&**held, &**replacement));
        locations.evict_idle(Instant::now()).unwrap();
        assert!(original.upgrade().is_some());
        assert_eq!(held.info.directory, replacement.info.directory);
        drop(held);
        drop(workspace);
        locations.evict_idle(Instant::now()).unwrap();
        assert!(original.upgrade().is_none());
        assert_eq!(
            child
                .info
                .directory
                .as_lossless()
                .as_str()
                .unwrap()
                .rsplit('/')
                .next(),
            Some("nested")
        );
        assert!(
            neighbor
                .info
                .directory
                .as_lossless()
                .as_str()
                .unwrap()
                .ends_with("-neighbor")
        );
        locations.close().unwrap();
    }

    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn fixture() -> (Store, Locations, LosslessString) {
        let directory = std::env::temp_dir().join(format!(
            "location-ttl-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
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
                decide_reviews: false,
                decide_hard_reviews: true,
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
            autonomy::Service::new(client.clone()),
            ycoding_core::session::review::Service::new(
                SessionStore::new(client),
                Arc::new(Refused),
            ),
        );
        (store, locations, path)
    }

    #[test]
    fn initializing_one_location_does_not_block_other_locations_or_cached_reads() {
        let (_store, locations, path) = fixture();
        let held = locations.location(&path, None).unwrap();
        let cold = PathBuf::from(path.as_str().unwrap()).join("cold");
        let other = PathBuf::from(path.as_str().unwrap()).join("other");
        std::fs::create_dir_all(&cold).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let (started, waiting) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let blocked = locations.clone();
        let initializer = std::thread::spawn(move || {
            blocked.acquire(&cold.to_str().unwrap().into(), None, |_| {
                started.send(()).unwrap();
                released.recv().unwrap();
                Err(Failure::Unavailable("fixture initialization failed".into()))
            })
        });
        waiting.recv_timeout(Duration::from_secs(2)).unwrap();
        let (completed, completion) = std::sync::mpsc::channel();
        let readers = std::thread::scope(|scope| {
            let cached = locations.clone();
            let ready = path.clone();
            let sender = completed.clone();
            scope.spawn(move || {
                let acquired = cached.location(&ready, None).unwrap();
                sender
                    .send(("cached", acquired.info.directory.clone()))
                    .unwrap();
            });
            let listed = locations.clone();
            let sender = completed.clone();
            scope.spawn(move || {
                let entries = listed.cached();
                sender
                    .send(("listed", AbsolutePath::new(entries[0].0.clone()).unwrap()))
                    .unwrap();
            });
            let fresh = locations.clone();
            scope.spawn(move || {
                let acquired = fresh
                    .location(&other.to_str().unwrap().into(), None)
                    .unwrap();
                completed
                    .send(("other", acquired.info.directory.clone()))
                    .unwrap();
            });
            let results = (0..3)
                .map(|_| completion.recv_timeout(Duration::from_secs(2)))
                .collect::<Vec<_>>();
            release.send(()).unwrap();
            results
        });
        assert!(initializer.join().unwrap().is_err());
        assert!(readers.iter().all(Result::is_ok));
        assert!(
            readers
                .iter()
                .filter_map(|item| item.as_ref().ok())
                .any(|(kind, directory)| {
                    *kind == "cached" && directory == &held.info.directory
                })
        );
        locations.close().unwrap();
    }

    #[test]
    fn concurrent_acquisition_initializes_one_location_once_and_failed_initialization_can_retry() {
        let (_store, locations, path) = fixture();
        let failed = locations.acquire(&path, None, |_| {
            Err(Failure::Unavailable("fixture initialization failed".into()))
        });
        assert!(failed.is_err());
        let (started, waiting) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let first = locations.clone();
        let directory = path.clone();
        let initializer = std::thread::spawn(move || {
            first
                .acquire(&directory, None, |directory| {
                    started.send(()).unwrap();
                    released.recv().unwrap();
                    Ok(Project {
                        id: ProjectId::new("prj_ttl").unwrap(),
                        directory: directory.clone(),
                    })
                })
                .unwrap()
        });
        waiting.recv_timeout(Duration::from_secs(2)).unwrap();
        let second = locations.clone();
        let directory = path.clone();
        let joined = std::thread::spawn(move || {
            second
                .acquire(&directory, None, |_| {
                    Err(Failure::Unavailable("duplicate initialization".into()))
                })
                .unwrap()
        });
        release.send(()).unwrap();
        let first = initializer.join().unwrap();
        let second = joined.join().unwrap();
        assert!(std::ptr::eq::<ServiceSet>(&**first, &**second));
        assert_eq!(locations.cached().len(), 1);
        locations.close().unwrap();
    }

    #[test]
    fn closing_waits_for_admitted_initialization_and_refuses_new_acquisition() {
        let (_store, locations, path) = fixture();
        let (started, waiting) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let first = locations.clone();
        let directory = path.clone();
        let initializer = std::thread::spawn(move || {
            first.acquire(&directory, None, |_| {
                started.send(()).unwrap();
                released.recv().unwrap();
                Err(Failure::Unavailable("fixture initialization failed".into()))
            })
        });
        waiting.recv_timeout(Duration::from_secs(2)).unwrap();
        let closing = locations.clone();
        let (finished, completion) = std::sync::mpsc::channel();
        let closer = std::thread::spawn(move || {
            let result = closing.close();
            finished.send(()).unwrap();
            result
        });
        while !locations
            .0
            .closed
            .load(std::sync::atomic::Ordering::Acquire)
        {
            std::thread::yield_now();
        }
        let rejected = locations.location(&path, None).is_err();
        let premature = completion.try_recv().is_ok();
        release.send(()).unwrap();
        assert!(initializer.join().unwrap().is_err());
        closer.join().unwrap().unwrap();
        assert!(rejected);
        assert!(!premature);
        assert!(locations.cached().is_empty());
    }

    #[test]
    fn eviction_waits_for_same_location_initialization_before_removing_the_cache_key() {
        let (_store, locations, path) = fixture();
        let (started, waiting) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let first = locations.clone();
        let directory = path.clone();
        let initializer = std::thread::spawn(move || {
            first
                .acquire(&directory, None, |directory| {
                    started.send(()).unwrap();
                    released.recv().unwrap();
                    Ok(Project {
                        id: ProjectId::new("prj_ttl").unwrap(),
                        directory: directory.clone(),
                    })
                })
                .unwrap()
        });
        waiting.recv_timeout(Duration::from_secs(2)).unwrap();
        let evicting = locations.clone();
        let (finished, completion) = std::sync::mpsc::channel();
        let evictor = std::thread::spawn(move || {
            evicting.evict(&path, None).unwrap();
            finished.send(()).unwrap();
        });
        let premature = completion.recv_timeout(Duration::from_secs(2)).is_ok();
        release.send(()).unwrap();
        let held = initializer.join().unwrap();
        evictor.join().unwrap();
        assert!(!premature);
        assert!(locations.cached().is_empty());
        assert!(held.permissions.list().is_empty());
        locations.close().unwrap();
    }

    #[test]
    fn idle_ttl_starts_when_the_last_location_lease_is_released() {
        let (_store, locations, path) = fixture();
        let lease = locations.location(&path, None).unwrap();
        assert_eq!(
            locations
                .evict_idle(Instant::now() + Duration::from_secs(7200))
                .unwrap(),
            0,
            "leased services cannot be evicted"
        );
        drop(lease);
        let released = Instant::now();
        assert_eq!(
            locations
                .evict_idle(released + Duration::from_secs(3599))
                .unwrap(),
            0
        );
        assert_eq!(
            locations
                .evict_idle(released + Duration::from_secs(3601))
                .unwrap(),
            1,
            "TTL must start at release, not at the next sweep"
        );
    }
}
