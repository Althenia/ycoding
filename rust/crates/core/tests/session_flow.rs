use std::sync::Arc;
use ycoding_core::session::{
    run_coordinator::{Coordinator, InterruptReason},
    store::Service,
};
use ycoding_schema::{
    DomainDecode, JsonValue, parse_json, session, session_message, session_pending,
};

#[path = "session_flow_support/mod.rs"]
mod flow;

use flow::{
    EMPTY, FixtureSkills, MALFORMED, RATE_LIMITED, REJECTED, Reply, Root, TEXT, TEXT_HEAD, TOOL,
    WHITESPACE, admit, admitting_echo, count, event_seqs, event_types, failing_echo, file_store,
    fixture_skill, held_echo, local, local_agents, local_at, local_clock, local_skills, registry,
    reopen, request, server, server_replies, server_status, session_tools_registry, tool_reply,
    user_texts, world,
};

struct IdleRuns;
impl ycoding_core::session::revert::Runs for IdleRuns {
    fn active(&self) -> Vec<session::Id> {
        Vec::new()
    }
    fn wake(&self, _: &session::Id) -> Result<(), String> {
        Ok(())
    }
}

/// Workspace snapshots are a filesystem boundary outside Session state; this double
/// reports an unchanged tree so the Session-side stage and commit run for real.
struct NoSnapshots;
impl ycoding_core::session::revert::Snapshots for NoSnapshots {
    fn capture(&self) -> Option<ycoding_schema::snapshot::Id> {
        None
    }
    fn files(
        &self,
        _: &ycoding_schema::snapshot::Id,
        _: &ycoding_schema::snapshot::Id,
    ) -> Result<
        Vec<ycoding_schema::schema::RelativePath>,
        ycoding_core::session::revert::SnapshotFailure,
    > {
        Ok(Vec::new())
    }
    fn restore(
        &self,
        _: &[(
            ycoding_schema::schema::RelativePath,
            ycoding_schema::snapshot::Id,
        )],
    ) -> Result<(), ycoding_core::session::revert::SnapshotFailure> {
        Ok(())
    }
    fn diff(
        &self,
        _: &ycoding_schema::snapshot::Id,
        _: &ycoding_schema::snapshot::Id,
        _: &[ycoding_schema::schema::RelativePath],
    ) -> Result<Vec<ycoding_schema::file_diff::Info>, ycoding_core::session::revert::SnapshotFailure>
    {
        Ok(Vec::new())
    }
}

async fn hold_writer(
    store: &ycoding_store::Store,
) -> (
    std::sync::mpsc::Sender<()>,
    impl std::future::Future<Output = Result<(), ycoding_store::Error>>,
) {
    let (entered, inside) = std::sync::mpsc::channel();
    let (release, barrier) = std::sync::mpsc::channel();
    let held = store
        .submit(move |_| {
            entered.send(()).unwrap();
            barrier.recv().unwrap();
            Ok(())
        })
        .unwrap();
    tokio::task::spawn_blocking(move || inside.recv().unwrap())
        .await
        .unwrap();
    (release, held)
}

