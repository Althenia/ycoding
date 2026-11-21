use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio_tungstenite::{
    accept_async, accept_hdr_async,
    tungstenite::{Message, handshake::server},
};
struct AssertHeaders;
impl server::Callback for AssertHeaders {
    fn on_request(
        self,
        request: &server::Request,
        response: server::Response,
    ) -> Result<server::Response, server::ErrorResponse> {
        assert_eq!(request.uri().path(), "/v1/messages");
        assert_eq!(request.headers()["x-api-key"], "fixture-key");
        Ok(response)
    }
}
use ycoding_ai::{
    auth::{Credential, ProviderAuth},
    llm::Request,
    route::Route,
    websocket::{Continuation, JsonTransport, SessionMetadata},
};
use ycoding_schema::{parse_json, stringify_json};

fn prepared(address: std::net::SocketAddr) -> ycoding_ai::route::Prepared {
    let route = Route::anthropic_compatible(
        format!("http://{address}/v1"),
        None,
        ProviderAuth::ApiKey(Credential::value("fixture-key")),
    )
    .unwrap();
    route
        .prepare(&Request::new(route.model("claude-sonnet-4-5")))
        .unwrap()
}
#[tokio::test]
async fn websocket_actual_headers_text_binary_and_normal_close() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = accept_hdr_async(socket, AssertHeaders).await.unwrap();
        let message = socket.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(message, r#"{"type":"response.create","input":"hello"}"#);
        socket
            .send(Message::Text("text frame".into()))
            .await
            .unwrap();
        socket
            .send(Message::Binary("ไทย".as_bytes().to_vec().into()))
            .await
            .unwrap();
        socket.close(None).await.unwrap();
    });
    let transport = JsonTransport::new(|_| {
        Ok(parse_json(r#"{"type":"response.create","input":"hello"}"#).unwrap())
    });
    let mut connection = transport.open(&prepared(address), None).await.unwrap();
    assert_eq!(
        connection.next().await.unwrap().as_deref(),
        Some("text frame")
    );
    assert_eq!(connection.next().await.unwrap().as_deref(), Some("ไทย"));
    assert!(connection.next().await.unwrap().is_none());
    drop(connection);
    server.await.unwrap();
}
fn continuation() -> Continuation {
    Continuation {
        session: Arc::new(|request| {
            Some(SessionMetadata {
                key: "fixture-session".into(),
                fingerprint: request.model.id.as_str().unwrap().into(),
                message_boundary: if request.messages.is_empty() { 0 } else { 1 },
                full_replay: false,
            })
        }),
        replay_message: Arc::new(|_, count| {
            Ok(parse_json(if count==0 {r#"{"type":"response.create","model":"fixture","input":[{"role":"user","content":"hello"}]}"#}else {r#"{"type":"response.create","model":"fixture","input":[{"role":"user","content":"hello"},{"role":"assistant","content":"answer"}]}"#}).unwrap())
        }),
        delta_message: Arc::new(|_, _| {
            Ok(parse_json(r#"{"type":"response.create","model":"fixture","input":[{"role":"user","content":"next"}]}"#).unwrap())
        }),
        normalize_output: Arc::new(|item| Some(item.clone())),
    }
}

#[tokio::test]
async fn continuation_reuses_connection_and_rejects_expired_without_replay() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(socket).await.unwrap();
        assert!(
            !socket
                .next()
                .await
                .unwrap()
                .unwrap()
                .into_text()
                .unwrap()
                .contains("previous_response_id")
        );
        socket.send(Message::Text(r#"{"type":"response.output_item.done","item":{"role":"assistant","content":"answer"}}"#.into())).await.unwrap();
        socket
            .send(Message::Text(
                r#"{"type":"response.completed","response":{"id":"response_1"}}"#.into(),
            ))
            .await
            .unwrap();
        let continued = socket.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(
            continued,
            r#"{"type":"response.create","model":"fixture","input":[{"role":"user","content":"next"}],"previous_response_id":"response_1"}"#
        );
        socket
            .send(Message::Text(
                r#"{"type":"error","error":{"message":"previous_response_id expired fixture-key"}}"#.into(),
            ))
            .await
            .unwrap();
    });
    let mut transport = JsonTransport::new(|_| {
        Ok(parse_json(r#"{"type":"response.create","model":"fixture","input":[{"role":"user","content":"hello"}]}"#).unwrap())
    });
    transport.continuation = Some(continuation());
    let prepared = prepared(address);
    let mut first = transport.open(&prepared, None).await.unwrap();
    assert!(
        first
            .next()
            .await
            .unwrap()
            .unwrap()
            .contains("output_item.done")
    );
    assert!(
        first
            .next()
            .await
            .unwrap()
            .unwrap()
            .contains("response.completed")
    );
    drop(first);
    let mut request = Request::new(prepared_model(address));
    request
        .messages
        .push(ycoding_ai::llm::Message::user("next"));
    let prepared = request.model.route.prepare(&request).unwrap();
    let mut second = transport.open(&prepared, None).await.unwrap();
    let error = second.next().await.unwrap_err();
    assert_eq!(error.transport_kind, Some("websocket-continuation"));
    assert!(error.message.contains("expired"));
    assert!(!format!("{error:?} {error}").contains("fixture-key"));
    drop(second);
    server.await.unwrap();
}
fn prepared_model(address: std::net::SocketAddr) -> ycoding_ai::llm::Model {
    Route::anthropic_compatible(
        format!("http://{address}/v1"),
        None,
        ProviderAuth::ApiKey(Credential::value("fixture-key")),
    )
    .unwrap()
    .model("claude-sonnet-4-5")
}

#[tokio::test]
async fn session_close_before_terminal_is_error_and_new_session_reopens() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for _ in 0..2 {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(socket).await.unwrap();
            socket.next().await.unwrap().unwrap();
            socket.close(None).await.unwrap();
        }
    });
    let mut transport = JsonTransport::new(|_| Ok(parse_json("{}").unwrap()));
    transport.continuation = Some(continuation());
    let prepared = prepared(address);
    for _ in 0..2 {
        let mut connection = transport.open(&prepared, None).await.unwrap();
        assert_eq!(
            connection.next().await.unwrap_err().transport_kind,
            Some("close")
        );
        drop(connection);
    }
    server.await.unwrap();
}

#[tokio::test]
async fn full_replay_does_not_send_previous_id() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(socket).await.unwrap();
        for _ in 0..2 {
            let message = socket.next().await.unwrap().unwrap().into_text().unwrap();
            assert!(!message.contains("previous_response_id"));
            socket
                .send(Message::Text(
                    r#"{"type":"response.completed","response":{"id":"response_1"}}"#.into(),
                ))
                .await
                .unwrap();
        }
    });
    let mut transport =
        JsonTransport::new(|_| Ok(parse_json(r#"{"type":"response.create","input":[]}"#).unwrap()));
    let mut config = continuation();
    config.session = Arc::new(|_| {
        Some(SessionMetadata {
            key: "fixture".into(),
            fingerprint: "same".into(),
            message_boundary: 0,
            full_replay: true,
        })
    });
    transport.continuation = Some(config);
    for _ in 0..2 {
        let mut connection = transport.open(&prepared(address), None).await.unwrap();
        assert!(connection.next().await.unwrap().is_some());
        drop(connection);
    }
    server.await.unwrap();
    assert_eq!(stringify_json(&parse_json("{}").unwrap()), "{}");
}

#[tokio::test]
async fn capacity_overflow_evicts_settled_not_active_connections() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (controls_tx, controls_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let mut tasks = tokio::task::JoinSet::new();
        let mut controls = Vec::new();
        for _ in 0..65 {
            let (socket, _) = listener.accept().await.unwrap();
            let (send, response) = tokio::sync::oneshot::channel();
            let (closed_tx, closed) = tokio::sync::oneshot::channel();
            controls.push((send, closed));
            tasks.spawn(async move {let mut socket=accept_async(socket).await.unwrap();socket.next().await.unwrap().unwrap();
                tokio::select! {
                    response=response=>if response.is_ok() {socket.send(Message::Text(r#"{"type":"response.completed","response":{"id":"done"}}"#.into())).await.unwrap();let _=socket.next().await;},
                    _=socket.next()=>{}
                }
                let _=closed_tx.send(());
            });
        }
        controls_tx.send(controls).unwrap();
        while let Some(task) = tasks.join_next().await {
            task.unwrap();
        }
    });
    let mut transport = JsonTransport::new(|_| Ok(parse_json("{}").unwrap()));
    let mut config = continuation();
    config.session = Arc::new(|request| {
        Some(SessionMetadata {
            key: request.id.as_ref().unwrap().as_str().unwrap().into(),
            fingerprint: "same".into(),
            message_boundary: 0,
            full_replay: false,
        })
    });
    transport.continuation = Some(config);
    let mut connections = Vec::new();
    for index in 0..65 {
        let mut request = Request::new(prepared_model(address));
        request.id = Some(format!("session-{index}").into());
        let prepared = request.model.route.prepare(&request).unwrap();
        connections.push(transport.open(&prepared, None).await.unwrap());
    }
    let mut controls = controls_rx.await.unwrap();
    let (send, closed) = controls.pop().unwrap();
    send.send(()).unwrap();
    let mut last = connections.pop().unwrap();
    assert!(
        last.next()
            .await
            .unwrap()
            .unwrap()
            .contains("response.completed")
    );
    drop(last);
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(2), closed)
            .await
            .is_ok(),
        "settled overflow connection was retained"
    );
    assert!(
        controls.iter_mut().all(|(_, closed)| matches!(
            closed.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        )),
        "active connection evicted"
    );
    drop(connections);
    drop(controls);
    server.await.unwrap();
}

#[tokio::test]
async fn idle_timer_closes_retained_socket_without_closing_active_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (release, ready) = tokio::sync::oneshot::channel();
    let (idle_closed_tx, idle_closed) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (active, _) = listener.accept().await.unwrap();
        let mut active = accept_async(active).await.unwrap();
        active.next().await.unwrap().unwrap();
        let active = tokio::spawn(async move {
            let mut ready = ready;
            let mut pings = 0;
            loop {
                tokio::select! {
                    message=active.next()=>match message.unwrap().unwrap() {Message::Ping(bytes)=>{pings+=1;active.send(Message::Pong(bytes)).await.unwrap();},other=>panic!("active connection changed before release: {other:?}")},
                    _=&mut ready=>{active.send(Message::Text(r#"{"type":"response.completed","response":{"id":"active"}}"#.into())).await.unwrap();break;}
                }
            }
            pings
        });
        let (idle, _) = listener.accept().await.unwrap();
        let mut idle = accept_async(idle).await.unwrap();
        idle.next().await.unwrap().unwrap();
        idle.send(Message::Text(
            r#"{"type":"response.completed","response":{"id":"idle"}}"#.into(),
        ))
        .await
        .unwrap();
        let mut pings = 0;
        while let Some(message) = idle.next().await {
            match message.unwrap() {
                Message::Ping(bytes) => {
                    pings += 1;
                    idle.send(Message::Pong(bytes)).await.unwrap();
                }
                Message::Close(_) => break,
                other => panic!("unexpected idle message: {other:?}"),
            }
        }
        idle_closed_tx.send(pings).unwrap();
        active.await.unwrap()
    });
    let mut transport = JsonTransport::new(|_| Ok(parse_json("{}").unwrap()));
    let mut config = continuation();
    config.session = Arc::new(|request| {
        Some(SessionMetadata {
            key: request.id.as_ref().unwrap().as_str().unwrap().into(),
            fingerprint: "same".into(),
            message_boundary: 0,
            full_replay: false,
        })
    });
    transport.continuation = Some(config);
    let mut request = Request::new(prepared_model(address));
    request.id = Some("active".into());
    let mut active = transport
        .open(&request.model.route.prepare(&request).unwrap(), None)
        .await
        .unwrap();
    request.id = Some("idle".into());
    let mut idle = transport
        .open(&request.model.route.prepare(&request).unwrap(), None)
        .await
        .unwrap();
    idle.next().await.unwrap().unwrap();
    drop(idle);
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(75), idle_closed)
            .await
            .unwrap()
            .unwrap()
            >= 2
    );
    release.send(()).unwrap();
    assert!(
        active
            .next()
            .await
            .unwrap()
            .unwrap()
            .contains("response.completed")
    );
    drop(active);
    assert!(server.await.unwrap() >= 2);
}
