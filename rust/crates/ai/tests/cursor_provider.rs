use bytes::Bytes;
use http::Response;
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use ycoding_ai::{
    auth::{Auth, Credential},
    cursor::{HOST_TOOL_NAMESPACE, framing, headers, persistence, protobuf, provider, transport},
    llm::{FinishReason, Message, Part, Request, ToolDefinition, ToolResult, ToolResultValue},
    route::Executor,
};

async fn failed_run(payloads: Vec<(u8, Vec<u8>)>, status: u16) -> ycoding_ai::Error {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut connection = h2::server::handshake(socket).await.unwrap();
            let (request, mut response) = connection.accept().await.unwrap().unwrap();
            let mut body = request.into_body();
            let exchange = async move {
                let bytes = body.data().await.unwrap().unwrap();
                body.flow_control().release_capacity(bytes.len()).unwrap();
                let mut send = response.send_response(Response::builder().status(status).body(()).unwrap(), false).unwrap();
                for (flags, payload) in payloads {
                    send.send_data(Bytes::from(framing::encode(flags, &payload).unwrap()), false).unwrap();
                }
                send.send_data(Bytes::new(), true).unwrap();
                while let Some(bytes) = body.data().await {
                    match bytes {
                        Ok(bytes) => body.flow_control().release_capacity(bytes.len()).unwrap(),
                        Err(error) => { assert_eq!(error.reason(), Some(h2::Reason::CANCEL)); break; }
                    }
                }
            };
            tokio::pin!(exchange);
            tokio::select! { () = &mut exchange => {}, next = connection.accept() => { assert!(next.is_none()); exchange.await; } }
        });
        let config = config(address);
        let runtime = config.runtime.clone();
        let mut request = Request::new(provider::model("composer-fixture", config).unwrap());
        request.messages.push(Message::user("Hello"));
        let mut stream = Executor::new(Executor::http_client().unwrap()).stream(&request).await.unwrap();
        let error = loop {
            match stream.next().await {
                Err(error) => break error,
                Ok(Some(event)) => assert!(!event.terminal()),
                Ok(None) => panic!("failure incorrectly became a clean stream end"),
            }
        };
        assert!(stream.next().await.unwrap().is_none());
        drop(stream);
        server.await.unwrap();
        runtime.shutdown().await;
        error
    }).await.unwrap()
}

#[tokio::test]
async fn cursor_connect_error_retains_retry_info_and_auth_classification() {
    let error = failed_run(
        vec![(
            framing::END_STREAM,
            br#"{"error":{"code":"resource_exhausted","retryAfter":"1.25s"}}"#.to_vec(),
        )],
        200,
    )
    .await;
    assert_eq!(error.reason, ycoding_ai::provider_error::Reason::RateLimit);
    assert_eq!(error.code.as_deref(), Some("resource_exhausted"));
    assert_eq!(error.retry_after_ms, Some(1250.0));
    let metadata = ycoding_schema::stringify_json(error.provider_metadata.as_ref().unwrap());
    assert!(metadata.contains("\"origin\":\"server\""));
    assert!(metadata.contains("\"transient\":true"));
    assert!(metadata.contains("\"replaySafe\":true"));

    let error = failed_run(
        vec![(
            framing::END_STREAM,
            br#"{"error":{"code":"unauthenticated"}}"#.to_vec(),
        )],
        200,
    )
    .await;
    assert_eq!(
        error.reason,
        ycoding_ai::provider_error::Reason::Authentication
    );
    assert_eq!(
        error.authentication_kind,
        Some(ycoding_ai::provider_error::AuthenticationKind::Invalid)
    );
    let metadata = ycoding_schema::stringify_json(error.provider_metadata.as_ref().unwrap());
    assert!(metadata.contains("\"origin\":\"auth\""));
    assert!(metadata.contains("\"transient\":false"));
    assert!(metadata.contains("\"replaySafe\":false"));
}

#[tokio::test]
async fn cursor_visible_output_suppresses_transport_replay() {
    let error = failed_run(vec![(0, vec![10, 5, 10, 3, 10, 1, b'x'])], 200).await;
    assert_eq!(error.reason, ycoding_ai::provider_error::Reason::Transport);
    let metadata = ycoding_schema::stringify_json(error.provider_metadata.as_ref().unwrap());
    assert!(metadata.contains("\"replaySafe\":false"));
    assert!(metadata.contains("\"transient\":false"));
}

#[tokio::test]
async fn cursor_http_auth_failure_has_typed_invalid_credentials() {
    let error = failed_run(Vec::new(), 401).await;
    assert_eq!(
        error.reason,
        ycoding_ai::provider_error::Reason::Authentication
    );
    assert_eq!(error.status, Some(401));
    assert_eq!(
        error.authentication_kind,
        Some(ycoding_ai::provider_error::AuthenticationKind::Invalid)
    );
}

async fn unary_failure(status: u16, response_body: &'static str) -> ycoding_ai::Error {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).await.unwrap();
                request.extend(byte);
            }
            let request = String::from_utf8(request).unwrap().to_lowercase();
            assert!(request.starts_with("post /aiserver.v1.aiservice/getserverconfig http/1.1\r\n"));
            assert!(request.contains("authorization: bearer fixture-token\r\n"));
            assert!(request.contains("content-type: application/json\r\n"));
            assert!(!request.contains("x-session-id"));
            assert!(!request.contains("x-session-affinity"));
            let mut body = vec![0; br#"{"telem_enabled":false}"#.len()];
            socket.read_exact(&mut body).await.unwrap();
            assert_eq!(body, br#"{"telem_enabled":false}"#);
            socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}", response_body.len()).as_bytes()).await.unwrap();
        });
        let mut config = config(address);
        config.agent = None;
        config.common.base_url = Some(format!("http://{address}/ignored/path"));
        let runtime = config.runtime.clone();
        let mut request = Request::new(provider::model("composer-fixture", config).unwrap());
        request.http.headers.insert("x-session-id".into(), "ses-fixture".into());
        request.http.headers.insert("x-session-affinity".into(), "ses-fixture".into());
        let error = Executor::new(Executor::http_client().unwrap()).generate(&request).await.unwrap_err();
        server.await.unwrap();
        runtime.shutdown().await;
        error
    }).await.unwrap()
}

