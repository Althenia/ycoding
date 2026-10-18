mod remote_derived_support;
mod support;
mod connector_support {
    pub const WAIT: std::time::Duration = super::support::WAIT;
}

use axum::{
    Router,
    body::Bytes,
    http::{HeaderMap, StatusCode, header::CONTENT_TYPE},
    response::IntoResponse,
};
use remote_derived_support::{Fixture, now};
use std::{path::PathBuf, process::Stdio, sync::Arc};
use ycoding_core::ycoding_schema::{JsonValue, LosslessString, parse_json, stringify_json};
use ycoding_runtime::{
    connector::{
        Credential, Enrolled, Peer,
        mcp::{self, Context, Request},
    },
    standard,
};

const FORWARDED: &[&str] = &[
    "content-type",
    "accept",
    "mcp-protocol-version",
    "mcp-method",
    "mcp-name",
];

const SCRIPT: &str = r#"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { createMcpHandler, ProtocolError, ProtocolErrorCode, Server } from "@modelcontextprotocol/server"

const rust = process.env.MCP_RUST_URL
const version = "2026-07-28"
const meta = {
  "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientInfo": { name: "fixture", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
}
const standard = (method, name) => ({
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": version,
  "mcp-method": method,
  ...(name === undefined ? {} : { "mcp-name": name }),
})
const post = async (url, body, headers) => {
  const response = await fetch(url, { method: "POST", headers, body })
  return { status: response.status, contentType: response.headers.get("content-type"), body: await response.text() }
}
const listing = JSON.parse((await post(rust, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } }), standard("tools/list"))).body)
const tools = listing.result.tools
const handler = createMcpHandler(
  () => {
    const server = new Server({ name: "ycoding-remote", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } })
    server.setRequestHandler("tools/list", async () => ({ tools: [...tools] }))
    server.setRequestHandler("resources/list", async () => ({resources: []}))
    server.setRequestHandler("resources/templates/list", async () => ({resourceTemplates: []}))
    server.setRequestHandler("tools/call", async (request) => {
      if (!tools.some((tool) => tool.name === request.params.name))
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`)
      return { content: [{ type: "text", text: "{}" }], structuredContent: {} }
    })
    return server
  },
  { legacy: "reject", responseMode: "json", maxRequestBodySize: 128 * 1024 },
)
const reference = async (body, headers) => {
  const response = await handler.fetch(new Request("http://reference.invalid/mcp", { method: "POST", headers, body }), {
    authInfo: { token: "relay", clientId: "relay", scopes: [], extra: {} },
  })
  return { status: response.status, contentType: response.headers.get("content-type"), body: await response.text() }
}
const request = (method, params, id = 1) => JSON.stringify({ jsonrpc: "2.0", id, method, params })
const without = (headers, name) => Object.fromEntries(Object.entries(headers).filter(([key]) => key !== name))
const cases = [
  ["discover", request("server/discover", { _meta: meta }), standard("server/discover")],
  ["tools-list", request("tools/list", { _meta: meta }), standard("tools/list")],
  ["initialize", request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } }), { "content-type": "application/json", accept: "application/json, text/event-stream" }],
  ["legacy-ping", request("ping", {}), { "content-type": "application/json", accept: "application/json, text/event-stream" }],
  ["modern-ping", request("ping", { _meta: meta }), standard("ping")],
  ["missing-version-header", request("server/discover", { _meta: meta }), without(standard("server/discover"), "mcp-protocol-version")],
  ["missing-method-header", request("server/discover", { _meta: meta }), without(standard("server/discover"), "mcp-method")],
  ["method-header-mismatch", request("server/discover", { _meta: meta }), standard("tools/list")],
  ["missing-name-header", request("tools/call", { name: "session_status", arguments: {}, _meta: meta }), standard("tools/call")],
  ["name-header-mismatch", request("tools/call", { name: "session_status", arguments: {}, _meta: meta }), standard("tools/call", "session_get")],
  ["header-body-version-mismatch", request("server/discover", { _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "2026-07-28" } }), { ...standard("server/discover"), "mcp-protocol-version": "2099-01-01" }],
  ["unsupported-version", request("server/discover", { _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "2099-01-01" } }), { ...standard("server/discover"), "mcp-protocol-version": "2099-01-01" }],
  ["envelope-missing-client", request("server/discover", { _meta: { "io.modelcontextprotocol/protocolVersion": version, "io.modelcontextprotocol/clientCapabilities": {} } }), standard("server/discover")],
  ["text-content-type", request("server/discover", { _meta: meta }), { ...standard("server/discover"), "content-type": "text/plain" }],
  ["invalid-json", "{", standard("server/discover")],
  ["batch", JSON.stringify([JSON.parse(request("server/discover", { _meta: meta }))]), standard("server/discover")],
  ["posted-response", JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), standard("server/discover")],
  ["notification", JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, _meta: meta } }), standard("notifications/cancelled")],
  ["unknown-tool", request("tools/call", { name: "incident_guidance_clear", arguments: {}, _meta: meta }), standard("tools/call", "incident_guidance_clear")],
  ["call", request("tools/call", { name: "session_status", arguments: {}, _meta: meta }, "call-1"), standard("tools/call", "session_status")],
  ["oversized", request("server/discover", { _meta: meta, padding: "x".repeat(128 * 1024) }), standard("server/discover")],
]
const differential = []
for (const [name, body, headers] of cases)
  differential.push({ name, rust: await post(rust, body, headers), reference: await reference(body, headers) })
const client = new Client({ name: "fixture", version: "1" }, { versionNegotiation: { mode: { pin: version } } })
await client.connect(new StreamableHTTPClientTransport(new URL(rust)))
const listed = await client.listTools()
const called = await client.callTool({ name: "session_get", arguments: { sessionID: process.env.MCP_SESSION } })
const resources = await client.listResources()
const templates = await client.listResourceTemplates()
const exported = await client.callTool({name: "artifact_demo_export", arguments: {}})
const link = exported.content[0]
if (link.type !== "resource_link") throw new Error("Expected typed resource link")
const png = await client.readResource({uri: link.uri})
const html = await client.readResource({uri: "ui://ycoding/artifact-demo/v1.html"})
await client.close()
console.log(JSON.stringify({
  differential,
  client: { tools: listed.tools.map((tool) => tool.name).sort(), called: called.structuredContent, isError: called.isError ?? false, resources, templates, exported, png, html },
}))
"#;

async fn serve(context: Arc<Context>, headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    let Ok(body) = std::str::from_utf8(&body) else {
        return (
            StatusCode::BAD_REQUEST,
            [(CONTENT_TYPE, "application/json")],
            String::new(),
        );
    };
    let forwarded = FORWARDED
        .iter()
        .filter_map(|name| {
            headers
                .get(*name)
                .and_then(|value| value.to_str().ok())
                .map(|value| ((*name).to_owned(), LosslessString::from(value)))
        })
        .collect();
    let response = mcp::handle(
        &context,
        Request {
            body: body.into(),
            headers: forwarded,
        },
    )
    .await;
    (
        StatusCode::from_u16(response.status).unwrap(),
        [(CONTENT_TYPE, response.content_type)],
        response.body,
    )
}

fn at<'a>(value: &'a JsonValue, path: &[&str]) -> Option<&'a JsonValue> {
    path.iter().try_fold(value, |value, key| match value {
        JsonValue::Object(object) => object.get(&(*key).into()),
        _ => None,
    })
}

fn keys(value: Option<&JsonValue>) -> Vec<String> {
    match value {
        Some(JsonValue::Object(object)) => object
            .iter()
            .filter_map(|(key, _)| key.as_str().map(str::to_owned))
            .collect(),
        _ => vec![],
    }
}

fn body(side: &JsonValue) -> Option<JsonValue> {
    match at(side, &["body"]) {
        Some(JsonValue::String(text)) => text.as_str().and_then(|text| parse_json(text).ok()),
        _ => None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_engine_matches_the_installed_sdk_server_and_serves_its_client() {
    let fixture = Fixture::new().await;
    let peer = Peer::authenticate(
        &Enrolled::new("https://relay.invalid", "device-a".into()).unwrap(),
        &Credential::new(
            "mcp-sdk".into(),
            now() + 600_000,
            "https://relay.invalid".into(),
            "device-a".into(),
        ),
        now(),
    )
    .unwrap();
    let context = Arc::new(Context {
        environment: fixture.environment(true),
        dispatcher: Arc::new(standard().unwrap()),
        peer: Peer::authenticate(
            &Enrolled::new("https://relay.invalid", "device-a".into()).unwrap(),
            &Credential::new(
                "mcp-sdk".into(),
                now() + 600_000,
                "https://relay.invalid".into(),
                "device-a".into(),
            ),
            now(),
        )
        .unwrap(),
        connection_id: "mcp-sdk-connection".into(),
        home: fixture.path.clone(),
        trusted_context: None,
        access: mcp::Access::new(
            Arc::new(mcp::Server::default()),
            mcp::Lease::new(peer, "mcp-sdk-connection".into(), "epoch-fixture".into()).unwrap(),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        ),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new().route(
        "/api/mcp/devices/device-a",
        axum::routing::post({
            let context = context.clone();
            move |headers: HeaderMap, body: Bytes| serve(context.clone(), headers, body)
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap()
        .to_path_buf();
    let output = tokio::process::Command::new("bun")
        .args(["-e", SCRIPT])
        .current_dir(root.join("packages/core"))
        .env(
            "MCP_RUST_URL",
            format!("http://{address}/api/mcp/devices/device-a"),
        )
        .env("MCP_SESSION", &fixture.root)
        .stdin(Stdio::null())
        .output()
        .await
        .unwrap();
    server.abort();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report = parse_json(String::from_utf8(output.stdout).unwrap().trim()).unwrap();
    let Some(JsonValue::Array(cases)) = at(&report, &["differential"]) else {
        panic!("missing differential cases")
    };
    assert_eq!(cases.len(), 21);
    let mut mismatches = Vec::new();
    for case in cases {
        let name = match at(case, &["name"]) {
            Some(JsonValue::String(name)) => name.as_str().unwrap().to_owned(),
            _ => panic!("unnamed case"),
        };
        let rust = at(case, &["rust"]).unwrap();
        let reference = at(case, &["reference"]).unwrap();
        let mut differ = |aspect: &str, left: String, right: String| {
            if left != right {
                mismatches.push(format!("{name} {aspect}: rust {left} reference {right}"));
            }
        };
        let show = |value: Option<&JsonValue>| value.map(stringify_json).unwrap_or_default();
        differ(
            "status",
            show(at(rust, &["status"])),
            show(at(reference, &["status"])),
        );
        let (actual, expected) = (body(rust), body(reference));
        let (Some(actual), Some(expected)) = (actual.clone(), expected.clone()) else {
            differ(
                "body",
                show(at(rust, &["body"])),
                if actual.is_none() && expected.is_none() {
                    show(at(rust, &["body"]))
                } else {
                    show(at(reference, &["body"]))
                },
            );
            continue;
        };
        differ(
            "id",
            show(at(&actual, &["id"])),
            show(at(&expected, &["id"])),
        );
        differ(
            "error code",
            show(at(&actual, &["error", "code"])),
            show(at(&expected, &["error", "code"])),
        );
        match name.as_str() {
            "discover" | "tools-list" => differ(
                "result",
                show(at(&actual, &["result"])),
                show(at(&expected, &["result"])),
            ),
            "call" => {
                differ(
                    "result keys",
                    keys(at(&actual, &["result"])).join(","),
                    keys(at(&expected, &["result"])).join(","),
                );
                differ(
                    "resultType",
                    show(at(&actual, &["result", "resultType"])),
                    show(at(&expected, &["result", "resultType"])),
                );
                differ(
                    "result _meta",
                    show(at(&actual, &["result", "_meta"])),
                    show(at(&expected, &["result", "_meta"])),
                );
            }
            _ => differ(
                "error data keys",
                keys(at(&actual, &["error", "data"])).join(","),
                keys(at(&expected, &["error", "data"])).join(","),
            ),
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
    let Some(JsonValue::Array(tools)) = at(&report, &["client", "tools"]) else {
        panic!("missing client tools")
    };
    assert_eq!(tools.len(), 80);
    assert_eq!(
        at(&report, &["client", "templates", "resourceTemplates"]),
        Some(&JsonValue::Array(vec![]))
    );
    let Some(JsonValue::Array(resources)) = at(&report, &["client", "resources", "resources"])
    else {
        panic!("missing SDK resources")
    };
    assert_eq!(resources.len(), 2);
    let Some(JsonValue::Array(png)) = at(&report, &["client", "png", "contents"]) else {
        panic!("missing SDK PNG")
    };
    assert_eq!(at(&png[0], &["blob"]), Some(&JsonValue::String("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGNIv77k/6fPX/8zgAgQBwB3aA11ihy37gAAAABJRU5ErkJggg==".into())));
    let Some(JsonValue::Array(html)) = at(&report, &["client", "html", "contents"]) else {
        panic!("missing SDK HTML")
    };
    assert_eq!(
        at(&html[0], &["mimeType"]),
        Some(&JsonValue::String("text/html;profile=mcp-app".into()))
    );
    assert_eq!(
        at(&html[0], &["_meta", "ui", "csp", "frameDomains"]),
        Some(&JsonValue::Array(vec![]))
    );
    assert_eq!(
        at(&report, &["client", "isError"]),
        Some(&JsonValue::Bool(false))
    );
    assert_eq!(
        at(&report, &["client", "called", "data", "id"]),
        Some(&JsonValue::String(fixture.root.as_str().into()))
    );
    fixture.close().await;
}
