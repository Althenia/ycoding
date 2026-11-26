use super::{SKILL, ensure, prepare};
use crate::dots::carrier::supervisor::{Prepare, PrepareError};
use std::{
    io,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, UNIX_EPOCH},
};
use ycoding_core::session::prompt_cache::sha256;

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "ycoding-dots-operator-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn data(&self) -> PathBuf {
        self.0.join("data")
    }
    fn skill(&self) -> PathBuf {
        self.data()
            .join("dots")
            .join("skills")
            .join("ycoding-operator")
            .join("SKILL.md")
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn next_ok(calls: Arc<AtomicUsize>) -> Prepare {
    Box::new(move || {
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    })
}

#[test]
fn embedded_skill_matches_the_pinned_digest() {
    assert_eq!(SKILL.len(), 29_778);
    assert_eq!(
        sha256(SKILL),
        "d81f10a8c97322865fadd12b1c7e3c125731c5cee7805fe8f01494cca68c2204"
    );
    assert!(SKILL.ends_with('\n'));
}

#[tokio::test]
async fn ensure_writes_an_absent_skill_and_its_parents() {
    let directory = Directory::new();
    ensure(directory.data()).await.unwrap();
    assert_eq!(std::fs::read(directory.skill()).unwrap(), SKILL.as_bytes());
}

#[tokio::test]
async fn ensure_leaves_equal_bytes_untouched() {
    let directory = Directory::new();
    std::fs::create_dir_all(directory.skill().parent().unwrap()).unwrap();
    std::fs::write(directory.skill(), SKILL).unwrap();
    let modified = UNIX_EPOCH + Duration::from_secs(1_000_000_000);
    std::fs::File::options()
        .write(true)
        .open(directory.skill())
        .unwrap()
        .set_modified(modified)
        .unwrap();
    ensure(directory.data()).await.unwrap();
    assert_eq!(std::fs::read(directory.skill()).unwrap(), SKILL.as_bytes());
    assert_eq!(
        std::fs::metadata(directory.skill())
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
}

#[tokio::test]
async fn ensure_replaces_stale_bytes() {
    let directory = Directory::new();
    std::fs::create_dir_all(directory.skill().parent().unwrap()).unwrap();
    std::fs::write(directory.skill(), "synthetic stale operator skill\n").unwrap();
    ensure(directory.data()).await.unwrap();
    assert_eq!(std::fs::read(directory.skill()).unwrap(), SKILL.as_bytes());
}

#[tokio::test]
async fn ensure_replaces_invalid_utf8_bytes() {
    let directory = Directory::new();
    std::fs::create_dir_all(directory.skill().parent().unwrap()).unwrap();
    std::fs::write(directory.skill(), [0xff, 0xfe, 0xfd]).unwrap();
    ensure(directory.data()).await.unwrap();
    assert_eq!(std::fs::read(directory.skill()).unwrap(), SKILL.as_bytes());
}

#[tokio::test]
async fn ensure_propagates_a_nonmissing_read_failure() {
    let directory = Directory::new();
    std::fs::create_dir_all(directory.skill()).unwrap();
    let read = std::fs::read(directory.skill()).unwrap_err();
    assert_ne!(read.kind(), io::ErrorKind::NotFound);
    let error = ensure(directory.data()).await.unwrap_err();
    assert_eq!(error.kind(), read.kind());
}

#[tokio::test]
async fn ensure_propagates_a_blocked_ancestor_read_failure() {
    let directory = Directory::new();
    std::fs::create_dir(directory.data()).unwrap();
    std::fs::write(directory.data().join("dots"), "synthetic file\n").unwrap();
    let read = std::fs::read(directory.skill()).unwrap_err();
    assert_ne!(read.kind(), io::ErrorKind::NotFound);
    let error = ensure(directory.data()).await.unwrap_err();
    assert_eq!(error.kind(), read.kind());
}

#[cfg(unix)]
#[tokio::test]
async fn ensure_propagates_a_directory_creation_failure() {
    use std::os::unix::fs::PermissionsExt;
    let directory = Directory::new();
    std::fs::create_dir(directory.data()).unwrap();
    let missing = std::fs::read(directory.skill()).unwrap_err();
    assert_eq!(missing.kind(), io::ErrorKind::NotFound);
    let original = std::fs::metadata(directory.data()).unwrap().permissions();
    std::fs::set_permissions(directory.data(), std::fs::Permissions::from_mode(0o555)).unwrap();
    let probe = std::fs::create_dir(directory.data().join("probe"));
    let outcome = ensure(directory.data()).await;
    std::fs::set_permissions(directory.data(), original).unwrap();
    assert_eq!(probe.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(outcome.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
}

#[tokio::test]
async fn ensure_propagates_a_write_failure() {
    let directory = Directory::new();
    std::fs::create_dir_all(directory.skill().parent().unwrap()).unwrap();
    std::fs::write(directory.skill(), "synthetic stale operator skill\n").unwrap();
    let original = std::fs::metadata(directory.skill()).unwrap().permissions();
    let mut readonly = original.clone();
    readonly.set_readonly(true);
    std::fs::set_permissions(directory.skill(), readonly).unwrap();
    let outcome = ensure(directory.data()).await;
    std::fs::set_permissions(directory.skill(), original).unwrap();
    assert!(outcome.is_err());
    assert_eq!(
        std::fs::read(directory.skill()).unwrap(),
        b"synthetic stale operator skill\n"
    );
}

#[tokio::test]
async fn prepare_ensures_the_skill_before_running_next_once() {
    let directory = Directory::new();
    let skill = directory.skill();
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let next: Prepare = Box::new(move || {
        Box::pin(async move {
            counted.fetch_add(1, Ordering::SeqCst);
            assert_eq!(std::fs::read(&skill).unwrap(), SKILL.as_bytes());
            Ok(())
        })
    });
    prepare(directory.data(), next)().await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn prepare_skips_next_when_ensure_fails() {
    let directory = Directory::new();
    std::fs::create_dir_all(directory.skill()).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let Err(held) = prepare(directory.data(), next_ok(calls.clone()))().await else {
        panic!("prepare succeeded past a failed operator ensure")
    };
    assert_eq!(
        held,
        PrepareError::Held {
            reason: "operator skill provisioning failed"
        }
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn prepare_propagates_the_downstream_held_unchanged() {
    let directory = Directory::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let next: Prepare = Box::new(move || {
        Box::pin(async move {
            counted.fetch_add(1, Ordering::SeqCst);
            Err(PrepareError::Held {
                reason: "synthetic downstream hold",
            })
        })
    });
    let Err(held) = prepare(directory.data(), next)().await else {
        panic!("prepare succeeded past a downstream hold")
    };
    assert_eq!(
        held,
        PrepareError::Held {
            reason: "synthetic downstream hold"
        }
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(std::fs::read(directory.skill()).unwrap(), SKILL.as_bytes());
}
