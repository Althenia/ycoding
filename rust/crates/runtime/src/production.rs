mod composition;
mod controls;
mod globals;
#[cfg(test)]
mod lifecycle_tests;
mod mcp_owner;
mod meeting;
mod observer;
pub(crate) mod owner;
mod refresh;
pub(crate) mod standalone;
#[cfg(test)]
pub(crate) mod tests;
mod tools;

use crate::{
    Configuration, Core, LocationServices, Locations, SnapshotSettings, dispatch::Failure, ids,
};
use futures_util::{FutureExt, future::Shared};
use std::{
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};
use tokio::{sync::watch, task::JoinHandle};
use ycoding_core::{
    event_feed::Feed,
    platform::git,
    process::guardrails::{Limits, Paths, Settings},
    resources::{
        agent, attachment_store, auth,
        catalog::{self, models_dev},
        command, config, credential, cursor,
        domain_state::DomainState,
        generate, mcp, memory, model, reference, skill,
    },
    session::{
        autonomy, compaction_policy, execution, goal, instruction_sources, orchestration,
        retention,
        run_coordinator::{self, DrainRequest, RunFuture},
        runner,
        store::Service,
    },
    tools::{
        policy,
        registry::{Registration, Registry},
    },
    ycoding_ai::{
        cursor::{
            headers::Identity,
            provider::{RequestContext, Runtime},
        },
        route::Executor,
    },
    ycoding_schema::{
        self, DomainDecode, JsonValue, LosslessString, ObjectEncoder, location, session,
    },
    ycoding_store::Client,
};

pub struct Production {
    pub configuration: config::LoadOptions,
    pub analytics: std::path::PathBuf,
    pub catalog: models_dev::Options,
    pub cursor: Option<Cursor>,
    pub steer: Option<Arc<dyn autonomy::Steer>>,
    pub ripgrep: std::path::PathBuf,
    pub meeting: bool,
}

pub struct Cursor {
    pub identity: Identity,
    pub runtime: Arc<Runtime>,
}

pub struct Composed {
    pub configuration: Arc<config::Configuration>,
    pub decision: Arc<dyn ycoding_core::process::guardrails::decision::Evaluator>,
    pub models: Arc<model::Resolver>,
    pub credentials: credential::Service,
    pub tools: Arc<Registry>,
    pub agents: DomainState<agent::Service>,
    pub memory: Arc<memory::Service>,
    pub runner: runner::Local,
    pub steer: Option<Arc<dyn autonomy::Steer>>,
    pub platform: Arc<crate::services::PlatformServices>,
    pub integrations: auth::integration::Registry,
    pub mcp: Arc<mcp::Service>,
    pub isolated: Arc<ycoding_core::platform::browser::isolated::Service>,
    pub computer: Arc<ycoding_core::platform::computer::service::Service>,
    paired: Arc<ycoding_core::platform::browser::service::Service>,
    pub commands: DomainState<command::Service>,
    pub references: DomainState<reference::Service>,
    pub skills: Arc<tokio::sync::Mutex<skill::Service>>,
    pub generate: Arc<generate::Service>,
    pub session_generate: Arc<ycoding_core::session::generate::Service>,
    pub activation: Arc<ycoding_core::extension::Activation>,
    reload: ycoding_core::extension::reload::Reloader,
    scope_view: Arc<refresh::ScopeView>,
    pub extension_diagnostics: Vec<ycoding_core::ycoding_schema::config::Diagnostic>,
    pub plugin_diagnostics: Vec<ycoding_core::ycoding_schema::config::Diagnostic>,
    pub plugins: Vec<ycoding_core::ycoding_schema::plugin::Info>,
    launch: ycoding_core::extension::Launch,
    pub(crate) generation: u64,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    watch_stop: watch::Sender<bool>,
    governor:
        tokio::sync::Mutex<Option<ycoding_core::resources::project_artifact::source::Governor>>,
    mcp_tools: tokio::sync::Mutex<Option<ycoding_core::tools::builtin::mcp::McpTools>>,
    mcp_owner: Arc<mcp_owner::Owner>,
    pending: crate::locations::Pending,
    closed: std::sync::atomic::AtomicBool,
    _registration: Registration,
    _meeting: Option<Registration>,
    _session_tools: Option<Registration>,
}

pub(crate) struct Prepared {
    pub configuration: Configuration,
    disk: Arc<config::Configuration>,
    models: Arc<model::Resolver>,
    source: ycoding_core::resources::project_artifact::source::Service,
    standard: ycoding_core::resources::project_artifact::source::Catalogs,
    builtin_agents: agent::Service,
    skills: Arc<tokio::sync::Mutex<skill::Service>>,
    refresh: reference::Refresh,
    models_updated: watch::Receiver<u64>,
    wellknown_updated: watch::Receiver<u64>,
}

pub(crate) struct Factory {
    parent_plugins: Option<ycoding_core::extension::ParentHandle>,
    options: config::LoadOptions,
    settings: Arc<dyn Fn() -> retention::Settings + Send + Sync>,
    catalog_refresh: bool,
    client: Client,
    events: Feed,
    credentials: credential::Service,
    executor: Arc<Executor>,
    git: Arc<git::Service>,
    publisher: policy::Publisher,
    cursor: Option<Cursor>,
    #[cfg(test)]
    cursor_agent: Option<ycoding_core::ycoding_ai::cursor::transport::Endpoint>,
    pub steer: Option<Arc<dyn autonomy::Steer>>,
    ripgrep: std::path::PathBuf,
    globals: Arc<globals::Globals>,
    locations: std::sync::OnceLock<crate::locations::WeakLocations>,
    orchestration: std::sync::OnceLock<orchestration::Service>,
    generations: std::sync::atomic::AtomicU64,
}

struct Bootstrap {
    client: Client,
    production: Production,
    credentials: credential::Service,
    events: Feed,
    git: Arc<git::Service>,
    globals: Arc<globals::Globals>,
}

type ShutdownCompletion = Shared<crate::dispatch::Boxed<Result<(), Failure>>>;

#[derive(Default)]
struct Started {
    recover: bool,
    execution: Option<&'static execution::Execution>,
    locations: Option<Locations>,
    maintenance: Option<Arc<Maintenance>>,
    dots: Option<Arc<crate::dots::Services>>,
}

#[derive(Default)]
pub(crate) struct Shutdown {
    parent: Option<Arc<ycoding_core::extension::ParentOwner>>,
    completion: Mutex<Option<ShutdownCompletion>>,
}

impl Shutdown {
    fn with_parent(parent: Option<Arc<ycoding_core::extension::ParentOwner>>) -> Self {
        Self {
            parent,
            ..Default::default()
        }
    }

    fn begin<F>(
        &self,
        start: impl FnOnce() -> F,
    ) -> Shared<crate::dispatch::Boxed<Result<(), Failure>>>
    where
        F: std::future::Future<Output = Result<(), Failure>> + Send + 'static,
    {
        let mut completion = self
            .completion
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        completion
            .get_or_insert_with(|| {
                let future: crate::dispatch::Boxed<Result<(), Failure>> = Box::pin(start());
                future.shared()
            })
            .clone()
    }

    pub(crate) async fn run<F>(&self, start: impl FnOnce() -> F) -> Result<(), Failure>
    where
        F: std::future::Future<Output = Result<(), Failure>> + Send + 'static,
    {
        self.begin(start).await
    }
}

pub(crate) fn cleanup_results(
    results: impl IntoIterator<Item = Result<(), Failure>>,
) -> Result<(), Failure> {
    let mut errors = results.into_iter().filter_map(Result::err);
    let Some(first) = errors.next() else {
        return Ok(());
    };
    let others = errors.collect::<Vec<_>>();
    if others.is_empty() {
        return Err(first);
    }
    let message = match first {
        Failure::Unavailable(message) => message,
        error => format!("{error:?}"),
    };
    Err(Failure::Unavailable(format!(
        "{message}; additional cleanup failures: {others:?}"
    )))
}

pub(crate) fn bootstrap_failure(primary: Failure, released: Result<(), Failure>) -> Failure {
    match released {
        Ok(()) => primary,
        Err(_)
            if matches!(
                &primary,
                Failure::ServiceUnavailable {
                    service: TELEMETRY_PRUNING,
                    ..
                }
            ) =>
        {
            tracing::error!(
                stage = TELEMETRY_PRUNING,
                "Cleanup after a failed production startup also failed"
            );
            primary
        }
        Err(released) => {
            let message = match primary {
                Failure::Unavailable(message) => message,
                error => format!("{error:?}"),
            };
            Failure::Unavailable(format!("{message}; cleanup failure: {released:?}"))
        }
    }
}

pub(crate) async fn close_parent(
    parent: Option<&ycoding_core::extension::ParentOwner>,
) -> Result<(), Failure> {
    let Some(parent) = parent else {
        return Ok(());
    };
    parent.retire();
    let closed = parent
        .close()
        .await
        .map_err(|error| Failure::Unavailable(format!("parent plugin cleanup: {error}")));
    let joined = parent
        .join()
        .await
        .map_err(|error| Failure::Unavailable(format!("parent plugin join: {error}")));
    cleanup_results([closed, joined])
}

async fn sleep_holds(
    client: &Client,
    awake: ycoding_core::platform::keep_awake::Service,
) -> Result<autonomy::Service, Failure> {
    let autonomy = autonomy::Service::new(client.clone()).with_keep_awake(awake);
    autonomy
        .migrate_stored_autonomy()
        .await
        .map_err(|_| unavailable("stored autonomy"))?;
    autonomy
        .rehydrate()
        .await
        .map_err(|_| unavailable("sleep keep-awake holds"))?;
    Ok(autonomy)
}

impl Core {
    pub async fn production(
        owner: &owner::Handle,
        client: Client,
        production: Production,
    ) -> Result<Self, Failure> {
        Self::production_with_recovery(owner, client, production, false).await
    }

    pub(crate) async fn production_with_recovery(
        owner: &owner::Handle,
        client: Client,
        production: Production,
        recover: bool,
    ) -> Result<Self, Failure> {
        owner
            .register_bootstrap(client, production, recover)?
            .await?
    }

    pub(crate) async fn production_registered(
        client: Client,
        production: Production,
        recover: bool,
        context: owner::Context,
    ) -> Result<Core, Failure> {
        production
            .configuration
            .roots
            .initialize()
            .map_err(|_| unavailable("runtime directories"))?;
        let credentials = credential::Service::new(client.clone());
        let events = Feed::attach(&client);
        let git = Arc::new(git::Service::new(16 * 1024 * 1024));
        let globals = match globals::Globals::start(
            client.clone(),
            &production,
            credentials.clone(),
            events.clone(),
            git.clone(),
            true,
            production.analytics.clone(),
        ) {
            Ok(globals) => globals,
            Err(error) => {
                let parent = context.parent_owner();
                let parent = close_parent(parent.as_deref()).await;
                let released = credentials
                    .shutdown()
                    .await
                    .map_err(|_| unavailable("credentials"));
                if released.is_err() {
                    tracing::error!("credential release after a failed bootstrap failed");
                }
                return Err(bootstrap_failure(
                    error,
                    cleanup_results([parent, released]),
                ));
            }
        };
        let mut started = Started {
            recover,
            ..Default::default()
        };
        match Core::bootstrap(
            Bootstrap {
                client,
                production,
                credentials: credentials.clone(),
                events,
                git,
                globals: globals.clone(),
            },
            &mut started,
            &context,
        )
        .await
        {
            Ok(core) => Ok(core),
            Err(error) => {
                let library = context.drain_library().await.result();
                let released = release(
                    &globals,
                    &credentials,
                    started.execution,
                    started.locations.as_ref(),
                    started.maintenance.as_deref(),
                    started.dots.as_ref(),
                    context.parent_owner().as_deref(),
                )
                .await;
                if released.is_err() {
                    tracing::error!("releasing owners after a failed bootstrap failed");
                }
                Err(bootstrap_failure(
                    error,
                    cleanup_results([library, released]),
                ))
            }
        }
    }

