mod checkpoint;
pub(crate) mod digest;
mod mappings;
mod meeting;
mod provenance;
mod read;

use crate::{
    Catalog, Metadata, Options, Store, TableDeclaration, analytics, artifacts, mcp_events,
    model_incident, project, resources, session,
};
pub use provenance::{IMPORTER_VERSION, ProvenanceTable, Report, TableSummary};
use rusqlite::{Connection, OpenFlags};
use std::collections::BTreeSet;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DatabaseKind {
    Core,
    Bootstrap,
    Meeting,
}

pub struct Request<'a> {
    pub source: &'a Path,
    pub candidate: &'a Path,
    pub kind: DatabaseKind,
    pub metadata: Metadata,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Progress {
    Created,
    Rows { table: &'static str, rows: u64 },
    Loaded(&'static str),
    Validating,
    Verifying,
    Verified(&'static str),
    Complete,
}

#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
    Store(crate::Error),
    Source(&'static str),
    SourceChanged,
    SourceBusy,
    JournalMode,
    Checkpoint(&'static str),
    Row {
        table: &'static str,
        row: u64,
        column: Option<&'static str>,
        reason: String,
    },
    Verification {
        table: &'static str,
        reason: &'static str,
    },
    Cancelled,
    Interrupted,
    Cleanup {
        original: Box<Error>,
        cleanup: std::io::Error,
    },
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "import IO: {error}"),
            Self::Sqlite(_) => f.write_str("import SQLite read or schema failure"),
            Self::Store(error) => write!(f, "import store: {error}"),
            Self::Source(reason) => write!(f, "unsupported import source: {reason}"),
            Self::SourceChanged => f.write_str("import source fingerprint changed; start a new candidate generation"),
            Self::SourceBusy => f.write_str("stable YCoding is writing; close it and retry"),
            Self::JournalMode => f.write_str("stable SQLite has no recoverable on-disk journal evidence; provide a WAL snapshot or a valid file rollback journal"),
            Self::Checkpoint(reason) => write!(f, "invalid import checkpoint: {reason}"),
            Self::Row {
                table,
                row,
                column,
                reason,
            } => write!(
                f,
                "{table} row {row}{}: {reason}",
                column.map(|c| format!(" column {c}")).unwrap_or_default()
            ),
            Self::Verification { table, reason } => write!(f, "{table} verification: {reason}"),
            Self::Cancelled => f.write_str("import cancelled"),
            Self::Interrupted => f.write_str("import interrupted by panic"),
            Self::Cleanup { original, cleanup } => {
                write!(f, "{original}; candidate cleanup failed: {cleanup}")
            }
        }
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}
impl From<crate::Error> for Error {
    fn from(error: crate::Error) -> Self {
        Self::Store(error)
    }
}

pub fn catalog(kind: DatabaseKind) -> Catalog {
    if kind == DatabaseKind::Meeting {
        return crate::meeting::CATALOG;
    }
    static CORE: OnceLock<Vec<TableDeclaration>> = OnceLock::new();
    const BOOTSTRAP: &[TableDeclaration] = &[
        TableDeclaration::of::<artifacts::MigrationTable>(),
        TableDeclaration::of::<artifacts::DatabaseFormatTable>(),
        TableDeclaration::of::<ProvenanceTable>(),
    ];
    if kind == DatabaseKind::Bootstrap {
        return Catalog::new(1, BOOTSTRAP);
    }
    Catalog::new(
        1,
        CORE.get_or_init(|| {
            project::TABLES
                .iter()
                .chain(session::TABLES)
                .chain(artifacts::TABLES)
                .chain(resources::TABLES)
                .chain(model_incident::TABLES)
                .chain(mcp_events::TABLES)
                .copied()
                .chain([
                    TableDeclaration::of::<analytics::DeliveryTable>(),
                    TableDeclaration::of::<analytics::IntentTable>(),
                    TableDeclaration::of::<ProvenanceTable>(),
                ])
                .collect()
        }),
    )
}

pub fn stage(
    request: Request<'_>,
    mut progress: impl FnMut(Progress) -> ControlFlow<()>,
) -> Result<Report, Error> {
    let source = open_source(request.source)?;
    let before = digest::file(request.source)?;
    source.execute_batch("BEGIN")?;
    validate_source(&source, request.kind)?;
    request.metadata.validate()?;
    if request.kind == DatabaseKind::Meeting {
        crate::meeting::private_parent(request.candidate)?;
    }
    let options = if request.kind == DatabaseKind::Meeting {
        Options::meeting()
    } else {
        Options::core()
    };
    let mut lock_path = request.candidate.as_os_str().to_os_string();
    lock_path.push(".import-lock");
    let mut lock_options = std::fs::OpenOptions::new();
    lock_options.create(true).truncate(false).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        lock_options.mode(0o600);
    }
    let lease = lock_options.open(lock_path)?;
    lease
        .try_lock()
        .map_err(|_| Error::Checkpoint("candidate is already being imported"))?;
    let mut checkpoint_state = match checkpoint::Checkpoint::read(request.candidate)? {
        Some(value) => {
            if value.kind != request.kind || value.metadata != request.metadata {
                return Err(Error::Checkpoint("candidate identity mismatch"));
            }
            if (
                value.report.source_fingerprint.as_str(),
                value.report.source_bytes,
            ) != (before.0.as_str(), before.1)
            {
                return Err(Error::SourceChanged);
            }
            value
        }
        None if request.candidate.try_exists()? => {
            return Err(Error::Source("candidate already exists"));
        }
        None => checkpoint::Checkpoint::new(&request, before.clone()),
    };
    if !request.candidate.try_exists()?
        && (!checkpoint_state.report.tables.is_empty()
            || checkpoint_state.validated != 0
            || checkpoint_state.sealed)
    {
        return Err(Error::Checkpoint("checkpoint candidate is missing"));
    }
    checkpoint_state.save(request.candidate)?;
    let staging = Staging::new(request.candidate)?;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let store = if request.candidate.try_exists()? {
            Store::open(request.candidate, options, catalog(request.kind))?
        } else {
            let store = Store::initialize(
                &staging.file,
                options,
                catalog(request.kind),
                request.metadata.clone(),
            )?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&staging.file, std::fs::Permissions::from_mode(0o600))?;
            }
            std::fs::hard_link(&staging.file, request.candidate)?;
            #[cfg(unix)]
            std::fs::File::open(request.candidate.parent().unwrap_or(Path::new(".")))?
                .sync_all()?;
            store
        };
        if store.metadata() != &request.metadata {
            return Err(Error::Checkpoint("database identity mismatch"));
        }
        checkpoint(&mut progress, Progress::Created)?;
        {
            let snapshot = store.snapshot()?;
            for (mapping, expected) in mappings::tables(request.kind)
                .iter()
                .zip(&checkpoint_state.report.tables)
            {
                (mapping.verify)(&source, &snapshot, expected, &mut progress)?;
            }
        }
        for mapping in &mappings::tables(request.kind)[checkpoint_state.report.tables.len()..] {
            (mapping.reset)(&store)?;
            checkpoint_state
                .report
                .tables
                .push((mapping.load)(&source, &store, &mut progress)?);
            checkpoint_state.save(request.candidate)?;
            checkpoint(&mut progress, Progress::Loaded(mapping.name))?;
        }
        checkpoint(&mut progress, Progress::Validating)?;
        for mapping in &mappings::tables(request.kind)[checkpoint_state.validated..] {
            (mapping.validate)(&source, &store, &mut progress)?;
            checkpoint_state.validated += 1;
            checkpoint_state.save(request.candidate)?;
        }
        let latency_high_water = latency_sequence(&source, request.kind)?;
        if request.kind == DatabaseKind::Core {
            let seed = latency_high_water.unwrap_or(0);
            store
                .submit(move |tx| resources::seed_latency_sequence(tx, seed))?
                .wait()?;
        }
        checkpoint_state.report.latency_high_water = latency_high_water;
        let report = checkpoint_state.report.clone();
        store.shutdown()?;
        checkpoint(&mut progress, Progress::Verifying)?;
        let store = Store::open(request.candidate, options, catalog(request.kind))?;
        let snapshot = store.snapshot()?;
        for (mapping, expected) in mappings::tables(request.kind).iter().zip(&report.tables) {
            (mapping.verify)(&source, &snapshot, expected, &mut progress)?;
            checkpoint(&mut progress, Progress::Verified(mapping.name))?;
        }
        if request.kind == DatabaseKind::Core {
            let retained = source
                .query_row("SELECT max(id) FROM web_latency", [], |row| {
                    row.get::<_, Option<i64>>(0)
                })?
                .unwrap_or(0);
            let expected = latency_high_water.unwrap_or(0).max(retained).max(0);
            let key = crate::tuple_key(&[crate::KeyPart::String(&"web_latency".into())]);
            if snapshot
                .get::<resources::SequenceTable>(&key)?
                .map(|row| row.high_water)
                != Some(expected)
            {
                return Err(Error::Verification {
                    table: "resource_sequence",
                    reason: "allocation high-water mismatch",
                });
            }
        }
        if checkpoint_state.sealed
            && snapshot.get::<ProvenanceTable>(&[])?.as_ref() != Some(&report)
        {
            return Err(Error::Verification {
                table: "import_provenance",
                reason: "provenance mismatch",
            });
        }
        drop(snapshot);
        store.shutdown()?;
        if digest::file(request.source)? != before {
            return Err(Error::SourceChanged);
        }
        if !checkpoint_state.sealed {
            let store = Store::open(request.candidate, options, catalog(request.kind))?;
            let provenance = report.clone();
            store
                .submit(move |tx| tx.put::<ProvenanceTable>(&provenance))?
                .wait()?;
            store.shutdown()?;
            checkpoint_state.sealed = true;
            checkpoint_state.save(request.candidate)?;
        }
        checkpoint(&mut progress, Progress::Complete)?;
        Ok(report)
    }))
    .unwrap_or(Err(Error::Interrupted));
    match staging.remove() {
        Ok(()) => result,
        Err(cleanup) => Err(Error::Cleanup {
            original: Box::new(result.err().unwrap_or(Error::Source("staging cleanup"))),
            cleanup,
        }),
    }
}

