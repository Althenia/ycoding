use super::{Checkpoint, MAGIC, path};
use crate::import::{self, DatabaseKind, Error, Progress, ProvenanceTable, Report, Request};
use crate::session::codec::Field;
use crate::{Metadata, TableSpec};
use rusqlite::Connection;
use std::ops::ControlFlow;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use ycoding_schema::LosslessString;

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ycoding-checkpoint-version-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn previous_provenance(report: &Report) -> Vec<u8> {
    let mut bytes = vec![1];
    Field::encode(
        &LosslessString::from(report.source_fingerprint.clone()),
        &mut bytes,
    )
    .unwrap();
    Field::encode(&report.source_bytes, &mut bytes).unwrap();
    Field::encode(&1i64, &mut bytes).unwrap();
    Field::encode(&(report.tables.len() as i64), &mut bytes).unwrap();
    for table in &report.tables {
        Field::encode(&LosslessString::from(table.name.clone()), &mut bytes).unwrap();
        Field::encode(&table.rows, &mut bytes).unwrap();
        Field::encode(&LosslessString::from(table.digest.clone()), &mut bytes).unwrap();
    }
    Field::encode(&report.latency_high_water, &mut bytes).unwrap();
    bytes
}

#[test]
fn a_checkpoint_written_by_the_previous_importer_version_is_refused_without_changing_anything() {
    let directory = Directory::new();
    let source = directory.0.join("source.sqlite");
    Connection::open(&source)
        .unwrap()
        .execute_batch(
            "CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
            CREATE TABLE database_format (id TEXT PRIMARY KEY, time_created INTEGER NOT NULL);
            INSERT INTO migration VALUES ('baseline', -9223372036854775808);
            INSERT INTO database_format VALUES ('current-2026-08-04', 9223372036854775807);",
        )
        .unwrap();
    let candidate = directory.0.join("candidate.redb");
    let request = || Request {
        source: &source,
        candidate: &candidate,
        kind: DatabaseKind::Bootstrap,
        metadata: Metadata::new([7; 16], 1),
    };
    assert!(matches!(
        import::stage(request(), |phase| if phase == Progress::Created {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }),
        Err(Error::Cancelled)
    ));
    let checkpoint = path(&candidate);
    let current = std::fs::read(&checkpoint).unwrap();
    let header = MAGIC.len()
        + 1
        + 16
        + 8
        + 8
        + import::catalog(DatabaseKind::Bootstrap).manifest().len()
        + 8
        + 1;
    let report = ProvenanceTable::decode(&current[header..]).unwrap();
    assert_eq!(report.importer_version, 2);
    let previous = [&current[..header], &previous_provenance(&report)].concat();
    assert_ne!(previous, current);
    std::fs::write(&checkpoint, &previous).unwrap();
    let candidate_bytes = std::fs::read(&candidate).unwrap();

    assert!(Checkpoint::read(&candidate).is_err());
    assert!(import::stage(request(), |_| ControlFlow::Continue(())).is_err());
    assert_eq!(std::fs::read(&candidate).unwrap(), candidate_bytes);
    assert_eq!(std::fs::read(&checkpoint).unwrap(), previous);
    assert!(import::sealed(&candidate, DatabaseKind::Bootstrap).is_err());

    std::fs::write(&checkpoint, &current).unwrap();
    assert!(Checkpoint::read(&candidate).unwrap().is_some());
    let resumed = import::stage(request(), |_| ControlFlow::Continue(())).unwrap();
    assert_eq!(resumed.importer_version, 2);
    assert_eq!(
        import::sealed(&candidate, DatabaseKind::Bootstrap)
            .unwrap()
            .1,
        resumed
    );
}
