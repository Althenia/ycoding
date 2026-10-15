mod composition;
mod controls;
mod globals;
mod mcp_owner;
mod meeting;
mod observer;
mod refresh;
#[cfg(test)]
mod tests;
mod tools;

use crate::{
    Configuration, Core, LocationServices, Locations, SnapshotSettings, dispatch::Failure,
};
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
        command, config, credential, cursor, generate, mcp, memory, model, reference, skill,
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
    ycoding_schema::{DomainDecode, JsonValue, LosslessString, location},
    ycoding_store::Client,
};

pub struct Production {
    pub configuration: config::LoadOptions,
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
    pub models: Arc<model::Resolver>,
    pub credentials: credential::Service,
    pub tools: Arc<Registry>,
    pub memory: Arc<memory::Service>,
    pub runner: runner::Local,
    pub steer: Option<Arc<dyn autonomy::Steer>>,
    pub platform: Arc<crate::services::PlatformServices>,
    pub integrations: auth::integration::Registry,
    pub mcp: Arc<mcp::Service>,
    pub isolated: Arc<ycoding_core::platform::browser::isolated::Service>,
    pub computer: Arc<ycoding_core::platform::computer::service::Service>,
    paired: Arc<ycoding_core::platform::browser::service::Service>,
    pub commands: Arc<command::Service>,
    pub references: Arc<reference::Service>,
    pub skills: Arc<tokio::sync::Mutex<skill::Service>>,
    pub generate: Arc<generate::Service>,
    pub session_generate: Arc<ycoding_core::session::generate::Service>,
    pub activation: Arc<ycoding_core::extension::Activation>,
    pub extension_diagnostics: Vec<ycoding_core::ycoding_schema::config::Diagnostic>,
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
    commands: Arc<command::Service>,
    skills: Arc<tokio::sync::Mutex<skill::Service>>,
    refresh: reference::Refresh,
    models_updated: watch::Receiver<u64>,
    wellknown_updated: watch::Receiver<u64>,
}

pub(crate) struct Factory {
    options: config::LoadOptions,
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

#[derive(Default)]
struct Started {
    execution: Option<&'static execution::Execution>,
    locations: Option<Locations>,
    maintenance: Option<Arc<Maintenance>>,
}

impl Core {
    pub async fn production(client: Client, production: Production) -> Result<Self, Failure> {
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
        ) {
            Ok(globals) => globals,
            Err(error) => {
                if credentials.shutdown().await.is_err() {
                    tracing::error!("credential release after a failed bootstrap failed");
                }
                return Err(error);
            }
        };
        let mut started = Started::default();
        match Self::bootstrap(
            client,
            production,
            credentials.clone(),
            events,
            git,
            globals.clone(),
            &mut started,
        )
        .await
        {
            Ok(core) => Ok(core),
            Err(error) => {
                let released = release(
                    &globals,
                    &credentials,
                    started.execution,
                    started.locations.as_ref(),
                    started.maintenance.as_deref(),
                )
                .await;
                if released.is_err() {
                    tracing::error!("releasing owners after a failed bootstrap failed");
                }
                Err(error)
            }
        }
    }

