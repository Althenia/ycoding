use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Semaphore;
use ycoding_core::{
    coordination::{
        self, Service as Coordination,
        runtime::{
            DecisionEscalateInput, DecisionEscalateResult, DecisionResult, Decisions,
            EvaluateInput, Future, Options, Pending, PendingInput, Runtime, SendInput,
        },
    },
    event_feed::Feed,
    job,
    session::{
        execution::{Execution, Locations, Runner},
        run_coordinator::{DrainRequest, Error, RunFuture},
        store::Service,
    },
};
use ycoding_schema::{
    JsonValue, coordination as c, session, session_delivery::Delivery, session_error,
    session_message,
};
use ycoding_store::{Metadata, Options as StoreOptions, Store, native, session::SessionTable};

#[path = "record.rs"]
mod record;

const BOUND: Duration = Duration::from_secs(10);

pub fn id(text: &str) -> session::Id {
    session::Id::new(text).unwrap()
}

pub fn message(text: &str) -> session_message::Id {
    session_message::Id::new(text).unwrap()
}

pub async fn quiesce(execution: &Execution, session: &session::Id) {
    tokio::time::timeout(BOUND, execution.await_idle(session))
        .await
        .expect("Session execution settles");
}

#[derive(Default)]
pub struct Waits(pub Mutex<Vec<Pending>>);

struct Gates(Arc<Waits>);

impl Decisions for Gates {
    fn settings(&self) -> Future<'_, c::Settings> {
        Box::pin(async { Err(coordination::Error::refused("outside this fixture")) })
    }
    fn pending(&self, input: PendingInput) -> Future<'_, Vec<Pending>> {
        let items = if input.target_session_id == id("ses_alpha") {
            self.0.0.lock().unwrap().clone()
        } else {
            vec![]
        };
        Box::pin(async move { Ok(items) })
    }
    fn evaluate(&self, _: EvaluateInput) -> Future<'_, DecisionResult> {
        Box::pin(async { Err(coordination::Error::refused("outside this fixture")) })
    }
    fn escalate(&self, _: DecisionEscalateInput) -> Future<'_, DecisionEscalateResult> {
        Box::pin(async { Err(coordination::Error::refused("outside this fixture")) })
    }
}

pub struct Script {
    drains: Mutex<BTreeMap<String, usize>>,
    pub failing: Mutex<BTreeSet<String>>,
    pub blocking: Mutex<BTreeSet<String>>,
    member_started: Semaphore,
    pub release: Semaphore,
}

impl Script {
    fn new() -> Self {
        Self {
            drains: Mutex::default(),
            failing: Mutex::default(),
            blocking: Mutex::default(),
            member_started: Semaphore::new(0),
            release: Semaphore::new(0),
        }
    }
    pub async fn wait_for_member_start(&self) {
        tokio::time::timeout(BOUND, self.member_started.acquire())
            .await
            .expect("Project member reaches the runner")
            .unwrap()
            .forget();
    }
    pub fn drains(&self, session: &str) -> usize {
        self.drains
            .lock()
            .unwrap()
            .get(session)
            .copied()
            .unwrap_or(0)
    }
}

struct Scripted {
    sessions: Service,
    script: Arc<Script>,
}

impl Runner for Scripted {
    fn drain(&self, request: DrainRequest) -> RunFuture {
        let sessions = self.sessions.clone();
        let script = self.script.clone();
        Box::pin(async move {
            let name = request.session_id.as_lossless().to_utf8().unwrap();
            *script
                .drains
                .lock()
                .unwrap()
                .entry(name.clone())
                .or_default() += 1;
            if name == "ses_alpha" {
                script.member_started.add_permits(1);
            }
            if script.blocking.lock().unwrap().remove(&name) {
                script.release.acquire().await.unwrap().forget();
            }
            sessions.promote_steers(&request.session_id, 30).await?;
            sessions
                .promote_next_queued(&request.session_id, 30)
                .await?;
            if script.failing.lock().unwrap().remove(&name) {
                return Err(Error::Runner(session_error::Error {
                    r#type: "unknown".into(),
                    message: "Synthetic turn failure after start".into(),
                }));
            }
            Ok(())
        })
    }
}