#[tokio::test]
async fn cursor_unary_fails_closed_with_cursor_http_and_protocol_diagnostics() {
    let error = unary_failure(401, "fixture-token denied").await;
    assert_eq!(
        error.reason,
        ycoding_ai::provider_error::Reason::Authentication
    );
    assert!(!error.message.contains("fixture-token"));
    let metadata = ycoding_schema::stringify_json(error.provider_metadata.as_ref().unwrap());
    assert!(metadata.contains("\"origin\":\"auth\""));
    assert!(metadata.contains("\"transient\":false"));
    assert!(metadata.contains("\"replaySafe\":false"));
    let error = unary_failure(302, "{}").await;
    assert_eq!(error.status, Some(302));
    assert!(
        ycoding_schema::stringify_json(error.provider_metadata.as_ref().unwrap())
            .contains("\"origin\":\"server\"")
    );
    let error = unary_failure(200, "not-json").await;
    assert_eq!(
        error.reason,
        ycoding_ai::provider_error::Reason::InvalidProviderOutput
    );
    assert!(
        ycoding_schema::stringify_json(error.provider_metadata.as_ref().unwrap())
            .contains("\"origin\":\"protocol\"")
    );
}

#[tokio::test]
async fn cursor_unary_deadline_includes_reading_the_response_body() {
    tokio::time::timeout(Duration::from_secs(7), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (done, settled) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).await.unwrap();
                request.extend(byte);
            }
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1024\r\n\r\n{")
                .await
                .unwrap();
            settled.await.unwrap();
        });
        let mut config = config(address);
        config.agent = None;
        config.common.base_url = Some(format!("http://{address}"));
        let runtime = config.runtime.clone();
        let request = Request::new(provider::model("composer-fixture", config).unwrap());
        let error = Executor::new(Executor::http_client().unwrap())
            .generate(&request)
            .await
            .unwrap_err();
        assert_eq!(error.code.as_deref(), Some("CURSOR_AGENT_URL_TIMEOUT"));
        done.send(()).unwrap();
        server.await.unwrap();
        runtime.shutdown().await;
    })
    .await
    .unwrap();
}

fn config(address: std::net::SocketAddr) -> provider::Config {
    let runtime = Arc::new(provider::Runtime::new(Default::default()).unwrap());
    let mut config = provider::Config::new(
        Auth::bearer(Credential::value("fixture-token")),
        headers::Identity {
            machine_id: "machine".into(),
            mac_machine_id: None,
            client_version: "cli-fixture".into(),
        },
        provider::RequestContext::new(vec![10, 0]).unwrap(),
        runtime,
    );
    config.agent = Some(transport::Endpoint::loopback(address).unwrap());
    config
}

#[tokio::test]
async fn cursor_catalog_model_uses_common_executor_and_preserves_absent_usage() {
    text_generation(true).await;
}

#[tokio::test]
async fn cursor_stateless_text_generation_needs_no_session_headers() {
    text_generation(false).await;
}

async fn text_generation(session_headers: bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut connection = h2::server::handshake(socket).await.unwrap();
            let (request, mut response) = connection.accept().await.unwrap().unwrap();
            assert_eq!(request.headers()["content-type"], "application/connect+proto");
            assert_eq!(request.headers()["authorization"], "Bearer fixture-token");
            assert_eq!(request.headers()["x-request-id"], "request-1");
            if session_headers { assert_eq!(request.headers()["x-session-id"], "ses-fixture"); }
            else { assert!(!request.headers().contains_key("x-session-id")); }
            let mut body = request.into_body();
            let exchange = async move {
                let mut decoder = framing::Decoder::default();
                let frame = loop {
                    let bytes = body.data().await.unwrap().unwrap();
                    body.flow_control().release_capacity(bytes.len()).unwrap();
                    if let Some(frame) = decoder.push(&bytes).pop() { break frame }
                };
                let client = protobuf::fields(&frame.payload).unwrap();
                let run = protobuf::fields(client[0].bytes().unwrap()).unwrap();
                let model = protobuf::fields(run.iter().find(|field| field.number == 9).unwrap().bytes().unwrap()).unwrap();
                assert_eq!(model[0].text().unwrap(), "composer-fixture");
                let mut send = response.send_response(Response::builder().status(200).body(()).unwrap(), false).unwrap();
                send.send_data(Bytes::from(framing::encode(0, &[10, 11, 10, 9, 10, 7, b'a', b'n', b's', b'w', b'e', b'r', b'!']).unwrap()), false).unwrap();
                send.send_data(Bytes::from(framing::encode(0, &[10, 2, 114, 0]).unwrap()), false).unwrap();
                while let Some(bytes) = body.data().await {
                    match bytes { Ok(bytes) => body.flow_control().release_capacity(bytes.len()).unwrap(), Err(error) => { assert_eq!(error.reason(), Some(h2::Reason::CANCEL)); break; } }
                }
            };
            tokio::pin!(exchange);
            tokio::select! { () = &mut exchange => {}, next = connection.accept() => { assert!(next.is_none()); exchange.await; } }
        });
        let config = config(address);
        let runtime = config.runtime.clone();
        let mut request = Request::new(provider::model("composer-fixture", config).unwrap());
        request.id = Some("request-1".into());
        if session_headers { request.http.headers.insert("x-session-id".into(), "ses-fixture".into()); }
        request.messages.push(Message::user("Hello"));
        let response = Executor::new(Executor::http_client().unwrap()).generate(&request).await.unwrap();
        assert_eq!(response.text(), "answer!".into());
        assert!(matches!(response.events.first(), Some(ycoding_ai::llm::Event::StepStart { index: 0.0 })));
        assert_eq!(response.events.iter().filter(|event| matches!(event, ycoding_ai::llm::Event::StepFinish { index: 0.0, finish } if finish.reason == FinishReason::Stop)).count(), 1);
        assert_eq!(response.finish_reason, FinishReason::Stop);
        assert_eq!(response.usage, None);
        server.await.unwrap();
        runtime.shutdown().await;
    }).await.unwrap();
}

#[tokio::test]
async fn cursor_tool_result_resumes_the_originating_run_without_resending_user_input() {
    tool_continuation(false, true).await;
}

#[tokio::test]
async fn cursor_stream_releases_session_ownership_when_the_tool_finish_is_consumed() {
    tool_continuation(true, true).await;
}

