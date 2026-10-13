use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use ycoding_core::meeting::store::{Change, MeetingDatabase, now};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "ycoding-meeting-facade-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&directory).unwrap();
        Self(directory)
    }

    fn file(&self) -> PathBuf {
        self.0.join("meetings.redb")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn segment(id: &str, sequence: u64, state: &str) -> Value {
    json!({
        "id": id,
        "meetingID": "m",
        "sequence": sequence,
        "source": "remote",
        "speakerID": "remote-unknown",
        "startMs": 0,
        "endMs": 900,
        "rawText": "Approve release",
        "text": "Approve release",
        "state": state,
        "model": "test-model",
        "createdAt": "2026-10-12T00:00:00.000Z",
    })
}

fn finding(id: &str) -> Value {
    json!({
        "id": id,
        "meetingID": "m",
        "kind": "decision",
        "summary": "Approve release",
        "sourceSegmentIds": ["s1"],
        "confidence": 1,
        "status": "unconfirmed",
        "createdAt": now(),
    })
}

fn job(id: &str, status: &str) -> Value {
    json!({
        "id": id,
        "meetingID": "m",
        "kind": "transcription",
        "status": status,
        "attempts": 1,
        "updatedAt": now(),
    })
}

async fn database(fixture: &Fixture) -> MeetingDatabase {
    let database = MeetingDatabase::open(&fixture.file()).unwrap();
    database
        .create_meeting("m", "Design", "session")
        .await
        .unwrap();
    database
}

#[tokio::test]
async fn creating_a_meeting_is_idempotent_and_rejects_a_changed_replay() {
    let fixture = Fixture::new();
    let database = database(&fixture).await;
    let created = database.get_meeting("m").unwrap().unwrap();
    assert_eq!(created["status"], "ready");
    assert_eq!(created["title"], "Design");
    assert_eq!(
        database
            .create_meeting("m", "Design", "session")
            .await
            .unwrap(),
        created
    );
    assert!(
        database
            .create_meeting("m", "Other", "session")
            .await
            .is_err()
    );
    assert!(
        database
            .create_meeting("m", "Design", "other")
            .await
            .is_err()
    );
    assert!(database.get_meeting("missing").unwrap().is_none());
    assert_eq!(database.list_meetings("", 10).unwrap().len(), 1);
    assert_eq!(database.list_meetings("DESIGN", 10).unwrap().len(), 1);
    assert!(database.list_meetings("absent", 10).unwrap().is_empty());
    database.close().await.unwrap();
}

#[tokio::test]
async fn updates_set_and_clear_optional_fields_without_touching_the_rest() {
    let fixture = Fixture::new();
    let database = database(&fixture).await;
    let recording = database
        .update_meeting(
            "m",
            Some("recording"),
            Change::Set("capture".into()),
            Change::Set("diagnostic".into()),
        )
        .await
        .unwrap();
    assert_eq!(recording["status"], "recording");
    assert_eq!(recording["captureID"], "capture");
    assert_eq!(recording["error"], "diagnostic");
    let kept = database
        .update_meeting("m", None, Change::Keep, Change::Clear)
        .await
        .unwrap();
    assert_eq!(kept["status"], "recording");
    assert_eq!(kept["captureID"], "capture");
    assert!(kept.get("error").is_none());
    let cleared = database
        .update_meeting("m", Some("stopped"), Change::Clear, Change::Keep)
        .await
        .unwrap();
    assert_eq!(cleared["status"], "stopped");
    assert!(cleared.get("captureID").is_none());
    let touched = database
        .update_meeting("m", None, Change::Keep, Change::Keep)
        .await
        .unwrap();
    assert_eq!(touched["status"], "stopped");
    assert_eq!(database.get_meeting("m").unwrap().unwrap(), touched);
    assert!(
        database
            .update_meeting("missing", Some("stopped"), Change::Keep, Change::Keep)
            .await
            .is_err()
    );
    assert!(
        database
            .update_meeting("m", Some("invalid"), Change::Keep, Change::Keep)
            .await
            .is_err()
    );
    database.close().await.unwrap();
}

#[tokio::test]
async fn segments_promote_correct_and_keep_final_sequences_unique_and_monotonic() {
    let fixture = Fixture::new();
    let database = database(&fixture).await;
    assert_eq!(database.next_sequence("m").unwrap(), 1);
    database
        .put_segment(&segment("s1", 1, "temporary"))
        .await
        .unwrap();
    assert_eq!(database.next_sequence("m").unwrap(), 1);
    database
        .put_segment(&segment("s1", 1, "final"))
        .await
        .unwrap();
    assert_eq!(database.next_sequence("m").unwrap(), 2);
    database
        .put_segment(&segment("s1", 1, "final"))
        .await
        .unwrap();
    database
        .correct_segment("s1", "Reject release")
        .await
        .unwrap();
    database
        .put_segment(&segment("s1", 1, "final"))
        .await
        .unwrap();
    let stored = database.segments("m", -1, 10).unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0]["text"], "Reject release");
    assert_eq!(stored[0]["rawText"], "Approve release");
    assert_eq!(stored[0]["state"], "final");

    let mut raw = segment("s1", 1, "final");
    raw["rawText"] = json!("changed");
    assert!(database.put_segment(&raw).await.is_err());
    assert!(
        database
            .put_segment(&segment("s2", 1, "final"))
            .await
            .is_err()
    );
    let mut orphan = segment("s3", 3, "final");
    orphan["meetingID"] = json!("missing");
    assert!(database.put_segment(&orphan).await.is_err());
    database
        .put_segment(&segment("s2", 2, "final"))
        .await
        .unwrap();
    database
        .put_segment(&segment("s3", 3, "temporary"))
        .await
        .unwrap();
    assert_eq!(database.segments("m", 1, 10).unwrap().len(), 2);
    assert_eq!(database.segments("m", -1, 2).unwrap().len(), 2);
    assert!(database.segments("m", -2, 2).is_err());
    assert!(database.correct_segment("missing", "x").await.is_err());
    database.close().await.unwrap();
}

