use ycoding_ai::llm;
use ycoding_core::session::generation_meter::{Change, Meter, Outcome};
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, model, parse_json, provider_request,
};

const SECOND: u64 = 1_000_000_000;

fn meter(attempt: u32) -> Meter {
    Meter::new(
        provider_request::Id::new("prq_meter").unwrap(),
        attempt,
        model::Ref::decode(&parse_json(r#"{"providerID":"local","id":"meter"}"#).unwrap()).unwrap(),
        0,
    )
}

fn text(value: impl Into<LosslessString>) -> llm::Event {
    llm::Event::TextDelta(llm::DeltaEvent {
        id: "text".into(),
        text: value.into(),
        provider_metadata: None,
    })
}

fn at<'a>(value: &'a JsonValue, path: &str) -> Option<&'a JsonValue> {
    path.split('.').try_fold(value, |value, key| match value {
        JsonValue::Object(fields) => fields.get(&key.into()),
        JsonValue::Array(items) => items.get(key.parse::<usize>().ok()?),
        _ => None,
    })
}

fn number(value: &JsonValue, path: &str) -> Option<f64> {
    match at(value, path) {
        Some(JsonValue::Number(value)) => Some(*value),
        _ => None,
    }
}

#[test]
fn waiting_output_intervals_and_terminal_settlement_match_the_attempt_boundary() {
    let mut current = meter(1);
    assert_eq!(
        at(&current.live(), "phase"),
        Some(&JsonValue::String("preparing".into()))
    );
    current.waiting(SECOND / 10);
    assert_eq!(
        at(&current.live(), "phase"),
        Some(&JsonValue::String("waiting".into()))
    );
    assert_eq!(
        current.observe(&text("a".repeat(4000)), 2 * SECOND),
        Some(Change::Phase)
    );
    assert_eq!(number(&current.live(), "firstOutputMs"), Some(2000.0));
    assert!(at(&current.live(), "sample").is_none());
    for second in 3..=9 {
        current.observe(&text("b".repeat(160)), second * SECOND);
    }
    assert_eq!(number(&current.live(), "sample.tokens"), Some(200.0));
    assert_eq!(
        number(&current.live(), "sample.tokensPerSecond"),
        Some(40.0)
    );
    assert!(current.settle(Outcome::Completed, 10 * SECOND));
    assert!(!current.settle(Outcome::Failed, 11 * SECOND));
    assert_eq!(
        current.observe(&text("late".repeat(1000)), 12 * SECOND),
        None
    );
    assert_eq!(current.output_tokens(), 1280);
    assert_eq!(number(&current.live(), "final.tokens"), Some(280.0));
    assert_eq!(
        number(&current.timing().unwrap(), "receivedOutput.durationNs"),
        Some(7e9)
    );
    assert!(at(&current.live(), "final.estimated").is_some());
}

#[test]
fn estimates_use_cumulative_utf16_units_independently_of_chunks() {
    let mut whole = meter(1);
    let mut split = meter(1);
    whole.observe(&text("😀😀😀😀😀😀"), 0);
    whole.observe(&text("😀😀😀😀😀😀"), 2 * SECOND);
    for time in [0, 2 * SECOND] {
        for _ in 0..6 {
            split.observe(&text("😀"), time);
        }
    }
    assert_eq!(whole.output_tokens(), 6);
    assert_eq!(split.output_tokens(), whole.output_tokens());
    assert_eq!(split.live(), whole.live());
    let mut rounding = meter(1);
    for second in 0..6 {
        rounding.observe(&text("xx"), second * SECOND);
    }
    assert_eq!(rounding.output_tokens(), 3);
}