#[tokio::test]
async fn cursor_tool_continuation_without_session_headers_finds_the_originating_run() {
    tool_continuation(false, false).await;
}

async fn tool_continuation(retain_finished_stream: bool, session_headers: bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut connection = h2::server::handshake(socket).await.unwrap();
            let (request, mut response) = connection.accept().await.unwrap().unwrap();
            let mut body = request.into_body();
            let exchange = async move {
                let mut decoder = framing::Decoder::default();
                let mut observed = Vec::new();
                while observed.is_empty() {
                    let bytes = body.data().await.unwrap().unwrap();
                    body.flow_control().release_capacity(bytes.len()).unwrap();
                    observed.extend(decoder.push(&bytes));
                }
                let mut args = Vec::new();
                protobuf::write_string(&mut args, 1, &format!("{HOST_TOOL_NAMESPACE}-read").into()).unwrap();
                protobuf::write_string(&mut args, 3, &"server-call".into()).unwrap();
                protobuf::write_string(&mut args, 4, &HOST_TOOL_NAMESPACE.into()).unwrap();
                protobuf::write_string(&mut args, 5, &"read".into()).unwrap();
                let mut exec = Vec::new();
                protobuf::write_varint(&mut exec, 1, 7).unwrap();
                protobuf::write_bytes(&mut exec, 11, &args).unwrap();
                let mut server = Vec::new();
                protobuf::write_bytes(&mut server, 2, &exec).unwrap();
                let mut send = response.send_response(Response::builder().status(200).body(()).unwrap(), false).unwrap();
                send.send_data(Bytes::from(framing::encode(0, &server).unwrap()), false).unwrap();
                while observed.len() < 3 {
                    let bytes = body.data().await.unwrap().unwrap();
                    body.flow_control().release_capacity(bytes.len()).unwrap();
                    observed.extend(decoder.push(&bytes));
                }
                assert_eq!(protobuf::fields(&observed[1].payload).unwrap()[0].number, 2);
                assert_eq!(protobuf::fields(&observed[2].payload).unwrap()[0].number, 5);
                assert!(observed[1].payload.windows(4).any(|bytes| bytes == b"done"));
                send.send_data(Bytes::from(framing::encode(0, &[10, 2, 114, 0]).unwrap()), false).unwrap();
                while let Some(bytes) = body.data().await {
                    match bytes { Ok(bytes) => body.flow_control().release_capacity(bytes.len()).unwrap(), Err(error) => { assert_eq!(error.reason(), Some(h2::Reason::CANCEL)); break; } }
                }
            };
            tokio::pin!(exchange);
            tokio::select! { () = &mut exchange => {}, next = connection.accept() => { assert!(next.is_none(), "continuation opened a second Run"); exchange.await; } }
        });
        let config = config(address);
        let runtime = config.runtime.clone();
        let mut request = Request::new(provider::model("composer-fixture", config).unwrap());
        request.id = Some("request-1".into());
        if session_headers { request.http.headers.insert("x-session-id".into(), "ses-fixture".into()); }
        request.messages.push(Message::user("Read"));
        request.tools.push(ToolDefinition { name: "read".into(), description: "Read".into(), input_schema: ycoding_schema::parse_json("{\"type\":\"object\"}").unwrap(), output_schema: None, cache: None, metadata: None, native: None });
        let executor = Executor::new(Executor::http_client().unwrap());
        let mut held_stream = None;
        let first = if retain_finished_stream {
            let mut stream = executor.stream(&request).await.unwrap();
            let mut content = Vec::new();
            loop {
                match stream.next().await.unwrap().unwrap() {
                    ycoding_ai::llm::Event::ToolCall(call) => content.push(Part::ToolCall(call)),
                    ycoding_ai::llm::Event::Finish(finish) => { assert_eq!(finish.reason, FinishReason::ToolCalls); break; },
                    _ => {}
                }
            }
            held_stream = Some(stream);
            Message::assistant(content)
        } else {
            let response = executor.generate(&request).await.unwrap();
            assert_eq!(response.finish_reason, FinishReason::ToolCalls);
            assert_eq!(response.events.iter().filter(|event| matches!(event, ycoding_ai::llm::Event::StepFinish { index: 0.0, finish } if finish.reason == FinishReason::ToolCalls)).count(), 1);
            response.message
        };
        let call = first.content.iter().find_map(|part| if let Part::ToolCall(call) = part { Some(call.clone()) } else { None }).unwrap();
        assert_eq!(call.name, "read".into());
        request.messages.push(first);
        request.messages.push(Message::new(ycoding_ai::llm::Role::Tool, vec![Part::ToolResult(ToolResult { id: call.id.clone(), name: call.name.clone(), result: ToolResultValue::Text(ycoding_schema::JsonValue::String("done".into())), cache: None, provider_executed: None, provider_metadata: None, output: None })]));
        let second = executor.generate(&request).await.unwrap();
        assert_eq!(second.finish_reason, FinishReason::Stop);
        assert_eq!(second.events.iter().filter(|event| matches!(event, ycoding_ai::llm::Event::StepFinish { index: 0.0, finish } if finish.reason == FinishReason::Stop)).count(), 1);
        assert_eq!(second.usage, None);
        if let Some(mut stream) = held_stream {
            assert!(stream.next().await.unwrap().is_none());
        }
        server.await.unwrap();
        runtime.shutdown().await;
    }).await.unwrap();
}

struct MemoryStore {
    loaded: Mutex<Option<provider::Snapshot>>,
    loads: Mutex<Vec<String>>,
    saves: Mutex<Vec<(String, provider::Snapshot)>>,
}

