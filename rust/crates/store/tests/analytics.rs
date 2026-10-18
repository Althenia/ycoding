use duckdb::types::Value;
use std::io::{BufRead, BufReader, Write};
use std::ops::Bound;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, mpsc};
use std::time::Duration;
use ycoding_store::analytics::{
    self, Change, Column, ColumnType, DeliveryTable, Engine, IntentTable, Query, Source, SourceRow,
};
use ycoding_store::{
    Catalog, Error, IndexDefinition, Metadata, Options, Snapshot, Store, TableDeclaration,
    TableSpec,
};

static SERIAL: Mutex<()> = Mutex::new(());
static PAGE_BARRIER: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>> = Mutex::new(None);
static NESTED_REPORT: Mutex<Option<analytics::Handle>> = Mutex::new(None);
static SOURCE_ROWS: AtomicU64 = AtomicU64::new(0);
static SOURCE_PAGE: AtomicU64 = AtomicU64::new(0);

struct Facts;
#[derive(Clone)]
struct Fact {
    id: u64,
    amount: i64,
    scope: Vec<u8>,
}
impl TableSpec for Facts {
    type Record = Fact;
    const NAME: &'static str = "test_retained_facts";
    const INDEXES: &'static [IndexDefinition] = &[];
    fn primary_key(row: &Fact) -> Vec<u8> {
        row.id.to_be_bytes().to_vec()
    }
    fn encode(row: &Fact) -> Result<Vec<u8>, Error> {
        Ok([
            row.id.to_be_bytes().as_slice(),
            row.amount.to_be_bytes().as_slice(),
            &row.scope,
        ]
        .concat())
    }
    fn decode(bytes: &[u8]) -> Result<Fact, Error> {
        if bytes.len() < 16 {
            return Err(Error::Rejected("invalid fact"));
        }
        Ok(Fact {
            id: u64::from_be_bytes(bytes[..8].try_into().unwrap()),
            amount: i64::from_be_bytes(bytes[8..16].try_into().unwrap()),
            scope: bytes[16..].to_vec(),
        })
    }
    fn index_key(_: &IndexDefinition, _: &Fact) -> Result<Option<Vec<u8>>, Error> {
        Err(Error::UnregisteredIndex)
    }
}
fn normalized(row: Fact) -> SourceRow {
    SourceRow {
        identity: Facts::primary_key(&row),
        scope: row.scope,
        values: vec![Value::BigInt(row.amount)],
    }
}
struct Consent;
impl TableSpec for Consent {
    type Record = bool;
    const NAME: &'static str = "test_consent";
    const INDEXES: &'static [IndexDefinition] = &[];
    fn primary_key(_: &bool) -> Vec<u8> {
        b"scope".to_vec()
    }
    fn encode(allowed: &bool) -> Result<Vec<u8>, Error> {
        Ok(vec![u8::from(*allowed)])
    }
    fn decode(bytes: &[u8]) -> Result<bool, Error> {
        match bytes {
            [0] => Ok(false),
            [1] => Ok(true),
            _ => Err(Error::Rejected("invalid consent")),
        }
    }
    fn index_key(_: &IndexDefinition, _: &bool) -> Result<Option<Vec<u8>>, Error> {
        Err(Error::UnregisteredIndex)
    }
}
fn allowed(snapshot: &Snapshot, scope: &[u8]) -> Result<bool, Error> {
    Ok(snapshot.get::<Consent>(scope)?.unwrap_or(false))
}
fn load(snapshot: &Snapshot, key: &[u8]) -> Result<Option<SourceRow>, Error> {
    let result = snapshot.get::<Facts>(key)?.map(normalized);
    let barrier = PAGE_BARRIER.lock().unwrap().take();
    if let Some((reached, release)) = barrier {
        reached.send(()).unwrap();
        release.recv_timeout(Duration::from_secs(20)).unwrap();
    }
    Ok(result)
}
fn page(snapshot: &Snapshot, after: Option<&[u8]>, limit: usize) -> Result<Vec<SourceRow>, Error> {
    SOURCE_PAGE.fetch_max(limit as u64, Ordering::Relaxed);
    let nested = NESTED_REPORT.lock().unwrap().take();
    if let Some(handle) = nested {
        assert!(matches!(
            handle.report(vec![Query {
                sql: "SELECT 1",
                parameters: vec![],
                max_rows: 1,
            }]),
            Err(analytics::Error::Busy)
        ));
    }
    if std::env::var_os("YCODING_ANALYTICS_CRASH_REBUILD").is_some_and(|phase| phase == "rebuild") {
        println!("REBUILD_SNAPSHOT_CAPTURED");
        std::io::stdout().flush().unwrap();
        let (_tx, rx) = mpsc::channel::<()>();
        rx.recv().unwrap();
    }
    let barrier = PAGE_BARRIER.lock().unwrap().take();
    if let Some((reached, release)) = barrier {
        reached.send(()).unwrap();
        release.recv_timeout(Duration::from_secs(20)).unwrap();
    }
    let rows = snapshot
        .scan::<Facts>(
            after.map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            limit,
        )?
        .into_iter()
        .map(normalized)
        .collect::<Vec<_>>();
    SOURCE_ROWS.fetch_add(rows.len() as u64, Ordering::Relaxed);
    Ok(rows)
}

#[test]
fn snapshot_reports_stage_bounded_source_pages_and_keep_one_read_boundary() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    store
        .submit(|tx| {
            for id in 0..10_017 {
                tx.put::<Facts>(&Fact {
                    id,
                    amount: id as i64,
                    scope: b"scope".to_vec(),
                })?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let engine = root.engine(&store);
    engine.rebuild().unwrap();
    let snapshot = store.snapshot().unwrap();
    put(&store, 10_017, 10_017);
    SOURCE_ROWS.store(0, Ordering::Relaxed);
    SOURCE_PAGE.store(0, Ordering::Relaxed);
    let query = || {
        vec![Query {
            sql: "SELECT count(*), sum(amount)::BIGINT FROM report_test_metrics WHERE amount >= 10015",
            parameters: vec![],
            max_rows: 1,
        }]
    };
    let result = engine
        .report_snapshot(snapshot, &["test_metrics"], query())
        .unwrap();
    assert_eq!(
        result,
        vec![vec![vec![Value::BigInt(2), Value::BigInt(20_031)]]]
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 10_017);
    assert!(SOURCE_PAGE.load(Ordering::Relaxed) <= 10_000);
    let result = engine
        .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
        .unwrap();
    assert_eq!(
        result,
        vec![vec![vec![Value::BigInt(3), Value::BigInt(30_048)]]]
    );
    assert!(matches!(
        engine.report(vec![Query {
            sql: "SELECT * FROM report_test_metrics",
            parameters: vec![],
            max_rows: 1
        }]),
        Err(analytics::Error::Duck(_))
    ));
}

#[test]
fn snapshot_report_staging_keeps_canonical_writes_free_and_rechecks_privacy() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    put(&store, 1, 10);
    let engine = root.engine(&store);
    engine.rebuild().unwrap();
    let snapshot = store.snapshot().unwrap();
    let (reached, entered) = mpsc::channel();
    let (release, held) = mpsc::channel();
    *PAGE_BARRIER.lock().unwrap() = Some((reached, held));
    let handle = engine.handle();
    std::thread::scope(|scope| {
        let report = scope.spawn(move || {
            handle.report_snapshot(
                snapshot,
                &["test_metrics"],
                vec![Query {
                    sql: "SELECT sum(amount)::BIGINT FROM report_test_metrics",
                    parameters: vec![],
                    max_rows: 1,
                }],
            )
        });
        entered.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(
            store
                .snapshot()
                .unwrap()
                .get::<Facts>(&1_u64.to_be_bytes())
                .unwrap()
                .unwrap()
                .amount,
            10
        );
        put(&store, 2, 20);
        store
            .submit(|tx| {
                tx.put::<Consent>(&false)?;
                analytics::privacy_changed(tx, b"scope".to_vec(), true)
            })
            .unwrap()
            .wait()
            .unwrap();
        release.send(()).unwrap();
        assert!(matches!(
            report.join().unwrap(),
            Err(analytics::Error::Privacy)
        ));
    });
}

#[test]
fn snapshot_report_reuses_same_view_and_restages_after_unrecorded_write() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    put(&store, 1, 10);
    put(&store, 2, 20);
    let engine = root.engine(&store);
    engine.rebuild().unwrap();
    let query = || {
        vec![Query {
            sql: "SELECT count(*), coalesce(sum(amount), 0)::BIGINT FROM report_test_metrics",
            parameters: vec![],
            max_rows: 1,
        }]
    };
    let totals = |count: i64, sum: i64| vec![vec![vec![Value::BigInt(count), Value::BigInt(sum)]]];
    SOURCE_ROWS.store(0, Ordering::Relaxed);
    let old = store.snapshot().unwrap();
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        totals(2, 30)
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 2);
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        totals(2, 30)
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 2);
    let held = (0..7)
        .map(|_| store.snapshot().unwrap())
        .collect::<Vec<_>>();
    assert!(matches!(store.snapshot(), Err(Error::SnapshotLimit)));
    drop(held);
    let order = delivery(&store).order;
    store
        .submit(|tx| {
            tx.put::<Facts>(&Fact {
                id: 3,
                amount: 30,
                scope: b"scope".to_vec(),
            })
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(delivery(&store).order, order);
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        totals(3, 60)
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 5);
    assert_eq!(
        engine
            .report_snapshot(old, &["test_metrics"], query())
            .unwrap(),
        totals(2, 30)
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 7);
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        totals(3, 60)
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 10);
    put(&store, 4, 40);
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        totals(4, 100)
    );
    engine.shutdown().unwrap();
}

