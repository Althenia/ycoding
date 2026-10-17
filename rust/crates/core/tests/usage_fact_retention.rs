use ycoding_core::session::cleanups::Error;
use ycoding_schema::session;
use ycoding_store::{Metadata, Options, Store, analytics, backup};

#[path = "autonomy_support/mod.rs"]
mod autonomy;
#[path = "usage_retention_support/mod.rs"]
mod harness;
#[path = "report_support/mod.rs"]
mod report_support;

use harness::{DAY, Harness, NOW, fact, fact_ids, insert_facts};

fn analytics_count(store: &Store) -> analytics::Value {
    store
        .analytics()
        .unwrap()
        .report(vec![analytics::Query {
            sql: "SELECT count(*) FROM usage_analytics_request",
            parameters: vec![],
            max_rows: 1,
        }])
        .unwrap()
        .remove(0)
        .remove(0)
        .remove(0)
}

#[tokio::test]
async fn facts_expire_strictly_before_the_usage_days_boundary_regardless_of_their_session() {
    let store = harness::store();
    let h = Harness::new();
    let cutoff = NOW - 30 * DAY;
    harness::seed(&store, "ses_active", NOW);
    insert_facts(
        &store,
        vec![
            fact("fact_expired", "ses_gone", cutoff - 1),
            fact("fact_boundary", "ses_gone", cutoff),
            fact("fact_fresh", "ses_gone", NOW),
            fact("fact_active_expired", "ses_active", cutoff - 1),
        ],
    );
    h.active
        .lock()
        .unwrap()
        .push(session::Id::new("ses_active").unwrap());
    let reports = report_support::start(store.client());
    let sweep = h.cleanups(store.client()).sweep().await;
    assert!(sweep.failures.is_empty(), "{:?}", sweep.failures);
    assert_eq!(fact_ids(&store), ["fact_boundary", "fact_fresh"]);
    assert_eq!(analytics_count(&store), analytics::Value::BigInt(2));
    drop(reports);
}

#[tokio::test]
async fn usage_days_is_read_again_at_every_sweep_and_never_resurrects_a_fact() {
    let store = harness::store();
    let h = Harness::new();
    insert_facts(
        &store,
        vec![
            fact("fact_twenty", "ses_gone", NOW - 20 * DAY),
            fact("fact_five", "ses_gone", NOW - 5 * DAY),
        ],
    );
    let reports = report_support::start(store.client());
    let cleanup = h.cleanups(store.client());
    h.set(7, 30);
    assert!(cleanup.sweep().await.failures.is_empty());
    assert_eq!(fact_ids(&store), ["fact_five", "fact_twenty"]);
    h.set(7, 10);
    assert!(cleanup.sweep().await.failures.is_empty());
    assert_eq!(fact_ids(&store), ["fact_five"]);
    h.set(7, 90);
    assert!(cleanup.sweep().await.failures.is_empty());
    assert_eq!(fact_ids(&store), ["fact_five"]);
    drop(reports);
}

#[tokio::test]
async fn session_record_cleanup_leaves_facts_untouched() {
    let store = harness::store();
    let h = Harness::new();
    harness::seed(&store, "ses_old", NOW - 8 * DAY);
    insert_facts(&store, vec![fact("fact_recent", "ses_old", NOW - DAY)]);
    let reports = report_support::start(store.client());
    let sweep = h.cleanups(store.client()).sweep().await;
    assert!(sweep.failures.is_empty(), "{:?}", sweep.failures);
    assert_eq!(sweep.requests, 1);
    assert_eq!(fact_ids(&store), ["fact_recent"]);
    drop(reports);
}

#[tokio::test]
async fn an_unavailable_report_engine_fences_expired_facts_and_the_next_sweep_completes_the_purge()
{
    let store = harness::store();
    let h = Harness::new();
    insert_facts(
        &store,
        vec![
            fact("fact_expired", "ses_gone", NOW - 31 * DAY),
            fact("fact_fresh", "ses_gone", NOW),
        ],
    );
    let cleanup = h.cleanups(store.client());
    let sweep = cleanup.sweep().await;
    assert!(
        sweep
            .failures
            .iter()
            .any(|(_, error)| matches!(error, Error::Analytics(analytics::Error::Unavailable)))
    );
    assert_eq!(fact_ids(&store), ["fact_fresh"]);
    let delivery = store
        .snapshot()
        .unwrap()
        .get::<analytics::DeliveryTable>(&[])
        .unwrap()
        .unwrap();
    assert!(delivery.purge_all || !delivery.purges.is_empty());
    let reports = report_support::start(store.client());
    let sweep = cleanup.sweep().await;
    assert!(sweep.failures.is_empty(), "{:?}", sweep.failures);
    let delivery = store
        .snapshot()
        .unwrap()
        .get::<analytics::DeliveryTable>(&[])
        .unwrap()
        .unwrap();
    assert!(!delivery.purge_all && delivery.purges.is_empty());
    assert_eq!(analytics_count(&store), analytics::Value::BigInt(1));
    drop(reports);
}

#[tokio::test]
async fn a_blocked_backup_prevents_fact_deletion_until_a_verified_backup_exists() {
    let h = Harness::new();
    std::fs::create_dir_all(&h.root).unwrap();
    let path = h.root.join("core.redb");
    let store = harness::file_store(&path);
    insert_facts(
        &store,
        vec![
            fact("fact_expired", "ses_gone", NOW - 31 * DAY),
            fact("fact_fresh", "ses_gone", NOW),
        ],
    );
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
    let sweep = cleanup.sweep().await;
    assert!(sweep.failures.is_empty(), "{:?}", sweep.failures);
    assert_eq!(fact_ids(&store), ["fact_expired", "fact_fresh"]);
    assert!(!backup::marker(&path).exists());
    std::fs::remove_file(backup::path(&path)).unwrap();
    assert_eq!(
        store.prepare_pruning(1, |_| Ok(u64::MAX)).unwrap(),
        backup::Status::Ready
    );
    let sweep = cleanup.sweep().await;
    assert!(sweep.failures.is_empty(), "{:?}", sweep.failures);
    assert_eq!(fact_ids(&store), ["fact_fresh"]);
    drop(reports);
    store.shutdown().unwrap();
}
