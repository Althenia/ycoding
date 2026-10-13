use ycoding_ai::{
    auth::{Auth, Credential},
    cache::{Hint, Policy},
    llm::{
        Event, FinishReason, Media, MediaData, Message, Part, Reasoning, Request, Role, ToolCall,
        ToolResult, ToolResultValue,
    },
    providers::{self, Api, Config},
};
use ycoding_schema::{parse_json, stringify_json};

fn request(id: &str, api: Api) -> Request {
    let mut config = Config::new(Auth::bearer(Credential::value("fixture")));
    config.base_url = Some("https://copilot.example.test".into());
    config
        .defaults
        .http
        .headers
        .insert("user-agent".into(), "ycoding/fixture".into());
    Request::new(
        providers::github_copilot_sdk(
            id,
            ycoding_ai::github_copilot::Config {
                common: config,
                api: Some(api),
                user_agent: "ycoding/fixture".into(),
            },
        )
        .unwrap(),
    )
}
fn body(request: &Request) -> serde_json::Value {
    serde_json::from_str(&request.model.route.prepare(request).unwrap().encoded_body).unwrap()
}
fn reasoning(text: &str, metadata: &str) -> Part {
    Part::Reasoning(Reasoning {
        text: text.into(),
        encrypted: None,
        provider_metadata: Some(parse_json(metadata).unwrap()),
    })
}
fn call(metadata: Option<&str>) -> Part {
    Part::ToolCall(ToolCall {
        id: "call_1".into(),
        name: "bash".into(),
        input: parse_json(r#"{"command":"ls"}"#).unwrap(),
        provider_executed: None,
        provider_metadata: metadata.map(|value| parse_json(value).unwrap()),
    })
}
fn tool_result() -> Part {
    Part::ToolResult(ToolResult {
        id: "call_1".into(),
        name: "bash".into(),
        result: ToolResultValue::Text(parse_json(r#""synthetic result""#).unwrap()),
        cache: None,
        provider_executed: None,
        provider_metadata: None,
        output: None,
    })
}
fn parse(request: &Request, chunks: &[&str]) -> Vec<Event> {
    let mut parser = request.model.route.protocol.parser(&request.resolved());
    let mut events = chunks
        .iter()
        .flat_map(|chunk| parser.push(&parse_json(chunk).unwrap()).unwrap())
        .collect::<Vec<_>>();
    events.extend(parser.finish().unwrap());
    events
}

#[test]
fn chat_preserves_text_parts_and_signed_reasoning() {
    let mut request = request("gemini-3-pro-preview", Api::Chat);
    request.cache = Policy::None;
    request.system = vec!["You are a helpful assistant.".into()];
    request.messages = vec![
        Message::new(
            Role::User,
            vec![Part::Text("Part 1".into()), Part::Text("Part 2".into())],
        ),
        Message::assistant(vec![
            reasoning(
                "Thinking...",
                r#"{"copilot":{"reasoningOpaque":"opaque-signature-123"}}"#,
            ),
            Part::Text("First part. ".into()),
            Part::Text("Second part.".into()),
        ]),
    ];
    assert_eq!(
        body(&request)["messages"],
        serde_json::json!([
            {"role":"system","content":"You are a helpful assistant."},
            {"role":"user","content":[{"type":"text","text":"Part 1"},{"type":"text","text":"Part 2"}]},
            {"role":"assistant","content":"First part. Second part.","reasoning_text":"Thinking...","reasoning_opaque":"opaque-signature-123"}
        ])
    );
    request.messages = vec![Message::assistant(vec![
        reasoning("Let me think about this...", "{}"),
        Part::Text("The answer is 42.".into()),
    ])];
    assert_eq!(
        body(&request)["messages"][1],
        serde_json::json!({"role":"assistant","content":"The answer is 42."})
    );
    assert!(body(&request).get("stream_options").is_none());
}

#[test]
fn chat_cache_is_message_scoped_ephemeral_and_bounded() {
    let mut request = request("claude-sonnet-4", Api::Chat);
    request.cache = Policy::None;
    request.messages = (0..5)
        .map(|index| {
            let mut text = ycoding_ai::llm::TextPart::from(format!("message-{index}").as_str());
            text.cache = Some(Hint::ephemeral(Some(3600.0)));
            Message::new(Role::User, vec![Part::Text(text)])
        })
        .collect();
    let body = body(&request);
    let messages = body["messages"].as_array().unwrap();
    assert_eq!(
        messages
            .iter()
            .filter(|message| message.get("copilot_cache_control").is_some())
            .count(),
        4
    );
    assert_eq!(
        messages[0]["copilot_cache_control"],
        serde_json::json!({"type":"ephemeral"})
    );
    assert!(!body.to_string().contains("ttl"));
    assert!(!body.to_string().contains("cacheControl"));
}

#[test]
fn chat_opaque_metadata_closes_reasoning_before_tools() {
    let request = request("gemini-3-pro-preview", Api::Chat);
    let events = parse(
        &request,
        &[
            r#"{"choices":[{"index":0,"delta":{"reasoning_text":"Thinking..."}}]}"#,
            r#"{"choices":[{"index":0,"finish_reason":"tool_calls","delta":{"reasoning_opaque":"opaque-xyz","tool_calls":[{"index":0,"id":"call_reasoning_only","type":"function","function":{"name":"read_file","arguments":"{}"}}]}}]}"#,
        ],
    );
    let end = events
        .iter()
        .position(|event| matches!(event, Event::ReasoningEnd(_)))
        .unwrap();
    let start = events
        .iter()
        .position(|event| matches!(event, Event::ToolInputStart(_)))
        .unwrap();
    assert!(end < start);
    let Event::ReasoningEnd(end) = &events[end] else {
        panic!()
    };
    assert_eq!(
        end.provider_metadata,
        Some(parse_json(r#"{"copilot":{"reasoningOpaque":"opaque-xyz"}}"#).unwrap())
    );
    let call = events
        .iter()
        .find_map(|event| {
            if let Event::ToolCall(call) = event {
                Some(call)
            } else {
                None
            }
        })
        .unwrap();
    assert_eq!(call.provider_metadata, end.provider_metadata);
    let finish = events
        .iter()
        .find_map(|event| {
            if let Event::Finish(finish) = event {
                Some(finish)
            } else {
                None
            }
        })
        .unwrap();
    assert_eq!(finish.reason, FinishReason::ToolCalls);
    assert!(finish.usage.is_none());
}

#[test]
fn chat_finish_reasons_and_absent_usage() {
    let request = request("gemini-2.5-pro", Api::Chat);
    for (wire, expected) in [
        ("stop", FinishReason::Stop),
        ("length", FinishReason::Length),
        ("content_filter", FinishReason::ContentFilter),
        ("function_call", FinishReason::ToolCalls),
        ("tool_calls", FinishReason::ToolCalls),
        ("unknown", FinishReason::Unknown),
    ] {
        let events = parse(
            &request,
            &[&format!(
                r#"{{"choices":[{{"index":0,"delta":{{"content":"Hello"}},"finish_reason":"{wire}"}}]}}"#
            )],
        );
        let finish = events
            .iter()
            .find_map(|event| {
                if let Event::Finish(finish) = event {
                    Some(finish)
                } else {
                    None
                }
            })
            .unwrap();
        assert_eq!(finish.reason, expected);
        assert!(finish.usage.is_none());
    }
}

#[test]
fn responses_stateless_reasoning_tool_ids_and_compaction() {
    let mut request = request("gpt-5.5", Api::Responses);
    request.provider_options = Some(parse_json(r#"{"copilot":{"store":false,"contextManagement":[{"type":"compaction","compactThreshold":900}]}}"#).unwrap());
    request.messages = vec![
        Message::assistant(vec![
            reasoning(
                "thinking...",
                r#"{"copilot":{"itemId":"rs_1","reasoningEncryptedContent":"enc_1"}}"#,
            ),
            call(Some(r#"{"copilot":{"itemId":"fc_999"}}"#)),
        ]),
        Message::new(Role::Tool, vec![tool_result()]),
    ];
    let prepared = body(&request);
    assert_eq!(prepared["store"], false);
    assert_eq!(
        prepared["input"],
        serde_json::json!([
            {"type":"reasoning","id":"rs_1","encrypted_content":"enc_1","summary":[{"type":"summary_text","text":"thinking..."}]},
            {"type":"function_call","call_id":"call_1","name":"bash","arguments":"{\"command\":\"ls\"}","id":"fc_999"},
            {"type":"function_call_output","call_id":"call_1","output":"synthetic result"}
        ])
    );
    assert_eq!(
        prepared["context_management"],
        serde_json::json!([{"type":"compaction","compact_threshold":900}])
    );
    request.system = vec!["Current instructions".into()];
    request.messages = vec![
        Message::user("Hello"),
        Message::assistant(vec![Part::Text("before".into())]),
        Message::assistant(vec![reasoning(
            "",
            r#"{"copilot":{"opaqueCompactionItem":{"type":"compaction","id":"cmp_1","encrypted_content":"old secret"}}}"#,
        )]),
        Message::assistant(vec![Part::Text("between".into())]),
        Message::assistant(vec![reasoning(
            "",
            r#"{"copilot":{"opaqueCompactionItem":{"type":"compaction","id":"cmp_2","encrypted_content":"secret"}}}"#,
        )]),
        Message::assistant(vec![Part::Text("after".into())]),
    ];
    assert_eq!(
        body(&request)["input"],
        serde_json::json!([
            {"role":"developer","content":"Current instructions"},
            {"type":"compaction","id":"cmp_2","encrypted_content":"secret"},
            {"role":"assistant","content":[{"type":"output_text","text":"after"}]}
        ])
    );
}

#[test]
fn inference_headers_use_final_wire_body_and_resolved_bearer() {
    let mut request = request("gpt-4o", Api::Chat);
    request
        .http
        .headers
        .insert("x-api-key".into(), "old".into());
    request
        .http
        .headers
        .insert("Copilot-Integration-Id".into(), "vscode-chat".into());
    request
        .http
        .headers
        .insert("Editor-Version".into(), "fixture".into());
    request.messages = vec![Message::new(
        Role::User,
        vec![Part::Media(Media {
            mime: "image/png".into(),
            data: MediaData::Bytes(vec![0, 1, 2, 3]),
            filename: None,
        })],
    )];
    let prepared = request.model.route.prepare(&request).unwrap();
    assert_eq!(prepared.headers["authorization"], "Bearer fixture");
    assert!(!prepared.headers.contains_key("x-api-key"));
    assert_eq!(prepared.headers["x-initiator"], "user");
    assert_eq!(prepared.headers["copilot-vision-request"], "true");
    assert_eq!(prepared.headers["x-github-api-version"], "2026-06-01");
    assert_eq!(prepared.headers["openai-intent"], "conversation-edits");
    assert_eq!(prepared.headers["copilot-integration-id"], "vscode-chat");
    assert_eq!(prepared.headers["editor-version"], "fixture");
    request.messages.push(Message::assistant(vec![call(None)]));
    assert_eq!(
        request.model.route.prepare(&request).unwrap().headers["x-initiator"],
        "agent"
    );
}

#[test]
fn responses_output_metadata_and_cache_writes_remain_copilot_scoped() {
    let request = request("gpt-5.5", Api::Responses);
    for write in [Some(30), None] {
        let mut terminal = serde_json::json!({"type":"response.completed","response":{"id":"resp_usage","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":20},"output_tokens":5}}});
        if let Some(write) = write {
            terminal["response"]["usage"]["input_tokens_details"]["cache_write_tokens"] =
                write.into();
        }
        let events = parse(
            &request,
            &[
                r#"{"type":"response.output_item.done","output_index":0,"item":{"type":"compaction","id":"cmp_stream","encrypted_content":"opaque"}}"#,
                &terminal.to_string(),
            ],
        );
        let end = events
            .iter()
            .find_map(|event| {
                if let Event::ReasoningEnd(end) = event {
                    Some(end)
                } else {
                    None
                }
            })
            .unwrap();
        assert_eq!(end.provider_metadata, Some(parse_json(r#"{"copilot":{"itemId":"cmp_stream","opaqueCompactionItem":{"type":"compaction","id":"cmp_stream","encrypted_content":"opaque"}}}"#).unwrap()));
        let finish = events
            .iter()
            .find_map(|event| {
                if let Event::Finish(finish) = event {
                    Some(finish)
                } else {
                    None
                }
            })
            .unwrap();
        let usage = finish.usage.as_ref().unwrap();
        assert_eq!(usage.input_tokens, Some(100.0));
        assert_eq!(usage.cache_read_input_tokens, Some(20.0));
        assert_eq!(usage.cache_write_input_tokens, write.map(f64::from));
        assert_eq!(
            usage.non_cached_input_tokens,
            Some(if write.is_some() { 50.0 } else { 80.0 })
        );
        let metadata = stringify_json(finish.provider_metadata.as_ref().unwrap());
        assert!(metadata.contains("copilot"));
        assert!(!metadata.contains("openai"));
    }
}

#[test]
fn image_and_tool_conversion_matches_ts() {
    let mut request = request("gemini-3-pro-preview", Api::Chat);
    request.messages = vec![
        Message::new(
            Role::User,
            vec![
                Part::Text("Hello".into()),
                Part::Media(Media {
                    mime: "image/png".into(),
                    data: MediaData::Bytes(vec![0, 1, 2, 3]),
                    filename: None,
                }),
            ],
        ),
        Message::assistant(vec![call(None)]),
        Message::new(Role::Tool, vec![tool_result()]),
    ];
    assert_eq!(
        body(&request)["messages"],
        serde_json::json!([
            {"role":"user","content":[{"type":"text","text":"Hello"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AAECAw=="}}]},
            {"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"bash","arguments":"{\"command\":\"ls\"}"}}]},
            {"role":"tool","tool_call_id":"call_1","content":"synthetic result"}
        ])
    );
}

#[test]
fn responses_summary_rotation_retains_canonical_id_and_final_encryption() {
    let request = request("test-model", Api::Responses);
    let events = parse(
        &request,
        &[
            r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","encrypted_content":"enc_initial"}}"#,
            r#"{"type":"response.reasoning_summary_part.added","item_id":"rs_1","summary_index":0}"#,
            r#"{"type":"response.reasoning_summary_text.delta","item_id":"rs_1","summary_index":0,"delta":"first"}"#,
            r#"{"type":"response.reasoning_summary_part.done","item_id":"rs_1","summary_index":0}"#,
            r#"{"type":"response.reasoning_summary_part.added","item_id":"rs_1","summary_index":1}"#,
            r#"{"type":"response.reasoning_summary_text.delta","item_id":"rs_1","summary_index":1,"delta":"second"}"#,
            r#"{"type":"response.reasoning_summary_part.done","item_id":"rs_1","summary_index":1}"#,
            r#"{"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_rotated","encrypted_content":"enc_final"}}"#,
            r#"{"type":"response.completed","response":{"incomplete_details":null,"usage":{"input_tokens":1,"output_tokens":2},"service_tier":null}}"#,
        ],
    );
    let reasoning = events
        .iter()
        .filter(|event| {
            matches!(
                event,
                Event::ReasoningStart(_) | Event::ReasoningDelta(_) | Event::ReasoningEnd(_)
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(reasoning.len(), 6);
    for (index, id, encrypted) in [
        (0, "rs_1:0", "enc_initial"),
        (2, "rs_1:0", "enc_initial"),
        (3, "rs_1:1", "enc_initial"),
        (5, "rs_1:1", "enc_final"),
    ] {
        let part = match reasoning[index] {
            Event::ReasoningStart(part) | Event::ReasoningEnd(part) => part,
            _ => panic!(),
        };
        assert_eq!(part.id.as_str(), Some(id));
        assert_eq!(
            part.provider_metadata,
            Some(
                parse_json(&format!(
                    r#"{{"copilot":{{"itemId":"rs_1","reasoningEncryptedContent":"{encrypted}"}}}}"#
                ))
                .unwrap()
            )
        );
    }
    let response = ycoding_ai::llm::Response::from_events(events).unwrap();
    assert_eq!(
        response
            .message
            .content
            .iter()
            .filter_map(|part| if let Part::Reasoning(part) = part {
                part.text.as_str()
            } else {
                None
            })
            .collect::<Vec<_>>(),
        vec!["first", "second"]
    );
}

#[test]
fn responses_done_only_tool_and_text_output_have_item_metadata() {
    let request = request("test-model", Api::Responses);
    let events = parse(
        &request,
        &[
            r#"{"type":"response.output_item.done","output_index":0,"item":{"type":"message","role":"assistant","id":"msg_1","content":[{"type":"output_text","text":"Hello there","annotations":[]}]}}"#,
            r#"{"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"bash","arguments":"{}","id":"fc_1"}}"#,
            r#"{"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":10,"output_tokens":5}}}"#,
        ],
    );
    let response = ycoding_ai::llm::Response::from_events(events).unwrap();
    let Part::Text(text) = &response.message.content[0] else {
        panic!()
    };
    assert_eq!(
        text.provider_metadata,
        Some(parse_json(r#"{"copilot":{"itemId":"msg_1"}}"#).unwrap())
    );
    let call = response
        .message
        .content
        .iter()
        .find_map(|part| {
            if let Part::ToolCall(call) = part {
                Some(call)
            } else {
                None
            }
        })
        .unwrap();
    assert_eq!(
        call.provider_metadata,
        Some(parse_json(r#"{"copilot":{"itemId":"fc_1"}}"#).unwrap())
    );
}

#[test]
fn responses_generic_continuation_uses_explicit_options() {
    let mut request = request("gpt-5.5", Api::Responses);
    request.messages = vec![Message::user("Hello")];
    request.provider_options = Some(parse_json(r#"{"openai":{"previousResponseId":"resp_previous","promptCacheKey":"session:cache","store":true}}"#).unwrap());
    let body = body(&request);
    assert_eq!(body["previous_response_id"], "resp_previous");
    assert_eq!(body["prompt_cache_key"], "session:cache");
    assert_eq!(body["store"], true);
}

#[test]
fn chat_opaque_on_text_or_tool_call_survives_replay() {
    let mut request = request("test-model", Api::Chat);
    let events = parse(
        &request,
        &[
            r#"{"choices":[{"delta":{"content":"Done!","reasoning_opaque":"opaque-text-456"},"finish_reason":"stop"}]}"#,
        ],
    );
    request.messages = vec![
        ycoding_ai::llm::Response::from_events(events)
            .unwrap()
            .message,
    ];
    assert_eq!(
        body(&request)["messages"][0],
        serde_json::json!({"role":"assistant","content":"Done!","reasoning_opaque":"opaque-text-456"})
    );
    let events = parse(
        &request,
        &[
            r#"{"choices":[{"delta":{"reasoning_opaque":"opaque-xyz","tool_calls":[{"index":0,"id":"call_reasoning_only","function":{"name":"read_file","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}"#,
        ],
    );
    assert!(!events.iter().any(|event| matches!(
        event,
        Event::ReasoningStart(_) | Event::ReasoningDelta(_) | Event::ReasoningEnd(_)
    )));
    request.messages = vec![
        ycoding_ai::llm::Response::from_events(events)
            .unwrap()
            .message,
    ];
    assert_eq!(
        body(&request)["messages"][0]["reasoning_opaque"],
        "opaque-xyz"
    );
}

#[test]
fn chat_tools_are_raw_ts_schemas_and_gpt_output_limit_is_omitted() {
    let mut request = request("gpt-5-mini", Api::Chat);
    request.generation.max_tokens = Some(16384.0);
    request.tools.push(ycoding_ai::llm::ToolDefinition { name:"get_weather".into(),description:"Get the weather for a location".into(),input_schema:parse_json(r#"{"type":"object","properties":{"location":{"type":"string"}},"required":["location"]}"#).unwrap(),output_schema:None,cache:None,metadata:None,native:None });
    assert_eq!(
        body(&request)["tools"],
        serde_json::json!([{"type":"function","function":{"name":"get_weather","description":"Get the weather for a location","parameters":{"type":"object","properties":{"location":{"type":"string"}},"required":["location"]}}}])
    );
    assert!(body(&request).get("max_tokens").is_none());
    let mut request = self::request("gpt-5.5", Api::Responses);
    request.generation.max_tokens = Some(16384.0);
    assert!(body(&request).get("max_output_tokens").is_none());
}

#[test]
fn cache_hints_on_assistant_and_tool_parts_are_lifted() {
    let mut request = request("claude-sonnet-4", Api::Chat);
    request.cache = Policy::None;
    let mut text = ycoding_ai::llm::TextPart::from("answer");
    text.provider_metadata =
        Some(parse_json(r#"{"copilot":{"cacheControl":{"type":"ephemeral"}}}"#).unwrap());
    let mut result = tool_result();
    let Part::ToolResult(part) = &mut result else {
        panic!()
    };
    part.result = ToolResultValue::Text(parse_json(r#""ok""#).unwrap());
    part.provider_metadata =
        Some(parse_json(r#"{"copilot":{"cacheControl":{"type":"ephemeral"}}}"#).unwrap());
    request.messages = vec![
        Message::assistant(vec![
            Part::Text(text),
            call(Some(r#"{"copilot":{"cacheControl":{"type":"ephemeral"}}}"#)),
        ]),
        Message::new(Role::Tool, vec![result]),
    ];
    let body = body(&request);
    assert_eq!(body["messages"][0]["content"], "answer");
    assert_eq!(body["messages"][1]["content"], "ok");
    assert_eq!(
        body["messages"][0]["copilot_cache_control"],
        serde_json::json!({"type":"ephemeral"})
    );
    assert_eq!(
        body["messages"][1]["copilot_cache_control"],
        serde_json::json!({"type":"ephemeral"})
    );
    assert!(!body.to_string().contains("cacheControl"));
}

#[test]
fn chat_media_vectors_preserve_urls_base64_and_bytes() {
    for (data, mime, expected) in [
        (
            MediaData::Bytes(vec![0, 1, 2, 3]),
            "image/png",
            "data:image/png;base64,AAECAw==",
        ),
        (
            MediaData::Encoded("AAECAw==".into()),
            "image/png",
            "data:image/png;base64,AAECAw==",
        ),
        (
            MediaData::Encoded("https://example.com/image.jpg".into()),
            "image/*",
            "https://example.com/image.jpg",
        ),
    ] {
        let mut request = request("test-model", Api::Chat);
        request.messages = vec![Message::new(
            Role::User,
            vec![Part::Media(Media {
                mime: mime.into(),
                data,
                filename: None,
            })],
        )];
        assert_eq!(
            body(&request)["messages"],
            serde_json::json!([{"role":"user","content":[{"type":"image_url","image_url":{"url":expected}}]}])
        );
    }
}

#[test]
fn chat_reasoning_only_and_json_tool_results_preserve_ts_shapes() {
    let mut request = request("test-model", Api::Chat);
    request.messages = vec![Message::assistant(vec![reasoning(
        "Just thinking, no response yet",
        r#"{"copilot":{"reasoningOpaque":"sig-abc"}}"#,
    )])];
    assert_eq!(
        body(&request)["messages"],
        serde_json::json!([{"role":"assistant","content":null,"reasoning_text":"Just thinking, no response yet","reasoning_opaque":"sig-abc"}])
    );
    let mut result = tool_result();
    let Part::ToolResult(part) = &mut result else {
        panic!()
    };
    part.id = "quux".into();
    part.result = ToolResultValue::Json(parse_json(r#"{"oof":"321rab"}"#).unwrap());
    request.messages = vec![Message::new(Role::Tool, vec![result])];
    assert_eq!(
        body(&request)["messages"],
        serde_json::json!([{"role":"tool","tool_call_id":"quux","content":"{\"oof\":\"321rab\"}"}])
    );
    request.messages = vec![Message::new(Role::Tool, vec![tool_result(), tool_result()])];
    assert_eq!(body(&request)["messages"].as_array().unwrap().len(), 2);
}

#[test]
fn responses_strip_stale_item_id_and_drop_unsigned_reasoning() {
    let mut request = request("test-model", Api::Responses);
    request.provider_options = Some(parse_json(r#"{"copilot":{"store":false}}"#).unwrap());
    request.messages = vec![Message::assistant(vec![call(None)])];
    assert!(body(&request)["input"][0].get("id").is_none());
    request.messages = vec![Message::assistant(vec![reasoning("thinking...", "{}")])];
    assert_eq!(body(&request)["input"], serde_json::json!([]));
}

#[test]
fn sdk_endpoint_selection_matches_native_model_family_routing() {
    for (id, api, expected) in [
        ("gpt-5", None, "/responses"),
        ("gpt-5.1-codex", None, "/responses"),
        ("gpt-4o", None, "/chat/completions"),
        ("gpt-5-mini", None, "/chat/completions"),
        ("gpt-5-mini-2025-08-07", None, "/chat/completions"),
        (
            "mai-code-1-flash-picker",
            Some(Api::Responses),
            "/responses",
        ),
        ("gpt-5", Some(Api::Chat), "/chat/completions"),
    ] {
        let mut common = Config::new(Auth::None);
        common.base_url = Some("https://copilot.example.test/".into());
        let model = providers::github_copilot_sdk(
            id,
            ycoding_ai::github_copilot::Config {
                common,
                api,
                user_agent: "ycoding/fixture".into(),
            },
        )
        .unwrap();
        assert_eq!(model.route.endpoint.path, expected);
        assert_eq!(
            model.route.provider_metadata_key.as_deref(),
            Some("copilot")
        );
    }
}

#[test]
fn reachable_hosted_tools_preserve_native_fields_and_choices() {
    for (name, native) in [
        (
            "image_generation",
            r#"{"type":"image_generation","action":"generate","quality":"high","size":"1024x1024"}"#,
        ),
        (
            "web_search",
            r#"{"type":"web_search","filters":{"allowed_domains":["effect.website"],"blocked_domains":["example.com"]},"search_context_size":"high","external_web_access":false,"return_token_budget":"unlimited","user_location":{"type":"approximate","country":"US","city":"New York","region":"New York","timezone":"America/New_York"}}"#,
        ),
    ] {
        let mut request = request("gpt-5.5", Api::Responses);
        request.tools.push(ycoding_ai::llm::ToolDefinition {
            name: name.into(),
            description: "".into(),
            input_schema: parse_json("{}").unwrap(),
            output_schema: None,
            cache: None,
            metadata: None,
            native: Some(parse_json(&format!(r#"{{"openai":{native}}}"#)).unwrap()),
        });
        request.tool_choice = Some(ycoding_ai::llm::ToolChoice::Tool(name.into()));
        let prepared = body(&request);
        assert_eq!(
            prepared["tools"],
            serde_json::json!([serde_json::from_str::<serde_json::Value>(native).unwrap()])
        );
        assert_eq!(prepared["tool_choice"], serde_json::json!({"type":name}));
    }
}

#[test]
fn hosted_choice_uses_native_type_and_keeps_unreachable_names_as_functions() {
    let mut request = request("gpt-5.5", Api::Responses);
    request.tools.push(ycoding_ai::llm::ToolDefinition { name:"web_search".into(),description:"".into(),input_schema:parse_json("{}").unwrap(),output_schema:None,cache:None,metadata:None,native:Some(parse_json(r#"{"openai":{"type":"image_generation","action":"generate","quality":"high","size":"1024x1024"}}"#).unwrap()) });
    request.tool_choice = Some(ycoding_ai::llm::ToolChoice::Tool("web_search".into()));
    assert_eq!(
        body(&request)["tool_choice"],
        serde_json::json!({"type":"image_generation"})
    );
    request.tools[0].native = None;
    for name in [
        "file_search",
        "local_shell",
        "web_search_preview",
        "code_interpreter",
        "image_generation",
        "web_search",
    ] {
        request.tools[0].name = name.into();
        request.tool_choice = Some(ycoding_ai::llm::ToolChoice::Tool(name.into()));
        let prepared = body(&request);
        assert_eq!(prepared["tools"][0]["type"], "function");
        assert_eq!(
            prepared["tool_choice"],
            serde_json::json!({"type":"function","name":name})
        );
    }
}

#[test]
fn copilot_rejects_invalid_reachable_hosted_tool_options() {
    let mut request = request("gpt-5.5", Api::Responses);
    request.tools.push(ycoding_ai::llm::ToolDefinition { name:"image_generation".into(),description:"".into(),input_schema:parse_json("{}").unwrap(),output_schema:None,cache:None,metadata:None,native:Some(parse_json(r#"{"openai":{"type":"image_generation","output_compression":-1,"partial_images":4,"size":"bogus"}}"#).unwrap()) });
    let error = request.model.route.prepare(&request).unwrap_err();
    assert_eq!(
        error.reason,
        ycoding_ai::provider_error::Reason::InvalidRequest
    );
    assert!(
        error
            .message
            .contains("image generation tool options are invalid")
    );
}
