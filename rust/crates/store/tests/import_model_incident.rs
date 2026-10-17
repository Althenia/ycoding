use rusqlite::Connection;
use std::ops::{Bound, ControlFlow};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use ycoding_schema::{LosslessString, parse_json};
use ycoding_store::import::{self, DatabaseKind, Request};
use ycoding_store::model_incident::{GuidanceClear, GuidanceClearTable, Incident, IncidentTable};
use ycoding_store::{Metadata, Options, Store, session::Document};

static NEXT: AtomicU64 = AtomicU64::new(0);

const INCIDENT_MIGRATION: &str = "20261016080907_model-incident";

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ycoding-import-incident-{}-{}",
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
    fn stage(&self, candidate: &Path) -> Result<import::Report, import::Error> {
        import::stage(
            Request {
                source: &self.source(),
                candidate,
                kind: DatabaseKind::Core,
                metadata: Metadata::new([8; 16], 1),
            },
            |_| ControlFlow::Continue(()),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn analytics_schema(db: &Connection) {
    db.execute_batch(
        "CREATE TABLE `usage_analytics_request` (
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
        CREATE INDEX `usage_analytics_request_time_created_id_idx` ON `usage_analytics_request` (`time_created`,`id`);",
    )
    .unwrap();
    for (table, column, type_) in [
        ("session_compaction_job", "usage_anchor", "text"),
        ("session_provider_request", "usage_anchor", "text"),
        ("session_task", "usage_anchor", "text"),
        ("session", "usage_pruned_through", "integer"),
    ] {
        let present = db
            .prepare(&format!("PRAGMA table_xinfo('{table}')"))
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .any(|name| name.unwrap() == column);
        if !present {
            db.execute_batch(&format!("ALTER TABLE `{table}` ADD `{column}` {type_};"))
                .unwrap();
        }
    }
    db.execute_batch("INSERT INTO migration VALUES ('20261015122915_usage-analytics', 1);")
        .unwrap();
}

fn incident_tables(db: &Connection) {
    db.execute_batch(
        "CREATE TABLE `model_guidance_clear` (
          `provider_id` text NOT NULL,
          `model_id` text NOT NULL,
          `cleared_at` integer NOT NULL,
          CONSTRAINT `model_guidance_clear_pk` PRIMARY KEY(`provider_id`, `model_id`)
        );
        CREATE TABLE `model_incident` (
          `id` text PRIMARY KEY,
          `time_created` integer NOT NULL,
          `kind` text NOT NULL,
          `provider_id` text NOT NULL,
          `model_id` text NOT NULL,
          `variant` text,
          `profile` text,
          `agent` text NOT NULL,
          `project_id` text NOT NULL,
          `session_id` text NOT NULL,
          `request_id` text,
          `category` text NOT NULL,
          `rule_ids` text NOT NULL,
          `target` text,
          `decided_by` text
        );
        CREATE INDEX `model_incident_time_created_id_idx` ON `model_incident` (`time_created`,`id`);
        CREATE INDEX `model_incident_model_time_idx` ON `model_incident` (`provider_id`,`model_id`,`time_created`);
        CREATE INDEX `model_incident_request_id_idx` ON `model_incident` (`request_id`);",
    )
    .unwrap();
}

fn latest_stable(fixture: &Fixture) -> Connection {
    let db = fixture.create();
    analytics_schema(&db);
    incident_tables(&db);
    db.execute_batch(&format!(
        "INSERT INTO migration VALUES ('{INCIDENT_MIGRATION}', 2);
         INSERT INTO migration VALUES ('20261017090000_session-yolo-level', 3);"
    ))
    .unwrap();
    db
}

type Row<'a> = [Option<&'a str>; 15];

const FALLBACK: Row<'static> = [
    Some("inc_01"),
    Some("10"),
    Some("fallback"),
    Some("openai"),
    Some("gpt"),
    Some("high"),
    Some("work"),
    Some("build"),
    Some("prj_gone"),
    Some("ses_gone"),
    None,
    Some("rate_limit"),
    Some("[]"),
    Some(r#"{"providerID":"openai","id":"mini"}"#),
    None,
];
const ESCALATED: Row<'static> = [
    Some("inc_02"),
    Some("20"),
    Some("guardrail-escalated"),
    Some("anthropic"),
    Some("claude"),
    None,
    None,
    Some("plan"),
    Some("prj_one"),
    Some("ses_one"),
    Some("grq_one"),
    Some("hard"),
    Some(r#"["standard.review.force-push","custom"]"#),
    None,
    None,
];
const REJECTED: Row<'static> = [
    Some("inc_03"),
    Some("30"),
    Some("guardrail-rejected"),
    Some("anthropic"),
    Some("claude"),
    None,
    None,
    Some("plan"),
    Some("prj_one"),
    Some("ses_one"),
    Some("grq_one"),
    Some("ordinary"),
    Some(r#"["standard.review.outside-repo"]"#),
    None,
    Some("decision-model"),
];