    async fn bootstrap(
        input: Bootstrap,
        started: &mut Started,
        context: &owner::Context,
    ) -> Result<Self, Failure> {
        let Bootstrap {
            client,
            production,
            credentials,
            events,
            git,
            globals,
        } = input;
        globals.catalog.get().await.map_err(|error| {
            eprintln!("production composition diagnostic: stage=model catalog; category={error:?}");
            Failure::Unavailable("model catalog unavailable".into())
        })?;
        let feed = events.clone();
        let factory = Arc::new(Factory {
            parent_plugins: context.parent_plugins(),
            settings: retention_settings(&production.configuration)?,
            options: production.configuration,
            catalog_refresh: production.catalog.fetch,
            client: client.clone(),
            events: events.clone(),
            credentials,
            executor: Arc::new(Executor::new(
                Executor::http_client().map_err(|_| unavailable("provider execution"))?,
            )),
            git,
            publisher: Arc::new(move |event| {
                feed.publish(crate::services::ephemeral(&event)?);
                Ok(())
            }),
            cursor: production.cursor,
            #[cfg(test)]
            cursor_agent: None,
            steer: production.steer,
            ripgrep: production.ripgrep,
            globals,
            locations: Default::default(),
            orchestration: Default::default(),
            generations: Default::default(),
        });
        let mut global = factory.options.clone();
        if global.content.is_none() {
            global.directory = global.roots.config.clone();
        }
        global.project = false;
        let global =
            Arc::new(config::Configuration::load(global).map_err(global_configuration_error)?);
        let configuration = factory.configuration(&global)?;
        let sessions = Service::new(client.clone());
        reconcile(&sessions, &client).await?;
        let keep_awake = ycoding_core::platform::keep_awake::Service::open(
            factory.options.roots.state.join("keep-awake-lid.json"),
        )
        .await;
        let autonomy = sleep_holds(&client, keep_awake.clone()).await?;
        let (reviews, delivery) = crate::session_review::service(sessions.clone());
        let review_limit = configuration.guardrails.limits.reviews as usize;
        let locations = Locations::new(
            client.clone(),
            sessions.clone(),
            configuration,
            events.clone(),
            autonomy.clone(),
            reviews.clone(),
        )
        .with_factory(factory.clone());
        started.locations = Some(locations.clone());
        let _ = factory.locations.set(locations.downgrade());
        let _ = factory.globals.locations.set(locations.downgrade());
        factory.globals.composition.wake().notify();
        let goal_locations = locations.clone();
        let steer = factory.steer.clone().unwrap_or_else(|| {
            Arc::new(goal::Service::new(
                sessions.clone(),
                Arc::new(move |reference| {
                    let services = goal_locations
                        .location(
                            reference.directory.as_lossless(),
                            reference
                                .workspace_id
                                .as_ref()
                                .map(|workspace| workspace.as_lossless()),
                        )
                        .ok()?;
                    let composed = services.production.as_ref()?;
                    Some(goal::Environment {
                        location: reference.clone(),
                        agents: services.agents.clone(),
                        generate: Arc::new(composed.runner.clone()),
                    })
                }),
            ))
        });
        let execution = execution::Execution::install(
            sessions.clone(),
            Arc::new(locations.clone()),
            ycoding_core::job::Jobs::new(),
            Some(steer),
        )
        .map_err(|_| unavailable("process-global Session execution"))?;
        started.execution = Some(execution);
        execution
            .bind_status(events.clone())
            .map_err(|_| unavailable("Session status feed"))?;
        let orchestration = orchestration::Service::new(
            sessions.clone(),
            Arc::new(crate::services::LocalExecution(execution)),
        )
        .with_reviews(policy::Reviews {
            service: reviews.clone(),
            limit: review_limit,
        });
        let decision_locations = locations.downgrade();
        let orchestration = orchestration.with_question_policy(Arc::new(move |child| {
            let (_, services) = decision_locations.upgrade()?.session(child).ok()?;
            Some(services.production.as_ref()?.decision.clone())
        }));
        let _ = factory.orchestration.set(orchestration.clone());
        delivery.bind(orchestration.clone(), execution);
        let coordination_runtime = crate::coordination::bind(crate::coordination::Bindings {
            coordination: factory.globals.coordination.clone(),
            sessions: sessions.clone(),
            execution,
            locations: locations.downgrade(),
            settings: crate::coordination::configured_settings(global.clone()),
        });
        factory
            .globals
            .coordination_runtime
            .set(coordination_runtime.clone())
            .map_err(|_| unavailable("Project runtime"))?;
        if started.recover {
            orchestration
                .recover_restart()
                .await
                .map_err(|_| unavailable("managed task recovery"))?;
        } else {
            orchestration
                .reconcile_stale()
                .await
                .map_err(|_| unavailable("stale tasks"))?;
        }
        orchestration
            .dispatch_notifications()
            .await
            .map_err(|_| unavailable("notification outbox"))?;
        reviews
            .reconcile(crate::ids::now_millis())
            .await
            .map_err(|_| unavailable("review reconciliation"))?;
        let publisher = factory.publisher.clone();
        let credentials = factory.credentials.clone();
        let resolver_locations = locations.clone();
        let catalog_roots = factory.options.roots.clone();
        let move_artifacts = factory.globals.artifacts.clone();
        let catalog_globals = factory.globals.clone();
        let catalog_refresh = factory.catalog_refresh;
        let catalogs = Arc::new(move |info: &location::Info| {
            let services = resolver_locations
                .location(
                    info.directory.as_lossless(),
                    info.workspace_id.as_ref().map(|id| id.as_lossless()),
                )
                .map_err(|_| "Location services unavailable".to_owned())?;
            let composed = services
                .production
                .as_ref()
                .ok_or_else(|| "Production services unavailable".to_owned())?;
            let held = services.clone();
            let refresh_locations = resolver_locations.clone();
            let refresh_info = info.clone();
            let refresh_globals = catalog_globals.clone();
            let refresh: crate::services::CatalogTask = Arc::new(move || {
                let locations = refresh_locations.clone();
                let info = refresh_info.clone();
                let globals = refresh_globals.clone();
                Box::pin(async move {
                    globals
                        .wellknown
                        .refresh()
                        .await
                        .map_err(|_| "WellKnown refresh failed".to_owned())?;
                    if catalog_refresh {
                        globals
                            .catalog
                            .refresh(true)
                            .await
                            .map_err(|_| "Model discovery refresh failed".to_owned())?;
                    }
                    tokio::task::spawn_blocking(move || locations.reload(&info))
                        .await
                        .map_err(|_| "Location reload worker failed".to_owned())?
                        .map_err(|_| "Location reload failed".to_owned())
                })
            });
            let ready: crate::services::CatalogTask = Arc::new(move || {
                let held = held.clone();
                Box::pin(async move {
                    let _ = held;
                    Ok(())
                })
            });
            let resolve_locations = resolver_locations.clone();
            let invalidate_locations = resolver_locations.clone();
            let artifacts = move_artifacts.clone();
            Ok(crate::services::CatalogServices {
                session: Some(crate::services::SessionServices {
                    runner: composed.runner.clone(),
                    generate: composed.session_generate.clone(),
                    destination: Some(crate::services::DestinationServices {
                        resolve: Arc::new(move |reference| {
                            let locations = resolve_locations.clone();
                            let artifacts = artifacts.clone();
                            Box::pin(async move {
                                let resolved = locations.clone();
                                let (info, previous) = tokio::task::spawn_blocking(move || {
                                    resolved.resolve_move(&reference)
                                })
                                .await
                                .map_err(|_| "Destination resolution worker failed".to_owned())?
                                .map_err(|_| "Destination Location is unavailable".to_owned())?;
                                locations.record(&info, false).await.map_err(|_| {
                                    "Destination Project recording failed".to_owned()
                                })?;
                                if let Some(previous) = previous.filter(|id| id != &info.project.id)
                                {
                                    artifacts
                                        .adopt_project_committed(&previous, &info.project.id)
                                        .await
                                        .map_err(|error| {
                                            format!(
                                                "Destination artifact adoption failed: {:?}",
                                                error.code
                                            )
                                        })?;
                                }
                                Ok(info)
                            })
                        }),
                        invalidate: Arc::new(move |reference| {
                            let locations = invalidate_locations.clone();
                            Box::pin(async move {
                                tokio::task::spawn_blocking(move || {
                                    locations.evict(
                                        reference.directory.as_lossless(),
                                        reference.workspace_id.as_ref().map(|id| id.as_lossless()),
                                    )
                                })
                                .await
                                .map_err(|_| "Destination invalidation worker failed".to_owned())?
                                .map_err(|_| "Destination invalidation failed".to_owned())
                            })
                        }),
                    }),
                }),
                models: composed.models.clone(),
                agents: services.agents.clone(),
                commands: composed.commands.clone(),
                references: composed.references.clone(),
                skills: composed.skills.clone(),
                roots: catalog_roots.clone(),
                diagnostics: composed
                    .configuration
                    .diagnostics
                    .iter()
                    .chain(&composed.extension_diagnostics)
                    .chain(&composed.plugin_diagnostics)
                    .cloned()
                    .collect(),
                plugins: composed.plugins.clone(),
                ready,
                refresh,
                generate: composed.generate.clone(),
            })
        });
        let integration_locations = locations.clone();
        let integration_globals = factory.globals.clone();
        let integrations = Arc::new(move |info: &location::Info| {
            let services = integration_locations
                .location(
                    info.directory.as_lossless(),
                    info.workspace_id.as_ref().map(|id| id.as_lossless()),
                )
                .map_err(|_| "Location services unavailable".to_owned())?;
            Ok(crate::services::IntegrationServices {
                registry: services
                    .production
                    .as_ref()
                    .ok_or_else(|| "Production services unavailable".to_owned())?
                    .integrations
                    .clone(),
                wellknown: Some(integration_globals.wellknown.clone()),
            })
        });
        let mcp_locations = locations.clone();
        let mcp = Arc::new(move |info: &location::Info| {
            let services = mcp_locations
                .location(
                    info.directory.as_lossless(),
                    info.workspace_id.as_ref().map(|id| id.as_lossless()),
                )
                .map_err(|_| "Location services unavailable".to_owned())?;
            Ok(services
                .production
                .as_ref()
                .ok_or_else(|| "Production services unavailable".to_owned())?
                .mcp
                .clone())
        });
        let platform_locations = locations.clone();
        let platform = Arc::new(move |reference: &location::Ref| {
            let services = platform_locations
                .location(
                    reference.directory.as_lossless(),
                    reference.workspace_id.as_ref().map(|id| id.as_lossless()),
                )
                .map_err(|_| "Location services unavailable".to_owned())?;
            Ok(services
                .production
                .as_ref()
                .ok_or_else(|| "Production services unavailable".to_owned())?
                .platform
                .clone())
        });
        let isolated_locations = locations.clone();
        let isolated = Arc::new(move |reference: &location::Ref| {
            let services = isolated_locations
                .location(
                    reference.directory.as_lossless(),
                    reference.workspace_id.as_ref().map(|id| id.as_lossless()),
                )
                .map_err(|_| "Location services unavailable".to_owned())?;
            Ok(services
                .production
                .as_ref()
                .ok_or_else(|| "Production services unavailable".to_owned())?
                .isolated
                .clone())
        });
        let quota = Arc::new(factory.globals.claude.quota.clone());
        let usage_locations = locations.clone();
        let provider_usage = Arc::new(move |info: &location::Info| {
            let held = usage_locations
                .loaded_location(
                    info.directory.as_lossless(),
                    info.workspace_id.as_ref().map(|id| id.as_lossless()),
                )
                .map_err(|_| "Location services unavailable".to_owned())?;
            let generation = held
                .production
                .as_ref()
                .ok_or_else(|| "Production services unavailable".to_owned())?
                .generation;
            if !usage_locations.is_current(&held) {
                return Err("Location services unavailable".to_owned());
            }
            Ok(crate::services::ProviderUsageServices {
                quota: quota.clone(),
                generation,
            })
        });
        let artifacts = factory.globals.artifacts.clone();
        let artifact_locations = locations.clone();
        let artifacts = Arc::new(move |info: &location::Info| {
            let held = artifact_locations
                .location(
                    info.directory.as_lossless(),
                    info.workspace_id.as_ref().map(|id| id.as_lossless()),
                )
                .ok()?;
            let locations = artifact_locations.clone();
            let info = info.clone();
            Some(crate::services::ArtifactServices {
                store: artifacts.clone(),
                refresh: Arc::new(move || {
                    let _held = &held;
                    if locations.reload(&info).is_err() {
                        tracing::error!("project artifact Location refresh failed");
                    }
                }),
            })
        });
        let browser = factory.globals.browser.clone();
        let remote = crate::connector::Control::open(&factory.options.roots.state)
            .await
            .map_err(|_| unavailable("remote control"))?;
        let maintenance = Arc::new(Maintenance::new(&factory));
        let events_key = factory.options.roots.data.join("mcp-events-native.key");
        started.maintenance = Some(maintenance.clone());
        let telemetry_settings = factory.settings.clone();
        maintenance
            .start(
                sessions.clone(),
                execution,
                factory.clone(),
                autonomy.changes(),
                AutonomyConsumers {
                    locations: locations.clone(),
                    orchestration: orchestration.clone(),
                    reviews: reviews.clone(),
                },
            )
            .await?;
        let incidents = ycoding_core::model_incident::Service::new(client.clone());
        let event_authorization = Arc::new(
            crate::connector::mcp_events_authorization::Authorizer::production(remote.clone())
                .map_err(|_| unavailable("MCP Events authorization"))?,
        );
        remote
            .server()
            .install_authorization(event_authorization.clone())?;
        let event_service = Arc::new(ycoding_core::mcp_events::Service::new(
            ycoding_core::mcp_events::Dependencies {
                store: client.clone(),
                authorization: event_authorization,
                transport: Arc::new(ycoding_core::mcp_events::protected_http::ProtectedHttp::new()),
                secrets: ycoding_core::mcp_events::Secrets::File(events_key),
                clock: Arc::new(crate::ids::now_millis),
            },
        ));
        remote.server().install_events(event_service.clone())?;
        event_service
            .start(events.clone())
            .map_err(|_| unavailable("MCP Events capture"))?;
        let native_factory = factory.clone();
        let native_catalogs: crate::dots::CatalogReader = Arc::new(move |session, kind| {
            let factory = native_factory.clone();
            Box::pin(async move {
                let unavailable = || ycoding_core::dots::access::Error::Unavailable;
                let project_key = ycoding_core::ycoding_store::tuple_key(&[
                    ycoding_core::ycoding_store::KeyPart::String(session.project_id.as_lossless()),
                ]);
                let project = factory
                    .client
                    .snapshot()
                    .map_err(|_| unavailable())?
                    .get::<ycoding_core::ycoding_store::project::ProjectTable>(&project_key)
                    .map_err(|_| unavailable())?
                    .ok_or_else(unavailable)?;
                let prepared = factory
                    .prepare(
                        session.location.directory.as_lossless(),
                        session
                            .location
                            .workspace_id
                            .as_ref()
                            .map(|id| id.as_lossless()),
                        session.project_id.as_lossless(),
                        &project.worktree,
                    )
                    .map_err(|_| unavailable())?;
                let catalog = prepared.models.catalog();
                let mut result = crate::dots::Catalog {
                    skills: vec![],
                    selected: None,
                };
                match kind {
                    crate::dots::CatalogKind::Skills => {
                        for skill in prepared
                            .skills
                            .lock()
                            .await
                            .list()
                            .await
                            .map_err(|_| unavailable())?
                        {
                            result.skills.push(ycoding_core::dots::native::Skill {
                                id: skill.id.to_utf8().map_err(|_| unavailable())?,
                                name: Some(skill.name.to_utf8().map_err(|_| unavailable())?),
                            });
                        }
                    }
                    crate::dots::CatalogKind::Selected => {
                        result.selected = match session.model {
                            Some(model) => Some(model),
                            None => catalog.default_selection(
                                &factory.credentials.all().map_err(|_| unavailable())?,
                            ),
                        }
                    }
                }
                Ok(result)
            })
        });
        let goal = crate::goal_decisions::bind(crate::goal_decisions::Bindings {
            client: client.clone(),
            autonomy: autonomy.clone(),
            execution,
            orchestration: orchestration.clone(),
            locations: locations.downgrade(),
            settings: crate::coordination::configured_settings(global.clone()),
        });
        let dots = Arc::new(
            crate::dots::Services::start(crate::dots::Settings {
                owner: context.handle(),
                client: client.clone(),
                global,
                credentials: credentials.clone(),
                sessions: sessions.clone(),
                execution,
                locations: locations.clone(),
                git: factory.git.clone(),
                orchestration: orchestration.clone(),
                reviews: reviews.clone(),
                events: events.clone(),
                catalogs: native_catalogs,
                auth: factory.globals.auth.clone(),
                preparation: factory.globals.preparation.clone(),
                env: factory.options.env.clone(),
                state: factory.options.roots.state.clone(),
                home: factory.options.roots.os_home.clone(),
                data: factory.options.roots.data.clone(),
                codex_home: factory
                    .options
                    .env
                    .get("CODEX_HOME")
                    .cloned()
                    .unwrap_or_else(|| {
                        factory
                            .options
                            .roots
                            .home
                            .join(".codex")
                            .to_string_lossy()
                            .into_owned()
                    }),
            })
            .await?,
        );
        started.dots = Some(dots.clone());
        maintenance
            .attach_coordination(coordination_runtime.clone(), events.clone())
            .await?;
        maintenance
            .attach_goal(&goal, &events, autonomy.clone())
            .await?;
        let mut snapshot = Self {
            generation: factory.globals.generation.clone(),
            usage_dashboard: Some(factory.globals.usage_dashboard.clone()),
            coordination: factory.globals.coordination.clone(),
            coordination_runtime: Some(coordination_runtime),
            captured: crate::remote_derived::captured::Cache::attach(&client),
            integrations: Some(integrations),
            mcp: Some(mcp),
            catalogs: Some(catalogs),
            artifacts: Some(artifacts),
            remote: Some(remote),
            dots: Some(dots),
            publisher,
            credentials,
            browser: Some(browser),
            isolated_browser: Some(isolated),
            interaction: Some(factory.globals.interaction.clone()),
            platform: Some(platform),
            configuration: Some({
                let factory = factory.clone();
                let locations = locations.clone();
                Arc::new(move |location| {
                    let mut configuration = factory
                        .read_configuration(location.directory.as_lossless())
                        .map_err(|_| "Location configuration unavailable".to_owned())?;
                    let sets = locations.current_sets();
                    if let Some(composed) = sets
                        .iter()
                        .filter(|set| {
                            set.info.directory == location.directory
                                && set.info.workspace_id == location.workspace_id
                        })
                        .filter_map(|set| set.production.as_ref())
                        .find(|composed| composed.configuration.entries == configuration.entries)
                    {
                        Arc::make_mut(&mut configuration)
                            .diagnostics
                            .extend(composed.plugin_diagnostics.iter().cloned());
                    }
                    Ok(configuration)
                })
            }),
            roots: Some(factory.options.roots.clone()),
            attachments: Some(Arc::new(
                attachment_store::Store::new(factory.options.roots.data.clone())
                    .map_err(|_| unavailable("managed attachments"))?,
            )),
            platform_default_location: None,
            telemetry: ycoding_core::telemetry::Service::new(client, telemetry_settings.clone()),
            keep_awake,
            provider_usage: Some(provider_usage),
            retention: telemetry_settings,
            state: factory.options.roots.state.clone(),
            sessions: sessions.clone(),
            execution,
            autonomy,
            events,
            locations,
            orchestration,
            reviews,
            incidents,
            maintenance: Some(maintenance),
            shutdown: Arc::new(Shutdown::with_parent(context.parent_owner())),
            lifetime: None,
        };
        let mut core = snapshot.clone();
        core.locations.restore_forms().await?;
        snapshot.shutdown = Arc::new(Shutdown::with_parent(context.parent_owner()));
        core.lifetime = Some(context.retain(
            context.production_retirement(),
            Box::pin(async move { owner::Report::runtime(snapshot.shutdown_owned().await) }),
        ));
        Ok(core)
    }