fn sid(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

async fn run_one(store: &ycoding_store::Store, endpoint: &str, session: &str) {
    let coordinator = Coordinator::new(Arc::new(local(store, endpoint, registry())));
    coordinator.run(&sid(session)).await.unwrap();
    coordinator.shutdown().await.unwrap();
}

// TEST-007: changed attachments/selection/delivery retry matrix, admit-only then resumed.
#[tokio::test]
async fn test007_retry_matrix_admit_only_then_resumed_single_consumer_message() {
    let root = Root::new();
    let store = file_store(&root);
    let service = Service::new(store.client());
    let digest = "a".repeat(64);
    let first_json = format!(
        r#"{{"type":"user","data":{{"text":"first text","files":[{{"content":{{"type":"managed","digest":"{digest}","bytes":3,"path":"attachments/sha256/aa/{digest}"}},"mime":"text/plain","name":"a.txt"}}],"agents":[{{"name":"build"}}],"metadata":{{"skills":[{{"id":"audit"}}],"model":"m1"}}}},"delivery":"steer"}}"#
    );
    let first_json = &first_json;
    let first = service
        .admit(request("ses_one", "msg_input", first_json, "evt_first"))
        .await
        .unwrap();
    // Admit-only: no coordinator has run, so nothing is visible or executed.
    assert!(user_texts(&service, "ses_one").is_empty());
    assert_eq!(service.pending_list(&sid("ses_one")).unwrap().len(), 1);
    for (text, delivery, extra) in [
        ("changed text", "queue", r#","files":[]"#),
        ("other", "steer", r#","agents":[]"#),
        ("third", "queue", r#","metadata":{"skills":[]}"#),
    ] {
        let json = format!(
            r#"{{"type":"user","data":{{"text":"{text}"{extra}}},"delivery":"{delivery}"}}"#
        );
        let retry = service
            .admit(request("ses_one", "msg_input", &json, "evt_retry"))
            .await
            .unwrap();
        assert_eq!(retry, first, "first admission wins for {text}");
    }
    let (concurrent, _) = tokio::join!(
        service.admit(request(
            "ses_one",
            "msg_input",
            r#"{"type":"user","data":{"text":"concurrent"},"delivery":"queue"}"#,
            "evt_conc"
        )),
        service.admit(request(
            "ses_one",
            "msg_input",
            r#"{"type":"user","data":{"text":"concurrent2"},"delivery":"steer"}"#,
            "evt_conc2"
        ))
    );
    assert_eq!(concurrent.unwrap(), first);
    assert_eq!(
        event_types(&store, "ses_one")
            .iter()
            .filter(|kind| kind.as_str() == "session.input.admitted.1")
            .count(),
        1
    );
    // Resumed wake: real runner promotes and calls the provider exactly once.
    let (endpoint, mut requests, server) = server(vec![TEXT]).await;
    let coordinator = Coordinator::new(Arc::new(local_skills(
        &store,
        &endpoint,
        registry(),
        Arc::new(FixtureSkills(vec![fixture_skill(
            "audit",
            "Audit",
            "AUDIT-INSTRUCTIONS",
        )])),
    )));
    coordinator.run(&sid("ses_one")).await.unwrap();
    coordinator.shutdown().await.unwrap();
    let sent = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(sent.contains("first text"), "{sent}");
    assert!(!sent.contains("changed text"));
    assert_eq!(user_texts(&service, "ses_one"), ["first text"]);
    assert!(service.pending_list(&sid("ses_one")).unwrap().is_empty());
    // Promoted retry reconciles against durable history, still one message.
    let after = service
        .admit(request(
            "ses_one",
            "msg_input",
            r#"{"type":"user","data":{"text":"post promotion"},"delivery":"steer"}"#,
            "evt_post",
        ))
        .await
        .unwrap();
    assert_eq!(after, first);
    assert_eq!(user_texts(&service, "ses_one"), ["first text"]);
    server.await.unwrap();
}

async fn within<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(std::time::Duration::from_secs(60), future)
        .await
        .expect("harness deadline")
}

// TEST-007: the process-global Execution honours admit-only and default wake semantics.
#[tokio::test]
async fn test007_execution_admit_only_then_default_retry_wakes_one_consumer() {
    let world = world();
    let id = world.seed("ses_w007", "/world/t007");
    let (endpoint, mut requests, server) = server(vec![TEXT]).await;
    world.place("/world/t007", &endpoint, registry());
    let first = world
        .execution
        .prompt(
            request(
                "ses_w007",
                "msg_w007",
                r#"{"type":"user","data":{"text":"first text"},"delivery":"steer"}"#,
                "evt_w007a",
            ),
            Some(false),
        )
        .await
        .unwrap();
    assert!(requests.try_recv().is_err());
    assert!(!world.execution.active().contains(&id));
    assert!(user_texts(&world.sessions, "ses_w007").is_empty());
    let retried = world
        .execution
        .prompt(
            request(
                "ses_w007",
                "msg_w007",
                r#"{"type":"user","data":{"text":"first text"},"delivery":"queue"}"#,
                "evt_w007b",
            ),
            Some(false),
        )
        .await
        .unwrap();
    assert_eq!(retried, first);
    assert!(requests.try_recv().is_err());
    let woken = world
        .execution
        .prompt(
            request(
                "ses_w007",
                "msg_w007",
                r#"{"type":"user","data":{"text":"changed text"},"delivery":"steer"}"#,
                "evt_w007c",
            ),
            None,
        )
        .await
        .unwrap();
    assert_eq!(woken, first);
    let sent = ycoding_schema::stringify_json(&within(requests.recv()).await.unwrap());
    assert!(
        sent.contains("first text") && !sent.contains("changed text"),
        "{sent}"
    );
    within(world.execution.await_idle(&id)).await;
    assert_eq!(user_texts(&world.sessions, "ses_w007"), ["first text"]);
    assert!(world.sessions.pending_list(&id).unwrap().is_empty());
    let promoted = world
        .execution
        .prompt(
            request(
                "ses_w007",
                "msg_w007",
                r#"{"type":"user","data":{"text":"after promotion"},"delivery":"steer"}"#,
                "evt_w007d",
            ),
            None,
        )
        .await
        .unwrap();
    assert_eq!(promoted, first);
    within(world.execution.await_idle(&id)).await;
    assert!(
        requests.try_recv().is_err(),
        "a promoted retry runs nothing"
    );
    assert_eq!(user_texts(&world.sessions, "ses_w007"), ["first text"]);
    server.await.unwrap();
}

// TEST-007: a barrier before the admission commit exposes nothing and admits once.
#[tokio::test]
async fn test007_admission_barrier_before_commit_exposes_nothing_and_admits_once() {
    let root = Root::new();
    let store = file_store(&root);
    let service = Service::new(store.client());
    let (release, held) = hold_writer(&store).await;
    let admissions = ["first", "second"].map(|text| {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .admit(request(
                    "ses_one",
                    "msg_barrier",
                    &format!(r#"{{"type":"user","data":{{"text":"{text}"}},"delivery":"steer"}}"#),
                    &format!("evt_{text}"),
                ))
                .await
        })
    });
    for _ in 0..20 {
        assert!(service.pending_list(&sid("ses_one")).unwrap().is_empty());
        assert_eq!(
            count(&event_types(&store, "ses_one"), "session.input.admitted"),
            0
        );
        tokio::task::yield_now().await;
    }
    assert!(admissions.iter().all(|admission| !admission.is_finished()));
    release.send(()).unwrap();
    held.await.unwrap();
    let [first, second] = admissions;
    assert_eq!(
        first.await.unwrap().unwrap(),
        second.await.unwrap().unwrap()
    );
    assert_eq!(service.pending_list(&sid("ses_one")).unwrap().len(), 1);
    assert_eq!(
        count(&event_types(&store, "ses_one"), "session.input.admitted"),
        1
    );
    assert!(user_texts(&service, "ses_one").is_empty());
}

// TEST-011: Execution resolves each Session's Location from the store when its drain starts.
#[tokio::test]
async fn test011_execution_places_each_session_by_its_stored_location() {
    let world = world();
    let one = world.seed("ses_w011a", "/world/t011a");
    let two = world.seed("ses_w011b", "/world/t011b");
    admit(
        &world.sessions,
        "ses_w011a",
        "w011a",
        "Alpha session",
        "steer",
    )
    .await;
    admit(
        &world.sessions,
        "ses_w011b",
        "w011b",
        "Beta session",
        "steer",
    )
    .await;
    let (alpha, mut alpha_requests, alpha_server) = server(vec![TEXT]).await;
    let (beta, mut beta_requests, beta_server) = server(vec![TEXT]).await;
    world.place("/world/t011a", &alpha, registry());
    world.place("/world/t011b", &beta, registry());
    let (a, b, c) = tokio::join!(
        world.execution.resume(&one),
        world.execution.resume(&one),
        world.execution.resume(&two)
    );
    a.unwrap();
    b.unwrap();
    c.unwrap();
    let alpha_sent = ycoding_schema::stringify_json(&within(alpha_requests.recv()).await.unwrap());
    let beta_sent = ycoding_schema::stringify_json(&within(beta_requests.recv()).await.unwrap());
    assert!(alpha_sent.contains("Alpha session") && !alpha_sent.contains("Beta session"));
    assert!(beta_sent.contains("Beta session") && !beta_sent.contains("Alpha session"));
    within(world.execution.await_idle(&one)).await;
    within(world.execution.await_idle(&two)).await;
    assert!(
        alpha_requests.try_recv().is_err(),
        "joined resumes share one drain"
    );
    assert!(beta_requests.try_recv().is_err());
    world.execution.interrupt(&one).await.unwrap();
    let unknown = sid("ses_w011_unknown");
    assert!(world.execution.interrupt(&unknown).await.is_err());
    assert!(world.execution.resume(&unknown).await.is_err());
    alpha_server.await.unwrap();
    beta_server.await.unwrap();
}

// TEST-015: a real drain continues an active goal only without child or shell blockers.
#[tokio::test]
async fn test015_goal_continuation_respects_child_and_shell_blockers() {
    use ycoding_core::session::{
        autonomy::{Goal, GoalStatus, Service as Autonomy},
        completion::{Completion, Page},
    };
    let world = world();
    let autonomy = Autonomy::new(world.client.clone());
    // Progress: no blocker, so settlement advances the goal and admits one continuation.
    let progress = world.seed("ses_w015p", "/world/t015p");
    admit(
        &world.sessions,
        "ses_w015p",
        "w015p",
        "Start the work",
        "steer",
    )
    .await;
    autonomy
        .set_goal(&progress, Goal::new("Ship the fix", None, None))
        .await
        .unwrap();
    world
        .steers
        .replies
        .lock()
        .unwrap()
        .insert(progress.clone(), ["Keep going".to_string()].into());
    let (endpoint, mut requests, progress_server) = server(vec![TEXT, TEXT]).await;
    world.place("/world/t015p", &endpoint, registry());
    world.execution.resume(&progress).await.unwrap();
    let first = ycoding_schema::stringify_json(&within(requests.recv()).await.unwrap());
    let second = ycoding_schema::stringify_json(&within(requests.recv()).await.unwrap());
    assert!(!first.contains("Keep going"));
    assert!(second.contains("Keep going"), "{second}");
    within(world.execution.await_idle(&progress)).await;
    let goal = autonomy.get(&progress).unwrap().goal.unwrap();
    assert_eq!(
        (goal.status, goal.iteration, goal.no_progress),
        (GoalStatus::Active, 1, 0)
    );
    let steered = world.steers.requests.lock().unwrap()[&progress].clone();
    assert_eq!(steered.len(), 2);
    assert!(
        !Completion::new(world.sessions.clone(), world.jobs.clone())
            .latest(Page {
                after: None,
                limit: 200
            })
            .unwrap()
            .data
            .iter()
            .any(|receipt| receipt.session_id == progress),
        "idle text alone creates no completion receipt"
    );
    progress_server.await.unwrap();
    // Active child and active shell block continuation: no steer is requested, the
    // iteration does not advance and no no-progress attempt is consumed.
    for blocker in ["child", "shell"] {
        let name = format!("ses_w015{blocker}");
        let directory = format!("/world/t015{blocker}");
        let id = world.seed(&name, &directory);
        admit(
            &world.sessions,
            &name,
            &format!("w015{blocker}"),
            "Start the work",
            "steer",
        )
        .await;
        autonomy
            .set_goal(&id, Goal::new("Ship the fix", None, None))
            .await
            .unwrap();
        world
            .steers
            .replies
            .lock()
            .unwrap()
            .insert(id.clone(), ["Never used".to_string()].into());
        let (release, held) = tokio::sync::oneshot::channel::<()>();
        let job = format!("job_w015{blocker}");
        if blocker == "child" {
            world.running_child(&id, "call_w015").await;
        } else {
            world
                .jobs
                .start(ycoding_core::job::StartInput {
                    id: Some(job.clone()),
                    kind: "shell".into(),
                    title: None,
                    metadata: Some(serde_json::Map::from_iter([(
                        "sessionID".into(),
                        name.clone().into(),
                    )])),
                    run: Box::pin(async move {
                        let _ = held.await;
                        Ok(String::new())
                    }),
                })
                .unwrap();
        }
        let (endpoint, mut requests, server) = server(vec![TEXT]).await;
        world.place(&directory, &endpoint, registry());
        world.execution.resume(&id).await.unwrap();
        within(world.execution.await_idle(&id)).await;
        within(requests.recv()).await.unwrap();
        assert!(
            requests.try_recv().is_err(),
            "{blocker} blocker spins no extra drain"
        );
        assert!(
            !world.steers.requests.lock().unwrap().contains_key(&id),
            "{blocker}"
        );
        let goal = autonomy.get(&id).unwrap().goal.unwrap();
        assert_eq!(
            (goal.status, goal.iteration, goal.no_progress),
            (GoalStatus::Active, 0, 0)
        );
        let _ = release.send(());
        if blocker == "shell" {
            within(world.jobs.wait(&job, None)).await;
        }
        server.await.unwrap();
    }
}

// TEST-015: a work-completion receipt needs the completed goal, the declaration and the
// final text; an open goal keeps the declaration from becoming a receipt.
#[tokio::test]
async fn test015_work_completion_receipt_requires_completed_goal_declaration_and_final_text() {
    use ycoding_core::session::{
        autonomy::{Goal, GoalStatus, Service as Autonomy},
        completion::{Completion, Page},
    };
    let world = world();
    let autonomy = Autonomy::new(world.client.clone());
    for (name, completes_goal) in [("ses_w015done", true), ("ses_w015open", false)] {
        let directory = format!("/world/{name}");
        let id = world.seed(name, &directory);
        admit(&world.sessions, name, name, "Finish and verify", "steer").await;
        autonomy
            .set_goal(&id, Goal::new("Ship it", None, None))
            .await
            .unwrap();
        let mut script = Vec::new();
        if completes_goal {
            script.push(Reply::Status(
                200,
                tool_reply("goal", r#"{"action":"complete"}"#),
            ));
        }
        script.push(Reply::Status(200, tool_reply("task_complete", "{}")));
        script.push(Reply::Status(200, TEXT));
        let calls = script.len();
        let (endpoint, mut requests, server) = server_replies(script).await;
        world.place(&directory, &endpoint, session_tools_registry(&world.client));
        within(world.execution.resume(&id)).await.unwrap();
        within(world.execution.await_idle(&id)).await;
        for _ in 0..calls {
            within(requests.recv()).await.unwrap();
        }
        assert!(requests.try_recv().is_err(), "{name}: no extra attempt");
        server.await.unwrap();
        let types = event_types(&world.client, name);
        let receipts = Completion::new(world.sessions.clone(), world.jobs.clone())
            .latest(Page {
                after: None,
                limit: 200,
            })
            .unwrap()
            .data
            .into_iter()
            .filter(|receipt| receipt.session_id == id)
            .collect::<Vec<_>>();
        let goal = autonomy.get(&id).unwrap().goal.unwrap();
        if completes_goal {
            assert_eq!(goal.status, GoalStatus::Completed);
            assert_eq!(receipts.len(), 1);
            assert_eq!(count(&types, "session.work.completed"), 1);
            let final_text = types
                .iter()
                .rposition(|kind| kind == "session.text.ended.1")
                .unwrap();
            let receipt = types
                .iter()
                .position(|kind| kind == "session.work.completed.1")
                .unwrap();
            assert!(receipt > final_text, "the receipt follows the final text");
        } else {
            assert_eq!(goal.status, GoalStatus::Active);
            assert!(receipts.is_empty(), "an active goal publishes no receipt");
            assert_eq!(count(&types, "session.work.completed"), 0);
            assert_eq!(count(&types, "session.tool.success"), 1);
        }
    }
}

struct NoExecution;
impl ycoding_core::session::orchestration::Execution for NoExecution {
    fn resume(&self, _: &session::Id) -> ycoding_core::session::run_coordinator::RunFuture {
        panic!("unexpected explicit resumption")
    }

    fn wake(&self, _: &session::Id) -> ycoding_core::session::run_coordinator::Outcome {
        Ok(())
    }
    fn interrupt(&self, _: &session::Id) -> ycoding_core::session::run_coordinator::RunFuture {
        Box::pin(async { Ok(()) })
    }
}

async fn worker(mode: &str, root: &Root, endpoint: &str, marker: &std::path::Path) -> Option<i32> {
    let (mode, directory, endpoint, marker) = (
        mode.to_string(),
        root.0.clone(),
        endpoint.to_string(),
        marker.to_path_buf(),
    );
    tokio::task::spawn_blocking(move || {
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "flow_worker", "--ignored"])
            .env("YCODING_FLOW_MODE", mode)
            .env("YCODING_FLOW_ROOT", directory)
            .env("YCODING_FLOW_ENDPOINT", endpoint)
            .env("YCODING_FLOW_MARKER", marker)
            .status()
            .unwrap()
            .code()
    })
    .await
    .unwrap()
}

#[test]
#[ignore = "subprocess-only restart fixture"]
fn flow_worker() {
    let mode = std::env::var("YCODING_FLOW_MODE").unwrap();
    let directory = std::path::PathBuf::from(std::env::var("YCODING_FLOW_ROOT").unwrap());
    let endpoint = std::env::var("YCODING_FLOW_ENDPOINT").unwrap();
    let marker = std::path::PathBuf::from(std::env::var("YCODING_FLOW_MARKER").unwrap());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let code = runtime.block_on(async move {
        let world = flow::build_world(flow::reopen_at(&directory));
        match mode.as_str() {
            "mutation_arm" => mutation_arm(&world, &endpoint, &marker).await,
            "mutation_restart" => mutation_restart(&world, &endpoint, &marker).await,
            "blocker_arm" => blocker_arm(&world, &endpoint).await,
            "blocker_restart" => blocker_restart(&world, &endpoint).await,
            other => panic!("unknown worker mode {other}"),
        }
    });
    std::process::exit(code)
}

// The process dies right after the tool result commits and before the next provider
// request: the committed mutation must stay the only one.
async fn mutation_arm(world: &flow::World, endpoint: &str, marker: &std::path::Path) -> i32 {
    world.client.observe_events(|events| {
        if events
            .iter()
            .any(|event| event.type_.as_str() == Some("session.tool.success.1"))
        {
            std::process::exit(17)
        }
        true
    });
    let id = world.seed("ses_mutation", "/world/mutation");
    admit(
        &world.sessions,
        "ses_mutation",
        "mutation",
        "Mutate once",
        "steer",
    )
    .await;
    world.place(
        "/world/mutation",
        endpoint,
        flow::mutating_registry(marker.to_path_buf()),
    );
    let _ = world.execution.resume(&id).await;
    1
}

async fn mutation_restart(world: &flow::World, endpoint: &str, marker: &std::path::Path) -> i32 {
    let id = sid("ses_mutation");
    world.place(
        "/world/mutation",
        endpoint,
        flow::mutating_registry(marker.to_path_buf()),
    );
    assert_eq!(world.sessions.reconcile_interrupted(10).await.unwrap(), 1);
    let types = event_types(&world.client, "ses_mutation");
    assert_eq!(
        count(&types, "session.step.ended") + count(&types, "session.step.failed"),
        count(&types, "session.step.started"),
        "reconciliation settles the unterminated Step"
    );
    let _ = within(world.execution.resume(&id)).await;
    let types = event_types(&world.client, "ses_mutation");
    assert_eq!(count(&types, "session.tool.called"), 1);
    assert_eq!(count(&types, "session.tool.success"), 1);
    0
}

// The process dies while a child task and a shell job block the active goal.
async fn blocker_arm(world: &flow::World, endpoint: &str) -> i32 {
    use ycoding_core::session::autonomy::{Goal, GoalStatus, Service as Autonomy};
    let id = world.seed("ses_restart", "/world/restart");
    admit(
        &world.sessions,
        "ses_restart",
        "restart",
        "Start the work",
        "steer",
    )
    .await;
    let autonomy = Autonomy::new(world.client.clone());
    autonomy
        .set_goal(&id, Goal::new("Ship the fix", None, None))
        .await
        .unwrap();
    world
        .steers
        .replies
        .lock()
        .unwrap()
        .insert(id.clone(), ["Continue after restart".to_string()].into());
    world.running_child(&id, "call_restart").await;
    world
        .jobs
        .start(ycoding_core::job::StartInput {
            id: Some("job_restart".into()),
            kind: "shell".into(),
            title: None,
            metadata: Some(serde_json::Map::from_iter([(
                "sessionID".into(),
                "ses_restart".into(),
            )])),
            run: Box::pin(async {
                std::future::pending::<()>().await;
                Ok(String::new())
            }),
        })
        .unwrap();
    world.place("/world/restart", endpoint, registry());
    within(world.execution.resume(&id)).await.unwrap();
    within(world.execution.await_idle(&id)).await;
    assert!(!world.steers.requests.lock().unwrap().contains_key(&id));
    let goal = autonomy.get(&id).unwrap().goal.unwrap();
    assert_eq!(
        (goal.status, goal.iteration, goal.no_progress),
        (GoalStatus::Active, 0, 0)
    );
    17
}

async fn blocker_restart(world: &flow::World, endpoint: &str) -> i32 {
    use ycoding_core::session::{
        autonomy::{GoalStatus, Service as Autonomy},
        orchestration::{Launch, Service as Orchestration},
    };
    let id = sid("ses_restart");
    let child = Launch::new(
        &id,
        &session_message::Id::new("msg_parent").unwrap(),
        "call_restart",
    )
    .child_id;
    let orchestration = Orchestration::new(world.sessions.clone(), Arc::new(NoExecution));
    assert_eq!(orchestration.reconcile_stale().await.unwrap(), 1);
    let state = world
        .client
        .snapshot()
        .unwrap()
        .get::<ycoding_store::session::TaskTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(child.as_lossless()),
        ]))
        .unwrap()
        .unwrap()
        .state
        .to_utf8()
        .unwrap();
    assert!(
        !["starting", "running", "waiting", "cancelling"].contains(&state.as_str()),
        "the restart settles the child as {state}"
    );
    let (ended, mut steps) = tokio::sync::mpsc::unbounded_channel();
    world.client.observe_events(move |events| {
        for event in events {
            if event.type_.as_str() == Some("session.step.ended.1") {
                let _ = ended.send(());
            }
        }
        true
    });
    world
        .steers
        .replies
        .lock()
        .unwrap()
        .insert(id.clone(), ["Continue after restart".to_string()].into());
    world.place("/world/restart", endpoint, registry());
    within(world.execution.resume(&id)).await.unwrap();
    let continued = || {
        ycoding_schema::stringify_json(&ycoding_schema::DomainEncode::encode(
            &world.sessions.context(&id).unwrap(),
        ))
        .contains("Continue after restart")
    };
    while !continued() {
        within(steps.recv()).await.unwrap();
    }
    within(world.execution.await_idle(&id)).await;
    let goal = Autonomy::new(world.client.clone())
        .get(&id)
        .unwrap()
        .goal
        .unwrap();
    assert_eq!((goal.status, goal.iteration), (GoalStatus::Active, 1));
    0
}

