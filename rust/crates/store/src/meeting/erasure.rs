use super::{
    ApprovalTable, CATALOG, CheckpointTable, FindingTable, JobTable, MeetingTable, PlanTable,
    ProposalTable, ReferenceTable, SegmentTable,
};
use crate::{
    Client, Error, IndexOrder, IndexQuery, KeyPart, Metadata, Options, Snapshot, Store, TableSpec,
    Write, tuple_key,
};
use redb::{ReadTransaction, ReadableDatabase, ReadableTable, ReadableTableMetadata};
use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom};
use std::ops::{Bound, Deref};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use ycoding_schema::LosslessString;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErasurePhase {
    Prepared,
    Committed,
    CandidateCreated,
    CopyBatch,
    Verified,
    Linked,
    Published,
    Scrubbing,
    Scrubbed,
    Unlinked,
    Finished,
}

pub struct MeetingStore {
    file: PathBuf,
    stage: PathBuf,
    store: Option<Store>,
    client: Client,
    _lock: File,
}

impl MeetingStore {
    pub fn initialize(path: impl AsRef<Path>, metadata: Metadata) -> Result<Self, Error> {
        let (file, stage, lock) = ownership(path.as_ref())?;
        if stage.try_exists()? {
            return Err(Error::Rejected(
                "pending Meeting erasure requires opening the existing database",
            ));
        }
        let store = super::initialize(&file, metadata)?;
        Ok(Self {
            file,
            stage,
            client: store.client(),
            store: Some(store),
            _lock: lock,
        })
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, Error> {
        let (file, stage, lock) = ownership(path.as_ref())?;
        let store = super::open(&file)?;
        let mut owner = Self {
            file,
            stage,
            client: store.client(),
            store: Some(store),
            _lock: lock,
        };
        if owner.stage.try_exists()? {
            owner.erase()?;
        }
        Ok(owner)
    }

    pub fn delete_meeting(&mut self, id: LosslessString) -> Result<bool, Error> {
        self.delete_meeting_with_progress(id, |_| Ok(()))
    }

    pub fn delete_meeting_with_progress(
        &mut self,
        id: LosslessString,
        progress: impl FnMut(ErasurePhase) -> Result<(), Error>,
    ) -> Result<bool, Error> {
        self.prepare()?;
        self.finish(move |tx| super::delete_meeting(tx, &id), progress)
    }

    pub fn retain(&mut self, days: f64, now_ms: i64) -> Result<(), Error> {
        if !days.is_finite() || days < 0.0 {
            return Err(Error::Rejected("invalid retention days"));
        }
        self.prepare()?;
        self.finish(move |tx| super::retain(tx, days, now_ms), |_| Ok(()))
    }

    pub fn erase(&mut self) -> Result<(), Error> {
        self.ensure_open()?;
        if !self.stage.try_exists()? {
            self.create_stage()?;
        }
        self.finish(|_| Ok(()), |_| Ok(()))
    }

    pub fn shutdown(mut self) -> Result<(), Error> {
        self.store.take().map_or(Ok(()), Store::shutdown)
    }

    pub fn client(&self) -> Client {
        self.client.clone()
    }

    fn ensure_open(&mut self) -> Result<(), Error> {
        if self.store.is_none() {
            let store = super::open(&self.file)?;
            self.client = store.client();
            self.store = Some(store);
        }
        Ok(())
    }

    fn prepare(&mut self) -> Result<(), Error> {
        self.ensure_open()?;
        if self.stage.try_exists()? {
            self.erase()?;
        }
        self.create_stage()
    }

    fn create_stage(&self) -> Result<(), Error> {
        sync_parent(&self.file)?;
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&self.stage)?;
        File::open(&self.stage)?.sync_all()?;
        sync_parent(&self.stage)
    }

