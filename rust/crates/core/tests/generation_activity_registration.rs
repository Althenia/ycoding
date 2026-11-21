use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use ycoding_ai::llm;
use ycoding_core::{
    generation_activity::Service,
    session::generation_meter::{Meter, Outcome},
};
use ycoding_schema::{DomainDecode, JsonValue, model, parse_json, provider_request, session};

const SECOND: u64 = 1_000_000_000;

#[allow(dead_code)]
#[path = "session_support/mod.rs"]
mod diagnostics_support;

fn field<'a>(value: &'a JsonValue, path: &str) -> Option<&'a JsonValue> {
    path.split('.').try_fold(value, |value, key| match value {
        JsonValue::Object(fields) => fields.get(&key.into()),
        JsonValue::Array(values) => values.get(key.parse::<usize>().ok()?),
        _ => None,
    })
}

fn number(value: &JsonValue, path: &str) -> Option<f64> {
    match field(value, path) {
        Some(JsonValue::Number(value)) => Some(*value),
        _ => None,
    }
}

fn phase(value: &JsonValue) -> Option<&str> {
    match field(value, "phase") {
        Some(JsonValue::String(value)) => value.as_str(),
        _ => None,
    }
}

fn text(length: usize) -> llm::Event {
    llm::Event::TextDelta(llm::DeltaEvent {
        id: "text".into(),
        text: "t".repeat(length).into(),
        provider_metadata: None,
    })
}

fn start(
    activity: &Service,
    clock: &Arc<AtomicU64>,
    session: &str,
    request: &str,
    attempt: u32,
    model: &str,
) -> Meter {
    let clock = clock.clone();
    activity.start(
        session::Id::new(session).unwrap(),
        provider_request::Id::new(request).unwrap(),
        attempt,
        model::Ref::decode(
            &parse_json(&format!(
                r#"{{"providerID":"local","id":"{model}","profile":"work"}}"#
            ))
            .unwrap(),
        )
        .unwrap(),
        Arc::new(move || clock.load(Ordering::SeqCst)),
    )
}

#[test]
fn preparing_and_waiting_register_before_output_and_drop_clears_the_shared_service() {
    let clock = Arc::new(AtomicU64::new(0));
    let activity = Service::new(1_700_000_000_000, 0);
    let dashboard = activity.clone();
    let session = session::Id::new("ses_one").unwrap();
    assert_eq!(activity.active(), 0);
    {
        let mut meter = start(&activity, &clock, "ses_one", "prq_one", 1, "test");
        assert_eq!(activity.active(), 1);
        assert_eq!(number(&dashboard.snapshot(0), "active"), Some(1.0));
        assert_eq!(phase(&activity.live(&session).unwrap()), Some("preparing"));
        meter.waiting(SECOND);
        assert_eq!(activity.active(), 1);
        assert_eq!(phase(&activity.live(&session).unwrap()), Some("waiting"));
        clock.store(2 * SECOND, Ordering::SeqCst);
    }
    assert_eq!(activity.active(), 0);
    assert_eq!(number(&dashboard.snapshot(2 * SECOND), "active"), Some(0.0));
    assert!(activity.live(&session).is_none());
}

#[test]
fn active_counts_waiting_attempts_and_releases_each_terminal_outcome_without_a_dashboard_read() {
    let clock = Arc::new(AtomicU64::new(0));
    let activity = Service::new(0, 0);
    let mut first = start(&activity, &clock, "ses_one", "prq_first", 1, "first");
    let mut second = start(&activity, &clock, "ses_two", "prq_second", 1, "second");
    second.waiting(SECOND);
    assert_eq!(activity.active(), 2);
    assert!(first.settle(Outcome::Failed, 2 * SECOND));
    assert_eq!(activity.active(), 1);
    assert!(second.settle(Outcome::Completed, 3 * SECOND));
    assert_eq!(activity.active(), 0);
    drop(first);
    drop(second);
    assert_eq!(activity.active(), 0);
    clock.store(3 * SECOND, Ordering::SeqCst);
    let mut cancelled = start(
        &activity,
        &clock,
        "ses_one",
        "prq_cancelled",
        1,
        "cancelled",
    );
    assert_eq!(activity.active(), 1);
    assert!(cancelled.settle(Outcome::Cancelled, 4 * SECOND));
    assert_eq!(activity.active(), 0);
    clock.store(4 * SECOND, Ordering::SeqCst);
    let dropped = start(&activity, &clock, "ses_two", "prq_dropped", 1, "dropped");
    assert_eq!(activity.active(), 1);
    drop(dropped);
    assert_eq!(activity.active(), 0);
}

