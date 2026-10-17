use ycoding_core::session::autonomy::{Goal, ReviewKind, State, YoloLevel};
use ycoding_schema::{JsonValue, parse_json};

const ACTIVE_GOAL: &str = r#"{"text":"Finish safely","rawText":"Finish safely","iteration":2,"noProgress":1,"maxNoProgress":3,"status":"active"}"#;

fn state(json: &str) -> State {
    State::read(Some(&parse_json(json).unwrap()))
}

fn field(value: &JsonValue, key: &str) -> Option<JsonValue> {
    let JsonValue::Object(object) = value else {
        panic!("autonomy state must encode as an object")
    };
    object.get(&key.into()).cloned()
}

fn active_goal() -> Option<Goal> {
    state(&format!(
        r#"{{"mode":"normal","yolo":0,"goal":{ACTIVE_GOAL}}}"#
    ))
    .goal
}

#[test]
fn new_levels_accept_only_zero_through_two() {
    for level in 0..=2 {
        assert_eq!(YoloLevel::new(level).map(YoloLevel::get), Some(level));
    }
    for level in [3, 4, u8::MAX] {
        assert_eq!(YoloLevel::new(level), None, "{level}");
    }
    assert_eq!(YoloLevel::OFF.get(), 0);
    assert_eq!(YoloLevel::APPROVALS.get(), 1);
    assert_eq!(YoloLevel::GUARDRAILS.get(), 2);
}

