use ycoding_core::resources::discovery::markdown;
use ycoding_schema::{JsonValue, parse_json};
#[test]
fn frontmatter_matches_literal_gray_matter_and_js_yaml_corpus() {
    let JsonValue::Array(cases) = parse_json(include_str!(
        "../src/resources/discovery/frontmatter-corpus.json"
    ))
    .unwrap() else {
        panic!()
    };
    for (i, case) in cases.iter().enumerate() {
        let JsonValue::Object(case) = case else {
            panic!()
        };
        let JsonValue::String(input) = case.get(&"input".into()).unwrap() else {
            panic!()
        };
        let mut cache = markdown::Cache::default();
        for phase in ["result", "repeat"] {
            let result = cache.parse(input.as_str().unwrap());
            let JsonValue::Object(expected) = case.get(&phase.into()).unwrap() else {
                panic!()
            };
            if expected.get(&"error".into()) == Some(&JsonValue::Bool(true)) {
                assert!(result.is_err(), "case {i} {phase}: {input:?}");
                continue;
            }
            let result = result.unwrap_or_else(|e| panic!("case {i} {phase}: {input:?}: {e}"));
            assert_eq!(
                result.data.snapshot(),
                *expected.get(&"data".into()).unwrap(),
                "data case {i} {phase}"
            );
            assert_eq!(
                JsonValue::String(result.content.into()),
                *expected.get(&"content".into()).unwrap(),
                "body case {i} {phase}"
            );
        }
    }
}

#[test]
fn unsupported_timestamp_keys_do_not_load_partial_records_on_first_or_repeated_reads() {
    let mut cache = markdown::Cache::default();
    let input = "---\n? 2020-01-02\n: value\n---\nBody";
    for _ in 0..2 {
        let error = cache
            .parse(input)
            .err()
            .expect("unsupported timestamp keys must remain explicit failures");
        assert!(error.to_string().contains("host-local Date.toString"));
    }
}
