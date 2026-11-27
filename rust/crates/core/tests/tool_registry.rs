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

struct SuppliedPath(Arc<dyn Tool>, ycoding_schema::LosslessString);
impl Tool for SuppliedPath {
    fn definition(&self, name: &str) -> ycoding_ai::llm::ToolDefinition {
        self.0.definition(name)
    }
    fn permission(&self) -> Option<&str> {
        self.0.permission()
    }
    fn code_path(&self) -> Option<&ycoding_schema::LosslessString> {
        Some(&self.1)
    }
    fn settle(
        &self,
        input: JsonValue,
        context: Context,
    ) -> ycoding_core::tools::registry::ToolFuture<'_> {
        self.0.settle(input, context)
    }
}

#[tokio::test]
async fn parent_supplied_code_path_preserves_catalog_invocation_permission_owner_and_default_path()
{
    let registry = configured_registry(r#"{}"#);
    let _registration = registry
        .register(
            vec![
                (
                    "lookup".into(),
                    Arc::new(SuppliedPath(tool("lookup"), "fixture.files.read".into()))
                        as Arc<dyn Tool>,
                ),
                ("other".into(), tool("other")),
            ],
            Options {
                namespace: Some("docs".into()),
                codemode: true,
            },
        )
        .unwrap();
    assert_eq!(
        registry.available(&[]).into_iter().collect::<Vec<_>>(),
        ["docs_lookup", "docs_other"]
    );
    let materialized = registry.materialize(&[]);
    let context =
        Context::new("ses_registry_paths", "build", "msg_registry_paths", "paths").unwrap();
    let catalog = materialized
        .invoke(
            "execute",
            parse_json(r#"{"code":"return (await search({})).items.map(x=>x.path).sort()"}"#)
                .unwrap(),
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
        parse_json(r#"["tools.docs.other","tools.fixture.files.read"]"#).unwrap()
    );
    let called = materialized
        .invoke(
            "execute",
            parse_json(r#"{"code":"await search({}); return await tools.fixture.files.read({})"}"#)
                .unwrap(),
            context,
        )
        .await
        .unwrap()
        .output
        .unwrap();
    let ToolContent::Text(text) = &called.content[0] else {
        panic!()
    };
    assert_eq!(text.text.as_str(), Some("lookup"));
    let rules = [permission::Rule {
        action: "docs_lookup".into(),
        resource: "*".into(),
        effect: permission::Effect("deny".into()),
    }];
    assert_eq!(
        registry.available(&rules).into_iter().collect::<Vec<_>>(),
        ["docs_other"]
    );
}

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
        parse_json(r#"["tools.docs.lookup","tools.read"]"#).unwrap()
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
fn skill_master_switch_hides_the_skill_tool() {
    for codemode in [false, true] {
        for (capabilities, expected) in [
            (r#"{"skills":{"enabled":false}}"#, vec!["read"]),
            (r#"{"skills":{"allow":[]}}"#, vec!["read", "skill"]),
            (r#"{"tools":{"deny":["skill"]}}"#, vec!["read"]),
        ] {
            let registry = configured_registry(capabilities);
            let _scope = registry
                .register(
                    vec![
                        ("skill".into(), tool("skill")),
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
                if codemode {
                    vec!["execute"]
                } else {
                    expected.into_iter().chain(["execute"]).collect()
                },
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

#[tokio::test]
async fn direct_registration_is_callable_through_execute() {
    let registry = registry();
    let calls = Arc::new(AtomicU64::new(0));
    let recorded = calls.clone();
    let _scope = registry
        .register(
            vec![(
                "echo".into(),
                Arc::new(DynamicTool::new(
                    "Echo the supplied text",
                    parse_json(r#"{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}"#).unwrap(),
                    None,
                    None,
                    move |input, _| {
                        let recorded = recorded.clone();
                        Box::pin(async move {
                            recorded.fetch_add(1, Ordering::Relaxed);
                            Ok(ToolOutput { structured: input, content: vec![] })
                        })
                    },
                )),
            )],
            Options::direct(),
        )
        .unwrap();
    let request = registry.materialize(&[]);
    assert_eq!(
        request
            .definitions
            .iter()
            .map(|item| item.name.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["echo", "execute"]
    );
    let context = Context::new("ses_direct", "build", "msg_direct", "call_direct").unwrap();
    let catalog = request
        .invoke(
            "execute",
            parse_json(r#"{"code":"return (await search({})).items.map(item => item.path)"}"#)
                .unwrap(),
            context.clone(),
        )
        .await
        .unwrap();
    let ToolResultValue::Text(JsonValue::String(catalog)) = catalog.result else {
        panic!("Expected a catalog result")
    };
    assert_eq!(
        parse_json(catalog.as_str().unwrap()).unwrap(),
        parse_json(r#"["tools.echo"]"#).unwrap()
    );
    let output = request
        .invoke(
            "execute",
            parse_json(
                r#"{"code":"await search({}); return await tools.echo({text:\"nested\"})"}"#,
            )
            .unwrap(),
            context,
        )
        .await
        .unwrap();
    let ToolResultValue::Text(JsonValue::String(value)) = output.result else {
        panic!("Expected the echo result")
    };
    assert_eq!(
        parse_json(value.as_str().unwrap()).unwrap(),
        parse_json(r#"{"text":"nested"}"#).unwrap()
    );
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    assert!(output.output_paths.is_empty());
}

#[tokio::test]
async fn direct_tool_codemode_visibility_obeys_leaf_and_execute_denies() {
    for (capabilities, denied) in [
        (r#"{}"#, "echo"),
        (r#"{}"#, "execute"),
        (r#"{"tools":{"deny":["echo"]}}"#, ""),
        (r#"{"tools":{"deny":["execute"]}}"#, ""),
    ] {
        let registry = configured_registry(capabilities);
        let calls = Arc::new(AtomicU64::new(0));
        let recorded = calls.clone();
        let _direct = registry
            .register(
                vec![(
                    "echo".into(),
                    Arc::new(DynamicTool::new(
                        "Count successful echoes",
                        JsonValue::Null,
                        None,
                        None,
                        move |_, _| {
                            let recorded = recorded.clone();
                            Box::pin(async move {
                                recorded.fetch_add(1, Ordering::Relaxed);
                                Ok(ToolOutput {
                                    structured: JsonValue::String("ok".into()),
                                    content: vec![],
                                })
                            })
                        },
                    )),
                )],
                Options::direct(),
            )
            .unwrap();
        let _lookup = registry
            .register(vec![("lookup".into(), tool("lookup"))], Options::default())
            .unwrap();
        let rules = if denied.is_empty() {
            vec![]
        } else {
            vec![permission::Rule {
                action: denied.into(),
                resource: "*".into(),
                effect: permission::Effect("deny".into()),
            }]
        };
        let denied_leaf = denied == "echo" || capabilities.contains("echo");
        let request = registry.materialize(&rules);
        let context = Context::new(
            "ses_visibility",
            "build",
            "msg_visibility",
            "call_visibility",
        )
        .unwrap();
        if denied_leaf {
            assert_eq!(
                registry.available(&rules).into_iter().collect::<Vec<_>>(),
                ["lookup"]
            );
            assert_eq!(
                request
                    .definitions
                    .iter()
                    .map(|item| item.name.as_str().unwrap())
                    .collect::<Vec<_>>(),
                ["execute"]
            );
            let output = request.invoke("execute", parse_json(r#"{"code":"const found = await search({}); try { await tools.echo({}) } catch (error) { return found.items.map(item => item.path) } throw new Error(\"hidden echo ran\")"}"#).unwrap(), context).await.unwrap();
            let ToolResultValue::Text(JsonValue::String(found)) = output.result else {
                panic!("Expected a catalog result")
            };
            assert_eq!(
                parse_json(found.as_str().unwrap()).unwrap(),
                parse_json(r#"["tools.lookup"]"#).unwrap()
            );
            assert_eq!(calls.load(Ordering::Relaxed), 0);
        } else {
            assert_eq!(
                registry.available(&rules).into_iter().collect::<Vec<_>>(),
                ["echo"]
            );
            assert_eq!(
                request
                    .definitions
                    .iter()
                    .map(|item| item.name.as_str().unwrap())
                    .collect::<Vec<_>>(),
                ["echo"]
            );
            assert_eq!(
                request
                    .invoke("echo", JsonValue::Null, context.clone())
                    .await
                    .unwrap()
                    .result,
                ToolResultValue::Json(JsonValue::String("ok".into()))
            );
            let missing = request
                .invoke(
                    "execute",
                    parse_json(r#"{"code":"return await tools.lookup({})"}"#).unwrap(),
                    context,
                )
                .await
                .unwrap();
            assert_eq!(missing.error.unwrap().r#type.as_str(), Some("tool.unknown"));
            assert_eq!(calls.load(Ordering::Relaxed), 1);
        }
    }
}

#[test]
fn execute_name_is_reserved_in_every_registration_placement() {
    for codemode in [true, false] {
        let registry = registry();
        let error = registry
            .register(
                vec![("execute".into(), tool("reserved"))],
                Options {
                    namespace: None,
                    codemode,
                },
            )
            .err()
            .expect("execute must be reserved in every placement");
        assert_eq!(error.name, "execute");
        assert_eq!(
            error.message,
            "Tool name \"execute\" is reserved for CodeMode"
        );
        assert!(registry.available(&[]).is_empty());
        assert!(registry.materialize(&[]).definitions.is_empty());
    }
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
        ["echo", "execute"]
    );
    let overlay = registry
        .register(vec![("echo".into(), tool("overlay"))], Options::direct())
        .unwrap();
    let held = registry.materialize(&[]);
    drop(overlay);
    assert_eq!(held.definitions[0].description.as_str(), Some("Echo text"));
    drop(base);
    assert!(registry.materialize(&[]).definitions.is_empty());
    assert_eq!(held.definitions.len(), 2);
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
        ["a_b", "middle", "zeta", "execute"]
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
async fn finalized_reservations_keep_registration_precedence_and_cleanup() {
    let registry = registry();
    let reservation = registry.reserve();
    let later = registry
        .register(vec![("echo".into(), tool("later"))], Options::direct())
        .unwrap();
    let finalized = registry
        .finalize(
            reservation,
            vec![("echo".into(), tool("reserved"))],
            Options::direct(),
        )
        .unwrap();
    let context = Context::new("ses_registry", "build", "msg_registry", "call-echo").unwrap();
    assert_eq!(
        registry
            .materialize(&[])
            .invoke("echo", JsonValue::Null, context.clone())
            .await
            .unwrap()
            .result,
        ToolResultValue::Json(JsonValue::String("later".into()))
    );
    drop(later);
    assert_eq!(
        registry
            .materialize(&[])
            .invoke("echo", JsonValue::Null, context)
            .await
            .unwrap()
            .result,
        ToolResultValue::Json(JsonValue::String("reserved".into()))
    );
    drop(finalized);
    assert!(!registry.available(&[]).contains("echo"));

    let other = configured_registry("{}");
    assert!(
        other
            .finalize(
                registry.reserve(),
                vec![("foreign".into(), tool("foreign"))],
                Options::direct(),
            )
            .is_err()
    );
    assert!(other.available(&[]).is_empty());
    assert!(
        registry
            .finalize(
                registry.reserve(),
                vec![("execute".into(), tool("reserved"))],
                Options::direct(),
            )
            .is_err()
    );
    assert!(registry.available(&[]).is_empty());
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
