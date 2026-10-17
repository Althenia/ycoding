use std::sync::Arc;
use ycoding_core::session::retention::Settings;
use ycoding_schema::session;
use ycoding_store::{Metadata, Options, Store, backup, resources, session as tables};

#[path = "autonomy_support/mod.rs"]
mod autonomy;
#[path = "usage_retention_support/mod.rs"]
mod harness;
#[path = "report_support/mod.rs"]
mod report_support;

use harness::{DAY, Harness, NOW, count, key, pruned_through, seed};

#[test]
fn settings_default_to_seven_thirty_and_thirty_days() {
    let settings = Settings::default();
    assert_eq!(
        (
            settings.records_days,
            settings.usage_days,
            settings.latency_days
        ),
        (7, 30, 30)
    );
}

#[tokio::test]
async fn records_idle_longer_than_records_days_are_deleted_with_a_strict_boundary() {
    let store = harness::store();
    let h = Harness::new();
    let cutoff = NOW - 7 * DAY;
    for (id, updated) in [
        ("ses_old", cutoff - 1),
        ("ses_boundary", cutoff),
        ("ses_fresh", NOW),
        ("ses_active", cutoff - 1),
    ] {
        seed(&store, id, updated);
    }
    h.active
        .lock()
        .unwrap()
        .push(session::Id::new("ses_active").unwrap());
    let reports = report_support::start(store.client());
    let cleanup = h.cleanups(store.client());
    assert_eq!(cleanup.context_exclusions().await.unwrap(), 1);
    assert_eq!(cleanup.file_changes().await.unwrap(), 1);
    assert_eq!(cleanup.usage().await.unwrap(), 1);
    assert_eq!(count::<tables::ExclusionTable>(&store), 3);
    assert_eq!(count::<tables::FileChangeTable>(&store), 3);
    assert_eq!(count::<resources::RequestTable>(&store), 3);
    assert_eq!(count::<resources::UsageTable>(&store), 3);
    assert_eq!(count::<tables::EventTable>(&store), 4);
    assert_eq!(count::<tables::MessageTable>(&store), 4);
    assert_eq!(pruned_through(&store, "ses_old"), Some(cutoff));
    for id in ["ses_boundary", "ses_fresh", "ses_active"] {
        assert_eq!(pruned_through(&store, id), None, "{id}");
    }
    drop(reports);
}

#[tokio::test]
async fn records_days_is_read_again_at_every_sweep() {
    let store = harness::store();
    let h = Harness::new();
    seed(&store, "ses_twenty", NOW - 20 * DAY);
    let reports = report_support::start(store.client());
    let cleanup = h.cleanups(store.client());
    h.set(30, 30);
    assert_eq!(cleanup.usage().await.unwrap(), 0);
    assert_eq!(count::<resources::RequestTable>(&store), 1);
    assert_eq!(pruned_through(&store, "ses_twenty"), None);
    h.set(7, 30);
    assert_eq!(cleanup.usage().await.unwrap(), 1);
    assert_eq!(count::<resources::RequestTable>(&store), 0);
    assert_eq!(pruned_through(&store, "ses_twenty"), Some(NOW - 7 * DAY));
    drop(reports);
}

#[tokio::test]
async fn the_usage_cutoff_never_moves_backward() {
    let store = harness::store();
    let h = Harness::new();
    let old = NOW - 40 * DAY;
    seed(&store, "ses_a", old);
    let reports = report_support::start(store.client());
    let cleanup = h.cleanups(store.client());
    h.set(7, 30);
    assert_eq!(cleanup.usage().await.unwrap(), 1);
    assert_eq!(pruned_through(&store, "ses_a"), Some(NOW - 7 * DAY));
    harness::insert_requests(&store, vec![harness::request("ses_a", "more", 2, old)]);
    h.set(30, 30);
    assert_eq!(cleanup.usage().await.unwrap(), 1);
    assert_eq!(pruned_through(&store, "ses_a"), Some(NOW - 7 * DAY));
    h.clock.set(NOW + DAY);
    harness::insert_requests(&store, vec![harness::request("ses_a", "third", 3, old)]);
    h.set(7, 30);
    assert_eq!(cleanup.usage().await.unwrap(), 1);
    assert_eq!(pruned_through(&store, "ses_a"), Some(NOW - 6 * DAY));
    drop(reports);
}

#[tokio::test]
async fn one_session_is_deleted_in_bounded_batches_that_recheck_the_session_between_batches() {
    let store = harness::store();
    let h = Harness::new();
    seed(&store, "ses_big", NOW - 8 * DAY);
    harness::insert_requests(
        &store,
        (2..=250)
            .map(|number| harness::request("ses_big", &format!("r{number}"), number, NOW - 8 * DAY))
            .collect(),
    );
    assert_eq!(count::<resources::RequestTable>(&store), 250);
    let reports = report_support::start(store.client());
    let probe = store.client();
    let cleanup = h.cleanups_with(
        store.client(),
        Arc::new(move || {
            if count::<resources::RequestTable>(&probe) < 250 {
                vec![session::Id::new("ses_big").unwrap()]
            } else {
                Vec::new()
            }
        }),
    );
    let deleted = cleanup.usage().await.unwrap();
    let remaining = count::<resources::RequestTable>(&store);
    assert!(
        (1..=100).contains(&deleted),
        "first batch deleted {deleted}"
    );
    assert_eq!(remaining, 250 - deleted);
    assert!(count::<resources::UsageTable>(&store) <= 1);
    let idle = h.cleanups(store.client());
    assert_eq!(idle.usage().await.unwrap(), 250 - deleted);
    assert_eq!(count::<resources::RequestTable>(&store), 0);
    assert_eq!(count::<resources::UsageTable>(&store), 0);
    assert_eq!(pruned_through(&store, "ses_big"), Some(NOW - 7 * DAY));
    drop(reports);
}