#[test]
fn idle_mirror_reads_do_not_invalidate_staged_snapshot_report() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    put(&store, 1, 10);
    put(&store, 2, 20);
    let engine = root.engine(&store);
    engine.rebuild().unwrap();
    assert_report(&engine, &[10, 20]);
    let settled = delivery(&store);
    assert!(settled.valid && !settled.rebuilding);
    assert_eq!(settled.applied, settled.order);
    assert_eq!(settled.intents, 0);
    let query = || {
        vec![Query {
            sql: "SELECT count(*), coalesce(sum(amount), 0)::BIGINT FROM report_test_metrics",
            parameters: vec![],
            max_rows: 1,
        }]
    };
    let totals = |count: i64, sum: i64| vec![vec![vec![Value::BigInt(count), Value::BigInt(sum)]]];
    SOURCE_ROWS.store(0, Ordering::Relaxed);
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        totals(2, 30)
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 2);
    engine.notify().unwrap();
    assert_report(&engine, &[10, 20]);
    let idle = delivery(&store);
    assert_eq!(idle.order, settled.order);
    assert_eq!(idle.applied, settled.applied);
    assert_eq!(idle.intents, 0);
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        totals(2, 30)
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 2);
    put(&store, 3, 30);
    assert_report(&engine, &[10, 20, 30]);
    let caught_up = delivery(&store);
    assert_eq!(caught_up.applied, caught_up.order);
    assert_eq!(caught_up.intents, 0);
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        totals(3, 60)
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 5);
    engine.shutdown().unwrap();
}

#[test]
fn empty_and_read_only_transactions_keep_staged_snapshot_report() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    put(&store, 1, 10);
    put(&store, 2, 20);
    let engine = root.engine(&store);
    engine.rebuild().unwrap();
    let query = || {
        vec![Query {
            sql: "SELECT count(*), coalesce(sum(amount), 0)::BIGINT FROM report_test_metrics",
            parameters: vec![],
            max_rows: 1,
        }]
    };
    let totals = |count: i64, sum: i64| vec![vec![vec![Value::BigInt(count), Value::BigInt(sum)]]];
    SOURCE_ROWS.store(0, Ordering::Relaxed);
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        totals(2, 30)
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 2);
    store.submit(|_| Ok(())).unwrap().wait().unwrap();
    let read = store
        .submit(|tx| Ok(tx.get::<Facts>(&1_u64.to_be_bytes())?.map(|row| row.amount)))
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(read, Some(10));
    let removed = store
        .submit(|tx| tx.delete::<Facts>(&999_u64.to_be_bytes()))
        .unwrap()
        .wait()
        .unwrap();
    assert!(!removed);
    let (_, snapshot) = store
        .submit_with_snapshot(|_| Ok(()))
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        engine
            .report_snapshot(snapshot, &["test_metrics"], query())
            .unwrap(),
        totals(2, 30)
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 2);
    let removed = store
        .submit(|tx| tx.delete::<Facts>(&2_u64.to_be_bytes()))
        .unwrap()
        .wait()
        .unwrap();
    assert!(removed);
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        totals(1, 10)
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 3);
    store
        .submit(|tx| {
            tx.put::<Facts>(&Fact {
                id: 2,
                amount: 20,
                scope: b"scope".to_vec(),
            })
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        totals(2, 30)
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 5);
    engine.shutdown().unwrap();
}

#[test]
fn snapshot_report_changed_source_selection_restages() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    put(&store, 1, 10);
    put(&store, 2, 20);
    let columns: &'static [Column] = Box::leak(Box::new([Column {
        name: "amount",
        kind: ColumnType::Integer,
    }]));
    let sources: &'static [Source] = Box::leak(Box::new([
        Source {
            name: "cache_source_a",
            version: 1,
            columns,
            allowed,
            load,
            page,
        },
        Source {
            name: "cache_source_b",
            version: 1,
            columns,
            allowed,
            load,
            page,
        },
    ]));
    let engine = Engine::start(store.client(), root.0.join("derived"), sources).unwrap();
    engine.rebuild().unwrap();
    let one = || {
        vec![Query {
            sql: "SELECT count(*) FROM report_cache_source_a",
            parameters: vec![],
            max_rows: 1,
        }]
    };
    let both = || {
        vec![Query {
            sql: "SELECT (SELECT count(*) FROM report_cache_source_a)::BIGINT, (SELECT count(*) FROM report_cache_source_b)::BIGINT",
            parameters: vec![],
            max_rows: 1,
        }]
    };
    SOURCE_ROWS.store(0, Ordering::Relaxed);
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["cache_source_a"], one())
            .unwrap(),
        vec![vec![vec![Value::BigInt(2)]]]
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 2);
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["cache_source_a"], one())
            .unwrap(),
        vec![vec![vec![Value::BigInt(2)]]]
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 2);
    assert_eq!(
        engine
            .report_snapshot(
                store.snapshot().unwrap(),
                &["cache_source_a", "cache_source_b"],
                both()
            )
            .unwrap(),
        vec![vec![vec![Value::BigInt(2), Value::BigInt(2)]]]
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 6);
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["cache_source_a"], one())
            .unwrap(),
        vec![vec![vec![Value::BigInt(2)]]]
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 8);
    engine.shutdown().unwrap();
}

#[test]
fn snapshot_report_cache_refuses_after_privacy_purge() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    put(&store, 1, 10);
    put(&store, 2, 20);
    let engine = root.engine(&store);
    engine.rebuild().unwrap();
    let query = || {
        vec![Query {
            sql: "SELECT count(*), coalesce(sum(amount), 0)::BIGINT FROM report_test_metrics",
            parameters: vec![],
            max_rows: 1,
        }]
    };
    SOURCE_ROWS.store(0, Ordering::Relaxed);
    let old = store.snapshot().unwrap();
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        vec![vec![vec![Value::BigInt(2), Value::BigInt(30)]]]
    );
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        vec![vec![vec![Value::BigInt(2), Value::BigInt(30)]]]
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 2);
    store
        .submit(|tx| {
            tx.put::<Consent>(&false)?;
            analytics::privacy_changed(tx, b"scope".to_vec(), true)
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(matches!(
        engine.report_snapshot(old, &["test_metrics"], query()),
        Err(analytics::Error::Privacy)
    ));
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 2);
    engine.purge().unwrap();
    SOURCE_ROWS.store(0, Ordering::Relaxed);
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        vec![vec![vec![Value::BigInt(0), Value::BigInt(0)]]]
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 2);
    engine.shutdown().unwrap();
}
#[test]
fn snapshot_report_reuses_staging_across_derived_metadata_and_unrelated_writes() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    put(&store, 1, 10);
    put(&store, 2, 20);
    let engine = root.engine(&store);
    engine.rebuild().unwrap();
    let query = || {
        vec![Query {
            sql: "SELECT count(*), coalesce(sum(amount), 0)::BIGINT FROM report_test_metrics",
            parameters: vec![],
            max_rows: 1,
        }]
    };
    let totals = |count: i64, sum: i64| vec![vec![vec![Value::BigInt(count), Value::BigInt(sum)]]];
    SOURCE_ROWS.store(0, Ordering::Relaxed);
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        totals(2, 30)
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 2);
    let settled = delivery(&store);
    store
        .submit(move |tx| {
            let mut current = tx.get::<DeliveryTable>(&[])?.unwrap();
            current.generation += 1;
            current.applied = current.order;
            current.rebuilding = !current.rebuilding;
            tx.put::<DeliveryTable>(&current)
        })
        .unwrap()
        .wait()
        .unwrap();
    let metadata_only = delivery(&store);
    assert_eq!(metadata_only.identity, settled.identity);
    assert_eq!(metadata_only.source_generation, settled.source_generation);
    assert_eq!(metadata_only.privacy, settled.privacy);
    assert_eq!(metadata_only.order, settled.order);
    assert_ne!(metadata_only.generation, settled.generation);
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        totals(2, 30)
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 2);
    store
        .submit(|tx| {
            tx.put::<IntentTable>(&analytics::Intent {
                source: "test_metrics".to_owned(),
                identity: vec![9; 8],
                order: u64::MAX,
                generation: u64::MAX,
                delete: false,
            })
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        totals(2, 30)
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 2);
    engine.shutdown().unwrap();
}