#[tokio::test]
async fn child_records_round_trip_in_insertion_order_and_approvals_are_immutable() {
    let fixture = Fixture::new();
    let database = database(&fixture).await;
    database.put_finding(&finding("b")).await.unwrap();
    database.put_finding(&finding("a")).await.unwrap();
    let mut confirmed = finding("b");
    confirmed["status"] = json!("confirmed");
    database.put_finding(&confirmed).await.unwrap();
    let findings = database.findings("m").unwrap();
    assert_eq!(
        findings
            .iter()
            .map(|item| item["id"].clone())
            .collect::<Vec<_>>(),
        vec![json!("b"), json!("a")]
    );
    assert_eq!(findings[0]["status"], "confirmed");
    let mut elsewhere = finding("x");
    elsewhere["meetingID"] = json!("missing");
    assert!(database.put_finding(&elsewhere).await.is_err());

    database.put_job(&job("j", "running")).await.unwrap();
    database.put_job(&job("j", "done")).await.unwrap();
    assert_eq!(database.jobs("m").unwrap().len(), 1);
    assert_eq!(database.jobs("m").unwrap()[0]["status"], "done");

    let checkpoint = json!({
        "id": "c", "meetingID": "m", "throughSequence": 1, "summary": "Summary",
        "final": true, "createdAt": now(), "latencyMs": 5,
    });
    database.put_checkpoint(&checkpoint).await.unwrap();
    assert_eq!(database.checkpoints("m").unwrap(), vec![checkpoint]);

    let plan = json!({
        "meetingID": "m", "content": "Plan", "findingIds": [], "sourceSegmentIds": [],
        "status": "proposed", "createdAt": now(),
    });
    database.put_plan(&plan).await.unwrap();
    let mut rejected = plan.clone();
    rejected["status"] = json!("rejected");
    database.put_plan(&rejected).await.unwrap();
    assert_eq!(database.plan("m").unwrap().unwrap()["status"], "rejected");

    let approval = json!({
        "id": "p", "meetingID": "m", "targetID": "b", "decision": "approve",
        "detail": "Approve release", "createdAt": now(),
    });
    database.put_approval(&approval).await.unwrap();
    database.put_approval(&approval).await.unwrap();
    let mut changed = approval.clone();
    changed["decision"] = json!("reject");
    assert!(database.put_approval(&changed).await.is_err());
    assert_eq!(database.approvals("m").unwrap().len(), 1);

    let proposal = json!({
        "id": "q", "meetingID": "m", "server": "wiki", "target": "page", "operation": "replace",
        "existingContent": "old", "suggestedContent": "new", "explanation": "why",
        "sourceSegmentIds": ["s1"], "references": [], "expectedRevision": "1",
        "confidence": 0.5, "status": "pending", "createdAt": now(),
    });
    database.put_proposal(&proposal).await.unwrap();
    assert_eq!(database.proposals("m").unwrap(), vec![proposal]);

    let reference = json!({
        "server": "wiki", "target": "page", "revision": "1", "content": "old", "retrievedAt": now(),
    });
    database.put_reference("m", &reference).await.unwrap();
    assert_eq!(database.references("m").unwrap(), vec![reference]);
    database.close().await.unwrap();
}

