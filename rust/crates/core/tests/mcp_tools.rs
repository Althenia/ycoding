include!("tool_fixture.rs");
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, sync::Arc, time::Duration};
use ycoding_ai::llm::ToolResultValue;
use ycoding_core::{
    job::{Jobs, Status},
    resources::{
        config::Entry,
        mcp::{Service, client::Hooks},
    },
    tools::{
        builtin::mcp::{Background, Error, McpTools, Notification, Notifier},
        registry::Registry,
    },
};
use ycoding_schema::{
    DomainDecode, JsonObject, JsonValue, guardrail::RuleDecision, llm::ToolContent, parse_json,
    permission, stringify_json,
};

const WAIT: Duration = Duration::from_secs(15);

struct World {
    fixture: ToolFixture,
    service: Arc<Service>,
    registry: Arc<Registry>,
}

fn server_tools(tools: Value, calls: Value) -> Value {
    json!({
        "capabilities": {"tools": {"listChanged": true}},
        "responses": {"tools/list": {"": {"tools": tools}}},
        "calls": calls,
    })
}

fn tool(name: &str, description: &str) -> Value {
    json!({"name": name, "description": description, "inputSchema": {"type": "object", "properties": {}}})
}

fn text(value: &str) -> Value {
    json!({"content": [{"type": "text", "text": value}]})
}

const APP_URI: &str = "ui://example/view.html";
const APP_MIME: &str = "text/html;profile=mcp-app";

fn app_server() -> (&'static str, Value, Value) {
    let mut declared = tool("show", "Show a view");
    declared["_meta"] = json!({"ui": {"resourceUri": APP_URI}});
    let mut table = server_tools(
        json!([declared]),
        json!({"show": {"result": {
            "content": [{"type": "text", "text": "ordinary result", "_meta": {"private": "omit"}}],
            "structuredContent": {"label": "result", "nested": {"api_key": "fixture-output-secret", "_meta": {"ui": {"resourceUri": "ui://other/redirect"}}}},
            "_meta": {"ui": {"resourceUri": "ui://other/redirect", "csp": {"connectDomains": ["https://example.invalid"]}}},
            "serverConfig": {"private": "omit"}
        }}}),
    );
    table["capabilities"]["resources"] = json!({});
    table["responses"]["resources/read"][APP_URI] = json!({"contents": [{
        "uri": APP_URI, "mimeType": APP_MIME, "text": "<p>App view</p>",
        "_meta": {"ui": {"csp": {"connectDomains": ["https://example.invalid"]}}}
    }]});
    ("demo", json!({"codemode": false}), table)
}

#[tokio::test]
async fn native_mcp_app_view_uses_the_settled_tool_call() {
    let world = World::new(ToolFixture::new(), vec![app_server()]);
    let tools = world.start(None);
    world.until(true, "demo_show").await;
    let context = world.fixture.context();
    assert!(world.app(&context).await.is_none());
    let settlement = world.invoke("demo_show", json!({
        "query": "weekly", "password": "fixture-input-secret", "_meta": {"ui": {"resourceUri": "ui://model/forged"}}
    })).await;
    assert_eq!(
        structured(&settlement)["nested"]["api_key"],
        "fixture-output-secret"
    );
    assert!(
        matches!(settlement.output.unwrap().content.as_slice(), [ToolContent::Text(part)] if part.text.as_str() == Some("ordinary result"))
    );
    assert_eq!(world.calls("demo"), 1);
    let mut wrong = context.clone();
    wrong.call_id = "different_call".into();
    assert!(world.app(&wrong).await.is_none());
    let wrong =
        ycoding_core::tools::context::Context::new("ses_other", "test", "msg_tool", "call_tool")
            .unwrap();
    assert!(world.app(&wrong).await.is_none());
    let wrong =
        ycoding_core::tools::context::Context::new("ses_tool", "test", "msg_other", "call_tool")
            .unwrap();
    assert!(world.app(&wrong).await.is_none());
    assert!(world.requests("demo", "resources/read").is_empty());
    let view = world
        .app(&context)
        .await
        .expect("successful MCP tool call exposes an App view");
    assert_eq!(view.resource_uri, APP_URI);
    assert_eq!(view.html, "<p>App view</p>");
    assert_eq!(view.tool, "show");
    assert_eq!(view.input, json!({"query": "weekly"}));
    assert_eq!(
        view.output,
        json!({
            "content": [{"type": "text", "text": "ordinary result"}],
            "structuredContent": {"label": "result", "nested": {}}
        })
    );
    assert_eq!(
        world.requests("demo", "resources/read"),
        vec![json!({"uri":APP_URI})]
    );
    assert_eq!(world.calls("demo"), 1);
    world.finish(tools).await;
}

