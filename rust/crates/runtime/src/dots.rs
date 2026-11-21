pub(crate) mod carrier;
mod conversation_socket;
mod native_library;

use crate::{
    convert,
    dispatch::{Failure, Invocation},
};
use prost::{Message, Name};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};
use ycoding_core::{
    cca::{
        error::ExecutorError,
        executor::{self as core_executor, PrepareExecutorInput, PreparedExecutor},
    },
    dots::{Admission, DecisionServices, Decisions, access, conversation, enrollment, native},
    event_feed::{self, Feed},
    resources::{auth, config, credential},
    session::{execution, orchestration, pending, review, store},
    ycoding_schema::{
        self, DomainDecode, DomainEncode, JsonValue, LosslessString, connection, model, session,
    },
    ycoding_store::Client,
};
use ycoding_protocol::{domain_json, v5};

pub struct Services {
    pub access: access::Access,
    pub host: native::Host,
    conversation: conversation::Service,
    registry: auth::integration::Registry,
    _registration: auth::integration::Registration,
    backend: Arc<Backend>,
    executor: Arc<NativeExecutor>,
    attachment: access::Attachment,
    shutdown: crate::production::Shutdown,
}
pub(crate) struct Catalog {
    pub skills: Vec<native::Skill>,
    pub selected: Option<model::Ref>,
}
#[derive(Clone, Copy)]
pub(crate) enum CatalogKind {
    Skills,
    Selected,
}
pub(crate) type CatalogReader =
    Arc<dyn Fn(session::Info, CatalogKind) -> native::NativeFuture<'static, Catalog> + Send + Sync>;
pub(crate) struct Settings {
    pub owner: crate::production::owner::Handle,
    pub client: Client,
    pub global: Arc<config::Configuration>,
    pub credentials: credential::Service,
    pub sessions: store::Service,
    pub execution: &'static execution::Execution,
    pub locations: crate::Locations,
    pub git: Arc<ycoding_core::platform::git::Service>,
    pub orchestration: orchestration::Service,
    pub reviews: review::Service,
    pub events: Feed,
    pub catalogs: CatalogReader,
    pub auth: auth::integration::Draft,
    pub preparation: auth::Preparation,
    pub env: BTreeMap<String, String>,
    pub state: std::path::PathBuf,
    pub home: std::path::PathBuf,
    pub data: std::path::PathBuf,
    pub codex_home: String,
}

struct NativePreparation {
    home: PathBuf,
    data: PathBuf,
    ca_directory: PathBuf,
    environment: Arc<BTreeMap<String, String>>,
}

impl NativePreparation {
    fn capture(
        home: PathBuf,
        data: PathBuf,
        state: PathBuf,
        environment: &BTreeMap<String, String>,
    ) -> Self {
        Self {
            home,
            data,
            ca_directory: state.join("cca-proxy"),
            environment: Arc::new(environment.clone()),
        }
    }

    fn input(&self) -> PrepareExecutorInput<'_> {
        PrepareExecutorInput {
            home_directory: &self.home,
            data_directory: &self.data,
            network_proxy_ca_directory: &self.ca_directory,
            startup_environment: &self.environment,
        }
    }
}

fn executor_configured(global: &config::Configuration) -> Result<bool, Failure> {
    global
        .native_dots_profile()
        .map(|profile| profile.is_some())
        .map_err(|_| unavailable())
}

enum NativeExecutor {
    Disabled,
    Held(&'static str),
    Running(Arc<carrier::supervisor::Supervisor>),
}

impl NativeExecutor {
    fn held_reason(&self) -> Option<&'static str> {
        match self {
            Self::Held(reason) => Some(reason),
            _ => None,
        }
    }

    fn connection_status(&self) -> access::TransportStatus {
        match self {
            Self::Running(supervisor) => supervisor.connection_status(),
            Self::Disabled | Self::Held(_) => access::TransportStatus {
                state: if matches!(self, Self::Held(_)) {
                    "error"
                } else {
                    "off"
                }
                .into(),
                hostname: None,
                name: None,
                problem: None,
            },
        }
    }

    async fn shutdown(&self) -> Result<(), Failure> {
        match self {
            Self::Running(supervisor) => supervisor.shutdown().await.map_err(|error| {
                Failure::Unavailable(format!("Native executor cleanup failed: {error:?}"))
            }),
            Self::Disabled | Self::Held(_) => Ok(()),
        }
    }
}

struct NativeTransport {
    control: ycoding_core::dots::computer::Control,
    executor: Arc<NativeExecutor>,
}

impl NativeTransport {
    fn new(host: native::Host, state_path: PathBuf, executor: Arc<NativeExecutor>) -> Self {
        Self {
            control: ycoding_core::dots::computer::Control::new(
                ycoding_core::dots::computer::Settings::production(
                    host,
                    state_path.with_file_name(carrier::EXECUTOR_STATE_FILE),
                ),
            ),
            executor,
        }
    }
}

impl access::Transport for NativeTransport {
    fn status(&self) -> access::StatusFuture<'_> {
        Box::pin(async move { Ok(self.executor.connection_status()) })
    }

    fn computer(&self) -> access::ComputerFuture<'_> {
        Box::pin(async move { Ok(self.control.computer().await) })
    }

    fn attach_computer(&self, input: access::ComputerAttach) -> access::ComputerFuture<'_> {
        Box::pin(async move { Ok(self.control.attach(input).await) })
    }

    fn detach_computer(&self, input: access::ComputerDetach) -> access::ComputerFuture<'_> {
        Box::pin(async move { Ok(self.control.detach(input).await) })
    }

    fn remove_computer(&self, input: access::ComputerRemove) -> access::ComputerFuture<'_> {
        Box::pin(async move { Ok(self.control.remove(input).await) })
    }
}