    pub async fn shutdown(&self) -> Result<(), Failure> {
        if let Some(lifetime) = &self.lifetime {
            return lifetime.close().await.result();
        }
        self.shutdown
            .run(|| {
                let mut owner = self.clone();
                owner.lifetime = None;
                owner.shutdown = Arc::new(Shutdown::with_parent(self.shutdown.parent.clone()));
                async move { owner.shutdown_owned().await }
            })
            .await
    }

    async fn shutdown_owned(&self) -> Result<(), Failure> {
        if let Some(parent) = &self.shutdown.parent {
            parent.retire();
        }
        let events = self.remote.as_ref().map(|remote| remote.server());
        if let Some(maintenance) = &self.maintenance {
            let checkpoint = self.locations.checkpoint_forms().await;
            let released = release(
                &maintenance.globals,
                &maintenance.credentials,
                Some(self.execution),
                Some(&self.locations),
                Some(maintenance.as_ref()),
                self.dots.as_ref(),
                self.shutdown.parent.as_deref(),
            )
            .await;
            let events = match events {
                Some(events) => events.shutdown().await,
                None => Ok(()),
            };
            return cleanup_results([checkpoint, released, events]);
        }
        let dots = match &self.dots {
            Some(dots) => dots.shutdown().await,
            None => Ok(()),
        };
        let dashboard = match &self.usage_dashboard {
            Some(dashboard) => dashboard
                .shutdown()
                .await
                .map_err(|_| unavailable("Usage dashboard worker")),
            None => Ok(()),
        };
        let execution = self
            .execution
            .shutdown()
            .await
            .map_err(|_| unavailable("Session execution"));
        let jobs = self
            .execution
            .jobs()
            .shutdown()
            .await
            .map_err(|_| unavailable("Jobs"));
        let events = match events {
            Some(events) => events.shutdown().await,
            None => Ok(()),
        };
        cleanup_results([
            dots,
            dashboard,
            execution,
            jobs,
            self.locations.close(),
            close_parent(self.shutdown.parent.as_deref()).await,
            events,
        ])
    }
}

async fn release(
    globals: &globals::Globals,
    credentials: &credential::Service,
    execution: Option<&'static execution::Execution>,
    locations: Option<&Locations>,
    maintenance: Option<&Maintenance>,
    dots: Option<&Arc<crate::dots::Services>>,
    parent: Option<&ycoding_core::extension::ParentOwner>,
) -> Result<(), Failure> {
    if let Some(parent) = parent {
        parent.retire();
    }
    let results = [
        match maintenance {
            Some(maintenance) => {
                let goal = maintenance.stop_goal().await;
                let coordination = maintenance.stop_coordination().await;
                cleanup_results([goal, coordination])
            }
            None => Ok(()),
        },
        match dots {
            Some(dots) => dots.shutdown().await,
            None => Ok(()),
        },
        globals.meetings.shutdown().await,
        match execution {
            Some(execution) => execution
                .shutdown()
                .await
                .map_err(|_| unavailable("Session execution")),
            None => Ok(()),
        },
        match execution {
            Some(execution) => execution
                .jobs()
                .shutdown()
                .await
                .map_err(|_| unavailable("Jobs")),
            None => Ok(()),
        },
        match maintenance {
            Some(maintenance) => maintenance.stop_workers().await,
            None => Ok(()),
        },
        globals.stop_controls().await,
        globals
            .usage_dashboard
            .shutdown()
            .await
            .map_err(|_| unavailable("Usage dashboard worker")),
        globals.composition.stop_reports(),
        locations.map_or(Ok(()), Locations::close),
        close_parent(parent).await,
        globals.close().await,
        credentials
            .shutdown()
            .await
            .map_err(|_| unavailable("credentials")),
        globals.composition.close(),
    ];
    cleanup_results(results)
}

impl Factory {
    pub(crate) fn wake_usage(&self) {
        self.globals.composition.wake().notify();
    }

    pub(crate) fn usage_changed(&self, location: Option<&location::Ref>) {
        self.globals.usage_changed(location);
    }
    pub(crate) fn pricing(
        &self,
        reference: &ycoding_core::session::usage_read::PricingRef,
        current: Option<Arc<catalog::Catalog>>,
    ) -> Result<
        Option<ycoding_core::session::usage_read::Pricing>,
        ycoding_core::ycoding_store::Error,
    > {
        use ycoding_core::ycoding_store::Error;
        let catalog = if let Some(catalog) = current {
            catalog
        } else {
            let mut options = self.options.clone();
            options.directory = reference
                .directory
                .to_utf8()
                .map_err(|_| Error::Rejected("Location pricing identity is unavailable"))?
                .into();
            match std::fs::metadata(&options.directory) {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(Error::Io(error)),
            }
            let sources = self
                .globals
                .composition
                .run(async {
                    Ok(self
                        .globals
                        .wellknown
                        .configuration(&self.credentials)
                        .await)
                })
                .map_err(|_| Error::Rejected("Location catalog runtime is unavailable"))?
                .map_err(|error| Error::Record(Box::new(error)))?;
            let disk = config::Configuration::load_with_sources(options, sources)
                .map_err(|error| Error::Record(Box::new(error)))?;
            let catalog = self
                .globals
                .composition
                .run(async {
                    let mut accounts = self.globals.accounts.lock().await;
                    Ok(catalog::Catalog::compose_current(
                        &self.globals.catalog,
                        &disk,
                        &self.credentials,
                        &mut accounts,
                        crate::ids::now_millis(),
                        false,
                    )
                    .await)
                })
                .map_err(|_| Error::Rejected("Location catalog runtime is unavailable"))?
                .map_err(|error| Error::Record(Box::new(error)))?
                .catalog;
            Arc::new(catalog)
        };
        let saved = self
            .credentials
            .all()
            .map_err(|error| Error::Record(Box::new(error)))?;
        let model = catalog.get(
            &ycoding_core::ycoding_schema::provider::Id(reference.provider.clone()),
            &reference.model,
            reference
                .profile
                .as_ref()
                .map(|profile| ycoding_core::ycoding_schema::model::ProfileName(profile.clone()))
                .as_ref(),
            &saved,
        );
        let router_id = if reference.provider.as_str() == Some("openrouter") {
            reference.model.clone()
        } else {
            LosslessString::from_utf16(
                reference
                    .provider
                    .code_units()
                    .chain(std::iter::once('/' as u16))
                    .chain(reference.model.code_units())
                    .collect(),
            )
        };
        let router = catalog.get(
            &ycoding_core::ycoding_schema::provider::Id("openrouter".into()),
            &router_id,
            None,
            &saved,
        );
        let provider = model.map(|model| model.cost).unwrap_or_default();
        let router = router.map(|model| model.cost).unwrap_or_default();
        Ok((!provider.is_empty() || !router.is_empty())
            .then_some(ycoding_core::session::usage_read::Pricing { provider, router }))
    }
    pub(crate) async fn cancel_session(
        &self,
        session: &ycoding_core::ycoding_schema::session::Id,
    ) -> Result<(), Failure> {
        self.globals.release_session(session.clone()).await
    }
    pub(crate) fn evict(&self, services: &crate::locations::ServiceSet) -> Result<(), Failure> {
        self.globals.composition.run(async {
            let Some(composed) = &services.production else {
                return Ok(());
            };
            let tasks = composed.stop_tasks().await;
            let observer = composed.mcp_owner.stop_observer().await;
            let controls = self.globals.flush_controls().await;
            let sessions = Service::new(self.client.clone())
                .list(&ycoding_core::session::list::Query::default())
                .map_err(|_| unavailable("evicted Session inventory"))?;
            let mut ownership = None;
            for session in sessions.iter().filter(|session| {
                session.location.directory == services.info.directory
                    && session.location.workspace_id == services.info.workspace_id
            }) {
                if let Some(execution) = execution::Execution::global() {
                    let _ = execution.request_interrupt(&session.id);
                }
                if let Err(error) = self.globals.release_session(session.id.clone()).await {
                    ownership.get_or_insert(error);
                }
                if let Some(execution) = execution::Execution::global() {
                    execution.await_idle(&session.id).await;
                }
            }
            let isolated = composed
                .isolated
                .shutdown()
                .await
                .map_err(|_| unavailable("evicted isolated browser"));
            let computer = composed
                .computer
                .release_location()
                .await
                .map_err(|_| unavailable("evicted computer work"));
            tasks
                .and(observer)
                .and(controls)
                .and(ownership.map_or(Ok(()), Err))
                .and(isolated)
                .and(computer)
        })
    }
    pub(crate) fn close(&self, services: &crate::locations::ServiceSet) -> Result<(), Failure> {
        self.globals.composition.run(async {
            if let Some(standalone) = &services.standalone {
                standalone.state.close();
            }
            if let Some(composed) = &services.production {
                composed.close().await?;
            }
            Ok(())
        })
    }
    fn read_configuration(
        &self,
        directory: &LosslessString,
    ) -> Result<Arc<config::Configuration>, Failure> {
        let mut options = self.options.clone();
        options.directory = directory
            .to_utf8()
            .map_err(|_| unavailable("Location directory"))?
            .into();
        let sources = self.globals.composition.run(async {
            self.globals
                .wellknown
                .configuration(&self.credentials)
                .await
                .map_err(|_| unavailable("WellKnown configuration"))
        })?;
        Ok(Arc::new(
            config::Configuration::load_with_sources(options, sources)
                .map_err(|_| unavailable("Location configuration"))?
                .with_mutation_policy(config::MutationPolicy(Arc::new(|_| true))),
        ))
    }

    pub(crate) fn prepare(
        &self,
        directory: &LosslessString,
        workspace: Option<&LosslessString>,
        project_id: &LosslessString,
        project_directory: &LosslessString,
    ) -> Result<Prepared, Failure> {
        self.prepare_refresh(directory, workspace, project_id, project_directory, false)
    }

    pub(crate) fn prepare_refresh(
        &self,
        directory: &LosslessString,
        workspace: Option<&LosslessString>,
        project_id: &LosslessString,
        project_directory: &LosslessString,
        force: bool,
    ) -> Result<Prepared, Failure> {
        let models_updated = self.globals.catalog.refreshed();
        let wellknown_updated = self.globals.wellknown.updated();
        let disk = self.read_configuration(directory)?;
        let reference = location::Ref::decode(
            &ycoding_core::ycoding_schema::ObjectEncoder::new()
                .field("directory", directory)
                .optional("workspaceID", &workspace.cloned())
                .finish(),
        )
        .map_err(|_| unavailable("Location identity"))?;
        let mut catalog = self.globals.composition.run(async {
            let mut accounts = self.globals.accounts.lock().await;
            catalog::Catalog::compose_current(
                &self.globals.catalog,
                &disk,
                &self.credentials,
                &mut accounts,
                crate::ids::now_millis(),
                force,
            )
            .await
            .map(|composition| composition.catalog)
            .map_err(|_| unavailable("configured account catalog"))
        })?;
        for record in &mut catalog.providers {
            if record
                .provider
                .overlays
                .settings
                .as_ref()
                .is_some_and(|settings| settings.0.get(&"apiKey".into()).is_some())
            {
                continue;
            }
            if let Some(key) = record
                .environment
                .iter()
                .filter_map(|name| name.as_str().and_then(|name| self.options.env.get(name)))
                .find(|value| !value.is_empty())
            {
                record
                    .provider
                    .overlays
                    .settings
                    .get_or_insert_with(Default::default)
                    .0
                    .insert("apiKey".into(), JsonValue::String(key.as_str().into()));
            }
        }
        let mut configuration = self.configuration(&disk)?;
        let path = |text: &LosslessString| {
            text.to_utf8()
                .map(std::path::PathBuf::from)
                .map_err(|_| unavailable("Location directory"))
        };
        let location_directory = path(directory)?;
        let roots = &self.options.roots;
        let commands = command::Service::from_project_entries(
            &disk.entries,
            &path(project_directory)?,
            &mut vec![],
        )
        .map_err(|_| unavailable("command catalog"))?;
        let skills = skill::Service::from_entries(
            &disk.entries,
            &location_directory,
            &roots.home,
            &roots.cache,
        )
        .map_err(|_| unavailable("skill catalog"))?;
        let standard = ycoding_core::resources::project_artifact::source::Catalogs {
            agents: (*configuration.agents).clone(),
            commands,
            skills,
        };
        let source = ycoding_core::resources::project_artifact::source::Service::new(
            ycoding_core::resources::project_artifact::source::Options {
                client: self.client.clone(),
                store: self.globals.artifacts.clone(),
                accounting: self.globals.accounting.clone(),
                registry: self.globals.sources.clone(),
                location: reference,
                project_id: ycoding_core::ycoding_schema::project::Id::new(project_id.clone())
                    .map_err(|_| unavailable("Project identity"))?,
                project_directory: path(project_directory)?,
                data_root: roots.data.clone(),
            },
            standard.clone(),
        );
        let catalogs = self.globals.composition.run(async {
            source
                .set_capabilities(&disk.capabilities)
                .await
                .map_err(|_| unavailable("project artifact capability policy"))?;
            Ok(source.catalogs().await)
        })?;
        configuration.agents = Arc::new(catalogs.agents);
        Ok(Prepared {
            configuration,
            disk,
            models: Arc::new(model::Resolver::new(catalog)),
            source,
            standard,
            builtin_agents: agent::Service::new(self.builtin_agents()?),
            skills: Arc::new(tokio::sync::Mutex::new(catalogs.skills)),
            refresh: if force {
                reference::Refresh::Fetch
            } else {
                reference::Refresh::Cached
            },
            models_updated,
            wellknown_updated,
        })
    }

    fn builtin_agents(&self) -> Result<Vec<ycoding_core::ycoding_schema::agent::Info>, Failure> {
        let mut builtins = agent::builtin::catalog(
            &self.options.roots,
            ycoding_core::ycoding_schema::session_scope::Scope::Bound,
        )
        .map_err(|_| unavailable("built-in agent catalog"))?;
        if self.globals.meetings.enabled() {
            builtins.push(ycoding_core::session::analysis::analysis_agent());
        }
        Ok(builtins)
    }