pub fn resume_metadata(candidate: &Path) -> Result<Metadata, Error> {
    checkpoint::Checkpoint::read(candidate)?
        .map(|state| state.metadata)
        .ok_or(Error::Checkpoint("checkpoint is missing"))
}

pub fn sealed(candidate: &Path, kind: DatabaseKind) -> Result<(Metadata, Report), Error> {
    let state = checkpoint::Checkpoint::read(candidate)?
        .ok_or(Error::Checkpoint("checkpoint is missing"))?;
    if state.kind != kind || !state.sealed {
        return Err(Error::Checkpoint("candidate is not sealed"));
    }
    let store = Store::open(
        candidate,
        if kind == DatabaseKind::Meeting {
            Options::meeting()
        } else {
            Options::core()
        },
        catalog(kind),
    )?;
    let snapshot = store.snapshot()?;
    if store.metadata() != &state.metadata
        || snapshot.get::<ProvenanceTable>(&[])?.as_ref() != Some(&state.report)
    {
        return Err(Error::Checkpoint("candidate seal mismatch"));
    }
    drop(snapshot);
    store.shutdown()?;
    Ok((state.metadata, state.report))
}

pub fn copy_source(source: &Path, copy: &Path) -> Result<(), Error> {
    copy_source_observed(source, copy, || Ok(()))
}