struct Placement(Arc<Scripted>);

impl Locations for Placement {
    fn get(&self, _: &ycoding_schema::session::Info) -> Result<Arc<dyn Runner>, Error> {
        Ok(self.0.clone())
    }
}

pub fn trace(sessions: &Service, session: &session::Id) -> Vec<String> {
    sessions
        .log(session, None, 200)
        .unwrap()
        .events
        .into_iter()
        .filter_map(|entry| {
            let kind = entry.event.0.event_type.to_utf8().unwrap();
            let data = &entry.event.0.data.0;
            match kind.as_str() {
                "session.input.admitted" => match data.get(&"inputID".into()) {
                    Some(JsonValue::String(input)) => {
                        Some(format!("admitted:{}", input.to_utf8().unwrap()))
                    }
                    _ => None,
                },
                "session.execution.started" => Some("started".into()),
                "session.execution.succeeded" => Some("succeeded".into()),
                "session.execution.failed" => Some("failed".into()),
                "session.execution.interrupted" => Some("interrupted".into()),
                _ => None,
            }
        })
        .collect()
}

pub fn send(text: &str, message_id: &str) -> SendInput {
    send_to("ses_alpha", text, message_id)
}

pub fn send_to(member: &str, text: &str, message_id: &str) -> SendInput {
    SendInput {
        session_id: id(member),
        text: text.into(),
        delivery: Some(Delivery::Queue),
        message_id: Some(message(message_id)),
        model: None,
    }
}

pub struct Fixture {
    pub store: Store,
    pub feed: Feed,
    pub group: coordination::Group,
    pub coordination: Coordination,
    pub sessions: Service,
    pub execution: &'static Execution,
    jobs: job::Jobs,
    pub script: Arc<Script>,
    pub waits: Arc<Waits>,
}

impl Fixture {
    pub fn runtime(&self) -> Runtime {
        Runtime::new(Options {
            coordination: self.coordination.clone(),
            sessions: Service::new(self.store.client()),
            execution: self.execution,
            decisions: Arc::new(Gates(self.waits.clone())),
            jobs: self.jobs.clone(),
            validate_model: Arc::new(|_, _| Box::pin(async { Ok(()) })),
            model_services: Arc::new(|_| {
                Box::pin(async { Err(coordination::Error::refused("outside this fixture")) })
            }),
            creator: None,
        })
    }
}

pub async fn fixture(
    members: impl IntoIterator<Item = &'static str> + Clone + Send + 'static,
) -> Fixture {
    let store = Store::disposable(
        StoreOptions::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([9; 16], 1),
    )
    .unwrap();
    let client = store.client();
    let inserted_members = members.clone();
    client
        .submit(move |tx| {
            ycoding_store::project::ProjectTable::insert(
                tx,
                &ycoding_store::project::Project {
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
            for name in ["ses_master"].into_iter().chain(inserted_members) {
                SessionTable::insert(tx, &record::record(name))?;
            }
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
    let feed = Feed::attach(&client);
    let coordination = Coordination::new(client.clone(), feed.clone());
    let group = coordination
        .create(c::CreateInput {
            name: "Admission".into(),
            master_session_id: id("ses_master"),
            member_session_ids: members.into_iter().map(id).collect(),
        })
        .await
        .unwrap();
    let sessions = Service::new(client.clone());
    let jobs = job::Jobs::new();
    let script = Arc::new(Script::new());
    let execution = Execution::install(
        sessions.clone(),
        Arc::new(Placement(Arc::new(Scripted {
            sessions: sessions.clone(),
            script: script.clone(),
        }))),
        jobs.clone(),
        None,
    )
    .unwrap();
    Fixture {
        store,
        feed,
        group,
        coordination,
        sessions,
        execution,
        jobs,
        script,
        waits: Arc::new(Waits::default()),
    }
}
