include!("tool_fixture.rs");

use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::mpsc;
use ycoding_ai::{
    Error,
    auth::Auth,
    llm::{self, Event, Request},
    provider_error::Reason,
    route::{Executor, LanguageAttempt, LanguageFuture, LanguageParts, ProcessInput, Transport},
};
use ycoding_core::{
    extension::{Activation, Host, Launch, Options},
    resources::model::{self, ProviderContext, from_language},
};
use ycoding_schema::{DomainDecode, JsonValue, parse_json, stringify_json};

const WATCHDOG: Duration = Duration::from_secs(5);

fn value(value: Value) -> JsonValue {
    parse_json(&value.to_string()).unwrap()
}

fn plain(value: &JsonValue) -> Value {
    serde_json::from_str(&stringify_json(value)).unwrap()
}

fn info(package: &str) -> ycoding_schema::model::Info {
    ycoding_schema::model::Info::decode(&value(json!({
        "id": "catalog-alias", "modelID": "wire-model", "providerID": "fixture.team",
        "name": "Fixture", "package": package,
        "capabilities": {"tools": true, "input": ["text"], "output": ["text"]},
        "variants": [], "time": {"released": 0}, "cost": [], "status": "active",
        "enabled": true, "limit": {"context": 131072, "input": 120000, "output": 8192}
    })))
    .unwrap()
}

fn settings(info: &mut ycoding_schema::model::Info, settings: Value) {
    info.settings = Some(ycoding_schema::provider::Settings::decode(&value(settings)).unwrap());
}

struct Language {
    inputs: Mutex<Vec<ProcessInput>>,
    parts: Mutex<Option<LanguageParts>>,
    failure: Option<Error>,
}

impl LanguageAttempt for Language {
    fn attempt(&self, input: ProcessInput) -> LanguageFuture<'_> {
        Box::pin(async move {
            self.inputs.lock().unwrap().push(input);
            if let Some(failure) = &self.failure {
                return Err(failure.clone());
            }
            self.parts
                .lock()
                .unwrap()
                .take()
                .ok_or_else(|| Error::output("Language attempt has already started"))
        })
    }
}

fn language() -> (mpsc::Sender<Result<JsonValue, Error>>, Arc<Language>) {
    let (send, parts) = mpsc::channel(2);
    (
        send,
        Arc::new(Language {
            inputs: Mutex::new(Vec::new()),
            parts: Mutex::new(Some(parts)),
            failure: None,
        }),
    )
}

fn request(info: &ycoding_schema::model::Info) -> Request {
    let (_, language) = language();
    let mut request = Request::new(from_language(info, language).unwrap());
    request.messages.push(llm::Message::user("Hello"));
    request
}

#[test]
fn model_identity_limits_and_transport_do_not_borrow_a_native_provider() {
    for package in ["fixture-sdk", "aisdk:fixture-sdk", "@ai-sdk/anthropic"] {
        let request = request(&info(package));
        let route = &request.model.route;
        assert_eq!(request.model.id.as_str(), Some("wire-model"));
        assert_eq!(request.model.provider.0.as_str(), Some("fixture.team"));
        assert_eq!(route.provider, request.model.provider);
        assert_eq!(
            route.id,
            format!("ai-sdk:{}", package.trim_start_matches("aisdk:"))
        );
        assert_eq!(route.protocol.id(), "ai-sdk");
        assert_eq!(route.defaults.context_limit, Some(131072.0));
        assert_eq!(route.defaults.output_limit, Some(8192.0));
        assert!(matches!(route.transport, Transport::Language(_)));
        assert!(matches!(route.auth, Auth::None));
        let prepared = route.prepare(&request).unwrap();
        assert_eq!(prepared.url.scheme(), "ai-sdk");
        assert_eq!(prepared.url.host_str(), Some("language"));
        assert!(!prepared.headers.contains_key("authorization"));
        assert_eq!(plain(&prepared.body)["maxOutputTokens"], 8192);
        assert!(route.defaults.provider_options.is_none());
        assert!(request.model.defaults.provider_options.is_none());
        assert!(request.model.tool_schema.is_none());
    }
}

