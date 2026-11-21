use ycoding_core::session::autonomy::{DecisionChange, DecisionMode, Goal, State};
use ycoding_schema::{JsonValue, parse_json};

const ACTIVE_GOAL: &str = r#"{"text":"Finish safely","rawText":"Finish safely","iteration":2,"noProgress":1,"maxNoProgress":3,"status":"active"}"#;
const MODES: [DecisionMode; 3] = [DecisionMode::Manual, DecisionMode::Yolo, DecisionMode::Auto];

fn state(json: &str) -> State {
    State::read(Some(&parse_json(json).unwrap()))
}

fn field(value: &JsonValue, key: &str) -> Option<JsonValue> {
    let JsonValue::Object(object) = value else {
        panic!("autonomy state must encode as an object")
    };
    object.get(&key.into()).cloned()
}

fn text(value: &str) -> Option<JsonValue> {
    Some(JsonValue::String(value.into()))
}

fn change(
    permissions: Option<DecisionMode>,
    guardrails: Option<DecisionMode>,
    answers: Option<DecisionMode>,
) -> DecisionChange {
    DecisionChange::new(permissions, guardrails, answers).unwrap()
}

#[test]
fn the_default_state_is_normal_with_every_category_manual() {
    let default = State::default();
    assert_eq!(
        (default.permissions, default.guardrails, default.answers),
        (
            DecisionMode::Manual,
            DecisionMode::Manual,
            DecisionMode::Manual
        )
    );
    assert!(default.goal.is_none() && !default.defer);
    assert_eq!(
        default.encode(),
        parse_json(
            r#"{"mode":"normal","permissions":"manual","guardrails":"manual","answers":"manual"}"#
        )
        .unwrap()
    );
    assert_eq!(State::read(None), default);
}

#[test]
fn every_mode_combination_round_trips_through_the_stored_shape() {
    for permissions in MODES {
        for guardrails in MODES {
            for answers in MODES {
                let stored = State {
                    permissions,
                    guardrails,
                    answers,
                    ..State::default()
                };
                let encoded = stored.encode();
                assert_eq!(field(&encoded, "permissions"), text(permissions.as_str()));
                assert_eq!(field(&encoded, "guardrails"), text(guardrails.as_str()));
                assert_eq!(field(&encoded, "answers"), text(answers.as_str()));
                assert_eq!(State::read(Some(&encoded)), stored);
            }
        }
    }
}

#[test]
fn decision_modes_are_a_closed_set_with_exact_strings() {
    assert_eq!(MODES.map(DecisionMode::as_str), ["manual", "yolo", "auto"]);
    for mode in MODES {
        assert_eq!(DecisionMode::parse(mode.as_str()), Some(mode));
    }
    for value in ["", "on", "off", "Manual", "AUTO", "true", "0"] {
        assert_eq!(DecisionMode::parse(value), None, "{value}");
    }
}

#[test]
fn the_reader_accepts_only_the_per_category_shape_and_ignores_unrelated_keys() {
    let read = state(&format!(
        r#"{{"mode":"normal","permissions":"auto","guardrails":"yolo","answers":"manual","guardrailDecision":true,"sleep":{{"priorGuardrailDecision":true}},"goal":{ACTIVE_GOAL}}}"#
    ));
    assert_eq!(read.permissions, DecisionMode::Auto);
    assert_eq!(read.guardrails, DecisionMode::Yolo);
    assert_eq!(read.answers, DecisionMode::Manual);
    assert!(read.defer);
    assert!(read.goal.as_ref().is_some_and(Goal::is_active));
    assert!(field(&read.encode(), "guardrailDecision").is_none());
    assert_eq!(
        field(&read.encode(), "defer"),
        Some(JsonValue::Object(Default::default()))
    );
}

