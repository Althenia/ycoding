use std::sync::{Arc, Mutex};
use ycoding_ai::llm::{ToolOutput, ToolResultValue};
use ycoding_core::tools::{
    context::Context,
    registry::{DynamicTool, Options, Registry},
};
use ycoding_schema::{JsonValue, parse_json};

fn registry() -> Registry {
    let roots = ycoding_core::resources::config::Roots::development(
        &std::env::temp_dir().join("ycoding-unified-native-tests"),
    )
    .unwrap();
    Registry::new(
        Arc::new(ycoding_core::resources::tool_output_store::Store::new(
            &roots,
        )),
        None,
        Default::default(),
        Arc::new(|left, right| left.cmp(right)),
    )
}

fn context() -> Context {
    Context::new("ses_unified", "build", "msg_unified", "outer_call").unwrap()
}

#[tokio::test]
async fn direct_tool_is_discoverable_and_callable_in_code_mode() {
    let registry = registry();
    let tool = Arc::new(DynamicTool::new(
        "Echo a value",
        parse_json(r#"{"type":"object"}"#).unwrap(),
        None,
        None,
        |input, _| {
            Box::pin(async move {
                Ok(ToolOutput {
                    structured: input,
                    content: vec![],
                })
            })
        },
    ));
    let _registration = registry
        .register(vec![("echo".into(), tool)], Options::direct())
        .unwrap();
    let materialized = registry.materialize(&[]);
    assert!(
        materialized
            .definitions
            .iter()
            .any(|item| item.name.as_str() == Some("echo"))
    );
    assert!(
        materialized
            .definitions
            .iter()
            .any(|item| item.name.as_str() == Some("execute"))
    );
    let result = materialized
        .invoke(
            "execute",
            parse_json(r#"{"code":"const found = await search({query:'echo'}); return [found.items.some(x => x.path === 'tools.echo'), await tools.echo({value:42})]"}"#).unwrap(),
            context(),
        )
        .await
        .unwrap();
    let ToolResultValue::Text(JsonValue::String(value)) = result.result else {
        panic!("expected text result");
    };
    assert_eq!(
        parse_json(value.as_str().unwrap()).unwrap(),
        parse_json(r#"[true,{"value":42}]"#).unwrap()
    );
}

#[tokio::test]
async fn nested_tool_runs_registry_hooks_with_outer_call_identity() {
    let registry = registry();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let observed = seen.clone();
    let _before = registry.hooks.before(Arc::new(move |event| {
        let observed = observed.clone();
        Box::pin(async move {
            observed
                .lock()
                .unwrap()
                .push((event.tool.clone(), event.context.call_id.clone()));
            Ok(event)
        })
    }));
    let after_seen = seen.clone();
    let _after = registry.hooks.after(Arc::new(move |event| {
        let after_seen = after_seen.clone();
        Box::pin(async move {
            after_seen.lock().unwrap().push((
                format!("after:{}", event.tool),
                event.context.call_id.clone(),
            ));
            Ok(event)
        })
    }));
    let tool = Arc::new(DynamicTool::new(
        "Return a value",
        parse_json(r#"{"type":"object"}"#).unwrap(),
        None,
        None,
        |_, _| {
            Box::pin(async {
                Ok(ToolOutput {
                    structured: JsonValue::Bool(true),
                    content: vec![],
                })
            })
        },
    ));
    let _registration = registry
        .register(vec![("leaf".into(), tool)], Options::default())
        .unwrap();
    let result = registry
        .materialize(&[])
        .invoke(
            "execute",
            parse_json(r#"{"code":"return await tools.leaf({})"}"#).unwrap(),
            context(),
        )
        .await
        .unwrap();
    assert!(matches!(result.result, ToolResultValue::Text(_)));
    let seen = seen.lock().unwrap();
    assert!(
        seen.iter()
            .any(|(name, call)| name == "leaf" && call.as_str() == Some("outer_call"))
    );
    assert!(
        seen.iter()
            .any(|(name, call)| name == "after:leaf" && call.as_str() == Some("outer_call"))
    );
}
