use std::sync::{Arc, Mutex};
use ycoding_ai::llm::{ToolOutput, ToolResultValue};
use ycoding_core::tools::{
    context::{Context, Progress},
    registry::{Codec, DynamicTool, Failure, Options, Registry, TypedTool},
};
use ycoding_schema::{
    JsonObject, JsonValue,
    llm::{ToolContent, ToolFileContent, ToolTextContent},
    parse_json,
};

fn registry() -> Registry {
    Registry::new(
        Arc::new(ycoding_core::resources::tool_output_store::Store::new(
            &ycoding_core::resources::config::Roots::development(
                &std::env::temp_dir().join("ycoding-materialization-test"),
            )
            .unwrap(),
        )),
        None,
        Default::default(),
        Arc::new(|left, right| left.cmp(right)),
    )
}
fn context() -> Context {
    Context::new("ses_registry", "build", "msg_registry", "call-context").unwrap()
}

#[tokio::test]
async fn hooks_transform_input_and_settlement_in_order_and_dispose() {
    let registry = registry();
    let events = Arc::new(Mutex::new(vec![]));
    let record = events.clone();
    let before = registry.hooks.before(Arc::new(move |mut event| {
        let record = record.clone();
        Box::pin(async move {
            assert_eq!(
                event.context.session_id.as_lossless().as_str(),
                Some("ses_registry")
            );
            assert_eq!(event.context.agent.as_str(), Some("build"));
            assert_eq!(
                event.context.message_id.as_lossless().as_str(),
                Some("msg_registry")
            );
            assert_eq!(event.context.call_id.as_str(), Some("call-context"));
            record.lock().unwrap().push("before");
            event.input = JsonValue::String("transformed".into());
            Ok(event)
        })
    }));
    let record = events.clone();
    let _after = registry.hooks.after(Arc::new(move |mut event| {
        let record = record.clone();
        Box::pin(async move {
            record.lock().unwrap().push("after");
            assert_eq!(event.input, JsonValue::String("transformed".into()));
            assert_eq!(event.result, ToolResultValue::Json(event.input.clone()));
            event.result = ToolResultValue::Text(JsonValue::String("after".into()));
            Ok(event)
        })
    }));
    let record = events.clone();
    let _scope = registry
        .register(
            vec![(
                "echo".into(),
                Arc::new(DynamicTool::new(
                    "Echo",
                    JsonValue::Null,
                    None,
                    None,
                    move |input, context| {
                        let record = record.clone();
                        Box::pin(async move {
                            record.lock().unwrap().push("execute");
                            assert_eq!(context.call_id.as_str(), Some("call-context"));
                            Ok(ToolOutput {
                                structured: input,
                                content: vec![],
                            })
                        })
                    },
                )),
            )],
            Options::direct(),
        )
        .unwrap();
    assert_eq!(
        registry
            .materialize(&[])
            .invoke("echo", JsonValue::Null, context())
            .await
            .unwrap()
            .result,
        ToolResultValue::Text(JsonValue::String("after".into()))
    );
    assert_eq!(*events.lock().unwrap(), ["before", "execute", "after"]);
    drop(before);
    assert!(
        registry
            .materialize(&[])
            .invoke("missing", JsonValue::Null, context())
            .await
            .unwrap()
            .error
            .is_some()
    );
}

