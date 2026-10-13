use std::{
    ops::Bound,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use ycoding_core::{
    resources::{
        agent, attachment_store,
        catalog::Catalog,
        command, credential, model,
        project_artifact::{accounting, source, source_registry, store as artifact_store},
        skill,
    },
    session::{
        run_coordinator::Coordinator,
        runner::{self, Local},
        store::Service,
    },
    tools::registry::Registry,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, ObjectEncoder, location, parse_json, project,
    project_artifact, session,
};
use ycoding_store::{
    KeyPart, Metadata, Options, Store, artifacts, import,
    session::{EventTable, InstructionStateTable},
    tuple_key,
};

#[path = "session_support/guardrails.rs"]
mod guardrails;
#[path = "session_support/mod.rs"]
#[allow(dead_code)]
mod support;

struct FixedClock;
impl runner::Clock for FixedClock {
    fn now(&self) -> i64 {
        1001
    }
    fn sleep(&self, _: u64) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        Box::pin(async {})
    }
}

struct Fixture {
    db: Store,
    root: PathBuf,
    artifacts: artifact_store::Service,
    runner: Local,
    scope: project_artifact::ScopeId,
}
impl Fixture {
    async fn new(managed: bool) -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "ycoding-session-move-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let db = Store::disposable(
            Options::core(),
            import::catalog(import::DatabaseKind::Core),
            Metadata::new([87; 16], 1),
        )
        .unwrap();
        db.submit(|tx| {
            for id in ["prj_one", "prj_two"] {
                ycoding_store::project::ProjectTable::insert(
                    tx,
                    &ycoding_store::project::Project {
                        id: id.into(),
                        worktree: "/project".into(),
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
                )?;
            }
            let mut row = support::record("ses_one");
            row.agent = Some("review".into());
            ycoding_store::session::SessionTable::insert(tx, &row)?;
            ycoding_store::session::SessionTable::insert(tx, &support::record("ses_two"))?;
            InstructionStateTable::insert(
                tx,
                &ycoding_store::session::InstructionState {
                    session_id: "ses_one".into(),
                    epoch_start: 0,
                    through_seq: 0,
                    initial_values: ycoding_store::session::Document::new(
                        parse_json("{}").unwrap(),
                    )?,
                    current_values: ycoding_store::session::Document::new(
                        parse_json("{}").unwrap(),
                    )?,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
        let registry = Arc::new(Mutex::new(source_registry::Registry::default()));
        let accounting = accounting::Service::new(db.client(), "test-secret".into());
        let artifacts = artifact_store::Service::new(
            db.client(),
            artifact_store::Paths {
                data: root.join("data"),
                home: root.join("home"),
                config: root.join("config"),
            },
            registry.clone(),
        )
        .with_accounting(accounting.clone());
        let definition = project_artifact::Definition::decode(&parse_json(r#"{"kind":"agent","name":"Review","description":"Review changes","mode":"subagent","system":"Review the changes.","permissions":[]}"#).unwrap()).unwrap();
        let written = artifacts
            .write_manual(artifact_store::ManualWriteInput {
                scope: project_artifact::ScopeSelector::Project,
                project_id: Some(project::Id::new("prj_one").unwrap()),
                id: "review",
                definition: &definition,
                expected: None,
                now: 1,
            })
            .unwrap();
        let agents = agent::Service::new(vec![agent::empty("build".into())]);
        let location =
            location::Ref::decode(&parse_json(r#"{"directory":"/project"}"#).unwrap()).unwrap();
        let source = source::Service::new(
            source::Options {
                client: db.client(),
                store: artifacts.clone(),
                accounting,
                registry,
                location: location.clone(),
                project_id: project::Id::new("prj_one").unwrap(),
                project_directory: "/project".into(),
                data_root: root.join("data"),
            },
            source::Catalogs {
                agents: agents.clone(),
                commands: command::Service::default(),
                skills: skill::Service::new(&root.join("cache")),
            },
        );
        source.refresh().await;
        assert_eq!(
            source.provenance(&kind(), "review").unwrap().scope,
            "project"
        );
        let store = if managed {
            Service::new(db.client()).with_artifact_source(source.clone())
        } else {
            Service::new(db.client())
        };
        let runner = Local::new(runner::Services {
            store,
            events: ycoding_core::event_feed::Feed::attach(&db.client()),
            location,
            models: Arc::new(model::Resolver::new(Catalog::default())),
            agents: Arc::new(agents),
            credentials: credential::Service::new(db.client()),
            tools: Arc::new(Registry::new(
                Arc::new(ycoding_core::resources::tool_output_store::Store::new(
                    &ycoding_core::resources::config::Roots::development(&root).unwrap(),
                )),
                None,
                Default::default(),
                Arc::new(|a, b| a.cmp(b)),
            )),
            attachments: Arc::new(attachment_store::Store::new(root.join("attachments")).unwrap()),
            instructions: vec![],
            analysis: None,
            clock: Arc::new(FixedClock),
            executor: Arc::new(runner::Executor::new(
                runner::Executor::http_client().unwrap(),
            )),
            compaction: Default::default(),
            guardrails: guardrails::guardrails(&db),
            helpers: Default::default(),
            cursor: None,
            claude: None,
            auth: None,
            skill_resolver: None,
            snapshots: None,
            configuration: None,
            image_analyzer: None,
            extensions: vec![],
            session_tools: None,
        });
        Self {
            db,
            root,
            artifacts,
            runner,
            scope: written.scope_id,
        }
    }
    fn activate(&self, id: &str, session: &str, boundary_seq: f64) {
        let details = self
            .artifacts
            .get(
                &self.scope,
                &kind(),
                &project_artifact::Id::decode(&JsonValue::String("review".into())).unwrap(),
            )
            .unwrap();
        self.artifacts
            .accounting()
            .unwrap()
            .activate(
                &project_artifact::Activation::decode(
                    &ObjectEncoder::new()
                        .field("id", id)
                        .field(
                            "artifact",
                            &ObjectEncoder::new()
                                .field("scopeID", &self.scope)
                                .field("kind", &kind())
                                .field("id", "review")
                                .field("versionID", &details.current_version.id)
                                .finish(),
                        )
                        .field("projectID", "prj_one")
                        .field("sessionID", session)
                        .field("source", "agent-selected")
                        .field("boundarySeq", &boundary_seq)
                        .field("activatedAt", &1.0)
                        .finish(),
                )
                .unwrap(),
            )
            .unwrap();
    }
    fn events(&self) -> Vec<ycoding_store::session::Event> {
        let mut events = self
            .db
            .snapshot()
            .unwrap()
            .scan::<EventTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
            .unwrap();
        events.sort_by_key(|event| event.seq);
        events
    }
    fn activations(&self) -> Vec<artifacts::Activation> {
        self.db
            .snapshot()
            .unwrap()
            .scan::<artifacts::ActivationTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.root.exists() {
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }
}
fn kind() -> project_artifact::Kind {
    project_artifact::Kind::decode(&JsonValue::String("agent".into())).unwrap()
}
fn sid() -> session::Id {
    session::Id::new("ses_one").unwrap()
}
fn destination(project: &str, directory: &str) -> location::Info {
    location::Info::decode(
        &ObjectEncoder::new()
            .field("directory", directory)
            .field(
                "project",
                &ObjectEncoder::new()
                    .field("id", project)
                    .field("directory", "/project")
                    .finish(),
            )
            .finish(),
    )
    .unwrap()
}

#[tokio::test]
async fn move_deactivates_only_the_sessions_old_project_and_projects_ordered_events() {
    let fixture = Fixture::new(true).await;
    fixture.activate("paa_move", "ses_one", 0.0);
    fixture.activate("paa_other", "ses_two", 0.0);
    fixture.activate("paa_closed", "ses_one", 9.0);
    fixture
        .db
        .submit(|tx| {
            let key = tuple_key(&[KeyPart::String(&"paa_closed".into())]);
            let mut row = tx.get::<artifacts::ActivationTable>(&key)?.unwrap();
            row.deactivated_at = Some(900);
            row.boundary_seq = 9;
            artifacts::ActivationTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    let coordinator = Coordinator::new(Arc::new(fixture.runner.clone()));
    fixture
        .runner
        .move_to(
            &coordinator,
            &sid(),
            &destination("prj_two", "/project/new"),
            fixture.artifacts.accounting(),
            Some(&"build".into()),
        )
        .await
        .unwrap();
    let activations = fixture.activations();
    let ended = activations
        .iter()
        .find(|a| a.id.as_str() == Some("paa_move"))
        .unwrap();
    assert_eq!(ended.deactivated_at, Some(1001));
    assert_eq!(ended.boundary_seq, fixture.events()[0].seq);
    assert!(
        activations
            .iter()
            .find(|a| a.id.as_str() == Some("paa_other"))
            .unwrap()
            .deactivated_at
            .is_none()
    );
    let closed = activations
        .iter()
        .find(|row| row.id.as_str() == Some("paa_closed"))
        .unwrap();
    assert_eq!(closed.deactivated_at, Some(900));
    assert_eq!(closed.boundary_seq, 9);
    let events = fixture.events();
    assert_eq!(
        events
            .iter()
            .map(|e| e.type_.as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "session.project-artifacts-ended.1",
            "session.agent.selected.1",
            "session.moved.1"
        ]
    );
    assert_eq!(
        events[0].data,
        parse_json(r#"{"sessionID":"ses_one","oldProjectID":"prj_one","newProjectID":"prj_two"}"#)
            .unwrap()
    );
    let info = Service::new(fixture.db.client())
        .get(&sid())
        .unwrap()
        .unwrap();
    assert_eq!(info.project_id, project::Id::new("prj_two").unwrap());
    assert_eq!(info.agent.unwrap().as_str(), Some("build"));
    assert_eq!(
        info.subpath.unwrap().encode(),
        JsonValue::String("new".into())
    );
    assert!(
        fixture
            .db
            .snapshot()
            .unwrap()
            .get::<InstructionStateTable>(&tuple_key(&[KeyPart::String(&"ses_one".into())]))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        Service::new(fixture.db.client())
            .snapshot(&sid(), 100, None)
            .unwrap()
            .messages
            .len(),
        2
    );
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn no_op_and_same_project_moves_keep_agent_and_accounting() {
    let fixture = Fixture::new(true).await;
    fixture.activate("paa_move", "ses_one", 0.0);
    let coordinator = Coordinator::new(Arc::new(fixture.runner.clone()));
    fixture
        .runner
        .move_to(
            &coordinator,
            &sid(),
            &destination("prj_one", "/project"),
            None,
            None,
        )
        .await
        .unwrap();
    assert!(fixture.events().is_empty());
    fixture
        .runner
        .move_to(
            &coordinator,
            &sid(),
            &destination("prj_one", "/project/new"),
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(fixture.events().len(), 1);
    assert_eq!(fixture.events()[0].type_.as_str(), Some("session.moved.1"));
    assert!(fixture.activations()[0].deactivated_at.is_none());
    assert_eq!(
        Service::new(fixture.db.client())
            .get(&sid())
            .unwrap()
            .unwrap()
            .agent
            .unwrap()
            .as_str(),
        Some("review")
    );
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn project_agents_follow_destination_default_and_standard_agents_stay_selected() {
    for (managed, default, expected) in [
        (true, Some("review"), "review"),
        (true, Some("build"), "build"),
        (true, None, "review"),
        (false, Some("build"), "review"),
    ] {
        let fixture = Fixture::new(managed).await;
        let coordinator = Coordinator::new(Arc::new(fixture.runner.clone()));
        let agents = default.map(|default| {
            let mut agents = agent::Service::new(vec![
                agent::empty("review".into()),
                agent::empty("build".into()),
            ]);
            agents.set_default(Some(default.into()));
            agents
        });
        fixture
            .runner
            .move_to(
                &coordinator,
                &sid(),
                &destination("prj_two", "/project/new"),
                fixture.artifacts.accounting(),
                agents
                    .as_ref()
                    .and_then(|agents| agents.default())
                    .map(|agent| &agent.id),
            )
            .await
            .unwrap();
        assert_eq!(
            Service::new(fixture.db.client())
                .get(&sid())
                .unwrap()
                .unwrap()
                .agent
                .unwrap()
                .as_str(),
            Some(expected)
        );
        assert_eq!(
            fixture
                .events()
                .iter()
                .filter(|event| event.type_.as_str() == Some("session.agent.selected.1"))
                .count(),
            usize::from(managed && default.is_some())
        );
        coordinator.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn failed_deactivation_transaction_rolls_back_activation_and_event() {
    let fixture = Fixture::new(true).await;
    fixture.activate("paa_move", "ses_one", 0.0);
    let accounting = fixture.artifacts.accounting().unwrap().clone();
    let result = fixture.db.submit(move |tx| {
        let ycoding_store::session::Append::Appended(event) = ycoding_store::session::append(tx, &ycoding_store::session::NewEvent {
            id: "evt_rollback".into(), aggregate_id: "ses_one".into(), created: 1001,
            type_: "session.project-artifacts-ended.1".into(),
            data: parse_json(r#"{"sessionID":"ses_one","oldProjectID":"prj_one","newProjectID":"prj_two"}"#).unwrap(),
        }, None)? else { panic!("new event must append") };
        assert_eq!(accounting.deactivate_project_in_transaction(tx, &"ses_one".into(), &"prj_one".into(), event.seq, 1001)?, 1);
        Err::<(), _>(ycoding_store::Error::Rejected("rollback"))
    }).unwrap().await;
    assert!(result.is_err());
    assert!(fixture.events().is_empty());
    assert!(fixture.activations()[0].deactivated_at.is_none());
    assert_eq!(fixture.activations()[0].boundary_seq, 0);
}

#[tokio::test]
async fn accounting_failure_does_not_commit_project_end_selection_or_move() {
    let fixture = Fixture::new(true).await;
    let coordinator = Coordinator::new(Arc::new(fixture.runner.clone()));
    assert!(
        fixture
            .runner
            .move_to(
                &coordinator,
                &sid(),
                &destination("prj_two", "/project/new"),
                None,
                Some(&"build".into())
            )
            .await
            .is_err()
    );
    assert!(fixture.events().is_empty());
    assert_eq!(
        Service::new(fixture.db.client())
            .get(&sid())
            .unwrap()
            .unwrap()
            .project_id,
        project::Id::new("prj_one").unwrap()
    );
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn move_subpath_is_lexically_relative_even_when_the_project_has_another_path_prefix() {
    let fixture = Fixture::new(true).await;
    let coordinator = Coordinator::new(Arc::new(fixture.runner.clone()));
    fixture
        .runner
        .move_to(
            &coordinator,
            &sid(),
            &destination("prj_one", "/alias/project"),
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        Service::new(fixture.db.client())
            .get(&sid())
            .unwrap()
            .unwrap()
            .subpath
            .unwrap()
            .encode(),
        JsonValue::String("../alias/project".into())
    );
    coordinator.shutdown().await.unwrap();
}
