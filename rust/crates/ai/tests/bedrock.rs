use ycoding_ai::{
    auth::{Auth, Credential, Input, Secret},
    bedrock::{self, BedrockConverse, Config},
    bedrock_auth::{self, Credentials},
    cache::{Hint, Policy},
    framing::AwsEventStream,
    llm::{Event, FinishReason, Message, Part, Request, Response, ToolChoice, ToolDefinition},
    route::{Protocol, Route},
};
use ycoding_schema::{JsonValue, parse_json, stringify_json};

fn j(value: &str) -> JsonValue {
    parse_json(value).unwrap()
}
fn request() -> Request {
    let mut request = Request::new(bedrock::amazon_bedrock(
        "anthropic.claude-v1:0",
        Config {
            endpoint: "https://bedrock-runtime.test".into(),
            auth: Auth::bearer(Credential::value("test-bearer")),
            defaults: Default::default(),
        },
    ));
    request.cache = Policy::None;
    request
}
fn response(frames: &[&str]) -> Result<Response, ycoding_ai::Error> {
    let request = request();
    let mut parser = BedrockConverse.parser(&request);
    let mut events = Vec::new();
    for frame in frames {
        events.extend(parser.push(&j(frame))?);
    }
    events.extend(parser.finish()?);
    Response::from_events(events)
}

#[test]
fn prepared_bytes_and_auth() {
    let mut request = request();
    request.system.push("You are concise.".into());
    request.messages.push(Message::user("Say hello."));
    request.generation.max_tokens = Some(64.0);
    request.generation.temperature = Some(0.0);
    let prepared = request.model.route.prepare(&request).unwrap();
    assert_eq!(
        prepared.encoded_body,
        r#"{"modelId":"anthropic.claude-v1:0","messages":[{"role":"user","content":[{"text":"Say hello."}]}],"system":[{"text":"You are concise."}],"inferenceConfig":{"maxTokens":64,"temperature":0}}"#
    );
    assert_eq!(
        prepared.url.as_str(),
        "https://bedrock-runtime.test/model/anthropic.claude-v1%3A0/converse-stream"
    );
    assert_eq!(prepared.headers["authorization"], "Bearer test-bearer");
    assert!(prepared.headers["authorization"].is_sensitive());
    assert_eq!(request.model.provider.0.as_str(), Some("amazon-bedrock"));
}

