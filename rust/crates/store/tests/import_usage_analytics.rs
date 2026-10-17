use rusqlite::Connection;
use std::collections::BTreeSet;
use std::ops::{Bound, ControlFlow};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use ycoding_schema::{
    DomainEncode, LosslessString, parse_json, session_id::SessionId, session_message_id,
    usage_anchor,
};
use ycoding_store::import::{self, DatabaseKind, Progress, Request};
use ycoding_store::{Metadata, Options, Store, resources, session};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ycoding-import-usage-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn source(&self) -> PathBuf {
        self.0.join("source.sqlite")
    }
    fn candidate(&self, name: &str) -> PathBuf {
        self.0.join(format!("{name}.redb"))
    }
    fn create(&self) -> Connection {
        let db = Connection::open(self.source()).unwrap();
        let source = include_str!("../../../../packages/core/src/database/schema.gen.ts");
        let delimiters = source
            .match_indices('`')
            .filter_map(|(at, _)| (at == 0 || source.as_bytes()[at - 1] != b'\\').then_some(at))
            .collect::<Vec<_>>();
        assert!(delimiters.as_chunks::<2>().1.is_empty());
        for pair in delimiters.as_chunks::<2>().0 {
            db.execute_batch(&source[pair[0] + 1..pair[1]].replace("\\`", "`"))
                .unwrap();
        }
        db.execute_batch(
            "CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
            CREATE TABLE database_format (id TEXT PRIMARY KEY, time_created INTEGER NOT NULL);
            INSERT INTO migration VALUES ('baseline', -9223372036854775808);
            INSERT INTO database_format VALUES ('current-2026-08-04', 9223372036854775807);",
        )
        .unwrap();
        db
    }
    fn stage(
        &self,
        candidate: &Path,
        progress: impl FnMut(Progress) -> ControlFlow<()>,
    ) -> Result<import::Report, import::Error> {
        import::stage(
            Request {
                source: &self.source(),
                candidate,
                kind: DatabaseKind::Core,
                metadata: Metadata::new([7; 16], 1),
            },
            progress,
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

const ANALYTICS_COLUMNS: [(&str, &str, &str); 4] = [
    ("session_compaction_job", "usage_anchor", "text"),
    ("session_provider_request", "usage_anchor", "text"),
    ("session_task", "usage_anchor", "text"),
    ("session", "usage_pruned_through", "integer"),
];

fn analytics_schema(db: &Connection) {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS `usage_analytics_request` (
          `id` text PRIMARY KEY,
          `session_id` text NOT NULL,
          `project_id` text NOT NULL,
          `directory` text NOT NULL,
          `workspace_id` text,
          `session_updated` integer NOT NULL,
          `agent` text NOT NULL,
          `source` text NOT NULL,
          `model` text NOT NULL,
          `usage_anchor` text,
          `task_path` text NOT NULL,
          `request` integer NOT NULL,
          `attempts` integer NOT NULL,
          `continuation` text NOT NULL,
          `invalidation` text NOT NULL,
          `prompt_cache_key` text NOT NULL,
          `cache_read_reported` integer,
          `tokens` text NOT NULL,
          `cost` real,
          `timing` text,
          `time_created` integer NOT NULL
        );
        CREATE INDEX IF NOT EXISTS `usage_analytics_request_time_created_id_idx` ON `usage_analytics_request` (`time_created`,`id`);",
    )
    .unwrap();
    for (table, column, type_) in ANALYTICS_COLUMNS {
        let mut statement = db
            .prepare(&format!("PRAGMA table_xinfo('{table}')"))
            .unwrap();
        let present = statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .any(|name| name.unwrap() == column);
        if !present {
            db.execute_batch(&format!("ALTER TABLE `{table}` ADD `{column}` {type_};"))
                .unwrap();
        }
    }
    db.execute_batch(
        "INSERT OR IGNORE INTO migration VALUES ('20261015122915_usage-analytics', 1);",
    )
    .unwrap();
}

const TIMING: &str = r#"{"generatedTokens":12,"generationDurationNs":2000000000}"#;
const TOKENS: &str = r#"{"input":3,"output":2,"reasoning":1,"cache":{"read":4,"write":5}}"#;

fn ledger(
    db: &Connection,
    id: &str,
    session: &str,
    request: i64,
    key: &str,
    time: i64,
    (cost, timing): (Option<f64>, Option<&str>),
) {
    db.execute(
        "INSERT INTO session_provider_request (id,session_id,input_id,assistant_message_id,connection_identity_digest,source,agent,model,route_id,prompt_cache_key,system_digest,tool_digest,request,attempts,invalidation,continuation,cache_read_reported,timing,cost,tokens,time_created)
         VALUES (?1,?2,NULL,NULL,NULL,'step','build','{\"providerID\":\"openai\",\"id\":\"gpt\"}','route',?3,'system','tools',?4,2,'first-request','full',1,?5,?6,?7,?8)",
        rusqlite::params![id, session, key, request, timing, cost, TOKENS, time],
    )
    .unwrap();
}

fn lineage(db: &Connection) {
    db.execute_batch(
        "INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('p','/synthetic',1,1,'[]');
         INSERT INTO workspace (id,type,name,project_id,time_used,extra) VALUES ('w','local','','p',1,'{}');
         INSERT INTO session (id,project_id,workspace_id,parent_id,directory,title,time_created,time_updated) VALUES
           ('ses_a','p','w',NULL,'/dir/a','a',1,50),
           ('ses_b','p',NULL,'ses_a','/dir/b','b',1,60),
           ('ses_c','p',NULL,NULL,'/dir/c','c',1,70),
           ('ses_d','p',NULL,'ses_c','/dir/d','d',1,80),
           ('ses_e','p',NULL,'ses_b','/dir/e','e',1,90);
         INSERT INTO session_task (session_id,parent_id,parent_assistant_message_id,tool_call_id,input_id,description,agent,model,prompt_digest,background,delivery,state,time_created,time_updated) VALUES
           ('ses_b','ses_a','assistant','call_b','input_b','task','build','{\"providerID\":\"test\",\"id\":\"test\"}','digest',1,'steer','running',1,1),
           ('ses_e','ses_b','assistant','call_e','input_e','task','build','{\"providerID\":\"test\",\"id\":\"test\"}','digest',1,'steer','running',1,1);",
    )
    .unwrap();
}

fn pre_analytics_source(fixture: &Fixture) {
    let db = fixture.create();
    lineage(&db);
    ledger(
        &db,
        "prq_a1",
        "ses_a",
        1,
        "abcdefghijkl",
        100,
        (Some(0.5), Some(TIMING)),
    );
    ledger(&db, "prq_a2", "ses_a", 2, "ab😀cdefghi", 110, (None, None));
    ledger(
        &db,
        "prq_b1",
        "ses_b",
        1,
        "zyxwvutsrq",
        120,
        (Some(1.5), None),
    );
    ledger(&db, "prq_e1", "ses_e", 1, "abc", 130, (None, None));
    ledger(&db, "prq_c1", "ses_c", 1, "mnopqrstuv", 140, (None, None));
    ledger(&db, "prq_d1", "ses_d", 1, "klmnopqrs", 150, (None, None));
}

fn open(candidate: &Path) -> Store {
    Store::open(
        candidate,
        Options::core(),
        import::catalog(DatabaseKind::Core),
    )
    .unwrap()
}

fn facts(store: &Store) -> Vec<resources::UsageAnalyticsRequest> {
    store
        .snapshot()
        .unwrap()
        .scan::<resources::UsageAnalyticsRequestTable>(
            Bound::Unbounded,
            Bound::Unbounded,
            usize::MAX,
        )
        .unwrap()
}

fn source_tables(fixture: &Fixture) -> BTreeSet<String> {
    Connection::open(fixture.source())
        .unwrap()
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn derived_units<'a>(
    report: &'a import::Report,
    tables: &BTreeSet<String>,
) -> Vec<&'a import::TableSummary> {
    report
        .tables
        .iter()
        .filter(|table| {
            !tables.contains(&table.name)
                && !["model_incident", "model_guidance_clear"].contains(&table.name.as_str())
        })
        .collect()
}