#[tokio::test]
async fn recovery_interrupts_capture_running_jobs_and_applying_proposals_after_restart() {
    let fixture = Fixture::new();
    let database = database(&fixture).await;
    database
        .update_meeting(
            "m",
            Some("recording"),
            Change::Set("capture".into()),
            Change::Set("earlier".into()),
        )
        .await
        .unwrap();
    database.put_job(&job("running", "running")).await.unwrap();
    database.put_job(&job("done", "done")).await.unwrap();
    database
        .put_proposal(&json!({
            "id": "q", "meetingID": "m", "server": "wiki", "target": "page", "operation": "replace",
            "existingContent": "old", "suggestedContent": "new", "explanation": "why",
            "sourceSegmentIds": [], "references": [], "expectedRevision": "1",
            "confidence": 0.5, "status": "applying", "createdAt": now(),
        }))
        .await
        .unwrap();
    database.close().await.unwrap();

    let reopened = MeetingDatabase::open(&fixture.file()).unwrap();
    assert_eq!(
        reopened.get_meeting("m").unwrap().unwrap()["status"],
        "recording"
    );
    reopened.recover().await.unwrap();
    let meeting = reopened.get_meeting("m").unwrap().unwrap();
    assert_eq!(meeting["status"], "interrupted");
    assert_eq!(
        meeting["error"],
        "earlier; Capture interrupted; volatile raw audio is unavailable after restart"
    );
    let jobs = reopened.jobs("m").unwrap();
    assert_eq!(jobs[0]["status"], "interrupted");
    assert_eq!(jobs[0]["error"], "Processing interrupted by restart");
    assert_eq!(jobs[1]["status"], "done");
    assert_eq!(reopened.proposals("m").unwrap()[0]["status"], "uncertain");
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn deletion_and_retention_erase_data_and_the_facade_keeps_serving_the_replacement_file() {
    let fixture = Fixture::new();
    let database = database(&fixture).await;
    database
        .create_meeting("old", "Old", "session")
        .await
        .unwrap();
    database
        .put_segment(&segment("s1", 1, "final"))
        .await
        .unwrap();
    assert!(database.delete_meeting("old").await.unwrap());
    assert!(!database.delete_meeting("old").await.unwrap());
    assert!(database.get_meeting("old").unwrap().is_none());
    assert_eq!(database.segments("m", -1, 10).unwrap().len(), 1);
    database
        .update_meeting("m", Some("stopped"), Change::Keep, Change::Keep)
        .await
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    database.retain(0.0).await.unwrap();
    assert!(database.get_meeting("m").unwrap().is_none());
    database
        .create_meeting("fresh", "Fresh", "session")
        .await
        .unwrap();
    database.retain(1.0).await.unwrap();
    assert!(database.get_meeting("fresh").unwrap().is_some());
    assert!(database.retain(-1.0).await.is_err());
    database.close().await.unwrap();

    let reopened = MeetingDatabase::open(&fixture.file()).unwrap();
    assert!(reopened.get_meeting("fresh").unwrap().is_some());
    assert!(reopened.get_meeting("m").unwrap().is_none());
    assert!(reopened.get_meeting("old").unwrap().is_none());
    reopened.close().await.unwrap();
    assert!(
        !PathBuf::from(format!("{}.erasure", fixture.file().display())).exists(),
        "erasure staging directory must be removed"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn the_database_is_private_single_owner_and_closed_stores_reject_operations() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let database = database(&fixture).await;
    let mode =
        |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&fixture.file()), 0o600);
    assert_eq!(mode(&fixture.0), 0o700);
    assert!(MeetingDatabase::open(&fixture.file()).is_err());
    database.close().await.unwrap();
    database.close().await.unwrap();
    assert!(database.get_meeting("m").is_err());
    assert!(database.create_meeting("n", "N", "s").await.is_err());
    assert!(MeetingDatabase::open(&fixture.file()).is_ok());
}
