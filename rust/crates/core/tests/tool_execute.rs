use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};
use ycoding_ai::llm::{ToolOutput, ToolResultValue};
use ycoding_core::tools::{
    context::Context,
    registry::{DynamicTool, Failure, Options, Registry, Tool},
};
use ycoding_schema::{
    JsonValue,
    llm::{ToolContent, ToolFileContent},
    parse_json,
};

fn registry() -> Registry {
    Registry::new(
        Arc::new(ycoding_core::resources::tool_output_store::Store::new(
            &ycoding_core::resources::config::Roots::development(
                &std::env::temp_dir().join("ycoding-execute-test"),
            )
            .unwrap(),
        )),
        None,
        Default::default(),
        Arc::new(|left, right| left.cmp(right)),
    )
}
fn context() -> Context {
    Context::new("ses_execute", "build", "msg_execute", "call_execute").unwrap()
}
fn assert_metadata(actual: JsonValue, expected: JsonValue) {
    assert_eq!(
        ycoding_core::session::prompt_cache::canonical_json(&actual),
        ycoding_core::session::prompt_cache::canonical_json(&expected)
    );
}
fn echo(value: &'static str) -> Arc<dyn Tool> {
    Arc::new(DynamicTool::new(
        "Return text",
        parse_json(r#"{"type":"object"}"#).unwrap(),
        Some(parse_json(r#"{"type":"string"}"#).unwrap()),
        None,
        move |_, _| {
            Box::pin(async move {
                Ok(ToolOutput {
                    structured: JsonValue::String(value.into()),
                    content: vec![],
                })
            })
        },
    ))
}

#[tokio::test]
async fn successful_results_retain_visible_unhandled_rejections() {
    let registry = registry();
    let _scope = registry
        .register(
            vec![(
                "fail".into(),
                Arc::new(DynamicTool::new(
                    "Always fail",
                    parse_json(r#"{"type":"object"}"#).unwrap(),
                    None,
                    None,
                    |_, _| Box::pin(async { Err(Failure::message("Lookup refused")) }),
                )),
            )],
            Options::default(),
        )
        .unwrap();
    let output = registry
        .materialize(&[])
        .invoke(
            "execute",
            parse_json(r#"{"code":"tools.fail({}); return \"done\""}"#).unwrap(),
            context(),
        )
        .await
        .unwrap();
    assert_metadata(
        output.output.unwrap().structured,
        parse_json(r#"{"toolCalls":[{"tool":"fail","name":"fail","id":"[\"ses_execute\",\"msg_execute\",\"call_execute\",0]","index":0,"input":{},"status":"error"}]}"#).unwrap()
    );
    assert_eq!(output.result, ToolResultValue::Text(JsonValue::String("done\n\nWarnings:\n- [ToolFailure] Unhandled rejection from an un-awaited promise: Lookup refused".into())));
}

#[tokio::test]
async fn callable_namespace_and_nested_tools_preserve_order() {
    let registry = registry();
    let _admin = registry
        .register(
            vec![("admin".into(), echo("admin"))],
            Options {
                namespace: Some("slack".into()),
                codemode: true,
            },
        )
        .unwrap();
    let _child = registry
        .register(
            vec![("create".into(), echo("created"))],
            Options {
                namespace: Some("slack.admin".into()),
                codemode: true,
            },
        )
        .unwrap();
    let output = registry.materialize(&[]).invoke("execute", parse_json(r#"{"code":"return [await tools.slack.admin({}), await tools.slack.admin.create({})]"}"#).unwrap(), context()).await.unwrap();
    assert_metadata(output.output.unwrap().structured, parse_json(r#"{"toolCalls":[{"tool":"slack.admin","name":"slack_admin","id":"[\"ses_execute\",\"msg_execute\",\"call_execute\",0]","index":0,"input":{},"status":"completed","structured":"admin"},{"tool":"slack.admin.create","name":"slack_admin_create","id":"[\"ses_execute\",\"msg_execute\",\"call_execute\",1]","index":1,"input":{},"status":"completed","structured":"created"}]}"#).unwrap());
    assert_eq!(
        output.result,
        ToolResultValue::Text(JsonValue::String(
            "[\n  \"admin\",\n  \"created\"\n]".into()
        ))
    );
}

#[tokio::test]
async fn nested_hooks_transform_input_and_wrap_each_leaf_once() {
    let registry = registry();
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded = events.clone();
    let _before = registry.hooks.before(Arc::new(move |mut event| {
        let recorded = recorded.clone();
        Box::pin(async move {
            recorded
                .lock()
                .unwrap()
                .push(format!("before:{}", event.tool));
            if event.tool == "demo_echo" {
                assert_eq!(event.context.call_id.as_str(), Some("call_execute"));
                event.input = parse_json(r#"{"text":"changed"}"#).unwrap();
            }
            Ok(event)
        })
    }));
    let recorded = events.clone();
    let _after = registry.hooks.after(Arc::new(move |event| {
        let recorded = recorded.clone();
        Box::pin(async move {
            recorded
                .lock()
                .unwrap()
                .push(format!("after:{}", event.tool));
            if event.tool == "demo_echo" {
                assert_eq!(event.input, parse_json(r#"{"text":"changed"}"#).unwrap());
                assert_eq!(event.output.as_ref().unwrap().structured, event.input);
                assert!(event.output_paths.is_empty());
            }
            Ok(event)
        })
    }));
    let recorded = events.clone();
    let _scope = registry
        .register(
            vec![(
                "echo".into(),
                Arc::new(DynamicTool::new(
                    "Echo text",
                    parse_json(r#"{"type":"object"}"#).unwrap(),
                    None,
                    None,
                    move |input, context| {
                        let recorded = recorded.clone();
                        Box::pin(async move {
                            assert_eq!(context.call_id.as_str(), Some("call_execute"));
                            recorded.lock().unwrap().push("leaf:demo_echo".into());
                            Ok(ToolOutput {
                                structured: input,
                                content: vec![],
                            })
                        })
                    },
                )),
            )],
            Options {
                namespace: Some("demo".into()),
                codemode: true,
            },
        )
        .unwrap();
    let output = execute(&registry, "return await tools.demo.echo({text:\"nested\"})").await;
    assert_eq!(
        parse_json(&text(&output)).unwrap(),
        parse_json(r#"{"text":"changed"}"#).unwrap()
    );
    assert_eq!(
        *events.lock().unwrap(),
        [
            "before:execute",
            "before:demo_echo",
            "leaf:demo_echo",
            "after:demo_echo",
            "after:execute"
        ]
    );
    assert!(output.output_paths.is_empty());
}

#[tokio::test]
async fn nested_before_hook_cancellation_and_defect_never_invoke_leaf() {
    for defect in [false, true] {
        let registry = registry();
        let entered = Arc::new(tokio::sync::Notify::new());
        let notified = entered.clone();
        let before_calls = Arc::new(AtomicU64::new(0));
        let recorded = before_calls.clone();
        let _before = registry.hooks.before(Arc::new(move |event| {
            let notified = notified.clone();
            let recorded = recorded.clone();
            Box::pin(async move {
                if event.tool != "echo" {
                    return Ok(event);
                }
                recorded.fetch_add(1, Ordering::Relaxed);
                notified.notify_one();
                if defect {
                    return Err(Failure::Defect("private hook failure".into()));
                }
                event.context.cancellation.cancelled().await;
                Err(Failure::Cancelled)
            })
        }));
        let after_calls = Arc::new(AtomicU64::new(0));
        let recorded = after_calls.clone();
        let _after = registry.hooks.after(Arc::new(move |event| {
            let recorded = recorded.clone();
            Box::pin(async move {
                if event.tool == "echo" {
                    recorded.fetch_add(1, Ordering::Relaxed);
                }
                Ok(event)
            })
        }));
        let calls = Arc::new(AtomicU64::new(0));
        let recorded = calls.clone();
        let _scope = registry
            .register(
                vec![(
                    "echo".into(),
                    Arc::new(DynamicTool::new(
                        "Count echoes",
                        JsonValue::Null,
                        None,
                        None,
                        move |_, _| {
                            let recorded = recorded.clone();
                            Box::pin(async move {
                                recorded.fetch_add(1, Ordering::Relaxed);
                                Ok(ToolOutput {
                                    structured: JsonValue::String("unexpected".into()),
                                    content: vec![],
                                })
                            })
                        },
                    )),
                )],
                Options::default(),
            )
            .unwrap();
        let context = context();
        let cancellation = context.cancellation.clone();
        let request = registry.materialize(&[]);
        let pending = request.invoke(
            "execute",
            parse_json(r#"{"code":"return await tools.echo({})"}"#).unwrap(),
            context,
        );
        tokio::pin!(pending);
        if !defect {
            tokio::select! {
                biased;
                _ = entered.notified() => {},
                result = &mut pending => panic!("Execution settled before the nested hook: {result:?}"),
            }
            cancellation.cancel();
        }
        match pending.await {
            Ok(output) => {
                assert!(!text(&output).contains("private hook failure"));
                assert!(output.output.is_some(), "{output:?}");
                let JsonValue::Object(structured) = output.output.unwrap().structured else {
                    panic!("Expected failed program output")
                };
                assert_eq!(
                    structured.get(&"error".into()),
                    Some(&JsonValue::Bool(true))
                );
            }
            Err(ycoding_core::tools::materialization::Error::Execution(Failure::Cancelled)) => {
                assert!(!defect)
            }
            Err(_) => panic!("Unexpected outer settlement failure"),
        }
        assert_eq!(before_calls.load(Ordering::Relaxed), 1);
        assert_eq!(calls.load(Ordering::Relaxed), 0);
        assert_eq!(after_calls.load(Ordering::Relaxed), 0);
    }
}

#[tokio::test]
async fn files_are_collected_in_call_order_not_completion_order() {
    let registry = registry();
    let tool = Arc::new(DynamicTool::new(
        "Files",
        JsonValue::Null,
        None,
        None,
        |input, _| {
            Box::pin(async move {
                let JsonValue::String(name) = input else {
                    return Err(Failure::message("Expected name"));
                };
                if name.as_str() == Some("first") {
                    tokio::task::yield_now().await;
                }
                Ok(ToolOutput {
                    structured: JsonValue::Null,
                    content: vec![
                        ToolContent::File(ToolFileContent {
                            uri: "data:text/plain;base64,YQ==".into(),
                            mime: "text/plain".into(),
                            name: Some(name),
                        }),
                        ToolContent::File(ToolFileContent {
                            uri: "https://example.com/file".into(),
                            mime: "text/plain".into(),
                            name: None,
                        }),
                    ],
                })
            })
        },
    ));
    let _scope = registry
        .register(vec![("file".into(), tool)], Options::default())
        .unwrap();
    let output = registry.materialize(&[]).invoke("execute", parse_json(r#"{"code":"await Promise.all([tools.file(\"first\"), tools.file(\"second\")]); return \"done\""}"#).unwrap(), context()).await.unwrap().output.unwrap();
    assert_eq!(
        output
            .content
            .iter()
            .filter_map(|part| match part {
                ToolContent::File(file) => file.name.as_ref().and_then(|name| name.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>(),
        ["first", "second"]
    );
    assert_metadata(output.structured, parse_json(r#"{"toolCalls":[{"tool":"file","name":"file","id":"[\"ses_execute\",\"msg_execute\",\"call_execute\",0]","index":0,"status":"completed","input":"first","structured":null},{"tool":"file","name":"file","id":"[\"ses_execute\",\"msg_execute\",\"call_execute\",1]","index":1,"status":"completed","input":"second","structured":null}]}"#).unwrap());
}

#[tokio::test]
async fn execute_definitions_are_catalog_independent_and_strings_remain_lossless() {
    let first = registry();
    let second = registry();
    let _first = first
        .register(
            vec![("issue".into(), echo("github"))],
            Options {
                namespace: Some("github".into()),
                codemode: true,
            },
        )
        .unwrap();
    let _second = second
        .register(
            vec![("channel".into(), echo("slack"))],
            Options {
                namespace: Some("slack".into()),
                codemode: true,
            },
        )
        .unwrap();
    assert_eq!(
        first.materialize(&[]).definitions,
        second.materialize(&[]).definitions
    );
    assert_eq!(first.materialize(&[]).definitions[0].output_schema, Some(parse_json(r#"{"type":"object","properties":{"toolCalls":{"type":"array","items":{"type":"object","properties":{"tool":{"type":"string"},"status":{"type":"string","enum":["running","completed","error"]},"id":{"type":"string"},"index":{"type":"number"},"name":{"type":"string"},"input":{},"structured":{}},"required":["tool","status"],"additionalProperties":false}},"error":{"type":"boolean","enum":[true]}},"required":["toolCalls"],"additionalProperties":false}"#).unwrap()));
    let output = first
        .materialize(&[])
        .invoke(
            "execute",
            parse_json(r#"{"code":"return '\\ud800'"}"#).unwrap(),
            context(),
        )
        .await
        .unwrap();
    assert_eq!(
        output.result,
        ToolResultValue::Text(JsonValue::String(
            ycoding_schema::LosslessString::from_utf16(vec![0xd800])
        ))
    );
}

async fn execute(
    registry: &Registry,
    code: &str,
) -> ycoding_core::tools::materialization::Settlement {
    let mut input = ycoding_schema::JsonObject::new();
    input.insert("code".into(), JsonValue::String(code.into()));
    registry
        .materialize(&[])
        .invoke("execute", JsonValue::Object(input), context())
        .await
        .unwrap()
}

fn text(output: &ycoding_core::tools::materialization::Settlement) -> String {
    let ToolResultValue::Text(JsonValue::String(text)) = &output.result else {
        panic!("Expected text output: {:?}", output.result)
    };
    text.to_utf8().unwrap()
}

fn namespaced(registry: &Registry, namespace: &str, name: &str, value: &'static str) -> impl Drop {
    registry
        .register(
            vec![(name.into(), echo(value))],
            Options {
                namespace: Some(namespace.into()),
                codemode: true,
            },
        )
        .unwrap()
}

#[tokio::test]
async fn runtime_search_follows_the_current_catalog() {
    let github = registry();
    let slack = registry();
    let _github = namespaced(&github, "github", "issue", "github");
    let _slack = namespaced(&slack, "slack", "channel", "slack");
    for (registry, path) in [
        (&github, "tools.github.issue"),
        (&slack, "tools.slack.channel"),
    ] {
        let output = execute(registry, "return search({ query: \"\" })").await;
        let JsonValue::Object(found) = parse_json(&text(&output)).unwrap() else {
            panic!("Search must return an object")
        };
        let Some(JsonValue::Array(items)) = found.get(&"items".into()) else {
            panic!("Search must return items")
        };
        let JsonValue::Object(first) = &items[0] else {
            panic!("A search item must be an object")
        };
        assert_eq!(
            first.get(&"path".into()),
            Some(&JsonValue::String(path.into()))
        );
    }
}

#[tokio::test]
async fn failed_programs_flag_the_error_and_report_only_the_message() {
    let registry = registry();
    let _scope = namespaced(&registry, "github", "issue", "github");
    let output = execute(&registry, "throw new Error(\"boom\")").await;
    assert_eq!(text(&output), "Uncaught: boom");
    assert_metadata(
        output.output.unwrap().structured,
        parse_json(r#"{"toolCalls":[],"error":true}"#).unwrap(),
    );
}

#[tokio::test]
async fn logs_follow_the_value_and_tool_failures_are_catchable_with_their_message() {
    let registry = registry();
    let _scope = registry
        .register(
            vec![(
                "fail".into(),
                Arc::new(DynamicTool::new(
                    "Always fail",
                    parse_json(r#"{"type":"object"}"#).unwrap(),
                    None,
                    None,
                    |_, _| Box::pin(async { Err(Failure::message("Lookup refused")) }),
                )),
            )],
            Options::default(),
        )
        .unwrap();
    let output = execute(
        &registry,
        "console.log(\"a\", 1); try { await tools.fail({}) } catch (e) { return e.message }",
    )
    .await;
    assert_eq!(text(&output), "Lookup refused\n\nLogs:\na 1");
}

#[tokio::test]
async fn nested_call_inputs_preserve_empty_objects_and_non_objects() {
    let registry = registry();
    let _scope = registry
        .register(
            vec![(
                "tool".into(),
                Arc::new(DynamicTool::new(
                    "Any input",
                    JsonValue::Null,
                    None,
                    None,
                    |_, _| {
                        Box::pin(async {
                            Ok(ToolOutput {
                                structured: JsonValue::Null,
                                content: vec![],
                            })
                        })
                    },
                )),
            )],
            Options::default(),
        )
        .unwrap();
    let output = execute(
        &registry,
        "await tools.tool({}); await tools.tool({ a: 1 }); await tools.tool(\"x\"); await tools.tool(5); return null",
    )
    .await;
    assert_eq!(text(&output), "null");
    assert_metadata(
        output.output.unwrap().structured,
        parse_json(
            r#"{"toolCalls":[{"tool":"tool","name":"tool","id":"[\"ses_execute\",\"msg_execute\",\"call_execute\",0]","index":0,"status":"completed","input":{},"structured":null},{"tool":"tool","name":"tool","id":"[\"ses_execute\",\"msg_execute\",\"call_execute\",1]","index":1,"status":"completed","input":{"a":1},"structured":null},{"tool":"tool","name":"tool","id":"[\"ses_execute\",\"msg_execute\",\"call_execute\",2]","index":2,"status":"completed","input":"x","structured":null},{"tool":"tool","name":"tool","id":"[\"ses_execute\",\"msg_execute\",\"call_execute\",3]","index":3,"status":"completed","input":5,"structured":null}]}"#
        )
        .unwrap()
    );
}

#[tokio::test]
async fn calls_still_running_when_the_program_fails_are_reported_as_errors() {
    let registry = registry();
    let _scope = registry
        .register(
            vec![(
                "pending".into(),
                Arc::new(DynamicTool::new(
                    "Never settles",
                    parse_json(r#"{"type":"object"}"#).unwrap(),
                    None,
                    None,
                    |_, context| {
                        Box::pin(async move {
                            context.cancellation.cancelled().await;
                            Err(Failure::Cancelled)
                        })
                    },
                )),
            )],
            Options::default(),
        )
        .unwrap();
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        execute(&registry, "tools.pending({}); throw new Error(\"stop\")"),
    )
    .await
    .unwrap();
    assert_metadata(
        output.output.unwrap().structured,
        parse_json(r#"{"toolCalls":[{"tool":"pending","name":"pending","id":"[\"ses_execute\",\"msg_execute\",\"call_execute\",0]","index":0,"input":{},"status":"error"}],"error":true}"#).unwrap()
    );
}

#[tokio::test]
async fn builtin_search_and_a_registered_search_tool_are_each_recorded_once() {
    let registry = registry();
    let _scope = registry
        .register(
            vec![(
                "search".into(),
                Arc::new(DynamicTool::new(
                    "Search records",
                    parse_json(r#"{"type":"object"}"#).unwrap(),
                    Some(parse_json(r#"{"type":"number"}"#).unwrap()),
                    None,
                    |_, _| {
                        Box::pin(async {
                            Ok(ToolOutput {
                                structured: JsonValue::Number(7.0),
                                content: vec![],
                            })
                        })
                    },
                )),
            )],
            Options::default(),
        )
        .unwrap();
    let output = execute(
        &registry,
        "await search({ query: \"search\" }); return await tools.search({})",
    )
    .await;
    assert_eq!(text(&output), "7");
    assert_metadata(
        output.output.unwrap().structured,
        parse_json(
            r#"{"toolCalls":[{"tool":"search","status":"completed","input":{"query":"search"}},{"tool":"search","name":"search","id":"[\"ses_execute\",\"msg_execute\",\"call_execute\",0]","index":0,"input":{},"status":"completed","structured":7}]}"#
        )
        .unwrap()
    );
}

#[test]
fn execute_advertises_the_release_call_and_discovery_guidance() {
    let registry = registry();
    let _scope = registry
        .register(vec![("echo".into(), echo("hello"))], Options::direct())
        .unwrap();
    let request = registry.materialize(&[]);
    let execute = request
        .definitions
        .iter()
        .find(|definition| definition.name.as_str() == Some("execute"))
        .unwrap();
    assert_eq!(
        execute.description.as_str(),
        Some(
            r#"Prefer execute for multiple calls, fanout, filtering, or aggregation, such as reading or grepping many files. A direct single full-output call remains supported.

Discover tools at runtime with `return search({ query: "<intent + key nouns>" })`. Search results contain exact callable paths, descriptions, and TypeScript signatures. Copy a returned path exactly in a later execution; do not infer or normalize tool names.

Call built-ins as `tools.<name>` and MCP tools as `tools.<server>.<tool>`, using the exact paths and signatures returned by search. The same approvals apply as direct calls. Run independent calls with `Promise.all`, await calls whose completion matters, and return only needed fields.

The language supports common JavaScript data operations, functions, control flow, selected standard-library methods, and awaited tool calls. Modules, imports, classes, generators, timers, fetch, eval, prototype access, and unlisted methods are unavailable.

Only tools returned by runtime search or already known from the same execution context are available. Catalog contents may change without changing this tool definition."#
        )
    );
}