    async fn bootstrap(
        client: Client,
        production: Production,
        credentials: credential::Service,
        events: Feed,
        git: Arc<git::Service>,
        globals: Arc<globals::Globals>,
        started: &mut Started,
    ) -> Result<Self, Failure> {
        globals.catalog.get().await.map_err(|error| {
            eprintln!("production composition diagnostic: stage=model catalog; category={error:?}");
            Failure::Unavailable("model catalog unavailable".into())
        })?;
        let feed = events.clone();
        let factory = Arc::new(Factory {
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
        global.directory = global.roots.config.clone();
        global.project = false;
        let global =
            config::Configuration::load(global).map_err(|_| unavailable("global configuration"))?;
        let configuration = factory.configuration(&global)?;
        let sessions = Service::new(client.clone());
        reconcile(&sessions, &client).await?;
        let autonomy = autonomy::Service::new(client.clone());
        let locations = Locations::new(
            client.clone(),
            sessions.clone(),
            configuration,
            events.clone(),
            autonomy.clone(),
        )
        .with_factory(factory.clone());
        started.locations = Some(locations.clone());
        let _ = factory.locations.set(locations.downgrade());
        let _ = factory.globals.locations.set(locations.downgrade());
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
        let orchestration = orchestration::Service::new(
            sessions.clone(),
            Arc::new(crate::services::LocalExecution(execution)),
        );
        let _ = factory.orchestration.set(orchestration.clone());
        orchestration
            .reconcile_stale()
            .await
            .map_err(|_| unavailable("stale tasks"))?;
        orchestration
            .dispatch_notifications()
            .await
            .map_err(|_| unavailable("notification outbox"))?;
        let publisher = factory.publisher.clone();
        let credentials = factory.credentials.clone();
        let pricing_locations = locations.clone();
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
        let usage_locations = locations.clone();
        let quota = Arc::new(factory.globals.claude.quota.clone());
        let provider_usage = Arc::new(move |info: &location::Info| {
            let services = usage_locations
                .location(
                    info.directory.as_lossless(),
                    info.workspace_id.as_ref().map(|id| id.as_lossless()),
                )
                .map_err(|_| "Location services unavailable".to_owned())?;
            let composed = services
                .production
                .as_ref()
                .ok_or_else(|| "Production services unavailable".to_owned())?;
            Ok(crate::services::ProviderUsageServices {
                quota: quota.clone(),
                providers: composed
                    .models
                    .catalog()
                    .providers
                    .iter()
                    .map(|record| record.provider.id.clone())
                    .collect(),
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
        started.maintenance = Some(maintenance.clone());
        maintenance
            .start(
                sessions.clone(),
                execution,
                locations.clone(),
                factory,
                orchestration.clone(),
            )
            .await?;
        Ok(Self {
            integrations: Some(integrations),
            mcp: Some(mcp),
            catalogs: Some(catalogs),
            artifacts: Some(artifacts),
            remote: Some(remote),
            publisher,
            credentials,
            browser: Some(browser),
            isolated_browser: Some(isolated),
            platform: Some(platform),
            platform_default_location: None,
            telemetry: ycoding_core::telemetry::Service::new(client),
            keep_awake: ycoding_core::platform::keep_awake::Service::new(),
            provider_usage: Some(provider_usage),
            usage_pricer: Some(Arc::new(move |reference| {
                pricing_locations.pricing(reference)
            })),
            sessions: sessions.clone(),
            execution,
            autonomy,
            events,
            locations,
            orchestration,
            maintenance: Some(maintenance),
        })
    }

    pub async fn shutdown(&self) -> Result<(), Failure> {
        if let Some(maintenance) = &self.maintenance {
            return release(
                &maintenance.globals,
                &maintenance.credentials,
                Some(self.execution),
                Some(&self.locations),
                Some(maintenance.as_ref()),
            )
            .await;
        }
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
        execution.and(jobs).and(self.locations.close())
    }
}

// Producers of execution work stop first and the composition runtime that hosts spawned owners
// stops last; every step runs even after a failure, and the first failure is returned.
async fn release(
    globals: &globals::Globals,
    credentials: &credential::Service,
    execution: Option<&'static execution::Execution>,
    locations: Option<&Locations>,
    maintenance: Option<&Maintenance>,
) -> Result<(), Failure> {
    let results = [
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
            Some(maintenance) => maintenance.stop().await,
            None => Ok(()),
        },
        globals.stop_controls().await,
        locations.map_or(Ok(()), Locations::close),
        globals.close().await,
        credentials
            .shutdown()
            .await
            .map_err(|_| unavailable("credentials")),
        globals.composition.close(),
    ];
    results.into_iter().find(Result::is_err).unwrap_or(Ok(()))
}

impl Factory {
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
            if let Some(composed) = &services.production {
                composed.close().await?;
            }
            Ok(())
        })
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
        let mut options = self.options.clone();
        options.directory = directory
            .to_utf8()
            .map_err(|_| unavailable("Location directory"))?
            .into();
        let models_updated = self.globals.catalog.refreshed();
        let wellknown_updated = self.globals.wellknown.updated();
        let sources = self.globals.composition.run(async {
            self.globals
                .wellknown
                .configuration(&self.credentials)
                .await
                .map_err(|_| unavailable("WellKnown configuration"))
        })?;
        let disk = Arc::new(
            config::Configuration::load_with_sources(options, sources)
                .map_err(|_| unavailable("Location configuration"))?
                .with_mutation_policy(config::MutationPolicy(Arc::new(|_| true))),
        );
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
        let commands = command::Service::from_entries(&disk.entries, &mut vec![])
            .map_err(|_| unavailable("command catalog"))?;
        let skills = skill::Service::from_entries(
            &disk.entries,
            &location_directory,
            &roots.home,
            &roots.cache,
        )
        .map_err(|_| unavailable("skill catalog"))?;
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
            ycoding_core::resources::project_artifact::source::Catalogs {
                agents: (*configuration.agents).clone(),
                commands,
                skills,
            },
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
            commands: Arc::new(catalogs.commands),
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

    fn configuration(&self, disk: &config::Configuration) -> Result<Configuration, Failure> {
        let roots = &self.options.roots;
        let mut builtins =
            agent::builtin::catalog(roots).map_err(|_| unavailable("built-in agent catalog"))?;
        if self.globals.meetings.enabled() {
            builtins.push(ycoding_core::session::analysis::analysis_agent());
        }
        let agents = Arc::new(
            agent::Service::from_entries(&disk.entries, &roots.home, builtins, &mut vec![])
                .map_err(|_| unavailable("agent configuration"))?,
        );
        let mut limits = Limits::default();
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
                    let copies = Arc::new(
                        ycoding_core::platform::project_copy::Copies::new(
                            &directory,
                            self.git.clone(),
                            self.client.clone(),
                            self.publisher.clone(),
                        )
                        .map_err(|_| unavailable("project copies"))?,
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
            let commands = prepared.commands.clone();
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
                    skills: skills.clone(),
                    mcp: &mcp,
                    artifacts: prepared.source.clone(),
                },
            )?;
            let clock: Arc<dyn runner::Clock> = Arc::new(runner::WallClock);
            let instruction_clock = clock.clone();
            let mut instructions = ycoding_core::instructions::builtins::load(
                ycoding_core::instructions::builtins::Environment {
                    directory: directory.to_string_lossy().into_owned(),
                    project_root: project.to_string_lossy().into_owned(),
                    git: repository.is_some(),
                    platform: std::env::consts::OS.into(),
                },
                Arc::new(move || instruction_clock.now()),
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
            let helper_models = Arc::new(policy::helper::Models {
                models: prepared.models.clone(),
                credentials: self.credentials.clone(),
                auth: self.globals.preparation.clone(),
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
            let session_tools =
                self.session_tools(services, &prepared, &compaction, helper_models.clone());
            let session_registration = session_tools
                .as_ref()
                .map(|tools| {
                    registry.register(
                        tools.clone().entries(),
                        ycoding_core::tools::registry::Options::direct(),
                    )
                })
                .transpose()
                .map_err(|_| unavailable("Session tool registration"))?;
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
                execution::Execution::global().map(|execution| {
                    ycoding_core::tools::builtin::mcp::Background {
                        jobs: execution.jobs().clone(),
                        notifier: runner::mcp_notifier(
                            Service::new(self.client.clone()),
                            Arc::new(runner::WallClock),
                            Arc::new(move |id| execution.wake(id)),
                        ),
                    }
                }),
            );
            let activation = Arc::new(ycoding_core::extension::Activation::new(
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
                                Ok(ycoding_core::extension::SessionServices {
                                    runner: composed.runner.clone(),
                                    generate: composed.session_generate.clone(),
                                    commands: composed.commands.clone(),
                                    configuration: composed.configuration.clone(),
                                })
                            }
                        })),
                    }),
                },
            ));
            let mut extension_diagnostics = Vec::new();
            if let Err(error) = activation.reload(&prepared.disk).await {
                tracing::error!(%error, "process extension configuration rejected");
                extension_diagnostics.push(extension_diagnostic(None, error));
            }
            extension_diagnostics.extend(
                activation
                    .failures()
                    .await
                    .into_iter()
                    .map(|(identity, error)| extension_diagnostic(Some(&identity), error)),
            );
            let plugins = activation.plugin_list().await;
            let extensions = activation.extensions().await;
            let instruction_context = ycoding_core::session::instruction_assembly::Context {
                configuration: prepared.disk.clone(),
                registry: registry.clone(),
                skills: skills.clone(),
                references: references.clone(),
                mcp: Arc::downgrade(&mcp),
            };
            let refresh = self.refresh(services.info.clone());
            let title = Arc::new(ycoding_core::session::title::Service::new(
                Service::new(self.client.clone()).with_artifact_source(prepared.source.clone()),
                services.agents.clone(),
                helper_models.clone(),
                self.executor.clone(),
            ));
            let session_generate = Arc::new(ycoding_core::session::generate::Service {
                store: Service::new(self.client.clone())
                    .with_artifact_source(prepared.source.clone()),
                location: reference.clone(),
                agents: services.agents.clone(),
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
                agents: services.agents.clone(),
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
                executor: self.executor.clone(),
                compaction: compaction_policy::resolve(&compaction),
                guardrails: services.guardrails.clone(),
                helpers,
                cursor,
                claude: Some(self.globals.claude.clone()),
                auth: Some(self.globals.preparation.clone()),
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
            let composed = Composed {
                configuration: prepared.disk,
                models: prepared.models,
                credentials: self.credentials.clone(),
                tools: registry,
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
                extension_diagnostics,
                plugins,
                launch,
                generation,
                tasks: Mutex::new(Vec::new()),
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
                for source in [
                    &composed.configuration.event_source,
                    &catalog.event_source,
                    &services.agents.event_source,
                    &composed.commands.event_source,
                    &composed.references.event_source,
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
                if composed.close().await.is_err() {
                    tracing::error!("failed Location replacement release failed");
                }
                return Err(error);
            }
            composed
                .tasks
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(tokio::spawn(watcher));
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
        if result.is_err() && previous.is_none() && release_on_failure.close().await.is_err() {
            tracing::error!("failed initial Location owner release failed");
        }
        result
    }
}

impl Factory {
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
        let subscriptions = directories
            .into_iter()
            .map(|path| (path, Kind::Directory))
            .chain(files.into_iter().map(|path| (path, Kind::File)))
            .filter_map(|(path, kind)| {
                self.globals
                    .watcher
                    .subscribe(Input {
                        path,
                        kind,
                        ignore: vec![],
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
    ) -> Option<ycoding_core::tools::context::consumers::SessionTools> {
        use ycoding_core::tools::{
            builtin::subagent::Subagent,
            context::consumers::{SessionDependencies, SessionTools},
        };
        let execution = execution::Execution::global()?;
        let orchestration = self.orchestration.get()?.clone();
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
                    services.agents.clone(),
                    prepared.models.clone(),
                    self.credentials.clone(),
                ),
                execution: Arc::new(execution),
                policy: Arc::new(ycoding_core::tools::context::policy::LeafPolicy {
                    permissions: services.permissions.clone(),
                    guardrails: services.guardrails.clone(),
                }),
                jobs: execution.jobs().clone(),
                agents: services.agents.clone(),
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
                store,
                agents: services.agents.clone(),
                models,
                executor: self.executor.clone(),
            }),
            publish: Arc::new(move |event| {
                let mut publication = crate::services::ephemeral(&event)?;
                publication.location = Some(location.clone());
                feed.publish(publication);
                Ok(())
            }),
            compaction: compaction_policy::resolve(compaction),
        }))
    }
}

