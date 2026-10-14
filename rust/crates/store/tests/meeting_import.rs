#[path = "meeting_fixture.rs"]
mod fixture;

use rusqlite::Connection;
use std::ops::ControlFlow;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use ycoding_schema::{JsonValue, parse_json};
use ycoding_store::import::{self, DatabaseKind, Progress, Request};
use ycoding_store::{Metadata, meeting};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ycoding-meeting-import-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn source(&self) -> PathBuf {
        self.0.join("meetings.sqlite")
    }
    fn candidate(&self) -> PathBuf {
        self.0.join("private/meetings.redb")
    }
    fn import(&self) -> Result<import::Report, import::Error> {
        import::stage(
            Request {
                source: &self.source(),
                candidate: &self.candidate(),
                kind: DatabaseKind::Meeting,
                metadata: Metadata::new([7; 16], 4),
            },
            |_| ControlFlow::Continue(()),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn literal_sqlite_generator_is_byte_identical_and_import_preserves_all_reopened_documents_indexes_and_provenance()
 {
    let test = Fixture::new();
    fixture::generate(&test.source());
    let second = test.0.join("second.sqlite");
    fixture::generate(&second);
    let before = std::fs::read(test.source()).unwrap();
    assert_eq!(before, std::fs::read(second).unwrap());
    let report = test.import().unwrap();
    assert_eq!(std::fs::read(test.source()).unwrap(), before);
    assert_eq!(report.source_bytes, before.len() as i64);
    assert_eq!(report.tables.len(), 9);
    assert!(
        report
            .tables
            .iter()
            .all(|table| table.rows == 1 && table.digest.len() == 64)
    );
    assert_eq!(report.importer_version, 1);
    assert!(fixture::MEETING.contains(fixture::NOW));
    assert_eq!(report.latency_high_water, None);
    let store = meeting::open(test.candidate()).unwrap();
    let snapshot = store.snapshot().unwrap();
    assert_eq!(store.metadata(), &Metadata::new([7; 16], 4));
    assert_eq!(
        snapshot.get::<import::ProvenanceTable>(&[]).unwrap(),
        Some(report.clone())
    );
    assert_eq!(
        meeting::get_meeting(&snapshot, &"m".into()).unwrap(),
        Some(parse_json(fixture::MEETING).unwrap())
    );
    assert_eq!(
        meeting::segments(&snapshot, &"m".into(), -1, 1).unwrap(),
        vec![parse_json(fixture::SEGMENT).unwrap()]
    );
    assert_eq!(meeting::next_sequence(&snapshot, &"m".into()).unwrap(), 2);
    assert_eq!(
        meeting::findings(&snapshot, &"m".into()).unwrap(),
        vec![parse_json(fixture::FINDING).unwrap()]
    );
    assert_eq!(
        meeting::checkpoints(&snapshot, &"m".into()).unwrap(),
        vec![parse_json(fixture::CHECKPOINT).unwrap()]
    );
    assert_eq!(
        meeting::proposals(&snapshot, &"m".into()).unwrap(),
        vec![parse_json(fixture::PROPOSAL).unwrap()]
    );
    assert_eq!(
        meeting::plan(&snapshot, &"m".into()).unwrap(),
        Some(parse_json(fixture::PLAN).unwrap())
    );
    assert_eq!(
        meeting::approvals(&snapshot, &"m".into()).unwrap(),
        vec![parse_json(fixture::APPROVAL).unwrap()]
    );
    assert_eq!(
        meeting::jobs(&snapshot, &"m".into()).unwrap(),
        vec![parse_json(fixture::JOB).unwrap()]
    );
    assert_eq!(
        meeting::references(&snapshot, &"m".into()).unwrap(),
        vec![parse_json(fixture::REFERENCE).unwrap()]
    );
    drop(snapshot);
    store.shutdown().unwrap();
    assert_eq!(test.import().unwrap(), report);
    assert_eq!(
        import::sealed(&test.candidate(), DatabaseKind::Meeting).unwrap(),
        (Metadata::new([7; 16], 4), report)
    );
    assert_eq!(std::fs::read(test.source()).unwrap(), before);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(test.candidate())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(test.candidate().parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}

#[test]
fn import_preserves_rowid_order_original_corrections_and_bounded_multi_page_indexes() {
    let test = Fixture::new();
    fixture::generate(&test.source());
    let db = Connection::open(test.source()).unwrap();
    db.execute(
        "INSERT INTO findings(rowid,id,meeting_id,data) VALUES (99,'a','m',?1)",
        [fixture::FINDING.replace("\"z\"", "\"a\"")],
    )
    .unwrap();
    db.execute(
        "UPDATE segments SET data=json_set(data,'$.text','Corrected')",
        [],
    )
    .unwrap();
    for sequence in 2..=260 {
        let data = fixture::SEGMENT
            .replace("\"s\"", &format!("\"s-{sequence:03}\""))
            .replace("\"sequence\":1", &format!("\"sequence\":{sequence}"));
        db.execute(
            "INSERT INTO segments VALUES (?1,'m',?2,'final','สวัสดี',?3)",
            rusqlite::params![format!("s-{sequence:03}"), sequence, data],
        )
        .unwrap();
    }
    drop(db);
    test.import().unwrap();
    let store = meeting::open(test.candidate()).unwrap();
    store
        .submit(|tx| meeting::put_segment(tx, &parse_json(fixture::SEGMENT).unwrap()))
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert_eq!(
        meeting::segments(&snapshot, &"m".into(), 128, 100)
            .unwrap()
            .len(),
        100
    );
    assert_eq!(meeting::next_sequence(&snapshot, &"m".into()).unwrap(), 261);
    let findings = meeting::findings(&snapshot, &"m".into()).unwrap();
    let JsonValue::Object(first) = &findings[0] else {
        panic!()
    };
    assert_eq!(
        first.get(&"id".into()),
        Some(&JsonValue::String("z".into()))
    );
    let JsonValue::Object(segment) = &meeting::segments(&snapshot, &"m".into(), -1, 1).unwrap()[0]
    else {
        panic!()
    };
    assert_eq!(
        segment.get(&"text".into()),
        Some(&JsonValue::String("Corrected".into()))
    );
}

#[test]
fn importer_rejects_invalid_documents_identity_types_references_and_versions_without_source_writes()
{
    for sql in [
        "PRAGMA ignore_check_constraints=ON; UPDATE meetings SET data='not json'",
        "UPDATE segments SET data='{\"id\":\"s\",\"meetingID\":\"m\"}'",
        "UPDATE segments SET sequence=1.5",
        "UPDATE segments SET meeting_id='missing'",
        "UPDATE segments SET state='temporary'",
        "UPDATE knowledge_references SET target='other'",
        "UPDATE plans SET id='wrong'",
        "UPDATE findings SET data=json_set(data,'$.confidence',2)",
        "UPDATE meetings SET data=json_set(data,'$.updatedAt','2026-02-30T00:00:00Z')",
        "UPDATE meetings SET data=json_set(data,'$.unexpected',1)",
        "UPDATE meetings SET data=CAST(X'FF' AS TEXT)",
        "PRAGMA user_version=99",
        "PRAGMA user_version=0",
        "CREATE TABLE session(id TEXT)",
        "ALTER TABLE jobs ADD COLUMN unrelated TEXT",
    ] {
        let test = Fixture::new();
        fixture::generate(&test.source());
        let db = Connection::open(test.source()).unwrap();
        db.execute_batch("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON")
            .unwrap();
        db.execute_batch(sql).unwrap();
        drop(db);
        let before = std::fs::read(test.source()).unwrap();
        assert!(test.import().is_err(), "accepted {sql}");
        assert!(import::sealed(&test.candidate(), DatabaseKind::Meeting).is_err());
        assert_eq!(std::fs::read(test.source()).unwrap(), before);
    }
}

#[test]
fn import_cancellation_panic_offline_wal_and_reopened_corruption_fail_closed() {
    for phase in [
        Progress::Created,
        Progress::Loaded("meetings"),
        Progress::Validating,
        Progress::Verifying,
        Progress::Complete,
    ] {
        let test = Fixture::new();
        fixture::generate(&test.source());
        let before = std::fs::read(test.source()).unwrap();
        let result = import::stage(
            Request {
                source: &test.source(),
                candidate: &test.candidate(),
                kind: DatabaseKind::Meeting,
                metadata: Metadata::new([7; 16], 4),
            },
            |current| {
                if current == phase {
                    ControlFlow::Break(())
                } else {
                    ControlFlow::Continue(())
                }
            },
        );
        assert!(matches!(result, Err(import::Error::Cancelled)));
        assert!(test.candidate().exists());
        assert_eq!(test.import().unwrap().tables.len(), 9);
        assert_eq!(std::fs::read(test.source()).unwrap(), before);
    }
    let test = Fixture::new();
    fixture::generate(&test.source());
    let result = import::stage(
        Request {
            source: &test.source(),
            candidate: &test.candidate(),
            kind: DatabaseKind::Meeting,
            metadata: Metadata::new([7; 16], 4),
        },
        |_| panic!("synthetic callback panic"),
    );
    assert!(matches!(result, Err(import::Error::Interrupted)));
    assert!(test.candidate().exists());
    std::fs::write(
        test.0.join("meetings.sqlite-wal"),
        b"synthetic-uncheckpointed",
    )
    .unwrap();
    assert!(test.import().is_err());
    std::fs::remove_file(test.0.join("meetings.sqlite-wal")).unwrap();
    let result = import::stage(
        Request {
            source: &test.source(),
            candidate: &test.candidate(),
            kind: DatabaseKind::Meeting,
            metadata: Metadata::new([7; 16], 4),
        },
        |current| {
            if current == Progress::Verifying {
                let db = redb::Database::open(test.candidate()).unwrap();
                let tx = db.begin_write().unwrap();
                {
                    let mut table = tx
                        .open_table(redb::TableDefinition::<&[u8], &[u8]>::new(
                            "findings_meeting",
                        ))
                        .unwrap();
                    table.retain(|_, _| false).unwrap();
                }
                tx.commit().unwrap();
            }
            ControlFlow::Continue(())
        },
    );
    assert!(matches!(
        result,
        Err(import::Error::Verification {
            table: "findings",
            ..
        })
    ));
    assert!(import::sealed(&test.candidate(), DatabaseKind::Meeting).is_err());
}

#[test]
fn meeting_source_cannot_cross_core_or_bootstrap_import_authority() {
    let test = Fixture::new();
    fixture::generate(&test.source());
    let before = std::fs::read(test.source()).unwrap();
    for kind in [DatabaseKind::Core, DatabaseKind::Bootstrap] {
        let result = import::stage(
            Request {
                source: &test.source(),
                candidate: &test.candidate(),
                kind,
                metadata: Metadata::new([7; 16], 4),
            },
            |_| ControlFlow::Continue(()),
        );
        assert!(matches!(result, Err(import::Error::Source(_))));
        assert!(!test.candidate().exists());
        assert_eq!(std::fs::read(test.source()).unwrap(), before);
    }
}

#[test]
fn maximum_imported_rowid_allows_a_new_record_without_replacing_or_reordering_existing_rows() {
    let test = Fixture::new();
    fixture::generate(&test.source());
    let db = Connection::open(test.source()).unwrap();
    db.execute("UPDATE findings SET rowid=9223372036854775807", [])
        .unwrap();
    db.execute_batch("BEGIN").unwrap();
    let data = fixture::FINDING.replace("\"z\"", "\"new\"");
    db.execute(
        "INSERT INTO findings(id,meeting_id,data) VALUES ('new','m',?1)",
        [&data],
    )
    .unwrap();
    let position: i64 = db
        .query_row("SELECT rowid FROM findings WHERE id='new'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!((1..i64::MAX).contains(&position));
    db.execute_batch("ROLLBACK").unwrap();
    drop(db);
    test.import().unwrap();
    let store = meeting::open(test.candidate()).unwrap();
    store
        .submit(move |tx| meeting::put_finding(tx, &parse_json(&data).unwrap()))
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    let findings = meeting::findings(&snapshot, &"m".into()).unwrap();
    assert_eq!(findings.len(), 2);
    let JsonValue::Object(first) = &findings[0] else {
        panic!()
    };
    let JsonValue::Object(last) = &findings[1] else {
        panic!()
    };
    assert_eq!(
        first.get(&"id".into()),
        Some(&JsonValue::String("new".into()))
    );
    assert_eq!(last.get(&"id".into()), Some(&JsonValue::String("z".into())));
}
