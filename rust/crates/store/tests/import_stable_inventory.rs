use rusqlite::Connection;
use std::ops::ControlFlow;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use ycoding_store::Metadata;
use ycoding_store::import::{self, DatabaseKind, Request};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Directory(PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn latest_stable() -> (Directory, PathBuf) {
    let directory = Directory(std::env::temp_dir().join(format!(
        "ycoding-import-inventory-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )));
    std::fs::create_dir(&directory.0).unwrap();
    let source = directory.0.join("ycoding.db");
    let db = Connection::open(&source).unwrap();
    let schema = include_str!("../../../../packages/core/src/database/schema.gen.ts");
    let delimiters = schema
        .match_indices('`')
        .filter_map(|(at, _)| (at == 0 || schema.as_bytes()[at - 1] != b'\\').then_some(at))
        .collect::<Vec<_>>();
    for pair in delimiters.as_chunks::<2>().0 {
        db.execute_batch(&schema[pair[0] + 1..pair[1]].replace("\\`", "`"))
            .unwrap();
    }
    db.execute_batch(
        "CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
        CREATE TABLE database_format (id TEXT PRIMARY KEY, time_created INTEGER NOT NULL);
        INSERT INTO database_format VALUES ('current-2026-08-04', 1);
        INSERT INTO migration VALUES
          ('baseline', 1),
          ('20261015122915_usage-analytics', 2),
          ('20261016080907_model-incident', 3),
          ('20261017090000_session-yolo-level', 4);
        CREATE TABLE `usage_analytics_request` (`id` text PRIMARY KEY, `session_id` text NOT NULL, `project_id` text NOT NULL, `directory` text NOT NULL, `workspace_id` text, `session_updated` integer NOT NULL, `agent` text NOT NULL, `source` text NOT NULL, `model` text NOT NULL, `usage_anchor` text, `task_path` text NOT NULL, `request` integer NOT NULL, `attempts` integer NOT NULL, `continuation` text NOT NULL, `invalidation` text NOT NULL, `prompt_cache_key` text NOT NULL, `cache_read_reported` integer, `tokens` text NOT NULL, `cost` real, `timing` text, `time_created` integer NOT NULL);
        CREATE INDEX `usage_analytics_request_time_created_id_idx` ON `usage_analytics_request` (`time_created`,`id`);
        CREATE TABLE `model_guidance_clear` (`provider_id` text NOT NULL, `model_id` text NOT NULL, `cleared_at` integer NOT NULL, CONSTRAINT `model_guidance_clear_pk` PRIMARY KEY(`provider_id`, `model_id`));
        CREATE TABLE `model_incident` (`id` text PRIMARY KEY, `time_created` integer NOT NULL, `kind` text NOT NULL, `provider_id` text NOT NULL, `model_id` text NOT NULL, `variant` text, `profile` text, `agent` text NOT NULL, `project_id` text NOT NULL, `session_id` text NOT NULL, `request_id` text, `category` text NOT NULL, `rule_ids` text NOT NULL, `target` text, `decided_by` text);
        CREATE INDEX `model_incident_time_created_id_idx` ON `model_incident` (`time_created`,`id`);
        CREATE INDEX `model_incident_model_time_idx` ON `model_incident` (`provider_id`,`model_id`,`time_created`);
        CREATE INDEX `model_incident_request_id_idx` ON `model_incident` (`request_id`);
        INSERT INTO model_incident VALUES ('inc_one', 5, 'fallback', 'openai', 'gpt', NULL, NULL, 'build', 'prj_one', 'ses_one', NULL, 'rate_limit', '[]', '{\"providerID\":\"openai\",\"id\":\"mini\"}', NULL);
        INSERT INTO model_guidance_clear VALUES ('openai', 'gpt', 4);",
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
    drop(db);
    (directory, source)
}

#[test]
fn the_latest_stable_inventory_with_model_incidents_imports_and_seals() {
    let (directory, source) = latest_stable();
    let candidate = directory.0.join("candidate.redb");
    let report = import::stage(
        Request {
            source: &source,
            candidate: &candidate,
            kind: DatabaseKind::Core,
            metadata: Metadata::new([6; 16], 1),
        },
        |_| ControlFlow::Continue(()),
    )
    .unwrap();
    let rows = |name: &str| {
        report
            .tables
            .iter()
            .find(|table| table.name == name)
            .map(|table| table.rows)
    };
    assert_eq!(rows("model_incident"), Some(1));
    assert_eq!(rows("model_guidance_clear"), Some(1));
    assert_eq!(report.tables.len(), 52);
    assert_eq!(
        import::sealed(&candidate, DatabaseKind::Core).unwrap().1,
        report
    );
}
