use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use ycoding_ai::{
    auth::{Auth, Credential},
    github_copilot,
    llm::{Event, FinishReason, Message, Part, Request, Role, ToolResult, ToolResultValue},
    providers::{self, Api, Config},
    route::Executor,
};
use ycoding_schema::{parse_json, stringify_json};

async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut chunk = [0; 1024];
    loop {
        let count = socket.read(&mut chunk).await.unwrap();
        assert_ne!(count, 0);
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            let length = String::from_utf8_lossy(&bytes[..end])
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length: ")
                        .and_then(|value| value.parse::<usize>().ok())
                })
                .unwrap();
            if bytes.len() >= end + 4 + length {
                return String::from_utf8(bytes).unwrap();
            }
        }
    }
}

fn request(address: std::net::SocketAddr, api: Api, id: &str) -> Request {
    let mut common = Config::new(Auth::bearer(Credential::value("fixture")));
    common.base_url = Some(format!("http://{address}"));
    Request::new(
        providers::github_copilot_sdk(
            id,
            github_copilot::Config {
                common,
                api: Some(api),
                user_agent: "ycoding/fixture".into(),
            },
        )
        .unwrap(),
    )
}

#[tokio::test]
async fn recorded_chat_exact_bytes_and_sse_fragments() {
    for (fixture, expected_reason, input, output) in [
        (
            include_str!("fixtures/github-copilot-text.sse"),
            FinishReason::Stop,
            None,
            None,
        ),
        (
            include_str!("fixtures/github-copilot-tools.sse"),
            FinishReason::ToolCalls,
            Some(19581.0),
            Some(53.0),
        ),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let actual = read_request(&mut socket).await;
            let (headers, body) = actual.split_once("\r\n\r\n").unwrap();
            assert_eq!(
                body,
                r#"{"model":"test-model","messages":[{"role":"user","content":"Hello"}],"stream":true}"#
            );
            assert!(headers.starts_with("POST /chat/completions HTTP/1.1"));
            assert!(headers.contains("x-initiator: user"));
            assert!(headers.contains("user-agent: ycoding/fixture"));
            assert!(headers.contains("authorization: Bearer fixture"));
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n",fixture.len()).as_bytes()).await.unwrap();
            for byte in fixture.bytes() {
                socket.write_all(&[byte]).await.unwrap();
            }
        });
        let mut request = request(address, Api::Chat, "test-model");
        request.messages = vec![Message::user("Hello")];
        let response = Executor::new(Executor::http_client().unwrap())
            .generate(&request)
            .await
            .unwrap();
        server.await.unwrap();
        assert_eq!(response.finish_reason, expected_reason);
        assert_eq!(
            response.usage.as_ref().and_then(|usage| usage.input_tokens),
            input
        );
        assert_eq!(
            response
                .usage
                .as_ref()
                .and_then(|usage| usage.output_tokens),
            output
        );
        if expected_reason == FinishReason::Stop {
            assert_eq!(response.text().as_str(), Some("Hello world!"));
        } else {
            let calls = response
                .events
                .iter()
                .filter_map(|event| {
                    if let Event::ToolCall(call) = event {
                        Some(call)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>();
            assert_eq!(calls.len(), 2);
            assert_eq!(calls[0].id.as_str(), Some("call_abc123"));
            assert_eq!(calls[1].id.as_str(), Some("call_def456"));
            assert_eq!(
                response.usage.as_ref().unwrap().cache_read_input_tokens,
                Some(17068.0)
            );
            assert_eq!(response.usage.as_ref().unwrap().reasoning_tokens, None);
            assert_eq!(calls[0].provider_metadata, Some(parse_json(r#"{"copilot":{"reasoningOpaque":"4CUQ6696CwSXOdQ5rtvDimqA91tBzfmga4ieRbmZ5P67T2NLW3"}}"#).unwrap()));
            request.messages.push(response.message);
            assert!(
                stringify_json(&request.model.route.prepare(&request).unwrap().body)
                    .contains("reasoning_opaque")
            );
        }
    }
}

#[tokio::test]
async fn responses_stateless_tool_followup_keeps_encrypted_reasoning_on_wire() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for (expected, response) in [
            (
                r#"{"model":"gpt-5.5","input":[{"role":"user","content":[{"type":"input_text","text":"Hello"}]}],"store":false,"stream":true}"#,
                concat!(
                    "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"id\":\"rs_1\",\"encrypted_content\":\"enc_1\"}}\n\n",
                    "data: {\"type\":\"response.reasoning_summary_text.delta\",\"item_id\":\"rs_1\",\"summary_index\":0,\"delta\":\"thinking...\"}\n\n",
                    "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"id\":\"rs_1\",\"encrypted_content\":\"enc_1\"}}\n\n",
                    "data: {\"type\":\"response.output_item.done\",\"output_index\":1,\"item\":{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"lookup\",\"arguments\":\"{}\",\"id\":\"fc_1\"}}\n\n",
                    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}\n\n"
                ),
            ),
            (
                r#"{"model":"gpt-5.5","input":[{"role":"user","content":[{"type":"input_text","text":"Hello"}]},{"type":"reasoning","id":"rs_1","encrypted_content":"enc_1","summary":[{"type":"summary_text","text":"thinking..."}]},{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{}","id":"fc_1"},{"type":"function_call_output","call_id":"call_1","output":"synthetic result"}],"store":false,"stream":true}"#,
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_2\",\"usage\":{\"input_tokens\":20,\"output_tokens\":5}}}\n\n",
            ),
        ] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let actual = read_request(&mut socket).await;
            let (headers, body) = actual.split_once("\r\n\r\n").unwrap();
            assert_eq!(body, expected);
            assert!(headers.starts_with("POST /responses HTTP/1.1"));
            assert_eq!(
                headers.contains("x-initiator: agent"),
                body.contains("function_call_output")
            );
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{response}",response.len()).as_bytes()).await.unwrap();
        }
    });
    let mut request = request(address, Api::Responses, "gpt-5.5");
    request.provider_options = Some(parse_json(r#"{"copilot":{"store":false}}"#).unwrap());
    request.messages = vec![Message::user("Hello")];
    let executor = Executor::new(Executor::http_client().unwrap());
    let first = executor.generate(&request).await.unwrap();
    assert_eq!(first.finish_reason, FinishReason::ToolCalls);
    request.messages.push(first.message);
    request.messages.push(Message::new(
        Role::Tool,
        vec![Part::ToolResult(ToolResult {
            id: "call_1".into(),
            name: "lookup".into(),
            result: ToolResultValue::Text(parse_json(r#""synthetic result""#).unwrap()),
            cache: None,
            provider_executed: None,
            provider_metadata: None,
            output: None,
        })],
    ));
    let second = executor.generate(&request).await.unwrap();
    server.await.unwrap();
    assert_eq!(second.finish_reason, FinishReason::Stop);
    assert_eq!(second.usage.unwrap().input_tokens, Some(20.0));
}

#[tokio::test]
async fn copilot_http_errors_accept_loose_error_shapes_before_stream_parsing() {
    for api in [Api::Chat, Api::Responses] {
        for (status, body, reason) in [
            (
                400,
                r#"{"error":{"type":"invalid_request_error","message":"Bad request"}}"#,
                ycoding_ai::provider_error::Reason::InvalidRequest,
            ),
            (
                400,
                r#"{"error":{"type":null,"message":"Bad request","code":503,"param":{"name":"model"}}}"#,
                ycoding_ai::provider_error::Reason::InvalidRequest,
            ),
            (
                402,
                r#"{"error":{"type":"invalid_request_error","message":"Bad request","code":null,"param":null}}"#,
                ycoding_ai::provider_error::Reason::InvalidRequest,
            ),
            (
                429,
                r#"{"error":{"message":"Slow down","code":"rate_limit_exceeded","param":["model"]}}"#,
                ycoding_ai::provider_error::Reason::RateLimit,
            ),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let actual = read_request(&mut socket).await;
                assert!(actual.contains("authorization: Bearer fixture"));
                socket.write_all(format!("HTTP/1.1 {status} Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            });
            let mut request = request(address, api, "test-model");
            request.messages = vec![Message::user("Hello")];
            let error = Executor::new(Executor::http_client().unwrap())
                .generate(&request)
                .await
                .unwrap_err();
            server.await.unwrap();
            assert_eq!(error.reason, reason);
            assert_eq!(error.status, Some(status));
            assert!(error.message.contains(&format!("HTTP {status}")));
            assert!(error.message.contains(if status == 429 {
                "Slow down"
            } else {
                "Bad request"
            }));
            let context = error.http.as_ref().unwrap();
            assert_eq!(context.body.as_deref(), Some(body));
            assert_eq!(context.request_headers["authorization"], "<redacted>");
            assert!(!format!("{error:?}").contains("Bearer fixture"));
        }
    }
}