#[tokio::test]
async fn cursor_fresh_input_cancels_held_exec_drains_and_preserves_conversation_checkpoint() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut connection = h2::server::handshake(socket).await.unwrap();
            let conversation = Arc::new(Mutex::new(Vec::new()));
            let mut handlers = Vec::new();
            while let Some(accepted) = connection.accept().await {
                let (request, mut response) = accepted.unwrap();
                let index = handlers.len();
                let conversation = conversation.clone();
                handlers.push(tokio::spawn(async move {
                    let mut body = request.into_body();
                    let mut decoder = framing::Decoder::default();
                    let first = loop {
                        let bytes = body.data().await.unwrap().unwrap();
                        body.flow_control().release_capacity(bytes.len()).unwrap();
                        if let Some(frame) = decoder.push(&bytes).pop() {
                            break frame;
                        }
                    };
                    let client = protobuf::fields(&first.payload).unwrap();
                    let run = protobuf::fields(client[0].bytes().unwrap()).unwrap();
                    let id = run
                        .iter()
                        .find(|field| field.number == 5)
                        .unwrap()
                        .bytes()
                        .unwrap();
                    let mut send = response
                        .send_response(Response::builder().status(200).body(()).unwrap(), false)
                        .unwrap();
                    if index == 0 {
                        *conversation.lock().unwrap() = id.to_vec();
                        let mut args = Vec::new();
                        protobuf::write_string(
                            &mut args,
                            1,
                            &format!("{HOST_TOOL_NAMESPACE}-read").into(),
                        )
                        .unwrap();
                        protobuf::write_string(&mut args, 4, &HOST_TOOL_NAMESPACE.into()).unwrap();
                        protobuf::write_string(&mut args, 5, &"read".into()).unwrap();
                        let mut exec = Vec::new();
                        protobuf::write_varint(&mut exec, 1, 7).unwrap();
                        protobuf::write_bytes(&mut exec, 11, &args).unwrap();
                        let mut message = Vec::new();
                        protobuf::write_bytes(&mut message, 2, &exec).unwrap();
                        send.send_data(Bytes::from(framing::encode(0, &message).unwrap()), false)
                            .unwrap();
                        let mut received = Vec::new();
                        while received.len() < 2 {
                            let bytes = body.data().await.unwrap().unwrap();
                            body.flow_control().release_capacity(bytes.len()).unwrap();
                            received.extend(
                                decoder
                                    .push(&bytes)
                                    .into_iter()
                                    .filter(|frame| frame.payload != [0x3a, 0]),
                            );
                        }
                        assert_eq!(protobuf::fields(&received[0].payload).unwrap()[0].number, 2);
                        assert_eq!(protobuf::fields(&received[1].payload).unwrap()[0].number, 5);
                        let reason =
                            b"Host started a new user turn before this tool result was delivered";
                        assert!(
                            received[0]
                                .payload
                                .windows(reason.len())
                                .any(|bytes| bytes == reason)
                        );
                        send.send_data(
                            Bytes::from(framing::encode(0, &[10, 2, 58, 0]).unwrap()),
                            false,
                        )
                        .unwrap();
                        send.send_data(
                            Bytes::from(framing::encode(0, &[10, 3, 130, 1, 0]).unwrap()),
                            false,
                        )
                        .unwrap();
                        send.send_data(
                            Bytes::from(framing::encode(0, &[26, 3, 7, 7, 7]).unwrap()),
                            false,
                        )
                        .unwrap();
                    } else {
                        assert_eq!(index, 1);
                        assert_eq!(id, conversation.lock().unwrap().as_slice());
                        assert_eq!(
                            run.iter()
                                .find(|field| field.number == 1)
                                .unwrap()
                                .bytes()
                                .unwrap(),
                            [7, 7, 7]
                        );
                        let action = protobuf::fields(
                            run.iter()
                                .find(|field| field.number == 2)
                                .unwrap()
                                .bytes()
                                .unwrap(),
                        )
                        .unwrap();
                        assert_eq!(action[0].number, 1);
                        assert!(
                            first
                                .payload
                                .windows(b"New input".len())
                                .any(|bytes| bytes == b"New input")
                        );
                    }
                    send.send_data(
                        Bytes::from(framing::encode(0, &[10, 2, 114, 0]).unwrap()),
                        false,
                    )
                    .unwrap();
                    while let Some(bytes) = body.data().await {
                        match bytes {
                            Ok(bytes) => body.flow_control().release_capacity(bytes.len()).unwrap(),
                            Err(_) => break,
                        }
                    }
                }));
            }
            assert_eq!(handlers.len(), 2);
            for handler in handlers {
                handler.await.unwrap();
            }
        });
        let config = config(address);
        let runtime = config.runtime.clone();
        let mut request = Request::new(provider::model("composer-fixture", config).unwrap());
        request
            .http
            .headers
            .insert("x-session-id".into(), "fresh-turn".into());
        request.messages.push(Message::user("Read"));
        request.tools.push(ToolDefinition {
            name: "read".into(),
            description: "Read".into(),
            input_schema: ycoding_schema::parse_json("{\"type\":\"object\"}").unwrap(),
            output_schema: None,
            cache: None,
            metadata: None,
            native: None,
        });
        let executor = Executor::new(Executor::http_client().unwrap());
        let first = executor.generate(&request).await.unwrap();
        assert_eq!(first.finish_reason, FinishReason::ToolCalls);
        request.messages.push(first.message);
        request.messages.push(Message::user("New input"));
        assert_eq!(
            executor.generate(&request).await.unwrap().finish_reason,
            FinishReason::Stop
        );
        runtime.shutdown().await;
        server.await.unwrap();
    })
    .await
    .unwrap();
}
impl persistence::Store for MemoryStore {
    fn load<'a>(
        &'a self,
        session_key: &'a ycoding_schema::LosslessString,
    ) -> Pin<Box<dyn Future<Output = persistence::Loaded> + Send + 'a>> {
        Box::pin(async move {
            self.loads
                .lock()
                .unwrap()
                .push(session_key.to_utf8().unwrap());
            self.loaded
                .lock()
                .unwrap()
                .take()
                .map_or(persistence::Loaded::Missing, persistence::Loaded::Restored)
        })
    }
    fn save<'a>(
        &'a self,
        session_key: &'a ycoding_schema::LosslessString,
        snapshot: &'a provider::Snapshot,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            self.saves
                .lock()
                .unwrap()
                .push((session_key.to_utf8().unwrap(), snapshot.clone()));
        })
    }
}

