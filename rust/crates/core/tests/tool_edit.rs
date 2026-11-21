include!("tool_fixture.rs");

use std::sync::Arc;
use ycoding_ai::llm::ToolResultValue;
use ycoding_core::tools::{
    builtin::edit::Edit,
    registry::{Options, Tool},
};
use ycoding_schema::{JsonValue, parse_json, stringify_json};

fn register_edit(
    fixture: &ToolFixture,
) -> (
    ycoding_core::tools::registry::Registry,
    ycoding_core::tools::registry::Registration,
) {
    let registry = fixture.registry();
    let registration = registry
        .register(
            vec![(
                "edit".into(),
                Arc::new(Edit {
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
async fn replaces_unique_exact_text_and_rejects_ambiguous_matches_without_writing() {
    let fixture = ToolFixture::new();
    let target = fixture.root.join("match.txt");
    std::fs::write(&target, "before\nrest\n").unwrap();
    let (registry, _registration) = register_edit(&fixture);
    let materialized = registry.materialize(&[]);
    assert_eq!(materialized.definitions[0].name.to_utf8().unwrap(), "edit");
    assert_eq!(
        materialized.definitions[0].description.to_utf8().unwrap(),
        "Replace exact text in one file. Relative paths resolve within the active Location. Absolute paths inside the Location are accepted. Explicit external absolute paths require external_directory approval before edit approval."
    );
    assert_eq!(
        materialized.definitions[0].input_schema,
        parse_json(r#"{"type":"object","properties":{"path":{"type":"string","description":"File path to edit. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval."},"oldString":{"type":"string","description":"Exact text to replace"},"newString":{"type":"string","description":"Replacement text, which must differ from oldString"},"replaceAll":{"anyOf":[{"type":"boolean"},{"type":"null"}],"description":"Replace all exact occurrences of oldString (default false)"}},"required":["path","oldString","newString"],"additionalProperties":false}"#).unwrap()
    );
    assert_eq!(
        materialized.definitions[0].output_schema,
        Some(parse_json(r#"{"type":"object","properties":{"files":{"type":"array","items":{"type":"object","properties":{"file":{"type":"string"},"patch":{"type":"string"},"additions":{"type":"integer","minimum":0},"deletions":{"type":"integer","minimum":0},"status":{"type":"string","enum":["added","deleted","modified"]}},"required":["file","patch","additions","deletions","status"],"additionalProperties":false}},"replacements":{"type":"number"}},"required":["files","replacements"],"additionalProperties":false}"#).unwrap())
    );
    let context = fixture.context();
    let output = materialized
        .invoke(
            "edit",
            parse_json(r#"{"path":"match.txt","oldString":"before","newString":"after"}"#).unwrap(),
            context.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        output.result,
        ToolResultValue::Text(JsonValue::String(
            "Edited file successfully: match.txt\nReplacements: 1\n```diff\n-before\n+after\n```"
                .into()
        ))
    );
    assert_eq!(
        output.output.unwrap().structured,
        parse_json(r#"{"files":[{"file":"match.txt","patch":"Index: match.txt\n===================================================================\n--- match.txt\n+++ match.txt\n@@ -1,2 +1,2 @@\n-before\n+after\n rest\n","additions":1,"deletions":1,"status":"modified"}],"replacements":1}"#).unwrap()
    );
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "after\nrest\n");
    std::fs::write(&target, "same same").unwrap();
    let ambiguous = registry
        .materialize(&[])
        .invoke(
            "edit",
            parse_json(r#"{"path":"match.txt","oldString":"same","newString":"after"}"#).unwrap(),
            context,
        )
        .await
        .unwrap();
    assert_eq!(
        ambiguous.result,
        ToolResultValue::Error(JsonValue::String("Found multiple exact matches for oldString. Provide more surrounding context or set replaceAll to true.".into()))
    );
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "same same");
    fixture.cleanup();
}

#[tokio::test]
async fn replace_all_preserves_bom_and_crlf_and_permission_denial_has_no_effect() {
    let fixture = ToolFixture::new();
    let target = fixture.root.join("match.txt");
    std::fs::write(&target, "\u{feff}same\r\nmiddle\r\nsame\r\n").unwrap();
    let (registry, _registration) = register_edit(&fixture);
    let output = registry
        .materialize(&[])
        .invoke(
            "edit",
            parse_json(
                r#"{"path":"match.txt","oldString":"same","newString":"after","replaceAll":true}"#,
            )
            .unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert!(matches!(output.result, ToolResultValue::Text(_)));
    let JsonValue::Object(structured) = output.output.unwrap().structured else {
        panic!("expected structured output")
    };
    let Some(JsonValue::Array(files)) = structured.get(&"files".into()) else {
        panic!("expected file diff")
    };
    let JsonValue::Object(file) = &files[0] else {
        panic!("expected file diff object")
    };
    assert_eq!(
        file.get(&"additions".into()),
        Some(&parse_json("2").unwrap())
    );
    assert_eq!(
        file.get(&"deletions".into()),
        Some(&parse_json("2").unwrap())
    );
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "\u{feff}after\r\nmiddle\r\nafter\r\n"
    );
    fixture.deny("edit", "*");
    let denied_target = fixture.root.join("denied.txt");
    std::fs::write(&denied_target, "secret").unwrap();
    let denied = registry
        .materialize(&[])
        .invoke(
            "edit",
            parse_json(r#"{"path":"denied.txt","oldString":"secret","newString":"changed"}"#)
                .unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    let missing_denied = registry
        .materialize(&[])
        .invoke(
            "edit",
            parse_json(r#"{"path":"denied.txt","oldString":"not present","newString":"changed"}"#)
                .unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert_eq!(
        denied.result,
        ToolResultValue::Error(JsonValue::String("Unable to edit denied.txt".into()))
    );
    assert_eq!(missing_denied.result, denied.result);
    assert_eq!(std::fs::read_to_string(&denied_target).unwrap(), "secret");
    fixture.cleanup();
}

#[tokio::test]
async fn rejects_no_op_empty_and_missing_matches_without_modifying_file() {
    let fixture = ToolFixture::new();
    let target = fixture.root.join("match.txt");
    std::fs::write(&target, "same").unwrap();
    let (registry, _registration) = register_edit(&fixture);
    for (input, message) in [
        (
            r#"{"path":"match.txt","oldString":"same","newString":"same"}"#,
            "No changes to apply: oldString and newString are identical.",
        ),
        (
            r#"{"path":"match.txt","oldString":"","newString":"after"}"#,
            "oldString must not be empty. Use write to create or overwrite a file.",
        ),
        (
            r#"{"path":"match.txt","oldString":"missing","newString":"after"}"#,
            "Could not find oldString in the file. It must match exactly, including whitespace and indentation.",
        ),
    ] {
        assert_eq!(
            registry
                .materialize(&[])
                .invoke("edit", parse_json(input).unwrap(), fixture.context())
                .await
                .unwrap()
                .result,
            ToolResultValue::Error(JsonValue::String(message.into()))
        );
    }
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "same");
    fixture.cleanup();
}

#[tokio::test]
async fn edit_patch_matches_npm_diff_for_distant_hunks_and_unterminated_lines() {
    let fixture = ToolFixture::new();
    let (registry, _registration) = register_edit(&fixture);
    let JsonValue::Array(cases) = parse_json(include_str!("fixtures/jsdiff-goldens.json")).unwrap()
    else {
        panic!("expected diff golden cases")
    };
    for id in ["distant", "no-newline"] {
        let Some(JsonValue::Object(case)) = cases.iter().find(|case| {
            matches!(case, JsonValue::Object(value) if value.get(&"id".into()) == Some(&JsonValue::String(id.into())))
        }) else {
            panic!("missing diff golden case {id}")
        };
        let value = |field: &str| match case.get(&field.into()) {
            Some(JsonValue::String(value)) => value.to_utf8().unwrap(),
            _ => panic!("missing diff golden field {field}"),
        };
        let path = format!("edit-{id}.txt");
        std::fs::write(fixture.root.join(&path), value("old")).unwrap();
        let input = parse_json(&format!(
            "{{\"path\":{},\"oldString\":{},\"newString\":{}}}",
            stringify_json(&JsonValue::String(path.into())),
            stringify_json(&JsonValue::String(value("old").into())),
            stringify_json(&JsonValue::String(value("next").into()))
        ))
        .unwrap();
        let output = registry
            .materialize(&[])
            .invoke("edit", input, fixture.context())
            .await
            .unwrap();
        let JsonValue::Object(structured) = output.output.unwrap().structured else {
            panic!("expected structured edit output")
        };
        let Some(JsonValue::Array(files)) = structured.get(&"files".into()) else {
            panic!("expected file diff")
        };
        let JsonValue::Object(file) = &files[0] else {
            panic!("expected file diff object")
        };
        let Some(JsonValue::String(patch)) = file.get(&"patch".into()) else {
            panic!("expected patch text")
        };
        assert_eq!(patch.to_utf8().unwrap(), value("patch"));
    }
    fixture.cleanup();
}