#[test]
fn a_pre_analytics_source_backfills_exact_facts_from_the_imported_ledger_only() {
    let fixture = Fixture::new();
    pre_analytics_source(&fixture);
    let original = std::fs::read(fixture.source()).unwrap();
    let candidate = fixture.candidate("one");
    let report = fixture
        .stage(&candidate, |_| ControlFlow::Continue(()))
        .unwrap();
    assert_eq!(std::fs::read(fixture.source()).unwrap(), original);
    assert_eq!(report.importer_version, 2);
    let tables = source_tables(&fixture);
    assert!(!tables.contains("usage_analytics_request"));
    let derived = derived_units(&report, &tables);
    assert_eq!(derived.len(), 1);
    assert_eq!(derived[0].rows, 6);
    assert_ne!(derived[0].name, "usage_analytics_request");
    assert_eq!(derived[0].digest.len(), 64);
    assert_eq!(
        import::sealed(&candidate, DatabaseKind::Core).unwrap().1,
        report
    );

    let store = open(&candidate);
    let rows = facts(&store);
    assert_eq!(rows.len(), 6);
    let tokens = parse_json(TOKENS).unwrap();
    let model = parse_json(r#"{"providerID":"openai","id":"gpt"}"#).unwrap();
    for (id, session, directory, workspace, updated, path, prefix, request, time, cost) in [
        (
            "prq_a1",
            "ses_a",
            "/dir/a",
            Some("w"),
            50,
            "[]",
            "abcdefgh",
            1,
            100,
            Some(0.5),
        ),
        (
            "prq_a2",
            "ses_a",
            "/dir/a",
            Some("w"),
            50,
            "[]",
            "ab😀cdefg",
            2,
            110,
            None,
        ),
        (
            "prq_b1",
            "ses_b",
            "/dir/b",
            None,
            60,
            r#"["ses_b"]"#,
            "zyxwvuts",
            1,
            120,
            Some(1.5),
        ),
        (
            "prq_e1",
            "ses_e",
            "/dir/e",
            None,
            90,
            r#"["ses_e","ses_b"]"#,
            "abc",
            1,
            130,
            None,
        ),
        (
            "prq_c1", "ses_c", "/dir/c", None, 70, "[]", "mnopqrst", 1, 140, None,
        ),
        (
            "prq_d1", "ses_d", "/dir/d", None, 80, "[]", "klmnopqr", 1, 150, None,
        ),
    ] {
        let fact = rows
            .iter()
            .find(|fact| fact.id.as_str() == Some(id))
            .unwrap_or_else(|| panic!("missing fact {id}"));
        assert_eq!(fact.session_id.as_str(), Some(session), "{id}");
        assert_eq!(fact.project_id.as_str(), Some("p"), "{id}");
        assert_eq!(fact.directory.as_str(), Some(directory), "{id}");
        assert_eq!(
            fact.workspace_id.as_ref().and_then(LosslessString::as_str),
            workspace,
            "{id}"
        );
        assert_eq!(fact.session_updated, updated, "{id}");
        assert_eq!(fact.agent.as_str(), Some("build"), "{id}");
        assert_eq!(fact.source.as_str(), Some("step"), "{id}");
        assert_eq!(fact.model.value(), &model, "{id}");
        assert!(fact.usage_anchor.is_none(), "{id}");
        assert_eq!(fact.task_path.value(), &parse_json(path).unwrap(), "{id}");
        assert_eq!(fact.request, request, "{id}");
        assert_eq!(fact.attempts, 2, "{id}");
        assert_eq!(fact.continuation.as_str(), Some("full"), "{id}");
        assert_eq!(fact.invalidation.as_str(), Some("first-request"), "{id}");
        assert_eq!(fact.prompt_cache_key.as_str(), Some(prefix), "{id}");
        assert_eq!(fact.cache_read_reported, Some(1), "{id}");
        assert_eq!(fact.tokens.value(), &tokens, "{id}");
        assert_eq!(fact.cost, cost, "{id}");
        assert_eq!(
            fact.timing.as_ref().map(|timing| timing.value().clone()),
            (id == "prq_a1").then(|| parse_json(TIMING).unwrap()),
            "{id}"
        );
        assert_eq!(fact.time_created, time, "{id}");
    }
    let ledger = store
        .snapshot()
        .unwrap()
        .scan::<resources::RequestTable>(Bound::Unbounded, Bound::Unbounded, 100)
        .unwrap();
    assert_eq!(ledger.len(), 6);
    assert!(ledger.iter().all(|row| row.usage_anchor.is_none()));
    assert!(
        store
            .snapshot()
            .unwrap()
            .scan::<session::SessionTable>(Bound::Unbounded, Bound::Unbounded, 100)
            .unwrap()
            .iter()
            .all(|row| row.usage_pruned_through.is_none())
    );
    store.shutdown().unwrap();
}

#[test]
fn the_backfill_is_deterministic_across_candidates() {
    let fixture = Fixture::new();
    pre_analytics_source(&fixture);
    let first = fixture
        .stage(&fixture.candidate("one"), |_| ControlFlow::Continue(()))
        .unwrap();
    let second = fixture
        .stage(&fixture.candidate("two"), |_| ControlFlow::Continue(()))
        .unwrap();
    assert_eq!(first.tables, second.tables);
    assert_eq!(first.source_fingerprint, second.source_fingerprint);
    let (one, two) = (
        open(&fixture.candidate("one")),
        open(&fixture.candidate("two")),
    );
    assert_eq!(facts(&one), facts(&two));
    one.shutdown().unwrap();
    two.shutdown().unwrap();
}

#[test]
fn a_pre_analytics_source_without_ledger_rows_backfills_no_facts() {
    let fixture = Fixture::new();
    let db = fixture.create();
    lineage(&db);
    drop(db);
    let candidate = fixture.candidate("one");
    let report = fixture
        .stage(&candidate, |_| ControlFlow::Continue(()))
        .unwrap();
    let tables = source_tables(&fixture);
    assert!(
        derived_units(&report, &tables)
            .iter()
            .all(|unit| unit.rows == 0)
    );
    let store = open(&candidate);
    assert!(facts(&store).is_empty());
    store.shutdown().unwrap();
}

#[test]
fn interruption_around_the_backfill_unit_resumes_to_the_same_sealed_result() {
    let fixture = Fixture::new();
    pre_analytics_source(&fixture);
    let mut phases = Vec::new();
    let reference = fixture
        .stage(&fixture.candidate("reference"), |phase| {
            phases.push(phase);
            ControlFlow::Continue(())
        })
        .unwrap();
    let tables = source_tables(&fixture);
    let boundaries = phases
        .into_iter()
        .filter(|phase| {
            matches!(phase, Progress::Loaded(name) | Progress::Verified(name) if !tables.contains(*name))
        })
        .collect::<Vec<_>>();
    assert!(!boundaries.is_empty());
    let reference_store = open(&fixture.candidate("reference"));
    let expected = facts(&reference_store);
    reference_store.shutdown().unwrap();
    for (index, boundary) in boundaries.into_iter().enumerate() {
        let candidate = fixture.candidate(&format!("resume{index}"));
        assert!(matches!(
            fixture.stage(&candidate, |phase| if phase == boundary {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }),
            Err(import::Error::Cancelled)
        ));
        assert!(candidate.exists());
        let report = fixture
            .stage(&candidate, |_| ControlFlow::Continue(()))
            .unwrap();
        assert_eq!(report.tables, reference.tables, "{boundary:?}");
        assert_eq!(
            import::sealed(&candidate, DatabaseKind::Core).unwrap().1,
            report
        );
        let store = open(&candidate);
        assert_eq!(facts(&store), expected, "{boundary:?}");
        store.shutdown().unwrap();
    }
}

fn anchor_json() -> String {
    r#"{"sessionID":"ses_live","inputID":"msg_live"}"#.to_owned()
}

#[test]
fn an_analytics_era_source_is_copied_verbatim_with_orphans_anchors_and_expired_gaps() {
    let fixture = Fixture::new();
    let db = fixture.create();
    analytics_schema(&db);
    db.execute_batch(
        "INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('p','/synthetic',1,1,'[]');
         INSERT INTO session (id,project_id,directory,title,time_created,time_updated,usage_pruned_through) VALUES
           ('ses_live','p','/synthetic','live',1,1,1234),
           ('ses_task','p','/synthetic','task',1,1,NULL);
         INSERT INTO session_context_revision (session_id,revision,time_created) VALUES ('ses_live',0,1);",
    )
    .unwrap();
    let anchor = anchor_json();
    ledger(
        &db,
        "prq_live",
        "ses_live",
        1,
        "abcdefghijkl",
        10,
        (Some(0.5), None),
    );
    ledger(
        &db,
        "prq_gap",
        "ses_live",
        2,
        "abcdefghijkl",
        11,
        (Some(0.5), None),
    );
    db.execute(
        "UPDATE session_provider_request SET usage_anchor = ?1 WHERE id = 'prq_live'",
        [&anchor],
    )
    .unwrap();
    db.execute(
        "INSERT INTO session_task (session_id,parent_id,parent_assistant_message_id,tool_call_id,input_id,description,agent,model,prompt_digest,background,delivery,state,time_created,time_updated,usage_anchor)
         VALUES ('ses_task','ses_live','assistant','call','input','task','build','{\"providerID\":\"test\",\"id\":\"test\"}','digest',1,'steer','running',1,1,?1)",
        [&anchor],
    )
    .unwrap();
    db.execute(
        "INSERT INTO session_compaction_job (id,session_id,legacy_input_id,trigger,requested_through_message_id,requested_through_seq,base_context_revision,status,attempts,time_created,usage_anchor)
         VALUES ('cmp_one','ses_live','msg_live','manual','msg_live',0,0,'pending',0,1,?1)",
        [&anchor],
    )
    .unwrap();
    for (id, session, anchor, time, cost) in [
        (
            "fact_live",
            "ses_live",
            Some(anchor.as_str()),
            10,
            Some(0.5),
        ),
        ("fact_orphan_a", "ses_gone", None, 20, None),
        ("fact_orphan_b", "ses_other_gone", None, 30, Some(2.0)),
    ] {
        db.execute(
            "INSERT INTO usage_analytics_request (id,session_id,project_id,directory,workspace_id,session_updated,agent,source,model,usage_anchor,task_path,request,attempts,continuation,invalidation,prompt_cache_key,cache_read_reported,tokens,cost,timing,time_created)
             VALUES (?1,?2,'p_gone','/gone','w_gone',5,'build','step','{\"providerID\":\"openai\",\"id\":\"gpt\"}',?3,'[\"ses_task\",\"ses_parent\"]',7,3,'full','first-request','abcdefgh',NULL,?4,?5,?6,?7)",
            rusqlite::params![id, session, anchor, TOKENS, cost, TIMING, time],
        )
        .unwrap();
    }
    drop(db);
    let original = std::fs::read(fixture.source()).unwrap();
    let candidate = fixture.candidate("one");
    let report = fixture
        .stage(&candidate, |_| ControlFlow::Continue(()))
        .unwrap();
    assert_eq!(std::fs::read(fixture.source()).unwrap(), original);
    assert_eq!(report.importer_version, 2);
    let tables = source_tables(&fixture);
    assert!(tables.contains("usage_analytics_request"));
    assert!(derived_units(&report, &tables).is_empty());
    assert_eq!(
        report
            .tables
            .iter()
            .filter(|table| table.name == "usage_analytics_request")
            .map(|table| table.rows)
            .collect::<Vec<_>>(),
        [3]
    );
    let second = fixture
        .stage(&fixture.candidate("two"), |_| ControlFlow::Continue(()))
        .unwrap();
    assert_eq!(report.tables, second.tables);

    let store = open(&candidate);
    let rows = facts(&store);
    assert_eq!(
        rows.iter()
            .map(|fact| fact.id.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["fact_live", "fact_orphan_a", "fact_orphan_b"]
    );
    let expected_anchor = usage_anchor::Ref {
        session_id: SessionId::new("ses_live").unwrap(),
        input_id: session_message_id::Id::new("msg_live").unwrap(),
    }
    .encode();
    assert_eq!(
        rows[0].usage_anchor.as_ref().map(|a| a.value().clone()),
        Some(expected_anchor.clone())
    );
    assert!(rows[1].usage_anchor.is_none());
    for (row, session) in rows.iter().zip(["ses_live", "ses_gone", "ses_other_gone"]) {
        assert_eq!(row.session_id.as_str(), Some(session));
        assert_eq!(row.project_id.as_str(), Some("p_gone"));
        assert_eq!(row.directory.as_str(), Some("/gone"));
        assert_eq!(
            row.workspace_id.as_ref().and_then(LosslessString::as_str),
            Some("w_gone")
        );
        assert_eq!(row.session_updated, 5);
        assert_eq!(
            row.task_path.value(),
            &parse_json(r#"["ses_task","ses_parent"]"#).unwrap()
        );
        assert_eq!((row.request, row.attempts), (7, 3));
        assert_eq!(row.prompt_cache_key.as_str(), Some("abcdefgh"));
        assert_eq!(row.cache_read_reported, None);
        assert_eq!(row.tokens.value(), &parse_json(TOKENS).unwrap());
        assert_eq!(
            row.timing.as_ref().map(|t| t.value().clone()),
            Some(parse_json(TIMING).unwrap())
        );
    }
    assert_eq!(rows[2].cost, Some(2.0));
    assert_eq!(rows[1].cost, None);
    assert_eq!(
        rows.iter()
            .map(|fact| fact.time_created)
            .collect::<Vec<_>>(),
        [10, 20, 30]
    );

    let snapshot = store.snapshot().unwrap();
    let ledger = snapshot
        .scan::<resources::RequestTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap();
    assert_eq!(ledger.len(), 2);
    assert_eq!(
        ledger
            .iter()
            .find(|row| row.id.as_str() == Some("prq_live"))
            .unwrap()
            .usage_anchor
            .as_ref()
            .map(|a| a.value().clone()),
        Some(expected_anchor.clone())
    );
    assert!(
        ledger
            .iter()
            .find(|row| row.id.as_str() == Some("prq_gap"))
            .unwrap()
            .usage_anchor
            .is_none()
    );
    let task = snapshot
        .scan::<session::TaskTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(
        task.usage_anchor.as_ref().map(|a| a.value().clone()),
        Some(expected_anchor.clone())
    );
    let job = snapshot
        .scan::<session::JobTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(
        job.usage_anchor.as_ref().map(|a| a.value().clone()),
        Some(expected_anchor)
    );
    let sessions = snapshot
        .scan::<session::SessionTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap();
    assert_eq!(
        sessions
            .iter()
            .find(|row| row.id.as_str() == Some("ses_live"))
            .unwrap()
            .usage_pruned_through,
        Some(1234)
    );
    assert_eq!(
        sessions
            .iter()
            .find(|row| row.id.as_str() == Some("ses_task"))
            .unwrap()
            .usage_pruned_through,
        None
    );
    drop(snapshot);
    store.shutdown().unwrap();
}

#[test]
fn an_unrepresentable_anchor_in_the_source_fails_closed_without_sealing_a_candidate() {
    for bad in [
        r#"{"sessionID":"ses_live"}"#,
        r#"{"sessionID":"msg_live","inputID":"msg_live"}"#,
        r#"{"sessionID":"ses_live","inputID":"msg_live","extra":1}"#,
        "null",
        "not json",
    ] {
        let fixture = Fixture::new();
        let db = fixture.create();
        analytics_schema(&db);
        db.execute_batch(
            "INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('p','/synthetic',1,1,'[]');
             INSERT INTO session (id,project_id,directory,title,time_created,time_updated) VALUES ('ses_live','p','/synthetic','live',1,1);",
        )
        .unwrap();
        ledger(
            &db,
            "prq_live",
            "ses_live",
            1,
            "abcdefghijkl",
            10,
            (None, None),
        );
        db.execute(
            "UPDATE session_provider_request SET usage_anchor = ?1",
            [bad],
        )
        .unwrap();
        drop(db);
        let original = std::fs::read(fixture.source()).unwrap();
        let candidate = fixture.candidate("one");
        assert!(
            fixture
                .stage(&candidate, |_| ControlFlow::Continue(()))
                .is_err(),
            "{bad}"
        );
        assert!(
            import::sealed(&candidate, DatabaseKind::Core).is_err(),
            "{bad}"
        );
        assert_eq!(std::fs::read(fixture.source()).unwrap(), original, "{bad}");
    }
}
