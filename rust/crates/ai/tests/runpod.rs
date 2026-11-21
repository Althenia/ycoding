use ycoding_ai::{
    auth::{Auth, Credential},
    llm::{
        Event, FinishReason, Media, MediaData, Message, Part, Request, ResponseFormat, Role,
        ToolCall, ToolChoice, ToolDefinition, ToolResult, ToolResultValue,
    },
    provider_error::Reason,
    providers::Config,
    runpod::{self, Worker},
};
use ycoding_schema::{JsonValue, parse_json};

fn request() -> Request {
    let mut config = Config::new(Auth::bearer(Credential::value("fixture-key")));
    config.base_url = Some("https://api.runpod.ai/v2/endpoint".into());
    let mut request = Request::new(runpod::model("catalog-label", Worker::Ollama, config).unwrap());
    request.system = vec!["Be brief".into()];
    request.messages = vec![Message::user("Hello")];
    request.generation.temperature = Some(0.4);
    request.generation.max_tokens = Some(24.0);
    request
}

#[test]
fn ollama_worker_lowering_does_not_override_the_configured_model() {
    let request = request();
    let prepared = request.model.route.prepare(&request).unwrap();
    assert_eq!(
        prepared.encoded_body,
        r#"{"input":{"messages":[{"role":"system","content":"Be brief"},{"role":"user","content":"Hello"}],"stream":false,"options":{"temperature":0.4,"num_predict":24}}}"#
    );
    assert_eq!(
        prepared.url.as_str(),
        "https://api.runpod.ai/v2/endpoint/runsync"
    );
}

