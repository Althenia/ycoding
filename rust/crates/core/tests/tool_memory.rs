include!("tool_fixture.rs");

use std::sync::Arc;
use ycoding_ai::llm::ToolResultValue;
use ycoding_core::{
    resources::memory::{Limits, Options as MemoryOptions, Repository, Service as MemoryService},
    tools::{
        builtin::memory::Memory,
        registry::{Options, Tool},
    },
};
use ycoding_schema::{JsonValue, parse_json};

fn register_memory(
    fixture: &ToolFixture,
) -> (
    ycoding_core::tools::registry::Registry,
    ycoding_core::tools::registry::Registration,
) {
    std::fs::create_dir_all(fixture.root.join(".git")).unwrap();
    let service = Arc::new(
        MemoryService::new(MemoryOptions {
            directory: fixture.root.clone(),
            home: fixture.root.clone(),
            data: fixture.root.join("data"),
            repository: Some(Repository {
                directory: fixture.root.clone(),
                common_directory: fixture.root.join(".git"),
                worktrees: vec![fixture.root.clone()],
            }),
            limits: Limits::default(),
        })
        .unwrap(),
    );
    let registry = fixture.registry();
    let registration = registry
        .register(
            vec![(
                "memory".into(),
                Arc::new(Memory {
                    service,
                    policy: fixture.policy.clone(),
                }) as Arc<dyn Tool>,
            )],
            Options::direct(),
        )
        .unwrap();
    (registry, registration)
}