#[tokio::test]
async fn native_mcp_app_requires_a_catalog_declaration_and_successful_result() {
    let (name, config, mut table) = app_server();
    let mut invalid = tool("invalid", "Invalid app declaration");
    invalid["_meta"] = json!({"ui": {"resourceUri": "https://example.invalid/app"}});
    let mut failed = tool("failed", "A failed app call");
    failed["_meta"] = table["responses"]["tools/list"][""]["tools"][0]["_meta"].clone();
    table["responses"]["tools/list"][""]["tools"]
        .as_array_mut()
        .unwrap()
        .extend([tool("plain", "No app declaration"), invalid, failed]);
    table["calls"]["plain"] = table["calls"]["show"].clone();
    table["calls"]["invalid"] = table["calls"]["show"].clone();
    table["calls"]["failed"] = table["calls"]["show"].clone();
    table["calls"]["failed"]["result"]["isError"] = json!(true);
    let world = World::new(ToolFixture::new(), vec![(name, config, table)]);
    let tools = world.start(None);
    for name in ["plain", "invalid", "failed"] {
        let tool = format!("demo_{name}");
        world.until(true, &tool).await;
        let mut context = world.fixture.context();
        context.call_id = name.into();
        let settlement = world
            .invoke_as(&tool, json!({"resourceUri": APP_URI}), context.clone())
            .await;
        if name == "failed" {
            assert_eq!(error_message(&settlement), "ordinary result");
        } else {
            assert_eq!(structured(&settlement)["label"], "result");
        }
        assert!(world.app(&context).await.is_none(), "{name}");
    }
    assert_eq!(world.calls("demo"), 3);
    assert!(world.requests("demo", "resources/read").is_empty());
    world.finish(tools).await;
}

#[tokio::test]
async fn native_mcp_app_validates_the_exact_single_html_item_and_payload_bounds() {
    let world = World::new(ToolFixture::new(), vec![app_server()]);
    let tools = world.start(None);
    world.until(true, "demo_show").await;
    let context = world.fixture.context();
    world.invoke("demo_show", json!({})).await;
    let valid = json!({"uri": APP_URI, "mimeType": APP_MIME, "text": "<p>Valid</p>"});
    let mut wrong_uri = valid.clone();
    wrong_uri["uri"] = json!("ui://other/not-the-request");
    let mut wrong_mime = valid.clone();
    wrong_mime["mimeType"] = json!("text/html");
    let mut ambiguous = valid.clone();
    ambiguous["blob"] = json!("PGE+");
    let mut oversized = valid.clone();
    oversized["text"] = json!("é".repeat(128 * 1024 + 1));
    for contents in [
        json!([]),
        json!([valid, valid]),
        json!([wrong_uri]),
        json!([wrong_mime]),
        json!([ambiguous]),
        json!([oversized]),
        json!([{"uri": APP_URI, "mimeType": APP_MIME, "blob": "/w=="}]),
    ] {
        world.edit_table("demo", |table| {
            table["responses"]["resources/read"][APP_URI] = json!({"contents": contents})
        });
        assert!(world.app(&context).await.is_none());
    }
    world.edit_table("demo", |table| {
        table["responses"]["resources/read"][APP_URI] = json!({"contents": [
            {"uri": APP_URI, "mimeType": APP_MIME, "blob": "PHA+VmFsaWQ8L3A+"}
        ]})
    });
    assert_eq!(world.app(&context).await.unwrap().html, "<p>Valid</p>");
    let mut oversized_input = context.clone();
    oversized_input.call_id = "oversized_input".into();
    let settlement = world
        .invoke_as(
            "demo_show",
            json!({"query": "x".repeat(32 * 1024 + 1)}),
            oversized_input.clone(),
        )
        .await;
    assert_eq!(structured(&settlement)["label"], "result");
    assert!(world.app(&oversized_input).await.is_none());
    assert_eq!(world.requests("demo", "resources/read").len(), 8);
    world.finish(tools).await;
}

