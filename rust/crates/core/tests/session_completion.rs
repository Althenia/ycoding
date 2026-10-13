use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::oneshot;
use ycoding_core::{
    job,
    session::{
        completion::{Active, Completion, Page, Receipt},
        store::Service,
    },
};
use ycoding_schema::{JsonValue, model, parse_json, session};
use ycoding_store::{
    Client, Store,
    session::{
        Document, EventTable, NewEvent, Notification, NotificationTable, Pending, PendingTable,
        SessionTable, Task, TaskTable, append,
    },
};

#[path = "session_support/mod.rs"]
mod support;

static EVENTS: AtomicUsize = AtomicUsize::new(0);

struct Exchange<'a> {
    declaration: bool,
    text: &'a str,
    finish: &'a str,
    phase: Option<&'a str>,
    executed: bool,
    failed_step: bool,
    terminal: &'a str,
    before_declaration: &'a dyn Fn(&Client),
    after_declaration: &'a dyn Fn(&Client),
}

impl Default for Exchange<'_> {
    fn default() -> Self {
        Self {
            declaration: true,
            text: "Implemented and verified.",
            finish: "stop",
            phase: None,
            executed: false,
            failed_step: false,
            terminal: "succeeded",
            before_declaration: &|_| {},
            after_declaration: &|_| {},
        }
    }
}

fn value(value: serde_json::Value) -> JsonValue {
    parse_json(&value.to_string()).unwrap()
}

