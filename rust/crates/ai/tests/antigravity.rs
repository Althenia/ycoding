use ycoding_ai::{
    antigravity,
    auth::Credential,
    llm::{
        Event, Message, Part, Reasoning, Request, Response, Role, ToolCall, ToolChoice,
        ToolDefinition, ToolResult, ToolResultValue,
    },
};
use ycoding_schema::{
    JsonValue,
    llm::{ToolContent, ToolTextContent},
    parse_json, stringify_json,
};

fn value(text: &str) -> JsonValue {
    parse_json(text).unwrap()
}
fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(fields) => fields.get(&key.into()),
        _ => None,
    }
}
fn text<'a>(value: &'a JsonValue, key: &str) -> Option<&'a str> {
    field(value, key).and_then(|value| match value {
        JsonValue::String(text) => text.as_str(),
        _ => None,
    })
}
fn config() -> antigravity::Config {
    antigravity::Config {
        access: Some(Credential::value("google-access")),
        project: Some("project-1".into()),
        ..Default::default()
    }
}
fn fixture(model: &str) -> Request {
    Request::new(antigravity::route(config()).model(model))
}
fn tool(name: &str, schema: &str) -> ToolDefinition {
    ToolDefinition {
        name: name.into(),
        description: "Look up a fixture".into(),
        input_schema: value(schema),
        output_schema: None,
        cache: None,
        metadata: None,
        native: None,
    }
}
fn lookup() -> ToolDefinition {
    tool(
        "lookup",
        r#"{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}"#,
    )
}
fn inner(prepared: &ycoding_ai::route::Prepared) -> JsonValue {
    field(&prepared.wire_body, "request").unwrap().clone()
}
fn wire_contents(prepared: &ycoding_ai::route::Prepared) -> Vec<JsonValue> {
    match field(&inner(prepared), "contents").unwrap() {
        JsonValue::Array(contents) => contents.clone(),
        _ => panic!("contents must be an array"),
    }
}
fn model_parts(prepared: &ycoding_ai::route::Prepared) -> JsonValue {
    wire_contents(prepared)
        .into_iter()
        .find(|content| text(content, "role") == Some("model"))
        .and_then(|content| field(&content, "parts").cloned())
        .expect("model content parts")
}

#[test]
fn session_id_uses_signed_fnv1a_vectors_and_client_identity() {
    assert_eq!(antigravity::session_id("", ""), "-5808590958014384161");
    assert_eq!(
        antigravity::session_id("ses-a", "gemini-3.8-flash-medium"),
        "4903109517633975494"
    );
    assert_eq!(
        antigravity::session_id("雪", "模型"),
        "-4657986721058320816"
    );
    assert_eq!(antigravity::CLIENT_VERSION, "2.28.2");
    assert!(
        antigravity::user_agent().starts_with("antigravity/hub/2.28.2 (aidev_client; os_type=")
    );
    assert_eq!(
        antigravity::user_agent_for("macos", "aarch64"),
        "antigravity/hub/2.28.2 (aidev_client; os_type=darwin; arch=arm64)"
    );
}

#[test]
fn prepared_envelope_headers_and_session_affinity() {
    let mut request = fixture("gemini-3.8-flash");
    request.messages.push(Message::user("Hi"));
    request
        .http
        .headers
        .insert("x-session-affinity".into(), " ses-a ".into());
    request
        .http
        .headers
        .insert("x-session-id".into(), "secondary".into());
    request
        .http
        .headers
        .insert("x-ycoding-session".into(), "ses-a".into());
    request
        .http
        .headers
        .insert("accept".into(), "text/event-stream".into());
    let prepared = request.model.route.prepare(&request).unwrap();
    assert_eq!(
        prepared.url.as_str(),
        "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
    );
    let mut keys: Vec<_> = prepared
        .headers
        .keys()
        .map(|name| name.as_str().to_owned())
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        ["accept", "authorization", "content-type", "user-agent"]
    );
    assert_eq!(prepared.headers["authorization"], "Bearer google-access");
    assert_eq!(prepared.headers["content-type"], "application/json");
    assert_eq!(prepared.headers["accept"], "text/event-stream");
    assert_eq!(
        prepared.headers["user-agent"].to_str().unwrap(),
        antigravity::user_agent()
    );
    let body = &prepared.wire_body;
    assert_eq!(text(body, "project"), Some("project-1"));
    assert_eq!(text(body, "model"), Some("gemini-3.8-flash"));
    assert_eq!(text(body, "userAgent"), Some("antigravity"));
    assert_eq!(text(body, "requestType"), Some("agent"));
    assert!(field(body, "sessionId").is_none());
    let request_id = text(body, "requestId").unwrap();
    assert_eq!(&request_id[..6], "agent-");
    assert_eq!(request_id.len(), 42);
    assert_eq!(
        text(&inner(&prepared), "sessionId"),
        Some(antigravity::session_id("ses-a", "gemini-3.8-flash").as_str())
    );
}

