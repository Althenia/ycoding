use redb::{ReadableDatabase, TableHandle};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use ycoding_schema::{JsonValue, parse_json};
use ycoding_store::{Catalog, Metadata, Options, Store, TableSpec, meeting};

#[path = "meeting_fixture.rs"]
mod fixture;

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "ycoding-meeting-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&directory).unwrap();
        Self(directory)
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

#[test]
fn meeting_catalog_contains_all_nine_tables_and_no_core_tables() {
    let fixture = Fixture::new();
    fixture::generate(&fixture.0.join("meetings.sqlite"));
    let store = meeting::initialize(fixture.file(), Metadata::new([9; 16], 1)).unwrap();
    store.shutdown().unwrap();
    let db = redb::Database::open(fixture.file()).unwrap();
    let names = db
        .begin_read()
        .unwrap()
        .list_tables()
        .unwrap()
        .map(|table| table.name().to_owned())
        .collect::<Vec<_>>();
    for name in [
        "meetings",
        "segments",
        "knowledge_references",
        "findings",
        "checkpoints",
        "proposals",
        "plans",
        "approvals",
        "jobs",
    ] {
        assert!(
            names.iter().any(|actual| actual == name),
            "missing Meeting table: {name}"
        );
    }
    assert!(
        !names
            .iter()
            .any(|name| name == "session" || name == "project")
    );
}

fn json(value: &str) -> JsonValue {
    parse_json(value).unwrap()
}
fn field<'a>(value: &'a JsonValue, name: &str) -> &'a JsonValue {
    let JsonValue::Object(object) = value else {
        panic!("expected object")
    };
    object.get(&name.into()).unwrap()
}
fn changed(mut value: JsonValue, name: &str, replacement: JsonValue) -> JsonValue {
    let JsonValue::Object(object) = &mut value else {
        panic!("expected object")
    };
    object.insert(name.into(), replacement);
    value
}

