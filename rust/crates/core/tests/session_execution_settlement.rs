use serde_json::json;
use std::{
    collections::HashMap,
    ops::Bound,
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::Semaphore;
use ycoding_core::{
    job,
    session::{
        autonomy::{self, Goal, GoalChange, GoalStatus, Steer, SteerFuture, SteerRequest},
        execution::{Execution, Locations, Runner},
        orchestration::{self, Launch},
        pending::Request,
        run_coordinator::{DrainRequest, Error, InterruptReason, Outcome, RunFuture},
        store::Service,
    },
};
use ycoding_schema::{
    DomainDecode, location, parse_json, session, session_message, session_pending,
};
use ycoding_store::{
    Client, KeyPart,
    session::{EventTable, NewEvent, NotificationTable, SessionTable, TaskTable},
    tuple_key,
};

#[path = "session_support/mod.rs"]
mod support;

static EVENTS: AtomicUsize = AtomicUsize::new(0);
static EXECUTION_TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
type Action = Arc<dyn Fn(DrainRequest) -> RunFuture + Send + Sync>;
type Generate = Arc<dyn Fn(SteerRequest) -> SteerFuture<'static> + Send + Sync>;
type Cleanup = Arc<dyn Fn() -> RunFuture + Send + Sync>;

#[derive(Default)]
struct Scripts {
    actions: Mutex<HashMap<session::Id, Action>>,
    calls: Mutex<HashMap<session::Id, usize>>,
    generation: Mutex<HashMap<session::Id, Generate>>,
    steers: Mutex<HashMap<session::Id, Vec<Option<String>>>>,
    cleanup: Mutex<HashMap<session::Id, Cleanup>>,
}

impl Steer for Scripts {
    fn steer(&self, request: SteerRequest) -> SteerFuture<'_> {
        self.steers
            .lock()
            .unwrap()
            .entry(request.session_id.clone())
            .or_default()
            .push(request.latest_assistant_text.clone());
        let generate = self
            .generation
            .lock()
            .unwrap()
            .get(&request.session_id)
            .cloned();
        Box::pin(async move {
            match generate {
                Some(generate) => generate(request).await,
                None => None,
            }
        })
    }
}

struct Scripted {
    sessions: Service,
    scripts: Arc<Scripts>,
}

