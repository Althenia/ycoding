use ycoding_ai::{
    auth::{Auth, Credential},
    cache::{Hint, Policy},
    framing::Sse,
    gemini::Gemini,
    google,
    llm::{
        Event, FinishReason, Media, MediaData, Message, Part, Request, Response, Role, ToolCall,
        ToolChoice, ToolDefinition, ToolResult, ToolResultValue,
    },
    route::Protocol,
};
use ycoding_schema::{
    JsonValue, LosslessString,
    llm::{ToolContent, ToolFileContent, ToolTextContent},
    parse_json, stringify_json,
};

fn value(text: &str) -> JsonValue {
    parse_json(text).unwrap()
}
fn request() -> Request {
    Request::new(
        google::route(google::Config {
            api_key: Some(Credential::value("fixture")),
            ..Default::default()
        })
        .model("gemini-2.5-flash"),
    )
}
fn tool(schema: &str) -> ToolDefinition {
    ToolDefinition {
        name: "lookup".into(),
        description: "Lookup data".into(),
        input_schema: value(schema),
        output_schema: None,
        cache: None,
        metadata: None,
        native: None,
    }
}
fn response(frames: &[&str]) -> Response {
    let mut parser = Gemini::parser(&request());
    let mut events = Vec::new();
    for frame in frames {
        events.extend(parser.push(&value(frame)).unwrap());
    }
    events.extend(parser.finish().unwrap());
    Response::from_events(events).unwrap()
}

