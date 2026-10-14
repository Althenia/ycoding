use std::{
    ops::Bound,
    sync::{Arc, Mutex},
};
use ycoding_core::{
    platform::shell::ledger,
    process::guardrails::{Guardrails, Limits, Paths, Reservation, Settings},
    session::{
        autonomy::{Goal, Service as Autonomy, YoloLevel},
        orchestration::{
            Error, Execution, Launch, LaunchInput, Prepared, Service, Settlement, TEAM_VIEW_BYTES,
            ToolCall, render_team_view, reserve,
        },
        run_coordinator::{Outcome, RunFuture},
        store,
    },
    tools::policy::{Authority, Publisher, permissions::Permissions},
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, model, parse_json, permission, session,
    session_message,
    session_orchestration::{NotificationType, QuestionId, State},
};
use ycoding_store::{
    KeyPart, Store,
    session::{Document, EventTable, NewEvent, NotificationTable, SessionTable, TaskTable},
    tuple_key,
};

#[path = "autonomy_support/mod.rs"]
mod support;

#[derive(Default)]
struct Recorder {
    woken: Mutex<Vec<String>>,
    interrupted: Mutex<Vec<String>>,
}

impl Recorder {
    fn woken(&self) -> Vec<String> {
        self.woken.lock().unwrap().clone()
    }
}

impl Execution for Recorder {
    fn wake(&self, id: &session::Id) -> Outcome {
        self.woken
            .lock()
            .unwrap()
            .push(id.as_lossless().as_str().unwrap().into());
        Ok(())
    }
    fn interrupt(&self, id: &session::Id) -> RunFuture {
        self.interrupted
            .lock()
            .unwrap()
            .push(id.as_lossless().as_str().unwrap().into());
        Box::pin(async { Ok(()) })
    }
}

struct Harness {
    store: Store,
    sessions: store::Service,
    service: Service,
    recorder: Arc<Recorder>,
}

fn harness() -> Harness {
    let store = support::store();
    let sessions = store::Service::new(store.client());
    let recorder = Arc::new(Recorder::default());
    Harness {
        service: Service::new(sessions.clone(), recorder.clone()),
        store,
        sessions,
        recorder,
    }
}

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn message(value: &str) -> session_message::Id {
    session_message::Id::new(value).unwrap()
}

fn ruleset(json: &str) -> permission::Ruleset {
    permission::Ruleset::decode(&parse_json(json).unwrap()).unwrap()
}

