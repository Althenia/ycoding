use super::*;
use std::sync::Mutex;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};

fn credential(access: &str) -> Arc<native::ResolvedCredential> {
    Arc::new(native::ResolvedCredential {
        profile: "synthetic".into(),
        credential_id: "crd_synthetic".into(),
        account_id: "synthetic_account".into(),
        account_generation: 1,
        access_token: access.into(),
    })
}

fn http(status: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

async fn serve(responses: Vec<Vec<u8>>) -> (String, JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let mut requests = vec![];
        for response in responses {
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
                    let head = String::from_utf8_lossy(&received[..end]).to_ascii_lowercase();
                    let length = head
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length: ")
                                .and_then(|value| value.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if received.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let _ = stream.write_all(&response).await;
            requests.push(String::from_utf8(received).unwrap());
        }
        requests
    });
    (format!("http://{address}/api"), task)
}

fn public_key() -> JsonValue {
    ObjectEncoder::new()
        .field("suite", "Noise_hybridIK_X25519+MLKEM768_AESGCM_SHA256")
        .field("x25519_public_key", "eA==")
        .field("mlkem768_public_key", "bQ==")
        .finish()
}

fn registered(environment: &str) -> String {
    format!(
        r#"{{"environment_id":"{environment}","security_profile":"noise_hybrid_ik_v1","executor_registration_id":"  reg-1  ","url":" wss://rendezvous.chatgpt.com/ws "}}"#
    )
}

fn body_of(request: &str) -> JsonValue {
    parse_json(request.split_once("\r\n\r\n").unwrap().1).unwrap()
}

fn field<'a>(value: &'a JsonValue, name: &str) -> &'a JsonValue {
    let JsonValue::Object(object) = value else {
        panic!("not an object")
    };
    object.get(&name.into()).unwrap_or(&JsonValue::Null)
}

#[test]
fn identifiers_are_percent_encoded_like_encode_uri_component() {
    assert_eq!(
        encode_component("env_e_AZaz09-_.!~*'()"),
        "env_e_AZaz09-_.!~*'()"
    );
    assert_eq!(
        encode_component("a b/c?d#e&f=g+h"),
        "a%20b%2Fc%3Fd%23e%26f%3Dg%2Bh"
    );
    assert_eq!(encode_component("é😀"), "%C3%A9%F0%9F%98%80");
    assert_eq!(encode_component(""), "");
}

#[test]
fn stream_ids_are_canonicalized_only_when_they_are_uuids() {
    let canonical = "0123abcd-4567-89ef-0123-456789abcdef";
    for accepted in [
        "0123ABCD-4567-89EF-0123-456789ABCDEF",
        "0123abcd456789ef0123456789abcdef",
        "urn:uuid:0123abcd-4567-89ef-0123-456789abcdef",
        "{0123abcd-4567-89ef-0123-456789abcdef}",
    ] {
        assert_eq!(
            canonical_uuid(accepted).as_deref(),
            Some(canonical),
            "{accepted}"
        );
    }
    for rejected in [
        "",
        "stream-1",
        "0123abcd-4567-89ef-0123-456789abcde",
        "0123abcd-4567-89ef-0123-456789abcdeg",
        "urn:uuid:0123abcd456789ef0123456789abcdef",
        "{0123abcd456789ef0123456789abcdef}",
        "0123abcd-4567-89ef-0123456789abcdef",
        "{0123abcd-4567-89ef-0123-456789abcdef",
    ] {
        assert_eq!(canonical_uuid(rejected), None, "{rejected}");
    }
}

#[test]
fn rendezvous_urls_must_be_chatgpt_wss_without_userinfo() {
    for accepted in [
        "wss://chatgpt.com/ws",
        "wss://relay.chatgpt.com/a/b?c=d",
        "WSS://RELAY.ChatGPT.com/ws",
    ] {
        assert!(rendezvous_url(accepted).is_some(), "{accepted}");
    }
    assert_eq!(
        rendezvous_url("wss://relay.chatgpt.com/ws?x=1").as_deref(),
        Some("wss://relay.chatgpt.com/ws?x=1")
    );
    for rejected in [
        "ws://relay.chatgpt.com/ws",
        "https://relay.chatgpt.com/ws",
        "wss://user@relay.chatgpt.com/ws",
        "wss://user:pw@relay.chatgpt.com/ws",
        "wss://evilchatgpt.com/ws",
        "wss://chatgpt.com.evil.example/ws",
        "wss://example.com/ws",
        "not a url",
        "",
    ] {
        assert_eq!(rendezvous_url(rejected), None, "{rejected}");
    }
}