#[test]
fn request_settings_headers_and_generation_follow_the_language_contract() {
    let mut info = info("aisdk:@ai-sdk/anthropic");
    settings(
        &mut info,
        json!({
            "apiKey": "synthetic-config-key", "authToken": "synthetic-config-token",
            "baseURL": "https://provider.invalid", "timeout": 1200, "chunkTimeout": 300,
            "fetch": "not-a-function", "thinking": {"type": "enabled", "budgetTokens": 1024},
            "temperature": 0.4, "maxTokens": 999, "nested": {"keep": true}
        }),
    );
    info.headers = Some(
        ycoding_schema::JsonObject::decode(&value(json!({
            "x-fixture": "configured", "x-preserved": "yes"
        })))
        .unwrap(),
    );
    let mut request = request(&info);
    request.generation.max_tokens = Some(64.0);
    request.generation.temperature = Some(0.7);
    request
        .http
        .headers
        .insert("x-fixture".into(), "request".into());
    let prepared = request.model.route.prepare(&request).unwrap();
    let body = plain(&prepared.body);
    assert_eq!(body["maxOutputTokens"], 64);
    assert_eq!(body["temperature"], 0.7);
    assert_eq!(
        body["headers"],
        json!({"x-fixture":"request","x-preserved":"yes"})
    );
    assert_eq!(prepared.headers["x-fixture"], "request");
    assert_eq!(
        body["providerOptions"],
        json!({"anthropic": {
            "thinking": {"type":"enabled","budgetTokens":1024},
            "temperature":0.4,"maxTokens":999,"nested":{"keep":true}
        }})
    );
    assert_eq!(
        request.model.route.defaults.generation,
        llm::Generation::default()
    );
    assert!(!prepared.headers.contains_key("authorization"));
}

#[test]
fn provider_namespaces_match_the_package_without_relabeling_unknown_models() {
    for (package, namespace) in [
        ("@ai-sdk/google", "google"),
        ("@ai-sdk/google-vertex", "vertex"),
        ("@ai-sdk/google-vertex/anthropic", "anthropic"),
        ("@ai-sdk/amazon-bedrock", "bedrock"),
        ("@ai-sdk/amazon-bedrock/mantle", "openai"),
        ("@ai-sdk/github-copilot", "copilot"),
        ("@jerome-benoit/sap-ai-provider-v2", "sap-ai"),
        ("@ai-sdk/openai-compatible", "fixture"),
        ("@openrouter/ai-sdk-provider", "openrouter"),
        ("ai-gateway-provider", "openaiCompatible"),
        ("@ai-sdk/custom", "custom"),
        ("fixture-sdk", "fixture.team"),
    ] {
        let mut info = info(package);
        settings(&mut info, json!({"selected":true}));
        let request = request(&info);
        assert_eq!(
            request.model.route.provider_metadata_key.as_deref(),
            Some(namespace),
            "{package}"
        );
        assert_eq!(
            plain(
                request
                    .model
                    .route
                    .defaults
                    .provider_options
                    .as_ref()
                    .unwrap()
            ),
            json!({namespace:{"selected":true}}),
            "{package}"
        );
    }
    let mut info = info("@ai-sdk/azure");
    settings(&mut info, json!({"reasoningEffort":"high"}));
    let request = request(&info);
    assert_eq!(
        request.model.route.provider_metadata_key.as_deref(),
        Some("azure")
    );
    assert_eq!(
        plain(
            request
                .model
                .route
                .defaults
                .provider_options
                .as_ref()
                .unwrap()
        ),
        json!({
            "openai":{"reasoningEffort":"high","forceReasoning":true},
            "azure":{"reasoningEffort":"high","forceReasoning":true}
        })
    );
}

