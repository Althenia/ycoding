use ycoding_core::platform::diff::{
    Change, Hunk, StructuredPatch, create_two_files_patch, diff_lines, format_patch,
    structured_patch,
};
use ycoding_schema::{JsonValue, parse_json};

fn field<'a>(object: &'a JsonValue, name: &str) -> &'a JsonValue {
    let JsonValue::Object(object) = object else {
        panic!("expected object")
    };
    object.get(&name.into()).unwrap()
}

fn string(value: &JsonValue) -> String {
    let JsonValue::String(value) = value else {
        panic!("expected string")
    };
    value.to_utf8().unwrap()
}

fn number(value: &JsonValue) -> usize {
    let JsonValue::Number(value) = value else {
        panic!("expected number")
    };
    *value as usize
}

fn boolean(value: &JsonValue) -> bool {
    let JsonValue::Bool(value) = value else {
        panic!("expected bool")
    };
    *value
}

fn array(value: &JsonValue) -> &[JsonValue] {
    let JsonValue::Array(value) = value else {
        panic!("expected array")
    };
    value
}

#[test]
fn line_diffs_and_patch_format_match_npm_diff_goldens() {
    let cases = parse_json(include_str!("fixtures/jsdiff-goldens.json")).unwrap();
    for case in array(&cases) {
        let id = string(field(case, "id"));
        let old = string(field(case, "old"));
        let new = string(field(case, "next"));
        let file = format!("edit-{id}.txt");
        let expected_changes = array(field(case, "chunks"))
            .iter()
            .map(|change| Change {
                count: number(field(change, "count")),
                added: boolean(field(change, "added")),
                removed: boolean(field(change, "removed")),
                value: string(field(change, "value")),
            })
            .collect::<Vec<_>>();
        assert_eq!(diff_lines(&old, &new), expected_changes, "diffLines: {id}");

        let expected = field(case, "structured");
        let expected_hunks = array(field(expected, "hunks"))
            .iter()
            .map(|hunk| Hunk {
                old_start: number(field(hunk, "oldStart")),
                old_lines: number(field(hunk, "oldLines")),
                new_start: number(field(hunk, "newStart")),
                new_lines: number(field(hunk, "newLines")),
                lines: array(field(hunk, "lines")).iter().map(string).collect(),
            })
            .collect::<Vec<_>>();
        let patch = structured_patch(&file, &file, &old, &new, Some(""), Some(""), 4);
        assert_eq!(
            patch,
            StructuredPatch {
                old_file_name: string(field(expected, "oldFileName")),
                new_file_name: string(field(expected, "newFileName")),
                old_header: Some(string(field(expected, "oldHeader"))),
                new_header: Some(string(field(expected, "newHeader"))),
                hunks: expected_hunks,
            },
            "structuredPatch: {id}"
        );
        assert_eq!(
            format_patch(&patch),
            string(field(case, "formatted")),
            "formatPatch: {id}"
        );
        assert_eq!(
            create_two_files_patch(&file, &file, &old, &new),
            string(field(case, "patch")),
            "createTwoFilesPatch: {id}"
        );
    }
}