// TEST-015: the active goal stays blocked by a child and a shell across a process crash
// and continues once the restart settles the child.
#[tokio::test]
async fn test015_blocker_restart_in_a_subprocess_worker() {
    use ycoding_core::session::autonomy::{GoalStatus, Service as Autonomy};
    let root = Root::new();
    file_store(&root).shutdown().unwrap();
    let (endpoint, mut requests, server) = server(vec![TEXT, TEXT, TEXT]).await;
    let marker = root.0.join("unused");
    assert_eq!(
        worker("blocker_arm", &root, &endpoint, &marker).await,
        Some(17)
    );
    let store = reopen(&root);
    let id = sid("ses_restart");
    let goal = Autonomy::new(store.client())
        .get(&id)
        .unwrap()
        .goal
        .unwrap();
    assert_eq!(
        (goal.status, goal.iteration, goal.no_progress),
        (GoalStatus::Active, 0, 0)
    );
    let service = Service::new(store.client());
    assert!(service.pending_list(&id).unwrap().is_empty());
    let running = store
        .snapshot()
        .unwrap()
        .scan::<ycoding_store::session::TaskTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            100,
        )
        .unwrap()
        .into_iter()
        .filter(|task| task.parent_id == *id.as_lossless())
        .map(|task| task.state.to_utf8().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(running, ["running"], "the crash leaves the child unsettled");
    store.shutdown().unwrap();
    within(requests.recv()).await.unwrap();
    assert!(
        requests.try_recv().is_err(),
        "blockers sent no extra request"
    );
    assert_eq!(
        worker("blocker_restart", &root, &endpoint, &marker).await,
        Some(0)
    );
    let mut later = Vec::new();
    while let Ok(body) = requests.try_recv() {
        later.push(ycoding_schema::stringify_json(&body));
    }
    assert!(!later.is_empty());
    assert!(later.last().unwrap().contains("Continue after restart"));
    server.abort();
}