async fn persisted_run(store: Arc<MemoryStore>, runs: usize, expect: fn(&[u8], &[u8], usize)) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut connection = h2::server::handshake(socket).await.unwrap();
            let mut handlers = Vec::new();
            while let Some(accepted) = connection.accept().await {
                let (request, mut response) = accepted.unwrap();
                let served = handlers.len();
                handlers.push(tokio::spawn(async move {
                    let mut body = request.into_body();
                    let mut decoder = framing::Decoder::default();
                    let frame = loop {
                        let bytes = body.data().await.unwrap().unwrap();
                        body.flow_control().release_capacity(bytes.len()).unwrap();
                        if let Some(frame) = decoder.push(&bytes).pop() {
                            break frame;
                        }
                    };
                    let client = protobuf::fields(&frame.payload).unwrap();
                    let run = protobuf::fields(client[0].bytes().unwrap()).unwrap();
                    expect(
                        run.iter()
                            .find(|field| field.number == 1)
                            .unwrap()
                            .bytes()
                            .unwrap(),
                        run.iter()
                            .find(|field| field.number == 5)
                            .unwrap()
                            .bytes()
                            .unwrap(),
                        served,
                    );
                    let mut send = response
                        .send_response(Response::builder().status(200).body(()).unwrap(), false)
                        .unwrap();
                    send.send_data(
                        Bytes::from(framing::encode(0, &[26, 3, 7, 7, 7]).unwrap()),
                        false,
                    )
                    .unwrap();
                    send.send_data(
                        Bytes::from(
                            framing::encode(
                                0,
                                &[
                                    10, 11, 10, 9, 10, 7, b'a', b'n', b's', b'w', b'e', b'r', b'!',
                                ],
                            )
                            .unwrap(),
                        ),
                        false,
                    )
                    .unwrap();
                    send.send_data(
                        Bytes::from(framing::encode(0, &[10, 2, 114, 0]).unwrap()),
                        false,
                    )
                    .unwrap();
                    while let Some(bytes) = body.data().await {
                        match bytes {
                            Ok(bytes) => body.flow_control().release_capacity(bytes.len()).unwrap(),
                            Err(_) => break,
                        }
                    }
                }));
            }
            assert_eq!(handlers.len(), runs);
            for handler in handlers {
                handler.await.unwrap();
            }
        });
        let mut config = config(address);
        config.persistence = Some(store);
        let runtime = config.runtime.clone();
        let model = provider::model("composer-fixture", config).unwrap();
        let client = async {
            for _ in 0..runs {
                let mut request = Request::new(model.clone());
                request
                    .http
                    .headers
                    .insert("x-session-id".into(), "ses-fixture".into());
                request.messages.push(Message::user("Hello"));
                assert_eq!(
                    Executor::new(Executor::http_client().unwrap())
                        .generate(&request)
                        .await
                        .unwrap()
                        .finish_reason,
                    FinishReason::Stop
                );
            }
        };
        tokio::pin!(client);
        tokio::pin!(server);
        tokio::select! {
            result = &mut server => result.unwrap(),
            () = &mut client => {}
        }
        runtime.shutdown().await;
        server.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn cursor_first_run_restores_the_persisted_conversation_and_turn_end_saves_the_new_checkpoint()
 {
    let mut persisted = provider::Snapshot {
        conversation_id: "conversation-persisted".into(),
        checkpoint: Some(vec![1, 2, 3]),
        blobs: Default::default(),
        last_user: None,
        descriptors: Vec::new(),
    };
    persisted.blobs.insert(vec![9], vec![8]);
    let store = Arc::new(MemoryStore {
        loaded: Mutex::new(Some(persisted)),
        loads: Mutex::new(Vec::new()),
        saves: Mutex::new(Vec::new()),
    });
    persisted_run(store.clone(), 2, |checkpoint, conversation, served| {
        assert_eq!(conversation, b"conversation-persisted");
        assert_eq!(
            checkpoint,
            if served == 0 {
                &[1, 2, 3][..]
            } else {
                &[7, 7, 7][..]
            }
        );
    })
    .await;
    assert_eq!(store.loads.lock().unwrap().as_slice(), ["ses-fixture"]);
    let saves = store.saves.lock().unwrap();
    assert_eq!(saves.len(), 2);
    assert_eq!(saves[0].0, "ses-fixture");
    assert_eq!(saves[0].1.conversation_id, "conversation-persisted".into());
    assert_eq!(saves[0].1.checkpoint, Some(vec![7, 7, 7]));
    assert_eq!(saves[0].1.blobs.get(&vec![9]), Some(&vec![8]));
}

#[tokio::test]
async fn cursor_missing_persisted_conversation_starts_fresh_and_still_saves_turn_end() {
    let store = Arc::new(MemoryStore {
        loaded: Mutex::new(None),
        loads: Mutex::new(Vec::new()),
        saves: Mutex::new(Vec::new()),
    });
    persisted_run(store.clone(), 1, |checkpoint, conversation, _| {
        assert_ne!(conversation, b"conversation-persisted");
        assert_ne!(checkpoint, [1, 2, 3]);
    })
    .await;
    let saves = store.saves.lock().unwrap();
    assert_eq!(saves.len(), 1);
    assert_eq!(saves[0].1.checkpoint, Some(vec![7, 7, 7]));
    assert_ne!(saves[0].1.conversation_id, "".into());
}

