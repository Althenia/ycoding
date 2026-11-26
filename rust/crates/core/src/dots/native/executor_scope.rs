use super::{Configuration, Host, Pins, Subscription};
use crate::{
    cca::{
        error::{Attribution, Authorize, BoxFuture, ExecutorError, ScopeContext},
        executor::{ExecutorScope, ScopeProvider},
        library::{
            LibraryCallError, LibraryFactory, LibraryOpenInput, LibraryProcess, LibraryTool,
        },
        signal::Signal,
        transcript::{CommandHook, Recorder, SessionTranscript, TranscriptOptions},
        value::{Value, concat},
    },
    dots::authority::{Gate, Lifetime, unavailable},
    session::projector,
};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use ycoding_schema::{JsonPath, LosslessString, ObjectDecoder, ObjectEncoder, session};
use ycoding_store::{
    resources,
    session::{Document, NewEvent},
};

fn scope_unavailable() -> ExecutorError {
    ExecutorError::new(-32603, "Executor scope unavailable")
}
fn nonempty(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 256
}
fn nonempty_attribution(value: &LosslessString) -> bool {
    let mut count = 0;
    let mut visible = false;
    for character in char::decode_utf16(value.code_units()) {
        count += 1;
        visible |= character.map_or(true, |character| !character.is_whitespace());
    }
    visible && count <= 256
}
fn lossless_text(value: &LosslessString) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>()))
}

pub type CurrentCheck =
    Arc<dyn Fn() -> BoxFuture<'static, Result<(), ExecutorError>> + Send + Sync>;

pub struct OpenedDirectory {
    pub directory: String,
    pub project_id: LosslessString,
}
pub struct CatalogProject {
    pub id: LosslessString,
    pub worktree: String,
    pub name: Option<LosslessString>,
}
#[derive(Clone)]
pub struct LibraryPrincipal {
    pub profile: String,
    pub credential_id: String,
    pub account_id: String,
    pub account_generation: i64,
    pub access_revision: u64,
}
pub struct LibraryScope {
    pub session_id: session::Id,
    pub principal: LibraryPrincipal,
    pub roots: Vec<String>,
    pub current: CurrentCheck,
    pub authorize: Arc<dyn Authorize>,
}

pub trait ScopeServices: Send + Sync {
    fn open_directory(
        &self,
        directory: &str,
    ) -> BoxFuture<'_, Result<OpenedDirectory, ExecutorError>>;
    fn project_root(&self, directory: &str) -> Option<String>;
    fn projects(&self) -> BoxFuture<'_, Result<Vec<CatalogProject>, ExecutorError>>;
    fn rename_session(
        &self,
        session: &session::Id,
        title: &LosslessString,
    ) -> BoxFuture<'_, Result<(), ExecutorError>>;
    fn authorization(
        &self,
        session: &session::Info,
        current: CurrentCheck,
    ) -> BoxFuture<'_, Result<Arc<dyn Authorize>, ExecutorError>>;
}
pub trait LibraryProvider: Send + Sync {
    fn factory(
        &self,
        scope: LibraryScope,
        session: &session::Info,
    ) -> BoxFuture<'_, Result<Arc<dyn LibraryFactory>, ExecutorError>>;
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Thread,
    Unattributed,
}

struct Entry {
    key: LosslessString,
    kind: Kind,
    session: Mutex<session::Info>,
    configuration: Configuration,
    lifetime: Arc<Mutex<Lifetime>>,
    gate: Gate,
    authorization: OnceLock<Arc<dyn Authorize>>,
    transcript: Arc<SessionTranscript>,
    library: OnceLock<Arc<dyn LibraryFactory>>,
    library_signal: Signal,
    library_processes: Mutex<Vec<Arc<FencedProcess>>>,
    library_failed: AtomicBool,
    opening: AtomicUsize,
    opened: tokio::sync::Notify,
    refs: Mutex<usize>,
    subscriptions: Mutex<Vec<Subscription>>,
    authorization_closing: OnceLock<Mutex<BoxFuture<'static, Result<(), ExecutorError>>>>,
    closing: tokio::sync::OnceCell<Result<(), ExecutorError>>,
}

