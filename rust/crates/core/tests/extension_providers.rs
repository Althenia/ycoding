include!("tool_fixture.rs");
use std::time::Duration;
use ycoding_ai::{
    llm::{Event, Request},
    route::{Executor, ProcessAttempt, ProcessInput, Transport},
};
use ycoding_core::{
    extension::{Configuration, Extension, FamilyGrant, Host, Options, ToolGrant, provider},
    resources::{catalog::models_dev, model::from_catalog_model},
};
use ycoding_schema::{DomainDecode, parse_json, provider as provider_schema, stringify_json};

fn info(package: &str) -> ycoding_schema::model::Info {
    let mut model = models_dev::normalize(
        &parse_json(include_str!(
            "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
        ))
        .unwrap(),
    )
    .unwrap()[0]
        .models[0]
        .clone();
    model.package = Some(package.into());
    model.model_id = "fake-model".into();
    model.provider_id = provider_schema::Id("fixture".into());
    model.settings = Some(
        ycoding_schema::provider::Settings::decode(
            &parse_json(r#"{"baseURL":"http://127.0.0.1:1","apiKey":"fixture"}"#).unwrap(),
        )
        .unwrap(),
    );
    model
}

fn configuration(fixture: &ToolFixture, package: &str, mode: &str) -> Configuration {
    Configuration {
        identity: "fixture".into(),
        executable: "/usr/bin/python3".into(),
        args: vec![
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/extension_child.py").into(),
            mode.into(),
        ],
        directory: fixture.root.clone(),
        registration_order: 0,
        grants: vec![ToolGrant {
            namespace: "demo".into(),
            tools: vec!["echo".into()],
            action: "extension.echo".into(),
            resources: vec!["demo".into()],
        }],
        families: vec![FamilyGrant {
            family: ycoding_core::extension::v5::CapabilityFamily::Providers,
            scopes: vec![package.into()],
            action: "extension.provider".into(),
            resources: vec!["providers".into()],
        }],
    }
}

fn options() -> Options {
    Options {
        startup: Duration::from_secs(1),
        execution: Duration::from_secs(10),
        cleanup: Duration::from_millis(100),
        shutdown: Duration::from_millis(100),
        write: Duration::from_millis(500),
    }
}

async fn response(package: &str) -> ycoding_ai::llm::Response {
    let model = from_catalog_model(&info(package), None).unwrap();
    assert!(
        matches!(model.route.transport, Transport::Process(_)),
        "aisdk package maps to the process transport while a granted extension provides it"
    );
    let mut request = Request::new(model);
    request.messages = vec![ycoding_ai::llm::Message::user("hi")];
    Executor::new(Executor::http_client().unwrap())
        .generate(&request)
        .await
        .unwrap()
}

fn assert_fake_output(response: &ycoding_ai::llm::Response) {
    assert_eq!(response.text().as_str(), Some("Hello"));
    let call = response
        .events
        .iter()
        .find_map(|event| match event {
            Event::ToolCall(call) => Some(call),
            _ => None,
        })
        .expect("one tool call");
    assert_eq!(call.name.as_str(), Some("get_weather"));
    assert_eq!(
        stringify_json(&call.input),
        "{\"city\":\"Paris\"}".to_string()
    );
    let usage = response.usage.as_ref().expect("usage");
    assert_eq!(
        (usage.input_tokens, usage.output_tokens, usage.total_tokens),
        (Some(10.0), Some(20.0), Some(30.0))
    );
    assert!(response.events.iter().any(|event| matches!(
        event,
        Event::Finish(finish) if matches!(
            finish.reason,
            ycoding_ai::llm::FinishReason::ToolCalls
        )
    )));
}

#[tokio::test]
async fn process_provider_round_trips_text_tool_call_and_usage() {
    let package = "aisdk:@ai-sdk/openai-compatible";
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let extension = Extension::start(
        configuration(&fixture, package, "provider_fake"),
        options(),
        &registry,
        fixture.policy.clone(),
        &fixture.context(),
        Host::default(),
    )
    .await
    .unwrap();
    assert_fake_output(&response(package).await);
    assert_fake_output(&response(package).await);
    assert!(
        provider::find("aisdk:@ai-sdk/openai").is_none(),
        "packages outside the grant stay on their built-in route"
    );
    fixture.deny("extension.provider", "providers");
    let denied = from_catalog_model(&info(package), None).unwrap();
    let mut denied_request = Request::new(denied);
    denied_request.messages = vec![ycoding_ai::llm::Message::user("hi")];
    assert!(
        Executor::new(Executor::http_client().unwrap())
            .generate(&denied_request)
            .await
            .is_err(),
        "denied provider authority rejects the attempt"
    );
    extension.shutdown().await;
    assert!(
        provider::find(package).is_none(),
        "shutdown revokes the provider"
    );
    fixture.cleanup();
}

#[tokio::test]
async fn dropped_attempts_cancel_and_the_generation_stays_usable() {
    let package = "aisdk:@ycoding-ai/ai/providers/openai-compatible";
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let extension = Extension::start(
        configuration(&fixture, package, "provider_slow"),
        options(),
        &registry,
        fixture.policy.clone(),
        &fixture.context(),
        Host::default(),
    )
    .await
    .unwrap();
    let provider = provider::find(package).unwrap();
    let pending = tokio::spawn(async move {
        let _ = provider
            .attempt(ProcessInput {
                model: "fake".into(),
                options: None,
                body: parse_json("{}").unwrap(),
            })
            .await;
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    pending.abort();
    let _ = pending.await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_fake_output(&response(package).await);
    extension.shutdown().await;
    fixture.cleanup();
}

#[test]
fn provider_scopes_are_aisdk_packages() {
    let fixture = ToolFixture::new();
    for (scopes, valid) in [
        (&["aisdk:@ai-sdk/openai"][..], true),
        (&["@ai-sdk/openai"][..], false),
        (&["aisdk:fake", "aisdk:fake"][..], false),
    ] {
        let configuration = configuration(&fixture, "aisdk:@ai-sdk/openai", "provider_fake");
        let families = vec![FamilyGrant {
            family: ycoding_core::extension::v5::CapabilityFamily::Providers,
            scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
            action: "extension.provider".into(),
            resources: vec!["providers".into()],
        }];
        assert_eq!(
            Configuration {
                families,
                ..configuration
            }
            .validate()
            .is_ok(),
            valid
        );
    }
    fixture.cleanup();
}