#[tokio::test]
async fn status_and_vacuum_preview_are_read_only() {
    let fixture = ToolFixture::new();
    let (registry, _registration) = register_memory(&fixture);
    let definitions = registry.materialize(&[]).definitions;
    assert_eq!(definitions[0].name.to_utf8().unwrap(), "memory");
    let JsonValue::Object(input_schema) = &definitions[0].input_schema else {
        panic!("expected input schema object")
    };
    let Some(JsonValue::Array(inputs)) = input_schema.get(&"oneOf".into()) else {
        panic!("expected action-specific input schema")
    };
    assert_eq!(inputs.len(), 11);
    let Some(JsonValue::Object(output_schema)) = definitions[0].output_schema.as_ref() else {
        panic!("expected output schema object")
    };
    let Some(JsonValue::Array(outputs)) = output_schema.get(&"oneOf".into()) else {
        panic!("expected action-specific output schema")
    };
    assert_eq!(outputs.len(), 11);
    let status = registry
        .materialize(&[])
        .invoke(
            "memory",
            parse_json(r#"{"action":"status"}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert!(matches!(status.result, ToolResultValue::Text(_)));
    assert!(!fixture.root.join("data").exists());
    let preview = registry
        .materialize(&[])
        .invoke(
            "memory",
            parse_json(r#"{"action":"vacuum"}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert!(matches!(preview.result, ToolResultValue::Text(_)));
    assert!(!fixture.root.join("data").exists());
    fixture.cleanup();
}

#[tokio::test]
async fn write_read_delete_trash_restore_and_purge_use_digest_fences() {
    let fixture = ToolFixture::new();
    let (registry, _registration) = register_memory(&fixture);
    let content = "---\ntype: Decision\ntitle: Build guide\n---\nUse the local build command.\n";
    let written = registry
        .materialize(&[])
        .invoke(
            "memory",
            parse_json(&format!(
                "{{\"action\":\"write\",\"id\":\"build/guide\",\"content\":{}}}",
                ycoding_schema::stringify_json(&JsonValue::String(content.into()))
            ))
            .unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    let JsonValue::Object(written) = written.output.unwrap().structured else {
        panic!("expected write result")
    };
    let Some(JsonValue::String(digest)) = written.get(&"digest".into()) else {
        panic!("expected content digest")
    };
    let digest = digest.to_utf8().unwrap();
    let list = registry
        .materialize(&[])
        .invoke(
            "memory",
            parse_json(r#"{"action":"list"}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    let JsonValue::Object(list) = list.output.unwrap().structured else {
        panic!("expected list result")
    };
    let Some(JsonValue::Array(concepts)) = list.get(&"concepts".into()) else {
        panic!("expected concepts")
    };
    assert_eq!(concepts.len(), 1);
    let search = registry
        .materialize(&[])
        .invoke(
            "memory",
            parse_json(r#"{"action":"search","query":"local build"}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    let JsonValue::Object(search) = search.output.unwrap().structured else {
        panic!("expected search result")
    };
    let Some(JsonValue::Array(hits)) = search.get(&"hits".into()) else {
        panic!("expected search hits")
    };
    assert_eq!(hits.len(), 1);
    let graph = registry
        .materialize(&[])
        .invoke(
            "memory",
            parse_json(r#"{"action":"graph"}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    let JsonValue::Object(graph) = graph.output.unwrap().structured else {
        panic!("expected graph result")
    };
    assert!(fixture.root.join("data").join("memory").exists());
    assert!(graph.get(&"path".into()).is_some());
    let read = registry
        .materialize(&[])
        .invoke(
            "memory",
            parse_json(r#"{"action":"read","id":"build/guide"}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    let JsonValue::Object(read) = read.output.unwrap().structured else {
        panic!("expected read result")
    };
    assert_eq!(
        read.get(&"content".into()),
        Some(&JsonValue::String(content.into()))
    );
    let deleted = registry
        .materialize(&[])
        .invoke(
            "memory",
            parse_json(&format!(
                r#"{{"action":"delete","id":"build/guide","expectedDigest":"{digest}"}}"#
            ))
            .unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    let JsonValue::Object(deleted) = deleted.output.unwrap().structured else {
        panic!("expected delete result")
    };
    let Some(JsonValue::String(trash_id)) = deleted.get(&"trashID".into()) else {
        panic!("expected trash id")
    };
    let trash_id = trash_id.to_utf8().unwrap();
    let trash = registry
        .materialize(&[])
        .invoke(
            "memory",
            parse_json(r#"{"action":"trash"}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    let JsonValue::Object(trash) = trash.output.unwrap().structured else {
        panic!("expected trash listing")
    };
    let Some(JsonValue::Array(entries)) = trash.get(&"entries".into()) else {
        panic!("expected trash entries")
    };
    assert_eq!(entries.len(), 1);
    let restored = registry
        .materialize(&[])
        .invoke(
            "memory",
            parse_json(&format!(
                r#"{{"action":"restore","trashID":"{trash_id}","expectedDigest":"{digest}"}}"#
            ))
            .unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert!(matches!(restored.result, ToolResultValue::Text(_)));
    let deleted_again = registry
        .materialize(&[])
        .invoke(
            "memory",
            parse_json(&format!(
                r#"{{"action":"delete","id":"build/guide","expectedDigest":"{digest}"}}"#
            ))
            .unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    let JsonValue::Object(deleted_again) = deleted_again.output.unwrap().structured else {
        panic!("expected second delete result")
    };
    let Some(JsonValue::String(trash_id)) = deleted_again.get(&"trashID".into()) else {
        panic!("expected second trash id")
    };
    let purged = registry
        .materialize(&[])
        .invoke(
            "memory",
            parse_json(&format!(
                r#"{{"action":"purge","trashID":"{}","expectedDigest":"{digest}"}}"#,
                trash_id.to_utf8().unwrap()
            ))
            .unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert!(matches!(purged.result, ToolResultValue::Text(_)));
    let preview = registry
        .materialize(&[])
        .invoke(
            "memory",
            parse_json(r#"{"action":"vacuum"}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    let JsonValue::Object(preview) = preview.output.unwrap().structured else {
        panic!("expected vacuum preview")
    };
    let Some(JsonValue::String(digest)) = preview.get(&"digest".into()) else {
        panic!("expected vacuum digest")
    };
    let digest = digest.to_utf8().unwrap();
    let applied = registry
        .materialize(&[])
        .invoke(
            "memory",
            parse_json(&format!(
                r#"{{"action":"vacuum","dryRun":false,"expectedDigest":"{digest}"}}"#
            ))
            .unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert!(matches!(applied.result, ToolResultValue::Text(_)));
    fixture.cleanup();
}

#[tokio::test]
async fn memory_write_permission_denial_preserves_storage() {
    let fixture = ToolFixture::new();
    fixture.deny("memory_write", "*");
    let (registry, _registration) = register_memory(&fixture);
    let result = registry
        .materialize(&[])
        .invoke(
            "memory",
            parse_json(r#"{"action":"write","id":"build/guide","content":"---\ntype: Decision\n---\nbody\n"}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert!(matches!(result.result, ToolResultValue::Error(_)));
    assert!(!fixture.root.join("data").exists());
    fixture.cleanup();
}
