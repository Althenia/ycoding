use std::sync::Arc;
use ycoding_ai::llm::{ToolOutput, ToolResultValue};
use ycoding_core::tools::{
    context::Context,
    registry::{DynamicTool, Options, Registry, Tool},
};
use ycoding_schema::{JsonValue, permission};

fn registry() -> Registry {
    Registry::new(
        Arc::new(ycoding_core::resources::tool_output_store::Store::new(
            &ycoding_core::resources::config::Roots::development(
                &std::env::temp_dir().join("ycoding-registry-test"),
            )
            .unwrap(),
        )),
        None,
        Default::default(),
        Arc::new(|left, right| left.cmp(right)),
    )
}

fn tool(text: &'static str) -> Arc<dyn Tool> {
    Arc::new(DynamicTool::new(
        "Echo text",
        JsonValue::Null,
        None,
        None,
        move |_, _| {
            Box::pin(async move {
                Ok(ToolOutput {
                    structured: JsonValue::String(text.into()),
                    content: vec![],
                })
            })
        },
    ))
}

#[test]
fn batch_validation_is_atomic_and_overlay_lifetime_is_scoped() {
    let registry = registry();
    let base = registry
        .register(vec![("echo".into(), tool("base"))], Options::direct())
        .unwrap();
    let invalid = registry.register_batch(vec![
        (vec![("first".into(), tool("first"))], Options::direct()),
        (
            vec![("second".into(), tool("second"))],
            Options {
                namespace: Some("invalid..namespace".into()),
                codemode: false,
            },
        ),
    ]);
    assert_eq!(
        invalid.err().unwrap().message,
        "Invalid tool namespace: \"invalid..namespace\""
    );
    assert_eq!(
        registry
            .materialize(&[])
            .definitions
            .iter()
            .map(|item| item.name.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["echo"]
    );
    let overlay = registry
        .register(vec![("echo".into(), tool("overlay"))], Options::direct())
        .unwrap();
    let held = registry.materialize(&[]);
    drop(overlay);
    assert_eq!(held.definitions[0].description.as_str(), Some("Echo text"));
    drop(base);
    assert!(registry.materialize(&[]).definitions.is_empty());
    assert_eq!(held.definitions.len(), 1);
}

#[test]
fn names_are_normalized_sorted_and_last_action_rule_controls_visibility() {
    let registry = registry();
    let _scope = registry
        .register(
            vec![
                ("zeta".into(), tool("z")),
                ("a.b".into(), tool("a")),
                ("middle".into(), tool("m")),
            ],
            Options::direct(),
        )
        .unwrap();
    let rules = vec![
        permission::Rule {
            action: "*".into(),
            resource: "*".into(),
            effect: permission::Effect("deny".into()),
        },
        permission::Rule {
            action: "a_b".into(),
            resource: "private".into(),
            effect: permission::Effect("allow".into()),
        },
    ];
    assert_eq!(
        registry
            .materialize(&rules)
            .definitions
            .iter()
            .map(|item| item.name.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["a_b"]
    );
    assert_eq!(
        registry
            .materialize(&[])
            .definitions
            .iter()
            .map(|item| item.name.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["a_b", "middle", "zeta"]
    );
    assert!(
        registry
            .register(
                vec![("execute".into(), tool("reserved"))],
                Options::direct()
            )
            .is_err()
    );
}

#[tokio::test]
async fn snapshots_execute_advertised_handlers_and_unknown_calls_are_typed() {
    let registry = registry();
    let scope = registry
        .register(vec![("echo".into(), tool("advertised"))], Options::direct())
        .unwrap();
    let held = registry.materialize(&[]);
    drop(scope);
    let _replacement = registry
        .register(
            vec![("echo".into(), tool("replacement"))],
            Options::direct(),
        )
        .unwrap();
    let context = Context::new("ses_registry", "build", "msg_registry", "call-echo").unwrap();
    assert_eq!(
        held.invoke("echo", JsonValue::Null, context.clone())
            .await
            .unwrap()
            .result,
        ToolResultValue::Json(JsonValue::String("advertised".into()))
    );
    let missing = held
        .invoke("missing", JsonValue::Null, context)
        .await
        .unwrap();
    assert_eq!(
        missing.result,
        ToolResultValue::Error(JsonValue::String("Unknown tool: missing".into()))
    );
    assert_eq!(missing.error.unwrap().r#type.as_str(), Some("tool.unknown"));
}

#[tokio::test]
async fn tool_failure_has_canonical_session_error_and_defects_propagate() {
    let registry = registry();
    let _scope = registry
        .register(
            vec![(
                "failed".into(),
                Arc::new(DynamicTool::new(
                    "Failed",
                    JsonValue::Null,
                    None,
                    None,
                    |_, _| {
                        Box::pin(async {
                            Err(ycoding_core::tools::registry::Failure::message("Denied"))
                        })
                    },
                )),
            )],
            Options::direct(),
        )
        .unwrap();
    let output = registry
        .materialize(&[])
        .invoke(
            "failed",
            JsonValue::Null,
            Context::new("ses_registry", "build", "msg_registry", "failed").unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        output.result,
        ToolResultValue::Error(JsonValue::String("Denied".into()))
    );
    assert_eq!(
        output.error.unwrap().r#type.as_str(),
        Some("tool.execution")
    );
}
