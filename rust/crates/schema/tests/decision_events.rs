use ycoding_schema::{
    DecodeError, DomainDecode, DomainEncode, JsonValue, durable_event_manifest, event_manifest,
    guardrail, parse_json, permission, session_event,
};

fn json(text: &str) -> JsonValue {
    parse_json(text).unwrap()
}

fn envelope(kind: &str, data: &str) -> JsonValue {
    json(&format!(
        r#"{{"id":"evt_decision","created":1,"type":"{kind}","durable":{{"aggregateID":"ses_decision","seq":0,"version":1}},"data":{data}}}"#
    ))
}

fn durable(kind: &str, data: &str) -> Result<JsonValue, DecodeError> {
    session_event::DurableEvent::decode(&envelope(kind, data))
        .map(|event| JsonValue::Object(event.0.data.0))
}

fn public(kind: &str, data: &str) -> Result<JsonValue, DecodeError> {
    session_event::PublicDurableEvent::decode(&envelope(kind, data))
        .map(|event| JsonValue::Object(event.0.data.0))
}

fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&key.into()),
        _ => None,
    }
}

#[test]
fn both_assessment_events_are_public_durable_manifest_entries() {
    for name in ["session.decision.audited", "session.permission.assessed"] {
        let has = |list: Vec<ycoding_schema::LosslessString>, value: &str| {
            list.iter().any(|item| item.as_str() == Some(value))
        };
        assert!(has(event_manifest::definitions(), name), "{name}");
        assert!(has(event_manifest::server_definitions(), name), "{name}");
        assert!(
            has(durable_event_manifest::definitions(), &format!("{name}.1")),
            "{name}"
        );
    }
}

