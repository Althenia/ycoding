use ycoding_ai::{
    llm::{Event, Message, Part, Reasoning, Request, Response},
    openai_chat::OpenAIChat,
    openai_responses::OpenAIResponses,
    route::{Route, StreamParser},
};
use ycoding_schema::{parse_json, stringify_json};

fn response(parser: &mut dyn StreamParser, frames: &[&str]) -> Result<Response, ycoding_ai::Error> {
    let mut events = Vec::new();
    for frame in frames {
        events.extend(parser.push(&parse_json(frame).unwrap())?);
    }
    events.extend(parser.finish()?);
    Response::from_events(events)
}

#[test]
fn chat_request_and_late_usage_fixture() {
    let route = Route::openai_chat();
    let mut request = Request::new(route.model("gpt-4o-mini"));
    request.system = vec!["You are concise.".into()];
    request.messages = vec![Message::user("Say hello.")];
    request.generation.max_tokens = Some(20.0);
    request.generation.temperature = Some(0.0);
    assert_eq!(route.prepare(&request).unwrap().body,parse_json(r#"{"model":"gpt-4o-mini","messages":[{"role":"system","content":"You are concise."},{"role":"user","content":"Say hello."}],"stream":true,"stream_options":{"include_usage":true},"max_tokens":20,"temperature":0}"#).unwrap());
    let result=response(&mut OpenAIChat::parser(&request),&[
        r#"{"choices":[{"delta":{"content":"Hello"}}]}"#,
        r#"{"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}"#,
        r#"{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14,"prompt_tokens_details":{"cached_tokens":3},"completion_tokens_details":{"reasoning_tokens":1}}}"#,
    ]).unwrap();
    assert_eq!(result.text().as_str(), Some("Hello!"));
    let usage = result.usage.unwrap();
    assert_eq!(
        (
            usage.input_tokens,
            usage.non_cached_input_tokens,
            usage.cache_read_input_tokens,
            usage.output_tokens,
            usage.reasoning_tokens
        ),
        (Some(10.0), Some(7.0), Some(3.0), Some(4.0), Some(1.0))
    );
}

#[test]
fn cache_wire_fields_are_model_and_route_gated() {
    for (model, new) in [("gpt-5.5", false), ("gpt-5.6", true), ("gpt-6-luna", true)] {
        for route in [Route::openai_chat(), Route::openai_responses()] {
            let mut request = Request::new(route.model(model));
            request.system = vec!["fixed".into()];
            request.messages = vec![Message::user("tail")];
            request.provider_options=Some(parse_json(r#"{"openai":{"promptCacheRetention":"24h","promptCacheOptions":{"mode":"explicit","ttl":"30m"}}}"#).unwrap());
            let body = stringify_json(&route.prepare(&request).unwrap().body);
            assert_eq!(body.contains("prompt_cache_options"), new);
            assert_eq!(body.contains("prompt_cache_retention"), !new);
            assert_eq!(body.contains("prompt_cache_breakpoint"), new);
        }
    }
}

#[test]
fn responses_encrypted_reasoning_replay_and_tool_input_splits() {
    let route = Route::openai_responses();
    let mut request = Request::new(route.model("gpt-5.6"));
    let result=response(&mut OpenAIResponses::parser(&request),&[
        r#"{"type":"response.output_item.added","item":{"type":"reasoning","id":"rs_1"}}"#,
        r#"{"type":"response.reasoning_summary_text.delta","item_id":"rs_1","summary_index":0,"delta":"think"}"#,
        r#"{"type":"response.reasoning_summary_part.done","item_id":"rs_1","summary_index":0}"#,
        r#"{"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_1","encrypted_content":"encrypted-state"}}"#,
        r#"{"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup"}}"#,
        r#"{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\"q\":"}"#,
        r#"{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"\"ไทย\"}"}"#,
        r#"{"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup"}}"#,
        r#"{"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":10,"output_tokens":4}}}"#,
    ]).unwrap();
    assert!(result.events.iter().any(|event|matches!(event,Event::ToolCall(call) if call.input==parse_json(r#"{"q":"ไทย"}"#).unwrap())));
    assert_eq!(
        result.finish_reason,
        ycoding_ai::llm::FinishReason::ToolCalls
    );
    request.messages = vec![result.message];
    let body = stringify_json(&route.prepare(&request).unwrap().body);
    assert!(body.contains(r#""encrypted_content":"encrypted-state""#));
    assert!(!body.contains("item_reference"));
    request.provider_options = Some(parse_json(r#"{"openai":{"store":true}}"#).unwrap());
    assert!(
        stringify_json(&route.prepare(&request).unwrap().body)
            .contains(r#"{"type":"item_reference","id":"rs_1"}"#)
    );
}

#[test]
fn responses_absent_usage_incomplete_and_failed_are_distinct() {
    let request = Request::new(Route::openai_responses().model("gpt-4.1"));
    let result=response(&mut OpenAIResponses::parser(&request),&[r#"{"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"},"usage":{}}}"#]).unwrap();
    assert_eq!(result.finish_reason, ycoding_ai::llm::FinishReason::Length);
    let usage = result.usage.unwrap();
    assert_eq!(usage.input_tokens, None);
    assert_eq!(usage.cache_read_input_tokens, None);
    assert_eq!(usage.reasoning_tokens, None);
    let error=response(&mut OpenAIResponses::parser(&request),&[r#"{"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded","message":"slow down"}}}"#]).unwrap_err();
    assert_eq!(error.reason, ycoding_ai::provider_error::Reason::RateLimit);
    assert!(
        response(
            &mut OpenAIResponses::parser(&request),
            &[r#"{"type":"response.output_text.delta","delta":"partial"}"#]
        )
        .is_err()
    );
}

#[test]
fn chat_thought_and_partial_identity_are_replayed_as_reasoning() {
    let request = Request::new(Route::openai_chat().model("llama-4-maverick"));
    let result=response(&mut OpenAIChat::parser(&request),&[
        r#"{"choices":[{"delta":{"thought":"reason"}}]}"#,
        r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call","function":{"arguments":"{\"q\":"}}]}}]}"#,
        r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"lookup","arguments":"1}"}}]},"finish_reason":"tool_calls"}]}"#,
    ]).unwrap();
    assert_eq!(result.reasoning().as_str(), Some("reason"));
    assert!(result.events.iter().any(|event|matches!(event,Event::ToolCall(call) if call.input==parse_json(r#"{"q":1}"#).unwrap())));
    let mut replay = request;
    replay.messages = vec![result.message];
    assert!(
        stringify_json(&replay.model.route.prepare(&replay).unwrap().body)
            .contains(r#""thought":"reason""#)
    );
    let reasoning = Part::Reasoning(Reasoning {
        text: "canonical".into(),
        encrypted: None,
        provider_metadata: None,
    });
    replay.messages = vec![Message::assistant(vec![reasoning])];
    assert!(
        stringify_json(&replay.model.route.prepare(&replay).unwrap().body)
            .contains("reasoning_content")
    );
}

#[test]
fn responses_reconcile_final_text_phase_and_citations_without_duplicate_output() {
    let request = Request::new(Route::openai_responses().model("gpt-5.6"));
    let result=response(&mut OpenAIResponses::parser(&request),&[
        r#"{"type":"response.output_item.added","item":{"type":"message","id":"msg","phase":"final_answer"}}"#,
        r#"{"type":"response.output_text.delta","item_id":"msg","delta":"Hel"}"#,
        r#"{"type":"response.output_text.annotation.added","item_id":"msg","annotation":{"type":"url_citation","title":"Fixture","url":"https://fixture.invalid/source"}}"#,
        r#"{"type":"response.output_text.done","item_id":"msg","text":"Hello"}"#,
        r#"{"type":"response.output_item.done","item":{"type":"message","id":"msg","phase":"final_answer","content":[{"type":"output_text","text":"Hello"}]}}"#,
        r#"{"type":"response.completed","response":{"output":[{"type":"message","id":"msg","content":[{"type":"output_text","text":"Hello"}]}]}}"#,
    ]).unwrap();
    assert_eq!(
        result.text().as_str(),
        Some("Hel\n\nSource: Fixture\nhttps://fixture.invalid/sourcelo")
    );
    assert_eq!(
        result
            .events
            .iter()
            .filter(|event| matches!(event, Event::Finish(_)))
            .count(),
        1
    );
    let mut replay = request.clone();
    replay.messages = vec![result.message];
    assert!(
        stringify_json(&replay.model.route.prepare(&replay).unwrap().body)
            .contains(r#""phase":"final_answer""#)
    );
    assert!(
        response(
            &mut OpenAIResponses::parser(&request),
            &[
                r#"{"type":"response.output_text.delta","item_id":"msg","delta":"known"}"#,
                r#"{"type":"response.output_text.done","item_id":"msg","text":"changed"}"#
            ]
        )
        .is_err()
    );
    let result=response(&mut OpenAIResponses::parser(&request),&[r#"{"type":"response.completed","response":{"output":[{"type":"message","id":"msg","content":[{"type":"output_text","text":"only final"}]}]}}"#]).unwrap();
    assert_eq!(result.text().as_str(), Some("only final"));
}

#[test]
fn reasoning_parts_group_for_stateless_replay_and_compaction_prunes_history() {
    let route = Route::openai_responses();
    let request = Request::new(route.model("gpt-5.6"));
    let result=response(&mut OpenAIResponses::parser(&request),&[
        r#"{"type":"response.output_item.added","item":{"type":"reasoning","id":"rs","encrypted_content":null}}"#,
        r#"{"type":"response.reasoning_summary_text.delta","item_id":"rs","summary_index":0,"delta":"First"}"#,
        r#"{"type":"response.reasoning_summary_part.done","item_id":"rs","summary_index":0}"#,
        r#"{"type":"response.reasoning_summary_part.added","item_id":"rs","summary_index":1}"#,
        r#"{"type":"response.reasoning_summary_text.delta","item_id":"rs","summary_index":1,"delta":"Second"}"#,
        r#"{"type":"response.reasoning_summary_part.done","item_id":"rs","summary_index":1}"#,
        r#"{"type":"response.output_item.done","item":{"type":"reasoning","id":"rs","encrypted_content":"encrypted"}}"#,
        r#"{"type":"response.completed","response":{"usage":{"output_tokens":12}}}"#,
    ]).unwrap();
    assert_eq!(result.reasoning().as_str(), Some("FirstSecond"));
    assert_eq!(
        result
            .usage
            .unwrap()
            .output_may_include_unreported_reasoning,
        Some(true)
    );
    let mut replay = request;
    replay.messages = vec![result.message];
    let body = stringify_json(&route.prepare(&replay).unwrap().body);
    assert_eq!(body.matches(r#""type":"reasoning""#).count(), 1);
    assert!(body.contains("First"));
    assert!(body.contains("Second"));
    assert!(body.contains("encrypted"));
    let compaction=Part::Reasoning(Reasoning {text:"".into(),encrypted:None,provider_metadata:Some(parse_json(r#"{"openai":{"opaqueCompactionItem":{"type":"compaction","id":"compact","encrypted_content":"opaque","extra":{"version":2}}}}"#).unwrap())});
    replay.messages = vec![
        Message::user("discard"),
        Message::assistant(vec![Part::Text("discard assistant".into()), compaction]),
        Message::user("keep"),
    ];
    let body = stringify_json(&route.prepare(&replay).unwrap().body);
    assert!(!body.contains("discard"));
    assert!(body.contains("keep"));
    assert!(body.contains(r#""extra":{"version":2}"#));
}

#[test]
fn imported_compaction_metadata_still_bounds_stateless_openai_history() {
    let mut request = Request::new(Route::openai_responses().model("gpt-5.6"));
    let compaction = Part::Reasoning(Reasoning {
        text: "".into(),
        encrypted: None,
        provider_metadata: Some(parse_json(r#"{"copilot":{"opaqueCompactionItem":{"type":"compaction","id":"compact","encrypted_content":"opaque"}}}"#).unwrap()),
    });
    request.messages = vec![
        Message::user("discard"),
        Message::assistant(vec![
            Part::Text("discard assistant".into()),
            compaction.clone(),
        ]),
        Message::user("keep"),
    ];
    request.provider_options = Some(parse_json(r#"{"openai":{"store":false}}"#).unwrap());
    assert_eq!(
        ycoding_ai::openai_responses::prune_messages(&request),
        vec![Message::assistant(vec![compaction]), Message::user("keep"),]
    );
    request.provider_options = Some(parse_json(r#"{"openai":{"store":true}}"#).unwrap());
    assert_eq!(
        ycoding_ai::openai_responses::prune_messages(&request),
        request.messages
    );
}

#[test]
fn chat_think_markers_and_reasoning_details_are_lossless_across_splits() {
    let request = Request::new(Route::openai_chat().model("fixture"));
    let text = "<think>ไทย</think>answer";
    for split in text
        .char_indices()
        .map(|(index, _)| index)
        .chain([text.len()])
    {
        let first =
            serde_json::json!({"choices":[{"delta":{"content":&text[..split]}}]}).to_string();
        let second=serde_json::json!({"choices":[{"delta":{"content":&text[split..]},"finish_reason":"stop"}]}).to_string();
        let result = response(&mut OpenAIChat::parser(&request), &[&first, &second]).unwrap();
        assert_eq!(result.reasoning().as_str(), Some("ไทย"));
        assert_eq!(result.text().as_str(), Some("answer"));
    }
    let result=response(&mut OpenAIChat::parser(&request),&[
        r#"{"choices":[{"delta":{"reasoning":"abc","reasoning_details":[{"type":"reasoning.text","id":"rs","text":"abc","signature":"sig"}]}}]}"#,
        r#"{"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","id":"rs","text":"def","signature":"sig"}]}}]}"#,
        r#"{"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}"#,
    ]).unwrap();
    assert_eq!(result.reasoning().as_str(), Some("abcdef"));
    let mut replay = request;
    replay.messages = vec![result.message];
    let body = stringify_json(&replay.model.route.prepare(&replay).unwrap().body);
    assert!(body.contains(r#""signature":"sig""#));
    assert!(body.contains(r#""reasoning":"abcdef""#));
}

#[test]
fn hosted_tools_and_local_malformed_inputs_remain_distinct() {
    let request = Request::new(Route::openai_responses().model("fixture"));
    let result=response(&mut OpenAIResponses::parser(&request),&[
        r#"{"type":"response.output_item.done","item":{"type":"function_call","id":"fc","call_id":"call","name":"lookup","arguments":"{"}}"#,
        r#"{"type":"response.output_item.done","item":{"type":"web_search_call","id":"ws","action":{"type":"search","query":"fixture"},"status":"completed","opaque":true}}"#,
        r#"{"type":"response.output_item.done","item":{"type":"image_generation_call","id":"img","result":"AQID","output_format":"png"}}"#,
        r#"{"type":"response.completed"}"#,
    ]).unwrap();
    assert!(
        result
            .events
            .iter()
            .any(|event| matches!(event, Event::ToolInputError { .. }))
    );
    assert!(
        result.events.iter().any(
            |event| matches!(event,Event::ToolCall(call) if call.provider_executed==Some(true))
        )
    );
    assert_eq!(
        result.finish_reason,
        ycoding_ai::llm::FinishReason::ToolCalls
    );
    let mut replay = request;
    replay.messages = vec![result.message];
    let body = stringify_json(&replay.model.route.prepare(&replay).unwrap().body);
    assert!(body.contains("web_search_call"));
    assert!(body.contains("data:image/png;base64,AQID"));
    assert!(!body.contains(r#""name":"image_generation""#));
}

#[test]
fn usage_zero_absence_clamping_and_refusal_settlement() {
    for usage in [
        "{}",
        r#"{"input_tokens":0,"output_tokens":0,"input_tokens_details":{"cached_tokens":0},"output_tokens_details":{"reasoning_tokens":0}}"#,
    ] {
        let request = Request::new(Route::openai_responses().model("fixture"));
        let frame = format!(
            r#"{{"type":"response.incomplete","response":{{"incomplete_details":{{"reason":"content_filter"}},"usage":{usage}}}}}"#
        );
        let result = response(&mut OpenAIResponses::parser(&request), &[&frame]).unwrap();
        assert_eq!(
            result.finish_reason,
            ycoding_ai::llm::FinishReason::ContentFilter
        );
        let usage = result.usage.unwrap();
        if usage.input_tokens.is_some() {
            assert_eq!(usage.cache_read_input_tokens, Some(0.0));
            assert_eq!(usage.reasoning_tokens, Some(0.0));
        } else {
            assert_eq!(usage.cache_read_input_tokens, None);
            assert_eq!(usage.reasoning_tokens, None);
            assert_eq!(usage.total_tokens, None);
        }
    }
    let request = Request::new(Route::openai_chat().model("deepseek-chat"));
    let result=response(&mut OpenAIChat::parser(&request),&[r#"{"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"prompt_cache_hit_tokens":9,"prompt_tokens_details":{"cached_tokens":7,"cache_write_tokens":4},"completion_tokens":2},"cache_discount":0}"#]).unwrap();
    let usage = result.usage.unwrap();
    assert_eq!(usage.cache_read_input_tokens, Some(5.0));
    assert_eq!(usage.cache_write_input_tokens, Some(0.0));
    assert_eq!(usage.non_cached_input_tokens, Some(0.0));
    assert!(
        stringify_json(usage.provider_metadata.as_ref().unwrap()).contains(r#""cache_discount":0"#)
    );
}
