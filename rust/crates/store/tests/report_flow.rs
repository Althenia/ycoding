use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use ycoding_schema::{DomainDecode, model, parse_json, provider, telemetry};
use ycoding_store::analytics::{self, Cancellation, DeliveryTable, Query, Value, reports};
use ycoding_store::import::{self, DatabaseKind};
use ycoding_store::{KeyPart, Metadata, Options, Store, project, resources, session, tuple_key};

static SERIAL: Mutex<()> = Mutex::new(());
const WORK_LIMIT: usize = 65_536;
const HEAVY: &str = "SELECT sum(i::HUGEINT * (i % 97)) FROM range(1000000000000) t(i)";

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ycoding-report-flow-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn canonical(&self) -> PathBuf {
        self.0.join("canonical.redb")
    }
    fn derived(&self) -> PathBuf {
        self.0.join("derived")
    }
    fn init(&self) -> Store {
        Store::initialize(
            self.canonical(),
            Options::core(),
            import::catalog(DatabaseKind::Core),
            Metadata::new([66; 16], 1),
        )
        .unwrap()
    }
    fn open(&self) -> Store {
        Store::open(
            self.canonical(),
            Options::core(),
            import::catalog(DatabaseKind::Core),
        )
        .unwrap()
    }
    fn engine(&self, store: &Store) -> analytics::Engine {
        reports::start(store.client(), self.derived()).unwrap()
    }
    fn derived_file(&self) -> PathBuf {
        std::fs::read_dir(self.derived())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.extension().is_some_and(|ext| ext == "duckdb"))
            .unwrap()
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[derive(Clone, Default)]
struct Model {
    requests: BTreeMap<String, (String, f64, f64)>,
    sessions: BTreeSet<String>,
    project: bool,
    consent: bool,
    latency: usize,
}

fn key(id: &str) -> Vec<u8> {
    tuple_key(&[KeyPart::String(&id.into())])
}

fn request(id: &str, session: &str, order: i64, input: f64, cost: f64) -> resources::Request {
    resources::Request {
        id: id.into(),
        session_id: session.into(),
        input_id: None,
        assistant_message_id: None,
        connection_identity_digest: None,
        source: "step".into(),
        agent: "build".into(),
        model: session::Document::from_domain(&model::Ref {
            provider_id: provider::Id("openai".into()),
            id: "model_a".into(),
            variant: None,
            profile: None,
        })
        .unwrap(),
        route_id: "private-route".into(),
        prompt_cache_key: "private-cache".into(),
        system_digest: "private-system".into(),
        tool_digest: "private-tools".into(),
        request: order,
        attempts: 1,
        invalidation: "none".into(),
        continuation: "full".into(),
        cache_read_reported: Some(1),
        timing: None,
        cost: Some(cost),
        tokens: session::Document::new(
            parse_json(&format!(
                r#"{{"input":{input},"output":0,"reasoning":0,"cache":{{"read":0,"write":0}}}}"#
            ))
            .unwrap(),
        )
        .unwrap(),
        time_created: order,
    }
}

fn session_row(id: &str) -> session::Session {
    session::Session {
        id: id.into(),
        project_id: "p".into(),
        workspace_id: None,
        parent_id: None,
        fork_session_id: None,
        fork_message_id: None,
        fork_seq: None,
        directory: "/project".into(),
        path: None,
        title: "Title".into(),
        cost: 0.0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        revert: None,
        permission: None,
        autonomy: None,
        autonomy_revision: 0,
        orchestration_revision: 0,
        agent: None,
        model: None,
        profile_binding: None,
        daybreak: None,
        time_created: 1,
        time_updated: 1,
        time_archived: None,
        time_active: None,
        time_pinned: None,
        time_suspended: None,
    }
}

fn sample() -> session::Document<telemetry::Sample> {
    session::Document::from_domain(
        &telemetry::Sample::decode(
            &parse_json(
                r#"{"kind":"request","at":"2026-10-04T12:00:00.000Z","operation":"session.snapshot","outcome":"ok","queueMs":5,"settlementMs":20,"totalMs":25}"#,
            )
            .unwrap(),
        )
        .unwrap(),
    )
    .unwrap()
}

