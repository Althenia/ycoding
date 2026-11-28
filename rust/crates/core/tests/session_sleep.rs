use std::{ops::Bound, sync::Arc};
use ycoding_core::{
    platform::{
        keep_awake,
        process::{Command, Input, Output},
    },
    session::{
        autonomy::{DecisionChange, DecisionMode, Goal, GoalChange, Origin, Service, State},
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

#[path = "decision_support/mod.rs"]
mod modes;
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
    awake.get().defer_hold == Some(true)
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
    set_rules(&service, &id("ses_child"), 2).await;

    let state = service.set_defer(&id("ses_child"), true).await.unwrap();
    assert!(state.is_deferred());
    assert_eq!(
        (state.permissions, state.guardrails),
        (DecisionMode::Auto, DecisionMode::Auto)
    );
    assert!(has(stored(&store, "ses_one").as_ref().unwrap(), "defer"));
    assert!(
        stored(&store, "ses_child")
            .as_ref()
            .is_none_or(|value| !has(value, "defer"))
    );
    for member in ["ses_one", "ses_child", "ses_grandchild"] {
        assert!(service.get(&id(member)).unwrap().is_deferred(), "{member}");
        assert!(service.effective(&id(member)).unwrap().deferred, "{member}");
    }
    assert!(!service.get(&id("ses_two")).unwrap().is_deferred());
    assert!(!service.effective(&id("ses_two")).unwrap().deferred);
    let child = service.get(&id("ses_child")).unwrap();
    assert_eq!(
        (child.permissions, child.guardrails),
        (DecisionMode::Auto, DecisionMode::Auto)
    );

    let woken = service
        .set_defer(&id("ses_grandchild"), false)
        .await
        .unwrap();
    assert!(!woken.is_deferred());
    for member in ["ses_one", "ses_child", "ses_grandchild"] {
        assert!(!service.get(&id(member)).unwrap().is_deferred(), "{member}");
    }
    assert!(!has(stored(&store, "ses_one").as_ref().unwrap(), "defer"));
}

#[tokio::test]
async fn waking_preserves_modes_and_goal_and_never_restores_legacy_delegation() {
    let store = family();
    put_autonomy(
        &store,
        "ses_one",
        &format!(
            r#"{{"mode":"normal","permissions":"auto","guardrails":"auto","answers":"manual","guardrailDecision":false,"sleep":{{"priorGuardrailDecision":true}},"goal":{ACTIVE_GOAL}}}"#
        ),
    );
    let service = Service::new(store.client());
    let before = service.get(&id("ses_one")).unwrap();
    assert!(before.is_deferred());
    assert!(
        !service
            .effective(&id("ses_one"))
            .unwrap()
            .can_auto_guardrail()
    );

    let changed = set_rules(&service, &id("ses_one"), 1).await;
    assert!(changed.is_deferred());

    let woken = service.set_defer(&id("ses_one"), false).await.unwrap();
    assert!(!woken.is_deferred());
    assert_eq!(
        (woken.permissions, woken.guardrails),
        (DecisionMode::Auto, DecisionMode::Manual)
    );
    assert_eq!(woken.goal, before.goal);
    let encoded = stored(&store, "ses_one").unwrap();
    assert!(!has(&encoded, "guardrailDecision"));
    assert!(!has(&encoded, "defer"));
    assert_eq!(State::read(Some(&encoded)), woken);
    let effective = service.effective(&id("ses_one")).unwrap();
    assert!(!effective.deferred);
    assert!(effective.can_auto_permission());
    assert!(!effective.can_auto_guardrail());
}

#[tokio::test]
async fn defer_holds_keep_awake_for_the_root_until_disabled_and_restores_holds_on_restart() {
    let store = family();
    let awake = keep_awake();
    let service = Service::new(store.client()).with_keep_awake(awake.clone());
    assert!(!held(&awake));
    service.set_defer(&id("ses_child"), true).await.unwrap();
    assert!(held(&awake));
    service.set_defer(&id("ses_one"), true).await.unwrap();
    assert!(held(&awake));
    service
        .set_defer(&id("ses_grandchild"), false)
        .await
        .unwrap();
    assert!(!held(&awake));
    service.set_defer(&id("ses_one"), true).await.unwrap();
    awake.close().await;

    let restarted = keep_awake();
    let service = Service::new(store.client()).with_keep_awake(restarted.clone());
    assert!(!held(&restarted));
    service.rehydrate().await.unwrap();
    assert!(held(&restarted));
    store::Service::new(store.client())
        .remove(&id("ses_one"))
        .await
        .unwrap();
    assert!(!held(&restarted));
    restarted.close().await;
}

#[tokio::test]
async fn an_archived_deferred_root_restores_its_hold_on_restart() {
    let store = support::store();
    put_autonomy(
        &store,
        "ses_two",
        r#"{"mode":"normal","permissions":"manual","guardrails":"manual","answers":"manual","defer":{}}"#,
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
    assert!(service.get(&id("ses_two")).unwrap().is_deferred());
    assert!(held(&awake));
    awake.close().await;
}

#[tokio::test]
async fn every_family_member_observes_each_transition_once() {
    let store = family();
    let service = Service::new(store.client());
    service.set_defer(&id("ses_one"), true).await.unwrap();
    service.set_defer(&id("ses_child"), true).await.unwrap();
    for member in ["ses_one", "ses_child", "ses_grandchild"] {
        let texts = observations(&store, member);
        assert_eq!(texts.len(), 1, "{member}");
        assert!(texts[0].contains("Defer is on"), "{member}: {}", texts[0]);
        for claim in ["decision model", "guardrail-decision", "guardrailDecision"] {
            assert!(!texts[0].contains(claim), "{member}: {}", texts[0]);
        }
    }
    service
        .set_defer(&id("ses_grandchild"), false)
        .await
        .unwrap();
    for member in ["ses_one", "ses_child", "ses_grandchild"] {
        let texts = observations(&store, member);
        assert_eq!(texts.len(), 2, "{member}");
        assert!(texts[1].contains("Defer is off"), "{member}: {}", texts[1]);
        assert!(texts[1].contains(
            "Unresolved requests return to the decision surface under the current autonomy modes"
        ));
        assert!(!texts[1].contains("restore"), "{member}: {}", texts[1]);
    }
    assert!(observations(&store, "ses_two").is_empty());
}

#[tokio::test]
async fn fresh_user_input_and_other_origins_preserve_family_defer() {
    let store = family();
    let awake = keep_awake();
    let service = Service::new(store.client()).with_keep_awake(awake.clone());
    let sessions = store::Service::new(store.client());
    service.set_defer(&id("ses_one"), true).await.unwrap();

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
            service.get(&id("ses_one")).unwrap().is_deferred(),
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
        assert!(service.get(&id(member)).unwrap().is_deferred(), "{member}");
    }
    assert!(held(&awake));
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
async fn retried_and_fresh_prompts_preserve_defer() {
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
    service.set_defer(&id("ses_one"), true).await.unwrap();

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
    assert!(service.get(&id("ses_one")).unwrap().is_deferred());

    service
        .admit(
            &sessions,
            input("ses_one", "msg_fresh", "user"),
            None,
            Origin::User,
        )
        .await
        .unwrap();
    assert!(service.get(&id("ses_one")).unwrap().is_deferred());
}

fn state(json: &str) -> State {
    State::read(Some(&parse_json(json).unwrap()))
}

#[test]
fn state_sleep_transitions_preserve_modes_and_goal_and_restore_nothing() {
    let awake = state(&format!(
        r#"{{"mode":"normal","permissions":"auto","guardrails":"auto","answers":"yolo","goal":{ACTIVE_GOAL}}}"#
    ));
    assert!(!awake.is_deferred());
    assert_eq!(awake.set_defer(false), None);

    let asleep = awake.set_defer(true).unwrap();
    assert!(asleep.is_deferred());
    assert_eq!(
        (asleep.permissions, asleep.guardrails, asleep.answers),
        (awake.permissions, awake.guardrails, awake.answers)
    );
    assert_eq!(asleep.goal, awake.goal);
    assert_eq!(asleep.set_defer(true), None);
    assert_eq!(asleep.set_defer(false).unwrap(), awake);

    let legacy = state(&format!(
        r#"{{"mode":"normal","permissions":"auto","guardrails":"manual","answers":"manual","guardrailDecision":false,"sleep":{{"priorGuardrailDecision":true}},"goal":{ACTIVE_GOAL}}}"#
    ));
    assert!(legacy.is_deferred());
    let woken = legacy.set_defer(false).unwrap();
    assert!(!woken.is_deferred());
    assert_eq!(woken.permissions, DecisionMode::Auto);
    assert_eq!(woken.goal, legacy.goal);
    let encoded = woken.encode();
    assert!(!has(&encoded, "guardrailDecision"));
    assert!(!has(&encoded, "sleep"));
}

#[test]
fn a_sleeping_state_withholds_auto_guardrail_approval_but_keeps_permission_settlement() {
    let awake =
        state(r#"{"mode":"normal","permissions":"auto","guardrails":"auto","answers":"manual"}"#)
            .effective();
    assert!(!awake.deferred);
    assert!(awake.can_auto_guardrail());
    assert!(awake.can_auto_permission());

    let asleep = state(
        r#"{"mode":"normal","permissions":"auto","guardrails":"auto","answers":"manual","sleep":{}}"#,
    )
    .effective();
    assert!(asleep.deferred);
    assert!(!asleep.can_auto_guardrail());
    assert!(asleep.can_auto_permission());

    let goal = state(&format!(
        r#"{{"mode":"normal","permissions":"manual","guardrails":"manual","answers":"manual","sleep":{{}},"goal":{ACTIVE_GOAL}}}"#
    ))
    .effective();
    assert!(goal.deferred);
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
    service.set_defer(&id("ses_one"), true).await.unwrap();
    let root_before = stored(&store, "ses_one").unwrap();
    let child = id("ses_child");

    let applied = set_rules(&service, &child, 2).await;
    assert!(applied.is_deferred());
    assert_eq!(applied.guardrails, DecisionMode::Auto);
    let unchanged = set_rules(&service, &child, 2).await;
    assert!(unchanged.is_deferred());

    let goal = service
        .set_goal(&child, Goal::new("Finish safely", None, None))
        .await
        .unwrap();
    assert!(goal.is_deferred());
    assert!(
        modes::permissions(&service, &child, DecisionMode::Yolo)
            .await
            .is_deferred()
    );
    assert!(service.report(&child).await.unwrap().is_deferred());
    assert!(service.advance(&child).await.unwrap().is_deferred());
    assert!(service.complete(&child).await.unwrap().is_deferred());
    assert!(
        service.complete(&child).await.unwrap().is_deferred(),
        "a no-op transition reports the family marker"
    );
    assert!(service.stop(&child).await.unwrap().is_deferred());
    assert!(
        service
            .change(&child, GoalChange::Resume)
            .await
            .unwrap()
            .is_deferred()
    );

    child_stores_no_marker(&store);
    assert_eq!(stored(&store, "ses_one").unwrap(), root_before);
    assert!(service.get(&child).unwrap().is_deferred());
}

#[tokio::test]
async fn conditional_child_mutations_report_the_inherited_marker_when_applied_or_stale() {
    let store = family();
    let service = Service::new(store.client());
    service.set_defer(&id("ses_one"), true).await.unwrap();
    let child = id("ses_child");

    let snapshot = service.snapshot(&child).unwrap();
    let applied = service
        .set_goal_if_current(
            &child,
            snapshot.sequence,
            Goal::new("Finish safely", None, None),
        )
        .await
        .unwrap();
    assert!(applied.applied);
    assert!(applied.state.is_deferred());

    let stale = service
        .set_goal_if_current(&child, snapshot.sequence, Goal::new("Replace", None, None))
        .await
        .unwrap();
    assert!(!stale.applied);
    assert!(stale.state.is_deferred());
    assert_eq!(
        stale.state.goal.as_ref().unwrap().text.as_str(),
        Some("Finish safely")
    );

    let current = service.snapshot(&child).unwrap().sequence;
    let advanced = service.advance_if_current(&child, current).await.unwrap();
    assert!(advanced.applied);
    assert!(advanced.state.is_deferred());
    let stale = service.advance_if_current(&child, current).await.unwrap();
    assert!(!stale.applied);
    assert!(stale.state.is_deferred());

    service.stop(&child).await.unwrap();
    let stale = service
        .resume_goal_if_current(&child, current)
        .await
        .unwrap();
    assert!(!stale.applied);
    assert!(stale.state.is_deferred());
    let current = service.snapshot(&child).unwrap().sequence;
    let resumed = service
        .resume_goal_if_current(&child, current)
        .await
        .unwrap();
    assert!(resumed.applied);
    assert!(resumed.state.is_deferred());

    child_stores_no_marker(&store);
}

#[tokio::test]
async fn child_mutation_results_stay_awake_in_an_awake_family() {
    let store = family();
    let service = Service::new(store.client());
    let child = id("ses_child");
    assert!(
        !modes::permissions(&service, &child, DecisionMode::Yolo)
            .await
            .is_deferred()
    );
    let snapshot = service.snapshot(&child).unwrap();
    let stale = service
        .advance_if_current(&child, snapshot.sequence - 1)
        .await
        .unwrap();
    assert!(!stale.applied);
    assert!(!stale.state.is_deferred());
    child_stores_no_marker(&store);
}

async fn set_rules(
    autonomy: &ycoding_core::session::autonomy::Service,
    session: &ycoding_schema::session::Id,
    rules: u8,
) -> ycoding_core::session::autonomy::State {
    autonomy
        .set_decisions(
            session,
            DecisionChange::new(
                Some(modes::auto(rules >= 1)),
                Some(modes::auto(rules >= 2)),
                None,
            )
            .unwrap(),
        )
        .await
        .unwrap()
}