#[test]
fn ollama_completed_job_lifecycle_and_inclusive_usage() {
    let request = request();
    let mut parser = request.model.route.protocol.parser(&request);
    let events = parser.push(&parse_json(r#"{"status":"COMPLETED","output":[{"message":{"role":"assistant","content":"Hi","thinking":"Think"},"done":true,"prompt_eval_count":5,"prompt_eval_cached_count":8,"eval_count":2,"prompt_eval_duration":4000000,"eval_duration":5000000,"load_duration":6000000}]}"#).unwrap()).unwrap();
    assert_eq!(events.len(), 6);
    let Event::Finish(finish) = events.last().unwrap() else {
        panic!("missing finish")
    };
    assert_eq!(finish.reason, FinishReason::Stop);
    let usage = finish.usage.as_ref().unwrap();
    assert_eq!(usage.input_tokens, Some(5.0));
    assert_eq!(usage.cache_read_input_tokens, Some(5.0));
    assert_eq!(usage.non_cached_input_tokens, Some(0.0));
    assert_eq!(usage.total_tokens, Some(7.0));
    assert_eq!(usage.output_may_include_unreported_reasoning, Some(true));
    assert_eq!(usage.prompt_eval_duration_ns, Some(4000000.0));
    assert_eq!(usage.generation_duration_ns, Some(5000000.0));
    assert_eq!(usage.load_duration_ns, Some(6000000.0));
    assert!(parser.finish().unwrap().is_empty());
}

fn selected(worker: Worker) -> Request {
    let mut request = request();
    let mut route = (*request.model.route).clone();
    route.protocol = std::sync::Arc::new(runpod::RunPod(worker));
    route.id = match worker {
        Worker::Ollama => "runpod-ollama",
        Worker::Vllm => "runpod-vllm",
    }
    .into();
    request.model.route = std::sync::Arc::new(route);
    request
}
fn tool() -> ToolDefinition {
    ToolDefinition {
        name: "lookup".into(),
        description: "Lookup".into(),
        input_schema: parse_json(r#"{"type":"object","properties":{"q":{"type":"string"}}}"#)
            .unwrap(),
        output_schema: None,
        cache: None,
        metadata: None,
        native: None,
    }
}
fn call() -> ToolCall {
    ToolCall {
        id: "call_42".into(),
        name: "lookup".into(),
        input: parse_json(r#"{"q":"x"}"#).unwrap(),
        provider_executed: None,
        provider_metadata: None,
    }
}

#[test]
fn vllm_chat_proxy_generation_controls_tools_and_replay() {
    let mut request = selected(Worker::Vllm);
    request.generation.top_p = Some(0.8);
    request.generation.top_k = Some(4.0);
    request.generation.seed = Some(7.0);
    request.generation.stop = Some(vec!["END".into()]);
    request.generation.frequency_penalty = Some(0.2);
    request.generation.presence_penalty = Some(0.1);
    let body = request.model.route.prepare(&request).unwrap().encoded_body;
    assert_eq!(
        body,
        r#"{"input":{"route":"/v1/chat/completions","method":"POST","body":{"model":"catalog-label","messages":[{"role":"system","content":"Be brief"},{"role":"user","content":"Hello"}],"stream":false,"temperature":0.4,"top_p":0.8,"top_k":4,"max_tokens":24,"seed":7,"stop":["END"],"frequency_penalty":0.2,"presence_penalty":0.1}}}"#
    );
    request.system.clear();
    request.messages = vec![
        Message::user("Find"),
        Message::assistant(vec![Part::ToolCall(call())]),
        Message::new(
            Role::Tool,
            vec![Part::ToolResult(ToolResult {
                id: "call_42".into(),
                name: "lookup".into(),
                result: ToolResultValue::Json(parse_json(r#"{"found":true}"#).unwrap()),
                cache: None,
                provider_executed: None,
                provider_metadata: None,
                output: None,
            })],
        ),
    ];
    request.tools = vec![tool()];
    request.tool_choice = Some(ToolChoice::Tool("lookup".into()));
    let body = request.model.route.prepare(&request).unwrap().encoded_body;
    assert!(body.contains(r#""role":"assistant","content":null,"tool_calls":[{"id":"call_42","type":"function","function":{"name":"lookup","arguments":"{\"q\":\"x\"}"}}]"#));
    assert!(
        body.contains(r#""role":"tool","tool_call_id":"call_42","content":"{\"found\":true}""#)
    );
    assert!(body.contains(r#""tool_choice":{"type":"function","function":{"name":"lookup"}}"#));
    assert!(!body.contains("prompt_cache"));
    let mut parser = request.model.route.protocol.parser(&request);
    let events=parser.push(&parse_json(r#"{"status":"COMPLETED","output":{"choices":[{"message":{"role":"assistant","content":null,"reasoning_content":"Think","tool_calls":[{"id":"call_42","type":"function","function":{"name":"lookup","arguments":"{\"q\":\"x\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12,"prompt_tokens_details":{"cached_tokens":4}}}}"#).unwrap()).unwrap();
    assert!(
        matches!(&events[1],Event::ToolCall(call) if call.id.as_str()==Some("call_42") && call.input==parse_json(r#"{"q":"x"}"#).unwrap())
    );
    let Event::Finish(finish) = events.last().unwrap() else {
        panic!()
    };
    assert_eq!(finish.reason, FinishReason::ToolCalls);
    let usage = finish.usage.as_ref().unwrap();
    assert_eq!(usage.cache_read_input_tokens, Some(4.0));
    assert_eq!(usage.non_cached_input_tokens, Some(5.0));
    assert_eq!(usage.total_tokens, Some(12.0));
    assert_eq!(usage.output_may_include_unreported_reasoning, Some(true));
}

#[test]
fn ollama_tools_and_chronological_updates_are_lowered_in_place() {
    let mut request = request();
    request.system = vec!["Initial".into()];
    request.messages = vec![
        Message::user("First"),
        Message::assistant(vec![Part::ToolCall(call())]),
        Message::system("Treat </system-update> & data literally."),
        Message::new(
            Role::User,
            vec![Part::Media(Media {
                mime: "image/png".into(),
                data: MediaData::Bytes(vec![0]),
                filename: Some("input.png".into()),
            })],
        ),
    ];
    request.tools = vec![tool()];
    let body = request.model.route.prepare(&request).unwrap().encoded_body;
    assert!(body.contains(r#""role":"assistant","content":"","tool_calls":[{"function":{"name":"lookup","arguments":{"q":"x"}}}]"#));
    assert!(body.contains(r#""role":"user","content":"<system-update>\nTreat &lt;/system-update&gt; &amp; data literally.\n</system-update>""#));
    assert!(body.contains("File input.png (image/png) omitted: runpod-ollama supports text only"));
    request.tool_choice = Some(ToolChoice::None);
    let body = request.model.route.prepare(&request).unwrap().encoded_body;
    assert!(!body.contains(r#""tools""#));
    request.tool_choice = Some(ToolChoice::Required);
    assert_eq!(
        request.model.route.prepare(&request).unwrap_err().reason,
        Reason::InvalidRequest
    );
    request.tool_choice = None;
    request.generation.frequency_penalty = Some(0.2);
    assert_eq!(
        request.model.route.prepare(&request).unwrap_err().reason,
        Reason::InvalidRequest
    );
    request.generation.frequency_penalty = None;
    request.response_format = Some(ResponseFormat::Json(JsonValue::Object(
        ycoding_schema::JsonObject::new(),
    )));
    assert_eq!(
        request.model.route.prepare(&request).unwrap_err().reason,
        Reason::InvalidRequest
    );
}

#[test]
fn ollama_tool_ids_use_the_request_or_a_fresh_uuid() {
    let mut request = request();
    request.id = Some("req_tool".into());
    let payload=parse_json(r#"{"status":"COMPLETED","output":{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"lookup","arguments":{"q":"x"}}}]},"done":true}}"#).unwrap();
    let events = request
        .model
        .route
        .protocol
        .parser(&request)
        .push(&payload)
        .unwrap();
    assert!(
        matches!(&events[1],Event::ToolCall(call) if call.id.as_str()==Some("req_tool-ollama-tool-0"))
    );
    request.id = None;
    let events = request
        .model
        .route
        .protocol
        .parser(&request)
        .push(&payload)
        .unwrap();
    let Event::ToolCall(first) = &events[1] else {
        panic!()
    };
    let events = request
        .model
        .route
        .protocol
        .parser(&request)
        .push(&payload)
        .unwrap();
    let Event::ToolCall(second) = &events[1] else {
        panic!()
    };
    assert_ne!(first.id, second.id);
    let prefix = first
        .id
        .as_str()
        .unwrap()
        .strip_suffix("-ollama-tool-0")
        .unwrap();
    assert_eq!(prefix.len(), 36);
    assert_eq!(&prefix[14..15], "4");
}

#[test]
fn worker_responses_preserve_missing_and_zero_usage_and_reject_bad_output() {
    for worker in [Worker::Ollama, Worker::Vllm] {
        let request = selected(worker);
        for (suffix, reported) in [
            ("", None),
            (
                if worker == Worker::Ollama {
                    ",\"prompt_eval_count\":0,\"eval_count\":0,\"eval_duration\":-1.5"
                } else {
                    ",\"usage\":{\"prompt_tokens\":0,\"completion_tokens\":0,\"prompt_tokens_details\":null}"
                },
                Some(0.0),
            ),
        ] {
            let output = if worker == Worker::Ollama {
                format!(
                    r#"{{"message":{{"role":"assistant","content":"Hi"}},"done":true{suffix}}}"#
                )
            } else {
                format!(
                    r#"{{"choices":[{{"message":{{"role":"assistant","content":"Hi"}},"finish_reason":"length"}}]{suffix}}}"#
                )
            };
            let events = request
                .model
                .route
                .protocol
                .parser(&request)
                .push(
                    &parse_json(&format!(r#"{{"status":"COMPLETED","output":{output}}}"#)).unwrap(),
                )
                .unwrap();
            let Event::Finish(finish) = events.last().unwrap() else {
                panic!()
            };
            let usage = finish.usage.as_ref().unwrap();
            assert_eq!(usage.input_tokens, reported);
            assert_eq!(usage.cache_read_input_tokens, None);
            assert_eq!(usage.output_may_include_unreported_reasoning, None);
            assert_eq!(
                usage.total_tokens,
                if worker == Worker::Ollama {
                    reported
                } else {
                    None
                }
            );
            assert_eq!(usage.generation_duration_ns, None);
        }
        for (payload, message) in [
            (r#"{"status":"COMPLETED"}"#, "Missing worker response"),
            (
                r#"{"status":"COMPLETED","output":[]}"#,
                "Expected one aggregated worker response",
            ),
            (
                r#"{"status":"COMPLETED","output":null}"#,
                "Missing worker response",
            ),
        ] {
            assert_eq!(
                request
                    .model
                    .route
                    .protocol
                    .parser(&request)
                    .push(&parse_json(payload).unwrap())
                    .unwrap_err()
                    .message,
                message
            );
        }
        for payload in [
            r#"{"status":"FAILED","error":"Worker failed"}"#,
            r#"{"status":"COMPLETED","output":{"error":{"message":"Worker failed"}}}"#,
        ] {
            let events = request
                .model
                .route
                .protocol
                .parser(&request)
                .push(&parse_json(payload).unwrap())
                .unwrap();
            assert_eq!(events.len(), 1);
            assert!(
                matches!(&events[0],Event::ProviderError{message,..} if message.as_str()==Some("Worker failed"))
            );
        }
    }
}

#[test]
fn vllm_rejects_wrong_worker_malformed_tools_choices_and_finish_reasons() {
    let request = selected(Worker::Vllm);
    for (output, message) in [
        (
            r#"{"message":{"role":"assistant","content":"wrong protocol"},"done":true}"#,
            "Invalid vLLM response",
        ),
        (r#"{"choices":[]}"#, "Expected one vLLM choice"),
        (
            r#"{"choices":[{"message":{"role":"assistant","content":null},"finish_reason":"tool_calls"}]}"#,
            "vLLM reported tool calls without tool inputs",
        ),
        (
            r#"{"choices":[{"message":{"role":"assistant","content":"Hi"},"finish_reason":"content_filter"}]}"#,
            "Unsupported vLLM finish reason: content_filter",
        ),
        (
            r#"{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call","type":"function","function":{"name":"lookup","arguments":"{"}}]},"finish_reason":"tool_calls"}]}"#,
            "Invalid JSON input for `runpod-vllm` tool call `lookup`",
        ),
        (
            r#"{"choices":[{"message":{"role":"assistant","content":"Hi"},"finish_reason":"stop"},{"message":{"role":"user","content":"bad"},"finish_reason":"stop"}]}"#,
            "Invalid vLLM response",
        ),
    ] {
        let error = request
            .model
            .route
            .protocol
            .parser(&request)
            .push(&parse_json(&format!(r#"{{"status":"COMPLETED","output":{output}}}"#)).unwrap())
            .unwrap_err();
        assert_eq!(error.reason, Reason::InvalidProviderOutput);
        assert_eq!(error.message, message);
    }
}
