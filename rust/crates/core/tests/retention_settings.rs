use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_core::{
    resources::config::{Configuration, LoadOptions, Roots},
    session::retention::{self, Settings},
};

struct Directory(PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn load(document: Option<&str>) -> (Directory, Configuration) {
    layered(document, None)
}

fn layered(document: Option<&str>, content: Option<&str>) -> (Directory, Configuration) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "retention-settings-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let roots = Roots::development(&root).unwrap();
    fs::create_dir_all(&roots.config).unwrap();
    if let Some(document) = document {
        fs::write(roots.config.join("ycoding.json"), document).unwrap();
    }
    let configuration = Configuration::load(LoadOptions {
        directory: roots.config.clone(),
        roots,
        project: false,
        file: None,
        content: content.map(str::to_owned),
        env: BTreeMap::new(),
    })
    .unwrap();
    (Directory(root), configuration)
}

fn read(document: Option<&str>) -> (Settings, usize) {
    read_layered(document, None)
}

fn read_layered(document: Option<&str>, content: Option<&str>) -> (Settings, usize) {
    let (_directory, configuration) = layered(document, content);
    (
        retention::settings(&configuration),
        configuration.diagnostics.len(),
    )
}

fn triple(settings: &Settings) -> (i64, i64, i64) {
    (
        settings.records_days,
        settings.usage_days,
        settings.latency_days,
    )
}

#[test]
fn absent_configuration_yields_seven_thirty_and_thirty_days() {
    let (settings, diagnostics) = read(None);
    assert_eq!(triple(&settings), (7, 30, 30));
    assert_eq!(diagnostics, 0);
    assert_eq!(triple(&Settings::default()), (7, 30, 30));
}

#[test]
fn every_configured_value_is_read_and_unset_values_keep_their_defaults() {
    let (settings, diagnostics) = read(Some(
        r#"{"session_retention":{"records_days":3},"analytics_retention":{"usage_days":90,"latency_days":14}}"#,
    ));
    assert_eq!(triple(&settings), (3, 90, 14));
    assert_eq!(diagnostics, 0);
    let (settings, _) = read(Some(r#"{"analytics_retention":{"usage_days":2}}"#));
    assert_eq!(triple(&settings), (7, 2, 30));
    let (settings, _) = read(Some(r#"{"analytics_retention":{"latency_days":2}}"#));
    assert_eq!(triple(&settings), (7, 30, 2));
    let (settings, _) = read(Some(r#"{"session_retention":{"records_days":1}}"#));
    assert_eq!(triple(&settings), (1, 30, 30));
}

#[test]
fn invalid_values_fall_back_to_their_own_default_with_one_diagnostic_each() {
    for (section, key, default) in [
        ("session_retention", "records_days", (7, 30, 30)),
        ("analytics_retention", "usage_days", (7, 30, 30)),
        ("analytics_retention", "latency_days", (7, 30, 30)),
    ] {
        for invalid in ["0", "-1", "1.5", r#""3""#] {
            let (settings, diagnostics) =
                read(Some(&format!(r#"{{"{section}":{{"{key}":{invalid}}}}}"#)));
            assert_eq!(triple(&settings), default, "{key}={invalid}");
            assert_eq!(diagnostics, 1, "{key}={invalid}");
        }
    }
    let (settings, diagnostics) = read(Some(
        r#"{"session_retention":{"records_days":0},"analytics_retention":{"usage_days":5,"latency_days":-1}}"#,
    ));
    assert_eq!(triple(&settings), (7, 5, 30));
    assert_eq!(diagnostics, 2);
}

#[test]
fn whole_family_days_is_independent_of_the_record_retention_settings() {
    let (_directory, configuration) = load(Some(
        r#"{"session_retention":{"days":3,"records_days":5},"analytics_retention":{"usage_days":9}}"#,
    ));
    assert_eq!(retention::days(&configuration), 3);
    assert_eq!(triple(&retention::settings(&configuration)), (5, 9, 30));
    let (_directory, configuration) = load(Some(r#"{"session_retention":{"days":3}}"#));
    assert_eq!(retention::days(&configuration), 3);
    assert_eq!(triple(&retention::settings(&configuration)), (7, 30, 30));
}

const GLOBAL: &str = r#"{"session_retention":{"records_days":3,"days":4},"analytics_retention":{"usage_days":10,"latency_days":20}}"#;

#[test]
fn a_later_global_document_overrides_each_key_without_replacing_its_section() {
    let (settings, diagnostics) = read_layered(
        Some(GLOBAL),
        Some(r#"{"analytics_retention":{"usage_days":11}}"#),
    );
    assert_eq!(triple(&settings), (3, 11, 20));
    assert_eq!(diagnostics, 0);
    let (settings, _) = read_layered(
        Some(GLOBAL),
        Some(r#"{"session_retention":{"days":9},"analytics_retention":{"latency_days":21}}"#),
    );
    assert_eq!(triple(&settings), (3, 10, 21));
    let (settings, _) = read_layered(
        Some(GLOBAL),
        Some(r#"{"session_retention":{"records_days":5}}"#),
    );
    assert_eq!(triple(&settings), (5, 10, 20));
    let (settings, _) = read_layered(
        Some(r#"{"analytics_retention":{"usage_days":2}}"#),
        Some(
            r#"{"session_retention":{"records_days":6},"analytics_retention":{"latency_days":8}}"#,
        ),
    );
    assert_eq!(triple(&settings), (6, 2, 8));
}

#[test]
fn an_invalid_later_value_never_hides_a_valid_earlier_one() {
    let (settings, diagnostics) = read_layered(
        Some(GLOBAL),
        Some(
            r#"{"session_retention":{"records_days":0},"analytics_retention":{"usage_days":1.5,"latency_days":30}}"#,
        ),
    );
    assert_eq!(triple(&settings), (3, 10, 30));
    assert_eq!(diagnostics, 2);
}

#[test]
fn whole_family_days_keeps_its_own_precedence() {
    let (_directory, configuration) = layered(
        Some(GLOBAL),
        Some(r#"{"analytics_retention":{"usage_days":11}}"#),
    );
    assert_eq!(retention::days(&configuration), 4);
    let (_directory, configuration) =
        layered(Some(GLOBAL), Some(r#"{"session_retention":{"days":9}}"#));
    assert_eq!(retention::days(&configuration), 9);
    assert_eq!(triple(&retention::settings(&configuration)), (3, 10, 20));
}
