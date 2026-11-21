use std::sync::Arc;
use ycoding_ai::{
    llm::{self, Event, Request},
    route::{AttemptFuture, Executor, ProcessAttempt, ProcessInput, Route, Transport},
};
use ycoding_schema::parse_json;

fn chunk(value: &str) -> ycoding_schema::JsonValue {
    parse_json(value).unwrap()
}

struct Fake;

impl ProcessAttempt for Fake {
    fn attempt(&self, input: ProcessInput) -> AttemptFuture<'_> {
        Box::pin(async move {
            assert_eq!(input.model.as_str(), Some("fake-model"));
            Ok(vec![
                chunk(
                    r#"{"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}"#,
                ),
                chunk(
                    r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\"city\":\"Paris\"}"}}]},"finish_reason":null}]}"#,
                ),
                chunk(
                    r#"{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}"#,
                ),
            ])
        })
    }
}

#[tokio::test]
async fn process_attempt_streams_text_tool_call_and_usage() {
    let mut route = Route::openai_chat();
    route.transport = Transport::Process(Arc::new(Fake));
    let mut request = Request::new(route.model("fake-model"));
    request.messages = vec![llm::Message::user("hi")];
    let response = Executor::new(Executor::http_client().unwrap())
        .generate(&request)
        .await
        .unwrap();
    assert_eq!(response.text().as_str(), Some("Hello"));
    let call = response
        .events
        .iter()
        .find_map(|event| match event {
            Event::ToolCall(call) => Some(call),
            _ => None,
        })
        .expect("one tool call");
    assert_eq!(call.name.as_str(), Some("get_weather"));
    assert_eq!(
        ycoding_schema::stringify_json(&call.input),
        "{\"city\":\"Paris\"}".to_string()
    );
    let usage = response.usage.expect("usage");
    assert_eq!(
        (usage.input_tokens, usage.output_tokens, usage.total_tokens),
        (Some(10.0), Some(20.0), Some(30.0))
    );
}
