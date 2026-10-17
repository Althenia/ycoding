use super::{Inner, Limits, Options, Request};
use std::{fs, path::PathBuf, sync::Arc};
use tokio::sync::oneshot::error::TryRecvError;

struct Directory(PathBuf);

impl Directory {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "ycoding-queue-settlement-{}",
            super::memory::random_uuid().unwrap()
        ));
        fs::create_dir_all(&directory).unwrap();
        Self(directory)
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn enqueue(inner: &Arc<Inner>, id: &str) -> super::EnqueueReceipt {
    inner
        .enqueue(Request {
            id: id.into(),
            session_id: id.into(),
            command: id.into(),
            cwd: inner.dir.clone(),
            admission: None,
            memory_limit_mb: None,
            resident_mb: None,
            limits: Limits {
                max_running: 1,
                ..Limits::default()
            },
        })
        .unwrap()
}

#[test]
fn directory_replacement_during_a_pass_preserves_waiting_ownership() {
    for restore_before_settlement in [false, true] {
        let directory = Directory::new();
        let inner = Arc::new(Inner::new(Options::new(directory.0.join("queue"))));
        let (_, _, mut holder) = enqueue(&inner, "sh_holder");
        inner.pass();
        assert_eq!(holder.try_recv(), Ok(Ok(())));
        let (_, _, mut waiting) = enqueue(&inner, "sh_waiting");
        inner.register().unwrap();
        fs::rename(&inner.dir, directory.0.join("lost")).unwrap();
        let snapshot = inner.snapshot();
        if restore_before_settlement {
            inner.register().unwrap();
        }
        inner.settle(&snapshot);
        assert_eq!(waiting.try_recv(), Err(TryRecvError::Empty));
        assert!(super::lock(&inner.state).waiters.contains_key("sh_waiting"));
        inner.register().unwrap();
        assert!(inner.entry_file("sh_holder").exists());
        assert!(inner.entry_file("sh_waiting").exists());
        inner.pass();
        assert_eq!(waiting.try_recv(), Err(TryRecvError::Empty));
        inner.release("sh_holder");
        inner.pass();
        assert_eq!(waiting.try_recv(), Ok(Ok(())));
        inner.release("sh_waiting");
    }
}

#[test]
fn missing_entry_in_the_registered_directory_settles_as_lost() {
    let directory = Directory::new();
    let inner = Arc::new(Inner::new(Options::new(directory.0.join("queue"))));
    let (_, _, mut waiting) = enqueue(&inner, "sh_waiting");
    inner.register().unwrap();
    fs::remove_file(inner.entry_file("sh_waiting")).unwrap();
    inner.settle(&inner.snapshot());
    assert_eq!(waiting.try_recv().unwrap().unwrap_err().id, "sh_waiting");
    inner.release("sh_waiting");
}