fn consent(enabled: bool) -> resources::Consent {
    resources::Consent {
        id: 1,
        enabled: i64::from(enabled),
        notice_version: telemetry::CURRENT_NOTICE_VERSION,
        decided_at: 1,
    }
}

fn seed(store: &Store, model: &mut Model) {
    store
        .submit(|tx| {
            project::ProjectTable::insert(
                tx,
                &project::Project {
                    id: "p".into(),
                    worktree: "/project".into(),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 1,
                    time_updated: 1,
                    time_initialized: None,
                    sandboxes: Vec::new(),
                    commands: None,
                },
            )?;
            for id in ["s0", "s1", "s2"] {
                session::SessionTable::insert(tx, &session_row(id))?;
            }
            for index in 0..6_i64 {
                let id = format!("r{index}");
                resources::RequestTable::insert(
                    tx,
                    &request(
                        &id,
                        &format!("s{}", index % 3),
                        index / 3 + 1,
                        10.0 + index as f64,
                        1.0 + index as f64,
                    ),
                )?;
            }
            resources::ConsentTable::put(tx, &consent(true))?;
            for received in 1..=3 {
                resources::append_latency(tx, received, &sample())?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    model.project = true;
    model.sessions = ["s0", "s1", "s2"].map(String::from).into();
    for index in 0..6_i64 {
        model.requests.insert(
            format!("r{index}"),
            (
                format!("s{}", index % 3),
                10.0 + index as f64,
                1.0 + index as f64,
            ),
        );
    }
    model.consent = true;
    model.latency = 3;
}

fn insert_requests(store: &Store, model: &mut Model, from: usize, to: usize) {
    for chunk in (from..to).collect::<Vec<_>>().chunks(256) {
        let ids = chunk.to_vec();
        store
            .submit(move |tx| {
                for index in ids {
                    resources::RequestTable::insert(
                        tx,
                        &request(&format!("bulk{index}"), "s0", 1000 + index as i64, 1.0, 0.0),
                    )?;
                }
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
    }
    for index in from..to {
        model
            .requests
            .insert(format!("bulk{index}"), ("s0".into(), 1.0, 0.0));
    }
}

fn delete_request(store: &Store, model: &mut Model, id: &str) {
    let identity = key(id);
    store
        .submit(move |tx| resources::RequestTable::delete(tx, &identity).map(|_| ()))
        .unwrap()
        .wait()
        .unwrap();
    model.requests.remove(id);
}

fn revoke(store: &Store, model: &mut Model) {
    store
        .submit(|tx| {
            resources::ConsentTable::put(tx, &consent(false))?;
            resources::purge_telemetry(tx)
        })
        .unwrap()
        .wait()
        .unwrap();
    model.consent = false;
    model.latency = 0;
}

fn number(value: &Value) -> f64 {
    reports::value_number(value).unwrap()
}

fn read(handle: &analytics::Handle, sql: &'static str, rows: usize) -> Vec<Vec<Value>> {
    handle
        .report(vec![Query {
            sql,
            parameters: Vec::new(),
            max_rows: rows,
        }])
        .unwrap()
        .remove(0)
}

fn assert_reports(handle: &analytics::Handle, model: &Model) {
    let totals = read(
        handle,
        "SELECT count(*), coalesce(sum(input), 0), coalesce(sum(cost), 0) FROM session_provider_request",
        1,
    );
    assert_eq!(number(&totals[0][0]), model.requests.len() as f64);
    assert_eq!(
        number(&totals[0][1]),
        model.requests.values().map(|row| row.1).sum::<f64>()
    );
    assert_eq!(
        number(&totals[0][2]),
        model.requests.values().map(|row| row.2).sum::<f64>()
    );
    let grouped = read(
        handle,
        "SELECT session_id, count(*), sum(input) FROM session_provider_request GROUP BY session_id ORDER BY session_id",
        16,
    );
    let expected = model
        .sessions
        .iter()
        .filter_map(|session| {
            let rows = model
                .requests
                .values()
                .filter(|row| &row.0 == session)
                .collect::<Vec<_>>();
            (!rows.is_empty()).then(|| {
                (
                    session.clone(),
                    rows.len() as f64,
                    rows.iter().map(|row| row.1).sum::<f64>(),
                )
            })
        })
        .collect::<Vec<_>>();
    assert_eq!(
        grouped
            .iter()
            .map(|row| {
                let Value::Text(session) = &row[0] else {
                    panic!("session key")
                };
                (session.clone(), number(&row[1]), number(&row[2]))
            })
            .collect::<Vec<_>>(),
        expected
    );
    let counts = read(
        handle,
        "SELECT (SELECT count(*) FROM session), (SELECT count(*) FROM project), (SELECT count(*) FROM telemetry_consent WHERE enabled), (SELECT count(*) FROM web_latency)",
        1,
    );
    assert_eq!(
        counts[0].iter().map(number).collect::<Vec<_>>(),
        vec![
            model.sessions.len() as f64,
            f64::from(u8::from(model.project)),
            f64::from(u8::from(model.consent)),
            model.latency as f64
        ]
    );
}

fn delivery(store: &Store) -> analytics::Delivery {
    store
        .snapshot()
        .unwrap()
        .get::<DeliveryTable>(&[])
        .unwrap()
        .unwrap()
}

#[test]
fn test_066_domain_bootstrap_overflow_crash_rebuild_delete_restore_match_canonical_reports() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.init();
    let mut model = Model::default();
    seed(&store, &mut model);

    let engine = root.engine(&store);
    engine.rebuild().unwrap();
    assert_reports(&engine.handle(), &model);
    assert!(delivery(&store).valid);

    engine.shutdown().unwrap();
    assert!(store.client().analytics().is_err());
    let before_overflow = delivery(&store);
    insert_requests(&store, &mut model, 0, analytics::INTENT_LIMIT + 1);
    delete_request(&store, &mut model, "r0");
    let overflowed = delivery(&store);
    assert!(!overflowed.valid);
    assert!(overflowed.intents <= analytics::INTENT_LIMIT);
    assert!(overflowed.bytes <= analytics::INTENT_BYTES);
    assert!(overflowed.generation >= before_overflow.generation);
    store.shutdown().unwrap();

    kill_child(&root, "rebuild", "REBUILD-STARTING");
    let store = root.open();
    delete_request(&store, &mut model, "bulk7");
    store.shutdown().unwrap();
    kill_child(&root, "held", "NATIVE-QUERY-RUNNING");

    let store = root.open();
    delete_request(&store, &mut model, "bulk8");
    let engine = root.engine(&store);
    engine.purge().unwrap();
    assert_reports(&engine.handle(), &model);
    let rebuilt = delivery(&store);
    assert!(rebuilt.valid && !rebuilt.rebuilding);
    assert!(rebuilt.generation > overflowed.generation);

    let removed = model.requests.keys().next().unwrap().clone();
    delete_request(&store, &mut model, &removed);
    assert!(matches!(
        engine.report(vec![Query {
            sql: "SELECT count(*) FROM session_provider_request",
            parameters: Vec::new(),
            max_rows: 1
        }]),
        Err(analytics::Error::Privacy)
    ));
    engine.purge().unwrap();
    assert_reports(&engine.handle(), &model);
    engine.shutdown().unwrap();
    store.shutdown().unwrap();
}

#[test]
fn test_066_derived_and_older_canonical_restore_follow_the_selected_canonical_source() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.init();
    let mut model = Model::default();
    seed(&store, &mut model);
    let engine = root.engine(&store);
    engine.rebuild().unwrap();
    assert_reports(&engine.handle(), &model);
    engine.shutdown().unwrap();
    store.shutdown().unwrap();
    let derived_backup = root.0.join("derived-backup.duckdb");
    std::fs::copy(root.derived_file(), &derived_backup).unwrap();
    let canonical_backup = root.0.join("canonical-backup.redb");
    std::fs::copy(root.canonical(), &canonical_backup).unwrap();
    let past = model.clone();

    let store = root.open();
    delete_request(&store, &mut model, "r1");
    revoke(&store, &mut model);
    let engine = root.engine(&store);
    engine.purge().unwrap();
    assert_reports(&engine.handle(), &model);
    engine.shutdown().unwrap();

    std::fs::copy(&derived_backup, root.derived_file()).unwrap();
    let generation = delivery(&store).generation;
    let engine = root.engine(&store);
    assert_reports(&engine.handle(), &model);
    assert!(delivery(&store).generation > generation);
    engine.shutdown().unwrap();
    store.shutdown().unwrap();

    std::fs::copy(&canonical_backup, root.canonical()).unwrap();
    advance_generation(&root.canonical(), 2);
    let store = root.open();
    assert_eq!(store.metadata().generation, 2);
    let engine = root.engine(&store);
    assert_reports(&engine.handle(), &past);
    let active = delivery(&store);
    assert_eq!(active.source_generation, 2);
    assert!(active.valid && !active.rebuilding);
    engine.shutdown().unwrap();
    store.shutdown().unwrap();
}

#[test]
fn test_066_held_report_revocation_and_deletion_fence_queued_reads_after_release() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.init();
    let mut model = Model::default();
    seed(&store, &mut model);
    let engine = root.engine(&store);
    engine.rebuild().unwrap();
    assert_reports(&engine.handle(), &model);
    let handle = engine.handle();
    let hold = Cancellation::default();
    std::thread::scope(|scope| {
        let held = scope.spawn(|| {
            handle.report_cancellable(
                vec![Query {
                    sql: HEAVY,
                    parameters: Vec::new(),
                    max_rows: 1,
                }],
                hold.clone(),
            )
        });
        hold.wait_querying().unwrap();
        let queued = scope.spawn(|| {
            handle.report(vec![
                Query {
                    sql: "SELECT count(*) FROM web_latency",
                    parameters: Vec::new(),
                    max_rows: 1,
                },
                Query {
                    sql: "SELECT count(*) FROM session_provider_request",
                    parameters: Vec::new(),
                    max_rows: 1,
                },
            ])
        });
        revoke(&store, &mut model);
        delete_request(&store, &mut model, "r2");
        hold.cancel();
        assert!(matches!(
            held.join().unwrap(),
            Err(analytics::Error::Cancelled)
        ));
        assert!(matches!(
            queued.join().unwrap(),
            Err(analytics::Error::Privacy)
        ));
    });
    engine.purge().unwrap();
    assert_reports(&engine.handle(), &model);
    engine.shutdown().unwrap();
    store.shutdown().unwrap();
}

#[test]
fn test_066_intent_boundary_n_minus_one_n_and_n_plus_one_with_unblocked_canonical_writes() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.init();
    let mut model = Model::default();
    seed(&store, &mut model);
    let engine = root.engine(&store);
    engine.rebuild().unwrap();
    engine.shutdown().unwrap();
    let base = delivery(&store).intents;
    assert_eq!(base, 0);
    let mut written = 0;
    for target in [
        analytics::INTENT_LIMIT - 1,
        analytics::INTENT_LIMIT,
        analytics::INTENT_LIMIT + 1,
    ] {
        insert_requests(&store, &mut model, written, target);
        written = target;
        let state = delivery(&store);
        if target <= analytics::INTENT_LIMIT {
            assert!(state.valid, "{target} intents stay within the budget");
            assert_eq!(state.intents, target);
        } else {
            assert!(!state.valid, "{target} intents overflow the budget");
        }
    }
    let engine = root.engine(&store);
    assert_reports(&engine.handle(), &model);
    assert!(delivery(&store).valid);
    engine.shutdown().unwrap();
    store.shutdown().unwrap();
}

#[test]
fn test_066_transaction_work_boundary_n_minus_one_n_and_n_plus_one_is_atomic() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.init();
    let work = |marker: &'static str, gets: usize, catch: bool| {
        let probe = key("absent");
        store
            .submit(move |tx| {
                resources::set_kv(
                    tx,
                    &marker.into(),
                    &session::Document::new(parse_json("1").unwrap())?,
                    1,
                )?;
                for _ in 0..gets {
                    let read = tx.get::<resources::RequestTable>(&probe);
                    if !catch {
                        read?;
                    }
                }
                Ok(())
            })
            .unwrap()
            .wait()
    };
    let present = |marker: &str| {
        store
            .snapshot()
            .unwrap()
            .get::<resources::KvTable>(&key(marker))
            .unwrap()
            .is_some()
    };
    assert!(work("below", WORK_LIMIT - 3, false).is_ok());
    assert!(present("below"));
    assert!(work("exact", WORK_LIMIT - 2, false).is_ok());
    assert!(present("exact"));
    for (marker, catch) in [("over", false), ("over-caught", true)] {
        assert!(matches!(
            work(marker, WORK_LIMIT - 1, catch),
            Err(ycoding_store::Error::Domain {
                kind: "transaction_work_limit",
                ..
            })
        ));
        assert!(!present(marker));
    }
    store.shutdown().unwrap();
}

