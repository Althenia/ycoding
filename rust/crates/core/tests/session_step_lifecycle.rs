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

#[test]
fn generation_timing_counts_only_the_observed_token_span_and_hides_uncertain_reasoning() {
    let times = usage::GenerationTimes {
        text: Some(40_000_000_000),
        reasoning: Some(0),
        tool_input: Some(39_000_000_000),
        ended: Some(43_000_000_000),
    };
    let mut reported = ycoding_core::ycoding_ai::llm::Usage {
        output_tokens: Some(4200.0),
        reasoning_tokens: Some(4000.0),
        ..Default::default()
    };
    assert_eq!(
        usage::generation_timing(Some(&reported), &times),
        Some(
            parse_json(r#"{"generatedTokens":200,"observedGenerationDurationNs":4000000000}"#)
                .unwrap()
        )
    );
    reported.reasoning_tokens = None;
    reported.output_tokens = Some(12.0);
    assert_eq!(
        usage::generation_timing(Some(&reported), &times),
        Some(
            parse_json(r#"{"generatedTokens":12,"observedGenerationDurationNs":43000000000}"#)
                .unwrap()
        )
    );
    reported.output_may_include_unreported_reasoning = Some(true);
    assert_eq!(usage::generation_timing(Some(&reported), &times), None);
    reported.generation_duration_ns = Some(2_000_000.0);
    assert_eq!(
        usage::generation_timing(Some(&reported), &times),
        Some(parse_json(r#"{"generatedTokens":12}"#).unwrap())
    );
    reported.generation_duration_ns = None;
    reported.output_may_include_unreported_reasoning = None;
    let burst = usage::GenerationTimes {
        text: Some(0),
        ended: Some(999_999_999),
        ..Default::default()
    };
    assert_eq!(
        usage::generation_timing(Some(&reported), &burst),
        Some(parse_json(r#"{"generatedTokens":12}"#).unwrap())
    );
    let boundary = usage::GenerationTimes {
        ended: Some(1_000_000_000),
        ..burst
    };
    assert_eq!(
        usage::generation_timing(Some(&reported), &boundary),
        Some(
            parse_json(r#"{"generatedTokens":12,"observedGenerationDurationNs":1000000000}"#)
                .unwrap()
        )
    );
    reported.output_tokens = Some(0.0);
    assert_eq!(usage::generation_timing(Some(&reported), &boundary), None);
}

fn timing(value: &str) -> ycoding_schema::provider_request::Timing {
    ycoding_schema::provider_request::Timing::decode(&parse_json(value).unwrap()).unwrap()
}

#[test]
fn generation_speed_keeps_eight_recent_steps_for_the_newest_model_and_variant() {
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
    assert!(history.latest.is_none());
    assert_eq!(
        history
            .recent
            .iter()
            .map(|sample| sample.tokens.get())
            .collect::<Vec<_>>(),
        [12, 13, 14, 15, 16, 17, 18]
    );
    assert_eq!(history.recent.last().unwrap().tokens_per_second, 9000.0);
    let mut variant = begin().model;
    variant.variant = Some("high".into());
    records.push((
        variant.clone(),
        Some(timing(
            r#"{"generatedTokens":80,"observedGenerationDurationNs":1000000000}"#,
        )),
    ));
    assert_eq!(
        diagnostics::generation_speed(&records)
            .unwrap()
            .recent
            .len(),
        1
    );
    records.push((
        variant,
        Some(timing(
            r#"{"generatedTokens":2355,"observedGenerationDurationNs":71223792}"#,
        )),
    ));
    let history = diagnostics::generation_speed(&records).unwrap();
    assert!(history.latest.is_none());
    assert_eq!(history.recent[0].tokens.get(), 80);
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
    assert!(speed.latest.is_none());
    assert_eq!(speed.recent.len(), 1);
    assert_eq!(speed.recent[0].tokens_per_second, 6.0);
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
    assert!(diagnostics.generation_speed.is_none());
}
