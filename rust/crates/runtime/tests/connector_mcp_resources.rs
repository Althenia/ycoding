mod remote_derived_support;
mod support;
mod connector_support {
    pub const WAIT: std::time::Duration = super::support::WAIT;
}

use remote_derived_support::{Fixture, expired_peer, now};
use std::sync::{Arc, atomic::AtomicBool};
use ycoding_core::ycoding_schema::{JsonValue, parse_json, stringify_json};
use ycoding_runtime::{
    connector::{
        Credential, Enrolled, Peer,
        mcp::{self, Context, Request, Response},
    },
    standard,
};

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

async fn read(cx: &Context, uri: &str) -> Response {
    request(
        cx,
        "resources/read",
        &format!(r#"{{"uri":{}}}"#, quoted(uri)),
        Some(uri),
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_resource_server_publishes_no_resources_and_every_read_is_missing() {
    let fixture = Fixture::new().await;
    let cx = context(&fixture);
    let listed = result(request(&cx, "resources/list", "{}", None).await);
    assert!(array(&listed, &["resources"]).is_empty());
    for uri in [
        "ui://ycoding/artifact-demo/v1.html",
        "ui://ycoding/local-http-app/v1.html",
        "artifact://ycoding-demo/unknown",
        "file:///synthetic/private.txt",
        "https://example.invalid/resource",
    ] {
        let body = parse_json(&read(&cx, uri).await.body).unwrap();
        assert_eq!(
            at(&body, &["error", "code"]),
            Some(&JsonValue::Number(-32602.0)),
            "{uri}"
        );
        assert_eq!(text(&body, &["error", "data", "uri"]), uri);
        assert!(at(&body, &["result"]).is_none());
    }
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_tool_listing_carries_no_ui_resource_or_demo_tool() {
    let fixture = Fixture::new().await;
    let cx = context(&fixture);
    let listed = result(request(&cx, "tools/list", "{}", None).await);
    let tools = array(&listed, &["tools"]);
    assert!(!tools.is_empty());
    for tool in tools {
        let name = text(tool, &["name"]);
        assert!(!name.starts_with("local_app_") && !name.starts_with("artifact_demo_"));
        assert!(at(tool, &["_meta", "ui"]).is_none(), "{name}");
    }
    let unknown = request(
        &cx,
        "tools/call",
        r#"{"name":"artifact_demo_export","arguments":{}}"#,
        Some("artifact_demo_export"),
    )
    .await;
    let body = parse_json(&unknown.body).unwrap();
    assert_eq!(
        at(&body, &["error", "code"]),
        Some(&JsonValue::Number(-32602.0))
    );
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_expired_authenticated_peer_cannot_discover_or_read_resources() {
    let fixture = Fixture::new().await;
    let mut cx = context(&fixture);
    cx.peer = expired_peer();
    for (method, params, name) in [
        ("resources/list", "{}".to_owned(), None),
        ("resources/templates/list", "{}".to_owned(), None),
        (
            "resources/read",
            format!(r#"{{"uri":{}}}"#, quoted("file:///synthetic/private.txt")),
            Some("file:///synthetic/private.txt"),
        ),
    ] {
        let response = request(&cx, method, &params, name).await;
        let body = parse_json(&response.body).unwrap();
        assert!(at(&body, &["error"]).is_some(), "{}", response.body);
        assert!(at(&body, &["result", "contents"]).is_none());
        assert!(at(&body, &["result", "resources"]).is_none());
    }
    fixture.close().await;
}