#[test]
fn snapshot_report_restages_when_only_consent_changes() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    put(&store, 1, 10);
    put(&store, 2, 20);
    let engine = root.engine(&store);
    engine.rebuild().unwrap();
    let query = || {
        vec![Query {
            sql: "SELECT count(*), coalesce(sum(amount), 0)::BIGINT FROM report_test_metrics",
            parameters: vec![],
            max_rows: 1,
        }]
    };
    let totals = |count: i64, sum: i64| vec![vec![vec![Value::BigInt(count), Value::BigInt(sum)]]];
    SOURCE_ROWS.store(0, Ordering::Relaxed);
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        totals(2, 30)
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 2);
    let settled = delivery(&store);
    store
        .submit(|tx| tx.put::<Consent>(&false))
        .unwrap()
        .wait()
        .unwrap();
    let consent_only = delivery(&store);
    assert_eq!(consent_only.privacy, settled.privacy);
    assert_eq!(consent_only.order, settled.order);
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        totals(0, 0)
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 4);
    store
        .submit(|tx| tx.put::<Consent>(&true))
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        totals(2, 30)
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 6);
    engine.shutdown().unwrap();
}

#[test]
fn failed_snapshot_report_never_publishes_its_staging() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    put(&store, 1, 10);
    put(&store, 2, 20);
    let engine = root.engine(&store);
    engine.rebuild().unwrap();
    let query = || {
        vec![Query {
            sql: "SELECT count(*), coalesce(sum(amount), 0)::BIGINT FROM report_test_metrics",
            parameters: vec![],
            max_rows: 1,
        }]
    };
    SOURCE_ROWS.store(0, Ordering::Relaxed);
    assert!(
        engine
            .report_snapshot(
                store.snapshot().unwrap(),
                &["test_metrics"],
                vec![Query {
                    sql: "SELECT missing FROM report_test_metrics",
                    parameters: vec![],
                    max_rows: 1,
                }],
            )
            .is_err()
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 2);
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        vec![vec![vec![Value::BigInt(2), Value::BigInt(30)]]]
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 4);
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), &["test_metrics"], query())
            .unwrap(),
        vec![vec![vec![Value::BigInt(2), Value::BigInt(30)]]]
    );
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 4);
    engine.shutdown().unwrap();
}
static SOURCES: &[Source] = &[Source {
    name: "test_metrics",
    version: 1,
    columns: &[Column {
        name: "amount",
        kind: ColumnType::Integer,
    }],
    allowed,
    load,
    page,
}];
const CATALOG: Catalog = Catalog::new(
    1,
    &[
        TableDeclaration::of::<Facts>(),
        TableDeclaration::of::<DeliveryTable>(),
        TableDeclaration::of::<IntentTable>(),
        TableDeclaration::of::<Consent>(),
    ],
);
struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ycoding-analytics-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn store(&self) -> Store {
        Store::initialize(
            self.0.join("canonical.redb"),
            options(),
            CATALOG,
            metadata(),
        )
        .unwrap()
    }
    fn reopen(&self) -> Store {
        Store::open(self.0.join("canonical.redb"), options(), CATALOG).unwrap()
    }
    fn engine(&self, store: &Store) -> Engine {
        Engine::start(store.client(), self.0.join("derived"), SOURCES).unwrap()
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn options() -> Options {
    Options {
        cache_bytes: 1024 * 1024,
        queue_capacity: 256,
        max_snapshots: 8,
    }
}
fn metadata() -> Metadata {
    Metadata::new([42; 16], 1)
}
fn allow(store: &Store) {
    store
        .submit(|tx| {
            tx.put::<Consent>(&true)?;
            analytics::privacy_changed(tx, b"scope".to_vec(), false)
        })
        .unwrap()
        .wait()
        .unwrap();
}
fn put(store: &Store, id: u64, amount: i64) -> u64 {
    store
        .submit(move |tx| {
            tx.put::<Facts>(&Fact {
                id,
                amount,
                scope: b"scope".to_vec(),
            })?;
            analytics::record(
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
        .unwrap()
}
fn delete(store: &Store, id: u64) {
    store
        .submit(move |tx| {
            tx.delete::<Facts>(&id.to_be_bytes())?;
            analytics::record(
                tx,
                Change {
                    source: "test_metrics",
                    identity: id.to_be_bytes().to_vec(),
                    delete: true,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}
fn report(engine: &Engine) -> Result<Vec<Vec<Vec<Value>>>, analytics::Error> {
    engine.report(vec![
        Query {
            sql: "SELECT amount FROM test_metrics ORDER BY amount",
            parameters: vec![],
            max_rows: 100,
        },
        Query {
            sql: "SELECT count(*), coalesce(sum(amount), 0)::BIGINT FROM test_metrics",
            parameters: vec![],
            max_rows: 1,
        },
    ])
}
fn assert_report(engine: &Engine, amounts: &[i64]) {
    let rows = report(engine).unwrap();
    assert_eq!(
        rows[0],
        amounts
            .iter()
            .map(|value| vec![Value::BigInt(*value)])
            .collect::<Vec<_>>()
    );
    assert_eq!(
        rows[1],
        vec![vec![
            Value::BigInt(amounts.len() as i64),
            Value::BigInt(amounts.iter().sum())
        ]]
    );
}

#[test]
fn canonical_intents_are_atomic_and_coalesced() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    assert!(put(&store, 1, 10) > 0);
    put(&store, 1, 20);
    let snapshot = store.snapshot().unwrap();
    let delivery = snapshot.get::<DeliveryTable>(&[]).unwrap().unwrap();
    assert_eq!(
        snapshot
            .get::<Facts>(&1_u64.to_be_bytes())
            .unwrap()
            .unwrap()
            .amount,
        20
    );
    assert!(delivery.order >= 3);
    drop(snapshot);
    let rejected = store
        .submit(|tx| {
            tx.put::<Facts>(&Fact {
                id: 2,
                amount: 99,
                scope: b"scope".to_vec(),
            })?;
            analytics::record(
                tx,
                Change {
                    source: "test_metrics",
                    identity: 2_u64.to_be_bytes().to_vec(),
                    delete: false,
                },
            )?;
            Err::<(), _>(Error::Rejected("rollback source and intent"))
        })
        .unwrap()
        .wait();
    assert!(rejected.is_err());
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<Facts>(&2_u64.to_be_bytes())
            .unwrap()
            .is_none()
    );
    let engine = root.engine(&store);
    assert_report(&engine, &[20]);
    put(&store, 1, 30);
    put(&store, 2, 40);
    engine.notify().unwrap();
    assert_report(&engine, &[30, 40]);
    delete(&store, 1);
    assert_report(&engine, &[40]);
    let snapshot = store.snapshot().unwrap();
    let delivery = snapshot.get::<DeliveryTable>(&[]).unwrap().unwrap();
    assert_eq!(delivery.applied, delivery.order);
    assert_eq!(delivery.intents, 0);
    assert!(
        snapshot
            .scan::<IntentTable>(Bound::Unbounded, Bound::Unbounded, 1)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn outage_does_not_block_canonical_and_overflow_recovers_retained_state() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    let engine = root.engine(&store);
    assert_report(&engine, &[]);
    engine.shutdown().unwrap();
    for id in 0..=analytics::INTENT_LIMIT as u64 {
        put(&store, id, id as i64);
        if id == (analytics::INTENT_LIMIT - 2) as u64 || id == (analytics::INTENT_LIMIT - 1) as u64
        {
            let boundary = store
                .snapshot()
                .unwrap()
                .get::<DeliveryTable>(&[])
                .unwrap()
                .unwrap();
            assert!(boundary.valid);
            assert_eq!(boundary.intents, id as usize + 1);
        }
    }
    let delivery = store
        .snapshot()
        .unwrap()
        .get::<DeliveryTable>(&[])
        .unwrap()
        .unwrap();
    assert!(!delivery.valid);
    assert!(delivery.intents <= analytics::INTENT_LIMIT);
    assert!(delivery.bytes <= analytics::INTENT_BYTES);
    delete(&store, 0);
    store.shutdown().unwrap();
    let store = root.reopen();
    let engine = root.engine(&store);
    let rows = engine
        .report(vec![Query {
            sql: "SELECT count(*), min(amount), max(amount) FROM test_metrics",
            parameters: vec![],
            max_rows: 1,
        }])
        .unwrap();
    assert_eq!(
        rows[0],
        vec![vec![
            Value::BigInt(4096),
            Value::BigInt(1),
            Value::BigInt(4096)
        ]]
    );
    let active = store
        .snapshot()
        .unwrap()
        .get::<DeliveryTable>(&[])
        .unwrap()
        .unwrap();
    assert!(active.valid);
    assert!(active.generation > delivery.generation);
}

#[test]
fn watermarked_rebuild_catches_up_delete_and_new_changes() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    put(&store, 1, 10);
    let engine = root.engine(&store);
    let (reached, started) = mpsc::channel();
    let (release, barrier) = mpsc::channel();
    *PAGE_BARRIER.lock().unwrap() = Some((reached, barrier));
    let writer = store.client();
    let handle = engine.handle();
    std::thread::scope(|scope| {
        let rebuilding = scope.spawn(|| handle.rebuild());
        started.recv_timeout(Duration::from_secs(20)).unwrap();
        writer
            .submit(|tx| {
                tx.delete::<Facts>(&1_u64.to_be_bytes())?;
                analytics::record(
                    tx,
                    Change {
                        source: "test_metrics",
                        identity: 1_u64.to_be_bytes().to_vec(),
                        delete: true,
                    },
                )?;
                tx.put::<Facts>(&Fact {
                    id: 2,
                    amount: 20,
                    scope: b"scope".to_vec(),
                })?;
                analytics::record(
                    tx,
                    Change {
                        source: "test_metrics",
                        identity: 2_u64.to_be_bytes().to_vec(),
                        delete: false,
                    },
                )?;
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        release.send(()).unwrap();
        rebuilding.join().unwrap().unwrap();
    });
    assert_report(&engine, &[20]);
}

#[test]
fn revocation_and_pending_purge_fence_reports_and_remove_private_copies() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    put(&store, 1, 10);
    let engine = root.engine(&store);
    assert_report(&engine, &[]);
    allow(&store);
    assert_report(&engine, &[10]);
    store
        .submit(|tx| {
            tx.put::<Consent>(&false)?;
            analytics::privacy_changed(tx, b"scope".to_vec(), true)
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(matches!(report(&engine), Err(analytics::Error::Privacy)));
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .get::<DeliveryTable>(&[])
            .unwrap()
            .unwrap()
            .purges,
        vec![b"scope".to_vec()]
    );
    engine.purge().unwrap();
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<DeliveryTable>(&[])
            .unwrap()
            .unwrap()
            .purges
            .is_empty()
    );
    assert_report(&engine, &[]);
    engine.shutdown().unwrap();
    let files: Vec<_> = std::fs::read_dir(root.0.join("derived"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "duckdb"))
        .collect();
    assert_eq!(files.len(), 1);
    let derived = duckdb::Connection::open(&files[0]).unwrap();
    assert_eq!(
        derived
            .query_row("SELECT count(*) FROM test_metrics", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn missing_corrupt_derived_or_changed_source_identity_requires_rebuild() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    put(&store, 1, 10);
    let engine = root.engine(&store);
    assert_report(&engine, &[10]);
    engine.shutdown().unwrap();
    for entry in std::fs::read_dir(root.0.join("derived")).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|ext| ext == "duckdb") {
            std::fs::write(path, b"not duckdb").unwrap();
        }
    }
    delete(&store, 1);
    put(&store, 2, 20);
    let engine = root.engine(&store);
    assert_report(&engine, &[20]);
    engine.shutdown().unwrap();
    store
        .submit(|tx| {
            let mut state = tx.get::<DeliveryTable>(&[])?.unwrap();
            state.identity = [99; 16];
            tx.put::<DeliveryTable>(&state)
        })
        .unwrap()
        .wait()
        .unwrap();
    let engine = root.engine(&store);
    assert_report(&engine, &[20]);
}

#[test]
fn process_kill_after_generation_reset_never_activates_partial_candidate() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    put(&store, 1, 10);
    store.shutdown().unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "analytics_process_worker",
            "--ignored",
            "--nocapture",
        ])
        .env("YCODING_ANALYTICS_CRASH_REBUILD", "rebuild")
        .env("YCODING_ANALYTICS_TEST_ROOT", &root.0)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    assert!(lines.any(|line| line.unwrap().contains("REBUILD_SNAPSHOT_CAPTURED")));
    child.kill().unwrap();
    assert!(!child.wait().unwrap().success());
    let store = root.reopen();
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<DeliveryTable>(&[])
            .unwrap()
            .unwrap()
            .rebuilding
    );
    delete(&store, 1);
    let engine = root.engine(&store);
    assert_report(&engine, &[]);
}

#[test]
#[ignore]
fn analytics_process_worker() {
    let path = PathBuf::from(std::env::var_os("YCODING_ANALYTICS_TEST_ROOT").unwrap());
    let store = Store::open(path.join("canonical.redb"), options(), CATALOG).unwrap();
    let engine = Engine::start(store.client(), path.join("derived"), SOURCES).unwrap();
    engine.rebuild().unwrap();
    if std::env::var_os("YCODING_ANALYTICS_CRASH_REBUILD").is_some_and(|phase| phase == "committed")
    {
        println!("DERIVED_COMMIT_ACKNOWLEDGED");
        std::io::stdout().flush().unwrap();
        let (_tx, rx) = mpsc::channel::<()>();
        rx.recv().unwrap();
    }
}

#[test]
fn duckdb_down_fails_reports_without_affecting_canonical_reads_or_writes() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    std::fs::write(root.0.join("derived"), b"unavailable directory").unwrap();
    let engine = root.engine(&store);
    assert!(report(&engine).is_err());
    put(&store, 1, 10);
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .get::<Facts>(&1_u64.to_be_bytes())
            .unwrap()
            .unwrap()
            .amount,
        10
    );
    store
        .submit(|tx| {
            tx.put::<Consent>(&false)?;
            analytics::privacy_changed(tx, b"scope".to_vec(), true)
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(matches!(report(&engine), Err(analytics::Error::Privacy)));
    assert!(engine.purge().is_err());
    engine.shutdown().unwrap();
    store.shutdown().unwrap();
    std::fs::remove_file(root.0.join("derived")).unwrap();
    let store = root.reopen();
    assert!(
        !store
            .snapshot()
            .unwrap()
            .get::<DeliveryTable>(&[])
            .unwrap()
            .unwrap()
            .purges
            .is_empty()
    );
    let engine = root.engine(&store);
    engine.purge().unwrap();
    assert_report(&engine, &[]);
}

#[test]
fn encoded_intent_budget_invalidates_instead_of_rejecting_source_commit() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    let engine = root.engine(&store);
    assert_report(&engine, &[]);
    store
        .submit(|tx| {
            tx.put::<Facts>(&Fact {
                id: 1,
                amount: 10,
                scope: b"scope".to_vec(),
            })?;
            analytics::record(
                tx,
                Change {
                    source: "test_metrics",
                    identity: vec![1; analytics::INTENT_BYTES],
                    delete: false,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let state = store
        .snapshot()
        .unwrap()
        .get::<DeliveryTable>(&[])
        .unwrap()
        .unwrap();
    assert!(!state.valid);
    assert!(state.bytes <= analytics::INTENT_BYTES);
    assert_report(&engine, &[10]);
}

#[test]
fn encoded_intent_budget_accepts_exact_bytes_and_invalidates_one_byte_past() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    for delta in [-1_isize, 0, 1] {
        let root = Root::new();
        let store = root.store();
        allow(&store);
        let engine = root.engine(&store);
        assert_report(&engine, &[]);
        engine.shutdown().unwrap();
        let empty = analytics::Intent {
            source: "test_metrics".to_owned(),
            identity: vec![],
            generation: 1,
            order: 1,
            delete: false,
        };
        let overhead =
            IntentTable::primary_key(&empty).len() + IntentTable::encode(&empty).unwrap().len();
        let bytes = analytics::INTENT_BYTES.checked_add_signed(delta).unwrap();
        let mut identity = vec![1; (bytes - overhead) / 2];
        if (bytes - overhead) % 2 == 1 {
            identity[0] = 0;
        }
        store
            .submit(move |tx| {
                tx.put::<Facts>(&Fact {
                    id: 1,
                    amount: 10,
                    scope: b"scope".to_vec(),
                })?;
                analytics::record(
                    tx,
                    Change {
                        source: "test_metrics",
                        identity,
                        delete: false,
                    },
                )
            })
            .unwrap()
            .wait()
            .unwrap();
        let state = store
            .snapshot()
            .unwrap()
            .get::<DeliveryTable>(&[])
            .unwrap()
            .unwrap();
        assert_eq!(state.valid, delta <= 0);
        assert_eq!(state.bytes, if delta <= 0 { bytes } else { 0 });
        assert_eq!(state.intents, usize::from(delta <= 0));
        assert_eq!(
            store
                .snapshot()
                .unwrap()
                .get::<Facts>(&1_u64.to_be_bytes())
                .unwrap()
                .unwrap()
                .amount,
            10
        );
        put(&store, 2, 20);
        assert!(!store.is_fenced());
        store.shutdown().unwrap();
        let reopened = root.reopen();
        let persisted = reopened
            .snapshot()
            .unwrap()
            .get::<DeliveryTable>(&[])
            .unwrap()
            .unwrap();
        assert!(!persisted.valid);
    }
}

#[test]
fn cancellation_and_external_access_reject_and_leave_owner_usable() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    let engine = root.engine(&store);
    assert_report(&engine, &[]);
    let cancellation = analytics::Cancellation::default();
    cancellation.cancel();
    assert!(matches!(
        engine.report_cancellable(
            vec![Query {
                sql: "SELECT 1",
                parameters: vec![],
                max_rows: 1
            }],
            cancellation
        ),
        Err(analytics::Error::Cancelled)
    ));
    assert!(
        engine
            .report(vec![Query {
                sql: "SELECT * FROM read_csv('/not-allowed.csv')",
                parameters: vec![],
                max_rows: 1
            }])
            .is_err()
    );
    assert_report(&engine, &[]);
}

#[test]
fn replay_after_lost_ack_is_idempotent_and_does_not_skip_lower_order_identity() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    let engine = root.engine(&store);
    assert_report(&engine, &[]);
    for id in 0..=analytics::BATCH_SIZE as u64 {
        put(&store, id, 1);
    }
    put(&store, 0, 2);
    let (before_ack, intents) = {
        let snapshot = store.snapshot().unwrap();
        (
            snapshot.get::<DeliveryTable>(&[]).unwrap().unwrap(),
            snapshot
                .scan::<IntentTable>(Bound::Unbounded, Bound::Unbounded, analytics::INTENT_LIMIT)
                .unwrap(),
        )
    };
    let query = || {
        vec![Query {
            sql: "SELECT count(*), sum(amount)::BIGINT FROM test_metrics",
            parameters: vec![],
            max_rows: 1,
        }]
    };
    let expected = vec![vec![vec![Value::BigInt(129), Value::BigInt(130)]]];
    assert_eq!(engine.report(query()).unwrap(), expected);
    store
        .submit(move |tx| {
            tx.put::<DeliveryTable>(&before_ack)?;
            for intent in intents {
                tx.put::<IntentTable>(&intent)?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(engine.report(query()).unwrap(), expected);
    assert!(
        store
            .snapshot()
            .unwrap()
            .scan::<IntentTable>(Bound::Unbounded, Bound::Unbounded, 1)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn ack_compares_captured_versions_and_preserves_concurrent_coalesced_change() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    put(&store, 1, 10);
    let engine = root.engine(&store);
    assert_report(&engine, &[10]);
    put(&store, 1, 20);
    let (reached, started) = mpsc::channel();
    let (release, barrier) = mpsc::channel();
    *PAGE_BARRIER.lock().unwrap() = Some((reached, barrier));
    let handle = engine.handle();
    std::thread::scope(|scope| {
        let reading = scope.spawn(|| {
            handle.report(vec![Query {
                sql: "SELECT amount FROM test_metrics",
                parameters: vec![],
                max_rows: 1,
            }])
        });
        started.recv_timeout(Duration::from_secs(20)).unwrap();
        put(&store, 1, 99);
        release.send(()).unwrap();
        reading.join().unwrap().unwrap();
    });
    assert_report(&engine, &[99]);
}

#[test]
fn process_kill_after_derived_commit_preserves_checkpoint_and_current_source_deletes() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    put(&store, 1, 10);
    store.shutdown().unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "analytics_process_worker",
            "--ignored",
            "--nocapture",
        ])
        .env("YCODING_ANALYTICS_CRASH_REBUILD", "committed")
        .env("YCODING_ANALYTICS_TEST_ROOT", &root.0)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    assert!(
        BufReader::new(child.stdout.take().unwrap())
            .lines()
            .any(|line| line.unwrap().contains("DERIVED_COMMIT_ACKNOWLEDGED"))
    );
    child.kill().unwrap();
    assert!(!child.wait().unwrap().success());
    let store = root.reopen();
    let delivery = store
        .snapshot()
        .unwrap()
        .get::<DeliveryTable>(&[])
        .unwrap()
        .unwrap();
    assert!(delivery.valid && !delivery.rebuilding);
    assert_eq!(delivery.applied, delivery.order);
    delete(&store, 1);
    let engine = root.engine(&store);
    assert_report(&engine, &[]);
}

#[test]
fn candidate_invalidated_during_snapshot_cannot_activate() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    put(&store, 1, 10);
    let engine = root.engine(&store);
    let (reached, started) = mpsc::channel();
    let (release, barrier) = mpsc::channel();
    *PAGE_BARRIER.lock().unwrap() = Some((reached, barrier));
    let handle = engine.handle();
    std::thread::scope(|scope| {
        let rebuilding = scope.spawn(|| handle.rebuild());
        started.recv_timeout(Duration::from_secs(20)).unwrap();
        store
            .submit(|tx| {
                tx.put::<Facts>(&Fact {
                    id: 2,
                    amount: 20,
                    scope: b"scope".to_vec(),
                })?;
                analytics::record(
                    tx,
                    Change {
                        source: "test_metrics",
                        identity: vec![1; analytics::INTENT_BYTES],
                        delete: false,
                    },
                )
            })
            .unwrap()
            .wait()
            .unwrap();
        release.send(()).unwrap();
        assert!(matches!(
            rebuilding.join().unwrap(),
            Err(analytics::Error::Invalid)
        ));
    });
    assert!(
        !store
            .snapshot()
            .unwrap()
            .get::<DeliveryTable>(&[])
            .unwrap()
            .unwrap()
            .valid
    );
    assert_report(&engine, &[10, 20]);
}

#[test]
fn cancelling_running_native_query_joins_it_and_does_not_cancel_next_report() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    let engine = root.engine(&store);
    assert_report(&engine, &[]);
    let cancellation = analytics::Cancellation::default();
    let handle = engine.handle();
    let signal = cancellation.clone();
    std::thread::scope(|scope| {
        let running = scope.spawn(|| {
            handle.report_cancellable(
                vec![Query {
                    sql: "SELECT sum(i::HUGEINT * (i % 97)) FROM range(1000000000000) t(i)",
                    parameters: vec![],
                    max_rows: 1,
                }],
                signal,
            )
        });
        cancellation.wait_querying().unwrap();
        put(&store, 1, 10);
        assert_eq!(
            store
                .snapshot()
                .unwrap()
                .get::<Facts>(&1_u64.to_be_bytes())
                .unwrap()
                .unwrap()
                .amount,
            10
        );
        cancellation.cancel();
        assert!(matches!(
            running.join().unwrap(),
            Err(analytics::Error::Cancelled)
        ));
    });
    assert_report(&engine, &[10]);
}

#[test]
fn report_deadline_is_explicit_and_native_work_releases_its_connection() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    let engine = root.engine(&store);
    assert_report(&engine, &[]);
    assert!(matches!(
        engine.report(vec![Query {
            sql: "SELECT sum(i::HUGEINT * (i % 97)) FROM range(1000000000000) t(i)",
            parameters: vec![],
            max_rows: 1
        }]),
        Err(analytics::Error::Deadline)
    ));
    assert_report(&engine, &[]);
    assert!(
        engine
            .report(vec![Query {
                sql: "SELECT i FROM range(2) t(i)",
                parameters: vec![],
                max_rows: 1
            }])
            .is_err()
    );
    assert_report(&engine, &[]);
}

#[test]
fn report_request_byte_budget_is_enforced() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    let engine = root.engine(&store);
    assert_report(&engine, &[]);
    let result = engine.report(vec![Query {
        sql: "SELECT length(?)",
        parameters: vec![Value::Text("x".repeat(analytics::REPORT_BYTES + 1))],
        max_rows: 1,
    }]);
    assert!(matches!(result, Err(analytics::Error::Limit)));
    assert_report(&engine, &[]);
}

