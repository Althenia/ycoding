use ycoding_core::session::store::Service;
use ycoding_schema::{DomainEncode, JsonValue, parse_json, session};
use ycoding_store::{
    Error, Store,
    session::{Message, MessageTable},
};

#[path = "autonomy_support/mod.rs"]
mod support;

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn json(value: &str) -> JsonValue {
    parse_json(value).unwrap()
}

fn seed(store: &Store, session: &str, rows: &[(&str, &str, i64, String)]) {
    let rows = rows
        .iter()
        .map(|(id, type_, seq, data)| Message {
            id: (*id).into(),
            session_id: session.into(),
            type_: (*type_).into(),
            seq: *seq,
            time_created: *seq,
            time_updated: *seq,
            data: parse_json(data).unwrap(),
        })
        .collect::<Vec<_>>();
    store
        .submit(move |tx| {
            rows.iter()
                .try_for_each(|row| MessageTable::insert(tx, row))
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn fixture() -> Vec<(&'static str, &'static str, i64, String)> {
    vec![
        (
            "msg_capture_user",
            "user",
            0,
            r#"{"text":"private prompt"}"#.into(),
        ),
        (
            "msg_capture_step",
            "assistant",
            1,
            format!(
                r#"{{"text":"private text","content":[
                {{"type":"text","text":"{}"}},
                {{"type":"reasoning","text":"private reasoning"}},
                {{"type":"tool","name":"read","state":{{"status":"completed","content":[{{"type":"text","text":"private output"}}]}}}},
                {{"type":"tool","id":"call_edit","name":"edit","state":{{"status":"completed","content":[{{"type":"text","text":"private output"}}],"input":{{"path":"private input"}},"structured":{{"files":[{{"file":"a.ts","patch":"--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new","secret":"private file metadata"}}],"secret":"private extra"}}}}}},
                {{"type":"tool","id":"call_send","name":"subagent_control","state":{{"status":"completed","input":{{"questionID":"question_1","text":"private input"}},"structured":{{"action":"send","task":{{"sessionID":"ses_child","secret":"private task"}}}}}}}}
                ]}}"#,
                "x".repeat(100_000)
            ),
        ),
        (
            "msg_capture_ignored",
            "compaction",
            2,
            r#"{"status":"completed","reason":"manual","summary":"private checkpoint"}"#.into(),
        ),
        (
            "msg_capture_reply",
            "assistant",
            3,
            r#"{"content":[{"type":"text","text":"final placement"}]}"#.into(),
        ),
        (
            "msg_capture_boundary",
            "synthetic",
            4,
            r#"{"text":"private synthetic","metadata":{"kind":"answer","questionID":"question_1","secret":"private metadata"}}"#.into(),
        ),
    ]
}

fn setup() -> (Store, Service) {
    let store = support::store();
    seed(&store, "ses_one", &fixture());
    let service = Service::new(store.client());
    (store, service)
}

fn page(service: &Service, after: Option<i64>, limit: usize) -> JsonValue {
    service
        .captured_inputs(&id("ses_one"), after, limit)
        .unwrap()
        .encode()
}

#[test]
fn pages_minimal_canonical_attribution_records_without_transcript_payloads() {
    let (_store, service) = setup();
    let first = page(&service, None, 2);
    assert_eq!(
        first,
        json(
            r#"{"data":[
            {"id":"msg_capture_user","type":"user"},
            {"id":"msg_capture_step","type":"assistant","content":[
              {"type":"tool","id":"call_edit","name":"edit","state":{"status":"completed","structured":{"files":[{"file":"a.ts","patch":"--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new"}]}}},
              {"type":"tool","id":"call_send","name":"subagent_control","state":{"status":"completed","input":{"questionID":"question_1"},"structured":{"action":"send","task":{"sessionID":"ses_child"}}}}
            ]}],"next":1}"#
        )
    );
    assert!(ycoding_schema::stringify_json(&first).len() < 1000);
    assert_eq!(
        page(&service, Some(1), 2),
        json(
            r#"{"data":[
            {"id":"msg_capture_reply","type":"assistant","content":[]},
            {"id":"msg_capture_boundary","type":"synthetic","metadata":{"kind":"answer","questionID":"question_1"}}]}"#
        )
    );
}

#[test]
fn the_cursor_is_exclusive_and_a_page_past_the_end_is_empty() {
    let (_store, service) = setup();
    assert_eq!(page(&service, Some(4), 200), json(r#"{"data":[]}"#));
    assert_eq!(page(&service, Some(3), 200), page(&service, Some(3), 1));
    assert_eq!(
        page(&service, Some(0), 1),
        json(
            r#"{"data":[{"id":"msg_capture_step","type":"assistant","content":[{"type":"tool","id":"call_edit","name":"edit","state":{"status":"completed","structured":{"files":[{"file":"a.ts","patch":"--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new"}]}}},{"type":"tool","id":"call_send","name":"subagent_control","state":{"status":"completed","input":{"questionID":"question_1"},"structured":{"action":"send","task":{"sessionID":"ses_child"}}}}]}],"next":1}"#
        )
    );
}

#[test]
fn a_session_with_no_records_and_another_sessions_records_stay_separate() {
    let (store, service) = setup();
    seed(
        &store,
        "ses_two",
        &[("msg_other", "user", 0, r#"{"text":"other"}"#.into())],
    );
    let two = service
        .captured_inputs(&id("ses_two"), None, 200)
        .unwrap()
        .encode();
    assert_eq!(two, json(r#"{"data":[{"id":"msg_other","type":"user"}]}"#));
    assert_eq!(page(&service, None, 200), page(&service, None, 5));
}

#[test]
fn patch_bytes_are_preserved_exactly() {
    let store = support::store();
    seed(
        &store,
        "ses_one",
        &[(
            "msg_patch",
            "assistant",
            0,
            r#"{"content":[{"type":"tool","name":"apply_patch","state":{"structured":{"files":[{"patch":"a\r\n\u0000\ud800 b","status":"modified","file":"f"},{"patch":42},{"file":"no-patch"},"x"]}}}]}"#.into(),
        )],
    );
    let service = Service::new(store.client());
    assert_eq!(
        page(&service, None, 200),
        json(
            r#"{"data":[{"id":"msg_patch","type":"assistant","content":[{"type":"tool","name":"apply_patch","state":{"structured":{"files":[{"file":"f","patch":"a\r\n\u0000\ud800 b","status":"modified"}]}}}]}]}"#
        )
    );
}

#[test]
fn invalid_pages_missing_sessions_and_undecodable_records_are_rejected() {
    let (store, service) = setup();
    for (after, limit) in [(None, 0), (None, 201), (Some(-1), 10)] {
        assert!(matches!(
            service.captured_inputs(&id("ses_one"), after, limit),
            Err(Error::Rejected(_))
        ));
    }
    assert!(matches!(
        service.captured_inputs(&id("ses_missing"), None, 10),
        Err(Error::Domain {
            kind: "not_found",
            ..
        })
    ));
    seed(
        &store,
        "ses_one",
        &[(
            "msg_bad_captured",
            "assistant",
            5,
            r#"{"content":[{"type":"tool","name":"edit","state":{"status":42}}]}"#.into(),
        )],
    );
    assert!(matches!(
        service.captured_inputs(&id("ses_one"), Some(1), 200),
        Err(Error::Record(_))
    ));
    assert!(service.captured_inputs(&id("ses_one"), None, 1).is_ok());
}