#[tokio::test]
async fn native_mcp_app_keeps_the_call_catalog_snapshot_and_rejects_a_replacement() {
    let world = World::new(ToolFixture::new(), vec![app_server()]);
    let tools = world.start(None);
    world.until(true, "demo_show").await;
    let context = world.fixture.context();
    world.edit_table("demo", |table| {
        table["notify"] = json!(["notifications/tools/list_changed"])
    });
    let gate = world.fixture.root.join("release_call");
    world.edit_table("demo", |table| table["calls"]["show"]["gate"] = json!(gate));
    let (settlement, ()) = tokio::join!(world.invoke("demo_show", json!({})), async {
        world.until_requests("tools/call", 1).await;
        world.edit_table("demo", |table| {
            table["responses"]["tools/list"][""]["tools"][0]["_meta"]["ui"]["resourceUri"] =
                json!("ui://example/new.html");
            table["notify"] = json!([]);
            table["calls"]["show"]
                .as_object_mut()
                .unwrap()
                .remove("gate");
        });
        fs::write(&gate, "").unwrap();
    });
    assert_eq!(structured(&settlement)["label"], "result");
    world.until_requests("tools/list", 2).await;
    assert_eq!(world.app(&context).await.unwrap().resource_uri, APP_URI);

    let gate = world.fixture.root.join("release_read");
    world.edit_table("demo", |table| table["readGate"] = json!(gate));
    let (view, ()) = tokio::join!(world.app(&context), async {
        world.until_requests("resources/read", 2).await;
        world.service.disconnect("demo").await.unwrap();
        world.edit_table("demo", |table| {
            table.as_object_mut().unwrap().remove("readGate");
        });
        world.service.connect("demo").await.unwrap();
    });
    assert!(view.is_none());
    assert!(world.app(&context).await.is_none());
    assert_eq!(world.requests("demo", "resources/read").len(), 2);
    world.service.remove("demo").await.unwrap();
    assert!(world.app(&context).await.is_none());
    world.finish(tools).await;
}

#[tokio::test]
async fn native_mcp_app_refuses_duplicate_and_evicted_call_ids() {
    let world = World::new(ToolFixture::new(), vec![app_server()]);
    let tools = world.start(None);
    world.until(true, "demo_show").await;
    let original = world.fixture.context();
    world.invoke("demo_show", json!({})).await;
    assert!(world.app(&original).await.is_some());
    world
        .invoke("demo_show", json!({"query": "distinct result"}))
        .await;
    assert!(world.app(&original).await.is_none());

    let mut oldest = original.clone();
    oldest.call_id = "oldest".into();
    world
        .invoke_as("demo_show", json!({}), oldest.clone())
        .await;
    assert!(world.app(&oldest).await.is_some());
    let mut newest = original;
    for index in 0..128 {
        newest.call_id = format!("call_{index}").into();
        world
            .invoke_as("demo_show", json!({}), newest.clone())
            .await;
    }
    assert!(world.app(&oldest).await.is_none());
    assert!(world.app(&newest).await.is_some());
    world.finish(tools).await;
}

#[tokio::test]
async fn native_mcp_app_does_not_attach_nested_calls_to_the_code_mode_call() {
    let (name, _, table) = app_server();
    let world = World::new(ToolFixture::new(), vec![(name, json!({}), table)]);
    let tools = world.start(None);
    let settlement = world.code("return await tools.demo.show({})").await;
    assert!(settlement.error.is_none(), "{:?}", settlement.result);
    assert_eq!(world.calls("demo"), 1);
    assert!(world.app(&world.fixture.context()).await.is_none());
    assert!(world.requests("demo", "resources/read").is_empty());
    world.finish(tools).await;
}

impl World {
    fn new(fixture: ToolFixture, servers: Vec<(&str, Value, Value)>) -> Self {
        let mut configured = serde_json::Map::new();
        for (name, extra, table) in servers {
            let state = fixture.root.join(format!("{name}.json"));
            let mut table = table;
            table["log"] = json!(fixture.root.join(format!("{name}.log")));
            fs::write(&state, table.to_string()).unwrap();
            let mut config = json!({
                "type": "local",
                "command": [
                    "python3",
                    concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mcp_table.py"),
                    state,
                ],
            });
            config
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            configured.insert(name.into(), config);
        }
        let entries = [Entry::Document {
            path: None,
            info: parse_json(&json!({"mcp": {"servers": configured}}).to_string()).unwrap(),
        }];
        let service = Arc::new(
            Service::new(
                &entries,
                fixture.root.clone(),
                "1".into(),
                BTreeMap::new(),
                Hooks::default(),
            )
            .unwrap(),
        );
        let registry = Arc::new(fixture.registry());
        Self {
            fixture,
            service,
            registry,
        }
    }

    fn start(&self, background: Option<Background>) -> McpTools {
        McpTools::start(
            self.service.clone(),
            self.registry.clone(),
            self.fixture.policy.clone(),
            background,
        )
    }

    fn definitions(&self) -> Vec<String> {
        self.registry
            .materialize(&[])
            .definitions
            .iter()
            .map(|definition| definition.name.as_str().unwrap().to_owned())
            .collect()
    }

