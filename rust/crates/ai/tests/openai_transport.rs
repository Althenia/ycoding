use futures_util::{SinkExt, StreamExt};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_tungstenite::{accept_async, tungstenite::Message};
use ycoding_ai::{
    auth::{Auth, Credential},
    llm::{self, Request},
    providers::{self, Config, OpenAIConfig, Transport},
    route::{Executor, Route},
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
async fn recorded_chat_matches_exact_request_and_late_usage() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/openai-chat-text.json")).unwrap();
    let expected = fixture["request"]["body"].as_str().unwrap().to_owned();
    let body = fixture["response"]["body"].as_str().unwrap().to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let actual = read_request(&mut socket).await;
        assert_eq!(actual.split_once("\r\n\r\n").unwrap().1, expected);
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n",body.len()).as_bytes()).await.unwrap();
        for byte in body.bytes() {
            socket.write_all(&[byte]).await.unwrap();
        }
    });
    let mut route = Route::openai_chat();
    route.endpoint.base_url = format!("http://{address}/v1");
    route.auth = Auth::bearer(Credential::value("fixture"));
    let mut request = Request::new(route.model("gpt-4o-mini"));
    request.system = vec!["You are concise.".into()];
    request.messages = vec![llm::Message::user("Say hello in one short sentence.")];
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
            usage.cache_read_input_tokens,
            usage.output_tokens,
            usage.reasoning_tokens
        ),
        (Some(22.0), Some(0.0), Some(2.0), Some(0.0))
    );
}

#[tokio::test]
async fn responses_websocket_wire_replay_and_terminal_do_not_require_close() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(socket).await.unwrap();
        let message = socket.next().await.unwrap().unwrap().into_text().unwrap();
        let body: serde_json::Value = serde_json::from_str(&message).unwrap();
        assert_eq!(body["type"], "response.create");
        assert!(body.get("stream").is_none());
        assert_eq!(body["metadata"]["fixture"], true);
        assert_eq!(body["prompt_cache_options"]["mode"], "explicit");
        socket.send(Message::Text(r#"{"type":"response.output_item.done","item":{"type":"message","id":"msg","content":[{"type":"output_text","text":"answer"}]}}"#.into())).await.unwrap();
        socket
            .send(Message::Text(
                r#"{"type":"response.completed","response":{"id":"resp_1"}}"#.into(),
            ))
            .await
            .unwrap();
        let message = socket.next().await.unwrap().unwrap().into_text().unwrap();
        let body: serde_json::Value = serde_json::from_str(&message).unwrap();
        assert_eq!(body["previous_response_id"], "resp_1");
        assert_eq!(body["input"].as_array().unwrap().len(), 1);
        assert_eq!(body["input"][0]["content"][0]["text"], "next");
        socket
            .send(Message::Text(
                r#"{"type":"response.completed","response":{"id":"resp_2"}}"#.into(),
            ))
            .await
            .unwrap();
        release_rx.await.unwrap();
    });
    let mut common = Config::new(Auth::bearer(Credential::value("fixture")));
    common.base_url = Some(format!("http://{address}/v1"));
    common.defaults.http.body = Some(parse_json(r#"{"metadata":{"fixture":true}}"#).unwrap());
    let model = providers::openai(
        "gpt-5.6",
        OpenAIConfig {
            common,
            organization: None,
            project: None,
            transport: Transport::WebSocket,
        },
    );
    let mut request = Request::new(model);
    request.messages = vec![llm::Message::user("hello")];
    request.provider_options=Some(parse_json(r#"{"openai":{"store":false,"promptCacheOptions":{"mode":"explicit","ttl":"30m"},"responsesWebSocket":{"sessionKey":"fixture-session","fingerprint":"same","messageBoundary":1}}}"#).unwrap());
    let executor = Executor::new(Executor::http_client().unwrap());
    let response = executor.generate(&request).await.unwrap();
    assert_eq!(response.text().as_str(), Some("answer"));
    request.messages.push(response.message);
    request.messages.push(llm::Message::user("next"));
    request.provider_options=Some(parse_json(r#"{"openai":{"store":false,"promptCacheOptions":{"mode":"explicit","ttl":"30m"},"responsesWebSocket":{"sessionKey":"fixture-session","fingerprint":"same","messageBoundary":3}}}"#).unwrap());
    let response = executor.generate(&request).await.unwrap();
    assert_eq!(response.text().as_str(), Some(""));
    release_tx.send(()).unwrap();
    server.await.unwrap();
    let encoded = stringify_json(&request.model.route.prepare(&request).unwrap().wire_body);
    assert!(encoded.contains("metadata"));
}

#[tokio::test]
async fn recorded_responses_matches_schema_order_and_preserves_encrypted_replay() {
    let expected = include_str!("fixtures/openai-responses-reasoning-request.json")
        .trim()
        .to_owned();
    let body = include_str!("fixtures/openai-responses-reasoning.sse").to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let actual = read_request(&mut socket).await;
        assert_eq!(actual.split_once("\r\n\r\n").unwrap().1, expected);
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
    });
    let mut common = Config::new(Auth::bearer(Credential::value("fixture")));
    common.base_url = Some(format!("http://{address}/v1"));
    let model = providers::openai(
        "gpt-5.5",
        OpenAIConfig {
            common,
            organization: None,
            project: None,
            transport: Transport::Http,
        },
    );
    let mut request = Request::new(model);
    request.system = vec![
        "Show concise reasoning when the provider supports visible reasoning summaries.".into(),
    ];
    request.messages = vec![llm::Message::user(
        "Think briefly, then reply exactly with: Hello!",
    )];
    request.generation.max_tokens = Some(120.0);
    request.provider_options=Some(parse_json(r#"{"openai":{"store":false,"include":["reasoning.encrypted_content"],"reasoningEffort":"low","reasoningSummary":"auto","textVerbosity":"low"}}"#).unwrap());
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
            usage.reasoning_tokens,
            usage.cache_read_input_tokens
        ),
        (Some(31.0), Some(21.0), Some(13.0), Some(0.0))
    );
    request.messages.push(response.message);
    let replay = stringify_json(&request.model.route.prepare(&request).unwrap().body);
    assert!(replay.contains("encrypted_content"));
    assert!(!replay.contains("item_reference"));
}
