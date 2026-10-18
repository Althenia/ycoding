use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, guardrail, parse_json, session_review,
};

const FAILURES: &[&str] = &[
    "unavailable",
    "invalid-request",
    "provider-failed",
    "timeout",
    "input-too-large",
    "invalid-output",
    "refused",
    "truncated-output",
    "unsupported-output",
];

#[test]
fn failure_only_provenance_preserves_the_cause_without_fabricated_judgments() {
    for reason in FAILURES {
        let value = parse_json(&format!(r#"{{"reason":"{reason}"}}"#)).unwrap();
        let decoded = guardrail::Escalation::decode(&value).unwrap();
        assert_eq!(decoded.encode(), value, "{reason}");
        let reason = JsonValue::String((*reason).into());
        assert_eq!(
            session_review::Reason::decode(&reason).unwrap().encode(),
            reason
        );
    }
}

#[test]
fn invalid_diagnostic_reasons_do_not_silently_disappear() {
    for value in [
        r#"{"reason":null}"#,
        r#"{"reason":1}"#,
        r#"{"reason":false}"#,
        r#"{"reason":"unknown-failure"}"#,
    ] {
        assert!(
            guardrail::Escalation::decode(&parse_json(value).unwrap()).is_err(),
            "{value}"
        );
    }
}

#[test]
fn explicit_escalation_and_existing_judgments_round_trip() {
    for reason in ["escalated", "low_confidence", "conflicting_grades"] {
        let value = parse_json(&format!(r#"{{"reason":"{reason}"}}"#)).unwrap();
        assert_eq!(
            guardrail::Escalation::decode(&value).unwrap().encode(),
            value
        );
    }
    let value = parse_json(r#"{"choice":"approve","confidence":0.93,"grades":[{"choice":"approve","confidence":0.93,"evidence":"Synthetic evidence"}]}"#).unwrap();
    assert_eq!(
        guardrail::Escalation::decode(&value).unwrap().encode(),
        value
    );
    assert_eq!(
        guardrail::Escalation::decode(&parse_json("{}").unwrap())
            .unwrap()
            .encode(),
        parse_json("{}").unwrap()
    );
}
