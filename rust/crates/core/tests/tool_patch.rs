include!("tool_fixture.rs");

use std::sync::Arc;
use ycoding_ai::llm::ToolResultValue;
use ycoding_core::tools::{
    builtin::patch::Patch,
    registry::{Options, Tool},
};
use ycoding_schema::{JsonValue, parse_json};

fn register_patch(
    fixture: &ToolFixture,
) -> (
    ycoding_core::tools::registry::Registry,
    ycoding_core::tools::registry::Registration,
) {
    let registry = fixture.registry();
    let registration = registry
        .register(
            vec![(
                "patch".into(),
                Arc::new(Patch {
                    paths: fixture.paths(),
                    files: Arc::new(
                        ycoding_core::platform::filesystem::mutation::Service::default(),
                    ),
                    policy: fixture.policy.clone(),
                }) as Arc<dyn Tool>,
            )],
            Options::direct(),
        )
        .unwrap();
    (registry, registration)
}

#[tokio::test]
async fn sequentially_applies_add_update_and_delete_and_returns_diffs() {
    let fixture = ToolFixture::new();
    std::fs::write(fixture.root.join("update.txt"), "before\n").unwrap();
    std::fs::write(fixture.root.join("remove.txt"), "remove\n").unwrap();
    let (registry, _registration) = register_patch(&fixture);
    let definitions = registry.materialize(&[]).definitions;
    assert_eq!(definitions[0].name.to_utf8().unwrap(), "patch");
    assert!(
        definitions[0]
            .description
            .to_utf8()
            .unwrap()
            .starts_with("Use the `patch` tool")
    );
    assert_eq!(
        definitions[0].input_schema,
        parse_json(r#"{"type":"object","properties":{"patchText":{"type":"string","description":"The full patch text describing add, update, and delete operations"}},"required":["patchText"],"additionalProperties":false}"#).unwrap()
    );
    assert_eq!(
        definitions[0].output_schema,
        Some(parse_json(r#"{"type":"object","properties":{"applied":{"type":"array","items":{"type":"object","properties":{"type":{"type":"string","enum":["add","update","delete"]},"resource":{"type":"string"},"target":{"type":"string"}},"required":["type","resource","target"],"additionalProperties":false}},"files":{"type":"array","items":{"type":"object","properties":{"file":{"type":"string"},"patch":{"type":"string"},"additions":{"type":"integer","minimum":0},"deletions":{"type":"integer","minimum":0},"status":{"type":"string","enum":["added","deleted","modified"]}},"required":["file","patch","additions","deletions","status"],"additionalProperties":false}}},"required":["applied","files"],"additionalProperties":false}"#).unwrap())
    );
    let result = registry
        .materialize(&[])
        .invoke(
            "patch",
            parse_json("{\"patchText\":\"*** Begin Patch\\n*** Add File: nested/new.txt\\n+created\\n*** Update File: update.txt\\n@@\\n-before\\n+after\\n*** Delete File: remove.txt\\n*** End Patch\"}").unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert_eq!(
        result.result,
        ToolResultValue::Text(JsonValue::String(
            "Success. Updated the following files:\nA nested/new.txt\nM update.txt\nD remove.txt"
                .into()
        ))
    );
    let JsonValue::Object(structured) = result.output.unwrap().structured else {
        panic!("expected structured patch output")
    };
    let Some(JsonValue::Array(applied)) = structured.get(&"applied".into()) else {
        panic!("expected applied changes")
    };
    assert_eq!(applied.len(), 3);
    let Some(JsonValue::Array(files)) = structured.get(&"files".into()) else {
        panic!("expected file diffs")
    };
    assert_eq!(files.len(), 3);
    let JsonValue::Object(deleted) = &files[2] else {
        panic!("expected delete diff")
    };
    assert_eq!(
        deleted.get(&"deletions".into()),
        Some(&parse_json("2").unwrap())
    );
    let JsonValue::String(patch) = deleted.get(&"patch".into()).unwrap() else {
        panic!("expected delete patch")
    };
    assert!(patch.to_utf8().unwrap().contains("-remove"));
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("nested/new.txt")).unwrap(),
        "created\n"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("update.txt")).unwrap(),
        "after\n"
    );
    assert!(!fixture.root.join("remove.txt").exists());
    fixture.cleanup();
}

#[tokio::test]
async fn moves_updates_and_overwrites_the_destination() {
    let fixture = ToolFixture::new();
    std::fs::write(fixture.root.join("old.txt"), "before\n").unwrap();
    std::fs::write(fixture.root.join("new.txt"), "existing\n").unwrap();
    let (registry, _registration) = register_patch(&fixture);
    let result = registry
        .materialize(&[])
        .invoke(
            "patch",
            parse_json(r#"{"patchText":"*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-before\n+after\n*** End Patch"}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert!(matches!(result.result, ToolResultValue::Text(_)));
    assert!(!fixture.root.join("old.txt").exists());
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("new.txt")).unwrap(),
        "after\n"
    );
    fixture.cleanup();
}

#[tokio::test]
async fn prevalidates_all_hunks_and_rejects_invalid_input_without_mutation() {
    let fixture = ToolFixture::new();
    let (registry, _registration) = register_patch(&fixture);
    for (patch_text, expected) in [
        ("", "patchText is required"),
        ("invalid patch", "patch verification failed"),
        (
            "*** Begin Patch\n*** End Patch",
            "patch rejected: empty patch",
        ),
        (
            "*** Begin Patch\n*** Add File: first.txt\n+first\n*** Update File: missing.txt\n@@\n-before\n+after\n*** End Patch",
            "Failed to read file to update",
        ),
    ] {
        let value = ycoding_schema::stringify_json(&JsonValue::String(patch_text.into()));
        let result = registry
            .materialize(&[])
            .invoke(
                "patch",
                parse_json(&format!("{{\"patchText\":{value}}}")).unwrap(),
                fixture.context(),
            )
            .await
            .unwrap();
        let ToolResultValue::Error(JsonValue::String(message)) = result.result else {
            panic!("expected patch error")
        };
        assert!(message.to_utf8().unwrap().contains(expected));
    }
    assert!(!fixture.root.join("first.txt").exists());
    fixture.cleanup();
}

#[tokio::test]
async fn edit_permission_denial_has_no_side_effects() {
    let fixture = ToolFixture::new();
    std::fs::write(fixture.root.join("file.txt"), "before\n").unwrap();
    fixture.deny("edit", "*");
    let (registry, _registration) = register_patch(&fixture);
    let result = registry
        .materialize(&[])
        .invoke(
            "patch",
            parse_json(r#"{"patchText":"*** Begin Patch\n*** Update File: file.txt\n@@\n-before\n+after\n*** End Patch"}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert!(matches!(result.result, ToolResultValue::Error(_)));
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("file.txt")).unwrap(),
        "before\n"
    );
    fixture.cleanup();
}

#[tokio::test]
async fn updates_empty_files_insert_only_and_multiple_chunks() {
    let fixture = ToolFixture::new();
    std::fs::write(fixture.root.join("empty.txt"), "").unwrap();
    std::fs::write(fixture.root.join("insert.txt"), "alpha\nomega\n").unwrap();
    std::fs::write(fixture.root.join("multi.txt"), "a\nb\nc\nd\n").unwrap();
    let (registry, _registration) = register_patch(&fixture);
    for patch in [
        "*** Begin Patch\n*** Update File: empty.txt\n@@\n+First line\n*** End Patch",
        "*** Begin Patch\n*** Update File: insert.txt\n@@\n alpha\n+beta\n omega\n*** End Patch",
        "*** Begin Patch\n*** Update File: multi.txt\n@@\n-b\n+B\n@@\n-d\n+D\n*** End Patch",
    ] {
        let input = parse_json(&format!(
            "{{\"patchText\":{}}}",
            ycoding_schema::stringify_json(&JsonValue::String(patch.into()))
        ))
        .unwrap();
        assert!(matches!(
            registry
                .materialize(&[])
                .invoke("patch", input, fixture.context())
                .await
                .unwrap()
                .result,
            ToolResultValue::Text(_)
        ));
    }
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("empty.txt")).unwrap(),
        "First line\n"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("insert.txt")).unwrap(),
        "alpha\nbeta\nomega\n"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("multi.txt")).unwrap(),
        "a\nB\nc\nD\n"
    );
    fixture.cleanup();
}

