use std::{ops::Bound, sync::Arc};
use ycoding_core::{
    platform::{
        keep_awake,
        process::{Command, Input, Output},
    },
    session::{
        autonomy::{Goal, GoalChange, Origin, ReviewKind, Service, State, YoloLevel},
        pending::Request,
        store,
    },
};
use ycoding_schema::{
    DomainDecode, JsonValue, ObjectEncoder, parse_json, session, session_message, session_pending,
};
use ycoding_store::{
    KeyPart, Store,
    session::{EventTable, SessionTable},
    tuple_key,
};

#[path = "autonomy_support/mod.rs"]
mod support;

const ACTIVE_GOAL: &str = r#"{"text":"Finish safely","rawText":"Finish safely","iteration":0,"noProgress":0,"maxNoProgress":3,"status":"active"}"#;

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn family() -> Store {
    let store = support::store();
    store
        .submit(|tx| {
            let mut child = support::record("ses_child");
            child.parent_id = Some("ses_one".into());
            SessionTable::insert(tx, &child)?;
            let mut grandchild = support::record("ses_grandchild");
            grandchild.parent_id = Some("ses_child".into());
            SessionTable::insert(tx, &grandchild)
        })
        .unwrap()
        .wait()
        .unwrap();
    store
}

fn stored(store: &Store, session: &str) -> Option<JsonValue> {
    store
        .snapshot()
        .unwrap()
        .get::<SessionTable>(&tuple_key(&[KeyPart::String(&session.into())]))
        .unwrap()
        .unwrap()
        .autonomy
}