async fn start_native_executor(
    settings: &Settings,
    host: native::Host,
    preparation: NativePreparation,
) -> Result<NativeExecutor, ExecutorError> {
    use carrier::{
        executor_rpc as rpc,
        supervisor::{self, PrepareError},
    };
    let published = Arc::new(OnceLock::<Arc<PreparedExecutor>>::new());
    let writer = published.clone();
    let (home, data, ca_directory) = (
        preparation.home.clone(),
        preparation.data.clone(),
        preparation.ca_directory.clone(),
    );
    let prepare: supervisor::Prepare = Box::new(move || {
        Box::pin(async move {
            let prepared = core_executor::prepare_executor(preparation.input()).map_err(
                |error| match error {
                    core_executor::PrepareExecutorError::Held { prerequisite, .. } => {
                        PrepareError::Held {
                            reason: prerequisite,
                        }
                    }
                    core_executor::PrepareExecutorError::Failed(error) => {
                        PrepareError::Failed(error)
                    }
                },
            )?;
            let advertised = rpc::core_adapter::environment_info(prepared.environment_info());
            rpc::readiness::check(&advertised, &rpc::core_adapter::backend_features())?;
            writer.set(Arc::new(prepared)).map_err(|_| {
                PrepareError::Failed(ExecutorError::new(
                    -32603,
                    "Native executor preparation was already published",
                ))
            })?;
            Ok(())
        })
    });
    let (locations, sessions, git) = (
        settings.locations.clone(),
        settings.sessions.clone(),
        settings.git.clone(),
    );
    let (owner, codex_home) = (settings.owner.clone(), settings.codex_home.clone());
    let serve_host = host.clone();
    let serve: supervisor::Serve = Arc::new(move |opened| {
        let (prepared, host) = (published.get().cloned(), serve_host.clone());
        let (locations, sessions, git) = (locations.clone(), sessions.clone(), git.clone());
        let (owner, codex_home) = (owner.clone(), codex_home.clone());
        let (home, data, ca_directory) = (home.clone(), data.clone(), ca_directory.clone());
        Box::pin(async move {
            let Some(prepared) = prepared else {
                opened
                    .diagnostics
                    .report(supervisor::Diagnostic::ScopeUnavailable);
                return Err(supervisor::ServeFailed);
            };
            let library = native_library::provider(native_library::Options {
                locations: locations.downgrade(),
                sessions: sessions.clone(),
                owner,
            });
            let serving = rpc::composition::Composition {
                host,
                locations,
                sessions,
                git,
                environment_id: opened.environment_id.clone(),
                home,
                data,
                prepared,
                network_proxy_ca_directory: Some(ca_directory),
                answer_process: None,
                library: Some(library),
                review_directories: None,
                authorization_timeout: None,
                codex_home_env: Some(codex_home),
                system_config_path: None,
            }
            .into_serving()
            .map_err(|_| {
                opened
                    .diagnostics
                    .report(supervisor::Diagnostic::ScopeUnavailable);
                supervisor::ServeFailed
            })?;
            (serving.serve)(opened).await
        })
    });
    let global = settings.global.clone();
    let name = Arc::new(move || match global.native_dots_name() {
        Ok(name) => name,
        Err(_) => {
            tracing::warn!("CCA executor name configuration unavailable");
            None
        }
    });
    let state_path = settings.state.join("remote-control.json");
    let installation_store = Arc::new(carrier::state::Store::new(state_path.clone()));
    let installation = Box::new(move || {
        let store = installation_store.clone();
        let future: supervisor::Boxed<Option<String>> = Box::pin(async move {
            match store.load().await {
                Ok(state) => Some(state.installation_id),
                Err(_) => {
                    tracing::warn!("CCA executor installation state unavailable");
                    None
                }
            }
        });
        future
    });
    match carrier::start_executor(carrier::ExecutorSettings {
        host,
        name,
        state_path,
        home: settings.home.clone(),
        data: settings.data.clone(),
        hostname: enrollment::machine_name().unwrap_or_else(|| "ycoding".into()),
        post: Arc::new(enrollment::post_executor),
        installation,
        prepare,
        serve,
    })
    .await
    {
        Ok(supervisor) => Ok(NativeExecutor::Running(supervisor)),
        Err(PrepareError::Held { reason }) => Ok(NativeExecutor::Held(reason)),
        Err(PrepareError::Failed(error)) => Err(error),
    }
}

