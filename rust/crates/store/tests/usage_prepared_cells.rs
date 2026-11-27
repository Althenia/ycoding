mod common;

use std::{
    path::PathBuf,
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
};
use ycoding_schema::parse_json;
use ycoding_store::{
    Catalog, Metadata, Options, Store, TableSpec,
    analytics::{Engine, Maintenance, Query, Value, reports},
    native::{self, DatabaseKind},
    resources::{UsageAnalyticsRequest, UsageAnalyticsRequestTable},
    session::Document,
};

static SERIAL: Mutex<()> = Mutex::new(());
static NEXT: AtomicU64 = AtomicU64::new(0);
const TABLES: &[&str] = &[
    "usage_cell",
    "usage_cell_leaf",
    "usage_cell_sample",
    "usage_cell_unpriced",
    "usage_cell_backfill",
];

fn fact(id: &str, time: i64) -> UsageAnalyticsRequest {
    UsageAnalyticsRequest {
        id: id.into(),
        session_id: "ses_test".into(),
        project_id: "prj_test".into(),
        directory: "/synthetic".into(),
        workspace_id: None,
        session_updated: 1,
        agent: "build".into(),
        source: "step".into(),
        model: Document::new(parse_json(r#"{"providerID":"local","id":"test"}"#).unwrap()).unwrap(),
        usage_anchor: None,
        task_path: Document::new(parse_json("[]").unwrap()).unwrap(),
        request: time,
        attempts: 1,
        continuation: "full".into(),
        invalidation: "none".into(),
        prompt_cache_key: "synthetic-only".into(),
        cache_read_reported: None,
        tokens: Document::new(
            parse_json(r#"{"input":10,"output":20,"reasoning":5,"cache":{"read":3,"write":4}}"#)
                .unwrap(),
        )
        .unwrap(),
        cost: Some(0.0),
        timing: None,
        time_created: time,
        outcome: None,
    }
}

struct Fixture {
    engine: Option<Engine>,
    store: Option<Store>,
    root: PathBuf,
    _serial: MutexGuard<'static, ()>,
}

impl Fixture {
    fn new() -> Self {
        let serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let root = std::env::temp_dir().join(format!(
            "ycoding-prepared-cells-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        let store = Store::disposable(
            Options::core(),
            native::catalog(DatabaseKind::Core),
            Metadata::new([51; 16], 1),
        )
        .unwrap();
        let engine = reports::start(store.client(), root.join("mirror")).unwrap();
        Self {
            engine: Some(engine),
            store: Some(store),
            root,
            _serial: serial,
        }
    }
    fn store(&self) -> &Store {
        self.store.as_ref().unwrap()
    }
    fn engine(&self) -> &Engine {
        self.engine.as_ref().unwrap()
    }
    fn insert(&self, rows: Vec<UsageAnalyticsRequest>) {
        self.store()
            .submit(move |tx| {
                rows.iter()
                    .try_for_each(|row| UsageAnalyticsRequestTable::insert(tx, row))
            })
            .unwrap()
            .wait()
            .unwrap();
    }
    fn rows(&self, sql: &'static str) -> Vec<Vec<Value>> {
        self.engine()
            .report(vec![Query {
                sql,
                parameters: vec![],
                max_rows: 100,
            }])
            .unwrap()
            .remove(0)
    }
    fn scalar(&self, sql: &'static str) -> f64 {
        number(&self.rows(sql)[0][0])
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(engine) = self.engine.take() {
            engine.shutdown().unwrap();
        }
        if let Some(store) = self.store.take() {
            store.shutdown().unwrap();
        }
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

fn number(value: &Value) -> f64 {
    reports::value_number(value).unwrap()
}

#[test]
fn native_decimal_aggregates_keep_exact_typed_values_nulls_and_group_states_within_existing_memory()
{
    let fixture = Fixture::new();
    let rows = fixture.rows("SELECT decimal_sum(decimal_from_double(value)),typeof(decimal_sum(decimal_from_double(value))) FROM (SELECT 9007199254740992.0 AS value UNION ALL SELECT 1.0 UNION ALL SELECT 1.0)");
    assert_eq!(number(&rows[0][0]), 9_007_199_254_740_994.0);
    assert_eq!(rows[0][1], Value::Text("ycoding_decimal".into()));
    assert_eq!(
        fixture.rows("SELECT decimal_sum(decimal_from_double(NULL::DOUBLE))"),
        vec![vec![Value::Null]]
    );
    let rows = fixture.engine().report(vec![Query {
        sql: "SELECT i,sqlite_sum(i+1.0),sqlite_sum(i+2.0),sqlite_sum(i+3.0),sqlite_sum(i+4.0),sqlite_sum(i+5.0),sqlite_sum(i+6.0),sqlite_sum(i+7.0),sqlite_sum(i+8.0),sqlite_sum(i+9.0),sqlite_sum(i+10.0),sqlite_sum(i+11.0) FROM range(450) rows(i) GROUP BY i ORDER BY i",
        parameters: Vec::new(), max_rows: 450,
    }]).unwrap().remove(0);
    assert_eq!(rows.len(), 450);
    for (index, row) in rows.iter().enumerate() {
        for (column, value) in row.iter().enumerate() {
            assert_eq!(number(value), (index + column) as f64);
        }
    }
}

#[test]
fn the_native_catalog_declares_five_rebuildable_tables_and_mirror_sources() {
    let catalog = native::catalog(DatabaseKind::Core);
    assert_eq!(catalog.version, 5);
    for name in TABLES {
        assert!(
            catalog.tables().iter().any(|table| table.name == *name),
            "missing native {name}"
        );
        assert!(
            reports::SOURCES.iter().any(|source| source.name == *name),
            "missing mirror {name}"
        );
    }
}

#[test]
fn cold_rebuild_preserves_exact_v2_rows_and_the_captured_order() {
    let fixture = Fixture::new();
    fixture.engine().rebuild().unwrap();
    let timing = Document::new(
        parse_json(
            r#"{"generatedTokens":77,"generationDurationNs":1000000000,"firstOutputMs":12,"totalMs":1012}"#,
        )
        .unwrap(),
    )
    .unwrap();
    let rows = (0..48)
        .map(|index| {
            let mut row = fact(&format!("fact_{index:02}"), index * 15 * 60_000);
            row.timing = Some(timing.clone());
            row.cost = (index % 3 != 0).then_some(-0.125);
            row.workspace_id = (index % 2 == 0).then(|| "wrk_test".into());
            row
        })
        .collect();
    fixture.insert(rows);
    let read = || {
        fixture
            .engine()
            .report(
                [
                    "SELECT * EXCLUDE(source_version) FROM usage_cell ORDER BY source_id",
                    "SELECT * EXCLUDE(source_version) FROM usage_cell_leaf ORDER BY source_id",
                    "SELECT * EXCLUDE(source_version) FROM usage_cell_sample ORDER BY source_id",
                    "SELECT * EXCLUDE(source_version) FROM usage_cell_unpriced ORDER BY source_id",
                    "SELECT * EXCLUDE(source_version) FROM usage_cell_backfill ORDER BY source_id",
                ]
                .into_iter()
                .map(|sql| Query {
                    sql,
                    parameters: vec![],
                    max_rows: 512,
                })
                .collect(),
            )
            .unwrap()
    };
    let incremental = read();
    assert!(incremental[2].len() > ycoding_store::analytics::BATCH_SIZE);
    fixture.engine().rebuild().unwrap();
    assert_eq!(read(), incremental);
    let delivery = fixture
        .store()
        .snapshot()
        .unwrap()
        .get::<ycoding_store::analytics::DeliveryTable>(&[])
        .unwrap()
        .unwrap();
    assert!(delivery.valid && !delivery.rebuilding && delivery.order > 0);
    assert_eq!(delivery.applied, delivery.order);
    assert_eq!(
        fixture.rows("SELECT source_order FROM analytics_checkpoint"),
        vec![vec![Value::UBigInt(delivery.order)]]
    );
    let order =
        fixture.rows("SELECT min(source_version), max(source_version) FROM usage_cell_sample");
    assert_eq!(order, vec![vec![Value::UBigInt(delivery.order); 2]]);
}

#[test]
fn source_inserts_update_all_grains_samples_and_price_contexts_atomically() {
    let fixture = Fixture::new();
    let mut unpriced = fact("fact_a", 100);
    unpriced.cost = None;
    unpriced.outcome = Some("failed".into());
    unpriced.timing = Some(Document::new(parse_json(r#"{"generatedTokens":100,"generationDurationNs":1000000000,"firstOutputMs":10,"totalMs":1000}"#).unwrap()).unwrap());
    fixture.insert(vec![unpriced.clone(), fact("fact_b", 200)]);
    let rows = fixture.rows("SELECT span,sum(logical),sum(physical),decimal_sum(input),decimal_sum(output),sum(priced),sum(unpriced),sum(failed) FROM usage_cell WHERE family='backend' GROUP BY span ORDER BY span");
    assert_eq!(rows.len(), 3);
    for (row, span) in rows.iter().zip([1.0, 60_000.0, 900_000.0]) {
        assert_eq!(
            row.iter().map(number).collect::<Vec<_>>(),
            [span, 2.0, 2.0, 20.0, 40.0, 1.0, 1.0, 1.0]
        );
    }
    assert_eq!(
        fixture.scalar("SELECT count(*) FROM usage_cell_leaf WHERE family='backend'"),
        6.0
    );
    assert_eq!(
        fixture.scalar("SELECT sum(count) FROM usage_cell_sample WHERE family='backend'"),
        9.0
    );
    assert_eq!(
        fixture.scalar(
            "SELECT sum(requests) FROM usage_cell_unpriced WHERE family='backend' AND context=decimal_from_double(17)"
        ),
        3.0
    );
    assert!(
        fixture
            .store()
            .submit(move |tx| {
                assert!(UsageAnalyticsRequestTable::insert(tx, &unpriced).is_err());
                Ok(())
            })
            .unwrap()
            .wait()
            .is_err()
    );
    assert_eq!(
        fixture.scalar("SELECT sum(logical) FROM usage_cell WHERE family='backend' AND span=1"),
        2.0
    );
}

#[test]
fn nonnegative_recorded_cost_appends_measures_without_replacing_signed_cost() {
    use std::ops::Bound;
    use ycoding_store::usage_cells::{AMOUNTS, COUNTS, CellTable};
    let fixture = Fixture::new();
    assert_eq!((COUNTS.len(), AMOUNTS.len()), (17, 11));
    assert_eq!(COUNTS[16], "cost_nonnegative_requests");
    assert_eq!(AMOUNTS[10], "cost_nonnegative");
    assert_eq!(AMOUNTS[0], "cost");
    assert_eq!(&AMOUNTS[8..10], &["generation_tokens", "generation_ns"]);
    let mut positive = fact("positive", 100);
    positive.cost = Some(3.0);
    positive.timing = Some(Document::new(parse_json(r#"{"generatedTokens":60,"generationDurationNs":2000000000,"firstOutputMs":10,"totalMs":1000}"#).unwrap()).unwrap());
    let mut negative = fact("negative", 100);
    negative.cost = Some(-1.0);
    let zero = fact("zero", 100);
    let mut absent = fact("absent", 100);
    absent.cost = None;
    fixture.insert(vec![positive.clone(), negative, zero, absent]);
    for row in fixture.rows("SELECT span,decimal_sum(cost),decimal_sum(cost_nonnegative),sum(cost_nonnegative_requests),sum(priced),sum(unpriced),sum(generation_rate),decimal_sum(generation_tokens),decimal_sum(generation_ns) FROM usage_cell WHERE family='backend' GROUP BY span ORDER BY span") {
        assert_eq!(row[1..].iter().map(number).collect::<Vec<_>>(), [2.0, 3.0, 2.0, 3.0, 1.0, 30.0, 60.0, 2_000_000_000.0]);
    }
    let snapshot = fixture.store().snapshot().unwrap();
    for cell in snapshot
        .scan::<CellTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap()
    {
        assert_eq!(CellTable::encode(&cell).unwrap()[0], 2);
        assert_eq!((cell.counts.len(), cell.amounts.len()), (17, 11));
    }
    drop(snapshot);
    positive.cost = Some(-3.0);
    fixture
        .store()
        .submit(move |tx| UsageAnalyticsRequestTable::put(tx, &positive))
        .unwrap()
        .wait()
        .unwrap();
    fixture.insert(vec![fact("zero_second", 100)]);
    let first_zero = UsageAnalyticsRequestTable::primary_key(&fact("zero", 100));
    fixture
        .store()
        .submit(move |tx| UsageAnalyticsRequestTable::delete(tx, &first_zero))
        .unwrap()
        .wait()
        .unwrap();
    fixture.engine().purge().unwrap();
    assert_eq!(fixture.rows("SELECT decimal_sum(cost),decimal_sum(cost_nonnegative),sum(cost_nonnegative_requests),sum(generation_rate),decimal_sum(generation_tokens),decimal_sum(generation_ns) FROM usage_cell WHERE family='backend' AND span=1")[0].iter().map(number).collect::<Vec<_>>(), [-4.0, 0.0, 1.0, 30.0, 60.0, 2_000_000_000.0]);
    let second_zero = UsageAnalyticsRequestTable::primary_key(&fact("zero_second", 100));
    fixture
        .store()
        .submit(move |tx| UsageAnalyticsRequestTable::delete(tx, &second_zero))
        .unwrap()
        .wait()
        .unwrap();
    fixture.engine().purge().unwrap();
    assert_eq!(fixture.rows("SELECT decimal_sum(cost),decimal_sum(cost_nonnegative),sum(cost_nonnegative_requests) FROM usage_cell WHERE family='backend' AND span=1")[0].iter().map(number).collect::<Vec<_>>(), [-4.0, 0.0, 0.0]);
    fixture.engine().rebuild().unwrap();
    assert_eq!(fixture.scalar("SELECT sum(cost_nonnegative_requests) FROM usage_cell WHERE family='backend' AND span=1"), 0.0);
}

#[test]
fn replacements_and_deletes_reverse_only_the_matching_source_projection() {
    let fixture = Fixture::new();
    let mut first = fact("fact_a", 100);
    first.cost = Some(0.5);
    first.timing = Some(Document::new(parse_json(r#"{"generatedTokens":100,"generationDurationNs":1000000000,"firstOutputMs":10,"totalMs":1000}"#).unwrap()).unwrap());
    fixture.insert(vec![first.clone(), fact("fact_b", 200)]);
    let mut replacement = fact("fact_a", 900_001);
    replacement.session_id = "ses_other".into();
    replacement.model = Document::new(
        parse_json(r#"{"providerID":"local","id":"other","profile":"work"}"#).unwrap(),
    )
    .unwrap();
    replacement.outcome = Some("cancelled".into());
    fixture
        .store()
        .submit(move |tx| UsageAnalyticsRequestTable::put(tx, &replacement))
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        fixture.scalar("SELECT count(*) FROM usage_cell WHERE family='backend'"),
        6.0
    );
    assert_eq!(
        fixture.scalar("SELECT count(*) FROM usage_cell_sample WHERE family='backend'"),
        0.0
    );
    assert_eq!(
        fixture
            .scalar("SELECT decimal_sum(cost) FROM usage_cell WHERE family='backend' AND span=1"),
        0.0
    );
    assert_eq!(
        fixture.scalar("SELECT sum(cancelled) FROM usage_cell WHERE family='backend' AND span=1"),
        1.0
    );
    fixture
        .store()
        .submit(move |tx| {
            tx.delete::<UsageAnalyticsRequestTable>(&UsageAnalyticsRequestTable::primary_key(
                &first,
            ))
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        fixture.scalar("SELECT count(*) FROM usage_cell WHERE family='backend'"),
        3.0
    );
    assert_eq!(
        fixture.scalar("SELECT count(*) FROM usage_cell_leaf WHERE family='backend'"),
        3.0
    );
    assert_eq!(
        fixture.scalar("SELECT sum(logical) FROM usage_cell WHERE family='backend' AND span=1"),
        1.0
    );
}

#[test]
fn native_cell_values_survive_public_number_overflow_and_return_after_removal() {
    let fixture = Fixture::new();
    let mut first = fact("fact_large", 100);
    first.cost = Some(f64::MAX * 0.75);
    fixture.insert(vec![first]);
    let before = fixture
        .scalar("SELECT decimal_sum(cost) FROM usage_cell WHERE family='backend' AND span=1");
    let mut overflowing = fact("fact_overflow", 200);
    overflowing.cost = Some(f64::MAX * 0.75);
    let lookup = UsageAnalyticsRequestTable::primary_key(&overflowing);
    fixture.insert(vec![overflowing]);
    let sum =
        fixture.rows("SELECT decimal_sum(cost) FROM usage_cell WHERE family='backend' AND span=1");
    assert!(reports::value_number(&sum[0][0]).is_err());
    assert!(
        fixture
            .store()
            .snapshot()
            .unwrap()
            .get::<UsageAnalyticsRequestTable>(&lookup)
            .unwrap()
            .is_some()
    );
    fixture
        .store()
        .submit(move |tx| UsageAnalyticsRequestTable::delete(tx, &lookup))
        .unwrap()
        .wait()
        .unwrap();
    fixture.engine().purge().unwrap();
    assert_eq!(
        fixture
            .scalar("SELECT decimal_sum(cost) FROM usage_cell WHERE family='backend' AND span=1"),
        before
    );
}

#[test]
fn caught_counter_overflow_also_rejects_the_whole_writer_transaction() {
    let fixture = Fixture::new();
    let mut first = fact("fact_large", 100);
    first.attempts = i64::MAX;
    fixture.insert(vec![first]);
    let extra = fact("fact_extra", 200);
    let lookup = UsageAnalyticsRequestTable::primary_key(&extra);
    assert!(
        fixture
            .store()
            .submit(move |tx| {
                assert!(UsageAnalyticsRequestTable::insert(tx, &extra).is_err());
                Ok(())
            })
            .unwrap()
            .wait()
            .is_err()
    );
    assert!(
        fixture
            .store()
            .snapshot()
            .unwrap()
            .get::<UsageAnalyticsRequestTable>(&lookup)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        fixture.scalar("SELECT sum(logical) FROM usage_cell WHERE family='backend' AND span=1"),
        1.0
    );
}

#[test]
fn family_identity_and_retention_are_independent_even_when_source_ids_match() {
    use ycoding_store::{project, resources, session};
    let fixture = Fixture::new();
    fixture
        .store()
        .submit(|tx| {
            project::ProjectTable::insert(
                tx,
                &project::Project {
                    id: "prj_test".into(),
                    worktree: "/synthetic".into(),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 1,
                    time_updated: 1,
                    time_initialized: None,
                    sandboxes: vec![],
                    commands: None,
                },
            )?;
            session::SessionTable::insert(
                tx,
                &session::Session {
                    id: "ses_test".into(),
                    project_id: "prj_test".into(),
                    workspace_id: None,
                    parent_id: None,
                    fork_session_id: None,
                    fork_message_id: None,
                    fork_seq: None,
                    directory: "/synthetic".into(),
                    path: None,
                    title: "Synthetic".into(),
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
                    usage_pruned_through: None,
                    origin: None,
                    scope: "bound".into(),
                },
            )?;
            let source = fact("same-id", 100);
            resources::RequestTable::insert(
                tx,
                &resources::Request {
                    id: source.id.clone(),
                    session_id: source.session_id.clone(),
                    input_id: None,
                    assistant_message_id: None,
                    connection_identity_digest: None,
                    source: source.source.clone(),
                    agent: source.agent.clone(),
                    model: source.model.clone(),
                    route_id: "synthetic".into(),
                    prompt_cache_key: source.prompt_cache_key.clone(),
                    system_digest: "synthetic".into(),
                    tool_digest: "synthetic".into(),
                    request: source.request,
                    attempts: source.attempts,
                    invalidation: source.invalidation.clone(),
                    continuation: source.continuation.clone(),
                    cache_read_reported: source.cache_read_reported,
                    timing: source.timing.clone(),
                    cost: source.cost,
                    tokens: source.tokens.clone(),
                    time_created: source.time_created,
                    usage_anchor: source.usage_anchor.clone(),
                    outcome: None,
                },
            )?;
            UsageAnalyticsRequestTable::insert(tx, &source)
        })
        .unwrap()
        .wait()
        .unwrap();
    let rows = fixture.rows(
        "SELECT family,sum(logical) FROM usage_cell WHERE span=1 GROUP BY family ORDER BY family",
    );
    assert_eq!(rows.len(), 2);
    assert_eq!(number(&rows[0][1]), 1.0);
    assert_eq!(number(&rows[1][1]), 1.0);
    fixture
        .store()
        .submit(|tx| session::delete(tx, &"ses_test".into()))
        .unwrap()
        .wait()
        .unwrap();
    fixture.engine().purge().unwrap();
    assert_eq!(
        fixture.scalar("SELECT count(*) FROM usage_cell WHERE family='session'"),
        0.0
    );
    assert_eq!(
        fixture.scalar("SELECT sum(logical) FROM usage_cell WHERE family='backend' AND span=1"),
        1.0
    );
    fixture
        .store()
        .submit(|tx| {
            tx.delete::<UsageAnalyticsRequestTable>(&UsageAnalyticsRequestTable::primary_key(
                &fact("same-id", 100),
            ))
        })
        .unwrap()
        .wait()
        .unwrap();
    for sql in [
        "SELECT count(*) FROM usage_cell",
        "SELECT count(*) FROM usage_cell_leaf",
        "SELECT count(*) FROM usage_cell_sample",
        "SELECT count(*) FROM usage_cell_unpriced",
    ] {
        assert_eq!(fixture.scalar(sql), 0.0);
    }
}

#[test]
fn weighted_histograms_exclude_estimated_display_output_and_keep_known_zero_cost() {
    let fixture = Fixture::new();
    let mut rows = Vec::new();
    for (index, rate) in [10, 10, 20, 100].into_iter().enumerate() {
        let mut row = fact(&format!("fact_{index}"), 100);
        row.request = index as i64;
        row.timing = Some(
            Document::new(
                parse_json(&format!(
                    r#"{{"generatedTokens":{rate},"generationDurationNs":1000000000}}"#
                ))
                .unwrap(),
            )
            .unwrap(),
        );
        rows.push(row);
    }
    let mut estimated = fact("fact_estimated", 100);
    estimated.cost = None;
    estimated.timing = Some(Document::new(parse_json(r#"{"estimatedTokens":9000,"estimatedGenerationDurationNs":1000000000,"receivedOutput":{"estimatedTokens":9000,"durationNs":1000000000}}"#).unwrap()).unwrap());
    rows.push(estimated);
    fixture.insert(rows);
    assert_eq!(
        fixture.scalar(
            "SELECT sum(generation_samples) FROM usage_cell WHERE family='backend' AND span=1"
        ),
        4.0
    );
    assert_eq!(fixture.scalar("SELECT sum(generation_rate) / sum(generation_samples) FROM usage_cell WHERE family='backend' AND span=1"), 35.0);
    let rows = fixture.rows("SELECT generation_rate,count FROM usage_cell_sample WHERE family='backend' AND span=1 AND metric=2 ORDER BY generation_rate");
    assert_eq!(
        rows.iter()
            .map(|row| (number(&row[0]), number(&row[1])))
            .collect::<Vec<_>>(),
        [(10.0, 2.0), (20.0, 1.0), (100.0, 1.0)]
    );
    assert_eq!(
        fixture.scalar("SELECT sum(priced) FROM usage_cell WHERE family='backend' AND span=1"),
        4.0
    );
    assert_eq!(
        fixture
            .scalar("SELECT decimal_sum(cost) FROM usage_cell WHERE family='backend' AND span=1"),
        0.0
    );
    assert_eq!(fixture.scalar("SELECT sum(completed)+sum(failed)+sum(cancelled) FROM usage_cell WHERE family='backend' AND span=1"), 0.0);
}

#[test]
fn captured_cell_histogram_and_readiness_sources_use_one_snapshot() {
    let fixture = Fixture::new();
    let mut first = fact("fact_first", 100);
    first.timing = Some(
        Document::new(
            parse_json(r#"{"generatedTokens":10,"generationDurationNs":1000000000}"#).unwrap(),
        )
        .unwrap(),
    );
    fixture.insert(vec![first]);
    let captured = fixture.store().snapshot().unwrap();
    let mut second = fact("fact_second", 100);
    second.timing = Some(
        Document::new(
            parse_json(r#"{"generatedTokens":20,"generationDurationNs":1000000000}"#).unwrap(),
        )
        .unwrap(),
    );
    fixture.insert(vec![second]);
    let query = |captured| Query {
        sql: if captured {
            "SELECT sum(logical),(SELECT sum(count) FROM report_usage_cell_sample WHERE family='backend' AND span=1 AND metric=2) FROM report_usage_cell WHERE family='backend' AND span=1"
        } else {
            "SELECT sum(logical),(SELECT sum(count) FROM usage_cell_sample WHERE family='backend' AND span=1 AND metric=2) FROM usage_cell WHERE family='backend' AND span=1"
        },
        parameters: vec![],
        max_rows: 1,
    };
    let old = fixture
        .engine()
        .report_snapshot(captured, TABLES, vec![query(true)])
        .unwrap();
    assert_eq!(old[0][0].iter().map(number).collect::<Vec<_>>(), [1.0, 1.0]);
    let current = fixture.engine().report(vec![query(false)]).unwrap();
    assert_eq!(
        current[0][0].iter().map(number).collect::<Vec<_>>(),
        [2.0, 2.0]
    );
}

#[test]
fn legacy_backfill_is_bounded_resumable_and_handles_writes_behind_its_cursor() {
    let mut fixture = Fixture::new();
    fixture.engine.take().unwrap().shutdown().unwrap();
    fixture.store.take().unwrap().shutdown().unwrap();
    let old = Catalog::new(
        1,
        Box::leak(
            common::with_removed(native::catalog(DatabaseKind::Core).tables())
                .into_iter()
                .filter(|table| {
                    !TABLES.contains(&table.name)
                        && !["coordination_group", "coordination_member"].contains(&table.name)
                })
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        ),
    );
    let path = fixture.root.join("synthetic.redb");
    let historical =
        Store::initialize(&path, Options::core(), old, Metadata::new([52; 16], 1)).unwrap();
    historical.shutdown().unwrap();
    {
        use redb::TableDefinition;
        let database = redb::Database::open(&path).unwrap();
        let write = database.begin_write().unwrap();
        for index in 0..10_001 {
            let row = fact(&format!("fact-{index:05}"), index);
            let primary = UsageAnalyticsRequestTable::primary_key(&row);
            let mut bytes = UsageAnalyticsRequestTable::encode(&row).unwrap();
            assert_eq!(bytes.pop(), Some(0));
            bytes[0] = 1;
            write
                .open_table(TableDefinition::<&[u8], &[u8]>::new(
                    UsageAnalyticsRequestTable::NAME,
                ))
                .unwrap()
                .insert(primary.as_slice(), bytes.as_slice())
                .unwrap();
            for definition in UsageAnalyticsRequestTable::INDEXES {
                if let Some(key) = UsageAnalyticsRequestTable::index_key(definition, &row).unwrap()
                {
                    let storage = if definition.unique {
                        key
                    } else {
                        ycoding_store::tuple_key(&[
                            ycoding_store::KeyPart::Bytes(&key),
                            ycoding_store::KeyPart::Bytes(&primary),
                        ])
                    };
                    write
                        .open_table(TableDefinition::<&[u8], &[u8]>::new(definition.name))
                        .unwrap()
                        .insert(storage.as_slice(), primary.as_slice())
                        .unwrap();
                }
            }
        }
        write.commit().unwrap();
    }
    ycoding_store::upgrade::core(&path, Options::core(), |_| Ok(u64::MAX)).unwrap();
    fixture.store =
        Some(Store::open(&path, Options::core(), native::catalog(DatabaseKind::Core)).unwrap());
    fixture.engine =
        Some(reports::start(fixture.store().client(), fixture.root.join("mirror")).unwrap());
    assert_eq!(fixture.engine().maintain().unwrap(), Maintenance::Pending);
    fixture.engine.take().unwrap().shutdown().unwrap();
    let mut changed = fact("fact-00001", 1);
    changed.outcome = Some("failed".into());
    changed.cost = Some(0.5);
    fixture
        .store()
        .submit(move |tx| {
            UsageAnalyticsRequestTable::insert(tx, &fact("aaa-late", 2))?;
            UsageAnalyticsRequestTable::put(tx, &changed)?;
            tx.delete::<UsageAnalyticsRequestTable>(&UsageAnalyticsRequestTable::primary_key(
                &fact("fact-00002", 2),
            ))?;
            tx.delete::<UsageAnalyticsRequestTable>(&UsageAnalyticsRequestTable::primary_key(
                &fact("fact-09999", 9999),
            ))?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    fixture.engine =
        Some(reports::start(fixture.store().client(), fixture.root.join("mirror")).unwrap());
    let mut settled = false;
    for _ in 0..1000 {
        if fixture.engine().maintain().unwrap() == Maintenance::Complete {
            settled = true;
            break;
        }
    }
    assert!(settled, "bounded preparation did not finish");
    for row in fixture.rows("SELECT span,sum(logical),sum(priced),decimal_sum(cost),sum(failed) FROM usage_cell WHERE family='backend' GROUP BY span ORDER BY span") {
        assert_eq!(row[1..].iter().map(number).collect::<Vec<_>>(), [10_000.0,10_000.0,0.5,1.0]);
    }
    assert_eq!(
        fixture.scalar("SELECT count(*) FROM usage_cell_leaf WHERE family='backend'"),
        30_000.0
    );
    fixture.engine.take().unwrap().shutdown().unwrap();
    fixture.engine = Some(
        reports::start(
            fixture.store().client(),
            fixture.root.join("mirror-rebuilt"),
        )
        .unwrap(),
    );
    let mut settled = false;
    for _ in 0..1000 {
        if fixture.engine().maintain().unwrap() == Maintenance::Complete {
            settled = true;
            break;
        }
    }
    assert!(settled, "bounded reconstruction did not finish");
    assert_eq!(
        fixture.scalar("SELECT sum(logical) FROM usage_cell WHERE family='backend' AND span=1"),
        10_000.0
    );
}

fn seed_legacy_backend_facts(fixture: &mut Fixture, identity: u8, count: i64) -> PathBuf {
    fixture.engine.take().unwrap().shutdown().unwrap();
    fixture.store.take().unwrap().shutdown().unwrap();
    let old = Catalog::new(
        1,
        Box::leak(
            common::with_removed(native::catalog(DatabaseKind::Core).tables())
                .into_iter()
                .filter(|table| {
                    !TABLES.contains(&table.name)
                        && !["coordination_group", "coordination_member"].contains(&table.name)
                })
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        ),
    );
    let path = fixture.root.join("synthetic.redb");
    Store::initialize(
        &path,
        Options::core(),
        old,
        Metadata::new([identity; 16], 1),
    )
    .unwrap()
    .shutdown()
    .unwrap();
    {
        use redb::TableDefinition;
        let database = redb::Database::open(&path).unwrap();
        let write = database.begin_write().unwrap();
        for index in 0..count {
            let row = fact(&format!("fact-{index:05}"), index);
            let primary = UsageAnalyticsRequestTable::primary_key(&row);
            let mut bytes = UsageAnalyticsRequestTable::encode(&row).unwrap();
            assert_eq!(bytes.pop(), Some(0));
            bytes[0] = 1;
            write
                .open_table(TableDefinition::<&[u8], &[u8]>::new(
                    UsageAnalyticsRequestTable::NAME,
                ))
                .unwrap()
                .insert(primary.as_slice(), bytes.as_slice())
                .unwrap();
            for definition in UsageAnalyticsRequestTable::INDEXES {
                if let Some(key) = UsageAnalyticsRequestTable::index_key(definition, &row).unwrap()
                {
                    let storage = if definition.unique {
                        key
                    } else {
                        ycoding_store::tuple_key(&[
                            ycoding_store::KeyPart::Bytes(&key),
                            ycoding_store::KeyPart::Bytes(&primary),
                        ])
                    };
                    write
                        .open_table(TableDefinition::<&[u8], &[u8]>::new(definition.name))
                        .unwrap()
                        .insert(storage.as_slice(), primary.as_slice())
                        .unwrap();
                }
            }
        }
        write.commit().unwrap();
    }
    ycoding_store::upgrade::core(&path, Options::core(), |_| Ok(u64::MAX)).unwrap();
    path
}

#[test]
fn completed_backfills_maintain_without_waiting_for_an_unrelated_canonical_writer() {
    use std::{ops::Bound, sync::mpsc, time::Duration};
    use ycoding_store::usage_cells::{self, CellTable};

    let mut fixture = Fixture::new();
    let path = seed_legacy_backend_facts(&mut fixture, 54, 1);
    fixture.store =
        Some(Store::open(&path, Options::core(), native::catalog(DatabaseKind::Core)).unwrap());
    let client = fixture.store().client().clone();
    let snapshot = client.snapshot().unwrap();
    assert!(!usage_cells::ready(&snapshot).unwrap());
    assert!(
        snapshot
            .scan::<CellTable>(Bound::Unbounded, Bound::Unbounded, 1)
            .unwrap()
            .is_empty()
    );
    drop(snapshot);
    assert!(!usage_cells::maintain(&client).unwrap());
    assert!(!usage_cells::ready(&client.snapshot().unwrap()).unwrap());
    assert!(usage_cells::maintain(&client).unwrap());
    assert!(usage_cells::ready(&client.snapshot().unwrap()).unwrap());
    fixture.engine =
        Some(reports::start(fixture.store().client(), fixture.root.join("mirror")).unwrap());
    let sql = "SELECT sum(logical),decimal_sum(input),decimal_sum(output),decimal_sum(cost) FROM usage_cell WHERE family='backend' AND span=1";
    let before = fixture.rows(sql);
    assert_eq!(
        before[0].iter().map(number).collect::<Vec<_>>(),
        [1.0, 10.0, 20.0, 0.0]
    );

    let (entered, reached) = mpsc::channel();
    let (release, barrier) = mpsc::channel();
    let writer_client = client.clone();
    let blocker = std::thread::spawn(move || {
        writer_client
            .submit(move |_| {
                entered.send(()).unwrap();
                barrier.recv().unwrap();
                Ok(())
            })
            .unwrap()
            .wait()
    });
    let reached = reached.recv_timeout(Duration::from_secs(30));
    let (finished, completion) = mpsc::channel();
    let maintainer = std::thread::spawn(move || {
        let result = usage_cells::maintain(&client);
        finished.send(()).unwrap();
        result
    });
    let completed = completion.recv_timeout(Duration::from_secs(30));
    let released = release.send(());
    let blocker_result = blocker.join();
    let maintenance_result = maintainer.join();

    reached.expect("canonical writer did not reach the barrier");
    released.unwrap();
    blocker_result.unwrap().unwrap();
    let maintained = maintenance_result.unwrap().unwrap();
    completed.expect("completed backfills waited for the blocked canonical writer");
    assert!(maintained);
    assert_eq!(fixture.rows(sql), before);
}

#[test]
fn backend_backfill_resumes_from_its_cursor_after_restart_with_source_changes_on_both_sides() {
    use ycoding_store::usage_cells::BackfillTable;
    let mut fixture = Fixture::new();
    let path = seed_legacy_backend_facts(&mut fixture, 53, 300);
    fixture.store =
        Some(Store::open(&path, Options::core(), native::catalog(DatabaseKind::Core)).unwrap());
    fixture.engine =
        Some(reports::start(fixture.store().client(), fixture.root.join("mirror")).unwrap());
    assert_eq!(fixture.engine().maintain().unwrap(), Maintenance::Pending);
    assert_eq!(fixture.engine().maintain().unwrap(), Maintenance::Pending);
    let backend = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&"backend".into())]);
    let cursor = fixture
        .store()
        .snapshot()
        .unwrap()
        .get::<BackfillTable>(&backend)
        .unwrap()
        .unwrap();
    assert_eq!(
        cursor.after.as_ref().and_then(|after| after.as_str()),
        Some("fact-00127")
    );
    assert_eq!(cursor.complete, 0);
    fixture.engine.take().unwrap().shutdown().unwrap();
    fixture.store.take().unwrap().shutdown().unwrap();
    fixture.store =
        Some(Store::open(&path, Options::core(), native::catalog(DatabaseKind::Core)).unwrap());
    let mut behind = fact("fact-00005", 5);
    behind.outcome = Some("failed".into());
    behind.cost = Some(0.5);
    let mut ahead = fact("fact-00200", 200);
    ahead.outcome = Some("cancelled".into());
    ahead.cost = Some(1.0);
    fixture
        .store()
        .submit(move |tx| {
            UsageAnalyticsRequestTable::insert(tx, &fact("aaa-late", 7))?;
            UsageAnalyticsRequestTable::put(tx, &behind)?;
            UsageAnalyticsRequestTable::put(tx, &ahead)?;
            tx.delete::<UsageAnalyticsRequestTable>(&UsageAnalyticsRequestTable::primary_key(
                &fact("fact-00006", 6),
            ))?;
            tx.delete::<UsageAnalyticsRequestTable>(&UsageAnalyticsRequestTable::primary_key(
                &fact("fact-00201", 201),
            ))?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    fixture.engine =
        Some(reports::start(fixture.store().client(), fixture.root.join("mirror")).unwrap());
    let mut settled = false;
    for _ in 0..1000 {
        if fixture.engine().maintain().unwrap() == Maintenance::Complete {
            settled = true;
            break;
        }
    }
    assert!(settled, "bounded preparation did not finish");
    let resumed = fixture
        .store()
        .snapshot()
        .unwrap()
        .get::<BackfillTable>(&backend)
        .unwrap()
        .unwrap();
    assert_eq!(resumed.complete, 1);
    let expected = [299.0, 299.0, 1.5, 1.0, 1.0];
    for row in fixture.rows("SELECT span,sum(logical),sum(priced),decimal_sum(cost),sum(failed),sum(cancelled) FROM usage_cell WHERE family='backend' GROUP BY span ORDER BY span") {
        assert_eq!(row[1..].iter().map(number).collect::<Vec<_>>(), expected);
    }
    assert_eq!(
        fixture.scalar("SELECT count(*) FROM usage_cell_leaf WHERE family='backend'"),
        897.0
    );
    fixture.engine().rebuild().unwrap();
    assert_eq!(
        fixture.scalar("SELECT sum(logical) FROM usage_cell WHERE family='backend' AND span=1"),
        299.0
    );
    assert_eq!(
        fixture.rows("SELECT sum(cost_nonnegative_requests),decimal_sum(cost_nonnegative) FROM usage_cell WHERE family='backend' AND span=1")[0].iter().map(number).collect::<Vec<_>>(),
        [299.0, 1.5]
    );
}