#[test]
fn registration_conflicts_retry_with_the_canonical_bounded_backoff() {
    let http = |status, code: Option<&str>| Error::Http {
        status,
        code: code.map(str::to_owned),
    };
    assert!(retryable(&http(503, Some("registration_conflict"))));
    assert!(retryable(&http(
        502,
        Some("authentication_service_unavailable")
    )));
    assert!(!retryable(&http(
        503,
        Some("authentication_service_unavailable")
    )));
    assert!(!retryable(&http(502, Some("registration_conflict"))));
    assert!(!retryable(&http(503, None)));
    assert!(!retryable(&http(500, Some("registration_conflict"))));
    assert!(!retryable(&Error::Failed("request failed")));
    assert_eq!(retry_delay_ms(0, 0.0), 500);
    assert_eq!(retry_delay_ms(0, 0.999), 500 + 250);
    assert_eq!(retry_delay_ms(1, 0.0), 1_000);
    assert_eq!(retry_delay_ms(3, 0.0), 4_000);
    assert_eq!(retry_delay_ms(4, 0.0), 5_000);
    assert_eq!(retry_delay_ms(40, 0.0), 5_000);
    assert_eq!(retry_delay_ms(40, 0.999), 5_000 + 2_500);
}

#[test]
fn the_exec_server_identity_is_the_canonical_cli_user_agent() {
    let agent = user_agent();
    assert!(
        agent.starts_with("codex_cli_rs/0.165.0-alpha.1.2 ("),
        "{agent}"
    );
    assert!(agent.ends_with(") unknown"), "{agent}");
    assert_eq!(agent.matches(';').count(), 1, "{agent}");
    if cfg!(target_os = "macos") {
        assert!(agent.contains("(Mac OS "), "{agent}");
    }
}

#[test]
fn the_exec_server_identity_is_composed_like_the_canonical_template() {
    assert_eq!(
        format_user_agent("Windows 10.0.22631", "x86_64"),
        "codex_cli_rs/0.165.0-alpha.1.2 (Windows 10.0.22631; x86_64) unknown"
    );
    assert_eq!(
        format_user_agent("Linux 6.8.0", "aarch64"),
        "codex_cli_rs/0.165.0-alpha.1.2 (Linux 6.8.0; aarch64) unknown"
    );
}

#[test]
fn windows_release_is_the_dotted_major_minor_build_version() {
    assert_eq!(
        windows_uname(10, 0, 22631, 9),
        Some(("10.0.22631".to_owned(), "x86_64".to_owned()))
    );
    assert_eq!(
        windows_uname(6, 1, 7601, 9),
        Some(("6.1.7601".to_owned(), "x86_64".to_owned()))
    );
}

#[test]
fn windows_machine_names_follow_the_native_processor_architecture() {
    assert_eq!(windows_uname(10, 0, 26100, 12).unwrap().1, "arm64");
    assert_eq!(windows_uname(10, 0, 26100, 9).unwrap().1, "x86_64");
}

#[test]
fn undecided_windows_architectures_yield_no_identity_instead_of_a_guess() {
    for architecture in [0, 1, 5, 6, 10, 14, 0xFFFF] {
        assert_eq!(
            windows_uname(10, 0, 22631, architecture),
            None,
            "{architecture}"
        );
    }
}

#[cfg(windows)]
#[test]
fn windows_architecture_constants_match_the_system_bindings() {
    use windows_sys::Win32::System::SystemInformation::{
        PROCESSOR_ARCHITECTURE_AMD64, PROCESSOR_ARCHITECTURE_ARM64,
    };
    assert_eq!(WINDOWS_ARCHITECTURE_AMD64, PROCESSOR_ARCHITECTURE_AMD64);
    assert_eq!(WINDOWS_ARCHITECTURE_ARM64, PROCESSOR_ARCHITECTURE_ARM64);
}