impl Services {
    pub(crate) async fn start(mut settings: Settings) -> Result<Self, Failure> {
        let preparation = executor_configured(&settings.global)?.then(|| {
            NativePreparation::capture(
                settings.home.clone(),
                settings.data.clone(),
                settings.state.clone(),
                &settings.env,
            )
        });
        let registry = auth::integration::Registry::prepared(
            settings.credentials.clone(),
            std::mem::take(&mut settings.env),
            settings.preparation.clone(),
            None,
        );
        let auth = settings.auth.clone();
        let registration = match registry.transform(move |draft| draft.extend(&auth)) {
            Ok(registration) => registration,
            Err(_) => {
                let released = registry.shutdown().await.map_err(|_| unavailable());
                return Err(startup_failure(released));
            }
        };
        if registry.bind_events(settings.events.clone(), None).is_err() {
            let released = registry.shutdown().await.map_err(|_| unavailable());
            return Err(startup_failure(released));
        }
        let global = settings.global.clone();
        let credentials = settings.credentials.clone();
        let access = access::Access::new(
            settings.client.clone(),
            Arc::new(move || native::configuration_status(&global, &credentials)),
        );
        let access_changes = access.subscribe();
        let backend = Arc::new(Backend {
            execution: settings.execution,
            sessions: settings.sessions.clone(),
            locations: settings.locations.clone(),
            reviews: settings.reviews.clone(),
            orchestration: settings.orchestration.clone(),
            events: settings.events.clone(),
            catalogs: settings.catalogs.clone(),
            tasks: Mutex::new(Some(Vec::new())),
            shutdown: crate::production::Shutdown::default(),
        });
        let prepare = registry.clone();
        let credentials = settings.credentials.clone();
        let host = native::Host::new(native::Options {
            access: access.clone(),
            global: settings.global.clone(),
            credentials: settings.credentials.clone(),
            sessions: settings.sessions.clone(),
            client: settings.client.clone(),
            backend: backend.clone(),
            credential: Arc::new(move |profile, rejected| {
                let prepare = prepare.clone();
                let credentials = credentials.clone();
                Box::pin(async move {
                    let binding = credentials
                        .bind("openai".into(), "openai".into(), profile.as_str().into())
                        .map_err(|_| access::Error::Unavailable)?;
                    let selected = credentials
                        .resolve_binding(&binding)
                        .map_err(|_| access::Error::Unavailable)?;
                    let rejected = rejected.map(LosslessString::from);
                    let kind = match selected
                        .secret()
                        .domain()
                        .map_err(|_| access::Error::Unavailable)?
                    {
                        ycoding_schema::credential::Value::OAuth(_) => {
                            connection::CredentialKind::Oauth
                        }
                        ycoding_schema::credential::Value::Key(_) => {
                            connection::CredentialKind::Key
                        }
                    };
                    let snapshot = prepare
                        .snapshot_with_rejected(
                            connection::Info::Credential(connection::CredentialInfo {
                                id: ycoding_schema::credential::Id(selected.id().clone()),
                                label: selected.label().clone(),
                                active: selected.active(),
                                kind: Some(kind),
                                status: None,
                                message: None,
                            }),
                            crate::ids::now_millis(),
                            rejected.as_ref(),
                        )
                        .await
                        .map_err(|_| access::Error::Unavailable)?;
                    let Some(selected) = snapshot.credential else {
                        return Ok(None);
                    };
                    let Some(secret) = snapshot.value else {
                        return Ok(None);
                    };
                    let ycoding_schema::credential::Value::OAuth(value) =
                        secret.domain().map_err(|_| access::Error::Unavailable)?
                    else {
                        return Ok(None);
                    };
                    let account = value
                        .metadata
                        .as_ref()
                        .and_then(|metadata| metadata.get(&"accountID".into()))
                        .and_then(|value| {
                            if let JsonValue::String(value) = value {
                                value.as_str()
                            } else {
                                None
                            }
                        })
                        .filter(|account| !account.trim().is_empty())
                        .ok_or(access::Error::Unavailable)?;
                    Ok(Some(native::ResolvedCredential {
                        profile,
                        credential_id: selected
                            .id()
                            .to_utf8()
                            .map_err(|_| access::Error::Unavailable)?,
                        account_id: account.into(),
                        account_generation: selected.account_generation(),
                        access_token: value
                            .access
                            .to_utf8()
                            .map_err(|_| access::Error::Unavailable)?,
                    }))
                })
            }),
        });
        match host {
            Ok(host) => {
                backend.watch_access(access_changes, host.configuration_observer());
                let executor = match preparation {
                    Some(preparation) => {
                        start_native_executor(&settings, host.clone(), preparation).await
                    }
                    None => Ok(NativeExecutor::Disabled),
                };
                let started = match executor {
                    Ok(executor) => {
                        if let Some(reason) = executor.held_reason() {
                            tracing::warn!("CCA executor preparation-held {reason}");
                        }
                        let executor = Arc::new(executor);
                        let transport = Arc::new(NativeTransport::new(
                            host.clone(),
                            settings.state.join("remote-control.json"),
                            executor.clone(),
                        ));
                        match host.attach_transport(transport) {
                            Ok(attachment) => match conversation::Service::start(
                                host.clone(),
                                &attachment,
                                conversation_socket::connect(),
                            ) {
                                Ok(conversation) => Ok((executor, attachment, conversation)),
                                Err(error) => {
                                    attachment.release();
                                    Err(crate::production::bootstrap_failure(
                                        conversation_failure(error),
                                        executor.shutdown().await,
                                    ))
                                }
                            },
                            Err(error) => Err(crate::production::bootstrap_failure(
                                Failure::Unavailable(format!(
                                    "Native Dots transport binding failed: {error:?}"
                                )),
                                executor.shutdown().await,
                            )),
                        }
                    }
                    Err(error) => Err(Failure::Unavailable(format!(
                        "Native executor startup failed: {error:?}"
                    ))),
                };
                match started {
                    Ok((executor, attachment, conversation)) => Ok(Self {
                        access,
                        host,
                        conversation,
                        registry,
                        _registration: registration,
                        backend,
                        executor,
                        attachment,
                        shutdown: crate::production::Shutdown::default(),
                    }),
                    Err(primary) => {
                        host.close();
                        let registry = registry.shutdown().await;
                        let events = backend.shutdown().await;
                        if registry.is_err() || events.is_err() {
                            tracing::error!("Native Dots startup cleanup failed");
                        }
                        Err(crate::production::bootstrap_failure(
                            primary,
                            crate::production::cleanup_results([
                                registry.map_err(|_| unavailable()),
                                events,
                            ]),
                        ))
                    }
                }
            }
            Err(_) => {
                let registry = registry.shutdown().await;
                let events = backend.shutdown().await;
                if registry.is_err() || events.is_err() {
                    tracing::error!("Native Dots startup cleanup failed");
                }
                Err(startup_failure(crate::production::cleanup_results([
                    registry.map_err(|_| unavailable()),
                    events,
                ])))
            }
        }
    }
    pub(crate) async fn shutdown(&self) -> Result<(), Failure> {
        self.shutdown
            .run(|| {
                self.attachment.release();
                let (executor, host, registry, backend, conversation) = (
                    self.executor.clone(),
                    self.host.clone(),
                    self.registry.clone(),
                    self.backend.clone(),
                    self.conversation.clone(),
                );
                async move {
                    let conversation = conversation.close().await.map_err(conversation_failure);
                    let executor = executor.shutdown().await;
                    host.close();
                    let registry = registry.shutdown().await.map_err(|_| unavailable());
                    let events = backend.shutdown().await;
                    crate::production::cleanup_results([conversation, executor, registry, events])
                }
            })
            .await
    }
}
fn unavailable() -> Failure {
    Failure::Unavailable("Native Dots services are unavailable".into())
}
fn startup_failure(released: Result<(), Failure>) -> Failure {
    crate::production::bootstrap_failure(unavailable(), released)
}
type AccessTask = (
    tokio::sync::watch::Sender<bool>,
    tokio::task::JoinHandle<()>,
);

