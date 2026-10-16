use crate::{Catalog, Error, Metadata, Snapshot, catalog::definition, metadata::bootstrap};
use redb::{Database, ReadableDatabase, ReadableTable};
use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

pub const HEADROOM_BYTES: u64 = 1024 * 1024 * 1024;
const BYTE_BUDGET: usize = 2 * 1024 * 1024;
const NOTICE_INTERVAL: i64 = 60 * 60 * 1000;

#[derive(Debug, PartialEq, Eq)]
pub enum Status {
    Ready,
    Blocked { notice: Option<String> },
}

pub(crate) struct State {
    path: Option<PathBuf>,
    verified: bool,
    notified: Option<i64>,
}

pub fn path(database: &Path) -> PathBuf {
    suffix(database, ".pre-prune-backup")
}

pub fn marker(database: &Path) -> PathBuf {
    suffix(&path(database), ".complete")
}

fn suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    name.into()
}

impl State {
    pub(crate) fn new(path: Option<PathBuf>) -> Self {
        Self {
            path,
            verified: false,
            notified: None,
        }
    }

    pub(crate) fn prepare(
        &mut self,
        now: i64,
        free_bytes: impl FnOnce(&Path) -> Result<u64, Error>,
        catalog: Catalog,
        metadata: &Metadata,
        snapshot: impl FnOnce() -> Result<Snapshot, Error>,
    ) -> Result<Status, Error> {
        let Some(source) = &self.path else {
            return Ok(Status::Ready);
        };
        let target = path(source);
        let completion = marker(source);
        let result = (|| {
            if target.try_exists()? {
                if !std::fs::symlink_metadata(&target)?.is_file() {
                    return Err(Error::Rejected("backup is not a regular file"));
                }
                let completed = completion.try_exists()?;
                if !self.verified || !completed {
                    verify(&target, catalog, metadata)?;
                }
                let seal = seal(metadata, std::fs::metadata(&target)?.len());
                if completed {
                    if !std::fs::symlink_metadata(&completion)?.is_file()
                        || std::fs::metadata(&completion)?.len() != seal.len() as u64
                        || std::fs::read(&completion)? != seal
                    {
                        return Err(Error::Rejected("backup completion marker mismatch"));
                    }
                } else {
                    publish_marker(&completion, &seal)?;
                }
                self.verified = true;
                return Ok(());
            }
            if completion.try_exists()? {
                return Err(Error::Rejected("completed backup is missing"));
            }
            let required = std::fs::metadata(source)?
                .len()
                .saturating_add(HEADROOM_BYTES);
            let available = free_bytes(
                source
                    .parent()
                    .ok_or(Error::Rejected("database directory missing"))?,
            )?;
            if available < required {
                return Err(Error::Domain {
                    kind: "backup_space",
                    message: "pre-prune backup requires database size plus 1 GiB of free space",
                });
            }
            let temporary = temporary(&target);
            let result = (|| {
                let snapshot = snapshot()?;
                copy(&snapshot, &temporary, catalog, metadata)?;
                File::open(&temporary)?.sync_all()?;
                std::fs::hard_link(&temporary, &target)?;
                std::fs::remove_file(&temporary)?;
                sync_parent(&target)?;
                publish_marker(
                    &completion,
                    &seal(metadata, std::fs::metadata(&target)?.len()),
                )?;
                self.verified = true;
                Ok(())
            })();
            if result.is_err() {
                let _ = std::fs::remove_file(&temporary);
            }
            result
        })();
        match result {
            Ok(()) => Ok(Status::Ready),
            Err(error) => {
                self.verified = false;
                let notify = self
                    .notified
                    .is_none_or(|previous| now.saturating_sub(previous) >= NOTICE_INTERVAL);
                if notify {
                    self.notified = Some(now);
                }
                Ok(Status::Blocked {
                    notice: notify.then(|| error.to_string()),
                })
            }
        }
    }
}

fn temporary(target: &Path) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    suffix(
        target,
        &format!(
            ".tmp-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ),
    )
}

fn seal(metadata: &Metadata, bytes: u64) -> Vec<u8> {
    let mut seal = b"ycoding-pre-prune-backup\x01".to_vec();
    seal.extend_from_slice(&metadata.database_identity);
    seal.extend_from_slice(&metadata.generation.to_be_bytes());
    seal.extend_from_slice(&bytes.to_be_bytes());
    seal
}

