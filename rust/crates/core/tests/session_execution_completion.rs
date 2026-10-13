use serde_json::json;
use std::{
    collections::HashMap,
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::oneshot;
use ycoding_core::{
    job,
    session::{
        autonomy::{self, Goal},
        execution::{Execution, Locations, Runner},
        pending::Request,
        run_coordinator::{DrainRequest, Error, InterruptReason, RunFuture},
        store::Service,
    },
    tools::builtin::shell::{Job, Jobs, Notice},
};
use ycoding_schema::{
    DomainDecode, location, parse_json, session, session_error, session_message, session_pending,
};
use ycoding_store::{
    Client,
    session::{EventTable, NewEvent, SessionTable, append},
};

#[path = "session_support/mod.rs"]
mod support;

static EVENTS: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone, Copy)]
enum Script {
    Idle,
    Verified,
    VerifiedThenFail,
    VerifiedThenInterrupted,
}

type Scripts = Arc<Mutex<HashMap<session::Id, Script>>>;

struct Scripted {
    service: Service,
    client: Client,
    scripts: Scripts,
}

impl Runner for Scripted {
    fn drain(&self, request: DrainRequest) -> RunFuture {
        let (service, client) = (self.service.clone(), self.client.clone());
        let script = self
            .scripts
            .lock()
            .unwrap()
            .get(&request.session_id)
            .copied()
            .unwrap_or(Script::Idle);
        Box::pin(async move {
            service.promote_steers(&request.session_id, 10).await?;
            if matches!(script, Script::Idle) {
                return Ok(());
            }
            exchange(&client, request.session_id.as_lossless().to_utf8().unwrap());
            match script {
                Script::VerifiedThenFail => Err(Error::Runner(session_error::Error {
                    r#type: "unknown".into(),
                    message: "run failed".into(),
                })),
                Script::VerifiedThenInterrupted => Err(Error::Interrupted(InterruptReason::User)),
                Script::Idle | Script::Verified => Ok(()),
            }
        })
    }
}

struct Placement(Arc<Scripted>);

impl Locations for Placement {
    fn get(&self, _: &location::Ref) -> Result<Arc<dyn Runner>, Error> {
        Ok(self.0.clone())
    }
}

struct World {
    client: Client,
    jobs: job::Jobs,
    execution: &'static Execution,
    scripts: Scripts,
}

static WORLD: LazyLock<World> = LazyLock::new(|| {
    let store = support::store();
    let client = store.client();
    std::mem::forget(store);
    let service = Service::new(client.clone());
    let scripts = Scripts::default();
    let jobs = job::Jobs::new();
    let runner = Arc::new(Scripted {
        service: service.clone(),
        client: client.clone(),
        scripts: scripts.clone(),
    });
    World {
        execution: Execution::install(service, Arc::new(Placement(runner)), jobs.clone()).unwrap(),
        client,
        jobs,
        scripts,
    }
});

