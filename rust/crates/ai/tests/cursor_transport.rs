use bytes::Bytes;
use http::{HeaderMap, HeaderValue, Response};
use std::{collections::BTreeMap, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use ycoding_ai::{
    auth::{Auth, Credential},
    cursor::{framing, headers, proxy, request, transport},
    provider_error::Reason,
};

fn identity() -> headers::Identity {
    headers::Identity {
        machine_id: "machine".into(),
        mac_machine_id: None,
        client_version: "cli-fixture".into(),
    }
}

#[tokio::test]
async fn cursor_goaway_drains_the_existing_run_and_routes_the_next_run_to_a_fresh_connection() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut first = h2::server::handshake(socket).await.unwrap();
            let (request, mut response) = first.accept().await.unwrap().unwrap();
            let mut send = response
                .send_response(Response::builder().status(200).body(()).unwrap(), false)
                .unwrap();
            let mut ping = first.ping_pong().unwrap();
            first.graceful_shutdown();
            let driver = tokio::spawn(async move {
                assert!(first.accept().await.is_none());
            });
            ping.ping(h2::Ping::opaque()).await.unwrap();
            send.send_data(
                Bytes::from(framing::encode(0, &[10, 2, 106, 0]).unwrap()),
                false,
            )
            .unwrap();

            let (socket, _) = listener.accept().await.unwrap();
            let mut second = h2::server::handshake(socket).await.unwrap();
            let (next, mut response) = second.accept().await.unwrap().unwrap();
            let mut second_send = response
                .send_response(Response::builder().status(200).body(()).unwrap(), false)
                .unwrap();
            second_send
                .send_data(
                    Bytes::from(framing::encode(0, &[10, 2, 106, 0]).unwrap()),
                    false,
                )
                .unwrap();
            send.send_data(
                Bytes::from(framing::encode(0, &[10, 2, 114, 0]).unwrap()),
                false,
            )
            .unwrap();
            let held = (request, send, next, second_send);
            assert!(second.accept().await.is_none());
            drop(held);
            driver.await.unwrap();
        });
        let client = transport::Client::new(Default::default()).unwrap();
        let endpoint = transport::Endpoint::loopback(address).unwrap();
        let mut first = client.open(&endpoint, HeaderMap::new()).await.unwrap();
        assert_eq!(
            first.reader.next().await.unwrap().unwrap().payload,
            [10, 2, 106, 0]
        );
        let mut second = client.open(&endpoint, HeaderMap::new()).await.unwrap();
        assert_eq!(
            second.reader.next().await.unwrap().unwrap().payload,
            [10, 2, 106, 0]
        );
        assert_eq!(
            first.reader.next().await.unwrap().unwrap().payload,
            [10, 2, 114, 0]
        );
        drop(first);
        drop(second);
        client.shutdown().await;
        server.await.unwrap();
    })
    .await
    .unwrap();
}

#[test]
fn cursor_tls_uses_platform_verification_and_h2_without_client_certificates() {
    let tls = transport::tls_config().unwrap();
    assert_eq!(tls.alpn_protocols, vec![b"h2".to_vec()]);
    assert!(!tls.client_auth_cert_resolver.has_certs());
    assert!(
        transport::Client::new(transport::Options {
            read_idle_ms: 0,
            ..Default::default()
        })
        .is_err()
    );
    assert!(
        transport::Client::new(transport::Options {
            connect_timeout_ms: u64::MAX,
            ..Default::default()
        })
        .is_err()
    );
    assert!(transport::Endpoint::agent("http://agent.cursor.sh").is_err());
    assert!(transport::Endpoint::loopback("192.0.2.1:80".parse().unwrap()).is_err());
}

