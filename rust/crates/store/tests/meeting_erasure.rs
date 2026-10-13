use std::collections::hash_map::RandomState;
use std::hash::BuildHasher;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use ycoding_schema::{JsonObject, JsonValue, parse_json};
use ycoding_store::{Metadata, meeting};

static NEXT: AtomicU64 = AtomicU64::new(0);
const NOW: &str = "2026-01-01T00:00:00.000Z";

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "meeting-erasure-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn file(&self) -> PathBuf {
        self.0.join("meetings.redb")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn marker() -> String {
    let random = RandomState::new();
    format!(
        "MEETING_ERASURE_{:016x}{:016x}",
        random.hash_one(0),
        random.hash_one(1)
    )
}

fn put(
    tx: &mut ycoding_store::Write<'_>,
    id: &str,
    marker: &str,
    now: &str,
) -> Result<(), ycoding_store::Error> {
    let mut value = JsonObject::new();
    value.insert("id".into(), JsonValue::String(id.into()));
    value.insert("title".into(), JsonValue::String(marker.into()));
    value.insert(
        "sessionID".into(),
        JsonValue::String("synthetic-session".into()),
    );
    meeting::create_meeting(tx, &JsonValue::Object(value), now)?;
    let segment = parse_json(&format!(r#"{{"id":"{id}-segment","meetingID":"{id}","sequence":1,"source":"remote","speakerID":"speaker","startMs":0,"endMs":1,"rawText":"{marker}","text":"{marker}","state":"final","model":"synthetic-model","createdAt":"{now}"}}"#)).unwrap();
    meeting::put_segment(tx, &segment)?;
    let finding = parse_json(&format!(r#"{{"id":"{id}-finding","meetingID":"{id}","kind":"topic","summary":"{marker}","sourceSegmentIds":["{id}-segment"],"confidence":1,"status":"confirmed","createdAt":"{now}"}}"#)).unwrap();
    meeting::put_finding(tx, &finding)
}

fn contains(bytes: &[u8], marker: &str) -> bool {
    let utf16 = marker
        .encode_utf16()
        .flat_map(u16::to_be_bytes)
        .collect::<Vec<_>>();
    bytes
        .windows(marker.len())
        .any(|window| window == marker.as_bytes())
        || bytes.windows(utf16.len()).any(|window| window == utf16)
}

#[test]
fn committed_meeting_deletion_erases_random_payload_markers_and_preserves_survivors() {
    let fixture = Fixture::new();
    let mut store =
        meeting::MeetingStore::initialize(fixture.file(), Metadata::new([8; 16], 3)).unwrap();
    let removed = marker();
    let survivor = marker();
    let a = removed.clone();
    let b = survivor.clone();
    store
        .submit(move |tx| {
            put(tx, "removed", &a, NOW)?;
            put(tx, "survivor", &b, NOW)
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(contains(&std::fs::read(fixture.file()).unwrap(), &removed));
    assert!(contains(&std::fs::read(fixture.file()).unwrap(), &survivor));
    let mut old_inode = std::fs::File::open(fixture.file()).unwrap();
    store.delete_meeting("removed".into()).unwrap();
    let mut old_bytes = Vec::new();
    std::io::Read::read_to_end(&mut old_inode, &mut old_bytes).unwrap();
    assert!(
        old_bytes.iter().all(|byte| *byte == 0),
        "old database inode was unlinked without overwriting"
    );
    assert_eq!(store.metadata(), &Metadata::new([8; 16], 3));
    store.shutdown().unwrap();
    let bytes = std::fs::read(fixture.file()).unwrap();
    assert!(
        !contains(&bytes, &removed),
        "deleted payload remains in database file"
    );
    assert!(contains(&bytes, &survivor));
    let reopened = meeting::MeetingStore::open(fixture.file()).unwrap();
    assert!(
        meeting::get_meeting(&reopened.snapshot().unwrap(), &"removed".into())
            .unwrap()
            .is_none()
    );
    assert!(
        meeting::get_meeting(&reopened.snapshot().unwrap(), &"survivor".into())
            .unwrap()
            .is_some()
    );
}

fn disk_files(path: &std::path::Path) -> Vec<PathBuf> {
    std::fs::read_dir(path)
        .unwrap()
        .flat_map(|entry| {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                return disk_files(&entry.path());
            }
            vec![entry.path()]
        })
        .collect()
}

fn absent_everywhere(fixture: &Fixture, marker: &str) {
    for path in disk_files(&fixture.0) {
        assert!(
            !contains(&std::fs::read(&path).unwrap(), marker),
            "deleted marker remains in {path:?}"
        );
    }
}

#[test]
fn retention_erases_expired_payloads_but_keeps_recording_and_recent_payloads() {
    let fixture = Fixture::new();
    let mut store =
        meeting::MeetingStore::initialize(fixture.file(), Metadata::new([8; 16], 3)).unwrap();
    let removed = marker();
    let active = marker();
    let recent = marker();
    let a = removed.clone();
    let b = active.clone();
    let c = recent.clone();
    store
        .submit(move |tx| {
            put(tx, "expired", &a, "2000-01-01T00:00:00.000Z")?;
            put(tx, "active", &b, "2000-01-01T00:00:00.000Z")?;
            meeting::update_meeting(
                tx,
                &"active".into(),
                &parse_json(r#"{"status":"recording"}"#).unwrap(),
                "2000-01-01T00:00:00.000Z",
            )?;
            put(tx, "recent", &c, NOW)
        })
        .unwrap()
        .wait()
        .unwrap();
    store.retain(30.0, 1_767_225_600_000).unwrap();
    absent_everywhere(&fixture, &removed);
    let bytes = std::fs::read(fixture.file()).unwrap();
    assert!(contains(&bytes, &active));
    assert!(contains(&bytes, &recent));
    store.shutdown().unwrap();
    let reopened = meeting::MeetingStore::open(fixture.file()).unwrap();
    let snapshot = reopened.snapshot().unwrap();
    assert!(
        meeting::get_meeting(&snapshot, &"expired".into())
            .unwrap()
            .is_none()
    );
    assert!(
        meeting::get_meeting(&snapshot, &"active".into())
            .unwrap()
            .is_some()
    );
    assert!(
        meeting::get_meeting(&snapshot, &"recent".into())
            .unwrap()
            .is_some()
    );
}

#[test]
fn erasure_requires_exclusive_snapshots_and_closes_old_client_admission() {
    let fixture = Fixture::new();
    let mut store =
        meeting::MeetingStore::initialize(fixture.file(), Metadata::new([8; 16], 3)).unwrap();
    let removed = marker();
    let value = removed.clone();
    store
        .submit(move |tx| put(tx, "removed", &value, NOW))
        .unwrap()
        .wait()
        .unwrap();
    let old_client = store.client();
    let snapshot = store.snapshot().unwrap();
    assert!(matches!(
        store.delete_meeting("removed".into()),
        Err(ycoding_store::Error::Domain {
            kind: "database_busy",
            ..
        })
    ));
    assert!(
        meeting::get_meeting(&snapshot, &"removed".into())
            .unwrap()
            .is_some()
    );
    assert!(matches!(
        old_client.submit(|_| Ok(())),
        Err(ycoding_store::Error::Closed)
    ));
    drop(snapshot);
    store.erase().unwrap();
    assert!(
        meeting::get_meeting(&store.snapshot().unwrap(), &"removed".into())
            .unwrap()
            .is_some()
    );
    store.delete_meeting("removed".into()).unwrap();
    absent_everywhere(&fixture, &removed);
}

#[test]
fn owner_lock_unowned_stage_and_late_failure_are_fail_closed_and_recoverable() {
    let fixture = Fixture::new();
    let mut store =
        meeting::MeetingStore::initialize(fixture.file(), Metadata::new([8; 16], 3)).unwrap();
    assert!(meeting::MeetingStore::open(fixture.file()).is_err());
    let removed = marker();
    let value = removed.clone();
    store
        .submit(move |tx| put(tx, "removed", &value, NOW))
        .unwrap()
        .wait()
        .unwrap();
    let result = store.delete_meeting_with_progress("removed".into(), |phase| {
        if phase == meeting::ErasurePhase::Published {
            return Err(ycoding_store::Error::Rejected(
                "synthetic post-publication failure",
            ));
        }
        Ok(())
    });
    assert!(result.is_err());
    assert!(
        disk_files(&fixture.0)
            .iter()
            .any(|path| contains(&std::fs::read(path).unwrap(), &removed))
    );
    store.shutdown().unwrap();
    let store = meeting::MeetingStore::open(fixture.file()).unwrap();
    absent_everywhere(&fixture, &removed);
    store.shutdown().unwrap();
    let stage = fixture.0.join("meetings.redb.erasure");
    std::fs::create_dir(&stage).unwrap();
    std::fs::write(stage.join("unowned.txt"), b"do not remove").unwrap();
    assert!(meeting::MeetingStore::open(fixture.file()).is_err());
    assert_eq!(
        std::fs::read(stage.join("unowned.txt")).unwrap(),
        b"do not remove"
    );
}

#[cfg(unix)]
#[test]
fn dangling_lock_symlink_cannot_create_or_chmod_a_filesystem_owned_target() {
    let fixture = Fixture::new();
    let target = fixture.0.join("filesystem-owned-target");
    std::os::unix::fs::symlink(&target, fixture.0.join("meetings.redb.erasure.lock")).unwrap();
    assert!(meeting::MeetingStore::initialize(fixture.file(), Metadata::new([8; 16], 3)).is_err());
    assert!(!target.exists());
    assert!(!fixture.file().exists());
}

#[cfg(unix)]
#[test]
fn forged_staging_hardlink_cannot_scrub_a_filesystem_owned_file() {
    let fixture = Fixture::new();
    meeting::MeetingStore::initialize(fixture.file(), Metadata::new([8; 16], 3))
        .unwrap()
        .shutdown()
        .unwrap();
    let target = fixture.0.join("filesystem-owned-target");
    std::fs::write(&target, b"filesystem-owned payload must survive").unwrap();
    let stage = fixture.0.join("meetings.redb.erasure");
    std::fs::create_dir(&stage).unwrap();
    std::fs::hard_link(&target, stage.join("candidate-1-1.redb")).unwrap();
    assert!(meeting::MeetingStore::open(fixture.file()).is_err());
    assert_eq!(
        std::fs::read(target).unwrap(),
        b"filesystem-owned payload must survive"
    );
}

#[test]
fn process_crash_at_each_erasure_step_leaves_a_consistent_selected_database_and_recovery_erases_owned_copies()
 {
    for phase in [
        meeting::ErasurePhase::Prepared,
        meeting::ErasurePhase::Committed,
        meeting::ErasurePhase::CandidateCreated,
        meeting::ErasurePhase::CopyBatch,
        meeting::ErasurePhase::Verified,
        meeting::ErasurePhase::Linked,
        meeting::ErasurePhase::Published,
        meeting::ErasurePhase::Scrubbing,
        meeting::ErasurePhase::Scrubbed,
        meeting::ErasurePhase::Unlinked,
        meeting::ErasurePhase::Finished,
    ] {
        let fixture = Fixture::new();
        let store =
            meeting::MeetingStore::initialize(fixture.file(), Metadata::new([8; 16], 3)).unwrap();
        let removed = marker();
        let survivor = marker();
        let a = removed.clone();
        let b = survivor.clone();
        store
            .submit(move |tx| {
                put(tx, "removed", &a, NOW)?;
                put(tx, "survivor", &b, NOW)
            })
            .unwrap()
            .wait()
            .unwrap();
        store.shutdown().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "erasure_process_worker", "--ignored"])
            .env("YCODING_MEETING_ERASURE_FILE", fixture.file())
            .env("YCODING_MEETING_ERASURE_PHASE", format!("{phase:?}"))
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(83), "phase {phase:?}");
        {
            let selected = meeting::open(fixture.file()).unwrap();
            let snapshot = selected.snapshot().unwrap();
            let present = phase == meeting::ErasurePhase::Prepared;
            assert_eq!(
                meeting::get_meeting(&snapshot, &"removed".into())
                    .unwrap()
                    .is_some(),
                present
            );
            assert_eq!(
                meeting::segments(&snapshot, &"removed".into(), -1, 10)
                    .unwrap()
                    .len(),
                usize::from(present)
            );
            assert_eq!(
                meeting::findings(&snapshot, &"removed".into())
                    .unwrap()
                    .len(),
                usize::from(present)
            );
            assert!(
                meeting::get_meeting(&snapshot, &"survivor".into())
                    .unwrap()
                    .is_some()
            );
            assert_eq!(
                meeting::next_sequence(&snapshot, &"survivor".into()).unwrap(),
                2
            );
        }
        let recovered = meeting::MeetingStore::open(fixture.file()).unwrap();
        assert_eq!(recovered.metadata(), &Metadata::new([8; 16], 3));
        if phase != meeting::ErasurePhase::Prepared {
            absent_everywhere(&fixture, &removed);
        }
        assert!(contains(&std::fs::read(fixture.file()).unwrap(), &survivor));
        assert!(!fixture.0.join("meetings.redb.erasure").exists());
    }
}

#[test]
#[ignore = "subprocess-only abrupt-exit fixture"]
fn erasure_process_worker() {
    let file = std::env::var_os("YCODING_MEETING_ERASURE_FILE").unwrap();
    let target = std::env::var("YCODING_MEETING_ERASURE_PHASE").unwrap();
    let mut store = meeting::MeetingStore::open(file).unwrap();
    store
        .delete_meeting_with_progress("removed".into(), |phase| {
            if format!("{phase:?}") == target {
                std::process::exit(83);
            }
            Ok(())
        })
        .unwrap();
    panic!("requested crash phase was not reached");
}
