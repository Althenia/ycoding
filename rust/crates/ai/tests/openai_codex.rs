use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_tungstenite::{accept_hdr_async, tungstenite::handshake::server};
use ycoding_ai::{
    auth::Credential,
    llm::{Message, Model, Request},
    openai_codex::{self, Config, TurnStates},
    route::Executor,
};
use ycoding_schema::parse_json;

async fn read(socket: &mut tokio::net::TcpStream) -> (String, serde_json::Value) {
    let mut bytes = Vec::new();
    let mut chunk = [0; 1024];
    loop {
        let count = socket.read(&mut chunk).await.unwrap();
        assert_ne!(count, 0);
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&bytes[..end]).into_owned();
            let length = headers
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length: ")
                        .and_then(|value| value.parse::<usize>().ok())
                })
                .unwrap();
            if bytes.len() >= end + 4 + length {
                return (headers, serde_json::from_slice(&bytes[end + 4..]).unwrap());
            }
        }
    }
}
fn selected(account: Option<&str>, websocket: bool, states: Arc<TurnStates>) -> Model {
    let mut config = Config::new(Credential::value("fixture-token"));
    config.account_id = account.map(String::from);
    config.websocket = websocket;
    config.turn_states = states;
    openai_codex::model("gpt-5.6-luna", config).unwrap()
}
fn request(model: &Model, user: Option<&str>, cache: Option<&str>) -> Request {
    let mut request = Request::new(model.clone());
    let mut message = Message::user("Hello");
    message.id = user.map(Into::into);
    request.messages.push(message);
    if let Some(cache) = cache {
        request.provider_options = Some(parse_json(&serde_json::json!({"openai":{"promptCacheKey":cache,"promptCacheOptions":{"mode":"explicit","ttl":"30m"},"promptCacheRetention":"24h"}}).to_string()).unwrap());
    }
    request
}
const COMPLETED: &str = "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"fixture-response\",\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":0,\"total_tokens\":1}}}\n\n";
async fn reply(socket: &mut tokio::net::TcpStream, token: Option<&str>) {
    let header = token
        .map(|token| format!("x-codex-turn-state: {token}\r\n"))
        .unwrap_or_default();
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n{header}Connection: close\r\n\r\n{COMPLETED}", COMPLETED.len()).as_bytes()).await.unwrap();
}

#[test]
fn codex_constructor_forces_backend_routes_and_keeps_cache_key_only() {
    for websocket in [false, true] {
        let model = selected(Some("fixture-account"), websocket, Arc::default());
        let prepared = model
            .route
            .prepare(&request(&model, Some("user"), Some("affinity")))
            .unwrap();
        assert_eq!(
            prepared.url.as_str(),
            "https://chatgpt.com/backend-api/codex/responses"
        );
        assert_eq!(
            prepared.route,
            if websocket {
                openai_codex::WEBSOCKET_ROUTE_ID
            } else {
                openai_codex::ROUTE_ID
            }
        );
        assert_eq!(prepared.headers["authorization"], "Bearer fixture-token");
        assert_eq!(prepared.headers["chatgpt-account-id"], "fixture-account");
        assert_eq!(prepared.headers.get("openai-beta").is_some(), websocket);
        let body: serde_json::Value = serde_json::from_str(&prepared.encoded_body).unwrap();
        assert_eq!(body["prompt_cache_key"], "affinity");
        assert_eq!(body["store"], false);
        assert!(body.get("prompt_cache_options").is_none());
        assert!(body.get("prompt_cache_retention").is_none());
        assert!(!prepared.encoded_body.contains("prompt_cache_breakpoint"));
    }
    let model = selected(None, false, Arc::default());
    let prepared = model.route.prepare(&request(&model, None, None)).unwrap();
    assert!(!prepared.headers.contains_key("chatgpt-account-id"));
    assert!(!prepared.headers.contains_key("session-id"));
}

