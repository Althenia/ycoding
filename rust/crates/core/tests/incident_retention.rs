use std::collections::{BTreeMap, BTreeSet};
use std::ops::Bound;
use std::{fs, path::PathBuf};
use ycoding_core::{
    instructions::builtins,
    resources::config::{Configuration, LoadOptions, Roots, capabilities::BUILTIN_INSTRUCTIONS},
    session::retention::{self, Settings},
};
use ycoding_schema::{JsonValue, LosslessString};
use ycoding_store::{
    Metadata, Options, Store, backup,
    model_incident::{Incident, IncidentTable},
    session::Document,
};

#[path = "autonomy_support/mod.rs"]
mod autonomy;
#[path = "usage_retention_support/mod.rs"]
mod harness;
#[path = "report_support/mod.rs"]
mod report_support;

use harness::{DAY, Harness, NOW, count};

fn s(value: &str) -> LosslessString {
    value.into()
}

fn incident(index: usize, time: i64) -> Incident {
    Incident {
        id: s(&format!("inc_{index:05}")),
        time_created: time,
        kind: s("fallback"),
        provider_id: s("openai"),
        model_id: s("gpt"),
        variant: None,
        profile: None,
        agent: s("build"),
        project_id: s("prj_one"),
        session_id: s("ses_gone"),
        request_id: None,
        category: s("rate_limit"),
        rule_ids: Document::new(JsonValue::Array(vec![])).unwrap(),
        target: Some(
            Document::new(
                ycoding_schema::parse_json(r#"{"id":"mini","providerID":"openai"}"#).unwrap(),
            )
            .unwrap(),
        ),
        decided_by: None,
    }
}

fn insert(store: &Store, rows: Vec<Incident>) {
    for chunk in rows.chunks(1_000) {
        let chunk = chunk.to_vec();
        store
            .submit(move |tx| {
                chunk
                    .iter()
                    .try_for_each(|row| IncidentTable::insert(tx, row))
            })
            .unwrap()
            .wait()
            .unwrap();
    }
}

fn times(store: &Store) -> Vec<i64> {
    store
        .snapshot()
        .unwrap()
        .scan::<IncidentTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
        .unwrap()
        .into_iter()
        .map(|row| row.time_created)
        .collect()
}

fn configuration(document: &str) -> (PathBuf, Configuration) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "incident-retention-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let roots = Roots::development(&root).unwrap();
    fs::create_dir_all(&roots.config).unwrap();
    fs::write(roots.config.join("ycoding.json"), document).unwrap();
    let configuration = Configuration::load(LoadOptions {
        directory: roots.config.clone(),
        roots,
        project: false,
        file: None,
        content: None,
        env: BTreeMap::new(),
    })
    .unwrap();
    (root, configuration)
}

fn settings(document: &str) -> (Settings, usize) {
    let (root, configuration) = configuration(document);
    let result = (
        retention::settings(&configuration),
        configuration.diagnostics.len(),
    );
    let _ = fs::remove_dir_all(root);
    result
}

#[test]
fn incident_days_defaults_to_thirty_and_reads_a_positive_global_value() {
    assert_eq!(Settings::default().incident_days, 30);
    assert_eq!(settings("{}"), (Settings::default(), 0));
    let (read, diagnostics) =
        settings(r#"{"analytics_retention":{"incident_days":5,"usage_days":9}}"#);
    assert_eq!((read.incident_days, read.usage_days), (5, 9));
    assert_eq!(diagnostics, 0);
    for invalid in ["0", "-1", "1.5", r#""3""#] {
        let (read, diagnostics) = settings(&format!(
            r#"{{"analytics_retention":{{"incident_days":{invalid}}}}}"#
        ));
        assert_eq!(read.incident_days, 30, "{invalid}");
        assert_eq!(diagnostics, 1, "{invalid}");
    }
}

#[test]
fn model_guidance_is_a_built_in_instruction_that_capabilities_can_turn_off() {
    assert!(BUILTIN_INSTRUCTIONS.contains(&"model-guidance"));
    let tools = BTreeSet::new();
    let (root, enabled) = configuration("{}");
    assert!(builtins::enabled(
        "model-guidance",
        &enabled.capabilities,
        &tools
    ));
    let _ = fs::remove_dir_all(root);
    let (root, denied) =
        configuration(r#"{"capabilities":{"builtin_instructions":{"deny":["model-guidance"]}}}"#);
    assert!(denied.diagnostics.is_empty(), "{:?}", denied.diagnostics);
    assert!(!builtins::enabled(
        "model-guidance",
        &denied.capabilities,
        &tools
    ));
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn incident_cleanup_deletes_bounded_batches_before_the_cutoff_and_keeps_the_boundary() {
    let store = harness::store();
    let h = Harness::new();
    h.settings.lock().unwrap().incident_days = 30;
    let cutoff = NOW - 30 * DAY;
    let mut rows = (0..2_500)
        .map(|index| incident(index, cutoff - 1 - index as i64))
        .collect::<Vec<_>>();
    rows.push(incident(9_000, cutoff));
    rows.push(incident(9_001, NOW));
    insert(&store, rows);
    let reports = report_support::start(store.client());
    let cleanup = h.cleanups(store.client());
    assert_eq!(cleanup.incidents().await.unwrap(), 2_500);
    assert_eq!(times(&store), [cutoff, NOW]);
    assert_eq!(cleanup.incidents().await.unwrap(), 0);
    h.settings.lock().unwrap().incident_days = 1;
    let sweep = cleanup.sweep().await;
    assert!(sweep.failures.is_empty(), "{:?}", sweep.failures);
    assert_eq!(sweep.incidents, 1);
    assert_eq!(times(&store), [NOW]);
    assert_eq!(count::<IncidentTable>(&store), 1);
    drop(reports);
}

#[tokio::test]
async fn incidents_outlive_session_record_cleanup_until_their_own_retention() {
    let store = harness::store();
    let h = Harness::new();
    harness::seed(&store, "ses_old", NOW - 8 * DAY);
    insert(&store, vec![incident(1, NOW - 8 * DAY)]);
    let reports = report_support::start(store.client());
    let cleanup = h.cleanups(store.client());
    let sweep = cleanup.sweep().await;
    assert!(sweep.failures.is_empty(), "{:?}", sweep.failures);
    assert_eq!(sweep.incidents, 0);
    assert_eq!(times(&store), [NOW - 8 * DAY]);
    drop(reports);
}

#[tokio::test]
async fn a_blocked_backup_prevents_incident_deletion_until_a_verified_backup_exists() {
    let h = Harness::new();
    std::fs::create_dir_all(&h.root).unwrap();
    let path = h.root.join("core.redb");
    let store = harness::file_store(&path);
    insert(&store, vec![incident(1, NOW - 31 * DAY), incident(2, NOW)]);
    Store::initialize(
        backup::path(&path),
        Options::core(),
        harness::catalog(),
        Metadata::new([9; 16], 1),
    )
    .unwrap()
    .shutdown()
    .unwrap();
    let cleanup = h.cleanups(store.client());
    assert_eq!(cleanup.incidents().await.unwrap(), 0);
    assert_eq!(times(&store), [NOW - 31 * DAY, NOW]);
    std::fs::remove_file(backup::path(&path)).unwrap();
    assert_eq!(
        store.prepare_pruning(1, |_| Ok(u64::MAX)).unwrap(),
        backup::Status::Ready
    );
    assert_eq!(cleanup.incidents().await.unwrap(), 1);
    assert_eq!(times(&store), [NOW]);
    store.shutdown().unwrap();
}