#[test]
fn segment_replay_correction_promotion_sequence_and_restart_match_sqlite() {
    let fixture = Fixture::new();
    let store = meeting::initialize(fixture.file(), Metadata::new([9; 16], 1)).unwrap();
    store
        .submit(|tx| {
            meeting::create_meeting(
                tx,
                &json(r#"{"id":"m","title":"Design meeting","sessionID":"session"}"#),
                fixture::NOW,
            )?;
            meeting::put_segment(tx, &json(fixture::SEGMENT))?;
            meeting::put_segment(tx, &json(fixture::SEGMENT))?;
            meeting::correct_segment(tx, &"s".into(), &"Corrected".into())?;
            meeting::put_segment(tx, &json(fixture::SEGMENT))
        })
        .unwrap()
        .wait()
        .unwrap();
    for (name, replacement) in [
        ("rawText", JsonValue::String("changed".into())),
        ("meetingID", JsonValue::String("missing".into())),
    ] {
        let value = changed(json(fixture::SEGMENT), name, replacement);
        assert!(
            store
                .submit(move |tx| meeting::put_segment(tx, &value))
                .unwrap()
                .wait()
                .is_err()
        );
    }
    let duplicate = changed(
        json(fixture::SEGMENT),
        "id",
        JsonValue::String("duplicate".into()),
    );
    assert!(
        store
            .submit(move |tx| meeting::put_segment(tx, &duplicate))
            .unwrap()
            .wait()
            .is_err()
    );
    store
        .submit(|tx| {
            let later = changed(
                changed(
                    json(fixture::SEGMENT),
                    "id",
                    JsonValue::String("later".into()),
                ),
                "sequence",
                JsonValue::Number(3.0),
            );
            meeting::put_segment(tx, &later)
        })
        .unwrap()
        .wait()
        .unwrap();
    let earlier = changed(
        changed(
            json(fixture::SEGMENT),
            "id",
            JsonValue::String("earlier".into()),
        ),
        "sequence",
        JsonValue::Number(2.0),
    );
    assert!(
        store
            .submit(move |tx| meeting::put_segment(tx, &earlier))
            .unwrap()
            .wait()
            .is_err()
    );
    store
        .submit(|tx| {
            let temporary = changed(
                changed(
                    changed(
                        json(fixture::SEGMENT),
                        "id",
                        JsonValue::String("temporary".into()),
                    ),
                    "sequence",
                    JsonValue::Number(4.0),
                ),
                "state",
                JsonValue::String("temporary".into()),
            );
            meeting::put_segment(tx, &temporary)?;
            meeting::put_segment(
                tx,
                &changed(temporary, "state", JsonValue::String("final".into())),
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    store.shutdown().unwrap();
    let reopened = meeting::open(fixture.file()).unwrap();
    let snapshot = reopened.snapshot().unwrap();
    assert_eq!(
        field(
            &meeting::segments(&snapshot, &"m".into(), -1, 10).unwrap()[0],
            "text"
        ),
        &JsonValue::String("Corrected".into())
    );
    assert_eq!(
        field(
            &meeting::segments(&snapshot, &"m".into(), 1, 1).unwrap()[0],
            "id"
        ),
        &JsonValue::String("later".into())
    );
    assert_eq!(meeting::next_sequence(&snapshot, &"m".into()).unwrap(), 5);
    assert!(meeting::segments(&snapshot, &"m".into(), -2, 1).is_err());
    assert!(meeting::segments(&snapshot, &"m".into(), -1, 9_007_199_254_740_992).is_err());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(fixture.file())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&fixture.0).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}

#[test]
fn documents_identity_ownership_approval_history_and_atomic_failure_are_enforced() {
    let fixture = Fixture::new();
    let store = meeting::initialize(fixture.file(), Metadata::new([8; 16], 3)).unwrap();
    store
        .submit(|tx| {
            meeting::create_meeting(
                tx,
                &json(r#"{"id":"m","title":"Design meeting","sessionID":"session"}"#),
                fixture::NOW,
            )?;
            meeting::put_approval(tx, &json(fixture::APPROVAL))?;
            meeting::put_approval(tx, &json(fixture::APPROVAL))?;
            meeting::put_finding(tx, &json(fixture::FINDING))?;
            let next = changed(json(fixture::FINDING), "id", JsonValue::String("a".into()));
            meeting::put_finding(tx, &next)?;
            meeting::put_finding(
                tx,
                &changed(
                    json(fixture::FINDING),
                    "summary",
                    JsonValue::String("Updated".into()),
                ),
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let changed_approval = changed(
        json(fixture::APPROVAL),
        "decision",
        JsonValue::String("reject".into()),
    );
    assert!(
        store
            .submit(move |tx| meeting::put_approval(tx, &changed_approval))
            .unwrap()
            .wait()
            .is_err()
    );
    let reassigned = changed(
        json(fixture::FINDING),
        "meetingID",
        JsonValue::String("other".into()),
    );
    assert!(
        store
            .submit(move |tx| {
                meeting::create_meeting(
                    tx,
                    &json(r#"{"id":"other","title":"Other","sessionID":"session"}"#),
                    fixture::NOW,
                )?;
                meeting::put_finding(tx, &reassigned)
            })
            .unwrap()
            .wait()
            .is_err()
    );
    let invalid = meeting::Meeting {
        id: "bad".into(),
        data: "not json".into(),
    };
    assert!(meeting::MeetingTable::encode(&invalid).is_err());
    let incomplete = meeting::Segment {
        id: "s".into(),
        meeting_id: "m".into(),
        sequence: 1,
        state: "final".into(),
        original_text: "".into(),
        data: r#"{"id":"s","meetingID":"m"}"#.into(),
    };
    assert!(meeting::SegmentTable::encode(&incomplete).is_err());
    let invalid = changed(json(fixture::SEGMENT), "endMs", JsonValue::Number(0.0));
    assert!(
        store
            .submit(move |tx| meeting::put_segment(tx, &invalid))
            .unwrap()
            .wait()
            .is_err()
    );
    let orphan = changed(
        json(fixture::SEGMENT),
        "meetingID",
        JsonValue::String("missing".into()),
    );
    assert!(
        store
            .submit(move |tx| meeting::put_segment(tx, &orphan))
            .unwrap()
            .wait()
            .is_err()
    );
    let snapshot = store.snapshot().unwrap();
    assert!(
        meeting::get_meeting(&snapshot, &"other".into())
            .unwrap()
            .is_none()
    );
    let findings = meeting::findings(&snapshot, &"m".into()).unwrap();
    assert_eq!(field(&findings[0], "id"), &JsonValue::String("z".into()));
    assert_eq!(field(&findings[1], "id"), &JsonValue::String("a".into()));
    assert_eq!(
        field(&findings[0], "summary"),
        &JsonValue::String("Updated".into())
    );
    assert_eq!(
        meeting::approvals(&snapshot, &"m".into()).unwrap(),
        vec![json(fixture::APPROVAL)]
    );
}

#[test]
fn recovery_retention_and_every_child_cascade_survive_reopen_without_touching_files() {
    let fixture = Fixture::new();
    let files = fixture.0.join("models");
    std::fs::create_dir(&files).unwrap();
    std::fs::write(files.join("synthetic.audio"), b"filesystem-owned").unwrap();
    let store = meeting::initialize(fixture.file(), Metadata::new([5; 16], 7)).unwrap();
    store
        .submit(|tx| {
            meeting::create_meeting(
                tx,
                &json(r#"{"id":"m","title":"Design meeting","sessionID":"core-does-not-exist"}"#),
                fixture::NOW,
            )?;
            meeting::update_meeting(
                tx,
                &"m".into(),
                &json(r#"{"status":"stopping","captureID":"lost","error":"Failed audio details"}"#),
                fixture::NOW,
            )?;
            meeting::put_segment(tx, &json(fixture::SEGMENT))?;
            meeting::put_reference(tx, &"m".into(), &json(fixture::REFERENCE))?;
            meeting::put_finding(tx, &json(fixture::FINDING))?;
            meeting::put_checkpoint(tx, &json(fixture::CHECKPOINT))?;
            meeting::put_proposal(tx, &json(fixture::PROPOSAL))?;
            meeting::put_plan(tx, &json(fixture::PLAN))?;
            meeting::put_approval(tx, &json(fixture::APPROVAL))?;
            meeting::put_job(tx, &json(fixture::JOB))?;
            let failed = changed(
                changed(
                    changed(json(fixture::JOB), "id", JsonValue::String("failed".into())),
                    "status",
                    JsonValue::String("failed".into()),
                ),
                "error",
                JsonValue::String("Failed audio details".into()),
            );
            meeting::put_job(tx, &failed)?;
            meeting::create_meeting(
                tx,
                &json(r#"{"id":"expired","title":"Expired","sessionID":"session"}"#),
                "2000-01-01T00:00:00.000Z",
            )?;
            meeting::create_meeting(
                tx,
                &json(r#"{"id":"active","title":"Active","sessionID":"session"}"#),
                "2000-01-01T00:00:00.000Z",
            )?;
            meeting::update_meeting(
                tx,
                &"active".into(),
                &json(r#"{"status":"recording"}"#),
                "2000-01-01T00:00:00.000Z",
            )?;
            meeting::retain(tx, 30.0, 1_767_225_600_000)
        })
        .unwrap()
        .wait()
        .unwrap();
    {
        let snapshot = store.snapshot().unwrap();
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
        assert_eq!(
            meeting::list_meetings(&snapshot, "active", 1)
                .unwrap()
                .len(),
            1
        );
    }
    store.shutdown().unwrap();
    let store = meeting::open(fixture.file()).unwrap();
    store
        .submit(|tx| meeting::recover(tx, fixture::NOW))
        .unwrap()
        .wait()
        .unwrap();
    store
        .submit(|tx| meeting::recover(tx, fixture::NOW))
        .unwrap()
        .wait()
        .unwrap();
    {
        let snapshot = store.snapshot().unwrap();
        let meeting = meeting::get_meeting(&snapshot, &"m".into())
            .unwrap()
            .unwrap();
        assert_eq!(
            field(&meeting, "status"),
            &JsonValue::String("interrupted".into())
        );
        assert_eq!(field(&meeting, "error"), &JsonValue::String("Failed audio details; Capture interrupted; volatile raw audio is unavailable after restart".into()));
        assert_eq!(
            field(&meeting::jobs(&snapshot, &"m".into()).unwrap()[0], "status"),
            &JsonValue::String("interrupted".into())
        );
        assert_eq!(
            field(&meeting::jobs(&snapshot, &"m".into()).unwrap()[1], "error"),
            &JsonValue::String("Failed audio details".into())
        );
        assert_eq!(
            field(
                &meeting::proposals(&snapshot, &"m".into()).unwrap()[0],
                "status"
            ),
            &JsonValue::String("uncertain".into())
        );
        assert!(meeting::plan(&snapshot, &"m".into()).unwrap().is_some());
        assert_eq!(
            meeting::references(&snapshot, &"m".into()).unwrap(),
            vec![json(fixture::REFERENCE)]
        );
        assert_eq!(store.metadata().generation, 7);
    }
    store
        .submit(|tx| meeting::delete_meeting(tx, &"m".into()))
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert!(
        meeting::segments(&snapshot, &"m".into(), -1, 100)
            .unwrap()
            .is_empty()
    );
    assert!(
        meeting::references(&snapshot, &"m".into())
            .unwrap()
            .is_empty()
    );
    assert!(
        meeting::findings(&snapshot, &"m".into())
            .unwrap()
            .is_empty()
    );
    assert!(
        meeting::checkpoints(&snapshot, &"m".into())
            .unwrap()
            .is_empty()
    );
    assert!(
        meeting::proposals(&snapshot, &"m".into())
            .unwrap()
            .is_empty()
    );
    assert!(meeting::plan(&snapshot, &"m".into()).unwrap().is_none());
    assert!(
        meeting::approvals(&snapshot, &"m".into())
            .unwrap()
            .is_empty()
    );
    assert!(meeting::jobs(&snapshot, &"m".into()).unwrap().is_empty());
    assert!(
        meeting::get_meeting(&snapshot, &"active".into())
            .unwrap()
            .is_some()
    );
    assert_eq!(
        std::fs::read(files.join("synthetic.audio")).unwrap(),
        b"filesystem-owned"
    );
}

#[test]
fn core_and_meeting_transactions_catalogs_generations_and_recovery_are_isolated() {
    let fixture = Fixture::new();
    let core_file = fixture.0.join("core.redb");
    let core_catalog = ycoding_store::import::catalog(ycoding_store::import::DatabaseKind::Core);
    let core = Store::initialize(
        &core_file,
        Options::core(),
        core_catalog,
        Metadata::new([1; 16], 8),
    )
    .unwrap();
    core.submit(|tx| {
        tx.put::<ycoding_store::resources::KvTable>(&ycoding_store::resources::Kv {
            key: "synthetic-sentinel".into(),
            value: ycoding_store::session::Document::new(json(r#"{"sentinel":"untouched"}"#))?,
            time_created: 0,
            time_updated: 0,
        })
    })
    .unwrap()
    .wait()
    .unwrap();
    let meeting = meeting::initialize(fixture.file(), Metadata::new([2; 16], 3)).unwrap();
    assert!(
        core.submit(|tx| tx.put::<meeting::MeetingTable>(&meeting::Meeting {
            id: "m".into(),
            data: fixture::MEETING.into()
        }))
        .unwrap()
        .wait()
        .is_err()
    );
    assert!(
        meeting
            .snapshot()
            .unwrap()
            .scan::<ycoding_store::session::SessionTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                1
            )
            .is_err()
    );
    meeting
        .submit(|tx| meeting::recover(tx, fixture::NOW))
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(core.metadata(), &Metadata::new([1; 16], 8));
    assert_eq!(meeting.metadata(), &Metadata::new([2; 16], 3));
    core.shutdown().unwrap();
    meeting.shutdown().unwrap();
    {
        let db = redb::Database::open(fixture.file()).unwrap();
        let tx = db.begin_write().unwrap();
        {
            let mut table = tx
                .open_table(redb::TableDefinition::<&[u8], &[u8]>::new(
                    "storage_metadata",
                ))
                .unwrap();
            table
                .insert(b"generation".as_slice(), 17_u64.to_be_bytes().as_slice())
                .unwrap();
        }
        tx.commit().unwrap();
    }
    let restored = meeting::open(fixture.file()).unwrap();
    assert_eq!(restored.metadata(), &Metadata::new([2; 16], 17));
    restored
        .submit(|tx| meeting::recover(tx, fixture::NOW))
        .unwrap()
        .wait()
        .unwrap();
    restored.shutdown().unwrap();
    let core = Store::open(&core_file, Options::core(), core_catalog).unwrap();
    assert_eq!(core.metadata(), &Metadata::new([1; 16], 8));
    assert_eq!(
        core.snapshot()
            .unwrap()
            .get::<ycoding_store::resources::KvTable>(&ycoding_store::tuple_key(&[
                ycoding_store::KeyPart::String(&"synthetic-sentinel".into())
            ]))
            .unwrap()
            .unwrap()
            .value
            .value(),
        &json(r#"{"sentinel":"untouched"}"#)
    );
    core.shutdown().unwrap();
    assert!(Store::open(fixture.file(), Options::core(), Catalog::EMPTY).is_err());
    assert!(meeting::open(&core_file).is_err());
    assert!(meeting::initialize(":memory:", Metadata::new([3; 16], 1)).is_err());
    assert!(meeting::initialize("", Metadata::new([3; 16], 1)).is_err());
    assert!(meeting::open(fixture.0.join("missing.redb")).is_err());
}

#[test]
fn meeting_location_realpath_hash_and_data_home_match_ts_without_creating_resources() {
    let fixture = Fixture::new();
    let location = fixture.0.join("project");
    std::fs::create_dir(&location).unwrap();
    let xdg = fixture.0.join("data");
    let home = fixture.0.join("home");
    let directory = meeting::directory(&location, Some(&xdg), &home).unwrap();
    assert_eq!(directory.parent().unwrap(), xdg.join("ycoding/meeting"));
    assert_eq!(directory.file_name().unwrap().len(), 32);
    assert!(!directory.exists());
    assert_eq!(
        meeting::directory(&location, None, &home)
            .unwrap()
            .parent()
            .unwrap(),
        home.join(".local/share/ycoding/meeting")
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&location, fixture.0.join("alias")).unwrap();
        assert_eq!(
            meeting::directory(&fixture.0.join("alias"), Some(&xdg), &home).unwrap(),
            directory
        );
        assert_eq!(
            meeting::directory(
                std::path::Path::new("/"),
                Some(std::path::Path::new("/synthetic/data")),
                &home
            )
            .unwrap(),
            PathBuf::from("/synthetic/data/ycoding/meeting/8a5edab282632443219e051e4ade2d1d")
        );
    }
    assert!(meeting::directory(&fixture.0.join("missing"), Some(&xdg), &home).is_err());
}

#[test]
fn sqlite_ascii_search_binary_order_optional_clearing_and_replay_match_ts() {
    let fixture = Fixture::new();
    fixture::generate(&fixture.0.join("oracle.sqlite"));
    let db = rusqlite::Connection::open(fixture.0.join("oracle.sqlite")).unwrap();
    let store = meeting::initialize(fixture.file(), Metadata::new([8; 16], 1)).unwrap();
    for (id, title) in [
        ("\u{e000}", "ÄBC\u{0000}DEF"),
        ("\u{10000}", "ÄBC\u{0000}DEF"),
    ] {
        let mut input = ycoding_schema::JsonObject::new();
        input.insert("id".into(), JsonValue::String(id.into()));
        input.insert("title".into(), JsonValue::String(title.into()));
        input.insert("sessionID".into(), JsonValue::String("session".into()));
        store
            .submit(move |tx| meeting::create_meeting(tx, &JsonValue::Object(input), fixture::NOW))
            .unwrap()
            .wait()
            .unwrap();
    }
    let snapshot = store.snapshot().unwrap();
    let results = meeting::list_meetings(&snapshot, "", 10).unwrap();
    assert_eq!(
        field(&results[0], "id"),
        &JsonValue::String("\u{e000}".into())
    );
    assert_eq!(
        field(&results[1], "id"),
        &JsonValue::String("\u{10000}".into())
    );
    for query in ["bc", "ä", "Ä", "DEF", "\u{0000}def", "not present"] {
        let oracle = db
            .query_row(
                "SELECT instr(lower(json_extract(?1,'$.title')),lower(?2))>0",
                rusqlite::params![ycoding_schema::stringify_json(&results[0]), query],
                |row| row.get::<_, bool>(0),
            )
            .unwrap();
        assert_eq!(
            meeting::list_meetings(&snapshot, query, 10).unwrap().len(),
            if oracle { 2 } else { 0 },
            "query: {query:?}"
        );
    }
    drop(snapshot);
    store
        .submit(|tx| {
            meeting::update_meeting(
                tx,
                &"\u{e000}".into(),
                &json(r#"{"error":"old","captureID":"capture","status":"error"}"#),
                fixture::NOW,
            )?;
            meeting::clear_optional_fields(
                tx,
                &"\u{e000}".into(),
                &["error", "captureID"],
                fixture::NOW,
            )?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    let value = meeting::get_meeting(&snapshot, &"\u{e000}".into())
        .unwrap()
        .unwrap();
    let JsonValue::Object(value) = value else {
        panic!()
    };
    assert!(value.get(&"error".into()).is_none());
    assert!(value.get(&"captureID".into()).is_none());
    drop(snapshot);
    let mismatch = changed(
        json(r#"{"id":"\ue000","title":"ÄBC\u0000DEF","sessionID":"session"}"#),
        "title",
        JsonValue::String("Changed".into()),
    );
    assert!(
        store
            .submit(move |tx| meeting::create_meeting(tx, &mismatch, fixture::NOW))
            .unwrap()
            .wait()
            .is_err()
    );
    for days in [-1.0, f64::INFINITY, f64::NAN] {
        assert!(
            store
                .submit(move |tx| meeting::retain(tx, days, 1_767_225_600_000))
                .unwrap()
                .wait()
                .is_err()
        );
    }
}

#[test]
fn schema_time_number_whitespace_and_strict_field_boundaries_match_ts() {
    for now in [
        "2024-02-29T23:59Z",
        "0000-02-29T00:00:00.000Z",
        "2026-01-01T00:00:00+23:59",
    ] {
        let record = meeting::Meeting {
            id: "m".into(),
            data: fixture::MEETING.replace(fixture::NOW, now).into(),
        };
        assert!(
            meeting::MeetingTable::encode(&record).is_ok(),
            "valid timestamp: {now}"
        );
    }
    for now in [
        "2026-02-29T00:00Z",
        "1900-02-29T00:00Z",
        "2026-01-01T24:00Z",
        "2026-01-01T00:00.1Z",
        "2026-01-01T00:00:00+24:00",
        "2026-01-01T00:00:00+00:60",
        "2026-01-01T00:00:00++1:00",
        "2026-01-01T00:00:00+00:+1",
        "2026-01-01T00:00:00",
    ] {
        let record = meeting::Meeting {
            id: "m".into(),
            data: fixture::MEETING.replace(fixture::NOW, now).into(),
        };
        assert!(
            meeting::MeetingTable::encode(&record).is_err(),
            "invalid timestamp: {now}"
        );
    }
    for data in [
        fixture::SEGMENT.replace("\"sequence\":1", "\"sequence\":1.5"),
        fixture::SEGMENT.replace("\"sequence\":1", "\"sequence\":9007199254740992"),
        fixture::SEGMENT.replace("  สวัสดี  ", "\\ufeff\\u00a0"),
        fixture::SEGMENT.replace("\"source\":\"remote\"", "\"source\":\"unknown\""),
    ] {
        let row = meeting::Segment {
            id: "s".into(),
            meeting_id: "m".into(),
            sequence: 1,
            state: "final".into(),
            original_text: "สวัสดี".into(),
            data: data.into(),
        };
        assert!(meeting::SegmentTable::encode(&row).is_err());
    }
}