#[test]
fn an_unmigrated_or_malformed_shape_reads_as_all_manual_without_a_goal() {
    for stored in [
        r#""yolo":true"#,
        r#""yolo":false,"permissions":"auto","guardrails":"auto","answers":"auto""#,
        r#""autoPermission":true"#,
        r#""permissions":"auto","guardrails":"auto","answers":"auto","autoAnswer":true"#,
        r#""permissions":"auto","guardrails":"auto""#,
        r#""permissions":"auto","guardrails":"auto","answers":"on""#,
        r#""permissions":"auto","guardrails":"auto","answers":true"#,
        r#""permissions":"auto","guardrails":"auto","answers":null"#,
        r#""permissions":"Auto","guardrails":"auto","answers":"auto""#,
        r#""permissions":"auto","guardrails":"auto","answers":"auto","sleep":true"#,
    ] {
        let read = state(&format!(
            r#"{{"mode":"normal",{stored},"goal":{ACTIVE_GOAL}}}"#
        ));
        assert_eq!(read, State::default(), "{stored}");
    }
    for stored in [
        format!(
            r#"{{"mode":"yolo","permissions":"auto","guardrails":"auto","answers":"auto","goal":{ACTIVE_GOAL}}}"#
        ),
        format!(
            r#"{{"mode":"goal","permissions":"auto","guardrails":"auto","answers":"auto","goal":{ACTIVE_GOAL}}}"#
        ),
        format!(r#"{{"permissions":"auto","guardrails":"auto","answers":"auto","goal":{ACTIVE_GOAL}}}"#),
        r#"{"mode":"normal","permissions":"auto","guardrails":"auto","answers":"auto","goal":{"text":"x"}}"#.to_owned(),
        "[true]".to_owned(),
        "null".to_owned(),
    ] {
        assert_eq!(state(&stored), State::default(), "{stored}");
    }
}

#[test]
fn a_decision_change_must_select_at_least_one_category_and_writes_only_those() {
    assert_eq!(DecisionChange::new(None, None, None), None);
    let base = state(&format!(
        r#"{{"mode":"normal","permissions":"manual","guardrails":"manual","answers":"manual","sleep":{{}},"goal":{ACTIVE_GOAL}}}"#
    ));
    for (selected, own) in [
        (change(Some(DecisionMode::Auto), None, None), "permissions"),
        (change(None, Some(DecisionMode::Yolo), None), "guardrails"),
        (change(None, None, Some(DecisionMode::Auto)), "answers"),
    ] {
        let next = base.set_decisions(selected).unwrap();
        assert_eq!(next.goal, base.goal, "{own}");
        assert_eq!(next.defer, base.defer, "{own}");
        assert_ne!(next.digest(), base.digest(), "{own}");
        let untouched = ["permissions", "guardrails", "answers"]
            .into_iter()
            .filter(|key| *key != own);
        for key in untouched {
            assert_eq!(
                field(&next.encode(), key),
                field(&base.encode(), key),
                "{own} {key}"
            );
        }
        assert_eq!(next.set_decisions(selected), None, "{own}");
    }
    let all = base
        .set_decisions(change(
            Some(DecisionMode::Auto),
            Some(DecisionMode::Yolo),
            Some(DecisionMode::Manual),
        ))
        .unwrap();
    assert_eq!(
        (all.permissions, all.guardrails, all.answers),
        (DecisionMode::Auto, DecisionMode::Yolo, DecisionMode::Manual)
    );
    assert_eq!(
        base.set_decisions(change(
            Some(DecisionMode::Manual),
            Some(DecisionMode::Manual),
            None
        )),
        None
    );
}

#[test]
fn goal_transitions_and_sleep_keep_every_category_mode() {
    let enabled = state(&format!(
        r#"{{"mode":"normal","permissions":"auto","guardrails":"yolo","answers":"auto","goal":{ACTIVE_GOAL}}}"#
    ));
    let resumed = enabled.stop_goal().resume_goal().unwrap();
    assert!(resumed.goal.as_ref().is_some_and(Goal::is_active));
    for next in [
        enabled.set_defer(true).unwrap(),
        enabled.stop_goal(),
        resumed,
        enabled.replace_goal(Goal::new("Another goal", None, None)),
    ] {
        assert_eq!(next.permissions, DecisionMode::Auto, "{next:?}");
        assert_eq!(next.guardrails, DecisionMode::Yolo, "{next:?}");
        assert_eq!(next.answers, DecisionMode::Auto, "{next:?}");
    }
}

#[test]
fn each_mode_authorizes_only_its_own_path_and_goals_grant_nothing() {
    for permissions in MODES {
        for guardrails in MODES {
            for answers in MODES {
                for asleep in [false, true] {
                    let label =
                        format!("{permissions:?} {guardrails:?} {answers:?} asleep {asleep}");
                    let stored = State {
                        permissions,
                        guardrails,
                        answers,
                        goal: state(&format!(
                            r#"{{"mode":"normal","permissions":"manual","guardrails":"manual","answers":"manual","goal":{ACTIVE_GOAL}}}"#
                        ))
                        .goal,
                        defer: asleep,
                    };
                    let effective = stored.effective();
                    assert!(effective.goal_active, "{label}");
                    assert_eq!(
                        effective.can_auto_permission(),
                        permissions == DecisionMode::Auto,
                        "{label}"
                    );
                    assert_eq!(
                        effective.can_yolo_permission(),
                        permissions == DecisionMode::Yolo,
                        "{label}"
                    );
                    assert_eq!(
                        effective.can_auto_guardrail(),
                        guardrails == DecisionMode::Auto && !asleep,
                        "{label}"
                    );
                    assert_eq!(
                        effective.can_yolo_guardrail(),
                        guardrails == DecisionMode::Yolo,
                        "{label}"
                    );
                    assert_eq!(
                        effective.can_auto_answer(),
                        answers == DecisionMode::Auto,
                        "{label}"
                    );
                    assert_eq!(
                        effective.can_yolo_answer(),
                        answers == DecisionMode::Yolo,
                        "{label}"
                    );
                }
            }
        }
    }
    let goal_only = state(&format!(
        r#"{{"mode":"normal","permissions":"manual","guardrails":"manual","answers":"manual","goal":{ACTIVE_GOAL}}}"#
    ))
    .effective();
    assert!(goal_only.goal_active);
    assert!(!goal_only.can_auto_permission() && !goal_only.can_yolo_permission());
    assert!(!goal_only.can_auto_guardrail() && !goal_only.can_yolo_guardrail());
    assert!(!goal_only.can_auto_answer() && !goal_only.can_yolo_answer());
}

#[test]
fn the_goal_reminder_names_the_answers_mode_without_granting_authority() {
    let reminder = |answers: &str| {
        state(&format!(
            r#"{{"mode":"normal","permissions":"manual","guardrails":"manual","answers":"{answers}","goal":{ACTIVE_GOAL}}}"#
        ))
        .goal_reminder()
        .unwrap()
    };
    assert!(reminder("manual").contains("Automatic answering is disabled for this Session."));
    assert!(reminder("auto").contains("Automatic answering is enabled for this Session."));
    assert!(
        reminder("yolo").contains("Answers YOLO uses the answer evaluator and validated fallbacks")
    );
    for answers in ["manual", "auto", "yolo"] {
        let text = reminder(answers);
        assert!(
            text.contains("Goals change no category authority."),
            "{answers}"
        );
        assert!(!text.contains("auto-answer toggle"), "{answers}");
    }
}
