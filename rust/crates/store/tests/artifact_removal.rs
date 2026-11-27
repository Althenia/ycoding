mod common;

use redb::{ReadableDatabase, ReadableTable, TableDefinition, TableHandle};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use ycoding_schema::{JsonValue, LosslessString, parse_json};
use ycoding_store::{
    Catalog, KeyPart, Metadata, Options, Store, TableSpec, backup,
    native::{self, DatabaseKind},
    project,
    session::{
        Event, EventTable, Message, MessageTable, Pending, PendingTable, Sequence, SequenceTable,
        Session, SessionTable,
    },
    tuple_key,
    upgrade::{self, Outcome, Predecessor},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ycoding-artifact-removal-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn database(&self) -> PathBuf {
        self.0.join("ycoding.redb")
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

type Dump = BTreeMap<String, Vec<(Vec<u8>, Vec<u8>)>>;

fn dump(path: &Path) -> Dump {
    let database = redb::ReadOnlyDatabase::open(path).unwrap();
    let read = database.begin_read().unwrap();
    let names = read
        .list_tables()
        .unwrap()
        .map(|table| table.name().to_owned())
        .collect::<Vec<_>>();
    names
        .into_iter()
        .map(|name| {
            let rows = read
                .open_table(TableDefinition::<&[u8], &[u8]>::new(&name))
                .unwrap()
                .iter()
                .unwrap()
                .map(|entry| {
                    let (key, value) = entry.unwrap();
                    (key.value().to_vec(), value.value().to_vec())
                })
                .collect();
            (name, rows)
        })
        .collect()
}

fn s(value: &str) -> LosslessString {
    value.into()
}

fn json(text: &str) -> JsonValue {
    parse_json(text).unwrap()
}

fn key(id: &str) -> Vec<u8> {
    tuple_key(&[KeyPart::String(&s(id))])
}

fn target() -> Catalog {
    native::catalog(DatabaseKind::Core)
}

fn old() -> Catalog {
    Catalog::new(
        5,
        Box::leak(common::with_removed(target().tables()).into_boxed_slice()),
    )
}

fn identity() -> Metadata {
    Metadata::new([21; 16], 2)
}

const PROVENANCE: &str = r#"{"scopeID":"pas_one","versionID":"pav_one","kind":"agent","id":"managed","sourceScope":"project"}"#;

fn session_row() -> Session {
    Session {
        id: s("ses_one"),
        project_id: s("prj_one"),
        workspace_id: None,
        parent_id: None,
        fork_session_id: None,
        fork_message_id: None,
        fork_seq: None,
        directory: s("/project"),
        path: None,
        title: s("one"),
        cost: 0.0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        revert: None,
        permission: None,
        autonomy: None,
        autonomy_revision: 0,
        orchestration_revision: 0,
        agent: Some(s("build")),
        model: None,
        profile_binding: None,
        daybreak: None,
        time_created: 1,
        time_updated: 2,
        time_archived: None,
        time_active: None,
        time_pinned: None,
        time_suspended: None,
        usage_pruned_through: None,
        origin: None,
        scope: "bound".into(),
    }
}

fn event(id: &str, seq: i64, type_: &str, data: String) -> Event {
    Event {
        id: s(id),
        aggregate_id: s("ses_one"),
        seq,
        created: 10 + seq,
        type_: s(type_),
        data: json(&data),
    }
}

fn message(id: &str, seq: i64, type_: &str, data: String) -> Message {
    Message {
        id: s(id),
        session_id: s("ses_one"),
        type_: s(type_),
        seq,
        time_created: 100 + seq,
        time_updated: 100 + seq,
        data: json(&data),
    }
}

fn pending(id: &str, seq: i64, data: String) -> Pending {
    Pending {
        id: s(id),
        session_id: s("ses_one"),
        type_: s("user"),
        data: json(&data),
        delivery: Some(s("queue")),
        admitted_seq: seq,
        time_created: 200 + seq,
    }
}

fn events() -> Vec<Event> {
    let admitted = |metadata: &str| {
        format!(
            r#"{{"sessionID":"ses_one","inputID":"msg_in","input":{{"type":"user","data":{{"text":"hi","metadata":{metadata}}},"delivery":"queue"}}}}"#
        )
    };
    vec![
        event(
            "evt_00",
            0,
            "session.renamed.1",
            r#"{"sessionID":"ses_one","title":"one"}"#.into(),
        ),
        event(
            "evt_01",
            1,
            "session.project-artifacts-ended.1",
            r#"{"sessionID":"ses_one","oldProjectID":"prj_one","newProjectID":"prj_two"}"#.into(),
        ),
        event(
            "evt_02",
            2,
            "session.agent.selected.1",
            format!(r#"{{"sessionID":"ses_one","agent":"build","artifact":{PROVENANCE}}}"#),
        ),
        event(
            "evt_03",
            3,
            "session.skill.activated.1",
            format!(
                r#"{{"sessionID":"ses_one","id":"skl_one","name":"review","artifact":{PROVENANCE},"text":"body"}}"#
            ),
        ),
        event(
            "evt_04",
            4,
            "session.agent.selected.1",
            r#"{"sessionID":"ses_one","agent":"plan"}"#.into(),
        ),
        event(
            "evt_05",
            5,
            "session.input.admitted.1",
            admitted(&format!(r#"{{"projectArtifact":{PROVENANCE}}}"#)),
        ),
        event(
            "evt_06",
            6,
            "session.input.admitted.1",
            admitted(&format!(
                r#"{{"projectArtifact":{PROVENANCE},"contextSource":"team-view"}}"#
            )),
        ),
        event(
            "evt_07",
            7,
            "session.project-artifacts-ended.1",
            r#"{"sessionID":"ses_one","oldProjectID":"prj_two","newProjectID":"prj_three"}"#.into(),
        ),
    ]
}

fn messages() -> Vec<Message> {
    vec![
        message("msg_00", 0, "user", r#"{"text":"plain"}"#.into()),
        message(
            "msg_01",
            1,
            "user",
            format!(r#"{{"text":"only","metadata":{{"projectArtifact":{PROVENANCE}}}}}"#),
        ),
        message(
            "msg_02",
            2,
            "user",
            format!(
                r#"{{"text":"mixed","metadata":{{"projectArtifact":{PROVENANCE},"contextSource":"team-view"}}}}"#
            ),
        ),
        message(
            "msg_03",
            3,
            "synthetic",
            r#"{"text":"","metadata":{"projectArtifactsEnded":{"oldProjectID":"prj_one","newProjectID":"prj_two"}}}"#.into(),
        ),
        message(
            "msg_04",
            4,
            "synthetic",
            r#"{"text":"kept","metadata":{"contextSource":"team-view"}}"#.into(),
        ),
        message(
            "msg_05",
            5,
            "agent-switched",
            format!(r#"{{"agent":"build","artifact":{PROVENANCE}}}"#),
        ),
        message(
            "msg_06",
            6,
            "skill",
            format!(r#"{{"skill":"skl_one","name":"review","text":"body","artifact":{PROVENANCE}}}"#),
        ),
        message(
            "msg_07",
            7,
            "agent-switched",
            r#"{"agent":"plan"}"#.into(),
        ),
        message(
            "msg_08",
            8,
            "synthetic",
            r#"{"text":"","metadata":{"projectArtifactsEnded":{}}}"#.into(),
        ),
    ]
}

fn pendings() -> Vec<Pending> {
    vec![
        pending(
            "msg_p0",
            1,
            format!(r#"{{"text":"queued","metadata":{{"projectArtifact":{PROVENANCE}}}}}"#),
        ),
        pending("msg_p1", 2, r#"{"text":"queued"}"#.into()),
    ]
}

fn seed(path: &Path) {
    let store = Store::initialize(path, Options::core(), old(), identity()).unwrap();
    let (events, messages, pendings) = (events(), messages(), pendings());
    store
        .submit(move |tx| {
            SequenceTable::put(
                tx,
                &Sequence {
                    aggregate_id: s("ses_one"),
                    seq: 7,
                    owner_id: None,
                },
            )?;
            project::ProjectTable::put(
                tx,
                &project::Project {
                    id: s("prj_one"),
                    worktree: s("/project"),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 0,
                    time_updated: 0,
                    time_initialized: None,
                    sandboxes: vec![],
                    commands: None,
                },
            )?;
            SessionTable::put(tx, &session_row())?;
            for row in &events {
                EventTable::put(tx, row)?;
            }
            for row in &messages {
                MessageTable::put(tx, row)?;
            }
            for row in &pendings {
                PendingTable::put(tx, row)?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    store.shutdown().unwrap();
    let database = redb::Database::open(path).unwrap();
    let write = database.begin_write().unwrap();
    for table in common::REMOVED {
        for name in std::iter::once(table.name).chain(table.indexes.iter().map(|index| index.name))
        {
            write
                .open_table(TableDefinition::<&[u8], &[u8]>::new(name))
                .unwrap()
                .insert(b"synthetic".as_slice(), b"synthetic".as_slice())
                .unwrap();
        }
    }
    write.commit().unwrap();
}

fn run(path: &Path) -> Outcome {
    upgrade::core(path, Options::core(), |_| Ok(u64::MAX)).unwrap()
}

#[test]
fn the_core_catalog_has_no_project_artifact_tables_or_indexes() {
    for table in target().tables() {
        assert!(
            !table.name.starts_with("project_artifact"),
            "{}",
            table.name
        );
        for index in table.indexes {
            assert!(
                !index.name.starts_with("project_artifact"),
                "{}",
                index.name
            );
        }
    }
    assert_eq!(target().version, 5);
    assert_eq!(target().tables().len(), 52);
}

#[test]
fn the_previous_core_catalog_is_recognized_and_its_artifact_data_is_removed_exactly() {
    let directory = Directory::new();
    let path = directory.database();
    seed(&path);
    assert!(Store::open(&path, Options::core(), target()).is_err());
    let before = dump(&path);
    for table in common::REMOVED {
        assert_eq!(before[table.name].len(), 1, "{}", table.name);
    }
    assert_eq!(
        run(&path),
        Outcome::Upgraded(Predecessor::BeforeArtifactRemoval)
    );
    let after = dump(&path);
    for table in common::REMOVED {
        assert!(!after.contains_key(table.name), "{}", table.name);
        for index in table.indexes {
            assert!(!after.contains_key(index.name), "{}", index.name);
        }
    }
    assert_eq!(
        after.keys().cloned().collect::<Vec<_>>(),
        target()
            .tables()
            .iter()
            .flat_map(|table| std::iter::once(table.name)
                .chain(table.indexes.iter().map(|index| index.name)))
            .chain(["storage_metadata"])
            .map(str::to_owned)
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
    );

    let store = Store::open(&path, Options::core(), target()).unwrap();
    assert_eq!(store.metadata(), &identity());
    let snapshot = store.snapshot().unwrap();
    let event = |id: &str| snapshot.get::<EventTable>(&key(id)).unwrap();
    let message = |id: &str| snapshot.get::<MessageTable>(&key(id)).unwrap();
    let pending = |id: &str| snapshot.get::<PendingTable>(&key(id)).unwrap();
    let admitted = |metadata: Option<&str>| {
        let data = metadata.map_or(String::new(), |metadata| {
            format!(r#","metadata":{metadata}"#)
        });
        json(&format!(
            r#"{{"sessionID":"ses_one","inputID":"msg_in","input":{{"type":"user","data":{{"text":"hi"{data}}},"delivery":"queue"}}}}"#
        ))
    };

    assert!(event("evt_01").is_none());
    assert!(event("evt_07").is_none());
    assert_eq!(
        event("evt_02").unwrap().data,
        json(r#"{"sessionID":"ses_one","agent":"build"}"#)
    );
    assert_eq!(
        event("evt_03").unwrap().data,
        json(r#"{"sessionID":"ses_one","id":"skl_one","name":"review","text":"body"}"#)
    );
    assert_eq!(event("evt_05").unwrap().data, admitted(None));
    assert_eq!(
        event("evt_06").unwrap().data,
        admitted(Some(r#"{"contextSource":"team-view"}"#))
    );

    assert!(message("msg_03").is_none());
    assert!(message("msg_08").is_none());
    assert_eq!(message("msg_01").unwrap().data, json(r#"{"text":"only"}"#));
    assert_eq!(
        message("msg_02").unwrap().data,
        json(r#"{"text":"mixed","metadata":{"contextSource":"team-view"}}"#)
    );
    assert_eq!(
        message("msg_05").unwrap().data,
        json(r#"{"agent":"build"}"#)
    );
    assert_eq!(
        message("msg_06").unwrap().data,
        json(r#"{"skill":"skl_one","name":"review","text":"body"}"#)
    );
    assert_eq!(
        pending("msg_p0").unwrap().data,
        json(r#"{"text":"queued"}"#)
    );
    drop(snapshot);
    store.shutdown().unwrap();

    let identical = |table: &str, ids: &[&str]| {
        for id in ids {
            let key = key(id);
            let find = |dump: &Dump| {
                dump[table]
                    .iter()
                    .find(|(candidate, _)| *candidate == key)
                    .cloned()
            };
            assert!(find(&before).is_some(), "{id}");
            assert_eq!(find(&before), find(&after), "{id}");
        }
    };
    identical("event", &["evt_00", "evt_04"]);
    identical("session_message", &["msg_00", "msg_04", "msg_07"]);
    identical("session_pending", &["msg_p1"]);
    for table in ["session", "event_sequence"] {
        assert_eq!(before[table], after[table], "{table}");
    }

    let removed = |ids: &[&str]| ids.iter().map(|id| key(id)).collect::<Vec<_>>();
    let gone = |names: &[&str], keys: Vec<Vec<u8>>| {
        for name in names {
            assert!(
                !before[*name].is_empty() && !after[*name].is_empty(),
                "{name}"
            );
            for (_, value) in &after[*name] {
                assert!(!keys.contains(value), "{name}");
            }
            assert_eq!(
                after[*name].len(),
                before[*name]
                    .iter()
                    .filter(|(_, value)| !keys.contains(value))
                    .count(),
                "{name}"
            );
            assert_eq!(
                before[*name].len() - after[*name].len(),
                keys.len(),
                "{name}"
            );
        }
    };
    gone(
        &["event_aggregate_seq_idx", "event_aggregate_type_seq_idx"],
        removed(&["evt_01", "evt_07"]),
    );
    gone(
        &[
            "session_message_session_seq_idx",
            "session_message_session_type_seq_idx",
            "session_message_session_time_created_id_idx",
            "session_message_time_created_idx",
        ],
        removed(&["msg_03", "msg_08"]),
    );
    assert_eq!(after["event"].len(), before["event"].len() - 2);
    assert_eq!(
        after["session_message"].len(),
        before["session_message"].len() - 2
    );

    let reopened = dump(&path);
    assert_eq!(run(&path), Outcome::Current);
    assert_eq!(dump(&path), reopened);
}

#[test]
fn pre_prune_backup_of_the_previous_catalog_is_upgraded_with_a_verified_scrub() {
    let directory = Directory::new();
    let path = directory.database();
    seed(&path);
    let store = Store::open(&path, Options::core(), old()).unwrap();
    assert_eq!(
        store.prepare_pruning(1_000, |_| Ok(u64::MAX)).unwrap(),
        backup::Status::Ready
    );
    store.shutdown().unwrap();
    let original_backup = dump(&backup::path(&path));
    assert_eq!(
        run(&path),
        Outcome::Upgraded(Predecessor::BeforeArtifactRemoval)
    );
    assert_eq!(
        dump(&backup::upgrade_path(&backup::path(&path))),
        original_backup
    );
    let upgraded_backup = dump(&backup::path(&path));
    assert!(!upgraded_backup.contains_key("project_artifact"));
    assert_eq!(
        upgraded_backup["event"].len(),
        original_backup["event"].len() - 2
    );
    let store = Store::open(&path, Options::core(), target()).unwrap();
    assert_eq!(
        store.prepare_pruning(1_001, |_| Ok(u64::MAX)).unwrap(),
        backup::Status::Ready
    );
    store.shutdown().unwrap();
    let restored = directory.0.join("restored.redb");
    std::fs::copy(backup::path(&path), &restored).unwrap();
    Store::open(&restored, Options::core(), target())
        .unwrap()
        .shutdown()
        .unwrap();
    assert_eq!(run(&path), Outcome::Current);
}

fn reinsert_removed_event(write: &redb::WriteTransaction) {
    write
        .open_table(TableDefinition::<&[u8], &[u8]>::new("event"))
        .unwrap()
        .insert(
            key("evt_01").as_slice(),
            <EventTable as TableSpec>::encode(&events()[1])
                .unwrap()
                .as_slice(),
        )
        .unwrap();
}

fn leave_an_artifact_in_a_message(write: &redb::WriteTransaction) {
    let row = message(
        "msg_01",
        1,
        "user",
        format!(r#"{{"text":"only","metadata":{{"projectArtifact":{PROVENANCE}}}}}"#),
    );
    write
        .open_table(TableDefinition::<&[u8], &[u8]>::new("session_message"))
        .unwrap()
        .insert(
            key("msg_01").as_slice(),
            <MessageTable as TableSpec>::encode(&row)
                .unwrap()
                .as_slice(),
        )
        .unwrap();
}

fn drop_a_message_index_entry(write: &redb::WriteTransaction) {
    let mut table = write
        .open_table(TableDefinition::<&[u8], &[u8]>::new(
            "session_message_session_seq_idx",
        ))
        .unwrap();
    let first = table
        .iter()
        .unwrap()
        .next()
        .map(|entry| entry.unwrap().0.value().to_vec())
        .unwrap();
    table.remove(first.as_slice()).unwrap();
}

#[test]
fn a_tampered_upgraded_pre_prune_backup_is_refused() {
    let tampering: [fn(&redb::WriteTransaction); 3] = [
        reinsert_removed_event,
        leave_an_artifact_in_a_message,
        drop_a_message_index_entry,
    ];
    for tamper in tampering {
        let directory = Directory::new();
        let path = directory.database();
        seed(&path);
        let store = Store::open(&path, Options::core(), old()).unwrap();
        store.prepare_pruning(1_000, |_| Ok(u64::MAX)).unwrap();
        store.shutdown().unwrap();
        assert_eq!(
            run(&path),
            Outcome::Upgraded(Predecessor::BeforeArtifactRemoval)
        );
        let database = redb::Database::open(backup::path(&path)).unwrap();
        let write = database.begin_write().unwrap();
        tamper(&write);
        write.commit().unwrap();
        drop(database);
        assert!(matches!(
            upgrade::core(&path, Options::core(), |_| Ok(u64::MAX)),
            Err(ycoding_store::Error::Rejected(
                "upgraded pre-prune backup differs from its pre-upgrade copy"
            ))
        ));
    }
}
