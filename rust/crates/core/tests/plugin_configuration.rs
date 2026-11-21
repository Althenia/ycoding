use ycoding_core::resources::config;
use ycoding_schema::{JsonValue, parse_json};

#[test]
fn plugin_configuration_preserves_module_entries_options_and_selectors() {
    for source in [
        r#"{"plugins":[]}"#,
        r#"{"plugins":["./plugin.ts"]}"#,
        r#"{"plugins":["file:///fixture/plugin.mjs","@fixture/plugin@1.0.0"]}"#,
        r#"{"plugins":[{"package":"./plugin.ts","options":{"label":"fixture","nested":{"enabled":true},"values":[1,null]}}]}"#,
        r#"{"plugins":["ycoding.*","-ycoding.fixture","*"]}"#,
    ] {
        let decoded = config::decode_document(source, "fixture/ycoding.json");
        assert!(decoded.diagnostics.is_empty(), "{source}");
        assert_eq!(decoded.info, Some(parse_json(source).unwrap()), "{source}");
    }
}

#[test]
fn malformed_plugin_entries_are_reported_without_dropping_unrelated_configuration() {
    for plugins in [
        "true",
        "[1]",
        "[[]]",
        r#"[{"package":17}]"#,
        r#"[{"package":"./plugin.ts","options":[]}]"#,
    ] {
        let source = format!(r#"{{"plugins":{plugins},"model":"fixture/model"}}"#);
        let decoded = config::decode_document(&source, "fixture/ycoding.json");
        assert!(
            decoded.diagnostics.iter().any(|diagnostic| {
                diagnostic.reason.0.as_str() == Some("invalid-values")
                    && diagnostic.json_path.as_ref().is_some_and(|path| {
                        path.as_str()
                            .is_some_and(|path| path.starts_with("$.plugins"))
                    })
            }),
            "{source}"
        );
        let Some(JsonValue::Object(info)) = decoded.info else {
            panic!("configuration object must survive invalid plugin entries")
        };
        assert_eq!(
            info.get(&"model".into()),
            Some(&parse_json(r#"{"providerID":"fixture","model":"model"}"#).unwrap()),
            "{source}"
        );
    }
}
