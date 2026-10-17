use prost::{Message, Name};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use ycoding_core::{
    platform::{filesystem, git, project_copy, pty, shell},
    process::guardrails::{Limits, Paths, Settings},
    resources::{
        agent,
        config::{Configuration, LoadOptions, Roots},
    },
    session::{
        execution::{self, Execution, Runner},
        run_coordinator,
        store::Service,
    },
    ycoding_schema::{JsonValue, LosslessString, ObjectEncoder, location, parse_json},
    ycoding_store::{
        self, Client, Metadata, Options, Store,
        import::{self, DatabaseKind},
        model_incident::{GuidanceClear, GuidanceClearTable, Incident, IncidentTable},
        project,
        session::Document,
    },
};
use ycoding_protocol::{OPERATIONS, connection::Budgets, decode_strict, v5};
use ycoding_runtime::{
    Core, Environment, Identity, LocalAuth, PlatformServices, Services, Settled, SnapshotSettings,
    Subscriptions,
    connector::{Credential, Enrolled, Peer},
    standard,
};

const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;
const DENIED: &str =
    r#"{"shell":"/bin/sh","capabilities":{"builtin_instructions":{"deny":["model-guidance"]}}}"#;
const ALLOWED: &str = r#"{"shell":"/bin/sh"}"#;

static NEXT: AtomicUsize = AtomicUsize::new(0);

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn text(value: &str) -> v5::LosslessString {
    v5::LosslessString {
        encoding: Some(v5::lossless_string::Encoding::Utf8(value.into())),
    }
}

fn units(value: &v5::LosslessString) -> String {
    match value.encoding.as_ref().unwrap() {
        v5::lossless_string::Encoding::Utf8(text) => text.clone(),
        v5::lossless_string::Encoding::Utf16LeUnits(_) => panic!("unexpected code units"),
    }
}

struct Idle;
impl Runner for Idle {
    fn drain(&self, mut request: run_coordinator::DrainRequest) -> run_coordinator::RunFuture {
        Box::pin(async move {
            Err(run_coordinator::Error::Interrupted(
                request.cancellation.cancelled().await,
            ))
        })
    }
}
impl execution::Locations for Idle {
    fn get(&self, _: &location::Ref) -> Result<Arc<dyn Runner>, run_coordinator::Error> {
        Ok(Arc::new(Self))
    }
}

struct World {
    core: Core,
    store: Client,
}

fn world() -> &'static World {
    static WORLD: OnceLock<World> = OnceLock::new();
    WORLD.get_or_init(|| {
        let store = Store::disposable(
            Options::core(),
            import::catalog(DatabaseKind::Core),
            Metadata::new([31; 16], 1),
        )
        .unwrap();
        let client = store.client();
        std::mem::forget(store);
        let execution = Execution::install(
            Service::new(client.clone()),
            Arc::new(Idle),
            ycoding_core::job::Jobs::new(),
            None,
        )
        .unwrap();
        let core = Core::new(
            client.clone(),
            execution,
            ycoding_runtime::Configuration {
                agents: Arc::new(agent::Service::new(vec![agent::empty("build".into())])),
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
                    data: std::env::temp_dir().join("ycoding-incident-wire-snapshots"),
                    enabled: false,
                },
            },
        );
        World {
            core,
            store: client,
        }
    })
}

struct Fixture {
    path: PathBuf,
    allowed: String,
    denied: String,
    allowed_session: String,
    denied_session: String,
    provider: String,
    base: i64,
    platforms: BTreeMap<String, Arc<PlatformServices>>,
}

