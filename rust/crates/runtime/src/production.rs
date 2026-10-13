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
        agent, attachment_store,
        catalog::{self, models_dev},
        config, credential, cursor, memory, model,
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
    _registration: Registration,
}

pub(crate) struct Prepared {
    pub configuration: Configuration,
    disk: Arc<config::Configuration>,
    models: Arc<model::Resolver>,
}

pub(crate) struct Factory {
    options: config::LoadOptions,
    snapshots: Vec<models_dev::Snapshot>,
    client: Client,
    events: Feed,
    credentials: credential::Service,
    executor: Arc<Executor>,
    git: Arc<git::Service>,
    publisher: policy::Publisher,
    cursor: Option<Cursor>,
    pub steer: Option<Arc<dyn autonomy::Steer>>,
    ripgrep: std::path::PathBuf,
}

impl Core {
    pub async fn production(client: Client, production: Production) -> Result<Self, Failure> {
        production
            .configuration
            .roots
            .initialize()
            .map_err(|_| unavailable("runtime directories"))?;
        let catalog = models_dev::Service::new(production.catalog)
            .map_err(|_| unavailable("model catalog"))?;
        let snapshots = catalog
            .get()
            .await
            .map_err(|_| unavailable("model catalog"))?;
        let credentials = credential::Service::new(client.clone());
        let events = Feed::attach(&client);
        let feed = events.clone();
        let factory = Arc::new(Factory {
            options: production.configuration,
            snapshots,
            client: client.clone(),
            events: events.clone(),
            credentials,
            executor: Arc::new(Executor::new(
                Executor::http_client().map_err(|_| unavailable("provider execution"))?,
            )),
            git: Arc::new(git::Service::new(16 * 1024 * 1024)),
            publisher: Arc::new(move |event| {
                feed.publish(crate::services::ephemeral(&event)?);
                Ok(())
            }),
            cursor: production.cursor,
            steer: production.steer,
            ripgrep: production.ripgrep,
        });
        let mut global = factory.options.clone();
        global.directory = global.roots.config.clone();
        global.project = false;
        let global =
            config::Configuration::load(global).map_err(|_| unavailable("global configuration"))?;
        let configuration = factory.configuration(&global)?;
        let sessions = Service::new(client.clone());
        let autonomy = autonomy::Service::new(client.clone());
        let locations = Locations::new(
            client.clone(),
            sessions.clone(),
            configuration,
            events.clone(),
            autonomy.clone(),
        )
        .with_factory(factory.clone());
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
        let publisher = factory.publisher.clone();
        let credentials = factory.credentials.clone();
        let pricing_locations = locations.clone();
        let maintenance =
            Maintenance::start(sessions.clone(), execution, locations.clone(), factory);
        Ok(Self {
            integrations: None,
            mcp: None,
            catalogs: None,
            artifacts: None,
            remote: None,
            publisher,
            credentials,
            browser: None,
            isolated_browser: None,
            platform: None,
            platform_default_location: None,
            telemetry: ycoding_core::telemetry::Service::new(client),
            keep_awake: ycoding_core::platform::keep_awake::Service::new(),
            provider_usage: None,
            usage_pricer: Some(Arc::new(move |reference| {
                pricing_locations.pricing(reference)
            })),
            sessions: sessions.clone(),
            execution,
            autonomy,
            events,
            locations,
            orchestration: orchestration::Service::new(
                sessions,
                Arc::new(crate::services::LocalExecution(execution)),
            ),
            maintenance: Some(Arc::new(maintenance)),
        })
    }

    pub async fn shutdown(&self) -> Result<(), Failure> {
        if let Some(maintenance) = &self.maintenance {
            maintenance.shutdown().await?;
        }
        Ok(())
    }
}

impl Factory {
    pub(crate) fn prepare(&self, directory: &LosslessString) -> Result<Prepared, Failure> {
        let mut options = self.options.clone();
        options.directory = directory
            .to_utf8()
            .map_err(|_| unavailable("Location directory"))?
            .into();
        let disk = Arc::new(
            config::Configuration::load(options)
                .map_err(|_| unavailable("Location configuration"))?,
        );
        let mut catalog = catalog::Catalog::from_config(self.snapshots.clone(), &disk)
            .map_err(|_| unavailable("configured model catalog"))?;
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
        Ok(Prepared {
            configuration: self.configuration(&disk)?,
            disk,
            models: Arc::new(model::Resolver::new(catalog)),
        })
    }

