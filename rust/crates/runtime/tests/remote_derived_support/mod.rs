#![allow(dead_code)]

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::watch;
use ycoding_core::{
    platform::{filesystem, git, project_copy, pty, shell},
    process::guardrails::{Limits, Paths, Settings},
    resources::{
        agent,
        auth::integration::{Authorization, OAuthImplementation, Registration, Registry},
        catalog::{Catalog, ProviderRecord},
        command,
        config::{Configuration, LoadOptions, Roots},
        credential, generate,
        mcp::{self, client::Hooks},
        model, reference, skill,
    },
    session::{
        execution::{Execution, Locations, Runner},
        run_coordinator,
        store::Service,
    },
    ycoding_schema::{
        DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder,
        credential as credential_schema, integration, location, parse_json, session,
    },
    ycoding_store::{self, Metadata, Options, Store, TableDeclaration, project, resources},
};
use ycoding_protocol::connection::Budgets;
use ycoding_runtime::{
    Boxed, CatalogServices, Core, Environment, Identity, IntegrationServices, LocalAuth,
    PlatformServices, Services, SnapshotSettings, Subscriptions,
    connector::{Credential, Credentials, Enrolled, Error, Peer, Preference},
};

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
static NEXT: AtomicUsize = AtomicUsize::new(0);

pub struct Saved(pub AtomicBool);
impl Preference for Saved {
    fn load(&self) -> Boxed<Result<bool, Error>> {
        let value = self.0.load(Ordering::Acquire);
        Box::pin(async move { Ok(value) })
    }
    fn save(&self, value: bool) -> Boxed<Result<(), Error>> {
        self.0.store(value, Ordering::Release);
        Box::pin(async { Ok(()) })
    }
}
pub struct Access(pub String);
impl Credentials for Access {
    fn enrolled(&self) -> Boxed<Result<Enrolled, Error>> {
        let enrolled = Enrolled::new(&self.0, "device-a".into());
        Box::pin(async move { enrolled })
    }
    fn access(&self) -> Boxed<Result<Credential, Error>> {
        let origin = self.0.clone();
        Box::pin(async move {
            Ok(Credential::new(
                "stand-in-token".into(),
                now() + 600_000,
                origin,
                "device-a".into(),
            ))
        })
    }
}
pub fn expired_peer() -> Peer {
    Peer::authenticate(
        &Enrolled::new("https://relay.invalid", "device-a".into()).unwrap(),
        &Credential::new(
            "stand-in-token".into(),
            1,
            "https://relay.invalid".into(),
            "device-a".into(),
        ),
        0,
    )
    .unwrap()
}

pub struct Running(watch::Sender<BTreeSet<session::Id>>);
impl Runner for Running {
    fn drain(&self, mut request: run_coordinator::DrainRequest) -> run_coordinator::RunFuture {
        self.0.send_modify(|started| {
            started.insert(request.session_id);
        });
        Box::pin(async move {
            Err(run_coordinator::Error::Interrupted(
                request.cancellation.cancelled().await,
            ))
        })
    }
}
impl Locations for Running {
    fn get(&self, _: &location::Ref) -> Result<Arc<dyn Runner>, run_coordinator::Error> {
        Ok(Arc::new(Self(self.0.clone())))
    }
}
pub struct World {
    pub core: Core,
    pub store: ycoding_store::Client,
    pub started: Arc<Running>,
}
pub fn world() -> &'static World {
    static WORLD: OnceLock<World> = OnceLock::new();
    WORLD.get_or_init(|| {
        let tables = ycoding_store::session::TABLES
            .iter()
            .chain(project::TABLES)
            .chain(resources::TABLES)
            .chain(ycoding_store::artifacts::TABLES)
            .copied()
            .chain([
                TableDeclaration::of::<ycoding_store::analytics::DeliveryTable>(),
                TableDeclaration::of::<ycoding_store::analytics::IntentTable>(),
            ])
            .collect::<Vec<_>>();
        let store = Store::disposable(
            Options::core(),
            ycoding_store::Catalog::new(1, Box::leak(tables.into_boxed_slice())),
            Metadata::new([27; 16], 1),
        )
        .unwrap();
        let client = store.client();
        std::mem::forget(store);
        let started = Arc::new(Running(watch::channel(BTreeSet::new()).0));
        let execution = Execution::install(
            Service::new(client.clone()),
            started.clone(),
            ycoding_core::job::Jobs::new(),
            None,
        )
        .unwrap();
        let mut build = agent::empty("build".into());
        build.permissions = vec![ycoding_core::ycoding_schema::permission::Rule {
            action: "*".into(),
            resource: "*".into(),
            effect: ycoding_core::ycoding_schema::permission::Effect("ask".into()),
        }];
        let core = Core::new(
            client.clone(),
            execution,
            ycoding_runtime::Configuration {
                agents: Arc::new(agent::Service::new(vec![build, agent::empty("btw".into())])),
                helpers: None,
                publisher: Arc::new(|_| Ok(())),
                guardrails: Settings {
                    paths: Paths {
                        workdir: "".into(),
                        project: "".into(),
                        home: "/home/fixture".into(),
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
                    git: Arc::new(git::Service::new(1_048_576)),
                    data: std::env::temp_dir().join("ycoding-remote-derived-snapshots"),
                    enabled: false,
                },
            },
        );
        World {
            core,
            store: client,
            started,
        }
    })
}
pub async fn activate(id: &str) {
    let id = session::Id::new(id).unwrap();
    let mut started = world().started.0.subscribe();
    let execution = world().core.execution;
    let running = id.clone();
    tokio::spawn(async move { execution.resume(&running).await });
    tokio::time::timeout(
        super::connector_support::WAIT,
        started.wait_for(|started| started.contains(&id)),
    )
    .await
    .unwrap()
    .unwrap();
}
pub async fn stop(id: &str) {
    world()
        .core
        .execution
        .interrupt(&session::Id::new(id).unwrap())
        .await
        .unwrap();
}