#[test]
fn session_snapshots_use_the_shared_activity_before_any_measured_assistant_and_keep_scopes_separate()
 {
    let store = diagnostics_support::store();
    let sessions = ycoding_core::session::store::Service::new(store.client());
    let clock = Arc::new(AtomicU64::new(0));
    let activity = Service::new(0, 0);
    let session = session::Id::new("ses_one").unwrap();
    let meter = start(&activity, &clock, "ses_one", "prq_live", 1, "resolved");
    let history = sessions
        .snapshot(&session, 10, None, &activity)
        .unwrap()
        .generation_speed
        .unwrap();
    assert_eq!(history.model.unwrap().id.as_str(), Some("resolved"));
    assert!(history.latest.is_none());
    assert!(history.recent.is_empty());
    assert_eq!(
        history.live.unwrap().phase,
        ycoding_schema::session_cache_diagnostics::GenerationPhase::Preparing
    );
    assert!(
        sessions
            .diagnostics(&session, None, &activity)
            .unwrap()
            .is_none()
    );
    assert!(
        sessions
            .snapshot(&session::Id::new("ses_two").unwrap(), 10, None, &activity)
            .unwrap()
            .generation_speed
            .is_none()
    );
    assert!(
        sessions
            .snapshot(
                &session::Id::new("ses_missing").unwrap(),
                10,
                None,
                &activity
            )
            .is_err()
    );
    drop(meter);
    assert!(
        sessions
            .snapshot(&session, 10, None, &activity)
            .unwrap()
            .generation_speed
            .is_none()
    );
}

#[test]
fn reverted_session_snapshots_never_overlay_the_current_live_attempt() {
    let store = diagnostics_support::store();
    let sessions = ycoding_core::session::store::Service::new(store.client());
    let clock = Arc::new(AtomicU64::new(0));
    let activity = Service::new(0, 0);
    let session = session::Id::new("ses_one").unwrap();
    let _meter = start(&activity, &clock, "ses_one", "prq_live", 1, "resolved");
    store
        .submit(|tx| {
            use ycoding_store::session::{Document, SessionTable};
            let key =
                ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&"ses_one".into())]);
            let mut row = tx.get::<SessionTable>(&key)?.unwrap();
            row.revert = Some(Document::new(
                parse_json(r#"{"messageID":"msg_reverted"}"#).unwrap(),
            )?);
            SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(activity.live(&session).is_some());
    assert!(
        sessions
            .snapshot(&session, 10, None, &activity)
            .unwrap()
            .generation_speed
            .is_none()
    );
}

