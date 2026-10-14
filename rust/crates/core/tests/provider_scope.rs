use ycoding_core::resources::{
    catalog::{Catalog, models_dev},
    config, model,
};
use ycoding_core::ycoding_schema::{DomainEncode, JsonValue, parse_json, provider};

const KEPT: &[(&str, &str)] = &[
    ("openai", "@ai-sdk/openai"),
    ("anthropic", "@ai-sdk/anthropic"),
    ("openrouter", "@openrouter/ai-sdk-provider"),
    ("llama", "@ai-sdk/openai-compatible"),
    ("meta", "@ai-sdk/openai"),
    ("cline-pass", "@ai-sdk/openai-compatible"),
    ("zai", "@ai-sdk/openai-compatible"),
    ("zai-coding-plan", "@ai-sdk/openai-compatible"),
    ("zhipuai", "@ai-sdk/openai-compatible"),
    ("zhipuai-coding-plan", "@ai-sdk/openai-compatible"),
    ("minimax", "@ai-sdk/anthropic"),
    ("minimax-cn", "@ai-sdk/anthropic"),
    ("minimax-coding-plan", "@ai-sdk/anthropic"),
    ("minimax-cn-coding-plan", "@ai-sdk/anthropic"),
    ("moonshotai", "@ai-sdk/openai-compatible"),
    ("moonshotai-cn", "@ai-sdk/openai-compatible"),
    ("kimi-code-plan-global", "@ai-sdk/openai-compatible"),
    ("kimi-code-plan-cn", "@ai-sdk/openai-compatible"),
];

fn snapshot(id: &str, package: &str) -> models_dev::Snapshot {
    models_dev::normalize(
        &parse_json(
            &serde_json::json!({id: {
                "id": id, "name": id, "env": [], "npm": package,
                "api": "https://fixture.example/v1", "models": {"code": {
                    "id": "code", "name": "Code", "release_date": "2026-01-01",
                    "attachment": false, "reasoning": false, "tool_call": true,
                    "limit": {"context": 10000, "output": 1000}
                }}
            }})
            .to_string(),
        )
        .unwrap(),
    )
    .unwrap()
    .remove(0)
}

#[test]
fn kept_models_dev_providers_resolve_and_prepare_their_wire_family() {
    for (id, package) in KEPT {
        let mut catalog = Catalog::new(vec![snapshot(id, package)]);
        catalog
            .configure(&[parse_json(
                &serde_json::json!({"providers":{(*id):{"settings":{"apiKey":"fixture-key"}}}})
                    .to_string(),
            )
            .unwrap()])
            .unwrap();
        let resolved = model::Resolver::new(catalog)
            .resolve(
                &ycoding_core::ycoding_schema::model::Ref {
                    provider_id: provider::Id((*id).into()),
                    id: "code".into(),
                    profile: None,
                    variant: None,
                },
                &[],
                None,
            )
            .unwrap();
        let native = model::from_catalog_model(&resolved.info, None).unwrap();
        let mut request = ycoding_ai::llm::Request::new(native.clone());
        request
            .messages
            .push(ycoding_ai::llm::Message::user("hello"));
        let prepared = native.route.prepare(&request).unwrap();
        assert_eq!(
            field(&prepared.body, "model"),
            Some(&"code".encode()),
            "{id}"
        );
        let messages = package == &"@ai-sdk/anthropic";
        assert_eq!(
            prepared.url.path(),
            if messages {
                "/v1/messages"
            } else if package == &"@ai-sdk/openai" || *id == "openrouter" {
                "/v1/responses"
            } else {
                "/v1/chat/completions"
            },
            "{id}"
        );
        assert_eq!(
            prepared.headers[if messages {
                "x-api-key"
            } else {
                "authorization"
            }],
            if messages {
                "fixture-key"
            } else {
                "Bearer fixture-key"
            },
            "{id}"
        );
    }
}

