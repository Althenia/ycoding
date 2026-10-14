use rusqlite::Connection;
use std::ops::{Bound, ControlFlow};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use ycoding_schema::{JsonValue, LosslessString};
use ycoding_store::import::{self, DatabaseKind, Progress, Request};
use ycoding_store::{Metadata, Options, Store, TableSpec, artifacts, project, resources, session};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ycoding-import-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn source(&self) -> PathBuf {
        self.0.join("source.sqlite")
    }
    fn candidate(&self) -> PathBuf {
        self.0.join("candidate.redb")
    }
    fn create(&self, kind: DatabaseKind) -> Connection {
        let db = Connection::open(self.source()).unwrap();
        if kind == DatabaseKind::Core {
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
    fn request<'a>(
        &self,
        kind: DatabaseKind,
        source: &'a std::path::Path,
        candidate: &'a std::path::Path,
    ) -> Request<'a> {
        let _ = self;
        Request {
            source,
            candidate,
            kind,
            metadata: Metadata::new([7; 16], 1),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn rows() -> &'static str {
    "INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('p','/synthetic',-1,9223372036854775807,'[\"\\ud800\",\"a\\u0000b\"]');
     INSERT INTO workspace (id,type,name,project_id,time_used,extra) VALUES ('w','local','', 'p',-1,'{\"\\udfff\": -0}');
     INSERT INTO permission VALUES ('rule','p','read','*',0,1);
     INSERT INTO data_migration VALUES ('m',9223372036854775807);
     INSERT INTO migration VALUES (CAST(X'FF' AS TEXT),0);
     INSERT INTO migration VALUES (CAST(X'E0A061F09F98' AS TEXT),0);
     INSERT INTO migration VALUES (CAST(X'EDA080' AS TEXT),0);
     INSERT INTO kv VALUES ('odd','{\"\\ud800\":\"\\udfff\",\"zero\":-0,\"null\":null}',-1,0);
     INSERT INTO kv VALUES ('invalid-json',CAST(X'22FF22' AS TEXT),0,0);
     INSERT INTO instruction_blob VALUES ('null',NULL);
     INSERT INTO instruction_blob VALUES ('json-null','null');
     INSERT INTO telemetry_consent VALUES (1,0,1,0);
     INSERT INTO credential (id,label,value,active,generation,account_generation,time_created,time_updated) VALUES ('credential','synthetic','{\"type\":\"key\",\"key\":\"synthetic-test-only\",\"metadata\":{\"\\ud800\":-0},\"extra\":\"retained\"}',99,0,1,0,1);
     INSERT INTO event_sequence VALUES ('aggregate',-1,NULL);
     INSERT INTO event VALUES ('event','aggregate',-1,0,'test','{\"empty\":\"\"}');"
}

#[test]
fn core_round_trip_preserves_rows_documents_indexes_and_source_bytes() {
    let fixture = Fixture::new();
    let db = fixture.create(DatabaseKind::Core);
    db.execute_batch(rows()).unwrap();
    drop(db);
    let source = fixture.source();
    let candidate = fixture.candidate();
    let before = std::fs::read(&source).unwrap();
    let report = import::stage(
        fixture.request(DatabaseKind::Core, &source, &candidate),
        |_| ControlFlow::Continue(()),
    )
    .unwrap();
    assert_eq!(report.tables.len(), 49);
    assert_eq!(
        report.tables.iter().find(|t| t.name == "kv").unwrap().rows,
        2
    );
    assert_eq!(before, std::fs::read(&source).unwrap());
    let store = Store::open(
        &candidate,
        Options::core(),
        import::catalog(DatabaseKind::Core),
    )
    .unwrap();
    let snapshot = store.snapshot().unwrap();
    let project = snapshot
        .scan::<project::ProjectTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(project.time_created, -1);
    assert_eq!(project.time_updated, i64::MAX);
    assert_eq!(
        project.sandboxes[0],
        LosslessString::from_utf16(vec![0xd800])
    );
    assert_eq!(project.sandboxes[1].as_str(), Some("a\0b"));
    let kv = snapshot
        .scan::<resources::KvTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap()
        .into_iter()
        .find(|row| row.key.as_str() == Some("odd"))
        .unwrap();
    let JsonValue::Object(value) = kv.value.value() else {
        panic!("expected object")
    };
    assert_eq!(
        value.get(&LosslessString::from_utf16(vec![0xd800])),
        Some(&JsonValue::String(LosslessString::from_utf16(vec![0xdfff])))
    );
    assert!(
        snapshot
            .scan::<resources::KvTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap()
            .iter()
            .any(|row| row.key.as_str() == Some("invalid-json")
                && row.value.value() == &JsonValue::String("�".into()))
    );
    assert!(
        snapshot
            .scan::<artifacts::MigrationTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap()
            .iter()
            .any(|row| row.id.as_str() == Some("�"))
    );
    assert!(
        snapshot
            .scan::<artifacts::MigrationTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap()
            .iter()
            .any(|row| row.id.as_str() == Some("�a�"))
    );
    assert!(
        snapshot
            .scan::<artifacts::MigrationTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap()
            .iter()
            .any(|row| row.id.as_str() == Some("���"))
    );
    let Some(JsonValue::Number(zero)) = value.get(&"zero".into()) else {
        panic!("expected number")
    };
    assert_eq!(zero.to_bits(), (-0.0f64).to_bits());
    let blobs = snapshot
        .scan::<session::InstructionBlobTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap();
    assert!(
        blobs
            .iter()
            .any(|r| r.hash.as_str() == Some("null") && r.value.is_none())
    );
    assert!(blobs.iter().any(|r| r.hash.as_str() == Some("json-null")
        && r.value.as_ref().unwrap().value() == &JsonValue::Null));
    let permission = snapshot
        .scan::<project::PermissionTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap()
        .pop()
        .unwrap();
    let index = &project::PermissionTable::INDEXES[0];
    assert_eq!(
        snapshot
            .index::<project::PermissionTable>(
                index.name,
                &project::PermissionTable::index_key(index, &permission)
                    .unwrap()
                    .unwrap(),
                None,
                10
            )
            .unwrap(),
        vec![permission]
    );
    assert_eq!(
        snapshot
            .scan::<import::ProvenanceTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap(),
        vec![report.clone()]
    );
    assert_eq!(report.source_fingerprint.len(), 64);
    let credential = snapshot
        .scan::<resources::CredentialTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(credential.active, Some(99));
    assert_eq!(credential.value.value(),&ycoding_schema::parse_json(r#"{"type":"key","key":"synthetic-test-only","metadata":{"\ud800":-0},"extra":"retained"}"#).unwrap());
    assert!(!format!("{:?}", credential).contains("synthetic-test-only"));
}

#[test]
fn bootstrap_round_trip_keeps_only_its_two_source_tables() {
    let fixture = Fixture::new();
    drop(fixture.create(DatabaseKind::Bootstrap));
    let source = fixture.source();
    let candidate = fixture.candidate();
    let report = import::stage(
        fixture.request(DatabaseKind::Bootstrap, &source, &candidate),
        |_| ControlFlow::Continue(()),
    )
    .unwrap();
    assert_eq!(
        report
            .tables
            .iter()
            .map(|t| (t.name.as_str(), t.rows))
            .collect::<Vec<_>>(),
        vec![("migration", 1), ("database_format", 1)]
    );
    let store = Store::open(
        &candidate,
        Options::core(),
        import::catalog(DatabaseKind::Bootstrap),
    )
    .unwrap();
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<artifacts::MigrationTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap()[0]
            .time_completed,
        i64::MIN
    );
}

#[test]
fn existing_candidate_is_refused_without_touching_it() {
    let fixture = Fixture::new();
    drop(fixture.create(DatabaseKind::Bootstrap));
    let source = fixture.source();
    let candidate = fixture.candidate();
    std::fs::write(&candidate, b"unrelated existing file").unwrap();
    assert!(
        import::stage(
            fixture.request(DatabaseKind::Bootstrap, &source, &candidate),
            |_| ControlFlow::Continue(())
        )
        .is_err()
    );
    assert_eq!(
        std::fs::read(&candidate).unwrap(),
        b"unrelated existing file"
    );
}

#[test]
fn rejected_checks_and_foreign_keys_name_the_source_row_without_sealing_candidate() {
    for (sql, table, reason) in [
        (
            "INSERT INTO credential (id,label,value,generation,account_generation,time_created,time_updated) VALUES ('c','synthetic','{\"type\":\"key\",\"key\":\"synthetic-test-only\"}',-1,0,0,0)",
            "credential",
            "credential_generation_check",
        ),
        (
            "INSERT INTO permission VALUES ('rule','absent','read','*',0,0)",
            "permission",
            "foreign_reference",
        ),
    ] {
        let fixture = Fixture::new();
        let db = fixture.create(DatabaseKind::Core);
        db.execute_batch("PRAGMA ignore_check_constraints=ON; PRAGMA foreign_keys=OFF;")
            .unwrap();
        db.execute_batch(sql).unwrap();
        drop(db);
        let source = fixture.source();
        let candidate = fixture.candidate();
        let error = import::stage(
            fixture.request(DatabaseKind::Core, &source, &candidate),
            |_| ControlFlow::Continue(()),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains(table), "{error}");
        assert!(error.contains(reason), "{error}");
        assert!(error.contains("row 1"), "{error}");
        assert!(import::sealed(&candidate, DatabaseKind::Core).is_err());
        assert!(!error.contains("synthetic-test-only"));
    }
}

#[test]
fn unrepresentable_numeric_and_null_types_fail_closed_without_coercion() {
    for (sql, column, reason) in [
        (
            "INSERT INTO data_migration VALUES ('fractional',1.5)",
            "time_completed",
            "real",
        ),
        ("INSERT INTO data_migration VALUES (NULL,1)", "name", "null"),
    ] {
        let fixture = Fixture::new();
        let db = fixture.create(DatabaseKind::Core);
        db.execute_batch(sql).unwrap();
        drop(db);
        let source = fixture.source();
        let candidate = fixture.candidate();
        let before = std::fs::read(&source).unwrap();
        let error = import::stage(
            fixture.request(DatabaseKind::Core, &source, &candidate),
            |_| ControlFlow::Continue(()),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("data_migration"), "{error}");
        assert!(error.contains(column), "{error}");
        assert!(error.contains(reason), "{error}");
        assert!(import::sealed(&candidate, DatabaseKind::Core).is_err());
        assert_eq!(before, std::fs::read(&source).unwrap());
    }
}

#[test]
fn deleted_sqlite_autoincrement_high_water_is_seeded_before_new_insert() {
    let fixture = Fixture::new();
    let db = fixture.create(DatabaseKind::Core);
    db.execute_batch("INSERT INTO sqlite_sequence VALUES ('web_latency',9000)")
        .unwrap();
    drop(db);
    let source = fixture.source();
    let candidate = fixture.candidate();
    let report = import::stage(
        fixture.request(DatabaseKind::Core, &source, &candidate),
        |_| ControlFlow::Continue(()),
    )
    .unwrap();
    assert_eq!(report.latency_high_water, Some(9000));
    let store = Store::open(
        &candidate,
        Options::core(),
        import::catalog(DatabaseKind::Core),
    )
    .unwrap();
    let sequence = store
        .snapshot()
        .unwrap()
        .scan::<resources::SequenceTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap();
    assert_eq!(sequence[0].high_water, 9000);
    store
        .submit(|tx| resources::seed_latency_sequence(tx, 1))
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<resources::SequenceTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap()[0]
            .high_water,
        9000
    );
    let sample = session::Document::new(
        ycoding_schema::parse_json(
            r#"{"kind":"long-task","at":"2026-10-11T00:00:00.000Z","durationMs":50}"#,
        )
        .unwrap(),
    )
    .unwrap();
    let row = store
        .submit(move |tx| resources::append_latency(tx, 0, &sample))
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(row.id, 9001);
}

#[test]
fn interruption_at_each_owned_boundary_preserves_and_resumes_candidate() {
    for phase in [
        Progress::Created,
        Progress::Loaded("migration"),
        Progress::Validating,
        Progress::Verifying,
        Progress::Verified("migration"),
        Progress::Complete,
    ] {
        let fixture = Fixture::new();
        drop(fixture.create(DatabaseKind::Bootstrap));
        let source = fixture.source();
        let candidate = fixture.candidate();
        assert!(matches!(
            import::stage(
                fixture.request(DatabaseKind::Bootstrap, &source, &candidate),
                |p| if p == phase {
                    ControlFlow::Break(())
                } else {
                    ControlFlow::Continue(())
                }
            ),
            Err(import::Error::Cancelled)
        ));
        assert!(candidate.exists());
        let report = import::stage(
            fixture.request(DatabaseKind::Bootstrap, &source, &candidate),
            |_| ControlFlow::Continue(()),
        )
        .unwrap();
        assert_eq!(
            report
                .tables
                .iter()
                .map(|table| table.rows)
                .collect::<Vec<_>>(),
            [1, 1]
        );
        assert_eq!(
            import::sealed(&candidate, DatabaseKind::Bootstrap)
                .unwrap()
                .1,
            report
        );
    }
}

#[test]
fn reopen_verification_detects_changed_record_without_sealing_candidate() {
    let fixture = Fixture::new();
    drop(fixture.create(DatabaseKind::Bootstrap));
    let source = fixture.source();
    let candidate = fixture.candidate();
    let error = import::stage(
        fixture.request(DatabaseKind::Bootstrap, &source, &candidate),
        |p| {
            if p == Progress::Verifying {
                let store = Store::open(
                    &candidate,
                    Options::core(),
                    import::catalog(DatabaseKind::Bootstrap),
                )
                .unwrap();
                store
                    .submit(|tx| {
                        artifacts::MigrationTable::put(
                            tx,
                            &artifacts::Migration {
                                id: "baseline".into(),
                                time_completed: 0,
                            },
                        )
                    })
                    .unwrap()
                    .wait()
                    .unwrap();
            }
            ControlFlow::Continue(())
        },
    )
    .unwrap_err();
    assert!(error.to_string().contains("digest"));
    assert!(import::sealed(&candidate, DatabaseKind::Bootstrap).is_err());
}

#[test]
fn artifact_cycles_and_large_index_groups_are_checked_in_the_complete_write_view() {
    let fixture = Fixture::new();
    let db = fixture.create(DatabaseKind::Core);
    db.execute_batch(rows()).unwrap();
    db.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
    db.execute_batch("INSERT INTO session (id,project_id,directory,title,time_created,time_updated) VALUES ('ses-one','p','/synthetic','fixture',0,1);
        INSERT INTO project_artifact_scope VALUES ('pas_test','project','12345678-1234-1234-1234-123456789abc',0,1);
        INSERT INTO project_artifact_project_scope (scope_id,project_id) VALUES ('pas_test','p');
        INSERT INTO project_artifact (scope_id,kind,artifact_id,revision,stage,current_version_id,time_created,time_updated) VALUES ('pas_test','skill','test',0,'active','pav_test',0,1);
        INSERT INTO project_artifact_version (id,scope_id,kind,artifact_id,state,content_digest,content_relpath,source,time_created,time_state_changed) VALUES ('pav_test','pas_test','skill','test','active','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','versions/test.md','user',0,1);").unwrap();
    for position in 0..130 {
        db.execute(
            "INSERT INTO session_todo VALUES ('ses-one','content','pending','high',?1,0,1)",
            [position - 65],
        )
        .unwrap();
    }
    assert!(
        db.prepare("PRAGMA foreign_key_check")
            .unwrap()
            .query([])
            .unwrap()
            .next()
            .unwrap()
            .is_none()
    );
    drop(db);
    let source = fixture.source();
    let candidate = fixture.candidate();
    let report = import::stage(
        fixture.request(DatabaseKind::Core, &source, &candidate),
        |_| ControlFlow::Continue(()),
    )
    .unwrap();
    assert_eq!(
        report
            .tables
            .iter()
            .find(|t| t.name == "session_todo")
            .unwrap()
            .rows,
        130
    );
    let store = Store::open(
        &candidate,
        Options::core(),
        import::catalog(DatabaseKind::Core),
    )
    .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert_eq!(
        snapshot
            .scan::<artifacts::VersionTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap()[0]
            .id
            .as_str(),
        Some("pav_test")
    );
    let key = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&"ses-one".into())]);
    let todos = snapshot
        .index::<session::TodoTable>("session_todo_session_idx", &key, None, 200)
        .unwrap();
    assert_eq!(todos.len(), 130);
    assert_eq!(todos.first().unwrap().position, -65);
    assert_eq!(todos.last().unwrap().position, 64);
}

