use ycoding_core::session::cache_diagnostics;
use ycoding_schema::{DomainDecode, JsonValue, model, parse_json, provider_request};

fn model(provider: &str, id: &str) -> model::Ref {
    model::Ref::decode(
        &parse_json(&format!(r#"{{"providerID":"{provider}","id":"{id}"}}"#)).unwrap(),
    )
    .unwrap()
}

fn timing(value: &str) -> provider_request::Timing {
    provider_request::Timing::decode(&parse_json(value).unwrap()).unwrap()
}

#[test]
fn google_sdk_route_reports_gemini_prefix_caching() {
    let value = cache_diagnostics::provider_cache("ai-sdk:@ai-sdk/google", "google", None);
    let JsonValue::Object(fields) = value else {
        panic!("provider cache must be an object")
    };
    assert_eq!(
        fields.get(&"mechanism".into()),
        Some(&JsonValue::String("gemini-prefix-cache".into()))
    );
}

#[test]
fn generation_speed_adopts_measured_counts_when_every_pooled_sample_is_provider_timed() {
    let model = model("openai", "gpt-test");
    let sample = || {
        Some(timing(
            r#"{"generatedTokens":8040,"generationDurationNs":2000000000,"receivedOutput":{"estimatedTokens":2000,"durationNs":2000000000}}"#,
        ))
    };
    let records = vec![(model.clone(), sample()), (model.clone(), sample())];
    let history = cache_diagnostics::generation_speed(&records).unwrap();
    assert_eq!(history.recent.len(), 2);
    assert!(
        history
            .recent
            .iter()
            .all(|sample| sample.estimated.is_none())
    );
    let latest = history.latest.unwrap();
    assert_eq!(latest.tokens.get(), 16080);
    assert_eq!(latest.duration_ns.get(), 4_000_000_000);
    assert_eq!(latest.tokens_per_second, 4020.0);
    assert_eq!(latest.estimated, None);
}

#[test]
fn generation_speed_keeps_estimated_fallback_when_any_pooled_sample_lacks_provider_counts() {
    let model = model("openai", "gpt-test");
    let records = vec![
        (
            model.clone(),
            Some(timing(
                r#"{"generatedTokens":80,"generationDurationNs":2000000000,"receivedOutput":{"estimatedTokens":20,"durationNs":2000000000}}"#,
            )),
        ),
        (
            model.clone(),
            Some(timing(
                r#"{"receivedOutput":{"estimatedTokens":60,"durationNs":2000000000}}"#,
            )),
        ),
    ];
    let history = cache_diagnostics::generation_speed(&records).unwrap();
    let latest = history.latest.unwrap();
    assert_eq!(latest.tokens.get(), 80);
    assert_eq!(latest.duration_ns.get(), 4_000_000_000);
    assert_eq!(latest.tokens_per_second, 20.0);
    assert_eq!(latest.estimated, Some(true));
}

#[test]
fn generation_speed_excludes_historical_short_samples_and_adopts_valid_provider_timing() {
    let model = model("anthropic", "claude-test");
    let measured = (
        model.clone(),
        Some(timing(
            r#"{"generatedTokens":12,"observedGenerationDurationNs":2000000000}"#,
        )),
    );
    let burst = (
        model.clone(),
        Some(timing(
            r#"{"generatedTokens":2355,"observedGenerationDurationNs":71223792}"#,
        )),
    );
    let history = cache_diagnostics::generation_speed(&[measured.clone(), burst]).unwrap();
    assert_eq!(history.recent.len(), 1);
    let latest = history.latest.clone().unwrap();
    assert_eq!(
        (latest.tokens.get(), latest.duration_ns.get()),
        (12, 2_000_000_000)
    );
    assert_eq!(latest.tokens_per_second, 6.0);
    assert_eq!(latest.estimated, None);
    let reported = (
        model,
        Some(timing(
            r#"{"generatedTokens":12,"generationDurationNs":71223792}"#,
        )),
    );
    let history = cache_diagnostics::generation_speed(&[measured, reported]).unwrap();
    let latest = history.latest.unwrap();
    assert_eq!(
        (latest.tokens.get(), latest.duration_ns.get()),
        (12, 2_000_000_000)
    );
}

#[test]
fn generation_speed_estimated_samples_require_one_second_and_ignore_subsecond_provider_timing() {
    let model = model("openai", "gpt-test");
    let short = vec![(
        model.clone(),
        Some(timing(
            r#"{"receivedOutput":{"estimatedTokens":80,"durationNs":999999999}}"#,
        )),
    )];
    let history = cache_diagnostics::generation_speed(&short).unwrap();
    assert!(history.recent.is_empty());
    assert!(history.latest.is_none());
    let records = vec![(
        model,
        Some(timing(
            r#"{"generatedTokens":10,"generationDurationNs":1,"receivedOutput":{"estimatedTokens":80,"durationNs":2000000000}}"#,
        )),
    )];
    let history = cache_diagnostics::generation_speed(&records).unwrap();
    let latest = history.latest.unwrap();
    assert_eq!(
        (latest.tokens.get(), latest.duration_ns.get()),
        (80, 2_000_000_000)
    );
    assert_eq!(latest.tokens_per_second, 40.0);
    assert_eq!(latest.estimated, Some(true));
}
