use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use ycoding_ai::{
    ai_sdk,
    cache::Hint,
    llm::{
        BlockEvent, DeltaEvent, Event, Finish, FinishReason, Media, MediaData, Message, Part,
        Reasoning, Request, Response, ResponseFormat, Role, TextPart, ToolCall, ToolChoice,
        ToolDefinition, ToolInputEvent, ToolResult, ToolResultValue, Usage,
    },
    provider_error::Reason,
    route::{
        Executor, LanguageAttempt, LanguageFuture, LanguageParts, ProcessInput, Protocol, Route,
        Transport,
    },
};
use ycoding_schema::{
    JsonValue, LosslessString,
    llm::{ToolContent, ToolFileContent, ToolTextContent},
    parse_json, stringify_json,
};

const ANTHROPIC: &str = "ai-sdk:@ai-sdk/anthropic";
const VERTEX_ANTHROPIC: &str = "ai-sdk:@ai-sdk/google-vertex/anthropic";
const OPENROUTER: &str = "ai-sdk:@openrouter/ai-sdk-provider";
const BEDROCK: &str = "ai-sdk:@ai-sdk/amazon-bedrock";
const COPILOT: &str = "ai-sdk:@ai-sdk/github-copilot";
const OPENAI: &str = "ai-sdk:@ai-sdk/openai";
const CURSOR: &str = "ai-sdk:cursor-opencode-provider";

fn value(text: &str) -> JsonValue {
    parse_json(text).unwrap()
}
fn plain(value: &JsonValue) -> Value {
    serde_json::from_str(&stringify_json(value)).unwrap()
}
fn route(id: &str) -> Route {
    let mut route = Route::openai_chat();
    route.id = id.into();
    route.protocol = Arc::new(codec(&Request::new(route.clone().model("fixture-model"))));
    route.provider_metadata_key = None;
    route
}
fn request(route_id: &str, model: &str) -> Request {
    Request::new(route(route_id).model(model))
}
fn codec(request: &Request) -> ai_sdk::Protocol {
    ai_sdk::Protocol::new(request).unwrap()
}
fn lower(request: &Request) -> Value {
    plain(&codec(request).lower(&request.resolved()).unwrap())
}
fn lower_error(request: &Request) -> ycoding_ai::Error {
    ai_sdk::Protocol::new(request)
        .and_then(|codec| codec.lower(&request.resolved()))
        .unwrap_err()
}
fn prompt(request: &Request) -> Value {
    lower(request)["prompt"].clone()
}
fn hint(ttl: f64) -> Hint {
    Hint::ephemeral(Some(ttl))
}
fn text_with(text: &str, cache: Option<Hint>, metadata: Option<&str>) -> Part {
    Part::Text(TextPart {
        text: text.into(),
        cache,
        metadata: None,
        provider_metadata: metadata.map(value),
    })
}
fn tool_result(id: &str, name: &str, result: ToolResultValue) -> ToolResult {
    ToolResult {
        id: id.into(),
        name: name.into(),
        result,
        cache: None,
        provider_executed: None,
        provider_metadata: None,
        output: None,
    }
}
fn definition(name: &str, schema: &str) -> ToolDefinition {
    ToolDefinition {
        name: name.into(),
        description: format!("{name} tool").into(),
        input_schema: value(schema),
        output_schema: None,
        cache: None,
        metadata: None,
        native: None,
    }
}
fn parser_events(request: &Request, frames: &[&str]) -> Vec<Event> {
    let mut parser = codec(request).parser(&request.resolved());
    let mut events = Vec::new();
    for frame in frames {
        events.extend(parser.push(&value(frame)).unwrap());
    }
    events.extend(parser.finish().unwrap());
    events
}
fn stream_error(request: &Request, frames: &[&str]) -> ycoding_ai::Error {
    let mut parser = codec(request).parser(&request.resolved());
    for frame in frames {
        if let Err(error) = parser.push(&value(frame)) {
            return error;
        }
    }
    parser.finish().unwrap_err()
}
fn finish_frame(usage: &str) -> String {
    format!(
        r#"{{"type":"finish","finishReason":{{"unified":"stop","raw":"end_turn"}},"usage":{usage}}}"#
    )
}
fn finish_usage(request: &Request, usage: &str, metadata: Option<&str>) -> Option<Usage> {
    let frame = match metadata {
        Some(metadata) => format!(
            r#"{{"type":"finish","finishReason":{{"unified":"stop"}},"usage":{usage},"providerMetadata":{metadata}}}"#
        ),
        None => finish_frame(usage),
    };
    let mut parser = codec(request).parser(&request.resolved());
    let events = parser.push(&value(&frame)).unwrap();
    match &events[..] {
        [
            Event::StepStart { .. },
            Event::StepFinish { finish, .. },
            Event::Finish(_),
        ] => finish.usage.clone(),
        other => panic!("unexpected events {other:?}"),
    }
}
fn block(id: &str) -> BlockEvent {
    BlockEvent {
        id: id.into(),
        provider_metadata: None,
    }
}
fn delta(id: &str, text: &str) -> DeltaEvent {
    DeltaEvent {
        id: id.into(),
        text: text.into(),
        provider_metadata: None,
    }
}
fn stop() -> Finish {
    Finish {
        reason: FinishReason::Stop,
        usage: None,
        provider_metadata: None,
    }
}
const EMPTY_USAGE: &str = r#"{"inputTokens":{},"outputTokens":{}}"#;