#[test]
fn dropped_provider_documents_load_the_rest_and_never_expose_the_provider() {
    for (id, package) in [
        ("google", "@ai-sdk/google"),
        ("xai", "@ai-sdk/xai"),
        ("runpod", "@ycoding-ai/ai/providers/runpod"),
        ("deepseek", "@ai-sdk/openai-compatible"),
        ("github-copilot", "@ai-sdk/github-copilot"),
    ] {
        let document = serde_json::json!({"model":"openai/code", "providers": {
            id:{"package":package,"models":{"code":{}}},
            "local":{"package":"aisdk:@ai-sdk/openai-compatible","settings":{"baseURL":"http://localhost:1234/v1"},"models":{"code":{}}}
        }}).to_string();
        let decoded = config::decode_document(&document, "fixture");
        let info = decoded
            .info
            .unwrap_or_else(|| panic!("{id}: document rejected"));
        assert!(
            decoded.diagnostics.iter().any(|item| item
                .message
                .as_str()
                .is_some_and(|message| message.contains("unsupported"))),
            "{id}: {:?}",
            decoded.diagnostics
        );
        assert!(field(&info, "model").is_some(), "{id}");
        let mut catalog = Catalog::new(vec![snapshot(id, package)]);
        catalog.configure(&[info]).unwrap();
        assert!(catalog.provider(&provider::Id(id.into())).is_none(), "{id}");
        assert!(
            catalog.provider(&provider::Id("local".into())).is_some(),
            "{id}"
        );
    }
}

#[test]
fn user_endpoint_shapes_load_and_prepare_without_credentials() {
    for (id, package, endpoint) in [
        (
            "remote",
            "@ycoding-ai/ai/providers/openai-compatible",
            "https://fixture.example/v1",
        ),
        (
            "local",
            "@ycoding-ai/ai/providers/openai-compatible",
            "http://localhost:1234/v1",
        ),
        ("anthropic", "@ai-sdk/anthropic", "http://localhost:1234/v1"),
        (
            "messages",
            "@ycoding-ai/ai/providers/anthropic-compatible",
            "https://fixture.example/v1",
        ),
        (
            "lmstudio",
            "aisdk:@ai-sdk/openai-compatible",
            "http://localhost:1234/v1",
        ),
    ] {
        let decoded = config::decode_document(&serde_json::json!({"providers":{id:{"package":package,"settings":{"baseURL":endpoint},"models":{"code":{}}}}}).to_string(), "fixture");
        assert!(
            decoded.diagnostics.is_empty(),
            "{id}: {:?}",
            decoded.diagnostics
        );
        let mut catalog = Catalog::default();
        catalog.configure(&[decoded.info.unwrap()]).unwrap();
        let native = model::from_catalog_model(
            &ycoding_core::resources::catalog::project(
                &catalog.providers[0].models[0],
                &catalog.providers[0].provider,
            ),
            None,
        )
        .unwrap();
        let prepared = native
            .route
            .prepare(&ycoding_ai::llm::Request::new(native.clone()))
            .unwrap();
        assert!(prepared.url.as_str().starts_with(endpoint), "{id}");
        assert!(!prepared.headers.contains_key("authorization"), "{id}");
        assert!(!prepared.headers.contains_key("x-api-key"), "{id}");
    }
}

#[test]
fn anthropic_base_url_only_overlay_preserves_the_native_messages_route() {
    let decoded = config::decode_document(
        r#"{"providers":{"anthropic":{"settings":{"baseURL":"http://localhost:1234/v1"}}}}"#,
        "fixture",
    );
    assert!(decoded.diagnostics.is_empty());
    let mut catalog = Catalog::new(vec![snapshot("anthropic", "@ai-sdk/anthropic")]);
    catalog.configure(&[decoded.info.unwrap()]).unwrap();
    let native = model::from_catalog_model(
        &ycoding_core::resources::catalog::project(
            &catalog.providers[0].models[0],
            &catalog.providers[0].provider,
        ),
        None,
    )
    .unwrap();
    let prepared = native
        .route
        .prepare(&ycoding_ai::llm::Request::new(native.clone()))
        .unwrap();
    assert_eq!(prepared.url.as_str(), "http://localhost:1234/v1/messages");
    assert!(!prepared.headers.contains_key("x-api-key"));
}

