use ycoding_core::session::autonomy::{Goal, State};
use ycoding_schema::{JsonObject, JsonValue, parse_json};

const ACTIVE_GOAL: &str = r#"{"text":"Finish safely","rawText":"Finish safely","iteration":2,"noProgress":1,"maxNoProgress":3,"status":"active"}"#;

fn reencoded(json: &str) -> JsonValue {
    State::read(Some(&parse_json(json).unwrap())).encode()
}

fn object(value: &JsonValue) -> &JsonObject {
    let JsonValue::Object(object) = value else {
        panic!("autonomy state must encode as an object")
    };
    object
}

fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    object(value).get(&key.into())
}

fn goal(value: &JsonValue) -> Option<Goal> {
    State::read(Some(value)).goal
}

fn active_goal() -> Option<Goal> {
    goal(
        &parse_json(&format!(
            r#"{{"mode":"normal","permissions":"manual","guardrails":"manual","answers":"manual","goal":{ACTIVE_GOAL}}}"#
        ))
        .unwrap(),
    )
}

fn empty_defer(value: &JsonValue) -> bool {
    matches!(field(value, "defer"), Some(JsonValue::Object(defer)) if defer.iter().next().is_none())
}

#[test]
fn a_legacy_sleep_marker_decodes_and_encodes_as_defer() {
    let encoded = reencoded(
        r#"{"mode":"normal","permissions":"yolo","guardrails":"yolo","answers":"yolo","sleep":{}}"#,
    );
    assert!(empty_defer(&encoded));
    assert!(field(&encoded, "sleep").is_none());
    assert_eq!(
        field(&encoded, "permissions"),
        Some(&JsonValue::String("yolo".into()))
    );
    assert_eq!(
        State::read(Some(&encoded)).encode(),
        encoded,
        "the marker is stable across repeated reads"
    );

    let awake =
        reencoded(r#"{"mode":"normal","permissions":"yolo","guardrails":"yolo","answers":"yolo"}"#);
    assert!(field(&awake, "defer").is_none());
}

#[test]
fn a_sleep_object_with_extra_keys_keeps_only_the_presence_marker() {
    assert!(active_goal().is_some_and(|goal| goal.is_active()));
    for sleep in [
        r#"{"priorGuardrailDecision":true}"#,
        r#"{"priorGuardrailDecision":false}"#,
    ] {
        let encoded = reencoded(&format!(
            r#"{{"mode":"normal","permissions":"auto","guardrails":"manual","answers":"manual","guardrailDecision":true,"sleep":{sleep},"goal":{ACTIVE_GOAL}}}"#
        ));
        assert!(empty_defer(&encoded), "{sleep}");
        assert!(field(&encoded, "guardrailDecision").is_none(), "{sleep}");
        assert_eq!(
            field(&encoded, "permissions"),
            Some(&JsonValue::String("auto".into())),
            "{sleep}"
        );
        assert!(field(&encoded, "goal").is_some(), "{sleep}");
        assert_eq!(goal(&encoded), active_goal(), "{sleep}");
    }
}

#[test]
fn a_stored_delegation_key_without_sleep_is_dropped_and_stays_awake() {
    let encoded = reencoded(&format!(
        r#"{{"mode":"normal","permissions":"manual","guardrails":"manual","answers":"manual","guardrailDecision":true,"goal":{ACTIVE_GOAL}}}"#
    ));
    assert!(field(&encoded, "guardrailDecision").is_none());
    assert!(field(&encoded, "sleep").is_none());
    assert_eq!(
        field(&encoded, "permissions"),
        Some(&JsonValue::String("manual".into()))
    );
    assert!(
        ["yolo", "autoPermission", "autoGuardrail", "autoAnswer"]
            .into_iter()
            .all(|key| field(&encoded, key).is_none())
    );
    assert!(field(&encoded, "goal").is_some());
    assert_eq!(goal(&encoded), active_goal());
}