    fn configuration(&self, disk: &config::Configuration) -> Result<Configuration, Failure> {
        let roots = &self.options.roots;
        let agents = Arc::new(
            agent::Service::from_entries(
                &disk.entries,
                &roots.home,
                agent::builtin::catalog(roots)
                    .map_err(|_| unavailable("built-in agent catalog"))?,
                &mut vec![],
            )
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
    ) -> Result<Composed, Failure> {
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
        let (registry, registration) =
            tools::compose(self, services, prepared.disk.clone(), memory.clone())?;
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
        instructions.push(instruction_sources::ambient(
            ycoding_core::resources::instruction_discovery::Options {
                directory: directory.clone(),
                project_root: project,
                global_config: roots.config.clone(),
                project: self.options.project,
                max_bytes: None,
            },
        ));
        let cursor = self
            .cursor
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
                    extensions: Default::default(),
                })
            })
            .transpose()?;
        let compaction = prepared
            .disk
            .values("compaction")
            .map(compaction_policy::Info::decode)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| unavailable("compaction configuration"))?;
        let runner = runner::Local::new(runner::Services {
            snapshots: None,
            store: Service::new(self.client.clone()),
            events: self.events.clone(),
            location: location::Ref {
                directory: services.info.directory.clone(),
                workspace_id: services.info.workspace_id.clone(),
            },
            models: prepared.models.clone(),
            agents: services.agents.clone(),
            credentials: self.credentials.clone(),
            tools: registry.clone(),
            attachments: Arc::new(
                attachment_store::Store::new(roots.data.clone())
                    .map_err(|_| unavailable("managed attachments"))?,
            ),
            instructions,
            analysis: None,
            configuration: None,
            image_analyzer: None,
            extensions: Vec::new(),
            clock,
            executor: self.executor.clone(),
            compaction: compaction_policy::resolve(&compaction),
            guardrails: services.guardrails.clone(),
            helpers: policy::helper::Settings::from_configuration(&prepared.disk)
                .map_err(|_| unavailable("helper model configuration"))?,
            cursor,
            claude: None,
            auth: Some(Default::default()),
            skill_resolver: Some(Arc::new(SkillResolver(tokio::sync::Mutex::new(
                ycoding_core::resources::skill::Service::from_entries(
                    &prepared.disk.entries,
                    &directory,
                    &roots.home,
                    &roots.cache,
                )
                .map_err(|_| unavailable("skill configuration"))?,
            )))),
        });
        Ok(Composed {
            configuration: prepared.disk,
            models: prepared.models,
            credentials: self.credentials.clone(),
            tools: registry,
            memory,
            runner,
            steer: self.steer.clone(),
            _registration: registration,
        })
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
            execution::Runner::settled(
                &lease.production.as_ref().expect("production runner").runner,
                id,
                outcome,
            )
            .await
        })
    }
}

pub(crate) struct Maintenance {
    stop: watch::Sender<bool>,
    task: Mutex<Option<JoinHandle<()>>>,
    credentials: credential::Service,
}

impl Maintenance {
    fn start(
        sessions: Service,
        execution: &'static execution::Execution,
        locations: Locations,
        factory: Arc<Factory>,
    ) -> Self {
        Self::start_owned(
            sessions,
            locations,
            factory,
            Arc::new(runner::WallClock),
            Arc::new(move || execution.active()),
        )
    }

    fn start_owned(
        sessions: Service,
        locations: Locations,
        factory: Arc<Factory>,
        clock: Arc<dyn runner::Clock>,
        active: Arc<dyn Fn() -> Vec<ycoding_core::ycoding_schema::session::Id> + Send + Sync>,
    ) -> Self {
        let credentials = factory.credentials.clone();
        let (stop, mut stopped) = watch::channel(false);
        let task = tokio::spawn(async move {
            let retention = async {
                loop {
                    let mut options = factory.options.clone();
                    options.directory = options.roots.config.clone();
                    options.project = false;
                    match config::Configuration::load(options) {
                        Ok(configuration) => {
                            let active = active.clone();
                            match sessions
                                .retain(clock.now(), retention::days(&configuration), move || {
                                    active()
                                })
                                .await
                            {
                                Ok(sweep) => {
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
                    clock.sleep(60 * 60 * 1000).await;
                }
            };
            let eviction = async {
                loop {
                    locations.evict_idle(Instant::now());
                    clock.sleep(60 * 1000).await;
                }
            };
            tokio::select! {
                _ = stopped.changed() => {},
                _ = async { tokio::join!(retention, eviction); } => {},
            }
        });
        Self {
            stop,
            task: Mutex::new(Some(task)),
            credentials,
        }
    }
    async fn shutdown(&self) -> Result<(), Failure> {
        self.stop.send_replace(true);
        let task = self
            .task
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(task) = task {
            task.await.map_err(|_| unavailable("runtime maintenance"))?;
        }
        self.credentials
            .shutdown()
            .await
            .map_err(|_| unavailable("credentials"))
    }
}

impl Drop for Maintenance {
    fn drop(&mut self) {
        self.stop.send_replace(true);
        if let Some(task) = self
            .task
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            task.abort();
        }
    }
}

struct SkillResolver(tokio::sync::Mutex<ycoding_core::resources::skill::Service>);

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

fn field<'a>(value: Option<&'a JsonValue>, key: &str) -> Option<&'a JsonValue> {
    match value {
        Some(JsonValue::Object(value)) => value.get(&key.into()),
        _ => None,
    }
}
fn unavailable(service: &str) -> Failure {
    Failure::Unavailable(format!("{service} unavailable"))
}
