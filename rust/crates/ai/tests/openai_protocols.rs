use ycoding_ai::{
    llm::{Event, Message, Part, Reasoning, Request, Response},
    openai_chat::OpenAIChat,
    openai_responses::OpenAIResponses,
    route::{Route, StreamParser},
};
use ycoding_schema::{parse_json, stringify_json};

#[path = "openai_protocols/chat_parity.rs"]
mod chat_parity;

fn response(parser: &mut dyn StreamParser, frames: &[&str]) -> Result<Response, ycoding_ai::Error> {
    let mut events = Vec::new();
    for frame in frames {
        events.extend(parser.push(&parse_json(frame).unwrap())?);
    }
    events.extend(parser.finish()?);
    Response::from_events(events)
}

#[test]
fn provider_recovery_responses_output_limit_retains_partial_text_and_reported_usage() {
    let request = Request::new(Route::openai_responses().model("fixture"));
    let result = response(&mut OpenAIResponses::parser(&request), &[
        r#"{"type":"response.in_progress","response":{"usage":{"input_tokens":11,"output_tokens":4}}}"#,
        r#"{"type":"response.output_text.delta","item_id":"msg","delta":"Partial"}"#,
        r#"{"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":null}}"#,
    ]).unwrap();
    assert_eq!(result.text().as_str(), Some("Partial"));
    assert_eq!(result.finish_reason, ycoding_ai::llm::FinishReason::Length);
    assert_eq!(result.usage.unwrap().output_tokens, Some(4.0));
    assert!(matches!(
        result.events.as_slice(),
        [
            ..,
            Event::TextEnd(_),
            Event::StepFinish { .. },
            Event::Finish(_)
        ]
    ));
}

#[test]
fn provider_recovery_responses_in_band_failure_keeps_the_provider_classification() {
    use ycoding_ai::provider_error::Reason;

    let request = Request::new(Route::openai_responses().model("fixture"));
    for (code, reason) in [
        ("server_error", Reason::ProviderInternal),
        ("authentication_error", Reason::Authentication),
        ("insufficient_quota", Reason::QuotaExceeded),
        ("invalid_prompt", Reason::InvalidRequest),
        ("content_filter", Reason::ContentPolicy),
        ("unrecognized", Reason::UnknownProvider),
    ] {
        let frame = format!(
            r#"{{"type":"response.failed","response":{{"status":"failed","usage":{{"input_tokens":11}},"error":{{"code":"{code}","message":"Request failed"}}}}}}"#
        );
        let mut parser = OpenAIResponses::parser(&request);
        assert!(parser.reported_usage().is_none());
        let error = response(&mut parser, &[&frame]).unwrap_err();
        assert_eq!(error.reason, reason, "{code}");
        assert_eq!(error.code.as_deref(), Some(code));
        assert_eq!(parser.reported_usage().unwrap().input_tokens, Some(11.0));
    }
}

#[test]
fn direct_api_key_cache_recording_preserves_cold_and_warm_token_counts() {
    let recording: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/ai/test/fixtures/recordings/openai-responses-cache/reports-cached-tokens-on-identical-second-call.json"
    )).unwrap();
    let interactions = recording["interactions"].as_array().unwrap();
    assert_eq!(interactions.len(), 2);
    assert_eq!(
        interactions[0]["request"]["body"],
        interactions[1]["request"]["body"]
    );
    let request = Request::new(Route::openai_responses().model("gpt-4.1-mini"));
    let tokens = interactions
        .iter()
        .map(|interaction| {
            assert_eq!(
                interaction["request"]["url"],
                "https://api.openai.com/v1/responses"
            );
            let frames = interaction["response"]["body"]
                .as_str()
                .unwrap()
                .lines()
                .filter_map(|line| line.strip_prefix("data: "))
                .filter(|line| *line != "[DONE]")
                .collect::<Vec<_>>();
            let usage = response(&mut OpenAIResponses::parser(&request), &frames)
                .unwrap()
                .usage
                .unwrap();
            (usage.input_tokens, usage.cache_read_input_tokens)
        })
        .collect::<Vec<_>>();
    assert_eq!(
        tokens,
        [(Some(4765.0), Some(0.0)), (Some(4765.0), Some(4608.0))]
    );
}

