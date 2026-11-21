use ycoding_ai::{
    effort::{self, Provider},
    llm::{Message, Request},
    route::{Endpoint, Route},
};
use ycoding_schema::{parse_json, stringify_json};

fn update(provider: &str, key: &str, value: &str) -> Message {
    let mut message = Message::new(ycoding_ai::llm::Role::System, vec![]);
    message.native =
        Some(parse_json(&format!(r#"{{"{provider}":{{"{key}":"{value}"}}}}"#)).unwrap());
    message
}

#[test]
fn public_gpt6_replays_configuration_changes_without_provider_compaction() {
    let route = Route::openai_responses();
    let mut request = Request::new(route.model("gpt-6-sol"));
    request.provider_options = Some(parse_json(r#"{"openai":{"reasoningEffort":"low"}}"#).unwrap());
    request.messages = vec![
        Message::user("first"),
        update("openai", "reasoningEffort", "high"),
        Message::user("second"),
    ];
    let body = stringify_json(&route.prepare(&request).unwrap().body);
    assert!(body.contains(r#""type":"configuration_update","reasoning":{"effort":"high"}"#));
    assert!(body.contains(r#""reasoning":{"effort":"low""#));
    assert!(!body.contains("context_management"));
    request
        .messages
        .insert(2, update("openai", "reasoningEffort", "medium"));
    assert!(route.prepare(&request).is_err());
}

#[test]
fn unsafe_models_endpoints_modes_and_raw_overrides_do_not_accept_updates() {
    let mut route = Route::openai_responses();
    for endpoint in [
        "https://api.openai.com/v1?extra=1",
        "https://user@api.openai.com/v1",
        "https://api.openai.com/v1//",
        "https://proxy.example/v1",
    ] {
        route.endpoint = Endpoint::new(endpoint, "/responses");
        assert_eq!(
            effort::mechanism(&Request::new(route.model("gpt-6-sol"))),
            None
        );
    }
    let route = Route::openai_responses();
    for model in ["gpt-5.6", "gpt-6-astra-pro", "gpt-6-sol-20261001"] {
        assert_eq!(effort::mechanism(&Request::new(route.model(model))), None);
    }
    for options in [
        r#"{"openai":{"reasoningMode":"heavy"}}"#,
        r#"{"openai":{"contextManagement":[{"type":"compaction"}]}}"#,
    ] {
        let mut request = Request::new(route.model("gpt-6-sol"));
        request.provider_options = Some(parse_json(options).unwrap());
        assert_eq!(effort::mechanism(&request), None);
    }
    for body in [
        r#"{"reasoning":{"effort":"low"}}"#,
        r#"{"multi_agent":{"enabled":true}}"#,
        r#"{"truncation":"auto"}"#,
        r#"{"context_management":[{"type":"compaction"}]}"#,
    ] {
        let mut request = Request::new(route.model("gpt-6-sol"));
        request.http.body = Some(parse_json(body).unwrap());
        assert_eq!(effort::mechanism(&request), None);
    }
    let mut request = Request::new(route.model("gpt-5.6"));
    request.messages = vec![update("openai", "reasoningEffort", "high")];
    assert!(route.prepare(&request).is_err());
    request.messages.clear();
    assert!(stringify_json(&route.prepare(&request).unwrap().body).contains("context_management"));
}

#[test]
fn anthropic_updates_merge_beta_and_preserve_user_boundaries() {
    let route = Route::anthropic();
    let mut request = Request::new(route.model("claude-opus-5-5"));
    request
        .http
        .headers
        .insert("AnThRoPiC-BeTa".into(), "existing-beta".into());
    request.messages = vec![
        Message::user("first"),
        update("anthropic", "effort", "high"),
        Message::user("second"),
    ];
    let prepared = route.prepare(&request).unwrap();
    let body = stringify_json(&prepared.body);
    assert!(body.contains(r#""role":"system","content":[],"output_config":{"effort":"high"}"#));
    let headers = prepared
        .headers
        .get("anthropic-beta")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(headers.contains("existing-beta"));
    assert!(headers.contains(effort::ANTHROPIC_BETA));
    request.provider_options = Some(
        parse_json(r#"{"anthropic":{"thinking":{"type":"enabled","budgetTokens":1024}}}"#).unwrap(),
    );
    assert_eq!(effort::mechanism(&request), None);
    assert!(route.prepare(&request).is_err());
}

#[test]
fn openrouter_native_and_compatible_directives_keep_null_baselines_off_the_wire() {
    let model = ycoding_ai::providers::openrouter(
        "openai/gpt-6-sol",
        ycoding_ai::providers::OpenRouterConfig {
            common: ycoding_ai::providers::Config::new(ycoding_ai::auth::Auth::None),
            reasoning: None,
        },
    );
    let mut request = Request::new(model);
    request.provider_options = Some(
        parse_json(
            r#"{"openrouter":{"reasoning":{"effort":null}},"openai":{"reasoningEffort":null}}"#,
        )
        .unwrap(),
    );
    request.messages = vec![
        Message::user("first"),
        update("openrouter", "effort", "high"),
        Message::user("second"),
    ];
    let body = stringify_json(&request.model.route.prepare(&request).unwrap().body);
    assert!(body.contains("configuration_update"));
    assert!(!body.contains(r#""effort":null"#));
    let mut route = Route::openai_chat();
    route.id = "openai-compatible-chat".into();
    route.endpoint = Endpoint::new("https://openrouter.ai/api/v1", "/chat/completions");
    let mut request = Request::new(route.model("anthropic/claude-opus-5"));
    assert_eq!(effort::mechanism(&request), Some(Provider::OpenAI));
    request.messages = vec![
        Message::user("first"),
        update("openai", "reasoningEffort", "high"),
        Message::user("second"),
    ];
    assert!(
        stringify_json(&route.prepare(&request).unwrap().body)
            .contains(r#""configuration_update":{"reasoning":{"effort":"high"}}"#)
    );
}

#[test]
fn subscription_and_external_process_routes_keep_top_level_effort() {
    use ycoding_ai::route::{AttemptFuture, ProcessAttempt, ProcessInput, Transport};
    struct External;
    impl ProcessAttempt for External {
        fn attempt(&self, _: ProcessInput) -> AttemptFuture<'_> {
            Box::pin(async { panic!("eligibility must not dispatch a provider request") })
        }
    }
    let mut route = Route::openai_responses();
    route.transport = Transport::Process(std::sync::Arc::new(External));
    assert_eq!(
        effort::mechanism(&Request::new(route.model("gpt-6-sol"))),
        None
    );
    for id in [
        ycoding_ai::openai_codex::ROUTE_ID,
        ycoding_ai::openai_codex::WEBSOCKET_ROUTE_ID,
        "claude-code-messages",
    ] {
        let mut route = Route::openai_responses();
        route.id = id.into();
        assert_eq!(
            effort::mechanism(&Request::new(route.model("gpt-6-sol"))),
            None
        );
    }
}