pub struct Fixture {
    pub path: PathBuf,
    pub directory: String,
    pub child_directory: String,
    pub project: String,
    pub root: String,
    pub child: String,
    pub other: String,
    pub integration: String,
    pub registry: Registry,
    pub registrations: Vec<Registration>,
    pub catalogs: CatalogServices,
    pub mcp: Arc<mcp::Service>,
    pub platform: Arc<PlatformServices>,
    pub child_platform: Arc<PlatformServices>,
    pub calls: Arc<AtomicUsize>,
}
impl Fixture {
    pub async fn new() -> Self {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        // Workspace discovery hides system temporary directories, so the fixture lives in Cargo's target scratch area.
        let path = Path::new(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("remote-derived-{}-{n}", std::process::id()));
        std::fs::create_dir(&path).unwrap();
        std::fs::create_dir(path.join("child")).unwrap();
        let path = std::fs::canonicalize(path).unwrap();
        let directory = path.to_str().unwrap().to_owned();
        let child_directory = path.join("child").to_str().unwrap().to_owned();
        let project = format!("prj_derived{n}");
        let root = format!("ses_derived{n}");
        let child = format!("ses_derived_child{n}");
        let other = format!("ses_derived_other{n}");
        let integration = format!("fixture-auth-{n}");
        let p = project.clone();
        let d = directory.clone();
        world()
            .store
            .submit(move |tx| {
                project::ProjectTable::insert(
                    tx,
                    &project::Project {
                        id: p.into(),
                        worktree: d.into(),
                        vcs: None,
                        name: Some("Derived workspace".into()),
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
            .await
            .unwrap();
        create(&root, &project, &directory, None, "build").await;
        create(&child, &project, &child_directory, Some(&root), "build").await;
        create(&other, &project, &directory, None, "build").await;
        let credentials = world().core.credentials.clone();
        let registry = Registry::new(
            credentials.clone(),
            BTreeMap::from([("SYNTH_KEY".into(), "synthetic-env-secret".into())]),
        );
        let id = integration.clone();
        let registration = registry
            .transform(move |draft| {
                draft.method(
                    id.as_str().into(),
                    integration::Method::Key(integration::KeyMethod { label: None }),
                );
                draft.method(
                    id.as_str().into(),
                    integration::Method::Env(integration::EnvMethod {
                        names: vec!["SYNTH_KEY".into()],
                    }),
                );
            })
            .unwrap();
        let mut catalog = Catalog::default();
        catalog.providers = vec![ProviderRecord { provider: ycoding_core::ycoding_schema::provider::Info::decode(&parse_json(&format!(r#"{{"id":"fixture","integrationID":"{integration}","name":"Fixture","package":"@ycoding-ai/ai/providers/openai-compatible","settings":{{"apiKey":"synthetic-provider-secret"}}}}"#)).unwrap()).unwrap(), models: vec![ycoding_core::ycoding_schema::model::Info::decode(&parse_json(r#"{"id":"code","modelID":"api-code","providerID":"fixture","name":"Code","package":"@ycoding-ai/ai/providers/openai-compatible","capabilities":{"tools":true,"input":["text"],"output":["text"]},"variants":[{"id":"high"}],"time":{"released":1},"cost":[],"status":"active","enabled":true,"limit":{"context":4096,"output":96}}"#).unwrap()).unwrap()], environment: vec![] }];
        let models = Arc::new(model::Resolver::new(catalog));
        let roots = Roots::development(&path).unwrap();
        let catalogs = CatalogServices {
            session: None,
            models: models.clone(),
            agents: Arc::new(agent::Service::new(vec![
                agent::empty("build".into()),
                agent::empty("btw".into()),
            ])),
            commands: Arc::new(command::Service::from_documents(&[]).unwrap()),
            references: Arc::new(reference::Service::from_infos(vec![])),
            skills: Arc::new(tokio::sync::Mutex::new(skill::Service::new(
                &path.join("skills"),
            ))),
            roots: roots.clone(),
            diagnostics: vec![],
            plugins: vec![],
            ready: Arc::new(|| Box::pin(async { Ok(()) })),
            refresh: Arc::new(|| Box::pin(async { Ok(()) })),
            generate: Arc::new(generate::Service {
                models,
                credentials: credentials.clone(),
                integrations: registry.clone(),
                executor: Arc::new(generate::Executor::new(
                    generate::Executor::http_client().unwrap(),
                )),
                cursor: None,
            }),
        };
        let mcp = Arc::new(
            mcp::Service::new(
                &[],
                path.clone(),
                project.clone(),
                BTreeMap::new(),
                Hooks {
                    integrations: Some(registry.clone()),
                    credentials: Some(credentials),
                    ..Default::default()
                },
            )
            .unwrap(),
        );
        let platform = make_platform(&path, &project, &roots, PLATFORM_CONFIG).await;
        let child_platform =
            make_platform(&path.join("child"), &project, &roots, PLATFORM_CONFIG).await;
        let mut fixture = Self {
            path,
            directory,
            child_directory,
            project,
            root,
            child,
            other,
            integration,
            registry,
            registrations: vec![registration],
            catalogs,
            mcp,
            platform,
            child_platform,
            calls: Arc::new(AtomicUsize::new(0)),
        };
        fixture.oauth("code", true, "https://auth.invalid/authorize", None, false);
        fixture.oauth(
            "backend",
            false,
            "https://auth.invalid/authorize",
            None,
            false,
        );
        fixture.oauth("unsafe", true, "https://localhost/authorize", None, false);
        fixture.oauth("failed", true, "https://auth.invalid/authorize", None, true);
        fixture
    }
    pub fn oauth(
        &mut self,
        method: &str,
        remote: bool,
        url: &str,
        prompts: Option<Vec<integration::Prompt>>,
        failure: bool,
    ) {
        let id = self.integration.clone();
        let method_id = method.to_owned();
        let url = url.to_owned();
        let calls = self.calls.clone();
        let implementation = OAuthImplementation {
            integration: id.into(),
            method: integration::OAuthMethod {
                id: integration::MethodId::new(method).unwrap(),
                label: method.into(),
                prompts,
                remote: Some(remote),
            },
            authorize: Arc::new(move |_| {
                calls.fetch_add(1, Ordering::AcqRel);
                let url = url.clone();
                let method = method_id.clone();
                Box::pin(async move {
                    Ok(Authorization::code(
                        url,
                        "Use the provider link".into(),
                        Arc::new(move |code| {
                            assert_eq!(code, "finish");
                            let method = method.clone();
                            Box::pin(async move {
                                if failure {
                                    return Err(credential::Error::Rejected);
                                }
                                Ok(resources::Secret::new(credential_schema::Value::OAuth(credential_schema::OAuth { method_id: integration::MethodId::new(method).unwrap(), access: "synthetic-access-secret".into(), refresh: "synthetic-refresh-secret".into(), expires: ycoding_core::ycoding_schema::schema::NonNegativeInt::new(9_000_000_000_000).unwrap(), metadata: None }).encode()).unwrap())
                            })
                        }),
                    ))
                })
            }),
            refresh: None,
            label: None,
        };
        self.registrations.push(
            self.registry
                .transform(move |draft| draft.oauth(implementation.clone()))
                .unwrap(),
        );
    }
    pub fn environment(&self, present: bool) -> Arc<Environment> {
        let mut core = world().core.clone();
        let registry = self.registry.clone();
        let catalogs = self.catalogs.clone();
        let mcp = self.mcp.clone();
        let directory = self.directory.clone();
        let child_directory = self.child_directory.clone();
        let platform = self.platform.clone();
        let child_platform = self.child_platform.clone();
        core.integrations = Some(Arc::new(move |_| {
            Ok(IntegrationServices {
                registry: registry.clone(),
                wellknown: None,
            })
        }));
        core.catalogs = Some(Arc::new(move |_| Ok(catalogs.clone())));
        core.mcp = Some(Arc::new(move |_| Ok(mcp.clone())));
        core.platform = Some(Arc::new(move |location| {
            match location.directory.as_lossless().as_str() {
                Some(value) if value == directory => Ok(platform.clone()),
                Some(value) if value == child_directory => Ok(child_platform.clone()),
                _ => Err("unexpected Location".into()),
            }
        }));
        Arc::new(Environment {
            services: Services {
                identity: Identity {
                    version: "fixture".into(),
                    pid: std::process::id() as u64,
                    source_epoch: "derived-source".into(),
                },
                auth: LocalAuth::disabled(),
                cors: vec![],
                budgets: Budgets::default(),
                core: present.then_some(core),
            },
            urls: vec![],
            subscriptions: Subscriptions::default(),
            uploads: Default::default(),
        })
    }
    pub async fn configure_platform(&mut self, config: &str) {
        self.platform.shell.shutdown().await.unwrap();
        self.platform.pty.shutdown().await.unwrap();
        self.platform = make_platform(
            &self.path,
            &self.project,
            &Roots::development(&self.path).unwrap(),
            config,
        )
        .await;
    }
    pub async fn close(self) {
        self.platform.shell.shutdown().await.unwrap();
        self.child_platform.shell.shutdown().await.unwrap();
        self.platform.pty.shutdown().await.unwrap();
        self.child_platform.pty.shutdown().await.unwrap();
        self.mcp.shutdown().await.unwrap();
        self.registry.shutdown().await.unwrap();
        std::fs::remove_dir_all(self.path).unwrap();
    }
}

pub async fn create(id: &str, project: &str, directory: &str, parent: Option<&str>, agent: &str) {
    world()
        .core
        .sessions
        .create(ycoding_store::session::NewEvent {
            id: format!("evt_create_{id}").into(),
            aggregate_id: id.into(),
            created: now(),
            type_: "session.created.2".into(),
            data: ObjectEncoder::new()
                .field("sessionID", id)
                .field("projectID", project)
                .field(
                    "location",
                    &parse_json(&format!(
                        r#"{{"directory":{}}}"#,
                        ycoding_core::ycoding_schema::stringify_json(&JsonValue::String(
                            directory.into()
                        ))
                    ))
                    .unwrap(),
                )
                .optional("parentID", &parent.map(LosslessString::from))
                .field("agent", agent)
                .field("title", id)
                .field("created", &(now() as f64))
                .finish(),
        })
        .await
        .unwrap();
}

pub async fn message(id: &str, suffix: &str, kind: &str, seq: i64, data: &str) {
    let row = ycoding_store::session::Message {
        id: format!("msg_{id}_{suffix}").into(),
        session_id: id.into(),
        type_: kind.into(),
        seq,
        time_created: seq,
        time_updated: seq,
        data: parse_json(data).unwrap(),
    };
    let id = id.to_owned();
    world()
        .store
        .submit(move |tx| {
            ycoding_store::session::MessageTable::insert(tx, &row)?;
            ycoding_store::session::reserve_sequence(tx, &id.as_str().into(), seq)?;
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
}

const PLATFORM_CONFIG: &str = "{\"shell\":\"/bin/sh\"}";

async fn make_platform(
    path: &Path,
    project: &str,
    roots: &Roots,
    config: &str,
) -> Arc<PlatformServices> {
    let git = Arc::new(git::Service::new(1_048_576));
    Arc::new(PlatformServices {
        shell: Arc::new(
            shell::Shell::new(roots, path.into(), project, world().store.clone())
                .await
                .unwrap(),
        ),
        pty: Arc::new(pty::Pty::new(path.into())),
        tickets: Arc::new(Mutex::new(pty::ticket::Tickets::default())),
        config: Arc::new(
            Configuration::load(LoadOptions {
                directory: path.into(),
                roots: roots.clone(),
                project: false,
                file: None,
                content: Some(config.into()),
                env: Default::default(),
            })
            .unwrap(),
        ),
        filesystem: Arc::new(filesystem::Location::new(path).unwrap()),
        search: Arc::new(
            filesystem::search::Service::new(
                path,
                filesystem::search::Backend::Ripgrep {
                    binary: "rg".into(),
                },
            )
            .unwrap(),
        ),
        copies: Arc::new(
            project_copy::Copies::new(
                path,
                git.clone(),
                world().store.clone(),
                Arc::new(|_| Ok(())),
            )
            .unwrap(),
        ),
        git,
    })
}

pub async fn owned_shell(
    platform: &PlatformServices,
    owner: Option<&str>,
    command: &str,
) -> ycoding_core::ycoding_schema::shell::Info {
    let mut metadata = ycoding_core::ycoding_schema::JsonObject::new();
    if let Some(owner) = owner {
        metadata.insert("sessionID".into(), JsonValue::String(owner.into()));
    }
    let input = ycoding_core::ycoding_schema::shell::CreateInput {
        command: command.into(),
        cwd: None,
        timeout: ycoding_core::ycoding_schema::schema::NonNegativeInt::new(60_000).unwrap(),
        memory_limit_mb: None,
        metadata: Some(metadata),
    };
    let mut prepared = platform.shell.prepare(input, &platform.config).unwrap();
    platform.shell.create(&mut prepared).await.unwrap()
}
