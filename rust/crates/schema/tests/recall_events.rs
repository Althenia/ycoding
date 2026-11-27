use ycoding_schema::{
    DecodeError, DomainDecode, JsonValue, durable_event_manifest, event_manifest, parse_json,
    session_event,
};

fn durable(kind: &str, data: &str) -> Result<JsonValue, DecodeError> {
    let envelope = parse_json(&format!(
        r#"{{"id":"evt_recall","created":1,"type":"{kind}","durable":{{"aggregateID":"ses_recall","seq":0,"version":1}},"data":{data}}}"#
    ))
    .unwrap();
    session_event::PublicDurableEvent::decode(&envelope)
        .map(|event| JsonValue::Object(event.0.data.0))
}

fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&key.into()),
        _ => None,
    }
}

const ITEM: &str = r#"{"kind":"memory","id":"decisions/cobalt","stage":"injected","method":"rrf","scores":{"bm25":1.5,"semantic":0.25,"rrf":0.03,"rank":0},"reason":"matched cue","source":{"id":"memory:repository/decisions/cobalt","revision":"sha256:abc"},"okf":{"type":"Decision","trust":"trusted","freshness":"fresh","lifecycle":"active"},"tokens":120}"#;

fn recorded(items: &str, extra: &str) -> String {
    format!(
        r#"{{"sessionID":"ses_recall","key":"k1","trigger":"cue","methods":["cue","rrf"],"outcome":"injected","items":{items},"elapsedMs":3,"injectedTokens":120{extra}}}"#
    )
}

#[test]
fn both_events_are_public_durable_manifest_entries() {
    for name in ["session.cue.detected", "session.recall.recorded"] {
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
fn cue_detection_accepts_every_trusted_cue_kind_and_nothing_else() {
    for kind in [
        "explicit",
        "command",
        "path",
        "symbol",
        "tool_call",
        "tool_result",
        "tool_error",
        "workspace",
        "lifecycle",
        "compaction",
        "recovery",
        "memory_revision",
        "skill_revision",
    ] {
        let data = format!(r#"{{"sessionID":"ses_recall","cueID":"c1","kind":"{kind}"}}"#);
        assert!(durable("session.cue.detected", &data).is_ok(), "{kind}");
    }
    for data in [
        r#"{"sessionID":"ses_recall","cueID":"c1","kind":"prompt-text"}"#,
        r#"{"sessionID":"ses_recall","cueID":"","kind":"command"}"#,
        r#"{"sessionID":"ses_recall","kind":"command"}"#,
    ] {
        assert!(durable("session.cue.detected", data).is_err(), "{data}");
    }
    let long = "a".repeat(513);
    let data =
        format!(r#"{{"sessionID":"ses_recall","cueID":"c1","kind":"path","subject":"{long}"}}"#);
    assert!(durable("session.cue.detected", &data).is_err());
}

#[test]
fn recall_record_keeps_candidate_selected_and_injected_stages_distinct() {
    let items = format!(
        "[{ITEM},{},{}]",
        ITEM.replace("injected", "candidate"),
        ITEM.replace("\"injected\"", "\"rejected\",\"rejection\":\"stale\"")
    );
    let decoded = durable("session.recall.recorded", &recorded(&items, "")).unwrap();
    let JsonValue::Array(items) = field(&decoded, "items").unwrap() else {
        panic!("items")
    };
    let stages: Vec<_> = items
        .iter()
        .map(|item| field(item, "stage").cloned())
        .collect();
    assert_eq!(
        stages,
        ["injected", "candidate", "rejected"]
            .map(|stage| Some(parse_json(&format!("\"{stage}\"")).unwrap()))
    );
    assert_eq!(
        field(&items[2], "rejection"),
        Some(&parse_json(r#""stale""#).unwrap())
    );
}

#[test]
fn recall_record_supports_abstention_and_restoration() {
    let abstained = recorded("[]", r#","abstention":"no_match","budgetTokens":2048"#)
        .replace("\"outcome\":\"injected\"", "\"outcome\":\"abstained\"");
    assert!(durable("session.recall.recorded", &abstained).is_ok());
    let restored = recorded(&format!("[{}]", ITEM.replace("injected", "restored")), "")
        .replace("\"trigger\":\"cue\"", "\"trigger\":\"compaction\"")
        .replace("\"outcome\":\"injected\"", "\"outcome\":\"restored\"");
    assert!(durable("session.recall.recorded", &restored).is_ok());
}

#[test]
fn recall_record_rejects_forged_or_unbounded_fields() {
    let too_many = format!("[{}]", vec![ITEM; 65].join(","));
    assert!(durable("session.recall.recorded", &recorded(&too_many, "")).is_err());
    for broken in [
        ITEM.replace("\"memory\"", "\"transcript\""),
        ITEM.replace("\"rrf\"", "\"llm\""),
        ITEM.replace("\"injected\"", "\"approved\""),
        ITEM.replace("\"trusted\"", "\"admin\""),
        ITEM.replace("\"fresh\"", "\"eternal\""),
        ITEM.replace("\"active\"", "\"zombie\""),
        ITEM.replace("\"revision\":\"sha256:abc\"", "\"revision\":\"\""),
        ITEM.replace("1.5", "null"),
        ITEM.replace("\"tokens\":120", "\"tokens\":-1"),
        ITEM.replace(
            "\"reason\":\"matched cue\"",
            &format!("\"reason\":\"{}\"", "r".repeat(201)),
        ),
    ] {
        let items = format!("[{broken}]");
        assert!(
            durable("session.recall.recorded", &recorded(&items, "")).is_err(),
            "{broken}"
        );
    }
    for invalid in [r#","abstention":"because""#, r#","budgetTokens":-1"#] {
        assert!(
            durable("session.recall.recorded", &recorded("[]", invalid)).is_err(),
            "{invalid}"
        );
    }
    let methods = recorded("[]", "").replace(
        r#"["cue","rrf"]"#,
        r#"["explicit","cue","exact","bm25","semantic","rrf","rrf"]"#,
    );
    assert!(durable("session.recall.recorded", &methods).is_err());
    let unknown = recorded("[]", r#","body":"secret text""#);
    let decoded = durable("session.recall.recorded", &unknown).unwrap();
    assert_eq!(field(&decoded, "body"), None);
}