#[tokio::test]
async fn cursor_real_client_sends_exact_frames_and_prefers_trailer_status_to_headers() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut connection = h2::server::handshake(socket).await.unwrap();
            let (request, mut response) = connection.accept().await.unwrap().unwrap();
            assert_eq!(request.uri().path(), "/agent.v1.AgentService/Run");
            assert_eq!(request.headers()["authorization"], "Bearer fixture-token");
            let mut body = request.into_body();
            let exchange = async move {
                let mut decoder = framing::Decoder::default();
                let frame = loop {
                    let bytes = body.data().await.unwrap().unwrap();
                    body.flow_control().release_capacity(bytes.len()).unwrap();
                    if let Some(frame) = decoder.push(&bytes).pop() {
                        break frame;
                    }
                };
                assert_eq!(frame.flags, 0);
                assert_eq!(
                    frame.payload,
                    request::RunRequest::new("conv", "msg", "composer-fixture", "Hello")
                        .encode()
                        .unwrap()
                );
                let mut send = response
                    .send_response(
                        Response::builder()
                            .status(200)
                            .header("grpc-status", "14")
                            .body(())
                            .unwrap(),
                        false,
                    )
                    .unwrap();
                let bytes = framing::encode(0, &[10, 5, 10, 3, 10, 1, b'x']).unwrap();
                for chunk in bytes.chunks(2) {
                    send.send_data(Bytes::copy_from_slice(chunk), false)
                        .unwrap();
                }
                let mut trailers = HeaderMap::new();
                trailers.insert("grpc-status", HeaderValue::from_static("16"));
                trailers.insert(
                    "grpc-message",
                    HeaderValue::from_static("fixture-token denied"),
                );
                send.send_trailers(trailers).unwrap();
                while let Some(bytes) = body.data().await {
                    let bytes = bytes.unwrap();
                    body.flow_control().release_capacity(bytes.len()).unwrap();
                }
            };
            tokio::pin!(exchange);
            tokio::select! {
                () = &mut exchange => {},
                request = connection.accept() => { assert!(request.is_none()); exchange.await; },
            }
        });
        let client = transport::Client::new(Default::default()).unwrap();
        let endpoint = transport::Endpoint::loopback(address).unwrap();
        let auth = Auth::bearer(Credential::value("fixture-token"));
        let headers = headers::run(
            &auth,
            &identity(),
            "request",
            1_700_000_000_000,
            endpoint.url(),
            &BTreeMap::new(),
        )
        .unwrap();
        let mut run = client.open(&endpoint, headers).await.unwrap();
        run.writer
            .write(
                &request::RunRequest::new("conv", "msg", "composer-fixture", "Hello")
                    .encode()
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            run.reader.next().await.unwrap().unwrap().payload,
            [10, 5, 10, 3, 10, 1, b'x']
        );
        let error = run.reader.next().await.unwrap_err();
        assert_eq!(error.reason, Reason::Authentication);
        assert!(!error.message.contains("fixture-token"));
        let metadata = error.provider_metadata.unwrap();
        assert!(ycoding_schema::stringify_json(&metadata).contains("\"grpcStatus\":\"16\""));
        assert_eq!(
            run.reader.next().await.unwrap_err().reason,
            Reason::Authentication
        );
        assert_eq!(
            run.writer.write(&[58, 0]).await.unwrap_err().reason,
            Reason::Authentication
        );
        run.writer.close().await.unwrap();
        server.await.unwrap();
        drop(run);
        client.shutdown().await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn cursor_write_window_timeout_is_non_replayable_and_settles_once() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut builder = h2::server::Builder::new();
            builder.initial_window_size(0);
            let mut connection = builder.handshake(socket).await.unwrap();
            let (request, mut response) = connection.accept().await.unwrap().unwrap();
            let mut send = response
                .send_response(Response::builder().status(200).body(()).unwrap(), false)
                .unwrap();
            send.send_data(
                Bytes::from(framing::encode(0, &[10, 2, 106, 0]).unwrap()),
                false,
            )
            .unwrap();
            let held = (request, send);
            assert!(connection.accept().await.is_none());
            drop(held);
        });
        let client = transport::Client::new(transport::Options {
            write_drain_ms: 10,
            ..Default::default()
        })
        .unwrap();
        let mut run = client
            .open(
                &transport::Endpoint::loopback(address).unwrap(),
                HeaderMap::new(),
            )
            .await
            .unwrap();
        run.reader.next().await.unwrap().unwrap();
        let error = run.writer.write(&[58, 0]).await.unwrap_err();
        assert_eq!(error.code.as_deref(), Some("CURSOR_WRITE_DRAIN_TIMEOUT"));
        let metadata = ycoding_schema::stringify_json(error.provider_metadata.as_ref().unwrap());
        assert!(metadata.contains("\"replaySafe\":false"));
        assert!(metadata.contains("\"transient\":false"));
        assert_eq!(run.reader.next().await.unwrap_err().code, error.code);
        drop(run);
        client.shutdown().await;
        server.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn cursor_read_idle_timeout_is_explicit_and_does_not_complete() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut connection = h2::server::handshake(socket).await.unwrap();
            let (request, mut response) = connection.accept().await.unwrap().unwrap();
            let send = response
                .send_response(Response::builder().status(200).body(()).unwrap(), false)
                .unwrap();
            let held = (request, send);
            assert!(connection.accept().await.is_none());
            drop(held);
        });
        let client = transport::Client::new(transport::Options {
            read_idle_ms: 10,
            ..Default::default()
        })
        .unwrap();
        let mut run = client
            .open(
                &transport::Endpoint::loopback(address).unwrap(),
                HeaderMap::new(),
            )
            .await
            .unwrap();
        let error = run.reader.next().await.unwrap_err();
        assert_eq!(error.code.as_deref(), Some("CURSOR_READ_IDLE_TIMEOUT"));
        assert_eq!(run.reader.next().await.unwrap_err().code, error.code);
        run.writer.cancel();
        assert!(run.reader.next().await.unwrap().is_none());
        drop(run);
        client.shutdown().await;
        server.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn cursor_local_close_interrupts_an_owned_read_without_remote_failure() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut connection = h2::server::handshake(socket).await.unwrap();
            while connection.accept().await.is_some() {}
        });
        let client = transport::Client::new(Default::default()).unwrap();
        let mut run = client
            .open(
                &transport::Endpoint::loopback(address).unwrap(),
                HeaderMap::new(),
            )
            .await
            .unwrap();
        run.writer.close().await.unwrap();
        assert!(run.reader.next().await.unwrap().is_none());
        assert_eq!(
            run.writer.write(&[58, 0]).await.unwrap_err().reason,
            Reason::Interrupted
        );
        drop(run);
        client.shutdown().await;
        server.await.unwrap();
    })
    .await
    .unwrap();
}