impl execution::Locations for Locations {
    fn get(
        &self,
        reference: &location::Ref,
    ) -> Result<Arc<dyn execution::Runner>, run_coordinator::Error> {
        let services = self
            .location(
                reference.directory.as_lossless(),
                reference.workspace_id.as_ref().map(|id| id.as_lossless()),
            )
            .map_err(|_| {
                run_coordinator::Error::Runner(ycoding_core::ycoding_schema::session_error::Error {
                    r#type: "location.unavailable".into(),
                    message: "Location services unavailable".into(),
                })
            })?;
        if services.production.is_none() {
            return Err(run_coordinator::Error::Closed);
        }
        Ok(Arc::new(LocationRunner(services)))
    }
}

struct LocationRunner(Arc<LocationServices>);
impl execution::Runner for LocationRunner {
    fn prepare_input(
        &self,
        input: ycoding_core::ycoding_schema::session_pending::Message,
    ) -> execution::PrepareInputFuture<'_> {
        execution::Runner::prepare_input(
            &self
                .0
                .production
                .as_ref()
                .expect("production runner")
                .runner,
            input,
        )
    }
    fn drain(&self, request: DrainRequest) -> RunFuture {
        let lease = self.0.clone();
        Box::pin(async move {
            execution::Runner::drain(
                &lease.production.as_ref().expect("production runner").runner,
                request,
            )
            .await
        })
    }
    fn settled(
        &self,
        id: ycoding_core::ycoding_schema::session::Id,
        outcome: run_coordinator::Outcome,
    ) -> RunFuture {
        let lease = self.0.clone();
        Box::pin(async move {
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

pub(crate) struct Maintenance {
    stop: watch::Sender<bool>,
    task: Mutex<Option<JoinHandle<()>>>,
    credentials: credential::Service,
    globals: Arc<globals::Globals>,
    cleanups: tokio::sync::Mutex<Option<ycoding_core::session::cleanups::Maintenance>>,
    notifications: Mutex<Option<JoinHandle<()>>>,
}

impl Maintenance {
    fn new(factory: &Factory) -> Self {
        Self {
            stop: watch::channel(false).0,
            task: Mutex::new(None),
            credentials: factory.credentials.clone(),
            globals: factory.globals.clone(),
            cleanups: tokio::sync::Mutex::new(None),
            notifications: Mutex::new(None),
        }
    }

    async fn start(
        &self,
        sessions: Service,
        execution: &'static execution::Execution,
        locations: Locations,
        factory: Arc<Factory>,
        orchestration: orchestration::Service,
    ) -> Result<(), Failure> {
        let mut cleanup = ycoding_core::session::cleanups::Maintenance::start(
            ycoding_core::session::cleanups::Cleanups::process(
                factory.client.clone(),
                &factory.options.roots,
            ),
        )
        .await
        .map_err(|_| unavailable("session cleanup startup"))?;
        if !cleanup.startup().failures.is_empty() {
            if cleanup.close().await.is_err() {
                tracing::error!("session cleanup shutdown failed");
            }
            return Err(unavailable("session cleanup startup"));
        }
        *self.cleanups.lock().await = Some(cleanup);
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
            orchestration,
        )));
        self.spawn(
            sessions,
            locations,
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
        let task = tokio::spawn(async move {
            let retention = async {
                loop {
                    if *stopped.borrow() {
                        break;
                    }
                    let mut options = factory.options.clone();
                    options.directory = options.roots.config.clone();
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
                                    if tokio::task::spawn_blocking(move || {
                                        client.analytics().and_then(|analytics| analytics.purge())
                                    })
                                    .await
                                    .is_err()
                                    {
                                        tracing::error!("retention analytics purge worker failed");
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
            tokio::join!(retention, eviction);
        });
        *self.task.lock().unwrap_or_else(PoisonError::into_inner) = Some(task);
    }

    async fn stop(&self) -> Result<(), Failure> {
        self.stop.send_replace(true);
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
        let results = [
            match task {
                Some(task) => task.await.map_err(|_| unavailable("runtime maintenance")),
                None => Ok(()),
            },
            match notifications {
                Some(task) => task
                    .await
                    .map_err(|_| unavailable("task notifications worker")),
                None => Ok(()),
            },
            match self.cleanups.lock().await.take() {
                Some(mut cleanups) => cleanups
                    .close()
                    .await
                    .map_err(|_| unavailable("session cleanup shutdown")),
                None => Ok(()),
            },
        ];
        results.into_iter().find(Result::is_err).unwrap_or(Ok(()))
    }
}

// Drains the subagent notification outbox after durable task updates. A failed drain leaves the
// rows undelivered for the next update, and feed overflow resubscribes and drains once.
async fn notifications(
    mut stopped: watch::Receiver<bool>,
    feed: Feed,
    mut subscriber: ycoding_core::event_feed::Subscriber,
    notify: Arc<tokio::sync::Notify>,
    orchestration: orchestration::Service,
) {
    loop {
        tokio::select! {
            _ = stopped.changed() => return,
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
        if updated && orchestration.dispatch_notifications().await.is_err() {
            tracing::error!(
                "subagent notification outbox dispatch failed; retrying after the next task update"
            );
        }
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
        self.pending.shutdown();
        let tasks = self.stop_tasks().await;
        self.launch.cancellation.cancel();
        self.activation.close().await;
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
    eprintln!("production composition diagnostic: stage={service}; category=unavailable");
    Failure::Unavailable(format!("{service} unavailable"))
}