#[test]
fn gateway_routes_separate_gateway_settings_from_the_model_namespace() {
    for (model_id, expected) in [
        (
            "anthropic/claude-fixture",
            json!({"gateway":{"order":["a"]},"anthropic":{"thinking":{"type":"adaptive"}}}),
        ),
        (
            "amazon/claude-fixture",
            json!({"gateway":{"order":["a"]},"bedrock":{"thinking":{"type":"adaptive"}}}),
        ),
        (
            "unprefixed",
            json!({"gateway":{"order":["a"],"thinking":{"type":"adaptive"}}}),
        ),
    ] {
        let mut info = info("@ai-sdk/gateway");
        info.model_id = model_id.into();
        settings(
            &mut info,
            json!({"gateway":{"order":["a"]},"thinking":{"type":"adaptive"}}),
        );
        let request = request(&info);
        assert_eq!(
            plain(
                request
                    .model
                    .route
                    .defaults
                    .provider_options
                    .as_ref()
                    .unwrap()
            ),
            expected
        );
        assert_eq!(
            request.model.route.provider_metadata_key.as_deref(),
            Some("gateway")
        );
    }
    let mut info = info("@ai-sdk/gateway");
    settings(&mut info, json!({"gateway":{"order":["a"]}}));
    assert_eq!(
        plain(
            request(&info)
                .model
                .route
                .defaults
                .provider_options
                .as_ref()
                .unwrap()
        ),
        json!({"gateway":{"order":["a"]}})
    );
    settings(&mut info, json!({"gateway":false}));
    assert!(
        request(&info)
            .model
            .route
            .defaults
            .provider_options
            .is_none()
    );
}

#[test]
fn pro_reasoning_is_projected_without_losing_other_body_defaults() {
    for package in [
        "@ai-sdk/openai",
        "@ai-sdk/azure",
        "@ai-sdk/amazon-bedrock/mantle",
        "fixture-sdk",
    ] {
        let mut info = info(package);
        info.body = Some(
            ycoding_schema::provider::Settings::decode(&value(json!({
                "reasoning":{"mode":"pro"},"custom":{"keep":true}
            })))
            .unwrap(),
        );
        let request = request(&info);
        assert_eq!(
            plain(request.model.route.defaults.http.body.as_ref().unwrap()),
            json!({"custom":{"keep":true}})
        );
        let options = plain(
            request
                .model
                .route
                .defaults
                .provider_options
                .as_ref()
                .unwrap(),
        );
        let namespace = request.model.route.provider_metadata_key.as_ref().unwrap();
        assert_eq!(options[namespace]["reasoningMode"], "pro");
        assert_eq!(
            options[namespace].get("forceReasoning"),
            (package != "fixture-sdk").then_some(&Value::Bool(true))
        );
        assert_eq!(
            plain(&request.model.route.prepare(&request).unwrap().wire_body)["custom"],
            json!({"keep":true})
        );
    }
    let mut info = info("fixture-sdk");
    info.body = Some(
        ycoding_schema::provider::Settings::decode(&value(json!({"reasoning":{"mode":"pro"}})))
            .unwrap(),
    );
    assert!(request(&info).model.route.defaults.http.body.is_none());
}

#[test]
fn invalid_factory_metadata_is_rejected_without_starting_an_attempt() {
    let (_, language) = language();
    let mut info = info("fixture-sdk");
    info.package = None;
    assert!(matches!(
        from_language(&info, language.clone()),
        Err(model::Error::UnsupportedPackage)
    ));
    info.package = Some("fixture-sdk".into());
    info.headers =
        Some(ycoding_schema::JsonObject::decode(&value(json!({"x-fixture":false}))).unwrap());
    assert!(matches!(
        from_language(&info, language.clone()),
        Err(model::Error::InvalidSettings)
    ));
    assert!(language.inputs.lock().unwrap().is_empty());
}