fn input(
    harness: &Harness,
    parent: &str,
    call: &str,
    prompt: &str,
    depth_limit: usize,
    caller: &str,
) -> LaunchInput {
    LaunchInput {
        parent_id: id(parent),
        parent_assistant_message_id: message("msg_parent"),
        tool_call_id: call.into(),
        description: "Explore".into(),
        prompt: prompt.into(),
        depth_limit,
        prepared: Prepared {
            agent: "explore".into(),
            caller_permissions: ruleset(caller),
            model: model::Ref::decode(
                &parse_json(r#"{"providerID":"local","id":"test"}"#).unwrap(),
            )
            .unwrap(),
            profile_binding: None,
        },
        guardrails: guarded(&harness.store, 8),
    }
}

fn child_of(parent: &str, call: &str) -> session::Id {
    Launch::new(&id(parent), &message("msg_parent"), call).child_id
}

async fn launched(harness: &Harness, call: &str) -> session::Id {
    harness
        .service
        .launch(input(harness, "ses_one", call, "Look around", 1, "[]"))
        .await
        .unwrap()
        .session_id
}

fn session_of(value: &JsonValue) -> &str {
    let JsonValue::Object(fields) = value else {
        panic!()
    };
    let Some(JsonValue::String(id)) = fields.get(&"sessionID".into()) else {
        panic!()
    };
    id.as_str().unwrap()
}

fn notifications(store: &Store) -> Vec<ycoding_store::session::Notification> {
    store
        .snapshot()
        .unwrap()
        .scan::<NotificationTable>(Bound::Unbounded, Bound::Unbounded, 100)
        .unwrap()
}

fn orchestration_revision(store: &Store, session: &str) -> i64 {
    store
        .snapshot()
        .unwrap()
        .get::<SessionTable>(&tuple_key(&[KeyPart::String(&session.into())]))
        .unwrap()
        .unwrap()
        .orchestration_revision
}

async fn raw_change(
    harness: &Harness,
    child: &session::Id,
    event: &str,
    change: &str,
) -> Result<(), ycoding_store::Error> {
    harness
        .sessions
        .publish(NewEvent {
            id: event.into(),
            aggregate_id: child.as_lossless().clone(),
            created: 99,
            type_: "session.task.updated.1".into(),
            data: parse_json(&format!(
                r#"{{"sessionID":"{}","change":{change}}}"#,
                child.as_lossless().as_str().unwrap()
            ))
            .unwrap(),
        })
        .await
        .map(|_| ())
}

#[tokio::test]
async fn launch_creates_a_background_child_session_with_durable_task_and_pending_input() {
    let harness = harness();
    let parent_ceiling = ruleset(r#"[{"action":"question","resource":"*","effect":"deny"}]"#);
    harness
        .store
        .submit(move |tx| {
            let key = tuple_key(&[KeyPart::String(&"ses_one".into())]);
            let mut row = tx.get::<SessionTable>(&key)?.unwrap();
            row.permission = Some(Document::from_domain(&parent_ceiling)?);
            SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    let task = harness
        .service
        .launch(input(
            &harness,
            "ses_one",
            "call_1",
            "Look around",
            1,
            r#"[{"action":"bash","resource":"*","effect":"deny"},{"action":"read","resource":"*","effect":"allow"},{"action":"question","resource":"*","effect":"deny"}]"#,
        ))
        .await
        .unwrap();

    let child = child_of("ses_one", "call_1");
    assert_eq!(task.session_id, child);
    assert_eq!(task.state, State::Running);
    assert!(task.background);
    assert_eq!(task.revision.get(), 1);
    assert_eq!(
        harness.recorder.woken(),
        [child.as_lossless().as_str().unwrap()]
    );

    let info = harness.sessions.get(&child).unwrap().unwrap();
    assert_eq!(info.parent_id, Some(id("ses_one")));
    assert_eq!(info.agent.unwrap().as_str(), Some("explore"));
    assert_eq!(
        info.permission_ceiling.unwrap().encode(),
        parse_json(
            r#"[{"action":"question","resource":"*","effect":"deny"},{"action":"bash","resource":"*","effect":"deny"}]"#
        )
        .unwrap()
    );
    let pending = harness.sessions.pending_list(&child).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].type_.as_str(), Some("user"));
    assert_eq!(orchestration_revision(&harness.store, "ses_one"), 2);
    assert_eq!(harness.service.list(&id("ses_one")).unwrap(), vec![task]);
}

#[tokio::test]
async fn identical_launch_retries_return_the_task_and_conflicting_retries_are_rejected() {
    let harness = harness();
    let first = harness
        .service
        .launch(input(&harness, "ses_one", "call_1", "Look around", 1, "[]"))
        .await
        .unwrap();
    let retry = harness
        .service
        .launch(input(&harness, "ses_one", "call_1", "Look around", 1, "[]"))
        .await
        .unwrap();
    assert_eq!(retry, first);
    assert_eq!(
        harness
            .sessions
            .pending_list(&first.session_id)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(harness.recorder.woken().len(), 1);
    assert!(matches!(
        harness
            .service
            .launch(input(
                &harness,
                "ses_one",
                "call_1",
                "Different prompt",
                1,
                "[]"
            ))
            .await,
        Err(Error::Conflict(_))
    ));
}

#[tokio::test]
async fn nesting_is_bounded_and_the_ceiling_inherits_transitively_without_escalation() {
    let harness = harness();
    let child = harness
        .service
        .launch(input(
            &harness,
            "ses_one",
            "call_1",
            "Look around",
            2,
            r#"[{"action":"bash","resource":"*","effect":"deny"}]"#,
        ))
        .await
        .unwrap()
        .session_id;
    let child_name = child.as_lossless().as_str().unwrap().to_owned();
    assert!(matches!(
        harness
            .service
            .launch(input(&harness, &child_name, "call_2", "Deeper", 1, "[]"))
            .await,
        Err(Error::DepthLimit(1))
    ));
    let grandchild = harness
        .service
        .launch(input(
            &harness,
            &child_name,
            "call_2",
            "Deeper",
            2,
            r#"[{"action":"write","resource":"*","effect":"deny"},{"action":"read","resource":"*","effect":"allow"}]"#,
        ))
        .await
        .unwrap()
        .session_id;
    assert_eq!(harness.service.depth(&grandchild).unwrap(), 2);
    assert_eq!(
        harness
            .sessions
            .get(&grandchild)
            .unwrap()
            .unwrap()
            .permission_ceiling
            .unwrap()
            .encode(),
        parse_json(
            r#"[{"action":"bash","resource":"*","effect":"deny"},{"action":"write","resource":"*","effect":"deny"}]"#
        )
        .unwrap()
    );
}

#[tokio::test]
async fn ownership_is_enforced_for_every_parent_control() {
    let harness = harness();
    let child = launched(&harness, "call_1").await;
    let unknown = id("ses_unknown");
    for result in [
        harness.service.get(&id("ses_two"), &child).map(|_| ()),
        harness
            .service
            .cancel(&id("ses_two"), &child)
            .await
            .map(|_| ()),
        harness
            .service
            .resume(&id("ses_two"), &child)
            .await
            .map(|_| ()),
        harness
            .service
            .send(&id("ses_two"), &child, &message("msg_x"), "hi", "steer")
            .await
            .map(|_| ()),
    ] {
        assert!(matches!(result, Err(Error::Forbidden { .. })));
    }
    assert!(matches!(
        harness.service.get(&id("ses_one"), &unknown),
        Err(Error::NotFound { .. })
    ));
    assert!(matches!(
        harness.service.get(&unknown, &child),
        Err(Error::SessionNotFound(_))
    ));
    assert!(harness.service.get(&id("ses_one"), &child).is_ok());
}

#[tokio::test]
async fn questions_wait_for_a_human_unless_the_family_is_autonomous() {
    let harness = harness();
    let child = launched(&harness, "call_1").await;
    let asked = harness
        .service
        .question(&child, "Which database?", None)
        .await
        .unwrap();
    assert!(!asked.auto_answered);
    let waiting = harness.service.get(&id("ses_one"), &child).unwrap();
    assert_eq!(waiting.state, State::Waiting);
    assert_eq!(waiting.question.unwrap().id, asked.question.id);
    assert_eq!(notifications(&harness.store).len(), 1);

    assert!(matches!(
        harness
            .service
            .answer(
                &id("ses_one"),
                &child,
                &QuestionId("qst_other".into()),
                Some("x"),
                None
            )
            .await,
        Err(Error::QuestionNotFound { .. })
    ));
    assert!(matches!(
        harness
            .service
            .answer(&id("ses_one"), &child, &asked.question.id, None, None)
            .await,
        Err(Error::InvalidRequest(_))
    ));
    let answered = harness
        .service
        .answer(
            &id("ses_one"),
            &child,
            &asked.question.id,
            Some("Postgres"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(answered.state, State::Running);
    assert!(answered.question.is_none());
    assert_eq!(harness.sessions.pending_list(&child).unwrap().len(), 2);

    Autonomy::new(harness.store.client())
        .set_yolo(&id("ses_one"), YoloLevel::ANSWERS)
        .await
        .unwrap();
    let automatic = harness
        .service
        .question(&child, "Which cache?", None)
        .await
        .unwrap();
    assert!(automatic.auto_answered);
    assert_eq!(
        harness.service.get(&id("ses_one"), &child).unwrap().state,
        State::Running
    );
    let pending = harness.sessions.pending_list(&child).unwrap();
    assert_eq!(pending.len(), 3);
    assert!(pending.iter().any(|row| {
        ycoding_schema::stringify_json(&row.data).contains("safest reasonable default")
    }));
}

#[tokio::test]
async fn an_active_parent_goal_also_auto_answers_child_questions_at_yolo_zero() {
    let harness = harness();
    let child = launched(&harness, "call_1").await;
    Autonomy::new(harness.store.client())
        .set_goal(&id("ses_one"), Goal::new("Finish", None, None))
        .await
        .unwrap();
    assert!(
        harness
            .service
            .question(&child, "Which?", None)
            .await
            .unwrap()
            .auto_answered
    );
}

#[tokio::test]
async fn a_waiting_child_question_notifies_the_parent_once_and_the_answer_resumes_the_child_with_provenance()
 {
    let harness = harness();
    let child = launched(&harness, "call_1").await;
    let asked = harness
        .service
        .question(&child, "Proceed?", None)
        .await
        .unwrap();
    let waiting = harness.service.get(&id("ses_one"), &child).unwrap();
    assert_eq!(waiting.state, State::Waiting);
    assert_eq!(waiting.question.unwrap().id, asked.question.id);

    assert_eq!(harness.service.dispatch_notifications().await.unwrap(), 1);
    let woken = |session: &str| {
        harness
            .recorder
            .woken()
            .iter()
            .filter(|id| *id == session)
            .count()
    };
    assert_eq!(woken("ses_one"), 1);
    let notices = harness.sessions.pending_list(&id("ses_one")).unwrap();
    assert_eq!(notices.len(), 1);
    let notice = ycoding_schema::stringify_json(&notices[0].data);
    assert!(notice.contains("subagent_notification"), "{notice}");
    assert!(
        notice.contains(child.as_lossless().as_str().unwrap()),
        "{notice}"
    );
    assert!(notice.contains("question"), "{notice}");

    let child_wakes = woken(child.as_lossless().as_str().unwrap());
    let answered = harness
        .service
        .answer(
            &id("ses_one"),
            &child,
            &asked.question.id,
            Some("yes"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(answered.state, State::Running);
    assert!(answered.question.is_none());
    assert_eq!(
        woken(child.as_lossless().as_str().unwrap()),
        child_wakes + 1
    );
    let answers = harness
        .sessions
        .pending_list(&child)
        .unwrap()
        .into_iter()
        .map(|row| ycoding_schema::stringify_json(&row.data))
        .filter(|data| data.contains(r#""kind":"answer""#))
        .collect::<Vec<_>>();
    assert_eq!(answers.len(), 1);
    assert!(
        answers[0].contains(r#""parentID":"ses_one""#),
        "{}",
        answers[0]
    );
    assert!(answers[0].contains(child.as_lossless().as_str().unwrap()));
    assert!(answers[0].contains(&asked.question.id.0.to_utf8().unwrap()));
    assert!(matches!(
        harness
            .service
            .answer(
                &id("ses_one"),
                &child,
                &asked.question.id,
                Some("again"),
                None
            )
            .await,
        Err(Error::QuestionNotFound { .. })
    ));
}

#[tokio::test]
async fn settlement_notifies_the_parent_once_and_is_idempotent() {
    let harness = harness();
    let child = launched(&harness, "call_1").await;
    let done = harness
        .service
        .settle(
            &child,
            Settlement::Completed {
                excerpt: Some("All done".into()),
            },
        )
        .await
        .unwrap();
    assert_eq!(done.state, State::Completed);
    assert_eq!(
        harness
            .service
            .settle(
                &child,
                Settlement::Failed {
                    error: "late".into(),
                    excerpt: None
                }
            )
            .await
            .unwrap(),
        done
    );
    assert_eq!(notifications(&harness.store).len(), 1);

    assert_eq!(harness.service.dispatch_notifications().await.unwrap(), 1);
    assert_eq!(harness.service.dispatch_notifications().await.unwrap(), 0);
    let expected = Launch::new(&id("ses_one"), &message("msg_parent"), "call_1")
        .notification(done.revision.get(), &NotificationType::Completed);
    let notice = harness.sessions.pending(&expected).unwrap().unwrap();
    assert_eq!(notice.session_id.as_str(), Some("ses_one"));
    assert!(ycoding_schema::stringify_json(&notice.data).contains("All done"));
    assert_eq!(
        harness
            .recorder
            .woken()
            .iter()
            .filter(|id| *id == "ses_one")
            .count(),
        1
    );
    assert!(notifications(&harness.store)[0].delivered == 1);
}

#[tokio::test]
async fn cancel_interrupts_once_and_rejects_settled_tasks() {
    let harness = harness();
    let child = launched(&harness, "call_1").await;
    let cancelled = harness
        .service
        .cancel(&id("ses_one"), &child)
        .await
        .unwrap();
    assert_eq!(cancelled.state, State::Cancelled);
    assert_eq!(harness.recorder.interrupted.lock().unwrap().len(), 1);
    assert_eq!(
        harness
            .service
            .cancel(&id("ses_one"), &child)
            .await
            .unwrap(),
        cancelled
    );
    assert_eq!(harness.recorder.interrupted.lock().unwrap().len(), 1);

    let second = launched(&harness, "call_2").await;
    harness
        .service
        .settle(&second, Settlement::Completed { excerpt: None })
        .await
        .unwrap();
    assert!(matches!(
        harness.service.cancel(&id("ses_one"), &second).await,
        Err(Error::Conflict(_))
    ));
}

#[tokio::test]
async fn notification_wake_storage_failures_propagate_and_leave_the_original_notice_retryable() {
    struct FailedWake;
    impl Execution for FailedWake {
        fn wake(&self, _: &session::Id) -> Outcome {
            Err(ycoding_core::session::run_coordinator::Error::Store(
                Arc::new(ycoding_store::Error::Rejected("parent wake storage failed")),
            ))
        }

        fn interrupt(&self, _: &session::Id) -> RunFuture {
            Box::pin(async { Ok(()) })
        }
    }
    let harness = harness();
    let child = launched(&harness, "call_notify_failure").await;
    let cancelled = harness
        .service
        .cancel(&id("ses_one"), &child)
        .await
        .unwrap();
    let failing = Service::new(harness.sessions.clone(), Arc::new(FailedWake));
    let error = failing.dispatch_notifications().await.unwrap_err();
    assert!(
        matches!(error, Error::Execution(ycoding_core::session::run_coordinator::Error::Store(error)) if matches!(&*error, ycoding_store::Error::Rejected("parent wake storage failed")))
    );
    let notice = Launch::new(
        &id("ses_one"),
        &message("msg_parent"),
        "call_notify_failure",
    )
    .notification(cancelled.revision.get(), &NotificationType::Cancelled);
    assert!(harness.sessions.pending(&notice).unwrap().is_some());
    assert_eq!(notifications(&harness.store)[0].delivered, 0);
    assert_eq!(harness.service.dispatch_notifications().await.unwrap(), 1);
    assert_eq!(harness.service.dispatch_notifications().await.unwrap(), 0);
    assert_eq!(
        harness.sessions.pending_list(&id("ses_one")).unwrap().len(),
        1
    );
    assert_eq!(notifications(&harness.store)[0].delivered, 1);
}

#[tokio::test]
async fn parent_messages_restart_a_terminal_child_only_for_new_pending_work() {
    let harness = harness();
    let child = launched(&harness, "call_1").await;
    harness
        .service
        .settle(&child, Settlement::Completed { excerpt: None })
        .await
        .unwrap();
    let woken = harness.recorder.woken().len();
    let restarted = harness
        .service
        .send(
            &id("ses_one"),
            &child,
            &message("msg_follow"),
            "One more thing",
            "steer",
        )
        .await
        .unwrap();
    assert_eq!(restarted.state, State::Running);
    assert_eq!(harness.recorder.woken().len(), woken + 1);
    assert!(
        harness
            .sessions
            .pending(&message("msg_follow"))
            .unwrap()
            .is_some()
    );
    assert!(harness.service.resume(&id("ses_one"), &child).await.is_ok());
}

#[tokio::test]
async fn parent_input_is_held_behind_a_staged_child_revert_without_waking_it() {
    let harness = harness();
    let child = launched(&harness, "call_1").await;
    support::stage_revert(&harness.sessions, child.as_lossless().as_str().unwrap()).await;
    let woken = harness.recorder.woken().len();

    harness
        .service
        .send(
            &id("ses_one"),
            &child,
            &message("msg_held"),
            "Hold this",
            "steer",
        )
        .await
        .unwrap();
    Autonomy::new(harness.store.client())
        .set_yolo(&id("ses_one"), YoloLevel::ANSWERS)
        .await
        .unwrap();
    assert!(
        harness
            .service
            .question(&child, "Which cache?", None)
            .await
            .unwrap()
            .auto_answered
    );

    assert_eq!(harness.sessions.pending_list(&child).unwrap().len(), 3);
    assert!(
        harness
            .sessions
            .get(&child)
            .unwrap()
            .unwrap()
            .revert
            .is_some()
    );
    assert_eq!(harness.recorder.woken().len(), woken);
}

#[tokio::test]
async fn an_answer_to_a_waiting_child_is_held_behind_a_staged_revert_without_waking_it() {
    let harness = harness();
    let child = launched(&harness, "call_1").await;
    let asked = harness
        .service
        .question(&child, "Which database?", None)
        .await
        .unwrap();
    support::stage_revert(&harness.sessions, child.as_lossless().as_str().unwrap()).await;
    let woken = harness.recorder.woken().len();

    harness
        .service
        .answer(
            &id("ses_one"),
            &child,
            &asked.question.id,
            Some("Postgres"),
            None,
        )
        .await
        .unwrap();

    assert_eq!(harness.sessions.pending_list(&child).unwrap().len(), 2);
    assert_eq!(harness.recorder.woken().len(), woken);
}

#[tokio::test]
async fn a_notification_is_held_behind_a_staged_parent_revert_without_waking_the_parent() {
    let harness = harness();
    let child = launched(&harness, "call_1").await;
    support::stage_revert(&harness.sessions, "ses_one").await;
    let woken = harness.recorder.woken().len();
    let done = harness
        .service
        .settle(&child, Settlement::Completed { excerpt: None })
        .await
        .unwrap();

    assert_eq!(harness.service.dispatch_notifications().await.unwrap(), 1);

    let expected = Launch::new(&id("ses_one"), &message("msg_parent"), "call_1")
        .notification(done.revision.get(), &NotificationType::Completed);
    assert!(harness.sessions.pending(&expected).unwrap().is_some());
    assert!(notifications(&harness.store)[0].delivered == 1);
    assert_eq!(harness.recorder.woken().len(), woken);
}

#[tokio::test]
async fn progress_is_bounded_and_rejected_outside_running() {
    let harness = harness();
    let child = launched(&harness, "call_1").await;
    let long = "é".repeat(4000);
    let task = harness.service.progress(&child, &long).await.unwrap();
    let progress = task.progress.unwrap();
    assert!(progress.text.as_str().unwrap().len() <= 4096);
    harness
        .service
        .settle(&child, Settlement::Lost { excerpt: None })
        .await
        .unwrap();
    assert!(matches!(
        harness.service.progress(&child, "late").await,
        Err(Error::Conflict(_))
    ));
}

#[tokio::test]
async fn invalid_projected_transitions_are_rejected_without_changing_the_task() {
    let harness = harness();
    let child = launched(&harness, "call_1").await;
    let before = harness.service.get(&id("ses_one"), &child).unwrap();
    for (event, change) in [
        ("evt_bad_cancelled", r#"{"type":"cancelled"}"#),
        (
            "evt_bad_answer",
            r#"{"type":"question_answered","answer":{"questionID":"qst_x","text":"x"}}"#,
        ),
        ("evt_bad_started", r#"{"type":"started"}"#),
    ] {
        assert!(
            raw_change(&harness, &child, event, change).await.is_err(),
            "{event}"
        );
    }
    assert_eq!(harness.service.get(&id("ses_one"), &child).unwrap(), before);
    assert!(
        raw_change(
            &harness,
            &child,
            "evt_valid_completed",
            r#"{"type":"completed"}"#
        )
        .await
        .is_ok()
    );
}

#[tokio::test]
async fn team_view_rehydrates_from_durable_state_and_observations_ignore_clocks() {
    let harness = harness();
    let first = launched(&harness, "call_1").await;
    let second = launched(&harness, "call_2").await;
    harness
        .service
        .settle(&second, Settlement::Completed { excerpt: None })
        .await
        .unwrap();
    harness
        .service
        .question(&first, "Pick one", None)
        .await
        .unwrap();

    let reconnected = Service::new(harness.sessions.clone(), Arc::new(Recorder::default()));
    let view = harness.service.team_view(&id("ses_one")).unwrap();
    assert_eq!(reconnected.team_view(&id("ses_one")).unwrap(), view);
    assert!(
        view.text
            .starts_with("Internal orchestration context (JSON).")
    );
    let JsonValue::Object(fields) = &view.view else {
        panic!()
    };
    let JsonValue::Array(children) = fields.get(&"children".into()).unwrap() else {
        panic!()
    };
    assert_eq!(children.len(), 2);
    assert_eq!(
        session_of(&children[0]),
        first.as_lossless().as_str().unwrap(),
        "active children precede terminal ones"
    );

    let observation = harness
        .service
        .team_observation(&id("ses_one"))
        .unwrap()
        .unwrap();
    assert!(!observation.text.contains("revision"));
    assert!(!observation.text.contains("\"time\""));
    assert!(
        observation.text.find("qst_").unwrap()
            < observation
                .text
                .find(second.as_lossless().as_str().unwrap())
                .unwrap()
    );
    assert!(
        harness
            .service
            .team_observation(&id("ses_two"))
            .unwrap()
            .is_none()
    );

    let tasks = harness.service.list(&id("ses_one")).unwrap();
    let active = tasks
        .iter()
        .find(|task| task.state == State::Waiting)
        .unwrap();
    let budget = render_team_view(std::slice::from_ref(active), TEAM_VIEW_BYTES)
        .unwrap()
        .text
        .len();
    let narrow = render_team_view(&tasks, budget).unwrap();
    let JsonValue::Object(narrow_fields) = &narrow.view else {
        panic!()
    };
    let JsonValue::Array(kept) = narrow_fields.get(&"children".into()).unwrap() else {
        panic!()
    };
    assert_eq!(kept.len(), 1);
    assert_eq!(
        narrow_fields.get(&"omitted".into()),
        Some(&JsonValue::Number(1.0))
    );
    assert!(narrow.text.len() <= budget);
    assert!(view.text.len() <= TEAM_VIEW_BYTES);
}

#[tokio::test]
async fn live_task_owner_survives_startup() {
    let harness = harness();
    let child = launched(&harness, "call_live").await;
    let before = task_row(&harness.store, &child);
    let woken = harness.recorder.woken();
    assert_eq!(harness.service.reconcile_stale().await.unwrap(), 0);
    assert_eq!(task_row(&harness.store, &child), before);
    assert!(notifications(&harness.store).is_empty());
    assert_eq!(harness.recorder.woken(), woken);
}

struct TaskDatabase(std::path::PathBuf);

impl Drop for TaskDatabase {
    fn drop(&mut self) {
        std::fs::remove_file(&self.0).unwrap();
    }
}

fn persistent_harness(path: &std::path::Path, fresh: bool) -> Harness {
    let catalog = ycoding_store::import::catalog(ycoding_store::import::DatabaseKind::Core);
    let store = if fresh {
        let store = Store::initialize(
            path,
            ycoding_store::Options::core(),
            catalog,
            ycoding_store::Metadata::new([99; 16], 1),
        )
        .unwrap();
        let seed = support::store();
        let snapshot = seed.snapshot().unwrap();
        let project = snapshot
            .scan::<ycoding_store::project::ProjectTable>(Bound::Unbounded, Bound::Unbounded, 1)
            .unwrap()
            .pop()
            .unwrap();
        let sessions = snapshot
            .scan::<SessionTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap();
        store
            .submit(move |tx| {
                ycoding_store::project::ProjectTable::insert(tx, &project)?;
                for session in sessions {
                    SessionTable::insert(tx, &session)?;
                }
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        store
    } else {
        Store::open(path, ycoding_store::Options::core(), catalog).unwrap()
    };
    let sessions = store::Service::new(store.client());
    let recorder = Arc::new(Recorder::default());
    Harness {
        service: Service::new(sessions.clone(), recorder.clone()),
        store,
        sessions,
        recorder,
    }
}

fn close(harness: Harness) {
    drop(harness.service);
    drop(harness.sessions);
    harness.store.shutdown().unwrap();
}

async fn set_owner(
    harness: &Harness,
    child: &session::Id,
    pid: Option<i64>,
    started: Option<&str>,
) {
    let mut row = task_row(&harness.store, child);
    row.owner_pid = pid;
    row.owner_started = started.map(Into::into);
    harness
        .store
        .submit(move |tx| TaskTable::put(tx, &row))
        .unwrap()
        .await
        .unwrap();
}

fn restart_events(harness: &Harness) -> Vec<ycoding_store::session::Event> {
    harness
        .store
        .snapshot()
        .unwrap()
        .scan::<EventTable>(Bound::Unbounded, Bound::Unbounded, 100)
        .unwrap()
        .into_iter()
        .filter(|event| {
            event
                .id
                .as_str()
                .unwrap()
                .starts_with("evt_task_restart_lost_")
        })
        .collect()
}

#[cfg(unix)]
#[tokio::test]
async fn live_external_task_owner_survives_reopen_and_is_lost_after_exit() {
    let path = TaskDatabase(std::env::temp_dir().join(format!(
            "ycoding-owner-fence-{}-{}.redb",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )));
    let mut owner = tokio::process::Command::new("sleep")
        .arg("60")
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let identity = ledger::identify(owner.id().unwrap()).await.unwrap();
    let harness = persistent_harness(&path.0, true);
    let child = launched(&harness, "call_external").await;
    set_owner(
        &harness,
        &child,
        Some(i64::from(identity.pid)),
        Some(&identity.started),
    )
    .await;
    let before = task_row(&harness.store, &child);
    close(harness);

    let harness = persistent_harness(&path.0, false);
    assert_eq!(harness.service.reconcile_stale().await.unwrap(), 0);
    assert_eq!(task_row(&harness.store, &child), before);
    assert!(restart_events(&harness).is_empty());
    assert!(harness.recorder.woken().is_empty());
    owner.kill().await.unwrap();
    owner.wait().await.unwrap();
    assert_eq!(
        harness.service.reconcile_stale().await.unwrap(),
        0,
        "one check per open Store even after owner exits"
    );
    close(harness);

    let harness = persistent_harness(&path.0, false);
    assert_eq!(harness.service.reconcile_stale().await.unwrap(), 1);
    assert_eq!(
        harness.service.get(&id("ses_one"), &child).unwrap().state,
        State::Lost
    );
    assert_eq!(
        task_row(&harness.store, &child).revision,
        before.revision + 1
    );
    assert_eq!(
        restart_events(&harness)[0].id,
        LosslessString::from(format!(
            "evt_task_restart_lost_{}_{}",
            child.as_lossless().as_str().unwrap(),
            before.revision + 1
        ))
    );
    assert_eq!(notifications(&harness.store).len(), 1);
    assert_eq!(notifications(&harness.store)[0].delivered, 0);
    assert_eq!(harness.service.dispatch_notifications().await.unwrap(), 0);
    assert!(harness.recorder.woken().is_empty());
    close(harness);

    let harness = persistent_harness(&path.0, false);
    assert_eq!(harness.service.reconcile_stale().await.unwrap(), 0);
    assert_eq!(restart_events(&harness).len(), 1);
    assert_eq!(notifications(&harness.store).len(), 1);
    assert!(harness.recorder.woken().is_empty());
    close(harness);
}

#[tokio::test]
async fn missing_dead_and_reused_pid_owners_become_lost_once() {
    let harness = harness();
    let identity = ledger::identify(std::process::id()).await.unwrap();
    let owners = [
        ("missing", "starting", None, None),
        ("dead", "running", Some(2_000_000_000), Some("dead")),
        (
            "reused",
            "waiting",
            Some(i64::from(identity.pid)),
            Some("different start"),
        ),
        (
            "partial_pid",
            "cancelling",
            Some(i64::from(identity.pid)),
            None,
        ),
        (
            "partial_started",
            "running",
            None,
            Some(identity.started.as_str()),
        ),
    ];
    let mut children = Vec::new();
    for (call, state, pid, started) in owners {
        let child = launched(&harness, call).await;
        set_owner(&harness, &child, pid, started).await;
        let mut row = task_row(&harness.store, &child);
        row.state = state.into();
        harness
            .store
            .submit(move |tx| TaskTable::put(tx, &row))
            .unwrap()
            .await
            .unwrap();
        children.push(child);
    }
    let terminal = launched(&harness, "completed").await;
    harness
        .service
        .settle(&terminal, Settlement::Completed { excerpt: None })
        .await
        .unwrap();
    let before_terminal = task_row(&harness.store, &terminal);
    let woken = harness.recorder.woken();
    let revision = orchestration_revision(&harness.store, "ses_one");
    let other = Service::new(harness.sessions.clone(), harness.recorder.clone());
    let (first, second) = tokio::join!(harness.service.reconcile_stale(), other.reconcile_stale());
    assert_eq!(first.unwrap() + second.unwrap(), children.len());
    for child in &children {
        let row = task_row(&harness.store, child);
        assert_eq!(row.state.as_str(), Some("lost"));
        assert_eq!(row.revision, 2);
        assert!(restart_events(&harness).iter().any(|event| event.id
            == LosslessString::from(format!(
                "evt_task_restart_lost_{}_2",
                child.as_lossless().as_str().unwrap()
            ))));
    }
    assert_eq!(
        orchestration_revision(&harness.store, "ses_one"),
        revision + children.len() as i64
    );
    assert_eq!(task_row(&harness.store, &terminal), before_terminal);
    assert_eq!(restart_events(&harness).len(), children.len());
    assert_eq!(
        notifications(&harness.store)
            .iter()
            .filter(|notice| notice.type_.as_str() == Some("lost") && notice.delivered == 0)
            .count(),
        children.len()
    );
    assert_eq!(harness.recorder.woken(), woken);
    let new = launched(&harness, "new_after_reconciliation").await;
    set_owner(&harness, &new, None, None).await;
    let woken_after_launch = harness.recorder.woken();
    assert_eq!(woken_after_launch.len(), woken.len() + 1);
    let recreated = Service::new(harness.sessions.clone(), harness.recorder.clone());
    assert_eq!(
        recreated
            .reconcile_stale_with_processes(|| async { panic!("already reconciled") })
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        task_row(&harness.store, &new).state.as_str(),
        Some("running")
    );
    assert_eq!(harness.recorder.woken(), woken_after_launch);
}

#[tokio::test]
async fn process_list_failure_defers_reconciliation() {
    let harness = harness();
    let child = launched(&harness, "call_unreadable").await;
    set_owner(&harness, &child, None, None).await;
    let before = task_row(&harness.store, &child);
    let parent_revision = orchestration_revision(&harness.store, "ses_one");
    let woken = harness.recorder.woken();
    assert_eq!(
        harness
            .service
            .reconcile_stale_with_processes(|| async {
                Err(std::io::Error::other("ps unavailable"))
            })
            .await
            .unwrap(),
        0
    );
    assert_eq!(task_row(&harness.store, &child), before);
    assert_eq!(
        orchestration_revision(&harness.store, "ses_one"),
        parent_revision
    );
    assert!(notifications(&harness.store).is_empty());
    assert!(restart_events(&harness).is_empty());
    let retry = Service::new(harness.sessions.clone(), harness.recorder.clone());
    assert_eq!(
        retry
            .reconcile_stale_with_processes(|| async { Ok(Vec::new()) })
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        task_row(&harness.store, &child).state.as_str(),
        Some("lost")
    );
    assert_eq!(harness.recorder.woken(), woken);
}

#[tokio::test]
async fn restart_loss_rebuilds_task_projection_and_outbox_from_durable_history() {
    let original = harness();
    let child = raw_launch(&original, "ses_two", "call_rebuild").await;
    raw_change(
        &original,
        &child,
        "evt_rebuild_started",
        r#"{"type":"started"}"#,
    )
    .await
    .unwrap();
    set_owner(&original, &child, None, None).await;
    assert_eq!(original.service.reconcile_stale().await.unwrap(), 1);
    let mut expected = task_row(&original.store, &child);
    let expected_notifications = notifications(&original.store);
    let mut history = original
        .store
        .snapshot()
        .unwrap()
        .scan::<EventTable>(Bound::Unbounded, Bound::Unbounded, 100)
        .unwrap();
    history.sort_by_key(|event| event.seq);
    let rebuilt = harness();
    rebuilt
        .store
        .submit(move |tx| {
            for event in history {
                ycoding_core::session::projector::fold(tx, &event)?;
            }
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
    let mut actual = task_row(&rebuilt.store, &child);
    expected.owner_pid = None;
    expected.owner_started = None;
    actual.owner_pid = None;
    actual.owner_started = None;
    assert_eq!(
        actual, expected,
        "ownership is local projection context, not a replayed event fact"
    );
    assert_eq!(notifications(&rebuilt.store), expected_notifications);
    assert_eq!(
        orchestration_revision(&rebuilt.store, "ses_one"),
        orchestration_revision(&original.store, "ses_one")
    );
    assert!(original.recorder.woken().is_empty());
    assert!(rebuilt.recorder.woken().is_empty());
}

#[tokio::test]
async fn empty_startup_skips_process_listing_and_settles_once() {
    let harness = harness();
    assert_eq!(
        harness
            .service
            .reconcile_stale_with_processes(|| async { panic!("no active rows") })
            .await
            .unwrap(),
        0
    );
    let child = launched(&harness, "call_after_empty_startup").await;
    set_owner(&harness, &child, None, None).await;
    let Harness {
        service,
        sessions,
        store,
        recorder,
    } = harness;
    drop(service);
    assert_eq!(
        Service::new(sessions, recorder)
            .reconcile_stale_with_processes(|| async { panic!("Store already reconciled") })
            .await
            .unwrap(),
        0
    );
    assert_eq!(task_row(&store, &child).state.as_str(), Some("running"));
}

#[tokio::test]
async fn launch_start_answer_claim_owner_other_changes_preserve_it() {
    let harness = harness();
    let child = raw_launch(&harness, "ses_two", "call_claims").await;
    let identity = ledger::identify(std::process::id()).await.unwrap();
    let mine = (
        Some(i64::from(identity.pid)),
        Some(LosslessString::from(identity.started)),
    );
    let owner = || {
        let row = task_row(&harness.store, &child);
        (row.owner_pid, row.owner_started)
    };
    assert_eq!(owner(), mine);
    set_owner(&harness, &child, Some(2_000_000_000), Some("dead")).await;
    raw_change(
        &harness,
        &child,
        "evt_owner_started",
        r#"{"type":"started"}"#,
    )
    .await
    .unwrap();
    assert_eq!(owner(), mine);
    set_owner(&harness, &child, Some(2_000_000_000), Some("dead")).await;
    let stale = owner();
    let mut row = task_row(&harness.store, &child);
    row.background = 0;
    harness
        .store
        .submit(move |tx| TaskTable::put(tx, &row))
        .unwrap()
        .await
        .unwrap();
    raw_change(
        &harness,
        &child,
        "evt_owner_background",
        r#"{"type":"backgrounded"}"#,
    )
    .await
    .unwrap();
    assert_eq!(owner(), stale);
    raw_change(
        &harness,
        &child,
        "evt_owner_progress",
        r#"{"type":"progressed","progress":{"text":"still","time":99}}"#,
    )
    .await
    .unwrap();
    assert_eq!(owner(), stale);
    step(
        &harness,
        &child,
        "session.step.started",
        "evt_owner_step_start",
        r#","agent":"build","model":{"providerID":"local","id":"test"}"#,
    )
    .await;
    assert_eq!(owner(), stale);
    step(&harness, &child, "session.step.ended", "evt_owner_step_end", r#","finish":"stop","cost":0,"tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}"#).await;
    assert_eq!(owner(), stale);
    raw_change(
        &harness,
        &child,
        "evt_owner_question",
        r#"{"type":"question_asked","question":{"id":"qst_owner","text":"which?","time":99}}"#,
    )
    .await
    .unwrap();
    assert_eq!(owner(), stale);
    raw_change(
        &harness,
        &child,
        "evt_owner_answer",
        r#"{"type":"question_answered","answer":{"questionID":"qst_owner","text":"this"}}"#,
    )
    .await
    .unwrap();
    assert_eq!(owner(), mine);
    for (index, changes) in [
        vec![r#"{"type":"lost","excerpt":"gone"}"#],
        vec![r#"{"type":"cancel_requested"}"#, r#"{"type":"cancelled"}"#],
        vec![r#"{"type":"completed"}"#],
        vec![r#"{"type":"failed","error":"boom"}"#],
    ]
    .into_iter()
    .enumerate()
    {
        set_owner(&harness, &child, Some(2_000_000_000), Some("dead")).await;
        for (ordinal, change) in changes.into_iter().enumerate() {
            raw_change(
                &harness,
                &child,
                &format!("evt_owner_terminal_{index}_{ordinal}"),
                change,
            )
            .await
            .unwrap();
            assert_eq!(owner(), stale);
        }
        raw_change(
            &harness,
            &child,
            &format!("evt_owner_restart_{index}"),
            r#"{"type":"started"}"#,
        )
        .await
        .unwrap();
        assert_eq!(owner(), mine);
    }
    let events = harness
        .store
        .snapshot()
        .unwrap()
        .scan::<EventTable>(Bound::Unbounded, Bound::Unbounded, 100)
        .unwrap();
    assert!(
        events
            .iter()
            .all(|event| !ycoding_schema::stringify_json(&event.data).contains("owner_")),
        "owner stays out of event payloads"
    );
}

#[tokio::test]
async fn restart_reconciliation_marks_active_tasks_lost_without_waking_the_parent() {
    let harness = harness();
    let running = launched(&harness, "call_1").await;
    set_owner(&harness, &running, None, None).await;
    let done = launched(&harness, "call_2").await;
    harness
        .service
        .settle(&done, Settlement::Completed { excerpt: None })
        .await
        .unwrap();
    harness.service.dispatch_notifications().await.unwrap();
    let woken = harness.recorder.woken().len();

    assert_eq!(harness.service.reconcile_stale().await.unwrap(), 1);
    assert_eq!(harness.service.reconcile_stale().await.unwrap(), 0);
    assert_eq!(
        harness.service.lost_sessions().unwrap(),
        std::collections::BTreeSet::from([ycoding_schema::LosslessString::from("ses_one")])
    );
    let lost = harness.service.get(&id("ses_one"), &running).unwrap();
    assert_eq!(lost.state, State::Lost);
    assert_eq!(
        harness.service.get(&id("ses_one"), &done).unwrap().state,
        State::Completed
    );

    assert_eq!(harness.service.dispatch_notifications().await.unwrap(), 0);
    assert_eq!(harness.recorder.woken().len(), woken);
    assert_eq!(
        harness
            .service
            .dispatch_restart_losses(&id("ses_two"))
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        harness
            .service
            .dispatch_restart_losses(&id("ses_one"))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        harness.recorder.woken().len(),
        woken,
        "restart-loss delivery never drives provider work"
    );
    assert!(harness.service.lost_sessions().unwrap().is_empty());
    let expected = Launch::new(&id("ses_one"), &message("msg_parent"), "call_1")
        .notification(lost.revision.get(), &NotificationType::Lost);
    assert!(harness.sessions.pending(&expected).unwrap().is_some());
}

#[tokio::test]
async fn child_autonomy_inherits_the_strongest_ancestor_level_and_goal() {
    let harness = harness();
    let child = launched(&harness, "call_1").await;
    let autonomy = Autonomy::new(harness.store.client());
    assert!(!autonomy.effective(&child).unwrap().can_auto_permission());
    autonomy
        .set_yolo(&id("ses_one"), YoloLevel::APPROVALS)
        .await
        .unwrap();
    let inherited = autonomy.effective(&child).unwrap();
    assert!(inherited.can_auto_permission() && inherited.can_auto_guardrail());
    assert!(!inherited.can_auto_answer());
    autonomy
        .set_yolo(&id("ses_one"), YoloLevel::OFF)
        .await
        .unwrap();
    autonomy
        .set_goal(&id("ses_one"), Goal::new("Finish", None, None))
        .await
        .unwrap();
    let goal = autonomy.effective(&child).unwrap();
    assert!(goal.can_auto_answer() && goal.can_auto_permission() && !goal.can_auto_guardrail());
}

#[tokio::test]
async fn goal_continuation_waits_for_active_children() {
    use ycoding_core::session::autonomy::{Steer, SteerFuture, SteerRequest, continue_goal};
    struct Next;
    impl Steer for Next {
        fn steer(&self, _: SteerRequest) -> SteerFuture<'_> {
            Box::pin(async { Some("next".to_owned()) })
        }
    }
    let harness = harness();
    let autonomy = Autonomy::new(harness.store.client());
    autonomy
        .set_goal(&id("ses_one"), Goal::new("Finish", None, None))
        .await
        .unwrap();
    let child = launched(&harness, "call_1").await;
    assert!(
        continue_goal(
            &autonomy,
            &harness.sessions,
            &Next,
            &id("ses_one"),
            None,
            false
        )
        .await
        .unwrap()
        .is_none()
    );
    harness
        .service
        .settle(&child, Settlement::Completed { excerpt: None })
        .await
        .unwrap();
    assert!(
        continue_goal(
            &autonomy,
            &harness.sessions,
            &Next,
            &id("ses_one"),
            None,
            false
        )
        .await
        .unwrap()
        .is_some()
    );
}

fn task_row(store: &Store, session: &session::Id) -> ycoding_store::session::Task {
    store
        .snapshot()
        .unwrap()
        .get::<TaskTable>(&tuple_key(&[KeyPart::String(session.as_lossless())]))
        .unwrap()
        .unwrap()
}

async fn step(harness: &Harness, child: &session::Id, kind: &str, event: &str, fields: &str) {
    harness
        .sessions
        .publish(NewEvent {
            id: event.into(),
            aggregate_id: child.as_lossless().clone(),
            created: 70,
            type_: format!("{kind}.1").into(),
            data: parse_json(&format!(
                r#"{{"sessionID":"{}","assistantMessageID":"msg_asst"{fields}}}"#,
                child.as_lossless().as_str().unwrap()
            ))
            .unwrap(),
        })
        .await
        .unwrap();
}

async fn raw_launch(harness: &Harness, child: &str, call: &str) -> session::Id {
    let child = id(child);
    raw_change(
        harness,
        &child,
        &format!("evt_launch_{call}"),
        &format!(
            r#"{{"type":"launched","parentID":"ses_one","parentAssistantMessageID":"msg_parent","toolCallID":"{call}","inputID":"msg_input_{call}","description":"Raw","agent":"explore","model":{{"providerID":"local","id":"test"}},"promptDigest":"{}","background":true,"delivery":"steer"}}"#,
            "0".repeat(64)
        ),
    )
    .await
    .unwrap();
    child
}

async fn admit(harness: &Harness, child: &session::Id, message_id: &str) {
    harness
        .sessions
        .admit(ycoding_core::session::pending::Request {
            id: message(message_id),
            session_id: child.clone(),
            input: ycoding_schema::session_pending::Message::decode(
                &parse_json(r#"{"type":"user","data":{"text":"work"},"delivery":"steer"}"#)
                    .unwrap(),
            )
            .unwrap(),
            event_id: ycoding_schema::event::Id::new(format!("evt_{message_id}")).unwrap(),
            created: 60,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn deleting_a_child_session_removes_its_task_and_bumps_the_parent_revision() {
    let harness = harness();
    let child = launched(&harness, "call_1").await;
    let before = orchestration_revision(&harness.store, "ses_one");
    let delete = |session: &session::Id, event: &str| NewEvent {
        id: event.into(),
        aggregate_id: session.as_lossless().clone(),
        created: 80,
        type_: "session.deleted.2".into(),
        data: parse_json(&format!(
            r#"{{"sessionID":"{}"}}"#,
            session.as_lossless().as_str().unwrap()
        ))
        .unwrap(),
    };
    harness
        .sessions
        .publish(delete(&child, "evt_delete_child"))
        .await
        .unwrap();
    assert!(harness.sessions.get(&child).unwrap().is_none());
    assert!(harness.service.list(&id("ses_one")).unwrap().is_empty());
    assert_eq!(
        orchestration_revision(&harness.store, "ses_one"),
        before + 1
    );

    harness
        .sessions
        .publish(delete(&id("ses_two"), "evt_delete_other"))
        .await
        .unwrap();
    assert_eq!(
        orchestration_revision(&harness.store, "ses_one"),
        before + 1
    );
}

#[tokio::test]
async fn step_events_mark_and_clear_the_in_flight_attempt() {
    let harness = harness();
    let child = launched(&harness, "call_1").await;
    assert_eq!(task_row(&harness.store, &child).attempt_started, 0);
    step(
        &harness,
        &child,
        "session.step.started",
        "evt_step_start",
        r#","agent":"build","model":{"providerID":"local","id":"test"}"#,
    )
    .await;
    assert_eq!(task_row(&harness.store, &child).attempt_started, 1);
    step(
        &harness,
        &child,
        "session.step.ended",
        "evt_step_end",
        r#","finish":"stop","cost":0,"tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}"#,
    )
    .await;
    assert_eq!(task_row(&harness.store, &child).attempt_started, 0);
}

#[tokio::test]
async fn recovery_never_replays_an_in_flight_attempt_and_drains_only_durable_pending_work() {
    let harness = harness();
    let cancelling = launched(&harness, "call_cancelling").await;
    raw_change(
        &harness,
        &cancelling,
        "evt_cancel_requested",
        r#"{"type":"cancel_requested"}"#,
    )
    .await
    .unwrap();
    let in_flight = launched(&harness, "call_in_flight").await;
    step(
        &harness,
        &in_flight,
        "session.step.started",
        "evt_in_flight",
        r#","agent":"build","model":{"providerID":"local","id":"test"}"#,
    )
    .await;
    let pending = launched(&harness, "call_pending").await;
    let bare = launched(&harness, "call_bare").await;
    harness.sessions.promote_steers(&bare, 90).await.unwrap();
    let woken_before = harness.recorder.woken().len();

    assert_eq!(harness.service.recover().await.unwrap(), 4);
    let state = |child: &session::Id| harness.service.get(&id("ses_one"), child).unwrap().state;
    assert_eq!(state(&cancelling), State::Cancelled);
    assert_eq!(state(&in_flight), State::Lost);
    assert_eq!(state(&pending), State::Running);
    assert_eq!(state(&bare), State::Lost);
    let excerpts = notifications(&harness.store)
        .into_iter()
        .filter_map(|row| row.excerpt)
        .map(|text| text.to_utf8().unwrap())
        .collect::<Vec<_>>();
    assert!(
        excerpts
            .iter()
            .any(|text| text.contains("in-flight model attempt"))
    );
    assert!(
        excerpts
            .iter()
            .any(|text| text.contains("without durable pending work"))
    );
    assert_eq!(
        harness.recorder.woken()[woken_before..],
        [pending.as_lossless().as_str().unwrap()]
    );
}

#[tokio::test]
async fn recovery_restarts_terminal_and_starting_tasks_only_with_durable_pending_work() {
    let harness = harness();
    let finished = launched(&harness, "call_finished").await;
    let idle = launched(&harness, "call_idle").await;
    for child in [&finished, &idle] {
        harness.sessions.promote_steers(child, 90).await.unwrap();
        harness
            .service
            .settle(child, Settlement::Completed { excerpt: None })
            .await
            .unwrap();
    }
    admit(&harness, &finished, "msg_follow_up").await;
    let starting = raw_launch(&harness, "ses_two", "call_starting").await;
    admit(&harness, &starting, "msg_starting_work").await;
    let woken_before = harness.recorder.woken().len();

    assert_eq!(harness.service.recover().await.unwrap(), 2);
    let state = |child: &session::Id| harness.service.get(&id("ses_one"), child).unwrap().state;
    assert_eq!(state(&finished), State::Running);
    assert_eq!(state(&idle), State::Completed);
    assert_eq!(state(&starting), State::Running);
    assert_eq!(harness.recorder.woken().len(), woken_before + 2);
}

#[tokio::test]
async fn a_starting_task_without_durable_pending_work_is_started_then_lost() {
    let harness = harness();
    let starting = raw_launch(&harness, "ses_two", "call_starting").await;
    assert_eq!(harness.service.recover().await.unwrap(), 1);
    assert_eq!(
        harness
            .service
            .get(&id("ses_one"), &starting)
            .unwrap()
            .state,
        State::Lost
    );
    assert_eq!(task_row(&harness.store, &starting).revision, 2);
    assert!(harness.recorder.woken().is_empty());
}

async fn pin(harness: &Harness, child: &session::Id, event: &str, time: i64) {
    harness
        .sessions
        .publish(NewEvent {
            id: event.into(),
            aggregate_id: child.as_lossless().clone(),
            created: time,
            type_: "session.pinned.1".into(),
            data: parse_json(&format!(
                r#"{{"sessionID":"{}"}}"#,
                child.as_lossless().as_str().unwrap()
            ))
            .unwrap(),
        })
        .await
        .unwrap();
}

fn names(tasks: &[ycoding_schema::session_orchestration::Task]) -> Vec<String> {
    tasks
        .iter()
        .map(|task| task.session_id.as_lossless().as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn pages_rank_pinned_then_waiting_starting_running_cancelling_and_settled_with_symmetric_cursors()
 {
    let harness = harness();
    let mut children = Vec::new();
    for index in 0..12 {
        children.push(launched(&harness, &format!("call_{index:02}")).await);
    }
    harness
        .service
        .question(&children[1], "Pick", None)
        .await
        .unwrap();
    harness
        .service
        .settle(&children[2], Settlement::Completed { excerpt: None })
        .await
        .unwrap();
    raw_change(
        &harness,
        &children[3],
        "evt_cancelling",
        r#"{"type":"cancel_requested"}"#,
    )
    .await
    .unwrap();
    pin(&harness, &children[5], "evt_pin_late", 200).await;
    pin(&harness, &children[4], "evt_pin_early", 100).await;
    let starting = raw_launch(&harness, "ses_two", "call_starting").await;

    let first = harness.service.page(&id("ses_one"), None, None).unwrap();
    assert_eq!(first.data.len(), 10);
    assert_eq!(
        (
            first.summary.total.get(),
            first.summary.active.get(),
            first.summary.running.get(),
            first.summary.waiting.get()
        ),
        (13, 12, 9, 1)
    );
    assert_eq!(
        names(&first.data)[..4],
        names(&[
            harness.service.get(&id("ses_one"), &children[4]).unwrap(),
            harness.service.get(&id("ses_one"), &children[5]).unwrap(),
            harness.service.get(&id("ses_one"), &children[1]).unwrap(),
            harness.service.get(&id("ses_one"), &starting).unwrap(),
        ])
    );
    assert_eq!(first.data[0].pinned_at.map(|time| time.get()), Some(100));
    assert!(first.previous.is_none());
    let next = first.next.clone().unwrap();
    assert_eq!(
        (next.rank.0, next.direction.clone()),
        (2, ycoding_schema::session_orchestration::Direction::Next)
    );

    let second = harness
        .service
        .page(&id("ses_one"), None, Some(&next))
        .unwrap();
    assert_eq!(second.data.len(), 3);
    assert_eq!(
        second
            .data
            .iter()
            .map(|task| task.state.clone())
            .collect::<Vec<_>>()[1..],
        [State::Cancelling, State::Completed]
    );
    assert!(second.next.is_none());
    let previous = second.previous.clone().unwrap();
    let back = harness
        .service
        .page(&id("ses_one"), None, Some(&previous))
        .unwrap();
    assert_eq!(names(&back.data), names(&first.data));
    assert!(back.previous.is_none());
    assert_eq!(back.next, first.next);

    let mut walked = names(&first.data);
    walked.extend(names(&second.data));
    let mut every = names(&harness.service.list(&id("ses_one")).unwrap());
    walked.sort();
    every.sort();
    assert_eq!(walked, every);

    let small = harness.service.page(&id("ses_one"), Some(2), None).unwrap();
    assert_eq!(names(&small.data), names(&first.data)[..2]);
    assert!(
        harness
            .service
            .page(&id("ses_unknown"), None, None)
            .is_err()
    );
}

fn guarded(store: &Store, subagents: u64) -> Guardrails {
    let authority = Authority {
        store: store.client(),
        agents: Arc::new(|agent| {
            Some((agent.cloned().unwrap_or_else(|| "build".into()), Vec::new()))
        }),
    };
    let publisher: Publisher = Arc::new(|_| Ok(()));
    Guardrails::new(
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
                subagents,
                ..Limits::default()
            },
        },
        publisher,
    )
}

async fn reserved(guardrails: &Guardrails, call: &str) -> Result<Reservation, Error> {
    reserve(
        guardrails,
        &id("ses_one"),
        &"explore".into(),
        "Explore",
        &ToolCall {
            agent: "build".into(),
            message_id: "msg_parent".into(),
            call_id: call.into(),
        },
    )
    .await
}

fn subagents(guardrails: &Guardrails) -> i64 {
    guardrails
        .status(&id("ses_one"))
        .unwrap()
        .counters
        .iter()
        .find(|counter| counter.id.as_str() == Some("subagents"))
        .unwrap()
        .current
        .get()
}

async fn launch_holding(harness: &Harness, guardrails: &Guardrails, call: &str) -> session::Id {
    harness
        .service
        .launch(LaunchInput {
            guardrails: guardrails.clone(),
            ..input(harness, "ses_one", call, "Look around", 1, "[]")
        })
        .await
        .unwrap()
        .session_id
}

#[tokio::test]
async fn a_launched_child_holds_one_subagent_slot_and_the_limit_message_names_its_setting() {
    let harness = harness();
    let guardrails = guarded(&harness.store, 1);
    let child = launch_holding(&harness, &guardrails, "call_1").await;
    assert_eq!(subagents(&guardrails), 1);
    assert_eq!(
        harness
            .service
            .launch(LaunchInput {
                guardrails: guardrails.clone(),
                ..input(&harness, "ses_one", "call_2", "Look around", 1, "[]")
            })
            .await
            .err()
            .unwrap()
            .to_string(),
        "Subagent limit reached: 1/1 subagents running in this session family (call_1). Wait for or stop a running subagent, or raise guardrails.max_concurrent_subagents."
    );
    assert!(
        harness
            .sessions
            .get(&child_of("ses_one", "call_2"))
            .unwrap()
            .is_none()
    );
    assert_eq!(harness.recorder.woken().len(), 1);
    harness
        .service
        .settle(&child, Settlement::Completed { excerpt: None })
        .await
        .unwrap();
    assert_eq!(subagents(&guardrails), 0);
    reserved(&guardrails, "call_3").await.unwrap();
}

#[tokio::test]
async fn every_terminal_child_transition_releases_its_subagent_slot() {
    for ending in ["failed", "lost", "cancelled", "restart"] {
        let harness = harness();
        let guardrails = guarded(&harness.store, 1);
        let child = launch_holding(&harness, &guardrails, "call_1").await;
        assert_eq!(subagents(&guardrails), 1, "{ending}");
        match ending {
            "failed" => harness
                .service
                .settle(
                    &child,
                    Settlement::Failed {
                        error: "boom".into(),
                        excerpt: None,
                    },
                )
                .await
                .map(|_| ()),
            "lost" => harness
                .service
                .settle(&child, Settlement::Lost { excerpt: None })
                .await
                .map(|_| ()),
            "cancelled" => harness
                .service
                .cancel(&id("ses_one"), &child)
                .await
                .map(|_| ()),
            _ => {
                set_owner(&harness, &child, None, None).await;
                harness.service.reconcile_stale().await.map(|_| ())
            }
        }
        .unwrap();
        assert_eq!(subagents(&guardrails), 0, "{ending}");
    }
}

#[tokio::test]
async fn a_launch_that_does_not_create_a_child_releases_the_reserved_slot() {
    let harness = harness();
    let guardrails = guarded(&harness.store, 1);
    assert!(matches!(
        harness
            .service
            .launch(LaunchInput {
                guardrails: guardrails.clone(),
                ..input(&harness, "ses_one", "call_1", "Look around", 0, "[]")
            })
            .await,
        Err(Error::DepthLimit(0))
    ));
    assert_eq!(subagents(&guardrails), 0);
}

#[tokio::test]
async fn a_launch_retry_keeps_exactly_one_slot_for_the_child() {
    let harness = harness();
    let guardrails = guarded(&harness.store, 1);
    let child = launch_holding(&harness, &guardrails, "call_1").await;
    assert_eq!(launch_holding(&harness, &guardrails, "call_1").await, child);
    assert_eq!(subagents(&guardrails), 1);
    harness
        .service
        .settle(&child, Settlement::Completed { excerpt: None })
        .await
        .unwrap();
    assert_eq!(launch_holding(&harness, &guardrails, "call_1").await, child);
    assert_eq!(subagents(&guardrails), 0);
}

#[tokio::test]
async fn nested_launches_share_the_root_family_subagent_limit() {
    let harness = harness();
    let guardrails = guarded(&harness.store, 1);
    let child = launch_holding(&harness, &guardrails, "call_1").await;
    let child_name = child.as_lossless().as_str().unwrap();
    let error = harness
        .service
        .launch(LaunchInput {
            guardrails: guardrails.clone(),
            ..input(&harness, child_name, "call_nested", "Nested", 2, "[]")
        })
        .await
        .err()
        .unwrap();
    assert!(error.to_string().starts_with("Subagent limit reached: 1/1"));
    assert!(
        harness
            .sessions
            .get(&child_of(child_name, "call_nested"))
            .unwrap()
            .is_none()
    );
    assert_eq!(subagents(&guardrails), 1);
}

#[tokio::test]
async fn a_guardrail_rejection_other_than_capacity_names_the_target() {
    let harness = harness();
    let guardrails = guarded(&harness.store, 1);
    let missing = reserve(
        &guardrails,
        &id("ses_missing"),
        &"explore".into(),
        "Explore",
        &ToolCall {
            agent: "build".into(),
            message_id: "msg_parent".into(),
            call_id: "call_1".into(),
        },
    )
    .await;
    assert_eq!(
        missing.err().unwrap().to_string(),
        "Session guardrail rejected subagent: explore"
    );
}

#[tokio::test]
async fn a_failed_child_wake_releases_the_launch_reservation() {
    struct Closed;
    impl Execution for Closed {
        fn wake(&self, _: &session::Id) -> Outcome {
            Err(ycoding_core::session::run_coordinator::Error::Closed)
        }
        fn interrupt(&self, _: &session::Id) -> RunFuture {
            Box::pin(async { Ok(()) })
        }
    }
    let harness = harness();
    let guardrails = guarded(&harness.store, 1);
    let service = Service::new(harness.sessions.clone(), Arc::new(Closed));
    assert!(
        service
            .launch(LaunchInput {
                guardrails: guardrails.clone(),
                ..input(&harness, "ses_one", "call_1", "Look around", 1, "[]")
            })
            .await
            .is_err()
    );
    assert_eq!(subagents(&guardrails), 0);
}