#[test]
fn unsupported_inventory_format_and_uncheckpointed_wal_are_refused() {
    for sql in [
        "CREATE TABLE unowned (id INTEGER)",
        "UPDATE database_format SET id='too-new'",
        "ALTER TABLE migration ADD COLUMN unowned TEXT",
    ] {
        let fixture = Fixture::new();
        let db = fixture.create(DatabaseKind::Bootstrap);
        db.execute_batch(sql).unwrap();
        drop(db);
        let source = fixture.source();
        let candidate = fixture.candidate();
        let bytes = std::fs::read(&source).unwrap();
        assert!(
            import::stage(
                fixture.request(DatabaseKind::Bootstrap, &source, &candidate),
                |_| ControlFlow::Continue(())
            )
            .is_err()
        );
        assert!(!candidate.exists());
        assert_eq!(bytes, std::fs::read(&source).unwrap());
    }
    let fixture = Fixture::new();
    drop(fixture.create(DatabaseKind::Bootstrap));
    let source = fixture.source();
    let candidate = fixture.candidate();
    std::fs::write(
        source.with_extension("sqlite-wal"),
        b"uncheckpointed synthetic WAL",
    )
    .unwrap();
    assert!(
        import::stage(
            fixture.request(DatabaseKind::Bootstrap, &source, &candidate),
            |_| ControlFlow::Continue(())
        )
        .unwrap_err()
        .to_string()
        .contains("WAL")
    );
    assert!(!candidate.exists());
}