#[tokio::test]
async fn cursor_held_run_sends_client_heartbeats_until_the_tool_result_arrives() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let beats = Arc::new(tokio::sync::Notify::new());
        let server_beats = beats.clone();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut connection = h2::server::handshake(socket).await.unwrap();
            let (request, mut response) = connection.accept().await.unwrap().unwrap();
            let mut body = request.into_body();
            let exchange = async move {
                let mut decoder = framing::Decoder::default();
                let mut observed = Vec::new();
                while observed.is_empty() {
                    let bytes = body.data().await.unwrap().unwrap();
                    body.flow_control().release_capacity(bytes.len()).unwrap();
                    observed.extend(decoder.push(&bytes));
                }
                let mut args = Vec::new();
                protobuf::write_string(&mut args, 1, &format!("{HOST_TOOL_NAMESPACE}-read").into()).unwrap();
                protobuf::write_string(&mut args, 3, &"server-call".into()).unwrap();
                protobuf::write_string(&mut args, 4, &HOST_TOOL_NAMESPACE.into()).unwrap();
                protobuf::write_string(&mut args, 5, &"read".into()).unwrap();
                let mut exec = Vec::new();
                protobuf::write_varint(&mut exec, 1, 7).unwrap();
                protobuf::write_bytes(&mut exec, 11, &args).unwrap();
                let mut message = Vec::new();
                protobuf::write_bytes(&mut message, 2, &exec).unwrap();
                let mut send = response.send_response(Response::builder().status(200).body(()).unwrap(), false).unwrap();
                send.send_data(Bytes::from(framing::encode(0, &message).unwrap()), false).unwrap();
                let mut heartbeats = 0;
                let mut results = Vec::new();
                while results.len() < 2 {
                    let bytes = body.data().await.unwrap().unwrap();
                    body.flow_control().release_capacity(bytes.len()).unwrap();
                    for frame in decoder.push(&bytes) {
                        if frame.payload == [0x3a, 0] {
                            heartbeats += 1;
                            if heartbeats == 2 { server_beats.notify_one(); }
                        } else {
                            assert!(heartbeats >= 2, "tool result arrived before two heartbeats: {:?} hb={heartbeats}", frame.payload);
                            results.push(frame.payload);
                        }
                    }
                }
                assert_eq!(protobuf::fields(&results[0]).unwrap()[0].number, 2);
                assert_eq!(protobuf::fields(&results[1]).unwrap()[0].number, 5);
                send.send_data(Bytes::from(framing::encode(0, &[10, 2, 114, 0]).unwrap()), false).unwrap();
                while let Some(bytes) = body.data().await {
                    match bytes { Ok(bytes) => body.flow_control().release_capacity(bytes.len()).unwrap(), Err(error) => { assert_eq!(error.reason(), Some(h2::Reason::CANCEL)); break; } }
                }
            };
            tokio::pin!(exchange);
            tokio::select! { () = &mut exchange => {}, next = connection.accept() => { assert!(next.is_none()); exchange.await; } }
        });
        let mut config = config(address);
        config.continuation.heartbeat_ms = 20;
        let runtime = config.runtime.clone();
        let mut request = Request::new(provider::model("composer-fixture", config).unwrap());
        request.http.headers.insert("x-session-id".into(), "ses-fixture".into());
        request.messages.push(Message::user("Read"));
        request.tools.push(ToolDefinition { name: "read".into(), description: "Read".into(), input_schema: ycoding_schema::parse_json("{\"type\":\"object\"}").unwrap(), output_schema: None, cache: None, metadata: None, native: None });
        let executor = Executor::new(Executor::http_client().unwrap());
        let first = executor.generate(&request).await.unwrap();
        assert_eq!(first.finish_reason, FinishReason::ToolCalls);
        let call = first.message.content.iter().find_map(|part| if let Part::ToolCall(call) = part { Some(call.clone()) } else { None }).unwrap();
        beats.notified().await;
        request.messages.push(first.message);
        request.messages.push(Message::new(ycoding_ai::llm::Role::Tool, vec![Part::ToolResult(ToolResult { id: call.id.clone(), name: call.name.clone(), result: ToolResultValue::Text(ycoding_schema::JsonValue::String("done".into())), cache: None, provider_executed: None, provider_metadata: None, output: None })]));
        assert_eq!(executor.generate(&request).await.unwrap().finish_reason, FinishReason::Stop);
        server.await.unwrap();
        runtime.shutdown().await;
    }).await.unwrap();
}

fn policy(heartbeat_ms: u64, semantic_idle_ms: u64, hard_cap_ms: u64) -> provider::Continuation {
    provider::Continuation {
        heartbeat_ms,
        semantic_idle_ms,
        hard_cap_ms,
    }
}

#[test]
fn cursor_continuation_policy_rejects_invalid_values_with_committed_messages() {
    let address = "127.0.0.1:1".parse().unwrap();
    for (continuation, message) in [
        (
            policy(0, 40, 80),
            "Cursor continuation heartbeatMs must be a positive integer no greater than 2147483647",
        ),
        (
            policy(10, 2_147_483_648, 2_147_483_647),
            "Cursor continuation semanticIdleMs must be a positive integer no greater than 2147483647",
        ),
        (
            policy(10, 40, 0),
            "Cursor continuation hardCapMs must be a positive integer no greater than 2147483647",
        ),
        (
            policy(40, 40, 80),
            "Cursor continuation heartbeatMs must be less than semanticIdleMs",
        ),
        (
            policy(10, 81, 80),
            "Cursor continuation semanticIdleMs must be no greater than hardCapMs",
        ),
    ] {
        let mut config = config(address);
        config.continuation = continuation;
        let error = provider::model("composer-fixture", config).err().unwrap();
        assert_eq!(
            error.reason,
            ycoding_ai::provider_error::Reason::InvalidRequest
        );
        assert_eq!(error.message, message);
    }
    let mut config = config(address);
    config.continuation = policy(10, 40, 40);
    assert!(provider::model("composer-fixture", config).is_ok());
}

type Script = Vec<(u64, Vec<u8>)>;

async fn scripted_runs(
    scripts: Vec<Script>,
    continuation: provider::Continuation,
    client: impl AsyncFnOnce(Executor, Arc<provider::Runtime>, provider::Config) -> (),
) {
    tokio::time::timeout(Duration::from_secs(10), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let runs = scripts.len();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut connection = h2::server::handshake(socket).await.unwrap();
            let mut scripts = scripts.into_iter();
            let mut handlers = Vec::new();
            while let Some(accepted) = connection.accept().await {
                let (request, mut response) = accepted.unwrap();
                let script = scripts.next().expect("unexpected extra Run");
                handlers.push(tokio::spawn(async move {
                    let mut body = request.into_body();
                    let mut decoder = framing::Decoder::default();
                    loop {
                        let bytes = body.data().await.unwrap().unwrap();
                        body.flow_control().release_capacity(bytes.len()).unwrap();
                        if !decoder.push(&bytes).is_empty() {
                            break;
                        }
                    }
                    let mut send = response
                        .send_response(Response::builder().status(200).body(()).unwrap(), false)
                        .unwrap();
                    for (delay_ms, frame) in script {
                        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                        send.send_data(Bytes::from(framing::encode(0, &frame).unwrap()), false)
                            .unwrap();
                    }
                    while let Some(bytes) = body.data().await {
                        match bytes {
                            Ok(bytes) => body.flow_control().release_capacity(bytes.len()).unwrap(),
                            Err(_) => break,
                        }
                    }
                }));
            }
            assert_eq!(handlers.len(), runs);
            for handler in handlers {
                handler.await.unwrap();
            }
        });
        let mut config = config(address);
        config.continuation = continuation;
        let runtime = config.runtime.clone();
        let executor = Executor::new(Executor::http_client().unwrap());
        tokio::pin!(server);
        let driven = client(executor, runtime.clone(), config);
        tokio::pin!(driven);
        tokio::select! {
            result = &mut server => result.unwrap(),
            () = &mut driven => {}
        }
        runtime.shutdown().await;
        server.await.unwrap();
    })
    .await
    .unwrap();
}

