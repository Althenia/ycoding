use std::sync::Arc;
use ycoding_ai::{
    auth::Input,
    cache::Hint,
    cursor::{
        headers::Identity,
        models::{Info, Variant},
        provider::{RequestContext, Runtime},
        transport::Options,
    },
    llm::{Model, TextPart},
    route::Route,
};
use ycoding_core::resources::{
    cursor::{
        models::from_cursor,
        route::{Host, model},
        system::{INSTRUCTION, system},
    },
    model::{Error, with_variant},
};
use ycoding_schema::{JsonValue, credential, model as schema_model, parse_json};

fn host() -> Host {
    Host {
        identity: Identity {
            machine_id: "machine".into(),
            mac_machine_id: None,
            client_version: "1.0.0".into(),
        },
        context: RequestContext::new(vec![0x22, 0x00]).unwrap(),
        runtime: Arc::new(Runtime::new(Options::default()).unwrap()),
        known_mcp_servers: vec![],
        extensions: Default::default(),
    }
}

fn variant(key: &str, display: &str, parameters: &[(&str, &str)], max: bool) -> Variant {
    Variant {
        key: key.into(),
        display_name: display.into(),
        parameters: parameters
            .iter()
            .map(|(id, value)| ((*id).into(), (*value).into()))
            .collect(),
        default_non_max: !max,
        default_max: max,
    }
}

fn info(id: &str, display: &str, variants: Vec<Variant>) -> Info {
    Info {
        id: id.into(),
        display_name: display.into(),
        supports_thinking: false,
        supports_agent: true,
        supports_images: None,
        max_context: None,
        max_context_max_mode: None,
        supports_max_mode: false,
        variants,
    }
}

fn opus() -> Vec<schema_model::Info> {
    from_cursor(&[info(
        "claude-opus-4-8",
        "Opus 4.8",
        vec![
            variant("high", "Opus 4.8 High", &[("effort", "high")], false),
            variant(
                "high-fast",
                "Opus 4.8 High Fast",
                &[("effort", "high"), ("fast", "true")],
                false,
            ),
            variant("1m", "Opus 4.8 1M", &[("context", "1m")], true),
        ],
    )])
}

fn oauth() -> credential::Value {
    credential::Value::OAuth(credential::OAuth {
        method_id: ycoding_schema::integration_id::IntegrationMethodId::new("browser").unwrap(),
        access: "access-jwt".into(),
        refresh: "refresh-token".into(),
        expires: ycoding_schema::schema::NonNegativeInt::new(0).unwrap(),
        metadata: None,
    })
}

fn key(value: &str) -> credential::Value {
    credential::Value::Key(credential::Key {
        key: value.into(),
        metadata: None,
    })
}

fn bearer(model: &Model) -> String {
    let headers = model
        .route
        .auth
        .apply(Input {
            method: "POST",
            url: "https://api2.cursor.sh",
            body: "",
            headers: Default::default(),
        })
        .unwrap();
    headers["authorization"].to_str().unwrap().to_owned()
}

fn options(model: &Model) -> Option<JsonValue> {
    model.route.defaults.provider_options.clone()
}

fn selected(
    info: &schema_model::Info,
    variant: Option<&str>,
    credential: &credential::Value,
) -> Model {
    let info = with_variant(info.clone(), variant.map(Into::into).as_ref()).unwrap();
    model(&info, Some(credential), &host()).unwrap()
}

