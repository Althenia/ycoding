mod code_mode_regexp_fixture;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use ycoding_core::tools::code_mode::{
    Cancellation, ExecutionLimits, Runtime, ToolFailure, ToolHost, openapi,
};
use ycoding_schema::{JsonObject, JsonValue, parse_json};

#[tokio::test]
async fn openapi_generated_tools_serialize_real_http_and_decode_vendor_json() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let observed = requests.clone();
    let server = tokio::spawn(async move {
        let (mut connection, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let size = connection.read(&mut chunk).await.unwrap();
            assert_ne!(size, 0);
            bytes.extend_from_slice(&chunk[..size]);
            if bytes.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                break;
            }
        }
        observed
            .lock()
            .unwrap()
            .push(String::from_utf8(bytes).unwrap());
        connection.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/vnd.example+json\r\nContent-Length: 10\r\nConnection: close\r\n\r\n{\"id\":\"a\"}").await.unwrap();
    });
    let document = parse_json(r##"{"openapi":"3.1.0","paths":{"/users/{id}":{"get":{"operationId":"users.get","parameters":[{"name":"id","in":"path","schema":{"type":"string"}},{"name":"include","in":"query","explode":false,"schema":{"type":"array","items":{"type":"string"}}},{"name":"X-Trace","in":"header","schema":{"type":"string"}}],"responses":{"200":{"content":{"application/json":{"schema":{"type":"object","properties":{"id":{"type":"string"}}}}}}}}}}}"##).unwrap();
    let generated = openapi::Host::from_spec(
        &document,
        openapi::Options {
            base_url: Some(format!("http://{address}")),
            namespace: Some("api".into()),
            headers: JsonObject::new(),
            auth: None,
            client: reqwest::Client::new(),
        },
    );
    assert!(generated.skipped.is_empty(), "{:?}", generated.skipped);
    assert_eq!(generated.host.catalog().len(), 1);
    let runtime = Runtime::new(
        Arc::new(generated.host),
        ExecutionLimits {
            timeout_ms: Some(1_000),
            ..ExecutionLimits::default()
        },
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        code_mode_regexp_fixture::collation(),
    )
    .unwrap();
    assert_eq!(runtime.execute("return await tools.api.users.get({id:'a/b',include:['roles','teams'],'X-Trace':'trace'})", Cancellation::default()).await.value, Ok(parse_json("{\"id\":\"a\"}").unwrap()));
    server.await.unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(
        requests[0].starts_with("GET /users/a%2Fb?include=roles%2Cteams HTTP/1.1\r\n"),
        "{}",
        requests[0]
    );
    assert!(requests[0].to_lowercase().contains("x-trace: trace\r\n"));
}

#[test]
fn openapi_skips_unsupported_transports_and_malformed_security_without_guessing() {
    let document = parse_json(r#"{"openapi":"3.1.0","paths":{"/cookie":{"get":{"operationId":"cookie","parameters":[{"name":"session","in":"cookie","schema":{"type":"string"}}]}},"/security":{"get":{"operationId":"secure","security":null}},"/sse":{"get":{"responses":{"200":{"content":{"text/event-stream":{}}}}}},"/binary":{"get":{"responses":{"200":{"content":{"application/octet-stream":{}}}}}}}}"#).unwrap();
    let generated = openapi::Host::from_spec(
        &document,
        openapi::Options {
            base_url: Some("https://example.test".into()),
            namespace: None,
            headers: JsonObject::new(),
            auth: None,
            client: reqwest::Client::new(),
        },
    );
    assert!(generated.host.catalog().is_empty());
    assert_eq!(
        generated
            .skipped
            .iter()
            .map(|item| item.reason.as_str())
            .collect::<Vec<_>>(),
        [
            "cookie parameter 'session' is not supported",
            "security declaration is not an array",
            "SSE operations are not supported",
            "binary responses are not supported"
        ]
    );
}

const LIMIT: usize = 50 * 1024 * 1024;

async fn serve(response: Vec<u8>) -> (String, tokio::task::JoinHandle<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut connection, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let size = connection.read(&mut chunk).await.unwrap();
            assert_ne!(size, 0);
            bytes.extend_from_slice(&chunk[..size]);
            let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
                continue;
            };
            let head = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
            let length = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .map_or(0, |value| value.trim().parse::<usize>().unwrap());
            if bytes.len() >= end + 4 + length {
                break;
            }
        }
        let _ = connection.write_all(&response).await;
        let _ = connection.shutdown().await;
        String::from_utf8(bytes).unwrap()
    });
    (format!("http://{address}"), server)
}