#[tokio::test]
async fn a_blocked_backup_prevents_every_record_deletion_until_a_verified_backup_exists() {
    let h = Harness::new();
    std::fs::create_dir_all(&h.root).unwrap();
    let path = h.root.join("core.redb");
    let store = harness::file_store(&path);
    seed(&store, "ses_old", NOW - 8 * DAY);
    Store::initialize(
        backup::path(&path),
        Options::core(),
        harness::catalog(),
        Metadata::new([9; 16], 1),
    )
    .unwrap()
    .shutdown()
    .unwrap();
    let reports = report_support::start(store.client());
    let cleanup = h.cleanups(store.client());
    assert_eq!(cleanup.context_exclusions().await.unwrap(), 0);
    assert_eq!(cleanup.file_changes().await.unwrap(), 0);
    assert_eq!(cleanup.usage().await.unwrap(), 0);
    let sweep = cleanup.sweep().await;
    assert!(sweep.failures.is_empty(), "{:?}", sweep.failures);
    assert_eq!(
        (sweep.context_exclusions, sweep.file_changes, sweep.requests),
        (0, 0, 0)
    );
    assert_eq!(count::<tables::ExclusionTable>(&store), 1);
    assert_eq!(count::<tables::FileChangeTable>(&store), 1);
    assert_eq!(count::<resources::RequestTable>(&store), 1);
    assert_eq!(count::<resources::UsageTable>(&store), 1);
    assert_eq!(pruned_through(&store, "ses_old"), None);
    assert!(!backup::marker(&path).exists());
    std::fs::remove_file(backup::path(&path)).unwrap();
    assert_eq!(
        store.prepare_pruning(1, |_| Ok(u64::MAX)).unwrap(),
        backup::Status::Ready
    );
    assert_eq!(cleanup.context_exclusions().await.unwrap(), 1);
    assert_eq!(cleanup.file_changes().await.unwrap(), 1);
    assert_eq!(cleanup.usage().await.unwrap(), 1);
    assert_eq!(pruned_through(&store, "ses_old"), Some(NOW - 7 * DAY));
    drop(reports);
    store.shutdown().unwrap();
}

#[tokio::test]
async fn sweeps_without_a_deletion_candidate_never_create_a_backup() {
    let h = Harness::new();
    std::fs::create_dir_all(&h.root).unwrap();
    let path = h.root.join("core.redb");
    let store = harness::file_store(&path);
    let reports = report_support::start(store.client());
    let cleanup = h.cleanups(store.client());
    let sweep = cleanup.sweep().await;
    assert!(sweep.failures.is_empty(), "{:?}", sweep.failures);
    seed(&store, "ses_boundary", NOW - 7 * DAY);
    seed(&store, "ses_fresh", NOW);
    harness::insert_facts(
        &store,
        vec![
            harness::fact("fact_boundary", "ses_boundary", NOW - 30 * DAY),
            harness::fact("fact_fresh", "ses_fresh", NOW),
        ],
    );
    let sweep = cleanup.sweep().await;
    assert!(sweep.failures.is_empty(), "{:?}", sweep.failures);
    assert_eq!(
        (sweep.context_exclusions, sweep.file_changes, sweep.requests),
        (0, 0, 0)
    );
    assert!(!backup::path(&path).exists());
    assert!(!backup::marker(&path).exists());
    drop(reports);
    store.shutdown().unwrap();
}

#[tokio::test]
async fn the_first_deletion_candidate_creates_a_verified_backup_holding_every_pre_deletion_row() {
    let h = Harness::new();
    std::fs::create_dir_all(&h.root).unwrap();
    let path = h.root.join("core.redb");
    let store = harness::file_store(&path);
    seed(&store, "ses_old", NOW - 8 * DAY);
    harness::insert_facts(
        &store,
        vec![
            harness::fact("fact_expired", "ses_gone", NOW - 31 * DAY),
            harness::fact("fact_fresh", "ses_old", NOW),
        ],
    );
    let reports = report_support::start(store.client());
    let sweep = h.cleanups(store.client()).sweep().await;
    assert!(sweep.failures.is_empty(), "{:?}", sweep.failures);
    assert_eq!(count::<resources::RequestTable>(&store), 0);
    assert_eq!(harness::fact_ids(&store), ["fact_fresh"]);
    assert!(backup::marker(&path).is_file());
    let restored = h.root.join("restored.redb");
    std::fs::copy(backup::path(&path), &restored).unwrap();
    let copy = Store::open(&restored, Options::core(), harness::catalog()).unwrap();
    assert_eq!(count::<resources::RequestTable>(&copy), 1);
    assert_eq!(count::<resources::UsageTable>(&copy), 1);
    assert_eq!(count::<tables::FileChangeTable>(&copy), 1);
    assert_eq!(count::<tables::ExclusionTable>(&copy), 1);
    assert_eq!(harness::fact_ids(&copy), ["fact_expired", "fact_fresh"]);
    assert!(
        copy.snapshot()
            .unwrap()
            .get::<tables::SessionTable>(&key("ses_old"))
            .unwrap()
            .is_some()
    );
    copy.shutdown().unwrap();
    drop(reports);
    store.shutdown().unwrap();
}