struct Backend {
    execution: &'static execution::Execution,
    sessions: store::Service,
    locations: crate::Locations,
    orchestration: orchestration::Service,
    reviews: review::Service,
    events: Feed,
    catalogs: CatalogReader,
    tasks: Mutex<Option<Vec<AccessTask>>>,
    shutdown: crate::production::Shutdown,
}
impl Backend {
    fn watch_access(
        &self,
        mut changes: tokio::sync::watch::Receiver<u64>,
        observe: native::Retirement,
    ) {
        let (stop, mut stopped) = tokio::sync::watch::channel(false);
        let mut tasks = self.tasks.lock().unwrap_or_else(|error| error.into_inner());
        let Some(tasks) = tasks.as_mut() else {
            return;
        };
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    _ = stopped.changed() => break,
                    changed = changes.changed() => {
                        if changed.is_err() {
                            break;
                        }
                        observe();
                    }
                }
            }
        });
        tasks.push((stop, task));
    }
    async fn shutdown(&self) -> Result<(), Failure> {
        self.shutdown
            .run(|| {
                let tasks = self
                    .tasks
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take()
                    .unwrap_or_default();
                for (stop, _) in &tasks {
                    stop.send_replace(true);
                }
                async move {
                    let mut results = Vec::new();
                    for (_, task) in tasks {
                        results.push(task.await.map_err(|_| unavailable()));
                    }
                    crate::production::cleanup_results(results)
                }
            })
            .await
    }
}
impl native::Backend for Backend {
    fn decisions(&self, session: session::Info) -> native::NativeFuture<'_, Arc<Decisions>> {
        Box::pin(async move {
            let (_, held) = self
                .locations
                .session(&session.id)
                .map_err(|_| access::Error::Unavailable)?;
            if !self.locations.is_current(&held) {
                return Err(access::Error::Unavailable);
            }
            let current = held.clone();
            let locations = self.locations.downgrade();
            Ok(Arc::new(Decisions::new(DecisionServices {
                forms: held.forms.clone(),
                permissions: held.permissions.clone(),
                questions: held.questions.clone(),
                guardrails: held.guardrails.clone(),
                reviews: self.reviews.clone(),
                orchestration: self.orchestration.clone(),
                lease: held,
                is_current: Arc::new(move || {
                    locations
                        .upgrade()
                        .is_some_and(|locations| locations.is_current(&current))
                }),
            })))
        })
    }
    fn selected_model(
        &self,
        session: session::Info,
    ) -> native::NativeFuture<'_, Option<model::Ref>> {
        Box::pin(async move {
            Ok((self.catalogs)(session, CatalogKind::Selected)
                .await?
                .selected)
        })
    }
    fn models(
        &self,
        location: ycoding_schema::location::Ref,
    ) -> native::NativeFuture<'_, Vec<native::Model>> {
        Box::pin(async move {
            let held = self
                .locations
                .location(
                    location.directory.as_lossless(),
                    location.workspace_id.as_ref().map(|id| id.as_lossless()),
                )
                .map_err(|_| access::Error::Unavailable)?;
            let composed = held.production.as_ref().ok_or(access::Error::Unavailable)?;
            let saved = composed
                .credentials
                .all()
                .map_err(|_| access::Error::Unavailable)?;
            let catalog = composed.models.catalog();
            let default = catalog.default_selection(&saved);
            let mut models = Vec::new();
            for model in catalog.available(&saved) {
                let id = model.id.to_utf8().map_err(|_| access::Error::Unavailable)?;
                let provider_id = model
                    .provider_id
                    .0
                    .to_utf8()
                    .map_err(|_| access::Error::Unavailable)?;
                let name = Some(
                    model
                        .name
                        .to_utf8()
                        .map_err(|_| access::Error::Unavailable)?,
                );
                let variants = Some(
                    model
                        .variants
                        .iter()
                        .map(|variant| variant.id.to_utf8().map_err(|_| access::Error::Unavailable))
                        .collect::<Result<Vec<_>, _>>()?,
                );
                if model
                    .profiles
                    .as_ref()
                    .is_none_or(|profiles| profiles.is_empty())
                {
                    models.push(native::Model {
                        id: id.clone(),
                        provider_id: provider_id.clone(),
                        name: name.clone(),
                        profile: None,
                        active: None,
                        variants: variants.clone(),
                        is_default: default
                            .as_ref()
                            .is_some_and(|value| {
                                value.provider_id == model.provider_id
                                    && value.id == model.id
                                    && value.profile.is_none()
                            })
                            .then_some(true),
                    });
                }
                for profile in model.profiles.as_deref().unwrap_or(&[]) {
                    models.push(native::Model {
                        id: id.clone(),
                        provider_id: provider_id.clone(),
                        name: name.clone(),
                        profile: Some(
                            profile
                                .name
                                .0
                                .to_utf8()
                                .map_err(|_| access::Error::Unavailable)?,
                        ),
                        active: Some(profile.active),
                        variants: profile
                            .variants
                            .as_ref()
                            .map(|values| {
                                values
                                    .iter()
                                    .map(|value| {
                                        value.to_utf8().map_err(|_| access::Error::Unavailable)
                                    })
                                    .collect::<Result<Vec<_>, _>>()
                            })
                            .transpose()?
                            .or_else(|| variants.clone()),
                        is_default: default
                            .as_ref()
                            .is_some_and(|value| {
                                value.provider_id == model.provider_id
                                    && value.id == model.id
                                    && value.profile.as_ref().map_or(profile.active, |selected| {
                                        selected == &profile.name
                                    })
                            })
                            .then_some(true),
                    });
                }
            }
            if !self.locations.is_current(&held) {
                return Err(access::Error::Unavailable);
            }
            Ok(models)
        })
    }
    fn validate_model(
        &self,
        location: ycoding_schema::location::Ref,
        target: model::Ref,
    ) -> native::NativeFuture<'_, model::Ref> {
        Box::pin(async move {
            let held = self
                .locations
                .location(
                    location.directory.as_lossless(),
                    location.workspace_id.as_ref().map(|id| id.as_lossless()),
                )
                .map_err(|_| access::Error::Unavailable)?;
            let composed = held.production.as_ref().ok_or(access::Error::Unavailable)?;
            let saved = composed
                .credentials
                .all()
                .map_err(|_| access::Error::Unavailable)?;
            let catalog = composed.models.catalog();
            if let Some(profile) = &target.profile {
                let provider = catalog
                    .provider(&target.provider_id)
                    .ok_or(access::Error::Unavailable)?;
                let integration = provider
                    .integration_id
                    .as_ref()
                    .map(|id| id.as_lossless())
                    .unwrap_or(&provider.id.0);
                let matches = saved
                    .iter()
                    .filter(|credential| {
                        credential.integration_id() == integration
                            && credential.label() == &profile.0
                    })
                    .count();
                if matches > 1 {
                    return Err(access::Error::InvalidInput);
                }
                if matches == 0 {
                    return Err(access::Error::Unavailable);
                }
            }
            let available = catalog
                .available(&saved)
                .into_iter()
                .find(|model| model.provider_id == target.provider_id && model.id == target.id)
                .ok_or(access::Error::Unavailable)?;
            let selected = catalog
                .get(
                    &target.provider_id,
                    &target.id,
                    target.profile.as_ref(),
                    &saved,
                )
                .filter(|model| model.enabled)
                .ok_or(access::Error::Unavailable)?;
            if let Some(profile) = &target.profile {
                let profile = available
                    .profiles
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .find(|profile_| &profile_.name == profile)
                    .ok_or(access::Error::Unavailable)?;
                if target.variant.as_ref().is_some_and(|variant| {
                    profile
                        .variants
                        .as_ref()
                        .is_some_and(|variants| !variants.contains(variant))
                }) {
                    return Err(access::Error::InvalidInput);
                }
            }
            if target.variant.as_ref().is_some_and(|variant| {
                !selected
                    .variants
                    .iter()
                    .any(|candidate| &candidate.id == variant)
            }) {
                return Err(access::Error::InvalidInput);
            }
            orchestration::ModelSwitch::new(
                self.sessions.clone(),
                composed.models.clone(),
                composed.credentials.clone(),
                composed.runner.compaction(),
                composed.runner.attachments(),
            )
            .resolve(&target, None)
            .map_err(|_| access::Error::Unavailable)?;
            if !self.locations.is_current(&held) {
                return Err(access::Error::Unavailable);
            }
            Ok(target)
        })
    }
    fn switch_model(
        &self,
        session: session::Info,
        target: model::Ref,
        admission: Admission,
    ) -> native::NativeFuture<'_, ()> {
        Box::pin(async move {
            let target = self
                .validate_model(session.location.clone(), target)
                .await?;
            let (current, held) = self
                .locations
                .session(&session.id)
                .map_err(|_| access::Error::Unavailable)?;
            if current.location != session.location || !self.locations.is_current(&held) {
                return Err(access::Error::Unavailable);
            }
            let composed = held.production.as_ref().ok_or(access::Error::Unavailable)?;
            match composed
                .runner
                .switch_model(
                    self.execution.coordinator(),
                    &session.id,
                    &target,
                    Some(admission),
                )
                .await
                .map_err(|_| access::Error::Unavailable)?
            {
                ycoding_core::session::model_switch::Outcome::Switched => Ok(()),
                ycoding_core::session::model_switch::Outcome::Blocked(_) => {
                    Err(access::Error::Unavailable)
                }
            }
        })
    }
    fn retire_root(
        &self,
        root: session::Id,
        admission: Admission,
    ) -> native::NativeFuture<'_, Box<dyn native::RemovalLease>> {
        Box::pin(async move {
            admission
                .validate(&self.sessions, Some(&root))
                .map_err(|_| access::Error::Unavailable)?;
            let mut members = std::collections::BTreeSet::new();
            let mut transitions = Vec::new();
            let mut locations = Vec::new();
            loop {
                let family = crate::handlers::removal_family(self.locations.client(), &root)
                    .map_err(|_| access::Error::Unavailable)?;
                let Some(member) = family.into_iter().find(|member| !members.contains(member))
                else {
                    break;
                };
                transitions.push(
                    self.execution
                        .transition(&member)
                        .await
                        .map_err(|_| access::Error::Unavailable)?,
                );
                self.execution
                    .request_interrupt(&member)
                    .map_err(|_| access::Error::Unavailable)?;
                self.execution.await_idle(&member).await;
                self.locations
                    .cancel_session(&member)
                    .await
                    .map_err(|_| access::Error::Unavailable)?;
                let info = self
                    .sessions
                    .get(&member)
                    .map_err(|_| access::Error::Unavailable)?
                    .ok_or(access::Error::Unavailable)?;
                if let Ok(held) = self.locations.loaded_location(
                    info.location.directory.as_lossless(),
                    info.location
                        .workspace_id
                        .as_ref()
                        .map(|id| id.as_lossless()),
                ) {
                    locations.push(held);
                }
                members.insert(member);
            }
            admission
                .validate(&self.sessions, Some(&root))
                .map_err(|_| access::Error::Unavailable)?;
            Ok(Box::new(Removal {
                members: members.into_iter().collect(),
                transitions,
                locations,
                owner: self.locations.downgrade(),
            }) as Box<dyn native::RemovalLease>)
        })
    }
    fn skills(&self, session: session::Info) -> native::NativeFuture<'_, Vec<native::Skill>> {
        Box::pin(async move { Ok((self.catalogs)(session, CatalogKind::Skills).await?.skills) })
    }
    fn active(&self, session: &session::Id) -> bool {
        self.execution.active().contains(session)
    }
    fn prompt(
        &self,
        request: pending::Request,
        admission: Admission,
    ) -> native::NativeFuture<'_, ()> {
        Box::pin(async move {
            self.execution
                .prompt_native(request, None, admission)
                .await
                .map(|_| ())
                .map_err(|_| access::Error::Unavailable)
        })
    }
    fn interrupt(&self, session: session::Id) -> native::NativeFuture<'_, ()> {
        Box::pin(async move {
            self.execution
                .interrupt(&session)
                .await
                .map_err(|_| access::Error::Unavailable)
        })
    }
    fn subscribe(
        &self,
        listener: native::Listener,
        on_retire: native::Retirement,
    ) -> Result<native::Subscription, access::Error> {
        let notify = Arc::new(tokio::sync::Notify::new());
        let wake = notify.clone();
        let subscriber = self
            .events
            .subscribe(event_feed::Scope::Global, None, move || wake.notify_one())
            .map_err(|_| access::Error::Unavailable)?;
        let (stop, mut stopped) = tokio::sync::watch::channel(false);
        let mut tasks = self.tasks.lock().unwrap_or_else(|error| error.into_inner());
        let tasks = tasks.as_mut().ok_or(access::Error::Unavailable)?;
        let task = tokio::spawn(async move {
            loop {
                if *stopped.borrow() {
                    break;
                }
                match subscriber.next() {
                    Ok(Some(item)) => listener(&item),
                    Ok(None) => {
                        tokio::select! { _ = notify.notified() => {}, _ = stopped.changed() => { break; } }
                    }
                    Err(_) => {
                        tracing::error!("Native Dots event subscription overflowed");
                        on_retire();
                        break;
                    }
                }
            }
        });
        tasks.push((stop.clone(), task));
        Ok(native::Subscription::new(move || {
            stop.send_replace(true);
        }))
    }
}