fn record(client: &Client, session: &str, type_: &str, data: serde_json::Value) {
    let (id, session, type_, data) = (
        format!("evt_exec_{}", EVENTS.fetch_add(1, Ordering::SeqCst)),
        session.to_owned(),
        type_.to_owned(),
        parse_json(&data.to_string()).unwrap(),
    );
    client
        .submit(move |tx| {
            append(
                tx,
                &NewEvent {
                    id: id.as_str().into(),
                    aggregate_id: session.as_str().into(),
                    created: 20,
                    type_: type_.as_str().into(),
                    data,
                },
                None,
            )
            .map(|_| ())
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn exchange(client: &Client, session: String) {
    let session = session.as_str();
    let call = |type_: &str, fields: serde_json::Value| {
        let mut data = json!({"sessionID": session, "assistantMessageID": "msg_work_declaration", "callID": "complete"});
        data.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        record(client, session, type_, data);
    };
    record(
        client,
        session,
        "session.step.started.1",
        json!({"sessionID": session, "assistantMessageID": "msg_work_declaration"}),
    );
    call(
        "session.tool.input.started.1",
        json!({"name": "task_complete"}),
    );
    call(
        "session.tool.called.1",
        json!({"input": {}, "executed": false}),
    );
    call(
        "session.tool.success.1",
        json!({"structured": {"recorded": true}, "content": [], "executed": false}),
    );
    record(
        client,
        session,
        "session.step.ended.1",
        json!({"sessionID": session, "assistantMessageID": "msg_work_declaration", "finish": "tool-calls"}),
    );
    record(
        client,
        session,
        "session.step.started.1",
        json!({"sessionID": session, "assistantMessageID": "msg_work_final"}),
    );
    record(
        client,
        session,
        "session.text.ended.1",
        json!({"sessionID": session, "assistantMessageID": "msg_work_final", "ordinal": 0, "text": "Implemented and verified."}),
    );
    record(
        client,
        session,
        "session.step.ended.1",
        json!({"sessionID": session, "assistantMessageID": "msg_work_final", "finish": "stop"}),
    );
}

fn seed(world: &World, id: &str, script: Script) -> session::Id {
    let row = id.to_owned();
    world
        .client
        .submit(move |tx| SessionTable::insert(tx, &support::record(&row)))
        .unwrap()
        .wait()
        .unwrap();
    let id = session::Id::new(id).unwrap();
    world.scripts.lock().unwrap().insert(id.clone(), script);
    id
}

async fn run(world: &World, id: &session::Id) {
    let input = format!("msg_input_{}", id.as_lossless().to_utf8().unwrap());
    world
        .execution
        .prompt(
            Request {
                id: session_message::Id::new(input.as_str()).unwrap(),
                session_id: id.clone(),
                input: session_pending::Message::decode(
                    &parse_json(
                        r#"{"type":"user","data":{"text":"Do and verify"},"delivery":"steer"}"#,
                    )
                    .unwrap(),
                )
                .unwrap(),
                event_id: ycoding_schema::event::Id::new(format!("evt_admit_{input}")).unwrap(),
                created: 10,
            },
            None,
        )
        .await
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        world.execution.await_idle(id),
    )
    .await
    .expect("execution settles");
}

fn receipts(world: &World, id: &session::Id) -> Vec<serde_json::Value> {
    let mut rows = world
        .client
        .snapshot()
        .unwrap()
        .scan::<EventTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            10_000,
        )
        .unwrap()
        .into_iter()
        .filter(|event| {
            event.aggregate_id == *id.as_lossless()
                && event.type_.as_str() == Some("session.work.completed.1")
        })
        .collect::<Vec<_>>();
    rows.sort_by_key(|event| event.seq);
    rows.into_iter()
        .map(|event| serde_json::from_str(&ycoding_schema::stringify_json(&event.data)).unwrap())
        .collect()
}

fn terminal_seq(world: &World, id: &session::Id, type_: &str) -> i64 {
    world
        .client
        .snapshot()
        .unwrap()
        .scan::<EventTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            10_000,
        )
        .unwrap()
        .into_iter()
        .filter(|event| {
            event.aggregate_id == *id.as_lossless() && event.type_.as_str() == Some(type_)
        })
        .map(|event| event.seq)
        .max()
        .unwrap()
}

#[tokio::test]
async fn verified_work_is_recorded_once_after_the_execution_succeeds() {
    let world = &*WORLD;
    let id = seed(world, "ses_exec_verified", Script::Verified);
    run(world, &id).await;
    assert_eq!(
        receipts(world, &id),
        [json!({
            "sessionID": "ses_exec_verified",
            "inputID": "msg_input_ses_exec_verified",
            "assistantMessageID": "msg_work_final"
        })]
    );
    assert!(
        terminal_seq(world, &id, "session.work.completed.1")
            > terminal_seq(world, &id, "session.execution.succeeded.1")
    );
}

