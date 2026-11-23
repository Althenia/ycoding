use ycoding_ai::llm::{Message, Request};
use ycoding_core::resources::{
    catalog::models_dev,
    model::{Error, ProviderContext, from_catalog_model, with_variant},
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, credential, integration_id::IntegrationMethodId,
    parse_json, provider, schema::NonNegativeInt, stringify_json,
};

fn info(settings: &str, variants: &[(&str, &str)]) -> ycoding_schema::model::Info {
    let mut model = models_dev::normalize(
        &parse_json(include_str!(
            "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
        ))
        .unwrap(),
    )
    .unwrap()[0]
        .models[0]
        .clone();
    model.id = "gemini-3.8-flash".into();
    model.model_id = "gemini-3.8-flash-medium".into();
    model.provider_id = provider::Id("antigravity".into());
    model.package = Some("aisdk:@ai-sdk/google".into());
    model.settings =
        Some(ycoding_schema::provider::Settings::decode(&parse_json(settings).unwrap()).unwrap());
    model.variants = variants
        .iter()
        .map(|(id, settings)| {
            ycoding_schema::model::Variant::decode(
                &parse_json(&format!(r#"{{"id":"{id}","settings":{settings}}}"#)).unwrap(),
            )
            .unwrap()
        })
        .collect();
    model
}
fn oauth(project: Option<&str>) -> credential::Value {
    credential::Value::OAuth(credential::OAuth {
        method_id: IntegrationMethodId::new("google").unwrap(),
        access: "google-access".into(),
        refresh: "google-refresh".into(),
        expires: NonNegativeInt::new(0).unwrap(),
        metadata: project.map(|project| {
            let mut metadata = ycoding_schema::JsonObject::new();
            metadata.insert("projectID".into(), JsonValue::String(project.into()));
            metadata
        }),
    })
}
fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(fields) => fields.get(&key.into()),
        _ => None,
    }
}

#[test]
fn catalog_model_resolves_to_antigravity_gateway_route() {
    let model = from_catalog_model(
        &info(
            r#"{"thinkingConfig":{"includeThoughts":true,"thinkingLevel":"medium"}}"#,
            &[],
        ),
        Some(&oauth(Some("project-9"))),
    )
    .unwrap();
    assert_eq!(model.route.id, "ai-sdk:@ai-sdk/google");
    assert_eq!(model.provider.0.as_str(), Some("antigravity"));
    assert_eq!(model.route.provider_metadata_key.as_deref(), Some("google"));
    let mut request = Request::new(model.clone());
    request.messages.push(Message::user("Hi"));
    request
        .http
        .headers
        .insert("x-session-affinity".into(), "ses-a".into());
    let prepared = model.route.prepare(&request).unwrap();
    assert_eq!(
        prepared.url.as_str(),
        "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
    );
    assert_eq!(prepared.headers["authorization"], "Bearer google-access");
    assert!(
        prepared.headers["user-agent"]
            .to_str()
            .unwrap()
            .starts_with("antigravity/hub/2.28.2 ")
    );
    assert_eq!(prepared.headers.len(), 3);
    assert_eq!(
        field(&prepared.wire_body, "project").cloned(),
        Some(JsonValue::String("project-9".into()))
    );
    assert_eq!(
        field(&prepared.wire_body, "model").cloned(),
        Some(JsonValue::String("gemini-3.8-flash-medium".into()))
    );
    let inner = field(&prepared.wire_body, "request").unwrap();
    assert_eq!(
        field(inner, "sessionId").cloned(),
        Some(JsonValue::String("4903109517633975494".into()))
    );
}

#[test]
fn variant_gateway_model_reaches_envelope_without_leaking_the_setting() {
    let info = info(
        r#"{"thinkingConfig":{"includeThoughts":true,"thinkingLevel":"medium"}}"#,
        &[(
            "high",
            r#"{"thinkingConfig":{"includeThoughts":true,"thinkingLevel":"high"},"antigravityModelID":"gemini-3.8-flash-high"}"#,
        )],
    );
    let info = with_variant(info, Some(&"high".into())).unwrap();
    let model = from_catalog_model(&info, Some(&oauth(None))).unwrap();
    let mut request = Request::new(model.clone());
    request.messages.push(Message::user("Hi"));
    request
        .http
        .headers
        .insert("x-session-affinity".into(), "ses-a".into());
    let prepared = model.route.prepare(&request).unwrap();
    assert_eq!(
        field(&prepared.wire_body, "model").cloned(),
        Some(JsonValue::String("gemini-3.8-flash-high".into()))
    );
    assert!(field(&prepared.wire_body, "project").is_none());
    assert!(!stringify_json(&prepared.wire_body).contains("antigravityModelID"));
    let inner = field(&prepared.wire_body, "request").unwrap();
    assert_eq!(
        field(inner, "sessionId").cloned(),
        Some(JsonValue::String(
            ycoding_ai::antigravity::session_id("ses-a", "gemini-3.8-flash-high").into()
        ))
    );
    assert!(
        stringify_json(&info.settings.as_ref().map(|s| s.encode()).unwrap())
            .contains("antigravityModelID")
    );
}

#[tokio::test]
async fn selected_antigravity_model_uses_the_oauth_gateway() {
    let info = with_variant(
        info(
            r#"{"thinkingConfig":{"includeThoughts":true,"thinkingLevel":"medium"}}"#,
            &[(
                "high",
                r#"{"thinkingConfig":{"includeThoughts":true,"thinkingLevel":"high"},"antigravityModelID":"gemini-3.8-flash-high"}"#,
            )],
        ),
        Some(&"high".into()),
    )
    .unwrap();
    let context = ProviderContext::new(Default::default(), "fixture").unwrap();
    let model = context
        .selected_model(
            &info,
            Some(&oauth(Some("project-9"))),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    let mut request = Request::new(model.clone());
    request.messages.push(Message::user("Hi"));
    let prepared = model.route.prepare(&request).unwrap();
    assert_eq!(
        prepared.url.as_str(),
        "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
    );
    assert_eq!(prepared.headers["authorization"], "Bearer google-access");
    assert!(!prepared.headers.contains_key("x-goog-api-key"));
    assert_eq!(
        field(&prepared.wire_body, "project"),
        Some(&JsonValue::String("project-9".into()))
    );
    assert_eq!(
        field(&prepared.wire_body, "model"),
        Some(&JsonValue::String("gemini-3.8-flash-high".into()))
    );
    assert!(!stringify_json(&prepared.wire_body).contains("antigravityModelID"));
}

#[test]
fn antigravity_requires_an_oauth_credential_and_the_google_package() {
    assert!(matches!(
        from_catalog_model(&info("{}", &[]), None),
        Err(Error::ProfileUnavailable)
    ));
    assert!(matches!(
        from_catalog_model(
            &info("{}", &[]),
            Some(&credential::Value::Key(credential::Key {
                key: "fixture".into(),
                metadata: None,
            })),
        ),
        Err(Error::ProfileUnavailable)
    ));
    let mut wrong = info("{}", &[]);
    wrong.package = Some("aisdk:@ai-sdk/openai".into());
    assert!(matches!(
        from_catalog_model(&wrong, Some(&oauth(None))),
        Err(Error::UnsupportedPackage)
    ));
}