#[tokio::test]
async fn codex_http_affinity_remembers_first_state_per_user_cache_and_account() {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let expected = [
                None,
                Some("first"),
                Some("first"),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            ];
            let tokens = [
                Some("first"),
                Some("later"),
                None,
                Some("second-user"),
                Some("other-account"),
                Some("other-cache"),
                Some("missing-user"),
                Some("missing-user"),
                Some("missing-cache"),
                Some("missing-cache"),
                None,
            ];
            for (index, token) in tokens.into_iter().enumerate() {
                let (mut socket, _) = listener.accept().await.unwrap();
                let (headers, body) = read(&mut socket).await;
                assert!(headers.starts_with("POST /backend-api/codex/responses HTTP/1.1"));
                assert!(headers.contains("authorization: Bearer fixture-token"));
                if let Some(token) = expected[index] {
                    assert!(headers.contains(&format!("x-codex-turn-state: {token}\r\n")));
                } else {
                    assert!(!headers.contains("x-codex-turn-state:"));
                }
                if index < 8 || index == 10 {
                    let cache = if index == 5 { "other" } else { "affinity" };
                    for name in ["session-id", "thread-id", "x-client-request-id"] {
                        assert!(headers.contains(&format!("{name}: {cache}\r\n")));
                    }
                }
                assert_eq!(body["store"], false);
                reply(&mut socket, token).await;
            }
        });
        let states = Arc::new(TurnStates::default());
        let mut model = selected(Some("account-one"), false, states.clone());
        Arc::make_mut(&mut model.route).endpoint.base_url =
            format!("http://{address}/backend-api/codex");
        let mut other = selected(Some("account-two"), false, states.clone());
        Arc::make_mut(&mut other.route).endpoint.base_url =
            format!("http://{address}/backend-api/codex");
        let executor = Executor::new(Executor::http_client().unwrap());
        for (selected, user, cache) in [
            (&model, Some("one"), Some("affinity")),
            (&model, Some("one"), Some("affinity")),
            (&model, Some("one"), Some("affinity")),
            (&model, Some("two"), Some("affinity")),
            (&other, Some("one"), Some("affinity")),
            (&model, Some("one"), Some("other")),
            (&model, None, Some("affinity")),
            (&model, None, Some("affinity")),
            (&model, Some("no-cache"), None),
            (&model, Some("no-cache"), None),
            (&model, Some("never"), Some("affinity")),
        ] {
            executor
                .generate(&request(selected, user, cache))
                .await
                .unwrap();
        }
        server.await.unwrap();
        let mut websocket = Config::new(Credential::value("fixture-token"));
        websocket.account_id = Some("account-one".into());
        websocket.websocket = true;
        websocket.turn_states = states;
        let websocket = openai_codex::model("gpt-5.6-luna", websocket).unwrap();
        assert!(
            !websocket
                .route
                .prepare(&request(&websocket, Some("one"), Some("affinity")))
                .unwrap()
                .headers
                .contains_key("x-codex-turn-state")
        );
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn codex_turn_state_token_and_fifo_capacity_are_bounded() {
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for index in 0..518 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let (headers, _) = read(&mut socket).await;
                if index == 1 || index == 3 || index == 517 {
                    assert!(!headers.contains("x-codex-turn-state:"));
                }
                let token = if index == 0 {
                    Some("x".repeat(4097))
                } else if index == 2 {
                    Some(String::new())
                } else if (4..517).contains(&index) {
                    Some(format!("state-{index}"))
                } else {
                    None
                };
                reply(&mut socket, token.as_deref()).await;
            }
        });
        let mut model = selected(None, false, Arc::default());
        Arc::make_mut(&mut model.route).endpoint.base_url = format!("http://{address}");
        let executor = Executor::new(Executor::http_client().unwrap());
        for index in 0..518 {
            let user = if index < 2 {
                "oversized".into()
            } else if index < 4 {
                "empty".into()
            } else if index == 517 {
                "user-4".into()
            } else {
                format!("user-{index}")
            };
            executor
                .generate(&request(&model, Some(&user), Some("bounded")))
                .await
                .unwrap();
        }
        server.await.unwrap();
    })
    .await
    .unwrap();
}

struct CodexHeaders;
impl server::Callback for CodexHeaders {
    fn on_request(
        self,
        request: &server::Request,
        response: server::Response,
    ) -> Result<server::Response, server::ErrorResponse> {
        assert_eq!(request.uri().path(), "/responses");
        assert_eq!(
            request.headers()["openai-beta"],
            "responses_websockets=2026-02-06"
        );
        assert_eq!(request.headers()["chatgpt-account-id"], "fixture-account");
        assert_eq!(request.headers()["authorization"], "Bearer fixture-token");
        for name in ["session-id", "thread-id", "x-client-request-id"] {
            assert_eq!(request.headers()[name], "affinity");
        }
        assert!(!request.headers().contains_key("x-codex-turn-state"));
        Ok(response)
    }
}

#[tokio::test]
async fn codex_http_errors_redact_bearer_account_and_new_turn_state() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        read(&mut socket).await;
        let body = "fixture-token fixture-account fixture-state rejected";
        socket.write_all(format!("HTTP/1.1 401 Unauthorized\r\nx-codex-turn-state: fixture-state\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    });
    let mut model = selected(Some("fixture-account"), false, Arc::default());
    Arc::make_mut(&mut model.route).endpoint.base_url = format!("http://{address}");
    let error = Executor::new(Executor::http_client().unwrap())
        .generate(&request(&model, Some("user"), Some("affinity")))
        .await
        .unwrap_err();
    assert_eq!(error.status, Some(401));
    let diagnostic = format!("{error:?}");
    for value in ["fixture-token", "fixture-account", "fixture-state"] {
        assert!(!diagnostic.contains(value));
    }
    server.await.unwrap();
}
#[tokio::test]
async fn codex_websocket_uses_native_responses_frames_and_affinity_without_http_state() {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = accept_hdr_async(socket, CodexHeaders).await.unwrap();
            let message = socket.next().await.unwrap().unwrap().into_text().unwrap();
            let body: serde_json::Value = serde_json::from_str(&message).unwrap();
            assert_eq!(body["type"], "response.create");
            assert!(body.get("stream").is_none());
            socket
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    COMPLETED
                        .trim()
                        .strip_prefix("data: ")
                        .unwrap()
                        .to_owned()
                        .into(),
                ))
                .await
                .unwrap();
        });
        let mut model = selected(Some("fixture-account"), true, Arc::default());
        Arc::make_mut(&mut model.route).endpoint.base_url = format!("http://{address}");
        Executor::new(Executor::http_client().unwrap())
            .generate(&request(&model, Some("user"), Some("affinity")))
            .await
            .unwrap();
        server.await.unwrap();
    })
    .await
    .unwrap();
}
