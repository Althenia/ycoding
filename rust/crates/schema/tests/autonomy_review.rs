use ycoding_schema::{
    DecodeError, DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder,
    durable_event_manifest, event, event_manifest, form, parse_json, session_event,
    session_message,
    session_orchestration::{Change, Notification, Question, Task},
};

const CALL: &str = r#"{"messageID":"msg_ask","callID":"call_ask"}"#;
const FORM: &str = r#"{"type":"form","title":"Questions","fields":[{"key":"choice","type":"string"}],"questionTool":true}"#;
const QUESTION: &str =
    r#"{"type":"question","questions":[{"header":"Plan","question":"Which plan?","options":[]}]}"#;
const SUBAGENT: &str =
    r#"{"type":"subagent_question","text":"Which plan?","data":{"choices":["A","B"]}}"#;
const RECOVERY: &str =
    r#"{"type":"recovery","tools":[{"messageID":"msg_tool","callID":"call_read","name":"read"}]}"#;
const GRADES: &str = r#"[{"choice":"approve_all","confidence":0.9,"evidence":"Scoped directory"},{"choice":"reject","confidence":0.1,"evidence":"No contrary evidence"}]"#;
const SOURCE: &str = r#"{"messageID":"msg_guardrail","callID":"call_guardrail"}"#;
const MODEL: &str = r#"{"providerID":"openai","id":"gpt"}"#;
const FALLBACK: &str = r#"{"providerID":"anthropic","id":"claude"}"#;
const ERROR: &str = r#"{"type":"provider","message":"quota"}"#;

const NEW_DURABLE: [&str; 8] = [
    "session.review.deferred",
    "session.review.decided",
    "session.review.withdrawn",
    "session.review.consumed",
    "session.step.rerouted",
    "session.guardrail.dismissed",
    "session.guardrail.escalated",
    "session.guardrail.decided",
];
const NEW_LIVE: [&str; 6] = [
    "form.timed_out",
    "form.deferred",
    "question.timed_out",
    "question.deferred",
    "guardrail.deferred",
    "permission.deferred",
];

fn guardrail_payload() -> String {
    format!(
        r#"{{"type":"guardrail","action":"shell","resources":["echo [redacted]"],"ruleIDs":["review"],"reason":"Review action","hardReview":true,"directories":[],"fingerprint":"{}","requestID":"grq_review"}}"#,
        "a".repeat(64)
    )
}

fn permission_payload() -> String {
    format!(
        r#"{{"type":"permission","action":"shell","resources":["echo [redacted]"],"save":["echo *"],"fingerprint":"{}","requestID":"per_review"}}"#,
        "b".repeat(64)
    )
}

fn variants() -> Vec<(&'static str, String)> {
    vec![
        ("question", FORM.to_owned()),
        ("question", QUESTION.to_owned()),
        ("subagent_question", SUBAGENT.to_owned()),
        ("guardrail", guardrail_payload()),
        ("permission", permission_payload()),
    ]
}

fn json(text: &str) -> JsonValue {
    parse_json(text).unwrap()
}

fn same(left: &JsonValue, right: &JsonValue) -> bool {
    match (left, right) {
        (JsonValue::Object(left), JsonValue::Object(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .all(|(key, value)| right.get(key).is_some_and(|other| same(value, other)))
        }
        (JsonValue::Array(left), JsonValue::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| same(left, right))
        }
        _ => left == right,
    }
}

fn open(text: &str) -> &str {
    text.strip_suffix('}').expect("JSON object")
}

fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&key.into()),
        _ => None,
    }
}