#[test]
fn test_066_report_row_boundary_n_minus_one_n_and_n_plus_one_follows_the_selected_limit() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = Root::new();
    let store = root.init();
    let engine = root.engine(&store);
    engine.rebuild().unwrap();
    let rows = |count: usize, max: usize| {
        engine.report(vec![Query {
            sql: Box::leak(format!("SELECT i FROM range({count}) t(i)").into_boxed_str()),
            parameters: Vec::new(),
            max_rows: max,
        }])
    };
    for count in [analytics::REPORT_ROWS - 1, analytics::REPORT_ROWS] {
        assert_eq!(rows(count, analytics::REPORT_ROWS).unwrap()[0].len(), count);
    }
    assert!(matches!(
        rows(analytics::REPORT_ROWS + 1, analytics::REPORT_ROWS),
        Err(analytics::Error::Limit)
    ));
    engine.shutdown().unwrap();
    store.shutdown().unwrap();
}

fn kill_child(root: &Root, mode: &str, signal: &str) {
    let mut child = spawn_child(root, mode);
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let reached = lines.any(|line| line.unwrap() == signal);
    child.kill().unwrap();
    assert!(!child.wait().unwrap().success());
    assert!(reached, "{mode} child reached {signal}");
}

fn spawn_child(root: &Root, mode: &str) -> std::process::Child {
    std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "report_flow_child", "--ignored", "--nocapture"])
        .env("YCODING_REPORT_FLOW_ROOT", &root.0)
        .env("YCODING_REPORT_FLOW_MODE", mode)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap()
}

