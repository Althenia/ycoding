use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use ycoding_core::tools::registry::Failure;
use ycoding_schema::{LosslessString, tool_invocation};

#[path = "../policy_fixture.rs"]
mod policy_fixture;
#[path = "../session_support/mod.rs"]
mod session_support;

#[tokio::test]
async fn execute_enforces_the_tool_call_budget_at_1000() {
    let registry = registry();
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let leaf = Arc::new(DynamicTool::new(
        "Count",
        JsonValue::Null,
        None,
        None,
        move |_, _| {
            let observed = observed.clone();
            Box::pin(async move {
                observed.fetch_add(1, Ordering::SeqCst);
                Ok(ToolOutput {
                    structured: JsonValue::Null,
                    content: vec![],
                })
            })
        },
    ));
    let _scope = registry
        .register(vec![("leaf".into(), leaf)], Options::default())
        .unwrap();
    let materialized = registry.materialize(&[]);
    let allowed = materialized
        .invoke(
            "execute",
            parse_json(
                r#"{"code":"for (let i=0;i<1000;i++) await tools.leaf({}); return 'done'"}"#,
            )
            .unwrap(),
            context(),
        )
        .await
        .unwrap();
    let JsonValue::Object(allowed_metadata) = allowed.output.unwrap().structured else {
        panic!()
    };
    assert!(allowed_metadata.get(&"error".into()).is_none());
    assert_eq!(calls.swap(0, Ordering::SeqCst), 1000);
    let denied = materialized
        .invoke(
            "execute",
            parse_json(
                r#"{"code":"for (let i=0;i<1001;i++) await tools.leaf({}); return 'done'"}"#,
            )
            .unwrap(),
            context(),
        )
        .await
        .unwrap();
    let JsonValue::Object(denied_metadata) = denied.output.unwrap().structured else {
        panic!()
    };
    assert_eq!(
        denied_metadata.get(&"error".into()),
        Some(&JsonValue::Bool(true))
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1000);
}