fn publish_marker(target: &Path, bytes: &[u8]) -> Result<(), Error> {
    let temporary = temporary(target);
    let result = (|| {
        let mut file = private_file(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::hard_link(&temporary, target)?;
        std::fs::remove_file(&temporary)?;
        sync_parent(target)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

fn private_file(path: &Path) -> Result<File, Error> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}

fn sync_parent(path: &Path) -> Result<(), Error> {
    #[cfg(unix)]
    File::open(
        path.parent()
            .ok_or(Error::Rejected("backup directory missing"))?,
    )?
    .sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn verify(path: &Path, catalog: Catalog, metadata: &Metadata) -> Result<Database, Error> {
    let mut database = Database::builder()
        .set_cache_size(8 * 1024 * 1024)
        .open(path)?;
    if !database.check_integrity()? || bootstrap(&database, catalog, None)? != *metadata {
        return Err(Error::Rejected(
            "pre-prune backup integrity or identity mismatch",
        ));
    }
    Ok(database)
}

fn copy(
    snapshot: &Snapshot,
    path: &Path,
    catalog: Catalog,
    metadata: &Metadata,
) -> Result<(), Error> {
    let database = Database::builder()
        .set_cache_size(8 * 1024 * 1024)
        .create_file(private_file(path)?)?;
    for name in catalog.names() {
        let source = snapshot.read.open_table(definition(name))?;
        let mut rows = source.iter()?;
        let mut pending = rows.next().transpose()?;
        loop {
            let transaction = database.begin_write()?;
            {
                let mut target = transaction.open_table(definition(name))?;
                let mut bytes = 0;
                let mut count = 0;
                while let Some((key, value)) = pending.take() {
                    let size = key.value().len().saturating_add(value.value().len());
                    if count > 0 && bytes + size > BYTE_BUDGET {
                        pending = Some((key, value));
                        break;
                    }
                    target.insert(key.value(), value.value())?;
                    bytes += size;
                    count += 1;
                    pending = rows.next().transpose()?;
                    if count == 100 {
                        break;
                    }
                }
            }
            transaction
                .commit()
                .map_err(crate::metadata::commit_error)?;
            if pending.is_none() {
                break;
            }
            std::thread::yield_now();
        }
    }
    drop(database);
    let database = verify(path, catalog, metadata)?;
    let read = database.begin_read()?;
    for name in catalog.names() {
        let source = snapshot.read.open_table(definition(name))?;
        let target = read.open_table(definition(name))?;
        let mut source = source.iter()?;
        let mut target = target.iter()?;
        loop {
            match (source.next().transpose()?, target.next().transpose()?) {
                (None, None) => break,
                (Some((a, b)), Some((c, d)))
                    if a.value() == c.value() && b.value() == d.value() => {}
                _ => return Err(Error::Rejected("pre-prune backup row mismatch")),
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::copy;
    use crate::{
        Catalog, Metadata, Options, Store, TableDeclaration,
        resources::{Kv, KvTable},
        session::Document,
    };
    use std::{
        ops::Bound,
        sync::{Arc, Barrier},
    };
    use ycoding_schema::JsonValue;

    #[test]
    fn snapshot_copy_preserves_rows_across_concurrent_writer_commits() {
        const CATALOG: Catalog = Catalog::new(1, &[TableDeclaration::of::<KvTable>()]);
        let metadata = Metadata::new([73; 16], 1);
        let store = Store::disposable(Options::core(), CATALOG, metadata.clone()).unwrap();
        store
            .submit(|tx| {
                for index in 0..230 {
                    KvTable::put(
                        tx,
                        &Kv {
                            key: format!("key_{index:03}").into(),
                            value: Document::new(JsonValue::String("a".repeat(12 * 1024).into()))?,
                            time_created: 0,
                            time_updated: 0,
                        },
                    )?;
                }
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        let snapshot = store.snapshot().unwrap();
        let expected = snapshot
            .scan::<KvTable>(Bound::Unbounded, Bound::Unbounded, 1000)
            .unwrap();
        let path = std::env::temp_dir().join(format!(
            "ycoding-snapshot-backup-{}.redb",
            std::process::id()
        ));
        let candidate = path.clone();
        let start = Arc::new(Barrier::new(2));
        let started = start.clone();
        let worker = std::thread::spawn(move || {
            started.wait();
            copy(&snapshot, &candidate, CATALOG, &metadata).unwrap();
        });
        start.wait();
        store
            .submit(|tx| {
                KvTable::put(
                    tx,
                    &Kv {
                        key: "key_000".into(),
                        value: Document::new(JsonValue::String("changed".into()))?,
                        time_created: 0,
                        time_updated: 1,
                    },
                )?;
                tx.delete::<KvTable>(&crate::tuple_key(&[crate::KeyPart::String(
                    &"key_001".into(),
                )]))?;
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        worker.join().unwrap();
        let restored = Store::open(&path, Options::core(), CATALOG).unwrap();
        assert_eq!(
            restored
                .snapshot()
                .unwrap()
                .scan::<KvTable>(Bound::Unbounded, Bound::Unbounded, 1000)
                .unwrap(),
            expected
        );
        assert_eq!(
            store
                .snapshot()
                .unwrap()
                .scan::<KvTable>(Bound::Unbounded, Bound::Unbounded, 1000)
                .unwrap()
                .len(),
            229
        );
        restored.shutdown().unwrap();
        std::fs::remove_file(path).unwrap();
    }
}