#[test]
fn panicking_progress_is_reported_and_owned_candidate_can_resume() {
    let fixture = Fixture::new();
    drop(fixture.create(DatabaseKind::Bootstrap));
    let source = fixture.source();
    let candidate = fixture.candidate();
    assert!(matches!(
        import::stage(
            fixture.request(DatabaseKind::Bootstrap, &source, &candidate),
            |p| {
                if p == Progress::Created {
                    panic!("synthetic interrupt");
                }
                ControlFlow::Continue(())
            }
        ),
        Err(import::Error::Interrupted)
    ));
    assert!(candidate.exists());
    import::stage(
        fixture.request(DatabaseKind::Bootstrap, &source, &candidate),
        |_| ControlFlow::Continue(()),
    )
    .unwrap();
    assert!(import::sealed(&candidate, DatabaseKind::Bootstrap).is_ok());
}

#[test]
fn sql_real_edges_preserve_infinity_without_narrowing_the_record_codec() {
    let fixture = Fixture::new();
    let db = fixture.create(DatabaseKind::Core);
    db.execute_batch(rows()).unwrap();
    db.execute_batch("INSERT INTO session (id,project_id,directory,title,cost,time_created,time_updated) VALUES ('ses-infinite','p','/synthetic','fixture',1e999,0,1)").unwrap();
    drop(db);
    let source = fixture.source();
    let candidate = fixture.candidate();
    import::stage(
        fixture.request(DatabaseKind::Core, &source, &candidate),
        |_| ControlFlow::Continue(()),
    )
    .unwrap();
    let store = Store::open(
        &candidate,
        Options::core(),
        import::catalog(DatabaseKind::Core),
    )
    .unwrap();
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<session::SessionTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap()[0]
            .cost
            .to_bits(),
        f64::INFINITY.to_bits()
    );
}

