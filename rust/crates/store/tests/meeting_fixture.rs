use rusqlite::Connection;
use std::path::Path;

pub const NOW: &str = "2026-01-01T00:00:00.000Z";
pub const MEETING: &str = r#"{"id":"m","title":"Design meeting","sessionID":"session","status":"ready","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}"#;
pub const SEGMENT: &str = r#"{"id":"s","meetingID":"m","sequence":1,"source":"remote","speakerID":"remote","startMs":100,"endMs":400,"rawText":"  สวัสดี  ","text":"สวัสดี","state":"final","model":"whisper","createdAt":"2026-01-01T00:00:00.000Z"}"#;
pub const FINDING: &str = r#"{"id":"z","meetingID":"m","kind":"decision","summary":"Use separate storage","sourceSegmentIds":["s"],"confidence":0.9,"status":"confirmed","createdAt":"2026-01-01T00:00:00.000Z"}"#;
pub const CHECKPOINT: &str = r#"{"id":"c","meetingID":"m","throughSequence":1,"summary":"Summary","final":true,"createdAt":"2026-01-01T00:00:00.000Z","latencyMs":50}"#;
pub const PROPOSAL: &str = r#"{"id":"p","meetingID":"m","server":"wiki","target":"page","operation":"replace","existingContent":"Old","suggestedContent":"New","explanation":"Agreed","sourceSegmentIds":["s"],"references":[{"server":"wiki","target":"page","revision":"1","content":"Old","retrievedAt":"2026-01-01T00:00:00.000Z"}],"expectedRevision":"1","confidence":0.9,"status":"applying","createdAt":"2026-01-01T00:00:00.000Z"}"#;
pub const PLAN: &str = r#"{"meetingID":"m","content":"Plan","findingIds":["z"],"sourceSegmentIds":["s"],"status":"approved","createdAt":"2026-01-01T00:00:00.000Z"}"#;
pub const APPROVAL: &str = r#"{"id":"a","meetingID":"m","targetID":"p","decision":"approve","detail":"Reviewed","createdAt":"2026-01-01T00:00:00.000Z"}"#;
pub const JOB: &str = r#"{"id":"j","meetingID":"m","kind":"knowledge","status":"running","attempts":1,"updatedAt":"2026-01-01T00:00:00.000Z"}"#;
pub const REFERENCE: &str = r#"{"server":"wiki","target":"page","revision":"1","content":"Original\u0000\ud800","retrievedAt":"2026-01-01T00:00:00.000Z"}"#;

pub fn generate(path: &Path) {
    let db = Connection::open(path).unwrap();
    db.execute_batch(
        "PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;
        CREATE TABLE meetings (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE TABLE segments (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, state TEXT NOT NULL, original_text TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE UNIQUE INDEX final_sequence ON segments(meeting_id,sequence) WHERE state='final';
        CREATE INDEX segment_order ON segments(meeting_id,sequence);
        CREATE TABLE knowledge_references (meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, server TEXT NOT NULL, target TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(meeting_id,server,target));
        CREATE TABLE findings (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE INDEX findings_meeting ON findings(meeting_id);
        CREATE TABLE checkpoints (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE INDEX checkpoints_meeting ON checkpoints(meeting_id);
        CREATE TABLE proposals (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE INDEX proposals_meeting ON proposals(meeting_id);
        CREATE TABLE plans (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE INDEX plans_meeting ON plans(meeting_id);
        CREATE TABLE approvals (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE INDEX approvals_meeting ON approvals(meeting_id);
        CREATE TABLE jobs (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE INDEX jobs_meeting ON jobs(meeting_id); PRAGMA user_version=1;",
    ).unwrap();
    db.execute("INSERT INTO meetings VALUES ('m',?1)", [MEETING])
        .unwrap();
    db.execute(
        "INSERT INTO segments VALUES ('s','m',1,'final','สวัสดี',?1)",
        [SEGMENT],
    )
    .unwrap();
    db.execute(
        "INSERT INTO knowledge_references VALUES ('m','wiki','page',?1)",
        [REFERENCE],
    )
    .unwrap();
    for (table, id, data) in [
        ("findings", "z", FINDING),
        ("checkpoints", "c", CHECKPOINT),
        ("proposals", "p", PROPOSAL),
        ("plans", "m", PLAN),
        ("approvals", "a", APPROVAL),
        ("jobs", "j", JOB),
    ] {
        db.execute(
            &format!("INSERT INTO {table} VALUES (?1,'m',?2)"),
            [id, data],
        )
        .unwrap();
    }
}
