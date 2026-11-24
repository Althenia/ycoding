include!("tool_fixture.rs");
use std::{fs, sync::Arc};
use ycoding_core::{
    platform::filesystem::search,
    tools::{
        builtin::search::{Kind, Search},
        registry::Options,
    },
};
use ycoding_schema::{JsonValue, parse_json};

#[tokio::test]
async fn search_bounds_defaults_checks_paths_and_read_denials_before_returning_matches() {
    let fixture = ToolFixture::new();
    for index in 0..101 {
        fs::write(fixture.root.join(format!("{index:03}.txt")), "needle\n").unwrap();
    }
    fs::write(fixture.root.join(".env"), "fixture-only-marker\n").unwrap();
    let service = Arc::new(
        search::Service::new(
            &fixture.root,
            search::Backend::Ripgrep {
                binary: "rg".into(),
            },
        )
        .unwrap(),
    );
    let registry = fixture.registry();
    let tools = [("glob", Kind::Glob), ("grep", Kind::Grep)]
        .map(|(name, kind)| {
            (
                name.into(),
                Arc::new(Search {
                    kind,
                    directory: fixture.root.clone(),
                    data: fixture.root.join("data"),
                    service: service.clone(),
                    ripgrep: "rg".into(),
                    policy: fixture.policy.clone(),
                }) as Arc<dyn ycoding_core::tools::registry::Tool>,
            )
        })
        .into();
    let _scope = registry.register(tools, Options::direct()).unwrap();
    assert_eq!(registry.materialize(&[]).definitions[0].output_schema, Some(parse_json(r##"{"type":"array","items":{"$ref":"#/$defs/FileSystem.Entry"},"$defs":{"FileSystem.Entry":{"type":"object","properties":{"path":{"type":"string"},"type":{"type":"string","enum":["file","directory"]}},"required":["path","type"],"additionalProperties":false}}}"##).unwrap()));
    for (name, pattern) in [("glob", "*.txt"), ("grep", "needle")] {
        let output = registry
            .materialize(&[])
            .invoke(
                name,
                parse_json(&format!(r#"{{"pattern":"{pattern}"}}"#)).unwrap(),
                fixture.context(),
            )
            .await
            .unwrap()
            .output
            .unwrap();
        let JsonValue::Array(items) = output.structured else {
            panic!("search results")
        };
        assert_eq!(items.len(), 100);
        let missing = registry
            .materialize(&[])
            .invoke(
                name,
                parse_json(&format!(r#"{{"pattern":"{pattern}","path":"missing"}}"#)).unwrap(),
                fixture.context(),
            )
            .await
            .unwrap();
        assert_eq!(
            missing.result,
            ycoding_ai::llm::ToolResultValue::Error(JsonValue::String(
                "Search path does not exist: missing".into()
            ))
        );
        let outside = registry
            .materialize(&[])
            .invoke(
                name,
                parse_json(&format!(r#"{{"pattern":"{pattern}","path":".."}}"#)).unwrap(),
                fixture.context(),
            )
            .await
            .unwrap();
        assert_eq!(
            outside.result,
            ycoding_ai::llm::ToolResultValue::Error(JsonValue::String(
                "Search path escapes the active Location".into()
            ))
        );
    }
    fixture.deny("read", ".env");
    for (input, expected) in [
        (
            r#"{"path":".env","pattern":"missing-marker"}"#,
            "Unable to grep for missing-marker",
        ),
        (
            r#"{"path":".env","pattern":"fixture-only-marker"}"#,
            "Unable to grep for fixture-only-marker",
        ),
        (
            r#"{"path":".","pattern":"fixture-only-marker"}"#,
            "Unable to grep for fixture-only-marker",
        ),
    ] {
        let output = registry
            .materialize(&[])
            .invoke("grep", parse_json(input).unwrap(), fixture.context())
            .await
            .unwrap();
        assert_eq!(
            output.result,
            ycoding_ai::llm::ToolResultValue::Error(JsonValue::String(expected.into()))
        );
    }
    fixture.cleanup();
}

#[tokio::test]
async fn managed_tool_output_can_be_searched_without_external_directory_approval() {
    let fixture = ToolFixture::new();
    let outside = fixture
        .root
        .parent()
        .unwrap()
        .join(format!("tool_search_data_{}", std::process::id()));
    fs::create_dir_all(outside.join("tool-output")).unwrap();
    let managed = outside.join("tool-output/tool_012345abcdef0123456789ABCD");
    fs::write(&managed, "managed-marker\n").unwrap();
    fixture.deny("external_directory", "*");
    let registry = fixture.registry();
    let _scope = registry
        .register(
            vec![(
                "grep".into(),
                Arc::new(Search {
                    kind: Kind::Grep,
                    directory: fixture.root.clone(),
                    data: outside.clone(),
                    service: Arc::new(
                        search::Service::new(
                            &fixture.root,
                            search::Backend::Ripgrep {
                                binary: "rg".into(),
                            },
                        )
                        .unwrap(),
                    ),
                    ripgrep: "rg".into(),
                    policy: fixture.policy.clone(),
                }),
            )],
            Options::direct(),
        )
        .unwrap();
    let output = registry
        .materialize(&[])
        .invoke(
            "grep",
            parse_json(&format!(
                r#"{{"path":{},"pattern":"managed-marker"}}"#,
                ycoding_schema::stringify_json(&JsonValue::String(
                    managed.to_string_lossy().as_ref().into()
                ))
            ))
            .unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert!(
        output
            .result
            .to_text()
            .as_str()
            .unwrap()
            .contains("managed-marker")
    );
    fs::remove_dir_all(outside).unwrap();
    fixture.cleanup();
}

#[cfg(unix)]
mod ripgrep_cancellation {
    use super::*;
    use std::{
        os::unix::fs::PermissionsExt,
        path::Path,
        time::{Duration, Instant},
    };
    use ycoding_ai::llm::ToolOutput;
    use ycoding_core::tools::registry::{DynamicTool, Registration};
    use ycoding_schema::tool_invocation::Status;

    fn register_search(
        fixture: &ToolFixture,
        registry: &ycoding_core::tools::registry::Registry,
        setup: &str,
    ) -> Registration {
        let binary = fixture.root.join("fixture-rg");
        fs::write(&binary, format!("#!/bin/sh\nwhile [ \"$1\" != -- ]; do shift; done\nshift\n{setup}\nprintf '%s\\n' \"$$\" > \"$1.pid\"\nexec /bin/sleep 3\n")).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        registry
            .register(
                vec![(
                    "grep".into(),
                    Arc::new(Search {
                        kind: Kind::Grep,
                        directory: fixture.root.clone(),
                        data: fixture.root.join("data"),
                        service: Arc::new(
                            search::Service::new(
                                &fixture.root,
                                search::Backend::Ripgrep {
                                    binary: binary.clone(),
                                },
                            )
                            .unwrap(),
                        ),
                        ripgrep: binary,
                        policy: fixture.policy.clone(),
                    }),
                )],
                Options::default(),
            )
            .unwrap()
    }

    fn pid(root: &Path, pattern: &str) -> Option<String> {
        let pid = fs::read_to_string(root.join(format!("{pattern}.pid"))).ok()?;
        let pid = pid.trim();
        (pid.parse::<u32>().ok()? > 1).then(|| pid.to_owned())
    }

    fn alive(pid: &str) -> bool {
        std::process::Command::new("/bin/kill")
            .args(["-0", pid])
            .output()
            .unwrap()
            .status
            .success()
    }

    async fn reaped(pids: &[String]) -> bool {
        tokio::time::timeout(Duration::from_secs(1), async {
            while pids.iter().any(|pid| alive(pid)) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok()
    }

    #[tokio::test]
    async fn execute_keeps_sibling_live_and_cancellation_reaps_both_silent_searches() {
        let fixture = ToolFixture::new();
        let registry = fixture.registry();
        let _search = register_search(&fixture, &registry, "");
        let _sibling = registry
            .register(
                vec![(
                    "sibling".into(),
                    Arc::new(DynamicTool::new(
                        "Return immediately",
                        parse_json(r#"{"type":"object"}"#).unwrap(),
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
        let materialized = registry.materialize(&[]);
        let mut context = fixture.context();
        let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
        context.invocation_settled = Some(Arc::new(move |receipt| {
            let _ = send.send(receipt);
            Box::pin(async { Ok(()) })
        }));
        let cancellation = context.cancellation.clone();
        let execution = materialized.invoke("execute", parse_json(r#"{"code":"return await Promise.all([tools.grep({pattern: 'first'}), tools.grep({pattern: 'second'}), tools.sibling({})])"}"#).unwrap(), context);
        let interrupt = async {
            let sibling = receive.recv().await.unwrap();
            let pids = loop {
                if let (Some(first), Some(second)) =
                    (pid(&fixture.root, "first"), pid(&fixture.root, "second"))
                {
                    break [first, second];
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            };
            let both_live = pids.iter().all(|pid| alive(pid));
            cancellation.cancel();
            (sibling, pids, both_live)
        };
        let start = Instant::now();
        let outcome = tokio::time::timeout(Duration::from_secs(2), async {
            tokio::join!(execution, interrupt)
        })
        .await;
        let elapsed = start.elapsed();
        let cleaned = match &outcome {
            Ok((_, (_, pids, _))) => reaped(pids).await,
            Err(_) => false,
        };
        fixture.cleanup();
        let (output, (sibling, _, both_live)) =
            outcome.unwrap_or_else(|_| panic!("execute and cancellation took {elapsed:?}"));
        assert!(
            elapsed < Duration::from_secs(2),
            "execute and cancellation took {elapsed:?}"
        );
        assert_eq!(sibling.name.as_str(), Some("sibling"));
        assert_eq!(sibling.status, Status::Completed);
        assert!(
            both_live,
            "both searches must still be alive when the sibling settles"
        );
        for _ in 0..2 {
            let search = receive.try_recv().unwrap();
            assert_eq!(search.name.as_str(), Some("grep"));
            assert_eq!(search.status, Status::Error);
        }
        assert!(
            output
                .unwrap()
                .result
                .to_text()
                .as_str()
                .unwrap()
                .contains("interrupted")
        );
        assert!(cleaned, "interrupted searches were not reaped");
        eprintln!("Sibling and both cancelled calls settled in {elapsed:?}");
    }

    #[tokio::test]
    async fn execute_deadline_reaps_search_that_closes_stdout_before_exit() {
        let fixture = ToolFixture::new();
        let registry = fixture.registry();
        let _search = register_search(&fixture, &registry, "exec 1>&-");
        let materialized = registry.materialize(&[]);
        let start = Instant::now();
        let expired = {
            let execution = materialized.invoke(
                "execute",
                parse_json(r#"{"code":"return await tools.grep({pattern: 'waiting'})"}"#).unwrap(),
                fixture.context(),
            );
            tokio::pin!(execution);
            let started = tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if let Some(child) = pid(&fixture.root, "waiting") {
                        break child;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            });
            let child = tokio::select! {
                child = started => child.ok(),
                _ = &mut execution => None,
            };
            match child {
                Some(child) => {
                    let started = Instant::now();
                    tokio::time::timeout(Duration::from_millis(300), execution)
                        .await
                        .is_err()
                        .then(|| (child, started.elapsed()))
                }
                None => None,
            }
        };
        let elapsed = start.elapsed();
        let cleaned = match &expired {
            Some((child, _)) => reaped(std::slice::from_ref(child)).await,
            None => false,
        };
        fixture.cleanup();
        let (_, deadline_elapsed) = expired.unwrap_or_else(|| {
            panic!("the deadline did not interrupt the child exit wait (elapsed {elapsed:?})")
        });
        assert!(
            deadline_elapsed < Duration::from_secs(1),
            "300 ms deadline settled in {deadline_elapsed:?}"
        );
        assert!(cleaned, "expired search was not reaped");
        eprintln!("300 ms deadline settled in {deadline_elapsed:?}; search was reaped");
    }
}