impl Entry {
    fn retire(&self) {
        Lifetime::retire(&self.lifetime);
        self.library_signal.cancel();
    }
}
impl Drop for Entry {
    fn drop(&mut self) {
        self.retire();
    }
}

struct Opening<'a>(&'a Entry);
impl Drop for Opening<'_> {
    fn drop(&mut self) {
        self.0.opening.fetch_sub(1, Ordering::AcqRel);
        self.0.opened.notify_one();
    }
}

struct Inner {
    host: Host,
    services: Arc<dyn ScopeServices>,
    library: Option<Arc<dyn LibraryProvider>>,
    environment_id: String,
    home: String,
    data: PathBuf,
    entries: Mutex<HashMap<LosslessString, Arc<Entry>>>,
    locks: Mutex<HashMap<LosslessString, Arc<tokio::sync::Semaphore>>>,
}

#[derive(Clone)]
pub(crate) struct ExecutorScopes(Arc<Inner>);

pub fn executor_scopes(
    host: Host,
    services: Arc<dyn ScopeServices>,
    library: Option<Arc<dyn LibraryProvider>>,
    environment_id: String,
    home: String,
    data: PathBuf,
) -> Result<Arc<dyn ScopeProvider>, ExecutorError> {
    Ok(Arc::new(ExecutorScopes::new(
        host,
        services,
        library,
        environment_id,
        home,
        data,
    )?))
}

fn collapse(roots: Vec<String>) -> Vec<String> {
    let mut unique: Vec<String> = vec![];
    for root in roots {
        if !unique.contains(&root) {
            unique.push(root);
        }
    }
    unique
        .iter()
        .filter(|root| {
            !unique
                .iter()
                .any(|other| other != *root && crate::cca::policy::within(root, other))
        })
        .cloned()
        .collect()
}
fn is_directory(path: &str) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_dir())
}

impl ExecutorScopes {
    pub(crate) fn new(
        host: Host,
        services: Arc<dyn ScopeServices>,
        library: Option<Arc<dyn LibraryProvider>>,
        environment_id: String,
        home: String,
        data: PathBuf,
    ) -> Result<Self, ExecutorError> {
        if !nonempty(&environment_id) || !crate::cca::policy::is_absolute(&home) {
            return Err(ExecutorError::new(
                -32602,
                "invalid executor scope configuration",
            ));
        }
        Ok(Self(Arc::new(Inner {
            host,
            services,
            library,
            environment_id,
            home,
            data,
            entries: Mutex::new(HashMap::new()),
            locks: Mutex::new(HashMap::new()),
        })))
    }

    fn watch_entry(&self, entry: &Arc<Entry>) -> Result<(), ExecutorError> {
        let weak = Arc::downgrade(entry);
        let configuration = self.0.host.subscribe_configuration(Arc::new(move || {
            if let Some(entry) = weak.upgrade() {
                entry.retire();
            }
        }));
        entry
            .subscriptions
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(configuration);
        let weak = Arc::downgrade(entry);
        let failed = weak.clone();
        let events = self
            .0
            .host
            .0
            .options
            .backend
            .subscribe(
                Arc::new(move |item| {
                    let Some(entry) = weak.upgrade() else { return };
                    if let crate::event_feed::Payload::Durable(event) = &item.payload {
                        let id = entry
                            .session
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .id
                            .clone();
                        if event.aggregate_id == *id.as_lossless()
                            && matches!(
                                event.type_.as_str(),
                                Some(
                                    "session.moved.1" | "session.archived.2" | "session.deleted.2"
                                )
                            )
                        {
                            entry.retire();
                        }
                    }
                }),
                Arc::new(move || {
                    if let Some(entry) = failed.upgrade() {
                        entry.retire();
                    }
                }),
            )
            .map_err(|_| scope_unavailable())?;
        entry
            .subscriptions
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(events);
        Ok(())
    }

    fn current_configuration(&self) -> Result<Configuration, ExecutorError> {
        match self.0.host.configuration() {
            Ok(configuration @ Configuration::Enabled { .. }) => Ok(configuration),
            _ => Err(scope_unavailable()),
        }
    }

