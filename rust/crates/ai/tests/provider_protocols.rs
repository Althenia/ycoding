use ycoding_ai::{
    anthropic::AnthropicMessages,
    llm::{Event, Request},
    route::Route,
};
use ycoding_schema::{parse_json, stringify_json};

#[test]
fn prepared_anthropic_fixture() {
    let route = Route::anthropic();
    let mut request = Request::new(route.model("claude-sonnet-4-5"));
    request.system.push("You are concise.".into());
    request
        .messages
        .push(ycoding_ai::llm::Message::user("Say hello."));
    request.cache = ycoding_ai::cache::Policy::None;
    request.system[0].cache = Some(ycoding_ai::cache::Hint::ephemeral(None));
    request.generation.max_tokens = Some(20.0);
    request.generation.temperature = Some(0.0);
    let body = route.prepare(&request).unwrap().body;
    assert_eq!(body, parse_json(r#"{"model":"claude-sonnet-4-5","system":[{"type":"text","text":"You are concise.","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":[{"type":"text","text":"Say hello."}]}],"stream":true,"max_tokens":20,"temperature":0}"#).unwrap());
    assert!(stringify_json(&body).starts_with("{\"model\""));
}

#[test]
fn partial_tool_args_and_malformed_settlement() {
    let request = Request::new(Route::anthropic().model("claude-sonnet-4-5"));
    let mut parser = AnthropicMessages::parser(&request);
    let events = [
        r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"search"}}"#,
        r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"q\":"}}"#,
        r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"ไทย\"}"}}"#,
        r#"{"type":"content_block_stop","index":0}"#,
        r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"}}"#,
    ].into_iter().flat_map(|frame| parser.push(frame).unwrap()).collect::<Vec<_>>();
    assert!(events.iter().any(|event| matches!(event, Event::ToolCall(call) if call.input == parse_json(r#"{"q":"ไทย"}"#).unwrap())));
    assert!(parser.finish().is_ok());
    assert!(parser.push(r#"{"type":"message_delta"}"#).is_err());
    assert!(AnthropicMessages::parser(&request).finish().is_err());
}

fn parse_response(
    request: &Request,
    frames: &[&str],
) -> Result<ycoding_ai::llm::Response, ycoding_ai::Error> {
    let mut parser = AnthropicMessages::parser(request);
    let mut events = Vec::new();
    for frame in frames {
        events.extend(parser.push(frame)?);
    }
    parser.finish()?;
    ycoding_ai::llm::Response::from_events(events)
}

#[test]
fn thinking_signatures_usage_and_replay() {
    let route = Route::anthropic();
    let request = Request::new(route.model("claude-opus-5"));
    let response = parse_response(&request, &[
        r#"{"type":"message_start","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":1,"cache_creation":{"ephemeral_5m_input_tokens":2},"ignored":900}}}"#,
        r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
        r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"thinking"}}"#,
        r#"{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_1"}}"#,
        r#"{"type":"content_block_stop","index":0}"#,
        r#"{"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"opaque"}}"#,
        r#"{"type":"content_block_start","index":2,"content_block":{"type":"text","text":"Hello"}}"#,
        r#"{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"!"}}"#,
        r#"{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":"\n\nHuman:"},"usage":{"output_tokens":2,"cache_creation_input_tokens":3,"cache_creation":{"ephemeral_1h_input_tokens":1}}}"#,
        r#"{"type":"message_stop"}"#,
    ]).unwrap();
    assert_eq!(response.text().as_str(), Some("Hello!"));
    assert_eq!(response.reasoning().as_str(), Some("thinking"));
    let usage = response.usage.as_ref().unwrap();
    assert_eq!(
        (
            usage.input_tokens,
            usage.non_cached_input_tokens,
            usage.cache_read_input_tokens,
            usage.cache_write_input_tokens,
            usage.output_tokens,
            usage.total_tokens
        ),
        (
            Some(9.0),
            Some(5.0),
            Some(1.0),
            Some(3.0),
            Some(2.0),
            Some(11.0)
        )
    );
    assert_eq!(usage.reasoning_tokens, None);
    assert_eq!(usage.output_may_include_unreported_reasoning, Some(true));
    assert_eq!(usage.provider_metadata, Some(parse_json(r#"{"anthropic":{"input_tokens":5,"cache_read_input_tokens":1,"cache_creation":{"ephemeral_5m_input_tokens":2,"ephemeral_1h_input_tokens":1},"output_tokens":2,"cache_creation_input_tokens":3}}"#).unwrap()));
    let mut replay = Request::new(route.model("claude-opus-5"));
    replay.cache = ycoding_ai::cache::Policy::None;
    replay.messages.push(response.message);
    let body = route.prepare(&replay).unwrap().body;
    let encoded = stringify_json(&body);
    assert!(encoded.contains(r#"{"type":"thinking","thinking":"thinking","signature":"sig_1"}"#));
    assert!(encoded.contains(r#"{"type":"redacted_thinking","data":"opaque"}"#));
    assert!(encoded.contains(r#"{"type":"text","text":"Hello!"}"#));
}

#[test]
fn usage_absence_zero_null_refusal_and_errors() {
    let request = Request::new(Route::anthropic().model("claude-sonnet-4-5"));
    for (usage, expected) in [
        ("{}", None),
        (r#"{"cache_read_input_tokens":null}"#, None),
        (r#"{"cache_read_input_tokens":0}"#, Some(0.0)),
    ] {
        let frame = format!(
            r#"{{"type":"message_delta","delta":{{"stop_reason":"refusal"}},"usage":{usage}}}"#
        );
        let response = parse_response(&request, &[&frame]).unwrap();
        let usage = response.usage.unwrap();
        assert_eq!(usage.cache_read_input_tokens, expected);
        assert_eq!(usage.input_tokens, expected);
        assert_eq!(usage.total_tokens, expected);
        assert_eq!(
            response.finish_reason,
            ycoding_ai::llm::FinishReason::ContentFilter
        );
    }
    let response = parse_response(
        &request,
        &[r#"{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}"#],
    )
    .unwrap();
    assert!(response.usage.is_none());
    assert_eq!(
        response.finish_reason,
        ycoding_ai::llm::FinishReason::Length
    );
    for (frame, reason) in [
        (
            r#"{"type":"error","error":{"type":"rate_limit_error"}}"#,
            ycoding_ai::provider_error::Reason::RateLimit,
        ),
        (
            r#"{"type":"error","error":{"type":"overloaded_error","message":"busy"}}"#,
            ycoding_ai::provider_error::Reason::ProviderInternal,
        ),
        (
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}"#,
            ycoding_ai::provider_error::Reason::InvalidRequest,
        ),
        (
            r#"{"type":"error"}"#,
            ycoding_ai::provider_error::Reason::UnknownProvider,
        ),
        (
            r#"{"type":"content_block_delta","delta":{"text":3}}"#,
            ycoding_ai::provider_error::Reason::InvalidProviderOutput,
        ),
    ] {
        assert_eq!(
            AnthropicMessages::parser(&request)
                .push(frame)
                .unwrap_err()
                .reason,
            reason
        );
    }
    assert!(AnthropicMessages::parser(&request).push(r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}"#).is_err());
}

#[test]
fn usage_null_delta_retains_ttl_breakdown() {
    let request = Request::new(Route::anthropic().model("claude-sonnet-4-5"));
    let response=parse_response(&request,&[
        r#"{"type":"message_start","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":2,"cache_creation":{"ephemeral_5m_input_tokens":3}}}}"#,
        r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"cache_read_input_tokens":null,"cache_creation":null}}"#,
    ]).unwrap();
    let usage = response.usage.unwrap();
    assert_eq!(usage.cache_read_input_tokens, Some(2.0));
    assert!(
        stringify_json(usage.provider_metadata.as_ref().unwrap())
            .contains(r#""cache_creation":{"ephemeral_5m_input_tokens":3}"#)
    );
}

#[test]
fn local_malformed_tool_is_nonexecutable_server_malformed_is_error() {
    let request = Request::new(Route::anthropic().model("claude-sonnet-4-5"));
    for kind in ["tool_use", "server_tool_use"] {
        let mut parser = AnthropicMessages::parser(&request);
        parser.push(&format!(r#"{{"type":"content_block_start","index":0,"content_block":{{"type":"{kind}","id":"call","name":"lookup"}}}}"#)).unwrap();
        parser.push(r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"partial"}}"#).unwrap();
        let result = parser.push(r#"{"type":"content_block_stop","index":0}"#);
        if kind == "server_tool_use" {
            assert!(result.is_err());
        } else {
            assert!(matches!(
                result.unwrap().as_slice(),
                [Event::ToolInputError { .. }]
            ));
        }
    }
}

#[test]
fn server_tool_roundtrip_and_unknown_name() {
    let route = Route::anthropic();
    let mut request = Request::new(route.model("claude-sonnet-4-5"));
    let response = parse_response(&request, &[
        r#"{"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"search","name":"web_search"}}"#,
        r#"{"type":"content_block_stop","index":0}"#,
        r#"{"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"search","content":{"type":"web_search_tool_result_error","error_code":"max_uses_exceeded"}}}"#,
        r#"{"type":"message_delta","delta":{"stop_reason":"pause_turn"}}"#,
    ]).unwrap();
    assert_eq!(response.finish_reason, ycoding_ai::llm::FinishReason::Stop);
    request.messages.push(response.message);
    let body = stringify_json(&route.prepare(&request).unwrap().body);
    assert!(body.contains(r#""type":"server_tool_use""#));
    assert!(body.contains(r#""type":"web_search_tool_result""#));
    if let ycoding_ai::llm::Part::ToolResult(result) = &mut request.messages[0].content[1] {
        result.name = "unknown".into();
    }
    assert!(route.prepare(&request).is_err());
}

#[test]
fn lossless_provider_strings_and_js_key_order() {
    let route = Route::anthropic();
    let mut request = Request::new(route.model("claude-sonnet-4-5"));
    request
        .system
        .push(ycoding_schema::LosslessString::from_utf16(vec![0xd800]).into());
    let high = route.prepare(&request).unwrap().encoded_body;
    request.system[0].text = ycoding_schema::LosslessString::from_utf16(vec![0xdc00]);
    let low = route.prepare(&request).unwrap().encoded_body;
    assert_ne!(high, low);
    assert!(high.contains("\\ud800"));
    assert!(low.contains("\\udc00"));
    let response = parse_response(
        &request,
        &[
            r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"\ud800"}}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"}}"#,
        ],
    )
    .unwrap();
    assert_eq!(response.text().as_utf16_units(), Some([0xd800].as_slice()));
    assert_eq!(
        stringify_json(&parse_json(r#"{"z":1,"10":2,"2":3,"a":4}"#).unwrap()),
        r#"{"2":3,"10":2,"z":1,"a":4}"#
    );
}

#[test]
fn tool_partial_json_preserves_literal_lone_surrogates() {
    let request = Request::new(Route::anthropic().model("claude-sonnet-4-5"));
    let response=parse_response(&request,&[
        r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call","name":"lookup"}}"#,
        r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"value\":\"\ud800"}}"#,
        r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"}"}}"#,
        r#"{"type":"content_block_stop","index":0}"#,
        r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"}}"#,
    ]).unwrap();
    assert!(response.events.iter().any(|event|matches!(event,Event::ToolCall(call) if call.input==parse_json(r#"{"value":"\ud800"}"#).unwrap())));
}