fn text_frame() -> Vec<u8> {
    vec![
        10, 11, 10, 9, 10, 7, b'a', b'n', b's', b'w', b'e', b'r', b'!',
    ]
}

#[tokio::test]
async fn cursor_silent_stream_fails_with_the_transient_replay_safe_semantic_idle_timeout() {
    scripted_runs(
        vec![vec![]],
        policy(10, 60, 600),
        async |executor, _, config| {
            let mut request = Request::new(provider::model("composer-fixture", config).unwrap());
            request
                .http
                .headers
                .insert("x-session-id".into(), "ses-fixture".into());
            request.messages.push(Message::user("Hello"));
            let error = executor.generate(&request).await.unwrap_err();
            assert_eq!(error.code.as_deref(), Some("CURSOR_SEMANTIC_IDLE_TIMEOUT"));
            assert_eq!(error.message, "Cursor semantic-progress timeout after 60ms");
            let metadata =
                ycoding_schema::stringify_json(error.provider_metadata.as_ref().unwrap());
            assert!(metadata.contains("\"transient\":true"));
            assert!(metadata.contains("\"replaySafe\":true"));
        },
    )
    .await;
}

#[tokio::test]
async fn cursor_semantic_progress_renews_the_idle_deadline_for_each_frame() {
    let script = vec![
        (40, text_frame()),
        (40, text_frame()),
        (40, text_frame()),
        (40, vec![10, 2, 114, 0]),
    ];
    scripted_runs(
        vec![script],
        policy(10, 100, 600),
        async |executor, _, config| {
            let mut request = Request::new(provider::model("composer-fixture", config).unwrap());
            request
                .http
                .headers
                .insert("x-session-id".into(), "ses-fixture".into());
            request.messages.push(Message::user("Hello"));
            assert_eq!(
                executor.generate(&request).await.unwrap().finish_reason,
                FinishReason::Stop
            );
        },
    )
    .await;
}

