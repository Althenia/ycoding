use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};
use ycoding_ai::{
    auth::{Credential, ProviderAuth},
    llm::{Event, Request},
    route::{Attempt, AttemptPhase, AttemptStage, Executor, Route},
};
use ycoding_schema::parse_json;

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
fn executor(attempts: &Arc<Mutex<Vec<Attempt>>>) -> Executor {
    let mut executor = Executor::new(Executor::http_client().unwrap());
    let attempts = attempts.clone();
    executor.observer = Some(Arc::new(move |attempt| {
        attempts.lock().unwrap().push(attempt);
        Ok(())
    }));
    executor
}
fn request(address: std::net::SocketAddr) -> Request {
    let route = Route::anthropic_compatible(
        format!("http://{address}/v1/"),
        None,
        ProviderAuth::ApiKey(Credential::value("fixture-private-token")),
    )
    .unwrap();
    let mut request = Request::new(route.model("claude-sonnet-4-5"));
    request
        .messages
        .push(ycoding_ai::llm::Message::user("hello"));
    request
}

#[tokio::test]
async fn recorded_anthropic_request_response_flow() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/anthropic-text.json")).unwrap();
    let recorded_request = fixture["request"]["body"].as_str().unwrap().to_owned();
    let body = fixture["response"]["body"].as_str().unwrap().to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let actual = read_request(&mut socket).await;
        assert_eq!(actual.split_once("\r\n\r\n").unwrap().1, recorded_request);
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
    });
    let route = Route::anthropic_compatible(
        format!("http://{address}/v1"),
        None,
        ProviderAuth::ApiKey(Credential::value("fixture")),
    )
    .unwrap();
    let mut request = Request::new(route.model("claude-haiku-4-5-20251001"));
    request.cache = ycoding_ai::cache::Policy::None;
    request.system = vec!["You are concise.".into()];
    request.messages = vec![ycoding_ai::llm::Message::user("Reply with exactly: Hello!")];
    request.generation.max_tokens = Some(20.0);
    request.generation.temperature = Some(0.0);
    let response = Executor::new(Executor::http_client().unwrap())
        .generate(&request)
        .await
        .unwrap();
    server.await.unwrap();
    assert_eq!(response.text().as_str(), Some("Hello!"));
    let usage = response.usage.unwrap();
    assert_eq!(
        (
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_input_tokens,
            usage.cache_write_input_tokens
        ),
        (Some(18.0), Some(5.0), Some(0.0), Some(0.0))
    );
}

