use crate::flow;
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, LazyLock, Mutex},
};
use ycoding_core::{
    extension::SessionServices,
    resources::{
        agent, attachment_store,
        catalog::{Catalog, models_dev},
        command, config, credential, model,
    },
    session::{
        execution::{Execution, Locations, Runner},
        generate,
        run_coordinator::Error,
        runner::WallClock,
        store::Service,
    },
    tools::{policy::helper, registry::Registry},
};
use ycoding_schema::{DomainDecode, location, parse_json, session};

struct Placement(Mutex<BTreeMap<String, Arc<dyn Runner>>>);
impl Locations for Placement {
    fn get(&self, location: &location::Ref) -> Result<Arc<dyn Runner>, Error> {
        self.0
            .lock()
            .unwrap()
            .get(&location.directory.as_lossless().to_utf8().unwrap())
            .cloned()
            .ok_or(Error::Closed)
    }
}

// One process-global Execution over a file-backed store; every flow seeds its own Sessions in its
// own Location directory and places a real Location runner there.
pub struct World {
    pub client: ycoding_store::Client,
    pub sessions: Service,
    pub execution: &'static Execution,
    placement: Arc<Placement>,
}

pub fn world() -> &'static World {
    static WORLD: LazyLock<World> = LazyLock::new(|| {
        let root: &'static flow::Root = Box::leak(Box::new(flow::Root::new()));
        let store = flow::file_store(root);
        let client = store.client();
        let sessions = Service::new(client.clone());
        let placement = Arc::new(Placement(Mutex::default()));
        std::mem::forget(store);
        World {
            client,
            execution: Execution::install(
                sessions.clone(),
                placement.clone(),
                ycoding_core::job::Jobs::new(),
                None,
            )
            .unwrap(),
            sessions,
            placement,
        }
    });
    &WORLD
}

pub fn catalog(endpoint: &str, package: Option<&str>) -> Catalog {
    let mut catalog = Catalog::new(
        models_dev::normalize(
            &parse_json(include_str!(
                "../../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
            ))
            .unwrap(),
        )
        .unwrap(),
    );
    let mut provider = serde_json::json!({"settings": {"apiKey": "fixture", "baseURL": endpoint}});
    if let Some(package) = package {
        provider["package"] = package.into();
    }
    catalog
        .configure(&[parse_json(
            &serde_json::json!({"model": {"providerID": "openai", "model": "gpt-reasoning"}, "providers": {"openai": provider}}).to_string(),
        )
        .unwrap()])
        .unwrap();
    catalog
}

impl World {
    pub fn seed(&self, id: &str, directory: &str) -> session::Id {
        let mut row = flow::record(id);
        row.directory = directory.into();
        self.client
            .submit(move |tx| {
                use ycoding_store::session::{
                    ContextState, ContextStateTable, Revision, RevisionTable, SessionTable,
                };
                SessionTable::insert(tx, &row)?;
                RevisionTable::insert(
                    tx,
                    &Revision {
                        session_id: row.id.clone(),
                        revision: 0,
                        parent_revision: None,
                        manifest_digest: None,
                        covered_through_message_id: None,
                        covered_through_seq: None,
                        activation_event_id: None,
                        activation_sequence: None,
                        time_created: row.time_created,
                    },
                )?;
                ContextStateTable::insert(
                    tx,
                    &ContextState {
                        session_id: row.id.clone(),
                        status: "active".into(),
                        revision: 0,
                        manifest_digest: None,
                        covered_through_message_id: None,
                        covered_through_seq: None,
                        activated_event_id: None,
                        time_activated: None,
                        error_code: None,
                    },
                )
            })
            .unwrap()
            .wait()
            .unwrap();
        session::Id::new(id).unwrap()
    }

    pub fn location(&self, id: &session::Id) -> location::Ref {
        self.sessions.get(id).unwrap().unwrap().location
    }

    // Places the Location runner for `directory` and returns the native services an extension
    // host resolves for command and generation calls.
    pub fn place(
        &self,
        directory: &str,
        scratch: &Path,
        catalog: Catalog,
        registry: Arc<Registry>,
    ) -> SessionServices {
        let agents = Arc::new(agent::Service::new(vec![agent::empty("test".into())]));
        let local = flow::local_full(
            &self.client,
            catalog.clone(),
            vec![agent::empty("test".into())],
            registry,
            Arc::new(WallClock),
            directory,
            None,
        );
        self.placement
            .0
            .lock()
            .unwrap()
            .insert(directory.to_string(), Arc::new(local.clone()));
        let models = Arc::new(model::Resolver::new(catalog));
        let executor = Arc::new(ycoding_ai::route::Executor::new(
            ycoding_ai::route::Executor::http_client().unwrap(),
        ));
        let location = location::Ref::decode(
            &parse_json(&serde_json::json!({"directory": directory}).to_string()).unwrap(),
        )
        .unwrap();
        let mut commands = command::Service::default();
        commands.update("test".into(), |command| {
            command.template = "Run $ARGUMENTS".into()
        });
        SessionServices {
            runner: local,
            generate: Arc::new(generate::Service {
                store: self.sessions.clone(),
                location,
                agents,
                models: Arc::new(helper::Models {
                    models,
                    credentials: credential::Service::new(self.client.clone()),
                    auth: Default::default(),
                    cursor: None,
                    claude: None,
                    store: self.sessions.clone(),
                    settings: Default::default(),
                }),
                executor,
                attachments: Arc::new(
                    attachment_store::Store::new(scratch.join("attachments")).unwrap(),
                ),
                instructions: vec![],
                instruction_context: None,
                refresh: None,
                extensions: vec![],
            }),
            commands: Arc::new(commands),
            configuration: Arc::new(
                config::Configuration::load(config::LoadOptions {
                    directory: scratch.to_path_buf(),
                    roots: config::Roots::development(scratch).unwrap(),
                    project: false,
                    file: None,
                    content: Some("{}".into()),
                    env: Default::default(),
                })
                .unwrap(),
            ),
        }
    }
}

pub fn directory(label: &str) -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!(
        "/contract-{label}-{}",
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}
