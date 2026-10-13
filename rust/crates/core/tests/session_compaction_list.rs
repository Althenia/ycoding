use ycoding_core::session::store::Service;
use ycoding_schema::{DomainEncode, JsonValue, parse_json, session};
use ycoding_store::{
    Error, Store,
    session::{Message, MessageTable, SessionTable},
};

#[path = "autonomy_support/mod.rs"]
mod support;

const JOBS: i64 = 105;
const WINDOW: usize = 100;

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn job_id(index: i64) -> String {
    format!("cmp_job{index:03}")
}

fn created(index: i64) -> i64 {
    1000 + index / 2
}

fn status(index: i64) -> &'static str {
    match index % 10 {
        3 => "failed",
        7 => "pending",
        _ => "completed",
    }
}

fn input_tokens(index: i64) -> i64 {
    1000 + index
}

fn data(job: &str, status: &str, created: i64, index: i64) -> String {
    let base = format!(r#""jobID":"{job}","trigger":"manual","time":{{"created":{created}}}"#);
    match status {
        "pending" => format!(r#"{{{base},"status":"pending"}}"#),
        "failed" => format!(
            r#"{{{base},"status":"failed","code":"provider_failed","error":{{"type":"provider","message":"failed"}}}}"#
        ),
        _ => format!(
            r#"{{{base},"status":"completed","revision":0,"boundary":{{"messageID":"msg_boundary","seq":0}},"metrics":{{"excludedMessages":{index},"excludedParts":1,"inputTokens":{},"retainedTokens":100}},"summary":"{}"}}"#,
            input_tokens(index),
            "x".repeat(2000)
        ),
    }
}

fn row(session: &str, message: String, seq: i64, data: &str) -> Message {
    Message {
        id: message.into(),
        session_id: session.into(),
        type_: "compaction".into(),
        seq,
        time_created: seq * 3,
        time_updated: seq * 3,
        data: parse_json(data).unwrap(),
    }
}

fn seed(store: &Store, rows: Vec<Message>) {
    store
        .submit(move |tx| {
            for row in &rows {
                MessageTable::insert(tx, row)?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn history(service: &Service, session: &str) -> JsonValue {
    service.compaction_history(&id(session)).unwrap().encode()
}

fn field<'a>(value: &'a JsonValue, name: &str) -> &'a JsonValue {
    let JsonValue::Object(object) = value else {
        panic!("object expected");
    };
    object.get(&name.into()).unwrap()
}

fn items(history: &JsonValue) -> &Vec<JsonValue> {
    let JsonValue::Array(items) = field(history, "data") else {
        panic!("data array expected");
    };
    items
}

fn job(history: &JsonValue, index: i64) -> &JsonValue {
    items(history)
        .iter()
        .find(|item| field(item, "jobID") == &JsonValue::String(job_id(index).as_str().into()))
        .unwrap()
}

fn expected(json: &str) -> JsonValue {
    parse_json(json).unwrap()
}

fn seeded() -> (Store, Service) {
    let store = support::store();
    let mut rows = (0..JOBS)
        .map(|index| {
            row(
                "ses_one",
                format!("msg_{}", job_id(index)),
                1000 - index,
                &data(&job_id(index), status(index), created(index), index),
            )
        })
        .collect::<Vec<_>>();
    rows.push(row(
        "ses_one",
        "msg_legacy_compaction".into(),
        2000,
        r#"{"reason":"auto","status":"completed","summary":"legacy","recent":"legacy","time":{"created":1}}"#,
    ));
    rows.push(row(
        "ses_two",
        "msg_cmp_bystander".into(),
        1,
        &data("cmp_bystander", "completed", 5000, 900),
    ));
    seed(&store, rows);
    store
        .submit(|tx| SessionTable::insert(tx, &support::record("ses_empty")))
        .unwrap()
        .wait()
        .unwrap();
    let service = Service::new(store.client());
    (store, service)
}

#[test]
fn summarizes_every_job_keyed_compaction_of_one_session_bounded_to_the_newest_100() {
    let (_store, service) = seeded();
    let history = history(&service, "ses_one");
    let completed = (0..JOBS)
        .filter(|index| status(*index) == "completed")
        .collect::<Vec<_>>();
    let newest = (JOBS - WINDOW as i64)..JOBS;

    assert_eq!(
        items(&history)
            .iter()
            .map(|item| field(item, "jobID").clone())
            .collect::<Vec<_>>(),
        newest
            .clone()
            .map(|index| JsonValue::String(job_id(index).as_str().into()))
            .collect::<Vec<_>>()
    );
    assert_eq!(field(&history, "truncated"), &JsonValue::Bool(true));
    assert_eq!(
        field(&history, "completedCount"),
        &JsonValue::Number(completed.len() as f64)
    );
    assert_eq!(
        field(&history, "completedBefore"),
        &JsonValue::Number(
            completed
                .iter()
                .filter(|index| !newest.contains(index))
                .count() as f64
        )
    );
    assert_eq!(
        field(&history, "totalSavedTokens"),
        &JsonValue::Number(
            completed
                .iter()
                .map(|index| input_tokens(*index) - 100)
                .sum::<i64>() as f64
        )
    );
    assert_eq!(
        job(&history, 10),
        &expected(
            r#"{"jobID":"cmp_job010","trigger":"manual","status":"completed","created":1005,"metrics":{"excludedMessages":10,"excludedParts":1,"inputTokens":1010,"retainedTokens":100}}"#
        )
    );
    assert_eq!(
        job(&history, 103),
        &expected(
            r#"{"jobID":"cmp_job103","trigger":"manual","status":"failed","created":1051,"code":"provider_failed"}"#
        )
    );
    assert_eq!(
        job(&history, 97),
        &expected(r#"{"jobID":"cmp_job097","trigger":"manual","status":"pending","created":1048}"#)
    );
}

#[test]
fn an_empty_session_has_an_empty_history_and_a_missing_session_is_not_found() {
    let (_store, service) = seeded();
    assert_eq!(
        history(&service, "ses_empty"),
        expected(
            r#"{"data":[],"truncated":false,"completedBefore":0,"completedCount":0,"totalSavedTokens":0}"#
        )
    );
    assert!(matches!(
        service.compaction_history(&id("ses_missing")),
        Err(Error::Domain {
            kind: "not_found",
            ..
        })
    ));
}