    fn configuration(&self, disk: &config::Configuration) -> Result<Configuration, Failure> {
        let roots = &self.options.roots;
        let agents = Arc::new(
            agent::Service::from_entries(
                &disk.entries,
                &roots.home,
                self.builtin_agents()?,
                &mut vec![],
            )
            .map_err(|_| unavailable("agent configuration"))?,
        );
        let mut limits = Limits {
            hard_review_expiry: Duration::from_secs(
                disk.hard_review_expiry_minutes().saturating_mul(60),
            ),
            ..Limits::default()
        };
        let settings = disk.latest("guardrails");
        for (key, target) in [
            ("max_concurrent_shells", &mut limits.shells),
            ("max_concurrent_subagents", &mut limits.subagents),
            ("max_pending_reviews", &mut limits.reviews),
        ] {
            if let Some(JsonValue::Number(value)) = field(settings, key) {
                *target = *value as u64;
            }
        }
        if let Some(JsonValue::Number(value)) = field(settings, "shell_wait_seconds") {
            limits.shell_wait = Duration::from_secs(*value as u64);
        }
        let global_roots = [
            &roots.config,
            &roots.data,
            &roots.cache,
            &roots.state,
            &roots.tmp,
            &roots.bin,
            &roots.log,
            &roots.repos,
        ]
        .into_iter()
        .map(|path| crate::locations::physical_path(path))
        .collect::<Result<Vec<_>, _>>()?;
        Ok(Configuration {
            agents,
            publisher: Arc::new(|_| Ok(())),
            helpers: None,
            guardrails: Settings {
                paths: Paths {
                    workdir: "".into(),
                    project: "".into(),
                    home: crate::locations::physical_path(&roots.home)?,
                    tmpdir: Some(crate::locations::physical_path(&roots.tmp)?),
                    trusted_paths: vec![],
                },
                global_roots,
                custom: tools::guardrails(disk),
                enabled: field(settings, "enabled") != Some(&JsonValue::Bool(false)),
                limits,
                decide_reviews: field(settings, "decide_reviews") != Some(&JsonValue::Bool(false)),
                decide_hard_reviews: field(settings, "decide_hard_reviews")
                    != Some(&JsonValue::Bool(false)),
            },
            snapshots: SnapshotSettings {
                git: self.git.clone(),
                data: roots.data.clone(),
                enabled: disk.latest("snapshots") != Some(&JsonValue::Bool(false)),
            },
        })
    }

    pub(crate) fn compose(
        &self,
        services: &crate::locations::ServiceSet,
        prepared: Prepared,
        boot: bool,
        previous: Option<&Composed>,
    ) -> Result<Composed, Failure> {
        self.globals
            .composition
            .run(self.compose_started(services, prepared, boot, previous))
    }