#[tokio::test]
async fn execute_bounds_serialized_return_at_one_mebibyte() {
    use std::collections::BTreeMap;
    use ycoding_core::tools::builtin::execute::Execute;
    use ycoding_core::tools::registry::Tool;
    use ycoding_schema::llm::ToolContent;
    let execute = Execute::new(BTreeMap::new(), Arc::new(|left, right| left.cmp(right)));
    let exact = execute
        .settle(
            parse_json(r#"{"code":"return 'x'.repeat(1048574)"}"#).unwrap(),
            context(),
        )
        .await
        .unwrap();
    let ToolContent::Text(exact) = &exact.content[0] else {
        panic!()
    };
    assert_eq!(exact.text.code_units().count(), 1048574);
    let over = execute
        .settle(
            parse_json(r#"{"code":"return 'x'.repeat(1048575)"}"#).unwrap(),
            context(),
        )
        .await
        .unwrap();
    let ToolContent::Text(over) = &over.content[0] else {
        panic!()
    };
    assert!(over.text.to_utf8().unwrap().contains("[result truncated: 1048577 bytes exceeds the 1048576-byte output limit; return a smaller value]"));
}

#[tokio::test]
async fn execute_output_limit_does_not_truncate_durable_leaf_structured_value() {
    let registry = registry();
    let large = "x".repeat(2 * 1024 * 1024);
    let expected = large.clone();
    let leaf = Arc::new(DynamicTool::new(
        "Large",
        JsonValue::Null,
        None,
        None,
        move |_, _| {
            let value = large.clone();
            Box::pin(async move {
                Ok(ToolOutput {
                    structured: JsonValue::String(value.into()),
                    content: vec![],
                })
            })
        },
    ));
    let _scope = registry
        .register(vec![("leaf".into(), leaf)], Options::default())
        .unwrap();
    let receipts = Arc::new(Mutex::new(Vec::new()));
    let observed = receipts.clone();
    let mut ctx = context();
    ctx.invocation_settled = Some(Arc::new(move |_, _, _, receipt| {
        let observed = observed.clone();
        Box::pin(async move {
            observed.lock().unwrap().push(receipt);
            Ok(())
        })
    }));
    let result = registry
        .materialize(&[])
        .invoke(
            "execute",
            parse_json(r#"{"code":"return await tools.leaf({})"}"#).unwrap(),
            ctx,
        )
        .await
        .unwrap();
    let ToolResultValue::Text(JsonValue::String(display)) = result.result else {
        panic!()
    };
    assert!(display.code_units().count() < expected.len());
    let receipts = receipts.lock().unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(
        receipts[0].structured,
        Some(JsonValue::String(expected.into()))
    );
}

#[tokio::test]
async fn nested_progress_keeps_outer_call_metadata_and_content() {
    use ycoding_core::tools::context::Progress;
    use ycoding_schema::llm::{ToolContent, ToolTextContent};
    let registry = registry();
    let leaf = Arc::new(DynamicTool::new(
        "Progress",
        JsonValue::Null,
        None,
        None,
        |_, ctx| {
            Box::pin(async move {
                ctx.report(Progress {
                    structured: Default::default(),
                    content: vec![ToolContent::Text(ToolTextContent {
                        text: "working".into(),
                    })],
                })
                .await;
                Ok(ToolOutput {
                    structured: JsonValue::Bool(true),
                    content: vec![],
                })
            })
        },
    ));
    let _scope = registry
        .register(vec![("leaf".into(), leaf)], Options::default())
        .unwrap();
    let updates = Arc::new(Mutex::new(Vec::new()));
    let observed = updates.clone();
    let mut ctx = context();
    ctx.progress = Some(Arc::new(move |update| {
        let observed = observed.clone();
        Box::pin(async move {
            observed.lock().unwrap().push(update);
        })
    }));
    registry
        .materialize(&[])
        .invoke(
            "execute",
            parse_json(r#"{"code":"return await tools.leaf({})"}"#).unwrap(),
            ctx,
        )
        .await
        .unwrap();
    let updates = updates.lock().unwrap();
    let update = updates.iter().find(|update| update.content.iter().any(|part| matches!(part, ToolContent::Text(text) if text.text.as_str() == Some("working")))).expect("leaf progress content");
    let Some(JsonValue::Array(calls)) = update.structured.get(&"toolCalls".into()) else {
        panic!("outer metadata missing toolCalls")
    };
    let JsonValue::Object(call) = &calls[0] else {
        panic!()
    };
    assert_eq!(
        call.get(&"tool".into()),
        Some(&JsonValue::String("leaf".into()))
    );
    assert_eq!(
        call.get(&"status".into()),
        Some(&JsonValue::String("running".into()))
    );
}

#[tokio::test]
async fn absent_input_and_null_output_remain_distinct() {
    let registry = registry();
    let leaf = Arc::new(DynamicTool::new(
        "Null",
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
    ));
    let _scope = registry
        .register(vec![("leaf".into(), leaf)], Options::default())
        .unwrap();
    let receipts = Arc::new(Mutex::new(Vec::new()));
    let observed = receipts.clone();
    let mut ctx = context();
    ctx.invocation_settled = Some(Arc::new(move |_, _, _, receipt| {
        let observed = observed.clone();
        Box::pin(async move {
            observed.lock().unwrap().push(receipt);
            Ok(())
        })
    }));
    registry
        .materialize(&[])
        .invoke(
            "execute",
            parse_json(r#"{"code":"return await tools.leaf(undefined)"}"#).unwrap(),
            ctx,
        )
        .await
        .unwrap();
    let receipts = receipts.lock().unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].input, None);
    assert_eq!(receipts[0].structured, Some(JsonValue::Null));
}

#[tokio::test]
async fn concurrent_leaf_receipts_keep_invocation_order_when_completion_reverses() {
    let registry = registry();
    let gate = Arc::new(tokio::sync::Notify::new());
    let leaf_gate = gate.clone();
    let leaf = Arc::new(DynamicTool::new(
        "Ordered",
        JsonValue::Null,
        None,
        None,
        move |input, _| {
            let gate = leaf_gate.clone();
            Box::pin(async move {
                if input == JsonValue::String("first".into()) {
                    gate.notified().await;
                }
                Ok(ToolOutput {
                    structured: input,
                    content: vec![],
                })
            })
        },
    ));
    let _scope = registry
        .register(vec![("leaf".into(), leaf)], Options::default())
        .unwrap();
    let receipts = Arc::new(Mutex::new(Vec::new()));
    let observed = receipts.clone();
    let mut ctx = context();
    ctx.invocation_settled = Some(Arc::new(move |_, _, _, receipt| {
        let observed = observed.clone();
        let gate = gate.clone();
        Box::pin(async move {
            let index = receipt.index.get();
            observed.lock().unwrap().push(receipt);
            if index == 1 {
                gate.notify_one();
            }
            Ok(())
        })
    }));
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), registry.materialize(&[]).invoke(
        "execute", parse_json(r#"{"code":"return await Promise.all([tools.leaf('first'),tools.leaf('second')])"}"#).unwrap(), ctx,
    )).await.expect("concurrent calls did not settle").unwrap();
    assert!(matches!(result.result, ToolResultValue::Text(_)));
    let receipts = receipts.lock().unwrap();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].index.get(), 1);
    assert_eq!(receipts[1].index.get(), 0);
    assert_ne!(receipts[0].id, receipts[1].id);
}

