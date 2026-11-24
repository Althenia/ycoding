mod support;

use prost::Message;
use std::{
    ops::Bound,
    sync::{Arc, OnceLock},
};
use support::{CATALOG, Client, WAIT, record, session_scope, start, success, text};
use tokio::{sync::Notify, time::timeout};
use ycoding_core::{
    coordination,
    event_feed::Feed,
    generation_activity,
    job::Jobs,
    platform::git,
    process::guardrails::{Limits, Paths, Settings},
    resources::agent,
    session::{
        execution::{Execution, Locations, Runner},
        pending,
        run_coordinator::{DrainRequest, Error, InterruptReason, Outcome, RunFuture},
        runner::{Clock, WallClock},
        store::Service,
    },
    ycoding_schema::{
        DomainDecode, coordination as project_domain, event, parse_json, session, session_message,
        session_pending,
    },
    ycoding_store::{
        Client as StoreClient, IndexOrder, IndexQuery, KeyPart, Metadata, Options, Store, project,
        session::{Event, EventTable, SessionTable},
        tuple_key,
    },
};
use ycoding_protocol::v5;
use ycoding_runtime::{Configuration, Core, LocalAuth, SnapshotSettings, standard};

const TARGET: &str = "ses_interrupt_successor";
const MASTER: &str = "ses_interrupt_master";
const MEMBER: &str = "ses_interrupt_member";

#[derive(Default)]
struct HeldRunner {
    original: Arc<Notify>,
    settling: Arc<Notify>,
    release: Arc<Notify>,
    successor: Arc<Notify>,
}

impl Runner for HeldRunner {
    fn drain(&self, mut request: DrainRequest) -> RunFuture {
        assert_eq!(request.session_id.as_lossless().as_str(), Some(TARGET));
        if request.force {
            self.original.notify_one();
        } else {
            self.successor.notify_one();
        }
        Box::pin(async move { Err(Error::Interrupted(request.cancellation.cancelled().await)) })
    }

    fn settled(&self, _: session::Id, outcome: Outcome) -> RunFuture {
        let settling = self.settling.clone();
        let release = self.release.clone();
        Box::pin(async move {
            if matches!(outcome, Err(Error::Interrupted(InterruptReason::User))) {
                settling.notify_one();
                release.notified().await;
            }
            Ok(())
        })
    }
}

struct TestLocations(Arc<HeldRunner>);

impl Locations for TestLocations {
    fn get(&self, _: &session::Info) -> Result<Arc<dyn Runner>, Error> {
        Ok(self.0.clone())
    }
}

struct Fixture {
    store: StoreClient,
    core: Core,
    runner: Arc<HeldRunner>,
}

impl Fixture {
    fn get() -> &'static Self {
        static FIXTURE: OnceLock<Fixture> = OnceLock::new();
        FIXTURE.get_or_init(|| {
            let store =
                Store::disposable(Options::core(), CATALOG, Metadata::new([7; 16], 1)).unwrap();
            store
                .submit(|tx| {
                    project::ProjectTable::insert(
                        tx,
                        &project::Project {
                            id: "prj_one".into(),
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
                    for id in [TARGET, MASTER, MEMBER] {
                        SessionTable::insert(tx, &record(id))?;
                    }
                    Ok(())
                })
                .unwrap()
                .wait()
                .unwrap();
            let runner = Arc::new(HeldRunner::default());
            let execution = Execution::install(
                Service::new(store.client()),
                Arc::new(TestLocations(runner.clone())),
                Jobs::new(),
                None,
            )
            .unwrap();
            let core = Core::new(
                store.client(),
                execution,
                Configuration {
                    agents: Arc::new(agent::Service::new(vec![agent::empty("build".into())])),
                    publisher: Arc::new(|_| Ok(())),
                    guardrails: Settings {
                        paths: Paths {
                            workdir: "/project".into(),
                            project: "/project".into(),
                            home: "/home/operator".into(),
                            tmpdir: None,
                            trusted_paths: vec![],
                        },
                        global_roots: vec![],
                        custom: Arc::new(Vec::new),
                        enabled: false,
                        limits: Limits::default(),
                        decide_reviews: false,
                        decide_hard_reviews: false,
                    },
                    snapshots: SnapshotSettings {
                        git: Arc::new(git::Service::new(16 * 1024 * 1024)),
                        data: Default::default(),
                        enabled: false,
                    },
                    helpers: None,
                },
                generation_activity::Service::new(WallClock.now(), WallClock.nanos()),
                Default::default(),
            );
            let client = store.client();
            std::mem::forget(store);
            Self {
                store: client,
                core,
                runner,
            }
        })
    }

    fn execution_events(&self, session: &str, kind: &str) -> Vec<Event> {
        let prefix = tuple_key(&[
            KeyPart::String(&session.into()),
            KeyPart::String(&kind.into()),
        ]);
        self.store
            .snapshot()
            .unwrap()
            .index_range::<EventTable>(
                "event_aggregate_type_seq_idx",
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Unbounded,
                    prefix: Some(&prefix),
                    order: IndexOrder::Ascending,
                    after: None,
                    limit: 8,
                },
            )
            .unwrap()
            .into_iter()
            .map(|row| row.record)
            .collect()
    }