#[test]
#[ignore = "subprocess-only fixture killed by the parent crash test"]
fn report_flow_child() {
    use std::io::Write;
    let root = PathBuf::from(std::env::var_os("YCODING_REPORT_FLOW_ROOT").unwrap());
    let store = Store::open(
        root.join("canonical.redb"),
        Options::core(),
        import::catalog(DatabaseKind::Core),
    )
    .unwrap();
    let engine = reports::start(store.client(), root.join("derived")).unwrap();
    if std::env::var("YCODING_REPORT_FLOW_MODE").unwrap() == "rebuild" {
        println!("REBUILD-STARTING");
        std::io::stdout().flush().unwrap();
        engine.rebuild().unwrap();
        std::thread::park();
    }
    engine.purge().unwrap();
    engine.rebuild().unwrap();
    read(
        &engine.handle(),
        "SELECT count(*) FROM session_provider_request",
        1,
    );
    let handle = engine.handle();
    let hold = Cancellation::default();
    let running = hold.clone();
    std::thread::spawn(move || {
        let _ = handle.report_cancellable(
            vec![Query {
                sql: HEAVY,
                parameters: Vec::new(),
                max_rows: 1,
            }],
            running,
        );
    });
    hold.wait_querying().unwrap();
    println!("NATIVE-QUERY-RUNNING");
    std::io::stdout().flush().unwrap();
    std::thread::park();
}

fn advance_generation(path: &Path, generation: u64) {
    let database = redb::Database::open(path).unwrap();
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
            .insert(
                b"generation".as_slice(),
                generation.to_be_bytes().as_slice(),
            )
            .unwrap();
    }
    transaction.commit().unwrap();
}
