use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_core::resources::config::{Configuration, LoadOptions, Roots, decode_document};
use ycoding_schema::{JsonValue, parse_json};

#[test]
fn chatgpt_shape_retains_required_enabled_optional_profile_and_lossless_connector_policy() {
    for source in [
        r#"{"account_connectors":{"chatgpt":{"enabled":false}}}"#,
        r#"{"account_connectors":{"chatgpt":{"enabled":true,"profile":" ","connectors":{"\ud800":"deny","mail":"allow"}}}}"#,
        r#"{"account_connectors":{}}"#,
    ] {
        let decoded = decode_document(source, "synthetic");
        assert!(decoded.diagnostics.is_empty());
        assert_eq!(decoded.info, Some(parse_json(source).unwrap()));
    }
}

#[test]
fn invalid_connector_values_keep_existing_diagnostic_order_and_utf16_paths() {
    let decoded = decode_document(
        r#"{"unknown":true,"account_connectors":{"chatgpt":{"enabled":true,"profile":"","connectors":{"\ud800":"other"},"extra":1},"claude":{"enabled":true}},"username":"kept"}"#,
        "synthetic",
    );
    let paths = decoded
        .diagnostics
        .iter()
        .map(|item| item.json_path.clone().unwrap())
        .collect::<Vec<_>>();
    let expected: Vec<ycoding_schema::LosslessString> = vec![
        "$.unknown".into(),
        "$.account_connectors.chatgpt.profile".into(),
        r#"$.account_connectors.chatgpt.connectors["\ud800"]"#.into(),
        "$.account_connectors.chatgpt.extra".into(),
        "$.account_connectors.claude".into(),
    ];
    assert_eq!(paths, expected);
    assert_eq!(decoded.info, Some(parse_json(r#"{"account_connectors":{"chatgpt":{"enabled":true,"connectors":{}}},"username":"kept"}"#).unwrap()));
    let missing = decode_document(
        r#"{"account_connectors":{"chatgpt":{"profile":"work"}}}"#,
        "synthetic",
    );
    assert_eq!(
        missing.diagnostics[0].json_path,
        Some("$.account_connectors.chatgpt".into())
    );
    assert_eq!(
        missing.info,
        Some(parse_json(r#"{"account_connectors":{}}"#).unwrap())
    );
}

struct Fixture(PathBuf);
static NEXT: AtomicU64 = AtomicU64::new(0);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "ycoding-library-config-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("project")).unwrap();
        fs::create_dir_all(root.join("config/ycoding")).unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
    fn config(&self) -> Configuration {
        Configuration::load(LoadOptions {
            directory: self.0.join("project"),
            roots: Roots::development(&self.0).unwrap(),
            project: true,
            file: None,
            content: None,
            env: BTreeMap::new(),
        })
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn latest_account_connectors_replaces_the_whole_section_and_snapshot_observes_disk_changes() {
    let f = Fixture::new();
    fs::write(
        f.0.join("config/ycoding/ycoding.json"),
        r#"{"account_connectors":{"chatgpt":{"enabled":true,"profile":"work"}}}"#,
    )
    .unwrap();
    fs::write(
        f.0.join("project/ycoding.json"),
        r#"{"account_connectors":{}}"#,
    )
    .unwrap();
    let config = f.config();
    assert_eq!(
        config.latest("account_connectors"),
        Some(&parse_json("{}").unwrap())
    );
    fs::write(
        f.0.join("project/ycoding.json"),
        r#"{"account_connectors":{"chatgpt":{"enabled":false}}}"#,
    )
    .unwrap();
    let latest = config.snapshot().unwrap();
    assert_eq!(
        latest.latest("account_connectors"),
        Some(&parse_json(r#"{"chatgpt":{"enabled":false}}"#).unwrap())
    );
    assert!(matches!(
        config.latest("account_connectors"),
        Some(JsonValue::Object(_))
    ));
}