    async fn compose_started(
        &self,
        services: &crate::locations::ServiceSet,
        prepared: Prepared,
        boot: bool,
        previous: Option<&Composed>,
    ) -> Result<Composed, Failure> {
        let generation = self
            .generations
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            + 1;
        let roots = &self.options.roots;
        let directory = std::path::PathBuf::from(
            services
                .info
                .directory
                .as_lossless()
                .to_utf8()
                .map_err(|_| unavailable("Location directory"))?,
        );
        let project = std::path::PathBuf::from(
            services
                .info
                .project
                .directory
                .as_lossless()
                .to_utf8()
                .map_err(|_| unavailable("Project directory"))?,
        );
        let repository = self
            .git
            .discover(&directory)
            .map_err(|_| unavailable("Location repository"))?;
        let memory = Arc::new(
            memory::Service::new(memory::Options {
                directory: directory.clone(),
                home: roots.home.clone(),
                data: roots.data.clone(),
                repository: repository
                    .as_ref()
                    .map(|repository| {
                        Ok(memory::Repository {
                            directory: repository.worktree.clone(),
                            common_directory: repository.common_directory.clone(),
                            worktrees: ycoding_core::platform::worktree::list(
                                &self.git, repository,
                            )
                            .map_err(|_| unavailable("repository worktrees"))?
                            .into_iter()
                            .map(|worktree| worktree.directory)
                            .collect(),
                        })
                    })
                    .transpose()?,
                limits: memory::Limits::from_configuration(&prepared.disk),
            })
            .map_err(|_| unavailable("workspace memory"))?,
        );
        let mcp_owner = match previous {
            Some(previous) => previous.mcp_owner.clone(),
            None => self.start_mcp(&prepared, &directory).await?,
        };
        let release_on_failure = mcp_owner.clone();
        let mut staged_activation = None;
        let result = async {
            let integrations = mcp_owner.integrations.clone();
            let mcp = mcp_owner.mcp.clone();
            let platform = match previous {
                Some(previous) => Arc::new(crate::services::PlatformServices {
                    shell: previous.platform.shell.clone(),
                    pty: previous.platform.pty.clone(),
                    tickets: previous.platform.tickets.clone(),
                    config: prepared.disk.clone(),
                    filesystem: previous.platform.filesystem.clone(),
                    search: previous.platform.search.clone(),
                    git: previous.platform.git.clone(),
                    copies: previous.platform.copies.clone(),
                }),
                None => {
                    let shell = Arc::new(
                        ycoding_core::platform::shell::Shell::new(
                            roots,
                            directory.clone(),
                            services
                                .info
                                .project
                                .id
                                .as_lossless()
                                .as_str()
                                .ok_or_else(|| unavailable("Project identity"))?,
                            self.client.clone(),
                        )
                        .await
                        .map_err(|_| unavailable("Location shell"))?,
                    );
                    shell
                        .event_source
                        .bind(
                            self.events.clone(),
                            Some(location::Ref {
                                directory: services.info.directory.clone(),
                                workspace_id: services.info.workspace_id.clone(),
                            }),
                        )
                        .map_err(|_| unavailable("shell events"))?;
                    let pty = Arc::new(ycoding_core::platform::pty::Pty::new(directory.clone()));
                    pty.event_source
                        .bind(
                            self.events.clone(),
                            Some(location::Ref {
                                directory: services.info.directory.clone(),
                                workspace_id: services.info.workspace_id.clone(),
                            }),
                        )
                        .map_err(|_| unavailable("PTY events"))?;
                    let copy_locations = self.globals.locations.clone();
                    let copies = Arc::new(
                        ycoding_core::platform::project_copy::Copies::new(
                            &directory,
                            self.git.clone(),
                            self.client.clone(),
                            self.publisher.clone(),
                        )
                        .map_err(|_| unavailable("project copies"))?
                        .with_retirement(Arc::new(move |directory| {
                            let locations = copy_locations.get().and_then(|locations| locations.upgrade())
                                .ok_or_else(|| "Location map is unavailable".to_owned())?;
                            let directory = directory.to_str().ok_or_else(|| "Directory is not UTF-8".to_owned())?;
                            locations.retire_directory(&directory.into())
                                .map_err(|_| "Location retirement failed".to_owned())
                        })),
                    );
                    let search_globals = self.globals.clone();
                    let vcs = repository.is_some();
                    Arc::new(crate::services::PlatformServices {
                        shell,
                        pty,
                        tickets: Arc::new(Mutex::new(Default::default())),
                        config: prepared.disk.clone(),
                        filesystem: Arc::new(
                            ycoding_core::platform::filesystem::Location::new(&directory)
                                .map_err(|_| unavailable("Location filesystem"))?,
                        ),
                        search: Arc::new(
                            ycoding_core::platform::filesystem::search::Service::deferred(
                                &directory,
                                Arc::new(move || {
                                    let binary = search_globals
                                        .composition
                                        .run(async {
                                            search_globals
                                                .ripgrep
                                                .filepath()
                                                .await
                                                .map_err(|_| unavailable("ripgrep acquisition"))
                                        })
                                        .map_err(|_| {
                                            std::io::Error::other("ripgrep acquisition failed")
                                        })?;
                                    Ok(
                            ycoding_core::platform::filesystem::search::Backend::Automatic {
                                vcs,
                                binary,
                            },
                        )
                                }),
                            )
                            .map_err(|_| unavailable("Location search"))?,
                        ),
                        git: self.git.clone(),
                        copies,
                    })
                }
            };
            let references = Arc::new(
                reference::Service::from_entries(
                    &prepared.disk.entries,
                    &directory,
                    roots,
                    &mut vec![],
                )
                .map_err(|_| unavailable("reference catalog"))?,
            );
            let materialized = references.clone();
            let repositories = self.globals.repositories.clone();
            let refresh = prepared.refresh;
            tokio::task::spawn_blocking(move || materialized.materialize(&repositories, refresh))
                .await
                .map_err(|_| unavailable("reference acquisition worker"))?
                .map_err(|_| unavailable("reference acquisition"))?;
            let skills = prepared.skills.clone();
            let isolated = previous
                .map(|previous| previous.isolated.clone())
                .unwrap_or_else(|| {
                    ycoding_core::platform::browser::isolated::Service::new(
                        self.globals.isolated_executor.clone(),
                        self.globals.admission.clone(),
                        self.globals.sessions.clone(),
                        Default::default(),
                    )
                });
            let computer = previous
                .map(|previous| previous.computer.clone())
                .unwrap_or_else(|| Arc::new(self.globals.computer.service()));
            let pending = services.pending();
            let (registry, registration) = tools::compose(
                self,
                services,
                prepared.disk.clone(),
                memory.clone(),
                &platform,
                tools::Handles {
                    isolated: &isolated,
                    computer: &computer,
                    interaction: &self.globals.interaction,
                    skills: skills.clone(),
                    mcp: &mcp,
                    artifacts: prepared.source.clone(),
                },
            )?;
            let clock = self.globals.clock.clone();
            let instruction_clock = clock.clone();
            let mut instructions = ycoding_core::instructions::builtins::load(
                ycoding_core::instructions::builtins::Environment {
                    directory: directory.to_string_lossy().into_owned(),
                    project_root: project.to_string_lossy().into_owned(),
                    git: repository.is_some(),
                    platform: std::env::consts::OS.into(),
                    data: self.options.roots.data.to_string_lossy().into_owned(),
                },
                Arc::new(move || instruction_clock.now()),
                ycoding_core::ycoding_schema::session_scope::Scope::Bound,
            );
            instructions.push(instruction_sources::ambient_with_capabilities(
                ycoding_core::resources::instruction_discovery::Options {
                    directory: directory.clone(),
                    project_root: project.clone(),
                    global_config: roots.config.clone(),
                    project: self.options.project,
                    max_bytes: None,
                },
                prepared.disk.capabilities.clone(),
            ));
            instructions.push(memory::instructions::source());
            instructions.push(ycoding_core::resources::project_artifact::instructions::source());
            let cursor_host = || {
                self.cursor
                    .as_ref()
                    .map(|cursor| {
                        let context = cursor::context::build(
                            &directory,
                            &[],
                            &cursor::context::Environment {
                                global_config_dir: roots.config.clone(),
                                cache_dir: roots.cache.clone(),
                                home: roots.home.clone(),
                                project_discovery_disabled: !self.options.project,
                            },
                        );
                        Ok(cursor::route::Host {
                            identity: cursor.identity.clone(),
                            context: RequestContext::new(
                                context
                                    .encode()
                                    .map_err(|_| unavailable("Cursor context"))?,
                            )
                            .map_err(|_| unavailable("Cursor context"))?,
                            runtime: cursor.runtime.clone(),
                            known_mcp_servers: context.known_mcp_servers,
                            extensions: cursor::route::Extensions {
                                #[cfg(test)]
                                agent: self.cursor_agent.clone(),
                                ..Default::default()
                            },
                        })
                    })
                    .transpose()
            };
            let cursor = cursor_host()?;
            let compaction = prepared
                .disk
                .values("compaction")
                .map(compaction_policy::Info::decode)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| unavailable("compaction configuration"))?;
            let attachments = Arc::new(
                attachment_store::Store::new(roots.data.clone())
                    .map_err(|_| unavailable("managed attachments"))?,
            );
            let helpers = policy::helper::Settings::from_configuration(&prepared.disk)
                .map_err(|_| unavailable("helper model configuration"))?;
            let meeting = self
                .globals
                .meetings
                .attach(
                    &self.client,
                    roots,
                    self.options
                        .env
                        .get("XDG_DATA_HOME")
                        .map(std::path::Path::new),
                    self.options.env.get("YCODING_CHANNEL").map(String::as_str) == Some("beta"),
                    meeting::Target {
                        reference: location::Ref {
                            directory: services.info.directory.clone(),
                            workspace_id: services.info.workspace_id.clone(),
                        },
                        project: ycoding_core::ycoding_schema::project::Id::new(
                            services.info.project.id.as_lossless().clone(),
                        )
                        .map_err(|_| unavailable("Project identity"))?,
                        project_directory: &project,
                        git: &self.git,
                        directory: &directory,
                        mcp: mcp.clone(),
                        models: prepared.models.clone(),
                    },
                )
                .await;
            let meeting_history = meeting
                .as_ref()
                .map(|meeting| {
                    ycoding_core::meeting::history::register(&registry, meeting.database.clone())
                })
                .transpose()
                .map_err(|_| unavailable("meeting history tool"))?;
            let providers = self.globals.providers.at(&directory);
            let preparation = ycoding_core::resources::auth::Preparation {
                providers: Some(providers.clone()),
                ..self.globals.preparation.clone()
            };
            let helper_models = Arc::new(policy::helper::Models {
                standalone: None,
                models: prepared.models.clone(),
                credentials: self.credentials.clone(),
                auth: preparation.clone(),
                cursor: cursor_host()?,
                claude: Some(self.globals.claude.clone()),
                store: Service::new(self.client.clone()),
                settings: helpers.clone(),
            });
            let generate_cursor = cursor_host()?.map(Arc::new);
            let image_analyzer = ycoding_core::session::image_analyzer::Service::new(
                prepared.disk.clone(),
                helper_models.clone(),
                self.executor.clone(),
            );
            let session_reservation = registry.reserve();
            let snapshots: Arc<dyn ycoding_core::session::revert::Snapshots + Send + Sync> =
                Arc::new(ycoding_core::session::snapshot::GitSnapshots::new(
                    self.git.clone(),
                    roots.data.clone(),
                    services
                        .info
                        .project
                        .id
                        .as_lossless()
                        .to_utf8()
                        .map_err(|_| unavailable("Project identity"))?,
                    project.clone(),
                    directory.clone(),
                    prepared.configuration.snapshots.enabled,
                ));
            let reference = location::Ref {
                directory: services.info.directory.clone(),
                workspace_id: services.info.workspace_id.clone(),
            };
            let launch = ycoding_core::extension::Launch {
                rules: configured_rules(&prepared.disk, &roots.home)?,
                cancellation: Default::default(),
            };
            let (watch_stop, stopped) = watch::channel(false);
            let watcher = self.watch(&prepared, generation, services.info.clone(), stopped)?;
            let governor = prepared
                .source
                .start(&self.events)
                .map_err(|_| unavailable("project artifact governor"))?;
            let leaf = Arc::new(ycoding_core::tools::context::policy::LeafPolicy {
                permissions: services.permissions.clone(),
                guardrails: services.guardrails.clone(),
            });
            let mcp_tools = ycoding_core::tools::builtin::mcp::McpTools::start(
                Arc::new(mcp.as_ref().clone()),
                registry.clone(),
                leaf.clone(),
                execution::Execution::global()
                    .zip(self.orchestration.get())
                    .map(|(execution, orchestration)| {
                        ycoding_core::tools::builtin::mcp::Background {
                            jobs: execution.jobs().clone(),
                            notifier: runner::mcp_notifier(orchestration.clone()),
                        }
                    }),
            );
            let activation = ycoding_core::extension::Activation::new(
                directory.clone(),
                ycoding_core::extension::Options::default(),
                registry.clone(),
                leaf,
                launch.clone(),
                ycoding_core::extension::Host {
                    mcp: Some(Arc::new(mcp.as_ref().clone())),
                    integrations: Some(integrations.clone()),
                    sessions: Some(ycoding_core::extension::SessionHost {
                        store: Service::new(self.client.clone()),
                        location: reference.clone(),
                        services: Some(Arc::new({
                            let locations = self.locations.get().cloned();
                            let reference = reference.clone();
                            move || {
                                let locations = locations
                                    .as_ref()
                                    .and_then(|locations| locations.upgrade())
                                    .ok_or(ycoding_core::extension::Error::Stopped)?;
                                let services = locations
                                    .location(
                                        reference.directory.as_lossless(),
                                        reference.workspace_id.as_ref().map(|id| id.as_lossless()),
                                    )
                                    .map_err(|_| ycoding_core::extension::Error::Stopped)?;
                                let composed = services
                                    .production
                                    .as_ref()
                                    .filter(|composed| composed.generation == generation)
                                    .ok_or(ycoding_core::extension::Error::Stopped)?;
                                let reload = composed.reload.clone();
                                let agents_at = {
                                    let locations = locations.downgrade();
                                    Arc::new(
                                        move |candidate: &ycoding_core::ycoding_schema::location::Ref| {
                                            use ycoding_core::ycoding_schema::DomainEncode;
                                            let locations = locations.upgrade().ok_or(
                                                ycoding_core::extension::Error::Stopped,
                                            )?;
                                            let services = locations
                                                .location(
                                                    candidate.directory.as_lossless(),
                                                    candidate
                                                        .workspace_id
                                                        .as_ref()
                                                        .map(|id| id.as_lossless()),
                                                )
                                                .map_err(|_| {
                                                    ycoding_core::extension::Error::Stopped
                                                })?;
                                            Ok((
                                                services.info.clone(),
                                                services
                                                    .agents
                                                    .snapshot()
                                                    .list()
                                                    .into_iter()
                                                    .map(DomainEncode::encode)
                                                    .collect(),
                                            ))
                                        },
                                    )
                                };
                                Ok(ycoding_core::extension::SessionServices {
                                    runner: composed.runner.clone(),
                                    generate: composed.session_generate.clone(),
                                    commands: composed.commands.clone(),
                                    configuration: composed.configuration.clone(),
                                    reads: Some(ycoding_core::extension::SessionServices::reads(
                                        services.info.clone(),
                                        composed.references.clone(),
                                        composed.skills.clone(),
                                        composed.credentials.clone(),
                                        composed.activation.clone(),
                                        reload,
                                        agents_at,
                                    )),
                                })
                            }
                        })),
                    }),
                },
            );
            let activation = match &self.parent_plugins {
                Some(parent) => activation.with_parent_plugins(parent.clone()),
                None => activation,
            };
            let activation = Arc::new(activation);
            staged_activation = Some(activation.clone());
            providers
                .bind_plugins(&activation)
                .map_err(|_| unavailable("plugin language binding"))?;
            activation
                .prepare_plugins(&prepared.disk)
                .await
                .map_err(|error| Failure::Unavailable(format!("plugin preparation: {error}")))?;
            let builtins = activation.builtins().await;
            let mut catalog = (*prepared.models.catalog()).clone();
            catalog
                .settle_builtins(&builtins)
                .map_err(|_| unavailable("plugin built-in catalog"))?;
            self.globals
                .replace_models(&reference,&prepared.models, catalog)
                .map_err(|_| unavailable("plugin built-in catalog"))?;
            let mut builtin_commands = command::Service::default();
            builtin_commands
                .settle_builtins(&builtins, &project)
                .map_err(|_| unavailable("plugin built-in commands"))?;
            let mut builtin_skills = skill::Service::new(&roots.cache);
            builtin_skills
                .settle_builtins(&builtins, &prepared.disk.entries, &directory)
                .map_err(|_| unavailable("plugin built-in skills"))?;
            let plugin_diagnostics = builtins.diagnostic().into_iter().collect::<Vec<_>>();
            let plugins = activation.plugin_list().await;
            let extensions = activation.extensions().await;
            let resources = Arc::new(ycoding_core::extension::Resources {
                agents: prepared.builtin_agents.clone(),
                commands: builtin_commands,
                references: reference::Service::from_infos(vec![]),
                skills: builtin_skills,
                catalog: (*prepared.models.catalog()).clone(),
            });
            let post = Arc::new(ConfigurationStage {
                disk: prepared.disk.clone(),
                home: roots.home.clone(),
                directory: directory.clone(),
                references: (*references).clone(),
                artifacts: prepared.source.clone(),
                standard: tokio::sync::Mutex::new(prepared.standard.clone()),
            });
            let configured = ycoding_core::resources::project_artifact::source::Catalogs {
                agents: post.agents(&resources.agents)?,
                commands: post.commands(&resources.commands)?,
                skills: post.skills(&resources.skills)?,
            };
            let catalogs = post
                .artifacts(|standard| *standard = configured)
                .await;
            let agents = services.agents.clone();
            agents.publish(catalogs.agents);
            let commands = DomainState::new(catalogs.commands);
            let references =
                DomainState::new(post.references(&resources.references)?);
            *skills.lock().await = catalogs.skills;
            self.globals
                .replace_models(&reference,&prepared.models, configured_catalog(
                    resources.catalog.clone(),
                    &prepared.disk,
                    &builtins,
                )?)
                .map_err(|_| unavailable("plugin domain catalog"))?;
            let start_reload = || ycoding_core::extension::reload::Reloader::start(
                Duration::from_millis(500),
                watch_stop.subscribe(),
                Arc::new({
                    let resources = resources.clone();
                    let activation = Arc::downgrade(&activation);
                    let agents = agents.clone();
                    let commands = commands.clone();
                    let references = references.clone();
                    let skills = skills.clone();
                    let models = prepared.models.clone();
                    let globals = self.globals.clone();
                    let reference=reference.clone();
                    let disk = prepared.disk.clone();
                    let post = post.clone();
                    move |stage| {
                        let resources = resources.clone();
                        let activation = activation.clone();
                        let agents = agents.clone();
                        let commands = commands.clone();
                        let references = references.clone();
                        let skills = skills.clone();
                        let models = models.clone();
                        let globals = globals.clone();
                        let reference=reference.clone();
                        let disk = disk.clone();
                        let post = post.clone();
                        Box::pin(async move {
                            use ycoding_core::{event_feed::Data, extension::{Error, v5::TransformStage}};
                            let activation = activation.upgrade().ok_or(Error::Stopped)?;
                            let extensions = activation.extensions().await;
                            let extensions = extensions.iter().map(Arc::as_ref).collect::<Vec<_>>();
                            let next = tokio::time::timeout(
                                Duration::from_secs(120),
                                resources.materialize_stage(stage, &extensions, None),
                            ).await.map_err(|_| Error::Timeout)??;
                            let (source, event) = match stage {
                                TransformStage::Agents => {
                                    let configured = post.agents(&next.agents).map_err(|_| Error::ExecutionFailed)?;
                                    let mut configured = post.artifacts(|standard| standard.agents = configured).await.agents;
                                    configured.event_source = next.agents.event_source.clone();
                                    let source = configured.event_source.clone();
                                    agents.publish(configured);
                                    (source, Data::AgentUpdated(Box::new(ycoding_core::ycoding_schema::agent::Empty)))
                                }
                                TransformStage::Commands => {
                                    let configured = post.commands(&next.commands).map_err(|_| Error::ExecutionFailed)?;
                                    let mut configured = post.artifacts(|standard| standard.commands = configured).await.commands;
                                    configured.event_source = next.commands.event_source.clone();
                                    let source = configured.event_source.clone();
                                    commands.publish(configured);
                                    (source, Data::CommandUpdated(Box::new(ycoding_core::ycoding_schema::command::Empty)))
                                }
                                TransformStage::References => {
                                    let configured = post.references(&next.references).map_err(|_| Error::ExecutionFailed)?;
                                    let source = configured.event_source.clone();
                                    references.publish(configured);
                                    (source, Data::ReferenceUpdated(Box::new(ycoding_core::ycoding_schema::models_dev::Empty)))
                                }
                                TransformStage::Skills => {
                                    let configured = post.skills(&next.skills).map_err(|_| Error::ExecutionFailed)?;
                                    let mut configured = post.artifacts(|standard| standard.skills = configured).await.skills;
                                    configured.event_source = next.skills.event_source.clone();
                                    let source = configured.event_source.clone();
                                    *skills.lock().await = configured;
                                    (source, Data::SkillUpdated(Box::new(ycoding_core::ycoding_schema::models_dev::Empty)))
                                }
                                TransformStage::Catalog => {
                                    let source = next.catalog.event_source.clone();
                                    let catalog = configured_catalog(next.catalog, &disk, &activation.builtins().await)
                                        .map_err(|_| Error::ExecutionFailed)?;
                                    globals.replace_models(&reference,&models, catalog).map_err(|_| Error::ExecutionFailed)?;
                                    (source, Data::CatalogUpdated(Box::new(ycoding_core::ycoding_schema::catalog::Empty)))
                                }
                                _ => return Err(Error::Unauthorized),
                            };
                            source.emit(event).map_err(|_| Error::ExecutionFailed)
                        })
                    }
                }),
            );
            let decisions = Arc::new(ycoding_core::resources::decision::Service {
                generation: self.globals.generation.clone(),
                clock: self.globals.clock.clone(),
                store: Service::new(self.client.clone()),
                agents: agents.clone(),
                models: helper_models.clone(),
                executor: self.executor.clone(),
                flights: Default::default(),
            });
            services.guardrails.clone().with_decision(decisions.clone());
            services.permissions.clone().with_decision(
                decisions.clone(),
                services.guardrails.review_policy().decide_reviews,
            );
            services.questions.clone().with_decision(decisions.clone());
            services.forms.clone().with_decision(decisions.clone());
            let session_tools = self.session_tools(
                services,
                &prepared,
                &compaction,
                helper_models.clone(),
                agents.clone(),
                attachments.clone(),
            );
            let session_registration = session_tools
                .as_ref()
                .map(|tools| {
                    registry.finalize(
                        session_reservation,
                        tools.clone().entries(),
                        ycoding_core::tools::registry::Options::direct(),
                    )
                })
                .transpose()
                .map_err(|_| unavailable("Session tool registration"))?;
            let instruction_context = ycoding_core::session::instruction_assembly::Context {
                configuration: prepared.disk.clone(),
                registry: registry.clone(),
                skills: skills.clone(),
                references: references.clone(),
                mcp: Arc::downgrade(&mcp),
                coordination: self.globals.coordination.clone(),
            };
            let scope_view = Arc::new(refresh::ScopeView::new(reference.clone(), generation));
            let refresh = self.refresh(services.info.clone(), &scope_view);
            let title = Arc::new(ycoding_core::session::title::Service::new(
                Service::new(self.client.clone()).with_artifact_source(prepared.source.clone()),
                agents.clone(),
                helper_models.clone(),
                self.executor.clone(),
                self.globals.generation.clone(),
                self.globals.clock.clone(),
            ));
            let session_generate = Arc::new(ycoding_core::session::generate::Service {
                store: Service::new(self.client.clone())
                    .with_artifact_source(prepared.source.clone()),
                location: reference.clone(),
                agents: agents.clone(),
                models: helper_models,
                executor: self.executor.clone(),
                attachments: attachments.clone(),
                instructions: instructions.clone(),
                instruction_context: Some(instruction_context.clone()),
                refresh: refresh.clone(),
                extensions: extensions.clone(),
            });
            let runner = runner::Local::new(runner::Services {
                snapshots: Some(snapshots),
                store: Service::new(self.client.clone())
                    .with_artifact_source(prepared.source.clone()),
                events: self.events.clone(),
                location: location::Ref {
                    directory: services.info.directory.clone(),
                    workspace_id: services.info.workspace_id.clone(),
                },
                models: prepared.models.clone(),
                agents: agents.clone(),
                credentials: self.credentials.clone(),
                tools: registry.clone(),
                attachments,
                instructions,
                analysis: meeting.map(|meeting| meeting.analysis),
                configuration: Some(prepared.disk.clone()),
                image_analyzer: Some(image_analyzer),
                extensions,
                session_tools,
                clock,
                generation: self.globals.generation.clone(),
                executor: self.executor.clone(),
                compaction: compaction_policy::resolve(&compaction),
                guardrails: services.guardrails.clone(),
                helpers,
                cursor,
                claude: Some(self.globals.claude.clone()),
                auth: Some(preparation),
                skill_resolver: Some(Arc::new(SkillResolver(skills.clone()))),
            })
            .with_instructions(instruction_context)
            .with_title(title);
            let runner = match refresh {
                Some(refresh) => runner.with_refresh(refresh),
                None => runner,
            };
            let generate = Arc::new(generate::Service {
                models: prepared.models.clone(),
                credentials: self.credentials.clone(),
                integrations: integrations.clone(),
                executor: self.executor.clone(),
                cursor: generate_cursor,
            });
            mcp_owner
                .generations
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            let (reload, reload_tasks) = start_reload();
            let mut composed = Composed {
                configuration: prepared.disk,
                decision: decisions,
                models: prepared.models,
                credentials: self.credentials.clone(),
                tools: registry,
                agents,
                memory,
                runner,
                steer: self.steer.clone(),
                platform,
                integrations,
                mcp,
                isolated,
                computer,
                commands,
                references,
                skills,
                generate,
                session_generate,
                paired: self.globals.browser.clone(),
                activation,
                reload,
                scope_view,
                extension_diagnostics: Vec::new(),
                plugin_diagnostics,
                plugins,
                launch,
                generation,
                tasks: Mutex::new(reload_tasks),
                watch_stop,
                governor: tokio::sync::Mutex::new(Some(governor)),
                mcp_tools: tokio::sync::Mutex::new(Some(mcp_tools)),
                mcp_owner,
                pending,
                closed: std::sync::atomic::AtomicBool::new(false),
                _registration: registration,
                _meeting: meeting_history,
                _session_tools: session_registration,
            };
            let committed = async {
                let agents_at = {
                    let current = reference.clone();
                    let info = services.info.clone();
                    let agents = composed.agents.clone();
                    let locations = self.locations.get().cloned();
                    Arc::new(move |candidate: &location::Ref| {
                        use ycoding_core::ycoding_schema::DomainEncode;
                        if candidate == &current {
                            return Ok((
                                info.clone(),
                                agents.snapshot().list().into_iter().map(DomainEncode::encode).collect(),
                            ));
                        }
                        let locations = locations
                            .as_ref()
                            .and_then(|locations| locations.upgrade())
                            .ok_or(ycoding_core::extension::Error::Stopped)?;
                        let services = locations
                            .location(
                                candidate.directory.as_lossless(),
                                candidate.workspace_id.as_ref().map(|id| id.as_lossless()),
                            )
                            .map_err(|_| ycoding_core::extension::Error::Stopped)?;
                        Ok((
                            services.info.clone(),
                            services.agents.snapshot().list().into_iter().map(DomainEncode::encode).collect(),
                        ))
                    })
                };
                let plugin_services = ycoding_core::extension::SessionServices {
                    runner: composed.runner.clone(),
                    generate: composed.session_generate.clone(),
                    commands: composed.commands.clone(),
                    configuration: composed.configuration.clone(),
                    reads: Some(ycoding_core::extension::SessionServices::reads(
                        services.info.clone(),
                        composed.references.clone(),
                        composed.skills.clone(),
                        composed.credentials.clone(),
                        composed.activation.clone(),
                        composed.reload.clone(),
                        agents_at,
                    )),
                };
                composed.scope_view.bind(plugin_services.clone())
                    .map_err(|error| Failure::Unavailable(format!("plugin scope binding: {error}")))?;
                composed.activation.plugin_services(plugin_services).await
                    .map_err(|error| Failure::Unavailable(format!("plugin service binding: {error}")))?;
                if let Err(error) = composed.activation.reload(&composed.configuration).await {
                    if self.parent_plugins.is_some() {
                        return Err(Failure::Unavailable(format!("parent plugin setup: {error}")));
                    }
                    tracing::error!(%error, "process extension configuration rejected");
                    composed.extension_diagnostics.push(extension_diagnostic(None, error));
                }
                composed.extension_diagnostics.extend(
                    composed.activation.failures().await.into_iter()
                        .map(|(identity, error)| extension_diagnostic(Some(&identity), error)),
                );
                let domain_extensions = composed.activation.extensions().await;
                let domain_extensions = domain_extensions.iter().map(Arc::as_ref).collect::<Vec<_>>();
                let materialized = tokio::select! {
                    result = tokio::time::timeout(
                        Duration::from_secs(120),
                        resources.materialize(&domain_extensions, None),
                    ) => result.unwrap_or(Err(ycoding_core::extension::Error::Timeout)),
                    () = composed.launch.cancellation.cancelled() => Err(ycoding_core::extension::Error::Cancelled),
                }.map_err(|error| Failure::Unavailable(format!("plugin domain materialization: {error}")))?;
                let configured = ycoding_core::resources::project_artifact::source::Catalogs {
                    agents: post.agents(&materialized.agents)?,
                    commands: post.commands(&materialized.commands)?,
                    skills: post.skills(&materialized.skills)?,
                };
                let mut catalogs = post.artifacts(|standard| *standard = configured).await;
                catalogs.agents.event_source = materialized.agents.event_source.clone();
                catalogs.commands.event_source = materialized.commands.event_source.clone();
                catalogs.skills.event_source = materialized.skills.event_source.clone();
                composed.agents.publish(catalogs.agents);
                composed.commands.publish(catalogs.commands);
                composed.references.publish(post.references(&materialized.references)?);
                *composed.skills.lock().await = catalogs.skills;
                let builtins = composed.activation.builtins().await;
                self.globals.replace_models(&reference,&composed.models, configured_catalog(
                    materialized.catalog,
                    &composed.configuration,
                    &builtins,
                )?).map_err(|_| unavailable("plugin domain catalog"))?;
                composed.plugin_diagnostics = builtins.diagnostic().into_iter().collect();
                composed.plugins = composed.activation.plugin_list().await;
                if previous.is_some() && !composed.extension_diagnostics.is_empty() {
                    return Err(unavailable("process extension replacement"));
                }
                if let Some(previous) = previous {
                    composed
                        .mcp_owner
                        .reload(&previous.configuration, &composed.configuration)
                        .await?;
                    if let Err(error) = composed.mcp_owner.configure(self, &composed.models) {
                        if composed
                            .mcp_owner
                            .reload(&composed.configuration, &previous.configuration)
                            .await
                            .is_err()
                        {
                            tracing::error!("MCP restoration after rejected integrations failed");
                        }
                        return Err(error);
                    }
                }
                composed
                    .mcp_owner
                    .observe(self, services, &composed.configuration, &directory)
                    .await?;
                let skills = composed.skills.lock().await.event_source.clone();
                let catalog = composed.models.catalog();
                let agents = composed.agents.snapshot();
                let commands = composed.commands.snapshot();
                let references = composed.references.snapshot();
                for source in [
                    &composed.configuration.event_source,
                    &catalog.event_source,
                    &agents.event_source,
                    &commands.event_source,
                    &references.event_source,
                    &skills,
                    &composed.activation.event_source,
                ] {
                    source
                        .bind(self.events.clone(), Some(reference.clone()))
                        .map_err(|_| unavailable("Location generation events"))?;
                }
                composed
                    .mcp
                    .bind_events(self.events.clone(), Some(reference.clone()))
                    .map_err(|_| unavailable("MCP events"))?;
                composed
                    .integrations
                    .bind_events(self.events.clone(), Some(reference.clone()))
                    .map_err(|_| unavailable("integration events"))?;
                Ok(())
            }
            .await;
            if let Err(error) = committed {
                return Err(bootstrap_failure(error, composed.close().await));
            }
            composed.scope_view.published();
            composed
                .tasks
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(tokio::spawn(watcher));
            if !composed.activation.extensions().await.is_empty() {
                composed
                    .tasks
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(tokio::spawn(self.forward_plugin_events(
                        composed.activation.clone(),
                        reference.clone(),
                        composed.watch_stop.subscribe(),
                    )));
            }
            if boot {
                let copies = composed.platform.copies.clone();
                let project = services.info.project.id.as_lossless().clone();
                composed
                    .tasks
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(tokio::spawn(async move {
                        if copies.refresh(project).await.is_err() {
                            tracing::warn!("project copy refresh failed");
                        }
                    }));
            }
            Ok(composed)
        }
        .await;
        match result {
            Ok(composed) => Ok(composed),
            Err(error) => {
                if let Some(activation) = staged_activation {
                    activation.close().await;
                }
                let released = if previous.is_none() {
                    release_on_failure.close().await
                } else {
                    Ok(())
                };
                Err(bootstrap_failure(error, released))
            }
        }
    }
}