    fn gate_for(
        &self,
        key: &LosslessString,
        configuration: &Configuration,
        root: Option<&session::Id>,
        lifetime: &Arc<Mutex<Lifetime>>,
    ) -> Result<Gate, ExecutorError> {
        let Configuration::Enabled {
            access_revision,
            profile,
            credential_id,
            account_id,
            account_generation,
        } = configuration
        else {
            return Err(scope_unavailable());
        };
        let pins = Pins {
            access_revision: *access_revision,
            profile: profile.clone(),
            credential_id: credential_id.clone(),
            account_id: account_id.clone(),
            account_generation: *account_generation,
            environment_id: self.0.environment_id.clone(),
            connection_id: key.clone(),
            is_current: Arc::new(|| true),
        };
        Ok(Gate {
            configuration: configuration.clone(),
            global: self.0.host.0.options.global.clone(),
            pins,
            lifetimes: vec![lifetime.clone()],
            root: root.cloned(),
            source: None,
            current: None,
        })
    }

    fn pinned(&self, entry: &Entry) -> bool {
        let configured = self
            .0
            .host
            .configuration()
            .is_ok_and(|current| current == entry.configuration);
        configured
            && entry
                .lifetime
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .active
    }

    fn same_session(expected: &session::Info, current: &session::Info) -> bool {
        current.id == expected.id
            && current.time.created == expected.time.created
            && current.location == expected.location
            && current.project_id == expected.project_id
            && current.parent_id.is_none()
            && current.time.archived.is_none()
    }

    fn current_session(&self, entry: &Entry) -> Result<session::Info, ExecutorError> {
        if !self.pinned(entry) {
            entry.retire();
            return Err(scope_unavailable());
        }
        let expected = entry
            .session
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let current = self.0.host.0.options.sessions.get(&expected.id);
        let active = entry
            .lifetime
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .active;
        match current {
            Ok(Some(current)) if active && Self::same_session(&expected, &current) => Ok(current),
            _ => {
                entry.retire();
                Err(scope_unavailable())
            }
        }
    }