#[test]
fn temperature_is_omitted_on_codex_routes() {
    for id in ["openai-codex-responses", "openai-codex-websocket-responses"] {
        let mut route = Route::openai_responses();
        route.id = id.into();
        let mut request = Request::new(route.model("gpt-4o-mini"));
        request.messages = vec![Message::user("Hello")];
        request.generation.temperature = Some(0.2);
        let body = stringify_json(&route.prepare(&request).unwrap().body);
        assert!(!body.contains("\"temperature\""), "{id}: {body}");
    }
}

#[test]
fn temperature_is_omitted_for_active_responses_reasoning() {
    let route = Route::openai_responses();
    for (effort, expected) in [("none", true), ("high", false)] {
        let mut request = Request::new(route.model("gpt-4o-mini"));
        request.messages = vec![Message::user("Hello")];
        request.generation.temperature = Some(0.2);
        request.provider_options =
            Some(parse_json(&format!(r#"{{"openai":{{"reasoningEffort":"{effort}"}}}}"#)).unwrap());
        let body = stringify_json(&route.prepare(&request).unwrap().body);
        assert_eq!(
            body.contains("\"temperature\""),
            expected,
            "{effort}: {body}"
        );
    }
}

#[test]
fn terra_supports_mid_conversation_effort() {
    assert!(ycoding_ai::effort::gpt6("gpt-6.1-terra"));
    for router in [false, true] {
        let model = if router {
            ycoding_ai::providers::openrouter(
                "openai/gpt-6.1-terra",
                ycoding_ai::providers::OpenRouterConfig {
                    common: ycoding_ai::providers::Config::new(ycoding_ai::auth::Auth::None),
                    reasoning: None,
                },
            )
        } else {
            Route::openai_responses().model("gpt-6.1-terra")
        };
        let mut update = Message::new(ycoding_ai::llm::Role::System, vec![]);
        update.native = Some(
            parse_json(if router {
                r#"{"openrouter":{"effort":"high"}}"#
            } else {
                r#"{"openai":{"reasoningEffort":"high"}}"#
            })
            .unwrap(),
        );
        let mut request = Request::new(model);
        request.messages = vec![Message::user("first"), update, Message::user("second")];
        let body = stringify_json(&request.model.route.prepare(&request).unwrap().body);
        assert!(body.contains("configuration_update"), "{body}");
    }
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

#[test]
fn openai_chat_and_responses_refusals_settle_as_content_filter() {
    let chat = Request::new(Route::openai_chat().model("fixture"));
    let result = response(
        &mut OpenAIChat::parser(&chat),
        &[
            r#"{"choices":[{"index":0,"delta":{"refusal":"I can't help with that."},"finish_reason":null}]}"#,
            r#"{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
        ],
    )
    .unwrap();
    assert_eq!(
        result.finish_reason,
        ycoding_ai::llm::FinishReason::ContentFilter
    );
    let plain = response(
        &mut OpenAIChat::parser(&chat),
        &[
            r#"{"choices":[{"index":0,"delta":{"refusal":""},"finish_reason":null}]}"#,
            r#"{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
        ],
    )
    .unwrap();
    assert_eq!(plain.finish_reason, ycoding_ai::llm::FinishReason::Stop);
    let responses = Request::new(Route::openai_responses().model("fixture"));
    for frames in [
        vec![
            r#"{"type":"response.refusal.delta","item_id":"msg","output_index":0,"content_index":0,"delta":"I can't"}"#,
            r#"{"type":"response.refusal.done","item_id":"msg","output_index":0,"content_index":0,"refusal":"I can't"}"#,
            r#"{"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}"#,
        ],
        vec![
            r#"{"type":"response.completed","response":{"output":[{"type":"message","id":"msg","role":"assistant","content":[{"type":"refusal","refusal":"I can't"}]}],"usage":{"input_tokens":1,"output_tokens":1}}}"#,
        ],
    ] {
        let result = response(&mut OpenAIResponses::parser(&responses), &frames).unwrap();
        assert_eq!(
            result.finish_reason,
            ycoding_ai::llm::FinishReason::ContentFilter,
            "{frames:?}"
        );
    }
}

mod responses_parity {
    use super::*;
    use ycoding_ai::{
        llm::{FinishReason, Media, MediaData, Role},
        provider_error::Reason,
        route::Executor,
    };

    #[test]
    fn copilot_terminal_reasoning_rotation_keeps_one_replayable_part() {
        let mut common = ycoding_ai::providers::Config::new(ycoding_ai::auth::Auth::None);
        common.base_url = Some("https://copilot.fixture.invalid".into());
        let request = Request::new(
            ycoding_ai::providers::github_copilot_sdk(
                "o3",
                ycoding_ai::github_copilot::Config {
                    common,
                    api: Some(ycoding_ai::providers::Api::Responses),
                    user_agent: "fixture".into(),
                },
            )
            .unwrap(),
        );
        let result = response(
            &mut *request.model.route.protocol.parser(&request),
            &[
                r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","encrypted_content":"enc_initial"}}"#,
                r#"{"type":"response.reasoning_summary_text.delta","item_id":"rs_1","summary_index":0,"delta":"first"}"#,
                r#"{"type":"response.completed","response":{"status":"completed","output":[{"type":"reasoning","id":"rs_rotated","summary":[{"type":"summary_text","text":"first and final"}],"encrypted_content":"enc_final"}]}}"#,
            ],
        ).unwrap();
        let [Part::Reasoning(part)] = result.message.content.as_slice() else {
            panic!("expected one replayable reasoning part");
        };
        assert_eq!(part.text.as_str(), Some("first and final"));
        assert_eq!(
            part.provider_metadata,
            Some(
                parse_json(
                    r#"{"copilot":{"itemId":"rs_1","reasoningEncryptedContent":"enc_final"}}"#
                )
                .unwrap()
            )
        );
    }

    #[tokio::test]
    async fn assistant_phases_and_route_specific_media_are_encoded_on_the_wire() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut route = Route::openai_responses();
        route.endpoint.base_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut reader = tokio::io::BufReader::new(&mut socket);
            use tokio::io::AsyncBufReadExt;
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            assert_eq!(line, "POST /v1/responses HTTP/1.1\r\n");
            let mut length = None;
            loop {
                line.clear();
                assert_ne!(reader.read_line(&mut line).await.unwrap(), 0);
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = Some(value.trim().parse::<usize>().unwrap());
                }
            }
            let mut body = vec![0; length.unwrap()];
            reader.read_exact(&mut body).await.unwrap();
            let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let event = "data: {\"type\":\"response.completed\"}\n\n";
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{event}", event.len()).as_bytes()).await.unwrap();
            body
        });
        let mut request = Request::new(route.model("gpt-5.6"));
        let text = |value: &str, phase: &str| {
            let mut part = ycoding_ai::llm::TextPart::from(value);
            part.provider_metadata =
                Some(parse_json(&format!(r#"{{"openai":{{"phase":"{phase}"}}}}"#)).unwrap());
            Part::Text(part)
        };
        let file = |mime: &str, filename: &str| {
            Part::Media(Media {
                mime: mime.into(),
                data: MediaData::Bytes(vec![1, 2, 3]),
                filename: Some(filename.into()),
            })
        };
        request.system = vec!["initial".into()];
        request.messages = vec![
            Message::new(
                Role::User,
                vec![
                    file("image/png", "picture.png"),
                    file("application/pdf", "paper.pdf"),
                ],
            ),
            Message::system("later"),
            Message::assistant(vec![
                text("checking", "commentary"),
                text("checked", "final_answer"),
            ]),
        ];
        let response = Executor::new(Executor::http_client().unwrap())
            .generate(&request)
            .await
            .unwrap();
        let body = server.await.unwrap();
        assert_eq!(response.finish_reason, FinishReason::Stop);
        let input = body["input"].as_array().unwrap();
        assert_eq!(
            input[0],
            serde_json::json!({"role":"system","content":"initial"})
        );
        assert_eq!(
            input[1]["content"][0],
            serde_json::json!({"type":"input_image","image_url":"data:image/png;base64,AQID"})
        );
        assert_eq!(input[1]["content"][1]["type"], "input_text");
        assert!(
            input[1]["content"][1]["text"]
                .as_str()
                .unwrap()
                .contains("paper.pdf (application/pdf) omitted")
        );
        assert_eq!(
            input[2],
            serde_json::json!({"role":"system","content":[{"type":"input_text","text":"later"}]})
        );
        assert_eq!(
            input[3..],
            [
                serde_json::json!({"role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"checking"}]}),
                serde_json::json!({"role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"checked"}]}),
            ]
        );

        let mut config = ycoding_ai::providers::Config::new(ycoding_ai::auth::Auth::None);
        config.base_url = Some("https://copilot.fixture.invalid".into());
        let copilot = ycoding_ai::providers::github_copilot_sdk(
            "o3",
            ycoding_ai::github_copilot::Config {
                common: config,
                api: Some(ycoding_ai::providers::Api::Responses),
                user_agent: "fixture".into(),
            },
        )
        .unwrap();
        let mut request = Request::new(copilot);
        request.system = vec!["initial".into()];
        request.messages = vec![
            Message::new(Role::User, vec![file("application/pdf", "paper.pdf")]),
            Message::system("later"),
        ];
        let prepared = request.model.route.prepare(&request).unwrap();
        let body: serde_json::Value = serde_json::from_str(&prepared.encoded_body).unwrap();
        assert_eq!(
            body["input"],
            serde_json::json!([
                {"role":"developer","content":"initial"},
                {"role":"user","content":[{"type":"input_file","filename":"paper.pdf","file_data":"data:application/pdf;base64,AQID"}]},
                {"role":"developer","content":"later"},
            ])
        );
    }

    #[test]
    fn reconciles_terminal_function_calls_once_in_terminal_order() {
        let request = Request::new(Route::openai_responses().model("fixture"));
        let result = response(&mut OpenAIResponses::parser(&request), &[
            r#"{"type":"response.output_item.added","item":{"type":"function_call","id":"fc_a","call_id":"call_a","name":"lookup","arguments":""}}"#,
            r#"{"type":"response.function_call_arguments.delta","item_id":"fc_a","delta":"{\"q\":"}"#,
            r#"{"type":"response.function_call_arguments.done","item_id":"fc_a","arguments":"{\"q\":1}"}"#,
            r#"{"type":"response.output_item.done","item":{"type":"function_call","id":"fc_a","call_id":"call_a","name":"lookup","status":"completed"}}"#,
            r#"{"type":"response.completed","response":{"output":[{"type":"function_call","call_id":"call_a","name":"lookup","status":"completed"},{"type":"function_call","call_id":"call_b","name":"lookup","arguments":"{\"q\":2}","status":"completed"}]}}"#,
        ]).unwrap();
        assert_eq!(result.finish_reason, FinishReason::ToolCalls);
        let calls = result
            .events
            .iter()
            .filter_map(|event| match event {
                Event::ToolCall(call) => {
                    if call.id.as_str() == Some("call_b") {
                        assert!(call.provider_metadata.is_none());
                    }
                    Some((call.id.as_str().unwrap(), stringify_json(&call.input)))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            calls,
            [
                ("call_a", "{\"q\":1}".into()),
                ("call_b", "{\"q\":2}".into())
            ]
        );
        for (id, arguments) in calls {
            let input_events = result
                .events
                .iter()
                .filter_map(|event| match event {
                    Event::ToolInputStart(call) if call.id.as_str() == Some(id) => {
                        Some(("start", ""))
                    }
                    Event::ToolInputDelta { id: call, text, .. } if call.as_str() == Some(id) => {
                        Some(("delta", text.as_str().unwrap()))
                    }
                    Event::ToolInputEnd(call) if call.id.as_str() == Some(id) => Some(("end", "")),
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert_eq!(input_events.first(), Some(&("start", "")));
            assert_eq!(input_events.last(), Some(&("end", "")));
            let mut body = String::new();
            for (kind, text) in &input_events[1..input_events.len() - 1] {
                assert_eq!(*kind, "delta");
                body.push_str(text);
            }
            assert_eq!(body, arguments);
        }
        assert!(
            !result
                .events
                .iter()
                .any(|event| matches!(event, Event::ToolInputError { .. }))
        );
        assert!(matches!(result.events.last(), Some(Event::Finish(_))));
    }

    #[test]
    fn withholds_local_calls_on_incomplete_failed_refused_or_disconnected_turns() {
        let request = Request::new(Route::openai_responses().model("fixture"));
        let done = parse_json(r#"{"type":"response.output_item.done","item":{"type":"function_call","id":"fc","call_id":"call","name":"lookup","arguments":"{}","status":"completed"}}"#).unwrap();
        for (terminal, finish, error) in [
            (
                Some(
                    r#"{"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}"#,
                ),
                Some(FinishReason::Length),
                None,
            ),
            (
                Some(r#"{"type":"response.incomplete","response":{"incomplete_details":null}}"#),
                Some(FinishReason::Unknown),
                None,
            ),
            (
                Some(
                    r#"{"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded","message":"slow down"}}}"#,
                ),
                None,
                Some(Reason::RateLimit),
            ),
            (
                Some(
                    r#"{"type":"response.completed","response":{"output":[{"type":"message","id":"msg","content":[{"type":"refusal","refusal":""}]}]}}"#,
                ),
                Some(FinishReason::ContentFilter),
                None,
            ),
            (None, None, Some(Reason::Transport)),
        ] {
            let mut parser = OpenAIResponses::parser(&request);
            let mut events = parser.push(&done).unwrap();
            let result = match terminal {
                Some(frame) => parser.push(&parse_json(frame).unwrap()),
                None => parser.finish(),
            };
            if let Some(error) = error {
                assert_eq!(result.unwrap_err().reason, error);
            } else {
                events.extend(result.unwrap());
                events.extend(parser.finish().unwrap());
            }
            assert!(
                !events.iter().any(|event| matches!(
                    event,
                    Event::ToolCall(_) | Event::ToolInputError { .. }
                )),
                "{terminal:?}"
            );
            assert_eq!(
                events.iter().find_map(|event| match event {
                    Event::Finish(finish) => Some(finish.reason),
                    _ => None,
                }),
                finish
            );
        }
    }

    #[test]
    fn does_not_synthesize_a_call_from_unfinished_or_absent_arguments() {
        let request = Request::new(Route::openai_responses().model("fixture"));
        let result = response(&mut OpenAIResponses::parser(&request), &[
            r#"{"type":"response.output_item.added","item":{"type":"function_call","id":"fc_a","call_id":"call_a","name":"lookup","arguments":"{}"}}"#,
            r#"{"type":"response.output_item.done","item":{"type":"function_call","id":"fc_a","call_id":"call_a","name":"lookup","arguments":"{}","status":"incomplete"}}"#,
            r#"{"type":"response.output_item.done","item":{"type":"function_call","id":"fc_b","call_id":"call_b","name":"lookup"}}"#,
            r#"{"type":"response.completed","response":{"output":[{"type":"function_call","id":"fc_a","call_id":"call_a","name":"lookup","arguments":"{}","status":"incomplete"}]}}"#,
        ]).unwrap();
        assert_eq!(result.finish_reason, FinishReason::Stop);
        assert!(
            !result
                .events
                .iter()
                .any(|event| matches!(event, Event::ToolCall(_) | Event::ToolInputError { .. }))
        );
    }

    #[test]
    fn recovers_final_reasoning_summaries_and_encryption_for_replay() {
        let route = Route::openai_responses();
        let mut request = Request::new(route.model("fixture"));
        let result = response(&mut OpenAIResponses::parser(&request), &[
            r#"{"type":"response.reasoning_summary_text.delta","item_id":"rs","summary_index":0,"delta":"First "}"#,
            r#"{"type":"response.reasoning_summary_text.done","item_id":"rs","summary_index":0,"text":"First summary"}"#,
            r#"{"type":"response.reasoning_summary_part.done","item_id":"rs","summary_index":1,"part":{"type":"summary_text","text":"Second summary"}}"#,
            r#"{"type":"response.output_item.done","item":{"type":"reasoning","id":"rs","encrypted_content":null}}"#,
            r#"{"type":"response.completed","response":{"output":[{"type":"reasoning","id":"rs","summary":[{"type":"summary_text","text":"First summary"},{"type":"summary_text","text":"Second summary"}],"encrypted_content":"encrypted-state"},{"type":"message","id":"msg","content":[{"type":"output_text","text":"answer"}]}],"usage":{"input_tokens":5,"input_tokens_details":{"cached_tokens":0},"output_tokens":3}}}"#,
        ]).unwrap();
        assert_eq!(
            result.reasoning().as_str(),
            Some("First summarySecond summary")
        );
        let usage = result.usage.unwrap();
        assert_eq!(usage.cache_read_input_tokens, Some(0.0));
        assert_eq!(usage.reasoning_tokens, None);
        assert_eq!(usage.output_may_include_unreported_reasoning, Some(true));
        request.messages = vec![result.message];
        let body: serde_json::Value =
            serde_json::from_str(&stringify_json(&route.prepare(&request).unwrap().body)).unwrap();
        assert_eq!(
            body["input"][0],
            serde_json::json!({"type":"reasoning","summary":[{"type":"summary_text","text":"First summary"},{"type":"summary_text","text":"Second summary"}],"encrypted_content":"encrypted-state"})
        );
        assert_eq!(body["input"][1]["role"], "assistant");
    }

    #[test]
    fn hosted_terminal_items_deduplicate_and_keep_image_replay_valid() {
        let route = Route::openai_responses();
        let mut request = Request::new(route.model("fixture"));
        let result = response(&mut OpenAIResponses::parser(&request), &[
            r#"{"type":"response.output_item.done","item":{"type":"image_generation_call","id":"img","status":"completed","result":"AQ\r\nID","output_format":"png"}}"#,
            r#"{"type":"response.completed","response":{"output":[{"type":"image_generation_call","id":"img","status":"completed","result":"AQ\r\nID","output_format":"png"},{"type":"code_interpreter_call","id":"ci","status":"completed","code":null,"container_id":"cntr","outputs":null}]}}"#,
        ]).unwrap();
        assert_eq!(result.finish_reason, FinishReason::Stop);
        let hosted = result
            .events
            .iter()
            .filter_map(|event| match event {
                Event::ToolCall(call) if call.provider_executed == Some(true) => call.name.as_str(),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(hosted, ["image_generation", "code_interpreter"]);
        request.messages = vec![result.message];
        let body = stringify_json(&route.prepare(&request).unwrap().body);
        assert!(body.contains("data:image/png;base64,AQID"), "{body}");
    }

    #[test]
    fn handles_refusal_content_parts_and_preserves_upstream_error_details() {
        let request = Request::new(Route::openai_responses().model("fixture"));
        let reason = |frames: &[&str]| {
            response(&mut OpenAIResponses::parser(&request), frames)
                .unwrap()
                .finish_reason
        };
        assert_eq!(
            reason(&[
                r#"{"type":"response.content_part.done","item_id":"msg","part":{"type":"refusal","refusal":"Cannot provide that"}}"#,
                r#"{"type":"response.completed"}"#,
            ]),
            FinishReason::ContentFilter
        );
        assert_eq!(
            reason(&[
                r#"{"type":"response.refusal.delta","item_id":"msg","delta":""}"#,
                r#"{"type":"response.completed"}"#,
            ]),
            FinishReason::Stop
        );
        let error = response(&mut OpenAIResponses::parser(&request), &[
            r#"{"type":"error","message":null,"error":null,"response":{"error":{"code":"context_length_exceeded","message":"Input is too long"}}}"#,
        ]).unwrap_err();
        assert!(error.context_overflow, "{error:?}");
        assert_eq!(error.code.as_deref(), Some("context_length_exceeded"));
        assert_eq!(error.message, "context_length_exceeded: Input is too long");
        let error = response(
            &mut OpenAIResponses::parser(&request),
            &[r#"{"type":"error","status":429,"error":{"message":"Slow down"}}"#],
        )
        .unwrap_err();
        assert_eq!((error.reason, error.status), (Reason::RateLimit, Some(429)));
    }
}
