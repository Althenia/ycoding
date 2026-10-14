use ycoding_ai::{
    auth::{Auth, Credential, ProviderAuth},
    llm::{Event, Part, Request, Response, ToolResultValue},
    muse::{Connection, Runtime},
    openai_codex,
    providers::{self, Api, Config, OpenAIConfig, OpenRouterConfig, Transport},
    route::Route,
};
use ycoding_schema::{parse_json, provider};

#[test]
fn responses_provider_routes_map_builtin_errors_to_provider_executed_results() {
    let mut compatible = Config::new(Auth::None);
    compatible.base_url = Some("http://127.0.0.1:1/v1".into());
    let runtime = Runtime::new("http://127.0.0.1:1/key".into()).unwrap();
    let models = [
        providers::openai(
            "fixture",
            OpenAIConfig {
                common: Config::new(Auth::bearer(Credential::value("fixture"))),
                organization: None,
                project: None,
                transport: Transport::Http,
            },
        ),
        openai_codex::model(
            "fixture",
            openai_codex::Config::new(Credential::value("fixture")),
        )
        .unwrap(),
        {
            let mut config = openai_codex::Config::new(Credential::value("fixture"));
            config.websocket = true;
            openai_codex::model("fixture", config).unwrap()
        },
        providers::openrouter(
            "fixture",
            OpenRouterConfig {
                common: Config::new(Auth::None),
                reasoning: None,
            },
        ),
        ycoding_ai::muse::route(Connection::key(
            runtime,
            "fixture".into(),
            ycoding_ai::muse::BASE_URL.into(),
            None,
        ))
        .model("fixture"),
        providers::compatible(
            "fixture",
            provider::Id("fixture".into()),
            compatible,
            Api::Responses,
        )
        .unwrap(),
    ];
    for model in models {
        for kind in [
            "web_search_call",
            "file_search_call",
            "code_interpreter_call",
            "computer_use_call",
            "image_generation_call",
            "mcp_call",
            "local_shell_call",
        ] {
            let request = Request::new(model.clone());
            let mut parser = model.route.protocol.parser(&request.resolved());
            let payload = parse_json(r#"{"code":"tool_failed","message":"Unavailable"}"#).unwrap();
            let frame = parse_json(&format!(r#"{{"type":"response.output_item.done","item":{{"type":"{kind}","id":"hosted_1","status":"failed","error":{{"code":"tool_failed","message":"Unavailable"}}}}}}"#)).unwrap();
            let mut events = parser.push(&frame).unwrap();
            events.extend(
                parser
                    .push(&parse_json(r#"{"type":"response.completed"}"#).unwrap())
                    .unwrap(),
            );
            events.extend(parser.finish().unwrap());
            let response = Response::from_events(events).unwrap();
            let calls = response
                .events
                .iter()
                .filter_map(|event| match event {
                    Event::ToolCall(call) => Some(call),
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert_eq!(calls.len(), 1, "{} {kind}", model.route.id);
            assert_eq!(calls[0].provider_executed, Some(true));
            let results = response
                .message
                .content
                .iter()
                .filter_map(|part| match part {
                    Part::ToolResult(result) => Some(result),
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert_eq!(results.len(), 1, "{} {kind}", model.route.id);
            assert_eq!(results[0].id, calls[0].id);
            assert_eq!(results[0].name, calls[0].name);
            assert_eq!(results[0].provider_executed, Some(true));
            assert_eq!(results[0].result, ToolResultValue::Error(payload));
            assert!(results[0].output.is_none());
            assert_eq!(
                results[0].provider_metadata,
                Some(parse_json(r#"{"openai":{"itemId":"hosted_1"}}"#).unwrap())
            );
        }
    }
}

#[test]
fn anthropic_and_minimax_routes_map_each_server_tool_error() {
    let routes = [
        Route::anthropic_provider(ProviderAuth::ApiKey(Credential::value("fixture"))),
        Route::anthropic_compatible(
            "http://127.0.0.1:1/v1",
            Some(provider::Id("minimax".into())),
            ProviderAuth::ApiKey(Credential::value("fixture")),
        )
        .unwrap(),
    ];
    for route in routes {
        for name in ["web_search", "web_fetch", "code_execution"] {
            let request = Request::new(route.model("fixture"));
            let mut parser = route.protocol.parser(&request.resolved());
            let payload = parse_json(&format!(
                r#"{{"type":"{name}_tool_result_error","error_code":"unavailable"}}"#
            ))
            .unwrap();
            let frames = [
                format!(
                    r#"{{"type":"content_block_start","index":0,"content_block":{{"type":"server_tool_use","id":"server_1","name":"{name}","input":{{}}}}}}"#
                ),
                r#"{"type":"content_block_stop","index":0}"#.into(),
                format!(
                    r#"{{"type":"content_block_start","index":1,"content_block":{{"type":"{name}_tool_result","tool_use_id":"server_1","content":{{"type":"{name}_tool_result_error","error_code":"unavailable"}}}}}}"#
                ),
                r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"}}"#.into(),
                r#"{"type":"message_stop"}"#.into(),
            ];
            let mut events = Vec::new();
            for frame in frames {
                events.extend(parser.push(&parse_json(&frame).unwrap()).unwrap());
            }
            events.extend(parser.finish().unwrap());
            let response = Response::from_events(events).unwrap();
            assert!(response.events.iter().any(|event| matches!(event, Event::ToolCall(call) if call.id == "server_1".into() && call.provider_executed == Some(true))));
            let Part::ToolResult(result) = &response.message.content[1] else {
                panic!("missing server tool result")
            };
            assert_eq!(result.name.as_str(), Some(name));
            assert_eq!(result.provider_executed, Some(true));
            assert_eq!(result.result, ToolResultValue::Error(payload));
            assert!(result.output.is_none());
            assert_eq!(
                result.provider_metadata,
                Some(
                    parse_json(&format!(
                        r#"{{"anthropic":{{"blockType":"{name}_tool_result"}}}}"#
                    ))
                    .unwrap()
                )
            );
        }
    }
}

#[test]
fn gateway_maps_hosted_tool_errors_to_provider_executed_results() {
    let model = ycoding_ai::gateway::model("fixture", Config::new(Auth::None));
    let request = Request::new(model.clone());
    let mut parser = model.route.protocol.parser(&request.resolved());
    let mut events = Vec::new();
    for frame in [
        r#"{"type":"tool-call","toolCallId":"hosted_1","toolName":"web_search","input":"{}","providerExecuted":true}"#,
        r#"{"type":"tool-result","toolCallId":"hosted_1","toolName":"web_search","result":{"message":"Unavailable"},"isError":true,"providerMetadata":{"gateway":{"itemId":"hosted_1"}}}"#,
        r#"{"type":"finish","finishReason":{"unified":"stop"},"usage":{"inputTokens":{},"outputTokens":{}}}"#,
    ] {
        events.extend(parser.push(&parse_json(frame).unwrap()).unwrap());
    }
    events.extend(parser.finish().unwrap());
    let response = Response::from_events(events).unwrap();
    assert!(response.events.iter().any(|event| matches!(event, Event::ToolCall(call) if call.id == "hosted_1".into() && call.provider_executed == Some(true))));
    let Part::ToolResult(result) = &response.message.content[1] else {
        panic!("missing hosted tool result")
    };
    assert_eq!(result.id.as_str(), Some("hosted_1"));
    assert_eq!(result.name.as_str(), Some("web_search"));
    assert_eq!(result.provider_executed, Some(true));
    assert_eq!(
        result.result,
        ToolResultValue::Error(parse_json(r#"{"message":"Unavailable"}"#).unwrap())
    );
    assert!(result.output.is_none());
    assert_eq!(
        result.provider_metadata,
        Some(parse_json(r#"{"gateway":{"itemId":"hosted_1"}}"#).unwrap())
    );
}
