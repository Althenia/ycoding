mod remote_derived_support;
mod support;
mod connector_support {
    pub const WAIT: std::time::Duration = super::support::WAIT;
}

use prost::{Message, Name};
use remote_derived_support::{Fixture, expired_peer, now};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicI64, Ordering},
};
use ycoding_core::{
    session::prompt_cache::sha256,
    ycoding_schema::{JsonValue, parse_json, stringify_json},
};
use ycoding_protocol::{OPERATIONS, v5};
use ycoding_runtime::{
    connector::{
        Credential, Enrolled, Peer,
        mcp::{self, Context, Request, Response},
    },
    standard,
};

const HTML_URI: &str = "ui://ycoding/artifact-demo/v1.html";
const HTML_SHA256: &str = "468f5068cf94b3dc035306ae0fa07b377d9c367d2653404265f260bb45f1dccc";
const PNG_SHA256: &str = "d3a97d031a3094c93d334c8e01e97c5a235ae1f44d5aab476d51311f16f0bce5";
const PNG_BASE64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGNIv77k/6fPX/8zgAgQBwB3aA11ihy37gAAAABJRU5ErkJggg==";
const TTL_MS: i64 = 15 * 60 * 1000;

fn context(fixture: &Fixture) -> Context {
    let peer = Peer::authenticate(
        &Enrolled::new("https://relay.invalid", "device-a".into()).unwrap(),
        &Credential::new(
            "resource-fixture".into(),
            now() + 3_600_000,
            "https://relay.invalid".into(),
            "device-a".into(),
        ),
        now(),
    )
    .unwrap();
    let lease =
        mcp::Lease::new(peer.clone(), "resource-connection".into(), "epoch-a".into()).unwrap();
    Context {
        environment: fixture.environment(false),
        dispatcher: Arc::new(standard().unwrap()),
        peer,
        connection_id: "resource-connection".into(),
        home: fixture.path.clone(),
        trusted_context: None,
        access: mcp::Access::new(
            Arc::new(mcp::Server::default()),
            lease,
            Arc::new(AtomicBool::new(false)),
        ),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expiry_starts_at_discovery_and_never_renews_across_rebinding() {
    let fixture = Fixture::new().await;
    let mut cx = context(&fixture);
    let clock = Arc::new(AtomicI64::new(1_000));
    let server = Arc::new(mcp::Server::new({
        let clock = clock.clone();
        Arc::new(move || clock.load(Ordering::Acquire))
    }));
    let lease =
        mcp::Lease::new(cx.peer.clone(), cx.connection_id.clone(), "epoch-a".into()).unwrap();
    cx.access = mcp::Access::new(
        server.clone(),
        lease.clone(),
        Arc::new(AtomicBool::new(false)),
    );
    result(request(&cx, "server/discover", "{}", None).await);
    clock.store(400_000, Ordering::Release);
    let exported = call(&cx, "artifact_demo_export", "{}").await;
    assert_eq!(
        at(&exported, &["structuredContent", "expiresAt"]),
        Some(&JsonValue::Number(901_000.0))
    );
    let uri = text(&array(&exported, &["content"])[0], &["uri"]).to_owned();
    clock.store(900_999, Ordering::Release);
    assert_eq!(call(&cx, "artifact_demo_export", "{}").await, exported);
    read(&cx, &uri).await;
    lease.revoke();
    let denied = request(
        &cx,
        "resources/read",
        &format!(r#"{{"uri":{}}}"#, quoted(&uri)),
        Some(&uri),
    )
    .await;
    assert_eq!(denied.status, 503);
    assert!(!denied.body.contains(PNG_BASE64));
    cx.access = mcp::Access::new(
        server.clone(),
        mcp::Lease::new(cx.peer.clone(), cx.connection_id.clone(), "epoch-b".into()).unwrap(),
        Arc::new(AtomicBool::new(false)),
    );
    assert_eq!(call(&cx, "artifact_demo_export", "{}").await, exported);
    clock.store(901_000, Ordering::Release);
    let failed = call(&cx, "artifact_demo_export", "{}").await;
    assert_eq!(at(&failed, &["isError"]), Some(&JsonValue::Bool(true)));
    let missing = request(
        &cx,
        "resources/read",
        &format!(r#"{{"uri":{}}}"#, quoted(&uri)),
        Some(&uri),
    )
    .await;
    assert_eq!(
        at(&parse_json(&missing.body).unwrap(), &["error", "code"]),
        Some(&JsonValue::Number(-32602.0))
    );
    let listed = result(request(&cx, "resources/list", "{}", None).await);
    assert_eq!(array(&listed, &["resources"]).len(), 1);
    read(&cx, HTML_URI).await;
    server.close();
    assert_eq!(
        request(
            &cx,
            "resources/read",
            &format!(r#"{{"uri":{}}}"#, quoted(HTML_URI)),
            Some(HTML_URI)
        )
        .await
        .status,
        503
    );
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_first_requests_share_the_same_original_resource() {
    let fixture = Fixture::new().await;
    let cx = context(&fixture);
    let (first, second) = tokio::join!(
        call(&cx, "artifact_demo_export", "{}"),
        call(&cx, "artifact_demo_export", "{}")
    );
    assert_eq!(first, second);
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_initialization_never_publishes_partial_or_poisoned_resource_state() {
    let fixture = Fixture::new().await;
    let mut cx = context(&fixture);
    let clock = Arc::new(AtomicI64::new(i64::MAX));
    let server = Arc::new(mcp::Server::new({
        let clock = clock.clone();
        Arc::new(move || clock.load(Ordering::Acquire))
    }));
    cx.access = mcp::Access::new(
        server,
        mcp::Lease::new(cx.peer.clone(), cx.connection_id.clone(), "epoch-a".into()).unwrap(),
        Arc::new(AtomicBool::new(false)),
    );
    let failed = request(&cx, "resources/list", "{}", None).await;
    assert_eq!(failed.status, 503);
    assert!(!failed.body.contains("artifact://"));
    clock.store(1_000, Ordering::Release);
    let exported = call(&cx, "artifact_demo_export", "{}").await;
    assert_eq!(
        at(&exported, &["structuredContent", "expiresAt"]),
        Some(&JsonValue::Number(901_000.0))
    );
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_and_revocation_after_dispatch_withhold_successful_export_bytes() {
    let fixture = Fixture::new().await;
    for revoke in [false, true] {
        let mut cx = context(&fixture);
        let cancelled = Arc::new(AtomicBool::new(false));
        let lease =
            mcp::Lease::new(cx.peer.clone(), cx.connection_id.clone(), "epoch-a".into()).unwrap();
        cx.access = mcp::Access::new(
            Arc::new(mcp::Server::default()),
            lease.clone(),
            cancelled.clone(),
        );
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let mut dispatcher = ycoding_runtime::Dispatcher::new(OPERATIONS.clone());
        dispatcher
            .handle("artifact.demo.export", {
                let entered = entered.clone();
                let release = release.clone();
                move |invocation: ycoding_runtime::Invocation, _: v5::ArtifactDemoExportRequest| {
                    let entered = entered.clone();
                    let release = release.clone();
                    async move {
                        let exported = invocation.mcp.as_ref().unwrap().export()?;
                        entered.notify_one();
                        release.acquire().await.unwrap().forget();
                        Ok(exported)
                    }
                }
            })
            .unwrap();
        cx.dispatcher = Arc::new(dispatcher);
        let (response, ()) = tokio::join!(
            request(
                &cx,
                "tools/call",
                r#"{"name":"artifact_demo_export","arguments":{}}"#,
                Some("artifact_demo_export")
            ),
            async {
                entered.notified().await;
                if revoke {
                    lease.revoke();
                } else {
                    cancelled.store(true, Ordering::Release);
                }
                release.add_permits(1);
            }
        );
        assert_eq!(response.status, 503);
        assert!(!response.body.contains("resource_link"));
        assert!(!response.body.contains(PNG_BASE64));
    }
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pre_cancelled_requests_disclose_nothing_and_safe_retry_keeps_identity() {
    let fixture = Fixture::new().await;
    let mut cx = context(&fixture);
    let clock = Arc::new(AtomicI64::new(1_000));
    let server = Arc::new(mcp::Server::new({
        let clock = clock.clone();
        Arc::new(move || clock.load(Ordering::Acquire))
    }));
    let lease =
        mcp::Lease::new(cx.peer.clone(), cx.connection_id.clone(), "epoch-a".into()).unwrap();
    let cancelled = Arc::new(AtomicBool::new(true));
    cx.access = mcp::Access::new(server.clone(), lease.clone(), cancelled.clone());
    assert_eq!(request(&cx, "resources/list", "{}", None).await.status, 503);
    clock.store(2_000, Ordering::Release);
    cancelled.store(false, Ordering::Release);
    let exported = call(&cx, "artifact_demo_export", "{}").await;
    assert_eq!(
        at(&exported, &["structuredContent", "expiresAt"]),
        Some(&JsonValue::Number(902_000.0))
    );
    cancelled.store(true, Ordering::Release);
    assert_eq!(request(&cx, "resources/list", "{}", None).await.status, 503);
    cx.access = mcp::Access::new(server, lease, Arc::new(AtomicBool::new(false)));
    assert_eq!(call(&cx, "artifact_demo_export", "{}").await, exported);
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordinary_remote_frames_cannot_mint_demo_access() {
    let fixture = Fixture::new().await;
    let cx = context(&fixture);
    for name in ["artifact.demo.preview", "artifact.demo.export"] {
        let descriptor = OPERATIONS
            .iter()
            .find(|item| item.diagnostic_name == name)
            .unwrap();
        let settled = cx
            .dispatcher
            .invoke_remote(
                cx.environment.clone(),
                cx.connection_id.clone(),
                &cx.peer,
                v5::Request {
                    request_id: "ordinary-demo".into(),
                    operation_id: descriptor.operation_id,
                    scope: v5::Scope {
                        target: Some(v5::scope::Target::Machine(v5::Empty {})),
                    },
                    payload: vec![],
                },
            )
            .await
            .unwrap();
        let ycoding_runtime::Settled::Result(result) = settled else {
            panic!("inline declared error expected")
        };
        let Some(v5::result::Outcome::Error(error)) = result.outcome else {
            panic!("ordinary frame disclosed demo")
        };
        assert_eq!(error.type_name, v5::ConnectorError::full_name());
        assert_eq!(
            v5::ConnectorError::decode(error.payload.as_slice())
                .unwrap()
                .code,
            3
        );
    }
    fixture.close().await;
}

fn quoted(value: &str) -> String {
    stringify_json(&JsonValue::String(value.into()))
}

async fn request(cx: &Context, method: &str, params: &str, name: Option<&str>) -> Response {
    let mut headers = vec![
        ("content-type".into(), "application/json".into()),
        (
            "accept".into(),
            "application/json, text/event-stream".into(),
        ),
        ("mcp-protocol-version".into(), mcp::VERSION.into()),
        ("mcp-method".into(), method.into()),
    ];
    if let Some(name) = name {
        headers.push(("mcp-name".into(), name.into()));
    }
    let JsonValue::Object(mut params) = parse_json(params).unwrap() else {
        panic!("object params required");
    };
    params.insert(
        "_meta".into(),
        parse_json(&format!(
            r#"{{"io.modelcontextprotocol/protocolVersion":{},"io.modelcontextprotocol/clientInfo":{{"name":"resource-fixture","version":"1"}},"io.modelcontextprotocol/clientCapabilities":{{}}}}"#,
            quoted(mcp::VERSION)
        ))
        .unwrap(),
    );
    mcp::handle(
        cx,
        Request {
            body: format!(
                r#"{{"jsonrpc":"2.0","id":7,"method":{},"params":{}}}"#,
                quoted(method),
                stringify_json(&JsonValue::Object(params))
            )
            .as_str()
            .into(),
            headers,
        },
    )
    .await
}

fn at<'a>(value: &'a JsonValue, path: &[&str]) -> Option<&'a JsonValue> {
    path.iter().try_fold(value, |value, key| match value {
        JsonValue::Object(object) => object.get(&(*key).into()),
        _ => None,
    })
}

fn text<'a>(value: &'a JsonValue, path: &[&str]) -> &'a str {
    let Some(JsonValue::String(value)) = at(value, path) else {
        panic!("missing text at {path:?}: {value:?}");
    };
    value.as_str().unwrap()
}

fn array<'a>(value: &'a JsonValue, path: &[&str]) -> &'a [JsonValue] {
    let Some(JsonValue::Array(items)) = at(value, path) else {
        panic!("missing array at {path:?}: {value:?}");
    };
    items
}

fn result(response: Response) -> JsonValue {
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.content_type, "application/json");
    assert!(!response.unknown);
    let value = parse_json(&response.body).unwrap();
    assert!(at(&value, &["error"]).is_none(), "{}", response.body);
    at(&value, &["result"]).unwrap().clone()
}

async fn call(cx: &Context, tool: &str, arguments: &str) -> JsonValue {
    result(
        request(
            cx,
            "tools/call",
            &format!(r#"{{"name":{},"arguments":{arguments}}}"#, quoted(tool)),
            Some(tool),
        )
        .await,
    )
}

async fn read(cx: &Context, uri: &str) -> JsonValue {
    let value = result(
        request(
            cx,
            "resources/read",
            &format!(r#"{{"uri":{}}}"#, quoted(uri)),
            Some(uri),
        )
        .await,
    );
    assert_cacheable_envelope(&value);
    value
}

fn assert_cacheable_envelope(value: &JsonValue) {
    assert_eq!(at(value, &["ttlMs"]), Some(&JsonValue::Number(0.0)));
    assert_eq!(text(value, &["cacheScope"]), "private");
    assert_eq!(text(value, &["resultType"]), "complete");
    assert_eq!(
        text(
            value,
            &["_meta", "io.modelcontextprotocol/serverInfo", "name"]
        ),
        "ycoding-remote"
    );
    assert_eq!(
        text(
            value,
            &["_meta", "io.modelcontextprotocol/serverInfo", "version"]
        ),
        "1.0.0"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resources_and_demo_tools_share_the_existing_server_without_a_session() {
    let fixture = Fixture::new().await;
    let cx = context(&fixture);
    let discovery = result(request(&cx, "server/discover", "{}", None).await);
    assert!(at(&discovery, &["capabilities", "tools"]).is_some());
    assert!(at(&discovery, &["capabilities", "resources"]).is_some());
    let catalog = result(request(&cx, "tools/list", "{}", None).await);
    let tools = array(&catalog, &["tools"]);
    for name in ["artifact_demo_preview", "artifact_demo_export"] {
        let tool = tools
            .iter()
            .find(|tool| text(tool, &["name"]) == name)
            .unwrap();
        assert_eq!(text(tool, &["inputSchema", "type"]), "object");
        assert_eq!(
            at(tool, &["inputSchema", "additionalProperties"]),
            Some(&JsonValue::Bool(false))
        );
        assert!(at(tool, &["outputSchema"]).is_some());
        assert_eq!(
            at(tool, &["annotations", "readOnlyHint"]),
            Some(&JsonValue::Bool(true))
        );
        if name == "artifact_demo_preview" {
            assert_eq!(text(tool, &["_meta", "ui", "resourceUri"]), HTML_URI);
        } else {
            assert!(at(tool, &["_meta"]).is_none());
        }
    }
    let preview = call(&cx, "artifact_demo_preview", "{}").await;
    assert_eq!(
        at(&preview, &["structuredContent", "variants"]),
        Some(&parse_json(r#"["list","cards"]"#).unwrap())
    );
    assert_eq!(
        text(&preview, &["structuredContent", "hostVerification"]),
        "required"
    );
    let listed = result(request(&cx, "resources/list", "{}", None).await);
    assert_cacheable_envelope(&listed);
    let resources = array(&listed, &["resources"]);
    assert_eq!(resources.len(), 2);
    assert_eq!(text(&resources[0], &["uri"]), HTML_URI);
    assert_eq!(
        text(&resources[0], &["mimeType"]),
        "text/html;profile=mcp-app"
    );
    let exported = call(&cx, "artifact_demo_export", "{}").await;
    assert_eq!(
        text(&resources[1], &["uri"]),
        text(&array(&exported, &["content"])[0], &["uri"])
    );
    let templates = result(request(&cx, "resources/templates/list", "{}", None).await);
    assert_cacheable_envelope(&templates);
    assert!(array(&templates, &["resourceTemplates"]).is_empty());
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn html_is_the_exact_authored_document_with_closed_ui_policy() {
    let fixture = Fixture::new().await;
    let cx = context(&fixture);
    let resource = read(&cx, HTML_URI).await;
    let contents = array(&resource, &["contents"]);
    assert_eq!(contents.len(), 1);
    assert_eq!(text(&contents[0], &["uri"]), HTML_URI);
    assert_eq!(
        text(&contents[0], &["mimeType"]),
        "text/html;profile=mcp-app"
    );
    let html = text(&contents[0], &["text"]);
    assert_eq!(html.len(), 24_699);
    assert_eq!(sha256(html), HTML_SHA256);
    assert_eq!(
        at(&contents[0], &["_meta"]),
        Some(&parse_json(r#"{"ui":{"prefersBorder":true,"csp":{"connectDomains":[],"resourceDomains":[],"frameDomains":[]}}}"#).unwrap())
    );
    assert!(at(&contents[0], &["blob"]).is_none());
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn png_export_is_an_original_byte_resource_link_with_stable_identity_and_expiry() {
    let fixture = Fixture::new().await;
    let cx = context(&fixture);
    let started = now();
    result(request(&cx, "server/discover", "{}", None).await);
    let initialized = now();
    let exported = call(&cx, "artifact_demo_export", "{}").await;
    let links = array(&exported, &["content"]);
    assert_eq!(links.len(), 1);
    let link = &links[0];
    assert_eq!(text(link, &["type"]), "resource_link");
    assert_eq!(text(link, &["name"]), "ycoding-demo.png");
    assert_eq!(text(link, &["mimeType"]), "image/png");
    assert_eq!(at(link, &["size"]), Some(&JsonValue::Number(79.0)));
    let metadata = at(&exported, &["structuredContent"]).unwrap();
    assert_eq!(text(metadata, &["filename"]), "ycoding-demo.png");
    assert_eq!(text(metadata, &["mime"]), "image/png");
    assert_eq!(text(metadata, &["sha256"]), PNG_SHA256);
    assert_eq!(
        text(metadata, &["delivery"]),
        "host-native-attachment-required"
    );
    assert_eq!(at(metadata, &["size"]), Some(&JsonValue::Number(79.0)));
    let id = text(metadata, &["id"]);
    assert!(id.starts_with("art_"));
    assert_eq!(
        text(link, &["uri"]),
        format!("artifact://ycoding-demo/{id}")
    );
    let Some(JsonValue::Number(expiry)) = at(metadata, &["expiresAt"]) else {
        panic!("missing numeric expiry");
    };
    assert!(*expiry >= (started + TTL_MS) as f64);
    assert!(*expiry <= (initialized + TTL_MS) as f64);
    assert!(!stringify_json(&exported).contains(PNG_BASE64));
    let resource = read(&cx, text(link, &["uri"])).await;
    let contents = array(&resource, &["contents"]);
    assert_eq!(contents.len(), 1);
    assert_eq!(text(&contents[0], &["uri"]), text(link, &["uri"]));
    assert_eq!(text(&contents[0], &["mimeType"]), "image/png");
    assert_eq!(text(&contents[0], &["blob"]), PNG_BASE64);
    assert!(at(&contents[0], &["text"]).is_none());
    assert_eq!(read(&cx, text(link, &["uri"])).await, resource);
    assert_eq!(call(&cx, "artifact_demo_export", "{}").await, exported);
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn demo_tools_reject_every_path_session_and_generated_html_argument() {
    let fixture = Fixture::new().await;
    let cx = context(&fixture);
    for tool in ["artifact_demo_preview", "artifact_demo_export"] {
        for arguments in [
            r#"{"path":"/synthetic/private.txt"}"#,
            r#"{"sessionID":"ses_resource_other"}"#,
            r#"{"input":{"uri":"file:///synthetic/private.txt"}}"#,
            r#"{"html":"<script>fetch('/synthetic')</script>"}"#,
            r#"{"directory":"/synthetic"}"#,
            r#"{"unexpected":true}"#,
        ] {
            let failed = call(&cx, tool, arguments).await;
            assert_eq!(at(&failed, &["isError"]), Some(&JsonValue::Bool(true)));
            assert!(!stringify_json(&failed).contains(PNG_BASE64));
            assert!(
                !array(&failed, &["content"])
                    .iter()
                    .any(|part| text(part, &["type"]) == "resource_link")
            );
        }
    }
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_and_path_selected_resources_return_the_missing_resource_error() {
    let fixture = Fixture::new().await;
    let cx = context(&fixture);
    for uri in [
        "file:///synthetic/private.txt",
        "ui://ycoding/artifact-demo/../../secret",
        "artifact://ycoding-demo/unknown",
        "https://example.invalid/resource",
    ] {
        let response = request(
            &cx,
            "resources/read",
            &format!(r#"{{"uri":{}}}"#, quoted(uri)),
            Some(uri),
        )
        .await;
        let body = parse_json(&response.body).unwrap();
        assert_eq!(
            at(&body, &["error", "code"]),
            Some(&JsonValue::Number(-32602.0))
        );
        assert_eq!(text(&body, &["error", "data", "uri"]), uri);
        assert!(at(&body, &["result"]).is_none());
        assert!(!response.body.contains(PNG_BASE64));
    }
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_expired_authenticated_peer_cannot_discover_or_read_fixed_resource_bytes() {
    let fixture = Fixture::new().await;
    let mut cx = context(&fixture);
    let exported = call(&cx, "artifact_demo_export", "{}").await;
    let uri = text(&array(&exported, &["content"])[0], &["uri"]).to_owned();
    cx.peer = expired_peer();
    for (method, params, name) in [
        ("resources/list", "{}".to_owned(), None),
        ("resources/templates/list", "{}".to_owned(), None),
        (
            "resources/read",
            format!(r#"{{"uri":{}}}"#, quoted(HTML_URI)),
            Some(HTML_URI),
        ),
        (
            "resources/read",
            format!(r#"{{"uri":{}}}"#, quoted(&uri)),
            Some(uri.as_str()),
        ),
        (
            "tools/call",
            r#"{"name":"artifact_demo_export","arguments":{}}"#.to_owned(),
            Some("artifact_demo_export"),
        ),
    ] {
        let response = request(&cx, method, &params, name).await;
        let body = parse_json(&response.body).unwrap();
        assert!(
            at(&body, &["error"]).is_some()
                || at(&body, &["result", "isError"]) == Some(&JsonValue::Bool(true)),
            "{}",
            response.body
        );
        assert!(at(&body, &["result", "contents"]).is_none());
        assert!(at(&body, &["result", "resources"]).is_none());
        assert!(!response.body.contains(PNG_BASE64));
        assert!(!response.body.contains("ui/initialize"));
        assert!(!response.body.contains("resource_link"));
    }
    fixture.close().await;
}