#[test]
fn recursive_report_is_rejected_without_waiting_or_blocking_canonical_work() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    let engine = root.engine(&store);
    *NESTED_REPORT.lock().unwrap() = Some(engine.handle());
    assert_report(&engine, &[]);
    put(&store, 1, 10);
    assert_report(&engine, &[10]);
}

#[test]
fn reviewed_report_count_sql_parameter_row_column_and_output_bounds() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    let engine = root.engine(&store);
    let query = || Query {
        sql: "SELECT 1",
        parameters: vec![],
        max_rows: 1,
    };
    assert_eq!(
        engine
            .report((0..16).map(|_| query()).collect())
            .unwrap()
            .len(),
        16
    );
    for queries in [
        vec![],
        (0..17).map(|_| query()).collect(),
        vec![Query {
            max_rows: 0,
            ..query()
        }],
        vec![Query {
            max_rows: 4097,
            ..query()
        }],
        vec![Query {
            parameters: vec![Value::BigInt(1); 65],
            ..query()
        }],
    ] {
        assert!(matches!(
            engine.report(queries),
            Err(analytics::Error::Configuration)
        ));
    }
    for count in [64, 65] {
        let sql = Box::leak(format!("SELECT {}", vec!["?"; count].join(",")).into_boxed_str());
        let result = engine.report(vec![Query {
            sql,
            parameters: vec![Value::BigInt(1); count],
            max_rows: 1,
        }]);
        if count == 64 {
            assert_eq!(result.unwrap()[0][0], vec![Value::BigInt(1); 64]);
        } else {
            assert!(matches!(result, Err(analytics::Error::Configuration)));
        }
        let sql = Box::leak(format!("SELECT {}", vec!["1"; count].join(",")).into_boxed_str());
        let result = engine.report(vec![Query { sql, ..query() }]);
        if count == 64 {
            assert_eq!(result.unwrap()[0][0].len(), 64);
        } else {
            assert!(matches!(result, Err(analytics::Error::Limit)));
        }
    }
    for bytes in [analytics::ROW_BYTES, analytics::ROW_BYTES + 1] {
        let sql = Box::leak(format!("SELECT 1{}", " ".repeat(bytes - 8)).into_boxed_str());
        let result = engine.report(vec![Query { sql, ..query() }]);
        if bytes == analytics::ROW_BYTES {
            assert_eq!(result.unwrap()[0], vec![vec![Value::Int(1)]]);
        } else {
            assert!(matches!(result, Err(analytics::Error::Configuration)));
        }
    }
    let rows = || Query {
        sql: "SELECT * FROM range(4096)",
        parameters: vec![],
        max_rows: 4096,
    };
    assert_eq!(engine.report(vec![rows()]).unwrap()[0].len(), 4096);
    assert!(matches!(
        engine.report(vec![rows(), query()]),
        Err(analytics::Error::Limit)
    ));
    assert!(matches!(
        engine.report(vec![Query {
            sql: "SELECT * FROM range(2)",
            ..query()
        }]),
        Err(analytics::Error::Limit)
    ));
    for bytes in [analytics::REPORT_BYTES, analytics::REPORT_BYTES + 1] {
        let input = engine.report(vec![Query {
            sql: "SELECT length(?)",
            parameters: vec![Value::Text("x".repeat(bytes))],
            max_rows: 1,
        }]);
        let output = engine.report(vec![Query {
            sql: "SELECT repeat('x', ?::BIGINT)",
            parameters: vec![Value::BigInt(bytes as i64)],
            max_rows: 1,
        }]);
        if bytes == analytics::REPORT_BYTES {
            assert_eq!(input.unwrap()[0], vec![vec![Value::BigInt(bytes as i64)]]);
            assert_eq!(
                output.unwrap()[0],
                vec![vec![Value::Text("x".repeat(bytes))]]
            );
        } else {
            assert!(matches!(input, Err(analytics::Error::Limit)));
            assert!(matches!(output, Err(analytics::Error::Limit)));
        }
    }
    assert_report(&engine, &[]);
    put(&store, 1, 10);
    assert_report(&engine, &[10]);
    engine.shutdown().unwrap();
}

