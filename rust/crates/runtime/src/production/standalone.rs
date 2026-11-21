use super::{Factory, unavailable};
use crate::{Configuration, SnapshotSettings, dispatch::Failure, locations::ServiceSet};
use std::sync::Arc;
use ycoding_core::{
    instructions::builtins,
    process::guardrails::{Limits, Paths, Settings},
    resources::{
        agent, attachment_store, auth, catalog::Catalog, config, image, model, tool_output_store,
    },
    session::{autonomy, compaction_policy, runner, standalone::State, store::Service, title},
    tools::{
        builtin::{
            goal::Goal, question::Question, task_complete::TaskComplete, todowrite::TodoWrite,
        },
        context::{Context, policy::LeafPolicy},
        policy::{self, Publisher},
        registry::{Options, Registration, Registry, Tool, ToolFuture},
    },
    ycoding_ai::llm::ToolDefinition,
    ycoding_schema::{DomainDecode, JsonValue, location, session, session_scope::Scope},
};

pub(crate) struct Prepared {
    pub configuration: Configuration,
    pub state: Arc<State>,
}

pub(crate) struct Composed {
    pub runner: runner::Local,
    pub state: Arc<State>,
    _registration: Registration,
}

impl Drop for Composed {
    fn drop(&mut self) {
        self.state.close();
        let memory = ycoding_core::observability::memory::Scalar::sample();
        tracing::info!(
            scope = "standalone",
            rss_bytes = memory.rss_bytes,
            rss_status = memory.rss_status,
            peak_rss_bytes = memory.peak_rss_bytes,
            "location services disposed"
        );
    }
}

impl Factory {
    pub(crate) fn prepare_standalone(&self, location: &location::Ref) -> Result<Prepared, Failure> {
        let roots = &self.options.roots;
        let snapshot = config::standalone::Snapshot::read(roots)
            .map_err(|_| unavailable("standalone global configuration"))?;
        let disk = &snapshot.configuration;
        let agents = agent::Service::from_documents(
            &disk.entries,
            &roots.home,
            agent::builtin::catalog(roots, Scope::Standalone)
                .map_err(|_| unavailable("standalone built-in agent catalog"))?,
        )
        .map_err(|_| unavailable("standalone agents"))?;
        let mut catalog = Catalog::new(
            self.globals
                .catalog
                .read_only()
                .map_err(|_| unavailable("standalone model catalog"))?,
        );
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
            .map_err(|_| unavailable("standalone provider configuration"))?;
        let settings = disk.latest("guardrails");
        let mut limits = Limits::default();
        if let Some(JsonValue::Number(value)) = super::field(settings, "max_pending_reviews") {
            limits.reviews = *value as u64;
        }
        let home = roots
            .home
            .to_str()
            .ok_or_else(|| unavailable("standalone global home"))?;
        let configuration = Configuration {
            agents: Arc::new(agents),
            publisher: Arc::new(|_| Ok(())),
            helpers: None,
            guardrails: Settings {
                paths: Paths {
                    workdir: location.directory.as_lossless().clone(),
                    project: location.directory.as_lossless().clone(),
                    home: home.into(),
                    tmpdir: None,
                    trusted_paths: Vec::new(),
                },
                global_roots: Vec::new(),
                custom: super::tools::guardrails(disk),
                enabled: super::field(settings, "enabled") != Some(&JsonValue::Bool(false)),
                limits,
                decide_reviews: super::field(settings, "decide_reviews")
                    != Some(&JsonValue::Bool(false)),
                decide_hard_reviews: super::field(settings, "decide_hard_reviews")
                    != Some(&JsonValue::Bool(false)),
            },
            snapshots: SnapshotSettings {
                git: self.git.clone(),
                data: roots.data.clone(),
                enabled: false,
            },
        };
        let state = Arc::new(State::new(
            snapshot,
            location.clone(),
            Service::new(self.client.clone()),
            Arc::new(model::Resolver::new(catalog)),
            self.credentials.clone(),
        ));
        Ok(Prepared {
            configuration,
            state,
        })
    }

