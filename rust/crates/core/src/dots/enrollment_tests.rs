use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};

fn request(phase: Phase) -> Request {
    Request {
        phase,
        credential: Arc::new(native::ResolvedCredential {
            profile: "synthetic".into(),
            credential_id: "crd_synthetic".into(),
            account_id: "synthetic_account".into(),
            account_generation: 1,
            access_token: "synthetic_access_marker".into(),
        }),
        installation_id: "synthetic_installation".into(),
        server_name: "synthetic_host.local".into(),
        server_id: (phase == Phase::Refresh).then(|| "synthetic_server".into()),
    }
}

async fn stand_in(response: Vec<u8>) -> (String, JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut received = vec![];
        loop {
            let mut chunk = [0; 4096];
            let count = stream.read(&mut chunk).await.unwrap();
            if count == 0 {
                break;
            }
            received.extend_from_slice(&chunk[..count]);
            if let Some(end) = received.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&received[..end]);
                let length = head
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|value| value.parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if received.len() >= end + 4 + length {
                    break;
                }
            }
        }
        let _ = stream.write_all(&response).await;
        String::from_utf8(received).unwrap()
    });
    (format!("http://{address}/synthetic"), task)
}

fn response(bytes: usize, chunked: bool) -> Vec<u8> {
    let mut response = if chunked {
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec()
    } else {
        format!("HTTP/1.1 200 OK\r\nContent-Length: {bytes}\r\nConnection: close\r\n\r\n")
            .into_bytes()
    };
    if chunked {
        response.extend_from_slice(format!("{bytes:x}\r\n").as_bytes());
    }
    response.extend(std::iter::repeat_n(b'x', bytes));
    if chunked {
        response.extend_from_slice(b"\r\n0\r\n\r\n");
    }
    response
}

#[tokio::test]
async fn exact_response_cap_accepts_and_one_byte_over_rejects_with_or_without_content_length() {
    for chunked in [false, true] {
        for bytes in [RESPONSE_BYTES, RESPONSE_BYTES + 1] {
            let (url, server) = stand_in(response(bytes, chunked)).await;
            let result = post_at(request(Phase::Enroll), &url).await;
            if bytes == RESPONSE_BYTES {
                assert_eq!(result.unwrap().body.len(), bytes);
            } else {
                let error = result.err().unwrap();
                assert_eq!(error.to_string(), access::Error::Unavailable.to_string());
            }
            server.await.unwrap();
        }
    }
}

#[tokio::test]
async fn oversized_content_length_does_not_bypass_the_streamed_response_cap() {
    let mut bytes = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        RESPONSE_BYTES * 2
    )
    .into_bytes();
    bytes.extend(std::iter::repeat_n(b'x', RESPONSE_BYTES + 1));
    let (url, server) = stand_in(bytes).await;
    assert!(post_at(request(Phase::Enroll), &url).await.is_err());
    server.await.unwrap();
}

#[tokio::test]
async fn request_headers_and_body_are_built_from_the_typed_selected_credential() {
    for phase in [Phase::Enroll, Phase::Refresh] {
        let (url, server) = stand_in(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_vec(),
        )
        .await;
        assert_eq!(post_at(request(phase), &url).await.unwrap().status, 200);
        let received = server.await.unwrap();
        let (headers, body) = received.split_once("\r\n\r\n").unwrap();
        let headers = headers.to_ascii_lowercase();
        assert!(headers.contains("authorization: bearer synthetic_access_marker"));
        assert!(headers.contains("chatgpt-account-id: synthetic_account"));
        assert!(headers.contains("x-codex-installation-id: synthetic_installation"));
        let body: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["name"], "synthetic_host.local");
        assert_eq!(body["installation_id"], "synthetic_installation");
        assert_eq!(body["app_server_version"], "0.163.0-alpha.10.2");
        assert_eq!(
            body.get("server_id").and_then(serde_json::Value::as_str),
            (phase == Phase::Refresh).then_some("synthetic_server")
        );
        assert!(body.get("access_token").is_none());
    }
}

