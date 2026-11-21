use std::sync::Arc;
use ycoding_core::{
    platform::shell::ledger,
    session::{
        orchestration::{
            Execution, Service, TEAM_VIEW_BYTES, render_team_observation, render_team_view,
        },
        run_coordinator::{Outcome, RunFuture},
        store,
    },
};
use ycoding_schema::{
    DomainDecode, LosslessString, parse_json, session,
    session_orchestration::{State, Task},
};
use ycoding_store::{
    KeyPart, Store,
    session::{NewEvent, NotificationTable, TaskTable},
    tuple_key,
};

#[path = "autonomy_support/mod.rs"]
mod support;

const RESUMED_EXCERPT: &str =
    "The service restarted while this subagent was working; it resumed with one recovery step.";

struct Silent;

impl Execution for Silent {
    fn resume(&self, _: &session::Id) -> RunFuture {
        panic!("unexpected explicit resumption")
    }

    fn wake(&self, _: &session::Id) -> Outcome {
        Ok(())
    }
    fn interrupt(&self, _: &session::Id) -> RunFuture {
        Box::pin(async { Ok(()) })
    }
}

struct Harness {
    store: Store,
    sessions: store::Service,
    service: Service,
}

fn harness() -> Harness {
    let store = support::store();
    let sessions = store::Service::new(store.client());
    Harness {
        service: Service::new(sessions.clone(), Arc::new(Silent)),
        store,
        sessions,
    }
}

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
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

async fn launched(harness: &Harness, name: &str) -> session::Id {
    let child = id(name);
    raw_change(
        harness,
        &child,
        &format!("evt_launch_{name}"),
        &format!(
            r#"{{"type":"launched","parentID":"ses_one","parentAssistantMessageID":"msg_parent","toolCallID":"call_{name}","inputID":"msg_input_{name}","description":"Raw","agent":"explore","model":{{"providerID":"local","id":"test"}},"promptDigest":"{}","background":true,"delivery":"steer"}}"#,
            "0".repeat(64)
        ),
    )
    .await
    .unwrap();
    child
}

async fn running_child(harness: &Harness, name: &str) -> session::Id {
    let child = launched(harness, name).await;
    raw_change(
        harness,
        &child,
        &format!("evt_started_{name}"),
        r#"{"type":"started"}"#,
    )
    .await
    .unwrap();
    child
}