#[test]
fn report_snapshot_accepts_64_sources_and_rejects_65_as_configuration() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    store
        .submit(|tx| {
            tx.put::<Facts>(&Fact {
                id: 1,
                amount: 10,
                scope: b"scope".to_vec(),
            })
        })
        .unwrap()
        .wait()
        .unwrap();
    let columns: &'static [Column] = Box::leak(Box::new([Column {
        name: "amount",
        kind: ColumnType::Integer,
    }]));
    let names: &'static [&'static str] = Box::leak(
        (0..64)
            .map(|index| &*Box::leak(format!("report_source_{index:03}").into_boxed_str()))
            .collect::<Vec<&'static str>>()
            .into_boxed_slice(),
    );
    let sources = Box::leak(
        names
            .iter()
            .copied()
            .map(|name| Source {
                name,
                version: 1,
                columns,
                allowed,
                load,
                page,
            })
            .collect::<Vec<_>>()
            .into_boxed_slice(),
    );
    let engine = Engine::start(store.client(), root.0.join("derived"), sources).unwrap();
    engine.rebuild().unwrap();
    let query = || {
        vec![Query {
            sql: "SELECT (SELECT count(*) FROM report_report_source_000)::BIGINT, (SELECT sum(amount) FROM report_report_source_063)::BIGINT",
            parameters: vec![],
            max_rows: 1,
        }]
    };
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), names, query())
            .unwrap(),
        vec![vec![vec![Value::BigInt(1), Value::BigInt(10)]]]
    );
    let oversized: &'static [&'static str] = Box::leak(
        names
            .iter()
            .copied()
            .chain([names[0]])
            .collect::<Vec<_>>()
            .into_boxed_slice(),
    );
    assert_eq!(oversized.len(), 65);
    assert!(matches!(
        engine.report_snapshot(store.snapshot().unwrap(), oversized, query()),
        Err(analytics::Error::Configuration)
    ));
    assert_eq!(
        engine
            .report_snapshot(store.snapshot().unwrap(), names, query())
            .unwrap(),
        vec![vec![vec![Value::BigInt(1), Value::BigInt(10)]]]
    );
    engine.shutdown().unwrap();
}