impl Fixture {
    async fn new() -> Self {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = Path::new(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("incident-wire-{}-{n}", std::process::id()));
        std::fs::create_dir_all(path.join("allowed")).unwrap();
        std::fs::create_dir_all(path.join("denied")).unwrap();
        let path = std::fs::canonicalize(path).unwrap();
        let project = format!("prj_incident{n}");
        let allowed = path.join("allowed").to_str().unwrap().to_owned();
        let denied = path.join("denied").to_str().unwrap().to_owned();
        let worktree = path.to_str().unwrap().to_owned();
        let id = project.clone();
        world()
            .store
            .submit(move |tx| {
                project::ProjectTable::insert(
                    tx,
                    &project::Project {
                        id: id.into(),
                        worktree: worktree.into(),
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
            .await
            .unwrap();
        let allowed_session = format!("ses_incident_allowed{n}");
        let denied_session = format!("ses_incident_denied{n}");
        create(&allowed_session, &project, &allowed).await;
        create(&denied_session, &project, &denied).await;
        let roots = Roots::development(&path).unwrap();
        let mut platforms = BTreeMap::new();
        for (directory, config) in [(&allowed, ALLOWED), (&denied, DENIED)] {
            platforms.insert(
                directory.clone(),
                platform(Path::new(directory), &project, &roots, config).await,
            );
        }
        Self {
            path,
            allowed,
            denied,
            allowed_session,
            denied_session,
            provider: format!("provider{n}"),
            base: (n as i64 + 1) * 1_000 * DAY,
            platforms,
        }
    }

    fn environment(&self) -> Arc<Environment> {
        let mut core = world().core.clone();
        let platforms = self.platforms.clone();
        core.platform = Some(Arc::new(move |location| {
            location
                .directory
                .as_lossless()
                .as_str()
                .and_then(|directory| platforms.get(directory).cloned())
                .ok_or_else(|| "unexpected Location".into())
        }));
        Arc::new(Environment {
            services: Services {
                identity: Identity {
                    version: "fixture".into(),
                    pid: std::process::id() as u64,
                    source_epoch: "incident-source".into(),
                },
                auth: LocalAuth::disabled(),
                cors: vec![],
                budgets: Budgets::default(),
                core: Some(core),
            },
            urls: vec![],
            subscriptions: Subscriptions::default(),
            uploads: Default::default(),
        })
    }

    fn incident(&self, id: &str, kind: &str, time: i64, model: &str, agent: &str) -> Incident {
        let guardrail = kind != "fallback";
        Incident {
            id: format!("inc_{}_{id}", self.provider).into(),
            time_created: time,
            kind: kind.into(),
            provider_id: self.provider.as_str().into(),
            model_id: model.into(),
            variant: None,
            profile: None,
            agent: agent.into(),
            project_id: "prj_gone".into(),
            session_id: "ses_gone".into(),
            request_id: guardrail.then(|| format!("grq_{}_{id}", self.provider).into()),
            category: if guardrail { "ordinary" } else { "rate_limit" }.into(),
            rule_ids: Document::new(
                parse_json(if guardrail { r#"["custom"]"# } else { "[]" }).unwrap(),
            )
            .unwrap(),
            target: (!guardrail).then(|| {
                Document::new(parse_json(r#"{"id":"mini","providerID":"openai"}"#).unwrap())
                    .unwrap()
            }),
            decided_by: (kind == "guardrail-rejected").then(|| "human".into()),
        }
    }

    async fn insert(&self, rows: Vec<Incident>) {
        world()
            .store
            .submit(move |tx| {
                rows.iter()
                    .try_for_each(|row| IncidentTable::insert(tx, row))
            })
            .unwrap()
            .await
            .unwrap();
    }

    async fn close(self) {
        for platform in self.platforms.values() {
            platform.shell.shutdown().await.unwrap();
            platform.pty.shutdown().await.unwrap();
        }
        std::fs::remove_dir_all(self.path).unwrap();
    }
}

async fn create(id: &str, project: &str, directory: &str) {
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
                .field("agent", "build")
                .field("title", id)
                .field("created", &(now() as f64))
                .finish(),
        })
        .await
        .unwrap();
}

async fn platform(
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

fn peer() -> Peer {
    Peer::authenticate(
        &Enrolled::new("https://relay.invalid", "device-a".into()).unwrap(),
        &Credential::new(
            "incident-test".into(),
            now() + 60_000,
            "https://relay.invalid".into(),
            "device-a".into(),
        ),
        now(),
    )
    .unwrap()
}

fn operation(name: &str) -> v5::OperationDescriptor {
    OPERATIONS
        .iter()
        .find(|descriptor| descriptor.diagnostic_name == name)
        .unwrap_or_else(|| panic!("operation {name}"))
        .clone()
}

fn machine() -> v5::Scope {
    v5::Scope {
        target: Some(v5::scope::Target::Machine(v5::Empty {})),
    }
}

fn session(id: &str) -> v5::Scope {
    v5::Scope {
        target: Some(v5::scope::Target::Session(id.into())),
    }
}

fn located(directory: &str) -> v5::Scope {
    v5::Scope {
        target: Some(v5::scope::Target::Location(text(directory))),
    }
}

async fn call<Q: Message>(
    environment: Arc<Environment>,
    name: &str,
    scope: v5::Scope,
    request: Q,
    peer: Option<&Peer>,
) -> Option<v5::TypedPayload> {
    let dispatcher = standard().unwrap();
    let request = v5::Request {
        request_id: "incident-request".into(),
        operation_id: operation(name).operation_id,
        scope,
        payload: request.encode_to_vec(),
    };
    let settled = match peer {
        Some(peer) => {
            dispatcher
                .invoke_remote(environment, "incident-connection".into(), peer, request)
                .await
        }
        None => {
            dispatcher
                .invoke(environment, "incident-connection".into(), request)
                .await
        }
    }?;
    let Settled::Result(result) = settled else {
        panic!("missing inline settlement for {name}")
    };
    match result.outcome.unwrap() {
        v5::result::Outcome::Success(payload) | v5::result::Outcome::Error(payload) => {
            Some(payload)
        }
        _ => panic!("unexpected asset"),
    }
}

fn success<R: Message + Name + Default>(payload: Option<v5::TypedPayload>) -> R {
    let payload = payload.expect("operation is exposed");
    assert_eq!(
        payload.type_name,
        R::full_name(),
        "{:?}",
        v5::InvalidRequestError::decode(payload.payload.as_slice())
    );
    decode_strict(&payload.payload).unwrap()
}

fn invalid(payload: Option<v5::TypedPayload>) -> v5::InvalidRequestError {
    let payload = payload.expect("operation is exposed");
    assert_eq!(payload.type_name, v5::InvalidRequestError::full_name());
    let error: v5::InvalidRequestError = decode_strict(&payload.payload).unwrap();
    assert_ne!(
        error.kind.as_ref().map(units).as_deref(),
        Some("unavailable"),
        "{}",
        units(&error.message)
    );
    error
}

fn report(group: i32) -> v5::ModelIncidentReportQuery {
    v5::ModelIncidentReportQuery {
        group,
        from: None,
        to: None,
        offset: None,
        limit: None,
    }
}

fn recent(provider: &str, agent: Option<&str>, limit: Option<u64>) -> v5::IncidentRecentRequest {
    v5::IncidentRecentRequest {
        query: v5::ModelIncidentRecentQuery {
            provider: text(provider),
            model: text("gpt"),
            agent: agent.map(text),
            limit,
        },
    }
}

fn guidance_query(provider: &str, directory: Option<&str>) -> v5::ModelIncidentGuidanceQuery {
    v5::ModelIncidentGuidanceQuery {
        provider: text(provider),
        model: text("gpt"),
        location: directory.map(|directory| v5::ModelIncidentGuidanceQueryLocation {
            directory: Some(text(directory)),
            workspace: None,
        }),
    }
}

type Row = (String, String, Option<String>, u64, u64, u64, u64);

fn rows(data: &v5::ModelIncidentReport) -> Vec<Row> {
    data.rows
        .items
        .iter()
        .map(|row| {
            (
                units(&row.provider_id),
                units(&row.model_id),
                row.agent.as_ref().map(units),
                row.fallbacks,
                row.escalated,
                row.rejected,
                row.last,
            )
        })
        .collect()
}

#[test]
fn incident_operations_carry_the_released_roles_scopes_and_errors() {
    for (name, id, scope, roles, session_roles, mutation, paging) in [
        (
            "incident.report",
            2064,
            v5::ScopeKind::Machine,
            3,
            false,
            v5::MutationClass::Read,
            v5::Paging::Offset,
        ),
        (
            "incident.recent",
            2065,
            v5::ScopeKind::Machine,
            3,
            false,
            v5::MutationClass::Read,
            v5::Paging::Unpaged,
        ),
        (
            "incident.guidance.get",
            2066,
            v5::ScopeKind::Location,
            3,
            true,
            v5::MutationClass::Read,
            v5::Paging::Unpaged,
        ),
        (
            "incident.guidance.clear",
            2067,
            v5::ScopeKind::Location,
            1,
            false,
            v5::MutationClass::Mutation,
            v5::Paging::Unpaged,
        ),
    ] {
        let descriptor = operation(name);
        assert_eq!(descriptor.operation_id, id, "{name}");
        assert_eq!(descriptor.scope, scope as i32, "{name}");
        assert_eq!(descriptor.mutation, mutation as i32, "{name}");
        assert_eq!(descriptor.paging, paging as i32, "{name}");
        assert_eq!(descriptor.roles.len(), roles, "{name}");
        assert!(
            descriptor
                .roles
                .contains(&(v5::PeerRole::LocalClient as i32))
        );
        assert_eq!(
            descriptor.role_scopes.len(),
            if session_roles { 2 } else { 0 }
        );
        for entry in &descriptor.role_scopes {
            assert_eq!(entry.scopes, [v5::ScopeKind::Session as i32], "{name}");
        }
        for error in [
            v5::InvalidRequestError::full_name(),
            v5::UnauthorizedError::full_name(),
        ] {
            assert!(descriptor.error_types.contains(&error), "{name} {error}");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reports_group_filter_and_page_backend_wide_for_local_and_remote_callers() {
    let fixture = Fixture::new().await;
    let base = fixture.base;
    fixture
        .insert(vec![
            fixture.incident("a", "fallback", base + 10, "gpt", "build"),
            fixture.incident("b", "fallback", base + 20, "gpt", "build"),
            fixture.incident("c", "guardrail-escalated", base + 50, "gpt", "plan"),
            fixture.incident("d", "guardrail-rejected", base + 30, "claude", "build"),
            fixture.incident("e", "guardrail-rejected", base + 40, "claude", "build"),
            fixture.incident("f", "guardrail-rejected", base + 35, "claude", "plan"),
        ])
        .await;
    let environment = fixture.environment();
    let provider = fixture.provider.clone();
    let peer = peer();
    let window = |query: v5::ModelIncidentReportQuery| v5::IncidentReportRequest {
        query: v5::ModelIncidentReportQuery {
            from: query.from.or(Some(base as u64)),
            to: query.to.or(Some((base + DAY) as u64)),
            ..query
        },
    };
    for peer in [None, Some(&peer)] {
        let by_model: v5::IncidentReportResult = success(
            call(
                environment.clone(),
                "incident.report",
                machine(),
                window(report(1)),
                peer,
            )
            .await,
        );
        assert_eq!(by_model.data.groups, 2);
        assert_eq!(
            rows(&by_model.data),
            [
                (
                    provider.clone(),
                    "gpt".into(),
                    None,
                    2,
                    1,
                    0,
                    (base + 50) as u64
                ),
                (
                    provider.clone(),
                    "claude".into(),
                    None,
                    0,
                    0,
                    3,
                    (base + 40) as u64
                ),
            ]
        );
        let by_agent: v5::IncidentReportResult = success(
            call(
                environment.clone(),
                "incident.report",
                machine(),
                window(report(2)),
                peer,
            )
            .await,
        );
        assert_eq!(by_agent.data.groups, 4);
        assert_eq!(
            rows(&by_agent.data),
            [
                (
                    provider.clone(),
                    "claude".into(),
                    Some("build".into()),
                    0,
                    0,
                    2,
                    (base + 40) as u64
                ),
                (
                    provider.clone(),
                    "gpt".into(),
                    Some("build".into()),
                    2,
                    0,
                    0,
                    (base + 20) as u64
                ),
                (
                    provider.clone(),
                    "gpt".into(),
                    Some("plan".into()),
                    0,
                    1,
                    0,
                    (base + 50) as u64
                ),
                (
                    provider.clone(),
                    "claude".into(),
                    Some("plan".into()),
                    0,
                    0,
                    1,
                    (base + 35) as u64
                ),
            ]
        );
        let ranged: v5::IncidentReportResult = success(
            call(
                environment.clone(),
                "incident.report",
                machine(),
                window(v5::ModelIncidentReportQuery {
                    from: Some((base + 20) as u64),
                    to: Some((base + 50) as u64),
                    ..report(1)
                }),
                peer,
            )
            .await,
        );
        assert_eq!(
            rows(&ranged.data),
            [
                (
                    provider.clone(),
                    "claude".into(),
                    None,
                    0,
                    0,
                    3,
                    (base + 40) as u64
                ),
                (
                    provider.clone(),
                    "gpt".into(),
                    None,
                    1,
                    0,
                    0,
                    (base + 20) as u64
                ),
            ]
        );
        let page: v5::IncidentReportResult = success(
            call(
                environment.clone(),
                "incident.report",
                machine(),
                window(v5::ModelIncidentReportQuery {
                    offset: Some(1),
                    limit: Some(1),
                    ..report(2)
                }),
                peer,
            )
            .await,
        );
        assert_eq!(page.data.groups, 4);
        assert_eq!(
            rows(&page.data),
            [(
                provider.clone(),
                "gpt".into(),
                Some("build".into()),
                2,
                0,
                0,
                (base + 20) as u64
            )]
        );
        for query in [
            v5::ModelIncidentReportQuery {
                from: Some((base + 5) as u64),
                to: Some((base + 4) as u64),
                ..report(1)
            },
            v5::ModelIncidentReportQuery {
                limit: Some(201),
                ..report(1)
            },
            v5::ModelIncidentReportQuery {
                limit: Some(0),
                ..report(1)
            },
        ] {
            invalid(
                call(
                    environment.clone(),
                    "incident.report",
                    machine(),
                    v5::IncidentReportRequest { query },
                    peer,
                )
                .await,
            );
        }
    }
    invalid(
        call(
            environment.clone(),
            "incident.report",
            session(&fixture.allowed_session),
            window(report(1)),
            Some(&peer),
        )
        .await,
    );
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recent_lists_one_model_newest_first_within_its_limits() {
    let fixture = Fixture::new().await;
    let base = fixture.base;
    let mut rows = (0..30)
        .map(|index| {
            fixture.incident(
                &format!("{index:02}"),
                "guardrail-escalated",
                base + index / 2,
                "gpt",
                if index % 2 == 0 { "build" } else { "plan" },
            )
        })
        .collect::<Vec<_>>();
    rows.push(Incident {
        variant: Some("high".into()),
        ..fixture.incident("fb", "fallback", base + 100, "gpt", "build")
    });
    rows.push(fixture.incident("other", "guardrail-rejected", base + 200, "mini", "build"));
    fixture.insert(rows).await;
    let environment = fixture.environment();
    let peer = peer();
    let provider = fixture.provider.clone();
    for peer in [None, Some(&peer)] {
        let listed: v5::IncidentRecentResult = success(
            call(
                environment.clone(),
                "incident.recent",
                machine(),
                recent(&provider, None, None),
                peer,
            )
            .await,
        );
        let items = &listed.data.items.items;
        assert_eq!(items.len(), 20);
        assert_eq!(
            items
                .iter()
                .take(3)
                .map(|item| units(&item.id))
                .collect::<Vec<_>>(),
            [
                format!("inc_{provider}_fb"),
                format!("inc_{provider}_29"),
                format!("inc_{provider}_28"),
            ]
        );
        let fallback = &items[0];
        assert_eq!(fallback.kind, 1);
        assert_eq!(fallback.time, (base + 100) as u64);
        assert_eq!(units(&fallback.category), "rate_limit");
        assert!(fallback.rule_i_ds.items.is_empty());
        assert_eq!(
            fallback.variant.as_ref().map(units).as_deref(),
            Some("high")
        );
        assert_eq!(
            fallback
                .target
                .as_ref()
                .map(|target| units(&target.id))
                .as_deref(),
            Some("mini")
        );
        assert_eq!(fallback.decided_by, None);
        assert_eq!(
            items[1]
                .rule_i_ds
                .items
                .iter()
                .map(units)
                .collect::<Vec<_>>(),
            ["custom"]
        );
        let all: v5::IncidentRecentResult = success(
            call(
                environment.clone(),
                "incident.recent",
                machine(),
                recent(&provider, None, Some(50)),
                peer,
            )
            .await,
        );
        assert_eq!(all.data.items.items.len(), 31);
        let plan: v5::IncidentRecentResult = success(
            call(
                environment.clone(),
                "incident.recent",
                machine(),
                recent(&provider, Some("plan"), Some(3)),
                peer,
            )
            .await,
        );
        assert_eq!(
            plan.data
                .items
                .items
                .iter()
                .map(|item| units(&item.id))
                .collect::<Vec<_>>(),
            [
                format!("inc_{provider}_29"),
                format!("inc_{provider}_27"),
                format!("inc_{provider}_25"),
            ]
        );
        for limit in [0, 51] {
            invalid(
                call(
                    environment.clone(),
                    "incident.recent",
                    machine(),
                    recent(&provider, None, Some(limit)),
                    peer,
                )
                .await,
            );
        }
    }
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_guidance_follows_the_location_capability_and_clear_keeps_a_monotonic_watermark() {
    let fixture = Fixture::new().await;
    let at = now() - HOUR;
    fixture
        .insert(vec![
            fixture.incident("r1", "guardrail-escalated", at, "gpt", "build"),
            fixture.incident("r2", "guardrail-escalated", at + 1, "gpt", "build"),
        ])
        .await;
    let environment = fixture.environment();
    let provider = fixture.provider.clone();
    let get = |directory: &str| {
        call(
            environment.clone(),
            "incident.guidance.get",
            located(directory),
            v5::IncidentGuidanceGetRequest {
                query: guidance_query(&provider, Some(directory)),
            },
            None,
        )
    };
    let allowed: v5::IncidentGuidanceGetResult = success(get(&fixture.allowed).await);
    assert!(allowed.data.enabled);
    let note = allowed.data.text.as_ref().map(units).unwrap();
    assert!(note.starts_with("<model-guidance>\n"), "{note}");
    assert!(note.contains("Custom guardrail rules (custom)"), "{note}");
    assert_eq!(allowed.data.cleared_at, None);
    let denied: v5::IncidentGuidanceGetResult = success(get(&fixture.denied).await);
    assert!(!denied.data.enabled);
    assert_eq!(denied.data.text.as_ref().map(units), Some(note.clone()));

    let before = now();
    let cleared: v5::IncidentGuidanceClearResult = success(
        call(
            environment.clone(),
            "incident.guidance.clear",
            located(&fixture.allowed),
            v5::IncidentGuidanceClearRequest {
                query: guidance_query(&provider, Some(&fixture.allowed)),
            },
            None,
        )
        .await,
    );
    let watermark = cleared.data.cleared_at.unwrap();
    assert!(watermark >= before as u64);
    assert!(cleared.data.enabled);
    assert_eq!(cleared.data.text, None);
    let read: v5::IncidentGuidanceGetResult = success(get(&fixture.allowed).await);
    assert_eq!(read.data.cleared_at, Some(watermark));
    assert_eq!(read.data.text, None);
    let listed: v5::IncidentRecentResult = success(
        call(
            environment.clone(),
            "incident.recent",
            machine(),
            recent(&provider, None, None),
            None,
        )
        .await,
    );
    assert_eq!(listed.data.items.items.len(), 2);

    let future = now() + DAY;
    let model = provider.clone();
    world()
        .store
        .submit(move |tx| {
            GuidanceClearTable::put(
                tx,
                &GuidanceClear {
                    provider_id: model.as_str().into(),
                    model_id: "gpt".into(),
                    cleared_at: future,
                },
            )
        })
        .unwrap()
        .await
        .unwrap();
    let kept: v5::IncidentGuidanceClearResult = success(
        call(
            environment.clone(),
            "incident.guidance.clear",
            located(&fixture.denied),
            v5::IncidentGuidanceClearRequest {
                query: guidance_query(&provider, None),
            },
            None,
        )
        .await,
    );
    assert_eq!(kept.data.cleared_at, Some(future as u64));
    assert!(!kept.data.enabled);
    invalid(
        call(
            environment.clone(),
            "incident.guidance.get",
            located(&fixture.allowed),
            v5::IncidentGuidanceGetRequest {
                query: guidance_query(&provider, Some(&fixture.denied)),
            },
            None,
        )
        .await,
    );
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_guidance_uses_the_verified_session_location_and_rejects_caller_placement() {
    let fixture = Fixture::new().await;
    let at = now() - HOUR;
    fixture
        .insert(vec![
            fixture.incident("r1", "guardrail-escalated", at, "gpt", "build"),
            fixture.incident("r2", "guardrail-escalated", at + 1, "gpt", "build"),
        ])
        .await;
    let environment = fixture.environment();
    let provider = fixture.provider.clone();
    let peer = peer();
    let remote = |scope: v5::Scope, directory: Option<String>| {
        call(
            environment.clone(),
            "incident.guidance.get",
            scope,
            v5::IncidentGuidanceGetRequest {
                query: guidance_query(&provider, directory.as_deref()),
            },
            Some(&peer),
        )
    };
    let denied: v5::IncidentGuidanceGetResult =
        success(remote(session(&fixture.denied_session), None).await);
    assert!(!denied.data.enabled);
    assert!(denied.data.text.is_some());
    let allowed: v5::IncidentGuidanceGetResult =
        success(remote(session(&fixture.allowed_session), None).await);
    assert!(allowed.data.enabled);
    let forbidden = invalid(
        remote(
            session(&fixture.denied_session),
            Some(fixture.allowed.clone()),
        )
        .await,
    );
    assert_eq!(
        forbidden.kind.as_ref().map(units).as_deref(),
        Some("forbidden")
    );
    invalid(remote(session("ses_incident_unknown"), None).await);
    invalid(remote(machine(), None).await);
    invalid(remote(located(&fixture.allowed), None).await);
    assert!(
        call(
            environment.clone(),
            "incident.guidance.clear",
            session(&fixture.allowed_session),
            v5::IncidentGuidanceClearRequest {
                query: guidance_query(&provider, None),
            },
            Some(&peer),
        )
        .await
        .is_none()
    );
    let unchanged: v5::IncidentGuidanceGetResult =
        success(remote(session(&fixture.allowed_session), None).await);
    assert_eq!(unchanged.data.cleared_at, None);
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn family_guardrail_status_preserves_reviewed_session_provenance_for_local_and_remote_reads()
{
    let fixture = Fixture::new().await;
    let root = &fixture.allowed_session;
    let child = format!("{root}_reviewed");
    let sibling = format!("{root}_sibling");
    let root_info = world()
        .core
        .sessions
        .get(&ycoding_core::ycoding_schema::session::Id::new(root.as_str()).unwrap())
        .unwrap()
        .unwrap();
    for id in [&child, &sibling] {
        world()
            .core
            .sessions
            .create(ycoding_store::session::NewEvent {
                id: format!("evt_create_{id}").into(),
                aggregate_id: id.as_str().into(),
                created: 1,
                type_: "session.created.2".into(),
                data: ObjectEncoder::new()
                    .field("sessionID", id.as_str())
                    .field("projectID", &root_info.project_id)
                    .field("location", &root_info.location)
                    .field("parentID", root.as_str())
                    .field("title", "Provenance")
                    .field("created", &1_f64)
                    .finish(),
            })
            .await
            .unwrap();
    }
    let source =
        parse_json(r#"{"messageID":"msg_provenance","callID":"call_provenance"}"#).unwrap();
    for (suffix, type_, created, data) in [
        (
            "dismissed",
            "session.guardrail.dismissed.1",
            20,
            ObjectEncoder::new()
                .field("sessionID", root.as_str())
                .field("reviewSessionID", child.as_str())
                .field("ruleID", "standard.review.outside-repository")
                .field("confidence", &0.95_f64)
                .field("source", &source)
                .finish(),
        ),
        (
            "decided",
            "session.guardrail.decided.1",
            30,
            ObjectEncoder::new()
                .field("sessionID", root.as_str())
                .field("reviewSessionID", child.as_str())
                .field("requestID", "grq_provenance")
                .field("reply", "once")
                .field("choice", "approve")
                .field("confidence", &0.91_f64)
                .field("ruleIDs", &vec![LosslessString::from("custom.review")])
                .field("source", &source)
                .finish(),
        ),
    ] {
        let event = ycoding_store::session::NewEvent {
            id: format!("evt_{root}_{suffix}").into(),
            aggregate_id: root.as_str().into(),
            created,
            type_: type_.into(),
            data,
        };
        world()
            .store
            .submit(move |tx| ycoding_store::session::append(tx, &event, None))
            .unwrap()
            .await
            .unwrap();
    }
    let peer = peer();
    let environment = fixture.environment();
    let mut expected = None;
    for remote in [None, Some(&peer)] {
        for selected in [root, &child, &sibling] {
            let result: v5::SessionGuardrailStatusResult = success(
                call(
                    environment.clone(),
                    "session.guardrail.status",
                    session(selected),
                    v5::SessionGuardrailStatusRequest {
                        params: v5::SessionGuardrailStatusRequestParams {
                            session_id: text(selected),
                        },
                    },
                    remote,
                )
                .await,
            );
            assert_eq!(units(&result.data.root_session_id), *root);
            let dismissals = &result.data.dismissals.as_ref().unwrap().items;
            let decisions = &result.data.decisions.as_ref().unwrap().items;
            assert_eq!(dismissals.len(), 1);
            assert_eq!(decisions.len(), 1);
            assert_eq!(units(&dismissals[0].session_id), child);
            assert_eq!(units(&decisions[0].session_id), child);
            assert_eq!(dismissals[0].created, 20);
            assert_eq!(decisions[0].created, 30);
            assert_eq!(
                units(&dismissals[0].event_id),
                format!("evt_{root}_dismissed")
            );
            assert_eq!(units(&decisions[0].request_id), "grq_provenance");
            assert_eq!(dismissals[0].source, decisions[0].source);
            let source = dismissals[0].source.as_ref().unwrap();
            assert_eq!(units(&source.message_id), "msg_provenance");
            assert_eq!(units(&source.call_id), "call_provenance");
            for id in [root, &child, &sibling] {
                assert_eq!(
                    dismissals
                        .iter()
                        .filter(|item| units(&item.session_id) == *id)
                        .count(),
                    usize::from(id == &child),
                );
                assert_eq!(
                    decisions
                        .iter()
                        .filter(|item| units(&item.session_id) == *id)
                        .count(),
                    usize::from(id == &child),
                );
            }
            let history = (result.data.dismissals, result.data.decisions);
            if let Some(expected) = &expected {
                assert_eq!(&history, expected);
            } else {
                expected = Some(history);
            }
        }
    }
    let mismatched = call(
        environment,
        "session.guardrail.status",
        session(&sibling),
        v5::SessionGuardrailStatusRequest {
            params: v5::SessionGuardrailStatusRequestParams {
                session_id: text(&child),
            },
        },
        Some(&peer),
    )
    .await;
    let payload = mismatched.expect("guardrail status is exposed");
    assert_ne!(
        payload.type_name,
        v5::SessionGuardrailStatusResult::full_name()
    );
    for id in [&child, &sibling] {
        let log = world()
            .core
            .sessions
            .log(
                &ycoding_core::ycoding_schema::session::Id::new(id.as_str()).unwrap(),
                None,
                512,
            )
            .unwrap();
        assert_eq!(log.events.len(), 1);
        assert_eq!(log.watermark, Some(0));
    }
    fixture.close().await;
}
