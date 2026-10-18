use ycoding_core::session::prompt_cache::{self, Namespace};
use ycoding_schema::{DomainDecode, JsonValue, parse_json};

#[test]
fn selected_context_markers_only_use_public_supported_responses_routes() {
    use prompt_cache::{OpenAIMode, shared_context_marker_support};
    assert!(shared_context_marker_support(
        &"openai".into(),
        "openai-responses",
        "gpt-6-sol",
        OpenAIMode::Auto,
        "https://api.openai.com/v1"
    ));
    for (provider, route, model, mode, endpoint) in [
        (
            "openai",
            "openai-responses",
            "gpt-5.5",
            OpenAIMode::Auto,
            "https://api.openai.com/v1",
        ),
        (
            "openai",
            "openai-responses-websocket",
            "gpt-6-sol",
            OpenAIMode::Auto,
            "https://api.openai.com/v1",
        ),
        (
            "openai",
            "openai-responses",
            "gpt-6-sol",
            OpenAIMode::Implicit,
            "https://api.openai.com/v1",
        ),
        (
            "openai",
            "openai-responses",
            "gpt-6-sol",
            OpenAIMode::Auto,
            "https://proxy.example/v1",
        ),
        (
            "openai",
            "openai-responses",
            "gpt-6-sol",
            OpenAIMode::Auto,
            "https://api.openai.com/v1?extra=1",
        ),
        (
            "openai",
            "openai-responses",
            "gpt-6-sol",
            OpenAIMode::Auto,
            "https://user@api.openai.com/v1",
        ),
        (
            "subscription",
            "openai-responses",
            "gpt-6-sol",
            OpenAIMode::Auto,
            "https://api.openai.com/v1",
        ),
    ] {
        assert!(!shared_context_marker_support(
            &provider.into(),
            route,
            model,
            mode,
            endpoint
        ));
    }
    assert!(!prompt_cache::Settings::default().family_experiment);
}

#[test]
fn family_cache_keys_require_complete_identity_and_partition_semantic_authority() {
    let root = "ses_root".into();
    let account = "a".repeat(64);
    let connection = "b".repeat(64);
    let semantic = "c".repeat(64);
    let snapshot = "d".repeat(64);
    let mut input = prompt_cache::FamilyExperiment {
        root_session_id: &root,
        baseline_key: "baseline",
        account_identity_digest: &account,
        api_model_id: "gpt-6-sol",
        variant: None,
        route_id: "openai-responses",
        connection_identity_digest: &connection,
        semantic_options_digest: &semantic,
        snapshot_digest: &snapshot,
    };
    let key = prompt_cache::family_experiment_key(&input).unwrap();
    input.snapshot_digest = &semantic;
    assert_ne!(prompt_cache::family_experiment_key(&input).unwrap(), key);
    input.snapshot_digest = &snapshot;
    input.connection_identity_digest = "unknown";
    assert!(prompt_cache::family_experiment_key(&input).is_none());
}

#[test]
fn kept_cache_policies_and_usage_reporting_follow_route_and_model_contracts() {
    let settings = prompt_cache::Settings::default();
    for (route, provider, model, ttl) in [
        (
            "anthropic-messages",
            "anthropic",
            "claude-sonnet-5-5",
            Some(3600.0),
        ),
        (
            "openrouter",
            "openrouter",
            "anthropic/claude-opus-5",
            Some(3600.0),
        ),
        (
            "openrouter-responses",
            "openrouter",
            "anthropic/claude-opus-5",
            Some(3600.0),
        ),
        ("openrouter", "openrouter", "google/gemini-3-pro", None),
        ("openai-compatible-chat", "local", "custom", None),
    ] {
        let options = prompt_cache::provider_options(&prompt_cache::OptionsInput {
            route_id: route,
            api_model_id: model,
            session_id: &"session".into(),
            project_id: &"project".into(),
            provider_id: &provider.into(),
            baseline_key: "stable",
            interactive: true,
            settings: &settings,
        });
        assert_eq!(
            options.cache,
            ttl.map(|ttl| ycoding_ai::cache::Policy::Explicit {
                tools: true,
                system: true,
                messages: Some(ycoding_ai::cache::MessageStrategy::Tail(2)),
                ttl_seconds: Some(ttl),
            })
        );
    }
    for (route, provider, mechanism) in [
        ("anthropic-messages", "anthropic", "anthropic-cache-control"),
        ("openrouter", "openrouter", "openrouter-cache-control"),
        (
            "openrouter-responses",
            "openrouter",
            "openrouter-cache-control",
        ),
        ("openai-chat", "openai", "openai-prefix-cache"),
        ("openai-responses", "openai", "openai-prefix-cache"),
        ("openai-compatible-chat", "local", "openai-prefix-cache"),
    ] {
        let absent = ycoding_core::session::cache_diagnostics::reported(route, provider, None);
        assert_eq!(absent.mechanism, mechanism);
        assert!(!absent.read);
        assert!(!absent.write);
        let usage = ycoding_ai::llm::Usage {
            cache_read_input_tokens: Some(0.0),
            cache_write_input_tokens: Some(0.0),
            ..Default::default()
        };
        let zero =
            ycoding_core::session::cache_diagnostics::reported(route, provider, Some(&usage));
        assert_eq!(zero.mechanism, mechanism);
        assert!(zero.read);
        assert!(zero.write);
    }
}

