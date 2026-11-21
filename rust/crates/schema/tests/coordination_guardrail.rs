use ycoding_schema::{DecodeError, DomainDecode, JsonValue, parse_json, session_event};

fn json(text: &str) -> JsonValue {
    parse_json(text).unwrap()
}

fn durable(data: &str) -> Result<JsonValue, DecodeError> {
    session_event::DurableEvent::decode(&json(&format!(
        r#"{{"id":"evt_guardrail","created":1,"type":"session.guardrail.decided","durable":{{"aggregateID":"ses_guardrail","seq":0,"version":1}},"data":{data}}}"#
    )))
    .map(|event| JsonValue::Object(event.0.data.0))
}

fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&key.into()),
        _ => None,
    }
}

fn decided(extra: &str) -> String {
    format!(
        r#"{{"sessionID":"ses_guardrail","reviewSessionID":"ses_review","requestID":"grq_1","reply":"once","ruleIDs":["standard.synthetic"]{extra}}}"#
    )
}

#[test]
fn guardrail_decision_retains_coordinator_provenance_in_order() {
    let data = decided(
        r#","actor":"coordinator","coordinatorSessionID":"ses_coordinator","groupID":"cgrp_1","rationale":"Synthetic scoped approval""#,
    );
    let decoded = durable(&data).unwrap();
    assert_eq!(field(&decoded, "actor"), Some(&json(r#""coordinator""#)));
    assert_eq!(
        field(&decoded, "coordinatorSessionID"),
        Some(&json(r#""ses_coordinator""#))
    );
    assert_eq!(field(&decoded, "groupID"), Some(&json(r#""cgrp_1""#)));
    assert_eq!(
        field(&decoded, "rationale"),
        Some(&json(r#""Synthetic scoped approval""#))
    );
    let JsonValue::Object(object) = &decoded else {
        panic!("decoded data is an object")
    };
    let keys = object
        .iter()
        .map(|(key, _)| key.as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        keys,
        [
            "sessionID",
            "reviewSessionID",
            "requestID",
            "reply",
            "ruleIDs",
            "actor",
            "coordinatorSessionID",
            "groupID",
            "rationale"
        ]
    );
}

#[test]
fn guardrail_decision_without_group_keeps_goal_reconsideration_shape() {
    let data = decided(
        r#","actor":"coordinator","coordinatorSessionID":"ses_coordinator","rationale":"Synthetic goal approval""#,
    );
    let decoded = durable(&data).unwrap();
    assert_eq!(field(&decoded, "groupID"), None);
    assert_eq!(field(&decoded, "actor"), Some(&json(r#""coordinator""#)));
}

#[test]
fn guardrail_decision_without_coordinator_fields_still_decodes() {
    let decoded = durable(&decided("")).unwrap();
    assert_eq!(field(&decoded, "actor"), None);
    assert_eq!(field(&decoded, "rationale"), None);
}

#[test]
fn guardrail_decision_rejects_invalid_coordinator_metadata() {
    let too_long = "x".repeat(501);
    let invalid = [
        r#","actor":"Coordinator""#.to_owned(),
        r#","actor":"member""#.to_owned(),
        r#","actor":null"#.to_owned(),
        r#","coordinatorSessionID":"per_coordinator""#.to_owned(),
        r#","coordinatorSessionID":null"#.to_owned(),
        r#","coordinatorSessionID":7"#.to_owned(),
        r#","groupID":null"#.to_owned(),
        r#","groupID":1"#.to_owned(),
        r#","groupID":["cgrp_1"]"#.to_owned(),
        r#","rationale":null"#.to_owned(),
        r#","rationale":1"#.to_owned(),
        r#","rationale":"""#.to_owned(),
        r#","rationale":" ""#.to_owned(),
        r#","rationale":"\t\n""#.to_owned(),
        r#","rationale":"\u00a0""#.to_owned(),
        r#","rationale":"\u3000""#.to_owned(),
        format!(r#","rationale":"{too_long}""#),
    ];
    for extra in invalid {
        assert!(durable(&decided(&extra)).is_err(), "accepted {extra}");
    }
}

#[test]
fn guardrail_decision_accepts_rationale_at_the_boundary() {
    let exact = "x".repeat(500);
    let data = decided(&format!(
        r#","actor":"coordinator","coordinatorSessionID":"ses_coordinator","rationale":"{exact}""#
    ));
    assert!(durable(&data).is_ok());
}

#[test]
fn guardrail_decision_still_drops_undeclared_fields() {
    let decoded = durable(&decided(r#","unexpected":true"#)).unwrap();
    assert_eq!(field(&decoded, "unexpected"), None);
}