fn insert(db: &Connection, row: Row<'_>) {
    let time = row[1].map(|time| time.parse::<i64>().unwrap());
    db.execute(
        "INSERT INTO model_incident (id,time_created,kind,provider_id,model_id,variant,profile,agent,project_id,session_id,request_id,category,rule_ids,target,decided_by)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        rusqlite::params![
            row[0], time, row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9],
            row[10], row[11], row[12], row[13], row[14]
        ],
    )
    .unwrap();
}

fn s(value: &str) -> LosslessString {
    value.into()
}

fn open(candidate: &Path) -> Store {
    Store::open(
        candidate,
        Options::core(),
        import::catalog(DatabaseKind::Core),
    )
    .unwrap()
}

fn rows(store: &Store) -> (Vec<Incident>, Vec<GuidanceClear>) {
    let snapshot = store.snapshot().unwrap();
    (
        snapshot
            .scan::<IncidentTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
            .unwrap(),
        snapshot
            .scan::<GuidanceClearTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
            .unwrap(),
    )
}

fn unit(report: &import::Report, name: &str) -> i64 {
    let matching = report
        .tables
        .iter()
        .filter(|table| table.name == name)
        .collect::<Vec<_>>();
    assert_eq!(matching.len(), 1, "{name}");
    matching[0].rows
}

