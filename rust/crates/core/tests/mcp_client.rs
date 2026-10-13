use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use ycoding_core::resources::mcp::client::{Connection, Content, Error, Hooks};
use ycoding_schema::{DomainDecode, mcp::ServerConfig, parse_json};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ycoding-mcp-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn source(&self, name: &str) -> PathBuf {
        let result = std::process::Command::new("bun")
            .arg(
                Path::new(env!("CARGO_MANIFEST_DIR")).join("src/resources/mcp/extract-fixture.mjs"),
            )
            .arg(name)
            .arg(&self.0)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        PathBuf::from(String::from_utf8(result.stdout).unwrap())
    }
    fn config(&self, name: &str, extra: serde_json::Value) -> ServerConfig {
        let mut value = json!({"type":"local","command":["bun",self.source(name)]});
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        ServerConfig::decode(&parse_json(&value.to_string()).unwrap()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[tokio::test]
async fn ajv_compilable_output_schemas_validate_through_paginated_client_calls_and_refresh() {
    let cases = [
        (
            "array",
            json!({"type":"array","items":{"type":"integer"},"minItems":1,"uniqueItems":true}),
            json!([1, 2]),
            json!([1, "2"]),
        ),
        (
            "enum",
            json!({"enum":["ready","done"]}),
            json!("ready"),
            json!("other"),
        ),
        (
            "union",
            json!({"anyOf":[{"type":"integer"},{"type":"string","pattern":"^ok$"}]}),
            json!("ok"),
            json!(false),
        ),
        (
            "one",
            json!({"oneOf":[{"type":"number"},{"type":"integer"}]}),
            json!(1.5),
            json!(1),
        ),
        (
            "all",
            json!({"allOf":[{"type":"integer"},{"minimum":2}],"not":{"const":3}}),
            json!(2),
            json!(3),
        ),
        (
            "ref",
            json!({"$defs":{"value":{"type":"integer"}},"$ref":"#/$defs/value"}),
            json!(2),
            json!("2"),
        ),
        (
            "additional",
            json!({"type":"object","additionalProperties":{"type":"integer"}}),
            json!({"a":2}),
            json!({"a":"2"}),
        ),
        (
            "patterns",
            json!({"type":"object","patternProperties":{"^x":{"type":"integer"}},"additionalProperties":false}),
            json!({"x1":2}),
            json!({"other":2}),
        ),
        (
            "conditional",
            json!({"if":{"properties":{"a":{"const":true}}},"then":{"required":["b"]},"else":{"required":["c"]}}),
            json!({"a":true,"b":1}),
            json!({"a":true}),
        ),
        (
            "tuple",
            json!({"type":"array","prefixItems":[{"type":"string"},{"type":"integer"}],"items":false}),
            json!(["a", 1]),
            json!(["a", 1, 2]),
        ),
        (
            "contains",
            json!({"type":"array","contains":{"const":1},"minContains":2,"maxContains":2}),
            json!([1, 1, 2]),
            json!([1, 2]),
        ),
        (
            "unevaluated",
            json!({"type":"object","allOf":[{"properties":{"a":{"type":"integer"}}}],"unevaluatedProperties":false}),
            json!({"a":1}),
            json!({"b":1}),
        ),
        (
            "dependent",
            json!({"type":"object","dependentRequired":{"a":["b"]}}),
            json!({"a":1,"b":2}),
            json!({"a":1}),
        ),
        (
            "format",
            json!({"type":"string","format":"email"}),
            json!("a@example.org"),
            json!("a@localhost"),
        ),
        (
            "length",
            json!({"type":"string","minLength":1,"maxLength":1}),
            json!("💡"),
            json!("💡💡"),
        ),
        (
            "nullable",
            json!({"type":"integer","nullable":true}),
            json!(null),
            json!("1"),
        ),
        (
            "draft7",
            json!({"$schema":"http://json-schema.org/draft-07/schema#","definitions":{"value":{"type":"integer"}},"$ref":"#/definitions/value","minimum":2}),
            json!(2),
            json!(1),
        ),
        (
            "draft6",
            json!({"$schema":"https://json-schema.org/draft-06/schema#","type":"array","items":[{"type":"string"}],"additionalItems":false}),
            json!(["a"]),
            json!(["a", 1]),
        ),
        (
            "draft2019",
            json!({"$schema":"https://json-schema.org/draft/2019-09/schema#","type":"object","properties":{"a":true},"unevaluatedProperties":false}),
            json!({"a":1}),
            json!({"b":1}),
        ),
        (
            "relaxed",
            json!({"title":42,"required":["a","a"],"properties":{"a":{"type":"integer"}},"unknownKeyword":true}),
            json!({"a":1}),
            json!({"a":"1"}),
        ),
    ];
    let fixture = Fixture::new();
    let source = fixture.0.join("schemas.mjs");
    fs::write(&source, format!(r##"
const cases = {}
let changed = false
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n")
let buffer = ""
for await (const chunk of Bun.stdin.stream()) {{
  buffer += new TextDecoder().decode(chunk)
  while (buffer.includes("\n")) {{
    const index = buffer.indexOf("\n")
    const request = JSON.parse(buffer.slice(0,index))
    buffer = buffer.slice(index+1)
    const reply = (result) => write({{jsonrpc:"2.0",id:request.id,result}})
    if (request.method === "initialize") reply({{protocolVersion:"2025-11-25",serverInfo:{{name:"schemas",version:"1"}},capabilities:{{tools:{{}}}}}})
    if (request.method === "tools/list") {{
      const offset = Number(request.params?.cursor ?? 0)
      reply({{tools:[...cases.slice(offset,offset+2).map(([name,original])=>{{const schema = changed && name === "enum" ? {{enum:["other"]}} : original;return {{name,inputSchema:{{type:"object"}},outputSchema:{{type:"object",properties:{{value:schema}},required:["value"],...Object.fromEntries(["$schema","$defs","definitions"].filter(key=>key in schema).map(key=>[key,schema[key]]))}}}}}}),...(offset===0 ? [{{name:"unresolved",inputSchema:{{type:"object"}},outputSchema:{{type:"object",properties:{{value:{{$ref:"#/$defs/missing"}}}}}}}},{{name:"malformed",inputSchema:{{type:"object"}},outputSchema:{{type:"object",properties:{{value:{{pattern:"["}}}}}}}}] : [])],...(offset+2 < cases.length ? {{nextCursor:String(offset+2)}} : {{}})}})
    }}
    if (request.method === "tools/call") {{
      if (request.params.name === "change") {{changed = true;reply({{content:[]}});continue}}
      if (request.params.arguments.missing) {{reply({{content:[]}});continue}}
      const entry = cases.find(([name])=>name === request.params.name)
      reply({{content:[],structuredContent:{{value:entry ? entry[request.params.arguments.invalid ? 3 : 2] : 1}},...(request.params.arguments.error ? {{isError:true}} : {{}})}})
    }}
  }}
}}
"##, serde_json::to_string(&cases).unwrap())).unwrap();
    let config = ServerConfig::decode(
        &parse_json(&json!({"type":"local","command":["bun",source]}).to_string()).unwrap(),
    )
    .unwrap();
    let connection = Connection::connect(
        "schemas",
        &config,
        &fixture.0,
        "1.0.0",
        &BTreeMap::new(),
        Hooks::default(),
    )
    .await
    .unwrap();
    for _ in 0..2 {
        let tools = connection.tools().await.unwrap();
        assert_eq!(tools.len(), cases.len() + 2);
        for (name, _, valid, _) in &cases {
            assert_eq!(
                connection
                    .call_tool(name, json!({}), None)
                    .await
                    .unwrap()
                    .structured,
                Some(json!({"value":valid})),
                "{name}"
            );
            let error = connection
                .call_tool(name, json!({"invalid":true}), None)
                .await
                .expect_err(name);
            assert!(
                error
                    .to_string()
                    .contains("Structured content does not match the tool's output schema"),
                "{name}: {error}"
            );
            assert!(matches!(error, Error::Rpc { code: -32602, .. }), "{name}");
        }
        for name in ["unresolved", "malformed"] {
            assert_eq!(
                connection
                    .call_tool(name, json!({}), None)
                    .await
                    .unwrap()
                    .structured,
                Some(json!({"value":1}))
            );
            assert_eq!(
                connection
                    .call_tool(name, json!({"missing":true}), None)
                    .await,
                Err(Error::Rpc {
                    code: -32600,
                    message: format!(
                        "Tool {name} has an output schema but did not return structured content"
                    )
                })
            );
        }
        assert!(
            connection
                .call_tool("array", json!({"invalid":true,"error":true}), None)
                .await
                .unwrap()
                .is_error
        );
    }
    connection
        .call_tool("change", json!({}), None)
        .await
        .unwrap();
    connection.tools().await.unwrap();
    assert!(connection.call_tool("enum", json!({}), None).await.is_err());
    assert_eq!(
        connection
            .call_tool("enum", json!({"invalid":true}), None)
            .await
            .unwrap()
            .structured,
        Some(json!({"value":"other"}))
    );
    connection.close().await.unwrap();
}

#[tokio::test]
async fn real_sdk_stdio_initializes_and_retains_paginated_output_schemas() {
    let fixture = Fixture::new();
    let connection = Connection::connect(
        "pagination",
        &fixture.config("mcp-output-schema", json!({})),
        &fixture.0,
        "1.0.0",
        &BTreeMap::new(),
        Hooks::default(),
    )
    .await
    .unwrap();
    assert_eq!(connection.protocol_version(), "2025-11-25");
    let tools = connection.tools().await.unwrap();
    assert_eq!(
        tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["first", "second", "unresolved"]
    );
    assert_eq!(
        tools[0]["outputSchema"],
        json!({"type":"object","properties":{"value":{"type":"string"}},"required":["value"]})
    );
    assert_eq!(
        tools[1]["outputSchema"]["properties"]["value"]["type"],
        "number"
    );
    assert_eq!(
        tools[2]["outputSchema"],
        json!({"type":"object","properties":{"value":{"$ref":"#/$defs/missing"}}})
    );
    assert_eq!(
        connection
            .call_tool("second", json!({}), None)
            .await
            .unwrap()
            .structured,
        Some(json!({"value":1}))
    );
    assert_eq!(
        connection
            .call_tool("unresolved", json!({}), None)
            .await
            .unwrap()
            .structured,
        Some(json!({"value":1}))
    );
    assert_eq!(
        connection.call_tool("first", json!({}), None).await,
        Err(Error::Rpc {code:-32602,message:"Structured content does not match the tool's output schema: data/value must be string".into()})
    );
    assert!(connection.prompts().await.unwrap().is_empty());
    assert!(connection.resources().await.unwrap().is_empty());
    assert!(
        connection
            .read_resource("test://none", None)
            .await
            .unwrap()
            .is_none()
    );
    assert!(connection.skill_entries().await.unwrap().is_empty());
    let pid = connection.process_id().unwrap();
    connection.close().await.unwrap();
    assert!(!ycoding_core::platform::process::is_alive(pid).unwrap());
}

#[tokio::test]
async fn timeouts_apply_to_catalog_tools_prompts_and_resource_reads() {
    let fixture = Fixture::new();
    let config=fixture.config("mcp-timeout",json!({"environment":{"MCP_TIMEOUT_TARGET":"catalog"},"timeout":{"catalog":10,"execution":10}}));
    let connection = Connection::connect(
        "timeout",
        &config,
        &fixture.0,
        "1.0.0",
        &BTreeMap::new(),
        Hooks::default(),
    )
    .await
    .unwrap();
    assert!(matches!(connection.tools().await, Err(Error::Timeout)));
    assert!(matches!(
        connection.call_tool("slow", json!({}), None).await,
        Err(Error::Timeout)
    ));
    assert!(matches!(
        connection.prompt("slow", json!({}), None).await,
        Err(Error::Timeout)
    ));
    assert!(matches!(
        connection.read_resource("test://slow", None).await,
        Err(Error::Timeout)
    ));
    connection.close().await.unwrap();
}

#[tokio::test]
async fn invalid_working_directories_do_not_spawn_a_server() {
    let fixture = Fixture::new();
    let marker = fixture.0.join("started");
    let config = fixture.config(
        "mcp-spawn-marker",
        json!({"environment":{"MCP_TEST_START_MARKER":marker}}),
    );
    let missing = fixture.0.join("missing");
    let error = Connection::connect(
        "marker",
        &config,
        &missing,
        "1.0.0",
        &BTreeMap::new(),
        Hooks::default(),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(
        error.to_string(),
        format!("Working directory does not exist: {}", missing.display())
    );
    assert!(!marker.exists());
    let file = fixture.0.join("file");
    fs::write(&file, "text").unwrap();
    let error = Connection::connect(
        "marker",
        &config,
        &file,
        "1.0.0",
        &BTreeMap::new(),
        Hooks::default(),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(
        error.to_string(),
        format!("Working directory is not a directory: {}", file.display())
    );
    assert!(!marker.exists());
    let connection = Connection::connect(
        "marker",
        &config,
        &fixture.0,
        "1.0.0",
        &BTreeMap::new(),
        Hooks::default(),
    )
    .await
    .unwrap();
    assert_eq!(fs::read_to_string(marker).unwrap(), "started");
    connection.close().await.unwrap();
}

#[tokio::test]
async fn resource_catalog_uses_the_configured_catalog_timeout() {
    let fixture = Fixture::new();
    let config = fixture.config(
        "mcp-timeout",
        json!({"environment":{"MCP_TIMEOUT_TARGET":"resource-catalog"},"timeout":{"catalog":10}}),
    );
    let connection = Connection::connect(
        "resource-timeout",
        &config,
        &fixture.0,
        "1.0.0",
        &BTreeMap::new(),
        Hooks::default(),
    )
    .await
    .unwrap();
    assert_eq!(connection.resources().await, Err(Error::Timeout));
    connection.close().await.unwrap();
}

#[tokio::test]
async fn cancelling_a_request_keeps_connection_usable() {
    let fixture = Fixture::new();
    let config = fixture.config("mcp-timeout", json!({}));
    let connection = Connection::connect(
        "cancel",
        &config,
        &fixture.0,
        "1.0.0",
        &BTreeMap::new(),
        Hooks::default(),
    )
    .await
    .unwrap();
    let (cancel, signal) = tokio::sync::watch::channel(true);
    assert!(matches!(
        connection.call_tool("slow", json!({}), Some(signal)).await,
        Err(Error::Cancelled)
    ));
    drop(cancel);
    assert_eq!(connection.tools().await.unwrap()[0]["name"], "slow");
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        connection.call_tool("slow", json!({}), None),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(result.content.is_empty());
    assert!(!result.is_error);
    connection.close().await.unwrap();
}

#[test]
fn mixed_tool_content_is_normalized_without_losing_errors_or_structured_output() {
    let result=ycoding_core::resources::mcp::client::tool_result(&json!({"isError":true,"structuredContent":{"bad":true},"content":[{"type":"text","text":"t"},{"type":"image","data":"AA==","mimeType":"image/png"},{"type":"audio","data":"AA==","mimeType":"audio/wav"},{"type":"resource_link","uri":"resource://link","name":"link"},{"type":"resource","resource":{"uri":"resource://embedded","text":"embedded"}},{"type":"resource","resource":{"uri":"resource://blob","blob":"AA==","mimeType":"application/octet-stream"}},{"type":"resource","resource":{"uri":"resource://uri","blob":"AA=="}}]})).unwrap();
    assert!(result.is_error);
    assert_eq!(result.structured, Some(json!({"bad":true})));
    assert_eq!(
        result.content,
        [
            Content::Text("t".into()),
            Content::Media {
                data: "AA==".into(),
                mime_type: "image/png".into()
            },
            Content::Media {
                data: "AA==".into(),
                mime_type: "audio/wav".into()
            },
            Content::Text("resource://link".into()),
            Content::Text("embedded".into()),
            Content::Media {
                data: "AA==".into(),
                mime_type: "application/octet-stream".into()
            },
            Content::Text("resource://uri".into())
        ]
    );
}

#[tokio::test]
async fn in_flight_cancellation_and_progress_preserve_the_hard_timeout() {
    let fixture = Fixture::new();
    let source = fixture.0.join("mcp-progress.mjs");
    fs::write(&source,r#"
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n")
const timers = new Map()
const log = (data) => write({jsonrpc:"2.0",method:"notifications/message",params:{level:"info",data}})
let buffer = ""
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk)
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n")
    const request = JSON.parse(buffer.slice(0,index))
    buffer = buffer.slice(index+1)
    const reply = (result) => write({jsonrpc:"2.0",id:request.id,result})
    if (request.method === "initialize") reply({protocolVersion:"2025-11-25",serverInfo:{name:"progress",version:"1"},capabilities:{tools:{}}})
    if (request.method === "tools/list") reply({tools:[{name:"slow",inputSchema:{type:"object"}}]})
    if (request.method === "tools/call") {
      const token=request.params._meta.progressToken
      const interval=setInterval(()=>write({jsonrpc:"2.0",method:"notifications/progress",params:{progressToken:token,progress:1}}),1)
      const timeout=setTimeout(()=>{clearInterval(interval);timers.delete(request.id);reply({content:[]})},1000)
      timers.set(request.id,[interval,timeout])
      log("started")
    }
    if (request.method === "notifications/cancelled") {
      const timer=timers.get(request.params.requestId)
      if (timer) {clearInterval(timer[0]);clearTimeout(timer[1]);timers.delete(request.params.requestId)}
      log("cancelled")
    }
  }
}
"#).unwrap();
    let config = ServerConfig::decode(
        &parse_json(
            &json!({"type":"local","command":["bun",source],"timeout":{"execution":2000}})
                .to_string(),
        )
        .unwrap(),
    )
    .unwrap();
    let connection = std::sync::Arc::new(
        Connection::connect(
            "progress",
            &config,
            &fixture.0,
            "1.0.0",
            &BTreeMap::new(),
            Hooks::default(),
        )
        .await
        .unwrap(),
    );
    let mut notifications = connection.subscribe();
    let (cancel, signal) = tokio::sync::watch::channel(false);
    let running = connection.clone();
    let call =
        tokio::spawn(async move { running.call_tool("slow", json!({}), Some(signal)).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let notification = notifications.recv().await.unwrap();
            if notification.params["data"] == "started" {
                break;
            }
        }
    })
    .await
    .unwrap();
    cancel.send_replace(true);
    assert_eq!(call.await.unwrap(), Err(Error::Cancelled));
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let notification = notifications.recv().await.unwrap();
            if notification.params["data"] == "cancelled" {
                break;
            }
        }
    })
    .await
    .unwrap();
    connection.close().await.unwrap();
    let timeout_config = ServerConfig::decode(
        &parse_json(
            &json!({"type":"local","command":["bun",source],"timeout":{"execution":20}})
                .to_string(),
        )
        .unwrap(),
    )
    .unwrap();
    let connection = std::sync::Arc::new(
        Connection::connect(
            "progress",
            &timeout_config,
            &fixture.0,
            "1.0.0",
            &BTreeMap::new(),
            Hooks::default(),
        )
        .await
        .unwrap(),
    );
    let mut notifications = connection.subscribe();
    let running = connection.clone();
    let call = tokio::spawn(async move { running.call_tool("slow", json!({}), None).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let notification = notifications.recv().await.unwrap();
            if notification.method == "notifications/progress" {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(call.await.unwrap(), Err(Error::Timeout));
    connection.close().await.unwrap();
}