// TEST-014: a mutating tool whose result committed before the process died is not run
// again by the restart reconciliation or an explicit resume.
#[tokio::test]
async fn test014_committed_mutation_is_not_replayed_after_restart() {
    let root = Root::new();
    file_store(&root).shutdown().unwrap();
    let (endpoint, mut requests, server) = server(vec![TOOL, TEXT]).await;
    let marker = root.0.join("mutations.log");
    let mutations = || {
        std::fs::read_to_string(&marker)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        worker("mutation_arm", &root, &endpoint, &marker).await,
        Some(17)
    );
    assert_eq!(mutations(), ["call_fixture"]);
    let store = reopen(&root);
    let types = event_types(&store, "ses_mutation");
    assert_eq!(count(&types, "session.step.started"), 1);
    assert_eq!(
        count(&types, "session.step.ended") + count(&types, "session.step.failed"),
        0
    );
    assert_eq!(count(&types, "session.tool.success"), 1);
    store.shutdown().unwrap();
    within(requests.recv()).await.unwrap();
    assert!(
        requests.try_recv().is_err(),
        "the process died before the next request"
    );
    assert_eq!(
        worker("mutation_restart", &root, &endpoint, &marker).await,
        Some(0)
    );
    assert_eq!(
        mutations(),
        ["call_fixture"],
        "the committed mutation ran once"
    );
    let store = reopen(&root);
    let types = event_types(&store, "ses_mutation");
    assert_eq!(
        count(&types, "session.step.ended") + count(&types, "session.step.failed"),
        count(&types, "session.step.started")
    );
    assert_eq!(count(&types, "session.tool.called"), 1);
    store.shutdown().unwrap();
    server.abort();
}

// TEST-008: malformed table admits nothing; command retry after promotion has no duplicate effect.
#[tokio::test]
async fn test008_malformed_table_and_retry_after_promotion() {
    let root = Root::new();
    let store = file_store(&root);
    let service = Service::new(store.client());
    for bad in [
        r#"{"type":"user","data":{},"delivery":"steer"}"#,
        r#"{"type":"user","data":{"text":"x"}}"#,
        r#"{"type":"user","data":{"text":"x"},"delivery":"later"}"#,
        r#"{"type":"unknown","data":{"text":"x"},"delivery":"steer"}"#,
        r#"{"type":"user","data":{"text":"x","files":[{"uri":7}]},"delivery":"steer"}"#,
        r#"{"type":"synthetic","data":{},"delivery":"steer"}"#,
    ] {
        assert!(
            session_pending::Message::decode(&parse_json(bad).unwrap()).is_err(),
            "malformed input must reject: {bad}"
        );
    }
    assert!(service.pending_list(&sid("ses_one")).unwrap().is_empty());
    assert!(user_texts(&service, "ses_one").is_empty());
    // Cross-session and cross-kind reuse reject atomically (also in TEST-007 matrix).
    admit(&service, "ses_one", "cmd", "/review focus", "steer").await;
    let mut other = request(
        "ses_two",
        "msg_cmd",
        r#"{"type":"user","data":{"text":"other session"},"delivery":"steer"}"#,
        "evt_other",
    );
    other.id = session_message::Id::new("msg_cmd").unwrap();
    assert!(service.admit(other).await.is_err());
    assert!(
        service
            .admit(request(
                "ses_one",
                "msg_cmd",
                r#"{"type":"synthetic","data":{"text":"kind change"},"delivery":"steer"}"#,
                "evt_kind"
            ))
            .await
            .is_err()
    );
    // Promote through the real runner (command-style input), then retry: no second
    // provider request and no second visible message.
    let (endpoint, mut requests, server) = server(vec![TEXT]).await;
    run_one(&store, &endpoint, "ses_one").await;
    requests.recv().await.unwrap();
    let retry = service
        .admit(request(
            "ses_one",
            "msg_cmd",
            r#"{"type":"user","data":{"text":"/review different"},"delivery":"steer"}"#,
            "evt_retry",
        ))
        .await
        .unwrap();
    assert_eq!(retry.id.as_str(), Some("msg_cmd"));
    assert_eq!(user_texts(&service, "ses_one"), ["/review focus"]);
    assert!(requests.try_recv().is_err());
    server.await.unwrap();
}

