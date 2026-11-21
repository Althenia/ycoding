use std::collections::BTreeMap;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use ycoding_ai::{
    auth::{Auth, Credential, Secret},
    bedrock::{self, Config},
    bedrock_auth::{self, Credentials},
    cache::Policy,
    llm::{Event, FinishReason, Message, Part, Request, ToolChoice, ToolDefinition},
    route::Executor,
    tool::{self, Tool},
};
use ycoding_schema::parse_json;

const TEXT: &str = include_str!(
    "../../../../packages/ai/test/fixtures/recordings/bedrock-converse/streams-text.json"
);
const TOOL: &str = include_str!(
    "../../../../packages/ai/test/fixtures/recordings/bedrock-converse/streams-a-tool-call.json"
);
const LOOP: &str = include_str!(
    "../../../../packages/ai/test/fixtures/recordings/bedrock-converse/drives-a-tool-loop.json"
);

fn weather_tool() -> ToolDefinition {
    ToolDefinition { name: "get_weather".into(), description: "Get current weather for a city.".into(), input_schema: parse_json(r#"{"type":"object","properties":{"city":{"type":"string"}},"required":["city"],"additionalProperties":false}"#).unwrap(), output_schema: None, cache: None, metadata: None, native: None }
}

fn decode(value: &str) -> Vec<u8> {
    assert!(value.len().is_multiple_of(4));
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    value
        .as_bytes()
        .as_chunks::<4>()
        .0
        .iter()
        .flat_map(|chunk| {
            let values = [chunk[0], chunk[1], chunk[2], chunk[3]].map(|byte| {
                if byte == b'=' {
                    0
                } else {
                    alphabet
                        .iter()
                        .position(|candidate| *candidate == byte)
                        .unwrap() as u32
                }
            });
            let bits = (values[0] << 18) | (values[1] << 12) | (values[2] << 6) | values[3];
            [(bits >> 16) as u8, (bits >> 8) as u8, bits as u8]
                .into_iter()
                .take(3 - usize::from(chunk[3] == b'=') - usize::from(chunk[2] == b'='))
        })
        .collect()
}

async fn read_request(socket: &mut TcpStream) -> String {
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

#[tokio::test]
async fn all_recorded_request_bytes_and_binary_response_flows() {
    for (fixture, system, prompt, max_tokens, use_tool) in [
        (
            TEXT,
            "Reply with the single word 'Hello'.",
            "Say hello.",
            16.0,
            false,
        ),
        (
            TOOL,
            "Call tools exactly as requested.",
            "Call get_weather with city exactly Paris.",
            80.0,
            true,
        ),
        (
            LOOP,
            "Use the get_weather tool, then answer in one short sentence.",
            "What is the weather in Paris?",
            80.0,
            true,
        ),
    ] {
        let recorded: serde_json::Value = serde_json::from_str(fixture).unwrap();
        let interactions = recorded["interactions"].as_array().unwrap().clone();
        let count = interactions.len();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for interaction in interactions {
                let (mut socket, _) = listener.accept().await.unwrap();
                let actual = read_request(&mut socket).await;
                let (headers, body) = actual.split_once("\r\n\r\n").unwrap();
                assert_eq!(body, interaction["request"]["body"].as_str().unwrap());
                assert!(headers.starts_with(
                    "POST /model/us.amazon.nova-micro-v1%3A0/converse-stream HTTP/1.1\r\n"
                ));
                assert!(headers.contains("authorization: Bearer test-bearer\r\n"));
                assert!(headers.contains("content-type: application/json\r\n"));
                let bytes = decode(interaction["response"]["body"].as_str().unwrap());
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/vnd.amazon.eventstream\r\nContent-Length: {}\r\n\r\n", bytes.len()).as_bytes()).await.unwrap();
                for chunk in bytes.chunks(13) {
                    socket.write_all(chunk).await.unwrap();
                }
            }
        });
        let mut request = Request::new(bedrock::amazon_bedrock(
            "us.amazon.nova-micro-v1:0",
            Config {
                endpoint: format!("http://{address}"),
                auth: Auth::bearer(Credential::value("test-bearer")),
                defaults: Default::default(),
            },
        ));
        request.cache = Policy::None;
        request.system.push(system.into());
        request.messages.push(Message::user(prompt));
        request.generation.max_tokens = Some(max_tokens);
        request.generation.temperature = Some(0.0);
        if use_tool {
            request.tools.push(weather_tool());
        }
        if fixture == TOOL {
            request.tool_choice = Some(ToolChoice::Tool("get_weather".into()));
        }
        let executor = Executor::new(Executor::http_client().unwrap());
        let first = executor.generate(&request).await.unwrap();
        if !use_tool {
            assert_eq!(first.text().as_str(), Some("Hello"));
            assert_eq!(first.finish_reason, FinishReason::Stop);
            let usage = first.usage.unwrap();
            assert_eq!(
                (usage.input_tokens, usage.output_tokens, usage.total_tokens),
                (Some(12.0), Some(2.0), Some(14.0))
            );
            assert_eq!(
                (
                    usage.cache_read_input_tokens,
                    usage.cache_write_input_tokens
                ),
                (None, None)
            );
            server.await.unwrap();
            continue;
        }
        assert_eq!(first.finish_reason, FinishReason::ToolCalls);
        let call = first
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
        assert_eq!(call.name.as_str(), Some("get_weather"));
        assert_eq!(call.input, parse_json(r#"{"city":"Paris"}"#).unwrap());
        if count == 1 {
            let usage = first.usage.unwrap();
            assert_eq!(
                (usage.input_tokens, usage.output_tokens, usage.total_tokens),
                (Some(419.0), Some(16.0), Some(435.0))
            );
            server.await.unwrap();
            continue;
        }
        let tools = BTreeMap::from([(
            "get_weather".into(),
            Tool::dynamic(weather_tool()).with_execute(|input, _| async move {
                assert_eq!(input, parse_json(r#"{"city":"Paris"}"#).unwrap());
                Ok(parse_json(r#"{"temperature":22,"condition":"sunny"}"#).unwrap())
            }),
        )]);
        let settlement = tool::dispatch(&tools, call).await.unwrap();
        assert_eq!(settlement.events.len(), 1);
        let Event::ToolResult(result) = settlement.events[0].clone() else {
            panic!("expected tool result")
        };
        request.messages.push(first.message);
        request.messages.push(Message::new(
            ycoding_ai::llm::Role::Tool,
            vec![Part::ToolResult(result)],
        ));
        let second = executor.generate(&request).await.unwrap();
        server.await.unwrap();
        assert_eq!(second.finish_reason, FinishReason::Stop);
        assert!(second.text().as_str().unwrap().contains("Paris"));
        assert_eq!(
            second
                .events
                .iter()
                .filter(|event| matches!(event, Event::Finish(_)))
                .count(),
            1
        );
    }
}

#[tokio::test]
async fn sigv4_actual_http_signs_final_overlay_bytes_and_redacts_diagnostics() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let actual = read_request(&mut socket).await;
        let (headers, body) = actual.split_once("\r\n\r\n").unwrap();
        assert!(headers.contains("x-amz-date: 20150830T123600Z\r\n"));
        assert!(headers.contains("x-amz-security-token: test-token\r\n"));
        assert!(headers.contains("authorization: AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/bedrock/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature="));
        assert_eq!(
            body,
            r#"{"modelId":"nova","messages":[],"additionalModelRequestFields":{"thinking":{"type":"adaptive"}}}"#
        );
        let error = r#"{"message":"test-token","authorization":"private signature echo"}"#;
        socket.write_all(format!("HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{error}", error.len()).as_bytes()).await.unwrap();
    });
    let auth = bedrock_auth::sigv4(
        Some(Credentials {
            region: "us-east-1".into(),
            access_key_id: Secret::new("AKIDEXAMPLE"),
            secret_access_key: Secret::new("test-secret"),
            session_token: Some(Secret::new("test-token")),
        }),
        || "20150830T123600Z".into(),
    );
    let mut request = Request::new(bedrock::amazon_bedrock(
        "nova",
        Config {
            endpoint: format!("http://{address}"),
            auth,
            defaults: Default::default(),
        },
    ));
    request.cache = Policy::None;
    request.http.body = Some(
        parse_json(r#"{"additionalModelRequestFields":{"thinking":{"type":"adaptive"}}}"#).unwrap(),
    );
    let error = Executor::new(Executor::http_client().unwrap())
        .generate(&request)
        .await
        .unwrap_err();
    server.await.unwrap();
    let diagnostic = format!("{error:?}");
    assert!(!diagnostic.contains("test-token"));
    assert!(!diagnostic.contains("test-secret"));
    assert!(!diagnostic.contains("private signature echo"));
    assert_eq!(
        error.reason,
        ycoding_ai::provider_error::Reason::Authentication
    );
}