#[test]
fn every_output_kind_auto_publishes_without_double_counting_tool_completion() {
    let clock = Arc::new(AtomicU64::new(0));
    let activity = Service::new(0, 0);
    let session = session::Id::new("ses_one").unwrap();
    let mut meter = start(&activity, &clock, "ses_one", "prq_one", 1, "test");
    meter.observe(&text(400), SECOND);
    meter.observe(
        &llm::Event::ReasoningDelta(llm::DeltaEvent {
            id: "reasoning".into(),
            text: "r".repeat(400).into(),
            provider_metadata: None,
        }),
        2 * SECOND,
    );
    meter.observe(
        &llm::Event::ToolInputDelta {
            id: "streamed".into(),
            name: "write".into(),
            text: "i".repeat(400).into(),
        },
        3 * SECOND,
    );
    let call = |id: &str| {
        llm::Event::ToolCall(llm::ToolCall {
            id: id.into(),
            name: "write".into(),
            input: parse_json(r#"{"x":"abcdefgh"}"#).unwrap(),
            provider_executed: None,
            provider_metadata: None,
        })
    };
    meter.observe(&call("streamed"), 4 * SECOND);
    assert_eq!(meter.output_tokens(), 300);
    meter.observe(&call("plain"), 4 * SECOND);
    meter.observe(&call("plain"), 4 * SECOND);
    assert_eq!(meter.output_tokens(), 304);
    let snapshot = activity.snapshot(4 * SECOND);
    assert_eq!(number(&snapshot, "active"), Some(1.0));
    assert_eq!(
        number(&snapshot, "outputTokensPerSecond"),
        Some(304.0 / 5.0)
    );
    assert_eq!(phase(&activity.live(&session).unwrap()), Some("tool"));
    assert!(meter.settle(Outcome::Completed, 5 * SECOND));
    assert_eq!(number(&activity.snapshot(5 * SECOND), "active"), Some(0.0));
    assert!(activity.live(&session).is_none());
    assert_eq!(phase(&meter.live()), Some("completed"));
    assert_eq!(
        number(&meter.timing().unwrap(), "receivedOutput.estimatedTokens"),
        Some(204.0)
    );
}

#[test]
fn retry_attempts_reset_counts_and_settle_drop_and_late_events_are_idempotent() {
    let clock = Arc::new(AtomicU64::new(0));
    let activity = Service::new(0, 0);
    let session = session::Id::new("ses_one").unwrap();
    let mut first = start(&activity, &clock, "ses_one", "prq_retry", 1, "first");
    first.observe(&text(400), SECOND);
    assert!(first.settle(Outcome::Failed, 2 * SECOND));
    assert!(!first.settle(Outcome::Cancelled, 3 * SECOND));
    assert!(first.observe(&text(400), 3 * SECOND).is_none());
    clock.store(3 * SECOND, Ordering::SeqCst);
    let mut second = start(&activity, &clock, "ses_one", "prq_retry", 2, "second");
    drop(first);
    assert_eq!(second.output_tokens(), 0);
    assert_eq!(number(&activity.snapshot(3 * SECOND), "active"), Some(1.0));
    assert_eq!(
        number(&activity.live(&session).unwrap(), "attempt"),
        Some(2.0)
    );
    assert!(second.settle(Outcome::Cancelled, 4 * SECOND));
    drop(second);
    assert_eq!(number(&activity.snapshot(5 * SECOND), "active"), Some(0.0));
    assert!(activity.live(&session).is_none());
}

#[test]
fn stale_updates_and_drop_cannot_remove_a_replacement_with_the_same_identity() {
    let clock = Arc::new(AtomicU64::new(0));
    let activity = Service::new(0, 0);
    let session = session::Id::new("ses_one").unwrap();
    let mut old = start(&activity, &clock, "ses_one", "prq_same", 1, "old");
    clock.store(SECOND, Ordering::SeqCst);
    let current = start(&activity, &clock, "ses_one", "prq_same", 1, "current");
    old.observe(&text(400), 2 * SECOND);
    old.settle(Outcome::Failed, 3 * SECOND);
    drop(old);
    assert_eq!(number(&activity.snapshot(3 * SECOND), "active"), Some(1.0));
    assert_eq!(
        number(&activity.snapshot(3 * SECOND), "outputTokensPerSecond"),
        Some(0.0)
    );
    assert_eq!(phase(&activity.live(&session).unwrap()), Some("preparing"));
    drop(current);
    assert_eq!(number(&activity.snapshot(4 * SECOND), "active"), Some(0.0));
}

#[test]
fn scoped_live_chooses_the_latest_started_active_attempt_not_the_last_mutation() {
    let clock = Arc::new(AtomicU64::new(0));
    let activity = Service::new(0, 0);
    let session = session::Id::new("ses_one").unwrap();
    let mut first = start(&activity, &clock, "ses_one", "prq_first", 1, "first");
    clock.store(SECOND, Ordering::SeqCst);
    let mut second = start(&activity, &clock, "ses_one", "prq_second", 1, "second");
    first.waiting(2 * SECOND);
    assert_eq!(
        field(&activity.live(&session).unwrap(), "requestID"),
        Some(&JsonValue::String("prq_second".into()))
    );
    second.settle(Outcome::Failed, 3 * SECOND);
    assert_eq!(phase(&activity.live(&session).unwrap()), Some("waiting"));
    first.settle(Outcome::Completed, 4 * SECOND);
    assert!(activity.live(&session).is_none());
}

#[test]
fn concurrent_sessions_share_wall_clock_throughput_and_expire_received_output() {
    let clock = Arc::new(AtomicU64::new(0));
    let activity = Service::new(0, 0);
    let mut first = start(&activity, &clock, "ses_one", "prq_first", 1, "first");
    let mut second = start(&activity, &clock, "ses_two", "prq_second", 1, "second");
    first.observe(&text(4), SECOND);
    second.observe(&text(8), SECOND);
    let combined = activity.snapshot(SECOND);
    assert_eq!(number(&combined, "active"), Some(2.0));
    assert_eq!(number(&combined, "streaming"), Some(2.0));
    assert_eq!(number(&combined, "outputTokensPerSecond"), Some(3.0 / 5.0));
    let stalled = activity.snapshot(6 * SECOND);
    assert_eq!(number(&stalled, "active"), Some(2.0));
    assert_eq!(number(&stalled, "streaming"), Some(0.0));
    assert_eq!(number(&stalled, "outputTokensPerSecond"), Some(0.0));
    clock.store(6 * SECOND, Ordering::SeqCst);
    drop((first, second));
    let empty = activity.snapshot(7 * SECOND);
    assert_eq!(number(&empty, "active"), Some(0.0));
    assert!(field(&empty, "outputTokensPerSecond").is_none());
}
