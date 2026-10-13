use ycoding_ai::{
    auth::{Auth, Credential, ProviderAuth},
    cache::{self, Hint, Policy},
    llm::{
        Message, Part, Request, Role, TextPart, ToolCall, ToolChoice, ToolDefinition, ToolResult,
        ToolResultValue,
    },
    route::Route,
};
use ycoding_schema::{parse_json, stringify_json};

fn tool(name: &str) -> ToolDefinition {
    ToolDefinition {
        name: name.into(),
        description: "Lookup data".into(),
        input_schema: parse_json(r#"{"type":"object"}"#).unwrap(),
        output_schema: None,
        cache: None,
        metadata: None,
        native: None,
    }
}
fn result(id: &str) -> Part {
    Part::ToolResult(ToolResult {
        id: id.into(),
        name: "lookup".into(),
        result: ToolResultValue::Text(parse_json(r#""result""#).unwrap()),
        cache: None,
        provider_executed: None,
        provider_metadata: None,
        output: None,
    })
}
fn markers(body: &ycoding_schema::JsonValue) -> usize {
    stringify_json(body).matches("cache_control").count()
}

#[test]
fn cache_direct_compatible_auto_manual_cap_and_order() {
    let mut request = Request::new(Route::anthropic().model("claude-sonnet-4-5"));
    request.tools = vec![tool("lookup")];
    request.system = vec!["fixed".into()];
    request.messages = vec![
        Message::user("start"),
        Message::assistant(vec![Part::Text("answer".into())]),
        Message::new(Role::Tool, vec![result("call")]),
        Message::user("next"),
    ];
    let mut volatile = Message::user("volatile");
    volatile.volatile = true;
    request.messages.push(volatile);
    let direct = request.model.route.prepare(&request).unwrap();
    assert_eq!(markers(&direct.body), 4);
    assert_eq!(direct.encoded_body.matches("\"ttl\":\"1h\"").count(), 2);
    assert!(
        direct
            .encoded_body
            .contains(r#"{"type":"text","text":"volatile"}"#)
    );
    let compatible = Route::anthropic_compatible(
        "https://fixture.invalid/v1",
        None,
        ProviderAuth::ApiKey(Credential::value("fixture")),
    )
    .unwrap();
    request.model = compatible.model("claude-sonnet-4-5");
    assert_eq!(compatible.prepare(&request).unwrap().body, direct.body);
    request.cache = Policy::None;
    assert_eq!(markers(&compatible.prepare(&request).unwrap().body), 0);
    for part in &mut request.system {
        part.cache = Some(Hint::ephemeral(Some(3600.0)));
    }
    for tool in &mut request.tools {
        tool.cache = Some(Hint::ephemeral(None));
    }
    request.messages[0].content.push(Part::Text(TextPart {
        cache: Some(Hint::ephemeral(None)),
        .."manual".into()
    }));
    assert_eq!(markers(&compatible.prepare(&request).unwrap().body), 3);
    request.tools = (0..5)
        .map(|index| {
            let mut tool = tool(&format!("t{index}"));
            tool.cache = Some(Hint::ephemeral(None));
            tool
        })
        .collect();
    assert_eq!(markers(&compatible.prepare(&request).unwrap().body), 4);
    assert!(
        !compatible
            .prepare(&request)
            .unwrap()
            .encoded_body
            .contains("\"ttl\":\"1h\"")
    );
}

#[test]
fn cache_manual_budget_and_ttl_conflicts() {
    let mut request = Request::new(Route::anthropic().model("claude-opus-4-8"));
    request.tools = vec![tool("lookup")];
    request.tools[0].cache = Some(Hint::ephemeral(None));
    request.system = vec!["prefix".into()];
    request.messages = vec![Message::user("tail")];
    let body = request.model.route.prepare(&request).unwrap().encoded_body;
    assert!(!body.contains("\"ttl\":\"1h\""));
    assert_eq!(body.matches("cache_control").count(), 2);
    request.tools[0].cache = Some(Hint::ephemeral(Some(3600.0)));
    request.cache = Policy::Explicit {
        tools: true,
        system: true,
        messages: Some(cache::MessageStrategy::LatestUser),
        ttl_seconds: Some(3600.0),
    };
    let body = request.model.route.prepare(&request).unwrap().encoded_body;
    assert_eq!(body.matches("\"ttl\":\"1h\"").count(), 3);
}

#[test]
fn profiles_model_gating_and_defaults() {
    for (model, min) in [
        ("anthropic/claude-opus-4.8", 1024),
        ("us.anthropic.claude-opus-4-7-v2:0", 2048),
        ("claude-haiku-4-5-20251001", 4096),
        ("anthropic--claude-opus-5", 512),
        ("claude-4-sonnet", 1024),
    ] {
        assert_eq!(
            cache::profile(model).unwrap(),
            cache::Profile {
                minimum_tokens: min,
                extended_ttl: true
            }
        );
    }
    assert!(cache::profile("unknown").is_none());
    assert!(!cache::profile("llama-4-maverick").unwrap().extended_ttl);
    for (model, adaptive, native) in [
        ("claude-opus-5", true, true),
        ("claude-fable-5-1", true, true),
        ("claude-sonnet-5", true, false),
        ("claude-opus-4-8", false, true),
        ("claude-opus-4-7", false, false),
        ("not-claude-opus-5-preview", false, false),
    ] {
        let mut route = Route::anthropic();
        route.defaults.output_limit = Some(100.0);
        route.defaults.generation.temperature = Some(0.5);
        let mut request = Request::new(route.model(model));
        request.model.defaults.output_limit = Some(200.0);
        request.generation.max_tokens = Some(300.0);
        let capabilities = cache::anthropic_capabilities(&request.model.id);
        assert_eq!(capabilities.mid_conversation_system, native);
        let body = route.prepare(&request).unwrap().encoded_body;
        assert_eq!(
            body.contains("\"thinking\":{\"type\":\"adaptive\"}"),
            adaptive
        );
        assert!(body.contains("\"max_tokens\":300"));
        assert_eq!(
            body.contains("temperature"),
            !capabilities.default_only_sampling
        );
    }
    let route = Route::anthropic();
    let mut request = Request::new(route.model("claude-fable-5"));
    request.provider_options =
        Some(parse_json(r#"{"anthropic":{"thinking":{"type":"disabled"}}}"#).unwrap());
    assert!(route.prepare(&request).is_err());
    request.model = route.model("claude-opus-5");
    request.provider_options = Some(
        parse_json(r#"{"anthropic":{"thinking":{"type":"enabled","budgetTokens":1024}}}"#).unwrap(),
    );
    assert!(route.prepare(&request).is_err());
    request.provider_options = Some(
        parse_json(r#"{"anthropic":{"thinking":{"type":"disabled"},"effort":"max"}}"#).unwrap(),
    );
    assert!(route.prepare(&request).is_err());
    request.provider_options = Some(
        parse_json(r#"{"anthropic":{"thinking":{"type":"disabled"},"effort":"high"}}"#).unwrap(),
    );
    assert!(route.prepare(&request).is_ok());
}

#[test]
fn chronological_system_updates_and_local_tool_fence() {
    let route = Route::anthropic();
    let mut request = Request::new(route.model("claude-opus-4-8"));
    request.cache = Policy::None;
    request.messages = vec![
        Message::user("user"),
        Message::system("<&>"),
        Message::assistant(Vec::new()),
    ];
    assert!(
        route
            .prepare(&request)
            .unwrap()
            .encoded_body
            .contains(r#"{"role":"system","content":[{"type":"text","text":"<&>"}]}"#)
    );
    request.model = route.model("claude-sonnet-4-5");
    assert!(
        route
            .prepare(&request)
            .unwrap()
            .encoded_body
            .contains("<system-update>\\n&lt;&amp;&gt;\\n</system-update>")
    );
    request.messages = vec![
        Message::assistant(vec![Part::ToolCall(ToolCall {
            id: "call".into(),
            name: "lookup".into(),
            input: parse_json("{}").unwrap(),
            provider_executed: None,
            provider_metadata: None,
        })]),
        Message::system("update"),
        Message::new(Role::Tool, vec![result("call")]),
    ];
    assert!(
        route
            .prepare(&request)
            .unwrap_err()
            .message
            .contains("cannot split")
    );
}

#[test]
fn tool_choice_schema_projection_and_overlays() {
    let mut route = Route::anthropic();
    route.auth = Auth::header("x-api-key", Credential::value("test-secret"));
    let mut request = Request::new(route.model("claude-opus-5"));
    request.cache = Policy::None;
    request.tools = vec![tool("lookup")];
    request.tool_choice = Some(ToolChoice::Required);
    request.tools[0].input_schema=parse_json(r#"{"anyOf":[{"type":"object","properties":{"action":{"const":"read"},"path":{"type":"string"}},"required":["action","path"]},{"type":"object","properties":{"action":{"const":"write"},"text":{"type":"string"}},"required":["action","text"]}]}"#).unwrap();
    let prepared = route.prepare(&request).unwrap();
    let body = stringify_json(&prepared.body);
    assert!(body.contains("\"$ref\":\"#/$defs/__ycoding_root\""));
    assert!(body.contains("\"tool_choice\":{\"type\":\"any\"}"));
    request.http.body =
        Some(parse_json(r#"{"metadata":{"user_id":"u"},"custom":{"a":2}}"#).unwrap());
    route.defaults.http.body = Some(parse_json(r#"{"custom":{"b":1}}"#).unwrap());
    request.model = route.model("claude-opus-5");
    let prepared = route.prepare(&request).unwrap();
    assert!(prepared.encoded_body.contains(r#""custom":{"b":1,"a":2}"#));
    assert!(!stringify_json(&prepared.body).contains("custom"));
    request.http.body = Some(parse_json(r#"{"messages":[]}"#).unwrap());
    assert!(route.prepare(&request).is_err());
    request.http.body = None;
    request.tool_choice = Some(ToolChoice::None);
    assert!(
        !route
            .prepare(&request)
            .unwrap()
            .encoded_body
            .contains("\"tools\"")
    );
    request.tool_choice = Some(ToolChoice::Tool("".into()));
    assert!(route.prepare(&request).is_err());
    let debug = format!("{prepared:?} {:?}", route.auth);
    assert!(!debug.contains("test-secret"));
}

#[test]
fn media_content_and_user_merge() {
    use ycoding_ai::llm::{Media, MediaData};
    let route = Route::anthropic();
    let mut request = Request::new(route.model("claude-sonnet-4-5"));
    request.cache = Policy::None;
    request.messages = vec![
        Message::user("a"),
        Message::user("b"),
        Message::new(
            Role::User,
            vec![Part::Media(Media {
                mime: "image/png".into(),
                data: MediaData::Bytes(vec![1, 2, 3]),
                filename: None,
            })],
        ),
    ];
    let body = route.prepare(&request).unwrap().encoded_body;
    assert_eq!(body.matches("\"role\":\"user\"").count(), 1);
    assert!(body.contains(r#""data":"AQID""#));
    request.messages[2].content = vec![Part::Media(Media {
        mime: "image/png".into(),
        data: MediaData::Encoded("AB==".into()),
        filename: Some("fixture.png".into()),
    })];
    let body = route.prepare(&request).unwrap().encoded_body;
    assert!(body.contains("fixture.png"));
    assert!(body.contains("canonical base64"));
    request.messages[2].content = vec![Part::Media(Media {
        mime: "application/pdf".into(),
        data: MediaData::Encoded("AQID".into()),
        filename: None,
    })];
    assert!(
        route
            .prepare(&request)
            .unwrap()
            .encoded_body
            .contains("omitted")
    );
}

#[test]
fn gpt_cache_gate_and_explicit_volatility_are_model_namespaced() {
    assert!(cache::supports_prompt_cache_breakpoints(
        "openai-responses",
        "openai/gpt-5.6"
    ));
    assert!(cache::supports_prompt_cache_breakpoints(
        "openai-responses",
        "gpt-daybreak-blue-latest"
    ));
    assert!(!cache::supports_prompt_cache_breakpoints(
        "openai-responses",
        "not-gpt-5.6"
    ));
    assert!(!cache::supports_prompt_cache_breakpoints(
        "custom-route",
        "gpt-5.6"
    ));
    assert!(!cache::supports_prompt_cache_breakpoints(
        "openai-chat",
        "gpt-5.5"
    ));
    let mut route = Route::anthropic();
    route.id = "openai-responses".into();
    let mut request = Request::new(route.model("gpt-5.6"));
    request.provider_options = Some(
        parse_json(r#"{"openai":{"promptCacheOptions":{"mode":"implicit","ttl":"30m"}}}"#).unwrap(),
    );
    request.system = vec!["fixed".into()];
    request.messages = (0..70)
        .map(|index| Message::user(format!("m{index}")))
        .collect();
    request.cache = Policy::Explicit {
        tools: true,
        system: true,
        messages: Some(cache::MessageStrategy::Tail(50)),
        ttl_seconds: None,
    };
    cache::apply(&mut request);
    assert_eq!(
        request
            .messages
            .iter()
            .flat_map(|message| message.content.iter())
            .filter(|part| part.cache().is_some())
            .count(),
        48
    );
    assert!(request.messages[0].content[0].cache().is_some());
    assert!(request.messages[1].content[0].cache().is_some());
    assert!(request.messages[20].content[0].cache().is_none());
    let mut volatile = Message::user("volatile");
    volatile.volatile = true;
    request.messages.push(volatile);
    request.cache = Policy::Auto;
    cache::apply(&mut request);
    assert!(
        stringify_json(request.provider_options.as_ref().unwrap()).contains(r#""mode":"explicit""#)
    );
    assert!(
        request.messages.last().unwrap().content[0]
            .cache()
            .is_none()
    );
}