#[tokio::test]
async fn actual_request_incremental_stream_and_single_attempt() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captured_tx, captured_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        captured_tx.send(read_request(&mut socket).await).unwrap();
        let first = "retry: 1000\r\n\r\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ไทย\"}}\r\n\r\n";
        let last = "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"input_tokens\":5,\"output_tokens\":2}}\n\ndata: [DONE]\n\n";
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n",first.len()+last.len()).as_bytes()).await.unwrap();
        for byte in first.bytes() {
            socket.write_all(&[byte]).await.unwrap();
        }
        release_rx.await.unwrap();
        socket.write_all(last.as_bytes()).await.unwrap();
    });
    let attempts = Arc::new(Mutex::new(Vec::new()));
    let executor = executor(&attempts);
    let mut request = request(address);
    request.http.query.insert("custom".into(), "a b".into());
    request.http.body = Some(parse_json(r#"{"metadata":{"user_id":"fixture"}}"#).unwrap());
    let mut stream = executor.stream(&request).await.unwrap();
    assert!(matches!(
        stream.next().await.unwrap(),
        Some(Event::StepStart { index: 0.0 })
    ));
    assert!(matches!(
        stream.next().await.unwrap(),
        Some(Event::TextStart(_))
    ));
    assert!(
        matches!(stream.next().await.unwrap(),Some(Event::TextDelta(delta)) if delta.text.as_str()==Some("ไทย"))
    );
    let actual = captured_rx.await.unwrap();
    assert!(actual.starts_with("POST /v1/messages?custom=a+b HTTP/1.1\r\n"));
    assert!(actual.contains("x-api-key: fixture-private-token"));
    assert!(actual.contains("anthropic-version: 2023-06-01"));
    assert!(actual.contains("content-type: application/json"));
    assert!(actual.contains("connection: close"));
    let body = actual.split_once("\r\n\r\n").unwrap().1;
    assert!(body.contains(r#""metadata":{"user_id":"fixture"}"#));
    release_tx.send(()).unwrap();
    let mut finish = 0;
    while let Some(event) = stream.next().await.unwrap() {
        if let Event::Finish(result) = event {
            finish += 1;
            assert_eq!(result.usage.unwrap().input_tokens, Some(5.0));
        }
    }
    assert_eq!(finish, 1);
    drop(stream);
    server.await.unwrap();
    let attempts = attempts.lock().unwrap();
    assert_eq!(attempts.len(), 2);
    assert!(attempts.iter().all(|attempt| attempt.attempt == 1));
    assert_eq!(
        (attempts[0].phase, attempts[0].stage),
        (AttemptPhase::Started, Some(AttemptStage::Request))
    );
    assert_eq!(
        (attempts[1].phase, attempts[1].stage, attempts[1].status),
        (
            AttemptPhase::Succeeded,
            Some(AttemptStage::Stream),
            Some(200)
        )
    );
}

#[tokio::test]
async fn http_failure_redaction_classification_and_no_retry() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_request(&mut socket).await;
        assert!(request.contains("fixture-private-token"));
        let body = r#"{"error":{"type":"rate_limit_error","message":"echo fixture-private-token"},"api_key":"other-private-value"}"#;
        socket.write_all(format!("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 30\r\nX-Request-ID: fixture-request\r\nX-Echo: fixture-private-token\r\nAnthropic-Ratelimit-Input-Tokens-Reset: fixture-private-token\r\nContent-Length: {}\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
    });
    let attempts = Arc::new(Mutex::new(Vec::new()));
    let error = executor(&attempts)
        .generate(&request(address))
        .await
        .unwrap_err();
    server.await.unwrap();
    assert_eq!(error.reason, ycoding_ai::provider_error::Reason::RateLimit);
    assert_eq!(error.retry_after_ms, Some(30_000.0));
    assert_eq!(
        error.http.as_ref().unwrap().request_id.as_deref(),
        Some("fixture-request")
    );
    let debug = format!("{error:?} {error}");
    assert!(!debug.contains("fixture-private-token"));
    assert!(!debug.contains("other-private-value"));
    let attempts = attempts.lock().unwrap();
    assert_eq!(attempts.len(), 2);
    assert!(attempts.iter().all(|attempt| attempt.attempt == 1));
    assert_eq!(
        (attempts[1].phase, attempts[1].stage, attempts[1].failure),
        (
            AttemptPhase::Failed,
            Some(AttemptStage::Request),
            Some("request")
        )
    );
}

#[tokio::test]
async fn interruption_before_headers_settles_attempt_once() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (accepted_tx, accepted_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        read_request(&mut socket).await;
        accepted_tx.send(()).unwrap();
        release_rx.await.unwrap();
    });
    let attempts = Arc::new(Mutex::new(Vec::new()));
    let executor = executor(&attempts);
    let request = request(address);
    let running = tokio::spawn(async move { executor.generate(&request).await });
    accepted_rx.await.unwrap();
    running.abort();
    assert!(running.await.unwrap_err().is_cancelled());
    release_tx.send(()).unwrap();
    server.await.unwrap();
    let attempts = attempts.lock().unwrap();
    assert_eq!(attempts.len(), 2);
    assert_eq!(attempts[1].phase, AttemptPhase::Failed);
    assert_eq!(attempts[1].failure, Some("request"));
}

#[tokio::test]
async fn interruption_during_read_and_malformed_settlement() {
    for malformed in [true, false] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (release_tx, release_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            let body = "data: [DONE]\n\n";
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                        if malformed {
                            body.len()
                        } else {
                            body.len() + 100
                        }
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            if !malformed {
                release_rx.await.unwrap();
            }
        });
        let attempts = Arc::new(Mutex::new(Vec::new()));
        let executor = executor(&attempts);
        let mut stream = executor.stream(&request(address)).await.unwrap();
        if malformed {
            assert_eq!(
                stream.next().await.unwrap_err().message,
                "Provider stream ended without a terminal finish event"
            );
        } else {
            drop(stream);
            release_tx.send(()).unwrap();
        }
        server.await.unwrap();
        let attempts = attempts.lock().unwrap();
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[1].phase, AttemptPhase::Succeeded);
    }
}