#[cfg(windows)]
#[test]
fn the_windows_exec_server_identity_reports_the_live_release_and_machine() {
    let (release, machine) = uname().expect("the system version and architecture are readable");
    let parts = release.split('.').collect::<Vec<_>>();
    assert_eq!(parts.len(), 3, "{release}");
    assert!(
        parts.iter().all(|part| part.parse::<u32>().is_ok()),
        "{release}"
    );
    assert!(["x86_64", "arm64"].contains(&machine.as_str()), "{machine}");
    let agent = user_agent();
    assert!(
        agent.contains(&format!("(Windows {release}; {machine})")),
        "{agent}"
    );
}

#[tokio::test]
async fn registration_posts_the_noise_profile_and_returns_trimmed_connection_details() {
    let (base, server) = serve(vec![http("200 OK", &registered("env/1"))]).await;
    let mut auth = credential("synthetic_access_marker");
    let result = register_at(&base, "  env/1  ", &mut auth, None, public_key())
        .await
        .unwrap();
    assert_eq!(
        result,
        Registered {
            environment_id: "env/1".into(),
            executor_registration_id: "reg-1".into(),
            url: "wss://rendezvous.chatgpt.com/ws".into(),
            security_profile: "noise_hybrid_ik_v1".into(),
        }
    );
    let requests = server.await.unwrap();
    assert!(requests[0].starts_with("POST /api/cloud/environment/env%2F1/register HTTP/1.1"));
    let headers = requests[0]
        .split_once("\r\n\r\n")
        .unwrap()
        .0
        .to_ascii_lowercase();
    assert!(headers.contains("authorization: bearer synthetic_access_marker"));
    assert!(headers.contains("chatgpt-account-id: synthetic_account"));
    assert!(headers.contains("originator: codex_cli_rs"));
    assert!(headers.contains(&format!(
        "user-agent: {}",
        user_agent().to_ascii_lowercase()
    )));
    assert!(headers.contains("content-type: application/json"));
    assert!(!headers.contains(STREAM_HEADER));
    let body = body_of(&requests[0]);
    assert_eq!(
        field(&body, "security_profile"),
        &JsonValue::String("noise_hybrid_ik_v1".into())
    );
    assert_eq!(field(&body, "executor_public_key"), &public_key());
}

#[tokio::test]
async fn registration_rejects_inconsistent_or_incomplete_payloads() {
    let environment = |value: &str| value.replace("env-1", "other");
    for (body, reason) in [
        (
            environment(&registered("env-1")),
            "registry returned a different environment id",
        ),
        (
            registered("env-1").replace("noise_hybrid_ik_v1", "other"),
            "registry returned unsupported security profile",
        ),
        (
            registered("env-1").replace("  reg-1  ", "   "),
            "registry returned invalid executor_registration_id",
        ),
        (
            registered("env-1").replace(" wss://rendezvous.chatgpt.com/ws ", " "),
            "registry returned incomplete connection url",
        ),
        ("[]".into(), "registration returned an invalid payload"),
        (
            "not json".into(),
            "registration returned an invalid payload",
        ),
    ] {
        let (base, server) = serve(vec![http("200 OK", &body)]).await;
        let mut auth = credential("synthetic_access_marker");
        let error = register_at(&base, "env-1", &mut auth, None, public_key())
            .await
            .unwrap_err();
        assert_eq!(error, Error::Failed(reason), "{body}");
        server.await.unwrap();
    }
    let mut auth = credential("synthetic_access_marker");
    assert_eq!(
        register_at(
            "http://127.0.0.1:1/api",
            "   ",
            &mut auth,
            None,
            public_key()
        )
        .await
        .unwrap_err(),
        Error::Failed("environment id is required")
    );
}