#[test]
fn canonical_keys_compare_code_points_without_losing_unmatched_utf16_units() {
    let expected = r#"{"10":"ten","2":"two","a":"prefix","a\ud800":"suffix","\ud800":1,"\ud801":2,"\udfff":3,"":"bmp","𐀀":"astral"}"#;
    for input in [
        r#"{"\udfff":3,"\ud801":2,"\ud800":1,"𐀀":"astral","":"bmp","2":"two","10":"ten","a\ud800":"suffix","a":"prefix"}"#,
        expected,
        r#"{"a":"prefix","a\ud800":"suffix","10":"ten","2":"two","\ud800":1,"":"bmp","𐀀":"astral","\udfff":3,"\ud801":2}"#,
    ] {
        assert_eq!(
            prompt_cache::canonical_json(&parse_json(input).unwrap()),
            expected
        );
    }
    assert_eq!(
        prompt_cache::canonical_json(
            &parse_json(r#"{"\ud800\udc00":1,"\ud800a":2,"\udc00":3}"#).unwrap()
        ),
        r#"{"\ud800a":2,"\udc00":3,"𐀀":1}"#
    );
}

#[test]
fn canonical_tool_definitions_preserve_lossless_schemas_and_native_ownership() {
    let definition = |name: &str, schema: &str| ycoding_ai::llm::ToolDefinition {
        name: name.into(),
        description: "Tool".into(),
        input_schema: parse_json(schema).unwrap(),
        output_schema: Some(parse_json(r#"{"z":1,"a":2}"#).unwrap()),
        cache: None,
        metadata: Some(parse_json(r#"{"owner":"registered"}"#).unwrap()),
        native: Some(parse_json(r#"{"z":1,"a":2}"#).unwrap()),
    };
    let mut first = vec![
        definition("zeta", r#"{"type":"object"}"#),
        definition(
            "alpha",
            r#"{"type":"object","properties":{"\ud801":2,"\ud800":1}}"#,
        ),
    ];
    let mut second = vec![
        definition(
            "alpha",
            r#"{"properties":{"\ud800":1,"\ud801":2},"type":"object"}"#,
        ),
        definition("zeta", r#"{"type":"object"}"#),
    ];
    prompt_cache::canonical_tools(&mut first);
    prompt_cache::canonical_tools(&mut second);
    assert_eq!(first, second);
    assert_eq!(
        prompt_cache::tool_digest(&first),
        prompt_cache::tool_digest(&second)
    );
    assert_eq!(
        ycoding_schema::stringify_json(&first[0].input_schema),
        r#"{"properties":{"\ud800":1,"\ud801":2},"type":"object"}"#
    );
    assert_eq!(
        first[0].metadata.as_ref().unwrap(),
        &parse_json(r#"{"owner":"registered"}"#).unwrap()
    );
    assert_eq!(
        ycoding_schema::stringify_json(first[0].native.as_ref().unwrap()),
        r#"{"a":2,"z":1}"#
    );
}

#[test]
fn namespace_matches_typescript_goldens_and_isolates_all_sharing_dimensions() {
    let permissions = ycoding_schema::permission::Ruleset::decode(
        &parse_json(r#"[{"action":"read","resource":"**","effect":"allow"}]"#).unwrap(),
    )
    .unwrap();
    let system = vec!["System after hook".into()];
    let mut tool = ycoding_ai::llm::ToolDefinition {
        name: "search".into(),
        description: "Search".into(),
        input_schema: parse_json(
            r#"{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}"#,
        )
        .unwrap(),
        output_schema: None,
        cache: None,
        metadata: None,
        native: None,
    };
    let tools = vec![tool.clone()];
    let mut input = Namespace {
        project_id: "project".into(),
        directory: "/repo".into(),
        workspace_id: Some("workspace".into()),
        provider_id: "openai".into(),
        model_id: "gpt-5.6".into(),
        variant: None,
        account_identity_digest: None,
        permissions: &permissions,
        system: &system,
        tools: &tools,
    };
    let baseline = prompt_cache::namespace(&input);
    input.variant = Some("high".into());
    assert_eq!(
        prompt_cache::namespace(&input),
        baseline,
        "effort does not rotate the namespace"
    );
    input.variant = None;
    assert_eq!(
        baseline,
        "87f7196969720e74e3d2ad02a0926e06bff1037aeb1d47dc516638a7fed3a6e0"
    );
    tool.input_schema = parse_json(r#"{"10":"ten","2":"two","𐀀":"astral","":"bmp"}"#).unwrap();
    let changed = vec![tool];
    input.tools = &changed;
    assert_eq!(
        prompt_cache::namespace(&input),
        "d86ed155497d942455d1f71c087324e0cabd58b5f5ea387713a01e5270818b31"
    );
    input.tools = &tools;
    for dimension in [
        "project",
        "directory",
        "workspace",
        "provider",
        "model",
        "account",
        "permissions",
        "system",
        "tools",
    ] {
        let alternative_system = vec!["Different system".into()];
        let mut alternative = Namespace {
            project_id: input.project_id.clone(),
            directory: input.directory.clone(),
            workspace_id: input.workspace_id.clone(),
            provider_id: input.provider_id.clone(),
            model_id: input.model_id.clone(),
            variant: None,
            account_identity_digest: None,
            permissions: &permissions,
            system: &system,
            tools: &tools,
        };
        match dimension {
            "project" => alternative.project_id = "other".into(),
            "directory" => alternative.directory = "/other".into(),
            "workspace" => alternative.workspace_id = None,
            "provider" => alternative.provider_id = "other".into(),
            "model" => alternative.model_id = "other".into(),
            "account" => alternative.account_identity_digest = Some("other"),
            "permissions" => alternative.permissions = &[],
            "system" => alternative.system = &alternative_system,
            "tools" => alternative.tools = &[],
            _ => unreachable!(),
        }
        assert_ne!(
            prompt_cache::namespace(&alternative),
            baseline,
            "{dimension}"
        );
    }
    assert_eq!(
        prompt_cache::canonical_json(&JsonValue::Array(vec![
            JsonValue::Null,
            JsonValue::String("tail".into())
        ])),
        r#"[null,"tail"]"#
    );
}

#[test]
fn family_semantic_digest_uses_effective_defaults_and_wire_options() {
    use ycoding_ai::llm;
    use ycoding_core::session::continuation::options_digest;
    let model = ycoding_ai::route::Route::openai_responses().model("gpt-6-sol");
    let base = llm::Request::new(model);
    let baseline = options_digest(&base);
    let mut temperature = base.clone();
    temperature.model.defaults.generation.temperature = Some(0.25);
    assert_ne!(options_digest(&temperature), baseline);
    let mut defaults = base.clone();
    defaults.model.defaults.provider_options =
        Some(parse_json(r#"{"openai":{"reasoningEffort":"high"}}"#).unwrap());
    assert_ne!(options_digest(&defaults), baseline);
    let mut explicit = base.clone();
    explicit.provider_options = defaults.model.defaults.provider_options.clone();
    assert_eq!(options_digest(&explicit), options_digest(&defaults));
    for change in ["body", "query", "format", "choice"] {
        let mut modified = base.clone();
        match change {
            "body" => {
                modified.model.defaults.http.body =
                    Some(parse_json(r#"{"reasoning":{"mode":"extended"}}"#).unwrap())
            }
            "query" => {
                modified
                    .http
                    .query
                    .insert("api-version".into(), "next".into());
            }
            "format" => {
                modified.response_format = Some(llm::ResponseFormat::Json(
                    parse_json(r#"{"type":"object"}"#).unwrap(),
                ))
            }
            "choice" => modified.tool_choice = Some(llm::ToolChoice::None),
            _ => unreachable!(),
        }
        assert_ne!(options_digest(&modified), baseline, "{change}");
    }
    explicit.provider_options = Some(parse_json(r#"{"openai":{"reasoningEffort":"high","previousResponseId":"response","continuationInputStart":3,"promptCacheKey":"other"}}"#).unwrap());
    assert_eq!(
        options_digest(&explicit),
        options_digest(&defaults),
        "session-local continuation identities are not semantic options"
    );
    assert!(!prompt_cache::shared_context_marker_support(
        &"openai".into(),
        "openai-responses",
        "gpt-6-sol",
        prompt_cache::OpenAIMode::Auto,
        "https://api.openai.com/v1//"
    ));
}