    async fn validate(&self, entry: &Arc<Entry>) -> Result<(), ExecutorError> {
        let expected = self.current_session(entry)?;
        let gate = entry.gate.clone();
        let store = self.0.host.0.options.sessions.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            store
                .client
                .submit(move |tx| {
                    gate.with(tx, Some(&expected.id), |tx| {
                        let row = tx
                            .get::<ycoding_store::session::SessionTable>(&crate::session::key(
                                expected.id.as_lossless(),
                            ))?
                            .ok_or_else(unavailable)?;
                        let current = crate::session::info::from_row(&row)?;
                        if !Self::same_session(&expected, &current) {
                            return Err(unavailable());
                        }
                        Ok(())
                    })
                })?
                .wait()
        })
        .await;
        if !matches!(outcome, Ok(Ok(()))) {
            entry.retire();
            return Err(scope_unavailable());
        }
        self.current_session(entry).map(|_| ())
    }

    fn current_check(&self, entry: &Arc<Entry>) -> CurrentCheck {
        let scopes = Arc::downgrade(&self.0);
        let weak = Arc::downgrade(entry);
        Arc::new(move || {
            let (scopes, entry) = (scopes.clone(), weak.clone());
            Box::pin(async move {
                let (Some(scopes), Some(entry)) = (scopes.upgrade(), entry.upgrade()) else {
                    return Err(scope_unavailable());
                };
                ExecutorScopes(scopes).validate(&entry).await
            })
        })
    }

    fn mapping(&self, key: &LosslessString) -> Option<(session::Id, Option<LosslessString>)> {
        let snapshot = self.0.host.0.options.client.snapshot().ok()?;
        let document = resources::get_kv(&snapshot, key).ok()??;
        let value = document.domain().ok()?.into_value();
        let path = JsonPath::default();
        let object = ObjectDecoder::new(&value, &path).ok()?;
        Some((
            object.field::<session::Id>("sessionID").ok()?,
            object.optional::<LosslessString>("projectID").ok()?,
        ))
    }

    fn usable(&self, id: Option<&session::Id>) -> Option<session::Info> {
        let session = self.0.host.0.options.sessions.get(id?).ok()??;
        (session.time.archived.is_none() && session.parent_id.is_none()).then_some(session)
    }

    async fn catalog_projects(&self) -> Result<Vec<CatalogProject>, ExecutorError> {
        Ok(self
            .0
            .services
            .projects()
            .await?
            .into_iter()
            .filter(|project| is_directory(&project.worktree))
            .collect())
    }
    async fn automatic_title(&self, directory: &str) -> Result<LosslessString, ExecutorError> {
        let projects = self.catalog_projects().await?;
        let name = projects
            .iter()
            .find(|project| project.worktree == directory)
            .map(|project| {
                project
                    .name
                    .clone()
                    .unwrap_or_else(|| crate::cca::policy::basename(&project.worktree).into())
            });
        Ok(concat(&[
            &"Dots · ".into(),
            &name.unwrap_or_else(|| crate::cca::policy::basename(directory).into()),
        ]))
    }

    async fn create_session(
        &self,
        key: &LosslessString,
        directory: &str,
        title: LosslessString,
        configuration: &Configuration,
        project_id: Option<LosslessString>,
    ) -> Result<session::Info, ExecutorError> {
        let opened = self.0.services.open_directory(directory).await?;
        let lifetime = Lifetime::new();
        let gate = self.gate_for(key, configuration, None, &lifetime)?;
        let id =
            session::Id::new(crate::platform::identifier("ses_").map_err(|_| scope_unavailable())?)
                .map_err(|_| scope_unavailable())?;
        let (key_text, project_for_mapping) = (key.clone(), project_id);
        let created = id.clone();
        let (directory_text, project) = (opened.directory.clone(), opened.project_id.clone());
        self.0
            .host
            .0
            .options
            .client
            .submit(move |tx| {
                gate.with(tx, None, |tx| {
                    let now = chrono::Utc::now().timestamp_millis();
                    projector::append(
                        tx,
                        &NewEvent {
                            id: projector::random_event_id()?.as_lossless().clone(),
                            aggregate_id: created.as_lossless().clone(),
                            created: now,
                            type_: "session.created.2".into(),
                            data: ObjectEncoder::new()
                                .field("sessionID", &created)
                                .field("projectID", &project)
                                .field(
                                    "location",
                                    &ObjectEncoder::new()
                                        .field("directory", directory_text.as_str())
                                        .finish(),
                                )
                                .field("title", &title)
                                .field("origin", &session::Origin::DotsExecutor)
                                .field("created", &(now as f64))
                                .finish(),
                        },
                    )?;
                    let mut mapping = ObjectEncoder::new().field("sessionID", &created);
                    if let Some(project) = &project_for_mapping {
                        mapping = mapping.field("projectID", project);
                    }
                    let value = ycoding_schema::domain::Json::new(mapping.finish())
                        .map_err(|_| unavailable())?;
                    resources::set_kv(tx, &key_text, &Document::from_domain(&value)?, now)
                })
            })
            .map_err(|_| scope_unavailable())?
            .await
            .map_err(|_| scope_unavailable())?;
        self.0
            .host
            .0
            .options
            .sessions
            .get(&id)
            .map_err(|_| scope_unavailable())?
            .ok_or_else(scope_unavailable)
    }

    async fn make_entry(
        &self,
        key: &LosslessString,
        kind: Kind,
        session: session::Info,
        configuration: &Configuration,
    ) -> Result<Arc<Entry>, ExecutorError> {
        if !matches!(configuration, Configuration::Enabled { .. })
            || self.current_configuration()? != *configuration
        {
            return Err(scope_unavailable());
        }
        let lifetime = Lifetime::new();
        let gate = self.gate_for(key, configuration, Some(&session.id), &lifetime)?;
        let session_cell: Arc<Mutex<Option<std::sync::Weak<Entry>>>> = Arc::new(Mutex::new(None));
        let retitle_cell = session_cell.clone();
        let command: Option<CommandHook> = (kind == Kind::Thread).then(|| {
            let scopes = Arc::downgrade(&self.0);
            Arc::new(move |command: LosslessString| {
                let (scopes, cell) = (scopes.clone(), retitle_cell.clone());
                Box::pin(async move {
                    let entry = cell
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .as_ref()
                        .and_then(std::sync::Weak::upgrade);
                    if let (Some(scopes), Some(entry)) = (scopes.upgrade(), entry)
                        && ExecutorScopes(scopes)
                            .retitle(&entry, &command)
                            .await
                            .is_err()
                    {
                        tracing::warn!("Native executor Session title update failed");
                    }
                }) as BoxFuture<'static, ()>
            }) as CommandHook
        });
        let directory_cell = session_cell.clone();
        let shell_cell = session_cell.clone();
        let data = self.0.data.clone();
        let transcript = SessionTranscript::new(TranscriptOptions {
            session_id: session.id.clone(),
            store: self.0.host.0.options.sessions.clone(),
            directory: Arc::new(move || {
                directory_cell
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .as_ref()
                    .and_then(std::sync::Weak::upgrade)
                    .map(|entry| {
                        lossless_text(
                            entry
                                .session
                                .lock()
                                .unwrap_or_else(|error| error.into_inner())
                                .location
                                .directory
                                .as_lossless(),
                        )
                    })
                    .unwrap_or_default()
            }),
            shell_directory: Arc::new(move || {
                let project = shell_cell
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .as_ref()
                    .and_then(std::sync::Weak::upgrade)
                    .map(|entry| {
                        lossless_text(
                            entry
                                .session
                                .lock()
                                .unwrap_or_else(|error| error.into_inner())
                                .project_id
                                .as_lossless(),
                        )
                    })
                    .unwrap_or_default();
                data.join("shell").join(project)
            }),
            command,
            record_reads: kind == Kind::Thread,
        });
        let entry = Arc::new(Entry {
            key: key.to_owned(),
            kind,
            session: Mutex::new(session.clone()),
            configuration: configuration.clone(),
            lifetime,
            gate,
            authorization: OnceLock::new(),
            transcript,
            library: OnceLock::new(),
            library_signal: Signal::default(),
            library_processes: Mutex::new(vec![]),
            library_failed: AtomicBool::new(false),
            opening: AtomicUsize::new(0),
            opened: tokio::sync::Notify::new(),
            refs: Mutex::new(0),
            subscriptions: Mutex::new(vec![]),
            authorization_closing: OnceLock::new(),
            closing: tokio::sync::OnceCell::new(),
        });
        *session_cell
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(Arc::downgrade(&entry));
        self.watch_entry(&entry)?;
        self.validate(&entry).await?;
        let authorization = self
            .0
            .services
            .authorization(&session, self.current_check(&entry))
            .await
            .map_err(|_| scope_unavailable())?;
        entry.authorization.get_or_init(|| authorization);
        if self.current_session(&entry).is_err() {
            self.close_entry(&entry).await?;
            return Err(scope_unavailable());
        }
        if self.0.library.is_some() {
            entry.library.get_or_init(|| self.fenced_library(&entry));
        }
        Ok(entry)
    }

    async fn retitle(
        &self,
        entry: &Arc<Entry>,
        command: &LosslessString,
    ) -> Result<(), ExecutorError> {
        self.validate(entry).await?;
        let current = self.current_session(entry)?;
        let directory = lossless_text(current.location.directory.as_lossless());
        if current.title != self.automatic_title(&directory).await? {
            return Ok(());
        }
        self.validate(entry).await?;
        let clipped = LosslessString::from_utf16(command.code_units().take(60).collect());
        let title = concat(&[&current.title, &" · ".into(), &clipped]);
        self.0.services.rename_session(&current.id, &title).await
    }

    fn fenced_library(&self, entry: &Arc<Entry>) -> Arc<dyn LibraryFactory> {
        Arc::new(FencedFactory {
            scopes: Arc::downgrade(&self.0),
            entry: Arc::downgrade(entry),
        })
    }

    fn roots_of(&self, entry: &Entry) -> Vec<String> {
        match entry.kind {
            Kind::Unattributed => vec![self.0.home.clone()],
            Kind::Thread => collapse(vec![
                lossless_text(
                    entry
                        .session
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .location
                        .directory
                        .as_lossless(),
                ),
                self.0.home.clone(),
            ]),
        }
    }

    fn lock_for(&self, key: &LosslessString) -> Arc<tokio::sync::Semaphore> {
        self.0
            .locks
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .entry(key.to_owned())
            .or_insert_with(|| Arc::new(tokio::sync::Semaphore::new(1)))
            .clone()
    }

    async fn scope(
        &self,
        key: LosslessString,
        kind: Kind,
        cwd: Option<String>,
    ) -> Result<Arc<dyn ExecutorScope>, ExecutorError> {
        let lock = self.lock_for(&key);
        let _held = lock.acquire().await.map_err(|_| scope_unavailable())?;
        let configuration = self.current_configuration()?;
        let cached = self
            .0
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&key)
            .cloned();
        if let Some(cached) = cached {
            if self.validate(&cached).await.is_ok() {
                let acquired = {
                    let mut refs = cached
                        .refs
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    if *refs == 0 {
                        false
                    } else {
                        *refs += 1;
                        true
                    }
                };
                if acquired {
                    return Ok(Arc::new(Handle {
                        scopes: self.clone(),
                        entry: cached,
                        released_ref: AtomicBool::new(false),
                        released: tokio::sync::OnceCell::new(),
                    }));
                }
            }
            {
                let mut entries = self
                    .0
                    .entries
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                if entries
                    .get(&key)
                    .is_some_and(|current| Arc::ptr_eq(current, &cached))
                {
                    entries.remove(&key);
                }
            }
            let unreferenced = *cached
                .refs
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                == 0;
            if unreferenced {
                self.close_entry(&cached).await?;
            }
        }
        let stored = self.mapping(&key);
        let existing = self.usable(stored.as_ref().map(|(id, _)| id));
        let session = match existing {
            Some(session) => session,
            None => match kind {
                Kind::Unattributed => {
                    self.create_session(
                        &key,
                        &self.0.home.clone(),
                        "Dots · unattributed".into(),
                        &configuration,
                        None,
                    )
                    .await?
                }
                Kind::Thread => {
                    let projects = self.catalog_projects().await?;
                    let project = stored
                        .as_ref()
                        .and_then(|(_, project_id)| project_id.as_ref())
                        .and_then(|project_id| {
                            projects
                                .iter()
                                .find(|candidate| &candidate.id == project_id)
                        });
                    let directory = match project {
                        Some(project) => project.worktree.clone(),
                        None => self.first_directory(cwd.as_deref()),
                    };
                    let title = self.automatic_title(&directory).await?;
                    self.create_session(
                        &key,
                        &directory,
                        title,
                        &configuration,
                        project.map(|project| project.id.clone()),
                    )
                    .await?
                }
            },
        };
        let entry = self.make_entry(&key, kind, session, &configuration).await?;
        *entry.refs.lock().unwrap_or_else(|error| error.into_inner()) = 1;
        self.0
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(key, entry.clone());
        Ok(Arc::new(Handle {
            scopes: self.clone(),
            entry,
            released_ref: AtomicBool::new(false),
            released: tokio::sync::OnceCell::new(),
        }))
    }

    fn first_directory(&self, cwd: Option<&str>) -> String {
        let Some(cwd) = cwd else {
            return self.0.home.clone();
        };
        let resolved = crate::cca::policy::normalize(cwd);
        let root = self.0.services.project_root(&resolved);
        [root, Some(resolved)]
            .into_iter()
            .flatten()
            .find(|candidate| is_directory(candidate))
            .unwrap_or_else(|| self.0.home.clone())
    }

    async fn close_entry(&self, entry: &Arc<Entry>) -> Result<(), ExecutorError> {
        entry.retire();
        let subscriptions = std::mem::take(
            &mut *entry
                .subscriptions
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        drop(subscriptions);
        {
            let mut entries = self
                .0
                .entries
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if entries
                .get(&entry.key)
                .is_some_and(|current| Arc::ptr_eq(current, entry))
            {
                entries.remove(&entry.key);
            }
        }
        entry
            .closing
            .get_or_init(|| async {
                loop {
                    let opened = entry.opened.notified();
                    if entry.opening.load(Ordering::Acquire) == 0 {
                        break;
                    }
                    opened.await;
                }
                let processes = entry
                    .library_processes
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .clone();
                for process in processes {
                    if process.close().await.is_err() {
                        entry.library_failed.store(true, Ordering::Release);
                    }
                }
                entry.transcript.flush().await;
                let closed = match entry.authorization.get() {
                    Some(authorization) => {
                        let closing = entry
                            .authorization_closing
                            .get_or_init(|| Mutex::new(authorization.close()));
                        std::future::poll_fn(|context| {
                            let mut future =
                                closing.lock().unwrap_or_else(|error| error.into_inner());
                            std::future::Future::poll(future.as_mut(), context)
                        })
                        .await
                    }
                    None => Ok(()),
                };
                if entry.library_failed.load(Ordering::Acquire) || closed.is_err() {
                    Err(scope_unavailable())
                } else {
                    Ok(())
                }
            })
            .await
            .clone()
    }
    async fn release(&self, entry: &Arc<Entry>) -> Result<(), ExecutorError> {
        let last = {
            let mut refs = entry.refs.lock().unwrap_or_else(|error| error.into_inner());
            *refs = refs.saturating_sub(1);
            if *refs == 0 {
                entry.retire();
            }
            *refs == 0
        };
        if last {
            self.close_entry(entry).await
        } else {
            Ok(())
        }
    }
}