#[test]
fn reasoning_and_tool_inputs_are_counted_once_without_pricing_estimates() {
    let mut current = meter(1);
    current.observe(
        &llm::Event::ReasoningDelta(llm::DeltaEvent {
            id: "r".into(),
            text: "r".repeat(400).into(),
            provider_metadata: None,
        }),
        SECOND,
    );
    current.observe(&text("t".repeat(400)), 3 * SECOND);
    current.observe(
        &llm::Event::ToolInputDelta {
            id: "call".into(),
            name: "write".into(),
            text: "i".repeat(400).into(),
        },
        4 * SECOND,
    );
    let call = |id: &str| {
        llm::Event::ToolCall(llm::ToolCall {
            id: id.into(),
            name: "write".into(),
            input: parse_json(r#"{"path":"abcdefghijklmnop"}"#).unwrap(),
            provider_executed: None,
            provider_metadata: None,
        })
    };
    current.observe(&call("call"), 5 * SECOND);
    assert_eq!(current.output_tokens(), 300);
    current.observe(&call("other"), 6 * SECOND);
    current.observe(&call("other"), 7 * SECOND);
    assert_eq!(current.output_tokens(), 307);
    assert_eq!(number(&current.live(), "firstOutputMs"), Some(1000.0));
    current.settle(Outcome::Cancelled, 8 * SECOND);
    let timing = current.timing().unwrap();
    assert_eq!(number(&timing, "estimatedTokens"), Some(307.0));
    assert!(at(&timing, "generatedTokens").is_none());
    assert_eq!(
        at(&current.live(), "phase"),
        Some(&JsonValue::String("cancelled".into()))
    );
}

#[test]
fn step_finish_freezes_output_and_reconciles_provider_usage_once() {
    let mut current = meter(1);
    current.observe(&text("a".repeat(400)), SECOND);
    current.observe(&text("b".repeat(400)), 3 * SECOND);
    let finish = |tokens| llm::Event::StepFinish {
        index: 0.0,
        finish: llm::Finish {
            reason: llm::FinishReason::Stop,
            usage: Some(llm::Usage {
                output_tokens: Some(tokens),
                reasoning_tokens: Some(20.0),
                ..Default::default()
            }),
            provider_metadata: None,
        },
    };
    current.observe(&finish(120.0), 4 * SECOND);
    current.observe(&finish(999.0), 5 * SECOND);
    current.observe(&text("ignored"), 6 * SECOND);
    current.settle(Outcome::Completed, 7 * SECOND);
    let timing = current.timing().unwrap();
    assert_eq!(number(&timing, "generatedTokens"), Some(120.0));
    assert_eq!(number(&timing, "observedGenerationDurationNs"), Some(3e9));
    assert_eq!(
        number(&timing, "receivedOutput.estimatedTokens"),
        Some(100.0)
    );
    assert_eq!(current.output_tokens(), 200);
    assert_eq!(meter(2).output_tokens(), 0);
}

#[test]
fn timestamps_short_windows_stalls_and_bursts_preserve_eligible_samples() {
    let mut current = meter(1);
    current.observe(&text("a".repeat(400)), 3 * SECOND);
    current.observe(&text("b".repeat(400)), 2 * SECOND);
    assert!(at(&current.live(), "sample").is_none());
    current.observe(&text("c".repeat(400)), 4 * SECOND);
    assert_eq!(
        number(&current.live(), "sample.tokensPerSecond"),
        Some(100.0)
    );
    current.observe(&text("d".repeat(400)), 10 * SECOND);
    assert_eq!(number(&current.live(), "sample.tokens"), Some(100.0));
    assert_eq!(number(&current.live(), "sample.durationNs"), Some(6e9));
    let mut short = meter(1);
    short.observe(&text("a".repeat(400)), SECOND);
    short.observe(&text("a".repeat(400)), SECOND + 999_999_999);
    short.settle(Outcome::Failed, 9 * SECOND);
    assert!(at(&short.live(), "final").is_none());
    let mut burst = meter(1);
    burst.observe(&text("a".repeat(4000)), 0);
    for index in 1..=100_000 {
        burst.observe(&text("bbbb"), index * 100_000);
    }
    assert_eq!(burst.output_tokens(), 101_000);
    assert_eq!(
        number(&burst.live(), "sample.tokensPerSecond"),
        Some(10_000.0)
    );
    assert!((5e9..=5.25e9).contains(&number(&burst.live(), "sample.durationNs").unwrap()));
    let mut silent = meter(1);
    silent.settle(Outcome::Failed, SECOND);
    assert!(silent.timing().is_none());
}