#[test]
fn tools_system_cache_and_model_fields() {
    let mut request = request();
    request.tools.push(ToolDefinition {
        name: "lookup".into(),
        description: "Lookup".into(),
        input_schema: j(r#"{"type":"object"}"#),
        output_schema: None,
        cache: Some(Hint::ephemeral(None)),
        metadata: None,
        native: None,
    });
    request.tool_choice = Some(ToolChoice::Required);
    request.system = (0..5)
        .map(|_| {
            let mut part: ycoding_ai::llm::TextPart = "prefix".into();
            part.cache = Some(Hint::ephemeral(Some(3600.0)));
            part
        })
        .collect();
    request.messages = vec![
        Message::user("Before."),
        Message::system("<&Update>"),
        Message::assistant(vec![Part::Text("After.".into())]),
    ];
    request.generation.top_k = Some(40.0);
    request.http.body = Some(j(
        r#"{"additionalModelRequestFields":{"thinking":{"type":"enabled","budget_tokens":1024}}}"#,
    ));
    let prepared = request.model.route.prepare(&request).unwrap();
    let wire = stringify_json(&prepared.wire_body);
    assert_eq!(wire.matches("cachePoint").count(), 4);
    assert!(wire.contains(r#""toolChoice":{"any":{}}"#));
    assert!(wire.contains(r#""additionalModelRequestFields":{"top_k":40,"thinking":{"type":"enabled","budget_tokens":1024}}"#));
    assert!(wire.contains(r#""ttl":"1h"#));
    assert!(wire.contains(r#""content":[{"text":"Before."},{"text":"<system-update>\n&lt;&amp;Update&gt;\n</system-update>"}]"#));
    request.tool_choice = Some(ToolChoice::None);
    assert!(
        !stringify_json(&request.model.route.prepare(&request).unwrap().body)
            .contains("toolConfig")
    );
}

#[test]
fn stop_reason_usage_absent_zero_and_metadata_order() {
    for (stop, reason) in [
        ("end_turn", FinishReason::Stop),
        ("stop_sequence", FinishReason::Stop),
        ("max_tokens", FinishReason::Length),
        ("tool_use", FinishReason::ToolCalls),
        ("content_filtered", FinishReason::ContentFilter),
        ("guardrail_intervened", FinishReason::ContentFilter),
        ("unrecognized", FinishReason::Unknown),
        ("malformed_model_output", FinishReason::Unknown),
        ("model_context_window_exceeded", FinishReason::Unknown),
    ] {
        let stop = format!(r#"{{"messageStop":{{"stopReason":"{stop}"}}}}"#);
        let response = response(&[&stop, r#"{"metadata":{"usage":{"inputTokens":5,"outputTokens":2,"totalTokens":7,"cacheReadInputTokens":1,"cacheWriteInputTokens":2}}}"#]).unwrap();
        assert_eq!(response.finish_reason, reason);
        let usage = response.usage.unwrap();
        assert_eq!(
            (usage.input_tokens, usage.total_tokens),
            (Some(8.0), Some(10.0))
        );
        assert_eq!(usage.non_cached_input_tokens, Some(5.0));
        assert_eq!(usage.reasoning_tokens, None);
        assert_eq!(
            response
                .events
                .iter()
                .filter(|e| matches!(e, Event::Finish(_)))
                .count(),
            1
        );
    }
    for (usage, read, write, input) in [
        ("{}", None, None, None),
        (r#"{"cacheReadInputTokens":0}"#, Some(0.0), None, Some(0.0)),
        (r#"{"cacheWriteInputTokens":0}"#, None, Some(0.0), Some(0.0)),
    ] {
        let frame = format!(r#"{{"metadata":{{"usage":{usage}}}}}"#);
        let response = response(&[&frame, r#"{"messageStop":{"stopReason":"end_turn"}}"#]).unwrap();
        let usage = response.usage.unwrap();
        assert_eq!(usage.cache_read_input_tokens, read);
        assert_eq!(usage.cache_write_input_tokens, write);
        assert_eq!(usage.input_tokens, input);
        assert_eq!(usage.total_tokens, input);
    }
    assert!(response(&[]).is_err());
    assert!(response(&[r#"{"messageStop":{"stopReason":7}}"#]).is_err());
    assert!(response(&[r#"{"metadata":{"usage":{"cacheReadInputTokens":null}}}"#]).is_err());
}

#[test]
fn partial_tool_input_and_malformed_tool_are_not_executable() {
    let start = r#"{"contentBlockStart":{"contentBlockIndex":0,"start":{"toolUse":{"toolUseId":"tool_1","name":"lookup"}}}}"#;
    let end = r#"{"contentBlockStop":{"contentBlockIndex":0}}"#;
    let stop = r#"{"messageStop":{"stopReason":"end_turn"}}"#;
    let valid = response(&[start, r#"{"contentBlockDelta":{"contentBlockIndex":0,"delta":{"toolUse":{"input":"{\"query\":"}}}}"#, r#"{"contentBlockDelta":{"contentBlockIndex":0,"delta":{"toolUse":{"input":"\"ไทย\"}"}}}}"#, end, stop]).unwrap();
    assert!(
        valid
            .events
            .iter()
            .any(|e| matches!(e, Event::ToolCall(call) if call.input == j(r#"{"query":"ไทย"}"#)))
    );
    assert_eq!(valid.finish_reason, FinishReason::ToolCalls);
    let malformed = response(&[
        start,
        r#"{"contentBlockDelta":{"contentBlockIndex":0,"delta":{"toolUse":{"input":"{bad"}}}}"#,
        end,
        stop,
    ])
    .unwrap();
    assert!(
        malformed.events.iter().any(
            |e| matches!(e, Event::ToolInputError { raw, .. } if raw.as_str() == Some("{bad"))
        )
    );
    assert!(
        !malformed
            .events
            .iter()
            .any(|e| matches!(e, Event::ToolCall(_)))
    );
    assert_eq!(malformed.finish_reason, FinishReason::ToolCalls);
    assert!(
        response(&[
            r#"{"contentBlockDelta":{"contentBlockIndex":0,"delta":{"toolUse":{"input":"{}"}}}}"#
        ])
        .is_err()
    );
    let empty = response(&[start, end, stop]).unwrap();
    assert!(
        empty
            .events
            .iter()
            .any(|e| matches!(e, Event::ToolCall(call) if call.input == j("{}")))
    );
}

#[test]
fn reasoning_signatures_replay_and_redacted_telemetry() {
    let response = response(&[r#"{"contentBlockDelta":{"contentBlockIndex":0,"delta":{"reasoningContent":{"text":"Think."}}}}"#, r#"{"contentBlockDelta":{"contentBlockIndex":0,"delta":{"reasoningContent":{"signature":"sig_1"}}}}"#, r#"{"contentBlockStop":{"contentBlockIndex":0}}"#, r#"{"contentBlockDelta":{"contentBlockIndex":1,"delta":{"reasoningContent":{"signature":"redacted"}}}}"#, r#"{"contentBlockStop":{"contentBlockIndex":1}}"#, r#"{"messageStop":{"stopReason":"end_turn"}}"#, r#"{"metadata":{"usage":{"outputTokens":12}}}"#]).unwrap();
    assert_eq!(response.reasoning().as_str(), Some("Think."));
    assert_eq!(
        response
            .usage
            .as_ref()
            .unwrap()
            .output_may_include_unreported_reasoning,
        Some(true)
    );
    assert_eq!(
        response
            .events
            .iter()
            .filter(|e| matches!(e, Event::ReasoningStart(_)))
            .count(),
        1
    );
    let mut replay = request();
    replay.messages.push(response.message);
    assert!(
        stringify_json(&replay.model.route.prepare(&replay).unwrap().body)
            .contains(r#""reasoningText":{"text":"Think.","signature":"sig_1"}"#)
    );
}

#[test]
fn stream_exception_classification() {
    use ycoding_ai::provider_error::Reason;
    for (code, message, reason, overflow) in [
        ("throttlingException", "Slow down", Reason::RateLimit, false),
        (
            "validationException",
            "Input is too long for requested model",
            Reason::InvalidRequest,
            true,
        ),
        (
            "internalServerException",
            "Oops",
            Reason::ProviderInternal,
            false,
        ),
        (
            "modelStreamErrorException",
            "Oops",
            Reason::ProviderInternal,
            false,
        ),
        (
            "serviceUnavailableException",
            "Oops",
            Reason::ProviderInternal,
            false,
        ),
    ] {
        let frame = format!(r#"{{"{code}":{{"message":"{message}"}}}}"#);
        let error = response(&[&frame]).unwrap_err();
        assert_eq!(error.reason, reason);
        assert_eq!(error.context_overflow, overflow);
    }
}

#[test]
fn sigv4_ts_fixed_clock_headers_and_missing_credentials() {
    let credentials = Credentials {
        region: "us-east-1".into(),
        access_key_id: Secret::new("AKIDEXAMPLE"),
        secret_access_key: Secret::new("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"),
        session_token: Some(Secret::new("test-token")),
    };
    assert!(!format!("{credentials:?}").contains("AKIDEXAMPLE"));
    let auth = bedrock_auth::sigv4(Some(credentials), || "20150830T123600Z".into());
    let mut headers = reqwest::header::HeaderMap::new();
    for (key, value) in [
        ("content-type", "text/plain"),
        ("x-zeta", "  a\t b  "),
        ("x-alpha", "first"),
        ("x-amzn-trace-id", "ignored"),
        ("authorization", "ignored"),
    ] {
        headers.insert(
            reqwest::header::HeaderName::from_bytes(key.as_bytes()).unwrap(),
            value.parse().unwrap(),
        );
    }
    let headers = auth.apply(Input { method: "POST", url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-v1%3A0/converse-stream?z=two+words&a=2&a=1&=ignored", body: r#"{"modelId":"anthropic.claude-v1:0","messages":[]}"#, headers }).unwrap();
    assert_eq!(
        headers["authorization"],
        "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/bedrock/aws4_request, SignedHeaders=host;x-alpha;x-amz-date;x-amz-security-token;x-zeta, Signature=37892e91bf878b87e1039a9b94cdbb41f889718c9d72bcaf89306ac1c00a802e"
    );
    assert_eq!(headers["content-type"], "application/json");
    assert_eq!(headers["x-amz-date"], "20150830T123600Z");
    assert_eq!(headers["x-amz-security-token"], "test-token");
    assert_eq!(headers["x-zeta"], "a\t b");
    assert!(headers["authorization"].is_sensitive());
    assert!(headers["x-amz-security-token"].is_sensitive());
    let route = Route::bedrock(
        "https://bedrock-runtime.test",
        bedrock_auth::sigv4(None, || "20150830T123600Z".into()),
    );
    assert!(
        route
            .prepare(&Request::new(route.model("nova")))
            .unwrap_err()
            .message
            .contains("requires either route bearer auth or AWS credentials")
    );
}

fn frame(message_type: &str, event_type: &str, extra: &[u8], payload: &str) -> Vec<u8> {
    let mut headers = Vec::new();
    for (name, value) in [(":message-type", message_type), (":event-type", event_type)] {
        headers.push(name.len() as u8);
        headers.extend(name.bytes());
        headers.push(7);
        headers.extend((value.len() as u16).to_be_bytes());
        headers.extend(value.bytes());
    }
    headers.extend(extra);
    let mut bytes = Vec::new();
    bytes.extend(((16 + headers.len() + payload.len()) as u32).to_be_bytes());
    bytes.extend((headers.len() as u32).to_be_bytes());
    bytes.extend(crc32fast::hash(&bytes).to_be_bytes());
    bytes.extend(headers);
    bytes.extend(payload.bytes());
    bytes.extend(crc32fast::hash(&bytes).to_be_bytes());
    bytes
}

#[test]
fn binary_header_types_split_frames_exception_error_crc_and_padding() {
    let mut extra = Vec::new();
    for (kind, value) in [
        (0, vec![]),
        (1, vec![]),
        (2, vec![1]),
        (3, vec![0; 2]),
        (4, vec![0; 4]),
        (5, vec![0; 8]),
        (6, vec![0, 1, 42]),
        (7, vec![0, 1, b'x']),
        (8, vec![0; 8]),
        (9, vec![0; 16]),
    ] {
        extra.extend([1, b'h', kind]);
        extra.extend(value);
    }
    let bytes = frame(
        "event",
        "messageStop",
        &extra,
        r#"{"stopReason":"end_turn","p":"padding"}"#,
    );
    for split in 0..=bytes.len() {
        let mut parser = AwsEventStream::default();
        let mut events = parser.push(&bytes[..split]).unwrap();
        events.extend(parser.push(&bytes[split..]).unwrap());
        assert_eq!(events, [j(r#"{"messageStop":{"stopReason":"end_turn"}}"#)]);
    }
    for message_type in ["exception", "error"] {
        assert!(
            AwsEventStream::default()
                .push(&frame(
                    message_type,
                    "validationException",
                    &[],
                    r#"{"message":"Oops"}"#
                ))
                .unwrap()
                .is_empty()
        );
    }
    let event = frame(
        "event",
        "throttlingException",
        &[],
        r#"{"message":"Slow down"}"#,
    );
    assert_eq!(
        AwsEventStream::default().push(&event).unwrap(),
        [j(r#"{"throttlingException":{"message":"Slow down"}}"#)]
    );
    let mut bad = bytes.clone();
    bad[8] ^= 1;
    let end = bad.len() - 4;
    let crc = crc32fast::hash(&bad[..end]);
    bad[end..].copy_from_slice(&crc.to_be_bytes());
    assert!(AwsEventStream::default().push(&bad).is_err());
    let mut bad = bytes.clone();
    let end = bad.len() - 1;
    bad[end] ^= 1;
    assert!(AwsEventStream::default().push(&bad).is_err());
    assert!(
        AwsEventStream::default()
            .push(&frame("event", "messageStop", &[1, b'h', 10], "{}"))
            .is_err()
    );
    assert!(
        AwsEventStream::default()
            .push(&frame("event", "messageStop", &[], "bad json"))
            .is_err()
    );
    let mut parser = AwsEventStream::default();
    assert!(parser.push(&bytes[..bytes.len() - 1]).unwrap().is_empty());
    assert!(parser.finish().is_empty());
}

#[test]
fn inference_empty_stop_contract() {
    let mut request = request();
    request.generation.stop = Some(Vec::new());
    assert!(
        !stringify_json(&request.model.route.prepare(&request).unwrap().body)
            .contains("inferenceConfig")
    );
    request.generation.max_tokens = Some(10.0);
    assert!(
        stringify_json(&request.model.route.prepare(&request).unwrap().body)
            .contains(r#""inferenceConfig":{"maxTokens":10,"stopSequences":[]}"#)
    );
}

#[test]
fn empty_tool_name_contract() {
    let mut request = request();
    request.tool_choice = Some(ToolChoice::Tool("".into()));
    assert!(
        request
            .model
            .route
            .prepare(&request)
            .unwrap_err()
            .message
            .contains("tool choice requires a tool name")
    );
}

#[test]
fn tool_schema_requires_object_and_unsupported_content_fails() {
    let mut request = request();
    request.tools.push(ToolDefinition {
        name: "lookup".into(),
        description: "Lookup".into(),
        input_schema: j("[]"),
        output_schema: None,
        cache: None,
        metadata: None,
        native: None,
    });
    assert!(request.model.route.prepare(&request).is_err());
    request.tools.clear();
    request.messages = vec![Message::new(
        ycoding_ai::llm::Role::User,
        vec![Part::Reasoning(ycoding_ai::llm::Reasoning {
            text: "unsupported".into(),
            encrypted: None,
            provider_metadata: None,
        })],
    )];
    assert_eq!(
        request.model.route.prepare(&request).unwrap_err().message,
        "Bedrock Converse user messages only support text and media content for now"
    );
}

#[test]
fn media_formats_validation_recovery_and_tool_results() {
    use ycoding_ai::llm::{Media, MediaData, Role, ToolCall, ToolResult, ToolResultValue};
    let mut request = request();
    let formats = [
        ("image/png", "image", "png"),
        ("image/jpg", "image", "jpeg"),
        ("image/jpeg", "image", "jpeg"),
        ("image/gif", "image", "gif"),
        ("image/webp", "image", "webp"),
        ("application/pdf", "document", "pdf"),
        ("text/csv", "document", "csv"),
        ("application/msword", "document", "doc"),
        (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "document",
            "docx",
        ),
        ("application/vnd.ms-excel", "document", "xls"),
        (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "document",
            "xlsx",
        ),
        ("text/html", "document", "html"),
        ("text/plain", "document", "txt"),
        ("text/markdown", "document", "md"),
    ];
    for (mime, kind, format) in formats {
        request.messages = vec![Message::new(
            Role::User,
            vec![Part::Media(Media {
                mime: mime.into(),
                data: MediaData::Bytes(vec![1, 2, 3, 4, 5]),
                filename: None,
            })],
        )];
        let wire = stringify_json(&request.model.route.prepare(&request).unwrap().body);
        let expected = if kind == "image" {
            format!(r#"{{"image":{{"format":"{format}","source":{{"bytes":"AQIDBAU="}}}}}}"#)
        } else {
            format!(
                r#"{{"document":{{"format":"{format}","name":"document.{format}","source":{{"bytes":"AQIDBAU="}}}}}}"#
            )
        };
        assert!(wire.contains(&expected), "{wire}");
    }
    for (mime, data, error) in [
        ("image/svg+xml", "AAAA", "does not support image media type"),
        ("application/x-tar", "AAAA", "does not support media type"),
        ("application/pdf", "bad", "must contain valid base64"),
        ("text/csv", "AB==", "must contain canonical base64"),
        (
            "image/jpg",
            "data:image/jpeg;base64,AAAA",
            "does not match data URL type",
        ),
        (
            "image/png",
            "https://example.test/image",
            "must contain valid base64",
        ),
    ] {
        request.messages = vec![Message::new(
            Role::User,
            vec![Part::Media(Media {
                mime: mime.into(),
                data: MediaData::Encoded(data.into()),
                filename: Some("fixture".into()),
            })],
        )];
        let wire = stringify_json(&request.model.route.prepare(&request).unwrap().body);
        assert!(
            wire.contains(&format!("File fixture ({mime}) omitted: Bedrock Converse"))
                && wire.contains(error),
            "{wire}"
        );
    }
    use ycoding_schema::llm::{ToolContent, ToolFileContent, ToolTextContent};
    let call = ToolCall {
        id: "call_1".into(),
        name: "lookup".into(),
        input: j("{}"),
        provider_executed: None,
        provider_metadata: None,
    };
    let result = ToolResult {
        id: "call_1".into(),
        name: "lookup".into(),
        result: ToolResultValue::Content(vec![
            ToolContent::Text(ToolTextContent {
                text: "screenshot".into(),
            }),
            ToolContent::File(ToolFileContent {
                uri: "data:image/jpg;base64,AAAA".into(),
                mime: "image/jpg".into(),
                name: None,
            }),
            ToolContent::File(ToolFileContent {
                uri: "data:application/pdf;base64,AAAA".into(),
                mime: "application/pdf".into(),
                name: Some("file.pdf".into()),
            }),
        ]),
        cache: Some(Hint::ephemeral(None)),
        provider_executed: None,
        provider_metadata: None,
        output: None,
    };
    request.messages = vec![
        Message::assistant(vec![Part::ToolCall(call)]),
        Message::new(Role::Tool, vec![Part::ToolResult(result)]),
        Message::user("After result."),
    ];
    let wire = stringify_json(&request.model.route.prepare(&request).unwrap().body);
    assert!(wire.contains(r#"{"toolUse":{"toolUseId":"call_1","name":"lookup","input":{}}}"#));
    assert!(wire.contains(r#""content":[{"text":"screenshot"},{"image":{"format":"jpeg","source":{"bytes":"AAAA"}}},{"text":"File file.pdf (application/pdf) omitted: Bedrock Converse only supports image media in tool results"}],"status":"success"}},{"cachePoint":{"type":"default"}},{"text":"After result."}]"#));
    request.messages = vec![Message::new(
        Role::User,
        vec![Part::Media(Media {
            mime: "IMAGE/PNG".into(),
            data: MediaData::Encoded("data:image/png;base64,AAAA".into()),
            filename: None,
        })],
    )];
    assert!(
        stringify_json(&request.model.route.prepare(&request).unwrap().body)
            .contains(r#""source":{"bytes":"AAAA"}"#)
    );
}

#[test]
fn sigv4_signs_exact_overlay_body_and_clock_errors_are_redacted() {
    let credentials = Credentials {
        region: "us-east-1".into(),
        access_key_id: Secret::new("AKIDEXAMPLE"),
        secret_access_key: Secret::new("test-secret"),
        session_token: Some(Secret::new("test-token")),
    };
    let route = Route::bedrock(
        "https://bedrock-runtime.test",
        bedrock_auth::sigv4(Some(credentials.clone()), || "20150830T123600Z".into()),
    );
    let mut request = Request::new(route.model("nova"));
    request.cache = Policy::None;
    request.http.body = Some(j(
        r#"{"additionalModelRequestFields":{"thinking":{"type":"adaptive"}}}"#,
    ));
    let prepared = route.prepare(&request).unwrap();
    assert_eq!(
        prepared.headers["authorization"],
        "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/bedrock/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=012d8481a9128417263f2339b5c1ac61e348904b20971381ed0312c12256f4fa"
    );
    let auth = bedrock_auth::sigv4(Some(credentials), || "test-secret".into());
    let error = auth
        .apply(Input {
            method: "POST",
            url: "https://bedrock-runtime.test",
            body: "{}",
            headers: Default::default(),
        })
        .unwrap_err();
    assert!(!format!("{error:?}").contains("test-secret"));
    assert!(error.message.contains("clock must return YYYYMMDDTHHMMSSZ"));
}

#[test]
fn stream_lifetime_empty_blocks_metadata_only_and_volatile_order() {
    let request = request();
    let mut parser = BedrockConverse.parser(&request);
    assert!(
        parser
            .push(&j(
                r#"{"contentBlockDelta":{"contentBlockIndex":0,"delta":{"text":""}}}"#
            ))
            .unwrap()
            .is_empty()
    );
    assert!(
        parser
            .push(&j(r#"{"messageStop":{"stopReason":"end_turn"}}"#))
            .unwrap()
            .is_empty()
    );
    assert!(
        parser
            .push(&j(r#"{"metadata":{"usage":{"outputTokens":0}}}"#))
            .unwrap()
            .is_empty()
    );
    let events = parser.finish().unwrap();
    assert!(matches!(events[0], Event::StepStart { index: 0.0 }));
    assert!(
        matches!(events.last(), Some(Event::Finish(finish)) if finish.usage.as_ref().unwrap().output_tokens == Some(0.0))
    );
    assert!(parser.finish().unwrap().is_empty());
    assert!(parser.push(&j("{}")).is_err());
    assert_eq!(
        response(&[r#"{"metadata":{}}"#]).unwrap().finish_reason,
        FinishReason::Stop
    );
    let mut volatile = request.clone();
    let mut second = Message::user("Second.");
    second.volatile = true;
    volatile.messages = vec![Message::user("First."), second, Message::user("Third.")];
    let wire = stringify_json(&volatile.model.route.prepare(&volatile).unwrap().body);
    assert_eq!(
        wire,
        r#"{"modelId":"anthropic.claude-v1:0","messages":[{"role":"user","content":[{"text":"First."}]},{"role":"user","content":[{"text":"Second."},{"text":"Third."}]}]}"#
    );
}