#[test]
fn sqlite_file_encoding_edges_fail_closed_before_transcoding_text() {
    let fixture = Fixture::new();
    let db = Connection::open(fixture.source()).unwrap();
    db.execute_batch(
        "PRAGMA encoding='UTF-16le';
        CREATE TABLE migration (id TEXT PRIMARY KEY,time_completed INTEGER NOT NULL);
        CREATE TABLE database_format (id TEXT PRIMARY KEY,time_created INTEGER NOT NULL);
        INSERT INTO database_format VALUES ('current-2026-08-04',0);",
    )
    .unwrap();
    drop(db);
    let source = fixture.source();
    let candidate = fixture.candidate();
    let before = std::fs::read(&source).unwrap();
    let result = import::stage(
        fixture.request(DatabaseKind::Bootstrap, &source, &candidate),
        |_| ControlFlow::Continue(()),
    );
    assert!(
        result.is_err(),
        "UTF-16 source must not be implicitly transcoded"
    );
    assert!(result.unwrap_err().to_string().contains("encoding"));
    assert!(!candidate.exists());
    assert_eq!(before, std::fs::read(&source).unwrap());
}

#[test]
fn missing_reopened_index_membership_is_detected_against_source() {
    let fixture = Fixture::new();
    let db = fixture.create(DatabaseKind::Core);
    db.execute_batch(rows()).unwrap();
    drop(db);
    let source = fixture.source();
    let candidate = fixture.candidate();
    let result = import::stage(
        fixture.request(DatabaseKind::Core, &source, &candidate),
        |phase| {
            if phase == Progress::Verifying {
                let db = redb::Database::open(&candidate).unwrap();
                let tx = db.begin_write().unwrap();
                {
                    let mut index = tx
                        .open_table(redb::TableDefinition::<&[u8], &[u8]>::new(
                            "permission_project_action_resource_idx",
                        ))
                        .unwrap();
                    let key = ycoding_store::tuple_key(&[
                        ycoding_store::KeyPart::String(&"p".into()),
                        ycoding_store::KeyPart::String(&"read".into()),
                        ycoding_store::KeyPart::String(&"*".into()),
                    ]);
                    assert!(index.remove(key.as_slice()).unwrap().is_some());
                }
                tx.commit().unwrap();
            }
            ControlFlow::Continue(())
        },
    );
    assert!(result.unwrap_err().to_string().contains("index membership"));
    assert!(import::sealed(&candidate, DatabaseKind::Core).is_err());
}

