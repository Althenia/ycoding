use std::{
    ops::Bound,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_store::{
    Catalog, Error, IndexDefinition, Metadata, Options, Store, TableDeclaration, TableSpec, backup,
};

struct Item;
impl TableSpec for Item {
    type Record = (u64, Vec<u8>);
    const NAME: &'static str = "item";
    const INDEXES: &'static [IndexDefinition] = &[];
    fn primary_key(record: &Self::Record) -> Vec<u8> {
        record.0.to_be_bytes().to_vec()
    }
    fn encode(record: &Self::Record) -> Result<Vec<u8>, Error> {
        Ok([record.0.to_be_bytes().as_slice(), &record.1].concat())
    }
    fn decode(bytes: &[u8]) -> Result<Self::Record, Error> {
        Ok((
            u64::from_be_bytes(bytes[..8].try_into().unwrap()),
            bytes[8..].to_vec(),
        ))
    }
    fn index_key(_: &IndexDefinition, _: &Self::Record) -> Result<Option<Vec<u8>>, Error> {
        Ok(None)
    }
}
const CATALOG: Catalog = Catalog::new(1, &[TableDeclaration::of::<Item>()]);

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ycoding-history-backup-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn database(&self) -> PathBuf {
        self.0.join("core.redb")
    }
    fn store(&self) -> Store {
        Store::initialize(
            self.database(),
            Options::core(),
            CATALOG,
            Metadata::new([8; 16], 1),
        )
        .unwrap()
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn space_gate_exact_threshold_retry_marker_restore_and_reopen() {
    let scratch = Scratch::new();
    let store = scratch.store();
    store
        .submit(|tx| {
            for id in 0..230 {
                tx.put::<Item>(&(id, vec![id as u8; 12 * 1024]))?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let rows = store
        .snapshot()
        .unwrap()
        .scan::<Item>(Bound::Unbounded, Bound::Unbounded, 1000)
        .unwrap();
    let required = std::fs::metadata(scratch.database()).unwrap().len() + backup::HEADROOM_BYTES;
    for (now, notify) in [(0, true), (1, false), (3_600_000, true)] {
        let status = store.prepare_pruning(now, |_| Ok(required - 1)).unwrap();
        assert!(matches!(status, backup::Status::Blocked { notice } if notice.is_some() == notify));
        assert!(!backup::path(&scratch.database()).exists());
        assert!(!backup::marker(&scratch.database()).exists());
    }
    assert_eq!(
        store.prepare_pruning(3_600_001, |_| Ok(required)).unwrap(),
        backup::Status::Ready
    );
    assert!(backup::marker(&scratch.database()).is_file());
    assert_eq!(std::fs::read_dir(&scratch.0).unwrap().count(), 3);
    let restored = scratch.0.join("restored.redb");
    std::fs::copy(backup::path(&scratch.database()), &restored).unwrap();
    let restore = Store::open(&restored, Options::core(), CATALOG).unwrap();
    assert_eq!(
        restore
            .snapshot()
            .unwrap()
            .scan::<Item>(Bound::Unbounded, Bound::Unbounded, 1000)
            .unwrap(),
        rows
    );
    assert_eq!(restore.metadata(), store.metadata());
    restore.shutdown().unwrap();
    store
        .submit(|tx| tx.delete::<Item>(&0u64.to_be_bytes()))
        .unwrap()
        .wait()
        .unwrap();
    store.shutdown().unwrap();
    let reopened = Store::open(scratch.database(), Options::core(), CATALOG).unwrap();
    assert_eq!(
        reopened
            .prepare_pruning(4_000_000, |_| panic!(
                "completed backup must not require space again"
            ))
            .unwrap(),
        backup::Status::Ready
    );
    let backup = Store::open(backup::path(&scratch.database()), Options::core(), CATALOG).unwrap();
    assert_eq!(
        backup
            .snapshot()
            .unwrap()
            .scan::<Item>(Bound::Unbounded, Bound::Unbounded, 1000)
            .unwrap(),
        rows
    );
}

#[test]
fn failed_copy_and_integrity_refuse_publication_and_retry_without_overwrite() {
    let scratch = Scratch::new();
    let store = scratch.store();
    assert!(matches!(
        store
            .prepare_pruning(0, |_| Err(
                std::io::Error::other("space query failed").into()
            ))
            .unwrap(),
        backup::Status::Blocked { notice: Some(_) }
    ));
    assert!(!backup::marker(&scratch.database()).exists());
    let target = backup::path(&scratch.database());
    std::fs::write(&target, b"invalid redb").unwrap();
    assert!(matches!(
        store.prepare_pruning(1, |_| Ok(u64::MAX)).unwrap(),
        backup::Status::Blocked { notice: None }
    ));
    assert_eq!(std::fs::read(&target).unwrap(), b"invalid redb");
    assert!(!backup::marker(&scratch.database()).exists());
    std::fs::remove_file(&target).unwrap();
    assert_eq!(
        store.prepare_pruning(2, |_| Ok(u64::MAX)).unwrap(),
        backup::Status::Ready
    );
    std::fs::remove_file(backup::marker(&scratch.database())).unwrap();
    store.shutdown().unwrap();
    let reopened = Store::open(scratch.database(), Options::core(), CATALOG).unwrap();
    assert_eq!(
        reopened
            .prepare_pruning(3, |_| panic!("published backup recovery must not recopy"))
            .unwrap(),
        backup::Status::Ready
    );
    assert!(backup::marker(&scratch.database()).is_file());
}

#[test]
fn missing_or_foreign_completion_blocks_and_disposable_has_no_disk_gate() {
    let scratch = Scratch::new();
    let store = scratch.store();
    assert_eq!(
        store.prepare_pruning(0, |_| Ok(u64::MAX)).unwrap(),
        backup::Status::Ready
    );
    std::fs::remove_file(backup::path(&scratch.database())).unwrap();
    assert!(matches!(
        store.prepare_pruning(1, |_| Ok(u64::MAX)).unwrap(),
        backup::Status::Blocked { .. }
    ));
    std::fs::remove_file(backup::marker(&scratch.database())).unwrap();
    Store::initialize(
        backup::path(&scratch.database()),
        Options::core(),
        CATALOG,
        Metadata::new([9; 16], 1),
    )
    .unwrap()
    .shutdown()
    .unwrap();
    assert!(matches!(
        store.prepare_pruning(2, |_| Ok(u64::MAX)).unwrap(),
        backup::Status::Blocked { .. }
    ));
    assert!(!backup::marker(&scratch.database()).exists());
    let disposable =
        Store::disposable(Options::core(), CATALOG, Metadata::new([9; 16], 1)).unwrap();
    assert_eq!(
        disposable
            .prepare_pruning(0, |_| panic!("memory store has no disk backup"))
            .unwrap(),
        backup::Status::Ready
    );
}

#[test]
fn atomic_publication_never_overwrites_a_target_created_during_copy() {
    let scratch = Scratch::new();
    let store = scratch.store();
    let target = backup::path(&scratch.database());
    assert!(matches!(
        store
            .prepare_pruning(0, |_| {
                std::fs::write(&target, b"reserved recovery artifact")?;
                Ok(u64::MAX)
            })
            .unwrap(),
        backup::Status::Blocked { .. }
    ));
    assert_eq!(
        std::fs::read(&target).unwrap(),
        b"reserved recovery artifact"
    );
    assert!(!backup::marker(&scratch.database()).exists());
    assert_eq!(std::fs::read_dir(&scratch.0).unwrap().count(), 2);
    std::fs::remove_file(&target).unwrap();
    assert_eq!(
        store.prepare_pruning(1, |_| Ok(u64::MAX)).unwrap(),
        backup::Status::Ready
    );
}

#[test]
fn publication_failure_recovers_verified_file_without_recopying_and_rejects_foreign_marker() {
    let scratch = Scratch::new();
    let store = scratch.store();
    let marker = backup::marker(&scratch.database());
    assert!(matches!(
        store
            .prepare_pruning(0, |_| {
                std::fs::create_dir(&marker)?;
                Ok(u64::MAX)
            })
            .unwrap(),
        backup::Status::Blocked { .. }
    ));
    assert!(backup::path(&scratch.database()).is_file());
    assert_eq!(std::fs::read_dir(&scratch.0).unwrap().count(), 3);
    std::fs::remove_dir(&marker).unwrap();
    assert_eq!(
        store
            .prepare_pruning(1, |_| panic!("verified publication must be recovered"))
            .unwrap(),
        backup::Status::Ready
    );
    let bytes = std::fs::read(&marker).unwrap();
    std::fs::write(&marker, vec![0; bytes.len()]).unwrap();
    assert!(matches!(
        store.prepare_pruning(2, |_| Ok(u64::MAX)).unwrap(),
        backup::Status::Blocked { .. }
    ));
    std::fs::write(&marker, bytes).unwrap();
    assert_eq!(
        store.prepare_pruning(3, |_| Ok(u64::MAX)).unwrap(),
        backup::Status::Ready
    );
}

#[cfg(unix)]
#[test]
fn copy_failure_leaves_no_partial_backup_and_retries() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = Scratch::new();
    let store = scratch.store();
    std::fs::set_permissions(&scratch.0, std::fs::Permissions::from_mode(0o500)).unwrap();
    let status = store.prepare_pruning(0, |_| Ok(u64::MAX)).unwrap();
    std::fs::set_permissions(&scratch.0, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(matches!(status, backup::Status::Blocked { .. }));
    assert!(!backup::path(&scratch.database()).exists());
    assert!(!backup::marker(&scratch.database()).exists());
    assert_eq!(std::fs::read_dir(&scratch.0).unwrap().count(), 1);
    assert_eq!(
        store.prepare_pruning(1, |_| Ok(u64::MAX)).unwrap(),
        backup::Status::Ready
    );
}

#[test]
fn fixed_native_reclaim_releases_pages_without_changing_retained_data() {
    let scratch = Scratch::new();
    let store = scratch.store();
    store
        .submit(|tx| {
            for id in 0..1000 {
                tx.put::<Item>(&(id, vec![1; 16 * 1024]))?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        store.prepare_pruning(0, |_| Ok(u64::MAX)).unwrap(),
        backup::Status::Ready
    );
    let before = std::fs::metadata(scratch.database()).unwrap().len();
    let held = store.snapshot().unwrap();
    store
        .submit(|tx| {
            for id in 1u64..1000 {
                tx.delete::<Item>(&id.to_be_bytes())?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    store.reclaim().unwrap().wait().unwrap();
    assert_eq!(
        held.scan::<Item>(Bound::Unbounded, Bound::Unbounded, 2000)
            .unwrap()
            .len(),
        1000
    );
    drop(held);
    for _ in 0..2 {
        store.reclaim().unwrap().wait().unwrap();
    }
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<Item>(Bound::Unbounded, Bound::Unbounded, 2000)
            .unwrap(),
        vec![(0, vec![1; 16 * 1024])]
    );
    store
        .submit(|tx| {
            for id in 1..1000 {
                tx.put::<Item>(&(id, vec![2; 16 * 1024]))?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(std::fs::metadata(scratch.database()).unwrap().len() <= before);
}