#[tokio::test]
async fn transformed_codecs_decode_before_execution_and_encode_before_projection() {
    let registry = registry();
    let calls = Arc::new(Mutex::new(vec![]));
    let record = calls.clone();
    let codec = || Codec {
        schema: parse_json(r#"{"type":"boolean"}"#).unwrap(),
        decode: Arc::new(|input| match input {
            JsonValue::Bool(value) => {
                Ok(JsonValue::String(if value { "yes" } else { "no" }.into()))
            }
            _ => Err("Expected boolean".into()),
        }),
        encode: Arc::new(|output| match output {
            JsonValue::String(value) => Ok(JsonValue::Bool(value.as_str() == Some("yes"))),
            _ => Err("Expected decoded string".into()),
        }),
    };
    let _scope = registry
        .register(
            vec![(
                "transformed".into(),
                Arc::new(TypedTool {
                    description: "Transform values".into(),
                    input: codec(),
                    output: codec(),
                    structured: Some(codec()),
                    permission: None,
                    handler: Arc::new(move |input, _| {
                        let record = record.clone();
                        Box::pin(async move {
                            record.lock().unwrap().push(input.clone());
                            Ok(input)
                        })
                    }),
                    projection: Some(Arc::new(|_, output| {
                        Ok(ToolOutput {
                            structured: JsonValue::String(
                                if output == &JsonValue::Bool(true) {
                                    "yes"
                                } else {
                                    "no"
                                }
                                .into(),
                            ),
                            content: vec![ToolContent::Text(ToolTextContent {
                                text: ycoding_schema::stringify_json(output).into(),
                            })],
                        })
                    })),
                }),
            )],
            Options::direct(),
        )
        .unwrap();
    let transformed = registry
        .materialize(&[])
        .invoke("transformed", JsonValue::Bool(true), context())
        .await
        .unwrap();
    assert_eq!(
        transformed.result,
        ToolResultValue::Text(JsonValue::String("true".into()))
    );
    assert_eq!(
        transformed.output.unwrap().structured,
        JsonValue::Bool(true)
    );
    let invalid = registry
        .materialize(&[])
        .invoke("transformed", JsonValue::String("yes".into()), context())
        .await
        .unwrap();
    assert_eq!(
        invalid.result,
        ToolResultValue::Error(JsonValue::String(
            "Invalid tool input: Expected boolean".into()
        ))
    );
    assert_eq!(*calls.lock().unwrap(), [JsonValue::String("yes".into())]);
}

#[tokio::test]
async fn image_progress_and_settlement_omit_undecodable_files_but_keep_remote_files() {
    let registry = registry();
    let content = vec![
        ToolContent::File(ToolFileContent {
            uri: "data:image/png;charset=utf-8;base64,aW1hZ2U=".into(),
            mime: "image/png".into(),
            name: Some("corrupt.png".into()),
        }),
        ToolContent::File(ToolFileContent {
            uri: "https://example.com/image.png".into(),
            mime: "image/png".into(),
            name: None,
        }),
    ];
    let _scope = registry
        .register(
            vec![(
                "progressive".into(),
                Arc::new(DynamicTool::new(
                    "Progress",
                    JsonValue::Null,
                    None,
                    None,
                    move |_, context| {
                        let content = content.clone();
                        Box::pin(async move {
                            context
                                .report(Progress {
                                    structured: JsonObject::new(),
                                    content: content.clone(),
                                })
                                .await;
                            Ok(ToolOutput {
                                structured: JsonValue::Null,
                                content,
                            })
                        })
                    },
                )),
            )],
            Options::direct(),
        )
        .unwrap();
    let updates = Arc::new(Mutex::new(vec![]));
    let record = updates.clone();
    let mut context = context();
    context.progress = Some(Arc::new(move |progress| {
        let record = record.clone();
        Box::pin(async move { record.lock().unwrap().push(progress) })
    }));
    let output = registry
        .materialize(&[])
        .invoke("progressive", JsonValue::Null, context)
        .await
        .unwrap()
        .output
        .unwrap();
    assert_eq!(
        output.content,
        vec![
            ToolContent::File(ToolFileContent {
                uri: "https://example.com/image.png".into(),
                mime: "image/png".into(),
                name: None
            }),
            ToolContent::Text(ToolTextContent {
                text: "[1 image omitted: could not be decoded.]".into()
            })
        ]
    );
    assert_eq!(updates.lock().unwrap()[0].content, output.content);
}

#[tokio::test]
async fn retention_failures_and_defects_propagate_without_after_hooks() {
    let root = std::env::temp_dir().join(format!(
        "tool_retention_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let roots = ycoding_core::resources::config::Roots::development(&root).unwrap();
    std::fs::create_dir_all(&roots.data).unwrap();
    std::fs::write(roots.data.join("tool-output"), "not a directory").unwrap();
    let registry = Registry::new(
        Arc::new(ycoding_core::resources::tool_output_store::Store::new(
            &roots,
        )),
        None,
        Default::default(),
        Arc::new(|left, right| left.cmp(right)),
    );
    let after = Arc::new(Mutex::new(0));
    let record = after.clone();
    let _hook = registry.hooks.after(Arc::new(move |event| {
        let record = record.clone();
        Box::pin(async move {
            *record.lock().unwrap() += 1;
            Ok(event)
        })
    }));
    let _scope = registry
        .register(
            vec![
                (
                    "large".into(),
                    Arc::new(DynamicTool::new(
                        "Large",
                        JsonValue::Null,
                        None,
                        None,
                        |_, _| {
                            Box::pin(async {
                                Ok(ToolOutput {
                                    structured: JsonValue::String("x".repeat(60 * 1024).into()),
                                    content: vec![],
                                })
                            })
                        },
                    )),
                ),
                (
                    "defect".into(),
                    Arc::new(DynamicTool::new(
                        "Defect",
                        JsonValue::Null,
                        None,
                        None,
                        |_, _| {
                            Box::pin(async {
                                Err(Failure::Defect("unexpected executor defect".into()))
                            })
                        },
                    )),
                ),
            ],
            Options::direct(),
        )
        .unwrap();
    assert!(matches!(
        registry
            .materialize(&[])
            .invoke("large", JsonValue::Null, context())
            .await,
        Err(ycoding_core::tools::materialization::Error::Storage(_))
    ));
    assert!(matches!(
        registry
            .materialize(&[])
            .invoke("defect", JsonValue::Null, context())
            .await,
        Err(ycoding_core::tools::materialization::Error::Execution(
            Failure::Defect(_)
        ))
    ));
    assert_eq!(*after.lock().unwrap(), 0);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn disposing_a_duplicate_hook_removes_all_equal_callback_registrations() {
    let hooks = ycoding_core::tools::materialization::Hooks::default();
    let calls = Arc::new(Mutex::new(0));
    let record = calls.clone();
    let callback: ycoding_core::tools::materialization::BeforeHook = Arc::new(move |event| {
        let record = record.clone();
        Box::pin(async move {
            *record.lock().unwrap() += 1;
            Ok(event)
        })
    });
    let first = hooks.before(callback.clone());
    let _second = hooks.before(callback);
    drop(first);
    hooks
        .run_before(ycoding_core::tools::materialization::BeforeEvent {
            tool: "echo".into(),
            context: context(),
            input: JsonValue::Null,
        })
        .await
        .unwrap();
    assert_eq!(*calls.lock().unwrap(), 0);
}
