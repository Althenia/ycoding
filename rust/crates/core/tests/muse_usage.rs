#[path = "support/muse.rs"]
mod fixture;
#[path = "support/muse_inference.rs"]
mod inference_fixture;
use fixture::{Fixture, header, secret, store};
use inference_fixture::{json, model};
use ycoding_ai::{
    llm::{self, Request},
    muse::{Runtime, normalize_usage},
    route::Executor,
};
use ycoding_core::resources::{
    model::{account_identity, quota},
    muse,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, parse_json, provider, provider_usage, schema::NonNegativeInt,
};

fn quota_event() -> &'static str {
    r#"{"type":"response.subscription_usage","subscription":{"tier":"private-tier","window":{"used_percent":0,"resets_at":1791876076,"window_duration_mins":300},"weekly":{"used_percent":0,"resets_at":1792368000}}}"#
}

#[test]
fn subscription_zero_fractional_absent_metrics_labels_resets_and_source_roundtrip() {
    let snapshot = normalize_usage(&parse_json(quota_event()).unwrap(), 100).unwrap();
    assert_eq!(snapshot.provider_id, provider::Id("muse".into()));
    assert_eq!(snapshot.label, "Muse (Meta)".into());
    assert_eq!(snapshot.status, "available".into());
    assert_eq!(snapshot.source, "response_stream".into());
    assert_eq!(snapshot.stability, "observed".into());
    assert_eq!(snapshot.updated_at.get(), 100);
    assert_eq!(snapshot.windows.len(), 2);
    let window = &snapshot.windows[0];
    assert_eq!(window.id, "window".into());
    assert_eq!(window.unit, "percent".into());
    assert_eq!(window.used, Some(0.0));
    assert_eq!(window.label, "5-hour window".into());
    assert_eq!(window.reset_at.unwrap().get(), 1791876076000);
    assert_eq!(window.period_seconds.unwrap().get(), 18000);
    let weekly = &snapshot.windows[1];
    assert_eq!(weekly.id, "weekly".into());
    assert_eq!(weekly.label, "Weekly".into());
    assert_eq!(weekly.used, Some(0.0));
    assert_eq!(weekly.reset_at.unwrap().get(), 1792368000000);
    assert_eq!(weekly.period_seconds.unwrap().get(), 604800);
    let encoded = snapshot.encode();
    assert_eq!(
        provider_usage::Snapshot::decode(&encoded).unwrap(),
        snapshot
    );
    assert!(!ycoding_schema::stringify_json(&encoded).contains("private-tier"));
    let observation = provider_usage::Observation {
        provider_id: snapshot.provider_id,
        label: snapshot.label,
        source: snapshot.source,
        stability: snapshot.stability,
        observed_at: snapshot.updated_at,
        windows: snapshot.windows,
    };
    assert_eq!(
        provider_usage::Observation::decode(&observation.encode()).unwrap(),
        observation
    );
    assert!(provider_usage::Source::decode(&parse_json(r#""response_stream""#).unwrap()).is_ok());
    let snapshot = normalize_usage(&parse_json(r#"{"type":"response.subscription_usage","subscription":{"window":{"window_duration_mins":30,"resets_at":1791876076},"weekly":{"used_percent":0.5}}}"#).unwrap(), -1).unwrap();
    assert_eq!(snapshot.updated_at.get(), 0);
    assert_eq!(snapshot.windows[0].label, "30-minute window".into());
    assert_eq!(snapshot.windows[0].used, None);
    assert_eq!(snapshot.windows[0].period_seconds.unwrap().get(), 1800);
    assert_eq!(snapshot.windows[1].used, Some(0.5));
    assert_eq!(snapshot.windows[1].reset_at, None);
    assert!(
        normalize_usage(
            &parse_json(r#"{"type":"response.subscription_usage","subscription":{}}"#).unwrap(),
            100
        )
        .unwrap()
        .windows
        .is_empty()
    );
}

#[test]
fn malformed_subscription_metrics_rejected_without_payload() {
    for payload in [
        "null",
        "{}",
        r#"{"type":"response.subscription_usage","subscription":"invalid"}"#,
        r#"{"type":"response.subscription_usage","subscription":{"window":{"used_percent":-1}}}"#,
        r#"{"type":"response.subscription_usage","subscription":{"weekly":{"used_percent":101}}}"#,
        r#"{"type":"response.subscription_usage","subscription":{"window":{"resets_at":"1791876076"}}}"#,
        r#"{"type":"response.subscription_usage","subscription":{"window":{"window_duration_mins":0}}}"#,
        r#"{"type":"response.subscription_usage","subscription":{"weekly":{"resets_at":1.5}}}"#,
    ] {
        assert!(
            normalize_usage(&parse_json(payload).unwrap(), 100).is_none(),
            "{payload}"
        );
    }
}

#[tokio::test]
async fn quota_read_is_unreported_without_a_network_request() {
    let (_store, credentials) = store();
    let saved = credentials
        .create(
            "muse-no-data".into(),
            "muse".into(),
            None,
            secret(r#"{"type":"key","key":"fixture"}"#),
            1,
        )
        .await
        .unwrap();
    let usage = quota::Service::new(credentials, quota::Endpoints::default()).unwrap();
    let result = usage
        .get(provider::Id("muse".into()), Some(saved.id()), true, 100)
        .await;
    assert_eq!(result, ycoding_ai::muse::unreported(100));
    assert_eq!(
        result.message.as_ref().unwrap().as_str(),
        Some("Quota is reported after the next Muse response")
    );
    usage.shutdown().await.unwrap();
}

#[tokio::test]
async fn trailing_quota_profile_env_isolation_replacement_malformed_and_no_terminal_newline() {
    for profile in [true, false] {
        let fixture = Fixture::new(vec![(
            200,
            format!("{}data: {}", inference_fixture::inference(), quota_event()),
        )])
        .await;
        let (_store, credentials) = store();
        let key = secret(r#"{"type":"key","key":"fixture"}"#);
        let saved = if profile {
            Some(
                credentials
                    .create(
                        "muse-personal".into(),
                        "muse".into(),
                        Some("Personal".into()),
                        key.clone(),
                        1,
                    )
                    .await
                    .unwrap(),
            )
        } else {
            None
        };
        let other = if profile {
            Some(
                credentials
                    .create(
                        "muse-work".into(),
                        "muse".into(),
                        Some("Work".into()),
                        secret(r#"{"type":"key","key":"other"}"#),
                        2,
                    )
                    .await
                    .unwrap(),
            )
        } else {
            None
        };
        let usage = quota::Service::new(credentials.clone(), quota::Endpoints::default()).unwrap();
        let runtime = Runtime::shared().unwrap();
        let model = muse::from_catalog_model(
            &model(&format!("{}/v1", fixture.base)),
            Some(&key.domain().unwrap()),
            saved.as_ref(),
            runtime.clone(),
        )
        .unwrap();
        let result = Executor::new(Executor::http_client().unwrap())
            .generate(&Request::new(model))
            .await
            .unwrap();
        assert_eq!(result.text().as_str(), Some("Hello こんにちは"));
        assert_eq!(result.reasoning().as_str(), Some("Thought"));
        let reported = usage
            .get(
                provider::Id("muse".into()),
                saved.as_ref().map(|v| v.id()),
                false,
                100,
            )
            .await;
        assert_eq!(reported.status, "available".into());
        assert_eq!(reported.windows.len(), 2);
        assert_eq!(reported.windows[0].used, Some(0.0));
        assert_eq!(reported.source, "response_stream".into());
        let profile_source = saved.as_ref().map(account_identity);
        let before = runtime
            .observation(profile_source.as_ref().and_then(|v| v.as_str()))
            .unwrap();
        runtime.observe(&parse_json(r#"{"type":"response.subscription_usage","subscription":{"window":{"used_percent":"private invalid value"}}}"#).unwrap(), profile_source.as_ref().and_then(|v| v.as_str()), 101);
        assert_eq!(
            runtime
                .observation(profile_source.as_ref().and_then(|v| v.as_str()))
                .unwrap(),
            before
        );
        if let (Some(saved), Some(other)) = (saved, other) {
            assert_eq!(reported.profile, Some("Personal".into()));
            assert_eq!(
                usage
                    .get(provider::Id("muse".into()), Some(other.id()), false, 100)
                    .await
                    .status,
                "unsupported".into()
            );
            credentials
                .update(
                    saved.id().clone(),
                    None,
                    Some(secret(r#"{"type":"key","key":"replacement"}"#)),
                    3,
                )
                .await
                .unwrap();
            assert_eq!(
                usage
                    .get(provider::Id("muse".into()), Some(saved.id()), false, 100)
                    .await
                    .status,
                "unsupported".into()
            );
        }
        let requests = fixture.finish().await;
        assert_eq!(requests.len(), 1);
        assert_eq!(
            header(&requests[0], "authorization"),
            Some("Bearer fixture")
        );
        usage.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn live_responses_commentary_function_tools_usage_and_malformed_quota_are_best_effort() {
    let runtime = Runtime::new("http://127.0.0.1:1/key".into()).unwrap();
    let tools = [
        serde_json::json!({"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"fc_live","call_id":"call_live","name":"read_file","arguments":""}}),
        serde_json::json!({"type":"response.function_call_arguments.delta","item_id":"fc_live","output_index":2,"delta":"{\"path\":\"file.txt\"}"}),
        serde_json::json!({"type":"response.output_item.done","output_index":2,"item":{"type":"function_call","id":"fc_live","call_id":"call_live","name":"read_file","arguments":"{\"path\":\"file.txt\"}","status":"completed"}}),
    ].iter().map(|v| format!("event: {}\ndata: {v}\n\n", v["type"].as_str().unwrap())).collect::<String>();
    let stream = inference_fixture::inference().replace(
        "event: response.completed",
        &format!("{tools}event: response.completed"),
    );
    let fixture = Fixture::new(vec![(200, format!("{stream}data: {{\"type\":\"response.subscription_usage\", invalid}}\r\n\r\ndata: {}\r\n\r\n", quota_event()))]).await;
    let value = secret(r#"{"type":"key","key":"direct-key"}"#)
        .domain()
        .unwrap();
    let model = muse::from_catalog_model(
        &model(&format!("{}/v1", fixture.base)),
        Some(&value),
        None,
        runtime.clone(),
    )
    .unwrap();
    let mut request = Request::new(model);
    request.messages = vec![llm::Message::user("Read file")];
    request.tools = vec![llm::ToolDefinition { name: "read_file".into(), description: "Read a file".into(), input_schema: parse_json(r#"{"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}"#).unwrap(), output_schema: None, cache: None, metadata: None, native: None }];
    let executor = Executor::new(Executor::http_client().unwrap());
    let mut stream = executor.stream(&request).await.unwrap();
    let mut events = vec![];
    while let Some(event) = stream.next().await.unwrap() {
        events.push(event);
    }
    assert!(events.iter().any(|event| matches!(event, llm::Event::TextStart(v) if v.provider_metadata.as_ref().is_some_and(|m| ycoding_schema::stringify_json(m).contains("commentary")))));
    assert!(events.iter().any(|event| matches!(event, llm::Event::ReasoningEnd(v) if v.provider_metadata.as_ref().is_some_and(|m| ycoding_schema::stringify_json(m).contains("encrypted-fixture")))));
    let result = llm::Response::from_events(events).unwrap();
    assert_eq!(result.text().as_str(), Some("Hello こんにちは"));
    assert_eq!(result.reasoning().as_str(), Some("Thought"));
    assert_eq!(result.finish_reason, llm::FinishReason::ToolCalls);
    assert!(result.message.content.iter().any(|p| matches!(p, llm::Part::ToolCall(call) if call.id == "call_live".into() && call.name == "read_file".into() && call.input == parse_json(r#"{"path":"file.txt"}"#).unwrap())));
    let usage = result.usage.unwrap();
    assert_eq!(
        (
            usage.input_tokens,
            usage.non_cached_input_tokens,
            usage.cache_read_input_tokens,
            usage.output_tokens,
            usage.reasoning_tokens
        ),
        (Some(100.0), Some(40.0), Some(60.0), Some(20.0), Some(12.0))
    );
    assert_eq!(runtime.observation(None).unwrap().windows.len(), 2);
    let requests = fixture.finish().await;
    let body = json(&requests[0]);
    assert_eq!(body["tools"][0]["strict"], false);
    assert_eq!(body["tools"][0]["type"], "function");
    assert_eq!(body["tools"][0]["name"], "read_file");
    assert_eq!(
        body["tools"][0]["parameters"]["required"],
        serde_json::json!(["path"])
    );
    assert!(body.get("temperature").is_none());
    assert!(body.get("top_p").is_none());
}

#[tokio::test]
async fn malformed_model_event_is_not_masked_as_quota() {
    let fixture = Fixture::new(vec![(200, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"response.subscription_usage\", invalid}\n\n".into())]).await;
    let value = secret(r#"{"type":"key","key":"direct-key"}"#)
        .domain()
        .unwrap();
    let model = muse::from_catalog_model(
        &model(&format!("{}/v1", fixture.base)),
        Some(&value),
        None,
        Runtime::new("http://127.0.0.1:1/key".into()).unwrap(),
    )
    .unwrap();
    let failure = Executor::new(Executor::http_client().unwrap())
        .generate(&Request::new(model))
        .await
        .unwrap_err();
    assert_eq!(failure.message, "Invalid provider stream event");
    assert_eq!(fixture.finish().await.len(), 1);
}

fn observation(used: f64) -> provider_usage::Observation {
    provider_usage::Observation {
        provider_id: provider::Id("muse".into()),
        label: "Muse (Meta)".into(),
        source: "response_stream".into(),
        stability: "observed".into(),
        observed_at: NonNegativeInt::new(200).unwrap(),
        windows: vec![provider_usage::Window {
            id: "window".into(),
            label: "5-hour window".into(),
            unit: "percent".into(),
            used: Some(used),
            limit: None,
            remaining: None,
            unlimited: None,
            reset_at: None,
            period_seconds: None,
        }],
    }
}

#[tokio::test]
async fn muse_refresh_keeps_stored_and_unbound_observations_at_later_time() {
    let (_store, credentials) = store();
    let saved = credentials
        .create(
            "muse-refresh".into(),
            "muse".into(),
            None,
            secret(r#"{"type":"key","key":"fixture"}"#),
            1,
        )
        .await
        .unwrap();
    let usage = quota::Service::new(credentials, quota::Endpoints::default()).unwrap();
    let muse = || provider::Id("muse".into());
    assert_eq!(
        usage.get(muse(), Some(saved.id()), true, 100).await,
        ycoding_ai::muse::unreported(100)
    );
    usage
        .observe(observation(42.0), Some(account_identity(&saved)))
        .unwrap();
    let result = usage.get(muse(), Some(saved.id()), true, 300).await;
    assert_eq!(result.status, "available".into());
    assert_eq!(result.source, "response_stream".into());
    assert_eq!(result.stability, "observed".into());
    assert_eq!(result.updated_at, NonNegativeInt::new(200).unwrap());
    assert_eq!(result.windows.len(), 1);
    assert_eq!(result.windows[0].used, Some(42.0));
    usage.shutdown().await.unwrap();

    let (_store, credentials) = store();
    let unbound = quota::Service::new(credentials, quota::Endpoints::default()).unwrap();
    assert_eq!(
        unbound.get(muse(), None, true, 100).await,
        ycoding_ai::muse::unreported(100)
    );
    unbound.observe(observation(7.0), None).unwrap();
    let result = unbound.get(muse(), None, true, 300).await;
    assert_eq!(result.status, "available".into());
    assert_eq!(result.updated_at, NonNegativeInt::new(200).unwrap());
    assert_eq!(result.windows[0].used, Some(7.0));
    unbound.shutdown().await.unwrap();
}
