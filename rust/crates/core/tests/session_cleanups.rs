use std::{
    future::Future,
    ops::Bound,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime},
};
use ycoding_core::{
    resources::{config::Roots, tool_output_store},
    session::{
        cleanups::{Cleanups, Error, Maintenance},
        runner::Clock,
    },
};
use ycoding_schema::{LosslessString, parse_json, session};
use ycoding_store::{
    Client, KeyPart, Store, TableSpec, analytics, resources, session as tables, tuple_key,
};

#[path = "report_support/mod.rs"]
mod report_support;
#[path = "autonomy_support/mod.rs"]
mod support;

const DAY: i64 = 86_400_000;
const NOW: i64 = 100 * DAY;
const OLD: i64 = NOW - 30 * DAY - 1;
const BOUNDARY: i64 = NOW - 30 * DAY;
static OWNER: Mutex<()> = Mutex::new(());

struct TestClock {
    now: AtomicI64,
    sleeping: tokio::sync::Semaphore,
    tick: tokio::sync::watch::Sender<u64>,
}
impl Default for TestClock {
    fn default() -> Self {
        Self {
            now: AtomicI64::new(NOW),
            sleeping: tokio::sync::Semaphore::new(0),
            tick: tokio::sync::watch::channel(0).0,
        }
    }
}
impl Clock for TestClock {
    fn now(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    fn sleep(&self, milliseconds: u64) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        assert_eq!(milliseconds, 3_600_000);
        let mut tick = self.tick.subscribe();
        self.sleeping.add_permits(1);
        Box::pin(async move { tick.changed().await.unwrap() })
    }
}

