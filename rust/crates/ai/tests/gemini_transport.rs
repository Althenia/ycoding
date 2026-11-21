use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use ycoding_ai::{
    auth::{Auth, Credential},
    google, google_vertex,
    google_vertex_shared::Config,
    llm::{Event, Message, Request, ToolChoice, ToolDefinition},
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
            let headers = String::from_utf8_lossy(&bytes[..end]);
            let length = headers
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length: ")
                        .and_then(|value| value.parse::<usize>().ok())
                })
                .unwrap_or(0);
            if bytes.len() >= end + 4 + length {
                return String::from_utf8(bytes).unwrap();
            }
        }
    }
}

#[tokio::test]
async fn recorded_requests_and_responses_are_byte_exact_through_http() {
    for (tool, raw) in [
        (false, include_str!("fixtures/gemini-text.json")),
        (true, include_str!("fixtures/gemini-tool.json")),
    ] {
        let fixture: serde_json::Value = serde_json::from_str(raw).unwrap();
        let expected = fixture["request"]["body"].as_str().unwrap().to_owned();
        let body = fixture["response"]["body"].as_str().unwrap().to_owned();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let actual = read_request(&mut socket).await;
            assert!(actual.starts_with(
                "POST /v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse HTTP/1.1\r\n"
            ));
            assert!(actual.contains("x-goog-api-key: fixture\r\n"));
            assert_eq!(actual.split_once("\r\n\r\n").unwrap().1, expected);
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n",body.len()).as_bytes()).await.unwrap();
            for chunk in body.as_bytes().chunks(7) {
                socket.write_all(chunk).await.unwrap();
            }
        });
        let route = google::route(google::Config {
            api_key: Some(Credential::value("fixture")),
            base_url: Some(format!("http://{address}/v1beta")),
            ..Default::default()
        });
        let mut request = Request::new(route.model("gemini-2.5-flash"));
        request.system.push(
            if tool {
                "Call tools exactly as requested."
            } else {
                "You are concise."
            }
            .into(),
        );
        request.messages.push(Message::user(if tool {
            "Call get_weather with city exactly Paris."
        } else {
            "Reply with exactly: Hello!"
        }));
        request.generation.max_tokens = Some(80.0);
        request.generation.temperature = Some(0.0);
        if tool {
            request.tools.push(ToolDefinition {name:"get_weather".into(),description:"Get current weather for a city.".into(),input_schema:parse_json(r#"{"type":"object","properties":{"city":{"type":"string"}},"required":["city"],"additionalProperties":false}"#).unwrap(),output_schema:None,cache:None,metadata:None,native:None});
            request.tool_choice = Some(ToolChoice::Tool("get_weather".into()));
        }
        let response = Executor::new(Executor::http_client().unwrap())
            .generate(&request)
            .await;
        server.await.unwrap();
        let response = response.unwrap();
        let usage = response.usage.as_ref().unwrap();
        assert_eq!(
            (
                usage.input_tokens,
                usage.output_tokens,
                usage.reasoning_tokens,
                usage.total_tokens
            ),
            if tool {
                (Some(55.0), Some(60.0), Some(45.0), Some(115.0))
            } else {
                (Some(11.0), Some(18.0), Some(16.0), Some(29.0))
            }
        );
        if !tool {
            assert_eq!(response.text().as_str(), Some("Hello!"));
            continue;
        }
        let call = response
            .events
            .iter()
            .find_map(|event| {
                if let Event::ToolCall(call) = event {
                    Some(call)
                } else {
                    None
                }
            })
            .unwrap();
        assert_eq!(call.input, parse_json(r#"{"city":"Paris"}"#).unwrap());
        assert!(call.provider_metadata.is_some());
        let mut replay = Request::new(request.model.clone());
        replay.messages.push(response.message);
        let encoded = stringify_json(&replay.model.route.prepare(&replay).unwrap().body);
        assert!(encoded.contains("thoughtSignature"));
    }
}

#[tokio::test]
async fn vertex_options_and_auth_reach_actual_http_transport() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let actual = read_request(&mut socket).await;
        assert!(actual.starts_with(
            "POST /v1/models/gemini-3.5-flash:streamGenerateContent?alt=sse HTTP/1.1\r\n"
        ));
        assert!(actual.contains("authorization: Bearer vertex-token\r\n"));
        assert_eq!(
            actual.split_once("\r\n\r\n").unwrap().1,
            r#"{"contents":[{"role":"user","parts":[{"text":"hello"}]}],"generationConfig":{"thinkingConfig":{"thinkingBudget":1024,"includeThoughts":true}},"safetySettings":[{"category":"HARM_CATEGORY_HATE_SPEECH","threshold":"BLOCK_NONE"}]}"#
        );
        let body = "data: {\"candidates\":[{\"finishReason\":\"STOP\"}]}\n\n";
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
    });
    let mut config = Config {
        access_token: Some(Credential::value("vertex-token")),
        base_url: Some(format!("http://{address}/v1")),
        ..Default::default()
    };
    config.defaults.provider_options = Some(
        parse_json(
            r#"{"gemini":{"thinkingConfig":{"thinkingBudget":1024,"includeThoughts":true}}}"#,
        )
        .unwrap(),
    );
    config.defaults.http.body=Some(parse_json(r#"{"safetySettings":[{"category":"HARM_CATEGORY_HATE_SPEECH","threshold":"BLOCK_NONE"}]}"#).unwrap());
    let mut request = Request::new(google_vertex::model("gemini-3.5-flash", config).unwrap());
    request.messages.push(Message::user("hello"));
    let result = Executor::new(Executor::http_client().unwrap())
        .generate(&request)
        .await;
    server.await.unwrap();
    result.unwrap();
}

#[tokio::test]
async fn google_http_errors_are_classified_without_credential_disclosure() {
    for (status, message, reason) in [
        (
            400,
            "too many tokens",
            ycoding_ai::provider_error::Reason::InvalidRequest,
        ),
        (
            401,
            "API key not valid",
            ycoding_ai::provider_error::Reason::Authentication,
        ),
        (
            429,
            "rate limit exceeded",
            ycoding_ai::provider_error::Reason::RateLimit,
        ),
        (
            500,
            "internal error",
            ycoding_ai::provider_error::Reason::ProviderInternal,
        ),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            let body = format!(r#"{{"error":{{"message":"{message} fixture-private-token"}}}}"#);
            socket.write_all(format!("HTTP/1.1 {status} Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nRetry-After: 2\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        });
        let route = google::route(google::Config {
            auth: Some(Auth::header(
                "x-goog-api-key",
                Credential::value("fixture-private-token"),
            )),
            base_url: Some(format!("http://{address}/v1")),
            ..Default::default()
        });
        let result = Executor::new(Executor::http_client().unwrap())
            .generate(&Request::new(route.model("gemini")))
            .await;
        server.await.unwrap();
        let error = result.unwrap_err();
        assert_eq!(error.reason, reason);
        assert_eq!(error.context_overflow, status == 400);
        assert_eq!(error.retry_after_ms, Some(2000.0));
        assert!(!format!("{error:?}").contains("fixture-private-token"));
    }
}