async fn ask(harness: &Harness, child: &session::Id, question: &str) {
    raw_change(
        harness,
        child,
        &format!("evt_ask_{question}"),
        &format!(r#"{{"type":"question_asked","question":{{"id":"{question}","text":"which?","time":99}}}}"#),
    )
    .await
    .unwrap();
}

fn row(store: &Store, child: &session::Id) -> ycoding_store::session::Task {
    store
        .snapshot()
        .unwrap()
        .get::<TaskTable>(&tuple_key(&[KeyPart::String(child.as_lossless())]))
        .unwrap()
        .unwrap()
}

fn notices(store: &Store) -> Vec<ycoding_store::session::Notification> {
    store
        .snapshot()
        .unwrap()
        .scan::<NotificationTable>(std::ops::Bound::Unbounded, std::ops::Bound::Unbounded, 100)
        .unwrap()
}

async fn stale_owner(harness: &Harness, child: &session::Id) {
    let mut stale = row(&harness.store, child);
    stale.owner_pid = Some(2_000_000_000);
    stale.owner_started = Some("dead".into());
    harness
        .store
        .submit(move |tx| TaskTable::put(tx, &stale))
        .unwrap()
        .await
        .unwrap();
}

async fn current_owner() -> (Option<i64>, Option<LosslessString>) {
    let identity = ledger::identify(std::process::id()).await.unwrap();
    (
        Some(i64::from(identity.pid)),
        Some(LosslessString::from(identity.started)),
    )
}

#[tokio::test]
async fn a_question_timeout_resumes_the_task_like_an_answer_without_a_notification() {
    let harness = harness();
    let child = running_child(&harness, "ses_two").await;
    ask(&harness, &child, "qst_open").await;
    assert_eq!(
        harness.service.get(&id("ses_one"), &child).unwrap().state,
        State::Waiting
    );
    let notices_before = notices(&harness.store).len();

    for (event, question) in [
        ("evt_timeout_wrong", "qst_other"),
        ("evt_timeout_unknown", "qst_missing"),
    ] {
        assert!(
            raw_change(
                &harness,
                &child,
                event,
                &format!(r#"{{"type":"question_timed_out","questionID":"{question}"}}"#),
            )
            .await
            .is_err(),
            "{question}"
        );
    }
    assert_eq!(
        harness.service.get(&id("ses_one"), &child).unwrap().state,
        State::Waiting
    );

    stale_owner(&harness, &child).await;
    raw_change(
        &harness,
        &child,
        "evt_timeout",
        r#"{"type":"question_timed_out","questionID":"qst_open"}"#,
    )
    .await
    .unwrap();
    let task = harness.service.get(&id("ses_one"), &child).unwrap();
    assert_eq!(task.state, State::Running);
    assert!(task.question.is_none());
    let stored = row(&harness.store, &child);
    assert_eq!(
        (stored.owner_pid, stored.owner_started),
        current_owner().await
    );
    assert!(stored.question_id.is_none() && stored.question_time.is_none());
    assert_eq!(notices(&harness.store).len(), notices_before);

    assert!(
        raw_change(
            &harness,
            &child,
            "evt_timeout_again",
            r#"{"type":"question_timed_out","questionID":"qst_open"}"#,
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn a_resumed_task_clears_the_attempt_claims_ownership_and_notifies_the_parent_once() {
    let harness = harness();
    let child = running_child(&harness, "ses_two").await;
    harness
        .sessions
        .publish(NewEvent {
            id: "evt_attempt".into(),
            aggregate_id: child.as_lossless().clone(),
            created: 70,
            type_: "session.step.started.1".into(),
            data: parse_json(&format!(
                r#"{{"sessionID":"{}","assistantMessageID":"msg_asst","agent":"build","model":{{"providerID":"local","id":"test"}}}}"#,
                child.as_lossless().as_str().unwrap()
            ))
            .unwrap(),
        })
        .await
        .unwrap();
    assert_eq!(row(&harness.store, &child).attempt_started, 1);
    stale_owner(&harness, &child).await;
    let revision = row(&harness.store, &child).revision;

    raw_change(&harness, &child, "evt_resumed", r#"{"type":"resumed"}"#)
        .await
        .unwrap();
    let stored = row(&harness.store, &child);
    assert_eq!(stored.state.as_str(), Some("running"));
    assert_eq!(stored.attempt_started, 0);
    assert_eq!(stored.revision, revision + 1);
    assert_eq!(
        (stored.owner_pid, stored.owner_started),
        current_owner().await
    );
    let resumed = notices(&harness.store)
        .into_iter()
        .filter(|notice| notice.type_.as_str() == Some("resumed"))
        .collect::<Vec<_>>();
    assert_eq!(resumed.len(), 1);
    assert_eq!(resumed[0].revision, stored.revision);
    assert_eq!(
        resumed[0].excerpt.as_ref().and_then(|text| text.as_str()),
        Some(RESUMED_EXCERPT)
    );

    assert_eq!(harness.service.dispatch_notifications().await.unwrap(), 1);
    let delivered = harness
        .sessions
        .pending_list(&id("ses_one"))
        .unwrap()
        .into_iter()
        .map(|row| ycoding_schema::stringify_json(&row.data))
        .collect::<Vec<_>>();
    assert_eq!(delivered.len(), 1);
    assert!(
        delivered[0].contains(r#""type":"resumed""#),
        "{}",
        delivered[0]
    );
    assert!(delivered[0].contains("recovery step"), "{}", delivered[0]);
}

#[tokio::test]
async fn resumption_requires_a_running_task() {
    for waiting in [true, false] {
        let harness = harness();
        let child = if waiting {
            let child = running_child(&harness, "ses_two").await;
            ask(&harness, &child, "qst_wait").await;
            child
        } else {
            launched(&harness, "ses_two").await
        };
        let before = row(&harness.store, &child);
        assert!(
            raw_change(&harness, &child, "evt_resume", r#"{"type":"resumed"}"#)
                .await
                .is_err(),
            "waiting: {waiting}"
        );
        let after = row(&harness.store, &child);
        assert_eq!(
            (after.state.as_str(), after.revision),
            (before.state.as_str(), before.revision)
        );
        assert!(
            notices(&harness.store)
                .iter()
                .all(|notice| notice.type_.as_str() != Some("resumed"))
        );
    }
}

fn reviewed_task(question: Option<&str>, state: &str) -> Task {
    let question = question.map_or(String::new(), |question| {
        format!(r#""question":{question},"#)
    });
    Task::decode(
        &parse_json(&format!(
            r#"{{"sessionID":"ses_two","parentID":"ses_one","description":"Raw","agent":"explore","model":{{"providerID":"local","id":"test"}},"background":true,"state":"{state}",{question}"revision":3,"time":{{"created":1,"updated":2}},"stoppedRecovery":{{"itemID":"rvw_stopped"}}}}"#
        ))
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn team_views_expose_review_state_and_observations_expose_only_deferred_questions() {
    let deferred = reviewed_task(
        Some(r#"{"id":"qst_def","text":"which?","time":5,"deferred":true}"#),
        "waiting",
    );
    assert_eq!(deferred.question.as_ref().unwrap().deferred, Some(true));
    let observed = render_team_observation(std::slice::from_ref(&deferred), TEAM_VIEW_BYTES);
    assert!(
        observed.text.contains(r#""deferred":true"#),
        "{}",
        observed.text
    );
    assert!(!observed.text.contains("stoppedRecovery"));
    assert!(!observed.text.contains("rvw_stopped"));

    let live = reviewed_task(
        Some(r#"{"id":"qst_live","text":"which?","time":5}"#),
        "waiting",
    );
    let observed = render_team_observation(std::slice::from_ref(&live), TEAM_VIEW_BYTES);
    assert!(!observed.text.contains("deferred"), "{}", observed.text);

    let stopped = reviewed_task(None, "lost");
    let view = render_team_view(std::slice::from_ref(&stopped), TEAM_VIEW_BYTES).unwrap();
    assert!(
        view.text
            .contains(r#""stoppedRecovery":{"itemID":"rvw_stopped"}"#),
        "{}",
        view.text
    );
    assert_eq!(
        stopped
            .stopped_recovery
            .as_ref()
            .map(|recovery| recovery.item_id.as_lossless().as_str()),
        Some(Some("rvw_stopped"))
    );
}