fn reply(status: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

fn runtime(
    document: &str,
    base_url: String,
    auth: Option<Arc<dyn openapi::AuthResolver>>,
) -> Runtime {
    let generated = openapi::Host::from_spec(
        &parse_json(document).unwrap(),
        openapi::Options {
            base_url: Some(base_url),
            namespace: Some("api".into()),
            headers: JsonObject::new(),
            auth,
            client: reqwest::Client::new(),
        },
    );
    assert!(generated.skipped.is_empty(), "{:?}", generated.skipped);
    Runtime::new(
        Arc::new(generated.host),
        ExecutionLimits {
            timeout_ms: Some(20_000),
            ..ExecutionLimits::default()
        },
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        code_mode_regexp_fixture::collation(),
    )
    .unwrap()
}

async fn message(runtime: &Runtime, call: &str) -> String {
    let source = format!("try {{ return await {call} }} catch (error) {{ return error.message }}");
    match runtime.execute(source, Cancellation::default()).await.value {
        Ok(JsonValue::String(value)) => value.to_utf8().unwrap(),
        other => panic!("Expected a message: {other:?}"),
    }
}

const GET: &str = r#"{"openapi":"3.1.0","paths":{"/test":{"get":{"operationId":"test","responses":{"200":{"description":"ok"}}}}}}"#;

#[tokio::test]
async fn http_error_statuses_map_to_bounded_tool_failures() {
    let (base, server) = serve(reply(
        "404 Not Found",
        "application/json",
        br#"{"error":"nope"}"#,
    ))
    .await;
    assert_eq!(
        message(&runtime(GET, base, None), "tools.api.test({})").await,
        r#"GET /test failed with HTTP 404: {"error":"nope"}"#
    );
    server.await.unwrap();
    let (base, server) = serve(reply("500 Internal Server Error", "text/plain", b"")).await;
    assert_eq!(
        message(&runtime(GET, base, None), "tools.api.test({})").await,
        "GET /test failed with HTTP 500: no response body"
    );
    server.await.unwrap();
    let (base, server) = serve(reply(
        "502 Bad Gateway",
        "text/plain",
        "x".repeat(2000).as_bytes(),
    ))
    .await;
    let failure = message(&runtime(GET, base, None), "tools.api.test({})").await;
    assert_eq!(
        failure,
        format!("GET /test failed with HTTP 502: {}...", "x".repeat(1024))
    );
    server.await.unwrap();
}

#[tokio::test]
async fn responses_over_fifty_mebibytes_are_rejected_declared_or_streamed() {
    let mut declared = reply("200 OK", "application/json", b"");
    declared.splice(
        declared
            .windows(16)
            .position(|window| window == b"Content-Length: ")
            .unwrap()..declared.len() - 4,
        format!("Content-Length: {}\r\nConnection: close", LIMIT + 1).into_bytes(),
    );
    let (base, server) = serve(declared).await;
    assert_eq!(
        message(&runtime(GET, base, None), "tools.api.test({})").await,
        "GET /test response exceeds 50 MiB."
    );
    server.await.unwrap();
    let mut streamed =
        b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n"
            .to_vec();
    streamed.resize(streamed.len() + LIMIT + 1, 0);
    let (base, server) = serve(streamed).await;
    assert_eq!(
        message(&runtime(GET, base, None), "tools.api.test({})").await,
        "GET /test response exceeds 50 MiB."
    );
    server.await.unwrap();
}

#[tokio::test]
async fn malformed_json_and_raw_text_responses_are_distinguished_by_media_type() {
    let (base, server) = serve(reply("200 OK", "application/json", b"{")).await;
    assert_eq!(
        message(&runtime(GET, base, None), "tools.api.test({})").await,
        "GET /test returned malformed JSON."
    );
    server.await.unwrap();
    let (base, server) = serve(reply("200 OK", "text/plain", b"123")).await;
    assert_eq!(
        message(&runtime(GET, base, None), "tools.api.test({})").await,
        "123"
    );
    server.await.unwrap();
}

#[tokio::test]
async fn json_media_types_are_preserved_and_the_body_is_serialized() {
    let document = r#"{"openapi":"3.1.0","paths":{"/test":{"post":{"operationId":"test","requestBody":{"required":true,"content":{"application/merge-patch+json":{"schema":{"type":"object","properties":{"name":{"type":"string"}}}}}},"responses":{"200":{"description":"ok"}}}}}}"#;
    let (base, server) = serve(reply("200 OK", "application/json", br#"{"ok":true}"#)).await;
    let runtime = runtime(document, base, None);
    assert_eq!(
        runtime
            .execute(
                "return await tools.api.test({ body: { name: 'updated' } })",
                Cancellation::default()
            )
            .await
            .value,
        Ok(parse_json(r#"{"ok":true}"#).unwrap())
    );
    let request = server.await.unwrap();
    assert!(request.starts_with("POST /test HTTP/1.1\r\n"), "{request}");
    assert!(
        request
            .to_lowercase()
            .contains("content-type: application/merge-patch+json\r\n")
    );
    assert!(request.ends_with(r#"{"name":"updated"}"#), "{request}");
}

struct Bearer(Mutex<Vec<(String, Vec<String>, String)>>);

impl openapi::AuthResolver for Bearer {
    fn resolve(&self, context: openapi::AuthContext) -> openapi::AuthFuture<'_> {
        Box::pin(async move {
            self.0.lock().unwrap().push((
                context.name,
                context.scopes,
                format!("{} {}", context.operation.method, context.operation.path),
            ));
            Ok(Some(openapi::Credential::Bearer("secret".into())))
        })
    }
}

const SECURED: &str = r#"{"openapi":"3.1.0","security":[{"bearer":[]}],"components":{"securitySchemes":{"bearer":{"type":"http","scheme":"bearer"}}},"paths":{"/test":{"get":{"operationId":"test","responses":{"200":{"description":"ok"}}}}}}"#;

#[tokio::test]
async fn bearer_credentials_are_resolved_per_operation_and_sent_as_a_header() {
    let (base, server) = serve(reply("200 OK", "application/json", br#"{"ok":true}"#)).await;
    let resolver = Arc::new(Bearer(Mutex::default()));
    let runtime = runtime(SECURED, base, Some(resolver.clone()));
    assert_eq!(
        runtime
            .execute("return await tools.api.test({})", Cancellation::default())
            .await
            .value,
        Ok(parse_json(r#"{"ok":true}"#).unwrap())
    );
    assert!(
        server
            .await
            .unwrap()
            .to_lowercase()
            .contains("authorization: bearer secret\r\n")
    );
    assert_eq!(
        *resolver.0.lock().unwrap(),
        [(
            "bearer".to_owned(),
            Vec::<String>::new(),
            "GET /test".to_owned()
        )]
    );
    assert!(runtime.catalog()[0].signature.contains("input: {}"));
}

struct Unavailable;

impl openapi::AuthResolver for Unavailable {
    fn resolve(&self, _: openapi::AuthContext) -> openapi::AuthFuture<'_> {
        Box::pin(async { Ok(None) })
    }
}

struct Refusing;

impl openapi::AuthResolver for Refusing {
    fn resolve(&self, _: openapi::AuthContext) -> openapi::AuthFuture<'_> {
        Box::pin(async { Err(ToolFailure::Safe("Vault locked".into())) })
    }
}

#[tokio::test]
async fn missing_credentials_and_resolver_failures_fail_before_any_network_request() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    for (auth, expected) in [
        (
            None,
            "GET /test requires authentication; no credential available for: bearer.",
        ),
        (
            Some(Arc::new(Unavailable) as Arc<dyn openapi::AuthResolver>),
            "GET /test requires authentication; no credential available for: bearer.",
        ),
        (
            Some(Arc::new(Refusing) as Arc<dyn openapi::AuthResolver>),
            "Vault locked",
        ),
    ] {
        assert_eq!(
            message(&runtime(SECURED, base.clone(), auth), "tools.api.test({})").await,
            expected
        );
    }
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), listener.accept())
            .await
            .is_err(),
        "authentication failures must not reach the network"
    );
}