#[test]
fn permission_assessment_records_outcome_path_and_bounded_provenance_only() {
    let value = r#"{"sessionID":"ses_decision","requestID":"per_1","outcome":"allow","via":"baseline","authority":"baseline","reply":"once","choice":"allow","confidence":0.91,"grades":[{"choice":"allow","confidence":0.91,"evidence":"Scoped to the stated work."}],"source":{"messageID":"msg_decision","callID":"call_1"}}"#;
    let decoded = public("session.permission.assessed", value).unwrap();
    assert_eq!(field(&decoded, "via"), Some(&json(r#""baseline""#)));
    assert_eq!(field(&decoded, "choice"), Some(&json(r#""allow""#)));
    let escalated = durable(
        "session.permission.assessed",
        r#"{"sessionID":"ses_decision","requestID":"per_2","outcome":"escalate","via":"yolo","authority":"yolo","reason":"unsupported-output"}"#,
    )
    .unwrap();
    assert_eq!(
        field(&escalated, "reason"),
        Some(&json(r#""unsupported-output""#))
    );
    let wide = durable(
        "session.permission.assessed",
        r#"{"sessionID":"ses_decision","requestID":"per_3","outcome":"deny","via":"auto-permission","resources":["rm -rf /"],"command":"rm"}"#,
    )
    .unwrap();
    assert_eq!(field(&wide, "resources"), None);
    assert_eq!(field(&wide, "command"), None);
    for invalid in [
        r#""via":"forged""#,
        r#""via":"baseline","outcome":"approve""#,
        r#""via":"baseline","authority":"admin""#,
        r#""via":"baseline","reply":"maybe""#,
    ] {
        let data = format!(
            r#"{{"sessionID":"ses_decision","requestID":"per_1","outcome":"deny",{invalid}}}"#
        );
        assert!(
            durable("session.permission.assessed", &data).is_err(),
            "{invalid}"
        );
    }
}

type Decode = fn(&str, &str) -> Result<JsonValue, DecodeError>;

const DECODERS: [(&str, Decode); 2] = [("durable", durable), ("public", public)];

fn assessed(extra: &str) -> String {
    format!(r#"{{"sessionID":"ses_decision","requestID":"per_1","outcome":"allow",{extra}}}"#)
}

fn entries(value: &JsonValue) -> usize {
    match value {
        JsonValue::Object(object) => object.len(),
        _ => panic!("object expected"),
    }
}

fn assert_same_entries(label: &str, actual: &JsonValue, expected: &JsonValue, data: &str) {
    let JsonValue::Object(expected_entries) = expected else {
        panic!("object expected")
    };
    assert_eq!(entries(actual), entries(expected), "{label}: {data}");
    for (key, value) in expected_entries.iter() {
        assert_eq!(
            field(actual, &key.to_utf8().unwrap()),
            Some(value),
            "{label}: {data}"
        );
    }
}

fn assert_retained(data: &str) {
    let input = json(data);
    for (name, decode) in DECODERS {
        let decoded = decode("session.permission.assessed", data)
            .unwrap_or_else(|error| panic!("{name}: {error:?}: {data}"));
        assert_same_entries(name, &decoded, &input, data);
    }
}

fn assert_encoded(data: &str) {
    let input = json(data);
    let wire = envelope("session.permission.assessed", data);
    let encoded = [
        (
            "durable",
            session_event::DurableEvent::decode(&wire).unwrap().encode(),
        ),
        (
            "public",
            session_event::PublicDurableEvent::decode(&wire)
                .unwrap()
                .encode(),
        ),
    ];
    for (name, value) in encoded {
        assert_eq!(
            field(&value, "type"),
            Some(&json(r#""session.permission.assessed""#)),
            "{name}"
        );
        let encoded_data = field(&value, "data").unwrap_or_else(|| panic!("{name}: data missing"));
        assert_same_entries(name, encoded_data, &input, data);
    }
}

#[test]
fn permission_assessment_coordination_metadata_is_retained() {
    let full = assessed(
        r#""via":"coordination","reply":"once","source":{"messageID":"msg_1","callID":"call_1"},"actor":"coordinator","coordinatorSessionID":"ses_coordinator","groupID":"group_1","rationale":"The owner approved the scoped read.""#,
    );
    assert_retained(&full);
    assert_encoded(&full);
    for (name, decode) in DECODERS {
        let decoded = decode("session.permission.assessed", &full).unwrap();
        assert_eq!(
            field(&decoded, "via"),
            Some(&json(r#""coordination""#)),
            "{name}"
        );
        assert_eq!(
            field(&decoded, "actor"),
            Some(&json(r#""coordinator""#)),
            "{name}"
        );
    }

    for metadata in [
        r#""actor":"coordinator""#,
        r#""coordinatorSessionID":"ses_coordinator""#,
        r#""coordinatorSessionID":"ses""#,
        r#""groupID":"group_1""#,
        r#""rationale":"Scoped.""#,
        r#""groupID":"""#,
    ] {
        assert_retained(&assessed(&format!(r#""via":"coordination",{metadata}"#)));
        assert_retained(&assessed(&format!(r#""via":"baseline",{metadata}"#)));
    }
    assert_retained(&assessed(r#""via":"coordination""#));

    let ascii = "x".repeat(500);
    let astral = "😀".repeat(250);
    let mixed = format!("{}😀", "x".repeat(498));
    let lone_surrogate = format!(r#"{}\ud800"#, "x".repeat(499));
    let exotic = ["\\u200b", "\\u0085", "\\u180e", "-", " a "];
    for rationale in [
        ascii.as_str(),
        astral.as_str(),
        mixed.as_str(),
        lone_surrogate.as_str(),
    ]
    .into_iter()
    .chain(exotic)
    {
        assert_retained(&assessed(&format!(
            r#""via":"coordination","rationale":"{rationale}""#
        )));
    }

    for via in ["auto-permission", "baseline", "yolo"] {
        let data = assessed(&format!(
            r#""via":"{via}","reply":"once","source":{{"messageID":"msg_1","callID":"call_1"}}"#
        ));
        assert_retained(&data);
        for (name, decode) in DECODERS {
            let decoded = decode("session.permission.assessed", &data).unwrap();
            for key in ["actor", "coordinatorSessionID", "groupID", "rationale"] {
                assert_eq!(field(&decoded, key), None, "{name}: {via}: {key}");
            }
        }
    }

    let wide = assessed(
        r#""via":"coordination","actor":"coordinator","groupID":"group_1","resources":["rm -rf /"],"command":"rm","unknown":1"#,
    );
    for (name, decode) in DECODERS {
        let decoded = decode("session.permission.assessed", &wide).unwrap();
        assert_eq!(
            field(&decoded, "actor"),
            Some(&json(r#""coordinator""#)),
            "{name}"
        );
        assert_eq!(
            field(&decoded, "groupID"),
            Some(&json(r#""group_1""#)),
            "{name}"
        );
        for key in ["resources", "command", "unknown"] {
            assert_eq!(field(&decoded, key), None, "{name}: {key}");
        }
    }
    for (name, decode) in DECODERS {
        assert!(
            decode(
                "session.permission.assessed",
                &assessed(r#""via":"forged","actor":"coordinator","groupID":"group_1""#),
            )
            .is_err(),
            "{name}"
        );
    }
}

#[test]
fn permission_assessment_coordination_metadata_is_validated() {
    let too_long = "x".repeat(501);
    let astral_over = "😀".repeat(251);
    let mixed_over = format!("{}😀", "x".repeat(499));
    let lone_surrogate_over = format!(r#"{}\ud800"#, "x".repeat(500));
    let invalid = [
        r#""actor":"Coordinator""#.to_owned(),
        r#""actor":"member""#.to_owned(),
        r#""actor":"""#.to_owned(),
        r#""actor":null"#.to_owned(),
        r#""actor":1"#.to_owned(),
        r#""actor":true"#.to_owned(),
        r#""coordinatorSessionID":"per_coordinator""#.to_owned(),
        r#""coordinatorSessionID":"""#.to_owned(),
        r#""coordinatorSessionID":null"#.to_owned(),
        r#""coordinatorSessionID":7"#.to_owned(),
        r#""groupID":null"#.to_owned(),
        r#""groupID":1"#.to_owned(),
        r#""groupID":["group_1"]"#.to_owned(),
        r#""groupID":{}"#.to_owned(),
        r#""rationale":null"#.to_owned(),
        r#""rationale":1"#.to_owned(),
        r#""rationale":"""#.to_owned(),
        r#""rationale":" ""#.to_owned(),
        r#""rationale":"\t\n""#.to_owned(),
        r#""rationale":"\u00a0""#.to_owned(),
        r#""rationale":"\u2028\u2029""#.to_owned(),
        r#""rationale":"\u3000""#.to_owned(),
        r#""rationale":"\ufeff""#.to_owned(),
        format!(r#""rationale":"{too_long}""#),
        format!(r#""rationale":"{astral_over}""#),
        format!(r#""rationale":"{mixed_over}""#),
        format!(r#""rationale":"{lone_surrogate_over}""#),
    ];
    for via in ["baseline", "yolo", "auto-permission", "coordination"] {
        for metadata in &invalid {
            let data = assessed(&format!(r#""via":"{via}",{metadata}"#));
            for (name, decode) in DECODERS {
                assert!(
                    decode("session.permission.assessed", &data).is_err(),
                    "{name}: {via}: {metadata}"
                );
            }
        }
    }
    let valid = r#""actor":"coordinator","coordinatorSessionID":"ses_coordinator","groupID":"group_1","rationale":"Scoped.""#;
    for via in ["forged", "Coordination"] {
        let data = assessed(&format!(r#""via":"{via}",{valid}"#));
        for (name, decode) in DECODERS {
            assert!(
                decode("session.permission.assessed", &data).is_err(),
                "{name}: {via}"
            );
        }
    }
}

#[test]
fn decision_audit_keeps_typed_answers_without_raw_output() {
    let value = format!(
        r#"{{"sessionID":"ses_decision","purpose":"answer","authority":"yolo","agent":"yolo-answer","model":{{"providerID":"openai","id":"gpt"}},"route":"openai-responses","outcome":"succeeded","fingerprint":"{}","invocationKey":"sha256:0123456789abcdef","attempts":1,"answers":[{{"name":"sha256:00","type":"choice","choice":"sha256:11","confidence":0.9}},{{"name":"sha256:22","type":"text","length":12,"confidence":0.85}},{{"name":"sha256:33","type":"predicate","answer":false,"confidence":0.8}}]}}"#,
        "a".repeat(64)
    );
    let decoded = public("session.decision.audited", &value).unwrap();
    assert_eq!(field(&decoded, "attempts"), Some(&json("1")));
    assert!(
        durable(
            "session.decision.audited",
            r#"{"sessionID":"ses_decision","purpose":"advisory","agent":"decision","outcome":"cancelled","fingerprint":"b","attempts":1}"#,
        )
        .is_ok()
    );
    assert!(
        durable(
            "session.decision.audited",
            r#"{"sessionID":"ses_decision","purpose":"guardrail","agent":"decision","outcome":"failed","reason":"timeout","fingerprint":"b","attempts":2}"#,
        )
        .is_ok()
    );
    for answers in [
        r#"[{"name":"q","type":"text","text":"secret","confidence":0.9}]"#,
        r#"[{"name":"q","type":"choice","confidence":1.5}]"#,
        r#"[{"name":"q","type":"opinion","confidence":0.5}]"#,
    ] {
        let data = format!(
            r#"{{"sessionID":"ses_decision","purpose":"answer","agent":"yolo-answer","outcome":"succeeded","fingerprint":"b","attempts":1,"answers":{answers}}}"#
        );
        assert!(
            durable("session.decision.audited", &data).is_err(),
            "{answers}"
        );
    }
    let many = format!(
        r#"{{"sessionID":"ses_decision","purpose":"answer","agent":"yolo-answer","outcome":"succeeded","fingerprint":"b","attempts":1,"answers":[{}]}}"#,
        vec![r#"{"name":"q","type":"score","score":1,"confidence":0.5}"#; 33].join(",")
    );
    assert!(durable("session.decision.audited", &many).is_err());
    for invalid in [
        r#""purpose":"approval""#,
        r#""purpose":"answer","authority":"admin""#,
        r#""purpose":"answer","outcome":"done""#,
        r#""purpose":"answer","reason":"escalated""#,
    ] {
        let data = format!(
            r#"{{"sessionID":"ses_decision","agent":"decision","outcome":"failed","fingerprint":"b","attempts":0,{invalid}}}"#
        );
        assert!(
            durable("session.decision.audited", &data).is_err(),
            "{invalid}"
        );
    }
}

#[test]
fn guardrail_provenance_and_permission_requests_carry_authority_and_strict_choices() {
    let decided = r#"{"sessionID":"ses_decision","reviewSessionID":"ses_decision","requestID":"grq_1","reply":"once","authority":"yolo","choice":"allow","confidence":0.9}"#;
    let decoded = durable("session.guardrail.decided", decided).unwrap();
    assert_eq!(field(&decoded, "authority"), Some(&json(r#""yolo""#)));
    let escalated = r#"{"sessionID":"ses_decision","requestID":"grq_2","authority":"baseline","reason":"low_confidence","choice":"deny","confidence":0.4}"#;
    let decoded = durable("session.guardrail.escalated", escalated).unwrap();
    assert_eq!(
        field(&decoded, "reason"),
        Some(&json(r#""low_confidence""#))
    );
    assert_eq!(field(&decoded, "authority"), Some(&json(r#""baseline""#)));
    assert!(
        durable(
            "session.guardrail.decided",
            &decided.replace(r#""authority":"yolo""#, r#""authority":"other""#)
        )
        .is_err()
    );
    let escalation = guardrail::Escalation::decode(&json(
        r#"{"authority":"baseline","reason":"unsupported-output"}"#,
    ))
    .unwrap();
    assert_eq!(escalation.authority, Some(guardrail::Authority::Baseline));
    let request = permission::Request::decode(&json(
        r#"{"id":"per_assessment","sessionID":"ses_decision","action":"shell","resources":["synthetic"],"escalation":{"authority":"yolo","reason":"escalated"}}"#,
    ))
    .unwrap();
    assert_eq!(
        request
            .escalation
            .and_then(|escalation| escalation.authority),
        Some(guardrail::Authority::Yolo)
    );
}