fn key(value: &LosslessString) -> Vec<u8> {
    tuple_key(&[KeyPart::String(value)])
}
fn count<T: TableSpec>(client: &Client) -> usize {
    client
        .snapshot()
        .unwrap()
        .scan::<T>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
        .unwrap()
        .len()
}
fn store() -> Store {
    let store = Store::disposable(
        ycoding_store::Options::core(),
        ycoding_store::import::catalog(ycoding_store::import::DatabaseKind::Core),
        ycoding_store::Metadata::new([7; 16], 1),
    )
    .unwrap();
    store
        .submit(|tx| {
            ycoding_store::project::ProjectTable::insert(
                tx,
                &ycoding_store::project::Project {
                    id: "prj_one".into(),
                    worktree: "/project".into(),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 0,
                    time_updated: 0,
                    time_initialized: None,
                    sandboxes: vec![],
                    commands: None,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    store
}
fn seed(store: &Store, id: &str, updated: i64) {
    let id = id.to_owned();
    store
        .submit(move |tx| {
            tables::SessionTable::put(
                tx,
                &tables::Session {
                    time_updated: updated,
                    ..support::record(&id)
                },
            )?;
            tables::SequenceTable::put(
                tx,
                &tables::Sequence {
                    aggregate_id: id.as_str().into(),
                    seq: 0,
                    owner_id: None,
                },
            )?;
            tables::EventTable::insert(
                tx,
                &tables::Event {
                    id: format!("evt_{id}").into(),
                    aggregate_id: id.as_str().into(),
                    seq: 0,
                    created: 0,
                    type_: "session.file_change.recorded.2".into(),
                    data: parse_json(
                        r#"{"change":{"path":"file","patch":"@@","additions":1,"deletions":0}}"#,
                    )
                    .unwrap(),
                },
            )?;
            tables::MessageTable::insert(
                tx,
                &tables::Message {
                    id: format!("msg_{id}").into(),
                    session_id: id.as_str().into(),
                    type_: "user".into(),
                    seq: 0,
                    time_created: 0,
                    time_updated: 0,
                    data: parse_json(r#"{"text":"canonical transcript"}"#).unwrap(),
                },
            )?;
            tables::FileChangeTable::insert(
                tx,
                &tables::FileChange {
                    session_id: id.as_str().into(),
                    path: "file".into(),
                    patch: "@@".into(),
                    additions: 1,
                    deletions: 0,
                    latest_seq: 0,
                },
            )?;
            tables::ManifestTable::put(
                tx,
                &tables::Manifest {
                    digest: "a".repeat(64).into(),
                    schema_version: 1,
                    content: tables::Document::new(parse_json("{}").unwrap())?,
                    input_tokens: 1,
                    retained_tokens: 0,
                    time_created: 0,
                },
            )?;
            tables::RevisionTable::insert(
                tx,
                &tables::Revision {
                    session_id: id.as_str().into(),
                    revision: 0,
                    parent_revision: None,
                    manifest_digest: None,
                    covered_through_message_id: None,
                    covered_through_seq: None,
                    activation_event_id: None,
                    activation_sequence: None,
                    time_created: 0,
                },
            )?;
            tables::ExclusionTable::insert(
                tx,
                &tables::Exclusion {
                    session_id: id.as_str().into(),
                    context_revision: 0,
                    target_key: "b".repeat(64).into(),
                    target_kind: "message".into(),
                    target_selector: tables::Document::new(parse_json("{}").unwrap())?,
                    dependency_group: None,
                    reason: "exact_duplicate".into(),
                    manifest_digest: "a".repeat(64).into(),
                },
            )?;
            resources::RequestTable::insert(tx, &request(&id, "old", 1))?;
            resources::UsageTable::insert(
                tx,
                &resources::Usage {
                    session_id: id.as_str().into(),
                    model_key: "p:m".into(),
                    model: request(&id, "unused", 0).model,
                    logical: 1,
                    physical: 1,
                    helpers: 0,
                    continued: 0,
                    fallback: 0,
                    cost: Some(1.0),
                    input: 1,
                    output: 1,
                    reasoning: 0,
                    cache_read: 0,
                    cache_write: 0,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}
fn request(id: &str, suffix: &str, number: i64) -> resources::Request {
    resources::Request {
        id: format!("prq_{id}_{suffix}").into(),
        session_id: id.into(),
        input_id: None,
        assistant_message_id: None,
        connection_identity_digest: None,
        source: "step".into(),
        agent: "build".into(),
        model: tables::Document::new(parse_json(r#"{"providerID":"p","id":"m"}"#).unwrap())
            .unwrap(),
        route_id: "test".into(),
        prompt_cache_key: "key".into(),
        system_digest: "system".into(),
        tool_digest: "tools".into(),
        request: number,
        attempts: 1,
        invalidation: "first-request".into(),
        continuation: "full".into(),
        cache_read_reported: None,
        timing: None,
        cost: Some(1.0),
        tokens: tables::Document::new(
            parse_json(r#"{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}"#)
                .unwrap(),
        )
        .unwrap(),
        time_created: OLD,
    }
}

struct Fixture {
    root: std::path::PathBuf,
    outputs: Arc<tool_output_store::Store>,
    clock: Arc<TestClock>,
    active: Arc<Mutex<Vec<session::Id>>>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "ycoding-cleanups-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let roots = Roots::development(&root).unwrap();
        Self {
            root,
            outputs: Arc::new(tool_output_store::Store::new(&roots)),
            clock: Arc::default(),
            active: Arc::default(),
        }
    }
    fn cleanup(&self, client: Client) -> Cleanups {
        let active = self.active.clone();
        Cleanups::new(
            client,
            self.outputs.clone(),
            self.clock.clone(),
            Arc::new(move || active.lock().unwrap().clone()),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.root.exists() {
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }
}

#[tokio::test]
async fn strict_cutoff_active_exemption_exact_counts_and_durable_history() {
    let store = store();
    let fixture = Fixture::new();
    for (id, updated) in [
        ("ses_old", OLD),
        ("ses_boundary", BOUNDARY),
        ("ses_fresh", NOW),
        ("ses_active", OLD),
        ("ses_idle_flags", OLD),
    ] {
        seed(&store, id, updated);
    }
    store
        .submit(|tx| {
            let mut row = tx
                .get::<tables::SessionTable>(&key(&"ses_idle_flags".into()))?
                .unwrap();
            row.time_pinned = Some(OLD);
            row.time_suspended = Some(OLD);
            row.time_active = Some(NOW);
            row.autonomy =
                Some(parse_json(r#"{"mode":"goal","yolo":0,"goal":{"status":"active"}}"#).unwrap());
            tables::SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    fixture
        .active
        .lock()
        .unwrap()
        .push(session::Id::new("ses_active").unwrap());
    let reports = report_support::start(store.client());
    let cleanup = fixture.cleanup(store.client());
    let events = store
        .snapshot()
        .unwrap()
        .scan::<tables::EventTable>(Bound::Unbounded, Bound::Unbounded, 20)
        .unwrap();
    let messages = store
        .snapshot()
        .unwrap()
        .scan::<tables::MessageTable>(Bound::Unbounded, Bound::Unbounded, 20)
        .unwrap();
    assert_eq!(cleanup.context_exclusions().await.unwrap(), 2);
    assert_eq!(cleanup.file_changes().await.unwrap(), 2);
    assert_eq!(cleanup.usage().await.unwrap(), 2);
    assert_eq!(count::<tables::ExclusionTable>(&store), 3);
    assert_eq!(count::<tables::FileChangeTable>(&store), 3);
    assert_eq!(count::<resources::RequestTable>(&store), 3);
    assert_eq!(count::<resources::UsageTable>(&store), 3);
    assert_eq!(count::<tables::RevisionTable>(&store), 5);
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<tables::EventTable>(Bound::Unbounded, Bound::Unbounded, 20)
            .unwrap(),
        events
    );
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<tables::MessageTable>(Bound::Unbounded, Bound::Unbounded, 20)
            .unwrap(),
        messages
    );
    assert_eq!(cleanup.context_exclusions().await.unwrap(), 0);
    assert_eq!(cleanup.file_changes().await.unwrap(), 0);
    assert_eq!(cleanup.usage().await.unwrap(), 0);
    fixture.active.lock().unwrap().clear();
    assert_eq!(cleanup.context_exclusions().await.unwrap(), 1);
    assert_eq!(cleanup.file_changes().await.unwrap(), 1);
    assert_eq!(cleanup.usage().await.unwrap(), 1);
    drop(reports);
}

#[tokio::test]
async fn batches_preserve_interleaved_writes() {
    let store = store();
    for index in 0..205 {
        seed(&store, &format!("ses_{index:03}"), OLD);
    }
    let fixture = Fixture::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let writer = store.client();
    let active = Arc::new(move || {
        if calls.fetch_add(1, Ordering::SeqCst) == 0 {
            writer
                .submit(|tx| {
                    let mut row = tx
                        .get::<tables::FileChangeTable>(&tuple_key(&[
                            KeyPart::String(&"ses_201".into()),
                            KeyPart::String(&"file".into()),
                        ]))?
                        .unwrap();
                    row.patch = "live write".into();
                    tables::FileChangeTable::put(tx, &row)?;
                    tables::FileChangeTable::insert(
                        tx,
                        &tables::FileChange {
                            path: "new".into(),
                            ..row
                        },
                    )?;
                    let mut session = tx
                        .get::<tables::SessionTable>(&key(&"ses_202".into()))?
                        .unwrap();
                    session.time_updated = NOW;
                    tables::SessionTable::put(tx, &session)
                })
                .unwrap()
                .wait()
                .unwrap();
        }
        Vec::new()
    });
    let cleanup = Cleanups::new(
        store.client(),
        fixture.outputs.clone(),
        fixture.clock.clone(),
        active,
    );
    assert_eq!(cleanup.file_changes().await.unwrap(), 203);
    assert_eq!(count::<tables::FileChangeTable>(&store), 3);
    assert_eq!(
        fixture
            .cleanup(store.client())
            .file_changes()
            .await
            .unwrap(),
        2
    );
    assert_eq!(count::<tables::FileChangeTable>(&store), 1);
}

#[tokio::test]
async fn absent_analytics_fences_deleted_usage_and_retries_purge_without_new_deletions() {
    let store = store();
    seed(&store, "ses_old", OLD);
    let fixture = Fixture::new();
    let cleanup = fixture.cleanup(store.client());
    assert!(matches!(
        cleanup.usage().await,
        Err(Error::Analytics(analytics::Error::Unavailable))
    ));
    assert_eq!(count::<resources::RequestTable>(&store), 0);
    assert_eq!(count::<resources::UsageTable>(&store), 0);
    let delivery = store
        .snapshot()
        .unwrap()
        .get::<analytics::DeliveryTable>(&[])
        .unwrap()
        .unwrap();
    assert!(delivery.purge_all || !delivery.purges.is_empty());
    let reports = report_support::start(store.client());
    assert_eq!(cleanup.usage().await.unwrap(), 0);
    let delivery = store
        .snapshot()
        .unwrap()
        .get::<analytics::DeliveryTable>(&[])
        .unwrap()
        .unwrap();
    assert!(!delivery.purge_all && delivery.purges.is_empty());
    let rows = store
        .analytics()
        .unwrap()
        .report(vec![analytics::Query {
            sql: "SELECT count(*) FROM session_provider_request",
            parameters: vec![],
            max_rows: 1,
        }])
        .unwrap();
    assert_eq!(rows[0][0][0], analytics::Value::BigInt(0));
    drop(reports);
}

#[tokio::test]
async fn usage_batches_preserve_new_requests_and_updated_aggregates() {
    let store = store();
    for index in 0..205 {
        seed(&store, &format!("ses_{index:03}"), OLD);
    }
    let reports = report_support::start(store.client());
    let fixture = Fixture::new();
    let writer = store.client();
    let calls = AtomicUsize::new(0);
    let cleanup = Cleanups::new(
        store.client(),
        fixture.outputs.clone(),
        fixture.clock.clone(),
        Arc::new(move || {
            if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                writer
                    .submit(|tx| {
                        resources::RequestTable::insert(tx, &request("ses_204", "live", 2))?;
                        let primary = tuple_key(&[
                            KeyPart::String(&"ses_204".into()),
                            KeyPart::String(&"p:m".into()),
                        ]);
                        let mut usage = tx.get::<resources::UsageTable>(&primary)?.unwrap();
                        usage.logical = 2;
                        resources::UsageTable::put(tx, &usage)
                    })
                    .unwrap()
                    .wait()
                    .unwrap();
            }
            vec![session::Id::new("ses_000").unwrap()]
        }),
    );
    assert_eq!(cleanup.usage().await.unwrap(), 204);
    assert_eq!(count::<resources::RequestTable>(&store), 2);
    assert_eq!(count::<resources::UsageTable>(&store), 2);
    let snapshot = store.snapshot().unwrap();
    assert!(
        snapshot
            .get::<resources::RequestTable>(&key(&"prq_ses_204_live".into()))
            .unwrap()
            .is_some()
    );
    assert_eq!(
        snapshot
            .get::<resources::UsageTable>(&tuple_key(&[
                KeyPart::String(&"ses_204".into()),
                KeyPart::String(&"p:m".into())
            ]))
            .unwrap()
            .unwrap()
            .logical,
        2
    );
    drop(snapshot);
    drop(reports);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn startup_hourly_single_owner_failures_and_close_drain() {
    let _owner = OWNER.lock().unwrap();
    let store = store();
    seed(&store, "ses_startup", OLD);
    let fixture = Fixture::new();
    let sweeping = Arc::new(tokio::sync::Notify::new());
    let enabled = Arc::new(AtomicBool::new(false));
    let signal = sweeping.clone();
    let flag = enabled.clone();
    let cleanup = Cleanups::new(
        store.client(),
        fixture.outputs.clone(),
        fixture.clock.clone(),
        Arc::new(move || {
            if flag.load(Ordering::SeqCst) {
                signal.notify_one();
            }
            Vec::new()
        }),
    );
    let mut owner = Maintenance::start(cleanup).await.unwrap();
    assert_eq!(owner.startup().file_changes, 1);
    assert_eq!(owner.startup().context_exclusions, 1);
    assert_eq!(owner.startup().failures.len(), 1);
    assert!(
        Maintenance::start(fixture.cleanup(store.client()))
            .await
            .is_err()
    );
    fixture
        .clock
        .sleeping
        .acquire_many(4)
        .await
        .unwrap()
        .forget();
    seed(&store, "ses_hourly", OLD);
    assert_eq!(count::<tables::FileChangeTable>(&store), 1);
    fixture.clock.tick.send_modify(|tick| *tick += 1);
    fixture
        .clock
        .sleeping
        .acquire_many(4)
        .await
        .unwrap()
        .forget();
    assert_eq!(count::<tables::FileChangeTable>(&store), 0);
    seed(&store, "ses_closing", OLD);
    let (entered, blocked) = std::sync::mpsc::sync_channel(1);
    let (release, released) = std::sync::mpsc::channel();
    let blocked_write = store
        .submit(move |_| {
            entered.send(()).unwrap();
            released.recv().unwrap();
            Ok(())
        })
        .unwrap();
    blocked.recv().unwrap();
    enabled.store(true, Ordering::SeqCst);
    fixture.clock.tick.send_modify(|tick| *tick += 1);
    sweeping.notified().await;
    let closing = tokio::spawn(async move { owner.close().await });
    tokio::task::yield_now().await;
    assert!(!closing.is_finished());
    release.send(()).unwrap();
    blocked_write.await.unwrap();
    closing.await.unwrap().unwrap();
    assert_eq!(count::<tables::FileChangeTable>(&store), 0);
    fixture.clock.tick.send_modify(|tick| *tick += 1);
    let mut next = Maintenance::start(fixture.cleanup(store.client()))
        .await
        .unwrap();
    next.close().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn tool_output_preserves_held_paths_boundary_and_unmanaged_files() {
    let fixture = Fixture::new();
    let directory = fixture.root.join("data/ycoding/tool-output");
    std::fs::create_dir_all(&directory).unwrap();
    let cutoff =
        SystemTime::UNIX_EPOCH + Duration::from_millis(NOW as u64) - tool_output_store::RETENTION;
    for (name, modified) in [
        ("tool_old", cutoff - Duration::from_millis(1)),
        ("tool_boundary", cutoff),
        ("tool_held", cutoff - Duration::from_millis(1)),
        ("other", cutoff - Duration::from_millis(1)),
    ] {
        let file = std::fs::File::create(directory.join(name)).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
    }
    let held = fixture.outputs.hold(directory.join("tool_held"));
    let other = tool_output_store::Store::new(&Roots::development(&fixture.root).unwrap());
    other
        .cleanup(SystemTime::UNIX_EPOCH + Duration::from_millis(NOW as u64))
        .await
        .unwrap();
    assert!(!directory.join("tool_old").exists());
    assert!(directory.join("tool_boundary").exists());
    assert!(directory.join("tool_held").exists());
    assert!(directory.join("other").exists());
    drop(held);
    other
        .cleanup(SystemTime::UNIX_EPOCH + Duration::from_millis(NOW as u64))
        .await
        .unwrap();
    assert!(!directory.join("tool_held").exists());
}