fn copy_source_observed(
    source: &Path,
    copy: &Path,
    mut copied: impl FnMut() -> Result<(), Error>,
) -> Result<(), Error> {
    let targets = source_files(copy);
    if targets
        .iter()
        .any(|file| std::fs::symlink_metadata(file).is_ok())
    {
        return Err(Error::Source("copy already exists"));
    }
    for _ in 0..3 {
        let before = fingerprint_files(source)?;
        if before[0].is_none() {
            return Err(Error::Source("source is missing"));
        }
        for ((from, to), fingerprint) in source_files(source).iter().zip(&targets).zip(&before) {
            if fingerprint.is_some() {
                let mut input = std::fs::File::open(from)?;
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut output = options.open(to)?;
                std::io::copy(&mut input, &mut output)?;
                output.sync_all()?;
            }
        }
        copied()?;
        let private = fingerprint_files(copy)?;
        let after = fingerprint_files(source)?;
        if before == private && private == after {
            require_journal(copy)?;
            return recover_copy(copy);
        }
        for file in targets
            .iter()
            .chain(std::iter::once(&sidecar(copy, "-shm")))
        {
            match std::fs::remove_file(file) {
                Ok(()) => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.into()),
            }
        }
    }
    Err(Error::SourceBusy)
}

pub fn source_fingerprint(source: &Path) -> Result<String, Error> {
    let mut digest = digest::Digest::new();
    for (suffix, fingerprint) in ["", "-wal", "-journal"]
        .into_iter()
        .zip(fingerprint_files(source)?)
    {
        digest.record(
            suffix.as_bytes(),
            &match fingerprint {
                Some((hash, bytes)) => {
                    [vec![1], bytes.to_be_bytes().to_vec(), hash.into_bytes()].concat()
                }
                None => vec![0],
            },
        );
    }
    Ok(digest.finish())
}