#[test]
fn identifies_the_protocol_and_rejects_provider_enforced_response_formats() {
    let mut request = request(OPENAI, "gpt-5.6");
    request.messages.push(Message::user("hi"));
    let codec = codec(&request);
    assert_eq!(codec.id(), "ai-sdk");
    assert!(codec.response_formats().is_empty());
    request.response_format = Some(ResponseFormat::Text);
    assert!(request.model.route.prepare(&request).is_ok());
    for format in [
        ResponseFormat::Json(value(r#"{"type":"object"}"#)),
        ResponseFormat::Tool(definition("decide", "{}")),
    ] {
        request.response_format = Some(format);
        let error = request.model.route.prepare(&request).unwrap_err();
        assert_eq!(error.reason, Reason::InvalidRequest);
        assert!(error.http.is_none());
    }
}

#[test]
fn lowers_generation_options_headers_and_empty_tools() {
    let mut request = request(OPENAI, "gpt-5.6");
    request.messages.push(Message::user("hi"));
    request.generation.max_tokens = Some(256.0);
    request.generation.temperature = Some(0.5);
    request.generation.top_p = Some(0.9);
    request.generation.top_k = Some(40.0);
    request.generation.presence_penalty = Some(0.1);
    request.generation.frequency_penalty = Some(0.2);
    request.generation.seed = Some(7.0);
    request.generation.stop = Some(vec!["END".into(), "STOP".into()]);
    request
        .http
        .headers
        .insert("x-trace".into(), "synthetic".into());
    assert_eq!(
        lower(&request),
        json!({
            "prompt": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
            "maxOutputTokens": 256,
            "temperature": 0.5,
            "stopSequences": ["END", "STOP"],
            "topP": 0.9,
            "topK": 40,
            "presencePenalty": 0.1,
            "frequencyPenalty": 0.2,
            "seed": 7,
            "tools": [],
            "headers": {"x-trace": "synthetic"}
        })
    );
}

#[test]
fn omits_unset_options_and_falls_back_to_the_route_output_limit() {
    let mut route = route(OPENAI);
    route.defaults.output_limit = Some(4096.0);
    let mut request = Request::new(route.model("gpt-5.6"));
    request.messages.push(Message::user("hi"));
    assert_eq!(
        lower(&request),
        json!({
            "prompt": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
            "maxOutputTokens": 4096,
            "tools": []
        })
    );
    request.generation.max_tokens = Some(10.0);
    assert_eq!(lower(&request)["maxOutputTokens"], json!(10));
}

#[test]
fn lowers_response_formats() {
    let mut request = request(OPENAI, "gpt-5.6");
    assert_eq!(lower(&request).get("responseFormat"), None);
    request.response_format = Some(ResponseFormat::Json(value(
        r#"{"type":"object","properties":{"a":{"type":"string"}}}"#,
    )));
    assert_eq!(
        lower(&request)["responseFormat"],
        json!({"type": "json", "schema": {"type": "object", "properties": {"a": {"type": "string"}}}})
    );
    request.response_format = Some(ResponseFormat::Text);
    assert_eq!(lower(&request)["responseFormat"], json!({"type": "text"}));
    request.response_format = Some(ResponseFormat::Tool(definition("decide", "{}")));
    assert_eq!(lower(&request)["responseFormat"], json!({"type": "text"}));
}

#[test]
fn lowers_tools_and_tool_choice() {
    let mut request = request(OPENAI, "gpt-5.6");
    request.tools = vec![definition(
        "read",
        r#"{"type":"object","properties":{"path":{"type":"string"}}}"#,
    )];
    assert_eq!(
        lower(&request)["tools"],
        json!([{
            "type": "function",
            "name": "read",
            "description": "read tool",
            "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}}
        }])
    );
    assert_eq!(lower(&request).get("toolChoice"), None);
    for (choice, expected) in [
        (ToolChoice::Auto, json!({"type": "auto"})),
        (ToolChoice::None, json!({"type": "none"})),
        (ToolChoice::Required, json!({"type": "required"})),
        (
            ToolChoice::Tool("read".into()),
            json!({"type": "tool", "toolName": "read"}),
        ),
    ] {
        request.tool_choice = Some(choice);
        assert_eq!(lower(&request)["toolChoice"], expected);
    }
}

#[test]
fn projects_anthropic_tool_schemas_only_for_anthropic_routes_and_models() {
    let union = r#"{"anyOf":[{"type":"object","properties":{"a":{"type":"string"}}}]}"#;
    let schema = |route_id: &str, model: &str| {
        let mut request = request(route_id, model);
        request.tools = vec![definition("pick", union)];
        lower(&request)["tools"][0]["inputSchema"].clone()
    };
    let raw: Value = serde_json::from_str(union).unwrap();
    assert_eq!(schema(OPENAI, "gpt-5.6"), raw);
    for projected in [
        schema(ANTHROPIC, "custom-model"),
        schema(OPENROUTER, "claude-sonnet-4-5"),
    ] {
        assert_ne!(projected, raw);
        assert_eq!(projected["type"], json!("object"));
    }
}

#[test]
fn joins_system_text_and_places_the_last_cache_hint() {
    let mut request = request(ANTHROPIC, "claude-sonnet-4-5");
    request.system = vec![
        TextPart {
            cache: Some(hint(60.0)),
            ..TextPart::from("first")
        },
        TextPart::from(""),
        TextPart {
            cache: Some(hint(3600.0)),
            ..TextPart::from("second")
        },
        TextPart::from("third"),
    ];
    request.messages.push(Message::user("hi"));
    assert_eq!(
        prompt(&request),
        json!([
            {
                "role": "system",
                "content": "first\n\nsecond\n\nthird",
                "providerOptions": {"anthropic": {"cacheControl": {"type": "ephemeral", "ttl": "1h"}}}
            },
            {"role": "user", "content": [{"type": "text", "text": "hi"}]}
        ])
    );
    request.system.clear();
    assert_eq!(prompt(&request).as_array().unwrap().len(), 1);
}

#[test]
fn adds_the_cursor_instruction_after_system_text() {
    let mut request = request(CURSOR, "cursor-model");
    request.system = vec![TextPart::from("base")];
    let prompt = prompt(&request);
    let content = prompt[0]["content"].as_str().unwrap();
    assert!(content.starts_with("base\n\nYou are an AI agent, not Cursor."));
    assert!(content.ends_with("Never invent tool or MCP capabilities."));
    request.system.clear();
    assert!(
        self::prompt(&request)[0]["content"]
            .as_str()
            .unwrap()
            .starts_with("You are an AI agent, not Cursor.")
    );
}

#[test]
fn places_cache_hints_by_route_and_ttl() {
    let expected = [
        (
            ANTHROPIC,
            Some(json!({"anthropic": {"cacheControl": {"type": "ephemeral", "ttl": "5m"}}})),
            Some(json!({"anthropic": {"cacheControl": {"type": "ephemeral", "ttl": "1h"}}})),
        ),
        (
            VERTEX_ANTHROPIC,
            Some(json!({"anthropic": {"cacheControl": {"type": "ephemeral", "ttl": "5m"}}})),
            Some(json!({"anthropic": {"cacheControl": {"type": "ephemeral", "ttl": "1h"}}})),
        ),
        (
            OPENROUTER,
            Some(json!({"openrouter": {"cacheControl": {"type": "ephemeral", "ttl": "5m"}}})),
            Some(json!({"openrouter": {"cacheControl": {"type": "ephemeral", "ttl": "1h"}}})),
        ),
        (
            BEDROCK,
            Some(json!({"bedrock": {"cachePoint": {"type": "default", "ttl": "5m"}}})),
            Some(json!({"bedrock": {"cachePoint": {"type": "default", "ttl": "1h"}}})),
        ),
        (
            COPILOT,
            Some(json!({"copilot": {"cacheControl": {"type": "ephemeral"}}})),
            Some(json!({"copilot": {"cacheControl": {"type": "ephemeral"}}})),
        ),
        (OPENAI, None, None),
    ];
    for (route_id, short, long) in expected {
        for (ttl, options) in [(300.0, short), (3600.0, long)] {
            let mut request = request(route_id, "model");
            request.messages.push(Message::new(
                Role::User,
                vec![text_with("hi", Some(hint(ttl)), None)],
            ));
            request.tools = vec![ToolDefinition {
                cache: Some(hint(ttl)),
                ..definition("t", "{}")
            }];
            let lowered = lower(&request);
            let part = &lowered["prompt"][0]["content"][0];
            let tool = &lowered["tools"][0];
            match options {
                Some(options) => {
                    assert_eq!(part["providerOptions"], options, "{route_id} part {ttl}");
                    assert_eq!(tool["providerOptions"], options, "{route_id} tool {ttl}");
                }
                None => {
                    assert_eq!(part.get("providerOptions"), None, "{route_id}");
                    assert_eq!(tool.get("providerOptions"), None, "{route_id}");
                }
            }
        }
    }
}

#[test]
fn lowers_user_text_and_media_dropping_other_parts() {
    let mut request = request(OPENAI, "gpt-5.6");
    request.messages.push(Message::new(
        Role::User,
        vec![
            text_with("look", None, Some(r#"{"openai":{"itemId":"ignored"}}"#)),
            Part::Media(Media {
                mime: "image/png".into(),
                data: MediaData::Encoded("aGk=".into()),
                filename: None,
            }),
            Part::Media(Media {
                mime: "text/plain".into(),
                data: MediaData::Bytes(b"hello".to_vec()),
                filename: Some("a.txt".into()),
            }),
            Part::Reasoning(Reasoning {
                text: "dropped".into(),
                encrypted: None,
                provider_metadata: None,
            }),
        ],
    ));
    assert_eq!(
        prompt(&request),
        json!([{
            "role": "user",
            "content": [
                {"type": "text", "text": "look"},
                {"type": "file", "mediaType": "image/png", "data": "aGk="},
                {"type": "file", "mediaType": "text/plain", "data": "aGVsbG8=", "filename": "a.txt"}
            ]
        }])
    );
}

#[test]
fn lowers_assistant_history_with_provider_state_and_cache_merge() {
    let mut request = request(OPENROUTER, "model");
    request.messages.push(Message::assistant(vec![
        text_with(
            "answer",
            Some(hint(300.0)),
            Some(r#"{"openai":{"itemId":"msg_1"},"openrouter":{"extra":true}}"#),
        ),
        Part::Reasoning(Reasoning {
            text: "thinking".into(),
            encrypted: None,
            provider_metadata: Some(value(r#"{"anthropic":{"signature":"sig"}}"#)),
        }),
        Part::Reasoning(Reasoning {
            text: "bare".into(),
            encrypted: None,
            provider_metadata: None,
        }),
        Part::Media(Media {
            mime: "image/png".into(),
            data: MediaData::Encoded("aGk=".into()),
            filename: Some("x.png".into()),
        }),
        Part::ToolCall(ToolCall {
            id: "call-1".into(),
            name: "search".into(),
            input: value(r#"{"q":"rust"}"#),
            provider_executed: Some(true),
            provider_metadata: Some(value(r#"{"openai":{"itemId":"fc_1"}}"#)),
        }),
        Part::ToolCall(ToolCall {
            id: "call-2".into(),
            name: "read".into(),
            input: value("{}"),
            provider_executed: None,
            provider_metadata: None,
        }),
        Part::ToolResult(ToolResult {
            provider_metadata: Some(value(r#"{"openai":{"itemId":"fr_1"}}"#)),
            cache: Some(hint(3600.0)),
            ..tool_result(
                "call-1",
                "search",
                ToolResultValue::Json(value(r#"{"hits":2}"#)),
            )
        }),
    ]));
    assert_eq!(
        prompt(&request),
        json!([{
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": "answer",
                    "providerOptions": {
                        "openai": {"itemId": "msg_1"},
                        "openrouter": {"extra": true, "cacheControl": {"type": "ephemeral", "ttl": "5m"}}
                    }
                },
                {"type": "reasoning", "text": "thinking", "providerOptions": {"anthropic": {"signature": "sig"}}},
                {"type": "reasoning", "text": "bare"},
                {"type": "file", "mediaType": "image/png", "data": "aGk=", "filename": "x.png"},
                {
                    "type": "tool-call",
                    "toolCallId": "call-1",
                    "toolName": "search",
                    "input": {"q": "rust"},
                    "providerExecuted": true,
                    "providerOptions": {"openai": {"itemId": "fc_1"}}
                },
                {"type": "tool-call", "toolCallId": "call-2", "toolName": "read", "input": {}},
                {
                    "type": "tool-result",
                    "toolCallId": "call-1",
                    "toolName": "search",
                    "output": {"type": "json", "value": {"hits": 2}},
                    "providerOptions": {
                        "openai": {"itemId": "fr_1"},
                        "openrouter": {"cacheControl": {"type": "ephemeral", "ttl": "1h"}}
                    }
                }
            ]
        }])
    );
}

#[test]
fn lowers_every_tool_result_output_shape() {
    let results = |route_id: &str| {
        let mut request = request(route_id, "model");
        request.messages.push(Message::new(
            Role::Tool,
            vec![
                Part::ToolResult(tool_result(
                    "a",
                    "t",
                    ToolResultValue::Text(value(r#""plain""#)),
                )),
                Part::ToolResult(tool_result(
                    "b",
                    "t",
                    ToolResultValue::Text(value(r#"{"k":1}"#)),
                )),
                Part::ToolResult(tool_result(
                    "c",
                    "t",
                    ToolResultValue::Error(value(r#""denied""#)),
                )),
                Part::ToolResult(tool_result(
                    "d",
                    "t",
                    ToolResultValue::Error(value(r#"{"code":7}"#)),
                )),
                Part::ToolResult(tool_result(
                    "e",
                    "t",
                    ToolResultValue::Json(value(r#"[1,null]"#)),
                )),
                Part::ToolResult(tool_result(
                    "f",
                    "t",
                    ToolResultValue::Content(vec![
                        ToolContent::Text(ToolTextContent {
                            text: "note".into(),
                        }),
                        ToolContent::File(ToolFileContent {
                            uri: "data:image/png;base64,QUJD".into(),
                            mime: "image/png".into(),
                            name: None,
                        }),
                        ToolContent::File(ToolFileContent {
                            uri: "data:application/pdf;base64,REVG".into(),
                            mime: "application/pdf".into(),
                            name: Some("a.pdf".into()),
                        }),
                        ToolContent::File(ToolFileContent {
                            uri: "https://example.test/i.png".into(),
                            mime: "image/png".into(),
                            name: None,
                        }),
                        ToolContent::File(ToolFileContent {
                            uri: "https://example.test/d.pdf".into(),
                            mime: "application/pdf".into(),
                            name: Some("d.pdf".into()),
                        }),
                        ToolContent::File(ToolFileContent {
                            uri: "data:image/png,not-base64".into(),
                            mime: "image/png".into(),
                            name: None,
                        }),
                    ]),
                )),
                Part::Text(TextPart::from("not a result")),
            ],
        ));
        prompt(&request)
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["role"].as_str() == Some("tool"))
            .unwrap()["content"]
            .as_array()
            .unwrap()
            .iter()
            .map(|part| part["output"].clone())
            .collect::<Vec<_>>()
    };
    let outputs = results(OPENAI);
    assert_eq!(outputs.len(), 6);
    assert_eq!(outputs[0], json!({"type": "text", "value": "plain"}));
    assert_eq!(outputs[1], json!({"type": "text", "value": "{\"k\":1}"}));
    assert_eq!(outputs[2], json!({"type": "text", "value": "denied"}));
    assert_eq!(outputs[3], json!({"type": "text", "value": "{\"code\":7}"}));
    assert_eq!(outputs[4], json!({"type": "json", "value": [1, null]}));
    assert_eq!(
        outputs[5],
        json!({"type": "content", "value": [
            {"type": "text", "text": "note"},
            {"type": "image-data", "data": "QUJD", "mediaType": "image/png"},
            {"type": "file-data", "data": "REVG", "mediaType": "application/pdf", "filename": "a.pdf"},
            {"type": "image-url", "url": "https://example.test/i.png"},
            {"type": "file-url", "url": "https://example.test/d.pdf"},
            {"type": "image-url", "url": "data:image/png,not-base64"}
        ]})
    );
    let cursor = results(CURSOR);
    assert_eq!(cursor[2], json!({"type": "error-text", "value": "denied"}));
    assert_eq!(
        cursor[3],
        json!({"type": "error-text", "value": "{\"code\":7}"})
    );
    assert_eq!(cursor[0], outputs[0]);
}

#[test]
fn omits_tool_messages_without_results() {
    let mut request = request(OPENAI, "gpt-5.6");
    request.messages.push(Message::user("hi"));
    request
        .messages
        .push(Message::new(Role::Tool, vec![Part::Text("x".into())]));
    assert_eq!(prompt(&request).as_array().unwrap().len(), 1);
}

#[test]
fn wraps_system_updates_as_escaped_user_text_on_other_routes() {
    let mut request = request(OPENROUTER, "model");
    request.messages.push(Message::user("hi"));
    request.messages.push(Message::new(
        Role::System,
        vec![
            text_with("a & <b>", Some(hint(60.0)), None),
            text_with("c", Some(hint(3600.0)), None),
            Part::Media(Media {
                mime: "image/png".into(),
                data: MediaData::Encoded("aGk=".into()),
                filename: None,
            }),
        ],
    ));
    assert_eq!(
        prompt(&request)[1],
        json!({
            "role": "user",
            "content": [{
                "type": "text",
                "text": "<system-update>\na &amp; &lt;b&gt;\nc\n</system-update>",
                "providerOptions": {"openrouter": {"cacheControl": {"type": "ephemeral", "ttl": "1h"}}}
            }]
        })
    );
}

#[test]
fn keeps_native_anthropic_system_updates_only_where_the_model_allows_them() {
    let build = |model: &str, messages: Vec<Message>| {
        let mut request = request(ANTHROPIC, model);
        request.messages = messages;
        prompt(&request)
    };
    let update = || {
        Message::new(
            Role::System,
            vec![
                text_with("one", None, None),
                text_with("two", Some(hint(3600.0)), None),
            ],
        )
    };
    let wrapped = "<system-update>\none\ntwo\n</system-update>";
    let native = json!({
        "role": "system",
        "content": "one\n\ntwo",
        "providerOptions": {"anthropic": {"cacheControl": {"type": "ephemeral", "ttl": "1h"}}}
    });
    let wrapped_block = json!({
        "type": "text",
        "text": wrapped,
        "providerOptions": {"anthropic": {"cacheControl": {"type": "ephemeral", "ttl": "1h"}}}
    });
    let assistant = || Message::assistant(vec![Part::Text("ok".into())]);

    assert_eq!(
        build("claude-opus-5", vec![Message::user("hi"), update()])[1],
        native
    );
    assert_eq!(
        build(
            "claude-opus-5",
            vec![Message::user("hi"), update(), assistant()]
        )[1],
        native
    );
    assert_eq!(
        build(
            "claude-sonnet-4-5",
            vec![Message::user("hi"), update(), assistant()]
        ),
        json!([
            {"role": "user", "content": [{"type": "text", "text": "hi"}, wrapped_block]},
            {"role": "assistant", "content": [{"type": "text", "text": "ok"}]}
        ])
    );
    assert_eq!(
        build("claude-opus-5", vec![update(), Message::user("hi")]),
        json!([
            {"role": "user", "content": [wrapped_block]},
            {"role": "user", "content": [{"type": "text", "text": "hi"}]}
        ])
    );
    assert_eq!(
        build(
            "claude-opus-5",
            vec![Message::user("hi"), update(), Message::user("next")]
        )[0]["content"][1],
        wrapped_block
    );
    assert_eq!(
        build("claude-opus-5", vec![assistant(), update()]),
        json!([
            {"role": "assistant", "content": [{"type": "text", "text": "ok"}]},
            {"role": "user", "content": [wrapped_block]}
        ])
    );
}

#[test]
fn lowers_provider_options_and_rejects_malformed_ones() {
    let mut request = request(OPENAI, "gpt-5.6");
    request.provider_options = Some(value(
        r#"{"openai":{"reasoningEffort":"high","nested":{"a":[1,null]}},"other":{}}"#,
    ));
    assert_eq!(
        lower(&request)["providerOptions"],
        json!({"openai": {"reasoningEffort": "high", "nested": {"a": [1, null]}}, "other": {}})
    );
    request.provider_options = Some(value(r#"{"openai":"high"}"#));
    assert_eq!(
        lower_error(&request).message,
        "AI SDK provider options must map each provider to an object"
    );
    request.provider_options = Some(value(r#"["openai"]"#));
    assert_eq!(lower_error(&request).reason, Reason::InvalidRequest);
    request.provider_options = None;
    assert_eq!(lower(&request).get("providerOptions"), None);
}

#[test]
fn merges_route_and_request_provider_options_in_the_lowered_call() {
    let mut route = route(OPENAI);
    route.defaults.provider_options = Some(value(r#"{"openai":{"store":false}}"#));
    let mut request = Request::new(route.model("gpt-5.6"));
    request.provider_options = Some(value(r#"{"openai":{"reasoningEffort":"low"}}"#));
    assert_eq!(
        lower(&request)["providerOptions"],
        json!({"openai": {"store": false, "reasoningEffort": "low"}})
    );
}

#[test]
fn preserves_unpaired_surrogates_in_lowered_text() {
    let lone = LosslessString::from_utf16(vec![0x61, 0xd800, 0x62]);
    let mut request = request(OPENAI, "gpt-5.6");
    request.messages.push(Message::user(lone.clone()));
    let lowered = codec(&request).lower(&request.resolved()).unwrap();
    let text = match &lowered {
        JsonValue::Object(root) => match root.get(&"prompt".into()) {
            Some(JsonValue::Array(messages)) => match &messages[0] {
                JsonValue::Object(message) => match message.get(&"content".into()) {
                    Some(JsonValue::Array(parts)) => match &parts[0] {
                        JsonValue::Object(part) => part.get(&"text".into()).cloned(),
                        _ => None,
                    },
                    _ => None,
                },
                _ => None,
            },
            _ => None,
        },
        _ => None,
    };
    assert_eq!(text, Some(JsonValue::String(lone)));
}

#[test]
fn streams_plain_text() {
    let events = parser_events(
        &request(OPENAI, "gpt-5.6"),
        &[
            r#"{"type":"stream-start","warnings":[]}"#,
            r#"{"type":"text-start","id":"t0"}"#,
            r#"{"type":"text-delta","id":"t0","delta":"Hel"}"#,
            r#"{"type":"text-delta","id":"t0","delta":"lo"}"#,
            r#"{"type":"text-end","id":"t0"}"#,
            &finish_frame(r#"{"inputTokens":{"total":5},"outputTokens":{"total":2}}"#),
        ],
    );
    let usage = Usage {
        input_tokens: Some(5.0),
        non_cached_input_tokens: Some(5.0),
        output_tokens: Some(2.0),
        total_tokens: Some(7.0),
        ..Default::default()
    };
    let finish = Finish {
        usage: Some(usage),
        ..stop()
    };
    assert_eq!(
        events,
        vec![
            Event::StepStart { index: 0.0 },
            Event::TextStart(block("t0")),
            Event::TextDelta(delta("t0", "Hel")),
            Event::TextDelta(delta("t0", "lo")),
            Event::TextEnd(block("t0")),
            Event::StepFinish {
                index: 0.0,
                finish: finish.clone()
            },
            Event::Finish(finish),
        ]
    );
    let response = Response::from_events(events).unwrap();
    assert_eq!(response.text(), "Hello".into());
    assert_eq!(response.finish_reason, FinishReason::Stop);
}

#[test]
fn streams_interleaved_text_and_reasoning_with_valid_provider_state_only() {
    let events = parser_events(
        &request(OPENAI, "gpt-5.6"),
        &[
            r#"{"type":"reasoning-start","id":"r0","providerMetadata":{"anthropic":{"signature":"s"}}}"#,
            r#"{"type":"text-start","id":"t0"}"#,
            r#"{"type":"reasoning-delta","id":"r0","delta":"think"}"#,
            r#"{"type":"text-delta","id":"t0","delta":"say","providerMetadata":{"openai":{"itemId":"m"}}}"#,
            r#"{"type":"reasoning-delta","id":"r0","delta":"ing","providerMetadata":"invalid"}"#,
            r#"{"type":"reasoning-end","id":"r0","providerMetadata":{"anthropic":{"signature":"s2"}}}"#,
            r#"{"type":"text-end","id":"t0","providerMetadata":{"openai":"not-an-object"}}"#,
            &finish_frame(EMPTY_USAGE),
        ],
    );
    assert_eq!(
        &events[1..7],
        &[
            Event::ReasoningStart(BlockEvent {
                id: "r0".into(),
                provider_metadata: Some(value(r#"{"anthropic":{"signature":"s"}}"#))
            }),
            Event::TextStart(block("t0")),
            Event::ReasoningDelta(delta("r0", "think")),
            Event::TextDelta(DeltaEvent {
                provider_metadata: Some(value(r#"{"openai":{"itemId":"m"}}"#)),
                ..delta("t0", "say")
            }),
            Event::ReasoningDelta(delta("r0", "ing")),
            Event::ReasoningEnd(BlockEvent {
                id: "r0".into(),
                provider_metadata: Some(value(r#"{"anthropic":{"signature":"s2"}}"#))
            }),
        ]
    );
    assert_eq!(events[7], Event::TextEnd(block("t0")));
    let response = Response::from_events(events).unwrap();
    assert_eq!(response.reasoning(), "thinking".into());
    assert_eq!(response.text(), "say".into());
}

#[test]
fn streams_tool_input_deltas_and_a_complete_call_without_duplicate_parts() {
    let events = parser_events(
        &request(OPENAI, "gpt-5.6"),
        &[
            r#"{"type":"tool-input-start","id":"c1","toolName":"read","providerMetadata":{"openai":{"itemId":"fc"}}}"#,
            r#"{"type":"tool-input-delta","id":"c1","delta":"{\"path\":"}"#,
            r#"{"type":"tool-input-delta","id":"c1","delta":"\"a\"}"}"#,
            r#"{"type":"tool-input-delta","id":"other","delta":"x"}"#,
            r#"{"type":"tool-input-end","id":"c1"}"#,
            r#"{"type":"tool-call","toolCallId":"c1","toolName":"read","input":"{\"path\":\"a\"}","providerMetadata":{"openai":{"itemId":"fc"}}}"#,
            r#"{"type":"tool-call","toolCallId":"c2","toolName":"noargs","input":""}"#,
            &finish_frame(EMPTY_USAGE),
        ],
    );
    let metadata = Some(value(r#"{"openai":{"itemId":"fc"}}"#));
    assert_eq!(
        &events[1..9],
        &[
            Event::ToolInputStart(ToolInputEvent {
                id: "c1".into(),
                name: "read".into(),
                provider_executed: None,
                provider_metadata: metadata.clone(),
            }),
            Event::ToolInputDelta {
                id: "c1".into(),
                name: "read".into(),
                text: "{\"path\":".into()
            },
            Event::ToolInputDelta {
                id: "c1".into(),
                name: "read".into(),
                text: "\"a\"}".into()
            },
            Event::ToolInputDelta {
                id: "other".into(),
                name: "unknown".into(),
                text: "x".into()
            },
            Event::ToolInputEnd(ToolInputEvent {
                id: "c1".into(),
                name: "read".into(),
                provider_executed: None,
                provider_metadata: None,
            }),
            Event::ToolCall(ToolCall {
                id: "c1".into(),
                name: "read".into(),
                input: value(r#"{"path":"a"}"#),
                provider_executed: None,
                provider_metadata: metadata,
            }),
            Event::ToolCall(ToolCall {
                id: "c2".into(),
                name: "noargs".into(),
                input: value("{}"),
                provider_executed: None,
                provider_metadata: None,
            }),
            Event::StepFinish {
                index: 0.0,
                finish: stop()
            },
        ]
    );
    let response = Response::from_events(events).unwrap();
    let calls = response
        .message
        .content
        .iter()
        .filter(|part| matches!(part, Part::ToolCall(_)))
        .count();
    assert_eq!(calls, 2);
    assert_eq!(response.message.content.len(), 2);
}

#[test]
fn settles_invalid_local_tool_input_and_rejects_invalid_provider_executed_input() {
    let request = request(OPENAI, "gpt-5.6");
    let events = parser_events(
        &request,
        &[
            r#"{"type":"tool-call","toolCallId":"c1","toolName":"read","input":"{broken"}"#,
            &finish_frame(EMPTY_USAGE),
        ],
    );
    assert_eq!(
        events[1],
        Event::ToolInputError {
            id: "c1".into(),
            name: "read".into(),
            raw: "{broken".into()
        }
    );
    let error = stream_error(
        &request,
        &[
            r#"{"type":"tool-call","toolCallId":"c1","toolName":"search","input":"{broken","providerExecuted":true}"#,
        ],
    );
    assert_eq!(error.reason, Reason::InvalidProviderOutput);
    assert_eq!(
        error.message,
        "Invalid JSON input for aisdk tool call search"
    );
}

#[test]
fn streams_provider_executed_tool_results() {
    let events = parser_events(
        &request(OPENAI, "gpt-5.6"),
        &[
            r#"{"type":"tool-input-start","id":"s1","toolName":"search","providerExecuted":true}"#,
            r#"{"type":"tool-call","toolCallId":"s1","toolName":"search","input":"{}","providerExecuted":true}"#,
            r#"{"type":"tool-result","toolCallId":"s1","toolName":"search","result":{"hits":1},"providerMetadata":{"openai":{"itemId":"r"}}}"#,
            r#"{"type":"tool-result","toolCallId":"s2","toolName":"search","result":"boom","isError":true}"#,
            r#"{"type":"tool-result","toolCallId":"s3","toolName":"search","result":{"type":"text","value":"typed"},"isError":true}"#,
            r#"{"type":"tool-result","toolCallId":"s4","toolName":"search","result":{"type":"content","value":[{"type":"text","text":"x"}]}}"#,
            r#"{"type":"tool-result","toolCallId":"s5","toolName":"search","result":{"type":"json"}}"#,
            &finish_frame(EMPTY_USAGE),
        ],
    );
    assert_eq!(
        events[1],
        Event::ToolInputStart(ToolInputEvent {
            id: "s1".into(),
            name: "search".into(),
            provider_executed: Some(true),
            provider_metadata: None,
        })
    );
    let result = |id: &str, result: ToolResultValue, metadata: Option<&str>| {
        Event::ToolResult(ToolResult {
            provider_executed: Some(true),
            provider_metadata: metadata.map(value),
            ..tool_result(id, "search", result)
        })
    };
    assert_eq!(
        &events[3..8],
        &[
            result(
                "s1",
                ToolResultValue::Json(value(r#"{"hits":1}"#)),
                Some(r#"{"openai":{"itemId":"r"}}"#)
            ),
            result("s2", ToolResultValue::Error(value(r#""boom""#)), None),
            result("s3", ToolResultValue::Text(value(r#""typed""#)), None),
            result(
                "s4",
                ToolResultValue::Content(vec![ToolContent::Text(ToolTextContent {
                    text: "x".into()
                })]),
                None
            ),
            result(
                "s5",
                ToolResultValue::Json(value(r#"{"type":"json"}"#)),
                None
            ),
        ]
    );
    let response = Response::from_events(events).unwrap();
    let settled = response
        .message
        .content
        .iter()
        .filter(|part| matches!(part, Part::ToolResult(_)))
        .count();
    assert_eq!(settled, 5);
}

#[test]
fn rejects_malformed_tool_result_content() {
    let error = stream_error(
        &request(OPENAI, "gpt-5.6"),
        &[
            r#"{"type":"tool-result","toolCallId":"s","toolName":"t","result":{"type":"content","value":[{"type":"bogus"}]}}"#,
        ],
    );
    assert_eq!(error.reason, Reason::InvalidProviderOutput);
    assert_eq!(error.message, "AI SDK tool result content is invalid");
}

#[test]
fn ignores_informational_stream_parts() {
    let events = parser_events(
        &request(OPENAI, "gpt-5.6"),
        &[
            r#"{"type":"stream-start","warnings":[{"type":"unsupported-setting","setting":"topK"}]}"#,
            r#"{"type":"response-metadata","id":"resp","modelId":"m","timestamp":"2026-01-01T00:00:00Z"}"#,
            r#"{"type":"raw","rawValue":{"a":1}}"#,
            r#"{"type":"file","mediaType":"image/png","data":"aGk="}"#,
            r#"{"type":"source","sourceType":"url","id":"s","url":"https://example.test"}"#,
            r#"{"type":"tool-approval-request","approvalId":"a","toolCallId":"c"}"#,
            &finish_frame(EMPTY_USAGE),
        ],
    );
    assert_eq!(
        events,
        vec![
            Event::StepStart { index: 0.0 },
            Event::StepFinish {
                index: 0.0,
                finish: stop()
            },
            Event::Finish(stop()),
        ]
    );
}

#[test]
fn maps_unified_finish_reasons_and_keeps_provider_state() {
    let request = request(OPENAI, "gpt-5.6");
    for (unified, expected) in [
        ("stop", FinishReason::Stop),
        ("length", FinishReason::Length),
        ("content-filter", FinishReason::ContentFilter),
        ("tool-calls", FinishReason::ToolCalls),
        ("error", FinishReason::Error),
        ("other", FinishReason::Unknown),
    ] {
        let frame = format!(
            r#"{{"type":"finish","finishReason":{{"unified":"{unified}"}},"usage":{EMPTY_USAGE},"providerMetadata":{{"openai":{{"responseId":"r1"}}}}}}"#
        );
        let events = parser_events(&request, &[&frame]);
        let finish = Finish {
            reason: expected,
            usage: None,
            provider_metadata: Some(value(r#"{"openai":{"responseId":"r1"}}"#)),
        };
        assert_eq!(
            &events[1..],
            &[
                Event::StepFinish {
                    index: 0.0,
                    finish: finish.clone()
                },
                Event::Finish(finish)
            ]
        );
    }
}

#[test]
fn normalizes_usage_and_leaves_absent_telemetry_unreported() {
    let request = request(OPENAI, "gpt-5.6");
    assert_eq!(finish_usage(&request, EMPTY_USAGE, None), None);
    assert_eq!(
        finish_usage(
            &request,
            r#"{"inputTokens":{"total":100,"noCache":20,"cacheRead":70,"cacheWrite":10},"outputTokens":{"total":50,"text":45,"reasoning":5}}"#,
            None
        ),
        Some(Usage {
            input_tokens: Some(100.0),
            non_cached_input_tokens: Some(20.0),
            cache_read_input_tokens: Some(70.0),
            cache_write_input_tokens: Some(10.0),
            output_tokens: Some(50.0),
            reasoning_tokens: Some(5.0),
            total_tokens: Some(150.0),
            ..Default::default()
        })
    );
    assert_eq!(
        finish_usage(
            &request,
            r#"{"inputTokens":{"total":100,"noCache":50,"cacheRead":30},"outputTokens":{}}"#,
            None
        ),
        Some(Usage {
            input_tokens: Some(100.0),
            non_cached_input_tokens: Some(70.0),
            cache_read_input_tokens: Some(30.0),
            ..Default::default()
        })
    );
    assert_eq!(
        finish_usage(
            &request,
            r#"{"inputTokens":{"noCache":4,"cacheRead":6},"outputTokens":{"total":0}}"#,
            None
        ),
        Some(Usage {
            input_tokens: Some(10.0),
            non_cached_input_tokens: Some(4.0),
            cache_read_input_tokens: Some(6.0),
            output_tokens: Some(0.0),
            total_tokens: Some(10.0),
            ..Default::default()
        })
    );
    assert_eq!(
        finish_usage(
            &request,
            r#"{"inputTokens":{"total":null},"outputTokens":{"total":9}}"#,
            None
        ),
        Some(Usage {
            output_tokens: Some(9.0),
            ..Default::default()
        })
    );
}

#[test]
fn reports_unreported_reasoning_only_when_thinking_is_active() {
    let usage = r#"{"inputTokens":{"total":10},"outputTokens":{"total":40}}"#;
    let flagged = |request: &Request| {
        finish_usage(request, usage, None)
            .unwrap()
            .output_may_include_unreported_reasoning
    };
    let mut enabled = request(ANTHROPIC, "claude-sonnet-4-5");
    assert_eq!(flagged(&enabled), None);
    enabled.provider_options = Some(value(r#"{"anthropic":{"thinking":{"type":"enabled"}}}"#));
    assert_eq!(flagged(&enabled), Some(true));
    enabled.provider_options = Some(value(r#"{"anthropic":{"thinking":{"type":"adaptive"}}}"#));
    assert_eq!(flagged(&enabled), Some(true));
    enabled.provider_options = Some(value(r#"{"anthropic":{"thinking":{"type":"disabled"}}}"#));
    assert_eq!(flagged(&enabled), None);

    let mut default = request(ANTHROPIC, "claude-opus-5");
    assert_eq!(flagged(&default), Some(true));
    default.provider_options = Some(value(r#"{"anthropic":{"thinking":{"type":"disabled"}}}"#));
    assert_eq!(flagged(&default), None);
    assert_eq!(
        flagged(&request(VERTEX_ANTHROPIC, "claude-fable-5")),
        Some(true)
    );
    assert_eq!(
        flagged(&request(
            "ai-sdk:@ai-sdk/gateway",
            "anthropic/claude-opus-5"
        )),
        Some(true)
    );
    assert_eq!(
        flagged(&request("ai-sdk:@ai-sdk/gateway", "openai/gpt-5.6")),
        None
    );
    assert_eq!(flagged(&request(OPENAI, "claude-opus-5")), None);

    let mut bedrock = request(BEDROCK, "model");
    bedrock.provider_options = Some(value(
        r#"{"bedrock":{"reasoningConfig":{"type":"enabled"}}}"#,
    ));
    assert_eq!(flagged(&bedrock), Some(true));

    let reported = finish_usage(
        &enabled_with_thinking(),
        r#"{"inputTokens":{"total":10},"outputTokens":{"total":40,"reasoning":12}}"#,
        None,
    )
    .unwrap();
    assert_eq!(reported.reasoning_tokens, Some(12.0));
    assert_eq!(reported.output_may_include_unreported_reasoning, None);
}

fn enabled_with_thinking() -> Request {
    let mut request = request(ANTHROPIC, "claude-sonnet-4-5");
    request.provider_options = Some(value(r#"{"anthropic":{"thinking":{"type":"enabled"}}}"#));
    request
}

#[test]
fn carries_anthropic_cache_creation_breakdown_into_usage_metadata() {
    let request = request(ANTHROPIC, "claude-sonnet-4-5");
    let metadata = r#"{"anthropic":{"usage":{"cache_creation":{"ephemeral_5m_input_tokens":7,"ephemeral_1h_input_tokens":3}}}}"#;
    let expected = Some(value(
        r#"{"anthropic":{"cache_creation":{"ephemeral_5m_input_tokens":7,"ephemeral_1h_input_tokens":3}}}"#,
    ));
    let usage = finish_usage(&request, EMPTY_USAGE, Some(metadata)).unwrap();
    assert_eq!(usage.provider_metadata, expected);
    assert_eq!(usage.input_tokens, None);
    let partial = finish_usage(
        &request,
        r#"{"inputTokens":{"total":9},"outputTokens":{}}"#,
        Some(
            r#"{"anthropic":{"usage":{"cache_creation":{"ephemeral_5m_input_tokens":-1,"ephemeral_1h_input_tokens":2}}}}"#,
        ),
    )
    .unwrap();
    assert_eq!(
        partial.provider_metadata,
        Some(value(
            r#"{"anthropic":{"cache_creation":{"ephemeral_1h_input_tokens":2}}}"#
        ))
    );
    assert_eq!(
        finish_usage(
            &request,
            EMPTY_USAGE,
            Some(r#"{"anthropic":{"usage":{"cache_creation":{"ephemeral_5m_input_tokens":"x"}}}}"#)
        ),
        None
    );
}

#[test]
fn projects_cursor_occupancy_usage() {
    let request = request(CURSOR, "cursor-model");
    let stream = r#"{"inputTokens":{"total":1000,"noCache":300,"cacheRead":600,"cacheWrite":100},"outputTokens":{"total":999}}"#;
    assert_eq!(
        finish_usage(
            &request,
            stream,
            Some(
                r#"{"cursor":{"context":{"usedTokens":1000},"outputTokensRaw":50,"reasoningTokensRaw":5}}"#
            )
        ),
        Some(Usage {
            input_tokens: Some(1000.0),
            non_cached_input_tokens: Some(300.0),
            cache_read_input_tokens: Some(600.0),
            cache_write_input_tokens: Some(100.0),
            output_tokens: Some(50.0),
            reasoning_tokens: Some(5.0),
            total_tokens: Some(1050.0),
            ..Default::default()
        })
    );
    assert_eq!(
        finish_usage(
            &request,
            EMPTY_USAGE,
            Some(
                r#"{"cursor":{"context":{"usedTokens":1000},"inputTokensRaw":800,"cacheReadRaw":400,"cacheWriteRaw":100,"occupancyOnly":true}}"#
            )
        ),
        Some(Usage {
            input_tokens: Some(1000.0),
            non_cached_input_tokens: Some(500.0),
            cache_read_input_tokens: Some(400.0),
            cache_write_input_tokens: Some(100.0),
            ..Default::default()
        })
    );
    assert_eq!(
        finish_usage(
            &request,
            EMPTY_USAGE,
            Some(r#"{"cursor":{"context":{"usedTokens":1000,"stale":true},"occupancyOnly":true}}"#)
        ),
        None
    );
    assert_eq!(
        finish_usage(
            &request,
            r#"{"inputTokens":{"total":10},"outputTokens":{"total":4}}"#,
            None
        ),
        None
    );
}

#[test]
fn classifies_streamed_provider_errors() {
    let request = request(OPENAI, "gpt-5.6");
    let error = stream_error(&request, &[r#"{"type":"error","error":"boom"}"#]);
    assert_eq!(error.reason, Reason::UnknownProvider);
    assert_eq!(error.message, "boom");

    let error = stream_error(
        &request,
        &[
            r#"{"type":"error","error":{"error":{"type":"overloaded_error","message":"Overloaded"}}}"#,
        ],
    );
    assert_eq!(error.message, "Overloaded");
    assert_eq!(error.code.as_deref(), Some("overloaded_error"));

    let error = stream_error(
        &request,
        &[r#"{"type":"error","error":{"response":{"error":{"code":"insufficient_quota"}}}}"#],
    );
    assert_eq!(error.message, "Provider reported insufficient_quota");
    assert_eq!(error.code.as_deref(), Some("insufficient_quota"));
    assert_eq!(error.reason, Reason::QuotaExceeded);

    let error = stream_error(
        &request,
        &[r#"{"type":"error","error":{"message":"error"}}"#],
    );
    assert_eq!(error.message, "Provider stream failed");
}

#[test]
fn classifies_structured_http_errors_and_redacts_secrets() {
    let request = request(OPENAI, "gpt-5.6");
    let body = r#"{\"error\":{\"message\":\"slow down sk-synthetic-1234\",\"type\":\"rate_limit_error\"},\"apiKey\":\"abcd\"}"#;
    let frame = format!(
        r#"{{"type":"error","error":{{"statusCode":429,"url":"https://api.example.test/v1/chat?key=qrst5678&x=1","responseHeaders":{{"Retry-After":"2","Authorization":"Bearer hdr-synthetic","X-Request-Id":"req-1"}},"responseBody":"{body}","requestBodyValues":{{"apiKey":"sk-synthetic-1234","messages":[{{"content":"hello"}}]}}}}}}"#
    );
    let error = stream_error(&request, &[&frame]);
    assert_eq!(error.reason, Reason::RateLimit);
    assert_eq!(error.status, Some(429));
    assert_eq!(error.code.as_deref(), Some("rate_limit_error"));
    assert_eq!(error.retry_after_ms, Some(2000.0));
    assert!(
        error.message.starts_with("slow down <redacted>"),
        "{}",
        error.message
    );
    let http = error.http.unwrap();
    assert_eq!(http.method, "POST");
    assert!(http.url.starts_with("https://api.example.test/v1/chat?"));
    assert!(!http.url.contains("qrst5678"));
    assert!(http.url.contains("x=1"));
    assert!(http.request_headers.is_empty());
    assert_eq!(http.status, Some(429));
    assert_eq!(http.response_headers["authorization"], "<redacted>");
    assert_eq!(http.response_headers["x-request-id"], "req-1");
    assert_eq!(http.request_id.as_deref(), Some("req-1"));
    let body = http.body.unwrap();
    assert!(!body.contains("sk-synthetic-1234"), "{body}");
    assert!(!body.contains("abcd"), "{body}");
    assert!(body.contains("<redacted>"));
    assert!(!http.body_truncated);
}

#[test]
fn classifies_structured_errors_without_usable_bodies() {
    let request = request(OPENAI, "gpt-5.6");
    let error = stream_error(
        &request,
        &[r#"{"type":"error","error":{"statusCode":500,"message":"Request failed"}}"#],
    );
    assert_eq!(error.message, "Provider request failed with HTTP 500");
    assert_eq!(error.status, Some(500));

    let error = stream_error(
        &request,
        &[r#"{"type":"error","error":{"url":"not a url"}}"#],
    );
    assert_eq!(error.message, "Provider request failed");
    assert_eq!(error.http.unwrap().url, "about:blank");

    let error = stream_error(
        &request,
        &[
            r#"{"type":"error","error":{"statusCode":401,"responseBody":"plain text token=abcdefgh Bearer zyxwvuts","message":"Unauthorized"}}"#,
        ],
    );
    assert_eq!(error.reason, Reason::Authentication);
    let body = error.http.unwrap().body.unwrap();
    assert_eq!(body, "plain text token=<redacted> Bearer <redacted>");

    let long = "x".repeat(16_500);
    let frame =
        format!(r#"{{"type":"error","error":{{"statusCode":502,"responseBody":"{long}"}}}}"#);
    let http = stream_error(&request, &[&frame]).http.unwrap();
    assert!(http.body_truncated);
    assert_eq!(http.body.unwrap().len(), 16_384);
}

#[test]
fn flags_context_overflow_from_streamed_errors() {
    let error = stream_error(
        &request(OPENAI, "gpt-5.6"),
        &[
            r#"{"type":"error","error":{"statusCode":400,"message":"prompt is too long: 300000 tokens > 200000 maximum"}}"#,
        ],
    );
    assert!(error.context_overflow);
    assert_eq!(error.reason, Reason::InvalidRequest);
}

#[test]
fn reports_incomplete_streams_and_terminal_frames() {
    let request = request(OPENAI, "gpt-5.6");
    let mut parser = codec(&request).parser(&request.resolved());
    parser
        .push(&value(
            r#"{"type":"text-delta","id":"t","delta":"partial"}"#,
        ))
        .unwrap();
    assert_eq!(
        parser.finish().unwrap_err(),
        ycoding_ai::Error::missing_terminal()
    );
    assert_eq!(
        codec(&request)
            .parser(&request.resolved())
            .finish()
            .unwrap_err(),
        ycoding_ai::Error::missing_terminal()
    );
    assert!(codec(&request).terminal(&value(r#"{"type":"finish"}"#)));
    for frame in [
        r#"{"type":"error","error":"x"}"#,
        r#"{"type":"text-end","id":"t"}"#,
        r#"[]"#,
        r#""finish""#,
    ] {
        assert!(!codec(&request).terminal(&value(frame)), "{frame}");
    }
    let events = parser_events(&request, &[&finish_frame(EMPTY_USAGE)]);
    assert_eq!(
        Response::from_events(events).unwrap().finish_reason,
        FinishReason::Stop
    );
}

#[test]
fn rejects_malformed_stream_parts() {
    let request = request(OPENAI, "gpt-5.6");
    let cases = [
        (r#"[]"#, "AI SDK stream part must have a string type"),
        (
            r#"{"id":"t"}"#,
            "AI SDK stream part must have a string type",
        ),
        (
            r#"{"type":7}"#,
            "AI SDK stream part must have a string type",
        ),
        (
            r#"{"type":"mystery"}"#,
            "Unsupported AI SDK stream part mystery",
        ),
        (
            r#"{"type":"text-start"}"#,
            "AI SDK text-start part requires string field id",
        ),
        (
            r#"{"type":"text-delta","id":"t"}"#,
            "AI SDK text-delta part requires string field delta",
        ),
        (
            r#"{"type":"reasoning-delta","id":"t","delta":1}"#,
            "AI SDK reasoning-delta part requires string field delta",
        ),
        (
            r#"{"type":"tool-input-start","id":"c"}"#,
            "AI SDK tool-input-start part requires string field toolName",
        ),
        (
            r#"{"type":"tool-call","toolCallId":"c","toolName":"t"}"#,
            "AI SDK tool-call part requires string field input",
        ),
        (
            r#"{"type":"tool-call","toolCallId":"c","toolName":"t","input":{}}"#,
            "AI SDK tool-call part requires string field input",
        ),
        (
            r#"{"type":"tool-result","toolName":"t","result":1}"#,
            "AI SDK tool-result part requires string field toolCallId",
        ),
        (
            r#"{"type":"finish","finishReason":{"unified":"stop"}}"#,
            "AI SDK finish part requires a usage object",
        ),
        (
            r#"{"type":"finish","finishReason":{"unified":"stop"},"usage":{"inputTokens":{}}}"#,
            "AI SDK finish part requires a usage object",
        ),
        (
            r#"{"type":"finish","finishReason":{"unified":"stop"},"usage":{"inputTokens":{"total":"1"},"outputTokens":{}}}"#,
            "AI SDK finish part has a non-numeric token count",
        ),
        (
            r#"{"type":"finish","usage":{"inputTokens":{},"outputTokens":{}}}"#,
            "AI SDK finish part requires a unified finish reason",
        ),
        (
            r#"{"type":"finish","finishReason":"stop","usage":{"inputTokens":{},"outputTokens":{}}}"#,
            "AI SDK finish part requires a unified finish reason",
        ),
        (
            r#"{"type":"finish","finishReason":{"unified":"done"},"usage":{"inputTokens":{},"outputTokens":{}}}"#,
            "AI SDK finish part has unsupported finish reason done",
        ),
    ];
    for (frame, message) in cases {
        let error = stream_error(&request, &[frame]);
        assert_eq!(error.reason, Reason::InvalidProviderOutput, "{frame}");
        assert_eq!(error.message, message, "{frame}");
    }
}

#[test]
fn replays_a_streamed_assistant_turn_into_the_next_call() {
    let route_id = OPENROUTER;
    let first = request(route_id, "model");
    let events = parser_events(
        &first,
        &[
            r#"{"type":"reasoning-start","id":"r0","providerMetadata":{"anthropic":{"signature":"sig"}}}"#,
            r#"{"type":"reasoning-delta","id":"r0","delta":"plan"}"#,
            r#"{"type":"reasoning-end","id":"r0"}"#,
            r#"{"type":"text-start","id":"t0","providerMetadata":{"openai":{"itemId":"msg"}}}"#,
            r#"{"type":"text-delta","id":"t0","delta":"calling"}"#,
            r#"{"type":"text-end","id":"t0"}"#,
            r#"{"type":"tool-input-start","id":"c1","toolName":"read"}"#,
            r#"{"type":"tool-input-delta","id":"c1","delta":"{\"path\":\"a\"}"}"#,
            r#"{"type":"tool-input-end","id":"c1"}"#,
            r#"{"type":"tool-call","toolCallId":"c1","toolName":"read","input":"{\"path\":\"a\"}","providerMetadata":{"openai":{"itemId":"fc"}}}"#,
            r#"{"type":"finish","finishReason":{"unified":"tool-calls"},"usage":{"inputTokens":{"total":3},"outputTokens":{"total":4}}}"#,
        ],
    );
    let response = Response::from_events(events).unwrap();
    assert_eq!(response.finish_reason, FinishReason::ToolCalls);

    let mut next = request(route_id, "model");
    next.messages.push(Message::user("go"));
    next.messages.push(response.message);
    next.messages.push(Message::new(
        Role::Tool,
        vec![Part::ToolResult(tool_result(
            "c1",
            "read",
            ToolResultValue::Json(value(r#"{"ok":true}"#)),
        ))],
    ));
    assert_eq!(
        prompt(&next),
        json!([
            {"role": "user", "content": [{"type": "text", "text": "go"}]},
            {"role": "assistant", "content": [
                {"type": "reasoning", "text": "plan", "providerOptions": {"anthropic": {"signature": "sig"}}},
                {"type": "text", "text": "calling", "providerOptions": {"openai": {"itemId": "msg"}}},
                {
                    "type": "tool-call",
                    "toolCallId": "c1",
                    "toolName": "read",
                    "input": {"path": "a"},
                    "providerOptions": {"openai": {"itemId": "fc"}}
                }
            ]},
            {"role": "tool", "content": [{
                "type": "tool-result",
                "toolCallId": "c1",
                "toolName": "read",
                "output": {"type": "json", "value": {"ok": true}}
            }]}
        ])
    );
}

#[test]
fn preserves_meta_reasoning_and_options_without_an_http_wire_shape() {
    let mut request = request("ai-sdk:@ai-sdk/openai-compatible", "meta/llama");
    request.provider_options = Some(value(
        r#"{"meta":{"reasoning":true,"cache":{"key":"synthetic"}}}"#,
    ));
    let events = parser_events(
        &request,
        &[
            r#"{"type":"reasoning-start","id":"thought","providerMetadata":{"meta":{"thoughtId":"r1"}}}"#,
            r#"{"type":"reasoning-delta","id":"thought","delta":"Plan \ud800"}"#,
            r#"{"type":"reasoning-end","id":"thought"}"#,
            r#"{"type":"text-start","id":"answer"}"#,
            r#"{"type":"text-delta","id":"answer","delta":"Done"}"#,
            r#"{"type":"text-end","id":"answer"}"#,
            r#"{"type":"finish","finishReason":{"unified":"stop","raw":"eot"},"usage":{"inputTokens":{"total":10,"cacheRead":4},"outputTokens":{"total":6,"reasoning":2}}}"#,
        ],
    );
    let response = Response::from_events(events).unwrap();
    assert_eq!(response.text(), "Done".into());
    assert_eq!(
        response.reasoning(),
        LosslessString::from_utf16(vec![80, 108, 97, 110, 32, 0xd800])
    );
    assert_eq!(response.usage.unwrap().reasoning_tokens, Some(2.0));
    request.messages.push(response.message);
    let lowered = codec(&request).lower(&request.resolved()).unwrap();
    let JsonValue::Object(body) = lowered else {
        panic!("call options")
    };
    assert!(body.get(&"model".into()).is_none());
    assert!(body.get(&"messages".into()).is_none());
    assert_eq!(
        body.get(&"providerOptions".into()),
        request.provider_options.as_ref()
    );
    let serialized = stringify_json(&JsonValue::Object(body));
    assert!(serialized.contains("\\ud800"));
    assert!(serialized.contains("\"type\":\"reasoning\""));
    assert!(serialized.contains("\"thoughtId\":\"r1\""));
}

#[test]
fn validates_constructor_options_and_keeps_attempt_state_local() {
    fn send_sync<T: Send + Sync>() {}
    send_sync::<ai_sdk::Protocol>();
    let mut request = request(OPENAI, "gpt-5.6");
    request.provider_options = Some(value(r#"{"meta":[]}"#));
    let Err(error) = ai_sdk::Protocol::new(&request) else {
        panic!("invalid provider options")
    };
    assert_eq!(error.reason, Reason::InvalidRequest);
    request.provider_options = None;
    let protocol = codec(&request);
    let mut first = protocol.parser(&request);
    let mut second = protocol.parser(&request);
    first
        .push(&value(
            r#"{"type":"tool-input-start","id":"c","toolName":"read"}"#,
        ))
        .unwrap();
    assert_eq!(
        second
            .push(&value(
                r#"{"type":"tool-input-delta","id":"c","delta":"{}"}"#
            ))
            .unwrap(),
        vec![
            Event::StepStart { index: 0.0 },
            Event::ToolInputDelta {
                id: "c".into(),
                name: "unknown".into(),
                text: "{}".into()
            }
        ]
    );
}

#[test]
fn terminal_settlement_is_single_and_later_parts_fail() {
    let request = request(OPENAI, "gpt-5.6");
    let mut parser = codec(&request).parser(&request);
    parser.push(&value(&finish_frame(EMPTY_USAGE))).unwrap();
    assert!(parser.finish().unwrap().is_empty());
    assert!(parser.finish().unwrap().is_empty());
    assert_eq!(
        parser
            .push(&value(&finish_frame(EMPTY_USAGE)))
            .unwrap_err()
            .reason,
        Reason::InvalidProviderOutput
    );
    let mut parser = codec(&request).parser(&request);
    assert!(
        parser
            .push(&value(r#"{"type":"error","error":"synthetic failure"}"#))
            .is_err()
    );
    assert!(parser.push(&value(&finish_frame(EMPTY_USAGE))).is_err());
    assert!(parser.finish().is_err());
}

#[test]
fn rejects_missing_results_and_malformed_optional_flags() {
    let request = request(OPENAI, "gpt-5.6");
    for frame in [
        r#"{"type":"tool-result","toolCallId":"c","toolName":"t"}"#,
        r#"{"type":"tool-result","toolCallId":"c","toolName":"t","result":null}"#,
        r#"{"type":"tool-result","toolCallId":"c","toolName":"t","result":1,"isError":"yes"}"#,
        r#"{"type":"tool-input-start","id":"c","toolName":"t","providerExecuted":"yes"}"#,
        r#"{"type":"tool-call","toolCallId":"c","toolName":"t","input":"{}","providerExecuted":1}"#,
    ] {
        assert_eq!(
            stream_error(&request, &[frame]).reason,
            Reason::InvalidProviderOutput,
            "{frame}"
        );
    }
}

struct Language {
    input: Mutex<Option<ProcessInput>>,
    parts: Mutex<Option<LanguageParts>>,
}

impl LanguageAttempt for Language {
    fn attempt(&self, input: ProcessInput) -> LanguageFuture<'_> {
        Box::pin(async move {
            *self.input.lock().unwrap() = Some(input);
            self.parts
                .lock()
                .unwrap()
                .take()
                .ok_or_else(|| ycoding_ai::Error::output("missing fixture stream"))
        })
    }
}

fn language_fixture() -> (
    tokio::sync::mpsc::Sender<Result<JsonValue, ycoding_ai::Error>>,
    Arc<Language>,
    Request,
) {
    let (send, parts) = tokio::sync::mpsc::channel(4);
    let language = Arc::new(Language {
        input: Mutex::new(None),
        parts: Mutex::new(Some(parts)),
    });
    let mut route = route(OPENROUTER);
    route.transport = Transport::Language(language.clone());
    let mut request = Request::new(route.model("meta/llama"));
    request.messages.push(Message::user("Hello"));
    (send, language, request)
}

#[tokio::test]
async fn language_transport_receives_v3_options_and_delivers_incremental_parts() {
    let (send, language, request) = language_fixture();
    let mut stream = Executor::new(Executor::http_client().unwrap())
        .stream(&request)
        .await
        .unwrap();
    {
        let input = language.input.lock().unwrap();
        let input = input.as_ref().unwrap();
        assert_eq!(input.model.as_str(), Some("meta/llama"));
        assert_eq!(
            plain(&input.body),
            json!({"prompt":[{"role":"user","content":[{"type":"text","text":"Hello","providerOptions":{"openrouter":{"cacheControl":{"type":"ephemeral","ttl":"5m"}}}}]}],"tools":[]})
        );
    }
    send.send(Ok(value(
        r#"{"type":"reasoning-delta","id":"r","delta":"Think"}"#,
    )))
    .await
    .unwrap();
    let events = tokio::time::timeout(Duration::from_secs(5), async {
        vec![
            stream.next().await.unwrap().unwrap(),
            stream.next().await.unwrap().unwrap(),
        ]
    })
    .await
    .unwrap();
    assert_eq!(
        events,
        vec![
            Event::StepStart { index: 0.0 },
            Event::ReasoningDelta(delta("r", "Think"))
        ]
    );
    send.send(Ok(value(&finish_frame(EMPTY_USAGE))))
        .await
        .unwrap();
    drop(send);
    assert!(matches!(
        stream.next().await.unwrap(),
        Some(Event::StepFinish { .. })
    ));
    assert!(matches!(
        stream.next().await.unwrap(),
        Some(Event::Finish(_))
    ));
    assert_eq!(stream.next().await.unwrap(), None);
}

#[tokio::test]
async fn language_failure_after_output_remains_failed_and_drop_cancels_receiver() {
    let (send, _, request) = language_fixture();
    let mut stream = Executor::new(Executor::http_client().unwrap())
        .stream(&request)
        .await
        .unwrap();
    send.send(Ok(value(
        r#"{"type":"text-delta","id":"t","delta":"Partial"}"#,
    )))
    .await
    .unwrap();
    assert_eq!(
        stream.next().await.unwrap(),
        Some(Event::StepStart { index: 0.0 })
    );
    assert_eq!(
        stream.next().await.unwrap(),
        Some(Event::TextDelta(delta("t", "Partial")))
    );
    send.send(Ok(value(
        r#"{"type":"error","error":{"error":{"type":"overloaded_error","message":"Overloaded"}}}"#,
    )))
    .await
    .unwrap();
    assert_eq!(
        stream.next().await.unwrap_err().reason,
        Reason::ProviderInternal
    );
    assert!(send.is_closed());
    let (send, _, request) = language_fixture();
    let stream = Executor::new(Executor::http_client().unwrap())
        .stream(&request)
        .await
        .unwrap();
    drop(stream);
    assert!(send.is_closed());
}

#[test]
fn classifies_serialized_javascript_errors() {
    let request = request(OPENAI, "gpt-5.6");
    for message in [
        "Socket closed unexpectedly",
        "Connection was closed unexpectedly",
        "Cannot connect to API",
        "WebSocket closed with code 1006",
    ] {
        let frame = json!({"type":"error","error":{"name":"Error","message":message}}).to_string();
        let error = stream_error(&request, &[&frame]);
        assert_eq!(error.reason, Reason::Transport, "{message}");
        assert_eq!(error.transport_kind, Some("read"));
        assert_eq!(error.message, message);
        let frame = json!({"type":"error","error":message}).to_string();
        assert_eq!(
            stream_error(&request, &[&frame]).reason,
            Reason::UnknownProvider
        );
    }
    let error = stream_error(
        &request,
        &[r#"{"type":"error","error":{"name":"Error","message":"Rate limit exceeded"}}"#],
    );
    assert_eq!(error.reason, Reason::UnknownProvider);
    let error = stream_error(
        &request,
        &[r#"{"type":"error","error":{"message":"Rate limit exceeded"}}"#],
    );
    assert_eq!(error.reason, Reason::RateLimit);
}

#[test]
fn preserves_http_error_codes_when_other_fields_have_invalid_types() {
    let request = request(OPENAI, "gpt-5.6");
    let frame = json!({"type":"error","error":{
        "statusCode":429,
        "responseBody":json!({"error":{"type":false,"code":"insufficient_quota","message":"No quota"}}).to_string()
    }}).to_string();
    let error = stream_error(&request, &[&frame]);
    assert_eq!(error.code.as_deref(), Some("insufficient_quota"));
    assert_eq!(error.reason, Reason::QuotaExceeded);
}