impl Runner for Scripted {
    fn drain(&self, request: DrainRequest) -> RunFuture {
        *self
            .scripts
            .calls
            .lock()
            .unwrap()
            .entry(request.session_id.clone())
            .or_default() += 1;
        let action = self
            .scripts
            .actions
            .lock()
            .unwrap()
            .get(&request.session_id)
            .cloned();
        let sessions = self.sessions.clone();
        Box::pin(async move {
            sessions.promote_steers(&request.session_id, 10).await?;
            sessions
                .promote_next_queued(&request.session_id, 10)
                .await?;
            match action {
                Some(action) => action(request).await,
                None => Ok(()),
            }
        })
    }
    fn settled(&self, id: session::Id, _: Outcome) -> RunFuture {
        let cleanup = self.scripts.cleanup.lock().unwrap().get(&id).cloned();
        Box::pin(async move {
            match cleanup {
                Some(cleanup) => cleanup().await,
                None => Ok(()),
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

struct LocalExecution;
impl orchestration::Execution for LocalExecution {
    fn wake(&self, id: &session::Id) -> Outcome {
        WORLD.execution.wake(id)
    }
    fn interrupt(&self, id: &session::Id) -> RunFuture {
        let id = id.clone();
        Box::pin(async move { WORLD.execution.interrupt(&id).await })
    }
}

struct World {
    client: Client,
    sessions: Service,
    scripts: Arc<Scripts>,
    jobs: job::Jobs,
    execution: &'static Execution,
    terminal_goals: Arc<Mutex<HashMap<session::Id, Vec<u64>>>>,
}

static WORLD: LazyLock<World> = LazyLock::new(|| {
    let store = support::store();
    let client = store.client();
    std::mem::forget(store);
    let sessions = Service::new(client.clone());
    let scripts = Arc::new(Scripts::default());
    let runner = Arc::new(Scripted {
        sessions: sessions.clone(),
        scripts: scripts.clone(),
    });
    let jobs = job::Jobs::new();
    let terminal_goals = Arc::new(Mutex::new(HashMap::<session::Id, Vec<u64>>::new()));
    let observed = terminal_goals.clone();
    let autonomy = autonomy::Service::new(client.clone());
    client.observe_events(move |events| {
        for event in events {
            if event.type_.as_str() == Some("session.execution.succeeded.1") {
                let id = session::Id::new(event.aggregate_id.clone()).unwrap();
                if let Some(goal) = autonomy.get(&id).unwrap().goal {
                    observed
                        .lock()
                        .unwrap()
                        .entry(id)
                        .or_default()
                        .push(goal.iteration);
                }
            }
        }
        true
    });
    World {
        execution: Execution::install(
            sessions.clone(),
            Arc::new(Placement(runner)),
            jobs.clone(),
            Some(scripts.clone()),
        )
        .unwrap(),
        client,
        sessions,
        scripts,
        jobs,
        terminal_goals,
    }
});

fn id(text: &str) -> session::Id {
    session::Id::new(text).unwrap()
}

fn seed(text: &str) -> session::Id {
    let row = support::record(text);
    WORLD
        .client
        .submit(move |tx| SessionTable::insert(tx, &row))
        .unwrap()
        .wait()
        .unwrap();
    id(text)
}

async fn publish(id: &session::Id, type_: &str, fields: serde_json::Value) {
    let mut data = json!({"sessionID": id.as_lossless().as_str().unwrap()});
    data.as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    WORLD
        .sessions
        .publish(NewEvent {
            id: format!("evt_settle_{}", EVENTS.fetch_add(1, Ordering::SeqCst)).into(),
            aggregate_id: id.as_lossless().clone(),
            created: 20,
            type_: type_.into(),
            data: parse_json(&data.to_string()).unwrap(),
        })
        .await
        .unwrap();
}

async fn assistant(id: &session::Id, parts: &[(&str, &str)]) {
    let message = format!("msg_settle_{}", EVENTS.fetch_add(1, Ordering::SeqCst));
    publish(id, "session.step.started.1", json!({"assistantMessageID": message, "agent": "reviewer", "model": {"providerID": "test", "id": "test"}})).await;
    for (ordinal, (kind, text)) in parts.iter().enumerate() {
        publish(
            id,
            &format!("session.{kind}.started.1"),
            json!({
                "assistantMessageID": message, "ordinal": ordinal,
            }),
        )
        .await;
        publish(
            id,
            &format!("session.{kind}.ended.1"),
            json!({
                "assistantMessageID": message, "ordinal": ordinal, "text": text,
            }),
        )
        .await;
    }
    publish(id, "session.step.ended.1", json!({"assistantMessageID": message, "finish": "stop", "cost": 0, "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}}})).await;
}

async fn task(parent: &session::Id, state: &str) -> session::Id {
    let ids = Launch::new(
        parent,
        &session_message::Id::new("msg_parent").unwrap(),
        "call",
    );
    let child = ids.child_id.clone();
    let mut row = support::record(child.as_lossless().as_str().unwrap());
    row.parent_id = Some(parent.as_lossless().clone());
    WORLD
        .client
        .submit(move |tx| SessionTable::insert(tx, &row))
        .unwrap()
        .wait()
        .unwrap();
    publish(&child, "session.task.updated.1", json!({"change": {
        "type": "launched", "parentID": parent.as_lossless().as_str().unwrap(),
        "parentAssistantMessageID": "msg_parent", "toolCallID": "call", "inputID": ids.input_id.as_lossless().as_str().unwrap(),
        "description": "child", "agent": "reviewer", "model": {"providerID": "test", "id": "test"},
        "promptDigest": "digest", "background": true, "delivery": "steer",
    }})).await;
    publish(
        &child,
        "session.task.updated.1",
        json!({"change": {"type": "started"}}),
    )
    .await;
    if state == "waiting" {
        publish(
            &child,
            "session.task.updated.1",
            json!({"change": {"type": "question_asked", "question": {
                "id": "qst_one", "text": "Proceed?", "time": 1,
            }}}),
        )
        .await;
        let child_id = child.as_lossless().clone();
        WORLD
            .client
            .submit(move |tx| {
                for mut row in
                    tx.scan::<NotificationTable>(Bound::Unbounded, Bound::Unbounded, 10_000)?
                {
                    if row.task_session_id == child_id {
                        row.delivered = 1;
                        NotificationTable::put(tx, &row)?;
                    }
                }
                Ok(())
            })
            .unwrap()
            .await
            .unwrap();
    }
    child
}

fn task_state(child: &session::Id) -> String {
    WORLD
        .client
        .snapshot()
        .unwrap()
        .get::<TaskTable>(&tuple_key(&[KeyPart::String(child.as_lossless())]))
        .unwrap()
        .unwrap()
        .state
        .to_utf8()
        .unwrap()
}

fn calls(id: &session::Id) -> usize {
    *WORLD.scripts.calls.lock().unwrap().get(id).unwrap_or(&0)
}
fn steers(id: &session::Id) -> Vec<Option<String>> {
    WORLD
        .scripts
        .steers
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .unwrap_or_default()
}
fn events(id: &session::Id, type_: &str) -> Vec<ycoding_store::session::Event> {
    let mut events = WORLD
        .client
        .snapshot()
        .unwrap()
        .scan::<EventTable>(Bound::Unbounded, Bound::Unbounded, 10_000)
        .unwrap()
        .into_iter()
        .filter(|event| {
            event.aggregate_id == *id.as_lossless() && event.type_.as_str() == Some(type_)
        })
        .collect::<Vec<_>>();
    events.sort_by_key(|event| event.seq);
    events
}
async fn idle(id: &session::Id) {
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        WORLD.execution.await_idle(id),
    )
    .await
    .unwrap();
}
async fn run(id: &session::Id) -> Outcome {
    let outcome = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        WORLD.execution.resume(id),
    )
    .await
    .unwrap();
    idle(id).await;
    outcome
}
async fn goal(id: &session::Id) {
    autonomy::Service::new(WORLD.client.clone())
        .set_goal(id, Goal::new("Ship the fix", None, None))
        .await
        .unwrap();
    WORLD.scripts.generation.lock().unwrap().insert(
        id.clone(),
        Arc::new(|_| Box::pin(async { Some("next".into()) })),
    );
}

#[tokio::test]
async fn waiting_managed_children_do_not_invoke_the_runner_or_consume_pending_input() {
    let _execution = EXECUTION_TESTS.lock().await;
    let parent = seed("ses_settle_waiting_parent");
    let child = task(&parent, "waiting").await;
    WORLD
        .execution
        .prompt(
            Request {
                id: session_message::Id::new("msg_waiting_pending").unwrap(),
                session_id: child.clone(),
                input: session_pending::Message::decode(
                    &parse_json(r#"{"type":"user","data":{"text":"held"},"delivery":"steer"}"#)
                        .unwrap(),
                )
                .unwrap(),
                event_id: ycoding_schema::event::Id::new("evt_waiting_pending").unwrap(),
                created: 5,
            },
            Some(false),
        )
        .await
        .unwrap();
    run(&child).await.unwrap();
    assert_eq!(calls(&child), 0);
    assert_eq!(WORLD.sessions.pending_list(&child).unwrap().len(), 1);
    assert_eq!(task_state(&child), "waiting");
    idle(&parent).await;
}

#[tokio::test]
async fn goal_advance_precedes_terminal_and_admission_follows_it_with_latest_text_only() {
    let _execution = EXECUTION_TESTS.lock().await;
    let session = seed("ses_settle_goal_order");
    goal(&session).await;
    let autonomy = autonomy::Service::new(WORLD.client.clone());
    autonomy.report(&session).await.unwrap();
    assistant(&session, &[("text", "Old question?")]).await;
    WORLD.scripts.actions.lock().unwrap().insert(
        session.clone(),
        Arc::new(|request| {
            Box::pin(async move {
                let count = calls(&request.session_id);
                assistant(
                    &request.session_id,
                    &[
                        (
                            "text",
                            if count == 1 {
                                "New <goal-complete/>"
                            } else {
                                "Selected"
                            },
                        ),
                        ("reasoning", "private"),
                        ("text", " answer"),
                    ],
                )
                .await;
                if count == 3 {
                    autonomy::Service::new(WORLD.client.clone())
                        .complete(&request.session_id)
                        .await
                        .unwrap();
                }
                Ok(())
            })
        }),
    );
    run(&session).await.unwrap();
    assert_eq!(calls(&session), 3);
    assert_eq!(
        steers(&session),
        [
            Some("New <goal-complete/> answer".into()),
            Some("Selected answer".into())
        ]
    );
    assert_eq!(WORLD.terminal_goals.lock().unwrap()[&session], [1, 2, 2]);
    let goal = autonomy::Service::new(WORLD.client.clone())
        .get(&session)
        .unwrap()
        .goal
        .unwrap();
    assert_eq!(
        (goal.status, goal.iteration, goal.no_progress),
        (GoalStatus::Completed, 2, 1)
    );
    let terminals = events(&session, "session.execution.succeeded.1");
    let inputs = events(&session, "session.input.admitted.1");
    assert_eq!(inputs.len(), 2);
    for (iteration, input) in inputs.iter().enumerate() {
        assert!(terminals[iteration].seq < input.seq && input.seq < terminals[iteration + 1].seq);
        assert!(
            ycoding_schema::stringify_json(&input.data).contains(&format!(
                "msg_goal_{}",
                &ycoding_core::session::prompt_cache::sha256(&format!(
                    "{}\0{}",
                    session.as_lossless().as_str().unwrap(),
                    iteration + 1
                ))[..24]
            ))
        );
    }
    assert!(WORLD.sessions.pending_list(&session).unwrap().is_empty());
}

#[tokio::test]
async fn blocker_reports_exhaust_the_goal_without_spending_budget_on_success() {
    let _execution = EXECUTION_TESTS.lock().await;
    let session = seed("ses_settle_exhaustion");
    goal(&session).await;
    WORLD.scripts.actions.lock().unwrap().insert(
        session.clone(),
        Arc::new(|request| {
            Box::pin(async move {
                autonomy::Service::new(WORLD.client.clone())
                    .report(&request.session_id)
                    .await
                    .unwrap();
                Ok(())
            })
        }),
    );
    run(&session).await.unwrap();
    let goal = autonomy::Service::new(WORLD.client.clone())
        .get(&session)
        .unwrap()
        .goal
        .unwrap();
    assert_eq!(
        (goal.status, goal.iteration, goal.no_progress),
        (GoalStatus::Exhausted, 2, 3)
    );
    assert_eq!(calls(&session), 3);
    assert_eq!(steers(&session).len(), 2);
}

#[tokio::test]
async fn failed_and_interrupted_drains_leave_goals_unchanged_and_queue_nothing() {
    let _execution = EXECUTION_TESTS.lock().await;
    for (suffix, outcome) in [
        (
            "failure",
            Err(Error::Runner(ycoding_schema::session_error::Error {
                r#type: "provider.transport".into(),
                message: "failed".into(),
            })),
        ),
        ("interrupt", Err(Error::Interrupted(InterruptReason::User))),
    ] {
        let session = seed(&format!("ses_settle_goal_{suffix}"));
        goal(&session).await;
        WORLD.scripts.actions.lock().unwrap().insert(
            session.clone(),
            Arc::new(move |_| {
                let outcome = outcome.clone();
                Box::pin(async move { outcome })
            }),
        );
        assert!(run(&session).await.is_err());
        assert!(steers(&session).is_empty());
        assert_eq!(
            autonomy::Service::new(WORLD.client.clone())
                .get(&session)
                .unwrap()
                .goal
                .unwrap()
                .iteration,
            0
        );
        assert!(events(&session, "session.input.admitted.1").is_empty());
    }
}

#[tokio::test]
async fn missing_steer_and_stopped_goals_settle_without_continuation() {
    let _execution = EXECUTION_TESTS.lock().await;
    for suffix in ["missing", "stopped"] {
        let session = seed(&format!("ses_settle_{suffix}"));
        goal(&session).await;
        if suffix == "missing" {
            WORLD.scripts.generation.lock().unwrap().remove(&session);
        } else {
            autonomy::Service::new(WORLD.client.clone())
                .stop(&session)
                .await
                .unwrap();
        }
        run(&session).await.unwrap();
        assert_eq!(calls(&session), 1);
        assert_eq!(
            autonomy::Service::new(WORLD.client.clone())
                .get(&session)
                .unwrap()
                .goal
                .unwrap()
                .iteration,
            0
        );
        assert!(events(&session, "session.input.admitted.1").is_empty());
    }
}

#[tokio::test]
async fn stop_replace_and_resume_fence_a_steer_calculated_during_settlement() {
    let _execution = EXECUTION_TESTS.lock().await;
    for change in ["stop", "replace", "resume"] {
        let session = seed(&format!("ses_settle_stale_{change}"));
        goal(&session).await;
        let entered = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let (signal, held) = (entered.clone(), release.clone());
        WORLD.scripts.generation.lock().unwrap().insert(
            session.clone(),
            Arc::new(move |_| {
                let (signal, held) = (signal.clone(), held.clone());
                Box::pin(async move {
                    signal.add_permits(1);
                    held.acquire().await.unwrap().forget();
                    Some("late".into())
                })
            }),
        );
        let current = session.clone();
        let running = tokio::spawn(async move { WORLD.execution.resume(&current).await });
        tokio::time::timeout(std::time::Duration::from_secs(5), entered.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
        let autonomy = autonomy::Service::new(WORLD.client.clone());
        if change == "replace" {
            autonomy
                .set_goal(&session, Goal::new("New objective", None, None))
                .await
                .unwrap();
        } else {
            autonomy.stop(&session).await.unwrap();
            if change == "resume" {
                autonomy
                    .change(&session, None, Some(GoalChange::Resume))
                    .await
                    .unwrap();
            }
        }
        let updated = autonomy.snapshot(&session).unwrap();
        release.add_permits(1);
        running.await.unwrap().unwrap();
        assert_eq!(autonomy.snapshot(&session).unwrap(), updated);
        idle(&session).await;
        assert!(events(&session, "session.input.admitted.1").is_empty());
    }
}

#[tokio::test]
async fn active_shell_blocks_goal_generation_without_advancing() {
    let _execution = EXECUTION_TESTS.lock().await;
    let session = seed("ses_settle_shell");
    goal(&session).await;
    let (release, held) = tokio::sync::oneshot::channel::<()>();
    WORLD
        .jobs
        .start(job::StartInput {
            id: Some("job_settle_shell".into()),
            kind: "shell".into(),
            title: None,
            metadata: Some(serde_json::Map::from_iter([(
                "sessionID".into(),
                "ses_settle_shell".into(),
            )])),
            run: Box::pin(async move {
                let _ = held.await;
                Ok(String::new())
            }),
        })
        .unwrap();
    run(&session).await.unwrap();
    assert!(steers(&session).is_empty());
    assert_eq!(calls(&session), 1);
    release.send(()).unwrap();
    WORLD.jobs.wait("job_settle_shell", None).await;
}

#[tokio::test]
async fn completed_failed_and_lost_children_from_running_and_waiting_unblock_the_parent_goal() {
    let _execution = EXECUTION_TESTS.lock().await;
    for state in ["running", "waiting"] {
        for terminal in ["completed", "failed", "lost"] {
            let parent = seed(&format!("ses_settle_{state}_{terminal}"));
            goal(&parent).await;
            let child = task(&parent, state).await;
            run(&parent).await.unwrap();
            assert!(steers(&parent).is_empty());
            assert_eq!(
                autonomy::Service::new(WORLD.client.clone())
                    .get(&parent)
                    .unwrap()
                    .goal
                    .unwrap()
                    .iteration,
                0
            );
            if state == "waiting" {
                publish(&child, "session.task.updated.1", json!({"change": {"type": "question_answered", "answer": {"questionID": "qst_one", "text": "yes"}}})).await;
            }
            let change = if terminal == "failed" {
                json!({"type": "failed", "error": "failed"})
            } else {
                json!({"type": terminal})
            };
            publish(&child, "session.task.updated.1", json!({"change": change})).await;
            WORLD.scripts.actions.lock().unwrap().insert(
                parent.clone(),
                Arc::new(|request| {
                    Box::pin(async move {
                        if calls(&request.session_id) >= 3 {
                            autonomy::Service::new(WORLD.client.clone())
                                .complete(&request.session_id)
                                .await
                                .unwrap();
                        }
                        Ok(())
                    })
                }),
            );
            orchestration::Service::new(WORLD.sessions.clone(), Arc::new(LocalExecution))
                .dispatch_notifications()
                .await
                .unwrap();
            idle(&parent).await;
            assert_eq!(calls(&parent), 3, "{state}/{terminal}");
            assert_eq!(steers(&parent).len(), 1, "{state}/{terminal}");
            assert_eq!(
                autonomy::Service::new(WORLD.client.clone())
                    .get(&parent)
                    .unwrap()
                    .goal
                    .unwrap()
                    .status,
                GoalStatus::Completed
            );
        }
    }
}

#[tokio::test]
async fn successful_child_settles_after_execution_with_bounded_latest_text_and_one_parent_notice() {
    let _execution = EXECUTION_TESTS.lock().await;
    let parent = seed("ses_settle_child_success_parent");
    let child = task(&parent, "running").await;
    assistant(&child, &[("text", "old")]).await;
    WORLD.scripts.actions.lock().unwrap().insert(
        child.clone(),
        Arc::new(|request| {
            Box::pin(async move {
                assistant(
                    &request.session_id,
                    &[
                        ("text", "latest"),
                        ("reasoning", "private"),
                        ("text", &"é".repeat(9000)),
                    ],
                )
                .await;
                Ok(())
            })
        }),
    );
    run(&child).await.unwrap();
    assert_eq!(task_state(&child), "completed");
    let settlements = events(&child, "session.task.updated.1");
    assert!(
        settlements.last().unwrap().seq
            > events(&child, "session.execution.succeeded.1")
                .last()
                .unwrap()
                .seq
    );
    let data: serde_json::Value = serde_json::from_str(&ycoding_schema::stringify_json(
        &settlements.last().unwrap().data,
    ))
    .unwrap();
    assert_eq!(
        data["change"]["excerpt"],
        format!("latest{}", "é".repeat(8189))
    );
    idle(&parent).await;
    assert_eq!(calls(&parent), 1);
    run(&child).await.unwrap();
    idle(&parent).await;
    assert_eq!(calls(&child), 1);
    assert_eq!(calls(&parent), 1);
    assert_eq!(events(&parent, "session.input.admitted.1").len(), 1);
}

#[tokio::test]
async fn missing_assistant_and_reasoning_only_assistant_remain_distinct_for_goal_steers() {
    let _execution = EXECUTION_TESTS.lock().await;
    for kind in ["absent", "reasoning"] {
        let session = seed(&format!("ses_settle_text_{kind}"));
        goal(&session).await;
        if kind == "reasoning" {
            assistant(&session, &[("reasoning", "not a text response")]).await;
        }
        WORLD.scripts.actions.lock().unwrap().insert(
            session.clone(),
            Arc::new(|request| {
                Box::pin(async move {
                    if calls(&request.session_id) == 2 {
                        autonomy::Service::new(WORLD.client.clone())
                            .stop(&request.session_id)
                            .await
                            .unwrap();
                    }
                    Ok(())
                })
            }),
        );
        run(&session).await.unwrap();
        assert_eq!(
            steers(&session),
            [if kind == "absent" {
                None
            } else {
                Some(String::new())
            }]
        );
    }
}

#[tokio::test]
async fn cancellation_wins_before_child_settlement_and_late_interrupt_does_not_override_success() {
    let _execution = EXECUTION_TESTS.lock().await;
    let parent = seed("ses_settle_cancel_parent");
    let child = task(&parent, "running").await;
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let (signal, held) = (entered.clone(), release.clone());
    WORLD.scripts.cleanup.lock().unwrap().insert(
        child.clone(),
        Arc::new(move || {
            let (signal, held) = (signal.clone(), held.clone());
            Box::pin(async move {
                signal.add_permits(1);
                held.acquire().await.unwrap().forget();
                Ok(())
            })
        }),
    );
    let current = child.clone();
    let running = tokio::spawn(async move { WORLD.execution.resume(&current).await });
    tokio::time::timeout(std::time::Duration::from_secs(5), entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    let cancelled = orchestration::Service::new(WORLD.sessions.clone(), Arc::new(LocalExecution))
        .cancel(&parent, &child)
        .await
        .unwrap();
    assert_eq!(
        cancelled.state,
        ycoding_schema::session_orchestration::State::Cancelled
    );
    release.add_permits(1);
    running.await.unwrap().unwrap();
    idle(&child).await;
    idle(&parent).await;
    assert_eq!(task_state(&child), "cancelled");
    assert_eq!(events(&child, "session.execution.succeeded.1").len(), 1);
    assert!(events(&child, "session.execution.interrupted.1").is_empty());
    assert_eq!(events(&child, "session.task.updated.1").len(), 4);
    let notices = events(&parent, "session.input.admitted.1");
    assert_eq!(notices.len(), 1);
    assert!(ycoding_schema::stringify_json(&notices[0].data).contains("cancelled"));
}

#[tokio::test]
async fn queued_parent_control_reactivates_a_terminal_child_and_promoted_retry_is_inert() {
    let _execution = EXECUTION_TESTS.lock().await;
    let parent = seed("ses_settle_queue_parent");
    let child = task(&parent, "running").await;
    run(&child).await.unwrap();
    idle(&parent).await;
    let orchestration =
        orchestration::Service::new(WORLD.sessions.clone(), Arc::new(LocalExecution));
    let input = session_message::Id::new("msg_settle_parent_queue").unwrap();
    orchestration
        .send(&parent, &child, &input, "finish", "queue")
        .await
        .unwrap();
    idle(&child).await;
    idle(&parent).await;
    assert_eq!(calls(&child), 2);
    assert_eq!(task_state(&child), "completed");
    assert!(WORLD.sessions.pending_list(&child).unwrap().is_empty());
    orchestration
        .send(&parent, &child, &input, "finish", "queue")
        .await
        .unwrap();
    idle(&child).await;
    idle(&parent).await;
    assert_eq!(calls(&child), 2);
    assert_eq!(events(&parent, "session.input.admitted.1").len(), 2);
}

#[tokio::test]
async fn failed_child_uses_utf8_bounded_error_and_excerpt_after_execution_failure() {
    let _execution = EXECUTION_TESTS.lock().await;
    let parent = seed("ses_settle_child_failure_parent");
    let child = task(&parent, "running").await;
    WORLD.scripts.actions.lock().unwrap().insert(
        child.clone(),
        Arc::new(|_| {
            Box::pin(async {
                Err(Error::Runner(ycoding_schema::session_error::Error {
                    r#type: "provider.transport".into(),
                    message: format!("{}é", "x".repeat(16 * 1024 - 1)).into(),
                }))
            })
        }),
    );
    assert!(run(&child).await.is_err());
    assert_eq!(task_state(&child), "failed");
    let last = events(&child, "session.task.updated.1").pop().unwrap();
    assert!(
        last.seq
            > events(&child, "session.execution.failed.1")
                .last()
                .unwrap()
                .seq
    );
    let data: serde_json::Value =
        serde_json::from_str(&ycoding_schema::stringify_json(&last.data)).unwrap();
    assert_eq!(data["change"]["error"], "x".repeat(16 * 1024 - 1));
    assert_eq!(data["change"]["excerpt"], data["change"]["error"]);
    idle(&parent).await;
    assert_eq!(events(&parent, "session.input.admitted.1").len(), 1);
}

#[tokio::test]
async fn interruption_preserves_suspension_and_never_settles_a_running_child() {
    let _execution = EXECUTION_TESTS.lock().await;
    let parent = seed("ses_settle_child_interrupt_parent");
    let child = task(&parent, "running").await;
    let entered = Arc::new(Semaphore::new(0));
    let signal = entered.clone();
    WORLD.scripts.actions.lock().unwrap().insert(
        child.clone(),
        Arc::new(move |_| {
            let signal = signal.clone();
            Box::pin(async move {
                signal.add_permits(1);
                std::future::pending().await
            })
        }),
    );
    let current = child.clone();
    let running = tokio::spawn(async move { WORLD.execution.resume(&current).await });
    entered.acquire().await.unwrap().forget();
    WORLD.execution.suspend_active(50).await.unwrap();
    WORLD.execution.interrupt(&child).await.unwrap();
    assert!(matches!(
        running.await.unwrap(),
        Err(Error::Interrupted(InterruptReason::User))
    ));
    assert_eq!(task_state(&child), "running");
    assert_eq!(events(&child, "session.task.updated.1").len(), 2);
    assert!(WORLD.sessions.consume_suspended(&child).await.unwrap());
    assert!(events(&parent, "session.input.admitted.1").is_empty());
}

#[tokio::test]
async fn restart_loss_is_delivered_at_execution_start_once_without_a_provider_wake() {
    let _execution = EXECUTION_TESTS.lock().await;
    let parent = seed("ses_settle_restart_parent");
    let child = task(&parent, "running").await;
    let orchestration =
        orchestration::Service::new(WORLD.sessions.clone(), Arc::new(LocalExecution));
    WORLD.sessions.publish(NewEvent {
        id: format!("evt_task_restart_lost_{}_2", child.as_lossless().as_str().unwrap()).into(),
        aggregate_id: child.as_lossless().clone(), created: 20, type_: "session.task.updated.1".into(),
        data: parse_json(&json!({"sessionID": child.as_lossless().as_str().unwrap(), "change": {"type": "lost", "excerpt": "Provider execution was not resumed"}}).to_string()).unwrap(),
    }).await.unwrap();
    assert_eq!(task_state(&child), "lost");
    orchestration.dispatch_notifications().await.unwrap();
    assert_eq!(calls(&parent), 0);
    WORLD.scripts.actions.lock().unwrap().insert(parent.clone(), Arc::new(|request| Box::pin(async move {
        let history = WORLD.sessions.context(&request.session_id).unwrap();
        assert!(history.iter().any(|message| matches!(message, ycoding_schema::session_message::Info::Synthetic(notice) if notice.text.to_utf8().unwrap().contains("Provider execution was not resumed"))));
        Ok(())
    })));
    run(&parent).await.unwrap();
    assert_eq!(calls(&parent), 1);
    assert!(orchestration.lost_sessions().unwrap().is_empty());
    assert_eq!(events(&parent, "session.input.admitted.1").len(), 1);
    assert!(
        WORLD
            .client
            .snapshot()
            .unwrap()
            .scan::<NotificationTable>(Bound::Unbounded, Bound::Unbounded, 10_000)
            .unwrap()
            .into_iter()
            .filter(|row| row.parent_id == *parent.as_lossless())
            .all(|row| row.delivered == 1)
    );
    run(&parent).await.unwrap();
    assert_eq!(calls(&parent), 2);
    assert_eq!(events(&parent, "session.input.admitted.1").len(), 1);
}