fn envelope(kind: &str, data: &str) -> JsonValue {
    json(&format!(
        r#"{{"id":"evt_review","created":1,"type":"{kind}","durable":{{"aggregateID":"ses_child","seq":0,"version":1}},"data":{data}}}"#
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

fn deferred(kind: &str, reason: &str, origin: &str, payload: &str, extra: &str) -> String {
    format!(
        r#"{{"sessionID":"ses_child","itemID":"rvw_first","kind":"{kind}","reason":"{reason}","origin":{origin},"payload":{payload}{extra}}}"#
    )
}

fn decided(decision: &str) -> String {
    format!(r#"{{"sessionID":"ses_child","itemID":"rvw_first","decision":{decision}}}"#)
}

fn has(list: &[LosslessString], name: &str) -> bool {
    list.iter().any(|value| value.as_str() == Some(name))
}

fn names(definitions: Vec<event::Definition>) -> Vec<LosslessString> {
    definitions
        .into_iter()
        .map(|definition| definition.event_type)
        .collect()
}

fn durable_version(definitions: &[event::Definition], name: &str) -> Option<i64> {
    definitions
        .iter()
        .find(|definition| definition.event_type.as_str() == Some(name))
        .and_then(|definition| match &definition.durability {
            event::Durability::Durable { version, aggregate } => {
                (aggregate.as_str() == Some("sessionID")).then(|| version.get())
            }
            event::Durability::Ephemeral => None,
        })
}

#[test]
fn eight_session_events_become_public_durable_facts_and_manifest_entries() {
    let definitions = session_event::definitions();
    let public_definitions = session_event::public_durable_definitions();
    let stored = session_event::durable_definitions();
    let all = session_event::all_event_types();
    for name in NEW_DURABLE {
        assert_eq!(durable_version(&definitions, name), Some(1), "{name}");
        assert_eq!(
            durable_version(&public_definitions, name),
            Some(1),
            "{name}: public"
        );
        assert_eq!(
            durable_version(&stored, name),
            Some(1),
            "{name}: stored replay"
        );
        assert!(has(&all, name), "{name}: all_event_types");
        assert!(
            has(&event_manifest::definitions(), name),
            "{name}: event manifest"
        );
        assert!(
            has(&event_manifest::server_definitions(), name),
            "{name}: server manifest"
        );
        assert!(
            has(&durable_event_manifest::definitions(), &format!("{name}.1")),
            "{name}: durable manifest"
        );
    }
    assert!(
        has(&names(stored.clone()), "session.guardrail.approved")
            && !has(&names(public_definitions), "session.guardrail.approved"),
        "the approval grant stays private"
    );
}

#[test]
fn stored_tool_progress_replay_stays_private_while_live_progress_stays_ephemeral() {
    let definitions = session_event::definitions();
    assert!(
        definitions.iter().any(|definition| {
            definition.event_type.as_str() == Some("session.tool.progress")
                && matches!(definition.durability, event::Durability::Ephemeral)
        }),
        "live progress is ephemeral"
    );
    assert_eq!(
        durable_version(
            &session_event::durable_definitions(),
            "session.tool.progress"
        ),
        Some(1),
        "stored progress rows still replay"
    );
    assert!(!has(
        &names(session_event::public_durable_definitions()),
        "session.tool.progress"
    ));
}

#[test]
fn deferred_and_timed_out_live_events_are_public_ephemeral_manifest_entries() {
    for name in NEW_LIVE {
        assert!(
            has(&event_manifest::definitions(), name),
            "{name}: event manifest"
        );
        assert!(
            has(&event_manifest::server_definitions(), name),
            "{name}: server manifest"
        );
        assert!(
            !has(&durable_event_manifest::definitions(), &format!("{name}.1")),
            "{name} is not durable"
        );
    }
}

#[test]
fn review_deferrals_cover_every_kind_payload_and_reason_without_changing_values() {
    for (kind, payload) in variants() {
        let data = deferred(kind, "sleep_entry", CALL, &payload, "");
        for decoded in [
            durable("session.review.deferred", &data).unwrap(),
            public("session.review.deferred", &data).unwrap(),
        ] {
            assert!(same(&decoded, &json(&data)), "{kind}: {payload}");
        }
    }
    let recovery = deferred(
        "recovery",
        "restart",
        r#"{"questionID":"qst_restart"}"#,
        RECOVERY,
        "",
    );
    assert!(same(
        &durable("session.review.deferred", &recovery).unwrap(),
        &json(&recovery)
    ));
    for reason in [
        "disabled",
        "free_text",
        "refused",
        "low_confidence",
        "escalated",
        "error",
        "timeout",
        "sleep_entry",
        "restart",
    ] {
        let data = deferred("guardrail", reason, CALL, &guardrail_payload(), "");
        assert!(
            durable("session.review.deferred", &data).is_ok(),
            "{reason}"
        );
    }
    for origin in [
        CALL,
        r#"{"questionID":"qst_review"}"#,
        r#"{"requestID":"per_review"}"#,
    ] {
        let data = deferred("guardrail", "escalated", origin, &guardrail_payload(), "");
        assert!(
            same(
                field(
                    &durable("session.review.deferred", &data).unwrap(),
                    "origin"
                )
                .unwrap(),
                &json(origin)
            ),
            "{origin}"
        );
    }
}

#[test]
fn review_deferrals_reject_unknown_kinds_reasons_origins_identities_and_payload_shapes() {
    let base = deferred("guardrail", "sleep_entry", CALL, &guardrail_payload(), "");
    let mut invalid = vec![
        base.replace(r#""kind":"guardrail""#, r#""kind":"form""#),
        base.replace(r#""kind":"guardrail""#, r#""kind":"incident""#),
        base.replace(r#""reason":"sleep_entry""#, r#""reason":"bogus""#),
        base.replace(r#""itemID":"rvw_first","#, ""),
        base.replace(
            r#""origin":{"messageID":"msg_ask","callID":"call_ask"},"#,
            "",
        ),
        base.replace(r#""payload":{"#, r#""unpayload":{"#),
        base.replace(r#""type":"guardrail""#, r#""type":"other""#),
        base.replace(r#""requestID":"grq_review""#, r#""requestID":"per_review""#),
        base.replace(&"a".repeat(64), "not-a-hash"),
        base.replace(&"a".repeat(64), &"A".repeat(64)),
        base.replace(&"a".repeat(64), &"a".repeat(63)),
        base.replace(&"a".repeat(64), &"a".repeat(65)),
        base.replace(r#""hardReview":true"#, r#""hardReview":"yes""#),
        base.replace(r#""directories":[]"#, r#""directories":"/""#),
    ];
    for id in ["rvwbad", "grq_review", "per_review", "rvw", ""] {
        invalid.push(base.replace(r#""itemID":"rvw_first""#, &format!(r#""itemID":"{id}""#)));
    }
    for origin in [
        "{}",
        r#"{"messageID":"msg_ask"}"#,
        r#"{"callID":"call_ask"}"#,
        r#"{"questionID":"wrong"}"#,
        r#"{"requestID":""}"#,
        "null",
    ] {
        invalid.push(deferred(
            "guardrail",
            "sleep_entry",
            origin,
            &guardrail_payload(),
            "",
        ));
    }
    invalid.push(deferred(
        "permission",
        "sleep_entry",
        CALL,
        &permission_payload().replace("per_review", "grq_review"),
        "",
    ));
    invalid.push(deferred(
        "recovery",
        "restart",
        r#"{"questionID":"qst_restart"}"#,
        r#"{"type":"recovery","tools":[]}"#,
        "",
    ));
    invalid.push(deferred(
        "recovery",
        "restart",
        r#"{"questionID":"qst_restart"}"#,
        r#"{"type":"recovery","tools":[{"messageID":"ses_tool","callID":"call_read","name":"read"}]}"#,
        "",
    ));
    for data in invalid {
        assert!(
            durable("session.review.deferred", &data).is_err(),
            "accepted {data}"
        );
    }
}

#[test]
fn helper_evidence_survives_exactly_and_is_never_invented() {
    let evidence = format!(r#","choice":"escalate","confidence":0.799999,"grades":{GRADES}"#);
    let data = deferred(
        "guardrail",
        "escalated",
        CALL,
        &guardrail_payload(),
        &evidence,
    );
    let decoded = durable("session.review.deferred", &data).unwrap();
    assert!(same(&decoded, &json(&data)));
    assert_eq!(
        field(&decoded, "confidence"),
        Some(&JsonValue::Number(0.799999))
    );
    for (kind, payload) in variants() {
        for reason in ["disabled", "free_text"] {
            let bare = deferred(kind, reason, CALL, &payload, "");
            let decoded = durable("session.review.deferred", &bare).unwrap();
            for absent in ["choice", "confidence", "grades"] {
                assert!(
                    field(&decoded, absent).is_none(),
                    "{kind} {reason} {absent}"
                );
            }
        }
    }
    for invalid in [
        r#","confidence":-0.01"#,
        r#","confidence":1.01"#,
        r#","confidence":null"#,
        r#","choice":null"#,
        r#","grades":null"#,
        r#","grades":{}"#,
        r#","grades":[{"choice":"approve_everything","confidence":0.5,"evidence":"x"}]"#,
        r#","grades":[{"choice":"approve","confidence":0.5,"evidence":""}]"#,
        r#","grades":[{"choice":"approve","confidence":0.5,"evidence":"   "}]"#,
        r#","grades":[{"choice":"approve","confidence":1.01,"evidence":"x"}]"#,
        r#","grades":[{"choice":"approve","confidence":-0.1,"evidence":"x"}]"#,
        r#","grades":[{"choice":"approve","confidence":0.5}]"#,
    ] {
        let data = deferred(
            "guardrail",
            "escalated",
            CALL,
            &guardrail_payload(),
            invalid,
        );
        assert!(
            durable("session.review.deferred", &data).is_err(),
            "{invalid}"
        );
    }
    let long = format!(
        r#","grades":[{{"choice":"approve","confidence":0.5,"evidence":"{}"}}]"#,
        "e".repeat(501)
    );
    assert!(
        durable(
            "session.review.deferred",
            &deferred("guardrail", "escalated", CALL, &guardrail_payload(), &long)
        )
        .is_err()
    );
    let limit = format!(
        r#","grades":[{{"choice":"approve","confidence":0.5,"evidence":"{}"}}]"#,
        "e".repeat(500)
    );
    assert!(
        durable(
            "session.review.deferred",
            &deferred("guardrail", "escalated", CALL, &guardrail_payload(), &limit)
        )
        .is_ok()
    );
}

#[test]
fn payloads_keep_only_their_declared_fields_so_restart_recovery_never_retains_tool_input() {
    let with_input = RECOVERY.replace(
        r#""name":"read""#,
        r#""name":"read","input":{"path":"/secret"}"#,
    );
    let data = deferred(
        "recovery",
        "restart",
        r#"{"questionID":"qst_restart"}"#,
        &with_input,
        "",
    );
    let decoded = durable("session.review.deferred", &data).unwrap();
    assert!(same(field(&decoded, "payload").unwrap(), &json(RECOVERY)));
    let wide = guardrail_payload().replace(
        r#""reason":"Review action""#,
        r#""reason":"Review action","command":"echo secret","metadata":{"path":"/secret"}"#,
    );
    let data = deferred("guardrail", "sleep_entry", CALL, &wide, "");
    let decoded = durable("session.review.deferred", &data).unwrap();
    assert!(same(
        field(&decoded, "payload").unwrap(),
        &json(&guardrail_payload())
    ));
}

#[test]
fn human_decisions_are_kind_tagged_answers_dismissals_and_live_approval_replies() {
    let mut valid = vec![
        r#"{"kind":"question","answers":{"choice":"A","enabled":true,"count":2}}"#.to_owned(),
        r#"{"kind":"question","answers":{"picked":["A","B"]}}"#.to_owned(),
        r#"{"kind":"question","answers":[["A"],["B","C"]]}"#.to_owned(),
        r#"{"kind":"subagent_question","text":"Proceed","data":{"plan":"A"}}"#.to_owned(),
        r#"{"kind":"subagent_question","text":"Proceed"}"#.to_owned(),
        r#"{"kind":"question","dismissed":true}"#.to_owned(),
        r#"{"kind":"subagent_question","dismissed":true}"#.to_owned(),
        r#"{"kind":"recovery","choice":"continue"}"#.to_owned(),
        r#"{"kind":"recovery","choice":"stop"}"#.to_owned(),
    ];
    for kind in ["guardrail", "permission"] {
        for reply in ["once", "always", "reject"] {
            valid.push(format!(r#"{{"kind":"{kind}","reply":"{reply}"}}"#));
        }
    }
    for decision in &valid {
        let data = decided(decision);
        let decoded = durable("session.review.decided", &data).unwrap();
        assert!(same(&decoded, &json(&data)), "{decision}");
    }
    for decision in [
        r#"{"kind":"guardrail","reply":"approve"}"#,
        r#"{"kind":"permission","dismissed":true}"#,
        r#"{"kind":"guardrail","dismissed":true}"#,
        r#"{"kind":"recovery","dismissed":true}"#,
        r#"{"kind":"recovery","choice":"retry"}"#,
        r#"{"kind":"recovery"}"#,
        r#"{"kind":"question"}"#,
        r#"{"kind":"question","dismissed":false}"#,
        r#"{"kind":"subagent_question","answers":[]}"#,
        r#"{"kind":"form","answers":{}}"#,
        r#"{"reply":"once"}"#,
        r#""once""#,
        "null",
    ] {
        assert!(
            durable("session.review.decided", &decided(decision)).is_err(),
            "accepted {decision}"
        );
    }
}

#[test]
fn review_withdrawal_and_consumption_carry_only_canonical_identities() {
    for reason in ["reverted", "task_closed"] {
        let data =
            format!(r#"{{"sessionID":"ses_child","itemID":"rvw_first","reason":"{reason}"}}"#);
        assert!(same(
            &durable("session.review.withdrawn", &data).unwrap(),
            &json(&data)
        ));
    }
    for reason in ["timeout", "restart", "", "Reverted"] {
        let data =
            format!(r#"{{"sessionID":"ses_child","itemID":"rvw_first","reason":"{reason}"}}"#);
        assert!(
            durable("session.review.withdrawn", &data).is_err(),
            "{reason}"
        );
    }
    let consumed = r#"{"sessionID":"ses_child","itemID":"rvw_first"}"#;
    assert!(same(
        &durable("session.review.consumed", consumed).unwrap(),
        &json(consumed)
    ));
    let leaked = r#"{"sessionID":"ses_child","itemID":"rvw_first","fingerprint":"aaaaaaaa","payload":{"x":1}}"#;
    assert!(same(
        &durable("session.review.consumed", leaked).unwrap(),
        &json(consumed)
    ));
    for kind in ["session.review.consumed", "session.review.withdrawn"] {
        for id in ["rvwbad", "grq_review", "per_review", "msg_first"] {
            let data =
                format!(r#"{{"sessionID":"ses_child","itemID":"{id}","reason":"reverted"}}"#);
            assert!(durable(kind, &data).is_err(), "{kind} {id}");
        }
    }
}

#[test]
fn guardrail_provenance_decodes_old_rows_and_preserves_grades_rule_ids_and_tool_identity() {
    let cases = [
        (
            "session.guardrail.decided",
            r#"{"sessionID":"ses_root","reviewSessionID":"ses_root","requestID":"grq_decided","reply":"once"}"#,
            r#","choice":"approve_all","confidence":0.9"#,
        ),
        (
            "session.guardrail.escalated",
            r#"{"sessionID":"ses_root","requestID":"grq_escalated"}"#,
            r#","choice":"escalate","confidence":0.6"#,
        ),
    ];
    let leaked = r#","action":"shell","resources":["echo secret"],"metadata":{"a":1},"evidence":"e","targets":["/secret"]"#;
    for (kind, old, choice) in cases {
        assert!(
            same(&durable(kind, old).unwrap(), &json(old)),
            "{kind}: old row"
        );
        let current = format!(
            r#"{}{choice},"grades":{GRADES},"ruleIDs":["standard.review.outside-repo"],"source":{SOURCE}}}"#,
            open(old)
        );
        assert!(
            same(&durable(kind, &current).unwrap(), &json(&current)),
            "{kind}: current row"
        );
        let wide = format!("{}{leaked}}}", open(&current));
        assert!(
            same(&durable(kind, &wide).unwrap(), &json(&current)),
            "{kind}: fields beyond provenance are dropped"
        );
        assert!(public(kind, &current).is_ok(), "{kind}: public decoding");
    }
    let decided = r#"{"sessionID":"ses_root","reviewSessionID":"ses_root","requestID":"grq_always","reply":"always","choice":"approve_all","confidence":0.9}"#;
    assert!(durable("session.guardrail.decided", decided).is_ok());
    assert!(
        durable(
            "session.guardrail.decided",
            &decided.replace(r#""reply":"always""#, r#""reply":"approve""#)
        )
        .is_err()
    );
}

#[test]
fn guardrail_choices_grades_and_sources_reject_malformed_values() {
    let decided = |extra: &str| {
        format!(
            r#"{{"sessionID":"ses_root","reviewSessionID":"ses_root","requestID":"grq_x","reply":"once"{extra}}}"#
        )
    };
    let escalated =
        |extra: &str| format!(r#"{{"sessionID":"ses_root","requestID":"grq_x"{extra}}}"#);
    for choice in ["approve_all", "approve", "reject", "escalate"] {
        let extra = format!(r#","choice":"{choice}""#);
        assert!(durable("session.guardrail.decided", &decided(&extra)).is_ok());
        assert!(durable("session.guardrail.escalated", &escalated(&extra)).is_ok());
    }
    for invalid in [
        r#","choice":"approve-all""#,
        r#","choice":"always""#,
        r#","choice":null"#,
        r#","confidence":1.01"#,
        r#","confidence":-0.01"#,
        r#","grades":[{"choice":"approve","confidence":0.5,"evidence":""}]"#,
        r#","grades":[{"choice":"approve","confidence":0.5,"evidence":" "}]"#,
        r#","grades":[{"choice":"approve","confidence":1.01,"evidence":"x"}]"#,
        r#","grades":[{"choice":"maybe","confidence":0.5,"evidence":"x"}]"#,
        r#","grades":"none""#,
        r#","ruleIDs":"review""#,
        r#","ruleIDs":[1]"#,
        r#","source":{"callID":"call_guardrail"}"#,
        r#","source":{"messageID":"msg_guardrail"}"#,
        r#","source":{"messageID":"ses_guardrail","callID":"call_guardrail"}"#,
        r#","source":null"#,
    ] {
        assert!(
            durable("session.guardrail.decided", &decided(invalid)).is_err(),
            "decided accepted {invalid}"
        );
        assert!(
            durable("session.guardrail.escalated", &escalated(invalid)).is_err(),
            "escalated accepted {invalid}"
        );
    }
    let long = format!(
        r#","grades":[{{"choice":"approve","confidence":0.5,"evidence":"{}"}}]"#,
        "e".repeat(501)
    );
    assert!(durable("session.guardrail.decided", &decided(&long)).is_err());
}

#[test]
fn standard_match_dismissals_keep_their_bounds_and_gain_an_optional_tool_source() {
    let base = r#"{"sessionID":"ses_root","reviewSessionID":"ses_child","ruleID":"standard.review.force-push","confidence":0.9}"#;
    assert!(same(
        &durable("session.guardrail.dismissed", base).unwrap(),
        &json(base)
    ));
    let sourced = format!(r#"{},"source":{SOURCE}}}"#, open(base));
    assert!(same(
        &durable("session.guardrail.dismissed", &sourced).unwrap(),
        &json(&sourced)
    ));
    for invalid in [
        base.replace("standard.review.force-push", "custom.review.force-push"),
        base.replace("standard.review.force-push", "standard.reviewer.force-push"),
        base.replace("standard.review.force-push", "standard.review"),
        base.replace("0.9", "0.89"),
        base.replace("0.9", "1.01"),
        base.replace(r#""reviewSessionID":"ses_child","#, ""),
        sourced.replace(r#""callID":"call_guardrail""#, r#""callID":1"#),
    ] {
        assert!(
            durable("session.guardrail.dismissed", &invalid).is_err(),
            "accepted {invalid}"
        );
    }
}

#[test]
fn step_reroutes_are_public_durable_facts_and_recorded_on_the_assistant_message() {
    let data = format!(
        r#"{{"sessionID":"ses_child","assistantMessageID":"msg_assistant","model":{FALLBACK},"error":{ERROR}}}"#
    );
    assert!(same(
        &durable("session.step.rerouted", &data).unwrap(),
        &json(&data)
    ));
    assert!(public("session.step.rerouted", &data).is_ok());
    for invalid in [
        data.replace(r#""assistantMessageID":"msg_assistant","#, ""),
        data.replace("msg_assistant", "ses_assistant"),
        data.replace(&format!(r#""model":{FALLBACK},"#), ""),
        data.replace(&format!(r#","error":{ERROR}"#), ""),
        data.replace(
            r#""model":{"providerID":"anthropic","id":"claude"}"#,
            r#""model":"claude""#,
        ),
    ] {
        assert!(
            durable("session.step.rerouted", &invalid).is_err(),
            "accepted {invalid}"
        );
    }

    let assistant = r#"{"id":"msg_assistant","type":"assistant","agent":"build","model":{"providerID":"openai","id":"gpt"},"content":[],"time":{"created":0}}"#;
    let reroute = format!(r#"{{"from":{MODEL},"model":{FALLBACK},"error":{ERROR}}}"#);
    let with = format!(r#"{},"reroutes":[{reroute}]}}"#, open(assistant));
    let decoded = session_message::Assistant::decode(&json(&with)).unwrap();
    assert!(same(&decoded.encode(), &json(&with)));
    let plain = session_message::Assistant::decode(&json(assistant)).unwrap();
    assert!(field(&plain.encode(), "reroutes").is_none());
    for invalid in [
        with.replace(&format!(r#""from":{MODEL},"#), ""),
        with.replace(&format!(r#","error":{ERROR}"#), ""),
        format!(r#"{},"reroutes":{{}}}}"#, open(assistant)),
        with.replace(r#""reroutes":[{"#, r#""reroutes":[1,{"#),
    ] {
        assert!(
            session_message::Assistant::decode(&json(&invalid)).is_err(),
            "accepted {invalid}"
        );
    }
}

#[test]
fn form_state_records_timeouts_and_deferral_to_a_review_item() {
    for state in [
        r#"{"status":"timed_out","seconds":30}"#,
        r#"{"status":"deferred","itemID":"rvw_first"}"#,
        r#"{"status":"pending"}"#,
        r#"{"status":"cancelled"}"#,
        r#"{"status":"answered","answer":{"choice":"A"}}"#,
    ] {
        let decoded = form::State::decode(&json(state)).unwrap();
        assert!(same(&decoded.encode(), &json(state)), "{state}");
    }
    for state in [
        r#"{"status":"deferred"}"#,
        r#"{"status":"deferred","itemID":"qst_first"}"#,
        r#"{"status":"deferred","itemID":"rvw"}"#,
        r#"{"status":"timed_out"}"#,
        r#"{"status":"timed_out","seconds":0}"#,
        r#"{"status":"timed_out","seconds":-1}"#,
        r#"{"status":"timed_out","seconds":1.5}"#,
        r#"{"status":"expired"}"#,
    ] {
        assert!(
            form::State::decode(&json(state)).is_err(),
            "accepted {state}"
        );
    }
}

#[test]
fn numeric_form_fields_and_conditions_reject_non_finite_values_in_every_transport_direction() {
    for kind in ["number", "integer"] {
        let finite = format!(
            r#"{{"key":"count","type":"{kind}","minimum":0,"maximum":10,"default":2,"when":[{{"key":"enabled","op":"eq","value":1}}]}}"#
        );
        let decoded = form::Field::decode(&json(&finite)).unwrap();
        assert!(same(&decoded.encode(), &json(&finite)), "{kind}");
        for value in [f64::INFINITY, f64::NEG_INFINITY, f64::NAN] {
            for property in ["minimum", "maximum", "default"] {
                let object = ObjectEncoder::new()
                    .field("key", &LosslessString::from("count"))
                    .field("type", &LosslessString::from(kind))
                    .field(property, &value)
                    .finish();
                assert!(
                    form::Field::decode(&object).is_err(),
                    "{kind}.{property}={value}"
                );
            }
        }
    }
    for value in [f64::INFINITY, f64::NEG_INFINITY, f64::NAN] {
        let object = ObjectEncoder::new()
            .field("key", &LosslessString::from("enabled"))
            .field("op", &LosslessString::from("eq"))
            .field("value", &value)
            .finish();
        assert!(form::When::decode(&object).is_err(), "{value}");
    }
}

#[test]
fn task_changes_record_resumed_recovery_and_question_timeouts() {
    for change in [
        r#"{"type":"resumed"}"#,
        r#"{"type":"question_timed_out","questionID":"qst_review"}"#,
    ] {
        let decoded = Change::decode(&json(change)).unwrap();
        assert!(same(&decoded.encode(), &json(change)), "{change}");
        let data = format!(r#"{{"sessionID":"ses_child","change":{change}}}"#);
        assert!(
            same(
                field(&durable("session.task.updated", &data).unwrap(), "change").unwrap(),
                &json(change)
            ),
            "{change}"
        );
    }
    for change in [
        r#"{"type":"question_timed_out"}"#,
        r#"{"type":"question_timed_out","questionID":"que_review"}"#,
        r#"{"type":"resumed_all"}"#,
    ] {
        assert!(Change::decode(&json(change)).is_err(), "accepted {change}");
    }
    let notification = r#"{"id":"ntf_1","parentID":"ses_parent","childID":"ses_child","type":"resumed","revision":2}"#;
    let decoded = Notification::decode(&json(notification)).unwrap();
    assert!(same(&decoded.encode(), &json(notification)));
    assert!(Notification::decode(&json(&notification.replace("resumed", "revived"))).is_err());
}

#[test]
fn tasks_expose_a_stopped_recovery_item_and_questions_record_deferral() {
    let base = r#"{"sessionID":"ses_child","parentID":"ses_parent","description":"Implement projection","agent":"build","model":{"providerID":"openai","id":"gpt"},"background":true,"state":"lost","revision":4,"time":{"created":1,"updated":2}}"#;
    let stopped = format!(
        "{},{}",
        open(base),
        r#""stoppedRecovery":{"itemID":"rvw_restart"}}"#
    );
    let decoded = Task::decode(&json(&stopped)).unwrap();
    assert!(same(&decoded.encode(), &json(&stopped)));
    let plain = Task::decode(&json(base)).unwrap();
    assert!(field(&plain.encode(), "stoppedRecovery").is_none());
    for invalid in [
        stopped.replace("rvw_restart", "qst_restart"),
        stopped.replace(r#""itemID":"rvw_restart""#, r#""item":"rvw_restart""#),
        stopped.replace(r#"{"itemID":"rvw_restart"}"#, r#""rvw_restart""#),
    ] {
        assert!(Task::decode(&json(&invalid)).is_err(), "accepted {invalid}");
    }

    let question = r#"{"id":"qst_review","text":"Which plan?","time":1,"deferred":true}"#;
    let decoded = Question::decode(&json(question)).unwrap();
    assert!(same(&decoded.encode(), &json(question)));
    let plain = Question::decode(&json(
        r#"{"id":"qst_review","text":"Which plan?","time":1}"#,
    ))
    .unwrap();
    assert!(field(&plain.encode(), "deferred").is_none());
    assert!(Question::decode(&json(&question.replace("true", r#""yes""#))).is_err());
}

#[test]
fn stored_progress_and_usage_anchor_fields_keep_decoding_unchanged() {
    let task = r#"{"sessionID":"ses_child","parentID":"ses_parent","description":"Implement projection","agent":"build","model":{"providerID":"openai","id":"gpt"},"background":true,"state":"running","progress":{"text":"Reading files","time":3},"revision":2,"time":{"created":1,"updated":3}}"#;
    let decoded = Task::decode(&json(task)).unwrap();
    assert!(same(&decoded.encode(), &json(task)));
    let progressed = r#"{"type":"progressed","progress":{"text":"Reading files","time":3}}"#;
    assert!(same(
        &Change::decode(&json(progressed)).unwrap().encode(),
        &json(progressed)
    ));
    let anchor = r#"{"sessionID":"ses_root","inputID":"msg_user"}"#;
    let admitted = format!(
        r#"{{"sessionID":"ses_child","inputID":"msg_child","input":{{"type":"user","data":{{"text":"work"}},"delivery":"steer"}},"causedBy":{anchor}}}"#
    );
    let decoded = durable("session.input.admitted", &admitted).unwrap();
    assert!(same(field(&decoded, "causedBy").unwrap(), &json(anchor)));
    let compaction =
        format!(r#"{{"sessionID":"ses_child","jobID":"cmp_job","usageAnchor":{anchor}}}"#);
    let envelope_v2 = json(&format!(
        r#"{{"id":"evt_review","created":1,"type":"session.compaction.admitted","durable":{{"aggregateID":"ses_child","seq":0,"version":2}},"data":{compaction}}}"#
    ));
    let event = session_event::DurableEvent::decode(&envelope_v2).unwrap();
    assert!(same(
        field(&JsonValue::Object(event.0.data.0), "usageAnchor").unwrap(),
        &json(anchor)
    ));
}
