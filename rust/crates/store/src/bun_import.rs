mod rows;

use crate::{
    Error, Metadata, Options, Store, TableSpec,
    analytics::DeliveryTable,
    backup::{private_file, sync_parent},
    catalog::definition,
    digest::Digest,
    native::{self, DatabaseKind},
};
use redb::{DatabaseError, ReadOnlyDatabase, ReadableDatabase, ReadableTableMetadata};
use rusqlite::{Connection, OpenFlags};
use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

const STAGING: &str = ".bun-import-v1";
const OWNER: &str = ".owned";
const MEMBERS: &[&str] = &[
    "source.db",
    "source.db-wal",
    "source.db-journal",
    "source.db-shm",
    "candidate.redb",
];

pub fn recover_interrupted(target: &Path) -> Result<(), Error> {
    let stage = append(target, STAGING);
    match fs::symlink_metadata(&stage) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Err(Error::Rejected("Bun import staging is not a directory")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    match fs::symlink_metadata(stage.join(OWNER)) {
        Ok(metadata) if metadata.is_file() && metadata.len() == 0 => {}
        Ok(_) => {
            return Err(Error::Rejected(
                "Bun import staging has an invalid ownership marker",
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    match ReadOnlyDatabase::open(target) {
        Ok(_) => Ok(()),
        Err(DatabaseError::RepairAborted) => {
            Store::open(target, Options::core(), native::catalog(DatabaseKind::Core))?.shutdown()
        }
        Err(error) => Err(error.into()),
    }
}

pub fn first_run(source: &Path, target: &Path, metadata: Metadata) -> Result<(), Error> {
    let stage = append(target, STAGING);
    clear_stage(&stage)?;
    let source_info = fs::symlink_metadata(source);
    if source_info
        .as_ref()
        .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
    {
        return Ok(());
    }
    let catalog = native::catalog(DatabaseKind::Core);
    let existing = match fs::symlink_metadata(target) {
        Ok(file) if file.is_file() => {
            let database = ReadOnlyDatabase::open(target)?;
            let snapshot = database.begin_read()?;
            for table in catalog.tables() {
                if blocks_import_when_populated(table.name)
                    && !snapshot.open_table(definition(table.name))?.is_empty()?
                {
                    return Ok(());
                }
            }
            true
        }
        Ok(_) => {
            return Err(Error::Rejected(
                "native import target is not a regular file",
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    match source_info {
        Ok(file) if file.is_file() => {}
        Ok(_) => return Err(Error::Rejected("Bun import source is not a regular file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    }

    let mut directory = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directory.mode(0o700);
    }
    directory.create(&stage)?;
    let result: Result<(), Error> = (|| {
        private_file(&stage.join(OWNER))?.sync_all()?;
        sync_parent(&stage.join(OWNER))?;
        sync_parent(&stage)?;
        let existing = existing
            .then(|| Store::open(target, Options::core(), catalog))
            .transpose()?;
        let (db, fingerprint, bytes) = snapshot(source, &stage.join("source.db"))?;
        let populated = db
            .query_one(
                "SELECT EXISTS(SELECT 1 FROM project WHERE id != 'global')
                 OR EXISTS(SELECT 1 FROM project_directory)
                 OR EXISTS(SELECT 1 FROM workspace)
                 OR EXISTS(SELECT 1 FROM permission)
                 OR EXISTS(SELECT 1 FROM session)
                 OR EXISTS(SELECT 1 FROM kv)
                 OR EXISTS(SELECT 1 FROM telemetry_consent)",
                [],
                |row| row.get::<_, bool>(0),
            )
            .map_err(sqlite)?;
        if !populated {
            return Ok(());
        }
        let candidate = stage.join("candidate.redb");
        let publish = existing.is_none();
        let store = match existing {
            Some(store) => store,
            None => Store::initialize(&candidate, Options::core(), catalog, metadata)?,
        };
        let (database, imported) = store.close_with(|write| {
            write.import_bun(|write| rows::import(&db, write, fingerprint, bytes))
        })?;
        drop(database);
        if publish && imported.is_some() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&candidate, fs::Permissions::from_mode(0o600))?;
            }
            File::open(&candidate)?.sync_all()?;
            fs::hard_link(&candidate, target)?;
            sync_parent(target)?;
        }
        Ok(())
    })();
    result?;
    clear_stage(&stage)
}

pub(crate) fn blocks_import_when_populated(table: &str) -> bool {
    !matches!(
        table,
        crate::artifacts::MigrationTable::NAME
            | crate::artifacts::DatabaseFormatTable::NAME
            | crate::resources::MigrationTable::NAME
            | crate::usage_cells::BackfillTable::NAME
            | DeliveryTable::NAME
    )
}

fn append(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    name.into()
}

fn clear_stage(stage: &Path) -> Result<(), Error> {
    match fs::symlink_metadata(stage) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Err(Error::Rejected("Bun import staging is not a directory")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    let mut files = Vec::new();
    let mut owned = false;
    for entry in fs::read_dir(stage)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            return Err(Error::Rejected("Bun import staging has unexpected files"));
        }
        if entry.file_name() == OWNER && entry.metadata()?.len() == 0 {
            owned = true;
        } else if entry
            .file_name()
            .to_str()
            .is_some_and(|name| MEMBERS.contains(&name))
        {
            files.push(entry.path());
        } else {
            return Err(Error::Rejected("Bun import staging has unexpected files"));
        }
    }
    if !owned && !files.is_empty() {
        return Err(Error::Rejected(
            "Bun import staging has no ownership marker",
        ));
    }
    for file in files {
        fs::remove_file(file)?;
    }
    if owned {
        fs::remove_file(stage.join(OWNER))?;
    }
    fs::remove_dir(stage)?;
    sync_parent(stage)
}

#[derive(PartialEq, Eq)]
struct Fingerprint {
    bytes: u64,
    digest: String,
}

fn fingerprint(path: &Path, copy: Option<&Path>) -> Result<Option<Fingerprint>, Error> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err(Error::Rejected("Bun SQLite member is not a regular file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let mut input = File::open(path)?;
    let mut output = copy.map(private_file).transpose()?;
    let mut digest = Digest::new();
    let mut bytes = 0u64;
    let mut buffer = [0; 64 * 1024];
    loop {
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        bytes += n as u64;
        digest.update(&buffer[..n]);
        if let Some(file) = &mut output {
            file.write_all(&buffer[..n])?;
        }
    }
    if let Some(file) = output {
        file.sync_all()?;
    }
    Ok(Some(Fingerprint {
        bytes,
        digest: digest.finish(),
    }))
}

fn snapshot(source: &Path, copy: &Path) -> Result<(Connection, String, i64), Error> {
    let suffixes = ["", "-wal", "-journal"];
    let before = suffixes
        .iter()
        .map(|suffix| fingerprint(&append(source, suffix), None))
        .collect::<Result<Vec<_>, _>>()?;
    if before[0].is_none() {
        return Err(Error::Rejected("Bun SQLite source disappeared"));
    }
    if before[2].as_ref().is_some_and(|journal| journal.bytes != 0) {
        return Err(Error::Rejected(
            "Bun SQLite has a rollback journal; close Bun and retry the import",
        ));
    }
    let mut digest = Digest::new();
    let mut bytes = 0i64;
    for (suffix, expected) in suffixes.iter().zip(&before) {
        let file = append(source, suffix);
        if expected.is_some() && fingerprint(&file, Some(&append(copy, suffix)))? != *expected {
            return Err(Error::Rejected("Bun SQLite changed while it was copied"));
        }
    }
    for (suffix, expected) in suffixes.iter().zip(&before) {
        if fingerprint(&append(source, suffix), None)? != *expected {
            return Err(Error::Rejected("Bun SQLite changed while it was copied"));
        }
        digest.update(suffix.as_bytes());
        if let Some(member) = expected {
            bytes = i64::try_from(member.bytes)
                .ok()
                .and_then(|length| bytes.checked_add(length))
                .ok_or(Error::Rejected("Bun SQLite source size overflow"))?;
            digest.update(member.digest.as_bytes());
        }
    }
    let db = Connection::open_with_flags(
        copy,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(sqlite)?;
    db.execute_batch(
        "PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; BEGIN",
    )
    .map_err(sqlite)?;
    let format: String = db
        .query_one("SELECT id FROM database_format", [], |row| row.get(0))
        .map_err(sqlite)?;
    let integrity: String = db
        .query_one("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(sqlite)?;
    if format != "current-2026-08-04" || integrity != "ok" {
        return Err(Error::Rejected(
            "Bun SQLite format or integrity check failed",
        ));
    }
    Ok((db, digest.finish(), bytes))
}

fn sqlite(_: rusqlite::Error) -> Error {
    Error::Rejected("Bun SQLite snapshot or row could not be read; the source was retained")
}