#[tokio::test]
async fn redirects_are_returned_without_following_or_forwarding_credentials() {
    let other = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = other.local_addr().unwrap();
    let (url, server) = stand_in(format!("HTTP/1.1 302 Found\r\nLocation: http://{target}/secret\r\nRetry-After: 7\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes()).await;
    let response = post_at(request(Phase::Enroll), &url).await.unwrap();
    assert_eq!(response.status, 302);
    assert_eq!(response.retry_after.as_deref(), Some("7"));
    server.await.unwrap();
    tokio::select! { biased; result = other.accept() => panic!("redirect target was contacted: {}", result.is_ok()), _ = std::future::ready(()) => {} }
}

#[tokio::test]
async fn invalid_header_and_body_errors_do_not_expose_credential_or_response_text() {
    let mut invalid = request(Phase::Enroll);
    Arc::get_mut(&mut invalid.credential).unwrap().access_token =
        "synthetic_access_marker\r\ninjected: yes".into();
    let error = post_at(invalid, "http://127.0.0.1:1")
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(!error.contains("synthetic"));
    assert!(!error.contains("injected"));
    let (url, server) = stand_in(
        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n\xff\xfe".to_vec(),
    )
    .await;
    let error = post_at(request(Phase::Enroll), &url)
        .await
        .err()
        .unwrap()
        .to_string();
    assert_eq!(error, access::Error::Unavailable.to_string());
    server.await.unwrap();
}

#[tokio::test]
async fn deadline_covers_response_body_after_headers_arrive() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (release, held) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buffer = [0; 4096];
        let _ = stream.read(&mut buffer).await.unwrap();
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nx")
            .await
            .unwrap();
        let _ = held.await;
    });
    let started = std::time::Instant::now();
    let result = post_at(
        request(Phase::Enroll),
        &format!("http://{address}/synthetic"),
    )
    .await;
    assert!(result.is_err());
    assert!(started.elapsed() >= std::time::Duration::from_millis(DEADLINE_MS - 250));
    assert!(started.elapsed() < std::time::Duration::from_millis(DEADLINE_MS + 3000));
    drop(release);
    server.await.unwrap();
}

fn executor_request(body: &str) -> ExecutorRequest {
    ExecutorRequest {
        credential: request(Phase::Enroll).credential,
        body: body.into(),
    }
}

#[test]
fn the_executor_endpoint_is_the_flora_cca_executor_route() {
    assert_eq!(
        EXECUTOR_URL,
        "https://chatgpt.com/backend-api/flora/cca/executor"
    );
    assert_eq!(EXECUTOR_DEADLINE_MS, 15_000);
}