    pub(crate) fn compose_standalone(
        &self,
        services: &ServiceSet,
        state: Arc<State>,
        publish: Publisher,
    ) -> Result<Composed, Failure> {
        let disk = Arc::new(state.snapshot.configuration.clone());
        let agents = services.agents.clone();
        let store = Service::new(self.client.clone());
        let helpers = policy::helper::Settings::from_configuration(&disk)
            .map_err(|_| unavailable("standalone helper configuration"))?;
        let helper_models = Arc::new(policy::helper::Models {
            standalone: Some(state.clone()),
            models: state.models.clone(),
            credentials: self.credentials.clone(),
            auth: auth::Preparation::default(),
            cursor: None,
            claude: None,
            store: store.clone(),
            settings: helpers.clone(),
        });
        let decisions = Arc::new(ycoding_core::resources::decision::Service {
            generation: self.globals.generation.clone(),
            clock: self.globals.clock.clone(),
            store: store.clone(),
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
        services.forms.clone().with_decision(decisions);
        let scope = state.clone();
        services
            .permissions
            .clone()
            .with_scope_check(move |id| {
                session::Id::new(id.as_lossless().clone())
                    .ok()
                    .is_some_and(|id| scope.session(&id).is_ok())
            })
            .map_err(|_| unavailable("standalone permission scope"))?;
        let policy = Arc::new(LeafPolicy {
            permissions: services.permissions.clone(),
            guardrails: services.guardrails.clone(),
        });
        let registry = Arc::new(Registry::new(
            Arc::new(tool_output_store::Store::new(&self.options.roots)),
            Some(disk.clone()),
            image::Limits::from_configuration(&disk),
            Arc::new(ycoding_core::platform::filesystem::collation::compare),
        ));
        let tools: Vec<(&str, Arc<dyn Tool>)> = vec![
            (
                "question",
                Arc::new(Question {
                    forms: services.forms.clone(),
                    policy: policy.clone(),
                }),
            ),
            (
                "todowrite",
                Arc::new(TodoWrite {
                    store: store.clone(),
                    policy: policy.clone(),
                    publish,
                }),
            ),
            (
                "goal",
                Arc::new(Goal {
                    autonomy: autonomy::Service::new(self.client.clone()),
                    sessions: store.clone(),
                    policy: policy.clone(),
                }),
            ),
            ("task_complete", Arc::new(TaskComplete)),
        ];
        let registration = registry
            .register(
                tools
                    .into_iter()
                    .map(|(name, tool)| {
                        (
                            name.to_owned(),
                            Arc::new(FencedTool {
                                state: state.clone(),
                                tool,
                                completion_policy: (name == "task_complete")
                                    .then(|| policy.clone()),
                            }) as Arc<dyn Tool>,
                        )
                    })
                    .collect(),
                Options::direct(),
            )
            .map_err(|_| unavailable("standalone tool registration"))?;
        let roots = &self.options.roots;
        let clock = self.globals.clock.clone();
        let instructions = builtins::load(
            builtins::Environment {
                directory: state
                    .location
                    .directory
                    .as_lossless()
                    .to_utf8()
                    .map_err(|_| unavailable("standalone location"))?,
                project_root: state
                    .location
                    .directory
                    .as_lossless()
                    .to_utf8()
                    .map_err(|_| unavailable("standalone location"))?,
                git: false,
                platform: std::env::consts::OS.into(),
                data: roots
                    .data
                    .to_str()
                    .ok_or_else(|| unavailable("standalone data root"))?
                    .into(),
            },
            Arc::new(move || clock.now()),
            Scope::Standalone,
        );
        let title = Arc::new(title::Service::new(
            store.clone(),
            agents.clone(),
            helper_models,
            self.executor.clone(),
            self.globals.generation.clone(),
            self.globals.clock.clone(),
        ));
        let compaction = disk
            .values("compaction")
            .map(compaction_policy::Info::decode)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| unavailable("standalone compaction configuration"))?;
        let runner = runner::Local::standalone(
            runner::Services {
                store,
                events: self.events.clone(),
                location: state.location.clone(),
                models: state.models.clone(),
                agents,
                credentials: self.credentials.clone(),
                tools: registry,
                attachments: Arc::new(
                    attachment_store::Store::new(roots.data.clone())
                        .map_err(|_| unavailable("standalone attachment boundary"))?,
                ),
                instructions,
                analysis: None,
                clock: self.globals.clock.clone(),
                generation: self.globals.generation.clone(),
                executor: self.executor.clone(),
                compaction: compaction_policy::resolve(&compaction),
                guardrails: services.guardrails.clone(),
                helpers,
                cursor: None,
                claude: None,
                auth: None,
                skill_resolver: None,
                snapshots: None,
                configuration: Some(disk),
                image_analyzer: None,
                extensions: Vec::new(),
                session_tools: None,
            },
            state.clone(),
        )
        .with_title(title);
        state
            .assert_current()
            .map_err(|_| unavailable("standalone configuration changed"))?;
        Ok(Composed {
            runner,
            state,
            _registration: registration,
        })
    }
}

struct FencedTool {
    state: Arc<State>,
    tool: Arc<dyn Tool>,
    completion_policy: Option<Arc<LeafPolicy>>,
}

impl Tool for FencedTool {
    fn definition(&self, name: &str) -> ToolDefinition {
        self.tool.definition(name)
    }
    fn permission(&self) -> Option<&str> {
        self.tool.permission()
    }
    fn validate_output(
        &self,
        output: &ycoding_core::ycoding_ai::llm::ToolOutput,
    ) -> Result<(), ycoding_core::tools::registry::Failure> {
        self.tool.validate_output(output)
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            self.state.session(&context.session_id).map_err(|_| {
                ycoding_core::tools::registry::Failure::message(
                    "Standalone tool configuration is no longer current",
                )
            })?;
            if let Some(policy) = &self.completion_policy {
                policy
                    .assert(&context, "task_complete", vec!["*".into()], vec![], None)
                    .await?;
            }
            if context.cancellation.is_cancelled() {
                return Err(ycoding_core::tools::registry::Failure::Cancelled);
            }
            self.tool.settle(input, context).await
        })
    }
}
