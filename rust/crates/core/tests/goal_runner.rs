#[path = "session_flow_support/mod.rs"]
#[allow(dead_code)]
mod session_flow_support;

use session_flow_support::{
    REJECTED, Reply, Root, TEXT, TOOL, admit, file_store, held_echo, local_clock, record, registry,
    server, server_replies, server_status, session_tools_registry, tool_reply, world,
};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};
use ycoding_core::session::{autonomy, run_coordinator::Coordinator, store::Service};
use ycoding_schema::{parse_json, session};
use ycoding_store::session as store_session;

struct GoalClock {
    time: tokio::sync::watch::Sender<i64>,
    sleeps: mpsc::UnboundedSender<i64>,
}
impl GoalClock {
    fn new() -> (Arc<Self>, mpsc::UnboundedReceiver<i64>) {
        let (time, _) = tokio::sync::watch::channel(1);
        let (sleeps, receiver) = mpsc::unbounded_channel();
        (Arc::new(Self { time, sleeps }), receiver)
    }
    fn advance(&self, millis: i64) {
        self.time.send_modify(|time| *time += millis);
    }
}
impl ycoding_core::session::runner::Clock for GoalClock {
    fn now(&self) -> i64 {
        *self.time.borrow()
    }
    fn sleep(
        &self,
        millis: u64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        let deadline = self.now() + millis as i64;
        let mut time = self.time.subscribe();
        self.sleeps.send(deadline).unwrap();
        Box::pin(async move {
            time.wait_for(|time| *time >= deadline).await.unwrap();
        })
    }
}
async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(std::time::Duration::from_secs(20), future)
        .await
        .unwrap()
}
fn goal_id() -> session::Id {
    session::Id::new("ses_one").unwrap()
}
fn goal_state(service: &autonomy::Service) -> autonomy::Goal {
    service.get(&goal_id()).unwrap().goal.unwrap()
}