#[tokio::test]
async fn executor_requests_carry_the_cca_identity_and_the_caller_body_verbatim() {
    let (url, server) =
        stand_in(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_vec())
            .await;
    let response = post_executor_at(executor_request(r#"{"displayName":"x"}"#), &url)
        .await
        .unwrap();
    assert_eq!(
        (response.status, response.challenged, response.body.as_str()),
        (200, false, "{}")
    );
    let received = server.await.unwrap();
    let (headers, body) = received.split_once("\r\n\r\n").unwrap();
    let lowered = headers.to_ascii_lowercase();
    assert!(lowered.starts_with("post /synthetic "));
    assert!(lowered.contains("authorization: bearer synthetic_access_marker"));
    assert!(lowered.contains("chatgpt-account-id: synthetic_account"));
    assert!(lowered.contains("originator: codex desktop"));
    assert!(lowered.contains(&format!(
        "user-agent: {}",
        cca_headers::user_agent().to_ascii_lowercase()
    )));
    assert!(lowered.contains("content-type: application/json"));
    assert!(!lowered.contains("x-codex-installation-id"));
    assert_eq!(body, r#"{"displayName":"x"}"#);
}

#[tokio::test]
async fn executor_redirects_are_transport_errors_and_never_followed() {
    let other = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = other.local_addr().unwrap();
    for status in [
        "301 Moved Permanently",
        "302 Found",
        "307 Temporary Redirect",
        "308 Permanent Redirect",
    ] {
        let (url, server) = stand_in(format!("HTTP/1.1 {status}\r\nLocation: http://{target}/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes()).await;
        let error = post_executor_at(executor_request("{}"), &url)
            .await
            .err()
            .unwrap();
        assert_eq!(error.to_string(), access::Error::Unavailable.to_string());
        server.await.unwrap();
    }
    tokio::select! { biased; result = other.accept() => panic!("redirect target was contacted: {}", result.is_ok()), _ = std::future::ready(()) => {} }
}

#[tokio::test]
async fn executor_responses_report_cloudflare_challenges_and_non_success_statuses() {
    for (header, challenged) in [
        ("cf-mitigated: challenge", true),
        ("CF-Mitigated: Challenge", true),
        ("cf-mitigated: other", false),
        ("x-unrelated: challenge", false),
    ] {
        let (url, server) = stand_in(format!("HTTP/1.1 403 Forbidden\r\n{header}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}").into_bytes()).await;
        let response = post_executor_at(executor_request("{}"), &url)
            .await
            .unwrap();
        assert_eq!(
            (response.status, response.challenged),
            (403, challenged),
            "{header}"
        );
        server.await.unwrap();
    }
}

#[tokio::test]
async fn executor_responses_obey_the_same_streamed_size_cap() {
    for chunked in [false, true] {
        for bytes in [RESPONSE_BYTES, RESPONSE_BYTES + 1] {
            let (url, server) = stand_in(response(bytes, chunked)).await;
            let result = post_executor_at(executor_request("{}"), &url).await;
            assert_eq!(result.is_ok(), bytes == RESPONSE_BYTES);
            server.await.unwrap();
        }
    }
}

#[tokio::test]
async fn executor_header_injection_and_invalid_utf8_are_rejected_without_leaking() {
    let mut invalid = executor_request("{}");
    Arc::get_mut(&mut invalid.credential).unwrap().access_token =
        "synthetic_access_marker\r\ninjected: yes".into();
    let error = post_executor_at(invalid, "http://127.0.0.1:1")
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(!error.contains("synthetic") && !error.contains("injected"));
    let (url, server) = stand_in(
        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n\xff\xfe".to_vec(),
    )
    .await;
    assert!(
        post_executor_at(executor_request("{}"), &url)
            .await
            .is_err()
    );
    server.await.unwrap();
}

#[test]
fn instants_format_as_javascript_iso_strings_and_parse_the_supported_date_grammars() {
    assert_eq!(instant_iso(0).as_deref(), Some("1970-01-01T00:00:00.000Z"));
    assert_eq!(
        instant_iso(1_793_440_800_123).as_deref(),
        Some("2026-10-31T10:00:00.123Z")
    );
    assert_eq!(instant_iso(-1).as_deref(), Some("1969-12-31T23:59:59.999Z"));
    assert_eq!(instant_iso(8_640_000_000_000_001), None);
    for (text, expected) in [
        ("2026-10-31T10:00:00.000Z", Some(1_793_440_800_000)),
        ("2026-10-31T10:00:00Z", Some(1_793_440_800_000)),
        ("2026-10-31T12:00:00+02:00", Some(1_793_440_800_000)),
        ("2026-10-31T10:00:00.5Z", Some(1_793_440_800_500)),
        ("Sat, 31 Oct 2026 10:00:00 GMT", Some(1_793_440_800_000)),
        ("2026-10-31", Some(1_793_404_800_000)),
        ("", None),
        ("tomorrow", None),
        ("2026-13-45T00:00:00Z", None),
    ] {
        assert_eq!(parse_instant(text), expected, "{text}");
    }
}