#[test]
fn report_scalar_output_budget_rejects_nested_values() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    let engine = root.engine(&store);
    assert_report(&engine, &[]);
    assert!(matches!(
        engine.report(vec![Query {
            sql: "SELECT [1, 2]",
            parameters: vec![],
            max_rows: 1
        }]),
        Err(analytics::Error::Configuration)
    ));
    assert_report(&engine, &[]);
}

#[test]
fn reviewed_analytics_source_column_and_identifier_configuration_bounds() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    for (source_count, column_count, name_bytes, accepted) in [
        (64, 1, 8, true),
        (65, 1, 8, false),
        (0, 1, 8, false),
        (1, 64, 8, true),
        (1, 65, 8, false),
        (1, 0, 8, false),
        (1, 1, 128, true),
        (1, 1, 129, false),
    ] {
        let root = Root::new();
        let store = root.store();
        allow(&store);
        let columns = Box::leak(
            (0..column_count)
                .map(|index| Column {
                    name: Box::leak(format!("c_{index}").into_boxed_str()),
                    kind: ColumnType::Integer,
                })
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        );
        let sources = Box::leak(
            (0..source_count)
                .map(|index| Source {
                    name: Box::leak(
                        format!("{}_{index:03}", "s".repeat(name_bytes - 4)).into_boxed_str(),
                    ),
                    version: 1,
                    columns,
                    allowed,
                    load,
                    page,
                })
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        );
        let result = Engine::start(store.client(), root.0.join("derived"), sources);
        if accepted {
            let engine = result.unwrap();
            assert_eq!(
                engine
                    .report(vec![Query {
                        sql: "SELECT 1::BIGINT",
                        parameters: vec![],
                        max_rows: 1
                    }])
                    .unwrap()[0],
                vec![vec![Value::BigInt(1)]]
            );
            engine.shutdown().unwrap();
        } else {
            assert!(matches!(result, Err(analytics::Error::Configuration)));
        }
        assert!(
            store
                .snapshot()
                .unwrap()
                .get::<Consent>(b"scope")
                .unwrap()
                .unwrap()
        );
    }
}