fn put_autonomy(store: &Store, session: &'static str, autonomy: &str) {
    let autonomy = parse_json(autonomy).unwrap();
    store
        .submit(move |tx| {
            let mut row = tx
                .get::<SessionTable>(&tuple_key(&[KeyPart::String(&session.into())]))?
                .unwrap();
            row.autonomy = Some(autonomy);
            SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn has(value: &JsonValue, key: &str) -> bool {
    matches!(value, JsonValue::Object(object) if object.get(&key.into()).is_some())
}

fn observations(store: &Store, session: &str) -> Vec<String> {
    let mut rows = store
        .snapshot()
        .unwrap()
        .scan::<EventTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
        .unwrap()
        .into_iter()
        .filter(|event| {
            event.aggregate_id.as_str() == Some(session)
                && event.type_.as_str() == Some("session.context.observed.1")
        })
        .map(|event| (event.seq, event.data))
        .collect::<Vec<_>>();
    rows.sort_by_key(|row| row.0);
    rows.into_iter()
        .filter_map(|(_, data)| {
            let JsonValue::Object(data) = data else {
                return None;
            };
            (data.get(&"source".into()) == Some(&JsonValue::String("session-state".into()))).then(
                || match data.get(&"text".into()) {
                    Some(JsonValue::String(text)) => text.to_utf8().unwrap(),
                    _ => panic!("session-state observation without text"),
                },
            )
        })
        .collect()
}

fn keep_awake() -> keep_awake::Service {
    keep_awake::Service::with_command(
        true,
        Arc::new(|| {
            let mut command = Command::new("/bin/sleep", ["3600"]);
            command.stdin = Input::Ignore;
            command.stdout = Output::Ignore;
            command.stderr = Output::Ignore;
            command
        }),
    )
}

fn held(awake: &keep_awake::Service) -> bool {
    awake.get().sleep_hold == Some(true)
}

fn input(session: &str, message: &str, kind: &str) -> Request {
    Request {
        id: session_message::Id::new(message).unwrap(),
        session_id: id(session),
        input: session_pending::Message::decode(
            &ObjectEncoder::new()
                .field("type", kind)
                .field(
                    "data",
                    &ObjectEncoder::new().field("text", "Back now").finish(),
                )
                .field("delivery", "steer")
                .finish(),
        )
        .unwrap(),
        event_id: ycoding_schema::event::Id::new(format!("evt_{message}")).unwrap(),
        created: 1,
    }
}

#[tokio::test]
async fn any_member_switches_the_root_family_marker_and_every_descendant_reads_it() {
    let store = family();
    let service = Service::new(store.client());
    service
        .set_yolo(&id("ses_child"), YoloLevel::GUARDRAILS)
        .await
        .unwrap();

    let state = service.set_sleep(&id("ses_child"), true).await.unwrap();
    assert!(state.is_asleep());
    assert_eq!(state.yolo, YoloLevel::GUARDRAILS);
    assert!(has(stored(&store, "ses_one").as_ref().unwrap(), "sleep"));
    assert!(
        stored(&store, "ses_child")
            .as_ref()
            .is_none_or(|value| !has(value, "sleep"))
    );
    for member in ["ses_one", "ses_child", "ses_grandchild"] {
        assert!(service.get(&id(member)).unwrap().is_asleep(), "{member}");
        assert!(service.effective(&id(member)).unwrap().asleep, "{member}");
    }
    assert!(!service.get(&id("ses_two")).unwrap().is_asleep());
    assert!(!service.effective(&id("ses_two")).unwrap().asleep);
    assert_eq!(
        service.get(&id("ses_child")).unwrap().yolo,
        YoloLevel::GUARDRAILS
    );

    let woken = service
        .set_sleep(&id("ses_grandchild"), false)
        .await
        .unwrap();
    assert!(!woken.is_asleep());
    for member in ["ses_one", "ses_child", "ses_grandchild"] {
        assert!(!service.get(&id(member)).unwrap().is_asleep(), "{member}");
    }
    assert!(!has(stored(&store, "ses_one").as_ref().unwrap(), "sleep"));
}

#[tokio::test]
async fn waking_preserves_yolo_and_goal_and_never_restores_legacy_delegation() {
    let store = family();
    put_autonomy(
        &store,
        "ses_one",
        &format!(
            r#"{{"mode":"normal","yolo":2,"guardrailDecision":false,"sleep":{{"priorGuardrailDecision":true}},"goal":{ACTIVE_GOAL}}}"#
        ),
    );
    let service = Service::new(store.client());
    let before = service.get(&id("ses_one")).unwrap();
    assert!(before.is_asleep());
    assert!(
        !service
            .effective(&id("ses_one"))
            .unwrap()
            .can_auto_guardrail()
    );

    let changed = service
        .set_yolo(&id("ses_one"), YoloLevel::APPROVALS)
        .await
        .unwrap();
    assert!(changed.is_asleep());

    let woken = service.set_sleep(&id("ses_one"), false).await.unwrap();
    assert!(!woken.is_asleep());
    assert_eq!(woken.yolo, YoloLevel::APPROVALS);
    assert_eq!(woken.goal, before.goal);
    let encoded = stored(&store, "ses_one").unwrap();
    assert!(!has(&encoded, "guardrailDecision"));
    assert!(!has(&encoded, "sleep"));
    assert_eq!(State::read(Some(&encoded)), woken);
    let effective = service.effective(&id("ses_one")).unwrap();
    assert!(!effective.asleep);
    assert!(effective.can_auto_permission());
    assert!(!effective.can_auto_guardrail());
}

#[tokio::test]
async fn sleep_holds_keep_awake_for_the_root_until_it_wakes_and_restores_holds_on_restart() {
    let store = family();
    let awake = keep_awake();
    let service = Service::new(store.client()).with_keep_awake(awake.clone());
    assert!(!held(&awake));
    service.set_sleep(&id("ses_child"), true).await.unwrap();
    assert!(held(&awake));
    service.set_sleep(&id("ses_one"), true).await.unwrap();
    assert!(held(&awake));
    service
        .set_sleep(&id("ses_grandchild"), false)
        .await
        .unwrap();
    assert!(!held(&awake));
    service.set_sleep(&id("ses_one"), true).await.unwrap();
    awake.close().await;

    let restarted = keep_awake();
    let service = Service::new(store.client()).with_keep_awake(restarted.clone());
    assert!(!held(&restarted));
    service.rehydrate().await.unwrap();
    assert!(held(&restarted));
    restarted.close().await;
}

#[tokio::test]
async fn an_archived_sleeping_root_is_not_held_on_restart() {
    let store = support::store();
    put_autonomy(
        &store,
        "ses_two",
        r#"{"mode":"normal","yolo":0,"sleep":{}}"#,
    );
    store
        .submit(|tx| {
            let mut row = tx
                .get::<SessionTable>(&tuple_key(&[KeyPart::String(&"ses_two".into())]))?
                .unwrap();
            row.time_archived = Some(5);
            SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    let awake = keep_awake();
    let service = Service::new(store.client()).with_keep_awake(awake.clone());
    service.rehydrate().await.unwrap();
    assert!(!held(&awake));
    awake.close().await;
}

#[tokio::test]
async fn every_family_member_observes_each_transition_once() {
    let store = family();
    let service = Service::new(store.client());
    service.set_sleep(&id("ses_one"), true).await.unwrap();
    service.set_sleep(&id("ses_child"), true).await.unwrap();
    for member in ["ses_one", "ses_child", "ses_grandchild"] {
        let texts = observations(&store, member);
        assert_eq!(texts.len(), 1, "{member}");
        assert!(texts[0].contains("asleep"), "{member}: {}", texts[0]);
        for claim in ["decision model", "guardrail-decision", "guardrailDecision"] {
            assert!(!texts[0].contains(claim), "{member}: {}", texts[0]);
        }
    }
    service
        .set_sleep(&id("ses_grandchild"), false)
        .await
        .unwrap();
    for member in ["ses_one", "ses_child", "ses_grandchild"] {
        let texts = observations(&store, member);
        assert_eq!(texts.len(), 2, "{member}");
        assert!(texts[1].contains("back"), "{member}: {}", texts[1]);
        assert!(!texts[1].contains("restore"), "{member}: {}", texts[1]);
    }
    assert!(observations(&store, "ses_two").is_empty());
}

#[tokio::test]
async fn only_new_user_input_from_the_user_wakes_the_family() {
    let store = family();
    let awake = keep_awake();
    let service = Service::new(store.client()).with_keep_awake(awake.clone());
    let sessions = store::Service::new(store.client());
    service.set_sleep(&id("ses_one"), true).await.unwrap();

    for (message, kind, origin) in [
        ("msg_subagent", "user", Origin::Subagent),
        ("msg_plugin", "user", Origin::Plugin),
        ("msg_review", "user", Origin::Review),
        ("msg_synthetic", "synthetic", Origin::User),
    ] {
        service
            .admit(&sessions, input("ses_child", message, kind), None, origin)
            .await
            .unwrap();
        assert!(
            service.get(&id("ses_one")).unwrap().is_asleep(),
            "{message}"
        );
        assert!(held(&awake), "{message}");
    }

    let admitted = service
        .admit(
            &sessions,
            input("ses_child", "msg_user", "user"),
            None,
            Origin::User,
        )
        .await
        .unwrap();
    assert_eq!(admitted.pending.id.as_str(), Some("msg_user"));
    for member in ["ses_one", "ses_child", "ses_grandchild"] {
        assert!(!service.get(&id(member)).unwrap().is_asleep(), "{member}");
    }
    assert!(!held(&awake));
    assert!(
        sessions
            .pending_list(&id("ses_child"))
            .unwrap()
            .iter()
            .any(|row| row.id.as_str() == Some("msg_user"))
    );
    awake.close().await;
}

#[tokio::test]
async fn a_retried_prompt_reusing_its_message_id_does_not_wake_a_family_put_to_sleep_afterwards() {
    let store = family();
    let service = Service::new(store.client());
    let sessions = store::Service::new(store.client());
    service
        .admit(
            &sessions,
            input("ses_one", "msg_original", "user"),
            None,
            Origin::User,
        )
        .await
        .unwrap();
    service.set_sleep(&id("ses_one"), true).await.unwrap();

    let retried = service
        .admit(
            &sessions,
            input("ses_one", "msg_original", "user"),
            None,
            Origin::User,
        )
        .await
        .unwrap();
    assert_eq!(retried.pending.id.as_str(), Some("msg_original"));
    assert!(service.get(&id("ses_one")).unwrap().is_asleep());

    service
        .admit(
            &sessions,
            input("ses_one", "msg_fresh", "user"),
            None,
            Origin::User,
        )
        .await
        .unwrap();
    assert!(!service.get(&id("ses_one")).unwrap().is_asleep());
}

fn state(json: &str) -> State {
    State::read(Some(&parse_json(json).unwrap()))
}

#[test]
fn state_sleep_transitions_preserve_yolo_and_goal_and_restore_nothing() {
    let awake = state(&format!(
        r#"{{"mode":"normal","yolo":2,"goal":{ACTIVE_GOAL}}}"#
    ));
    assert!(!awake.is_asleep());
    assert_eq!(awake.set_sleep(false), None);

    let asleep = awake.set_sleep(true).unwrap();
    assert!(asleep.is_asleep());
    assert_eq!(asleep.yolo, awake.yolo);
    assert_eq!(asleep.goal, awake.goal);
    assert_eq!(asleep.set_sleep(true), None);
    assert_eq!(asleep.set_sleep(false).unwrap(), awake);

    let legacy = state(&format!(
        r#"{{"mode":"normal","yolo":1,"guardrailDecision":false,"sleep":{{"priorGuardrailDecision":true}},"goal":{ACTIVE_GOAL}}}"#
    ));
    assert!(legacy.is_asleep());
    let woken = legacy.set_sleep(false).unwrap();
    assert!(!woken.is_asleep());
    assert_eq!(woken.yolo, YoloLevel::APPROVALS);
    assert_eq!(woken.goal, legacy.goal);
    let encoded = woken.encode();
    assert!(!has(&encoded, "guardrailDecision"));
    assert!(!has(&encoded, "sleep"));
}

#[test]
fn a_sleeping_state_withholds_yolo_guardrail_approval_but_keeps_permission_settlement() {
    let awake = state(r#"{"mode":"normal","yolo":2}"#).effective();
    assert!(!awake.asleep);
    assert!(awake.can_auto_guardrail());
    assert!(awake.can_auto_permission());

    let asleep = state(r#"{"mode":"normal","yolo":2,"sleep":{}}"#).effective();
    assert!(asleep.asleep);
    assert!(!asleep.can_auto_guardrail());
    assert!(!asleep.can_auto_review(ReviewKind::Ordinary));
    assert!(!asleep.can_auto_review(ReviewKind::Hard));
    assert!(asleep.can_auto_permission());

    let goal = state(&format!(
        r#"{{"mode":"normal","yolo":0,"sleep":{{}},"goal":{ACTIVE_GOAL}}}"#
    ))
    .effective();
    assert!(goal.asleep);
    assert!(!goal.can_auto_permission());
    assert!(!goal.can_auto_guardrail());
}

fn child_stores_no_marker(store: &Store) {
    assert!(
        stored(store, "ses_child")
            .as_ref()
            .is_none_or(|value| !has(value, "sleep"))
    );
}

#[tokio::test]
async fn child_mutation_results_report_the_inherited_marker_without_storing_it() {
    let store = family();
    let service = Service::new(store.client());
    service.set_sleep(&id("ses_one"), true).await.unwrap();
    let root_before = stored(&store, "ses_one").unwrap();
    let child = id("ses_child");

    let applied = service
        .set_yolo(&child, YoloLevel::GUARDRAILS)
        .await
        .unwrap();
    assert!(applied.is_asleep());
    assert_eq!(applied.yolo, YoloLevel::GUARDRAILS);
    let unchanged = service
        .set_yolo(&child, YoloLevel::GUARDRAILS)
        .await
        .unwrap();
    assert!(unchanged.is_asleep());

    let goal = service
        .set_goal(&child, Goal::new("Finish safely", None, None))
        .await
        .unwrap();
    assert!(goal.is_asleep());
    assert!(
        service
            .change(&child, Some(YoloLevel::APPROVALS), None)
            .await
            .unwrap()
            .is_asleep()
    );
    assert!(service.report(&child).await.unwrap().is_asleep());
    assert!(service.advance(&child).await.unwrap().is_asleep());
    assert!(service.complete(&child).await.unwrap().is_asleep());
    assert!(
        service.complete(&child).await.unwrap().is_asleep(),
        "a no-op transition reports the family marker"
    );
    assert!(service.stop(&child).await.unwrap().is_asleep());
    assert!(
        service
            .change(&child, None, Some(GoalChange::Resume))
            .await
            .unwrap()
            .is_asleep()
    );

    child_stores_no_marker(&store);
    assert_eq!(stored(&store, "ses_one").unwrap(), root_before);
    assert!(service.get(&child).unwrap().is_asleep());
}

#[tokio::test]
async fn conditional_child_mutations_report_the_inherited_marker_when_applied_or_stale() {
    let store = family();
    let service = Service::new(store.client());
    service.set_sleep(&id("ses_one"), true).await.unwrap();
    let child = id("ses_child");

    let snapshot = service.snapshot(&child).unwrap();
    let applied = service
        .set_goal_if_current(
            &child,
            snapshot.sequence,
            Some(YoloLevel::GUARDRAILS),
            Goal::new("Finish safely", None, None),
        )
        .await
        .unwrap();
    assert!(applied.applied);
    assert!(applied.state.is_asleep());

    let stale = service
        .set_goal_if_current(
            &child,
            snapshot.sequence,
            None,
            Goal::new("Replace", None, None),
        )
        .await
        .unwrap();
    assert!(!stale.applied);
    assert!(stale.state.is_asleep());
    assert_eq!(
        stale.state.goal.as_ref().unwrap().text.as_str(),
        Some("Finish safely")
    );

    let current = service.snapshot(&child).unwrap().sequence;
    let advanced = service.advance_if_current(&child, current).await.unwrap();
    assert!(advanced.applied);
    assert!(advanced.state.is_asleep());
    let stale = service.advance_if_current(&child, current).await.unwrap();
    assert!(!stale.applied);
    assert!(stale.state.is_asleep());

    service.stop(&child).await.unwrap();
    let stale = service
        .resume_goal_if_current(&child, current, None)
        .await
        .unwrap();
    assert!(!stale.applied);
    assert!(stale.state.is_asleep());
    let current = service.snapshot(&child).unwrap().sequence;
    let resumed = service
        .resume_goal_if_current(&child, current, None)
        .await
        .unwrap();
    assert!(resumed.applied);
    assert!(resumed.state.is_asleep());

    child_stores_no_marker(&store);
}

#[tokio::test]
async fn child_mutation_results_stay_awake_in_an_awake_family() {
    let store = family();
    let service = Service::new(store.client());
    let child = id("ses_child");
    assert!(
        !service
            .set_yolo(&child, YoloLevel::GUARDRAILS)
            .await
            .unwrap()
            .is_asleep()
    );
    let snapshot = service.snapshot(&child).unwrap();
    let stale = service
        .advance_if_current(&child, snapshot.sequence - 1)
        .await
        .unwrap();
    assert!(!stale.applied);
    assert!(!stale.state.is_asleep());
    child_stores_no_marker(&store);
}
