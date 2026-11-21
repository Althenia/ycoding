use std::collections::BTreeMap;
use ycoding_core::dots::projection::{self, Read, Stage};
use ycoding_schema::{DomainDecode, JsonValue, form, parse_json, question};

fn answers(values: &[(&str, &str)]) -> BTreeMap<String, Vec<String>> {
    values
        .iter()
        .map(|(key, value)| (key.to_string(), vec![value.to_string()]))
        .collect()
}
fn stage(fields: &str) -> Stage {
    projection::form(
        "Synthetic",
        form::Fields::decode(&parse_json(fields).unwrap()).unwrap(),
    )
    .unwrap()
}
fn next(result: Read) -> Stage {
    match result {
        Read::Next(stage) => stage,
        _ => panic!("expected next stage"),
    }
}
fn value(result: Read) -> JsonValue {
    match result {
        Read::Answer(value) => value,
        _ => panic!("expected answer"),
    }
}

#[test]
fn single_choices_preserve_values_duplicate_labels_and_custom_text() {
    let stage = stage(
        r#"[{"type":"string","key":"choice","required":true,"custom":true,"options":[{"value":"a","label":" Alpha "},{"value":"b","label":"Alpha"}]}]"#,
    );
    assert_eq!(
        stage.questions[0]
            .options
            .as_ref()
            .unwrap()
            .iter()
            .map(|option| option.label.as_str())
            .collect::<Vec<_>>(),
        ["1. Alpha", "2. Alpha"]
    );
    assert_eq!(
        value(
            stage
                .read(&answers(&[("value", "2. Alpha"), ("action", "Continue")]))
                .unwrap()
        ),
        parse_json(r#"{"choice":"b"}"#).unwrap()
    );
    let custom = next(
        stage
            .read(&answers(&[("action", "Custom answer")]))
            .unwrap(),
    );
    assert_eq!(custom.questions[0].options, None);
    assert!(custom.questions[0].is_other);
    assert!(!custom.questions[0].is_secret);
    assert_eq!(
        value(
            custom
                .read(&answers(&[("value", "Alpha (1)"), ("action", "Continue")]))
                .unwrap()
        ),
        parse_json(r#"{"choice":"Alpha (1)"}"#).unwrap()
    );
}

#[test]
fn multiselect_requires_every_option_and_preserves_bounds_and_uniqueness() {
    let stage = stage(
        r#"[{"type":"multiselect","key":"selection","required":true,"minItems":1,"maxItems":2,"custom":true,"options":[{"value":"a","label":"Alpha"},{"value":"b","label":"Beta"}]}]"#,
    );
    assert!(
        stage
            .read(&answers(&[("option:0", "Select"), ("action", "Continue")]))
            .is_err()
    );
    assert!(
        stage
            .read(&answers(&[
                ("option:0", "Do not select"),
                ("option:1", "Do not select"),
                ("action", "Continue")
            ]))
            .is_err()
    );
    let custom = next(
        stage
            .read(&answers(&[
                ("option:0", "Select"),
                ("option:1", "Do not select"),
                ("action", "Custom answer"),
            ]))
            .unwrap(),
    );
    assert!(
        custom
            .read(&answers(&[("value", "a"), ("action", "Add value")]))
            .is_err()
    );
    let added = next(
        custom
            .read(&answers(&[("value", "custom"), ("action", "Add value")]))
            .unwrap(),
    );
    assert_eq!(
        value(added.read(&answers(&[("action", "Finish")])).unwrap()),
        parse_json(r#"{"selection":["a","custom"]}"#).unwrap()
    );
    let too_many = next(
        added
            .read(&answers(&[("value", "third"), ("action", "Add value")]))
            .unwrap(),
    );
    assert!(too_many.read(&answers(&[("action", "Finish")])).is_err());
}

#[test]
fn conditional_fields_preserve_false_integer_bounds_and_optional_absence() {
    let first = stage(
        r#"[{"type":"boolean","key":"enabled","required":true},{"type":"integer","key":"count","required":true,"minimum":2,"maximum":4,"when":[{"key":"enabled","op":"eq","value":true}]},{"type":"string","key":"note","minLength":2}]"#,
    );
    let number = next(
        first
            .read(&answers(&[("value", "True"), ("action", "Continue")]))
            .unwrap(),
    );
    for invalid in ["1", "5", "2.5", "Infinity", "", " 3 ", "0x3"] {
        assert!(
            number
                .read(&answers(&[("value", invalid), ("action", "Continue")]))
                .is_err(),
            "{invalid}"
        );
    }
    let note = next(
        number
            .read(&answers(&[("value", "3"), ("action", "Continue")]))
            .unwrap(),
    );
    assert!(
        note.read(&answers(&[("value", "x"), ("action", "Continue")]))
            .is_err()
    );
    assert_eq!(
        value(note.read(&answers(&[("action", "Skip field")])).unwrap()),
        parse_json(r#"{"enabled":true,"count":3}"#).unwrap()
    );
    let skipped = next(
        first
            .read(&answers(&[("value", "False"), ("action", "Continue")]))
            .unwrap(),
    );
    assert_eq!(skipped.questions[0].header, "note");
    assert_eq!(
        value(skipped.read(&answers(&[("action", "Skip field")])).unwrap()),
        parse_json(r#"{"enabled":false}"#).unwrap()
    );
}

#[test]
fn external_formats_unknown_answers_and_cancellation_remain_distinct() {
    let external =
        stage(r#"[{"type":"external","key":"visit","url":"https://example.test/setup"}]"#);
    assert!(
        external.questions[0]
            .question
            .contains("https://example.test/setup")
    );
    assert!(
        external
            .read(&answers(&[("action", "Skip field")]))
            .is_err()
    );
    assert_eq!(
        value(
            external
                .read(&answers(&[
                    ("value", "Acknowledged"),
                    ("action", "Continue")
                ]))
                .unwrap()
        ),
        parse_json(r#"{"visit":true}"#).unwrap()
    );
    let email = stage(
        r#"[{"type":"string","key":"email","format":"email","pattern":"@example\\.test$","maxLength":30,"required":true}]"#,
    );
    for invalid in ["not-an-email", "sample@other.test"] {
        assert!(
            email
                .read(&answers(&[("value", invalid), ("action", "Continue")]))
                .is_err()
        );
    }
    assert!(matches!(
        email
            .read(&answers(&[("action", "Cancel request")]))
            .unwrap(),
        Read::Cancel
    ));
    assert!(email.read(&answers(&[])).is_err());
    assert!(
        email
            .read(&answers(&[
                ("action", "Cancel request"),
                ("unknown", "value")
            ]))
            .is_err()
    );
}

#[test]
fn empty_and_exact_text_round_trip_without_optional_or_required_coercion() {
    let text = stage(r#"[{"type":"string","key":"text"}]"#);
    assert_eq!(
        value(text.read(&answers(&[("action", "Empty value")])).unwrap()),
        parse_json(r#"{"text":""}"#).unwrap()
    );
    assert_eq!(
        value(text.read(&answers(&[("action", "Skip field")])).unwrap()),
        parse_json("{}").unwrap()
    );
    let exact = next(text.read(&answers(&[("action", "Exact text")])).unwrap());
    assert_eq!(
        value(
            exact
                .read(&answers(&[
                    ("value", "\\scontent\\t\\n\\u263a\\\\"),
                    ("action", "Continue")
                ]))
                .unwrap()
        ),
        parse_json(r#"{"text":" content\t\n☺\\"}"#).unwrap()
    );
    for invalid in [" content ", "\\x", "\\u123", "\\uGGGG"] {
        assert!(
            exact
                .read(&answers(&[("value", invalid), ("action", "Continue")]))
                .is_err()
        );
    }
    let required = stage(r#"[{"type":"string","key":"text","required":true}]"#);
    assert!(
        required
            .read(&answers(&[("action", "Empty value")]))
            .is_err()
    );
}

#[test]
fn questions_preserve_skip_single_multi_and_free_text() {
    let questions = Vec::<question::Info>::decode(&parse_json(r#"[{"header":"Single","question":"Choose one","options":[{"label":"A","description":"Alpha"}],"custom":false},{"header":"Multiple","question":"Choose several","options":[{"label":"B","description":"Beta"},{"label":"C","description":"Gamma"}],"multiple":true,"custom":false}]"#).unwrap()).unwrap();
    let first = projection::questions(&questions).unwrap();
    let second = next(first.read(&answers(&[("action", "Skip field")])).unwrap());
    assert_eq!(
        value(
            second
                .read(&answers(&[
                    ("option:0", "Select"),
                    ("option:1", "Select"),
                    ("action", "Continue")
                ]))
                .unwrap()
        ),
        parse_json(r#"[[],["B","C"]]"#).unwrap()
    );
    let free = Vec::<question::Info>::decode(
        &parse_json(r#"[{"header":"Free text","question":"Explain","options":[]}]"#).unwrap(),
    )
    .unwrap();
    let free = projection::questions(&free).unwrap();
    assert_eq!(free.questions[0].options, None);
    assert_eq!(
        value(
            free.read(&answers(&[("value", "Answer"), ("action", "Continue")]))
                .unwrap()
        ),
        parse_json(r#"[["Answer"]]"#).unwrap()
    );
}

#[test]
fn child_answer_text_data_cancellation_and_missing_components_are_distinct() {
    let first = projection::child("Explain the blocker");
    assert!(matches!(
        first
            .read(&answers(&[("action", "Cancel request")]))
            .unwrap(),
        Read::Cancel
    ));
    let data = next(
        first
            .read(&answers(&[
                ("value", "Synthetic explanation"),
                ("action", "Continue"),
            ]))
            .unwrap(),
    );
    assert_eq!(
        value(data.read(&answers(&[("action", "Skip field")])).unwrap()),
        parse_json(r#"{"text":"Synthetic explanation"}"#).unwrap()
    );
    let only_data = next(first.read(&answers(&[("action", "Skip field")])).unwrap());
    assert_eq!(
        value(
            only_data
                .read(&answers(&[
                    ("value", "{\"answer\":true}"),
                    ("action", "Continue")
                ]))
                .unwrap()
        ),
        parse_json(r#"{"data":{"answer":true}}"#).unwrap()
    );
    assert!(
        only_data
            .read(&answers(&[("action", "Skip field")]))
            .is_err()
    );
    assert!(
        only_data
            .read(&answers(&[("value", "not json"), ("action", "Continue")]))
            .is_err()
    );
}
