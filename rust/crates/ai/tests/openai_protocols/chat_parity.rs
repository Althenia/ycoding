use super::response;
use ycoding_ai::{
    auth::Auth,
    llm::{
        Event, FinishReason, Media, MediaData, Message, Part, Request, Role, ToolCall, ToolResult,
        ToolResultValue,
    },
    openai_chat::OpenAIChat,
    provider_error::Reason,
    providers::{Api, Config, compatible},
    route::{Route, StreamParser},
};
use ycoding_schema::{
    llm::{ToolContent, ToolFileContent, ToolTextContent},
    parse_json, provider, stringify_json,
};

#[test]
fn compatible_chat_replays_tool_data_and_flushes_media_before_effort_update() {
    let make = |base: &str| {
        let mut config = Config::new(Auth::None);
        config.base_url = Some(base.into());
        compatible(
            "openai/gpt-6.1-terra",
            provider::Id("fixture".into()),
            config,
            Api::Chat,
        )
        .unwrap()
    };
    let model = make("https://openrouter.ai/api/v1");
    assert_eq!(model.route.provider_metadata_key.as_deref(), Some("openai"));
    let mut request = Request::new(model);
    request.system = vec!["Initial".into()];
    request.provider_options = Some(parse_json(r#"{"openai":{"reasoningEffort":"medium","promptCacheRetention":"24h","promptCacheOptions":{"mode":"explicit"}},"openai-compatible":{"includeUsage":false}}"#).unwrap());
    let result = |id: &str, data| {
        Part::ToolResult(ToolResult {
            id: id.into(),
            name: "lookup".into(),
            result: data,
            cache: None,
            provider_executed: None,
            provider_metadata: None,
            output: None,
        })
    };
    let call = |id: &str, input| {
        Part::ToolCall(ToolCall {
            id: id.into(),
            name: "lookup".into(),
            input,
            provider_executed: None,
            provider_metadata: None,
        })
    };
    let mut effort = Message::new(Role::System, vec![]);
    effort.native = Some(parse_json(r#"{"openai":{"reasoningEffort":"high"}}"#).unwrap());
    let mut update = Message::system("Use <safe> & preserve order");
    update.volatile = true;
    request.messages = vec![
        Message::user("Find both"),
        Message::assistant(vec![
            call("call_image", parse_json(r#"{"id":7}"#).unwrap()),
            call("call_error", parse_json("{}").unwrap()),
        ]),
        Message::new(
            Role::Tool,
            vec![result(
                "call_image",
                ToolResultValue::Content(vec![
                    ToolContent::Text(ToolTextContent {
                        text: "image ready".into(),
                    }),
                    ToolContent::File(ToolFileContent {
                        mime: "image/png".into(),
                        name: Some("test.png".into()),
                        uri: "AQID".into(),
                    }),
                ]),
            )],
        ),
        Message::new(
            Role::Tool,
            vec![result(
                "call_error",
                ToolResultValue::Error(parse_json(r#"{"kind":"missing"}"#).unwrap()),
            )],
        ),
        effort,
        Message::new(
            Role::User,
            vec![
                Part::Text("Look".into()),
                Part::Media(Media {
                    mime: "image/png".into(),
                    data: MediaData::Bytes(vec![4, 5, 6]),
                    filename: None,
                }),
            ],
        ),
        update,
    ];
    let expected = parse_json(r#"{
      "model":"openai/gpt-6.1-terra",
      "messages":[
        {"role":"system","content":"Initial"},
        {"role":"user","content":"Find both"},
        {"role":"assistant","content":null,"tool_calls":[
          {"id":"call_image","type":"function","function":{"name":"lookup","arguments":"{\"id\":7}"}},
          {"id":"call_error","type":"function","function":{"name":"lookup","arguments":"{}"}}]},
        {"role":"tool","tool_call_id":"call_image","content":"image ready"},
        {"role":"tool","tool_call_id":"call_error","content":"{\"kind\":\"missing\"}"},
        {"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,AQID"}}]},
        {"role":"system","content":"","configuration_update":{"reasoning":{"effort":"high"}}},
        {"role":"user","content":[{"type":"text","text":"Look"},{"type":"image_url","image_url":{"url":"data:image/png;base64,BAUG"}}]},
        {"role":"user","content":"<system-update>\nUse &lt;safe&gt; &amp; preserve order\n</system-update>"}],
      "stream":true,"reasoning_effort":"medium"
    }"#).unwrap();
    assert_eq!(
        request.model.route.prepare(&request).unwrap().body,
        expected
    );
    request.model = make("https://proxy.example/v1");
    assert_eq!(
        request.model.route.prepare(&request).err().unwrap().reason,
        Reason::InvalidRequest
    );
}

#[test]
fn chat_retains_late_reasoning_details_in_one_replayable_part() {
    let mut request = Request::new(Route::openai_chat().model("fixture"));
    let result = response(&mut OpenAIChat::parser(&request), &[
        r#"{"choices":[{"delta":{"reasoning":"consider","reasoning_details":[{"type":"reasoning.text","index":0,"text":"consider"}]}}]}"#,
        r#"{"choices":[{"delta":{"content":"answer"}}]}"#,
        r#"{"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","index":0,"signature":"signed"}]},"finish_reason":"stop"}]}"#,
    ]).unwrap();
    assert_eq!(result.reasoning().as_str(), Some("consider"));
    assert_eq!(result.text().as_str(), Some("answer"));
    assert_eq!(
        result
            .events
            .iter()
            .filter(|event| matches!(event, Event::ReasoningEnd(_)))
            .count(),
        1
    );
    request.messages = vec![result.message];
    let body = stringify_json(&request.model.route.prepare(&request).unwrap().body);
    assert!(body.contains(r#""reasoning":"consider""#), "{body}");
    assert!(body.contains(r#""signature":"signed""#), "{body}");
}

#[test]
fn interleaved_chat_arguments_settle_by_index_only_after_usage() {
    let request = Request::new(Route::openai_chat().model("fixture"));
    let mut parser = OpenAIChat::parser(&request);
    for frame in [
        r#"{"choices":[{"delta":{"tool_calls":[{"index":10,"id":"call_empty","function":{"name":"noop","arguments":""}},{"index":2,"id":"call_input","function":{"arguments":"{\"id\":"}}]}}]}"#,
        r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bad","function":{"name":"lookup","arguments":"{"}},{"index":2,"function":{"name":"lookup","arguments":"7}"}}]}}]}"#,
        r#"{"choices":[{"finish_reason":"stop"}],"usage":null}"#,
        r#"{"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"prompt_cache_hit_tokens":5,"completion_tokens":3},"cache_discount":0}"#,
    ] {
        let events = parser.push(&parse_json(frame).unwrap()).unwrap();
        assert!(!events.iter().any(|event| matches!(
            event,
            Event::ToolCall(_) | Event::ToolInputError { .. } | Event::Finish(_)
        )));
    }
    let events = parser.finish().unwrap();
    let settled = events
        .iter()
        .filter_map(|event| match event {
            Event::ToolInputError { id, raw, .. } => {
                Some((id.as_str().unwrap(), raw.as_str().unwrap().to_owned()))
            }
            Event::ToolCall(call) => Some((call.id.as_str().unwrap(), stringify_json(&call.input))),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        settled,
        [
            ("call_bad", "{".into()),
            ("call_input", r#"{"id":7}"#.into()),
            ("call_empty", "{}".into())
        ]
    );
    let Some(Event::Finish(finish)) = events.last() else {
        panic!("{events:?}")
    };
    assert_eq!(finish.reason, FinishReason::ToolCalls);
    let usage = finish.usage.as_ref().unwrap();
    assert_eq!(usage.non_cached_input_tokens, Some(7.0));
    assert_eq!(usage.cache_read_input_tokens, Some(5.0));
    assert_eq!(usage.total_tokens, Some(15.0));
    assert!(
        stringify_json(usage.provider_metadata.as_ref().unwrap()).contains(r#""cache_discount":0"#)
    );
    assert!(parser.finish().unwrap().is_empty());
}

#[test]
fn filtered_and_truncated_chat_never_settle_local_calls() {
    let request = Request::new(Route::openai_chat().model("fixture"));
    for (finish, expected) in [
        (r#"{"finish_reason":"length"}"#, FinishReason::Length),
        (
            r#"{"finish_reason":"content_filter"}"#,
            FinishReason::ContentFilter,
        ),
        (
            r#"{"finish_reason":"stop","delta":{"refusal":"Denied"}}"#,
            FinishReason::ContentFilter,
        ),
        (r#"{"finish_reason":"other"}"#, FinishReason::Unknown),
    ] {
        let mut parser = OpenAIChat::parser(&request);
        parser.push(&parse_json(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_complete","function":{"name":"lookup","arguments":"{}"}},{"index":1,"id":"call_empty","function":{"name":"lookup","arguments":""}},{"index":2,"id":"call_partial","function":{"name":"lookup","arguments":"{"}},{"index":3,"function":{"arguments":"{"}}]}}]}"#).unwrap()).unwrap();
        let end = format!(r#"{{"choices":[{finish}]}}"#);
        assert!(parser.push(&parse_json(&end).unwrap()).unwrap().is_empty());
        let events = parser.finish().unwrap();
        assert!(
            !events.iter().any(|event| matches!(
                event,
                Event::ToolCall(_) | Event::ToolInputEnd(_) | Event::ToolInputError { .. }
            )),
            "{events:?}"
        );
        assert!(matches!(events.last(), Some(Event::Finish(finish)) if finish.reason == expected));
    }

    let incomplete = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_missing_name","function":{"arguments":"{}"}}]}}]}"#;
    let error = response(
        &mut OpenAIChat::parser(&request),
        &[
            incomplete,
            r#"{"choices":[{"finish_reason":"tool_calls"}]}"#,
        ],
    )
    .unwrap_err();
    assert_eq!(error.reason, Reason::InvalidProviderOutput);
    let error = response(&mut OpenAIChat::parser(&request), &[incomplete]).unwrap_err();
    assert_eq!(error.reason, Reason::Transport);
}

#[test]
fn refuses_invalid_refusal_shape_and_requires_a_finish_reason() {
    let request = Request::new(Route::openai_chat().model("fixture"));
    let mut parser = OpenAIChat::parser(&request);
    let malformed = parse_json(r#"{"choices":[{"delta":{"refusal":true}}]}"#).unwrap();
    assert_eq!(
        parser.push(&malformed).unwrap_err().reason,
        Reason::InvalidProviderOutput
    );

    let error = response(
        &mut OpenAIChat::parser(&request),
        &[r#"{"choices":[{"delta":{"refusal":"Denied"}}]}"#],
    )
    .unwrap_err();
    assert_eq!(error.reason, Reason::Transport);
    assert_eq!(error.transport_kind, Some("read"));
}

#[test]
fn classifies_chat_error_envelopes_without_flushing_buffered_calls() {
    let request = Request::new(Route::openai_chat().model("fixture"));
    let mut parser = OpenAIChat::parser(&request);
    parser.push(&parse_json(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}"#).unwrap()).unwrap();
    let failure =
        parse_json(r#"{"choices":[],"error":{"code":"insufficient_quota","message":"No quota"}}"#)
            .unwrap();
    let error = parser.push(&failure).unwrap_err();
    assert_eq!(error.reason, Reason::QuotaExceeded);
    assert_eq!(error.code.as_deref(), Some("insufficient_quota"));
    assert_eq!(error.message, "No quota");
    assert!(parser.finish().unwrap().is_empty());
}

#[test]
fn chat_recognizes_openrouter_error_status_and_rejects_late_tool_deltas() {
    let request = Request::new(Route::openai_chat().model("fixture"));
    for (frame, expected, status, code) in [
        (
            r#"{"error":{"code":502,"message":"Upstream disconnected"},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}"#,
            Reason::ProviderInternal,
            Some(502),
            None,
        ),
        (
            r#"{"error":{"code":403,"message":"Request declined","metadata":{"error_type":"refusal"}},"choices":[{"finish_reason":"error"}]}"#,
            Reason::ContentPolicy,
            Some(403),
            Some("refusal"),
        ),
        (
            r#"{"choices":[{"finish_reason":"error","error":{"code":402,"message":"Balance unavailable"}}]}"#,
            Reason::QuotaExceeded,
            Some(402),
            None,
        ),
        (
            r#"{"choices":[{"finish_reason":"error"}]}"#,
            Reason::UnknownProvider,
            None,
            None,
        ),
    ] {
        let error = response(&mut OpenAIChat::parser(&request), &[frame]).unwrap_err();
        assert_eq!(error.reason, expected);
        assert_eq!(error.status, status);
        assert_eq!(error.code.as_deref(), code);
    }

    let mut parser = OpenAIChat::parser(&request);
    parser.push(&parse_json(r#"{"choices":[{"finish_reason":"tool_calls","delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":""}}]}}]}"#).unwrap()).unwrap();
    let late = parse_json(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"id\":7}"}}]}}]}"#).unwrap();
    assert_eq!(
        parser.push(&late).unwrap_err().reason,
        Reason::InvalidProviderOutput
    );
}