// TEST-009: held promotion/read race never exposes an intermediate state; failure retains input.
#[tokio::test]
async fn test009_promotion_race_and_failed_transaction_retry() {
    let root = Root::new();
    let store = file_store(&root);
    let service = Service::new(store.client());
    admit(&service, "ses_one", "race", "Race input", "steer").await;
    let key = || ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&"msg_race".into())]);
    // Failed promotion commit: a stray message row already owns the input identity on
    // disk, so the real promotion transaction appends its event and then fails
    // projecting the message. The writer is held meanwhile, so the promotion is queued
    // and every snapshot read shows the pending row and no promoted event.
    store
        .submit(|tx| {
            ycoding_store::session::MessageTable::insert(
                tx,
                &ycoding_store::session::Message {
                    id: "msg_race".into(),
                    session_id: "ses_one".into(),
                    type_: "user".into(),
                    seq: 999,
                    time_created: 1,
                    time_updated: 1,
                    data: parse_json(r#"{"text":"stray","time":{"created":1}}"#).unwrap(),
                },
            )
        })
        .unwrap()
        .await
        .unwrap();
    let before = event_seqs(&store, "ses_one");
    let (release, held) = hold_writer(&store).await;
    let failing = service.clone();
    let attempt = tokio::spawn(async move { failing.promote_steers(&sid("ses_one"), 20).await });
    for _ in 0..20 {
        let snapshot = store.snapshot().unwrap();
        assert!(
            snapshot
                .get::<ycoding_store::session::PendingTable>(&key())
                .unwrap()
                .is_some()
        );
        assert_eq!(event_seqs(&store, "ses_one"), before);
        tokio::task::yield_now().await;
    }
    assert!(!attempt.is_finished());
    release.send(()).unwrap();
    held.await.unwrap();
    assert!(
        attempt.await.unwrap().is_err(),
        "a conflicting message cannot be promoted over"
    );
    assert_eq!(
        event_seqs(&store, "ses_one"),
        before,
        "rollback leaves neither the promoted event nor a sequence gap"
    );
    assert_eq!(service.pending_list(&sid("ses_one")).unwrap().len(), 1);
    // Removing the conflict and retrying promotes the input exactly once, with a
    // contiguous sequence.
    store
        .submit(|tx| {
            tx.delete::<ycoding_store::session::MessageTable>(&ycoding_store::tuple_key(&[
                ycoding_store::KeyPart::String(&"msg_race".into()),
            ]))
        })
        .unwrap()
        .await
        .unwrap();
    assert!(user_texts(&service, "ses_one").is_empty());
    // Held promotion commit: the promotion is queued behind the held writer, so every
    // snapshot read meanwhile shows the pending row and no message.
    let (release, held) = hold_writer(&store).await;
    let promoting = service.clone();
    let task = tokio::spawn(async move { promoting.promote_steers(&sid("ses_one"), 20).await });
    for _ in 0..20 {
        let snapshot = store.snapshot().unwrap();
        assert!(
            snapshot
                .get::<ycoding_store::session::PendingTable>(&ycoding_store::tuple_key(&[
                    ycoding_store::KeyPart::String(&"msg_race".into()),
                ]))
                .unwrap()
                .is_some()
        );
        assert!(
            snapshot
                .get::<ycoding_store::session::MessageTable>(&ycoding_store::tuple_key(&[
                    ycoding_store::KeyPart::String(&"msg_race".into()),
                ]))
                .unwrap()
                .is_none()
        );
        tokio::task::yield_now().await;
    }
    assert!(!task.is_finished());
    release.send(()).unwrap();
    held.await.unwrap();
    // Coherent store snapshots while the promotion commits: a single snapshot must
    // never show both the pending row and the visible message for the same input.
    for _ in 0..200 {
        let snapshot = store.snapshot().unwrap();
        let pending = snapshot
            .get::<ycoding_store::session::PendingTable>(&ycoding_store::tuple_key(&[
                ycoding_store::KeyPart::String(&"msg_race".into()),
            ]))
            .unwrap();
        let message = snapshot
            .get::<ycoding_store::session::MessageTable>(&ycoding_store::tuple_key(&[
                ycoding_store::KeyPart::String(&"msg_race".into()),
            ]))
            .unwrap();
        assert!(
            !(pending.is_some() && message.is_some()),
            "snapshot exposed consumed-with-message duplicate"
        );
        if task.is_finished() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(task.await.unwrap().unwrap(), 1);
    assert_eq!(user_texts(&service, "ses_one"), ["Race input"]);
    assert!(service.pending_list(&sid("ses_one")).unwrap().is_empty());
    let after = event_seqs(&store, "ses_one");
    assert_eq!(after.len(), before.len() + 1);
    assert!(after.windows(2).all(|pair| pair[1] == pair[0] + 1));
    // Successful retry after the earlier failure is exactly-once: a second promotion is a no-op.
    assert_eq!(
        service.promote_steers(&sid("ses_one"), 30).await.unwrap(),
        0
    );
    assert_eq!(user_texts(&service, "ses_one"), ["Race input"]);
}

// TEST-010: two steers and two queues, held would-idle boundaries, batch allowance reset once.
#[tokio::test]
async fn test010_two_steers_two_queues_batch_reset_once() {
    let root = Root::new();
    let store = file_store(&root);
    let service = Service::new(store.client());
    admit(&service, "ses_one", "input", "Answer the prompt", "steer").await;
    let (registry, _registration) = admitting_echo(
        &store,
        "ses_one",
        vec![
            ("steer1", "Steer one", "steer"),
            ("steer2", "Steer two", "steer"),
            ("queue1", "Queue one", "queue"),
            ("queue2", "Queue two", "queue"),
        ],
    );
    // Step allowance of 2: without a reset the second step would be tool-less.
    let mut build = ycoding_core::resources::agent::empty("build".into());
    build.steps = Some(ycoding_schema::schema::PositiveInt::new(2).unwrap());
    let (endpoint, mut requests, server) = server(vec![TOOL, TEXT, TEXT, TEXT]).await;
    let coordinator = Coordinator::new(Arc::new(local_agents(
        &store,
        &endpoint,
        registry,
        vec![build],
    )));
    coordinator.run(&sid("ses_one")).await.unwrap();
    let first = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    let second = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    let third = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    let fourth = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(!first.contains("Steer one") && !first.contains("Queue one"));
    // Both steers promote together at the next safe boundary (batch, one reset:
    // tools are present again on this step despite the allowance of 2).
    assert!(
        second.contains("Steer one") && second.contains("Steer two"),
        "{second}"
    );
    assert!(!second.contains("Queue one"));
    assert!(
        second.contains("\"tools\""),
        "batch reset must restore tools: {second}"
    );
    // Queues promote one per would-idle boundary, in order.
    assert!(
        third.contains("Queue one") && !third.contains("Queue two"),
        "{third}"
    );
    assert!(fourth.contains("Queue two"), "{fourth}");
    assert!(service.pending_list(&sid("ses_one")).unwrap().is_empty());
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

// TEST-011: same/different Session interleaving with real Location runners.
#[tokio::test]
async fn test011_same_and_different_session_interleaving_real_runners() {
    let root = Root::new();
    let store = file_store(&root);
    let service = Service::new(store.client());
    admit(&service, "ses_one", "one", "First session", "steer").await;
    admit(&service, "ses_two", "two", "Second session", "steer").await;
    // The second Session belongs to the second Location.
    store
        .submit(|tx| {
            let key =
                ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&"ses_two".into())]);
            let mut row = tx
                .get::<ycoding_store::session::SessionTable>(&key)?
                .unwrap();
            row.directory = "/other".into();
            ycoding_store::session::SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    let (endpoint, mut requests, server) = server(vec![TEXT, TEXT]).await;
    let one = Coordinator::new(Arc::new(local_at(
        &store,
        &endpoint,
        registry(),
        "/project",
    )));
    let two = Coordinator::new(Arc::new(local_at(&store, &endpoint, registry(), "/other")));
    // Same-Session concurrent resumes join one drain; different Sessions progress together.
    let one_id = sid("ses_one");
    let two_id = sid("ses_two");
    let (a, b, c) = tokio::join!(one.run(&one_id), one.run(&one_id), two.run(&two_id));
    a.unwrap();
    b.unwrap();
    c.unwrap();
    let mut bodies = [
        ycoding_schema::stringify_json(&requests.recv().await.unwrap()),
        ycoding_schema::stringify_json(&requests.recv().await.unwrap()),
    ];
    bodies.sort();
    assert!(bodies.iter().any(|body| body.contains("First session")));
    assert!(bodies.iter().any(|body| body.contains("Second session")));
    assert_eq!(user_texts(&service, "ses_one"), ["First session"]);
    assert_eq!(user_texts(&service, "ses_two"), ["Second session"]);
    // Idle interruption is a no-op; an unknown Session has no durable state to interrupt.
    one.interrupt(&sid("ses_one"), InterruptReason::User)
        .await
        .unwrap();
    assert!(service.get(&sid("ses_unknown")).unwrap().is_none());
    assert!(one.active().is_empty() && two.active().is_empty());
    server.await.unwrap();
    one.shutdown().await.unwrap();
    two.shutdown().await.unwrap();
}

// TEST-012: settlement table — read failure, non-LLM failure, backoff cancellation.
#[tokio::test]
async fn test012_settlement_table_exactly_one_terminal_per_step() {
    // Malformed / read failure: the provider stream cannot be read as events.
    for replies in [
        vec![Reply::Status(200, MALFORMED)],
        vec![Reply::Truncated(TEXT_HEAD, "data: [DONE]\n\n")],
    ] {
        let root = Root::new();
        let store = file_store(&root);
        let service = Service::new(store.client());
        admit(&service, "ses_one", "input", "Answer", "steer").await;
        let (endpoint, mut requests, server) = server_replies(replies).await;
        let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry())));
        assert!(coordinator.run(&sid("ses_one")).await.is_err());
        requests.recv().await.unwrap();
        assert!(
            requests.try_recv().is_err(),
            "only a context overflow earns a second physical attempt"
        );
        let types = event_types(&store, "ses_one");
        assert_eq!(count(&types, "session.step.started"), 1);
        assert_eq!(
            count(&types, "session.step.ended") + count(&types, "session.step.failed"),
            1
        );
        server.await.unwrap();
        coordinator.shutdown().await.unwrap();
    }
    // Non-LLM failure: the tool fails; the step still settles with one terminal.
    {
        let root = Root::new();
        let store = file_store(&root);
        let service = Service::new(store.client());
        admit(&service, "ses_one", "input", "Answer", "steer").await;
        let (registry, _registration) = failing_echo(&store, "ses_one");
        let (endpoint, _requests, server) = server(vec![TOOL, TEXT]).await;
        let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry)));
        coordinator.run(&sid("ses_one")).await.unwrap();
        let types = event_types(&store, "ses_one");
        assert_eq!(count(&types, "session.step.started"), 2);
        assert_eq!(
            count(&types, "session.step.ended") + count(&types, "session.step.failed"),
            2
        );
        server.await.unwrap();
        coordinator.shutdown().await.unwrap();
    }
    // Interruption during retry backoff closes the step with one aborted failure.
    {
        struct Stalled(tokio::sync::mpsc::UnboundedSender<u64>);
        impl ycoding_core::session::runner::Clock for Stalled {
            fn now(&self) -> i64 {
                10
            }
            fn sleep(
                &self,
                milliseconds: u64,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
                self.0.send(milliseconds).unwrap();
                Box::pin(std::future::pending())
            }
        }
        let root = Root::new();
        let store = file_store(&root);
        let service = Service::new(store.client());
        admit(&service, "ses_one", "input", "Answer", "steer").await;
        let (endpoint, _requests, server) = server_status(vec![(429, RATE_LIMITED)]).await;
        let (slept, mut backoff) = tokio::sync::mpsc::unbounded_channel();
        let coordinator = Coordinator::new(Arc::new(local_clock(
            &store,
            &endpoint,
            registry(),
            Arc::new(Stalled(slept)),
        )));
        let running = coordinator.clone();
        let task = tokio::spawn(async move { running.run(&sid("ses_one")).await });
        assert_eq!(backoff.recv().await.unwrap(), 2000);
        coordinator
            .interrupt(&sid("ses_one"), InterruptReason::User)
            .await
            .unwrap();
        assert!(task.await.unwrap().is_err());
        let types = event_types(&store, "ses_one");
        assert_eq!(count(&types, "session.step.started"), 1);
        assert_eq!(count(&types, "session.step.failed"), 1);
        assert_eq!(count(&types, "session.step.ended"), 0);
        server.await.unwrap();
        coordinator.shutdown().await.unwrap();
    }
}

// TEST-013: whitespace recovery, recovery failure, no-recovery contrasts.
#[tokio::test]
async fn test013_whitespace_recovery_and_no_recovery_contrasts() {
    // Whitespace-only terminal text gets exactly one text-only recovery step.
    {
        let root = Root::new();
        let store = file_store(&root);
        let service = Service::new(store.client());
        admit(&service, "ses_one", "input", "Answer", "steer").await;
        let (endpoint, mut requests, server) = server(vec![WHITESPACE, TEXT]).await;
        let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry())));
        coordinator.run(&sid("ses_one")).await.unwrap();
        requests.recv().await.unwrap();
        let recovery = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
        assert!(
            !recovery.contains("\"tools\""),
            "recovery is text-only: {recovery}"
        );
        let types = event_types(&store, "ses_one");
        assert_eq!(count(&types, "session.step.started"), 2);
        assert_eq!(count(&types, "session.step.ended"), 2);
        assert_eq!(user_texts(&service, "ses_one"), ["Answer"]);
        server.await.unwrap();
        coordinator.shutdown().await.unwrap();
    }
    // Recovery failure settles the recovery step and never starts a third.
    {
        let root = Root::new();
        let store = file_store(&root);
        let service = Service::new(store.client());
        admit(&service, "ses_one", "input", "Answer", "steer").await;
        let (endpoint, _requests, server) =
            server_status(vec![(200, WHITESPACE), (400, REJECTED)]).await;
        let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry())));
        assert!(coordinator.run(&sid("ses_one")).await.is_err());
        let types = event_types(&store, "ses_one");
        assert_eq!(count(&types, "session.step.started"), 2);
        assert_eq!(
            count(&types, "session.step.ended") + count(&types, "session.step.failed"),
            2
        );
        server.await.unwrap();
        coordinator.shutdown().await.unwrap();
    }
    // Local tool continuation: useful continuation exists, so no recovery step.
    {
        let root = Root::new();
        let store = file_store(&root);
        let service = Service::new(store.client());
        admit(&service, "ses_one", "input", "Answer", "steer").await;
        let (registry, _registration) = admitting_echo(&store, "ses_one", Vec::new());
        let (endpoint, mut requests, server) = server(vec![TOOL, TEXT]).await;
        let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry)));
        coordinator.run(&sid("ses_one")).await.unwrap();
        requests.recv().await.unwrap();
        requests.recv().await.unwrap();
        assert!(requests.try_recv().is_err(), "no recovery request");
        let types = event_types(&store, "ses_one");
        assert_eq!(count(&types, "session.step.started"), 2);
        server.await.unwrap();
        coordinator.shutdown().await.unwrap();
    }
    // Empty hosted-style result with no local continuation still recovers once;
    // EMPTY is the no-text settlement contrasted with the TOOL case above.
    {
        let root = Root::new();
        let store = file_store(&root);
        let service = Service::new(store.client());
        admit(&service, "ses_one", "input", "Answer", "steer").await;
        let (endpoint, _requests, server) = server(vec![EMPTY, TEXT]).await;
        let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry())));
        coordinator.run(&sid("ses_one")).await.unwrap();
        let types = event_types(&store, "ses_one");
        assert_eq!(count(&types, "session.step.started"), 2);
        assert_eq!(count(&types, "session.step.ended"), 2);
        server.await.unwrap();
        coordinator.shutdown().await.unwrap();
    }
}