struct Handle {
    scopes: ExecutorScopes,
    entry: Arc<Entry>,
    released_ref: AtomicBool,
    released: tokio::sync::OnceCell<Result<(), ExecutorError>>,
}
impl ExecutorScope for Handle {
    fn ensure_current(&self) -> BoxFuture<'_, Result<(), ExecutorError>> {
        Box::pin(self.scopes.validate(&self.entry))
    }

    fn session_id(&self) -> String {
        lossless_text(
            self.entry
                .session
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .id
                .as_lossless(),
        )
    }
    fn roots(&self) -> Vec<String> {
        self.scopes.roots_of(&self.entry)
    }
    fn authorization(&self) -> Arc<dyn Authorize> {
        self.entry
            .authorization
            .get()
            .expect("published Entry authorization")
            .clone()
    }
    fn transcript(&self) -> Option<Arc<dyn Recorder>> {
        let recorder: Arc<dyn Recorder> = Arc::new(self.entry.transcript.clone());
        Some(recorder)
    }
    fn library(&self) -> Option<Arc<dyn LibraryFactory>> {
        self.entry.library.get().cloned()
    }
    fn library_signal(&self) -> Option<Signal> {
        self.entry
            .library
            .get()
            .map(|_| self.entry.library_signal.clone())
    }
    fn close(&self) -> BoxFuture<'_, Result<(), ExecutorError>> {
        Box::pin(async move {
            self.released
                .get_or_init(|| async {
                    if !self.released_ref.swap(true, Ordering::AcqRel) {
                        self.scopes.release(&self.entry).await
                    } else {
                        self.scopes.close_entry(&self.entry).await
                    }
                })
                .await
                .clone()
        })
    }
}