#[test]
fn changed_source_fingerprint_after_verification_rejects_candidate_resume() {
    let fixture = Fixture::new();
    drop(fixture.create(DatabaseKind::Bootstrap));
    let source = fixture.source();
    let candidate = fixture.candidate();
    let result = import::stage(
        fixture.request(DatabaseKind::Bootstrap, &source, &candidate),
        |phase| {
            if phase == Progress::Verified("database_format") {
                Connection::open(&source)
                    .unwrap()
                    .execute("UPDATE migration SET time_completed=5", [])
                    .unwrap();
            }
            ControlFlow::Continue(())
        },
    );
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("source fingerprint changed")
    );
    assert!(candidate.exists());
    assert!(matches!(
        import::stage(
            fixture.request(DatabaseKind::Bootstrap, &source, &candidate),
            |_| ControlFlow::Continue(())
        ),
        Err(import::Error::SourceChanged)
    ));
    assert!(import::sealed(&candidate, DatabaseKind::Bootstrap).is_err());
}

#[test]
fn table_checkpoint_resume_preserves_multi_batch_rows_and_publishes_provenance_after_verification()
{
    for count in [0, 1, 127, 128, 129, 257] {
        let fixture = Fixture::new();
        let db = fixture.create(DatabaseKind::Core);
        db.execute_batch(rows()).unwrap();
        for row in 0..count {
            db.execute(
                "INSERT INTO migration VALUES (?1,?2)",
                (format!("synthetic-{row:04}"), row),
            )
            .unwrap();
        }
        drop(db);
        let source = fixture.source();
        let candidate = fixture.candidate();
        let before = std::fs::read(&source).unwrap();
        let result = import::stage(
            fixture.request(DatabaseKind::Core, &source, &candidate),
            |phase| {
                if matches!(
                    phase,
                    Progress::Rows {
                        table: "migration",
                        rows: 128
                    }
                ) || phase == Progress::Loaded("migration")
                {
                    return ControlFlow::Break(());
                }
                ControlFlow::Continue(())
            },
        );
        assert!(matches!(result, Err(import::Error::Cancelled)));
        let report = import::stage(
            fixture.request(DatabaseKind::Core, &source, &candidate),
            |phase| {
                if phase == Progress::Verifying {
                    let store = Store::open(
                        &candidate,
                        Options::core(),
                        import::catalog(DatabaseKind::Core),
                    )
                    .unwrap();
                    let snapshot = store.snapshot().unwrap();
                    assert!(
                        snapshot
                            .get::<import::ProvenanceTable>(&[])
                            .unwrap()
                            .is_none()
                    );
                    drop(snapshot);
                    store.shutdown().unwrap();
                }
                ControlFlow::Continue(())
            },
        )
        .unwrap();
        assert_eq!(
            report
                .tables
                .iter()
                .find(|table| table.name == "migration")
                .unwrap()
                .rows,
            count + 4
        );
        assert_eq!(
            import::sealed(&candidate, DatabaseKind::Core).unwrap().1,
            report
        );
        assert_eq!(std::fs::read(source).unwrap(), before);
    }
}

