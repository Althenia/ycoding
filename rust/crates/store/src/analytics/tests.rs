use super::{Worker, apply, checkpoint, cleanup, schema};
use crate::analytics::{
    BATCH_SIZE, Cancellation, Change, Column, ColumnType, DeliveryTable, Error, IntentTable,
    Operation, Query, REPORT_DEADLINE, Source, SourceRow, privacy_changed, record,
};
use crate::{
    Catalog, IndexDefinition, Metadata, Options, Snapshot, Store, TableDeclaration, TableSpec,
};
use duckdb::types::Value;
use std::ops::Bound;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

struct Facts;
struct Consent;
static FAIL_SECOND: AtomicBool = AtomicBool::new(false);
static SERIAL: Mutex<()> = Mutex::new(());
static PAGE_BARRIER: Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>> =
    Mutex::new(None);
impl TableSpec for Facts {
    type Record = (u64, i64);
    const NAME: &'static str = "test_facts";
    const INDEXES: &'static [IndexDefinition] = &[];
    fn primary_key(row: &(u64, i64)) -> Vec<u8> {
        row.0.to_be_bytes().to_vec()
    }
    fn encode(row: &(u64, i64)) -> Result<Vec<u8>, crate::Error> {
        Ok([row.0.to_be_bytes(), row.1.to_be_bytes()].concat())
    }
    fn decode(bytes: &[u8]) -> Result<(u64, i64), crate::Error> {
        if bytes.len() != 16 {
            return Err(crate::Error::Rejected("fact codec"));
        }
        Ok((
            u64::from_be_bytes(bytes[..8].try_into().unwrap()),
            i64::from_be_bytes(bytes[8..].try_into().unwrap()),
        ))
    }
    fn index_key(_: &IndexDefinition, _: &(u64, i64)) -> Result<Option<Vec<u8>>, crate::Error> {
        Err(crate::Error::UnregisteredIndex)
    }
}
impl TableSpec for Consent {
    type Record = bool;
    const NAME: &'static str = "test_consent";
    const INDEXES: &'static [IndexDefinition] = &[];
    fn primary_key(_: &bool) -> Vec<u8> {
        Vec::new()
    }
    fn encode(allowed: &bool) -> Result<Vec<u8>, crate::Error> {
        Ok(vec![u8::from(*allowed)])
    }
    fn decode(bytes: &[u8]) -> Result<bool, crate::Error> {
        match bytes {
            [0] => Ok(false),
            [1] => Ok(true),
            _ => Err(crate::Error::Rejected("consent codec")),
        }
    }
    fn index_key(_: &IndexDefinition, _: &bool) -> Result<Option<Vec<u8>>, crate::Error> {
        Err(crate::Error::UnregisteredIndex)
    }
}
fn normalized(row: (u64, i64)) -> SourceRow {
    SourceRow {
        identity: row.0.to_be_bytes().to_vec(),
        scope: Vec::new(),
        values: vec![Value::BigInt(row.1)],
    }
}
fn load(snapshot: &Snapshot, identity: &[u8]) -> Result<Option<SourceRow>, crate::Error> {
    if identity == 2_u64.to_be_bytes() && FAIL_SECOND.load(Ordering::Acquire) {
        return Err(crate::Error::Rejected(
            "injected normalized-source decode failure",
        ));
    }
    Ok(snapshot.get::<Facts>(identity)?.map(normalized))
}
static SOURCES: &[Source] = &[Source {
    name: "test_metrics",
    version: 1,
    columns: &[Column {
        name: "amount",
        kind: ColumnType::Integer,
    }],
    allowed: |snapshot, _| Ok(snapshot.get::<Consent>(&[])?.unwrap_or(false)),
    load,
    page: |snapshot, after, limit| {
        let barrier = PAGE_BARRIER.lock().unwrap().take();
        if let Some((reached, release)) = barrier {
            reached.send(()).unwrap();
            release
                .recv_timeout(std::time::Duration::from_secs(20))
                .unwrap();
        }
        Ok(snapshot
            .scan::<Facts>(
                after.map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
                limit,
            )?
            .into_iter()
            .map(normalized)
            .collect())
    },
}];
const CATALOG: Catalog = Catalog::new(
    1,
    &[
        TableDeclaration::of::<Facts>(),
        TableDeclaration::of::<Consent>(),
        TableDeclaration::of::<DeliveryTable>(),
        TableDeclaration::of::<IntentTable>(),
    ],
);
struct Root(PathBuf);
impl Drop for Root {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn metadata() -> Metadata {
    Metadata::new([83; 16], 1)
}
fn setup() -> (Root, Store, Worker) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let root = Root(std::env::temp_dir().join(format!(
        "ycoding-analytics-native-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )));
    std::fs::create_dir(&root.0).unwrap();
    let store = Store::initialize(
        root.0.join("canonical.redb"),
        Options {
            cache_bytes: 1024 * 1024,
            queue_capacity: 256,
            max_snapshots: 8,
        },
        CATALOG,
        metadata(),
    )
    .unwrap();
    store
        .submit(|tx| {
            tx.put::<Consent>(&true)?;
            privacy_changed(tx, Vec::new(), false)
        })
        .unwrap()
        .wait()
        .unwrap();
    let worker = Worker {
        store: store.client(),
        root: root.0.join("derived"),
        schema: schema(SOURCES),
        sources: SOURCES,
        connection: None,
        generation: None,
        before_release: None,
    };
    (root, store, worker)
}
fn put(store: &Store, id: u64, amount: i64) {
    store
        .submit(move |tx| {
            tx.put::<Facts>(&(id, amount))?;
            record(
                tx,
                Change {
                    source: "test_metrics",
                    identity: id.to_be_bytes().to_vec(),
                    delete: false,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}
fn queries() -> Vec<Query> {
    vec![
        Query {
            sql: "SELECT amount FROM test_metrics ORDER BY amount",
            parameters: Vec::new(),
            max_rows: BATCH_SIZE,
        },
        Query {
            sql: "SELECT count(*), sum(amount)::BIGINT FROM test_metrics",
            parameters: Vec::new(),
            max_rows: 1,
        },
    ]
}

#[test]
fn native_rows_and_checkpoint_rollback_together_then_lost_ack_reconciles_on_reopen() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let (_root, store, mut worker) = setup();
    put(&store, 1, 10);
    worker
        .rebuild(&Cancellation::default(), Instant::now() + REPORT_DEADLINE)
        .unwrap();
    let prior = checkpoint(worker.connection.as_ref().unwrap())
        .unwrap()
        .order;
    put(&store, 1, 20);
    put(&store, 2, 30);
    let snapshot = store.snapshot().unwrap();
    let state = snapshot.get::<DeliveryTable>(&[]).unwrap().unwrap();
    let intents = snapshot
        .scan::<IntentTable>(Bound::Unbounded, Bound::Unbounded, BATCH_SIZE)
        .unwrap();
    FAIL_SECOND.store(true, Ordering::Release);
    let failed = apply(
        worker.connection.as_mut().unwrap(),
        &snapshot,
        &state,
        &intents,
        SOURCES,
        &worker.schema,
        (&Cancellation::default(), Instant::now() + REPORT_DEADLINE),
    );
    FAIL_SECOND.store(false, Ordering::Release);
    assert!(matches!(
        failed,
        Err(Error::Store(crate::Error::Rejected(_)))
    ));
    let connection = worker.connection.as_ref().unwrap();
    assert_eq!(checkpoint(connection).unwrap().order, prior);
    assert_eq!(
        connection
            .query_row("SELECT sum(amount)::BIGINT FROM test_metrics", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        10
    );
    apply(
        worker.connection.as_mut().unwrap(),
        &snapshot,
        &state,
        &intents,
        SOURCES,
        &worker.schema,
        (&Cancellation::default(), Instant::now() + REPORT_DEADLINE),
    )
    .unwrap();
    assert_eq!(
        checkpoint(worker.connection.as_ref().unwrap())
            .unwrap()
            .order,
        state.order
    );
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .get::<DeliveryTable>(&[])
            .unwrap()
            .unwrap()
            .applied,
        prior
    );
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<IntentTable>(Bound::Unbounded, Bound::Unbounded, BATCH_SIZE)
            .unwrap(),
        intents
    );
    drop(snapshot);
    worker.connection.take();
    worker.generation = None;
    worker
        .synchronize(&Cancellation::default(), Instant::now() + REPORT_DEADLINE)
        .unwrap();
    let active = store
        .snapshot()
        .unwrap()
        .get::<DeliveryTable>(&[])
        .unwrap()
        .unwrap();
    assert_eq!(active.applied, state.order);
    assert_eq!(active.intents, 0);
    assert_eq!(
        worker
            .connection
            .as_ref()
            .unwrap()
            .query_row(
                "SELECT count(*), sum(amount)::BIGINT FROM test_metrics",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
            )
            .unwrap(),
        (2, 50)
    );
}

#[test]
fn analytics_queue_deadline_and_cancellation_bounds_leave_canonical_work_available() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let (root, store, worker) = setup();
    drop(worker);
    let engine =
        crate::analytics::Engine::start(store.client(), root.0.join("derived"), SOURCES).unwrap();
    let (started, reached) = std::sync::mpsc::channel();
    let (release, barrier) = std::sync::mpsc::channel();
    *PAGE_BARRIER.lock().unwrap() = Some((started, barrier));
    let (reply, first) = std::sync::mpsc::sync_channel(1);
    engine
        .send(crate::analytics::Command {
            operation: Operation::Rebuild,
            cancellation: Cancellation::default(),
            deadline: Instant::now() + REPORT_DEADLINE,
            reply: Some(reply),
        })
        .unwrap();
    reached
        .recv_timeout(std::time::Duration::from_secs(20))
        .unwrap();
    for _ in 0..254 {
        engine.notify().unwrap();
    }
    let mut receipts = Vec::new();
    for expired in [false, true] {
        let (reply, receipt) = std::sync::mpsc::sync_channel(1);
        let cancellation = Cancellation::default();
        if !expired {
            cancellation.cancel();
        }
        engine
            .send(crate::analytics::Command {
                operation: Operation::Rebuild,
                cancellation,
                deadline: if expired {
                    Instant::now()
                } else {
                    Instant::now() + REPORT_DEADLINE
                },
                reply: Some(reply),
            })
            .unwrap();
        receipts.push(receipt);
    }
    assert!(matches!(engine.rebuild(), Err(Error::Busy)));
    engine.notify().unwrap();
    put(&store, 1, 10);
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .get::<Facts>(&1_u64.to_be_bytes())
            .unwrap(),
        Some((1, 10))
    );
    release.send(()).unwrap();
    first
        .recv_timeout(std::time::Duration::from_secs(20))
        .unwrap()
        .unwrap();
    assert!(matches!(
        receipts[0]
            .recv_timeout(std::time::Duration::from_secs(20))
            .unwrap(),
        Err(Error::Cancelled)
    ));
    assert!(matches!(
        receipts[1]
            .recv_timeout(std::time::Duration::from_secs(20))
            .unwrap(),
        Err(Error::Deadline)
    ));
    assert_eq!(
        engine.report(queries()).unwrap()[0],
        vec![vec![Value::BigInt(10)]]
    );
    engine.shutdown().unwrap();
}

#[test]
fn native_configuration_locks_selected_bounds_and_rejects_one_past() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let (_root, store, mut worker) = setup();
    worker
        .execute(
            Operation::Rebuild,
            &Cancellation::default(),
            Instant::now() + REPORT_DEADLINE,
        )
        .unwrap();
    let connection = worker.connection.as_ref().unwrap();
    for (setting, selected, overflow) in [
        ("threads", "2", "3"),
        ("memory_limit", "256.0 MiB", "268435457B"),
        ("max_temp_directory_size", "256.0 MiB", "268435457B"),
        ("max_expression_depth", "1000", "1001"),
    ] {
        let query = format!("SELECT current_setting('{setting}')::VARCHAR");
        assert_eq!(
            connection
                .query_row(&query, [], |row| row.get::<_, String>(0))
                .unwrap(),
            selected
        );
        let error = connection
            .execute_batch(&format!("SET {setting} = '{overflow}'"))
            .map_err(Error::from)
            .unwrap_err();
        assert!(matches!(error, Error::Duck(_)));
        assert!(
            error.to_string().contains("configuration") && error.to_string().contains("locked")
        );
        assert_eq!(
            connection
                .query_row(&query, [], |row| row.get::<_, String>(0))
                .unwrap(),
            selected
        );
    }
    put(&store, 1, 10);
    assert_eq!(
        worker
            .execute(
                Operation::Report(worker.read_state().unwrap(), queries()),
                &Cancellation::default(),
                Instant::now() + REPORT_DEADLINE
            )
            .unwrap()[0],
        vec![vec![Value::BigInt(10)]]
    );
}

#[test]
fn cleanup_removes_only_owned_non_kept_generations_and_never_foreign_entries() {
    let (root, _store, _worker) = setup();
    let derived = root.0.join("derived");
    std::fs::create_dir_all(derived.join("spill")).unwrap();
    std::fs::write(derived.join("spill/block"), "spill").unwrap();
    let kept = "generation-53-1-2.duckdb";
    for name in [
        kept,
        "generation-53-1-2.duckdb.wal",
        "generation-53-1-1.duckdb",
        "generation-53-1-1.duckdb.wal",
    ] {
        std::fs::write(derived.join(name), name).unwrap();
    }
    cleanup(&derived, Some(kept)).unwrap();
    let mut entries = std::fs::read_dir(&derived)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect::<Vec<_>>();
    entries.sort();
    assert_eq!(
        entries,
        [kept, "generation-53-1-2.duckdb.wal", "spill"].map(String::from)
    );
    assert_eq!(
        std::fs::read_to_string(derived.join("spill/block")).unwrap(),
        "spill"
    );

    std::fs::write(derived.join("generation-53-1-1.duckdb"), "stale").unwrap();
    std::fs::write(derived.join("foreign.log"), "foreign").unwrap();
    assert!(matches!(
        cleanup(&derived, Some(kept)),
        Err(Error::Configuration)
    ));
    assert_eq!(
        std::fs::read_to_string(derived.join("foreign.log")).unwrap(),
        "foreign"
    );
    for name in [
        kept,
        "generation-53-1-2.duckdb.wal",
        "generation-53-1-1.duckdb",
    ] {
        assert!(derived.join(name).is_file(), "{name}");
    }
}

#[test]
fn completed_read_rechecks_canonical_consent_before_releasing_rows() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let (_root, store, mut worker) = setup();
    put(&store, 1, 10);
    let captured = worker
        .rebuild(&Cancellation::default(), Instant::now() + REPORT_DEADLINE)
        .unwrap();
    let client = store.client();
    worker.before_release = Some(Box::new(move || {
        client
            .submit(|tx| {
                tx.put::<Consent>(&false)?;
                privacy_changed(tx, Vec::new(), true)
            })
            .unwrap()
            .wait()
            .unwrap();
    }));
    let result = worker.execute(
        Operation::Report(captured, queries()),
        &Cancellation::default(),
        Instant::now() + REPORT_DEADLINE,
    );
    assert!(matches!(result, Err(Error::Privacy)));
    assert_eq!(
        store.snapshot().unwrap().get::<Consent>(&[]).unwrap(),
        Some(false)
    );
    assert!(worker.read_state().unwrap().pending_purge());
    worker
        .execute(
            Operation::Purge,
            &Cancellation::default(),
            Instant::now() + REPORT_DEADLINE,
        )
        .unwrap();
    assert!(!worker.read_state().unwrap().pending_purge());
}

#[test]
fn rows_totals_and_pagination_share_read_view_without_cross_request_snapshot_claim() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let (_root, store, mut worker) = setup();
    put(&store, 1, 10);
    let captured = worker
        .rebuild(&Cancellation::default(), Instant::now() + REPORT_DEADLINE)
        .unwrap();
    let client = store.client();
    worker.before_release = Some(Box::new(move || {
        client
            .submit(|tx| {
                tx.put::<Facts>(&(1, 99))?;
                record(
                    tx,
                    Change {
                        source: "test_metrics",
                        identity: 1_u64.to_be_bytes().to_vec(),
                        delete: false,
                    },
                )
            })
            .unwrap()
            .wait()
            .unwrap();
    }));
    let rows = worker
        .execute(
            Operation::Report(captured, queries()),
            &Cancellation::default(),
            Instant::now() + REPORT_DEADLINE,
        )
        .unwrap();
    assert_eq!(
        rows,
        vec![
            vec![vec![Value::BigInt(10)]],
            vec![vec![Value::BigInt(1), Value::BigInt(10)]]
        ]
    );
    let captured = worker.read_state().unwrap();
    let rows = worker
        .execute(
            Operation::Report(captured, queries()),
            &Cancellation::default(),
            Instant::now() + REPORT_DEADLINE,
        )
        .unwrap();
    assert_eq!(
        rows,
        vec![
            vec![vec![Value::BigInt(99)]],
            vec![vec![Value::BigInt(1), Value::BigInt(99)]]
        ]
    );
}
