use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use ycoding_ai::llm::{ToolOutput, ToolResultValue};
use ycoding_core::resources::config::{Configuration, LoadOptions, Roots};
use ycoding_core::tools::{
    context::Context,
    registry::{DynamicTool, Options, Registry, Tool},
};
use ycoding_schema::{JsonValue, llm::ToolContent, parse_json, permission};

static NEXT: AtomicU64 = AtomicU64::new(0);

fn configured_registry(capabilities: &str) -> Registry {
    let roots = Roots::development(&std::env::temp_dir().join(format!(
        "ycoding-registry-policy-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )))
    .unwrap();
    let configuration = Configuration::load(LoadOptions {
        directory: roots.home.clone(),
        roots: roots.clone(),
        project: false,
        file: None,
        content: Some(format!(r#"{{"capabilities":{capabilities}}}"#)),
        env: BTreeMap::new(),
    })
    .unwrap();
    assert!(configuration.diagnostics.is_empty());
    Registry::new(
        Arc::new(ycoding_core::resources::tool_output_store::Store::new(
            &roots,
        )),
        Some(Arc::new(configuration)),
        Default::default(),
        Arc::new(|left, right| left.cmp(right)),
    )
}

#[tokio::test]
async fn capabilities_share_available_and_materialized_visibility() {
    let registry = configured_registry(r#"{"tools":{"deny":["shell","docs_private"]}}"#);
    let _direct = registry
        .register(
            vec![
                ("read".into(), tool("read")),
                ("shell".into(), tool("shell")),
            ],
            Options::direct(),
        )
        .unwrap();
    let _code = registry
        .register(
            vec![
                ("lookup".into(), tool("lookup")),
                ("private".into(), tool("private")),
                ("blocked".into(), tool("blocked")),
            ],
            Options {
                namespace: Some("docs".into()),
                codemode: true,
            },
        )
        .unwrap();
    let rules = [permission::Rule {
        action: "docs_blocked".into(),
        resource: "*".into(),
        effect: permission::Effect("deny".into()),
    }];
    let materialized = registry.materialize(&rules);
    assert_eq!(
        registry.available(&rules).into_iter().collect::<Vec<_>>(),
        ["docs_lookup", "read"]
    );
    assert_eq!(
        materialized
            .definitions
            .iter()
            .map(|definition| definition.name.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["read", "execute"]
    );
    let context = Context::new("ses_registry", "build", "msg_registry", "catalog").unwrap();
    let catalog = materialized
        .invoke(
            "execute",
            parse_json(r#"{"code":"return (await search({})).items.map(x=>x.path)"}"#).unwrap(),
            context.clone(),
        )
        .await
        .unwrap()
        .output
        .unwrap();
    let ToolContent::Text(text) = &catalog.content[0] else {
        panic!()
    };
    assert_eq!(
        parse_json(text.text.as_str().unwrap()).unwrap(),
        parse_json(r#"["tools.docs.lookup"]"#).unwrap()
    );
    let call = materialized
        .invoke(
            "execute",
            parse_json(r#"{"code":"await search({}); return await tools.docs.lookup({})"}"#)
                .unwrap(),
            context,
        )
        .await
        .unwrap()
        .output
        .unwrap();
    let ToolContent::Text(text) = &call.content[0] else {
        panic!()
    };
    assert_eq!(text.text.as_str(), Some("lookup"));
}

#[tokio::test]
async fn execute_allowlist_exception_and_unknown_hidden_call() {
    for (capabilities, rules, expected) in [
        (
            r#"{"tools":{"allow":["docs_lookup"]}}"#,
            vec![],
            vec!["execute"],
        ),
        (r#"{"tools":{"allow":[]}}"#, vec![], vec![]),
        (r#"{"tools":{"enabled":false}}"#, vec![], vec![]),
        (r#"{"tools":{"deny":["execute"]}}"#, vec![], vec!["read"]),
        (
            r#"{}"#,
            vec![permission::Rule {
                action: "execute".into(),
                resource: "*".into(),
                effect: permission::Effect("deny".into()),
            }],
            vec!["read"],
        ),
    ] {
        let registry = configured_registry(capabilities);
        let _direct = registry
            .register(vec![("read".into(), tool("read"))], Options::direct())
            .unwrap();
        let _code = registry
            .register(
                vec![("lookup".into(), tool("lookup"))],
                Options {
                    namespace: Some("docs".into()),
                    codemode: true,
                },
            )
            .unwrap();
        let materialized = registry.materialize(&rules);
        assert_eq!(
            registry.available(&rules).into_iter().collect::<Vec<_>>(),
            if expected.contains(&"execute") {
                vec!["docs_lookup".to_owned()]
            } else {
                expected
                    .iter()
                    .map(|name| (*name).to_owned())
                    .collect::<Vec<_>>()
            }
        );
        assert_eq!(
            materialized
                .definitions
                .iter()
                .map(|definition| definition.name.as_str().unwrap())
                .collect::<Vec<_>>(),
            expected,
            "{capabilities}"
        );
        let hidden = if expected.contains(&"read") {
            "docs_lookup"
        } else {
            "read"
        };
        let settlement = materialized
            .invoke(
                hidden,
                JsonValue::Null,
                Context::new("ses_registry", "build", "msg_registry", "hidden").unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            settlement.result,
            ToolResultValue::Error(JsonValue::String(format!("Unknown tool: {hidden}").into()))
        );
        assert_eq!(
            settlement.error.unwrap().r#type.as_str(),
            Some("tool.unknown")
        );
    }
}

#[test]
fn skill_and_project_artifact_master_switches_hide_tools() {
    for codemode in [false, true] {
        for (capabilities, expected) in [
            (
                r#"{"skills":{"enabled":false},"project_artifacts":false}"#,
                vec!["read"],
            ),
            (
                r#"{"skills":{"allow":[]}}"#,
                vec!["project_artifact", "read", "skill"],
            ),
            (
                r#"{"tools":{"deny":["skill"]}}"#,
                vec!["project_artifact", "read"],
            ),
        ] {
            let registry = configured_registry(capabilities);
            let _scope = registry
                .register(
                    vec![
                        ("skill".into(), tool("skill")),
                        ("project_artifact".into(), tool("artifact")),
                        ("read".into(), tool("read")),
                    ],
                    Options {
                        namespace: None,
                        codemode,
                    },
                )
                .unwrap();
            let materialized = registry.materialize(&[]);
            assert_eq!(
                registry.available(&[]).into_iter().collect::<Vec<_>>(),
                expected
                    .iter()
                    .map(|name| (*name).to_owned())
                    .collect::<Vec<_>>(),
                "{capabilities}/{codemode}"
            );
            let names = materialized
                .definitions
                .iter()
                .map(|definition| definition.name.as_str().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(
                names,
                if codemode { vec!["execute"] } else { expected },
                "{capabilities}"
            );
        }
    }
}

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