#[test]
fn malformed_checkpoint_and_wrong_identity_are_refused_without_replacing_candidate() {
    let fixture = Fixture::new();
    drop(fixture.create(DatabaseKind::Bootstrap));
    let source = fixture.source();
    let candidate = fixture.candidate();
    assert!(matches!(
        import::stage(
            fixture.request(DatabaseKind::Bootstrap, &source, &candidate),
            |_| ControlFlow::Break(())
        ),
        Err(import::Error::Cancelled)
    ));
    let before = std::fs::read(&candidate).unwrap();
    let mut request = fixture.request(DatabaseKind::Bootstrap, &source, &candidate);
    request.metadata = Metadata::new([8; 16], 1);
    assert!(matches!(
        import::stage(request, |_| ControlFlow::Continue(())),
        Err(import::Error::Checkpoint(_))
    ));
    std::fs::write(
        candidate.with_file_name("candidate.redb.import-v1"),
        b"unknown checkpoint",
    )
    .unwrap();
    assert!(matches!(
        import::stage(
            fixture.request(DatabaseKind::Bootstrap, &source, &candidate),
            |_| ControlFlow::Continue(())
        ),
        Err(import::Error::Checkpoint(_))
    ));
    assert_eq!(std::fs::read(candidate).unwrap(), before);
}