pub fn file_fingerprint(file: &Path) -> Result<(String, i64), Error> {
    digest::file(file)
}

fn sidecar(file: &Path, suffix: &str) -> PathBuf {
    let mut name = file.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn source_files(source: &Path) -> [PathBuf; 3] {
    [
        source.to_path_buf(),
        sidecar(source, "-wal"),
        sidecar(source, "-journal"),
    ]
}

fn fingerprint_files(source: &Path) -> Result<Vec<Option<(String, i64)>>, Error> {
    source_files(source)
        .iter()
        .map(|file| match std::fs::symlink_metadata(file) {
            Ok(info) if info.is_file() => digest::file(file).map(Some),
            Ok(_) => Err(Error::Source("source member is not a regular file")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        })
        .collect()
}

fn require_journal(copy: &Path) -> Result<(), Error> {
    use std::io::Read;
    let mut header = [0; 100];
    std::fs::File::open(copy)?
        .read_exact(&mut header)
        .map_err(|_| Error::Source("SQLite header is truncated"))?;
    if &header[..16] != b"SQLite format 3\0" {
        return Err(Error::Source("SQLite header is invalid"));
    }
    if header[18..20] == [2, 2] {
        return Ok(());
    }
    if header[18..20] != [1, 1] {
        return Err(Error::JournalMode);
    }
    let mut journal = [0; 28];
    match std::fs::File::open(sidecar(copy, "-journal")) {
        Ok(mut file) => {
            if file.read_exact(&mut journal).is_ok()
                && journal[..8] == [0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]
            {
                return Ok(());
            }
            Err(Error::JournalMode)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(Error::JournalMode),
        Err(error) => Err(error.into()),
    }
}

fn recover_copy(copy: &Path) -> Result<(), Error> {
    let db = Connection::open_with_flags(
        copy,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let (busy, _, _) = db.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;
    if busy != 0 {
        return Err(Error::Source("copied WAL checkpoint is busy"));
    }
    db.execute_batch("PRAGMA journal_mode=DELETE")?;
    db.close().map_err(|(_, error)| Error::Sqlite(error))?;
    #[cfg(unix)]
    std::fs::File::open(copy.parent().unwrap_or(Path::new(".")))?.sync_all()?;
    Ok(())
}

fn checkpoint(
    progress: &mut dyn FnMut(Progress) -> ControlFlow<()>,
    phase: Progress,
) -> Result<(), Error> {
    match progress(phase) {
        ControlFlow::Continue(()) => Ok(()),
        ControlFlow::Break(()) => Err(Error::Cancelled),
    }
}

fn open_source(path: &Path) -> Result<Connection, Error> {
    let path = std::fs::canonicalize(path)?;
    if !path.is_file() {
        return Err(Error::Source("source is not a regular file"));
    }
    for suffix in ["-wal", "-journal"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        match std::fs::metadata(sidecar) {
            Ok(metadata) if metadata.len() > 0 => {
                return Err(Error::Source(
                    "offline source has an uncheckpointed WAL or journal",
                ));
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
    }
    let path = path
        .to_str()
        .ok_or(Error::Source("source path is not UTF-8"))?;
    let uri = format!(
        "file:{}?immutable=1&mode=ro",
        path.bytes()
            .map(|byte| {
                if byte.is_ascii_alphanumeric() || b"/-._~".contains(&byte) {
                    return char::from(byte).to_string();
                }
                format!("%{byte:02X}")
            })
            .collect::<String>()
    );
    let connection = Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    if !connection.is_readonly(rusqlite::MAIN_DB)? {
        return Err(Error::Source("source connection is writable"));
    }
    Ok(connection)
}

fn validate_source(db: &Connection, kind: DatabaseKind) -> Result<(), Error> {
    if db.query_row("PRAGMA encoding", [], |row| row.get::<_, String>(0))? != "UTF-8" {
        return Err(Error::Source("SQLite text encoding is not UTF-8"));
    }
    let names = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<BTreeSet<_>, _>>()?;
    let migrated = kind == DatabaseKind::Core && names.contains("migration");
    let analytics = migrated && mappings::analytics_migrated(db)?;
    let incidents = migrated && mappings::incidents_migrated(db)?;
    let present = |name: &str| {
        (analytics || name != mappings::FACTS)
            && (incidents || !mappings::INCIDENT_TABLES.contains(&name))
    };
    let expected = mappings::tables(kind)
        .iter()
        .filter(|table| present(table.name))
        .map(|table| table.name.to_owned())
        .collect::<BTreeSet<_>>();
    if names != expected {
        return Err(Error::Source(
            "table inventory differs from the exact compiled baseline",
        ));
    }
    if kind == DatabaseKind::Meeting
        && db.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))? != 1
    {
        return Err(Error::Source("Meeting database version is not 1"));
    }
    if kind != DatabaseKind::Meeting {
        let format = db
            .prepare("SELECT id FROM database_format")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        if format != ["current-2026-08-04"] {
            return Err(Error::Source("database_format is missing or unsupported"));
        }
    }
    if db.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))? != "ok" {
        return Err(Error::Source("SQLite integrity check failed"));
    }
    for table in mappings::tables(kind)
        .iter()
        .filter(|table| present(table.name))
    {
        let missing: &[&str] = if kind == DatabaseKind::Core {
            mappings::missing_columns(db, table.name)?
        } else {
            &[]
        };
        let mut columns = db
            .prepare(&format!("PRAGMA table_xinfo('{}')", table.name))?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<BTreeSet<_>, _>>()?;
        if matches!(
            table.name,
            "project_artifact_project_scope" | "project_artifact_global_scope"
        ) {
            columns.remove("scope_type");
            let type_ = if table.name == "project_artifact_project_scope" {
                "project"
            } else {
                "global"
            };
            if db.query_row(
                &format!(
                    "SELECT COUNT(*) FROM {} WHERE scope_type IS NULL OR scope_type != ?1",
                    table.name
                ),
                [type_],
                |row| row.get::<_, i64>(0),
            )? != 0
            {
                return Err(Error::Source(
                    "generated scope membership differs from baseline",
                ));
            }
        }
        if columns
            != table
                .columns
                .iter()
                .copied()
                .filter(|column| !missing.contains(column))
                .map(str::to_owned)
                .collect()
        {
            return Err(Error::Source(
                "column inventory differs from the exact compiled baseline",
            ));
        }
    }
    Ok(())
}

fn latency_sequence(db: &Connection, kind: DatabaseKind) -> Result<Option<i64>, Error> {
    if kind == DatabaseKind::Meeting {
        return Ok(None);
    }
    if kind == DatabaseKind::Bootstrap {
        return Ok(None);
    }
    let mut query = db.prepare("SELECT name,seq FROM sqlite_sequence ORDER BY rowid")?;
    let mut rows = query.query([])?;
    let mut value = None;
    while let Some(row) = rows.next()? {
        let reader = read::Row {
            value: row,
            table: "sqlite_sequence",
            number: 1,
        };
        let name: ycoding_schema::LosslessString = reader.field("name")?;
        if name.as_str() != Some("web_latency") || value.is_some() {
            return Err(Error::Source(
                "unexpected or duplicate SQLite allocation sequence",
            ));
        }
        value = Some(reader.field("seq")?);
    }
    Ok(value)
}

struct Staging {
    directory: PathBuf,
    file: PathBuf,
}
impl Staging {
    fn new(candidate: &Path) -> Result<Self, Error> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let directory = candidate.parent().unwrap_or(Path::new(".")).join(format!(
            ".ycoding-import-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&directory)?;
        Ok(Self {
            file: directory.join("candidate.redb"),
            directory,
        })
    }
    fn remove(self) -> Result<(), std::io::Error> {
        match std::fs::remove_file(&self.file) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
        std::fs::remove_dir(self.directory)
    }
}

#[cfg(test)]
mod copy_tests {
    use super::{Connection, Error, copy_source, copy_source_observed, source_fingerprint};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "ycoding-copy-{}-{}",
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

    #[test]
    fn nonpersistent_and_ambiguous_rollback_modes_are_refused() {
        for mode in ["MEMORY", "OFF", "DELETE"] {
            let directory = Directory::new();
            let source = directory.0.join("source.sqlite");
            let db = Connection::open(&source).unwrap();
            db.execute_batch(&format!("PRAGMA journal_mode={mode}; CREATE TABLE synthetic(id INTEGER); INSERT INTO synthetic VALUES(1);")).unwrap();
            let before = std::fs::read(&source).unwrap();
            assert!(matches!(
                copy_source(&source, &directory.0.join("copy.sqlite")),
                Err(Error::JournalMode)
            ));
            assert_eq!(std::fs::read(source).unwrap(), before);
        }
    }

    #[test]
    fn a_real_wal_writer_causes_bounded_retry_and_typed_refusal() {
        use std::io::{BufRead, BufReader, Write};
        let directory = Directory::new();
        let source = directory.0.join("source.sqlite");
        let script = "import sqlite3,sys\ndb=sqlite3.connect(sys.argv[1])\ndb.execute('PRAGMA journal_mode=WAL')\ndb.execute('PRAGMA wal_autocheckpoint=0')\ndb.execute('CREATE TABLE synthetic(id INTEGER)')\ndb.commit()\nprint('ready',flush=True)\nfor line in sys.stdin:\n db.execute('INSERT INTO synthetic VALUES(1)');db.commit();print('written',flush=True)\ndb.close()";
        let mut child = std::process::Command::new("python3")
            .args(["-c", script])
            .arg(&source)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "ready");
        let mut attempts = 0;
        let result = copy_source_observed(&source, &directory.0.join("copy.sqlite"), || {
            attempts += 1;
            child.stdin.as_mut().unwrap().write_all(b"write\n")?;
            child.stdin.as_mut().unwrap().flush()?;
            line.clear();
            output.read_line(&mut line)?;
            assert_eq!(line.trim(), "written");
            Ok(())
        });
        drop(child.stdin.take());
        assert!(child.wait().unwrap().success());
        assert!(matches!(result, Err(Error::SourceBusy)));
        assert_eq!(attempts, 3);
        assert!(!directory.0.join("copy.sqlite").exists());
        copy_source(&source, &directory.0.join("copy.sqlite")).unwrap();
        assert_eq!(
            Connection::open(directory.0.join("copy.sqlite"))
                .unwrap()
                .query_row("SELECT count(*) FROM synthetic", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
    }

    #[test]
    fn file_rollback_journal_recovers_only_the_private_copy() {
        use std::io::{BufRead, BufReader};
        let directory = Directory::new();
        let source = directory.0.join("source.sqlite");
        let script = "import sqlite3,sys\ndb=sqlite3.connect(sys.argv[1])\ndb.executescript('PRAGMA journal_mode=DELETE; PRAGMA cache_size=1; CREATE TABLE synthetic(id INTEGER, value BLOB); INSERT INTO synthetic VALUES(1,zeroblob(100000));')\ndb.execute('BEGIN IMMEDIATE')\nfor value in range(2,50): db.execute('INSERT INTO synthetic VALUES(?,zeroblob(100000))',(value,))\nprint('ready',flush=True)\nsys.stdin.read()\ndb.rollback();db.close()";
        let mut child = std::process::Command::new("python3")
            .args(["-c", script])
            .arg(&source)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line.trim(), "ready");
        let before = source_fingerprint(&source).unwrap();
        let copy = directory.0.join("copy.sqlite");
        let result = copy_source(&source, &copy);
        let after = source_fingerprint(&source).unwrap();
        drop(child.stdin.take());
        assert!(child.wait().unwrap().success());
        result.unwrap();
        assert_eq!(after, before);
        assert_eq!(
            Connection::open(copy)
                .unwrap()
                .query_row("SELECT count(*) FROM synthetic", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}