#[tokio::test]
async fn idle_success_is_not_verified_work() {
    let world = &*WORLD;
    let id = seed(world, "ses_exec_idle", Script::Idle);
    run(world, &id).await;
    assert!(receipts(world, &id).is_empty());
}

#[tokio::test]
async fn idle_success_with_a_completed_goal_is_not_verified_work() {
    let world = &*WORLD;
    let id = seed(world, "ses_exec_completed_goal", Script::Idle);
    let autonomy = autonomy::Service::new(world.client.clone());
    autonomy
        .set_goal(&id, Goal::new("Already done", None, None))
        .await
        .unwrap();
    autonomy.complete(&id).await.unwrap();
    run(world, &id).await;
    assert!(receipts(world, &id).is_empty());
}

#[tokio::test]
async fn executions_that_fail_or_are_interrupted_after_declaring_completion_are_not_verified_work()
{
    let world = &*WORLD;
    for (name, script) in [
        ("failed", Script::VerifiedThenFail),
        ("interrupted", Script::VerifiedThenInterrupted),
    ] {
        let id = seed(world, &format!("ses_exec_{name}"), script);
        run(world, &id).await;
        assert!(receipts(world, &id).is_empty(), "{name}");
    }
}

#[tokio::test]
async fn an_active_goal_keeps_declared_work_unrecorded() {
    let world = &*WORLD;
    let id = seed(world, "ses_exec_active_goal", Script::Verified);
    autonomy::Service::new(world.client.clone())
        .set_goal(&id, Goal::new("Keep going", None, None))
        .await
        .unwrap();
    run(world, &id).await;
    assert!(receipts(world, &id).is_empty());
}

#[tokio::test]
async fn a_running_shell_job_of_the_session_keeps_declared_work_unrecorded() {
    let world = &*WORLD;
    let id = seed(world, "ses_exec_shell_job", Script::Verified);
    let (release, held) = oneshot::channel::<()>();
    world
        .jobs
        .start(job::StartInput {
            id: Some("job_exec_shell".into()),
            kind: "shell".into(),
            title: None,
            metadata: Some(serde_json::Map::from_iter([(
                "sessionID".into(),
                "ses_exec_shell_job".into(),
            )])),
            run: Box::pin(async move {
                let _ = held.await;
                Ok(String::new())
            }),
        })
        .unwrap();
    run(world, &id).await;
    assert!(receipts(world, &id).is_empty());
    drop(release);
}

#[tokio::test]
async fn shell_notices_are_admitted_as_steering_input_and_wake_the_session_through_the_shared_jobs()
{
    let world = &*WORLD;
    let id = seed(world, "ses_exec_notice", Script::Idle);
    let shells = world.execution.job_shells();
    let job = Job {
        session_id: id.clone(),
        call_id: "call_exec_notice".into(),
        command: "make test".into(),
    };
    let lease = shells.background(&job);
    drop(lease);
    assert!(world.jobs.outstanding_sessions().contains(&id));
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        shells.deliver(Notice::Completed {
            job,
            shell_id: "shl_exec_notice".into(),
            state: "completed",
            text: "all green".into(),
        }),
    )
    .await
    .expect("notice delivery settles")
    .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        world.execution.await_idle(&id),
    )
    .await
    .expect("woken execution settles");
    let service = Service::new(world.client.clone());
    let messages = service.snapshot(&id, 100, None).unwrap().messages;
    let [session_message::Info::Synthetic(notice)] = messages.as_slice() else {
        panic!("expected one promoted synthetic notice, got {messages:?}");
    };
    assert_eq!(
        notice.text.to_utf8().unwrap(),
        "<shell id=\"call_exec_notice\" state=\"completed\" command=\"make test\">\nall green\n</shell>"
    );
    assert!(service.pending_list(&id).unwrap().is_empty());
    assert!(!world.jobs.outstanding_sessions().contains(&id));
}