// TEST-014: cancellation points and late-attempt fencing.
#[tokio::test]
async fn test014_cancellation_points_and_location_close() {
    // Cancel before send: interrupt the idle session, then a later explicit run is the
    // only provider attempt (the interruption itself sends nothing).
    {
        let root = Root::new();
        let store = file_store(&root);
        let service = Service::new(store.client());
        admit(&service, "ses_one", "input", "Answer", "steer").await;
        let (endpoint, mut requests, server) = server(vec![TEXT]).await;
        let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry())));
        coordinator
            .interrupt(&sid("ses_one"), InterruptReason::User)
            .await
            .unwrap();
        assert!(requests.try_recv().is_err());
        coordinator.run(&sid("ses_one")).await.unwrap();
        requests.recv().await.unwrap();
        assert!(requests.try_recv().is_err());
        server.await.unwrap();
        coordinator.shutdown().await.unwrap();
    }
    // Cancel after promotion commit, before the provider ack/request completes:
    // promote durably first, then close the Location (coordinator shutdown) — no
    // provider request is made and the visible message remains exactly once.
    {
        let root = Root::new();
        let store = file_store(&root);
        let service = Service::new(store.client());
        admit(&service, "ses_one", "input", "Answer", "steer").await;
        assert_eq!(
            service.promote_steers(&sid("ses_one"), 20).await.unwrap(),
            1
        );
        let (endpoint, mut requests, server) = server(vec![TEXT]).await;
        let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry())));
        coordinator.shutdown().await.unwrap();
        assert!(requests.try_recv().is_err());
        assert_eq!(user_texts(&service, "ses_one"), ["Answer"]);
        server.abort();
    }
    // Cancel during the provider stream: the request is held after the provider has
    // acknowledged it. Interruption settles the step once; the late response written
    // after the cancel appends nothing.
    {
        let root = Root::new();
        let store = file_store(&root);
        let service = Service::new(store.client());
        admit(&service, "ses_one", "input", "Answer", "steer").await;
        let (release, held) = tokio::sync::oneshot::channel();
        let (endpoint, mut requests, server) = server_replies(vec![Reply::Held(held, TEXT)]).await;
        let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry())));
        let running = coordinator.clone();
        let task = tokio::spawn(async move { running.run(&sid("ses_one")).await });
        requests.recv().await.unwrap();
        coordinator
            .interrupt(&sid("ses_one"), InterruptReason::User)
            .await
            .unwrap();
        assert!(matches!(
            task.await.unwrap(),
            Err(ycoding_core::session::run_coordinator::Error::Interrupted(
                _
            ))
        ));
        let settled = event_types(&store, "ses_one");
        assert_eq!(count(&settled, "session.step.started"), 1);
        assert_eq!(count(&settled, "session.step.failed"), 1);
        assert_eq!(count(&settled, "session.step.ended"), 0);
        release.send(()).unwrap();
        server.await.unwrap();
        coordinator.shutdown().await.unwrap();
        assert_eq!(event_types(&store, "ses_one"), settled);
        assert!(requests.try_recv().is_err(), "no replayed attempt");
        assert!(coordinator.active().is_empty());
    }
    // Cancel during tool work: interruption joins the owned tool future before it
    // settles, so no late tool result can land. The step keeps its aborted settlement
    // and the tool call is an error, with no continuation request replayed.
    {
        let root = Root::new();
        let store = file_store(&root);
        let service = Service::new(store.client());
        admit(&service, "ses_one", "input", "Answer", "steer").await;
        let (started, mut begin) = tokio::sync::mpsc::unbounded_channel();
        let (finished, mut late) = tokio::sync::mpsc::unbounded_channel();
        let (registry, _registration) = held_echo(started, finished);
        let (endpoint, mut requests, server) = server(vec![TOOL, TEXT]).await;
        let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry)));
        let running = coordinator.clone();
        let task = tokio::spawn(async move { running.run(&sid("ses_one")).await });
        begin.recv().await.unwrap();
        coordinator
            .interrupt(&sid("ses_one"), InterruptReason::User)
            .await
            .unwrap();
        assert!(matches!(
            task.await.unwrap(),
            Err(ycoding_core::session::run_coordinator::Error::Interrupted(
                _
            ))
        ));
        late.recv().await.unwrap();
        coordinator.shutdown().await.unwrap();
        let types = event_types(&store, "ses_one");
        assert_eq!(count(&types, "session.step.started"), 1);
        assert_eq!(count(&types, "session.step.failed"), 1);
        assert_eq!(count(&types, "session.step.ended"), 0);
        requests.recv().await.unwrap();
        assert!(requests.try_recv().is_err(), "no continuation after cancel");
        let history = service.context(&sid("ses_one")).unwrap();
        let ycoding_schema::session_message::Info::Assistant(assistant) = history.last().unwrap()
        else {
            panic!("expected the assistant message to settle last")
        };
        assert!(
            matches!(&assistant.content[0], ycoding_schema::session_message::AssistantContent::Tool(tool) if matches!(tool.state, ycoding_schema::session_message::ToolState::Error(_)))
        );
        server.abort();
    }
    // Location close while a stream is in flight: shutdown cancels and joins the
    // owned drain, leaving no active Session and one failed step.
    {
        let root = Root::new();
        let store = file_store(&root);
        let service = Service::new(store.client());
        admit(&service, "ses_one", "input", "Answer", "steer").await;
        let (release, held) = tokio::sync::oneshot::channel();
        let (endpoint, mut requests, server) = server_replies(vec![Reply::Held(held, TEXT)]).await;
        let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry())));
        let running = coordinator.clone();
        let task = tokio::spawn(async move { running.run(&sid("ses_one")).await });
        requests.recv().await.unwrap();
        coordinator.shutdown().await.unwrap();
        assert!(matches!(
            task.await.unwrap(),
            Err(ycoding_core::session::run_coordinator::Error::Interrupted(
                InterruptReason::Shutdown
            ))
        ));
        assert!(coordinator.active().is_empty());
        let settled = event_types(&store, "ses_one");
        assert_eq!(count(&settled, "session.step.failed"), 1);
        assert_eq!(count(&settled, "session.step.ended"), 0);
        release.send(()).unwrap();
        server.await.unwrap();
        assert_eq!(event_types(&store, "ses_one"), settled);
        assert!(coordinator.run(&sid("ses_one")).await.is_err());
    }
}

// TEST-015: file-backed restart of terminal goals.
#[tokio::test]
async fn test015_terminal_goals_survive_file_restart() {
    use ycoding_core::session::autonomy::{Goal, GoalStatus, Service as Autonomy};
    // Completed on its own root, with the report/advance budget rules.
    {
        let root = Root::new();
        let store = file_store(&root);
        let autonomy = Autonomy::new(store.client());
        autonomy
            .set_goal(&sid("ses_one"), Goal::new("Ship it", None, Some(2)))
            .await
            .unwrap();
        let reported = autonomy
            .report(&sid("ses_one"))
            .await
            .unwrap()
            .goal
            .unwrap();
        assert_eq!(reported.no_progress, 1);
        let advanced = autonomy
            .advance(&sid("ses_one"))
            .await
            .unwrap()
            .goal
            .unwrap();
        assert_eq!((advanced.no_progress, advanced.iteration), (1, 1));
        autonomy.complete(&sid("ses_one")).await.unwrap();
        store.shutdown().unwrap();
        let reopened = reopen(&root);
        let goal = Autonomy::new(reopened.client())
            .get(&sid("ses_one"))
            .unwrap()
            .goal
            .unwrap();
        assert_eq!(goal.status, GoalStatus::Completed);
        assert_eq!(goal.text.as_str(), Some("Ship it"));
        reopened.shutdown().unwrap();
    }
    // Stopped and exhausted on their own roots.
    for expected in [GoalStatus::Stopped, GoalStatus::Exhausted] {
        let root = Root::new();
        let store = file_store(&root);
        let autonomy = Autonomy::new(store.client());
        autonomy
            .set_goal(&sid("ses_one"), Goal::new("Ship it", None, Some(1)))
            .await
            .unwrap();
        if expected == GoalStatus::Stopped {
            autonomy.stop(&sid("ses_one")).await.unwrap();
        } else {
            let goal = autonomy
                .report(&sid("ses_one"))
                .await
                .unwrap()
                .goal
                .unwrap();
            assert_eq!(goal.status, GoalStatus::Exhausted);
        }
        store.shutdown().unwrap();
        let reopened = reopen(&root);
        let goal = Autonomy::new(reopened.client())
            .get(&sid("ses_one"))
            .unwrap()
            .goal
            .unwrap();
        assert_eq!(goal.status, expected);
        reopened.shutdown().unwrap();
    }
}