impl ScopeProvider for ExecutorScopes {
    fn scope_for(
        &self,
        attribution: Option<Attribution>,
        context: ScopeContext,
    ) -> BoxFuture<'_, Result<Arc<dyn ExecutorScope>, ExecutorError>> {
        Box::pin(async move {
            let environment = self.0.environment_id.clone();
            match attribution.and_then(|attribution| attribution.thread_id) {
                None => {
                    self.scope(
                        format!("dots.cca.unattributed.{environment}").into(),
                        Kind::Unattributed,
                        None,
                    )
                    .await
                }
                Some(thread) => {
                    if !nonempty(&environment)
                        || !nonempty_attribution(&thread)
                        || context
                            .cwd
                            .as_deref()
                            .is_some_and(|cwd| !crate::cca::policy::is_absolute(cwd))
                    {
                        return Err(scope_unavailable());
                    }
                    self.scope(
                        concat(&[&format!("dots.cca.thread.{environment}.").into(), &thread]),
                        Kind::Thread,
                        context.cwd,
                    )
                    .await
                }
            }
        })
    }
}

struct FencedFactory {
    scopes: std::sync::Weak<Inner>,
    entry: std::sync::Weak<Entry>,
}
impl LibraryFactory for FencedFactory {
    fn open(
        &self,
        input: LibraryOpenInput,
    ) -> BoxFuture<'_, Result<Arc<dyn LibraryProcess>, ExecutorError>> {
        Box::pin(async move {
            let entry = self.entry.upgrade().ok_or_else(scope_unavailable)?;
            let scopes = ExecutorScopes(self.scopes.upgrade().ok_or_else(scope_unavailable)?);
            let Some(provider) = scopes.0.library.clone() else {
                return Err(scope_unavailable());
            };
            let Configuration::Enabled {
                access_revision,
                profile,
                credential_id,
                account_id,
                account_generation,
            } = &entry.configuration
            else {
                return Err(scope_unavailable());
            };
            let check = scopes.current_check(&entry);
            if entry.library_signal.is_cancelled() {
                return Err(scope_unavailable());
            }
            let _opening = {
                let lifetime = entry
                    .lifetime
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                if !lifetime.active {
                    return Err(scope_unavailable());
                }
                entry.opening.fetch_add(1, Ordering::AcqRel);
                Opening(&entry)
            };
            check().await?;
            let session = scopes.current_session(&entry)?;
            let factory = provider
                .factory(
                    LibraryScope {
                        session_id: session.id.clone(),
                        principal: LibraryPrincipal {
                            profile: profile.clone(),
                            credential_id: credential_id.clone(),
                            account_id: account_id.clone(),
                            account_generation: *account_generation,
                            access_revision: *access_revision,
                        },
                        roots: scopes.roots_of(&entry),
                        current: check.clone(),
                        authorize: entry
                            .authorization
                            .get()
                            .ok_or_else(scope_unavailable)?
                            .clone(),
                    },
                    &session,
                )
                .await?;
            check().await?;
            let backend = factory.open(input).await?;
            let process = Arc::new(FencedProcess {
                backend,
                check: check.clone(),
                closed: AtomicBool::new(false),
                close_future: OnceLock::new(),
                closing: tokio::sync::OnceCell::new(),
                entry: Arc::downgrade(&entry),
            });
            entry
                .library_processes
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(process.clone());
            if let Err(error) = check().await {
                process.close().await?;
                return Err(error);
            }
            Ok(process as Arc<dyn LibraryProcess>)
        })
    }
}