#[test]
fn stored_levels_outside_zero_through_two_read_as_zero_and_keep_every_other_value() {
    for (stored, expected) in [
        ("0", 0),
        ("1", 1),
        ("2", 2),
        ("1.5", 1),
        ("2.9", 2),
        ("-0.5", 0),
        ("3", 0),
        ("4", 0),
        ("-1", 0),
        ("true", 2),
        ("false", 0),
        (r#""2""#, 0),
        ("null", 0),
    ] {
        let read = state(&format!(
            r#"{{"mode":"normal","yolo":{stored},"autoAnswer":true,"sleep":{{}},"goal":{ACTIVE_GOAL}}}"#
        ));
        assert_eq!(read.yolo.get(), expected, "{stored}");
        assert_eq!(read.auto_answer, Some(true), "{stored}");
        assert!(read.sleep, "{stored}");
        assert_eq!(read.goal, active_goal(), "{stored}");
        assert_eq!(
            field(&read.encode(), "yolo"),
            Some(JsonValue::Number(f64::from(expected))),
            "{stored}"
        );
    }
    let missing = state(&format!(
        r#"{{"mode":"normal","autoAnswer":false,"goal":{ACTIVE_GOAL}}}"#
    ));
    assert_eq!(missing.yolo, YoloLevel::OFF);
    assert_eq!(missing.auto_answer, Some(false));
    assert_eq!(missing.goal, active_goal());
}

#[test]
fn the_auto_answer_toggle_round_trips_and_defaults_off() {
    for (stored, expected) in [("true", Some(true)), ("false", Some(false))] {
        let read = state(&format!(
            r#"{{"mode":"normal","yolo":1,"autoAnswer":{stored}}}"#
        ));
        assert_eq!(read.auto_answer, expected, "{stored}");
        assert_eq!(
            field(&read.encode(), "autoAnswer"),
            expected.map(JsonValue::Bool),
            "{stored}"
        );
        assert_eq!(read.effective().can_auto_answer(), expected == Some(true));
        assert_eq!(
            State::read(Some(&read.encode())),
            read,
            "the toggle is stable across repeated reads"
        );
    }
    for stored in [None, Some(r#""yes""#), Some("1"), Some("null")] {
        let json = match stored {
            Some(value) => {
                format!(r#"{{"mode":"normal","yolo":1,"autoAnswer":{value},"goal":{ACTIVE_GOAL}}}"#)
            }
            None => format!(r#"{{"mode":"normal","yolo":1,"goal":{ACTIVE_GOAL}}}"#),
        };
        let read = state(&json);
        assert_eq!(read.auto_answer, None, "{stored:?}");
        assert_eq!(read.yolo, YoloLevel::APPROVALS, "{stored:?}");
        assert_eq!(read.goal, active_goal(), "{stored:?}");
        assert!(field(&read.encode(), "autoAnswer").is_none(), "{stored:?}");
        assert!(!read.effective().can_auto_answer(), "{stored:?}");
    }
    assert_eq!(State::default().auto_answer, None);
    assert!(!State::default().effective().can_auto_answer());
}

#[test]
fn setting_the_toggle_changes_only_the_toggle_and_reports_no_change_when_equal() {
    let base = state(&format!(
        r#"{{"mode":"normal","yolo":2,"sleep":{{}},"goal":{ACTIVE_GOAL}}}"#
    ));
    let off = base.set_auto_answer(false).unwrap();
    assert_eq!(off.auto_answer, Some(false));
    assert_eq!(
        field(&off.encode(), "autoAnswer"),
        Some(JsonValue::Bool(false))
    );
    assert_eq!(off.set_auto_answer(false), None);
    let on = off.set_auto_answer(true).unwrap();
    assert_eq!(on.auto_answer, Some(true));
    assert_eq!(on.set_auto_answer(true), None);
    for changed in [&off, &on] {
        assert_eq!(changed.yolo, base.yolo);
        assert_eq!(changed.goal, base.goal);
        assert_eq!(changed.sleep, base.sleep);
    }
    assert_ne!(on.digest(), base.digest());
}

#[test]
fn other_transitions_preserve_the_toggle() {
    let enabled = state(&format!(
        r#"{{"mode":"normal","yolo":0,"autoAnswer":true,"goal":{ACTIVE_GOAL}}}"#
    ));
    let preserved = [
        enabled.set_yolo(YoloLevel::GUARDRAILS).unwrap(),
        enabled.set_sleep(true).unwrap(),
        enabled.stop_goal(),
        enabled
            .stop_goal()
            .resume_goal(Some(YoloLevel::APPROVALS))
            .unwrap(),
        enabled.replace_goal(Goal::new("Another goal", None, None)),
    ];
    for next in preserved {
        assert_eq!(next.auto_answer, Some(true), "{next:?}");
    }
}

#[test]
fn approvals_follow_the_level_and_answers_follow_only_the_toggle() {
    for yolo in 0..=2u8 {
        for goal in [false, true] {
            for asleep in [false, true] {
                for auto_answer in [false, true] {
                    let label =
                        format!("yolo {yolo} goal {goal} asleep {asleep} auto {auto_answer}");
                    let mut json =
                        format!(r#"{{"mode":"normal","yolo":{yolo},"autoAnswer":{auto_answer}"#);
                    if goal {
                        json.push_str(&format!(r#","goal":{ACTIVE_GOAL}"#));
                    }
                    if asleep {
                        json.push_str(r#","sleep":{}"#);
                    }
                    json.push('}');
                    let effective = state(&json).effective();
                    assert_eq!(effective.goal_active, goal, "{label}");
                    assert_eq!(effective.can_auto_permission(), yolo >= 1, "{label}");
                    assert_eq!(
                        effective.can_auto_guardrail(),
                        yolo >= 2 && !asleep,
                        "{label}"
                    );
                    assert_eq!(
                        effective.can_auto_review(ReviewKind::Ordinary),
                        yolo >= 2 && !asleep,
                        "{label}"
                    );
                    assert!(!effective.can_auto_review(ReviewKind::Hard), "{label}");
                    assert_eq!(effective.can_auto_answer(), auto_answer, "{label}");
                }
            }
        }
    }
}

#[test]
fn inheritance_carries_levels_but_never_the_toggle() {
    let parent = state(&format!(
        r#"{{"mode":"normal","yolo":2,"autoAnswer":true,"goal":{ACTIVE_GOAL}}}"#
    ))
    .effective();
    let child = state(r#"{"mode":"normal","yolo":0}"#).effective();
    let inherited = child.inherit(parent);
    assert_eq!(inherited.yolo, YoloLevel::GUARDRAILS);
    assert!(inherited.can_auto_permission());
    assert!(inherited.can_auto_guardrail());
    assert!(!inherited.can_auto_answer());

    let own = state(r#"{"mode":"normal","yolo":0,"autoAnswer":true}"#).effective();
    let without_parent = state(r#"{"mode":"normal","yolo":0,"autoAnswer":false}"#).effective();
    assert!(own.inherit(without_parent).can_auto_answer());
}