#[tokio::test]
async fn leaf_continuation_waits_for_durable_receipt_acknowledgement() {
    let registry = registry();
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let leaf = Arc::new(DynamicTool::new(
        "Count",
        JsonValue::Null,
        None,
        None,
        move |_, _| {
            let counter = counter.clone();
            Box::pin(async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(ToolOutput {
                    structured: JsonValue::Bool(true),
                    content: vec![],
                })
            })
        },
    ));
    let _scope = registry
        .register(vec![("leaf".into(), leaf)], Options::default())
        .unwrap();
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let first = entered.clone();
    let gate = release.clone();
    let mut ctx = context();
    ctx.invocation_settled = Some(Arc::new(move |_, _, _, receipt| {
        let first = first.clone();
        let gate = gate.clone();
        Box::pin(async move {
            if receipt.index.get() == 0 {
                first.notify_one();
                gate.notified().await;
            }
            Ok(())
        })
    }));
    let materialized = registry.materialize(&[]);
    let execution = materialized.invoke(
        "execute",
        parse_json(r#"{"code":"await tools.leaf({}); return await tools.leaf({})"}"#).unwrap(),
        ctx,
    );
    let observer = async {
        entered.notified().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        release.notify_one();
    };
    let (settlement, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(execution, observer)
    })
    .await
    .expect("receipt acknowledgement was not reached");
    assert!(settlement.is_ok());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn durable_receipts_survive_later_progress_failure_and_replay() {
    use ycoding_core::session::{projector, store::Service};
    use ycoding_schema::session_message;
    use ycoding_store::session::NewEvent;
    let source = session_support::store();
    let service = Service::new(source.client());
    let mut recorded = Vec::new();
    for (number, kind, fields) in [
        (
            1,
            "session.step.started",
            r#", "assistantMessageID":"msg_one","agent":"build","model":{"providerID":"local","id":"test"}"#,
        ),
        (
            2,
            "session.tool.input.started",
            r#", "assistantMessageID":"msg_one","callID":"outer","name":"execute""#,
        ),
        (
            3,
            "session.tool.called",
            r#", "assistantMessageID":"msg_one","callID":"outer","input":{},"executed":false"#,
        ),
        (
            4,
            "session.tool.invocation-settled",
            r#", "assistantMessageID":"msg_one","callID":"outer","invocation":{"id":"inner0","index":0,"name":"write","tool":"write","status":"completed","input":{"path":"a"},"structured":{"ok":true}}"#,
        ),
        (
            5,
            "session.tool.invocation-settled",
            r#", "assistantMessageID":"msg_one","callID":"outer","invocation":{"id":"inner1","index":1,"name":"read","tool":"read","status":"error","input":null}"#,
        ),
        (
            6,
            "session.tool.progress",
            r#", "assistantMessageID":"msg_one","callID":"outer","structured":{"toolCalls":[{"id":"inner0","index":0,"tool":"write","status":"running"}]},"content":[]"#,
        ),
        (
            7,
            "session.tool.failed",
            r#", "assistantMessageID":"msg_one","callID":"outer","error":{"type":"unknown","message":"outer failed"},"executed":false"#,
        ),
    ] {
        recorded.push(
            service
                .publish(NewEvent {
                    id: format!("evt_unified_{number}").into(),
                    aggregate_id: "ses_one".into(),
                    created: number,
                    type_: format!("{kind}.1").into(),
                    data: parse_json(&format!(r#"{{"sessionID":"ses_one"{fields}}}"#)).unwrap(),
                })
                .await
                .unwrap(),
        );
    }
    let id = session_message::Id::new("msg_one").unwrap();
    let (_, message) = service.message(&id).unwrap().unwrap();
    let session_message::Info::Assistant(assistant) = &message else {
        panic!()
    };
    assert_eq!(assistant.content.len(), 1);
    let session_message::AssistantContent::Tool(tool) = &assistant.content[0] else {
        panic!()
    };
    assert_eq!(tool.id.as_str(), Some("outer"));
    let session_message::ToolState::Error(state) = &tool.state else {
        panic!()
    };
    assert_eq!(state.structured.get(&"toolCalls".into()), Some(&parse_json(r#"[{"id":"inner0","index":0,"name":"write","tool":"write","status":"completed","input":{"path":"a"},"structured":{"ok":true}},{"id":"inner1","index":1,"name":"read","tool":"read","status":"error","input":null}]"#).unwrap()));
    let replay = session_support::store();
    replay
        .submit(move |tx| {
            for event in &recorded {
                projector::fold(tx, event)?;
            }
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
    let (_, replayed) = Service::new(replay.client()).message(&id).unwrap().unwrap();
    assert_eq!(replayed, message);
}

#[tokio::test]
async fn nested_builtin_write_obeys_permission_and_preserves_direct_use() {
    use ycoding_core::{
        platform::{filesystem::mutation, git},
        process::guardrails::{CustomLayer, Guardrails, Limits, Paths, Settings},
        tools::{
            builtin::{filesystem, write::Write},
            context::policy::LeafPolicy,
        },
    };
    use ycoding_schema::{guardrail, permission, schema::Int};
    let fixture = policy_fixture::Fixture::default();
    fixture.session("ses_unified", None, 2, false, None);
    fixture.rules.lock().unwrap().push(permission::Rule {
        action: "*".into(),
        resource: "*".into(),
        effect: permission::Effect("allow".into()),
    });
    let root = std::env::temp_dir().join(format!(
        "ycoding-unified-write-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.to_str().unwrap();
    let policy = Arc::new(LeafPolicy {
        permissions: fixture.permissions(),
        guardrails: Guardrails::new(
            fixture.authority(),
            fixture.permissions(),
            Settings {
                paths: Paths {
                    workdir: path.into(),
                    project: path.into(),
                    home: path.into(),
                    tmpdir: None,
                    trusted_paths: vec![],
                },
                global_roots: vec![],
                custom: Arc::new(|| {
                    vec![CustomLayer {
                        rules: vec![guardrail::Rule {
                            id: "deny-fixture".into(),
                            source: guardrail::RuleSource::Custom,
                            decision: guardrail::RuleDecision::Deny,
                            actions: vec!["file_mutation".into()],
                            resources: vec!["*guardrail.txt".into()],
                            reason: "Fixture denial".into(),
                            priority: Int::new(0).unwrap(),
                        }],
                        invalid_files: vec![],
                    }]
                }),
                enabled: true,
                limits: Limits::default(),
                decide_reviews: false,
                decide_hard_reviews: true,
            },
            fixture.publisher(),
        ),
    });
    let registry = registry();
    let _scope = registry
        .register(
            vec![(
                "write".into(),
                Arc::new(Write {
                    paths: Arc::new(filesystem::Paths {
                        directory: std::fs::canonicalize(&root).unwrap(),
                        data: root.join("data"),
                        git: Arc::new(git::Service::new(1024 * 1024)),
                    }),
                    files: Arc::new(mutation::Service::default()),
                    policy,
                }),
            )],
            Options::direct(),
        )
        .unwrap();
    let mut ctx = context();
    ctx.agent = "test".into();
    let direct = registry
        .materialize(&[])
        .invoke(
            "write",
            parse_json(r#"{"path":"direct.txt","content":"direct"}"#).unwrap(),
            ctx.clone(),
        )
        .await
        .unwrap();
    assert!(!matches!(direct.result, ToolResultValue::Error(_)));
    assert_eq!(
        std::fs::read_to_string(root.join("direct.txt")).unwrap(),
        "direct"
    );
    let nested_allowed = registry
        .materialize(&[])
        .invoke(
            "execute",
            parse_json(
                r#"{"code":"return await tools.write({path:'nested.txt',content:'nested'})"}"#,
            )
            .unwrap(),
            ctx.clone(),
        )
        .await
        .unwrap();
    let JsonValue::Object(metadata) = nested_allowed.output.unwrap().structured else {
        panic!()
    };
    assert!(metadata.get(&"error".into()).is_none());
    assert_eq!(
        std::fs::read_to_string(root.join("nested.txt")).unwrap(),
        "nested"
    );
    let guarded = registry.materialize(&[]).invoke(
        "execute",
        parse_json(r#"{"code":"return await tools.write({path:'guardrail.txt',content:'forbidden'})"}"#).unwrap(),
        ctx.clone(),
    ).await.unwrap();
    let JsonValue::Object(metadata) = guarded.output.unwrap().structured else {
        panic!()
    };
    assert_eq!(metadata.get(&"error".into()), Some(&JsonValue::Bool(true)));
    assert!(!root.join("guardrail.txt").exists());
    fixture.rules.lock().unwrap().push(permission::Rule {
        action: "edit".into(),
        resource: "*".into(),
        effect: permission::Effect("deny".into()),
    });
    let nested = registry
        .materialize(&[])
        .invoke(
            "execute",
            parse_json(
                r#"{"code":"return await tools.write({path:'denied.txt',content:'forbidden'})"}"#,
            )
            .unwrap(),
            ctx,
        )
        .await
        .unwrap();
    let JsonValue::Object(metadata) = nested.output.unwrap().structured else {
        panic!()
    };
    assert_eq!(metadata.get(&"error".into()), Some(&JsonValue::Bool(true)));
    assert!(!root.join("denied.txt").exists());
}

#[tokio::test]
async fn cancelled_execution_does_not_dispatch_leaf() {
    let registry = registry();
    let dispatched = Arc::new(AtomicUsize::new(0));
    let counter = dispatched.clone();
    let leaf = Arc::new(DynamicTool::new(
        "Count",
        JsonValue::Null,
        None,
        None,
        move |_, _| {
            let counter = counter.clone();
            Box::pin(async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(ToolOutput {
                    structured: JsonValue::Null,
                    content: vec![],
                })
            })
        },
    ));
    let _scope = registry
        .register(vec![("leaf".into(), leaf)], Options::direct())
        .unwrap();
    let context = context();
    context.cancellation.cancel();
    let result = registry
        .materialize(&[])
        .invoke(
            "execute",
            parse_json(r#"{"code":"return await tools.leaf({})"}"#).unwrap(),
            context,
        )
        .await;
    match result {
        Err(ycoding_core::tools::materialization::Error::Execution(Failure::Cancelled)) => {}
        Ok(settlement) => {
            let JsonValue::Object(metadata) = settlement.output.unwrap().structured else {
                panic!()
            };
            assert_eq!(metadata.get(&"error".into()), Some(&JsonValue::Bool(true)));
        }
        Err(error) => panic!("unexpected cancellation result: {error:?}"),
    }
    assert_eq!(dispatched.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn nested_file_capture_is_preserved() {
    use ycoding_schema::llm::{ToolContent, ToolFileContent};
    let registry = registry();
    let leaf = Arc::new(DynamicTool::new(
        "File",
        JsonValue::Null,
        None,
        None,
        |_, _| {
            Box::pin(async {
                Ok(ToolOutput {
                    structured: JsonValue::Bool(true),
                    content: vec![ToolContent::File(ToolFileContent {
                        uri: "data:text/plain;base64,YQ==".into(),
                        mime: "text/plain".into(),
                        name: Some("fixture.txt".into()),
                    })],
                })
            })
        },
    ));
    let _scope = registry
        .register(vec![("leaf".into(), leaf)], Options::direct())
        .unwrap();
    let output = registry
        .materialize(&[])
        .invoke(
            "execute",
            parse_json(r#"{"code":"return await tools.leaf({})"}"#).unwrap(),
            context(),
        )
        .await
        .unwrap()
        .output
        .unwrap();
    assert!(output.content.iter().any(|part| matches!(part, ToolContent::File(file) if file.name.as_ref().and_then(|name| name.as_str()) == Some("fixture.txt"))));
}

#[test]
fn projection_upserts_trusted_receipts_by_id_and_keeps_unrelated_fields() {
    use ycoding_core::tools::builtin::execute::merge_settled;
    use ycoding_schema::{DomainDecode, DomainEncode};
    let JsonValue::Object(mut metadata) = parse_json(r#"{"error":true,"other":"retained","toolCalls":[{"id":"second","index":1,"name":"leaf","tool":"leaf","status":"running"}]}"#).unwrap() else { panic!() };
    let first = tool_invocation::Settled::decode(&parse_json(r#"{"id":"first","index":0,"name":"leaf","tool":"leaf","status":"completed","input":null,"structured":{"value":3}}"#).unwrap()).unwrap();
    let second = tool_invocation::Settled::decode(
        &parse_json(r#"{"id":"second","index":1,"name":"leaf","tool":"leaf","status":"error"}"#)
            .unwrap(),
    )
    .unwrap();
    merge_settled(&mut metadata, &second);
    merge_settled(&mut metadata, &first);
    merge_settled(&mut metadata, &first);
    assert_eq!(metadata.get(&"error".into()), Some(&JsonValue::Bool(true)));
    assert_eq!(
        metadata.get(&"other".into()),
        Some(&JsonValue::String("retained".into()))
    );
    assert_eq!(
        metadata.get(&"toolCalls".into()),
        Some(&JsonValue::Array(vec![first.encode(), second.encode()]))
    );
}

#[tokio::test]
async fn receipts_commit_before_continuation_and_keep_identity_and_values() {
    let registry = registry();
    let receipts = Arc::new(Mutex::new(Vec::new()));
    let committed = receipts.clone();
    let observed = receipts.clone();
    let leaf = Arc::new(DynamicTool::new(
        "Echo input",
        JsonValue::Null,
        None,
        None,
        move |input, context| {
            let observed = observed.clone();
            Box::pin(async move {
                if input == JsonValue::Bool(true) {
                    assert_eq!(observed.lock().unwrap().len(), 1);
                }
                assert_eq!(context.call_id.as_str(), Some("outer_call"));
                assert_ne!(context.invocation_id.as_ref(), Some(&context.call_id));
                Ok(ToolOutput {
                    structured: input,
                    content: vec![],
                })
            })
        },
    ));
    let _scope = registry
        .register(vec![("leaf".into(), leaf)], Options::default())
        .unwrap();
    let mut context = context();
    context.invocation_settled = Some(Arc::new(move |session, message, call, receipt| {
        let committed = committed.clone();
        Box::pin(async move {
            assert_eq!(session.as_lossless().as_str(), Some("ses_unified"));
            assert_eq!(message.as_lossless().as_str(), Some("msg_unified"));
            assert_eq!(call.as_str(), Some("outer_call"));
            committed.lock().unwrap().push(receipt);
            Ok(())
        })
    }));
    let result = registry.materialize(&[]).invoke(
        "execute",
        parse_json(r#"{"code":"await search({query:'leaf'}); await tools.leaf('\\ud800'); await tools.leaf(true); throw new Error('outer failed')"}"#).unwrap(),
        context,
    ).await.unwrap();
    let JsonValue::Object(structured) = result.output.unwrap().structured else {
        panic!("expected execute metadata");
    };
    assert_eq!(
        structured.get(&"error".into()),
        Some(&JsonValue::Bool(true))
    );
    let receipts = receipts.lock().unwrap();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].status, tool_invocation::Status::Completed);
    assert_eq!(receipts[1].status, tool_invocation::Status::Completed);
    assert_eq!(receipts[0].index.get(), 0);
    assert_eq!(receipts[1].index.get(), 1);
    assert_ne!(receipts[0].id, receipts[1].id);
    assert_ne!(receipts[0].id.as_str(), Some("outer_call"));
    let lone = JsonValue::String(LosslessString::from_utf16(vec![0xd800]));
    assert_eq!(receipts[0].input, Some(lone.clone()));
    assert_eq!(receipts[0].structured, Some(lone));
    assert_eq!(receipts[1].input, Some(JsonValue::Bool(true)));
}

#[tokio::test]
async fn leaf_failure_is_receipted_and_can_be_caught() {
    let registry = registry();
    let receipts = Arc::new(Mutex::new(Vec::new()));
    let committed = receipts.clone();
    let leaf = Arc::new(DynamicTool::new(
        "Fail",
        JsonValue::Null,
        None,
        None,
        |_, _| Box::pin(async { Err(Failure::message("denied")) }),
    ));
    let _scope = registry
        .register(vec![("leaf".into(), leaf)], Options::default())
        .unwrap();
    let mut context = context();
    context.invocation_settled = Some(Arc::new(move |_, _, _, receipt| {
        let committed = committed.clone();
        Box::pin(async move {
            committed.lock().unwrap().push(receipt);
            Ok(())
        })
    }));
    let result = registry
        .materialize(&[])
        .invoke(
            "execute",
            parse_json(
                r#"{"code":"try { await tools.leaf({}); } catch (e) { return 'caught'; }"}"#,
            )
            .unwrap(),
            context,
        )
        .await
        .unwrap();
    assert_eq!(
        result.result,
        ToolResultValue::Text(JsonValue::String("caught".into()))
    );
    let receipts = receipts.lock().unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].status, tool_invocation::Status::Error);
    assert_eq!(receipts[0].input, Some(parse_json("{}").unwrap()));
    assert_eq!(receipts[0].structured, None);
}

#[tokio::test]
async fn publication_failure_cannot_be_caught_or_dispatch_another_leaf() {
    let registry = registry();
    let dispatched = Arc::new(AtomicUsize::new(0));
    let counter = dispatched.clone();
    let leaf = Arc::new(DynamicTool::new(
        "Count",
        JsonValue::Null,
        None,
        None,
        move |_, _| {
            let counter = counter.clone();
            Box::pin(async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(ToolOutput {
                    structured: JsonValue::Null,
                    content: vec![],
                })
            })
        },
    ));
    let _scope = registry
        .register(vec![("leaf".into(), leaf)], Options::default())
        .unwrap();
    let mut context = context();
    context.invocation_settled = Some(Arc::new(|_, _, _, _| {
        Box::pin(async { Err(Failure::Defect("receipt publication failed".into())) })
    }));
    let result = registry.materialize(&[]).invoke("execute", parse_json(r#"{"code":"try { await tools.leaf({}); } catch (e) {} await tools.leaf({}); return 'success'"}"#).unwrap(), context).await;
    assert!(result.is_err());
    assert_eq!(dispatched.load(Ordering::SeqCst), 1);
}
