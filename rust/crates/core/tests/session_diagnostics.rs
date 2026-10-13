use ycoding_core::session::store::Service;
use ycoding_schema::{parse_json, session, session_message};
use ycoding_store::{
    Store,
    session::{Message, MessageTable},
};

#[path = "session_support/mod.rs"]
mod support;

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn message_id(value: &str) -> session_message::Id {
    session_message::Id::new(value).unwrap()
}

fn put(store: &Store, message: &str, type_: &str, seq: i64, data: &str) {
    store
        .submit({
            let (message, type_, data) = (message.to_string(), type_.to_string(), data.to_string());
            move |tx| {
                MessageTable::insert(
                    tx,
                    &Message {
                        id: message.into(),
                        session_id: "ses_one".into(),
                        type_: type_.into(),
                        seq,
                        time_created: 1,
                        time_updated: 1,
                        data: parse_json(&data).unwrap(),
                    },
                )
            }
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn assistant(measured: &str, provider: &str, model: &str) -> String {
    format!(
        r#"{{"time":{{"created":1}},"agent":"build","model":{{"providerID":"{provider}","id":"{model}"}},"content":[{{"type":"text","text":"{}"}}]{measured}}}"#,
        "x".repeat(2_000)
    )
}

fn measured(input: u32, cost: Option<&str>, diagnostics: Option<&str>) -> String {
    format!(
        r#","tokens":{{"input":{input},"output":2,"reasoning":1,"cache":{{"read":3,"write":4}}}}{}{}"#,
        cost.map_or(String::new(), |cost| format!(r#","cost":{cost}"#)),
        diagnostics.map_or(String::new(), |value| format!(r#","diagnostics":{value}"#)),
    )
}

fn compaction(seq: i64, store: &Store) {
    put(
        store,
        &format!("msg_compaction_{seq}"),
        "compaction",
        seq,
        r#"{"status":"completed","reason":"manual","summary":"summary","recent":"recent","time":{"created":1}}"#,
    );
}

fn setup() -> (Store, Service) {
    let store = support::store();
    let service = Service::new(store.client());
    (store, service)
}

fn total(service: &Service, boundary: Option<&str>) -> Option<(i64, f64)> {
    service
        .diagnostics(&id("ses_one"), boundary.map(message_id).as_ref())
        .unwrap()
        .map(|info| (info.context.total.get(), info.estimated_cost.unwrap().get()))
}

#[test]
fn selects_the_latest_measured_assistant_before_the_boundary() {
    let (store, service) = setup();
    put(
        &store,
        "msg_diagnostic",
        "assistant",
        0,
        &assistant(
            &measured(10, Some("0.25"), Some(r#"{"contextLimit":100}"#)),
            "local",
            "test",
        ),
    );
    put(
        &store,
        "msg_boundary",
        "user",
        1,
        r#"{"text":"boundary","time":{"created":1}}"#,
    );
    put(
        &store,
        "msg_newer",
        "assistant",
        2,
        &assistant(&measured(99, None, None), "local", "test"),
    );

    let info = service
        .diagnostics(&id("ses_one"), Some(&message_id("msg_boundary")))
        .unwrap()
        .unwrap();

    assert_eq!(info.context.total.get(), 20);
    assert_eq!(info.context.limit.unwrap().get(), 100);
    assert_eq!(info.context.remaining.unwrap().get(), 80);
    assert_eq!(info.context.percent, Some(20.0));
    assert_eq!(info.estimated_cost.unwrap().get(), 0.25);
    assert_eq!(info.tokens.uncached_input.get(), 10);
    assert_eq!(total(&service, None), Some((109, 0.0)));
    assert!(
        service
            .diagnostics(&id("ses_one"), Some(&message_id("msg_missing")))
            .unwrap()
            .is_none()
    );
}

#[test]
fn bounds_compaction_and_missing_measurements() {
    let (store, service) = setup();
    let plain = |tokens: bool| {
        assistant(
            &if tokens {
                measured(7, None, None)
            } else {
                String::new()
            },
            "local",
            "test",
        )
    };
    put(&store, "msg_before", "assistant", 0, &plain(true));
    assert_eq!(total(&service, None), Some((17, 0.0)));

    compaction(1, &store);
    assert_eq!(total(&service, None), None);
    assert_eq!(total(&service, Some("msg_before")), None);

    put(&store, "msg_after", "assistant", 2, &plain(true));
    for seq in 3..30 {
        put(
            &store,
            &format!("msg_unmeasured_{seq}"),
            "assistant",
            seq,
            &plain(false),
        );
    }
    assert_eq!(total(&service, None), Some((17, 0.0)));
    assert_eq!(total(&service, Some("msg_after")), None);
    assert_eq!(total(&service, Some("msg_unmeasured_29")), Some((17, 0.0)));
}

#[test]
fn reports_provider_cache_mechanism_hit_ratio_and_minimum() {
    let (store, service) = setup();
    put(
        &store,
        "msg_anthropic",
        "assistant",
        0,
        &assistant(
            r#","tokens":{"input":100,"output":10,"reasoning":0,"cache":{"read":300,"write":100}}"#,
            "anthropic",
            "claude-opus-5",
        ),
    );
    let info = service.diagnostics(&id("ses_one"), None).unwrap().unwrap();
    assert_eq!(info.cache.eligible.get(), 500);
    assert_eq!(info.cache.hit_ratio, Some(0.6));
    assert_eq!(
        info.cache.mechanism.0.to_utf8().unwrap(),
        "anthropic-cache-control"
    );
    assert_eq!(info.cache.minimum_tokens.unwrap().get(), 512);
    assert_eq!(info.cache.below_minimum, Some(true));
    assert!(info.context.limit.is_none());

    put(
        &store,
        "msg_reported",
        "assistant",
        1,
        &assistant(
            &measured(
                10,
                None,
                Some(
                    r#"{"providerCache":{"mechanism":"provider-reported","readReported":false,"writeReported":true}}"#,
                ),
            ),
            "anthropic",
            "unlisted",
        ),
    );
    let info = service.diagnostics(&id("ses_one"), None).unwrap().unwrap();
    assert_eq!(
        info.cache.mechanism.0.to_utf8().unwrap(),
        "provider-reported"
    );
    assert!(info.cache.hit_ratio.is_none());
    assert!(info.cache.write_reported);
    assert!(info.cache.minimum_tokens.is_none());
}

#[test]
fn claude_55_cache_minimum_distinguishes_511_from_512_tokens() {
    for model in ["claude-sonnet-5-5", "claude-haiku-5-5"] {
        for (input, below) in [(511, true), (512, false)] {
            let (store, service) = setup();
            put(
                &store,
                "msg_claude_55",
                "assistant",
                0,
                &assistant(
                    &format!(
                        r#","tokens":{{"input":{input},"output":20,"reasoning":0,"cache":{{"read":0,"write":0}}}}"#
                    ),
                    "anthropic",
                    model,
                ),
            );
            let info = service.diagnostics(&id("ses_one"), None).unwrap().unwrap();
            assert_eq!(
                info.cache.minimum_tokens.unwrap().get(),
                512,
                "{model}/{input}"
            );
            assert_eq!(info.cache.below_minimum, Some(below), "{model}/{input}");
        }
    }
}