fn tuple_options(parameters: &[(&str, &str)]) -> JsonValue {
    parse_json(&format!(
        r#"{{"cursor":{{"cursorVariantParameters":[{}]}}}}"#,
        parameters
            .iter()
            .map(|(id, value)| format!(r#"{{"id":"{id}","value":"{value}"}}"#))
            .collect::<Vec<_>>()
            .join(",")
    ))
    .unwrap()
}

#[test]
fn selected_variant_tuple_and_credential_reach_the_cursor_route() {
    let models = opus();
    let routed = selected(&models[1], Some("high"), &oauth());
    assert_eq!(routed.id.as_str(), Some("claude-opus-4-8"));
    assert_eq!(bearer(&routed), "Bearer access-jwt");
    assert_eq!(
        options(&routed),
        Some(tuple_options(&[("effort", "high"), ("fast", "true")]))
    );
    assert_eq!(routed.route.id, "cursor-connect");
}

#[test]
fn base_model_without_variant_has_no_cursor_parameters() {
    let models = opus();
    let routed = selected(&models[0], None, &key("crsr_key"));
    assert_eq!(bearer(&routed), "Bearer crsr_key");
    assert_eq!(options(&routed), None);
}

#[test]
fn single_non_effort_tuple_is_the_base_model_setting() {
    let composer = from_cursor(&[info(
        "composer-2.5",
        "composer-2.5",
        vec![variant(
            "standard",
            "Composer 2.5",
            &[("fast", "false")],
            false,
        )],
    )]);
    assert!(composer[0].variants.is_empty());
    let routed = selected(&composer[0], None, &oauth());
    assert_eq!(routed.id.as_str(), Some("composer-2.5"));
    assert_eq!(options(&routed), Some(tuple_options(&[("fast", "false")])));
}

#[test]
fn long_context_entry_uses_real_model_id_default_tuple_and_128k_output() {
    let models = opus();
    assert_eq!(models[2].id.as_str(), Some("claude-opus-4-8-1m"));
    let routed = selected(&models[2], None, &oauth());
    assert_eq!(routed.id.as_str(), Some("claude-opus-4-8"));
    assert_eq!(options(&routed), Some(tuple_options(&[("context", "1m")])));
    assert_eq!(routed.route.defaults.output_limit, Some(128_000.0));
}

#[test]
fn five_hundred_k_entry_sends_selected_effort_with_complete_context_tuple() {
    let mut grok = info(
        "grok-4.7",
        "Grok 4.7",
        vec![
            variant(
                "high",
                "Grok 4.7 High",
                &[("effort", "high"), ("context", "256k")],
                false,
            ),
            variant(
                "xhigh-500k",
                "Grok 4.7 Extra High 500k",
                &[("effort", "xhigh"), ("context", "500k")],
                true,
            ),
        ],
    );
    grok.max_context = Some(256_000.0);
    let models = from_cursor(&[grok]);
    let long = models
        .iter()
        .find(|model| model.id.as_str() == Some("grok-4.7-500k"))
        .unwrap();
    let routed = selected(long, Some("xhigh"), &oauth());
    assert_eq!(routed.id.as_str(), Some("grok-4.7"));
    assert_eq!(
        options(&routed),
        Some(tuple_options(&[("effort", "xhigh"), ("context", "500k")]))
    );
    assert_eq!(long.limit.context.get(), 500_000);
}

#[test]
fn unadvertised_variant_ids_are_rejected() {
    let models = opus();
    assert_eq!(
        with_variant(models[2].clone(), Some(&"Opus 4.8 High".into())).unwrap_err(),
        Error::VariantUnavailable
    );
    assert_eq!(
        with_variant(models[0].clone(), Some(&"Opus 4.8 High".into())).unwrap_err(),
        Error::VariantUnavailable
    );
}

#[test]
fn only_the_cursor_package_is_routed() {
    let mut other = opus().remove(0);
    other.package = Some("aisdk:@ai-sdk/groq".into());
    assert_eq!(
        model(&other, Some(&key("k")), &host()).err(),
        Some(Error::UnsupportedPackage)
    );
}

fn parts() -> Vec<TextPart> {
    vec![
        TextPart {
            cache: Some(Hint::ephemeral(Some(300.0))),
            ..TextPart::from("Stable agent instructions")
        },
        TextPart::from("Repository instructions"),
    ]
}

#[test]
fn identity_is_appended_once_after_the_stable_system_parts() {
    let models = opus();
    let routed = selected(&models[0], None, &key("crsr_key"));
    let original = parts();
    let assembled = system(&routed, &original);
    assert_eq!(assembled.len(), 3);
    assert_eq!(assembled[..2], original[..]);
    assert_eq!(assembled[0].cache, Some(Hint::ephemeral(Some(300.0))));
    assert_eq!(assembled[2].text.as_str(), Some(INSTRUCTION));
    assert_eq!(
        INSTRUCTION
            .matches("You are an AI agent, not Cursor.")
            .count(),
        1
    );
    for expected in [
        "Do not claim to be Cursor",
        "Follow user instructions strictly",
        "subject to higher-priority instructions, permissions, and guardrails",
        "when the user's task requires it and the action is authorized",
        "Do not perform unrelated availability probes",
        "A permission denial is not evidence that a capability is unavailable",
        "Never invent tool or MCP capabilities",
    ] {
        assert!(INSTRUCTION.contains(expected), "{expected}");
    }
    assert_eq!(system(&routed, &assembled[..2]), assembled);
}

#[test]
fn identity_is_supplied_without_existing_system_or_cursor_provider_label() {
    let mut custom = opus().remove(0);
    custom.provider_id = ycoding_schema::provider::Id("custom-cursor".into());
    let routed = selected(&custom, None, &key("crsr_key"));
    assert_eq!(routed.provider.0.as_str(), Some("custom-cursor"));
    let assembled = system(&routed, &[]);
    assert_eq!(assembled.len(), 1);
    assert_eq!(assembled[0].text.as_str(), Some(INSTRUCTION));
    let blank = system(&routed, &[TextPart::from("")]);
    assert_eq!(blank, assembled);
}

#[test]
fn identity_is_not_added_to_another_route_named_cursor() {
    let mut other = Route::openai_chat().model("claude-opus-4-8");
    other.provider = ycoding_schema::provider::Id("cursor".into());
    let original = parts();
    assert_eq!(system(&other, &original), original);
}