#[test]
fn session_affinity_falls_back_in_order_and_is_omitted_when_absent() {
    let mut fallback = antigravity::Config {
        session_id: Some(" fallback ".into()),
        ..config()
    };
    fallback.project = None;
    let route = antigravity::route(fallback);
    let mut request = Request::new(route.model("gemini-fixture"));
    request.messages.push(Message::user("Hi"));
    request
        .http
        .headers
        .insert("x-session-affinity".into(), " ".into());
    request
        .http
        .headers
        .insert("x-session-id".into(), " secondary ".into());
    let prepared = request.model.route.prepare(&request).unwrap();
    assert_eq!(
        text(&inner(&prepared), "sessionId"),
        Some(antigravity::session_id("secondary", "gemini-fixture").as_str())
    );
    assert!(field(&prepared.wire_body, "project").is_none());
    let mut keys: Vec<_> = prepared
        .headers
        .keys()
        .map(|name| name.as_str().to_owned())
        .collect();
    keys.sort();
    assert_eq!(keys, ["authorization", "content-type", "user-agent"]);

    let mut request = Request::new(route.model("gemini-fixture"));
    request.messages.push(Message::user("Hi"));
    let prepared = request.model.route.prepare(&request).unwrap();
    assert_eq!(
        text(&inner(&prepared), "sessionId"),
        Some(antigravity::session_id("fallback", "gemini-fixture").as_str())
    );

    let mut request = fixture("gemini-fixture");
    request.messages.push(Message::user("Hi"));
    let prepared = request.model.route.prepare(&request).unwrap();
    assert!(field(&inner(&prepared), "sessionId").is_none());
}

#[test]
fn gateway_model_override_decides_envelope_model_and_affinity() {
    let route = antigravity::route(antigravity::Config {
        gateway_model: Some("gemini-3.8-flash-high".into()),
        ..config()
    });
    let mut request = Request::new(route.model("gemini-3.8-flash"));
    request.messages.push(Message::user("Hi"));
    request
        .http
        .headers
        .insert("x-session-affinity".into(), "ses-a".into());
    let prepared = request.model.route.prepare(&request).unwrap();
    assert_eq!(
        text(&prepared.wire_body, "model"),
        Some("gemini-3.8-flash-high")
    );
    assert_eq!(
        text(&inner(&prepared), "sessionId"),
        Some(antigravity::session_id("ses-a", "gemini-3.8-flash-high").as_str())
    );
}