#[test]
fn native_resource_configuration_private_files_and_single_process_owner_are_bounded() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    put(&store, 1, 10);
    let engine = root.engine(&store);
    assert!(matches!(
        Engine::start(store.client(), root.0.join("other"), SOURCES),
        Err(analytics::Error::Busy)
    ));
    let rows = engine.report(vec![Query { sql: "SELECT current_setting('threads')::BIGINT, current_setting('memory_limit'), current_setting('max_temp_directory_size'), current_setting('enable_external_access'), current_setting('autoload_known_extensions'), current_setting('autoinstall_known_extensions'), current_setting('lock_configuration'), current_setting('max_expression_depth')::BIGINT", parameters: vec![], max_rows: 1 }, Query { sql: "SELECT sum(memory_usage_bytes)::BIGINT, sum(temporary_storage_bytes)::BIGINT FROM duckdb_memory()", parameters: vec![], max_rows: 1 }]).unwrap();
    assert_eq!(
        rows[0],
        vec![vec![
            Value::BigInt(1),
            Value::Text("256.0 MiB".to_owned()),
            Value::Text("256.0 MiB".to_owned()),
            Value::Boolean(false),
            Value::Boolean(false),
            Value::Boolean(false),
            Value::Boolean(true),
            Value::BigInt(1000)
        ]]
    );
    assert!(matches!(rows[1][0][0], Value::BigInt(bytes) if bytes <= 256 * 1024 * 1024));
    assert!(matches!(rows[1][0][1], Value::BigInt(bytes) if bytes <= 256 * 1024 * 1024));
    let root_path = root.0.join("derived");
    let spill_bytes: u64 = std::fs::read_dir(root_path.join("spill"))
        .unwrap()
        .map(|entry| entry.unwrap().metadata().unwrap().len())
        .sum();
    assert!(spill_bytes <= 256 * 1024 * 1024);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&root_path).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    engine.shutdown().unwrap();
    let surviving = Engine::start(store.client(), root.0.join("derived"), SOURCES).unwrap();
    let handle = surviving.handle();
    surviving.shutdown().unwrap();
    assert!(matches!(
        handle.report(vec![Query {
            sql: "SELECT 1",
            parameters: vec![],
            max_rows: 1
        }]),
        Err(analytics::Error::Closed)
    ));
}

#[test]
fn restored_derived_backup_ahead_checkpoint_and_pruned_gap_rebuild_current_sources() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    put(&store, 1, 10);
    let engine = root.engine(&store);
    assert_report(&engine, &[10]);
    engine.shutdown().unwrap();
    let derived = std::fs::read_dir(root.0.join("derived"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.extension().is_some_and(|ext| ext == "duckdb"))
        .unwrap();
    let backup = root.0.join("derived-backup.duckdb");
    std::fs::copy(&derived, &backup).unwrap();
    delete(&store, 1);
    let engine = root.engine(&store);
    assert_report(&engine, &[]);
    engine.shutdown().unwrap();
    std::fs::copy(backup, &derived).unwrap();
    let old_generation = store
        .snapshot()
        .unwrap()
        .get::<DeliveryTable>(&[])
        .unwrap()
        .unwrap()
        .generation;
    let engine = root.engine(&store);
    assert_report(&engine, &[]);
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<DeliveryTable>(&[])
            .unwrap()
            .unwrap()
            .generation
            > old_generation
    );
    engine.shutdown().unwrap();
    let derived = std::fs::read_dir(root.0.join("derived"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.extension().is_some_and(|ext| ext == "duckdb"))
        .unwrap();
    let connection = duckdb::Connection::open(&derived).unwrap();
    connection
        .execute(
            "UPDATE analytics_checkpoint SET source_order = source_order + 1000",
            [],
        )
        .unwrap();
    drop(connection);
    put(&store, 2, 20);
    let engine = root.engine(&store);
    assert_report(&engine, &[20]);
    engine.shutdown().unwrap();
    put(&store, 3, 30);
    store
        .submit(|tx| {
            for intent in
                tx.scan::<IntentTable>(Bound::Unbounded, Bound::Unbounded, analytics::INTENT_LIMIT)?
            {
                tx.delete::<IntentTable>(&IntentTable::primary_key(&intent))?;
            }
            let mut state = tx.get::<DeliveryTable>(&[])?.unwrap();
            state.intents = 0;
            state.bytes = 0;
            tx.put::<DeliveryTable>(&state)
        })
        .unwrap()
        .wait()
        .unwrap();
    let engine = root.engine(&store);
    assert_report(&engine, &[20, 30]);
}

#[test]
fn selected_older_canonical_restore_can_restore_rows_and_consent_after_generation_advance() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    put(&store, 1, 10);
    let engine = root.engine(&store);
    assert_report(&engine, &[10]);
    engine.shutdown().unwrap();
    store.shutdown().unwrap();
    let backup = root.0.join("canonical-backup.redb");
    std::fs::copy(root.0.join("canonical.redb"), &backup).unwrap();
    let store = root.reopen();
    store
        .submit(|tx| {
            tx.put::<Consent>(&false)?;
            tx.delete::<Facts>(&1_u64.to_be_bytes())?;
            analytics::privacy_changed(tx, b"scope".to_vec(), true)
        })
        .unwrap()
        .wait()
        .unwrap();
    let engine = root.engine(&store);
    engine.purge().unwrap();
    assert_report(&engine, &[]);
    engine.shutdown().unwrap();
    store.shutdown().unwrap();
    std::fs::copy(backup, root.0.join("canonical.redb")).unwrap();
    let database = redb::Database::open(root.0.join("canonical.redb")).unwrap();
    let mut transaction = database.begin_write().unwrap();
    transaction
        .set_durability(redb::Durability::Immediate)
        .unwrap();
    {
        let mut table = transaction
            .open_table(redb::TableDefinition::<&[u8], &[u8]>::new(
                "storage_metadata",
            ))
            .unwrap();
        table
            .insert(b"generation".as_slice(), 2_u64.to_be_bytes().as_slice())
            .unwrap();
    }
    transaction.commit().unwrap();
    drop(database);
    let store = root.reopen();
    assert_eq!(store.metadata().generation, 2);
    assert_eq!(
        store.snapshot().unwrap().get::<Consent>(b"scope").unwrap(),
        Some(true)
    );
    let engine = root.engine(&store);
    assert_report(&engine, &[10]);
    let active = store
        .snapshot()
        .unwrap()
        .get::<DeliveryTable>(&[])
        .unwrap()
        .unwrap();
    assert_eq!(active.source_generation, 2);
    assert!(active.valid && !active.rebuilding);
}

fn delivery(store: &Store) -> analytics::Delivery {
    store
        .snapshot()
        .unwrap()
        .get::<DeliveryTable>(&[])
        .unwrap()
        .unwrap()
}

