use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::Semaphore;
use ycoding_core::{
    coordination::{
        self, Admission, Service as Coordination,
        runtime::{
            AssignInput, DecisionEscalateInput, DecisionEscalateResult, DecisionResult, Decisions,
            Delegation, EvaluateInput, Future, HANDLED_EVENTS, INACTIVE_MESSAGE, Options, Pending,
            PendingInput, RequestDetail, Runtime, SendInput,
        },
    },
    event_feed::{Feed, Scope, Subscriber},
    job,
    session::{
        execution::{Execution, Locations, Runner},
        pending::Request,
        run_coordinator::{DrainRequest, Error, RunFuture},
        store::Service,
    },
    tools::{builtin::project::Project, context::Context, registry::Tool},
};
use ycoding_schema::{
    JsonValue, coordination as c, parse_json, session, session_delivery::Delivery, session_error,
    session_message, session_pending,
};
use ycoding_store::{
    KeyPart, Metadata, Options as StoreOptions, Store, native,
    session::{NewEvent, SessionTable},
    tuple_key,
};

#[path = "session_support/record.rs"]
mod support;

const STARTUP: [&str; 9] = [
    "ses_boot",
    "ses_window",
    "ses_other",
    "ses_unknown",
    "ses_mixed",
    "ses_archived",
    "ses_suspended",
    "ses_decided",
    "ses_stale",
];

async fn startup(runtime: &Runtime) {
    runtime.recover().await.unwrap();
    runtime.resume_admitted().await.unwrap();
}

const BOUND: Duration = Duration::from_secs(10);

fn id(text: &str) -> session::Id {
    session::Id::new(text).unwrap()
}

fn message(text: &str) -> session_message::Id {
    session_message::Id::new(text).unwrap()
}

async fn quiesce(execution: &Execution, session: &session::Id) {
    tokio::time::timeout(BOUND, execution.await_idle(session))
        .await
        .expect("Session execution settles");
}

#[derive(Default)]
struct Waits(Mutex<Vec<Pending>>);

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

fn permission_wait() -> Pending {
    Pending {
        summary: c::PendingRequest {
            kind: c::RequestKind::Permission,
            request_id: "per_gate".into(),
            fingerprint: "fp_gate".into(),
            summary: "Synthetic pending permission".into(),
            request_session_id: None,
        },
        detail: RequestDetail::Permission {
            request_id: "per_gate".into(),
            fingerprint: "fp_gate".into(),
            action: "shell".into(),
            resources: vec!["true".into()],
            delegation: Delegation::Routine,
            coordination_escalation: None,
            request_session_id: None,
        },
    }
}