#[tokio::test]
async fn stalled_tool_is_cancelled_while_parallel_sibling_and_matching_retry_complete() {
    bounded(async {
        let root = Root::new();
        let store = file_store(&root);
        let sessions = Service::new(store.client());
        let autonomy = autonomy::Service::new(store.client());
        autonomy.set_goal(&goal_id(), autonomy::Goal::new("Ship the change", None, None)).await.unwrap();
        let tools = session_tools_registry(&store.client());
        let (started, mut starts) = mpsc::unbounded_channel();
        let (ended, mut ends) = mpsc::unbounded_channel();
        let registration = tools.register(vec![("hang".into(), Arc::new(ycoding_core::tools::registry::DynamicTool::new("Wait until cancelled", parse_json(r#"{"type":"object"}"#).unwrap(), None, None, move |input, context| {
            let started = started.clone();
            let ended = ended.clone();
            Box::pin(async move {
                if ycoding_schema::stringify_json(&input).contains("release") { return Ok(ycoding_ai::llm::ToolOutput { structured: input, content: Vec::new() }); }
                struct End(mpsc::UnboundedSender<()>);
                impl Drop for End { fn drop(&mut self) { self.0.send(()).unwrap(); } }
                let _end = End(ended);
                started.send(()).unwrap();
                context.cancellation.cancelled().await;
                Err(ycoding_core::tools::registry::Failure::Cancelled)
            })
        }))), ("echo".into(), Arc::new(ycoding_core::tools::registry::DynamicTool::new("Complete independently", parse_json(r#"{"type":"object"}"#).unwrap(), None, None, |input, _| Box::pin(async move { Ok(ycoding_ai::llm::ToolOutput { structured: input, content: Vec::new() }) }))))], ycoding_core::tools::registry::Options::direct()).unwrap();
        let parallel = "data: {\"id\":\"parallel\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_hang\",\"type\":\"function\",\"function\":{\"name\":\"hang\",\"arguments\":\"{}\"}},{\"index\":1,\"id\":\"call_echo\",\"type\":\"function\",\"function\":{\"name\":\"echo\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\ndata: {\"id\":\"parallel\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n";
        let (endpoint, mut requests, server) = server(vec![parallel, tool_reply("goal", r#"{"action":"complete"}"#), tool_reply("hang", r#"{"label":"release"}"#), tool_reply("goal", r#"{"action":"complete"}"#), TEXT]).await;
        let (clock, _sleeps) = GoalClock::new();
        let coordinator = Coordinator::new(Arc::new(local_clock(&store, &endpoint, tools, clock.clone())));
        admit(&sessions, "ses_one", "start", "Ship it", "steer").await;
        let run = { let coordinator = coordinator.clone(); tokio::spawn(async move { coordinator.run(&goal_id()).await }) };
        starts.recv().await.unwrap();
        loop {
            let messages = ycoding_schema::stringify_json(&ycoding_schema::DomainEncode::encode(&sessions.context(&goal_id()).unwrap()));
            if messages.contains("call_echo") && messages.contains("completed") { break; }
            tokio::task::yield_now().await;
        }
        clock.advance(601_000);
        run.await.unwrap().unwrap();
        ends.recv().await.unwrap();
        let messages = ycoding_schema::stringify_json(&ycoding_schema::DomainEncode::encode(&sessions.context(&goal_id()).unwrap()));
        assert!(messages.contains("tool.stalled:tool/hang"), "{messages}");
        assert!(messages.contains("its effects are unknown"));
        assert!(messages.contains("Goal completed"));
        let goal = goal_state(&autonomy);
        assert_eq!((goal.status, goal.stalls, goal.no_progress), (autonomy::GoalStatus::Completed, Some(1), 0));
        assert!(goal.failure.is_none());
        let mut count = 0;
        while requests.recv().await.is_some() { count += 1; }
        assert_eq!(count, 5);
        coordinator.shutdown().await.unwrap();
        server.await.unwrap();
        drop(registration);
    }).await;
}

#[tokio::test]
async fn silent_provider_stream_retries_as_a_read_failure_and_clean_step_clears_failure() {
    bounded(async {
        let root = Root::new();
        let store = file_store(&root);
        let sessions = Service::new(store.client());
        let autonomy = autonomy::Service::new(store.client());
        autonomy
            .set_goal(&goal_id(), autonomy::Goal::new("Ship it", None, None))
            .await
            .unwrap();
        let (release, gate) = oneshot::channel();
        let (endpoint, mut requests, server) =
            server_replies(vec![Reply::Held(gate, TEXT), Reply::Status(200, TEXT)]).await;
        let (clock, mut sleeps) = GoalClock::new();
        let coordinator = Coordinator::new(Arc::new(local_clock(
            &store,
            &endpoint,
            registry(),
            clock.clone(),
        )));
        admit(&sessions, "ses_one", "start", "Ship it", "steer").await;
        let run = {
            let coordinator = coordinator.clone();
            tokio::spawn(async move { coordinator.run(&goal_id()).await })
        };
        requests.recv().await.unwrap();
        clock.advance(601_000);
        loop {
            if sleeps.recv().await.unwrap() > 601_001 {
                break;
            }
        }
        assert_eq!(goal_state(&autonomy).stalls, Some(1));
        release.send(()).unwrap();
        clock.advance(2_001);
        requests.recv().await.unwrap();
        run.await.unwrap().unwrap();
        let goal = goal_state(&autonomy);
        assert_eq!(
            (goal.stalls, goal.no_progress, goal.status),
            (Some(1), 0, autonomy::GoalStatus::Active)
        );
        assert!(goal.failure.is_none());
        coordinator.shutdown().await.unwrap();
        server.await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn waiting_child_and_tool_progress_reset_the_stall_clock_without_owner_failure() {
    bounded(async {
        let root = Root::new();
        let store = file_store(&root);
        let sessions = Service::new(store.client());
        let parent = goal_id();
        let launch = ycoding_core::session::orchestration::Launch::new(&parent, &ycoding_schema::session_message::Id::new("msg_parent").unwrap(), "goal-wait-child");
        let child = launch.child_id;
        let mut row = record(child.as_lossless().as_str().unwrap());
        row.parent_id = Some(parent.as_lossless().clone());
        store.submit(move |tx| store_session::SessionTable::insert(tx, &row)).unwrap().wait().unwrap();
        for (index, change) in [format!(r#"{{"type":"launched","parentID":"ses_one","parentAssistantMessageID":"msg_parent","toolCallID":"goal-wait-child","inputID":"{}","description":"child","agent":"build","model":{{"providerID":"test","id":"test"}},"promptDigest":"digest","background":true,"delivery":"steer"}}"#, launch.input_id.as_lossless().as_str().unwrap()), r#"{"type":"started"}"#.into()].into_iter().enumerate() {
            sessions.publish(store_session::NewEvent { id: format!("evt_goal_wait_{index}").into(), aggregate_id: child.as_lossless().clone(), created: 20, type_: "session.task.updated.1".into(), data: parse_json(&format!(r#"{{"sessionID":"{}","change":{change}}}"#, child.as_lossless().as_str().unwrap())).unwrap() }).await.unwrap();
        }
        let autonomy = autonomy::Service::new(store.client());
        autonomy
            .set_goal(&parent, autonomy::Goal::new("Ship it", None, None))
            .await
            .unwrap();
        let tools = session_tools_registry(&store.client());
        let goal_tools = tools.materialize(&[]);
        let (started, mut starts) = mpsc::unbounded_channel();
        let (progress, receive_progress) = oneshot::channel();
        let receive_progress = Arc::new(tokio::sync::Mutex::new(Some(receive_progress)));
        let (progressed, mut observed_progress) = mpsc::unbounded_channel();
        let registration = tools
            .register(
                vec![(
                    "echo".into(),
                    Arc::new(ycoding_core::tools::registry::DynamicTool::new(
                        "Wait and report progress",
                        parse_json(r#"{"type":"object"}"#).unwrap(),
                        None,
                        None,
                        move |_, context| {
                            let started = started.clone();
                            let progress = receive_progress.clone();
                            let progressed = progressed.clone();
                            Box::pin(async move {
                                started.send(()).unwrap();
                                progress.lock().await.take().unwrap().await.unwrap();
                                context
                                    .report(ycoding_core::tools::context::Progress {
                                        structured: Default::default(),
                                        content: Vec::new(),
                                    })
                                    .await;
                                progressed.send(()).unwrap();
                                context.cancellation.cancelled().await;
                                Err(ycoding_core::tools::registry::Failure::Cancelled)
                            })
                        },
                    )),
                )],
                ycoding_core::tools::registry::Options::direct(),
            )
            .unwrap();
        let (endpoint, _requests, server) = server(vec![TOOL, TEXT]).await;
        let (clock, mut sleeps) = GoalClock::new();
        let local = local_clock(&store, &endpoint, tools, clock.clone());
        let coordinator = Coordinator::new(Arc::new(local));
        admit(
            &sessions,
            child.as_lossless().as_str().unwrap(),
            "start",
            "Child work",
            "steer",
        )
        .await;
        let run = {
            let coordinator = coordinator.clone();
            let child = child.clone();
            tokio::spawn(async move { coordinator.run(&child).await })
        };
        starts.recv().await.unwrap();
        let set_task = |state: &str| {
            let state = state.to_owned();
            let child = child.clone();
            store
                .submit(move |tx| {
                    let key = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(
                        child.as_lossless(),
                    )]);
                    let mut task = tx.get::<store_session::TaskTable>(&key)?.unwrap();
                    task.state = state.into();
                    store_session::TaskTable::put(tx, &task)
                })
                .unwrap()
                .wait()
                .unwrap();
        };
        set_task("waiting");
        clock.advance(601_000);
        loop {
            if sleeps.recv().await.unwrap() > 601_001 {
                break;
            }
        }
        assert!(
            autonomy
                .get(&parent)
                .unwrap()
                .goal
                .unwrap()
                .stalls
                .is_none()
        );
        set_task("running");
        clock.advance(300_000);
        progress.send(()).unwrap();
        observed_progress.recv().await.unwrap();
        clock.advance(400_000);
        loop {
            if sleeps.recv().await.unwrap() > 1_301_001 {
                break;
            }
        }
        assert!(
            autonomy
                .get(&parent)
                .unwrap()
                .goal
                .unwrap()
                .stalls
                .is_none()
        );
        clock.advance(201_000);
        run.await.unwrap().unwrap();
        let goal = autonomy.get(&parent).unwrap().goal.unwrap();
        assert_eq!((goal.stalls, goal.no_progress), (Some(1), 0));
        assert!(goal.failure.is_none());
        goal_tools.invoke(
            "goal",
            parse_json(r#"{"action":"complete"}"#).unwrap(),
            ycoding_core::tools::context::Context::new(
                parent.as_lossless().as_str().unwrap(),
                "build",
                "msg_owner",
                "call_goal",
            )
            .unwrap(),
        )
        .await
        .unwrap();
        coordinator.shutdown().await.unwrap();
        server.await.unwrap();
        drop(registration);
    })
    .await;
}

#[tokio::test]
async fn execution_admits_one_recovery_then_waits_and_renews_only_after_user_input_changes() {
    bounded(async {
        let world = world();
        let id = world.seed("ses_goal_recovery", "/goal-recovery");
        let autonomy = autonomy::Service::new(world.client.clone());
        autonomy
            .set_goal(&id, autonomy::Goal::new("Ship it", None, None))
            .await
            .unwrap();
        let (endpoint, mut requests, server) = server_status(vec![(400, REJECTED); 4]).await;
        world.place("/goal-recovery", &endpoint, registry());
        admit(
            &world.sessions,
            "ses_goal_recovery",
            "first",
            "Ship it",
            "steer",
        )
        .await;
        assert!(world.execution.resume(&id).await.is_err());
        world.execution.await_idle(&id).await;
        for _ in 0..2 {
            requests.recv().await.unwrap();
        }
        assert!(requests.try_recv().is_err());
        let first = autonomy.get(&id).unwrap().goal.unwrap();
        assert_eq!(
            (
                first.phase(),
                first.rework,
                first.iteration,
                first.no_progress
            ),
            (autonomy::GoalPhase::Stalled, Some(1), 0, 0)
        );
        assert_eq!(first.failure.unwrap().count, 2);
        assert_eq!(
            world
                .steers
                .requests
                .lock()
                .unwrap()
                .get(&id)
                .unwrap()
                .len(),
            1
        );
        admit(
            &world.sessions,
            "ses_goal_recovery",
            "second",
            "Try the current state",
            "steer",
        )
        .await;
        assert!(world.execution.resume(&id).await.is_err());
        world.execution.await_idle(&id).await;
        let second = autonomy.get(&id).unwrap().goal.unwrap();
        assert_eq!(
            (second.phase(), second.rework, second.no_progress),
            (autonomy::GoalPhase::Stalled, Some(2), 0)
        );
        assert_eq!(
            world
                .steers
                .requests
                .lock()
                .unwrap()
                .get(&id)
                .unwrap()
                .len(),
            2
        );
        server.await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn standalone_tools_keep_their_normal_cancellation_lifetime_without_goal_watchdogs() {
    bounded(async {
        let root = Root::new();
        let store = file_store(&root);
        let sessions = Service::new(store.client());
        store
            .submit(|tx| {
                let key =
                    ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&"ses_one".into())]);
                let mut row = tx.get::<store_session::SessionTable>(&key)?.unwrap();
                row.scope = "standalone".into();
                store_session::SessionTable::put(tx, &row)
            })
            .unwrap()
            .wait()
            .unwrap();
        let autonomy = autonomy::Service::new(store.client());
        autonomy
            .set_goal(&goal_id(), autonomy::Goal::new("Ship it", None, None))
            .await
            .unwrap();
        let (started, mut starts) = mpsc::unbounded_channel();
        let (ended, mut ends) = mpsc::unbounded_channel();
        let (tools, _registration) = held_echo(started, ended);
        let (endpoint, _requests, server) = server(vec![TOOL]).await;
        let (clock, mut sleeps) = GoalClock::new();
        let coordinator = Coordinator::new(Arc::new(local_clock(
            &store,
            &endpoint,
            tools,
            clock.clone(),
        )));
        admit(&sessions, "ses_one", "start", "Work", "steer").await;
        let run = {
            let coordinator = coordinator.clone();
            tokio::spawn(async move { coordinator.run(&goal_id()).await })
        };
        starts.recv().await.unwrap();
        clock.advance(1_200_000);
        assert!(sleeps.try_recv().is_err());
        assert!(goal_state(&autonomy).stalls.is_none());
        coordinator
            .interrupt(
                &goal_id(),
                ycoding_core::session::run_coordinator::InterruptReason::User,
            )
            .await
            .unwrap();
        assert!(run.await.unwrap().is_err());
        ends.recv().await.unwrap();
        coordinator.shutdown().await.unwrap();
        server.await.unwrap();
    })
    .await;
}