struct Removal {
    members: Vec<session::Id>,
    transitions: Vec<ycoding_core::session::run_coordinator::TransitionGuard>,
    locations: Vec<Arc<crate::locations::LocationServices>>,
    owner: crate::locations::WeakLocations,
}

impl native::RemovalLease for Removal {
    fn members(&self) -> &[session::Id] {
        &self.members
    }
    fn is_current(&self) -> bool {
        self.transitions.len() == self.members.len()
            && self
                .owner
                .upgrade()
                .is_some_and(|owner| self.locations.iter().all(|held| owner.is_current(held)))
    }
}

fn access(invocation: &Invocation) -> Result<&access::Access, Failure> {
    invocation
        .core()?
        .dots
        .as_ref()
        .map(|dots| &dots.access)
        .ok_or_else(|| Failure::Unavailable("Native Dots is unavailable".into()))
}
fn conversation_failure(error: access::ConversationError) -> Failure {
    match error.code {
        access::ConversationErrorCode::Conflict => Failure::Conflict(error.message.into()),
        access::ConversationErrorCode::InvalidInput => Failure::DotsConversation {
            message: error.message.into(),
            rejection: error.rejection,
        },
        access::ConversationErrorCode::Unavailable => match error.rejection {
            Some(rejection) => Failure::DotsConversation {
                message: error.message.into(),
                rejection: Some(rejection),
            },
            None => Failure::Unavailable(error.message.into()),
        },
    }
}
async fn converse<Q: Message + Name, R: Message + Name + Default>(
    invocation: Invocation,
    request: Q,
    operation: conversation::Operation,
) -> Result<R, Failure> {
    let service = invocation.core()?.dots.as_ref().ok_or_else(unavailable)?;
    let input = domain_json::decode(&Q::full_name(), &request.encode_to_vec())
        .map_err(|_| Failure::Invalid("Invalid Dots conversation input".into()))?;
    let result = service
        .conversation
        .call(operation, crate::connector::mcp::json::value(&input))
        .await
        .map_err(conversation_failure)?;
    let bytes = domain_json::encode(
        &R::full_name(),
        &convert::json_domain(
            &ycoding_schema::ObjectEncoder::new()
                .field("data", &result)
                .finish(),
        ),
        ycoding_protocol::limits::INLINE_BODY_BYTES as usize,
    )
    .map_err(|_| Failure::Unavailable("Dots conversation result cannot be represented".into()))?;
    R::decode(bytes.as_slice())
        .map_err(|_| Failure::Unavailable("Dots conversation result cannot be represented".into()))
}
pub async fn threads(
    invocation: Invocation,
    request: v5::DotsThreadsRequest,
) -> Result<v5::DotsThreadsResult, Failure> {
    converse(invocation, request, conversation::Operation::Threads).await
}
pub async fn task_updates(
    invocation: Invocation,
    request: v5::DotsTaskUpdatesRequest,
) -> Result<v5::DotsTaskUpdatesResult, Failure> {
    converse(invocation, request, conversation::Operation::TaskUpdates).await
}
pub async fn thread_read(
    invocation: Invocation,
    request: v5::DotsThreadReadRequest,
) -> Result<v5::DotsThreadReadResult, Failure> {
    converse(invocation, request, conversation::Operation::Read).await
}
pub async fn thread_send(
    invocation: Invocation,
    request: v5::DotsThreadSendRequest,
) -> Result<v5::DotsThreadSendResult, Failure> {
    converse(invocation, request, conversation::Operation::Send).await
}
pub async fn thread_interrupt(
    invocation: Invocation,
    request: v5::DotsThreadInterruptRequest,
) -> Result<v5::DotsThreadInterruptResult, Failure> {
    converse(invocation, request, conversation::Operation::Interrupt).await
}
pub async fn thread_requests(
    invocation: Invocation,
    request: v5::DotsThreadRequestsRequest,
) -> Result<v5::DotsThreadRequestsResult, Failure> {
    converse(invocation, request, conversation::Operation::Requests).await
}
pub async fn thread_respond(
    invocation: Invocation,
    request: v5::DotsThreadRespondRequest,
) -> Result<v5::DotsThreadRespondResult, Failure> {
    converse(invocation, request, conversation::Operation::Respond).await
}
pub async fn resume(
    invocation: Invocation,
    request: v5::DotsResumeRequest,
) -> Result<v5::DotsResumeResponse, Failure> {
    converse(invocation, request, conversation::Operation::Resume).await
}
fn failure(error: access::Error) -> Failure {
    match error {
        access::Error::Conflict => Failure::Conflict("Native Dots access revision changed".into()),
        access::Error::InvalidInput => Failure::Invalid("Invalid Native Dots access".into()),
        access::Error::Unavailable => Failure::Unavailable("Native Dots is unavailable".into()),
    }
}
fn wire(value: &access::Status) -> Result<v5::DotsNativeStatus, Failure> {
    let unrepresentable =
        || Failure::Unavailable("Native Dots status cannot be represented".into());
    let optional = |value: &Option<String>| value.as_deref().map(LosslessString::from);
    let status = ycoding_schema::dots::NativeStatus::decode(
        &ycoding_schema::ObjectEncoder::new()
            .field(
                "access",
                &ycoding_schema::ObjectEncoder::new()
                    .field("enabled", &value.access.enabled)
                    .field("revision", &JsonValue::Number(value.access.revision as f64))
                    .finish(),
            )
            .field(
                "configuration",
                &ycoding_schema::ObjectEncoder::new()
                    .field("ready", &value.configuration.ready)
                    .optional("profile", &value.configuration.profile)
                    .optional("message", &value.configuration.message)
                    .finish(),
            )
            .field(
                "connection",
                &ycoding_schema::ObjectEncoder::new()
                    .field("state", value.connection.state.as_str())
                    .optional("hostname", &value.connection.hostname)
                    .optional("name", &value.connection.name)
                    .optional("message", &value.connection.message)
                    .finish(),
            )
            .optional(
                "computer",
                &value.computer.as_ref().map(|computer| {
                    ycoding_schema::ObjectEncoder::new()
                        .field("state", computer.state.as_str())
                        .optional("name", &computer.name)
                        .optional(
                            "target",
                            &computer.target.as_ref().map(|target| {
                                ycoding_schema::ObjectEncoder::new()
                                    .field("dotID", &target.dot_id)
                                    .field("threadID", &target.thread_id)
                                    .field("environmentID", &target.environment_id)
                                    .field("revision", target.revision.as_str())
                                    .finish()
                            }),
                        )
                        .optional(
                            "readiness",
                            &computer
                                .readiness
                                .map(|readiness| LosslessString::from(readiness.as_str())),
                        )
                        .optional("usableForTasks", &computer.usable_for_tasks)
                        .optional(
                            "dotEnvironment",
                            &computer.dot_environment.as_ref().map(|environment| {
                                ycoding_schema::ObjectEncoder::new()
                                    .field("status", environment.status.as_str())
                                    .field(
                                        "capabilities",
                                        &JsonValue::Array(
                                            environment
                                                .capabilities
                                                .iter()
                                                .map(|(kind, status)| {
                                                    ycoding_schema::ObjectEncoder::new()
                                                        .field("type", kind.as_str())
                                                        .field("status", status.as_str())
                                                        .finish()
                                                })
                                                .collect(),
                                        ),
                                    )
                                    .finish()
                            }),
                        )
                        .optional("message", &optional(&computer.message))
                        .finish()
                }),
            )
            .finish(),
    )
    .map_err(|_| unrepresentable())?;
    let bytes = domain_json::encode(
        "ycoding.v5.Dots_NativeStatus",
        &convert::json_domain(&status.encode()),
        64 * 1024,
    )
    .map_err(|_| unrepresentable())?;
    v5::DotsNativeStatus::decode(bytes.as_slice())
        .map_err(|_| Failure::Unavailable("Native Dots status cannot be represented".into()))
}
pub async fn get(
    invocation: Invocation,
    _: v5::DotsGetRequest,
) -> Result<v5::DotsGetResult, Failure> {
    Ok(v5::DotsGetResult {
        data: wire(&access(&invocation)?.status().await.map_err(failure)?)?,
    })
}
pub async fn set(
    invocation: Invocation,
    request: v5::DotsSetRequest,
) -> Result<v5::DotsSetResult, Failure> {
    let access = access(&invocation)?;
    access
        .set(request.payload.enabled, request.payload.expected_revision)
        .await
        .map_err(failure)?;
    Ok(v5::DotsSetResult {
        data: wire(&access.status().await.map_err(failure)?)?,
    })
}
fn receipt(target: Option<&v5::DotsComputerTarget>) -> Result<Option<JsonValue>, Failure> {
    target
        .map(|target| {
            Ok::<_, Failure>(
                ycoding_schema::ObjectEncoder::new()
                    .field("dotID", &convert::domain(&target.dot_id)?)
                    .field("threadID", &convert::domain(&target.thread_id)?)
                    .field("environmentID", &convert::domain(&target.environment_id)?)
                    .field("revision", &convert::domain(&target.revision)?)
                    .finish(),
            )
        })
        .transpose()
}
fn expected_target(
    target: Option<ycoding_schema::dots::ComputerTarget>,
    invalid: impl Fn() -> Failure,
) -> Result<Option<access::ComputerTarget>, Failure> {
    target
        .map(|target| {
            Ok::<_, Failure>(access::ComputerTarget {
                dot_id: target.dot_id.0,
                thread_id: target.thread_id.0,
                environment_id: target.environment_id.0,
                revision: target.revision.0.to_utf8().map_err(|_| invalid())?,
            })
        })
        .transpose()
}
pub async fn attach(
    invocation: Invocation,
    request: v5::DotsAttachRequest,
) -> Result<v5::DotsAttachResult, Failure> {
    let invalid = || Failure::Invalid("Invalid computer attach request".into());
    let expected = receipt(request.payload.expected_target.as_ref())?;
    let attach = ycoding_schema::dots::ComputerAttach::decode(
        &ycoding_schema::ObjectEncoder::new()
            .field("replaceOthers", &request.payload.replace_others)
            .optional("expectedTarget", &expected)
            .finish(),
    )
    .map_err(|_| invalid())?;
    Ok(v5::DotsAttachResult {
        data: wire(
            &access(&invocation)?
                .attach_computer(access::ComputerAttach {
                    replace_others: attach.replace_others,
                    expected_target: expected_target(attach.expected_target, invalid)?,
                })
                .await
                .map_err(failure)?,
        )?,
    })
}
pub async fn detach(
    invocation: Invocation,
    request: v5::DotsDetachRequest,
) -> Result<v5::DotsDetachResult, Failure> {
    let invalid = || Failure::Invalid("Invalid computer detach request".into());
    let expected = receipt(request.payload.expected_target.as_ref())?;
    let detach = ycoding_schema::dots::ComputerDetach::decode(
        &ycoding_schema::ObjectEncoder::new()
            .optional("expectedTarget", &expected)
            .finish(),
    )
    .map_err(|_| invalid())?;
    Ok(v5::DotsDetachResult {
        data: wire(
            &access(&invocation)?
                .detach_computer(access::ComputerDetach {
                    expected_target: expected_target(detach.expected_target, invalid)?,
                })
                .await
                .map_err(failure)?,
        )?,
    })
}
pub async fn remove(
    invocation: Invocation,
    request: v5::DotsRemoveRequest,
) -> Result<v5::DotsRemoveResult, Failure> {
    let invalid = || Failure::Invalid("Invalid computer removal request".into());
    let expected = receipt(request.payload.expected_target.as_ref())?;
    let remove = ycoding_schema::dots::ComputerRemove::decode(
        &ycoding_schema::ObjectEncoder::new()
            .optional("expectedTarget", &expected)
            .finish(),
    )
    .map_err(|_| invalid())?;
    Ok(v5::DotsRemoveResult {
        data: wire(
            &access(&invocation)?
                .remove_computer(access::ComputerRemove {
                    expected_target: expected_target(remove.expected_target, invalid)?,
                })
                .await
                .map_err(failure)?,
        )?,
    })
}
