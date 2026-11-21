use ycoding_core::resources::{
    catalog::models_dev,
    model::{Error, from_catalog_model},
};
use ycoding_schema::{DomainDecode, parse_json, provider};

fn info(package: &str, settings: &str) -> ycoding_schema::model::Info {
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
    model.model_id = "gpt-5.6".into();
    model.provider_id = provider::Id("fixture".into());
    model.settings =
        Some(ycoding_schema::provider::Settings::decode(&parse_json(settings).unwrap()).unwrap());
    model
}

#[test]
fn native_entrypoints_choose_their_own_api_and_api_model_identity() {
    for (package, route) in [
        ("@ycoding-ai/ai/providers/openai", "openai-responses"),
        (
            "@ycoding-ai/ai/providers/openai/responses",
            "openai-responses",
        ),
        ("@ycoding-ai/ai/providers/azure", "azure-openai-responses"),
        (
            "@ycoding-ai/ai/providers/azure/responses",
            "azure-openai-responses",
        ),
        ("@ycoding-ai/ai/providers/azure/chat", "azure-openai-chat"),
        ("@ycoding-ai/ai/providers/xai", "openai-responses"),
        (
            "@ycoding-ai/ai/providers/openai-compatible",
            "openai-compatible-chat",
        ),
        (
            "@ycoding-ai/ai/providers/openai-compatible/responses",
            "openai-compatible-responses",
        ),
        ("@ycoding-ai/ai/providers/anthropic", "anthropic-messages"),
        (
            "@ycoding-ai/ai/providers/anthropic-compatible",
            "anthropic-messages",
        ),
        ("@ycoding-ai/ai/providers/google", "gemini"),
        (
            "@ycoding-ai/ai/providers/openrouter",
            "openrouter-responses",
        ),
    ] {
        let model = from_catalog_model(
            &info(
                package,
                r#"{"baseURL":"http://127.0.0.1:1","apiKey":"fixture"}"#,
            ),
            None,
        )
        .unwrap();
        assert_eq!(model.route.id, route, "{package}");
        assert_eq!(model.id, "gpt-5.6".into());
        assert_eq!(model.provider.0, "fixture".into());
    }
    assert!(matches!(
        from_catalog_model(&info("@ycoding-ai/ai/providers/openai/chat", "{}"), None),
        Err(Error::UnsupportedPackage)
    ));
}

#[test]
fn native_provider_options_query_and_transport_defaults_reach_prepared_wire() {
    let native = from_catalog_model(&info("@ycoding-ai/ai/providers/openai",r#"{"apiKey":"fixture","providerOptions":{"openai":{"reasoningEffort":"high"}},"transport":"websocket"}"#),None).unwrap();
    assert_eq!(native.route.id, "openai-responses-websocket");
    let prepared = native
        .route
        .prepare(&ycoding_ai::llm::Request::new(native.clone()))
        .unwrap();
    assert!(ycoding_schema::stringify_json(&prepared.wire_body).contains("\"effort\":\"high\""));
    let azure = from_catalog_model(&info("@ycoding-ai/ai/providers/azure/chat",r#"{"apiKey":"fixture","baseURL":"http://127.0.0.1:1","apiVersion":"custom","queryParams":{"api-version":"override","extra":"retained"}}"#),None).unwrap();
    assert_eq!(
        azure
            .route
            .endpoint
            .query
            .get("api-version")
            .map(String::as_str),
        Some("override")
    );
    assert_eq!(
        azure.route.endpoint.query.get("extra").map(String::as_str),
        Some("retained")
    );
    assert!(
        from_catalog_model(
            &info(
                "@ycoding-ai/ai/providers/openai",
                r#"{"transport":"unsupported"}"#
            ),
            None
        )
        .is_err()
    );
}