impl Factory {
    fn forward_plugin_events(
        &self,
        activation: Arc<ycoding_core::extension::Activation>,
        reference: location::Ref,
        mut stopped: watch::Receiver<bool>,
    ) -> crate::dispatch::Boxed<()> {
        let feed = self.events.clone();
        let sessions = Service::new(self.client.clone());
        Box::pin(async move {
            let notify = Arc::new(tokio::sync::Notify::new());
            let subscribe = |feed: &ycoding_core::event_feed::Feed,
                             notify: &Arc<tokio::sync::Notify>| {
                let wake = notify.clone();
                feed.subscribe(ycoding_core::event_feed::Scope::Global, None, move || {
                    wake.notify_one()
                })
            };
            let Ok(mut subscriber) = subscribe(&feed, &notify) else {
                return;
            };
            loop {
                let mut items = Vec::new();
                loop {
                    match subscriber.next() {
                        Ok(Some(item)) => items.push(item),
                        Ok(None) => break,
                        Err(_) => {
                            let Ok(next) = subscribe(&feed, &notify) else {
                                return;
                            };
                            subscriber = next;
                            break;
                        }
                    }
                }
                if !items.is_empty() {
                    let extensions = activation.extensions().await;
                    for item in &items {
                        if let ycoding_core::event_feed::Payload::Durable(event) = &item.payload
                            && let Ok(id) = ycoding_core::ycoding_schema::session::Id::new(
                                event.aggregate_id.clone(),
                            )
                            && !sessions
                                .get(&id)
                                .ok()
                                .flatten()
                                .is_some_and(|session| session.location == reference)
                        {
                            continue;
                        }
                        for extension in &extensions {
                            let _ = extension.publish_feed(item, &reference);
                        }
                    }
                }
                if *stopped.borrow() {
                    return;
                }
                tokio::select! {
                    _ = stopped.changed() => return,
                    _ = notify.notified() => {}
                }
            }
        })
    }

