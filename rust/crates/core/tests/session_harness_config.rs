use ycoding_core::harness::Mode;
use ycoding_core::resources::config::decode_document;
use ycoding_core::session::harness_config::{Resolved, resolve};
use ycoding_schema::{JsonValue, parse_json};

fn layers(documents: &[&str]) -> Vec<JsonValue> {
    documents
        .iter()
        .map(|document| parse_json(document).unwrap())
        .collect()
}

#[test]
fn absent_configuration_leaves_the_harness_off() {
    assert_eq!(resolve(Vec::new().iter()).unwrap(), None);
}

#[test]
fn every_mode_is_selectable_and_unset_fields_keep_their_defaults() {
    for (text, mode) in [
        ("adaptive", Mode::Adaptive),
        ("parallel", Mode::Parallel),
        ("sequential", Mode::Sequential),
        ("disabled", Mode::Disabled),
    ] {
        let values = layers(&[&format!(r#"{{"mode":"{text}"}}"#)]);
        let resolved = resolve(values.iter()).unwrap().unwrap();
        assert_eq!(resolved.settings.mode, mode);
        let defaults = Resolved::default();
        assert_eq!(resolved.settings.steps, defaults.settings.steps);
        assert_eq!(resolved.ceiling, defaults.ceiling);
    }
}

#[test]
fn later_layers_override_fields_independently() {
    let values = layers(&[
        r#"{"mode":"parallel","steps":3,"max_depth":2,"ceiling":{"skills":["a"],"max_items":8}}"#,
        r#"{"steps":5,"min_signals":0,"ceiling":{"plugins":["p"]}}"#,
    ]);
    let resolved = resolve(values.iter()).unwrap().unwrap();
    assert_eq!(resolved.settings.mode, Mode::Parallel);
    assert_eq!(resolved.settings.steps, 5);
    assert_eq!(resolved.settings.max_depth, 2);
    assert_eq!(resolved.settings.min_signals, 0);
    assert_eq!(resolved.ceiling.skills, ["a".to_string()].into());
    assert_eq!(resolved.ceiling.plugins, ["p".to_string()].into());
    assert_eq!(resolved.ceiling.max_items, 8);
}

#[test]
fn out_of_range_and_unknown_values_are_rejected() {
    for document in [
        r#"{"mode":"eager"}"#,
        r#"{"steps":0}"#,
        r#"{"max_depth":256}"#,
        r#"{"max_tokens":-1}"#,
        r#"{"ceiling":{"max_items":0}}"#,
        r#"{"ceiling":{"skills":[1]}}"#,
    ] {
        let values = layers(&[document]);
        assert!(resolve(values.iter()).is_err(), "{document}");
    }
}

#[test]
fn configuration_validation_reports_each_invalid_harness_field() {
    let decoded = decode_document(
        r#"{"harness":{"mode":"eager","steps":0,"max_depth":300,"ceiling":{"max_items":0,"skills":[""]},"unknown":true}}"#,
        "fixture.jsonc",
    );
    let mut paths = decoded
        .diagnostics
        .iter()
        .map(|item| {
            item.json_path
                .as_ref()
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect::<Vec<_>>();
    paths.sort();
    assert_eq!(
        paths,
        [
            "$.harness.ceiling.max_items",
            "$.harness.ceiling.skills[0]",
            "$.harness.max_depth",
            "$.harness.mode",
            "$.harness.steps",
            "$.harness.unknown",
        ]
    );
    let valid = decode_document(
        r#"{"harness":{"mode":"sequential","steps":2,"ceiling":{"skills":["x"]}}}"#,
        "fixture.jsonc",
    );
    assert!(valid.diagnostics.is_empty());
}