// TEST-016: orchestration restart, pin/question/answer, nesting/ceiling, BTW identity.
#[tokio::test]
async fn test016_orchestration_restart_pin_question_btw_limits() {
    use ycoding_core::{
        process::guardrails::{Limits, Paths, Settings},
        session::orchestration::{Execution, LaunchInput, Prepared, Service as Orchestration},
        tools::policy::{Authority, Publisher, permissions::Permissions},
    };
    use ycoding_schema::{model, permission, session_orchestration::State};
    struct Recorder(Arc<std::sync::Mutex<Vec<String>>>);
    impl Execution for Recorder {
        fn resume(&self, _: &session::Id) -> ycoding_core::session::run_coordinator::RunFuture {
            panic!("unexpected explicit resumption")
        }

        fn wake(&self, id: &session::Id) -> ycoding_core::session::run_coordinator::Outcome {
            self.0
                .lock()
                .unwrap()
                .push(id.as_lossless().as_str().unwrap().to_string());
            Ok(())
        }
        fn interrupt(
            &self,
            _id: &session::Id,
        ) -> ycoding_core::session::run_coordinator::RunFuture {
            Box::pin(async { Ok(()) })
        }
    }
    let root = Root::new();
    let store = file_store(&root);
    let sessions = Service::new(store.client());
    let recorder = Arc::new(Recorder(Arc::new(std::sync::Mutex::new(Vec::new()))));
    let authority = Authority {
        store: store.client(),
        agents: Arc::new(|agent| {
            Some((agent.cloned().unwrap_or_else(|| "build".into()), Vec::new()))
        }),
    };
    let publisher: Publisher = Arc::new(|_| Ok(()));
    let guardrails = ycoding_core::process::guardrails::Guardrails::new(
        authority.clone(),
        Permissions::new(
            authority,
            ycoding_schema::project_id::ProjectId::new("prj_one").unwrap(),
            publisher.clone(),
        ),
        Settings {
            paths: Paths {
                workdir: "/project".into(),
                project: "/project".into(),
                home: "/home/operator".into(),
                tmpdir: None,
                trusted_paths: vec![],
            },
            global_roots: vec![],
            custom: Arc::new(Vec::new),
            enabled: true,
            limits: Limits {
                subagents: 8,
                ..Limits::default()
            },
            decide_reviews: false,
            decide_hard_reviews: true,
        },
        publisher,
    );
    let service = Orchestration::new(sessions.clone(), recorder.clone());
    let input = |call: &str, depth: usize| LaunchInput {
        parent_id: sid("ses_one"),
        parent_assistant_message_id: session_message::Id::new("msg_parent").unwrap(),
        tool_call_id: call.into(),
        description: "Explore".into(),
        prompt: "Look around".into(),
        depth_limit: depth,
        prepared: Prepared {
            agent: "explore".into(),
            caller_permissions: permission::Ruleset::decode(
                &parse_json(r#"[{"action":"bash","resource":"*","effect":"deny"}]"#).unwrap(),
            )
            .unwrap(),
            model: model::Ref::decode(
                &parse_json(r#"{"providerID":"local","id":"test"}"#).unwrap(),
            )
            .unwrap(),
            profile_binding: None,
        },
        guardrails: guardrails.clone(),
    };
    let child = service.launch(input("call_1", 1)).await.unwrap().session_id;
    assert!(
        service.launch(input("call_deep", 0)).await.is_err(),
        "nesting limit"
    );
    let asked = service.question(&child, "Proceed?", None).await.unwrap();
    assert_eq!(
        service.get(&sid("ses_one"), &child).unwrap().state,
        State::Waiting
    );
    // Restart the root store: Team view and the waiting question rehydrate without
    // opening the child session.
    store.shutdown().unwrap();
    let reopened = reopen(&root);
    let sessions2 = Service::new(reopened.client());
    let service2 = Orchestration::new(sessions2.clone(), recorder.clone());
    let view = service2.team_view(&sid("ses_one")).unwrap();
    assert!(view.text.contains(child.as_lossless().as_str().unwrap()));
    assert_eq!(service2.dispatch_notifications().await.unwrap(), 1);
    let answered = service2
        .answer(
            &sid("ses_one"),
            &child,
            &asked.question.id,
            Some("yes"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(answered.state, State::Running);
    // Pin: pinning the child is a Session lifecycle fact that the parent's Team page
    // reads back without opening the child.
    assert!(
        sessions2
            .change(&child, ycoding_core::session::lifecycle::Change::Pin)
            .await
            .unwrap()
    );
    let page = service2.page(&sid("ses_one"), None, None).unwrap();
    assert_eq!(page.summary.total.get(), 1);
    assert_eq!(page.summary.running.get(), 1);
    assert!(page.data[0].pinned_at.is_some());
    // Permission ceiling: the caller's deny rule is stored on the child.
    let stored = reopened
        .snapshot()
        .unwrap()
        .get::<ycoding_store::session::SessionTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(child.as_lossless()),
        ]))
        .unwrap()
        .unwrap();
    let ceiling = format!("{:?}", stored.permission.unwrap()).to_lowercase();
    assert!(
        ceiling.contains("bash") && ceiling.contains("deny"),
        "{ceiling}"
    );
    // BTW: a side Session selects the btw agent, is promptable on its own, and is not
    // a child of the root Session's Team.
    sessions2
        .publish(ycoding_store::session::NewEvent {
            id: "evt_btw".into(),
            aggregate_id: "ses_two".into(),
            created: 5,
            type_: "session.agent.selected.1".into(),
            data: parse_json(r#"{"sessionID":"ses_two","agent":"btw"}"#).unwrap(),
        })
        .await
        .unwrap();
    admit(&sessions2, "ses_two", "side", "Side question", "steer").await;
    assert_eq!(
        sessions2.promote_steers(&sid("ses_two"), 6).await.unwrap(),
        1
    );
    assert_eq!(user_texts(&sessions2, "ses_two"), ["Side question"]);
    assert!(user_texts(&sessions2, "ses_one").is_empty());
    assert_eq!(
        service2
            .page(&sid("ses_one"), None, None)
            .unwrap()
            .summary
            .total
            .get(),
        1
    );
    reopened.shutdown().unwrap();
}

// TEST-017: reference/tool/MCP skill loads produce the compiled request; instruction epochs.
#[tokio::test]
async fn test017_skill_loads_compiled_request_and_instruction_epochs() {
    let root = Root::new();
    let store = file_store(&root);
    let service = Service::new(store.client());
    // Reference ($mention) and selected-id loads both reach the provider request.
    let skills = Arc::new(FixtureSkills(vec![
        fixture_skill("audit", "Audit", "AUDIT-INSTRUCTIONS"),
        fixture_skill("selected", "Selected", "SELECTED-INSTRUCTIONS"),
    ]));
    let (endpoint, mut requests, server) = server(vec![TEXT, TEXT]).await;
    let coordinator = Coordinator::new(Arc::new(local_skills(
        &store,
        &endpoint,
        registry(),
        skills,
    )));
    service
        .admit(request(
            "ses_one",
            "msg_ref",
            r#"{"type":"user","data":{"text":"Review $audit now"},"delivery":"steer"}"#,
            "evt_ref",
        ))
        .await
        .unwrap();
    coordinator.run(&sid("ses_one")).await.unwrap();
    let first = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(first.contains("AUDIT-INSTRUCTIONS"), "{first}");
    service
        .admit(request(
            "ses_one",
            "msg_sel",
            r#"{"type":"user","data":{"text":"Use selected","metadata":{"skills":[{"id":"selected"}]}},"delivery":"steer"}"#,
            "evt_sel",
        ))
        .await
        .unwrap();
    coordinator.run(&sid("ses_one")).await.unwrap();
    let second = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(second.contains("SELECTED-INSTRUCTIONS"), "{second}");
    // Duplicate load of an active skill does not create a second activation.
    service
        .admit(request(
            "ses_one",
            "msg_dup",
            r#"{"type":"user","data":{"text":"Again $audit"},"delivery":"steer"}"#,
            "evt_dup",
        ))
        .await
        .unwrap();
    let statuses = service.skills(&sid("ses_one"), &[]).unwrap();
    assert_eq!(statuses.len(), 2);
    assert!(
        statuses
            .iter()
            .all(|status| status.state == ycoding_schema::session_skill_status::State::Active)
    );
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
    drop(service);
    // Instruction values across epochs on the same file-backed store.
    {
        use std::sync::{
            Mutex,
            atomic::{AtomicUsize, Ordering},
        };
        use ycoding_core::instructions::{Observation, Source};
        use ycoding_schema::instruction;
        let service = Service::new(store.client());
        let value = Arc::new(Mutex::new(Observation::Value(JsonValue::String(
            "first".into(),
        ))));
        let reads = Arc::new(AtomicUsize::new(0));
        let source = Source {
            key: instruction::Key::decode(&JsonValue::String("api/task".into())).unwrap(),
            read: {
                let value = value.clone();
                let reads = reads.clone();
                Arc::new(move || {
                    let value = value.clone();
                    let reads = reads.clone();
                    Box::pin(async move {
                        reads.fetch_add(1, Ordering::SeqCst);
                        Ok(value.lock().unwrap().clone())
                    })
                })
            },
            initial: Arc::new(|value| match value {
                JsonValue::String(value) => value
                    .as_str()
                    .map(|value| format!("Initial {value}").into()),
                _ => None,
            }),
            changed: Arc::new(|previous, current| match (previous, current) {
                (JsonValue::String(previous), JsonValue::String(current)) => {
                    Some(format!("Changed {} -> {}", previous.as_str()?, current.as_str()?).into())
                }
                _ => None,
            }),
            removed: Some(Arc::new(|_| Some("Removed task".into()))),
        };
        let sources = vec![source];
        service
            .prepare_instructions(&sid("ses_two"), &sources, 1)
            .await
            .unwrap();
        *value.lock().unwrap() = Observation::Value(JsonValue::String("second".into()));
        service
            .prepare_instructions(&sid("ses_two"), &sources, 2)
            .await
            .unwrap();
        // No-op prepare adds nothing.
        let before = service.snapshot(&sid("ses_two"), 100, None).unwrap();
        service
            .prepare_instructions(&sid("ses_two"), &sources, 3)
            .await
            .unwrap();
        assert_eq!(
            service.snapshot(&sid("ses_two"), 100, None).unwrap(),
            before
        );
        // Unavailable retains the last value.
        *value.lock().unwrap() = Observation::Unavailable;
        service
            .prepare_instructions(&sid("ses_two"), &sources, 4)
            .await
            .unwrap();
        assert_eq!(
            service
                .assemble_instructions(&sid("ses_two"), &sources)
                .unwrap()
                .initial
                .as_str(),
            Some("Initial first")
        );
        // Restart: assembly rebuilds from durable blobs without re-reading as initial.
        store.shutdown().unwrap();
        let reopened = reopen(&root);
        let service = Service::new(reopened.client());
        assert_eq!(
            service
                .assemble_instructions(&sid("ses_two"), &sources)
                .unwrap()
                .initial
                .as_str(),
            Some("Initial first")
        );
        // Epochs: completed compaction renders the retained value as the new initial
        // delta; movement and a committed revert clear the epoch until the next prepare.
        for (epoch, (event, kind)) in [
            ("evt_compaction", "session.compaction.ended.2"),
            ("evt_move", "session.moved.1"),
            ("evt_revert", "session.revert.committed.1"),
        ]
        .into_iter()
        .enumerate()
        {
            if kind == "session.revert.committed.1" {
                admit(&service, "ses_two", "boundary", "Revert boundary", "steer").await;
                service.promote_steers(&sid("ses_two"), 30).await.unwrap();
                let boundary = session_message::Id::new("msg_boundary").unwrap();
                ycoding_core::session::revert::stage_idle(
                    &service,
                    &IdleRuns,
                    &NoSnapshots,
                    &sid("ses_two"),
                    &boundary,
                    false,
                    31,
                )
                .await
                .unwrap();
                assert!(
                    service
                        .get(&sid("ses_two"))
                        .unwrap()
                        .unwrap()
                        .revert
                        .is_some()
                );
                assert_eq!(
                    service
                        .assemble_instructions(&sid("ses_two"), &sources)
                        .unwrap()
                        .initial
                        .as_str(),
                    Some("Initial second"),
                    "a staged revert keeps the epoch"
                );
                ycoding_core::session::revert::commit_idle(
                    &service,
                    &IdleRuns,
                    &sid("ses_two"),
                    32,
                )
                .await
                .unwrap();
                assert!(user_texts(&service, "ses_two").is_empty());
            } else {
                reopened
                    .submit(move |tx| {
                        ycoding_store::session::append(
                            tx,
                            &ycoding_store::session::NewEvent {
                                id: event.into(),
                                aggregate_id: "ses_two".into(),
                                created: 10 + epoch as i64,
                                type_: kind.into(),
                                data: parse_json(r#"{"sessionID":"ses_two"}"#).unwrap(),
                            },
                            None,
                        )?;
                        Ok(())
                    })
                    .unwrap()
                    .await
                    .unwrap();
            }
            if kind == "session.compaction.ended.2" {
                let assembly = service
                    .assemble_instructions(&sid("ses_two"), &sources)
                    .unwrap();
                assert_eq!(assembly.initial.as_str(), Some("Initial second"));
                assert!(assembly.updates.is_empty());
                continue;
            }
            assert!(
                service
                    .assemble_instructions(&sid("ses_two"), &sources)
                    .is_err(),
                "{kind} clears the epoch"
            );
            *value.lock().unwrap() = Observation::Unavailable;
            let blocked = service
                .prepare_instructions(&sid("ses_two"), &sources, 20 + epoch as i64)
                .await
                .unwrap_err();
            assert!(
                format!("{blocked:?}").contains("InitializationBlocked"),
                "{kind}: an unavailable source blocks only the new initial delta: {blocked:?}"
            );
            *value.lock().unwrap() = Observation::Value(JsonValue::String("second".into()));
            service
                .prepare_instructions(&sid("ses_two"), &sources, 20 + epoch as i64)
                .await
                .unwrap();
            assert_eq!(
                service
                    .assemble_instructions(&sid("ses_two"), &sources)
                    .unwrap()
                    .initial
                    .as_str(),
                Some("Initial second")
            );
        }
        reopened.shutdown().unwrap();
    }
}

// TEST-018: durable restart/rollback for compaction and artifact lifecycle tokens.
#[tokio::test]
async fn test018_compaction_restart_and_artifact_lifecycle_tokens() {
    use ycoding_core::resources::project_artifact::{source_registry::Registry, store as artifact};
    use ycoding_schema::{DomainDecode as _, DomainEncode as _, project_artifact};
    // Compaction job survives a file restart; a stale admission conflicts without writes.
    let root = Root::new();
    let store = file_store(&root);
    let service = Service::new(store.client());
    admit(&service, "ses_one", "input", "History", "steer").await;
    service.promote_steers(&sid("ses_one"), 2).await.unwrap();
    let job_input = |revision: i64| ycoding_core::session::compaction_job::AdmitInput {
        id: None,
        session: sid("ses_one"),
        trigger: ycoding_schema::session_compaction::Trigger::Manual,
        requested_through_message: session_message::Id::new("msg_input").unwrap(),
        requested_through_seq: 1,
        base_context_revision: revision,
        target_max_input_tokens: 1000,
        config_digest: "c".repeat(64),
        pressure: None,
    };
    // Seed the context revision rows the job admission requires.
    store
        .submit(|tx| {
            ycoding_store::session::RevisionTable::insert(
                tx,
                &ycoding_store::session::Revision {
                    session_id: "ses_one".into(),
                    revision: 0,
                    parent_revision: None,
                    manifest_digest: None,
                    covered_through_message_id: None,
                    covered_through_seq: None,
                    activation_event_id: None,
                    activation_sequence: None,
                    time_created: 0,
                },
            )?;
            ycoding_store::session::ContextStateTable::insert(
                tx,
                &ycoding_store::session::ContextState {
                    session_id: "ses_one".into(),
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
    let job = service.compaction_admit(job_input(0), 10).await.unwrap();
    store.shutdown().unwrap();
    let reopened = reopen(&root);
    let service = Service::new(reopened.client());
    let pending = service.compaction_pending(&sid("ses_one")).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, job.id);
    assert!(service.compaction_admit(job_input(3), 11).await.is_err());
    assert_eq!(
        service
            .compaction_pending(&sid("ses_one"))
            .await
            .unwrap()
            .len(),
        1
    );
    reopened.shutdown().unwrap();
    // Artifact lifecycle across project and global scopes with stale-token rejection.
    let root = Root::new();
    let store = file_store(&root);
    let sources = Arc::new(std::sync::Mutex::new(Registry::default()));
    let paths = artifact::Paths {
        data: root.0.join("data"),
        home: root.0.join("home"),
        config: root.0.join("config"),
    };
    let service = artifact::Service::new(store.client(), paths.clone(), sources.clone());
    let definition = project_artifact::Definition::decode(
        &parse_json(
            r#"{"kind":"skill","name":"Review","description":"Reusable review","content":"Review the current change."}"#,
        )
        .unwrap(),
    )
    .unwrap();
    let manual = artifact::ManualWriteInput {
        scope: project_artifact::ScopeSelector::Project,
        project_id: Some(
            ycoding_schema::project::Id::decode(&JsonValue::String("prj_one".into())).unwrap(),
        ),
        id: "review",
        definition: &definition,
        expected: None,
        now: 1000,
    };
    let first = service.write_manual(manual).unwrap();
    // Global-scope preview token is single-use.
    let preview = service
        .preview_manual(artifact::ManualPreviewInput {
            id: "global-review",
            definition: &definition,
            expected: None,
            now: 2000,
        })
        .unwrap();
    let global = service.confirm_manual(&preview.token, 2001).unwrap();
    assert!(service.confirm_manual(&preview.token, 2002).is_err());
    store.shutdown().unwrap();
    let reopened = reopen(&root);
    let service = artifact::Service::new(reopened.client(), paths, sources);
    // Both scopes survive the restart; a stale lifecycle expectation rejects with no write.
    let got = service
        .get(&first.scope_id, &first.kind, &first.id)
        .unwrap();
    assert_eq!(got.artifact.id, first.id);
    assert!(
        service
            .get(&global.scope_id, &global.kind, &global.id)
            .is_ok()
    );
    let stale = project_artifact::MutationExpectation {
        expected_revision: ycoding_schema::project_artifact::Revision::decode(&JsonValue::Number(
            99.0,
        ))
        .unwrap(),
        expected_version_id: got.current_version.id.clone(),
        expected_digest: got.current_version.content_digest.clone(),
    };
    let before = service
        .get(&first.scope_id, &first.kind, &first.id)
        .unwrap();
    assert!(
        service
            .disable(artifact::LifecycleInput {
                scope_id: &first.scope_id,
                kind: &first.kind,
                id: &first.id,
                expected: &stale,
                now: 3000,
            })
            .is_err()
    );
    assert_eq!(
        service
            .get(&first.scope_id, &first.kind, &first.id)
            .unwrap(),
        before
    );
    let expected = project_artifact::MutationExpectation {
        expected_revision: before.artifact.revision,
        expected_version_id: before.current_version.id.clone(),
        expected_digest: before.current_version.content_digest.clone(),
    };
    service
        .disable(artifact::LifecycleInput {
            scope_id: &first.scope_id,
            kind: &first.kind,
            id: &first.id,
            expected: &expected,
            now: 3001,
        })
        .unwrap();
    assert_eq!(
        service
            .get(&first.scope_id, &first.kind, &first.id)
            .unwrap()
            .artifact
            .stage
            .encode(),
        JsonValue::String("disabled".into())
    );
    reopened.shutdown().unwrap();
}
