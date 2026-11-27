use std::{ops::Bound, path::PathBuf, sync::Arc};
use ycoding_core::{
    resources::{agent, attachment_store, catalog::Catalog, credential, model},
    session::{
        run_coordinator::Coordinator,
        runner::{self, Local},
        store::Service,
    },
    tools::registry::Registry,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, ObjectEncoder, location, parse_json, session,
};
use ycoding_store::{
    Metadata, Options, Store, native,
    session::{EventTable, InstructionStateTable},
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
    runner: Local,
}
impl Fixture {
    async fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "ycoding-session-move-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let db = Store::disposable(
            Options::core(),
            native::catalog(native::DatabaseKind::Core),
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
        let agents = agent::Service::new(vec![agent::empty("build".into())]);
        let location =
            location::Ref::decode(&parse_json(r#"{"directory":"/project"}"#).unwrap()).unwrap();
        let store = Service::new(db.client());
        let clock: Arc<dyn runner::Clock> = Arc::new(FixedClock);
        let runner = Local::new(runner::Services {
            generation: ycoding_core::generation_activity::Service::new(clock.now(), clock.nanos()),
            store,
            events: ycoding_core::event_feed::Feed::attach(&db.client()),
            location,
            models: Arc::new(model::Resolver::new(Catalog::default())),
            agents: ycoding_core::resources::domain_state::DomainState::new(agents),
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
            clock,
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
        Self { db, root, runner }
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
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.root.exists() {
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }
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
async fn no_op_and_same_project_moves_keep_agent_and_publish_only_the_move() {
    let fixture = Fixture::new().await;
    let coordinator = Coordinator::new(Arc::new(fixture.runner.clone()));
    fixture
        .runner
        .move_to(&coordinator, &sid(), &destination("prj_one", "/project"))
        .await
        .unwrap();
    assert!(fixture.events().is_empty());
    fixture
        .runner
        .move_to(
            &coordinator,
            &sid(),
            &destination("prj_one", "/project/new"),
        )
        .await
        .unwrap();
    assert_eq!(fixture.events().len(), 1);
    assert_eq!(fixture.events()[0].type_.as_str(), Some("session.moved.1"));
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
async fn move_subpath_is_lexically_relative_even_when_the_project_has_another_path_prefix() {
    let fixture = Fixture::new().await;
    let coordinator = Coordinator::new(Arc::new(fixture.runner.clone()));
    fixture
        .runner
        .move_to(
            &coordinator,
            &sid(),
            &destination("prj_one", "/alias/project"),
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