#[tokio::test]
async fn preserves_bom_and_avoids_diffing_the_bom_as_file_content() {
    let fixture = ToolFixture::new();
    let target = fixture.root.join("example.cs");
    std::fs::write(&target, "\u{feff}using System;\n\nclass Test {}\n").unwrap();
    let (registry, _registration) = register_patch(&fixture);
    let result = registry
        .materialize(&[])
        .invoke(
            "patch",
            parse_json(r#"{"patchText":"*** Begin Patch\n*** Update File: example.cs\n@@\n class Test {}\n+class Next {}\n*** End Patch"}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    let JsonValue::Object(structured) = result.output.unwrap().structured else {
        panic!("expected structured patch output")
    };
    let Some(JsonValue::Array(files)) = structured.get(&"files".into()) else {
        panic!("expected file diffs")
    };
    let JsonValue::Object(file) = &files[0] else {
        panic!("expected patch diff")
    };
    let Some(JsonValue::String(patch)) = file.get(&"patch".into()) else {
        panic!("expected patch text")
    };
    let patch = patch.to_utf8().unwrap();
    assert!(!patch.contains('\u{feff}'));
    assert!(!patch.contains("-using System;"));
    assert!(!patch.contains("+using System;"));
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "\u{feff}using System;\n\nclass Test {}\nclass Next {}\n"
    );
    fixture.cleanup();
}

