use ycoding_core::session::{
    continuation, diagnostics, provider_request, provider_request::Begin, provider_state,
    store::Service, usage,
};
use ycoding_schema::{
    DomainDecode, JsonValue, ObjectEncoder, parse_json, session, session_message,
};
use ycoding_store::{
    KeyPart,
    resources::{ContinuationTable, StateBlobTable, StateLinkTable},
    session::{NewEvent, Revision, RevisionTable},
    tuple_key,
};

#[path = "session_support/mod.rs"]
mod support;

fn begin() -> Begin {
    Begin {
        session: session::Id::new("ses_one").unwrap(),
        model: ycoding_schema::model::Ref::decode(
            &parse_json(r#"{"providerID":"openai","id":"gpt-5.6"}"#).unwrap(),
        )
        .unwrap(),
        route_id: "openai-responses".into(),
        connection_identity_digest: None,
        prompt_cache_key: "a".repeat(64),
        system_digest: "b".repeat(64),
        tool_digest: "c".repeat(64),
    }
}

fn event(id: &str, kind: &str, data: &str) -> NewEvent {
    NewEvent {
        id: id.into(),
        aggregate_id: "ses_one".into(),
        type_: kind.into(),
        created: 2,
        data: parse_json(data).unwrap(),
    }
}

fn state() -> continuation::State {
    continuation::State {
        response_id: "resp_test".into(),
        fingerprint: continuation::Fingerprint {
            session: "ses_one".into(),
            context_revision: 0,
            continuation_generation: 0,
            provider: "openai".into(),
            route_id: "openai-responses".into(),
            model_id: "gpt-5.6".into(),
            variant: None,
            connection_identity_digest: "d".repeat(64),
            represented_through_message_id: None,
            represented_message_count: 0,
            prompt_cache_key: "a".repeat(64),
            instructions_digest: "b".repeat(64),
            tools_digest: "c".repeat(64),
            options_digest: "d".repeat(64),
            volatile_context_digest: "e".repeat(64),
        },
    }
}

async fn started(store: &ycoding_store::Store, service: &Service) {
    store
        .submit(|tx| {
            RevisionTable::insert(
                tx,
                &Revision {
                    session_id: "ses_one".into(),
                    revision: 0,
                    parent_revision: None,
                    manifest_digest: None,
                    covered_through_message_id: None,
                    covered_through_seq: None,
                    activation_event_id: None,
                    activation_sequence: None,
                    time_created: 0,
                },
            )
        })
        .unwrap()
        .await
        .unwrap();
    service.publish(event("evt_started", "session.step.started.1", r#"{"sessionID":"ses_one","assistantMessageID":"msg_step","agent":"build","model":{"providerID":"openai","id":"gpt-5.6"}}"#)).await.unwrap();
}

fn ended() -> NewEvent {
    event(
        "evt_ended",
        "session.step.ended.1",
        r#"{"sessionID":"ses_one","assistantMessageID":"msg_step","finish":"stop","cost":0.25,"tokens":{"input":1,"output":12,"reasoning":0,"cache":{"read":0,"write":0}}}"#,
    )
}

fn capture(ordinal: usize) -> provider_state::Capture {
    provider_state::Capture {
        message: session_message::Id::new("msg_step").unwrap(),
        ordinal,
        kind: "reasoning",
        item: parse_json(r#"{"type":"reasoning","id":"item","encrypted_content":"synthetic"}"#)
            .unwrap(),
    }
}

#[tokio::test]
async fn terminal_projection_state_and_continuation_commit_together_or_roll_back() {
    for failure in [None, Some("capture"), Some("continuation")] {
        let store = support::store();
        let service = Service::new(store.client());
        started(&store, &service).await;
        let mut remembered = state();
        if failure == Some("continuation") {
            remembered.response_id = "".into();
        }
        let captures = if failure == Some("capture") {
            vec![capture(0), capture(usize::MAX)]
        } else {
            vec![capture(0)]
        };
        let result = service
            .publish_step_end(
                ended(),
                "openai".into(),
                "gpt-5.6".into(),
                captures,
                Some(remembered),
            )
            .await;
        let snapshot = store.snapshot().unwrap();
        let blobs = snapshot
            .scan::<StateBlobTable>(std::ops::Bound::Unbounded, std::ops::Bound::Unbounded, 10)
            .unwrap();
        let links = snapshot
            .scan::<StateLinkTable>(std::ops::Bound::Unbounded, std::ops::Bound::Unbounded, 10)
            .unwrap();
        let remembered = snapshot
            .get::<ContinuationTable>(&tuple_key(&[KeyPart::String(&"ses_one".into())]))
            .unwrap();
        let (_, session_message::Info::Assistant(assistant)) = service
            .message(&session_message::Id::new("msg_step").unwrap())
            .unwrap()
            .unwrap()
        else {
            panic!()
        };
        let events = snapshot
            .scan::<ycoding_store::session::EventTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                10,
            )
            .unwrap();
        if failure.is_some() {
            assert!(result.is_err(), "{failure:?}");
            assert!(assistant.time.completed.is_none());
            assert!(assistant.tokens.is_none());
            assert!(blobs.is_empty());
            assert!(links.is_empty());
            assert!(remembered.is_none());
            assert_eq!(events.len(), 1);
        } else {
            result.unwrap();
            assert_eq!(assistant.tokens.unwrap().output.get(), 12.0);
            assert!(assistant.time.completed.is_some());
            assert_eq!(blobs.len(), 1);
            assert_eq!(links.len(), 1);
            assert_eq!(remembered.unwrap().response_id.as_str(), Some("resp_test"));
            assert_eq!(events.len(), 2);
        }
    }
}

#[tokio::test]
async fn stale_continuation_authority_does_not_revoke_an_otherwise_valid_terminal_step() {
    let store = support::store();
    let service = Service::new(store.client());
    started(&store, &service).await;
    service
        .continuation_authority(&begin().session)
        .await
        .unwrap();
    service
        .clear_continuation(&begin().session, 2)
        .await
        .unwrap();
    service
        .publish_step_end(
            ended(),
            "openai".into(),
            "gpt-5.6".into(),
            vec![capture(0)],
            Some(state()),
        )
        .await
        .unwrap();
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<ContinuationTable>(&tuple_key(&[KeyPart::String(&"ses_one".into())]))
            .unwrap()
            .is_none()
    );
    let (_, session_message::Info::Assistant(assistant)) = service
        .message(&session_message::Id::new("msg_step").unwrap())
        .unwrap()
        .unwrap()
    else {
        panic!()
    };
    assert!(assistant.time.completed.is_some());
}

const SECOND: u64 = 1_000_000_000;
const SAFE: u64 = 9_007_199_254_740_991;

fn reported(output: f64, reasoning: Option<f64>) -> ycoding_core::ycoding_ai::llm::Usage {
    ycoding_core::ycoding_ai::llm::Usage {
        output_tokens: Some(output),
        reasoning_tokens: reasoning,
        ..Default::default()
    }
}

fn measured(tokens: u64, observed: Option<u64>) -> Option<ycoding_schema::JsonValue> {
    Some(
        parse_json(&match observed {
            Some(duration) => format!(
                r#"{{"generatedTokens":{tokens},"observedGenerationDurationNs":{duration}}}"#
            ),
            None => format!(r#"{{"generatedTokens":{tokens}}}"#),
        })
        .unwrap(),
    )
}

fn estimated(tokens: u64, duration: u64) -> Option<ycoding_schema::JsonValue> {
    Some(
        parse_json(&format!(
            r#"{{"estimatedTokens":{tokens},"estimatedGenerationDurationNs":{duration}}}"#
        ))
        .unwrap(),
    )
}

fn timed(
    usage: Option<&ycoding_core::ycoding_ai::llm::Usage>,
    times: usage::GenerationTimes,
) -> Option<ycoding_schema::JsonValue> {
    usage::generation_timing(usage, &times)
}

#[test]
fn generation_timing_keeps_short_windows_and_counts_reasoning_with_provider_output() {
    let times = usage::GenerationTimes {
        reasoning: Some(SECOND),
        text: Some(1_050_000_000),
        ended: Some(1_100_000_000),
        ..Default::default()
    };
    assert_eq!(
        timed(Some(&reported(12.0, Some(4.0))), times),
        measured(12, Some(100_000_000))
    );
}

#[test]
fn generation_timing_starts_at_the_earliest_output_so_folded_reasoning_is_never_hidden_or_dropped()
{
    let both = || usage::GenerationTimes {
        text: Some(2 * SECOND),
        reasoning: Some(SECOND),
        ended: Some(3 * SECOND),
        ..Default::default()
    };
    let text_only = || usage::GenerationTimes {
        reasoning: None,
        ..both()
    };
    let unreported = ycoding_core::ycoding_ai::llm::Usage {
        output_may_include_unreported_reasoning: Some(true),
        ..reported(12.0, None)
    };
    assert_eq!(
        timed(Some(&unreported), text_only()),
        measured(12, Some(SECOND))
    );
    assert_eq!(
        timed(Some(&unreported), both()),
        measured(12, Some(2 * SECOND))
    );
    assert_eq!(
        timed(Some(&reported(12.0, Some(4.0))), text_only()),
        measured(12, Some(SECOND))
    );
    assert_eq!(
        timed(Some(&reported(12.0, Some(4.0))), both()),
        measured(12, Some(2 * SECOND))
    );
    assert_eq!(
        timed(
            Some(&reported(2_355.0, None)),
            usage::GenerationTimes {
                text: Some(30 * SECOND),
                ended: Some(30_071_223_792),
                ..Default::default()
            }
        ),
        measured(2_355, Some(71_223_792))
    );
    let folded = || usage::GenerationTimes {
        reasoning: Some(10 * SECOND),
        text: Some(29 * SECOND),
        ended: Some(30 * SECOND),
        ..Default::default()
    };
    for reasoning in [None, Some(0.0)] {
        assert_eq!(
            timed(Some(&reported(1_123.0, reasoning)), folded()),
            measured(1_123, Some(20 * SECOND))
        );
    }
}

#[test]
fn generation_timing_counts_all_reported_output_even_when_it_exceeds_the_visible_span() {
    let times = usage::GenerationTimes {
        text: Some(40 * SECOND),
        reasoning: Some(0),
        tool_input: Some(39 * SECOND),
        ended: Some(43 * SECOND),
        ..Default::default()
    };
    assert_eq!(
        timed(Some(&reported(4_200.0, Some(4_000.0))), times),
        measured(4_200, Some(43 * SECOND))
    );
}

#[test]
fn generation_timing_uses_the_request_window_without_first_output_and_ignores_provider_duration() {
    let window = || usage::GenerationTimes {
        started: Some(SECOND),
        ended: Some(1_500_000_000),
        ..Default::default()
    };
    let provider_timed = ycoding_core::ycoding_ai::llm::Usage {
        generation_duration_ns: Some(9_000_000_000.0),
        ..reported(12.0, None)
    };
    assert_eq!(
        timed(Some(&provider_timed), window()),
        measured(12, Some(500_000_000))
    );
    assert_eq!(
        timed(
            None,
            usage::GenerationTimes {
                streamed_output_units: 11,
                ..window()
            }
        ),
        estimated(3, 500_000_000)
    );
    let first_output = usage::GenerationTimes {
        text: Some(1_200_000_000),
        ..window()
    };
    assert_eq!(
        timed(Some(&reported(12.0, None)), first_output),
        measured(12, Some(300_000_000))
    );
}

#[test]
fn generation_timing_without_any_start_keeps_only_the_measured_tokens() {
    let ended = usage::GenerationTimes {
        ended: Some(3 * SECOND),
        streamed_output_units: 40,
        ..Default::default()
    };
    assert_eq!(
        timed(Some(&reported(12.0, None)), ended),
        measured(12, None)
    );
    let ended = usage::GenerationTimes {
        ended: Some(3 * SECOND),
        streamed_output_units: 40,
        ..Default::default()
    };
    assert_eq!(timed(None, ended), None);
    let provider_timed = ycoding_core::ycoding_ai::llm::Usage {
        generation_duration_ns: Some(2_000_000.0),
        output_may_include_unreported_reasoning: Some(true),
        ..reported(12.0, None)
    };
    assert_eq!(
        timed(Some(&provider_timed), usage::GenerationTimes::default()),
        measured(12, None)
    );
}

#[test]
fn generation_timing_without_an_end_keeps_only_the_measured_tokens() {
    let open = || usage::GenerationTimes {
        text: Some(SECOND),
        streamed_output_units: 40,
        ..Default::default()
    };
    assert_eq!(
        timed(Some(&reported(12.0, None)), open()),
        measured(12, None)
    );
    assert_eq!(timed(None, open()), None);
}

#[test]
fn generation_timing_estimates_every_nonempty_tool_only_stream() {
    for (units, tokens) in [(1, 1), (16, 4)] {
        let times = usage::GenerationTimes {
            tool_input: Some(SECOND),
            ended: Some(1_010_000_000),
            streamed_output_units: units,
            ..Default::default()
        };
        assert_eq!(timed(None, times), estimated(tokens, 10_000_000), "{units}");
    }
}

#[test]
fn generation_timing_estimates_round_half_up_and_never_fall_below_one() {
    for (units, tokens) in [
        (1, 1),
        (2, 1),
        (3, 1),
        (6, 2),
        (9, 2),
        (10, 3),
        (11, 3),
        (14, 4),
    ] {
        let times = usage::GenerationTimes {
            text: Some(0),
            ended: Some(SECOND),
            streamed_output_units: units,
            ..Default::default()
        };
        assert_eq!(timed(None, times), estimated(tokens, SECOND), "{units}");
    }
}

#[test]
fn generation_timing_is_absent_without_reported_tokens_or_streamed_output() {
    let window = || usage::GenerationTimes {
        started: Some(0),
        ended: Some(1_000_000),
        ..Default::default()
    };
    assert_eq!(timed(None, window()), None);
    assert_eq!(timed(Some(&reported(0.0, None)), window()), None);
    assert_eq!(
        timed(
            Some(&ycoding_core::ycoding_ai::llm::Usage::default()),
            window()
        ),
        None
    );
}

#[test]
fn generation_timing_turns_a_zero_window_into_one_nanosecond() {
    let zero = |units| usage::GenerationTimes {
        started: Some(5 * SECOND),
        ended: Some(5 * SECOND),
        streamed_output_units: units,
        ..Default::default()
    };
    assert_eq!(
        timed(Some(&reported(12.0, None)), zero(0)),
        measured(12, Some(1))
    );
    assert_eq!(timed(None, zero(8)), estimated(2, 1));
}

#[test]
fn generation_timing_drops_regressive_and_overflowing_windows_but_keeps_measured_tokens() {
    let regressive = || usage::GenerationTimes {
        text: Some(2 * SECOND),
        reasoning: Some(SECOND),
        ended: Some(2_000_000),
        streamed_output_units: 40,
        ..Default::default()
    };
    assert_eq!(
        timed(Some(&reported(12.0, None)), regressive()),
        measured(12, None)
    );
    assert_eq!(timed(None, regressive()), None);
    let overflow = |ended| usage::GenerationTimes {
        started: Some(0),
        ended: Some(ended),
        streamed_output_units: 40,
        ..Default::default()
    };
    assert_eq!(
        timed(Some(&reported(12.0, None)), overflow(SAFE + 1)),
        measured(12, None)
    );
    assert_eq!(timed(None, overflow(SAFE + 1)), None);
    assert_eq!(
        timed(Some(&reported(12.0, None)), overflow(SAFE)),
        measured(12, Some(SAFE))
    );
    assert_eq!(timed(None, overflow(SAFE)), estimated(10, SAFE));
}

#[test]
fn generation_timing_falls_back_to_the_estimate_for_unusable_provider_token_counts() {
    let window = || usage::GenerationTimes {
        text: Some(SECOND),
        ended: Some(2 * SECOND),
        streamed_output_units: 8,
        ..Default::default()
    };
    for unusable in [12.5, -3.0, f64::NAN, f64::INFINITY, 9_007_199_254_740_992.0] {
        assert_eq!(
            timed(Some(&reported(unusable, None)), window()),
            estimated(2, SECOND),
            "{unusable}"
        );
        assert_eq!(
            timed(
                Some(&reported(unusable, None)),
                usage::GenerationTimes {
                    streamed_output_units: 0,
                    ..window()
                }
            ),
            None,
            "{unusable}"
        );
    }
}

#[test]
fn measured_and_estimated_timing_never_appear_together() {
    let window = usage::GenerationTimes {
        text: Some(0),
        ended: Some(SECOND),
        streamed_output_units: 100,
        ..Default::default()
    };
    assert_eq!(
        timed(Some(&reported(12.0, None)), window),
        measured(12, Some(SECOND))
    );
}

#[test]
fn estimated_output_never_enters_the_actual_token_counters() {
    let window = || usage::GenerationTimes {
        text: Some(0),
        ended: Some(SECOND),
        streamed_output_units: 64,
        ..Default::default()
    };
    assert_eq!(timed(None, window()), estimated(16, SECOND));
    assert_eq!(
        usage::tokens(None),
        parse_json(r#"{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#).unwrap()
    );
    let unusable = reported(f64::NAN, None);
    assert_eq!(timed(Some(&unusable), window()), estimated(16, SECOND));
    assert_eq!(
        usage::tokens(Some(&unusable)),
        parse_json(r#"{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#).unwrap()
    );
}

fn timing(value: &str) -> ycoding_schema::provider_request::Timing {
    ycoding_schema::provider_request::Timing::decode(&parse_json(value).unwrap()).unwrap()
}

#[test]
fn generation_speed_aggregates_eight_recent_steps_across_variants_of_the_newest_model() {
    let mut records = (0..10)
        .map(|index| {
            (
                begin().model,
                Some(timing(&format!(
                    r#"{{"generatedTokens":{},"generationDurationNs":2000000}}"#,
                    index + 10
                ))),
            )
        })
        .collect::<Vec<_>>();
    records[9].1 = Some(timing(
        r#"{"generatedTokens":10,"generationDurationNs":0,"observedGenerationDurationNs":2000000000}"#,
    ));
    let history = diagnostics::generation_speed(&records).unwrap();
    assert_eq!(
        history
            .recent
            .iter()
            .map(|sample| sample.tokens.get())
            .collect::<Vec<_>>(),
        [12, 13, 14, 15, 16, 17, 18, 10]
    );
    assert_eq!(history.recent[6].tokens_per_second, 9000.0);
    assert_eq!(history.recent[7].tokens_per_second, 5.0);
    let latest = history.latest.as_ref().unwrap();
    assert_eq!(
        (latest.tokens.get(), latest.duration_ns.get()),
        (115, 2_014_000_000)
    );
    assert_eq!(latest.tokens_per_second, 115_f64 * 1e9 / 2_014_000_000_f64);
    assert_eq!(latest.estimated, None);
    assert_eq!(latest.model, begin().model);
    let mut variant = begin().model;
    variant.variant = Some("high".into());
    records.push((
        variant.clone(),
        Some(timing(
            r#"{"generatedTokens":80,"observedGenerationDurationNs":1000000000}"#,
        )),
    ));
    let history = diagnostics::generation_speed(&records).unwrap();
    assert_eq!(
        history
            .recent
            .iter()
            .map(|sample| sample.tokens.get())
            .collect::<Vec<_>>(),
        [13, 14, 15, 16, 17, 18, 10, 80]
    );
    let latest = history.latest.as_ref().unwrap();
    assert_eq!(
        (latest.tokens.get(), latest.duration_ns.get()),
        (183, 3_012_000_000)
    );
    assert_eq!(latest.model, variant);
    assert_eq!(history.model, Some(variant.clone()));
    records.push((
        variant,
        Some(timing(
            r#"{"generatedTokens":2355,"observedGenerationDurationNs":71223792}"#,
        )),
    ));
    let history = diagnostics::generation_speed(&records).unwrap();
    assert_eq!(
        history
            .recent
            .iter()
            .map(|sample| sample.tokens.get())
            .collect::<Vec<_>>(),
        [14, 15, 16, 17, 18, 10, 80, 2355]
    );
    let latest = history.latest.as_ref().unwrap();
    assert_eq!(
        (latest.tokens.get(), latest.duration_ns.get()),
        (2525, 3_081_223_792)
    );
    assert_eq!(latest.tokens_per_second, 2525_f64 * 1e9 / 3_081_223_792_f64);
    assert!(diagnostics::generation_speed(&[]).is_none());
}

#[tokio::test]
async fn request_summary_counts_helpers_but_speed_uses_only_steps_and_snapshot_is_coherent() {
    let store = support::store();
    let service = Service::new(store.client());
    started(&store, &service).await;
    service
        .publish_step_end(ended(), "openai".into(), "gpt-5.6".into(), Vec::new(), None)
        .await
        .unwrap();
    for (ordinal, source, attempts, measured) in [
        (1, "step", 2, true),
        (2, "title", 1, true),
        (3, "step", 1, false),
    ] {
        let pending = service.begin_provider_request(&begin()).await.unwrap();
        assert_eq!(pending.request, ordinal);
        let fields = provider_request::recorded_fields(
            &begin(),
            &pending,
            &provider_request::Completion {
                source,
                agent: &"build".into(),
                invalidation: "provider-not-reported",
                continuation: "full",
                attempts,
                cache_read_reported: None,
                timing: measured.then(|| {
                    parse_json(r#"{"generatedTokens":12,"generationDurationNs":2000000000}"#)
                        .unwrap()
                }),
                cost: None,
                tokens: &usage::tokens(None),
                time: ordinal,
            },
        )
        .unwrap();
        let JsonValue::Object(fields) = fields else {
            panic!()
        };
        let JsonValue::Object(mut data) = ObjectEncoder::new()
            .field("sessionID", &begin().session)
            .finish()
        else {
            panic!()
        };
        for (key, value) in fields.iter() {
            data.insert(key.clone(), value.clone());
        }
        service
            .publish(NewEvent {
                id: format!("evt_request_{ordinal}").into(),
                aggregate_id: "ses_one".into(),
                type_: "session.provider.request.recorded.1".into(),
                created: ordinal,
                data: JsonValue::Object(data),
            })
            .await
            .unwrap();
    }
    let diagnostics = service
        .diagnostics(&begin().session, None)
        .unwrap()
        .unwrap();
    let summary = diagnostics.requests.unwrap();
    assert_eq!(
        (
            summary.logical.get(),
            summary.physical.get(),
            summary.helpers.get()
        ),
        (3, 4, 1)
    );
    assert!(summary.cost.is_none());
    assert!(summary.cache_read_reported.is_none());
    assert_eq!(summary.latest_namespace.unwrap().as_str(), Some("aaaaaaaa"));
    assert!(summary.latest_timing.is_none());
    let speed = diagnostics.generation_speed.unwrap();
    assert_eq!(speed.model, Some(begin().model));
    assert_eq!(speed.recent.len(), 1);
    assert_eq!(speed.recent[0].tokens_per_second, 6.0);
    let latest = speed.latest.as_ref().unwrap();
    assert_eq!(
        (latest.tokens.get(), latest.duration_ns.get()),
        (12, 2_000_000_000)
    );
    assert_eq!(latest.tokens_per_second, 6.0);
    assert_eq!(latest.estimated, None);
    assert_eq!(
        service
            .snapshot(&begin().session, 1, None)
            .unwrap()
            .generation_speed,
        Some(speed)
    );
    store.submit(|tx| ycoding_store::session::MessageTable::insert(tx, &ycoding_store::session::Message {
        id: "msg_compaction".into(), session_id: "ses_one".into(), type_: "compaction".into(), seq: 100,
        time_created: 2, time_updated: 2,
        data: parse_json(r#"{"status":"completed","reason":"manual","summary":"summary","recent":"","time":{"created":2}}"#).unwrap(),
    })).unwrap().await.unwrap();
    assert!(
        service
            .diagnostics(&begin().session, None)
            .unwrap()
            .is_none()
    );
    assert!(
        service
            .snapshot(&begin().session, 1, None)
            .unwrap()
            .generation_speed
            .is_none()
    );
}

#[tokio::test]
async fn overlapping_requests_reserve_distinct_ordinals_before_either_settles() {
    let store = support::store();
    let first_service = Service::new(store.client());
    let second_service = Service::new(store.client());
    let first = first_service
        .begin_provider_request(&begin())
        .await
        .unwrap();
    let second = second_service
        .begin_provider_request(&begin())
        .await
        .unwrap();
    assert_eq!((first.request, second.request), (1, 2));
    assert_ne!(first.id, second.id);
}

#[tokio::test]
async fn abandoned_reservations_survive_service_recreation_but_session_removal_cleans_them() {
    let store = support::store();
    let first = Service::new(store.client())
        .begin_provider_request(&begin())
        .await
        .unwrap();
    let service = Service::new(store.client());
    let next = service.begin_provider_request(&begin()).await.unwrap();
    assert_eq!((first.request, next.request), (1, 2));
    service.remove(&begin().session).await.unwrap();
    let key = tuple_key(&[KeyPart::String(&"session_provider_request:ses_one".into())]);
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<ycoding_store::resources::SequenceTable>(&key)
            .unwrap()
            .is_none()
    );
    store
        .submit(|tx| ycoding_store::session::SessionTable::insert(tx, &support::record("ses_one")))
        .unwrap()
        .await
        .unwrap();
    assert_eq!(
        service
            .begin_provider_request(&begin())
            .await
            .unwrap()
            .request,
        1
    );
}

#[test]
fn measured_diagnostics_include_an_empty_request_summary_without_fabricated_speed() {
    let store = support::store();
    store.submit(|tx| {
        ycoding_store::session::MessageTable::insert(tx, &ycoding_store::session::Message {
            id: "msg_measured".into(), session_id: "ses_one".into(), type_: "assistant".into(),
            seq: 0, time_created: 1, time_updated: 1,
            data: parse_json(r#"{"time":{"created":1,"completed":2},"agent":"build","model":{"providerID":"openai","id":"gpt-5.6"},"content":[],"tokens":{"input":1,"output":2,"reasoning":0,"cache":{"read":0,"write":0}}}"#).unwrap(),
        })
    }).unwrap().wait().unwrap();
    let diagnostics = Service::new(store.client())
        .diagnostics(&begin().session, None)
        .unwrap()
        .unwrap();
    assert_eq!(diagnostics.requests.unwrap().logical.get(), 0);
    let speed = diagnostics.generation_speed.unwrap();
    let model = speed.model.unwrap();
    assert_eq!(
        (model.provider_id.0.as_str(), model.id.as_str()),
        (Some("openai"), Some("gpt-5.6"))
    );
    assert!(speed.latest.is_none());
    assert!(speed.recent.is_empty());
    assert!(speed.unreported_reason.is_none());
}