struct Script {
    drains: Mutex<BTreeMap<String, usize>>,
    failing: Mutex<BTreeSet<String>>,
    blocking: Mutex<BTreeSet<String>>,
    member_started: Semaphore,
    release: Semaphore,
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
    async fn wait_for_member_start(&self) {
        tokio::time::timeout(BOUND, self.member_started.acquire())
            .await
            .expect("Project member reaches the runner")
            .unwrap()
            .forget();
    }
    fn drains(&self, session: &str) -> usize {
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

fn trace(sessions: &Service, session: &session::Id) -> Vec<String> {
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

fn notices(sessions: &Service, receiver: &session::Id) -> Vec<String> {
    sessions
        .log(receiver, None, 200)
        .unwrap()
        .events
        .into_iter()
        .filter(|entry| entry.event.0.event_type.as_str() == Some("session.input.admitted"))
        .filter_map(|entry| {
            let JsonValue::Object(input) = entry.event.0.data.0.get(&"input".into())? else {
                return None;
            };
            let JsonValue::Object(data) = input.get(&"data".into())? else {
                return None;
            };
            let JsonValue::Object(metadata) = data.get(&"metadata".into())? else {
                return None;
            };
            if metadata.get(&"memberSessionID".into())
                != Some(&JsonValue::String("ses_alpha".into()))
            {
                return None;
            }
            let JsonValue::String(event) = metadata.get(&"event".into())? else {
                return None;
            };
            Some(event.to_utf8().unwrap())
        })
        .collect()
}

async fn pump(runtime: &Runtime, subscriber: &Subscriber) {
    while let Some(item) = subscriber.next().unwrap() {
        runtime.handle(&item.payload).await.unwrap();
    }
}

fn send(text: &str, message_id: &str) -> SendInput {
    send_to("ses_alpha", text, message_id)
}

fn send_to(member: &str, text: &str, message_id: &str) -> SendInput {
    SendInput {
        session_id: id(member),
        text: text.into(),
        delivery: Some(Delivery::Queue),
        message_id: Some(message(message_id)),
        model: None,
    }
}

fn ledger(sessions: &Service, session: &session::Id) -> Vec<String> {
    let text = |value: Option<&JsonValue>| match value {
        Some(JsonValue::String(text)) => text.to_utf8().unwrap(),
        _ => String::new(),
    };
    sessions
        .log(session, None, 200)
        .unwrap()
        .events
        .into_iter()
        .filter_map(|entry| {
            let data = &entry.event.0.data.0;
            Some(match entry.event.0.event_type.to_utf8().unwrap().as_str() {
                "session.input.admitted" => {
                    format!("admitted:{}", text(data.get(&"inputID".into())))
                }
                "session.input.promoted" => {
                    format!("promoted:{}", text(data.get(&"inputID".into())))
                }
                "session.input.consumed" => match data.get(&"inputIDs".into()) {
                    Some(JsonValue::Array(ids)) => format!(
                        "consumed:{}",
                        ids.iter()
                            .map(|id| text(Some(id)))
                            .collect::<Vec<_>>()
                            .join(",")
                    ),
                    _ => "consumed:".into(),
                },
                "session.execution.started" => "started".into(),
                "session.execution.succeeded" => "succeeded".into(),
                "session.execution.interrupted" => "interrupted".into(),
                "session.execution.failed" => match data.get(&"error".into()) {
                    Some(JsonValue::Object(error)) => {
                        format!("failed:{}", text(error.get(&"type".into())))
                    }
                    _ => "failed".into(),
                },
                "session.step.started" => "step".into(),
                _ => return None,
            })
        })
        .collect()
}

async fn admit(
    execution: &Execution,
    group: &c::GroupId,
    member: &session::Id,
    input: &str,
    text: &str,
) {
    let master = id("ses_master");
    execution
        .prompt_coordination(
            Request {
                id: message(input),
                session_id: member.clone(),
                input: session_pending::Message::User(session_pending::UserMessage {
                    delivery: Delivery::Queue,
                    data: session_pending::UserData {
                        text: text.into(),
                        files: None,
                        agents: None,
                        metadata: None,
                    },
                }),
                event_id: ycoding_schema::event::Id::new(format!("evt_{input}")).unwrap(),
                created: 1,
            },
            Some(false),
            Admission {
                group_id: group.clone(),
                master_session_id: master.clone(),
                sender_session_id: master,
                message_id: message(input),
                model: None,
            },
        )
        .await
        .unwrap();
}

async fn publish(sessions: &Service, member: &session::Id, name: &str, kind: &str, fields: &str) {
    let member_text = member.as_lossless().to_utf8().unwrap();
    let body = if fields.is_empty() {
        format!(r#"{{"sessionID":"{member_text}"}}"#)
    } else {
        format!(r#"{{"sessionID":"{member_text}",{fields}}}"#)
    };
    sessions
        .publish(NewEvent {
            id: name.into(),
            aggregate_id: member.as_lossless().clone(),
            created: 2,
            type_: kind.into(),
            data: parse_json(&body).unwrap(),
        })
        .await
        .unwrap();
}

fn check(failures: &mut Vec<String>, condition: bool, message: String) {
    if !condition {
        failures.push(message);
    }
}

async fn state(runtime: &Runtime, master: &session::Id) -> c::MemberState {
    runtime
        .roster(master)
        .await
        .unwrap()
        .members
        .into_iter()
        .find(|member| member.session_id == id("ses_alpha"))
        .unwrap()
        .state
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn admitted_project_input_reaches_execution_through_pause_gate_restart_and_settlement() {
    let store = Store::disposable(
        StoreOptions::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([9; 16], 1),
    )
    .unwrap();
    let client = store.client();
    client
        .submit(|tx| {
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
            for name in ["ses_master", "ses_alpha"].into_iter().chain(STARTUP) {
                SessionTable::insert(tx, &support::record(name))?;
            }
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
    let feed = Feed::attach(&client);
    let subscriber = feed
        .subscribe_types(Scope::Global, HANDLED_EVENTS, || {})
        .unwrap();
    let coordination = Coordination::new(client.clone(), feed.clone());
    let master = id("ses_master");
    let alpha = id("ses_alpha");
    let group = coordination
        .create(c::CreateInput {
            name: "Admission".into(),
            master_session_id: master.clone(),
            member_session_ids: ["ses_alpha"].into_iter().chain(STARTUP).map(id).collect(),
        })
        .await
        .unwrap();
    coordination.activate(&group.id).unwrap();
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
    let waits = Arc::new(Waits::default());
    let options = || Options {
        coordination: coordination.clone(),
        sessions: sessions.clone(),
        execution,
        decisions: Arc::new(Gates(waits.clone())),
        jobs: jobs.clone(),
        validate_model: Arc::new(|_, _| Box::pin(async { Ok(()) })),
        model_services: Arc::new(|_| {
            Box::pin(async { Err(coordination::Error::refused("outside this fixture")) })
        }),
        creator: None,
    };
    let runtime = Runtime::new(options());
    runtime
        .assign(
            &master,
            AssignInput {
                session_id: alpha.clone(),
                owner_session_id: master.clone(),
            },
        )
        .await
        .unwrap();

    coordination.pause(&group.id).unwrap();
    let paused = runtime.send(&master, send("Paused", "msg_paused")).await;
    assert_eq!(
        paused.err().map(|error| error.to_string()).as_deref(),
        Some(INACTIVE_MESSAGE)
    );
    quiesce(execution, &alpha).await;
    coordination.activate(&group.id).unwrap();
    *waits.0.lock().unwrap() = vec![permission_wait()];
    let gated = runtime.send(&master, send("Gated", "msg_gated")).await;
    assert!(gated.unwrap_err().to_string().contains("per_gate"));
    quiesce(execution, &alpha).await;
    *waits.0.lock().unwrap() = vec![];
    for refused in ["msg_paused", "msg_gated"] {
        assert!(sessions.pending(&message(refused)).unwrap().is_none());
        assert!(sessions.message(&message(refused)).unwrap().is_none());
    }
    assert!(
        trace(&sessions, &alpha).is_empty(),
        "no admission, no start"
    );
    assert_eq!(script.drains("ses_alpha"), 0);

    let ready = message("msg_ready");
    admit(execution, &group.id, &alpha, "msg_ready", "Ready work").await;
    pump(&runtime, &subscriber).await;
    assert_eq!(trace(&sessions, &alpha), ["admitted:msg_ready"]);
    assert!(sessions.pending(&ready).unwrap().is_some());

    let mut failures = Vec::new();
    let [
        boot,
        window,
        other,
        unknown,
        mixed,
        archived,
        suspended,
        decided,
        stale,
    ] = STARTUP.map(id);
    publish(
        &sessions,
        &stale,
        "evt_stale_started",
        "session.execution.started.1",
        "",
    )
    .await;
    publish(
        &sessions,
        &stale,
        "evt_stale_step",
        "session.step.started.1",
        r#""assistantMessageID":"msg_stale_assistant","agent":"build","model":{"providerID":"test","id":"test"}"#,
    )
    .await;
    publish(
        &sessions,
        &stale,
        "evt_stale_tool_input",
        "session.tool.input.started.1",
        r#""assistantMessageID":"msg_stale_assistant","callID":"call_stale","name":"shell""#,
    )
    .await;
    publish(
        &sessions,
        &stale,
        "evt_stale_tool_called",
        "session.tool.called.1",
        r#""assistantMessageID":"msg_stale_assistant","callID":"call_stale","input":{},"executed":true"#,
    )
    .await;
    sessions.reconcile_interrupted(4).await.unwrap();
    admit(execution, &group.id, &stale, "msg_stale", "Work msg_stale").await;
    check(
        &mut failures,
        ledger(&sessions, &stale)
            == [
                "started",
                "step",
                "failed:interrupted",
                "admitted:msg_stale",
            ],
        format!(
            "earlier unknown-effect attempt fixture: {:?}",
            ledger(&sessions, &stale)
        ),
    );
    admit(execution, &group.id, &boot, "msg_boot", "Work msg_boot").await;
    admit(
        execution,
        &group.id,
        &window,
        "msg_window",
        "Work msg_window",
    )
    .await;
    publish(
        &sessions,
        &window,
        "evt_window_started",
        "session.execution.started.1",
        "",
    )
    .await;
    admit(execution, &group.id, &other, "msg_other", "Work msg_other").await;
    publish(
        &sessions,
        &other,
        "evt_other_started",
        "session.execution.started.1",
        "",
    )
    .await;
    publish(
        &sessions,
        &other,
        "evt_other_succeeded",
        "session.execution.succeeded.1",
        "",
    )
    .await;
    admit(
        execution,
        &group.id,
        &unknown,
        "msg_unknown_first",
        "Work msg_unknown_first",
    )
    .await;
    admit(
        execution,
        &group.id,
        &unknown,
        "msg_unknown_next",
        "Work msg_unknown_next",
    )
    .await;
    publish(
        &sessions,
        &unknown,
        "evt_unknown_started",
        "session.execution.started.1",
        "",
    )
    .await;
    sessions
        .promote_input(&unknown, &"msg_unknown_first".into(), 3)
        .await
        .unwrap();
    publish(
        &sessions,
        &unknown,
        "evt_unknown_step",
        "session.step.started.1",
        r#""assistantMessageID":"msg_unknown_assistant","agent":"build","model":{"providerID":"test","id":"test"}"#,
    )
    .await;
    admit(execution, &group.id, &mixed, "msg_mixed", "Work msg_mixed").await;
    execution
        .prompt(
            Request {
                id: message("msg_mixed_human"),
                session_id: mixed.clone(),
                input: session_pending::Message::User(session_pending::UserMessage {
                    delivery: Delivery::Queue,
                    data: session_pending::UserData {
                        text: "Direct human work".into(),
                        files: None,
                        agents: None,
                        metadata: None,
                    },
                }),
                event_id: ycoding_schema::event::Id::new("evt_mixed_human").unwrap(),
                created: 1,
            },
            Some(false),
        )
        .await
        .unwrap();
    admit(
        execution,
        &group.id,
        &archived,
        "msg_archived",
        "Work msg_archived",
    )
    .await;
    admit(
        execution,
        &group.id,
        &suspended,
        "msg_suspended",
        "Work msg_suspended",
    )
    .await;
    client
        .submit(|tx| {
            for (name, archived) in [("ses_archived", true), ("ses_suspended", false)] {
                let mut row = tx
                    .get::<SessionTable>(&tuple_key(&[KeyPart::String(&name.into())]))?
                    .unwrap();
                if archived {
                    row.time_archived = Some(5);
                } else {
                    row.time_suspended = Some(5);
                }
                tx.put::<SessionTable>(&row)?;
            }
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
    admit(
        execution,
        &group.id,
        &decided,
        "msg_decided",
        "Work msg_decided",
    )
    .await;
    publish(
        &sessions,
        &decided,
        "evt_decided_review",
        "session.review.deferred.1",
        r#""itemID":"rvw_decided","kind":"permission","reason":"defer_entry","origin":{"requestID":"per_decided"},"payload":{"type":"permission","action":"edit","resources":["src/a.rs"],"fingerprint":"0000000000000000000000000000000000000000000000000000000000000000","fingerprintVersion":2,"requestID":"per_decided"}"#,
    )
    .await;
    sessions.reconcile_interrupted(10).await.unwrap();
    let crashed = |session: &session::Id| ledger(&sessions, session);
    check(
        &mut failures,
        crashed(&window) == ["admitted:msg_window", "started", "failed:interrupted"]
            && crashed(&unknown)
                == [
                    "admitted:msg_unknown_first",
                    "admitted:msg_unknown_next",
                    "started",
                    "promoted:msg_unknown_first",
                    "step",
                    "failed:interrupted",
                ],
        format!(
            "restart reconciliation fixture: {:?} {:?}",
            crashed(&window),
            crashed(&unknown)
        ),
    );
    let members = ["ses_alpha"]
        .into_iter()
        .chain(STARTUP)
        .map(id)
        .collect::<Vec<_>>();
    let idle = async |execution: &Execution| {
        for member in &members {
            quiesce(execution, member).await;
        }
    };

    let restarted = Runtime::new(options());
    restarted.recover().await.unwrap();
    pump(&restarted, &subscriber).await;
    idle(execution).await;
    for member in &members {
        let name = member.as_lossless().to_utf8().unwrap();
        check(
            &mut failures,
            script.drains(&name) == 0,
            format!("notice rehydration through recover must not start {name}"),
        );
    }
    assert_eq!(state(&restarted, &master).await, c::MemberState::Idle);

    coordination.pause(&group.id).unwrap();
    startup(&restarted).await;
    idle(execution).await;
    for member in &members {
        let name = member.as_lossless().to_utf8().unwrap();
        check(
            &mut failures,
            script.drains(&name) == 0,
            format!("startup in a paused Project must not start {name}"),
        );
    }
    let retried = restarted
        .send(&master, send("Ready work", "msg_ready"))
        .await
        .unwrap();
    assert!(retried.reconciled);
    quiesce(execution, &alpha).await;
    assert_eq!(
        trace(&sessions, &alpha),
        ["admitted:msg_ready"],
        "a retry while the Project is paused starts nothing"
    );
    *waits.0.lock().unwrap() = vec![permission_wait()];
    coordination.activate(&group.id).unwrap();
    let retried = restarted
        .send(&master, send("Ready work", "msg_ready"))
        .await
        .unwrap();
    assert!(retried.reconciled);
    quiesce(execution, &alpha).await;
    assert_eq!(
        trace(&sessions, &alpha),
        ["admitted:msg_ready"],
        "a retry while a member decision is pending starts nothing"
    );
    assert!(sessions.pending(&ready).unwrap().is_some());

    let retried = restarted
        .send(&master, send_to("ses_other", "Work msg_other", "msg_other"))
        .await
        .unwrap();
    check(
        &mut failures,
        retried.reconciled,
        "other retry reconciles".into(),
    );
    quiesce(execution, &other).await;
    check(
        &mut failures,
        ledger(&sessions, &other)
            == [
                "admitted:msg_other",
                "started",
                "succeeded",
                "started",
                "promoted:msg_other",
                "succeeded",
            ],
        format!(
            "a different input's start must not block the exact-ID retry: {:?}",
            ledger(&sessions, &other)
        ),
    );

    startup(&restarted).await;
    idle(execution).await;
    check(
        &mut failures,
        ledger(&sessions, &boot)
            == [
                "admitted:msg_boot",
                "started",
                "promoted:msg_boot",
                "succeeded",
            ],
        format!(
            "startup must start input admitted before its wake: {:?}",
            ledger(&sessions, &boot)
        ),
    );
    check(
        &mut failures,
        ledger(&sessions, &window)
            == [
                "admitted:msg_window",
                "started",
                "failed:interrupted",
                "started",
                "promoted:msg_window",
                "succeeded",
            ],
        format!(
            "startup must start input whose run stopped before promotion: {:?}",
            ledger(&sessions, &window)
        ),
    );
    for (session, reason) in [
        (&alpha, "a pending member decision"),
        (&unknown, "an effect-unknown interrupted run"),
        (&mixed, "a mixed inbox with direct human input"),
        (&archived, "an archived Session"),
        (&suspended, "a suspended Session"),
        (&decided, "an open durable review"),
        (
            &stale,
            "an earlier unknown-effect attempt in projected history",
        ),
    ] {
        let name = session.as_lossless().to_utf8().unwrap();
        check(
            &mut failures,
            script.drains(&name) == 0,
            format!("startup must not start {name} behind {reason}"),
        );
    }
    for (member, text, input) in [
        ("ses_unknown", "Work msg_unknown_next", "msg_unknown_next"),
        ("ses_unknown", "Work msg_unknown_first", "msg_unknown_first"),
        ("ses_mixed", "Work msg_mixed", "msg_mixed"),
        ("ses_decided", "Work msg_decided", "msg_decided"),
        ("ses_suspended", "Work msg_suspended", "msg_suspended"),
        ("ses_stale", "Work msg_stale", "msg_stale"),
    ] {
        let retried = restarted.send(&master, send_to(member, text, input)).await;
        check(
            &mut failures,
            retried.as_ref().is_ok_and(|result| result.reconciled),
            format!(
                "{input}: retry reconciles, got {:?}",
                retried.map(|result| result.reconciled)
            ),
        );
    }
    startup(&restarted).await;
    idle(execution).await;
    for (name, expected) in [
        ("ses_boot", 1),
        ("ses_window", 1),
        ("ses_other", 1),
        ("ses_unknown", 0),
        ("ses_mixed", 0),
        ("ses_archived", 0),
        ("ses_suspended", 0),
        ("ses_decided", 0),
        ("ses_stale", 0),
    ] {
        check(
            &mut failures,
            script.drains(name) == expected,
            format!(
                "{name}: expected {expected} executions after repeated startup and gated retries, got {}",
                script.drains(name)
            ),
        );
    }
    check(
        &mut failures,
        [
            "msg_unknown_next",
            "msg_mixed",
            "msg_mixed_human",
            "msg_archived",
            "msg_suspended",
            "msg_decided",
            "msg_stale",
        ]
        .into_iter()
        .all(|input| sessions.pending(&message(input)).unwrap().is_some()),
        "gated inputs stay pending".into(),
    );

    *waits.0.lock().unwrap() = vec![];
    let project = Project {
        runtime: Arc::new(OnceLock::from(restarted.clone())),
    };
    let retried = project
        .settle(
            parse_json(
                r#"{"action":"send","sessionID":"ses_alpha","text":"Ready work","messageID":"msg_ready"}"#,
            )
            .unwrap(),
            Context::new("ses_master", "test", "msg_master", "call_retry").unwrap(),
        )
        .await
        .unwrap();
    let JsonValue::Object(result) = retried.structured else {
        panic!("expected Project send result");
    };
    assert_eq!(
        result.get(&"reconciled".into()),
        Some(&JsonValue::Bool(true))
    );
    assert_eq!(
        result.get(&"messageID".into()),
        Some(&JsonValue::String("msg_ready".into()))
    );
    script.wait_for_member_start().await;
    quiesce(execution, &alpha).await;
    assert_eq!(script.drains("ses_alpha"), 1);
    assert!(sessions.pending(&ready).unwrap().is_none());
    assert!(sessions.message(&ready).unwrap().is_some());
    assert_eq!(
        trace(&sessions, &alpha),
        ["admitted:msg_ready", "started", "succeeded"],
        "the retried admission identity starts exactly one execution"
    );
    pump(&restarted, &subscriber).await;
    quiesce(execution, &master).await;
    assert_eq!(
        notices(&sessions, &master),
        ["permission", "started", "completed"]
    );

    let settled = restarted
        .send(&master, send("Ready work", "msg_ready"))
        .await
        .unwrap();
    assert!(settled.reconciled);
    quiesce(execution, &alpha).await;
    assert_eq!(
        trace(&sessions, &alpha),
        ["admitted:msg_ready", "started", "succeeded"]
    );
    assert_eq!(
        script.drains("ses_alpha"),
        1,
        "a settled admission is not replayed"
    );
    assert_eq!(state(&restarted, &master).await, c::MemberState::Idle);

    script.blocking.lock().unwrap().insert("ses_alpha".into());
    script.failing.lock().unwrap().insert("ses_alpha".into());
    let fresh = restarted
        .send(&master, send("Failing work", "msg_failing"))
        .await
        .unwrap();
    assert!(!fresh.reconciled);
    script.wait_for_member_start().await;
    assert_eq!(state(&restarted, &master).await, c::MemberState::Running);
    assert_eq!(
        trace(&sessions, &alpha)[3..],
        ["admitted:msg_failing", "started"]
    );
    script.release.add_permits(1);
    quiesce(execution, &alpha).await;
    assert_eq!(
        trace(&sessions, &alpha)[3..],
        ["admitted:msg_failing", "started", "failed"]
    );
    assert_eq!(state(&restarted, &master).await, c::MemberState::Failed);
    pump(&restarted, &subscriber).await;
    quiesce(execution, &master).await;
    assert_eq!(
        notices(&sessions, &master),
        ["permission", "started", "completed", "started", "failed"]
    );
    assert_eq!(
        script.drains("ses_alpha"),
        2,
        "a failed turn is not retried"
    );

    script.blocking.lock().unwrap().insert("ses_alpha".into());
    let held = message("msg_held");
    let fresh = restarted
        .send(&master, send("Held work", "msg_held"))
        .await
        .unwrap();
    assert!(!fresh.reconciled);
    script.wait_for_member_start().await;
    restarted
        .interrupt(
            &master,
            coordination::runtime::InterruptInput {
                session_id: alpha.clone(),
            },
        )
        .await
        .unwrap();
    quiesce(execution, &alpha).await;
    assert!(sessions.pending(&held).unwrap().is_some());
    let retried = restarted
        .send(&master, send("Held work", "msg_held"))
        .await
        .unwrap();
    assert!(retried.reconciled);
    quiesce(execution, &alpha).await;
    assert_eq!(
        script.drains("ses_alpha"),
        3,
        "a retry does not restart input whose execution started and was interrupted"
    );
    assert_eq!(
        trace(&sessions, &alpha)[6..],
        ["admitted:msg_held", "started", "interrupted"]
    );
    startup(&restarted).await;
    quiesce(execution, &alpha).await;
    check(
        &mut failures,
        script.drains("ses_alpha") == 3,
        "startup must not resume explicitly interrupted unpromoted input".into(),
    );
    execution.shutdown().await.unwrap();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