#[test]
fn tools_disabled_sends_none_without_declarations() {
    let mut request = fixture("gemini-fixture");
    request.messages.push(Message::user("Answer"));
    request.tools = vec![lookup()];
    request.tool_choice = Some(ToolChoice::None);
    let prepared = request.model.route.prepare(&request).unwrap();
    let body = inner(&prepared);
    assert!(field(&body, "tools").is_none());
    assert_eq!(
        field(&body, "toolConfig").cloned(),
        Some(value(r#"{"functionCallingConfig":{"mode":"NONE"}}"#))
    );

    let mut request = fixture("gemini-fixture");
    request.messages.push(Message::user("Answer"));
    let prepared = request.model.route.prepare(&request).unwrap();
    assert!(field(&inner(&prepared), "toolConfig").is_none());
}

#[test]
fn envelope_drops_client_cache_controls_and_trailing_model_contents() {
    let mut request = fixture("gemini-fixture");
    request.messages = vec![
        Message::user("Hi"),
        Message::assistant(vec![Part::Text("Draft".into())]),
    ];
    request.http.body = Some(value(
        r#"{"cachedContent":"cachedContents/fixture","promptCacheOptions":{"type":"ephemeral"},"cacheBreakpoints":[{"index":0}],"safetySettings":[]}"#,
    ));
    let prepared = request.model.route.prepare(&request).unwrap();
    let inner = inner(&prepared);
    assert!(field(&inner, "cachedContent").is_none());
    assert!(field(&inner, "promptCacheOptions").is_none());
    assert!(field(&inner, "cacheBreakpoints").is_none());
    assert!(field(&inner, "safetySettings").is_some());
    let contents = wire_contents(&prepared);
    assert_eq!(contents.len(), 1);
    assert_eq!(text(&contents[0], "role"), Some("user"));
}

fn call(id: &str, name: &str, input: &str, signature: Option<&str>) -> Part {
    Part::ToolCall(ToolCall {
        id: id.into(),
        name: name.into(),
        input: value(input),
        provider_executed: None,
        provider_metadata: signature.map(|signature| {
            value(&format!(
                r#"{{"google":{{"thoughtSignature":"{signature}"}}}}"#
            ))
        }),
    })
}
fn result(id: &str, name: &str, result: ToolResultValue) -> Part {
    Part::ToolResult(ToolResult {
        id: id.into(),
        name: name.into(),
        result,
        cache: None,
        provider_executed: None,
        provider_metadata: None,
        output: None,
    })
}
fn tool_history() -> Vec<Message> {
    vec![
        Message::user("Run them"),
        Message::assistant(vec![
            call("toolu_01", "read", r#"{"path":"a"}"#, Some("sig-a")),
            call("toolu_02", "read", r#"{"path":"b"}"#, None),
            call("toolu_03", "bash", r#"{"command":"ls"}"#, None),
        ]),
        Message::new(
            Role::Tool,
            vec![
                result("toolu_02", "read", ToolResultValue::Text(value(r#""B""#))),
                result(
                    "toolu_01",
                    "read",
                    ToolResultValue::Content(vec![
                        ToolContent::Text(ToolTextContent {
                            text: "first".into(),
                        }),
                        ToolContent::Text(ToolTextContent {
                            text: "second".into(),
                        }),
                    ]),
                ),
                result(
                    "toolu_03",
                    "bash",
                    ToolResultValue::Error(value(r#""Denied by user""#)),
                ),
            ],
        ),
        Message::assistant(vec![Part::Text("Done".into())]),
        Message::user("Next"),
    ]
}

#[test]
fn claude_history_carries_tool_call_ids_and_gemini_history_omits_them() {
    let mut request = fixture("claude-opus-4-6");
    request.messages = tool_history();
    let prepared = request.model.route.prepare(&request).unwrap();
    let contents = wire_contents(&prepared);
    assert_eq!(
        field(&contents[1], "parts").cloned(),
        Some(value(
            r#"[{"functionCall":{"name":"read","args":{"path":"a"},"id":"toolu_01"},"thoughtSignature":"sig-a"},{"functionCall":{"name":"read","args":{"path":"b"},"id":"toolu_02"}},{"functionCall":{"name":"bash","args":{"command":"ls"},"id":"toolu_03"}}]"#
        ))
    );
    assert_eq!(
        field(&contents[2], "parts").cloned(),
        Some(value(
            r#"[{"functionResponse":{"name":"read","response":{"name":"read","content":"B"},"id":"toolu_02"}},{"functionResponse":{"name":"read","response":{"name":"read","content":"first\nsecond"},"id":"toolu_01"}},{"functionResponse":{"name":"bash","response":{"name":"bash","content":"Denied by user"},"id":"toolu_03"}}]"#
        ))
    );
    let again = request.model.route.prepare(&request).unwrap();
    assert_eq!(wire_contents(&again), contents);

    let mut request = fixture("gemini-3.8-flash");
    request.messages = tool_history();
    let prepared = request.model.route.prepare(&request).unwrap();
    let contents = wire_contents(&prepared);
    assert_eq!(
        field(&contents[1], "parts").cloned(),
        Some(value(
            r#"[{"functionCall":{"name":"read","args":{"path":"a"}},"thoughtSignature":"sig-a"},{"functionCall":{"name":"read","args":{"path":"b"}}},{"functionCall":{"name":"bash","args":{"command":"ls"}}}]"#
        ))
    );
    assert!(!stringify_json(&prepared.wire_body).contains("toolu_"));
}

#[test]
fn claude_request_fails_before_sending_without_a_prompt_tool_call_id() {
    let mut request = fixture("claude-opus-4-6");
    let mut messages = tool_history();
    if let Part::ToolCall(call) = &mut messages[1].content[1] {
        call.id = "".into();
    }
    request.messages = messages;
    let error = request.model.route.prepare(&request).unwrap_err();
    assert!(
        error
            .message
            .contains("Antigravity Claude request has a tool call without an id: read"),
        "{}",
        error.message
    );
}

#[test]
fn claude_declarations_use_parameters_json_schema_and_gemini_keeps_parameters() {
    for (model, claude) in [("claude-sonnet-4-6", true), ("gemini-3.8-flash", false)] {
        let mut request = fixture(model);
        request.messages.push(Message::user("Use it"));
        request.tools = vec![lookup()];
        let prepared = request.model.route.prepare(&request).unwrap();
        let inner = inner(&prepared);
        let tools = match field(&inner, "tools").unwrap() {
            JsonValue::Array(tools) => tools.clone(),
            _ => panic!("tools must be an array"),
        };
        let declarations = match field(&tools[0], "functionDeclarations").unwrap() {
            JsonValue::Array(declarations) => declarations.clone(),
            _ => panic!("declarations must be an array"),
        };
        let declaration = &declarations[0];
        assert_eq!(text(declaration, "name"), Some("lookup"));
        if claude {
            assert!(field(declaration, "parameters").is_none());
            let schema = field(declaration, "parametersJsonSchema").unwrap();
            assert_eq!(text(schema, "type"), Some("object"));
            assert!(stringify_json(schema).contains(r#""query""#));
        } else {
            assert!(field(declaration, "parametersJsonSchema").is_none());
            assert!(field(declaration, "parameters").is_some());
        }
    }
}

fn reasoning(text: &str, signature: Option<&str>) -> Part {
    Part::Reasoning(Reasoning {
        text: text.into(),
        encrypted: None,
        provider_metadata: signature.map(|signature| {
            value(&format!(
                r#"{{"google":{{"thoughtSignature":"{signature}"}}}}"#
            ))
        }),
    })
}

#[test]
fn claude_requests_omit_only_unsigned_thinking() {
    let history = vec![
        Message::user("Start"),
        Message::assistant(vec![reasoning("draft", None), Part::Text("kept".into())]),
        Message::assistant(vec![reasoning("signed", Some("sig-1"))]),
        Message::user("Next"),
    ];
    let mut request = fixture("claude-sonnet-5-5");
    request.messages = history.clone();
    let prepared = request.model.route.prepare(&request).unwrap();
    let contents = wire_contents(&prepared);
    assert_eq!(
        field(&contents[1], "parts").cloned(),
        Some(value(r#"[{"text":"kept"}]"#))
    );
    assert_eq!(
        field(&contents[2], "parts").cloned(),
        Some(value(
            r#"[{"text":"signed","thought":true,"thoughtSignature":"sig-1"}]"#
        ))
    );

    let mut request = fixture("claude-sonnet-5-5");
    request.messages = vec![
        Message::user("Start"),
        Message::assistant(vec![reasoning("draft", None)]),
        Message::user("Next"),
    ];
    let prepared = request.model.route.prepare(&request).unwrap();
    let contents = wire_contents(&prepared);
    assert_eq!(contents.len(), 2);
    assert!(contents.iter().all(|c| text(c, "role") == Some("user")));

    let mut request = fixture("gemini-3.8-flash");
    request.messages = history;
    let prepared = request.model.route.prepare(&request).unwrap();
    let contents = wire_contents(&prepared);
    assert_eq!(
        field(&contents[1], "parts").cloned(),
        Some(value(
            r#"[{"text":"draft","thought":true},{"text":"kept"}]"#
        ))
    );
}

fn gateway_frame(parts: &str, finish: bool, usage: bool) -> JsonValue {
    value(&format!(
        r#"{{"response":{{"candidates":[{{"content":{{"role":"model","parts":{parts}}}{finish}}}]{usage}}},"traceId":"t-1"}}"#,
        finish = if finish {
            r#","finishReason":"STOP""#
        } else {
            ""
        },
        usage = if usage {
            r#","usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}"#
        } else {
            ""
        }
    ))
}
fn run_frames(request: &Request, frames: &[JsonValue]) -> Vec<Event> {
    let mut parser = request.model.route.protocol.parser(request);
    let mut events = Vec::new();
    for frame in frames {
        events.extend(parser.push(frame).unwrap());
    }
    events.extend(parser.finish().unwrap());
    events
}
fn kind(event: &Event) -> &'static str {
    match event {
        Event::StepStart { .. } => "step-start",
        Event::TextStart(_) => "text-start",
        Event::TextDelta(_) => "text-delta",
        Event::TextEnd(_) => "text-end",
        Event::ReasoningStart(_) => "reasoning-start",
        Event::ReasoningDelta(_) => "reasoning-delta",
        Event::ReasoningEnd(_) => "reasoning-end",
        Event::ToolInputStart(_) => "tool-input-start",
        Event::ToolInputDelta { .. } => "tool-input-delta",
        Event::ToolInputEnd(_) => "tool-input-end",
        Event::ToolInputError { .. } => "tool-input-error",
        Event::ToolCall(_) => "tool-call",
        Event::ToolResult(_) => "tool-result",
        Event::ToolError { .. } => "tool-error",
        Event::StepFinish { .. } => "step-finish",
        Event::Finish(_) => "finish",
        Event::ProviderError { .. } => "provider-error",
    }
}
fn signature_of(metadata: &Option<JsonValue>) -> Option<String> {
    metadata
        .as_ref()
        .and_then(|metadata| field(metadata, "google"))
        .and_then(|google| text(google, "thoughtSignature"))
        .map(str::to_owned)
}

#[test]
fn interleaved_reasoning_and_tool_calls_preserve_order_and_signatures() {
    let parts = [
        r#"{"text":"First thought","thought":true}"#,
        r#"{"text":"","thoughtSignature":"sig-1"}"#,
        r#"{"functionCall":{"name":"lookup","args":{"query":"a"}}}"#,
        r#"{"text":"Second thought","thought":true}"#,
        r#"{"text":"","thoughtSignature":"sig-2"}"#,
        r#"{"functionCall":{"name":"lookup","args":{"query":"b"}}}"#,
    ];
    for packed in [false, true] {
        let frames: Vec<_> = if packed {
            vec![gateway_frame(&format!("[{}]", parts.join(",")), true, true)]
        } else {
            parts
                .iter()
                .enumerate()
                .map(|(index, part)| {
                    gateway_frame(
                        &format!("[{part}]"),
                        index == parts.len() - 1,
                        index == parts.len() - 1,
                    )
                })
                .collect()
        };
        let mut request = fixture("gemini-fixture");
        request.messages.push(Message::user("Hi"));
        request.tools = vec![lookup()];
        let events = run_frames(&request, &frames);
        let selected: Vec<_> = events
            .iter()
            .map(kind)
            .filter(|kind| {
                [
                    "reasoning-start",
                    "reasoning-delta",
                    "reasoning-end",
                    "tool-call",
                    "finish",
                ]
                .contains(kind)
            })
            .collect();
        assert_eq!(
            selected,
            [
                "reasoning-start",
                "reasoning-delta",
                "reasoning-end",
                "tool-call",
                "reasoning-start",
                "reasoning-delta",
                "reasoning-end",
                "tool-call",
                "finish",
            ],
            "packed={packed}"
        );
        let deltas: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                Event::ReasoningDelta(delta) => Some(delta),
                _ => None,
            })
            .collect();
        assert_eq!(deltas.len(), 2);
        assert_eq!(deltas[0].text.as_str(), Some("First thought"));
        assert_eq!(
            signature_of(&deltas[0].provider_metadata).as_deref(),
            Some("sig-1")
        );
        assert_eq!(deltas[1].text.as_str(), Some("Second thought"));
        assert_eq!(
            signature_of(&deltas[1].provider_metadata).as_deref(),
            Some("sig-2")
        );
        assert_ne!(deltas[0].id, deltas[1].id);
        let calls: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                Event::ToolCall(call) => Some(call),
                _ => None,
            })
            .collect();
        assert_eq!(calls[0].input, value(r#"{"query":"a"}"#));
        assert_eq!(calls[1].input, value(r#"{"query":"b"}"#));
        let response = Response::from_events(events).unwrap();
        let reasoning: Vec<_> = response
            .message
            .content
            .iter()
            .filter_map(|part| match part {
                Part::Reasoning(part) => Some(part),
                _ => None,
            })
            .collect();
        assert_eq!(reasoning.len(), 2, "packed={packed}");
        assert_eq!(reasoning[0].text.as_str(), Some("First thought"));
        assert_eq!(
            signature_of(&reasoning[0].provider_metadata).as_deref(),
            Some("sig-1")
        );
        assert_eq!(reasoning[1].text.as_str(), Some("Second thought"));
        assert_eq!(
            signature_of(&reasoning[1].provider_metadata).as_deref(),
            Some("sig-2")
        );
    }
}

#[test]
fn packed_tool_call_precedes_subsequent_text_and_finish_carries_usage_once() {
    let mut request = fixture("gemini-fixture");
    request.messages.push(Message::user("Hi"));
    let events = run_frames(
        &request,
        &[gateway_frame(
            r#"[{"functionCall":{"name":"lookup","args":{"query":"a"}}},{"text":"After"}]"#,
            true,
            true,
        )],
    );
    let selected: Vec<_> = events
        .iter()
        .map(kind)
        .filter(|kind| {
            [
                "tool-call",
                "text-start",
                "text-delta",
                "text-end",
                "finish",
            ]
            .contains(kind)
        })
        .collect();
    assert_eq!(
        selected,
        [
            "tool-call",
            "text-start",
            "text-delta",
            "text-end",
            "finish"
        ]
    );
    assert_eq!(events.iter().filter(|e| kind(e) == "finish").count(), 1);
    let response = Response::from_events(events).unwrap();
    assert_eq!(response.usage.unwrap().input_tokens, Some(3.0));
}

#[test]
fn interleaved_text_and_reasoning_reopen_with_epoch_suffixed_ids() {
    let mut request = fixture("gemini-fixture");
    request.messages.push(Message::user("Hi"));
    let frames = [
        gateway_frame(r#"[{"text":"one"}]"#, false, false),
        gateway_frame(r#"[{"text":"think","thought":true}]"#, false, false),
        gateway_frame(r#"[{"text":"two"}]"#, true, true),
    ];
    let events = run_frames(&request, &frames);
    let selected: Vec<_> = events
        .iter()
        .map(kind)
        .filter(|kind| !matches!(*kind, "step-start" | "step-finish"))
        .collect();
    assert_eq!(
        selected,
        [
            "text-start",
            "text-delta",
            "text-end",
            "reasoning-start",
            "reasoning-delta",
            "reasoning-end",
            "text-start",
            "text-delta",
            "text-end",
            "finish",
        ]
    );
    let text_starts: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            Event::TextStart(block) => Some(block.id.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(text_starts.len(), 2);
    assert_ne!(text_starts[0], text_starts[1]);
    assert!(text_starts[1].as_str().unwrap().ends_with(":1"));
    let response = Response::from_events(events).unwrap();
    let texts: Vec<_> = response
        .message
        .content
        .iter()
        .filter_map(|part| match part {
            Part::Text(part) => part.text.as_str(),
            _ => None,
        })
        .collect();
    assert_eq!(texts, ["one", "two"]);
}

fn two_turns(model: &str, frames: &[JsonValue]) -> (Response, JsonValue) {
    let mut request = fixture(model);
    request.messages.push(Message::user("Start"));
    request.tools = vec![lookup()];
    let response = Response::from_events(run_frames(&request, frames)).unwrap();
    let call = response.message.content.iter().find_map(|part| match part {
        Part::ToolCall(call) => Some(call.clone()),
        _ => None,
    });
    let mut next = fixture(model);
    next.tools = vec![lookup()];
    next.messages = vec![
        Message::user("Start"),
        response.message.clone(),
        match &call {
            Some(call) => Message::new(
                Role::Tool,
                vec![result(
                    call.id.as_str().unwrap(),
                    call.name.as_str().unwrap(),
                    ToolResultValue::Text(value(r#""found""#)),
                )],
            ),
            None => Message::user("Continue"),
        },
    ];
    let prepared = next.model.route.prepare(&next).unwrap();
    (response, model_parts(&prepared))
}
fn thought(text: &str) -> String {
    format!(r#"{{"text":"{text}","thought":true}}"#)
}
fn sig_only(signature: &str) -> String {
    format!(r#"{{"text":"","thought":true,"thoughtSignature":"{signature}"}}"#)
}
fn reply(parts: &[String], finish: bool) -> JsonValue {
    gateway_frame(&format!("[{}]", parts.join(",")), finish, finish)
}

#[test]
fn signature_only_events_sign_the_replayed_thinking_block() {
    let (response, replayed) = two_turns(
        "claude-sonnet-5-5",
        &[
            reply(&[thought("Let me ")], false),
            reply(&[thought("think")], false),
            reply(&[sig_only("sig-1")], false),
            reply(&[r#"{"text":"Answer"}"#.into()], true),
        ],
    );
    let first = &response.message.content[0];
    let Part::Reasoning(first) = first else {
        panic!("first part must be reasoning")
    };
    assert_eq!(first.text.as_str(), Some("Let me think"));
    assert_eq!(
        signature_of(&first.provider_metadata).as_deref(),
        Some("sig-1")
    );
    assert_eq!(
        replayed,
        value(
            r#"[{"text":"Let me think","thought":true,"thoughtSignature":"sig-1"},{"text":"Answer"}]"#
        )
    );

    let (_, replayed) = two_turns(
        "claude-sonnet-5-5",
        &[reply(
            &[
                thought("Plan"),
                sig_only("sig-2"),
                r#"{"text":"Answer"}"#.into(),
            ],
            true,
        )],
    );
    assert_eq!(
        replayed,
        value(r#"[{"text":"Plan","thought":true,"thoughtSignature":"sig-2"},{"text":"Answer"}]"#)
    );

    let (_, replayed) = two_turns(
        "claude-sonnet-5-5",
        &[
            reply(&[thought("Plan")], false),
            reply(&[r#"{"text":"","thoughtSignature":"sig-3"}"#.into()], false),
            reply(&[r#"{"text":"Answer"}"#.into()], true),
        ],
    );
    assert_eq!(
        replayed,
        value(r#"[{"text":"Plan","thought":true,"thoughtSignature":"sig-3"},{"text":"Answer"}]"#)
    );

    let (_, replayed) = two_turns(
        "claude-sonnet-5-5",
        &[
            reply(&[thought("Plan")], false),
            reply(
                &[r#"{"thought":true,"thoughtSignature":"sig-absent"}"#.into()],
                false,
            ),
            reply(&[r#"{"text":"Answer"}"#.into()], true),
        ],
    );
    assert_eq!(
        replayed,
        value(
            r#"[{"text":"Plan","thought":true,"thoughtSignature":"sig-absent"},{"text":"Answer"}]"#
        )
    );
}

#[test]
fn thinking_and_tool_call_replay_with_each_blocks_own_signature() {
    let (_, replayed) = two_turns(
        "claude-sonnet-5-5",
        &[
            reply(&[thought("Need data")], false),
            reply(&[sig_only("sig-think")], false),
            reply(
                &[r#"{"functionCall":{"name":"lookup","args":{"query":"fixture"}},"thoughtSignature":"sig-call"}"#.into()],
                true,
            ),
        ],
    );
    assert_eq!(
        replayed,
        value(
            r#"[{"text":"Need data","thought":true,"thoughtSignature":"sig-think"},{"functionCall":{"name":"lookup","args":{"query":"fixture"},"id":"tool_0"},"thoughtSignature":"sig-call"}]"#
        )
    );

    let (_, replayed) = two_turns(
        "claude-sonnet-5-5",
        &[
            reply(&[thought("First")], false),
            reply(&[sig_only("sig-a")], false),
            reply(&[r#"{"text":"Between"}"#.into()], false),
            reply(&[thought("Second")], false),
            reply(&[sig_only("sig-b")], false),
            reply(&[r#"{"text":"After"}"#.into()], true),
        ],
    );
    assert_eq!(
        replayed,
        value(
            r#"[{"text":"First","thought":true,"thoughtSignature":"sig-a"},{"text":"Between"},{"text":"Second","thought":true,"thoughtSignature":"sig-b"},{"text":"After"}]"#
        )
    );
}

#[test]
fn signatures_never_move_across_blocks() {
    let (_, replayed) = two_turns(
        "gemini-3.8-flash",
        &[
            reply(&[thought("Plan")], false),
            reply(
                &[r#"{"functionCall":{"name":"lookup","args":{"query":"fixture"}},"thoughtSignature":"sig-call"}"#.into()],
                true,
            ),
        ],
    );
    assert_eq!(
        replayed,
        value(
            r#"[{"text":"Plan","thought":true},{"functionCall":{"name":"lookup","args":{"query":"fixture"}},"thoughtSignature":"sig-call"}]"#
        )
    );

    let (_, replayed) = two_turns(
        "claude-sonnet-5-5",
        &[reply(
            &[
                r#"{"text":"Plan","thought":true,"thoughtSignature":"sig-inline"}"#.into(),
                r#"{"text":"Answer"}"#.into(),
            ],
            true,
        )],
    );
    assert_eq!(
        replayed,
        value(
            r#"[{"text":"Plan","thought":true,"thoughtSignature":"sig-inline"},{"text":"Answer"}]"#
        )
    );

    let (_, replayed) = two_turns(
        "gemini-3.8-flash",
        &[
            reply(&[thought("Plan")], false),
            reply(&[r#"{"text":"Answer"}"#.into()], false),
            reply(
                &[r#"{"text":"","thoughtSignature":"sig-text"}"#.into()],
                true,
            ),
        ],
    );
    assert_eq!(
        replayed,
        value(r#"[{"text":"Plan","thought":true},{"text":"Answer"}]"#)
    );

    let (_, replayed) = two_turns(
        "gemini-3.8-flash",
        &[reply(
            &[sig_only("sig-orphan"), r#"{"text":"Answer"}"#.into()],
            true,
        )],
    );
    assert!(!stringify_json(&replayed).contains("sig-orphan"));

    let (_, replayed) = two_turns(
        "gemini-3.8-flash",
        &[
            reply(&[thought("Plan")], false),
            reply(&[sig_only("")], false),
            reply(&[r#"{"text":"Answer"}"#.into()], true),
        ],
    );
    assert_eq!(
        replayed,
        value(r#"[{"text":"Plan","thought":true},{"text":"Answer"}]"#)
    );
}

#[test]
fn unfinished_thinking_is_delivered_before_finish_and_errors_stay_visible() {
    let (response, _) = two_turns("gemini-3.8-flash", &[reply(&[thought("Plan")], true)]);
    let reasoning_text: String = response
        .events
        .iter()
        .filter_map(|event| match event {
            Event::ReasoningDelta(delta) => delta.text.as_str(),
            _ => None,
        })
        .collect();
    assert_eq!(reasoning_text, "Plan");
    let end = response
        .events
        .iter()
        .position(|e| kind(e) == "reasoning-end")
        .unwrap();
    let finish = response
        .events
        .iter()
        .position(|e| kind(e) == "finish")
        .unwrap();
    assert!(end < finish);

    let mut request = fixture("gemini-fixture");
    request.messages.push(Message::user("Hi"));
    let mut parser = request.model.route.protocol.parser(&request);
    assert!(
        parser
            .push(&reply(&[thought("Plan")], false))
            .unwrap()
            .is_empty()
    );
    let events = parser
        .push(&value(r#"{"error":{"message":"synthetic failure"}}"#))
        .unwrap();
    let kinds: Vec<_> = events.iter().map(kind).collect();
    let delta = kinds.iter().position(|k| *k == "reasoning-delta").unwrap();
    let error = kinds.iter().position(|k| *k == "provider-error").unwrap();
    assert!(delta < error);
    assert!(
        matches!(&events[error], Event::ProviderError { message, .. } if message.as_str() == Some("synthetic failure"))
    );
}

#[test]
fn held_thinking_flushes_before_a_metadata_frame_and_late_signature_stays_off() {
    let mut request = fixture("gemini-fixture");
    request.messages.push(Message::user("Hi"));
    let mut parser = request.model.route.protocol.parser(&request);
    assert!(
        parser
            .push(&reply(&[thought("Plan")], false))
            .unwrap()
            .is_empty()
    );
    let flushed = parser
        .push(&value(
            r#"{"response":{"usageMetadata":{"promptTokenCount":1}}}"#,
        ))
        .unwrap();
    let delta = flushed
        .iter()
        .find_map(|event| match event {
            Event::ReasoningDelta(delta) => Some(delta),
            _ => None,
        })
        .expect("held thinking flushes before the metadata frame");
    assert_eq!(delta.text.as_str(), Some("Plan"));
    assert_eq!(signature_of(&delta.provider_metadata), None);
}