struct FencedProcess {
    backend: Arc<dyn LibraryProcess>,
    check: CurrentCheck,
    closed: AtomicBool,
    close_future: OnceLock<Mutex<BoxFuture<'static, Result<(), ExecutorError>>>>,
    closing: tokio::sync::OnceCell<Result<(), ExecutorError>>,
    entry: std::sync::Weak<Entry>,
}
impl FencedProcess {
    async fn fence(&self) -> Result<(), ExecutorError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(scope_unavailable());
        }
        (self.check)().await?;
        if self.closed.load(Ordering::Acquire) {
            return Err(scope_unavailable());
        }
        self.backend.check().await?;
        (self.check)().await?;
        if self.closed.load(Ordering::Acquire) {
            Err(scope_unavailable())
        } else {
            Ok(())
        }
    }
}
impl LibraryProcess for FencedProcess {
    fn check(&self) -> BoxFuture<'_, Result<(), ExecutorError>> {
        Box::pin(self.fence())
    }
    fn tools(&self) -> Vec<LibraryTool> {
        self.backend.tools()
    }
    fn call(&self, name: &str, arguments: Value) -> BoxFuture<'_, Result<Value, LibraryCallError>> {
        let name = name.to_owned();
        Box::pin(async move {
            self.fence().await.map_err(|_| LibraryCallError::Failed)?;
            let result = self.backend.call(&name, arguments).await?;
            self.fence().await.map_err(|_| LibraryCallError::Failed)?;
            Ok(result)
        })
    }
    fn close(&self) -> BoxFuture<'_, Result<(), ExecutorError>> {
        Box::pin(async move {
            self.closed.store(true, Ordering::Release);
            self.closing
                .get_or_init(|| async {
                    let closing = self.close_future.get_or_init(|| {
                        let backend = self.backend.clone();
                        Mutex::new(Box::pin(async move { backend.close().await }))
                    });
                    let outcome = std::future::poll_fn(|context| {
                        let mut future = closing.lock().unwrap_or_else(|error| error.into_inner());
                        std::future::Future::poll(future.as_mut(), context)
                    })
                    .await;
                    if let Some(entry) = self.entry.upgrade() {
                        if outcome.is_err() {
                            entry.library_failed.store(true, Ordering::Release);
                        }
                        entry
                            .library_processes
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .retain(|process| !std::ptr::eq(process.as_ref(), self));
                    }
                    if outcome.is_err() {
                        return Err(scope_unavailable());
                    }
                    Ok(())
                })
                .await
                .clone()
        })
    }
}

#[cfg(test)]
mod tests {
    include!("executor_scope_tests.rs");
}