#[test]
fn latest_stable_imports_every_incident_and_guidance_watermark_exactly() {
    let fixture = Fixture::new();
    let db = latest_stable(&fixture);
    for row in [FALLBACK, ESCALATED, REJECTED] {
        insert(&db, row);
    }
    db.execute_batch(
        "INSERT INTO model_guidance_clear VALUES ('anthropic','claude',25), ('openai','gpt',0);",
    )
    .unwrap();
    drop(db);
    let original = std::fs::read(fixture.source()).unwrap();
    let candidate = fixture.candidate("one");
    let report = fixture.stage(&candidate).unwrap();
    assert_eq!(std::fs::read(fixture.source()).unwrap(), original);
    assert_eq!(report.importer_version, 2);
    assert_eq!(unit(&report, "model_incident"), 3);
    assert_eq!(unit(&report, "model_guidance_clear"), 2);
    assert_eq!(
        import::sealed(&candidate, DatabaseKind::Core).unwrap().1,
        report
    );
    let second = fixture.stage(&fixture.candidate("two")).unwrap();
    assert_eq!(second.tables, report.tables);

    let store = open(&candidate);
    let (incidents, watermarks) = rows(&store);
    let document = |text: &str| Document::new(parse_json(text).unwrap()).unwrap();
    assert_eq!(
        incidents,
        [
            Incident {
                id: s("inc_01"),
                time_created: 10,
                kind: s("fallback"),
                provider_id: s("openai"),
                model_id: s("gpt"),
                variant: Some(s("high")),
                profile: Some(s("work")),
                agent: s("build"),
                project_id: s("prj_gone"),
                session_id: s("ses_gone"),
                request_id: None,
                category: s("rate_limit"),
                rule_ids: document("[]"),
                target: Some(
                    Document::new(parse_json(r#"{"providerID":"openai","id":"mini"}"#).unwrap())
                        .unwrap()
                ),
                decided_by: None,
            },
            Incident {
                id: s("inc_02"),
                time_created: 20,
                kind: s("guardrail-escalated"),
                provider_id: s("anthropic"),
                model_id: s("claude"),
                variant: None,
                profile: None,
                agent: s("plan"),
                project_id: s("prj_one"),
                session_id: s("ses_one"),
                request_id: Some(s("grq_one")),
                category: s("hard"),
                rule_ids: document(r#"["standard.review.force-push","custom"]"#),
                target: None,
                decided_by: None,
            },
            Incident {
                id: s("inc_03"),
                time_created: 30,
                kind: s("guardrail-rejected"),
                provider_id: s("anthropic"),
                model_id: s("claude"),
                variant: None,
                profile: None,
                agent: s("plan"),
                project_id: s("prj_one"),
                session_id: s("ses_one"),
                request_id: Some(s("grq_one")),
                category: s("ordinary"),
                rule_ids: document(r#"["standard.review.outside-repo"]"#),
                target: None,
                decided_by: Some(s("decision-model")),
            },
        ]
    );
    assert_eq!(
        watermarks,
        [
            GuidanceClear {
                provider_id: s("anthropic"),
                model_id: s("claude"),
                cleared_at: 25,
            },
            GuidanceClear {
                provider_id: s("openai"),
                model_id: s("gpt"),
                cleared_at: 0,
            },
        ]
    );
    store.shutdown().unwrap();
}

#[test]
fn a_source_before_the_incident_migration_imports_empty_incident_tables() {
    let fixture = Fixture::new();
    let db = fixture.create();
    analytics_schema(&db);
    drop(db);
    let candidate = fixture.candidate("one");
    let report = fixture.stage(&candidate).unwrap();
    assert_eq!(unit(&report, "model_incident"), 0);
    assert_eq!(unit(&report, "model_guidance_clear"), 0);
    let store = open(&candidate);
    assert_eq!(rows(&store), (vec![], vec![]));
    store.shutdown().unwrap();
}

#[test]
fn incident_inventory_must_match_the_migration_record() {
    type Prepare = fn(&Connection);
    let cases: [(&str, Prepare); 3] = [
        ("tables without the migration record", |db| {
            incident_tables(db)
        }),
        ("migration record without the tables", |db| {
            db.execute_batch(&format!(
                "INSERT INTO migration VALUES ('{INCIDENT_MIGRATION}', 2);"
            ))
            .unwrap()
        }),
        ("one table missing", |db| {
            incident_tables(db);
            db.execute_batch(&format!(
                "DROP TABLE model_guidance_clear; INSERT INTO migration VALUES ('{INCIDENT_MIGRATION}', 2);"
            ))
            .unwrap()
        }),
    ];
    for (name, prepare) in cases {
        let fixture = Fixture::new();
        let db = fixture.create();
        analytics_schema(&db);
        prepare(&db);
        drop(db);
        let candidate = fixture.candidate("one");
        assert!(
            matches!(
                fixture.stage(&candidate),
                Err(import::Error::Source(
                    "table inventory differs from the exact compiled baseline"
                ))
            ),
            "{name}"
        );
        assert!(!candidate.exists(), "{name}");
    }
}

#[test]
fn a_malformed_legacy_incident_or_watermark_fails_the_whole_import() {
    let with = |index: usize, value: Option<&'static str>| {
        let mut row = ESCALATED;
        row[index] = value;
        row
    };
    let rejected = |index: usize, value: Option<&'static str>| {
        let mut row = REJECTED;
        row[index] = value;
        row
    };
    let fallback = |index: usize, value: Option<&'static str>| {
        let mut row = FALLBACK;
        row[0] = Some("inc_09");
        row[index] = value;
        row
    };
    let incidents: Vec<(&str, Row<'static>)> = vec![
        ("id prefix", with(0, Some("prq_02"))),
        ("negative time", with(1, Some("-1"))),
        ("unknown kind", with(2, Some("guardrail"))),
        ("empty agent", with(7, Some(""))),
        ("guardrail category", with(11, Some("medium"))),
        (
            "free-text fallback category",
            fallback(11, Some("rate limit /home/me")),
        ),
        ("unbounded rule", with(12, Some(r#"["rm -rf /"]"#))),
        ("duplicate rule", with(12, Some(r#"["custom","custom"]"#))),
        ("rule ids not an array", with(12, Some(r#""custom""#))),
        ("rule ids not json", with(12, Some("custom"))),
        ("guardrail without request", with(10, None)),
        ("fallback with request", fallback(10, Some("grq_x"))),
        ("fallback without target", fallback(13, None)),
        (
            "fallback target not a model",
            fallback(13, Some(r#"{"model":"mini"}"#)),
        ),
        ("guardrail with target", with(13, FALLBACK[13])),
        ("escalation decided", with(14, Some("human"))),
        ("rejection undecided", rejected(14, None)),
        ("unknown decider", rejected(14, Some("model"))),
    ];
    for (name, row) in incidents {
        let fixture = Fixture::new();
        let db = latest_stable(&fixture);
        insert(&db, FALLBACK);
        insert(&db, row);
        drop(db);
        let original = std::fs::read(fixture.source()).unwrap();
        let candidate = fixture.candidate("one");
        assert!(fixture.stage(&candidate).is_err(), "{name}");
        assert!(
            import::sealed(&candidate, DatabaseKind::Core).is_err(),
            "{name}"
        );
        assert_eq!(std::fs::read(fixture.source()).unwrap(), original, "{name}");
    }
    for (name, statement) in [
        (
            "negative watermark",
            "INSERT INTO model_guidance_clear VALUES ('openai','gpt',-1);",
        ),
        (
            "empty provider",
            "INSERT INTO model_guidance_clear VALUES ('','gpt',1);",
        ),
    ] {
        let fixture = Fixture::new();
        let db = latest_stable(&fixture);
        insert(&db, FALLBACK);
        db.execute_batch(statement).unwrap();
        drop(db);
        let candidate = fixture.candidate("one");
        assert!(fixture.stage(&candidate).is_err(), "{name}");
        assert!(
            import::sealed(&candidate, DatabaseKind::Core).is_err(),
            "{name}"
        );
    }
}