#[test]
fn missing_checkpoint_candidate_is_refused_without_creating_an_empty_replacement() {
    let fixture = Fixture::new();
    drop(fixture.create(DatabaseKind::Bootstrap));
    let source = fixture.source();
    let candidate = fixture.candidate();
    assert!(matches!(
        import::stage(
            fixture.request(DatabaseKind::Bootstrap, &source, &candidate),
            |phase| if phase == Progress::Loaded("migration") {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }
        ),
        Err(import::Error::Cancelled)
    ));
    std::fs::remove_file(&candidate).unwrap();
    assert!(matches!(
        import::stage(
            fixture.request(DatabaseKind::Bootstrap, &source, &candidate),
            |_| ControlFlow::Continue(())
        ),
        Err(import::Error::Checkpoint("checkpoint candidate is missing"))
    ));
    assert!(!candidate.exists());
}

#[test]
fn interrupted_import_child() {
    let Ok(root) = std::env::var("YCODING_IMPORT_CHILD_ROOT") else {
        return;
    };
    let fixture = Fixture(PathBuf::from(root));
    let phase = std::env::var("YCODING_IMPORT_CHILD_PHASE").unwrap();
    import::stage(
        fixture.request(
            DatabaseKind::Bootstrap,
            &fixture.source(),
            &fixture.candidate(),
        ),
        |current| {
            if format!("{current:?}") == phase {
                use std::io::{Read, Write};
                println!("IMPORT-CHECKPOINT");
                std::io::stdout().flush().unwrap();
                std::io::stdin().read_exact(&mut [0]).unwrap();
            }
            ControlFlow::Continue(())
        },
    )
    .unwrap();
}

#[test]
fn hard_process_death_at_import_checkpoints_resumes_without_duplicate_records() {
    for phase in [
        "Created",
        "Rows { table: \"migration\", rows: 128 }",
        "Loaded(\"migration\")",
        "Validating",
        "Verifying",
        "Verified(\"migration\")",
        "Complete",
    ] {
        let fixture = Fixture::new();
        let db = fixture.create(DatabaseKind::Bootstrap);
        for row in 0..257 {
            db.execute(
                "INSERT INTO migration VALUES (?1,?2)",
                (format!("synthetic-{row}"), row),
            )
            .unwrap();
        }
        drop(db);
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "interrupted_import_child", "--nocapture"])
            .env("YCODING_IMPORT_CHILD_ROOT", &fixture.0)
            .env("YCODING_IMPORT_CHILD_PHASE", phase)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stdout).lines() {
                if line.unwrap() == "IMPORT-CHECKPOINT" {
                    sender.send(()).unwrap();
                    break;
                }
            }
        });
        let ready = receiver.recv_timeout(std::time::Duration::from_secs(30));
        child.kill().unwrap();
        child.wait().unwrap();
        reader.join().unwrap();
        ready.unwrap();
        let report = import::stage(
            fixture.request(
                DatabaseKind::Bootstrap,
                &fixture.source(),
                &fixture.candidate(),
            ),
            |_| ControlFlow::Continue(()),
        )
        .unwrap();
        assert_eq!(report.tables[0].rows, 258);
        assert!(import::sealed(&fixture.candidate(), DatabaseKind::Bootstrap).is_ok());
    }
}
