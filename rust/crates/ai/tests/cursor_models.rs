use std::sync::Arc;
use ycoding_ai::cursor::models;
use ycoding_ai::{
    auth::{Auth, Credential},
    cursor::{headers, provider},
    llm::Request,
    provider_error::Reason,
};

fn request(options: &str) -> Request {
    let runtime = Arc::new(provider::Runtime::new(Default::default()).unwrap());
    let config = provider::Config::new(
        Auth::bearer(Credential::value("fixture-token")),
        headers::Identity {
            machine_id: "machine".into(),
            mac_machine_id: None,
            client_version: "cli-fixture".into(),
        },
        provider::RequestContext::new(vec![34, 0]).unwrap(),
        runtime,
    );
    let mut request = Request::new(provider::model("composer-fixture", config).unwrap());
    request.provider_options = Some(ycoding_schema::parse_json(options).unwrap());
    request
}

#[test]
fn cursor_selected_variant_is_validated_before_any_provider_io() {
    for options in [
        r#"{"cursor":{"cursorVariantParameters":{}}}"#,
        r#"{"cursor":{"cursorVariantParameters":[{"id":" ","value":"high"}]}}"#,
        r#"{"cursor":{"cursorVariantParameters":[{"id":"effort","value":"high"}]}}"#,
    ] {
        let request = request(options);
        let error = request
            .model
            .route
            .prepare(&request)
            .expect_err("invalid or stale variants must fail locally");
        assert_eq!(error.reason, Reason::InvalidRequest);
    }
}

#[test]
fn cursor_dedicated_wire_model_id_preserves_the_ui_model_identity() {
    let request = request(
        r#"{"cursor":{"cursorModelId":"real-model","reasoningEffort":"high","maxMode":true}}"#,
    );
    let prepared = request.model.route.prepare(&request).unwrap();
    assert_eq!(request.model.id.as_str(), Some("composer-fixture"));
    assert!(ycoding_schema::stringify_json(&prepared.body).contains("\"model\":\"real-model\""));
}

#[test]
fn cursor_catalog_variants_keep_base_max_image_absence_and_exact_fast_tuples() {
    let raw = ycoding_schema::parse_json(r#"{"models":[null,{"name":" "},{"name":"real-model","client_display_name":"Real","supports_thinking":true,"supports_agent":true,"supports_max_mode":true,"variants":[{"parameter_values":[{"id":"context","value":"1m"},{"id":"effort","value":"high"}],"is_default_max_config":true},{"parameterValues":[{"id":"context","value":"300k"},{"id":"effort","value":"low"}],"isDefaultNonMaxConfig":true},{"parameterValues":[{"id":"context","value":"300k"},{"id":"effort","value":"high"},{"id":"fast","value":"true"}]}]}]}"#).unwrap();
    let catalog = models::available_models(&raw).unwrap();
    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0].display_name, "Real".into());
    assert_eq!(catalog[0].max_context, Some(300_000.0));
    assert_eq!(catalog[0].max_context_max_mode, Some(1_000_000.0));
    assert_eq!(catalog[0].supports_images, None);
    assert!(
        catalog[0].supports_thinking && catalog[0].supports_agent && catalog[0].supports_max_mode
    );
    for (options, expected, max_mode) in [
        (r#"{}"#, vec![("context", "300k"), ("effort", "low")], false),
        (
            r#"{"maxMode":true,"reasoningEffort":"high"}"#,
            vec![("context", "1m"), ("effort", "high")],
            true,
        ),
        (
            r#"{"maxMode":true,"reasoningEffort":"low","cursorVariantParameters":[{"id":"fast","value":"true"},{"id":"effort","value":"high"},{"id":"context","value":"300k"}]}"#,
            vec![("context", "300k"), ("effort", "high"), ("fast", "true")],
            false,
        ),
    ] {
        let options = ycoding_schema::parse_json(options).unwrap();
        let selected = models::selection(&"real-model".into(), Some(&options), &catalog).unwrap();
        assert_eq!(
            selected.parameters,
            expected
                .into_iter()
                .map(|(id, value)| (id.into(), value.into()))
                .collect::<Vec<_>>()
        );
        assert_eq!(selected.max_mode, max_mode);
    }
    for options in [
        r#"{"cursorVariantParameters":[{"id":"effort","value":"high"}]}"#,
        r#"{"cursorVariantParameters":[{"id":"effort","value":"low"},{"id":"effort","value":"low"}]}"#,
    ] {
        let options = ycoding_schema::parse_json(options).unwrap();
        assert_eq!(
            models::selection(&"real-model".into(), Some(&options), &catalog)
                .unwrap_err()
                .reason,
            Reason::InvalidRequest
        );
    }
}

#[test]
fn cursor_context_tiers_and_catalog_failures_match_typescript_boundaries() {
    for (value, expected) in [
        ("1M", Some(1_000_000.0)),
        ("1.5 k", Some(1500.0)),
        ("0x100", Some(256.0)),
        ("0", None),
        ("-1", None),
        ("1.5", None),
        ("1.5m", Some(1_500_000.0)),
        ("9007199254740992", None),
    ] {
        assert_eq!(models::context_limit(&value.into()), expected);
    }
    for raw in [
        r#"{"models":[{"name":"x","supportsImages":"yes"}]}"#,
        r#"{"models":[{"name":"x","supportsThinking":"yes"}]}"#,
        r#"{"models":[{"name":"x","variants":{}}]}"#,
        r#"{"models":[{"name":"x","variants":[{"parameterValues":[{"id":"effort","value":1}]}]}]}"#,
    ] {
        assert_eq!(
            models::available_models(&ycoding_schema::parse_json(raw).unwrap())
                .unwrap_err()
                .reason,
            Reason::InvalidProviderOutput
        );
    }
    let options = ycoding_schema::parse_json(
        r#"{"reasoningEffort":"high","maxMode":true,"unrelated":"never a parameter"}"#,
    )
    .unwrap();
    let selected = models::selection(&"unknown".into(), Some(&options), &[]).unwrap();
    assert_eq!(selected.parameters, vec![("effort".into(), "high".into())]);
    assert!(selected.max_mode);
}

#[test]
fn cursor_catalog_nullish_aliases_use_the_next_authoritative_value() {
    let raw = ycoding_schema::parse_json(r#"{"models":[{"name":"x","clientDisplayName":null,"client_display_name":"X","contextTokenLimit":null,"context_token_limit":100,"variants":[{"parameterValues":null,"parameter_values":[{"id":"effort","value":"low"}]}]}]}"#).unwrap();
    let models = models::available_models(&raw).unwrap();
    assert_eq!(models[0].display_name, "X".into());
    assert_eq!(models[0].max_context, Some(100.0));
    assert_eq!(
        models[0].variants[0].parameters,
        vec![("effort".into(), "low".into())]
    );
}