    // Watches this generation's configuration sources. A debounced change rebuilds the
    // Location while this generation is current; a failed rebuild keeps it and keeps watching.
    fn watch(
        &self,
        prepared: &Prepared,
        generation: u64,
        info: location::Info,
        mut stopped: watch::Receiver<bool>,
    ) -> Result<crate::dispatch::Boxed<()>, Failure> {
        use ycoding_core::platform::filesystem::watcher::{Input, Kind};
        let disk = &prepared.disk;
        let directories = disk
            .entries
            .iter()
            .filter_map(|entry| match entry {
                config::Entry::Directory(path)
                | config::Entry::AgentsDirectory(path)
                | config::Entry::ClaudeDirectory(path) => Some(path.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        let files = disk
            .entries
            .iter()
            .filter_map(|entry| match entry {
                config::Entry::File(path)
                | config::Entry::Document {
                    path: Some(path), ..
                } => Some(path.clone()),
                _ => None,
            })
            .filter(|file| {
                !directories
                    .iter()
                    .any(|directory| file.starts_with(directory))
            })
            .collect::<Vec<_>>();
        let legacy = disk
            .entries
            .iter()
            .filter_map(|entry| match entry {
                config::Entry::Directory(path) => Some(path),
                _ => None,
            })
            .flat_map(|directory| [directory.join("plugin"), directory.join("plugins")])
            .collect::<Vec<_>>();
        let subscriptions = directories
            .into_iter()
            .map(|path| (path, Kind::Directory))
            .chain(files.into_iter().map(|path| (path, Kind::File)))
            .filter_map(|(path, kind)| {
                self.globals
                    .watcher
                    .subscribe(Input {
                        ignore: legacy
                            .iter()
                            .filter(|directory| directory.starts_with(&path))
                            .map(|directory| directory.to_string_lossy().into_owned())
                            .collect(),
                        path,
                        kind,
                    })
                    .map_err(
                        |error| tracing::warn!(%error, "configuration source cannot be watched"),
                    )
                    .ok()
            })
            .collect::<Vec<_>>();
        let locations = self.locations.get().cloned();
        let mut models = prepared.models_updated.clone();
        let mut wellknown = prepared.wellknown_updated.clone();
        let notify = Arc::new(tokio::sync::Notify::new());
        let notified = notify.clone();
        let connections = self
            .events
            .subscribe_types(
                ycoding_core::event_feed::Scope::Global,
                &["integration.connection.updated"],
                move || notified.notify_one(),
            )
            .map_err(|_| unavailable("connection source subscription"))?;
        Ok(Box::pin(async move {
            let Some(locations) = locations else { return };
            let (sender, mut updates) = tokio::sync::mpsc::unbounded_channel();
            let mut forwarders = tokio::task::JoinSet::new();
            for mut subscription in subscriptions {
                let sender = sender.clone();
                forwarders.spawn(async move {
                    while subscription.recv().await.is_ok() {
                        if sender.send(()).is_err() {
                            return;
                        }
                    }
                });
            }
            drop(sender);
            loop {
                tokio::select! {
                    _ = stopped.changed() => break,
                    result = models.changed() => if result.is_err() { break; },
                    result = wellknown.changed() => if result.is_err() { break; },
                    _ = notify.notified() => {
                        while let Ok(Some(_)) = connections.next() {}
                    },
                    Some(()) = updates.recv() => {},
                }
                loop {
                    tokio::select! {
                        _ = stopped.changed() => break,
                        _ = tokio::time::sleep(Duration::from_millis(100)) => break,
                        Some(()) = updates.recv() => {},
                    }
                }
                if *stopped.borrow() {
                    break;
                }
                let Some(locations) = locations.upgrade() else {
                    break;
                };
                let info = info.clone();
                match tokio::task::spawn_blocking(move || {
                    locations.reload_generation(&info, generation)
                })
                .await
                {
                    Ok(Ok(_)) => break,
                    Ok(Err(_)) => tracing::error!(
                        "configuration reload failed; the current Location generation stays active"
                    ),
                    Err(_) => tracing::error!("configuration reload worker failed"),
                }
            }
            forwarders.abort_all();
            while forwarders.join_next().await.is_some() {}
        }))
    }
}

impl Factory {
    // The model-facing Session controls need the process-global execution and orchestration
    // owners, which exist only once the production bootstrap installed them.
    fn session_tools(
        &self,
        services: &crate::locations::ServiceSet,
        prepared: &Prepared,
        compaction: &[compaction_policy::Info],
        models: Arc<policy::helper::Models>,
        agents: DomainState<agent::Service>,
        attachments: Arc<attachment_store::Store>,
    ) -> Option<ycoding_core::tools::context::consumers::SessionTools> {
        use ycoding_core::tools::{
            builtin::subagent::Subagent,
            context::consumers::{SessionDependencies, SessionTools},
        };
        let execution = execution::Execution::global()?;
        let orchestration = self
            .orchestration
            .get()?
            .clone()
            .with_review_limit(prepared.configuration.guardrails.limits.reviews as usize);
        let store = Service::new(self.client.clone()).with_artifact_source(prepared.source.clone());
        let source = prepared.source.clone();
        let feed = self.events.clone();
        let location = location::Ref {
            directory: services.info.directory.clone(),
            workspace_id: services.info.workspace_id.clone(),
        };
        Some(SessionTools::new(SessionDependencies {
            subagent: Subagent {
                store: Service::new(self.client.clone()),
                orchestration: Arc::new(orchestration),
                preflight: orchestration::Preflight::new(
                    store.clone(),
                    agents.clone(),
                    prepared.models.clone(),
                    self.credentials.clone(),
                ),
                execution: Arc::new(execution),
                policy: Arc::new(ycoding_core::tools::context::policy::LeafPolicy {
                    permissions: services.permissions.clone(),
                    guardrails: services.guardrails.clone(),
                }),
                jobs: execution.jobs().clone(),
                agents: agents.clone(),
                config: prepared.disk.clone(),
                collator: Arc::new(ycoding_core::platform::filesystem::collation::compare),
                activate: Arc::new(move |context, agent| {
                    let source = source.clone();
                    Box::pin(async move {
                        if source.activate(ycoding_core::resources::project_artifact::source::ActivationInput {
                            kind: ycoding_core::ycoding_schema::project_artifact::Kind::decode(&JsonValue::String("agent".into())).expect("fixed artifact kind"),
                            id: agent.clone(),
                            session_id: context.session_id,
                            agent_id: Some(agent),
                            source: ycoding_core::resources::project_artifact::source::ActivationSource::SubagentLaunch {
                                message_id: context.message_id.as_lossless().clone(),
                                call_id: Some(context.call_id),
                            },
                        }).is_err() {
                            source.record_activation_failure();
                        }
                    })
                }),
            },
            forms: services.forms.clone(),
            decisions: Arc::new(ycoding_core::resources::decision::Service {
                generation: self.globals.generation.clone(),
                clock: self.globals.clock.clone(),
                store,
                agents,
                models,
                executor: self.executor.clone(),
                flights: Default::default(),
            }),
            publish: Arc::new(move |event| {
                let mut publication = crate::services::ephemeral(&event)?;
                publication.location = Some(location.clone());
                feed.publish(publication);
                Ok(())
            }),
            compaction: compaction_policy::resolve(compaction),
            attachments,
        }))
    }
}

impl execution::Locations for Locations {
    fn get(
        &self,
        session: &ycoding_core::ycoding_schema::session::Info,
    ) -> Result<Arc<dyn execution::Runner>, run_coordinator::Error> {
        let services =
            if session.scope == ycoding_core::ycoding_schema::session_scope::Scope::Standalone {
                self.standalone_session(session)
            } else {
                self.location(
                    session.location.directory.as_lossless(),
                    session
                        .location
                        .workspace_id
                        .as_ref()
                        .map(|id| id.as_lossless()),
                )
            }
            .map_err(|_| {
                run_coordinator::Error::Runner(ycoding_core::ycoding_schema::session_error::Error {
                    r#type: "location.unavailable".into(),
                    message: "Location services unavailable".into(),
                })
            })?;
        if services.production.is_none() && services.standalone.is_none() {
            return Err(run_coordinator::Error::Closed);
        }
        Ok(Arc::new(LocationRunner(services)))
    }
}

struct LocationRunner(Arc<LocationServices>);
impl LocationRunner {
    fn runner(services: &LocationServices) -> &runner::Local {
        match &services.standalone {
            Some(standalone) => &standalone.runner,
            None => {
                &services
                    .production
                    .as_ref()
                    .expect("production runner")
                    .runner
            }
        }
    }
}
impl execution::Runner for LocationRunner {
    fn prepare_input(
        &self,
        input: ycoding_core::ycoding_schema::session_pending::Message,
    ) -> execution::PrepareInputFuture<'_> {
        execution::Runner::prepare_input(Self::runner(&self.0), input)
    }
    fn drain(&self, request: DrainRequest) -> RunFuture {
        let lease = self.0.clone();
        Box::pin(async move { execution::Runner::drain(Self::runner(&lease), request).await })
    }
    fn settled(
        &self,
        id: ycoding_core::ycoding_schema::session::Id,
        outcome: run_coordinator::Outcome,
    ) -> RunFuture {
        let lease = self.0.clone();
        Box::pin(async move {
            if let Some(standalone) = &lease.standalone {
                let result =
                    execution::Runner::settled(&standalone.runner, id.clone(), outcome).await;
                lease.pending().cancel(&id);
                return result;
            }
            let composed = lease.production.as_ref().expect("production runner");
            let lifecycle = match &outcome {
                Ok(()) => ycoding_core::platform::browser::service::Lifecycle::ExecutionSucceeded,
                Err(run_coordinator::Error::Interrupted(_)) => {
                    ycoding_core::platform::browser::service::Lifecycle::ExecutionInterrupted
                }
                Err(_) => ycoding_core::platform::browser::service::Lifecycle::ExecutionFailed,
            };
            let browser_id =
                ycoding_core::ycoding_schema::session_id::SessionId::new(id.as_lossless().clone())
                    .map_err(|_| run_coordinator::Error::Closed)?;
            let released = composed.paired.lifecycle(&browser_id, lifecycle).await;
            let settled = execution::Runner::settled(&composed.runner, id, outcome).await;
            released.map_err(|_| run_coordinator::Error::Closed)?;
            settled
        })
    }
}

fn retention_settings(
    options: &config::LoadOptions,
) -> Result<Arc<dyn Fn() -> retention::Settings + Send + Sync>, Failure> {
    let options = options.clone();
    let load = move || {
        let mut options = options.clone();
        if options.content.is_none() {
            options.directory = options.roots.config.clone();
        }
        options.project = false;
        config::Configuration::load(options)
            .map(|configuration| retention::settings(&configuration))
    };
    let last = Arc::new(Mutex::new(load().map_err(global_configuration_error)?));
    Ok(Arc::new(move || {
        let mut last = last.lock().unwrap_or_else(PoisonError::into_inner);
        match load() {
            Ok(settings) => *last = settings,
            Err(_) => tracing::error!(
                "retention configuration reload failed; keeping the last loaded settings"
            ),
        }
        *last
    }))
}

fn reconcile_retention_analytics(
    client: &Client,
    deleted: usize,
) -> Result<(), ycoding_core::ycoding_store::analytics::Error> {
    let pending = client
        .snapshot()?
        .get::<ycoding_core::ycoding_store::analytics::DeliveryTable>(&[])?
        .is_some_and(|state| state.purge_all || !state.purges.is_empty());
    if deleted == 0 && !pending {
        return Ok(());
    }
    client.analytics()?.purge()
}

pub(crate) struct Maintenance {
    stop: watch::Sender<bool>,
    task: Mutex<Option<JoinHandle<()>>>,
    telemetry: Mutex<Option<JoinHandle<()>>>,
    credentials: credential::Service,
    globals: Arc<globals::Globals>,
    cleanups: Mutex<Option<ycoding_core::session::cleanups::Maintenance>>,
    notifications: Mutex<Option<JoinHandle<()>>>,
    coordination: Mutex<Option<crate::coordination::Worker>>,
    goal: Mutex<Option<ycoding_core::session::goal_decisions::Started>>,
    shutdown: Shutdown,
    coordination_shutdown: Shutdown,
    goal_shutdown: Shutdown,
}

impl Maintenance {
    fn new(factory: &Factory) -> Self {
        Self {
            stop: watch::channel(false).0,
            task: Mutex::new(None),
            telemetry: Mutex::new(None),
            credentials: factory.credentials.clone(),
            globals: factory.globals.clone(),
            cleanups: Mutex::new(None),
            notifications: Mutex::new(None),
            coordination: Mutex::new(None),
            goal: Mutex::new(None),
            shutdown: Shutdown::default(),
            coordination_shutdown: Shutdown::default(),
            goal_shutdown: Shutdown::default(),
        }
    }

    async fn attach_coordination(
        &self,
        runtime: ycoding_core::coordination::runtime::Runtime,
        feed: Feed,
    ) -> Result<(), Failure> {
        let worker = crate::coordination::Worker::start(runtime, feed).await?;
        *self
            .coordination
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(worker);
        Ok(())
    }

    async fn attach_goal(
        &self,
        goal: &ycoding_core::session::goal_decisions::GoalDecisions,
        feed: &Feed,
        autonomy: autonomy::Service,
    ) -> Result<(), Failure> {
        let started = goal
            .start(feed, autonomy)
            .map_err(|_| unavailable("Goal decision subscription"))?;
        *self.goal.lock().unwrap_or_else(PoisonError::into_inner) = Some(started);
        Ok(())
    }

    async fn stop_goal(&self) -> Result<(), Failure> {
        self.goal_completion().await
    }

    fn goal_completion(&self) -> Shared<crate::dispatch::Boxed<Result<(), Failure>>> {
        self.goal_shutdown.begin(|| {
            let goal = self
                .goal
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take();
            async move {
                match goal {
                    Some(goal) => goal.shutdown().await.map_err(|error| {
                        Failure::Unavailable(format!(
                            "Goal decision shutdown failed: {:?}",
                            error.failures()
                        ))
                    }),
                    None => Ok(()),
                }
            }
        })
    }

    async fn stop_coordination(&self) -> Result<(), Failure> {
        self.coordination_completion().await
    }

    fn coordination_completion(&self) -> Shared<crate::dispatch::Boxed<Result<(), Failure>>> {
        self.coordination_shutdown.begin(|| {
            let worker = self
                .coordination
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take();
            async move {
                match worker {
                    Some(worker) => worker.stop().await,
                    None => Ok(()),
                }
            }
        })
    }

    async fn housekeeping(&self, factory: &Factory) -> Result<(), Failure> {
        let task =
            ycoding_core::telemetry::Service::new(factory.client.clone(), factory.settings.clone())
                .housekeeping(self.stop.subscribe(), |error| {
                    tracing::warn!(
                        stage = TELEMETRY_PRUNING,
                        cause = error.category(),
                        "Web latency housekeeping will retry"
                    );
                })
                .await
                .map_err(|error| Failure::ServiceUnavailable {
                    service: TELEMETRY_PRUNING,
                    message: error.category().into(),
                })?;
        *self
            .telemetry
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(task);
        Ok(())
    }

    async fn cleanups(&self, factory: &Factory) -> Result<(), Failure> {
        let mut cleanup = ycoding_core::session::cleanups::Maintenance::start(
            ycoding_core::session::cleanups::Cleanups::process(
                factory.client.clone(),
                &factory.options.roots,
                factory.settings.clone(),
            ),
        )
        .await
        .map_err(|_| unavailable("session cleanup startup"))?;
        let mut failed = false;
        for (kind, error) in &cleanup.startup().failures {
            if let Some(cause) = session_cleanup_deferral(error) {
                tracing::warn!(
                    ?kind,
                    cause,
                    "Session cleanup will retry the derived analytics purge"
                );
            } else {
                failed = true;
            }
        }
        if failed {
            let released = cleanup
                .close()
                .await
                .map_err(|_| unavailable("session cleanup shutdown"));
            if released.is_err() {
                tracing::error!("session cleanup shutdown failed");
            }
            return Err(bootstrap_failure(
                unavailable("session cleanup startup"),
                released,
            ));
        }
        *self.cleanups.lock().unwrap_or_else(PoisonError::into_inner) = Some(cleanup);
        Ok(())
    }

    async fn start(
        &self,
        sessions: Service,
        execution: &'static execution::Execution,
        factory: Arc<Factory>,
        autonomy: autonomy::Changes,
        consumers: AutonomyConsumers,
    ) -> Result<(), Failure> {
        self.housekeeping(&factory).await?;
        self.cleanups(&factory).await?;
        let notify = Arc::new(tokio::sync::Notify::new());
        let notified = notify.clone();
        let subscriber = factory
            .events
            .subscribe(ycoding_core::event_feed::Scope::Global, None, move || {
                notified.notify_one()
            })
            .map_err(|_| unavailable("task notifications subscription"))?;
        *self
            .notifications
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(tokio::spawn(notifications(
            self.stop.subscribe(),
            factory.events.clone(),
            subscriber,
            notify,
            autonomy,
            consumers.clone(),
        )));
        self.spawn(
            sessions,
            consumers.locations,
            factory,
            Arc::new(runner::WallClock),
            Arc::new(move || execution.active()),
        );
        Ok(())
    }

    fn spawn(
        &self,
        sessions: Service,
        locations: Locations,
        factory: Arc<Factory>,
        clock: Arc<dyn runner::Clock>,
        active: Arc<dyn Fn() -> Vec<ycoding_core::ycoding_schema::session::Id> + Send + Sync>,
    ) {
        let mut stopped = self.stop.subscribe();
        let mut eviction_stopped = self.stop.subscribe();
        let mut memory_stopped = self.stop.subscribe();
        let task = tokio::spawn(async move {
            let retention = async {
                #[cfg(unix)]
                let mut stages = ycoding_core::resources::staging::Sweep::default();
                loop {
                    if *stopped.borrow() {
                        break;
                    }
                    let mut options = factory.options.clone();
                    if options.content.is_none() {
                        options.directory = options.roots.config.clone();
                    }
                    options.project = false;
                    match config::Configuration::load(options) {
                        Ok(configuration) => {
                            let retaining = active.clone();
                            match sessions
                                .retain(clock.now(), retention::days(&configuration), move || {
                                    retaining()
                                })
                                .await
                            {
                                Ok(sweep) => {
                                    let client = factory.client.clone();
                                    let deleted = sweep.deleted;
                                    if !matches!(
                                        tokio::task::spawn_blocking(move || {
                                            reconcile_retention_analytics(&client, deleted)
                                        })
                                        .await,
                                        Ok(Ok(()))
                                    ) {
                                        tracing::error!(
                                            "retention analytics reconciliation failed"
                                        );
                                    }
                                    if !sweep.failures.is_empty() {
                                        tracing::error!(
                                            failures = sweep.failures.len(),
                                            "session retention families failed"
                                        );
                                    }
                                }
                                Err(_) => tracing::error!("session retention sweep failed"),
                            }
                        }
                        Err(_) => tracing::error!("session retention configuration unavailable"),
                    }
                    #[cfg(unix)]
                    if let Ok(now) = u64::try_from(clock.now()) {
                        let roots = factory.options.roots.clone();
                        let time = std::time::UNIX_EPOCH + std::time::Duration::from_millis(now);
                        match tokio::task::spawn_blocking(move || {
                            let failures = stages.run(&roots.cache, &roots.data, time);
                            (stages, failures)
                        })
                        .await
                        {
                            Ok((cursor, failures)) => {
                                stages = cursor;
                                if failures > 0 {
                                    tracing::warn!(
                                        failures,
                                        "Temporary file cleanup deferred some entries"
                                    );
                                }
                            }
                            Err(_) => {
                                stages = Default::default();
                                tracing::warn!("Temporary file cleanup worker failed");
                            }
                        }
                    }
                    let pruning = active.clone();
                    match sessions.prune_history(clock.now(), move || pruning()).await {
                        Ok(sweep) if sweep.failures.is_empty() => {}
                        Ok(sweep) => tracing::error!(
                            failures = sweep.failures.len(),
                            "compacted Session history pruning failed"
                        ),
                        Err(error) => {
                            tracing::error!(%error, "compacted Session history sweep failed")
                        }
                    }
                    if *stopped.borrow() {
                        break;
                    }
                    tokio::select! {
                        _ = stopped.changed() => break,
                        _ = clock.sleep(60 * 60 * 1000) => {},
                    }
                }
            };
            let eviction = async {
                loop {
                    if *eviction_stopped.borrow() {
                        break;
                    }
                    if locations.evict_idle(Instant::now()).is_err() {
                        tracing::error!("Location eviction failed");
                    }
                    tokio::select! {
                        _ = eviction_stopped.changed() => break,
                        _ = clock.sleep(60 * 1000) => {},
                    }
                }
            };
            let memory = async {
                let mut telemetry = ycoding_core::observability::memory::Telemetry::default();
                loop {
                    if *memory_stopped.borrow() {
                        break;
                    }
                    let (bound, standalone, full) = locations.memory_counts();
                    telemetry.sample(bound, standalone, full, factory.globals.generation.active());
                    tokio::select! {
                        _ = memory_stopped.changed() => break,
                        _ = clock.sleep(60 * 1000) => {},
                    }
                }
            };
            tokio::join!(retention, eviction, memory);
        });
        *self.task.lock().unwrap_or_else(PoisonError::into_inner) = Some(task);
    }

    #[cfg(test)]
    async fn stop(&self) -> Result<(), Failure> {
        self.stop.send_replace(true);
        let goal = self.stop_goal().await;
        let coordination = self.stop_coordination().await;
        let workers = self.stop_workers().await;
        cleanup_results([goal, coordination, workers])
    }

    async fn stop_workers(&self) -> Result<(), Failure> {
        self.stop.send_replace(true);
        self.shutdown
            .run(|| {
                let task = self
                    .task
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .take();
                let notifications = self
                    .notifications
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .take();
                let telemetry = self
                    .telemetry
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .take();
                let cleanups = self
                    .cleanups
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .take();
                async move {
                    let results = [
                        match task {
                            Some(task) => {
                                task.await.map_err(|_| unavailable("runtime maintenance"))
                            }
                            None => Ok(()),
                        },
                        match notifications {
                            Some(task) => task
                                .await
                                .map_err(|_| unavailable("task notifications worker")),
                            None => Ok(()),
                        },
                        match telemetry {
                            Some(task) => task
                                .await
                                .map_err(|_| unavailable("telemetry housekeeping")),
                            None => Ok(()),
                        },
                        match cleanups {
                            Some(mut cleanups) => cleanups
                                .close()
                                .await
                                .map_err(|_| unavailable("session cleanup shutdown")),
                            None => Ok(()),
                        },
                    ];
                    cleanup_results(results)
                }
            })
            .await
    }
}

// Drains the subagent notification outbox after durable task updates. A failed drain leaves the
// rows undelivered for the next update, and feed overflow resubscribes and drains once.
async fn notifications(
    mut stopped: watch::Receiver<bool>,
    feed: Feed,
    mut subscriber: ycoding_core::event_feed::Subscriber,
    notify: Arc<tokio::sync::Notify>,
    mut autonomy: autonomy::Changes,
    consumers: AutonomyConsumers,
) {
    loop {
        tokio::select! {
            _ = stopped.changed() => return,
            changed = autonomy.next() => {
                let Some(id) = changed else { return };
                tokio::select! {
                    _ = stopped.changed() => return,
                    _ = reconcile_autonomy(&consumers, &id) => {}
                }
                continue;
            }
            _ = notify.notified() => {}
        }
        let mut updated = false;
        loop {
            match subscriber.next() {
                Ok(Some(item)) => {
                    updated |= matches!(&item.payload, ycoding_core::event_feed::Payload::Durable(event) if event.type_.as_str() == Some("session.task.updated.1"));
                }
                Ok(None) => break,
                Err(_) => {
                    updated = true;
                    let notified = notify.clone();
                    match feed.subscribe(ycoding_core::event_feed::Scope::Global, None, move || {
                        notified.notify_one()
                    }) {
                        Ok(resubscribed) => subscriber = resubscribed,
                        Err(_) => {
                            tracing::error!("task notification subscription failed");
                            return;
                        }
                    }
                    break;
                }
            }
        }
        if updated
            && consumers
                .orchestration
                .dispatch_notifications()
                .await
                .is_err()
        {
            tracing::error!(
                "subagent notification outbox dispatch failed; retrying after the next task update"
            );
        }
    }
}

#[derive(Clone)]
struct AutonomyConsumers {
    locations: Locations,
    orchestration: orchestration::Service,
    reviews: ycoding_core::session::review::Service,
}

async fn reconcile_autonomy(consumers: &AutonomyConsumers, id: &session::Id) {
    let AutonomyConsumers {
        locations,
        orchestration,
        reviews,
    } = consumers;
    let (session, services) = match locations.session(id) {
        Ok(located) => located,
        Err(error) => {
            tracing::warn!(?error, "Unable to locate autonomy consumers");
            return;
        }
    };
    if session.scope == ycoding_core::ycoding_schema::session_scope::Scope::Standalone
        || session.time.archived.is_some()
    {
        return;
    }
    if let Err(error) = services.permissions.reconcile_autonomy(id) {
        tracing::warn!(?error, "Unable to reconcile permission autonomy");
    }
    if let Err(error) = services.guardrails.reconcile_autonomy(id) {
        tracing::warn!(?error, "Unable to reconcile guardrail autonomy");
    }
    if let Err(error) = services.questions.reconcile_autonomy(id).await {
        tracing::warn!(?error, "Unable to reconcile question autonomy");
    }
    if let Err(error) = services.forms.reconcile_autonomy(id).await {
        tracing::warn!(?error, "Unable to reconcile form autonomy");
    }
    if let Err(error) = orchestration.reconcile_autonomy(id).await {
        tracing::warn!(?error, "Unable to reconcile child-question autonomy");
    }
    let questions = &services.questions;
    let forms = &services.forms;
    if let Err(error) = reviews
        .reconcile_answers(id, ids::now_millis(), |item| async move {
            use ycoding_schema::session_review::{Answers, Payload};
            match item.deferral.payload {
                Payload::Question(payload) => {
                    let request = ycoding_schema::question::Request {
                        id: ycoding_schema::question::Id::decode(&JsonValue::String(
                            format!(
                                "que_{}",
                                item.deferral
                                    .item_id
                                    .as_lossless()
                                    .to_utf8()
                                    .unwrap_or_default()
                            )
                            .into(),
                        ))
                        .ok()?,
                        session_id: item.session_id,
                        questions: payload.questions,
                        tool: None,
                    };
                    questions
                        .yolo_answers(&request)
                        .await
                        .map(Answers::Questions)
                }
                Payload::Form(payload) => {
                    let info = ycoding_schema::form::Info::decode(
                        &ObjectEncoder::new()
                            .field(
                                "id",
                                format!(
                                    "frm_{}",
                                    item.deferral
                                        .item_id
                                        .as_lossless()
                                        .to_utf8()
                                        .unwrap_or_default()
                                )
                                .as_str(),
                            )
                            .field("sessionID", &item.session_id)
                            .field("title", &payload.title)
                            .field("fields", &payload.fields)
                            .finish(),
                    )
                    .ok()?;
                    forms.yolo_answer(&info).await.map(Answers::Form)
                }
                _ => None,
            }
        })
        .await
    {
        tracing::warn!(?error, "Unable to reconcile deferred answers");
    }
    if let Err(error) = reviews.reconcile_autonomy(id, ids::now_millis()).await {
        tracing::warn!(?error, "Unable to supersede autonomy reviews");
    }
}

impl Composed {
    async fn stop_tasks(&self) -> Result<(), Failure> {
        self.watch_stop.send_replace(true);
        let tasks = std::mem::take(&mut *self.tasks.lock().unwrap_or_else(PoisonError::into_inner));
        let mut failure = None;
        for task in tasks {
            if task.await.is_err() {
                failure.get_or_insert_with(|| unavailable("Location worker settlement"));
            }
        }
        failure.map_or(Ok(()), Err)
    }
    pub(crate) fn in_use(&self) -> bool {
        // The browser tool of this generation holds one isolated-browser reference.
        Arc::strong_count(&self.platform) > 1
            || self.pending.in_use()
            || (self
                .mcp_owner
                .generations
                .load(std::sync::atomic::Ordering::Acquire)
                == 1
                && Arc::strong_count(&self.mcp) > Arc::strong_count(&self.mcp_owner) + 1)
            || Arc::strong_count(&self.isolated)
                > 2 * self
                    .mcp_owner
                    .generations
                    .load(std::sync::atomic::Ordering::Acquire)
    }
    pub(crate) async fn close(&self) -> Result<(), Failure> {
        if self.closed.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return Ok(());
        }
        self.scope_view.retire();
        self.pending.shutdown();
        let tasks = self.stop_tasks().await;
        self.launch.cancellation.cancel();
        self.activation.close().await;
        self.scope_view.drain().await;
        self.scope_view.clear();
        // A watcher that ended on a registration failure kept the previous tool batch; it is
        // reported here instead of failing the Location close.
        if let Some(tools) = self.mcp_tools.lock().await.take()
            && let Err(error) = tools.stop().await
        {
            tracing::error!(?error, "MCP tool watcher ended with an error");
        }
        let governor = match self.governor.lock().await.take() {
            Some(governor) => governor
                .close()
                .await
                .map_err(|_| unavailable("project artifact governor")),
            None => Ok(()),
        };
        let last = self
            .mcp_owner
            .generations
            .fetch_sub(1, std::sync::atomic::Ordering::AcqRel)
            == 1;
        let isolated = if last {
            self.isolated
                .shutdown()
                .await
                .map_err(|_| unavailable("isolated browser shutdown"))
        } else {
            Ok(())
        };
        let computer = if last {
            self.computer
                .release_location()
                .await
                .map_err(|_| unavailable("computer Location release"))
        } else {
            Ok(())
        };
        let mcp = if last {
            self.mcp_owner.close().await
        } else {
            Ok(())
        };
        let shell = if last {
            self.platform
                .shell
                .shutdown()
                .await
                .map_err(|_| unavailable("shell shutdown"))
        } else {
            Ok(())
        };
        let pty = if last {
            self.platform
                .pty
                .shutdown()
                .await
                .map_err(|_| unavailable("PTY shutdown"))
        } else {
            Ok(())
        };
        tasks
            .and(governor)
            .and(isolated)
            .and(computer)
            .and(mcp)
            .and(shell)
            .and(pty)
    }
}

impl Drop for Maintenance {
    fn drop(&mut self) {
        self.stop.send_replace(true);
        for task in [self.task.get_mut(), self.notifications.get_mut()] {
            if let Some(task) = task.unwrap_or_else(PoisonError::into_inner).take() {
                task.abort();
            }
        }
    }
}

struct SkillResolver(Arc<tokio::sync::Mutex<ycoding_core::resources::skill::Service>>);

async fn reconcile(sessions: &Service, client: &Client) -> Result<(), Failure> {
    sessions
        .reconcile_interrupted(crate::ids::now_millis())
        .await
        .map_err(|_| unavailable("interrupted steps"))?;
    let reconciled = ycoding_core::platform::shell::ledger::Ledger::new(client.clone())
        .reconcile(ycoding_core::platform::shell::ledger::TERMINATE_GRACE)
        .await
        .map_err(|_| unavailable("shell ledger"))?;
    if reconciled.process_list_unavailable || !reconciled.signal_failures.is_empty() {
        return Err(unavailable("shell process reconciliation"));
    }
    Ok(())
}

impl ycoding_core::session::skill::Resolver for SkillResolver {
    fn list(&self) -> ycoding_core::session::skill::SkillsFuture<'_> {
        Box::pin(async move {
            self.0
                .lock()
                .await
                .list()
                .await
                .map_err(|error| error.to_string())
        })
    }
    fn instructions<'a>(
        &'a self,
        info: &'a ycoding_core::ycoding_schema::skill::Info,
    ) -> ycoding_core::session::skill::InstructionsFuture<'a> {
        Box::pin(async move {
            Ok(ycoding_core::tools::builtin::skill::to_model_output(
                info,
                &[],
            ))
        })
    }
}