#[tokio::test]
async fn external_paths_require_permission_before_they_can_be_patched() {
    let fixture = ToolFixture::new();
    let outside = fixture.root.with_file_name(format!(
        "{}_external_patch.txt",
        fixture.root.file_name().unwrap().to_string_lossy()
    ));
    std::fs::write(&outside, "before\n").unwrap();
    fixture.deny("external_directory", "*");
    let (registry, _registration) = register_patch(&fixture);
    let input = parse_json(&format!(
        "{{\"patchText\":{}}}",
        ycoding_schema::stringify_json(&JsonValue::String(
            format!(
                "*** Begin Patch\n*** Update File: {}\n@@\n-before\n+after\n*** End Patch",
                outside.display()
            )
            .into()
        ))
    ))
    .unwrap();
    let result = registry
        .materialize(&[])
        .invoke("patch", input, fixture.context())
        .await
        .unwrap();
    assert!(matches!(result.result, ToolResultValue::Error(_)));
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "before\n");
    std::fs::remove_file(outside).unwrap();
    fixture.cleanup();
}

#[tokio::test]
async fn parses_heredoc_wrappers_before_applying_files() {
    let fixture = ToolFixture::new();
    let (registry, _registration) = register_patch(&fixture);
    for (name, patch) in [
        (
            "with-cat.txt",
            "cat <<'EOF'\n*** Begin Patch\n*** Add File: with-cat.txt\n+with cat\n*** End Patch\nEOF",
        ),
        (
            "without-cat.txt",
            "<<EOF\n*** Begin Patch\n*** Add File: without-cat.txt\n+without cat\n*** End Patch\nEOF",
        ),
    ] {
        let input = parse_json(&format!(
            "{{\"patchText\":{}}}",
            ycoding_schema::stringify_json(&JsonValue::String(patch.into()))
        ))
        .unwrap();
        assert!(matches!(
            registry
                .materialize(&[])
                .invoke("patch", input, fixture.context())
                .await
                .unwrap()
                .result,
            ToolResultValue::Text(_)
        ));
        assert_eq!(
            std::fs::read_to_string(fixture.root.join(name)).unwrap(),
            if name == "with-cat.txt" {
                "with cat\n"
            } else {
                "without cat\n"
            }
        );
    }
    fixture.cleanup();
}

#[cfg(unix)]
#[tokio::test]
async fn moves_a_symlink_without_modifying_its_target() {
    let fixture = ToolFixture::new();
    let target = fixture.root.join("target.txt");
    let link = fixture.root.join("link.txt");
    let moved = fixture.root.join("moved.txt");
    std::fs::write(&target, "before\n").unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let (registry, _registration) = register_patch(&fixture);
    let result = registry
        .materialize(&[])
        .invoke(
            "patch",
            parse_json(r#"{"patchText":"*** Begin Patch\n*** Update File: link.txt\n*** Move to: moved.txt\n@@\n-before\n+after\n*** End Patch"}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert!(matches!(result.result, ToolResultValue::Text(_)));
    assert!(!link.exists());
    assert_eq!(std::fs::read_to_string(target).unwrap(), "before\n");
    assert_eq!(std::fs::read_to_string(moved).unwrap(), "after\n");
    fixture.cleanup();
}