#[test]
fn request_lowering_and_catalog_options_reach_wire() {
    let mut route = google::route(google::Config {
        api_key: Some(Credential::value("fixture")),
        base_url: Some("https://generativelanguage.test/v1beta/".into()),
        ..Default::default()
    });
    route.defaults.provider_options = Some(value(
        r#"{"gemini":{"thinkingConfig":{"thinkingBudget":1024,"includeThoughts":true,"ignored":1}},"google":{"thinkingConfig":{"thinkingBudget":99}}}"#,
    ));
    route.defaults.http.body = Some(value(
        r#"{"safetySettings":[],"cachedContent":"cachedContents/fixture"}"#,
    ));
    route
        .defaults
        .http
        .headers
        .insert("x-application".into(), "ycoding".into());
    let mut model = route.model("gemini-3.5-flash");
    model.defaults.provider_options = Some(value(
        r#"{"gemini":{"thinkingConfig":{"thinkingBudget":2048}}}"#,
    ));
    let mut request = Request::new(model);
    request.system = vec!["You are concise.".into(), "Use tools.".into()];
    request.messages = vec![
        Message::user("Before."),
        Message::system("<update>&"),
        Message::assistant(vec![Part::Text("After.".into())]),
    ];
    request.generation.max_tokens = Some(20.0);
    request.generation.temperature = Some(0.0);
    request.generation.top_p = Some(0.9);
    request.generation.top_k = Some(4.0);
    request.generation.stop = Some(vec!["STOP".into()]);
    request.provider_options = Some(value(
        r#"{"gemini":{"thinkingConfig":{"includeThoughts":false}}}"#,
    ));
    let prepared = route.prepare(&request).unwrap();
    assert_eq!(
        prepared.url.as_str(),
        "https://generativelanguage.test/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse"
    );
    assert_eq!(prepared.headers["x-goog-api-key"], "fixture");
    assert_eq!(prepared.headers["x-application"], "ycoding");
    assert_eq!(
        prepared.encoded_body,
        r#"{"contents":[{"role":"user","parts":[{"text":"Before."},{"text":"<system-update>\n&lt;update&gt;&amp;\n</system-update>"}]},{"role":"model","parts":[{"text":"After."}]}],"systemInstruction":{"parts":[{"text":"You are concise.\nUse tools."}]},"generationConfig":{"maxOutputTokens":20,"temperature":0,"topP":0.9,"topK":4,"stopSequences":["STOP"],"thinkingConfig":{"thinkingBudget":2048,"includeThoughts":false}},"safetySettings":[],"cachedContent":"cachedContents/fixture"}"#
    );
    assert!(!stringify_json(&prepared.body).contains("safetySettings"));
    for id in ["gemini-1.5-pro", "gemini-2.5-flash", "gemini-3.5-flash"] {
        let mut request = Request::new(route.model(id));
        request.provider_options = Some(value(
            r#"{"gemini":{"thinkingConfig":{"thinkingBudget":-1,"includeThoughts":false}}}"#,
        ));
        assert!(
            stringify_json(&route.prepare(&request).unwrap().body)
                .contains(r#""thinkingConfig":{"thinkingBudget":-1,"includeThoughts":false}"#)
        );
    }
    let mut plain =
        Request::new(google::route(google::Config::default()).model("gemini-2.5-flash"));
    plain.provider_options = Some(value(
        r#"{"gemini":{"thinkingConfig":{"thinkingBudget":"1024","includeThoughts":1}},"google":{"thinkingConfig":{"thinkingBudget":1024}}}"#,
    ));
    assert_eq!(Gemini.lower(&plain).unwrap(), value(r#"{"contents":[]}"#));
    plain.http.body = Some(value(r#"{"generationConfig":{"temperature":1}}"#));
    assert!(
        plain
            .model
            .route
            .prepare(&plain)
            .unwrap_err()
            .message
            .contains("protocol-owned")
    );
}

#[test]
fn tools_schema_projection_and_none_choice() {
    let mut request = request();
    request.messages.push(Message::user("Use the tool."));
    request.tools.push(tool(r#"{"type":"object","required":["status","missing"],"properties":{"status":{"type":"integer","enum":[1,2]},"tags":{"type":"array"},"name":{"type":"string","properties":{"ignored":{"type":"string"}},"required":["ignored"]},"maybe":{"type":["string","null"],"const":"fixed","additionalProperties":false},"empty":{"type":"object"}},"additionalProperties":false}"#));
    request.tool_choice = Some(ToolChoice::Tool("lookup".into()));
    assert_eq!(
        stringify_json(&Gemini.lower(&request).unwrap()),
        r#"{"contents":[{"role":"user","parts":[{"text":"Use the tool."}]}],"tools":[{"functionDeclarations":[{"name":"lookup","description":"Lookup data","parameters":{"required":["status"],"type":"object","properties":{"status":{"type":"string","enum":["1","2"]},"tags":{"type":"array","items":{"type":"string"}},"name":{"type":"string"},"maybe":{"type":"string","nullable":true,"enum":["fixed"]}}}}]}],"toolConfig":{"functionCallingConfig":{"mode":"ANY","allowedFunctionNames":["lookup"]}}}"#
    );
    for (choice, mode) in [(ToolChoice::Auto, "AUTO"), (ToolChoice::Required, "ANY")] {
        request.tool_choice = Some(choice);
        assert!(
            stringify_json(&Gemini.lower(&request).unwrap())
                .contains(&format!(r#""mode":"{mode}""#))
        );
    }
    request.tool_choice = Some(ToolChoice::None);
    assert_eq!(
        Gemini.lower(&request).unwrap(),
        value(r#"{"contents":[{"role":"user","parts":[{"text":"Use the tool."}]}]}"#)
    );
    request.tool_choice = None;
    request.tools = vec![tool(r#"{"type":"object"}"#)];
    assert!(!stringify_json(&Gemini.lower(&request).unwrap()).contains("parameters"));
    request.model.tool_schema = Some(ycoding_ai::llm::ToolSchemaCompatibility::Gemini);
    assert!(stringify_json(&Gemini.lower(&request).unwrap()).contains(r#""parameters":{}"#));
}

#[test]
fn multimodal_input_results_and_recoverable_media_errors() {
    let mut request = request();
    request.tools = vec![tool(
        r#"{"type":"object","properties":{"query":{"type":"string"}}}"#,
    )];
    request.messages = vec![
        Message::new(
            Role::User,
            vec![
                Part::Text("What is in this image?".into()),
                Part::Media(Media {
                    mime: "IMAGE/PNG".into(),
                    data: MediaData::Bytes(vec![0, 1, 2, 3]),
                    filename: None,
                }),
            ],
        ),
        Message::assistant(vec![Part::ToolCall(ToolCall {
            id: "call_1".into(),
            name: "lookup".into(),
            input: value(r#"{"query":"weather"}"#),
            provider_executed: None,
            provider_metadata: None,
        })]),
        Message::new(
            Role::Tool,
            vec![Part::ToolResult(ToolResult {
                id: "call_1".into(),
                name: "lookup".into(),
                result: ToolResultValue::Content(vec![
                    ToolContent::Text(ToolTextContent {
                        text: "Image read successfully".into(),
                    }),
                    ToolContent::File(ToolFileContent {
                        uri: "data:image/png;base64,AAECAw==".into(),
                        mime: "image/png".into(),
                        name: Some("pixel.png".into()),
                    }),
                ]),
                cache: None,
                provider_executed: None,
                provider_metadata: None,
                output: None,
            })],
        ),
    ];
    let body = stringify_json(&Gemini.lower(&request).unwrap());
    assert!(body.contains(r#"{"inlineData":{"mimeType":"image/png","data":"AAECAw=="}}"#));
    assert!(body.contains(r#"{"functionResponse":{"name":"lookup","response":{"name":"lookup","content":"Image read successfully"}}},{"inlineData":{"mimeType":"image/png","data":"AAECAw=="}}"#));
    for (mime, data, failure) in [
        ("image/png", "data:image/jpeg;base64,/9j/", "does not match"),
        (
            "image/png",
            "data:image/png;charset=utf8;base64,AAEC",
            "data URL must contain valid base64",
        ),
        (
            "image/png",
            "data:image/png;base64,AA=E",
            "data URL must contain valid base64",
        ),
        ("image/png", "%%%=", "valid base64"),
        ("image/png", "AB==", "canonical base64"),
        ("image/svg+xml", "PHN2Zz4=", "does not support"),
    ] {
        request.messages = vec![Message::new(
            Role::User,
            vec![Part::Media(Media {
                mime: mime.into(),
                data: MediaData::Encoded(data.into()),
                filename: None,
            })],
        )];
        let body = stringify_json(&Gemini.lower(&request).unwrap());
        assert!(body.contains("File (unnamed)"));
        assert!(body.contains(failure), "{body}");
        assert!(!body.contains("inlineData"));
    }
    for mime in [
        "image/jpeg",
        "image/gif",
        "image/webp",
        "video/mp4",
        "video/webm",
        "video/quicktime",
        "audio/wav",
        "audio/mp3",
        "audio/aiff",
        "audio/aac",
        "audio/ogg",
        "audio/flac",
    ] {
        request.messages = vec![Message::new(
            Role::User,
            vec![Part::Media(Media {
                mime: mime.into(),
                data: MediaData::Encoded("AAEC".into()),
                filename: None,
            })],
        )];
        assert!(stringify_json(&Gemini.lower(&request).unwrap()).contains("inlineData"));
    }
    request.messages = vec![Message::assistant(vec![Part::Media(Media {
        mime: "image/png".into(),
        data: MediaData::Encoded("AAEC".into()),
        filename: None,
    })])];
    assert!(
        Gemini
            .lower(&request)
            .unwrap_err()
            .message
            .contains("assistant messages only support text, reasoning, and tool-call")
    );
}

#[test]
fn reasoning_signatures_usage_lifecycle_and_replay() {
    let response = response(&[
        r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"thinking","thought":true}]}}]}"#,
        r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"","thought":true,"thoughtSignature":"thought_sig"},{"text":"Hello"}]}}]}"#,
        r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"!"},{"functionCall":{"name":"lookup","args":{"query":"weather"}},"thoughtSignature":"tool_sig"}]},"finishReason":"STOP"}]}"#,
        r#"{"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7,"thoughtsTokenCount":1,"cachedContentTokenCount":1,"ignored":900}}"#,
    ]);
    assert_eq!(response.text().as_str(), Some("Hello!"));
    assert_eq!(response.reasoning().as_str(), Some("thinking"));
    assert_eq!(response.finish_reason, FinishReason::ToolCalls);
    let usage = response.usage.unwrap();
    assert_eq!(
        (
            usage.input_tokens,
            usage.output_tokens,
            usage.non_cached_input_tokens,
            usage.cache_read_input_tokens,
            usage.reasoning_tokens,
            usage.total_tokens
        ),
        (
            Some(5.0),
            Some(3.0),
            Some(4.0),
            Some(1.0),
            Some(1.0),
            Some(7.0)
        )
    );
    assert_eq!(usage.visible_output_tokens(), 2.0);
    assert_eq!(usage.cache_write_input_tokens, None);
    assert_eq!(usage.output_may_include_unreported_reasoning, None);
    assert_eq!(
        usage.provider_metadata,
        Some(value(
            r#"{"google":{"cachedContentTokenCount":1,"thoughtsTokenCount":1,"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}"#
        ))
    );
    assert!(matches!(&response.events[0], Event::StepStart { index } if *index == 0.0));
    assert!(
        matches!(&response.events[1], Event::ReasoningStart(block) if block.provider_metadata.is_none())
    );
    assert!(
        matches!(&response.events[3], Event::ReasoningEnd(block) if block.provider_metadata == Some(value(r#"{"google":{"thoughtSignature":"thought_sig"}}"#)))
    );
    assert!(matches!(&response.events[4], Event::TextStart(_)));
    assert!(matches!(&response.events[8], Event::TextEnd(_)));
    assert!(matches!(&response.events[9], Event::StepFinish { .. }));
    assert!(matches!(&response.events[10], Event::Finish(_)));
    let mut request = request();
    request.messages.push(response.message);
    let encoded = stringify_json(&Gemini.lower(&request).unwrap());
    assert!(
        encoded.contains(r#"{"text":"thinking","thought":true,"thoughtSignature":"thought_sig"}"#)
    );
    assert!(encoded.contains(r#"{"functionCall":{"name":"lookup","args":{"query":"weather"}},"thoughtSignature":"tool_sig"}"#));
}

#[test]
fn function_args_are_complete_values_not_accumulated_fragments() {
    let response = response(&[
        r#"{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"lookup","args":"{\"q\":"}}]}}]}"#,
        r#"{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"lookup","args":{"q":"ไทย"}}},{"functionCall":{"name":"lookup","args":null}}]},"finishReason":"STOP"}]}"#,
    ]);
    let calls: Vec<_> = response
        .events
        .iter()
        .filter_map(|event| {
            if let Event::ToolCall(call) = event {
                Some(call)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(calls.len(), 3);
    assert_eq!(calls[0].id.as_str(), Some("tool_0"));
    assert_eq!(calls[0].input, value(r#""{\"q\":""#));
    assert_eq!(calls[1].id.as_str(), Some("tool_1"));
    assert_eq!(calls[1].input, value(r#"{"q":"ไทย"}"#));
    assert_eq!(calls[2].id.as_str(), Some("tool_2"));
    assert_eq!(calls[2].input, JsonValue::Null);
    assert!(!response.events.iter().any(|event| matches!(
        event,
        Event::ToolInputDelta { .. } | Event::ToolInputError { .. }
    )));
}

#[test]
fn finish_reasons_usage_absence_zero_and_replacement() {
    for (reason, expected) in [
        ("STOP", FinishReason::Stop),
        ("MAX_TOKENS", FinishReason::Length),
        ("SAFETY", FinishReason::ContentFilter),
        ("IMAGE_SAFETY", FinishReason::ContentFilter),
        ("RECITATION", FinishReason::ContentFilter),
        ("BLOCKLIST", FinishReason::ContentFilter),
        ("PROHIBITED_CONTENT", FinishReason::ContentFilter),
        ("SPII", FinishReason::ContentFilter),
        ("MALFORMED_FUNCTION_CALL", FinishReason::Error),
        ("OTHER", FinishReason::Unknown),
    ] {
        let frame = format!(r#"{{"candidates":[{{"finishReason":"{reason}"}}]}}"#);
        let response = response(&[&frame]);
        assert_eq!(response.finish_reason, expected);
        assert_eq!(response.events.len(), 3);
        assert!(response.usage.is_none());
    }
    for (raw, input, read, non_cached, output, reasoning, total) in [
        ("{}", None, None, None, None, None, None),
        (
            r#"{"thoughtsTokenCount":1}"#,
            None,
            None,
            None,
            None,
            Some(1.0),
            None,
        ),
        (
            r#"{"cachedContentTokenCount":0}"#,
            Some(0.0),
            Some(0.0),
            Some(0.0),
            None,
            None,
            None,
        ),
        (
            r#"{"promptTokenCount":5,"cachedContentTokenCount":8,"candidatesTokenCount":0}"#,
            Some(5.0),
            Some(5.0),
            Some(0.0),
            Some(0.0),
            None,
            Some(5.0),
        ),
        (
            r#"{"promptTokenCount":-1,"cachedContentTokenCount":-3,"candidatesTokenCount":2,"thoughtsTokenCount":3}"#,
            Some(0.0),
            Some(0.0),
            Some(0.0),
            Some(5.0),
            Some(3.0),
            Some(4.0),
        ),
    ] {
        let frame = format!(r#"{{"usageMetadata":{raw}}}"#);
        let usage = response(&[&frame]).usage.unwrap();
        assert_eq!(
            (
                usage.input_tokens,
                usage.cache_read_input_tokens,
                usage.non_cached_input_tokens,
                usage.output_tokens,
                usage.reasoning_tokens,
                usage.total_tokens
            ),
            (input, read, non_cached, output, reasoning, total),
            "{raw}"
        );
    }
    let usage = response(&[
        r#"{"usageMetadata":{"promptTokenCount":8,"cachedContentTokenCount":2}}"#,
        r#"{"usageMetadata":{"candidatesTokenCount":1}}"#,
    ])
    .usage
    .unwrap();
    assert_eq!(usage.input_tokens, None);
    assert_eq!(usage.cache_read_input_tokens, None);
    assert_eq!(usage.output_tokens, Some(1.0));
}

#[test]
fn stream_validation_missing_terminal_and_extra_fields() {
    for frame in [
        "[]",
        r#"{"candidates":null}"#,
        r#"{"usageMetadata":{"promptTokenCount":null}}"#,
        r#"{"candidates":[{"finishReason":1}]}"#,
        r#"{"candidates":[{"content":{"role":"assistant","parts":[]}}]}"#,
        r#"{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":1,"args":{}}}]}}]}"#,
        r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"x","thought":1}]}}]}"#,
    ] {
        assert!(
            Gemini::parser(&request()).push(&value(frame)).is_err(),
            "{frame}"
        );
    }
    let mut parser = Gemini::parser(&request());
    parser
        .push(&value(r#"{"error":{"message":"not protocol data"}}"#))
        .unwrap();
    assert!(parser.finish().is_err());
    let mut parser = Gemini::parser(&request());
    parser
        .push(&value(
            r#"{"candidates":[{"finishReason":"STOP"}],"extra":true}"#,
        ))
        .unwrap();
    parser.finish().unwrap();
    assert!(
        parser
            .push(&value(
                r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"late"}]}}]}"#
            ))
            .is_err()
    );
}

#[test]
fn function_call_and_response_require_their_unknown_value_fields() {
    for frame in [
        r#"{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"lookup"}}]}}]}"#,
        r#"{"candidates":[{"content":{"role":"model","parts":[{"functionResponse":{"name":"lookup"}}]}}]}"#,
    ] {
        assert!(Gemini::parser(&request()).push(&value(frame)).is_err());
    }
}

#[test]
fn media_limits_produce_notices_without_inline_payloads() {
    for (data, limit) in [
        (
            MediaData::Encoded("A".repeat(28 * 1024 * 1024 + 4).into()),
            "encoded limit",
        ),
        (
            MediaData::Encoded("A".repeat(28 * 1024 * 1024).into()),
            "decoded limit",
        ),
        (
            MediaData::Bytes(vec![0; 20 * 1024 * 1024 + 1]),
            "decoded limit",
        ),
    ] {
        let mut request = request();
        request.messages.push(Message::new(
            Role::User,
            vec![Part::Media(Media {
                mime: "image/png".into(),
                data,
                filename: Some("large.png".into()),
            })],
        ));
        let encoded = stringify_json(&Gemini.lower(&request).unwrap());
        assert!(encoded.contains("File large.png (image/png) omitted:"));
        assert!(encoded.contains(limit));
        assert!(!encoded.contains("inlineData"));
    }
}

#[test]
fn tool_result_text_json_error_and_empty_content_preserve_values() {
    for (result, expected) in [
        (
            ToolResultValue::Json(value(r#"{"forecast":"sunny"}"#)),
            r#"{\"forecast\":\"sunny\"}"#,
        ),
        (ToolResultValue::Text(value(r#""sunny""#)), "sunny"),
        (
            ToolResultValue::Text(value(r#"{"forecast":"sunny"}"#)),
            "[object Object]",
        ),
        (
            ToolResultValue::Error(value(r#"{"message":"failed"}"#)),
            r#"{\"message\":\"failed\"}"#,
        ),
        (ToolResultValue::Error(value(r#""failed""#)), "failed"),
        (ToolResultValue::Content(Vec::new()), ""),
    ] {
        let mut request = request();
        request.messages.push(Message::new(
            Role::Tool,
            vec![Part::ToolResult(ToolResult {
                id: "call_1".into(),
                name: "lookup".into(),
                result,
                cache: None,
                provider_executed: None,
                provider_metadata: None,
                output: None,
            })],
        ));
        assert_eq!(
            stringify_json(&Gemini.lower(&request).unwrap()),
            format!(
                r#"{{"contents":[{{"role":"user","parts":[{{"functionResponse":{{"name":"lookup","response":{{"name":"lookup","content":"{expected}"}}}}}}]}}]}}"#
            )
        );
    }
}

#[test]
fn sse_utf8_and_every_frame_split_preserve_events_and_surrogates() {
    let wire = "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"ไทย🦀\"}]},\"finishReason\":\"STOP\"}]}\r\n\r\ndata: {\"usageMetadata\":{\"promptTokenCount\":5}}\n\ndata: [DONE]\n\n";
    for split in 0..=wire.len() {
        let mut framing = Sse::default();
        let mut parser = Gemini::parser(&request());
        let mut events = Vec::new();
        for chunk in [&wire.as_bytes()[..split], &wire.as_bytes()[split..]] {
            for frame in framing.push(chunk) {
                events.extend(parser.push(&value(&frame)).unwrap());
            }
        }
        assert!(framing.finish().is_empty());
        events.extend(parser.finish().unwrap());
        let response = Response::from_events(events).unwrap();
        assert_eq!(response.text().as_str(), Some("ไทย🦀"));
        assert_eq!(response.usage.unwrap().input_tokens, Some(5.0));
    }
    let response = response(&[
        r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"\ud800"}]},"finishReason":"STOP"}]}"#,
    ]);
    assert_eq!(response.text(), LosslessString::from_utf16(vec![0xd800]));
    let mut request = request();
    request.messages.push(response.message);
    assert!(stringify_json(&Gemini.lower(&request).unwrap()).contains(r#""text":"\ud800""#));
}

#[test]
fn cache_hints_do_not_change_gemini_prefix_or_wire() {
    let mut request = request();
    request.system.push("stable".into());
    request.messages.push(Message::user("hello"));
    request.tools.push(tool(r#"{"type":"object"}"#));
    let baseline = request.model.route.prepare(&request).unwrap().encoded_body;
    request.cache = Policy::None;
    request.system[0].cache = Some(Hint::ephemeral(Some(3600.0)));
    request.tools[0].cache = Some(Hint::ephemeral(None));
    assert_eq!(
        request.model.route.prepare(&request).unwrap().encoded_body,
        baseline
    );
    let route = google::route(google::Config {
        api_key: Some(Credential::value("unused")),
        auth: Some(Auth::bearer(Credential::value("override"))),
        ..Default::default()
    });
    let prepared = route.prepare(&Request::new(route.model("gemini"))).unwrap();
    assert_eq!(prepared.headers["authorization"], "Bearer override");
    assert!(!prepared.headers.contains_key("x-goog-api-key"));
    assert!(!format!("{prepared:?}").contains("override"));
}