#[tokio::test]
async fn real_language_codec_streams_text_tools_and_usage_without_http() {
    let (send, language) = language();
    let mut info = info("fixture-sdk");
    settings(&mut info, json!({"selected":true}));
    let mut request = Request::new(from_language(&info, language.clone()).unwrap());
    request.messages.push(llm::Message::user("Hello"));
    request.caller = Some(llm::Caller {
        session_id: "ses_language".into(),
        agent: "test".into(),
        message_id: "msg_language".into(),
    });
    request
        .http
        .headers
        .insert("x-fixture".into(), "request".into());
    let observed = Arc::new(Mutex::new(Vec::new()));
    let captured = observed.clone();
    let mut executor = Executor::new(Executor::http_client().unwrap());
    executor.observer = Some(Arc::new(move |attempt| {
        captured.lock().unwrap().push(attempt);
        Ok(())
    }));
    let mut stream = executor.stream(&request).await.unwrap();
    send.send(Ok(value(
        json!({"type":"text-delta","id":"text","delta":"Hello"}),
    )))
    .await
    .unwrap();
    let first = tokio::time::timeout(WATCHDOG, async {
        loop {
            match stream.next().await.unwrap() {
                Some(Event::TextDelta(delta)) => break delta.text,
                Some(_) => {}
                None => panic!("stream ended before its first text"),
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(first.as_str(), Some("Hello"));
    let producer = tokio::spawn(async move {
        for part in [
            json!({"type":"text-end","id":"text"}),
            json!({"type":"tool-input-start","id":"call","toolName":"lookup"}),
            json!({"type":"tool-input-delta","id":"call","delta":"{\"query\":\"value\"}"}),
            json!({"type":"tool-input-end","id":"call"}),
            json!({"type":"tool-call","toolCallId":"call","toolName":"lookup","input":"{\"query\":\"value\"}"}),
            json!({"type":"finish","finishReason":{"unified":"tool-calls"},"usage":{"inputTokens":{"total":10,"noCache":6,"cacheRead":4},"outputTokens":{"total":3,"text":3}}}),
        ] {
            send.send(Ok(value(part))).await.unwrap();
        }
    });
    let mut tool = None;
    let mut finishes = Vec::new();
    tokio::time::timeout(WATCHDOG, async {
        while let Some(event) = stream.next().await.unwrap() {
            match event {
                Event::ToolCall(call) => tool = Some(call),
                Event::Finish(finish) => finishes.push(finish),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    producer.await.unwrap();
    let tool = tool.unwrap();
    assert_eq!(tool.name.as_str(), Some("lookup"));
    assert_eq!(plain(&tool.input), json!({"query":"value"}));
    assert_eq!(finishes.len(), 1);
    assert_eq!(finishes[0].reason, llm::FinishReason::ToolCalls);
    let usage = finishes[0].usage.as_ref().unwrap();
    assert_eq!(usage.input_tokens, Some(10.0));
    assert_eq!(usage.output_tokens, Some(3.0));
    assert_eq!(usage.cache_read_input_tokens, Some(4.0));
    assert_eq!(usage.total_tokens, Some(13.0));
    let inputs = language.inputs.lock().unwrap();
    assert_eq!(inputs.len(), 1);
    assert_eq!(inputs[0].model, info.model_id);
    assert_eq!(inputs[0].caller, request.caller);
    let body = plain(&inputs[0].body);
    assert_eq!(
        body["prompt"],
        json!([{"role":"user","content":[{"type":"text","text":"Hello"}]}])
    );
    assert_eq!(
        body["providerOptions"],
        json!({"fixture.team":{"selected":true}})
    );
    assert_eq!(body["headers"], json!({"x-fixture":"request"}));
    assert!(body.get("messages").is_none());
    assert!(observed.lock().unwrap().is_empty());
}

#[tokio::test]
async fn language_startup_and_stream_errors_preserve_the_ai_failure() {
    let failure = Error {
        code: Some("fixture_failure".into()),
        retry_after_ms: Some(123.0),
        ..Error::new(Reason::QuotaExceeded, "Synthetic quota failure")
    };
    let language = Arc::new(Language {
        inputs: Mutex::new(Vec::new()),
        parts: Mutex::new(None),
        failure: Some(failure.clone()),
    });
    let request = Request::new(from_language(&info("fixture-sdk"), language.clone()).unwrap());
    let executor = Executor::new(Executor::http_client().unwrap());
    let Err(actual) = executor.stream(&request).await else {
        panic!("failed startup returned a stream")
    };
    assert_eq!(actual, failure);
    assert_eq!(language.inputs.lock().unwrap().len(), 1);

    let (send, language) = self::language();
    let request = Request::new(from_language(&info("fixture-sdk"), language).unwrap());
    send.send(Ok(value(
        json!({"type":"text-delta","id":"text","delta":"Partial"}),
    )))
    .await
    .unwrap();
    send.send(Err(Error::interrupted())).await.unwrap();
    let mut stream = executor.stream(&request).await.unwrap();
    let mut visible = false;
    let actual = tokio::time::timeout(WATCHDOG, async {
        loop {
            match stream.next().await {
                Ok(Some(Event::TextDelta(_))) => visible = true,
                Ok(Some(Event::Finish(_))) => panic!("failed stream completed successfully"),
                Ok(Some(_)) => {}
                Ok(None) => panic!("stream swallowed interruption"),
                Err(error) => break error,
            }
        }
    })
    .await
    .unwrap();
    assert!(visible);
    assert_eq!(actual, Error::interrupted());
    assert!(send.is_closed());
}

#[tokio::test]
async fn dropping_the_factory_stream_cancels_its_owned_language_receiver() {
    let (send, language) = language();
    let request = Request::new(from_language(&info("fixture-sdk"), language).unwrap());
    let stream = Executor::new(Executor::http_client().unwrap())
        .stream(&request)
        .await
        .unwrap();
    assert!(!send.is_closed());
    drop(stream);
    tokio::time::timeout(WATCHDOG, send.closed()).await.unwrap();
}

fn activation(fixture: &ToolFixture) -> Arc<Activation> {
    Arc::new(Activation::new(
        fixture.root.clone(),
        Options::default(),
        Arc::new(fixture.registry()),
        fixture.policy.clone(),
        Launch::default(),
        Host::default(),
    ))
}

#[tokio::test]
async fn unbound_context_and_unclaimed_native_models_remain_native() {
    let fixture = ToolFixture::new();
    let context = ProviderContext::new(BTreeMap::new(), "test")
        .unwrap()
        .at(&fixture.root);
    assert!(
        context
            .language_model(&info("fixture-sdk"))
            .await
            .unwrap()
            .is_none()
    );
    let activation = activation(&fixture);
    context.bind_plugins(&activation).unwrap();
    assert!(
        context
            .language_model(&info("@ai-sdk/openai"))
            .await
            .unwrap()
            .is_none()
    );
    let failure = context
        .language_model(&info("fixture-sdk"))
        .await
        .err()
        .unwrap();
    assert_eq!(failure.reason, Reason::InvalidProviderOutput);
    activation.close().await;
    fixture.cleanup();
}

#[tokio::test]
async fn plugin_binding_is_single_assignment_and_scoped_to_its_directory() {
    let fixture = ToolFixture::new();
    let context = ProviderContext::new(BTreeMap::new(), "test")
        .unwrap()
        .at(&fixture.root);
    let activation = activation(&fixture);
    let weak = Arc::downgrade(&activation);
    context.bind_plugins(&activation).unwrap();
    let other = self::activation(&fixture);
    assert!(context.bind_plugins(&other).is_err());
    let same = context.at(&fixture.root);
    let isolated = context.at(&fixture.root.join("other"));
    let isolated_same = isolated.at(&fixture.root.join("other"));
    let isolated_again = isolated.at(&fixture.root);
    drop(activation);
    assert!(weak.upgrade().is_none());
    for context in [&context, &same] {
        assert!(
            context
                .language_model(&info("@ai-sdk/openai"))
                .await
                .is_err()
        );
    }
    for context in [&isolated, &isolated_same, &isolated_again] {
        assert!(
            context
                .language_model(&info("fixture-sdk"))
                .await
                .unwrap()
                .is_none()
        );
    }
    other.close().await;
    fixture.cleanup();
}

#[tokio::test]
async fn closed_but_retained_activation_does_not_fall_back_to_native() {
    let fixture = ToolFixture::new();
    let context = ProviderContext::new(BTreeMap::new(), "test")
        .unwrap()
        .at(&fixture.root);
    let activation = activation(&fixture);
    context.bind_plugins(&activation).unwrap();
    activation.close().await;
    assert!(
        context
            .language_model(&info("@ai-sdk/openai"))
            .await
            .is_err()
    );
    fixture.cleanup();
}