    async fn server(&self) -> ycoding_runtime::Server {
        let mut settings = support::services(LocalAuth::disabled(), false);
        settings.core = Some(self.core.clone());
        start(settings, standard().unwrap()).await
    }
}

fn interrupt(id: &str) -> Vec<u8> {
    v5::SessionInterruptRequest {
        params: v5::SessionInterruptRequestParams {
            session_id: text(id),
        },
    }
    .encode_to_vec()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interrupt_replies_after_durable_settlement_without_waiting_for_the_successor() {
    let fixture = Fixture::get();
    let execution = fixture.core.execution;
    let id = session::Id::new(TARGET).unwrap();
    let server = fixture.server().await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();
    execution.request_resume(&id).await.unwrap();
    timeout(WAIT, fixture.runner.original.notified())
        .await
        .unwrap();

    let request = client
        .send(
            "session.interrupt",
            session_scope(TARGET),
            interrupt(TARGET),
        )
        .await;
    let mut reply = std::pin::pin!(async move {
        let reply = client.settle(&request).await;
        let durable = fixture.execution_events(TARGET, "session.execution.interrupted.1");
        (reply, durable)
    });
    let prepare_successor = async {
        fixture.runner.settling.notified().await;
        fixture
            .core
            .sessions
            .admit(pending::Request {
                id: session_message::Id::new("msg_interrupt_successor").unwrap(),
                session_id: id.clone(),
                input: session_pending::Message::decode(
                    &parse_json(
                        r#"{"type":"user","delivery":"steer","data":{"text":"Successor input"}}"#,
                    )
                    .unwrap(),
                )
                .unwrap(),
                event_id: event::Id::new("evt_interrupt_successor").unwrap(),
                created: 2,
            })
            .await
            .unwrap();
        execution.wake(&id).unwrap();
    };
    tokio::select! {
        biased;
        _ = &mut reply => panic!("interrupt replied before settlement"),
        result = timeout(WAIT, prepare_successor) => result.expect("interrupt did not settle with a queued successor"),
    }
    fixture.runner.release.notify_one();
    let (started, received) = tokio::join!(
        timeout(WAIT, fixture.runner.successor.notified()),
        timeout(WAIT, &mut reply),
    );
    started.expect("successor did not start");
    assert!(execution.active().contains(&id));
    fixture.runner.release.notify_one();
    execution.interrupt(&id).await.unwrap();
    if received.is_err() {
        let _: v5::SessionInterruptResult = success(timeout(WAIT, reply).await.unwrap().0);
    }
    server.shutdown().await.unwrap();

    let (reply, durable) = received.expect("interrupt waited for the already running successor");
    let _: v5::SessionInterruptResult = success(reply);
    assert_eq!(
        durable.len(),
        1,
        "the original interruption must be durable when the reply arrives"
    );
    let starts = fixture.execution_events(TARGET, "session.execution.started.1");
    assert_eq!(starts.len(), 2);
    assert!(starts[0].seq < durable[0].seq && durable[0].seq < starts[1].seq);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interrupting_an_idle_project_master_persists_the_pause_before_replying() {
    let fixture = Fixture::get();
    let id = session::Id::new(MASTER).unwrap();
    let project = fixture
        .core
        .coordination
        .create(project_domain::CreateInput {
            name: "Idle interrupt".into(),
            master_session_id: id.clone(),
            member_session_ids: vec![session::Id::new(MEMBER).unwrap()],
        })
        .await
        .unwrap();
    fixture.core.coordination.activate(&project.id).unwrap();
    assert!(fixture.core.coordination.get(&project.id).unwrap().active);
    assert!(!fixture.core.execution.active().contains(&id));

    let server = fixture.server().await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();
    let _: v5::SessionInterruptResult = success(
        client
            .call(
                "session.interrupt",
                session_scope(MASTER),
                interrupt(MASTER),
            )
            .await,
    );
    let store = fixture.store.clone();
    let fresh = coordination::Service::new(store.clone(), Feed::attach(&store));
    let persisted = fresh.get(&project.id).unwrap();
    drop(client);
    server.shutdown().await.unwrap();

    assert!(
        fixture
            .execution_events(MASTER, "session.execution.started.1")
            .is_empty()
    );
    assert!(
        fixture
            .execution_events(MASTER, "session.execution.interrupted.1")
            .is_empty()
    );
    assert_eq!(
        persisted.paused_reason,
        Some(project_domain::PausedReason::Interrupted)
    );
    assert!(!persisted.active);
}
