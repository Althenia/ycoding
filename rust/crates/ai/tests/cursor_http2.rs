use bytes::Bytes;
use http::{Request, Response};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::net::{TcpListener, TcpStream};
use ycoding_ai::{
    auth::{Auth, Credential},
    cursor::{framing, headers, request, stream, wire},
    llm::{Event, ToolCall, ToolDefinition, ToolOutput},
    tool::{self, Tool},
};
use ycoding_schema::{
    JsonValue,
    llm::{ToolContent, ToolTextContent},
    parse_json,
};

fn fixture(name: &str) -> Vec<u8> {
    let fixtures: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/cursor/wire.json")).unwrap();
    fixtures[name]
        .as_str()
        .unwrap()
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

async fn read_frames(
    body: &mut h2::RecvStream,
    decoder: &mut framing::Decoder,
    count: usize,
) -> Vec<framing::Frame> {
    let mut frames = Vec::new();
    while frames.len() < count {
        let bytes = body.data().await.unwrap().unwrap();
        body.flow_control().release_capacity(bytes.len()).unwrap();
        frames.extend(decoder.push(&bytes));
    }
    assert_eq!(frames.len(), count);
    frames
}

#[tokio::test]
async fn cursor_http2_connect_request_fragmented_stream_and_same_stream_tool_continuation() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut connection = h2::server::handshake(socket).await.unwrap();
            let (request, mut respond) = connection.accept().await.unwrap().unwrap();
            assert_eq!(request.method(), "POST");
            assert_eq!(request.uri().path(), "/agent.v1.AgentService/Run");
            assert_eq!(request.headers()["authorization"], "Bearer fixture-token");
            assert_eq!(request.headers()["connect-protocol-version"], "1");
            assert_eq!(request.headers()["x-cursor-streaming"], "true");
            assert_eq!(
                request.headers()["content-type"],
                "application/connect+proto"
            );
            let mut body = request.into_body();
            let exchange = async move {
                let mut decoder = framing::Decoder::default();
                let initial = read_frames(&mut body, &mut decoder, 1).await;
                assert_eq!(initial[0].flags, 0);
                assert_eq!(initial[0].payload, fixture("minimal"));
                let mut reply = respond
                    .send_response(
                        Response::builder()
                            .status(200)
                            .header("content-type", "application/connect+proto")
                            .body(())
                            .unwrap(),
                        false,
                    )
                    .unwrap();
                for name in ["thinking", "text", "mcp"] {
                    let framed = framing::encode(
                        if name == "thinking" { framing::GZIP } else { 0 },
                        &fixture(name),
                    )
                    .unwrap();
                    for chunk in framed.chunks(2) {
                        reply
                            .send_data(Bytes::copy_from_slice(chunk), false)
                            .unwrap();
                    }
                }
                let continuation = read_frames(&mut body, &mut decoder, 2).await;
                assert_eq!(continuation[0].payload, fixture("mcpResult"));
                assert_eq!(continuation[1].payload, fixture("close"));
                for name in ["checkpoint", "ended"] {
                    reply
                        .send_data(
                            Bytes::from(framing::encode(0, &fixture(name)).unwrap()),
                            false,
                        )
                        .unwrap();
                }
                reply
                    .send_data(
                        Bytes::from(framing::encode(framing::END_STREAM, b"{}").unwrap()),
                        false,
                    )
                    .unwrap();
                let mut trailers = http::HeaderMap::new();
                trailers.insert("grpc-status", http::HeaderValue::from_static("0"));
                reply.send_trailers(trailers).unwrap();
                while let Some(bytes) = body.data().await {
                    let bytes = bytes.unwrap();
                    assert!(bytes.is_empty());
                    body.flow_control().release_capacity(bytes.len()).unwrap();
                }
                decoder.finish().unwrap();
            };
            tokio::pin!(exchange);
            tokio::select! {
                () = &mut exchange => {},
                request = connection.accept() => {
                    assert!(request.is_none());
                    exchange.await;
                },
            }
            connection.graceful_shutdown();
            assert!(connection.accept().await.is_none());
        });
        let socket = TcpStream::connect(address).await.unwrap();
        let (client, connection) = h2::client::handshake(socket).await.unwrap();
        let driver = tokio::spawn(connection);
        let mut client = client.ready().await.unwrap();
        let url = format!("http://{address}/agent.v1.AgentService/Run");
        let auth = Auth::bearer(Credential::value("fixture-token"));
        let identity = headers::Identity {
            machine_id: "machine".into(),
            mac_machine_id: None,
            client_version: "cli-fixture".into(),
        };
        let headers = headers::run(
            &auth,
            &identity,
            "request-fixture",
            1_700_000_000_123,
            &url,
            &BTreeMap::new(),
        )
        .unwrap();
        let mut request = Request::builder()
            .method("POST")
            .uri(&url)
            .body(())
            .unwrap();
        request.headers_mut().extend(headers);
        let (response, mut send) = client.send_request(request, false).unwrap();
        let run = request::RunRequest::new("conv", "msg", "composer-fixture", "Hello");
        send.send_data(
            Bytes::from(framing::encode(0, &run.encode().unwrap()).unwrap()),
            false,
        )
        .unwrap();
        let response = response.await.unwrap();
        assert_eq!(response.status(), 200);
        let mut body = response.into_body();
        let mut state = stream::State::new();
        let definition = ToolDefinition {
            name: "read".into(),
            description: "Read".into(),
            input_schema: parse_json("{\"type\":\"object\"}").unwrap(),
            output_schema: None,
            cache: None,
            metadata: None,
            native: None,
        };
        let mut read = Tool::dynamic(definition).with_execute(|input, call| async move {
            assert_eq!(call.name, "read".into());
            assert_eq!(input, parse_json("{\"path\":\"a.ts\"}").unwrap());
            Ok(JsonValue::String("Read a.ts".into()))
        });
        read.project = Some(Arc::new(|_, _, output| ToolOutput {
            structured: output,
            content: vec![ToolContent::Text(ToolTextContent {
                text: "Read a.ts".into(),
            })],
        }));
        let tools = BTreeMap::from([("read".into(), read)]);
        let mut events = Vec::new();
        let mut calls = 0;
        while let Some(bytes) = body.data().await {
            let bytes = bytes.unwrap();
            body.flow_control().release_capacity(bytes.len()).unwrap();
            let batch = state.push(&bytes).unwrap();
            events.extend(batch.events);
            for control in batch.controls {
                let wire::ServerMessage::Exec(exec) = control else {
                    panic!("exec expected")
                };
                let mcp = exec.mcp().unwrap().unwrap();
                let call = ToolCall {
                    id: format!("cursor_conv_{}", exec.id).into(),
                    name: mcp.tool_name.unwrap().into(),
                    input: mcp.input,
                    provider_executed: None,
                    provider_metadata: None,
                };
                let settlement = tool::dispatch(&tools, &call).await.unwrap();
                let output = settlement.result.to_text().to_utf8().unwrap();
                assert_eq!(output, "Read a.ts");
                send.send_data(
                    Bytes::from(
                        framing::encode(0, &exec.mcp_result(Ok(&output), 0).unwrap()).unwrap(),
                    ),
                    false,
                )
                .unwrap();
                send.send_data(
                    Bytes::from(framing::encode(0, &exec.close().unwrap()).unwrap()),
                    false,
                )
                .unwrap();
                calls += 1;
            }
            for reply in batch.replies {
                send.send_data(Bytes::from(framing::encode(0, &reply).unwrap()), false)
                    .unwrap();
            }
        }
        let trailers = body.trailers().await.unwrap().unwrap();
        assert_eq!(trailers["grpc-status"], "0");
        state.finish().unwrap();
        assert_eq!(calls, 1);
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, Event::Finish(_)))
                .count(),
            1
        );
        assert_eq!(
            state.checkpoint(),
            Some(fixture("checkpoint")[2..].as_ref())
        );
        assert!(!state.replay_safe(true));
        send.send_data(Bytes::new(), true).unwrap();
        drop(send);
        drop(client);
        drop(body);
        server.await.unwrap();
        driver.await.unwrap().unwrap();
    })
    .await
    .unwrap();
}
