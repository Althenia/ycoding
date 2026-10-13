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