fn configured_rules(
    disk: &config::Configuration,
    home: &std::path::Path,
) -> Result<Vec<ycoding_core::ycoding_schema::permission::Rule>, Failure> {
    let home = home
        .to_str()
        .ok_or_else(|| unavailable("home directory"))?
        .into();
    disk.entries
        .iter()
        .filter_map(|entry| match entry {
            config::Entry::Document {
                info: JsonValue::Object(document),
                ..
            } => document.get(&"permissions".into()),
            _ => None,
        })
        .map(|value| {
            Vec::<ycoding_core::ycoding_schema::permission::Rule>::decode(value)
                .map(|rules| ycoding_core::tools::policy::expand_permissions(&rules, &home))
                .map_err(|_| unavailable("permission configuration"))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|groups| groups.into_iter().flatten().collect())
}

struct ConfigurationStage {
    disk: Arc<config::Configuration>,
    home: std::path::PathBuf,
    directory: std::path::PathBuf,
    references: reference::Service,
    artifacts: ycoding_core::resources::project_artifact::source::Service,
    standard: tokio::sync::Mutex<ycoding_core::resources::project_artifact::source::Catalogs>,
}

impl ConfigurationStage {
    fn agents(&self, transformed: &agent::Service) -> Result<agent::Service, Failure> {
        let mut configured = agent::Service::from_entries(
            &self.disk.entries,
            &self.home,
            transformed.list().into_iter().cloned().collect(),
            &mut vec![],
        )
        .map_err(|_| unavailable("agent configuration"))?;
        if configured.default_id().is_none() {
            configured.set_default(transformed.default_id().cloned());
        }
        Ok(configured)
    }

    fn commands(&self, transformed: &command::Service) -> Result<command::Service, Failure> {
        let mut configured = transformed.clone();
        configured.event_source = Default::default();
        configured
            .configure_entries(&self.disk.entries, &mut vec![])
            .map_err(|_| unavailable("command configuration"))?;
        Ok(configured)
    }

    fn skills(&self, transformed: &skill::Service) -> Result<skill::Service, Failure> {
        let mut configured = transformed.clone();
        configured.event_source = Default::default();
        configured
            .configure(&self.disk.entries, &self.directory, &self.home)
            .map_err(|_| unavailable("skill configuration"))?;
        Ok(configured)
    }

    fn references(&self, transformed: &reference::Service) -> Result<reference::Service, Failure> {
        let mut configured = transformed.clone();
        configured.event_source = Default::default();
        configured
            .replace(
                transformed
                    .list()
                    .iter()
                    .filter(|reference| {
                        !self
                            .references
                            .list()
                            .iter()
                            .any(|item| item.name == reference.name)
                    })
                    .chain(self.references.list())
                    .cloned()
                    .collect(),
            )
            .map_err(|_| unavailable("reference configuration"))?;
        configured.event_source = transformed.event_source.clone();
        Ok(configured)
    }

    async fn artifacts(
        &self,
        update: impl FnOnce(&mut ycoding_core::resources::project_artifact::source::Catalogs),
    ) -> ycoding_core::resources::project_artifact::source::Catalogs {
        let mut standard = self.standard.lock().await;
        update(&mut standard);
        self.artifacts.replace_standard(standard.clone()).await;
        self.artifacts.catalogs().await
    }
}

fn configured_catalog(
    mut catalog: catalog::Catalog,
    disk: &config::Configuration,
    builtins: &ycoding_core::extension::plugin::Builtins,
) -> Result<catalog::Catalog, Failure> {
    catalog
        .configure(
            &disk
                .entries
                .iter()
                .filter_map(|entry| match entry {
                    config::Entry::Document { info, .. } => Some(info.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>(),
        )
        .and_then(|()| catalog.settle_builtins(builtins))
        .map_err(|_| unavailable("catalog configuration"))?;
    Ok(catalog)
}

fn extension_diagnostic(
    identity: Option<&str>,
    error: ycoding_core::extension::Error,
) -> ycoding_core::ycoding_schema::config::Diagnostic {
    ycoding_core::ycoding_schema::config::Diagnostic {
        path: "extensions".into(),
        reason: ycoding_core::ycoding_schema::config::DiagnosticReason("invalid-values".into()),
        json_path: None,
        fail_closed: Some(true),
        message: match identity {
            Some(identity) => format!("Process extension {identity} did not start: {error}"),
            None => error.to_string(),
        }
        .into(),
    }
}

fn field<'a>(value: Option<&'a JsonValue>, key: &str) -> Option<&'a JsonValue> {
    match value {
        Some(JsonValue::Object(value)) => value.get(&key.into()),
        _ => None,
    }
}
fn unavailable(service: &'static str) -> Failure {
    Failure::Unavailable(format!("{service} unavailable"))
}

pub(crate) const GLOBAL_CONFIGURATION: &str = "global configuration";
pub(crate) const TELEMETRY_PRUNING: &str = "telemetry pruning";

fn session_cleanup_deferral(
    error: &ycoding_core::session::cleanups::Error,
) -> Option<&'static str> {
    use ycoding_core::{session::cleanups::Error, ycoding_store::analytics};

    match error {
        Error::Analytics(analytics::Error::Deadline) => {
            Some("analytics maintenance deadline exceeded")
        }
        Error::Analytics(error) if ycoding_core::telemetry::derived_engine_unavailable(error) => {
            Some("analytics engine unavailable")
        }
        _ => None,
    }
}

fn global_configuration_error(error: config::Error) -> Failure {
    use std::error::Error as _;

    eprintln!(
        "production composition diagnostic: stage={GLOBAL_CONFIGURATION}; category=unavailable"
    );
    let cause = match error
        .source()
        .and_then(|cause| cause.downcast_ref::<std::io::Error>())
    {
        Some(cause) if cause.kind() == std::io::ErrorKind::NotFound => {
            "a configuration file or referenced file was not found"
        }
        Some(cause) if cause.kind() == std::io::ErrorKind::PermissionDenied => {
            "a configuration file or referenced file could not be read because access was denied"
        }
        Some(cause) if cause.kind() == std::io::ErrorKind::IsADirectory => {
            "a configuration file or referenced file points to a directory"
        }
        Some(_) => "a configuration file or referenced file could not be read",
        None => "the configuration could not be loaded",
    };
    Failure::ServiceUnavailable {
        service: GLOBAL_CONFIGURATION,
        message: format!("{cause}. Check the global configuration and any files it references."),
    }
}