#[test]
fn cursor_proxy_resolution_keeps_explicit_environment_and_no_proxy_semantics() {
    let env = BTreeMap::from([
        (
            "HTTPS_PROXY".into(),
            "http://user:p%40ss@localhost:8080".into(),
        ),
        ("NO_PROXY".into(), ".corp.example:443, [::1]:8443".into()),
    ]);
    assert!(proxy::resolve("host.corp.example", 443, &env).is_none());
    assert!(proxy::resolve("host.corp.example", 8443, &env).is_some());
    assert!(proxy::host_matches_no_proxy(
        "::1",
        8443,
        Some("[::1]:8443")
    ));
    assert!(!proxy::host_matches_no_proxy(
        "cursor.sh.evil.test",
        443,
        Some("cursor.sh")
    ));
    assert!(
        proxy::resolve(
            "agent.cursor.sh",
            443,
            &BTreeMap::from([("HTTPS_PROXY".into(), "https://localhost:8080".into())])
        )
        .is_none()
    );
}

#[tokio::test]
async fn cursor_proxy_connect_preserves_buffered_bytes_and_encoded_userinfo() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut byte = [0; 1];
            while !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).await.unwrap();
                request.extend(byte);
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("CONNECT agent.fixture.cursor.sh:443 HTTP/1.1\r\n"));
            assert!(request.contains("Proxy-Authorization: Basic dXNlcjpwQHNz\r\n"));
            socket
                .write_all(b"HTTP/1.1 204 Connected\r\n\r\nTLS")
                .await
                .unwrap();
        });
        let url = reqwest::Url::parse(&format!("http://user:p%40ss@{address}")).unwrap();
        let mut socket = proxy::connect(&url, "agent.fixture.cursor.sh", 443)
            .await
            .unwrap();
        let mut bytes = [0; 3];
        socket.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"TLS");
        server.await.unwrap();
    })
    .await
    .unwrap();
}