#[tokio::test]
async fn cursor_held_run_past_the_hard_cap_is_closed_and_the_continuation_starts_a_fresh_run() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let expired = Arc::new(tokio::sync::Notify::new());
        let server_expired = expired.clone();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut connection = h2::server::handshake(socket).await.unwrap();
            let mut handlers = Vec::new();
            while let Some(accepted) = connection.accept().await {
                let (request, mut response) = accepted.unwrap();
                let index = handlers.len();
                let expired = server_expired.clone();
                handlers.push(tokio::spawn(async move {
                    let mut body = request.into_body();
                    let mut decoder = framing::Decoder::default();
                    let first = loop {
                        let bytes = body.data().await.unwrap().unwrap();
                        body.flow_control().release_capacity(bytes.len()).unwrap();
                        if let Some(frame) = decoder.push(&bytes).pop() {
                            break frame;
                        }
                    };
                    let mut send = response
                        .send_response(Response::builder().status(200).body(()).unwrap(), false)
                        .unwrap();
                    if index == 0 {
                        let mut args = Vec::new();
                        protobuf::write_string(
                            &mut args,
                            1,
                            &format!("{HOST_TOOL_NAMESPACE}-read").into(),
                        )
                        .unwrap();
                        protobuf::write_string(&mut args, 3, &"server-call".into()).unwrap();
                        protobuf::write_string(&mut args, 4, &HOST_TOOL_NAMESPACE.into()).unwrap();
                        protobuf::write_string(&mut args, 5, &"read".into()).unwrap();
                        let mut exec = Vec::new();
                        protobuf::write_varint(&mut exec, 1, 7).unwrap();
                        protobuf::write_bytes(&mut exec, 11, &args).unwrap();
                        let mut message = Vec::new();
                        protobuf::write_bytes(&mut message, 2, &exec).unwrap();
                        send.send_data(Bytes::from(framing::encode(0, &message).unwrap()), false)
                            .unwrap();
                        let mut heartbeats = 0;
                        loop {
                            match body.data().await {
                                Some(Ok(bytes)) => {
                                    body.flow_control().release_capacity(bytes.len()).unwrap();
                                    for frame in decoder.push(&bytes) {
                                        assert_eq!(
                                            frame.payload,
                                            [0x3a, 0],
                                            "the expired Run must never receive a tool result"
                                        );
                                        heartbeats += 1;
                                        if heartbeats == 10 {
                                            expired.notify_one();
                                        }
                                    }
                                }
                                Some(Err(error)) => {
                                    assert_eq!(error.reason(), Some(h2::Reason::CANCEL));
                                    break;
                                }
                                None => break,
                            }
                        }
                        return;
                    }
                    let client = protobuf::fields(&first.payload).unwrap();
                    let run = protobuf::fields(client[0].bytes().unwrap()).unwrap();
                    let action = protobuf::fields(
                        run.iter()
                            .find(|field| field.number == 2)
                            .unwrap()
                            .bytes()
                            .unwrap(),
                    )
                    .unwrap();
                    assert_eq!(action[0].number, 1);
                    let user = protobuf::fields(action[0].bytes().unwrap()).unwrap();
                    let message = protobuf::fields(user[0].bytes().unwrap()).unwrap();
                    let images = protobuf::fields(
                        message
                            .iter()
                            .find(|field| field.number == 3)
                            .unwrap()
                            .bytes()
                            .unwrap(),
                    )
                    .unwrap();
                    let image = protobuf::fields(images[0].bytes().unwrap()).unwrap();
                    assert_eq!(
                        image
                            .iter()
                            .find(|field| field.number == 8)
                            .unwrap()
                            .bytes()
                            .unwrap(),
                        [1, 2, 3]
                    );
                    assert!(
                        first
                            .payload
                            .windows(b"Continue the interrupted turn".len())
                            .any(|bytes| bytes == b"Continue the interrupted turn")
                    );
                    assert!(
                        run.iter()
                            .find(|field| field.number == 1)
                            .unwrap()
                            .bytes()
                            .unwrap()
                            .windows(b"Tool result read: done".len())
                            .any(|bytes| bytes == b"Tool result read: done")
                    );
                    send.send_data(
                        Bytes::from(framing::encode(0, &[10, 2, 114, 0]).unwrap()),
                        false,
                    )
                    .unwrap();
                    while let Some(bytes) = body.data().await {
                        match bytes {
                            Ok(bytes) => body.flow_control().release_capacity(bytes.len()).unwrap(),
                            Err(_) => break,
                        }
                    }
                }));
            }
            assert_eq!(handlers.len(), 2);
            for handler in handlers {
                handler.await.unwrap();
            }
        });
        let mut config = config(address);
        config.continuation = policy(10, 40, 80);
        config.models = ycoding_ai::cursor::models::available_models(
            &ycoding_schema::parse_json(
                r#"{"models":[{"name":"composer-fixture","supportsImages":true}]}"#,
            )
            .unwrap(),
        )
        .unwrap();
        let runtime = config.runtime.clone();
        let mut request = Request::new(provider::model("composer-fixture", config).unwrap());
        request
            .http
            .headers
            .insert("x-session-id".into(), "ses-fixture".into());
        request.messages.push(Message::new(
            ycoding_ai::llm::Role::User,
            vec![
                Part::Text("Read".into()),
                Part::Media(ycoding_ai::llm::Media {
                    mime: "image/png".into(),
                    data: ycoding_ai::llm::MediaData::Bytes(vec![1, 2, 3]),
                    filename: None,
                }),
            ],
        ));
        request.tools.push(ToolDefinition {
            name: "read".into(),
            description: "Read".into(),
            input_schema: ycoding_schema::parse_json("{\"type\":\"object\"}").unwrap(),
            output_schema: None,
            cache: None,
            metadata: None,
            native: None,
        });
        let executor = Executor::new(Executor::http_client().unwrap());
        let client = async {
            let first = executor.generate(&request).await.unwrap();
            assert_eq!(first.finish_reason, FinishReason::ToolCalls);
            let call = first
                .message
                .content
                .iter()
                .find_map(|part| {
                    if let Part::ToolCall(call) = part {
                        Some(call.clone())
                    } else {
                        None
                    }
                })
                .unwrap();
            expired.notified().await;
            request.messages.push(first.message);
            request.messages.push(Message::new(
                ycoding_ai::llm::Role::Tool,
                vec![Part::ToolResult(ToolResult {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    result: ToolResultValue::Text(ycoding_schema::JsonValue::String("done".into())),
                    cache: None,
                    provider_executed: None,
                    provider_metadata: None,
                    output: None,
                })],
            ));
            assert_eq!(
                executor.generate(&request).await.unwrap().finish_reason,
                FinishReason::Stop
            );
        };
        tokio::pin!(client);
        tokio::pin!(server);
        tokio::select! {
            result = &mut server => result.unwrap(),
            () = &mut client => {}
        }
        runtime.shutdown().await;
        server.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn cursor_heartbeats_stop_once_the_turn_has_ended() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let beats = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let server_beats = beats.clone();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut connection = h2::server::handshake(socket).await.unwrap();
            let mut handlers = Vec::new();
            while let Some(accepted) = connection.accept().await {
                let (request, mut response) = accepted.unwrap();
                let beats = server_beats.clone();
                handlers.push(tokio::spawn(async move {
                    let mut body = request.into_body();
                    let mut decoder = framing::Decoder::default();
                    let mut sent = false;
                    let mut send = None;
                    while let Some(bytes) = body.data().await {
                        let Ok(bytes) = bytes else { break };
                        body.flow_control().release_capacity(bytes.len()).unwrap();
                        for frame in decoder.push(&bytes) {
                            if !sent {
                                let mut stream = response
                                    .send_response(
                                        Response::builder().status(200).body(()).unwrap(),
                                        false,
                                    )
                                    .unwrap();
                                sent = true;
                                let mut ended = false;
                                while !ended {
                                    let more = tokio::time::timeout(
                                        Duration::from_millis(100),
                                        body.data(),
                                    )
                                    .await;
                                    let Ok(Some(Ok(bytes))) = more else {
                                        ended = true;
                                        continue;
                                    };
                                    body.flow_control().release_capacity(bytes.len()).unwrap();
                                    beats.fetch_add(
                                        decoder
                                            .push(&bytes)
                                            .iter()
                                            .filter(|frame| frame.payload == [0x3a, 0])
                                            .count(),
                                        std::sync::atomic::Ordering::SeqCst,
                                    );
                                    if beats.load(std::sync::atomic::Ordering::SeqCst) >= 3 {
                                        ended = true;
                                    }
                                }
                                stream
                                    .send_data(
                                        Bytes::from(framing::encode(0, &[10, 2, 114, 0]).unwrap()),
                                        false,
                                    )
                                    .unwrap();
                                send = Some(stream);
                            } else if frame.payload == [0x3a, 0] {
                                beats.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            }
                        }
                    }
                    drop(send);
                }));
            }
            for handler in handlers {
                handler.await.unwrap();
            }
        });
        let mut config = config(address);
        config.continuation = policy(10, 40, 80);
        let runtime = config.runtime.clone();
        let mut request = Request::new(provider::model("composer-fixture", config).unwrap());
        request
            .http
            .headers
            .insert("x-session-id".into(), "ses-fixture".into());
        request.messages.push(Message::user("Hello"));
        let client = async {
            assert_eq!(
                Executor::new(Executor::http_client().unwrap())
                    .generate(&request)
                    .await
                    .unwrap()
                    .finish_reason,
                FinishReason::Stop
            );
            tokio::time::sleep(Duration::from_millis(60)).await;
            let settled = beats.load(std::sync::atomic::Ordering::SeqCst);
            assert!(
                settled >= 3,
                "the held Run must have sent heartbeats before the turn ended"
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
            assert_eq!(
                beats.load(std::sync::atomic::Ordering::SeqCst),
                settled,
                "heartbeats continued after TurnEnded"
            );
        };
        tokio::pin!(client);
        tokio::pin!(server);
        tokio::select! {
            result = &mut server => result.unwrap(),
            () = &mut client => {}
        }
        runtime.shutdown().await;
        server.await.unwrap();
    })
    .await
    .unwrap();
}
