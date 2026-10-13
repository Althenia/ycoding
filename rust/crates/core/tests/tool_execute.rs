use std::sync::Arc;
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
    assert_eq!(
        output.output.unwrap().structured,
        parse_json(r#"{"toolCalls":[{"tool":"fail","status":"error"}]}"#).unwrap()
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
    assert_eq!(output.output.unwrap().structured, parse_json(r#"{"toolCalls":[{"tool":"slack.admin","status":"completed"},{"tool":"slack.admin.create","status":"completed"}]}"#).unwrap());
    assert_eq!(
        output.result,
        ToolResultValue::Text(JsonValue::String(
            "[\n  \"admin\",\n  \"created\"\n]".into()
        ))
    );
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
    assert_eq!(output.structured, parse_json(r#"{"toolCalls":[{"tool":"file","status":"completed","input":{"input":"first"}},{"tool":"file","status":"completed","input":{"input":"second"}}]}"#).unwrap());
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
    assert_eq!(first.materialize(&[]).definitions[0].output_schema, Some(parse_json(r#"{"type":"object","properties":{"toolCalls":{"type":"array","items":{"type":"object","properties":{"tool":{"type":"string"},"status":{"type":"string","enum":["running","completed","error"]},"input":{"type":"object"}},"required":["tool","status"],"additionalProperties":false}},"error":{"type":"boolean","enum":[true]}},"required":["toolCalls"],"additionalProperties":false}"#).unwrap()));
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
    assert_eq!(
        output.output.unwrap().structured,
        parse_json(r#"{"toolCalls":[],"error":true}"#).unwrap()
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
async fn displayed_call_inputs_omit_empty_values_and_wrap_non_objects() {
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
    assert_eq!(
        output.output.unwrap().structured,
        parse_json(
            r#"{"toolCalls":[{"tool":"tool","status":"completed"},{"tool":"tool","status":"completed","input":{"a":1}},{"tool":"tool","status":"completed","input":{"input":"x"}},{"tool":"tool","status":"completed","input":{"input":5}}]}"#
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
    assert_eq!(
        output.output.unwrap().structured,
        parse_json(r#"{"toolCalls":[{"tool":"pending","status":"error"}],"error":true}"#).unwrap()
    );
}
