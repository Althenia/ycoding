pub(crate) mod digest;
mod mappings;
mod meeting;
mod provenance;
mod read;

use crate::{
    Catalog, Metadata, Options, Store, TableDeclaration, analytics, artifacts, project, resources,
    session,
};
pub use provenance::{ProvenanceTable, Report, TableSummary};
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
    if request.candidate.try_exists()? {
        return Err(Error::Source("candidate already exists"));
    }
    if request.kind == DatabaseKind::Meeting {
        crate::meeting::private_parent(request.candidate)?;
    }
    let options = if request.kind == DatabaseKind::Meeting {
        Options::meeting()
    } else {
        Options::core()
    };
    let staging = Staging::new(request.candidate)?;
    let mut linked = false;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let store = Store::initialize(
            &staging.file,
            options,
            catalog(request.kind),
            request.metadata,
        )?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&staging.file, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::hard_link(&staging.file, request.candidate)?;
        linked = true;
        checkpoint(&mut progress, Progress::Created)?;
        let mut tables = Vec::new();
        for mapping in mappings::tables(request.kind) {
            tables.push((mapping.load)(&source, &store, &mut progress)?);
            checkpoint(&mut progress, Progress::Loaded(mapping.name))?;
        }
        checkpoint(&mut progress, Progress::Validating)?;
        for mapping in mappings::tables(request.kind) {
            (mapping.validate)(&source, &store, &mut progress)?;
        }
        let latency_high_water = latency_sequence(&source, request.kind)?;
        if request.kind == DatabaseKind::Core {
            let seed = latency_high_water.unwrap_or(0);
            store
                .submit(move |tx| resources::seed_latency_sequence(tx, seed))?
                .wait()?;
        }
        let report = Report {
            source_fingerprint: before.0.clone(),
            source_bytes: before.1,
            importer_version: 1,
            tables,
            latency_high_water,
        };
        let provenance = report.clone();
        store
            .submit(move |tx| tx.put::<ProvenanceTable>(&provenance))?
            .wait()?;
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
        if snapshot.get::<ProvenanceTable>(&[])?.as_ref() != Some(&report) {
            return Err(Error::Verification {
                table: "import_provenance",
                reason: "provenance mismatch",
            });
        }
        drop(snapshot);
        store.shutdown()?;
        if digest::file(request.source)? != before {
            return Err(Error::Source("source fingerprint changed during import"));
        }
        checkpoint(&mut progress, Progress::Complete)?;
        Ok(report)
    }))
    .unwrap_or(Err(Error::Interrupted));
    let result = match staging.remove() {
        Ok(()) => result,
        Err(cleanup) => Err(Error::Cleanup {
            original: Box::new(result.err().unwrap_or(Error::Source("staging cleanup"))),
            cleanup,
        }),
    };
    if result.is_err()
        && linked
        && let Err(cleanup) = std::fs::remove_file(request.candidate)
    {
        return Err(Error::Cleanup {
            original: Box::new(result.err().ok_or(Error::Interrupted)?),
            cleanup,
        });
    }
    result
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
    let expected = mappings::tables(kind)
        .iter()
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
    for table in mappings::tables(kind) {
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
                .map(|column| (*column).to_owned())
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