fn record(store: &Client, id: &str, session: &str, type_: &str, data: serde_json::Value) {
    let (id, session, type_, data) = (
        format!("evt_{id}_{}", EVENTS.fetch_add(1, Ordering::SeqCst)),
        session.to_owned(),
        type_.to_owned(),
        value(data),
    );
    store
        .submit(move |tx| {
            append(
                tx,
                &NewEvent {
                    id: id.as_str().into(),
                    aggregate_id: session.as_str().into(),
                    created: 10,
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

fn admit(store: &Client, session: &str, input: &str) {
    record(
        store,
        "admitted",
        session,
        "session.input.admitted.1",
        json!({"sessionID": session, "inputID": input, "input": {"type": "user", "data": {"text": "Do and verify this work"}, "delivery": "steer"}}),
    );
}

fn promote(store: &Client, session: &str, input: &str) {
    record(
        store,
        "promoted",
        session,
        "session.input.promoted.1",
        json!({"sessionID": session, "inputID": input}),
    );
}

fn started(store: &Client, session: &str) {
    record(
        store,
        "started",
        session,
        "session.execution.started.1",
        json!({"sessionID": session}),
    );
}

fn step(store: &Client, session: &str, message: &str) {
    record(
        store,
        "step",
        session,
        "session.step.started.1",
        json!({"sessionID": session, "assistantMessageID": message}),
    );
}

fn exchange(store: &Client, session: &str, options: &Exchange<'_>) {
    if options.declaration {
        step(store, session, "msg_work_declaration");
        (options.before_declaration)(store);
        record(
            store,
            "input",
            session,
            "session.tool.input.started.1",
            json!({"sessionID": session, "assistantMessageID": "msg_work_declaration", "callID": "complete", "name": "task_complete"}),
        );
        record(
            store,
            "called",
            session,
            "session.tool.called.1",
            json!({"sessionID": session, "assistantMessageID": "msg_work_declaration", "callID": "complete", "input": {}, "executed": options.executed}),
        );
        record(
            store,
            "success",
            session,
            "session.tool.success.1",
            json!({"sessionID": session, "assistantMessageID": "msg_work_declaration", "callID": "complete", "structured": {"recorded": true}, "content": [], "executed": options.executed}),
        );
        (options.after_declaration)(store);
        record(
            store,
            "ended",
            session,
            "session.step.ended.1",
            json!({"sessionID": session, "assistantMessageID": "msg_work_declaration", "finish": "tool-calls"}),
        );
    }
    step(store, session, "msg_work_final");
    let mut ended = json!({"sessionID": session, "assistantMessageID": "msg_work_final", "ordinal": 0, "text": options.text});
    if let Some(phase) = options.phase {
        ended["phase"] = phase.into();
    }
    record(store, "text", session, "session.text.ended.1", ended);
    if options.failed_step {
        record(
            store,
            "failed",
            session,
            "session.step.failed.1",
            json!({"sessionID": session, "assistantMessageID": "msg_work_final", "error": {"type": "aborted", "message": "Final response interrupted"}}),
        );
    } else {
        record(
            store,
            "ended",
            session,
            "session.step.ended.1",
            json!({"sessionID": session, "assistantMessageID": "msg_work_final", "finish": options.finish}),
        );
    }
    let terminal = match options.terminal {
        "succeeded" => json!({"sessionID": session}),
        "failed" => {
            json!({"sessionID": session, "error": {"type": "unknown", "message": "run failed"}})
        }
        _ => json!({"sessionID": session, "reason": "user"}),
    };
    record(
        store,
        "terminal",
        session,
        &format!("session.execution.{}.1", options.terminal),
        terminal,
    );
}

fn settled(store: &Client, session: &str, options: &Exchange<'_>) {
    admit(store, session, "msg_work_input");
    started(store, session);
    promote(store, session, "msg_work_input");
    exchange(store, session, options);
}

fn active(ids: &[&str]) -> Active {
    let ids = ids
        .iter()
        .map(|id| session::Id::new(*id).unwrap())
        .collect::<Vec<_>>();
    Arc::new(move || ids.clone())
}

fn completion(store: &Store, jobs: &job::Jobs) -> Completion {
    Completion::new(Service::new(store.client()), jobs.clone())
}

fn receipts(store: &Store, session: &str) -> Vec<(String, i64, serde_json::Value)> {
    let snapshot = store.client().snapshot().unwrap();
    let mut rows = snapshot
        .scan::<EventTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            10_000,
        )
        .unwrap()
        .into_iter()
        .filter(|event| {
            event.aggregate_id.as_str() == Some(session)
                && event.type_.as_str() == Some("session.work.completed.1")
        })
        .map(|event| {
            (
                event.id.to_utf8().unwrap(),
                event.seq,
                serde_json::from_str(&ycoding_schema::stringify_json(&event.data)).unwrap(),
            )
        })
        .collect::<Vec<_>>();
    rows.sort_by_key(|row| row.1);
    rows
}

async fn complete(store: &Store, jobs: &job::Jobs, session: &str, running: &[&str]) {
    completion(store, jobs)
        .complete(&session::Id::new(session).unwrap(), active(running))
        .await
        .unwrap();
}

fn child(store: &Client, id: &str, parent: &str) {
    let (id, parent) = (id.to_owned(), parent.to_owned());
    store
        .submit(move |tx| {
            let mut row = support::record(&id);
            row.parent_id = Some(parent.as_str().into());
            SessionTable::insert(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
}

#[tokio::test]
async fn verified_work_is_recorded_once_after_the_declaration_and_final_response_settle() {
    let store = support::store();
    let jobs = job::Jobs::new();
    settled(&store, "ses_one", &Exchange::default());

    tokio::join!(
        complete(&store, &jobs, "ses_one", &["ses_one"]),
        complete(&store, &jobs, "ses_one", &["ses_one"]),
    );
    complete(&store, &jobs, "ses_one", &["ses_one"]).await;

    let completed = receipts(&store, "ses_one");
    assert_eq!(completed.len(), 1);
    assert!(
        completed[0].0.starts_with("evt_work_") && completed[0].0.len() == "evt_work_".len() + 24
    );
    assert_eq!(
        completed[0].2,
        json!({"sessionID": "ses_one", "inputID": "msg_work_input", "assistantMessageID": "msg_work_final"})
    );
    let snapshot = store.client().snapshot().unwrap();
    let last = |type_: &str| {
        snapshot
            .scan::<EventTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                10_000,
            )
            .unwrap()
            .into_iter()
            .filter(|event| event.type_.as_str() == Some(type_))
            .map(|event| event.seq)
            .max()
            .unwrap()
    };
    assert!(completed[0].1 > last("session.step.ended.1"));
    assert!(completed[0].1 > last("session.execution.succeeded.1"));
}

#[tokio::test]
async fn replies_without_an_explicit_final_declaration_are_not_verified_work() {
    let scenarios = [
        (
            "ordinary reply",
            Exchange {
                declaration: false,
                ..Exchange::default()
            },
        ),
        (
            "blank final reply",
            Exchange {
                text: " \n\t",
                ..Exchange::default()
            },
        ),
        (
            "commentary without final reply",
            Exchange {
                phase: Some("commentary"),
                ..Exchange::default()
            },
        ),
        (
            "truncated final reply",
            Exchange {
                finish: "length",
                ..Exchange::default()
            },
        ),
        (
            "failed final step",
            Exchange {
                failed_step: true,
                ..Exchange::default()
            },
        ),
        (
            "provider-executed declaration",
            Exchange {
                executed: true,
                ..Exchange::default()
            },
        ),
        (
            "failed execution",
            Exchange {
                terminal: "failed",
                ..Exchange::default()
            },
        ),
        (
            "interrupted execution",
            Exchange {
                terminal: "interrupted",
                ..Exchange::default()
            },
        ),
    ];
    for (name, options) in scenarios {
        let store = support::store();
        settled(&store, "ses_one", &options);
        complete(&store, &job::Jobs::new(), "ses_one", &["ses_one"]).await;
        assert_eq!(receipts(&store, "ses_one"), [], "{name}");
    }
}

#[tokio::test]
async fn work_admitted_during_or_before_the_declaring_step_requires_a_fresh_declaration() {
    let admitted_after: &dyn Fn(&Client) = &|store| admit(store, "ses_one", "msg_new_work");
    let promoted_after: &dyn Fn(&Client) = &|store| {
        admit(store, "ses_one", "msg_new_work");
        promote(store, "ses_one", "msg_new_work");
    };
    let newer_steer_first: &dyn Fn(&Client) = &|store| {
        admit(store, "ses_one", "msg_newer_steer");
        promote(store, "ses_one", "msg_newer_steer");
    };
    for (name, options) in [
        (
            "queue during the declaring step",
            Exchange {
                after_declaration: admitted_after,
                ..Exchange::default()
            },
        ),
        (
            "steer during the declaring step",
            Exchange {
                after_declaration: promoted_after,
                ..Exchange::default()
            },
        ),
        (
            "newer steer before the declaration",
            Exchange {
                before_declaration: newer_steer_first,
                ..Exchange::default()
            },
        ),
    ] {
        let store = support::store();
        settled(&store, "ses_one", &options);
        complete(&store, &job::Jobs::new(), "ses_one", &["ses_one"]).await;
        assert_eq!(receipts(&store, "ses_one"), [], "{name}");
    }
}

#[tokio::test]
async fn a_revert_committed_after_the_declaring_step_discards_the_completion_but_an_older_one_does_not()
 {
    let store = support::store();
    record(
        &store,
        "revert",
        "ses_one",
        "session.revert.committed.1",
        json!({"sessionID": "ses_one", "to": "msg_old"}),
    );
    settled(&store, "ses_one", &Exchange::default());
    complete(&store, &job::Jobs::new(), "ses_one", &["ses_one"]).await;
    assert_eq!(receipts(&store, "ses_one").len(), 1);

    let store = support::store();
    let reverted: &dyn Fn(&Client) = &|store| {
        record(
            store,
            "revert",
            "ses_one",
            "session.revert.committed.1",
            json!({"sessionID": "ses_one", "to": "msg_work_input"}),
        );
    };
    settled(
        &store,
        "ses_one",
        &Exchange {
            after_declaration: reverted,
            ..Exchange::default()
        },
    );
    complete(&store, &job::Jobs::new(), "ses_one", &["ses_one"]).await;
    assert_eq!(receipts(&store, "ses_one"), []);
}

#[tokio::test]
async fn a_change_racing_the_publication_rejects_the_completion_atomically() {
    for change in ["admission", "revert"] {
        let store = support::store();
        settled(&store, "ses_one", &Exchange::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let racing: Active = {
            let (store, calls) = (store.clone(), calls.clone());
            Arc::new(move || {
                if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    match change {
                        "admission" => admit(&store, "ses_one", "msg_racing_work"),
                        _ => record(
                            &store,
                            "revert",
                            "ses_one",
                            "session.revert.committed.1",
                            json!({"sessionID": "ses_one", "to": "msg_work_final"}),
                        ),
                    }
                }
                vec![session::Id::new("ses_one").unwrap()]
            })
        };
        completion(&store, &job::Jobs::new())
            .complete(&session::Id::new("ses_one").unwrap(), racing)
            .await
            .unwrap();
        assert!(calls.load(Ordering::SeqCst) >= 1, "{change}");
        assert_eq!(receipts(&store, "ses_one"), [], "{change}");
    }
}

#[tokio::test]
async fn an_old_declaration_is_not_backfilled_after_a_newer_execution_starts() {
    let store = support::store();
    let jobs = job::Jobs::new();
    settled(&store, "ses_one", &Exchange::default());
    started(&store, "ses_one");
    exchange(
        &store,
        "ses_one",
        &Exchange {
            declaration: false,
            ..Exchange::default()
        },
    );
    complete(&store, &jobs, "ses_one", &["ses_one"]).await;
    assert_eq!(receipts(&store, "ses_one"), []);

    started(&store, "ses_one");
    exchange(&store, "ses_one", &Exchange::default());
    complete(&store, &jobs, "ses_one", &["ses_one"]).await;
    let completed = receipts(&store, "ses_one");
    assert_eq!(completed.len(), 1);
    complete(&store, &jobs, "ses_one", &["ses_one"]).await;
    assert_eq!(receipts(&store, "ses_one"), completed);
}

#[tokio::test]
async fn work_is_not_certified_outside_the_settling_execution() {
    let store = support::store();
    settled(&store, "ses_one", &Exchange::default());
    complete(&store, &job::Jobs::new(), "ses_one", &[]).await;
    complete(&store, &job::Jobs::new(), "ses_one", &["ses_two"]).await;
    assert_eq!(receipts(&store, "ses_one"), []);
}

#[tokio::test]
async fn a_child_declaration_never_certifies_the_parent() {
    let store = support::store();
    child(&store, "ses_child", "ses_one");
    settled(&store, "ses_child", &Exchange::default());
    let jobs = job::Jobs::new();

    complete(&store, &jobs, "ses_one", &["ses_one"]).await;
    complete(&store, &jobs, "ses_child", &["ses_child"]).await;

    assert_eq!(receipts(&store, "ses_one"), []);
    assert_eq!(receipts(&store, "ses_child").len(), 1);
}

fn blocker_pending(store: &Client, session: &str) {
    let session = session.to_owned();
    store
        .submit(move |tx| {
            PendingTable::insert(
                tx,
                &Pending {
                    id: "msg_child_work".into(),
                    session_id: session.as_str().into(),
                    type_: "user".into(),
                    data: value(json!({"text": "More"})),
                    delivery: Some("queue".into()),
                    admitted_seq: 1,
                    time_created: 1,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn blocker_task(store: &Client, parent: &str, task: &str, state: &str, notice: bool) {
    let (parent, task, state) = (parent.to_owned(), task.to_owned(), state.to_owned());
    store
        .submit(move |tx| {
            TaskTable::insert(
                tx,
                &Task {
                    session_id: task.as_str().into(),
                    parent_id: parent.as_str().into(),
                    parent_assistant_message_id: "msg_parent".into(),
                    tool_call_id: "call_task".into(),
                    input_id: "msg_task_input".into(),
                    description: "Work".into(),
                    agent: "build".into(),
                    model: Document::<model::Ref>::new(value(
                        json!({"providerID": "local", "id": "test"}),
                    ))?,
                    prompt_digest: "0".repeat(64).as_str().into(),
                    background: 1,
                    delivery: "steer".into(),
                    state: state.as_str().into(),
                    progress: None,
                    progress_time: None,
                    question_id: None,
                    question: None,
                    question_data: None,
                    question_time: None,
                    attempt_started: 0,
                    revision: 0,
                    time_created: 1,
                    time_updated: 1,
                },
            )?;
            if notice {
                NotificationTable::insert(
                    tx,
                    &Notification {
                        id: "ntf_task".into(),
                        task_session_id: task.as_str().into(),
                        parent_id: parent.as_str().into(),
                        type_: "completed".into(),
                        revision: 1,
                        excerpt: None,
                        delivered: 0,
                        time_created: 1,
                        time_delivered: None,
                    },
                )?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn blocker_goal(store: &Client, session: &str) {
    let session = session.to_owned();
    store
        .submit(move |tx| {
            let mut row = tx
                .get::<SessionTable>(&ycoding_store::tuple_key(&[
                    ycoding_store::KeyPart::String(&session.as_str().into()),
                ]))?
                .unwrap();
            row.autonomy = Some(value(
                json!({"mode": "goal", "goal": {"text": "Unfinished", "status": "active"}}),
            ));
            SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
}

#[tokio::test]
async fn unfinished_family_work_refuses_completion() {
    for blocker in [
        "goal",
        "task",
        "waiting task",
        "pending child",
        "notice",
        "active grandchild",
        "staged revert",
    ] {
        let store = support::store();
        child(&store, "ses_child", "ses_one");
        child(&store, "ses_grand", "ses_child");
        settled(&store, "ses_one", &Exchange::default());
        let mut running = vec!["ses_one"];
        match blocker {
            "goal" => blocker_goal(&store, "ses_child"),
            "task" => blocker_task(&store, "ses_one", "ses_child", "running", false),
            "waiting task" => blocker_task(&store, "ses_one", "ses_child", "waiting", false),
            "notice" => blocker_task(&store, "ses_one", "ses_child", "completed", true),
            "pending child" => blocker_pending(&store, "ses_grand"),
            "active grandchild" => running.push("ses_grand"),
            _ => {
                let id = "ses_grand".to_owned();
                store
                    .submit(move |tx| {
                        let mut row = tx
                            .get::<SessionTable>(&ycoding_store::tuple_key(&[
                                ycoding_store::KeyPart::String(&id.as_str().into()),
                            ]))?
                            .unwrap();
                        row.revert = Some(Document::new(value(
                            json!({"messageID": "msg_work_input"}),
                        ))?);
                        SessionTable::put(tx, &row)
                    })
                    .unwrap()
                    .wait()
                    .unwrap();
            }
        }
        complete(&store, &job::Jobs::new(), "ses_one", &running).await;
        assert_eq!(receipts(&store, "ses_one"), [], "{blocker}");
    }
}

async fn started_job(jobs: &job::Jobs, kind: &str, session: &str) -> oneshot::Sender<()> {
    let (release, released) = oneshot::channel::<()>();
    let info = jobs
        .start(job::StartInput {
            id: None,
            kind: kind.into(),
            title: None,
            metadata: json!({"sessionID": session}).as_object().cloned(),
            run: Box::pin(async move {
                let _ = released.await;
                Ok("done".into())
            }),
        })
        .unwrap();
    jobs.background(&info.id);
    release
}

#[tokio::test]
async fn running_jobs_and_unadmitted_shell_notices_in_the_family_refuse_completion() {
    let store = support::store();
    child(&store, "ses_child", "ses_one");
    settled(&store, "ses_one", &Exchange::default());

    let jobs = job::Jobs::new();
    let release = started_job(&jobs, "verification", "ses_child").await;
    complete(&store, &jobs, "ses_one", &["ses_one"]).await;
    assert_eq!(receipts(&store, "ses_one"), []);
    release.send(()).unwrap();
    for info in jobs.list() {
        jobs.wait(&info.id, None).await;
    }
    complete(&store, &jobs, "ses_one", &["ses_one"]).await;
    assert_eq!(receipts(&store, "ses_one").len(), 1);

    let store = support::store();
    child(&store, "ses_child", "ses_one");
    settled(&store, "ses_one", &Exchange::default());
    let jobs = job::Jobs::new();
    let release = started_job(&jobs, "shell", "ses_child").await;
    release.send(()).unwrap();
    let id = jobs.list()[0].id.clone();
    jobs.wait(&id, None).await;
    complete(&store, &jobs, "ses_one", &["ses_one"]).await;
    assert_eq!(receipts(&store, "ses_one"), []);
    jobs.notice_admitted(&id);
    complete(&store, &jobs, "ses_one", &["ses_one"]).await;
    assert_eq!(receipts(&store, "ses_one").len(), 1);
}

#[tokio::test]
async fn the_latest_receipt_of_each_root_session_pages_by_session_id() {
    let store = support::store();
    child(&store, "ses_child", "ses_one");
    for session in ["ses_one", "ses_two", "ses_child"] {
        settled(&store, session, &Exchange::default());
        complete(&store, &job::Jobs::new(), session, &[session]).await;
    }
    let reader = completion(&store, &job::Jobs::new());
    let id = |name: &str| session::Id::new(name).unwrap();

    let first = reader
        .latest(Page {
            after: None,
            limit: 1,
        })
        .unwrap();
    assert_eq!(
        first
            .data
            .iter()
            .map(|r: &Receipt| r.session_id.clone())
            .collect::<Vec<_>>(),
        [id("ses_one")]
    );
    assert_eq!(first.next, Some(id("ses_one")));
    assert_eq!(
        first.data[0].input_id.as_lossless().as_str(),
        Some("msg_work_input")
    );
    assert_eq!(
        first.data[0].assistant_message_id.as_lossless().as_str(),
        Some("msg_work_final")
    );
    assert_eq!(first.data[0].seq, receipts(&store, "ses_one")[0].1);

    let second = reader
        .latest(Page {
            after: Some(id("ses_one")),
            limit: 1,
        })
        .unwrap();
    assert_eq!(second.data[0].session_id, id("ses_two"));
    assert_eq!(second.next, None);
    assert!(
        reader
            .latest(Page {
                after: Some(id("ses_two")),
                limit: 1
            })
            .unwrap()
            .data
            .is_empty()
    );
    assert_eq!(
        reader
            .latest(Page {
                after: None,
                limit: 200
            })
            .unwrap()
            .data
            .len(),
        2
    );
    assert!(
        reader
            .latest(Page {
                after: None,
                limit: 0
            })
            .is_err()
    );
    assert!(
        reader
            .latest(Page {
                after: None,
                limit: 201
            })
            .is_err()
    );
}