#[test]
fn dropped_model_package_is_diagnosed_without_discarding_its_kept_sibling() {
    let decoded = config::decode_document(
        r#"{"default_agent":"god","providers":{"openai":{"models":{"code":{},"dropped":{"package":"aisdk:@ai-sdk/google"}}}}}"#,
        "fixture",
    );
    assert_eq!(decoded.diagnostics.len(), 1);
    assert!(
        decoded.diagnostics[0]
            .message
            .as_str()
            .unwrap()
            .contains("unsupported")
    );
    let mut catalog = Catalog::new(vec![snapshot("openai", "@ai-sdk/openai")]);
    catalog.configure(&[decoded.info.unwrap()]).unwrap();
    assert!(
        catalog
            .get(&provider::Id("openai".into()), &"code".into(), None, &[])
            .is_some()
    );
    assert!(
        catalog
            .get(&provider::Id("openai".into()), &"dropped".into(), None, &[])
            .is_none()
    );
}

#[test]
fn catalog_is_closed_to_the_kept_set_and_normalization_does_not_inject_deepseek() {
    let catalog = Catalog::new(
        KEPT.iter()
            .map(|(id, package)| snapshot(id, package))
            .chain([
                snapshot("unlisted", "@ai-sdk/openai-compatible"),
                snapshot("deepseek", "@ai-sdk/openai-compatible"),
            ])
            .collect(),
    );
    assert_eq!(
        catalog
            .providers
            .iter()
            .map(|record| record.provider.id.0.as_str().unwrap())
            .collect::<Vec<_>>(),
        KEPT.iter().map(|(id, _)| *id).collect::<Vec<_>>()
    );
    let snapshots = models_dev::normalize(&parse_json(r#"{"openai":{"id":"openai","name":"OpenAI","env":[],"npm":"@ai-sdk/openai","models":{}},"anthropic":{"id":"anthropic","name":"Anthropic","env":[],"npm":"@ai-sdk/anthropic","models":{}}}"#).unwrap()).unwrap();
    assert_eq!(
        snapshots
            .iter()
            .map(|snapshot| snapshot.info.id.0.as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["openai", "anthropic"]
    );
}

#[test]
fn bundled_catalog_packages_match_the_kept_set_and_every_dropped_document_recovers() {
    let source = parse_json(include_str!(
        "../../../../packages/cli/script/models-dev.snapshot.json"
    ))
    .unwrap();
    let snapshots = models_dev::normalize(&source).unwrap();
    let catalog = Catalog::new(snapshots);
    let mut actual = catalog
        .providers
        .iter()
        .map(|record| record.provider.id.0.as_str().unwrap())
        .collect::<Vec<_>>();
    actual.sort();
    let mut expected = KEPT.iter().map(|(id, _)| *id).collect::<Vec<_>>();
    expected.sort();
    assert_eq!(actual, expected);
    for (id, package) in KEPT {
        assert_eq!(
            model::family(
                &catalog
                    .provider(&provider::Id((*id).into()))
                    .unwrap()
                    .package
            )
            .unwrap(),
            model::family(&(*package).into()).unwrap(),
            "{id}"
        );
    }
    let JsonValue::Object(providers) = source else {
        panic!("expected catalog");
    };
    for (id, item) in providers.iter().filter(|(id, _)| {
        !KEPT.iter().any(|(kept, _)| id.as_str() == Some(*kept)) && id.as_str() != Some("lmstudio")
    }) {
        let Some(JsonValue::String(package)) = field(item, "npm") else {
            panic!("expected package");
        };
        let document = serde_json::json!({"default_agent":"god","providers":{(id.as_str().unwrap()):{"package":package.as_str().unwrap()}}}).to_string();
        let decoded = config::decode_document(&document, "fixture");
        assert!(decoded.info.is_some(), "{id:?}: {:?}", decoded.diagnostics);
        assert_eq!(decoded.diagnostics.len(), 1, "{id:?}");
        assert!(
            decoded.diagnostics[0]
                .message
                .as_str()
                .unwrap()
                .contains("unsupported"),
            "{id:?}"
        );
    }
}

fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    let JsonValue::Object(fields) = value else {
        return None;
    };
    fields.get(&key.into())
}