fn seed_facts(store: &Store, rows: u64) {
    store
        .submit(move |tx| {
            for id in 0..rows {
                tx.put::<Facts>(&Fact {
                    id,
                    amount: id as i64,
                    scope: b"scope".to_vec(),
                })?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn mirror_totals(engine: &Engine) -> Vec<Value> {
    engine
        .report(vec![Query {
            sql: "SELECT count(*), coalesce(sum(amount), 0)::BIGINT FROM test_metrics",
            parameters: vec![],
            max_rows: 1,
        }])
        .unwrap()[0][0]
        .clone()
}

fn derived_files(root: &Root) -> Vec<PathBuf> {
    std::fs::read_dir(root.0.join("derived"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "duckdb"))
        .collect()
}

fn cancel_inline_rebuild(engine: &Engine) {
    let (reached, started) = mpsc::channel();
    let (release, barrier) = mpsc::channel();
    *PAGE_BARRIER.lock().unwrap() = Some((reached, barrier));
    let cancellation = analytics::Cancellation::default();
    let signal = cancellation.clone();
    let handle = engine.handle();
    std::thread::scope(|scope| {
        let running = scope.spawn(|| {
            handle.report_cancellable(
                vec![Query {
                    sql: "SELECT count(*) FROM test_metrics",
                    parameters: vec![],
                    max_rows: 1,
                }],
                signal,
            )
        });
        started.recv_timeout(Duration::from_secs(20)).unwrap();
        cancellation.cancel();
        release.send(()).unwrap();
        assert!(matches!(
            running.join().unwrap(),
            Err(analytics::Error::Cancelled)
        ));
    });
}

#[test]
fn cancelled_inline_rebuild_resumes_its_generation_instead_of_restarting() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    let rows = analytics::BATCH_SIZE as u64 * 3 + 5;
    seed_facts(&store, rows);
    let engine = root.engine(&store);
    cancel_inline_rebuild(&engine);
    let interrupted = delivery(&store);
    assert!(interrupted.valid && interrupted.rebuilding);
    engine.rebuild().unwrap();
    let rebuilt = delivery(&store);
    assert!(rebuilt.valid && !rebuilt.rebuilding);
    assert_eq!(rebuilt.generation, interrupted.generation);
    assert_eq!(rebuilt.applied, rebuilt.order);
    assert_eq!(
        mirror_totals(&engine),
        vec![
            Value::BigInt(rows as i64),
            Value::BigInt((0..rows as i64).sum())
        ]
    );
    engine.shutdown().unwrap();
    assert_eq!(derived_files(&root).len(), 1);
}

#[test]
fn interrupted_rebuild_restarts_after_invalidation_and_catches_up_new_changes() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    let rows = analytics::BATCH_SIZE as u64 * 3 + 5;
    seed_facts(&store, rows);
    let engine = root.engine(&store);
    cancel_inline_rebuild(&engine);
    let interrupted = delivery(&store);
    allow(&store);
    delete(&store, 0);
    put(&store, rows, 1_000);
    engine.rebuild().unwrap();
    let rebuilt = delivery(&store);
    assert!(rebuilt.valid && !rebuilt.rebuilding);
    assert!(rebuilt.generation > interrupted.generation);
    assert_eq!(
        mirror_totals(&engine),
        vec![
            Value::BigInt(rows as i64),
            Value::BigInt((1..rows as i64).sum::<i64>() + 1_000)
        ]
    );
    engine.shutdown().unwrap();
    assert_eq!(derived_files(&root).len(), 1);
}

#[test]
fn purge_after_an_interrupted_rebuild_rebuilds_without_purged_scope() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    let rows = analytics::BATCH_SIZE as u64 * 3 + 5;
    seed_facts(&store, rows);
    let engine = root.engine(&store);
    cancel_inline_rebuild(&engine);
    store
        .submit(|tx| {
            tx.put::<Consent>(&false)?;
            analytics::privacy_changed(tx, b"scope".to_vec(), true)
        })
        .unwrap()
        .wait()
        .unwrap();
    engine.purge().unwrap();
    let purged = delivery(&store);
    assert!(purged.valid && !purged.rebuilding && !purged.purge_all && purged.purges.is_empty());
    assert_eq!(
        mirror_totals(&engine),
        vec![Value::BigInt(0), Value::BigInt(0)]
    );
    engine.shutdown().unwrap();
    assert_eq!(derived_files(&root).len(), 1);
}

#[test]
fn shutdown_during_an_interrupted_rebuild_leaves_one_activated_generation_after_restart() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    let rows = analytics::BATCH_SIZE as u64 * 3 + 5;
    seed_facts(&store, rows);
    let engine = root.engine(&store);
    cancel_inline_rebuild(&engine);
    engine.shutdown().unwrap();
    assert!(delivery(&store).rebuilding);
    let engine = root.engine(&store);
    assert_eq!(
        mirror_totals(&engine),
        vec![
            Value::BigInt(rows as i64),
            Value::BigInt((0..rows as i64).sum())
        ]
    );
    let active = delivery(&store);
    assert!(active.valid && !active.rebuilding);
    engine.shutdown().unwrap();
    assert_eq!(derived_files(&root).len(), 1);
}

fn slice_rows() -> u64 {
    (analytics::BATCH_SIZE * analytics::REBUILD_SLICE_PAGES * 2 + 5) as u64
}

fn maintain_to_completion(engine: &Engine) -> usize {
    let mut pending = 0;
    loop {
        match engine.maintain().unwrap() {
            analytics::Maintenance::Pending => pending += 1,
            analytics::Maintenance::Complete => return pending,
        }
        assert!(pending < 1_000, "maintenance never completed");
    }
}

#[test]
fn maintenance_rebuilds_in_bounded_slices_that_interleave_snapshot_reads() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    let rows = slice_rows();
    seed_facts(&store, rows);
    let engine = root.engine(&store);
    assert_eq!(analytics::REBUILD_SLICE_PAGES, 64);
    SOURCE_PAGE.store(0, Ordering::Relaxed);
    SOURCE_ROWS.store(0, Ordering::Relaxed);
    assert!(matches!(
        engine.maintain().unwrap(),
        analytics::Maintenance::Pending
    ));
    let first = delivery(&store);
    assert!(first.valid && first.rebuilding);
    assert!(SOURCE_PAGE.load(Ordering::Relaxed) <= analytics::BATCH_SIZE as u64);
    assert_eq!(SOURCE_ROWS.load(Ordering::Relaxed), 128 * 64);
    assert_eq!(
        engine
            .report_snapshot(
                store.snapshot().unwrap(),
                &["test_metrics"],
                vec![Query {
                    sql: "SELECT count(*), sum(amount)::BIGINT FROM report_test_metrics",
                    parameters: vec![],
                    max_rows: 1,
                }],
            )
            .unwrap(),
        vec![vec![vec![
            Value::BigInt(rows as i64),
            Value::BigInt((0..rows as i64).sum())
        ]]]
    );
    assert!(delivery(&store).rebuilding);
    put(&store, rows, 7);
    assert!(maintain_to_completion(&engine) >= 1);
    let done = delivery(&store);
    assert!(done.valid && !done.rebuilding);
    assert_eq!(done.generation, first.generation);
    assert_eq!(done.applied, done.order);
    assert_eq!(
        mirror_totals(&engine),
        vec![
            Value::BigInt(rows as i64 + 1),
            Value::BigInt((0..rows as i64).sum::<i64>() + 7)
        ]
    );
    assert!(matches!(
        engine.maintain().unwrap(),
        analytics::Maintenance::Complete
    ));
    assert_eq!(delivery(&store).generation, done.generation);
    engine.shutdown().unwrap();
    assert_eq!(derived_files(&root).len(), 1);
}

#[test]
fn maintenance_abandons_a_stale_slice_after_privacy_purge() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.store();
    allow(&store);
    seed_facts(&store, slice_rows());
    let engine = root.engine(&store);
    assert!(matches!(
        engine.maintain().unwrap(),
        analytics::Maintenance::Pending
    ));
    let first = delivery(&store);
    store
        .submit(|tx| {
            tx.put::<Consent>(&false)?;
            analytics::privacy_changed(tx, b"scope".to_vec(), true)
        })
        .unwrap()
        .wait()
        .unwrap();
    maintain_to_completion(&engine);
    let done = delivery(&store);
    assert!(done.valid && !done.rebuilding && !done.purge_all && done.purges.is_empty());
    assert!(done.generation > first.generation);
    assert_eq!(
        mirror_totals(&engine),
        vec![Value::BigInt(0), Value::BigInt(0)]
    );
    engine.shutdown().unwrap();
    assert_eq!(derived_files(&root).len(), 1);
}