    fn finish<R>(
        &mut self,
        operation: impl FnOnce(&mut Write<'_>) -> Result<R, Error>,
        mut progress: impl FnMut(ErasurePhase) -> Result<(), Error>,
    ) -> Result<R, Error> {
        validate_links(&owned_files(&self.stage)?, Some(&self.file))?;
        progress(ErasurePhase::Prepared)?;
        let store = self.store.take().ok_or(Error::Closed)?;
        let (source, result) = store.close_with(operation)?;
        progress(ErasurePhase::Committed)?;
        let metadata = crate::metadata::bootstrap(&source, CATALOG, None)?;
        let candidate = candidate(&self.stage)?;
        let destination =
            Store::initialize(&candidate, Options::meeting(), CATALOG, metadata.clone())?;
        super::private_file(&candidate)?;
        progress(ErasurePhase::CandidateCreated)?;
        let read = source.begin_read()?;
        macro_rules! copy {
            ($table:ty, $put:expr) => {
                copy_table::<$table>(&read, &destination, $put, &mut progress)?;
            };
        }
        copy!(MeetingTable, MeetingTable::put);
        copy!(SegmentTable, SegmentTable::put);
        copy!(ReferenceTable, ReferenceTable::put);
        copy!(FindingTable, FindingTable::put);
        copy!(CheckpointTable, CheckpointTable::put);
        copy!(ProposalTable, ProposalTable::put);
        copy!(PlanTable, PlanTable::put);
        copy!(ApprovalTable, ApprovalTable::put);
        copy!(JobTable, JobTable::put);
        copy!(crate::import::ProvenanceTable, |tx, value| {
            tx.put::<crate::import::ProvenanceTable>(value)
        });
        destination.shutdown()?;
        let verified = Store::open(&candidate, Options::meeting(), CATALOG)?;
        if verified.metadata() != &metadata {
            return Err(Error::Incompatible("Meeting replacement metadata mismatch"));
        }
        let snapshot = verified.snapshot()?;
        macro_rules! verify {
            ($($table:ty),* $(,)?) => { $(verify_table::<$table>(&read, &snapshot)?;)* };
        }
        verify!(
            MeetingTable,
            SegmentTable,
            ReferenceTable,
            FindingTable,
            CheckpointTable,
            ProposalTable,
            PlanTable,
            ApprovalTable,
            JobTable,
            crate::import::ProvenanceTable
        );
        drop(snapshot);
        verified.shutdown()?;
        drop(read);
        File::open(&candidate)?.sync_all()?;
        File::open(&self.stage)?.sync_all()?;
        progress(ErasurePhase::Verified)?;
        let previous = self.stage.join("previous.redb");
        if !previous.try_exists()? {
            std::fs::hard_link(&self.file, &previous)?;
        }
        drop(source);
        File::open(&self.file)?.sync_all()?;
        File::open(&self.stage)?.sync_all()?;
        progress(ErasurePhase::Linked)?;
        std::fs::rename(&candidate, &self.file)?;
        sync_parent(&self.file)?;
        File::open(&self.stage)?.sync_all()?;
        let store = super::open(&self.file)?;
        self.client = store.client();
        self.store = Some(store);
        progress(ErasurePhase::Published)?;
        let files = owned_files(&self.stage)?;
        validate_links(&files, None)?;
        for path in files {
            scrub(&path, &mut progress)?;
        }
        progress(ErasurePhase::Scrubbed)?;
        for path in owned_files(&self.stage)? {
            std::fs::remove_file(path)?;
        }
        File::open(&self.stage)?.sync_all()?;
        progress(ErasurePhase::Unlinked)?;
        std::fs::remove_dir(&self.stage)?;
        sync_parent(&self.stage)?;
        progress(ErasurePhase::Finished)?;
        Ok(result)
    }
}

impl Deref for MeetingStore {
    type Target = Client;
    fn deref(&self) -> &Client {
        &self.client
    }
}

fn ownership(path: &Path) -> Result<(PathBuf, PathBuf, File), Error> {
    super::private_parent(path)?;
    let parent = path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let file = std::fs::canonicalize(parent)?.join(
        path.file_name()
            .ok_or(Error::Rejected("Meeting database filename is missing"))?,
    );
    regular_or_missing(&file)?;
    let mut stage = file.as_os_str().to_os_string();
    stage.push(".erasure");
    let stage = PathBuf::from(stage);
    match std::fs::symlink_metadata(&stage) {
        Ok(metadata) if metadata.is_dir() => (),
        Ok(_) => return Err(Error::Rejected("Meeting erasure directory is not owned")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
    }
    let mut lock = file.as_os_str().to_os_string();
    lock.push(".erasure.lock");
    let lock = PathBuf::from(lock);
    regular_or_missing(&lock)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock_file = options.open(&lock)?;
    lock_file.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => Error::Rejected("Meeting database is already owned"),
        std::fs::TryLockError::Error(error) => Error::Io(error),
    })?;
    super::private_file(&lock)?;
    Ok((file, stage, lock_file))
}