#[tokio::test]
async fn registration_failures_surface_the_status_and_the_registry_error_code() {
    for (body, code) in [
        (
            r#"{"error":{"code":"registration_conflict"}}"#,
            Some("registration_conflict"),
        ),
        (
            r#"{"detail":{"code":"authentication_service_unavailable"}}"#,
            Some("authentication_service_unavailable"),
        ),
        (
            r#"{"error":null,"detail":{"code":"from_detail"}}"#,
            Some("from_detail"),
        ),
        (
            r#"{"error":{"code":"first"},"detail":{"code":"second"}}"#,
            Some("first"),
        ),
        (r#"{"error":{"code":7}}"#, None),
        (r#"{"error":"flat"}"#, None),
        (r#"[1]"#, None),
        ("not json", None),
        ("", None),
    ] {
        let (base, server) = serve(vec![http("503 Service Unavailable", body)]).await;
        let mut auth = credential("synthetic_access_marker");
        let error = register_at(&base, "env-1", &mut auth, None, public_key())
            .await
            .unwrap_err();
        assert_eq!(
            error,
            Error::Http {
                status: 503,
                code: code.map(str::to_owned)
            },
            "{body}"
        );
        server.await.unwrap();
    }
}

fn refresh_to(next: Option<&'static str>, seen: Arc<Mutex<Vec<String>>>) -> Refresh {
    Arc::new(move |rejected| {
        seen.lock().unwrap().push(rejected);
        Box::pin(async move { Ok(next.map(credential)) })
    })
}

#[tokio::test]
async fn unauthorized_responses_refresh_once_and_keep_the_renewed_credential() {
    let seen = Arc::new(Mutex::new(vec![]));
    let (base, server) = serve(vec![
        http("401 Unauthorized", "{}"),
        http("200 OK", &registered("env-1")),
    ])
    .await;
    let mut auth = credential("stale_marker");
    let refresh = refresh_to(Some("renewed_marker"), seen.clone());
    register_at(&base, "env-1", &mut auth, Some(&refresh), public_key())
        .await
        .unwrap();
    assert_eq!(auth.access_token, "renewed_marker");
    assert_eq!(seen.lock().unwrap().as_slice(), ["stale_marker"]);
    let requests = server.await.unwrap();
    assert!(
        requests[0]
            .to_ascii_lowercase()
            .contains("authorization: bearer stale_marker")
    );
    assert!(
        requests[1]
            .to_ascii_lowercase()
            .contains("authorization: bearer renewed_marker")
    );

    let (base, server) = serve(vec![
        http("401 Unauthorized", "{}"),
        http("401 Unauthorized", "{}"),
    ])
    .await;
    let mut auth = credential("stale_marker");
    let seen = Arc::new(Mutex::new(vec![]));
    let refresh = refresh_to(Some("renewed_marker"), seen.clone());
    let error = register_at(&base, "env-1", &mut auth, Some(&refresh), public_key())
        .await
        .unwrap_err();
    assert_eq!(
        error,
        Error::Http {
            status: 401,
            code: None
        }
    );
    assert_eq!(seen.lock().unwrap().len(), 1);
    server.await.unwrap();

    for next in [None, Some("stale_marker")] {
        let (base, server) = serve(vec![http("401 Unauthorized", "{}")]).await;
        let mut auth = credential("stale_marker");
        let refresh = refresh_to(next, Arc::new(Mutex::new(vec![])));
        let error = register_at(&base, "env-1", &mut auth, Some(&refresh), public_key())
            .await
            .unwrap_err();
        assert_eq!(
            error,
            Error::Http {
                status: 401,
                code: None
            }
        );
        assert_eq!(auth.access_token, "stale_marker");
        server.await.unwrap();
    }
}

#[tokio::test]
async fn redirects_are_request_failures_and_are_never_followed() {
    let other = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = other.local_addr().unwrap();
    let (base, server) = serve(vec![format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{target}/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes()]).await;
    let mut auth = credential("synthetic_access_marker");
    assert_eq!(
        register_at(&base, "env-1", &mut auth, None, public_key())
            .await
            .unwrap_err(),
        Error::Failed("request failed")
    );
    server.await.unwrap();
    tokio::select! { biased; result = other.accept() => panic!("redirect target was contacted: {}", result.is_ok()), _ = std::future::ready(()) => {} }
}

#[tokio::test]
async fn validation_sends_the_canonical_stream_header_and_requires_valid_true() {
    let stream = "0123ABCD-4567-89EF-0123-456789ABCDEF";
    let (base, server) = serve(vec![http("200 OK", r#"{"valid":true}"#)]).await;
    let mut auth = credential("synthetic_access_marker");
    validate_at(
        &base,
        " env-1 ",
        &mut auth,
        None,
        "reg-1",
        public_key(),
        "authorization-value",
        stream,
    )
    .await
    .unwrap();
    let requests = server.await.unwrap();
    assert!(requests[0].starts_with("POST /api/cloud/environment/env-1/validate HTTP/1.1"));
    let headers = requests[0]
        .split_once("\r\n\r\n")
        .unwrap()
        .0
        .to_ascii_lowercase();
    assert!(headers.contains("x-codex-noise-stream-id: 0123abcd-4567-89ef-0123-456789abcdef"));
    let body = body_of(&requests[0]);
    assert_eq!(
        field(&body, "executor_registration_id"),
        &JsonValue::String("reg-1".into())
    );
    assert_eq!(field(&body, "harness_public_key"), &public_key());
    assert_eq!(
        field(&body, "harness_key_authorization"),
        &JsonValue::String("authorization-value".into())
    );

    let (base, server) = serve(vec![http("200 OK", r#"{"valid":true}"#)]).await;
    validate_at(
        &base,
        "env-1",
        &mut auth,
        None,
        "reg-1",
        public_key(),
        "a",
        "not-a-uuid",
    )
    .await
    .unwrap();
    assert!(
        !server.await.unwrap()[0]
            .to_ascii_lowercase()
            .contains(STREAM_HEADER)
    );

    for (status, body, expected) in [
        (
            "200 OK",
            r#"{"valid":false}"#,
            Error::Failed("registry rejected harness key"),
        ),
        (
            "200 OK",
            r#"{"valid":"true"}"#,
            Error::Failed("registry rejected harness key"),
        ),
        (
            "200 OK",
            r#"{}"#,
            Error::Failed("registry rejected harness key"),
        ),
        (
            "200 OK",
            "not json",
            Error::Failed("harness key validation returned unparseable JSON"),
        ),
        (
            "200 OK",
            "[true]",
            Error::Failed("harness key validation returned unparseable JSON"),
        ),
        (
            "403 Forbidden",
            r#"{"error":{"code":"registration_conflict"}}"#,
            Error::Http {
                status: 403,
                code: None,
            },
        ),
        (
            "500 Internal Server Error",
            "",
            Error::Http {
                status: 500,
                code: None,
            },
        ),
    ] {
        let (base, server) = serve(vec![http(status, body)]).await;
        let error = validate_at(
            &base,
            "env-1",
            &mut auth,
            None,
            "reg-1",
            public_key(),
            "a",
            stream,
        )
        .await
        .unwrap_err();
        assert_eq!(error, expected, "{status} {body}");
        server.await.unwrap();
    }
}

#[tokio::test]
async fn invalid_authorization_lengths_never_reach_the_registry() {
    let mut auth = credential("synthetic_access_marker");
    for authorization in [String::new(), "x".repeat(MAX_AUTHORIZATION_BYTES + 1)] {
        let error = validate_at(
            "http://127.0.0.1:1/api",
            "env-1",
            &mut auth,
            None,
            "reg-1",
            public_key(),
            &authorization,
            "s",
        )
        .await
        .unwrap_err();
        assert_eq!(
            error,
            Error::Failed("harness key authorization length is invalid")
        );
    }
    let (base, server) = serve(vec![http("200 OK", r#"{"valid":true}"#)]).await;
    validate_at(
        &base,
        "env-1",
        &mut auth,
        None,
        "reg-1",
        public_key(),
        &"x".repeat(MAX_AUTHORIZATION_BYTES),
        "s",
    )
    .await
    .unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn a_stalled_registry_is_a_timeout_failure() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (release, held) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buffer = [0; 4096];
        let _ = stream.read(&mut buffer).await.unwrap();
        let _ = held.await;
    });
    let mut auth = credential("synthetic_access_marker");
    let started = std::time::Instant::now();
    let error = register_at(
        &format!("http://{address}/api"),
        "env-1",
        &mut auth,
        None,
        public_key(),
    )
    .await
    .unwrap_err();
    assert_eq!(error, Error::Failed("timed out or was aborted"));
    assert!(started.elapsed() >= Duration::from_millis(DEADLINE_MS - 250));
    assert!(started.elapsed() < Duration::from_millis(DEADLINE_MS + 3000));
    drop(release);
    server.await.unwrap();
}