    async fn until(&self, present: bool, name: &str) {
        tokio::time::timeout(WAIT, async {
            while self.definitions().iter().any(|item| item == name) != present {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{name} presence did not become {present}"));
    }

    async fn invoke(
        &self,
        name: &str,
        input: Value,
    ) -> ycoding_core::tools::materialization::Settlement {
        self.invoke_as(name, input, self.fixture.context()).await
    }

    async fn invoke_as(
        &self,
        name: &str,
        input: Value,
        context: ycoding_core::tools::context::Context,
    ) -> ycoding_core::tools::materialization::Settlement {
        tokio::time::timeout(
            WAIT,
            self.registry.materialize(&[]).invoke(
                name,
                parse_json(&input.to_string()).unwrap(),
                context,
            ),
        )
        .await
        .expect("tool settled")
        .unwrap()
    }

    async fn code(&self, code: &str) -> ycoding_core::tools::materialization::Settlement {
        self.until(true, "execute").await;
        self.invoke("execute", json!({"code": code})).await
    }

    fn calls(&self, server: &str) -> usize {
        self.requests(server, "tools/call").len()
    }

    fn requests(&self, server: &str, method: &str) -> Vec<Value> {
        fs::read_to_string(self.fixture.root.join(format!("{server}.log")))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|line| line["method"] == method)
            .map(|mut line| line["params"].take())
            .collect()
    }

    fn edit_table(&self, server: &str, change: impl FnOnce(&mut Value)) {
        let path = self.fixture.root.join(format!("{server}.json"));
        let mut table = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        change(&mut table);
        let next = path.with_extension("next");
        fs::write(&next, table.to_string()).unwrap();
        fs::rename(next, path).unwrap();
    }

    async fn until_requests(&self, method: &str, count: usize) {
        tokio::time::timeout(WAIT, async {
            while self.requests("demo", method).len() < count {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    async fn app(
        &self,
        context: &ycoding_core::tools::context::Context,
    ) -> Option<ycoding_core::resources::mcp::AppView> {
        tokio::time::timeout(
            WAIT,
            self.service
                .app_view(&context.session_id, &context.message_id, &context.call_id),
        )
        .await
        .unwrap()
        .unwrap()
    }

    async fn finish(self, tools: McpTools) {
        tools.stop().await.unwrap();
        self.service.shutdown().await.unwrap();
        drop(self.registry);
        self.fixture.cleanup();
    }
}

fn demo_search() -> (&'static str, Value, Value) {
    (
        "demo",
        json!({}),
        server_tools(
            json!([{
                "name": "search",
                "description": "Search",
                "inputSchema": {"type": "object", "properties": {}},
                "outputSchema": {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]},
            }]),
            json!({"search": {"result": {"content": [], "structuredContent": {"ok": true}}}}),
        ),
    )
}

fn structured(settlement: &ycoding_core::tools::materialization::Settlement) -> Value {
    let output = settlement.output.as_ref().expect("tool output");
    serde_json::from_str(&stringify_json(&output.structured)).unwrap()
}

fn error_message(settlement: &ycoding_core::tools::materialization::Settlement) -> String {
    match &settlement.result {
        ToolResultValue::Error(JsonValue::String(message)) => message.to_utf8().unwrap(),
        other => panic!("expected an error result, got {other:?}"),
    }
}

#[tokio::test]
async fn code_mode_search_exposes_mcp_output_schemas() {
    let world = World::new(ToolFixture::new(), vec![demo_search()]);
    let tools = world.start(None);
    let settlement = world
        .code(r#"return search({ query: "demo search" })"#)
        .await;
    assert!(settlement.error.is_none(), "{:?}", settlement.result);
    let rendered = settlement
        .output
        .as_ref()
        .unwrap()
        .content
        .iter()
        .find_map(|part| match part {
            ycoding_schema::llm::ToolContent::Text(text) => text.text.to_utf8().ok(),
            _ => None,
        })
        .unwrap();
    assert!(rendered.contains("tools.demo.search"), "{rendered}");
    assert!(
        rendered.contains("tools.demo.search(input: {}): Promise<{\\n  ok: boolean,\\n}>")
            || rendered.contains("tools.demo.search(input: {}): Promise<{\n  ok: boolean,\n}>"),
        "{rendered}"
    );
    world.finish(tools).await;
}

#[tokio::test]
async fn code_mode_disabled_servers_are_advertised_directly() {
    let world = World::new(
        ToolFixture::new(),
        vec![
            demo_search(),
            (
                "direct",
                json!({"codemode": false}),
                server_tools(json!([tool("lookup", "Lookup")]), json!({})),
            ),
        ],
    );
    let tools = world.start(None);
    world.until(true, "direct_lookup").await;
    world.until(true, "execute").await;
    let definitions = world.registry.materialize(&[]).definitions;
    assert!(
        definitions
            .iter()
            .any(|item| item.name.as_str() == Some("direct_lookup"))
    );
    assert!(
        !definitions
            .iter()
            .any(|item| item.name.as_str() == Some("demo_search"))
    );
    let execute = definitions
        .iter()
        .find(|item| item.name.as_str() == Some("execute"))
        .unwrap();
    assert!(
        !execute
            .description
            .to_utf8()
            .unwrap()
            .contains("tools.direct.lookup")
    );
    let search = world.code(r#"return search({ query: "lookup" })"#).await;
    assert!(format!("{:?}", search.output).contains("tools.direct.lookup"));
    world.finish(tools).await;
}

#[tokio::test]
async fn code_mode_returns_text_when_structured_content_is_null_or_absent() {
    for null_structured in [false, true] {
        let mut result = text("synthetic result");
        if null_structured {
            result["structuredContent"] = Value::Null;
        }
        let world = World::new(
            ToolFixture::new(),
            vec![(
                "hosted",
                json!({}),
                server_tools(
                    json!([tool("search", "Search hosted public index")]),
                    json!({"search":{"result":result}}),
                ),
            )],
        );
        let tools = world.start(None);
        let settlement = world.code("return await tools.hosted.search({})").await;
        assert!(settlement.error.is_none(), "{:?}", settlement.result);
        let output = settlement.output.as_ref().unwrap();
        let [ToolContent::Text(content)] = output.content.as_slice() else {
            panic!("expected the hosted text result");
        };
        assert_eq!(content.text.as_str(), Some("synthetic result"));
        assert_eq!(
            structured(&settlement)["toolCalls"][0]["status"],
            "completed"
        );
        assert_eq!(world.calls("hosted"), 1);
        world.finish(tools).await;
    }
}

#[tokio::test]
async fn permission_ask_holds_the_mcp_call_until_answered() {
    let fixture = ToolFixture::new();
    fixture.authority.rules.lock().unwrap().clear();
    fixture
        .authority
        .session("ses_manual", None, 0, false, None);
    let context =
        ycoding_core::tools::context::Context::new("ses_manual", "test", "msg_tool", "call_tool")
            .unwrap();
    let world = World::new(fixture, vec![demo_search()]);
    let tools = world.start(None);
    world.until(true, "execute").await;
    let events = world.fixture.authority.events.clone();
    let permissions = world.fixture.policy.permissions.clone();
    let driver = async {
        let request = tokio::time::timeout(WAIT, async {
            loop {
                if let Some(event) = events.lock().unwrap().first() {
                    return permission::Request::decode(&event.data).unwrap();
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("permission request");
        assert_eq!(request.action.as_str(), Some("demo_search"));
        assert_eq!(request.resources, vec!["*".into()]);
        assert_eq!(request.save, Some(vec!["*".into()]));
        assert_eq!(request.metadata, Some(JsonObject::new()));
        assert_eq!(request.session_id, context.session_id);
        assert_eq!(
            request.source,
            Some(permission::Source {
                message_id: "msg_tool".into(),
                call_id: "call_tool".into()
            })
        );
        assert_eq!(world.calls("demo"), 0);
        permissions
            .reply(&request.id, permission::Reply("once".into()), None)
            .unwrap();
    };
    let (settlement, ()) = tokio::join!(
        async {
            world
                .registry
                .materialize(&[])
                .invoke(
                    "execute",
                    parse_json(r#"{"code":"return await tools.demo.search({})"}"#).unwrap(),
                    context.clone(),
                )
                .await
                .unwrap()
        },
        driver
    );
    assert!(settlement.error.is_none(), "{:?}", settlement.result);
    assert_eq!(world.calls("demo"), 1);
    world.finish(tools).await;
}

#[tokio::test]
async fn blocked_permission_never_calls_the_server() {
    let fixture = ToolFixture::new();
    fixture.deny("demo_search", "*");
    let world = World::new(fixture, vec![demo_search()]);
    let tools = world.start(None);
    let settlement = world.code("return await tools.demo.search({})").await;
    assert_eq!(
        settlement.result,
        ToolResultValue::Text(JsonValue::String("Unable to execute demo_search".into()))
    );
    assert_eq!(
        structured(&settlement),
        json!({"toolCalls": [{"tool": "demo.search", "name": "demo_search", "id": "[\"ses_tool\",\"msg_tool\",\"call_tool\",0]", "index": 0, "input": {}, "status": "error"}], "error": true})
    );
    assert_eq!(world.calls("demo"), 0);
    world.finish(tools).await;
}

#[tokio::test]
async fn results_map_text_structured_media_and_errors() {
    let audio = json!({"type": "audio", "data": "aGVsbG8=", "mimeType": "audio/wav"});
    let world = World::new(
        ToolFixture::new(),
        vec![(
            "map",
            json!({"codemode": false}),
            server_tools(
                json!([
                    tool("plain", "Plain"),
                    tool("structured", "Structured"),
                    tool("failing", "Failing"),
                    tool("blank", "Blank"),
                    tool("empty", "Empty"),
                    tool("audio", "Audio"),
                    tool("look.up", "Dotted"),
                ]),
                json!({
                    "plain": {"result": {"content": [{"type": "text", "text": "hello"}, {"type": "text", "text": "world"}]}},
                    "structured": {"result": {"content": [{"type": "text", "text": "ignored"}], "structuredContent": {"ok": true}}},
                    "failing": {"result": {"isError": true, "content": [{"type": "text", "text": "  boom  "}]}},
                    "blank": {"result": {"isError": true, "content": []}},
                    "audio": {"result": {"content": [audio]}},
                }),
            ),
        )],
    );
    let tools = world.start(None);
    world.until(true, "map_look_up").await;

    let plain = world.invoke("map_plain", json!({})).await;
    assert_eq!(structured(&plain), json!("hello\nworld"));
    assert_eq!(plain.output.as_ref().unwrap().content.len(), 2);

    let object = world.invoke("map_structured", json!({})).await;
    assert_eq!(structured(&object), json!({"ok": true}));

    assert_eq!(
        error_message(&world.invoke("map_failing", json!({})).await),
        "boom"
    );
    assert_eq!(
        error_message(&world.invoke("map_blank", json!({})).await),
        "MCP tool returned an error"
    );
    assert_eq!(
        structured(&world.invoke("map_empty", json!({})).await),
        Value::Null
    );

    let media = world.invoke("map_audio", json!({})).await;
    let output = media.output.unwrap();
    let [ToolContent::File(file)] = output.content.as_slice() else {
        panic!("expected one file part");
    };
    assert_eq!(file.mime.as_str(), Some("audio/wav"));
    assert_eq!(file.uri.as_str(), Some("data:audio/wav;base64,aGVsbG8="));
    world.finish(tools).await;
}

#[tokio::test]
async fn a_removed_server_reports_unavailable_for_a_held_tool() {
    let world = World::new(
        ToolFixture::new(),
        vec![(
            "gone",
            json!({"codemode": false}),
            server_tools(json!([tool("ping", "Ping")]), json!({})),
        )],
    );
    let tools = world.start(None);
    world.until(true, "gone_ping").await;
    let held = world.registry.materialize(&[]);
    world.service.remove("gone").await.unwrap();
    let settlement = held
        .invoke(
            "gone_ping",
            parse_json("{}").unwrap(),
            world.fixture.context(),
        )
        .await
        .unwrap();
    assert_eq!(
        error_message(&settlement),
        "MCP server \"gone\" is not available"
    );
    world.finish(tools).await;
}

#[tokio::test]
async fn tool_changes_replace_the_registered_set() {
    let world = World::new(
        ToolFixture::new(),
        vec![(
            "swap",
            json!({"codemode": false}),
            server_tools(json!([tool("ping", "Ping")]), json!({})),
        )],
    );
    let tools = world.start(None);
    world.until(true, "swap_ping").await;
    world.service.disconnect("swap").await.unwrap();
    world.until(false, "swap_ping").await;
    world.service.connect("swap").await.unwrap();
    world.until(true, "swap_ping").await;
    world.finish(tools).await;
}

#[tokio::test]
async fn an_unregistrable_server_name_ends_reconciliation_with_a_registration_error() {
    let world = World::new(
        ToolFixture::new(),
        vec![
            (
                "1bad",
                json!({"codemode": false}),
                server_tools(json!([tool("ping", "Ping")]), json!({})),
            ),
            (
                "good",
                json!({"codemode": false}),
                server_tools(json!([tool("ping", "Ping")]), json!({})),
            ),
        ],
    );
    let tools = world.start(None);
    tokio::time::timeout(WAIT, async {
        while !tools.is_finished() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("reconciliation ends");
    assert!(world.definitions().is_empty());
    let Err(Error::Registration(error)) = tools.stop().await else {
        panic!("expected a registration error");
    };
    assert_eq!(error.name, "1bad");
    world.service.shutdown().await.unwrap();
    world.fixture.cleanup();
}

fn jobs() -> (&'static str, Value, Value) {
    (
        "jobs",
        json!({"codemode": false}),
        server_tools(
            json!([tool("run_job", "Run a job"), tool("status", "Status")]),
            json!({
                "run_job": {"delay": 0.5, "result": text("done")},
                "status": {"result": text("idle")},
            }),
        ),
    )
}

#[tokio::test]
async fn execution_style_tools_are_reviewed_by_the_session_guardrail() {
    let fixture = ToolFixture::new().with_guardrail_rule(RuleDecision::Deny, "mcp_execute");
    let world = World::new(fixture, vec![jobs()]);
    let tools = world.start(None);
    world.until(true, "jobs_run_job").await;
    let blocked = world.invoke("jobs_run_job", json!({"x": 1})).await;
    assert_eq!(error_message(&blocked), "Unable to execute jobs_run_job");
    assert_eq!(world.calls("jobs"), 0);
    let status = world.invoke("jobs_status", json!({})).await;
    assert_eq!(structured(&status), json!("idle"));
    assert_eq!(world.calls("jobs"), 1);
    world.finish(tools).await;
}

#[tokio::test]
async fn background_calls_return_immediately_and_deliver_the_completion() {
    let (background, mut received) = background();
    let world = World::new(ToolFixture::new(), vec![jobs()]);
    let tools = world.start(Some(background));
    world.until(true, "jobs_run_job").await;
    let definitions = world.registry.materialize(&[]).definitions;
    let run = definitions
        .iter()
        .find(|item| item.name.as_str() == Some("jobs_run_job"))
        .unwrap();
    assert!(
        run.description
            .to_utf8()
            .unwrap()
            .ends_with("must not be polled.")
    );
    assert!(stringify_json(&run.input_schema).contains("\"background\":{"));
    let status = definitions
        .iter()
        .find(|item| item.name.as_str() == Some("jobs_status"))
        .unwrap();
    assert!(!stringify_json(&status.input_schema).contains("background"));

    let started = world
        .invoke("jobs_run_job", json!({"background": true, "x": 1}))
        .await;
    assert_eq!(
        started.result,
        ToolResultValue::Text(JsonValue::String(
            "The MCP tool was moved to the background.".into()
        ))
    );
    assert!(received.try_recv().is_err());
    let notification = tokio::time::timeout(WAIT, received.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(notification.state, "completed");
    assert_eq!(notification.description, "run_job");
    assert_eq!(notification.session_id, world.fixture.context().session_id);
    assert_eq!(
        notification.text,
        "<mcp id=\"call_tool\" state=\"completed\" tool=\"jobs_run_job\">\ndone\n</mcp>"
    );
    assert_eq!(world.calls("jobs"), 1);
    world.finish(tools).await;
}

#[tokio::test]
async fn without_a_notifier_background_is_not_advertised_and_the_call_runs_in_the_foreground() {
    let world = World::new(ToolFixture::new(), vec![jobs()]);
    let tools = world.start(None);
    world.until(true, "jobs_run_job").await;
    let definitions = world.registry.materialize(&[]).definitions;
    let run = definitions
        .iter()
        .find(|item| item.name.as_str() == Some("jobs_run_job"))
        .unwrap();
    assert!(!stringify_json(&run.input_schema).contains("background"));
    assert!(!run.description.to_utf8().unwrap().contains("Background"));
    let settlement = world
        .invoke("jobs_run_job", json!({"background": true}))
        .await;
    assert_eq!(structured(&settlement), json!("done"));
    world.finish(tools).await;
}

fn background() -> (
    Background,
    tokio::sync::mpsc::UnboundedReceiver<Notification>,
) {
    let (sender, received) = tokio::sync::mpsc::unbounded_channel::<Notification>();
    let notifier: Notifier = Arc::new(move |notification| {
        sender.send(notification).unwrap();
        Box::pin(async {})
    });
    (
        Background {
            jobs: Jobs::new(),
            notifier,
        },
        received,
    )
}

fn hosted_jobs() -> (&'static str, Value, Value) {
    let (_, config, mut table) = app_server();
    let mut run = tool("run_job", "Run a job");
    run["_meta"] = json!({"ui": {"resourceUri": APP_URI}});
    table["responses"]["tools/list"][""]["tools"] = json!([run, tool("fail_job", "Fail a job")]);
    table["calls"] = json!({
        "run_job": {"delay": 0.6, "result": text("done")},
        "fail_job": {"result": {"content": [{"type": "text", "text": " bad "}], "isError": true}},
    });
    ("jobs", config, table)
}

const MOVED: &str = "The MCP tool was moved to the background.";

#[tokio::test]
async fn hosted_foreground_calls_run_through_a_job_and_return_the_result() {
    let (background, mut received) = background();
    let jobs = background.jobs.clone();
    let world = World::new(ToolFixture::new(), vec![hosted_jobs()]);
    let tools = world.start(Some(background));
    world.until(true, "jobs_run_job").await;
    let settlement = world.invoke("jobs_run_job", json!({"x": 1})).await;
    assert_eq!(structured(&settlement), json!("done"));
    let info = jobs.get("call_tool").unwrap();
    assert_eq!(info.status, Status::Completed);
    assert_eq!(info.kind, "jobs_run_job");
    assert_eq!(info.title.as_deref(), Some("run_job (x)"));
    assert_eq!(info.output.as_deref(), Some("done"));
    assert_eq!(info.metadata.unwrap()["sessionID"], json!("ses_tool"));
    let view = world.app(&world.fixture.context()).await.unwrap();
    assert_eq!(view.output, text("done"));
    assert_eq!(view.input, json!({"x": 1}));
    assert!(received.try_recv().is_err());
    world.finish(tools).await;
}

#[tokio::test]
async fn a_running_foreground_call_moves_to_the_background_and_delivers_the_completion() {
    let (background, mut received) = background();
    let jobs = background.jobs.clone();
    let world = World::new(ToolFixture::new(), vec![hosted_jobs()]);
    let tools = world.start(Some(background));
    world.until(true, "jobs_run_job").await;
    let session_id = world.fixture.context().session_id;
    let (settlement, moved) = tokio::join!(world.invoke("jobs_run_job", json!({})), async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        jobs.background_all(&session_id, None)
    });
    assert_eq!(moved.len(), 1);
    assert_eq!(moved[0].status, Status::Running);
    assert_eq!(
        settlement.result,
        ToolResultValue::Text(JsonValue::String(MOVED.into()))
    );
    let notification = tokio::time::timeout(WAIT, received.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(notification.state, "completed");
    assert_eq!(
        notification.text,
        "<mcp id=\"call_tool\" state=\"completed\" tool=\"jobs_run_job\">\ndone\n</mcp>"
    );
    assert_eq!(world.calls("jobs"), 1);
    assert!(world.app(&world.fixture.context()).await.is_none());
    assert!(world.requests("jobs", "resources/read").is_empty());
    world.finish(tools).await;
}

#[tokio::test]
async fn cancelling_a_foreground_call_cancels_its_job() {
    let (background, mut received) = background();
    let jobs = background.jobs.clone();
    let world = World::new(ToolFixture::new(), vec![hosted_jobs()]);
    let tools = world.start(Some(background));
    world.until(true, "jobs_run_job").await;
    let context = world.fixture.context();
    let cancellation = context.cancellation.clone();
    let materialized = world.registry.materialize(&[]);
    let (settlement, ()) = tokio::join!(
        tokio::time::timeout(
            WAIT,
            materialized.invoke("jobs_run_job", parse_json("{}").unwrap(), context)
        ),
        async {
            tokio::time::sleep(Duration::from_millis(200)).await;
            cancellation.cancel();
        }
    );
    assert!(matches!(
        settlement.expect("tool settled"),
        Err(ycoding_core::tools::materialization::Error::Execution(
            ycoding_core::tools::registry::Failure::Cancelled
        ))
    ));
    assert_eq!(jobs.get("call_tool").unwrap().status, Status::Cancelled);
    assert!(world.app(&world.fixture.context()).await.is_none());
    assert!(world.requests("jobs", "resources/read").is_empty());
    assert!(received.try_recv().is_err());
    world.finish(tools).await;
}

#[tokio::test]
async fn a_moved_call_that_is_cancelled_delivers_a_cancelled_notification() {
    let (background, mut received) = background();
    let jobs = background.jobs.clone();
    let world = World::new(ToolFixture::new(), vec![hosted_jobs()]);
    let tools = world.start(Some(background));
    world.until(true, "jobs_run_job").await;
    let settlement = world
        .invoke("jobs_run_job", json!({"background": true}))
        .await;
    assert_eq!(
        settlement.result,
        ToolResultValue::Text(JsonValue::String(MOVED.into()))
    );
    assert_eq!(jobs.get("call_tool").unwrap().status, Status::Running);
    assert_eq!(
        jobs.cancel("call_tool").await.unwrap().status,
        Status::Cancelled
    );
    let notification = tokio::time::timeout(WAIT, received.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(notification.state, "cancelled");
    assert_eq!(
        notification.text,
        "<mcp id=\"call_tool\" state=\"cancelled\" tool=\"jobs_run_job\">\nMCP tool cancelled\n</mcp>"
    );
    world.finish(tools).await;
}

#[tokio::test]
async fn hosted_error_results_fail_the_call_with_their_trimmed_text() {
    let (background, _received) = background();
    let jobs = background.jobs.clone();
    let world = World::new(ToolFixture::new(), vec![hosted_jobs()]);
    let tools = world.start(Some(background));
    world.until(true, "jobs_fail_job").await;
    let settlement = world.invoke("jobs_fail_job", json!({})).await;
    assert_eq!(error_message(&settlement), "bad");
    assert_eq!(jobs.get("call_tool").unwrap().status, Status::Completed);
    world.finish(tools).await;
}