fn regular_or_missing(path: &Path) -> Result<(), Error> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(()),
        Ok(_) => Err(Error::Rejected(
            "Meeting database and lock require regular files",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn sync_parent(path: &Path) -> Result<(), Error> {
    File::open(
        path.parent()
            .ok_or(Error::Rejected("Meeting database parent is missing"))?,
    )?
    .sync_all()?;
    Ok(())
}

fn candidate(stage: &Path) -> Result<PathBuf, Error> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    loop {
        let path = stage.join(format!(
            "candidate-{}-{}.redb",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        if !path.try_exists()? {
            return Ok(path);
        }
    }
}

fn owned_files(stage: &Path) -> Result<Vec<PathBuf>, Error> {
    if !std::fs::symlink_metadata(stage)?.is_dir() {
        return Err(Error::Rejected("Meeting erasure directory is not owned"));
    }
    std::fs::read_dir(stage)?
        .map(|entry| {
            let entry = entry?;
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or(Error::Rejected("unowned Meeting erasure entry"))?;
            let candidate = name
                .strip_prefix("candidate-")
                .and_then(|name| name.strip_suffix(".redb"))
                .is_some_and(|name| {
                    let values = name.split('-').collect::<Vec<_>>();
                    values.len() == 2
                        && values.iter().all(|value| {
                            !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
                        })
                });
            if !entry.file_type()?.is_file() || (name != "previous.redb" && !candidate) {
                return Err(Error::Rejected("unowned Meeting erasure entry"));
            }
            Ok(entry.path())
        })
        .collect()
}

fn scrub(
    path: &Path,
    progress: &mut impl FnMut(ErasurePhase) -> Result<(), Error>,
) -> Result<(), Error> {
    let mut file = OpenOptions::new().write(true).open(path)?;
    let mut remaining = file.metadata()?.len();
    file.seek(SeekFrom::Start(0))?;
    while remaining > 0 {
        let count = remaining.min(65536) as usize;
        std::io::Write::write_all(&mut file, &[0; 65536][..count])?;
        remaining -= count as u64;
        progress(ErasurePhase::Scrubbing)?;
    }
    file.sync_all()?;
    Ok(())
}

fn validate_links(files: &[PathBuf], selected: Option<&Path>) -> Result<(), Error> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = files
            .iter()
            .map(std::fs::symlink_metadata)
            .collect::<Result<Vec<_>, _>>()?;
        let selected = selected.map(std::fs::symlink_metadata).transpose()?;
        if let Some(selected) = &selected {
            let owned = 1 + metadata
                .iter()
                .filter(|file| file.dev() == selected.dev() && file.ino() == selected.ino())
                .count() as u64;
            if selected.nlink() != owned {
                return Err(Error::Rejected("Meeting database has an unowned hardlink"));
            }
        }
        for file in &metadata {
            let owned = metadata
                .iter()
                .filter(|owned| owned.dev() == file.dev() && owned.ino() == file.ino())
                .count() as u64
                + u64::from(selected.as_ref().is_some_and(|selected| {
                    selected.dev() == file.dev() && selected.ino() == file.ino()
                }));
            if file.nlink() != owned {
                return Err(Error::Rejected(
                    "Meeting erasure file has an unowned hardlink",
                ));
            }
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (files, selected);
        Err(Error::InvalidConfiguration(
            "Meeting erasure requires Unix inode ownership checks",
        ))
    }
}

fn copy_table<T: TableSpec>(
    source: &ReadTransaction,
    destination: &Store,
    put: fn(&mut Write<'_>, &T::Record) -> Result<(), Error>,
    progress: &mut impl FnMut(ErasurePhase) -> Result<(), Error>,
) -> Result<(), Error>
where
    T::Record: Send + 'static,
{
    let table = source.open_table(redb::TableDefinition::<&[u8], &[u8]>::new(T::NAME))?;
    let mut after: Option<Vec<u8>> = None;
    let mut counts = vec![0usize; T::INDEXES.len()];
    loop {
        let rows = table
            .range::<&[u8]>((
                after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
            ))?
            .take(128)
            .map(|entry| {
                let (key, value) = entry?;
                let record = T::decode(value.value())?;
                if T::primary_key(&record) != key.value() {
                    return Err(Error::Incompatible(
                        "Meeting source primary identity mismatch",
                    ));
                }
                Ok((record, key.value().to_vec(), value.value().to_vec()))
            })
            .collect::<Result<Vec<_>, Error>>()?;
        if rows.is_empty() {
            break;
        }
        after = rows.last().map(|row| row.1.clone());
        for (record, primary, _) in &rows {
            for (position, index) in T::INDEXES.iter().enumerate() {
                let Some(logical) = T::index_key(index, record)? else {
                    continue;
                };
                counts[position] += 1;
                let physical = if index.unique {
                    logical
                } else {
                    tuple_key(&[KeyPart::Bytes(&logical), KeyPart::Bytes(primary)])
                };
                if source
                    .open_table(redb::TableDefinition::<&[u8], &[u8]>::new(index.name))?
                    .get(physical.as_slice())?
                    .is_none_or(|value| value.value() != primary)
                {
                    return Err(Error::Incompatible(
                        "Meeting source index membership mismatch",
                    ));
                }
            }
        }
        let expected = rows
            .iter()
            .map(|row| (row.1.clone(), row.2.clone()))
            .collect::<Vec<_>>();
        destination
            .submit(move |tx| {
                for (record, _, _) in rows {
                    put(tx, &record)?;
                }
                Ok(())
            })?
            .wait()?;
        let snapshot = destination.snapshot()?;
        for (key, value) in expected {
            let record = snapshot
                .get::<T>(&key)?
                .ok_or(Error::Incompatible("Meeting replacement row is missing"))?;
            if T::encode(&record)? != value {
                return Err(Error::Incompatible("Meeting replacement record mismatch"));
            }
        }
        drop(snapshot);
        progress(ErasurePhase::CopyBatch)?;
    }
    for (index, expected) in T::INDEXES.iter().zip(counts) {
        if source
            .open_table(redb::TableDefinition::<&[u8], &[u8]>::new(index.name))?
            .len()?
            != expected as u64
        {
            return Err(Error::Incompatible(
                "Meeting source index cardinality mismatch",
            ));
        }
    }
    Ok(())
}

fn verify_table<T: TableSpec>(source: &ReadTransaction, candidate: &Snapshot) -> Result<(), Error> {
    let table = source.open_table(redb::TableDefinition::<&[u8], &[u8]>::new(T::NAME))?;
    for entry in table.iter()? {
        let (key, value) = entry?;
        let record = candidate.get::<T>(key.value())?.ok_or(Error::Incompatible(
            "reopened Meeting replacement row is missing",
        ))?;
        if T::encode(&record)? != value.value() {
            return Err(Error::Incompatible(
                "reopened Meeting replacement record mismatch",
            ));
        }
    }
    let mut after: Option<Vec<u8>> = None;
    let mut count = 0;
    loop {
        let rows = candidate.scan::<T>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            128,
        )?;
        if rows.is_empty() {
            break;
        }
        count += rows.len() as u64;
        after = rows.last().map(T::primary_key);
    }
    if count != table.len()? {
        return Err(Error::Incompatible(
            "reopened Meeting replacement row count mismatch",
        ));
    }
    for index in T::INDEXES {
        let mut after = None;
        let mut count = 0;
        loop {
            let rows = candidate.index_range::<T>(
                index.name,
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Unbounded,
                    prefix: None,
                    order: IndexOrder::Ascending,
                    after: after.as_ref(),
                    limit: 128,
                },
            )?;
            if rows.is_empty() {
                break;
            }
            count += rows.len() as u64;
            after = rows.last().map(|row| row.cursor.clone());
        }
        if count
            != source
                .open_table(redb::TableDefinition::<&[u8], &[u8]>::new(index.name))?
                .len()?
        {
            return Err(Error::Incompatible(
                "reopened Meeting replacement index count mismatch",
            ));
        }
    }
    Ok(())
}
