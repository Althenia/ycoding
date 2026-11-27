mod common;

use redb::{ReadableDatabase, ReadableTable, TableDefinition, TableHandle};
use std::collections::BTreeMap;
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use ycoding_schema::{JsonValue, LosslessString, parse_json};
use ycoding_store::{
    Catalog, Error, KeyPart, Metadata, Options, Store, TableSpec, backup,
    native::{self, DatabaseKind},
    project, resources, session,
    session::Document,
    tuple_key,
    upgrade::{self, Outcome, Predecessor},
};

const NOW: i64 = 1_000;
const BOUND: &[u8] = &[
    0, 0, 0, 0, 0, 0, 0, 5, 0, b'b', 0, b'o', 0, b'u', 0, b'n', 0, b'd',
];
static NEXT: AtomicU64 = AtomicU64::new(0);

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ycoding-session-origin-{}-{}",
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
    let database = redb::Database::open(path).unwrap();
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

fn target() -> Catalog {
    native::catalog(DatabaseKind::Core)
}

fn predecessor() -> Catalog {
    Catalog::new(
        2,
        Box::leak(common::with_removed(target().tables()).into_boxed_slice()),
    )
}

fn identity() -> Metadata {
    Metadata::new([9; 16], 4)
}

fn s(value: &str) -> LosslessString {
    value.into()
}

fn json(text: &str) -> JsonValue {
    parse_json(text).unwrap()
}

fn plenty(_: &Path) -> Result<u64, Error> {
    Ok(u64::MAX)
}

fn run(path: &Path) -> Result<Outcome, Error> {
    upgrade::core(path, Options::core(), plenty)
}

fn session_row(id: &str, title: &str) -> session::Session {
    session::Session {
        id: s(id),
        project_id: s("prj_one"),
        workspace_id: Some(s("wrk_one")),
        parent_id: None,
        fork_session_id: None,
        fork_message_id: None,
        fork_seq: None,
        directory: s("/project"),
        path: Some(s("sub")),
        title: s(title),
        cost: 1.5,
        tokens_input: 3,
        tokens_output: 4,
        tokens_reasoning: 5,
        tokens_cache_read: 6,
        tokens_cache_write: 7,
        revert: None,
        permission: None,
        autonomy: Some(json(r#"{"mode":"normal"}"#)),
        autonomy_revision: 2,
        orchestration_revision: 1,
        agent: Some(s("build")),
        model: Some(Document::new(json(r#"{"providerID":"openai","id":"gpt"}"#)).unwrap()),
        profile_binding: None,
        daybreak: None,
        time_created: 1,
        time_updated: 2,
        time_archived: None,
        time_active: Some(3),
        time_pinned: Some(4),
        time_suspended: None,
        usage_pruned_through: Some(8),
        origin: None,
        scope: "bound".into(),
    }
}

fn kv(key: &str, value: &str) -> resources::Kv {
    resources::Kv {
        key: s(key),
        value: Document::new(json(value)).unwrap(),
        time_created: 1,
        time_updated: 1,
    }
}

const MAPPED: [&str; 2] = ["ses_thread", "ses_unattributed"];
const UNMAPPED: [&str; 11] = [
    "ses_no_separator",
    "ses_empty_head",
    "ses_trailing_dot",
    "ses_empty_tail",
    "ses_number_id",
    "ses_array_value",
    "ses_other_prefix",
    "ses_title_only",
    "ses_unrelated_setting",
    "ses_missing_key_owner",
    "ses_prefix_only",
];

fn sessions() -> Vec<session::Session> {
    MAPPED
        .iter()
        .chain(UNMAPPED.iter())
        .map(|id| {
            session_row(
                id,
                if *id == "ses_title_only" {
                    "Dots · unattributed"
                } else {
                    id
                },
            )
        })
        .collect()
}

fn mappings() -> Vec<resources::Kv> {
    vec![
        kv(
            "dots.cca.thread.alpha.beta",
            r#"{"sessionID":"ses_thread"}"#,
        ),
        kv(
            "dots.cca.unattributed.gamma",
            r#"{"sessionID":"ses_unattributed","extra":1}"#,
        ),
        kv(
            "dots.cca.thread.alpha",
            r#"{"sessionID":"ses_no_separator"}"#,
        ),
        kv("dots.cca.thread..beta", r#"{"sessionID":"ses_empty_head"}"#),
        kv(
            "dots.cca.thread.alpha.",
            r#"{"sessionID":"ses_trailing_dot"}"#,
        ),
        kv(
            "dots.cca.unattributed.",
            r#"{"sessionID":"ses_empty_tail"}"#,
        ),
        kv("dots.cca.thread.num.one", r#"{"sessionID":7}"#),
        kv("dots.cca.thread.arr.one", r#"["ses_array_value"]"#),
        kv(
            "dots.cca.other.alpha.beta",
            r#"{"sessionID":"ses_other_prefix"}"#,
        ),
        kv("setting", r#"{"sessionID":"ses_unrelated_setting"}"#),
        kv(
            "dots.cca.thread.gone.one",
            r#"{"sessionID":"ses_gone_owner"}"#,
        ),
        kv("dots.cca.thread.", r#"{"sessionID":"ses_prefix_only"}"#),
    ]
}

fn seed(path: &Path, catalog: Catalog, rows: Vec<session::Session>, mapped: Vec<resources::Kv>) {
    let store = Store::initialize(path, Options::core(), catalog, identity()).unwrap();
    store
        .submit(move |tx| {
            project::ProjectTable::insert(
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
            rows.iter()
                .try_for_each(|row| session::SessionTable::insert(tx, row))?;
            mapped
                .iter()
                .try_for_each(|row| resources::KvTable::insert(tx, row))
        })
        .unwrap()
        .wait()
        .unwrap();
    store.shutdown().unwrap();
    legacy_layout(path);
}

fn legacy_layout(path: &Path) {
    let database = redb::Database::open(path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut table = write
            .open_table(TableDefinition::<&[u8], &[u8]>::new("session"))
            .unwrap();
        let rows = table
            .iter()
            .unwrap()
            .map(|entry| {
                let (key, value) = entry.unwrap();
                (key.value().to_vec(), value.value().to_vec())
            })
            .collect::<Vec<_>>();
        for (key, mut value) in rows {
            assert!(value.ends_with(BOUND));
            value.truncate(value.len() - BOUND.len());
            assert_eq!(value.pop(), Some(0));
            table.insert(key.as_slice(), value.as_slice()).unwrap();
        }
    }
    write.commit().unwrap();
}

fn origin_suffix() -> Vec<u8> {
    let plain = session::SessionTable::encode(&session_row("ses_suffix", "suffix")).unwrap();
    let mut tagged = session_row("ses_suffix", "suffix");
    tagged.origin = Some(s("dots-executor"));
    let tagged = session::SessionTable::encode(&tagged).unwrap();
    tagged[plain.len() - 1 - BOUND.len()..tagged.len() - BOUND.len()].to_vec()
}

fn with_origin(rows: &[(Vec<u8>, Vec<u8>)], mapped: &[&str]) -> Vec<(Vec<u8>, Vec<u8>)> {
    let keys = mapped
        .iter()
        .map(|id| session::SessionTable::primary_key(&session_row(id, id)))
        .collect::<Vec<_>>();
    let suffix = origin_suffix();
    rows.iter()
        .map(|(key, value)| {
            let suffix: &[u8] = if keys.contains(key) { &suffix } else { &[0] };
            (key.clone(), [value.as_slice(), suffix, BOUND].concat())
        })
        .collect()
}

fn stored(store: &Store) -> Vec<session::Session> {
    store
        .snapshot()
        .unwrap()
        .scan::<session::SessionTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
        .unwrap()
}

fn expected(rows: &[session::Session], mapped: &[&str]) -> Vec<session::Session> {
    let mut rows = rows
        .iter()
        .cloned()
        .map(|mut row| {
            if mapped.iter().any(|id| row.id.as_str() == Some(*id)) {
                row.origin = Some(s("dots-executor"));
            }
            row
        })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| left.id.cmp(&right.id));
    rows
}

fn assert_only_sessions_and_metadata_changed(before: &Dump, after: &Dump, mapped: &[&str]) {
    for (name, rows) in before {
        if common::removed(name) {
            assert!(!after.contains_key(name), "{name}");
            continue;
        }
        match name.as_str() {
            "session" => assert_eq!(&with_origin(rows, mapped), &after[name], "{name}"),
            "storage_metadata" => {
                for key in [
                    "physical_format",
                    "record_codec_version",
                    "key_codec_version",
                    "database_identity",
                    "generation",
                ] {
                    let find = |dump: &Dump| {
                        dump["storage_metadata"]
                            .iter()
                            .find(|(name, _)| name == key.as_bytes())
                            .map(|(_, value)| value.clone())
                    };
                    assert_eq!(find(before), find(after), "{key}");
                }
                let version = after[name]
                    .iter()
                    .find(|(name, _)| name == b"catalog_version")
                    .map(|(_, value)| value.clone());
                assert_eq!(version, Some(5u64.to_be_bytes().to_vec()));
            }
            _ => assert_eq!(&after[name], rows, "{name}"),
        }
    }
    assert_eq!(common::retained(before), after.len());
}

fn stored_manifest(catalog: Catalog) -> Vec<u8> {
    let directory = Directory::new();
    let path = directory.database();
    Store::initialize(&path, Options::core(), catalog, identity())
        .unwrap()
        .shutdown()
        .unwrap();
    dump(&path)["storage_metadata"]
        .iter()
        .find(|(name, _)| name == b"catalog_manifest")
        .map(|(_, value)| value.clone())
        .unwrap()
}

#[test]
fn the_current_catalog_is_a_distinct_version_from_its_recognized_predecessor() {
    assert_eq!(
        predecessor().tables(),
        common::with_removed(target().tables())
    );
    assert_ne!(stored_manifest(predecessor()), stored_manifest(target()));
    assert_eq!(target().version, 5);
    assert_eq!(predecessor().version, 2);
}

#[test]
fn only_still_mapped_executor_sessions_gain_the_origin_and_nothing_else_changes() {
    let directory = Directory::new();
    let path = directory.database();
    seed(&path, predecessor(), sessions(), mappings());
    let before = dump(&path);
    assert!(Store::open(&path, Options::core(), target()).is_err());

    assert_eq!(
        run(&path).unwrap(),
        Outcome::Upgraded(Predecessor::BeforeSessionOrigin)
    );
    let after = dump(&path);
    assert_only_sessions_and_metadata_changed(&before, &after, &MAPPED);
    assert_eq!(dump(&backup::upgrade_path(&path)), before);

    let store = Store::open(&path, Options::core(), target()).unwrap();
    assert_eq!(store.metadata(), &identity());
    assert_eq!(stored(&store), expected(&sessions(), &MAPPED));
    store.shutdown().unwrap();

    let bytes = std::fs::read(&path).unwrap();
    let copy = std::fs::read(backup::upgrade_path(&path)).unwrap();
    assert_eq!(run(&path).unwrap(), Outcome::Current);
    assert_eq!(run(&path).unwrap(), Outcome::Current);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(std::fs::read(backup::upgrade_path(&path)).unwrap(), copy);
}

#[test]
fn a_store_without_mapped_executors_or_sessions_upgrades_without_inferring_an_origin() {
    for (rows, mapped) in [
        (Vec::new(), Vec::new()),
        (
            sessions(),
            vec![kv("setting", r#"{"sessionID":"ses_thread"}"#)],
        ),
    ] {
        let directory = Directory::new();
        let path = directory.database();
        seed(&path, predecessor(), rows.clone(), mapped);
        let before = dump(&path);
        assert_eq!(
            run(&path).unwrap(),
            Outcome::Upgraded(Predecessor::BeforeSessionOrigin)
        );
        assert_only_sessions_and_metadata_changed(&before, &dump(&path), &[]);
        let store = Store::open(&path, Options::core(), target()).unwrap();
        assert_eq!(stored(&store), expected(&rows, &[]));
        store.shutdown().unwrap();
        assert_eq!(run(&path).unwrap(), Outcome::Current);
    }
}

#[test]
fn a_session_that_already_carries_an_origin_keeps_it_and_new_records_round_trip() {
    let mut row = session_row("ses_new", "New");
    row.origin = Some(s("dots-executor"));
    let bytes = session::SessionTable::encode(&row).unwrap();
    assert_eq!(bytes[0], 1);
    assert_eq!(session::SessionTable::decode(&bytes).unwrap(), row);
    let mut plain = row.clone();
    plain.origin = None;
    let plain_bytes = session::SessionTable::encode(&plain).unwrap();
    assert!(plain_bytes.ends_with(&[[0].as_slice(), BOUND].concat()));
    let prefix = plain_bytes.len() - 1 - BOUND.len();
    assert_eq!(&bytes[..prefix], &plain_bytes[..prefix]);
    assert!(bytes.ends_with(BOUND));
    assert!(session::SessionTable::decode(&plain_bytes[..prefix]).is_err());

    let mut invalid = row;
    invalid.origin = Some(s("other"));
    assert!(session::SessionTable::encode(&invalid).is_err());
}

#[test]
fn a_corrupt_legacy_session_leaves_the_store_unchanged_and_refuses_the_upgrade() {
    let directory = Directory::new();
    let path = directory.database();
    seed(&path, predecessor(), sessions(), mappings());
    {
        let database = redb::Database::open(&path).unwrap();
        let write = database.begin_write().unwrap();
        {
            let mut table = write
                .open_table(TableDefinition::<&[u8], &[u8]>::new("session"))
                .unwrap();
            let (key, mut value) = {
                let (key, value) = table.last().unwrap().unwrap();
                (key.value().to_vec(), value.value().to_vec())
            };
            value.push(7);
            table.insert(key.as_slice(), value.as_slice()).unwrap();
        }
        write.commit().unwrap();
    }
    let before = dump(&path);
    for _ in 0..2 {
        assert!(run(&path).is_err());
        assert_eq!(dump(&path), before);
        assert!(Store::open(&path, Options::core(), target()).is_err());
    }
}

fn remove_mapping(path: &Path, key: &str) {
    let database = redb::Database::open(path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut table = write
            .open_table(TableDefinition::<&[u8], &[u8]>::new("kv"))
            .unwrap();
        assert!(
            table
                .remove(tuple_key(&[KeyPart::String(&s(key))]).as_slice())
                .unwrap()
                .is_some()
        );
    }
    write.commit().unwrap();
}

fn backup_copy(path: &Path) -> PathBuf {
    backup::upgrade_path(&backup::path(path))
}

#[test]
fn a_pre_prune_backup_is_upgraded_from_its_own_mappings_and_keeps_its_verified_copy() {
    let directory = Directory::new();
    let path = directory.database();
    seed(&path, predecessor(), sessions(), mappings());
    let store = Store::open(&path, Options::core(), predecessor()).unwrap();
    assert_eq!(
        store.prepare_pruning(NOW, plenty).unwrap(),
        backup::Status::Ready
    );
    store.shutdown().unwrap();
    assert!(backup::marker(&path).is_file());
    remove_mapping(&path, "dots.cca.unattributed.gamma");
    let original_backup = dump(&backup::path(&path));
    let main = dump(&path);

    assert_eq!(
        run(&path).unwrap(),
        Outcome::Upgraded(Predecessor::BeforeSessionOrigin)
    );
    assert_eq!(dump(&backup_copy(&path)), original_backup);
    assert_eq!(dump(&backup::upgrade_path(&path)), main);

    let store = Store::open(&path, Options::core(), target()).unwrap();
    assert_eq!(stored(&store), expected(&sessions(), &["ses_thread"]));
    assert_eq!(
        store.prepare_pruning(NOW + 1, plenty).unwrap(),
        backup::Status::Ready
    );
    store.shutdown().unwrap();

    let restored = directory.0.join("restored.redb");
    std::fs::copy(backup::path(&path), &restored).unwrap();
    let copy = Store::open(&restored, Options::core(), target()).unwrap();
    assert_eq!(stored(&copy), expected(&sessions(), &MAPPED));
    copy.shutdown().unwrap();

    let before = [
        std::fs::read(&path).unwrap(),
        std::fs::read(backup::path(&path)).unwrap(),
        std::fs::read(backup::marker(&path)).unwrap(),
    ];
    assert_eq!(run(&path).unwrap(), Outcome::Current);
    assert_eq!(
        before,
        [
            std::fs::read(&path).unwrap(),
            std::fs::read(backup::path(&path)).unwrap(),
            std::fs::read(backup::marker(&path)).unwrap(),
        ]
    );
}

#[test]
fn an_unverifiable_backup_copy_refuses_the_upgrade_without_writes() {
    let directory = Directory::new();
    let path = directory.database();
    seed(&path, predecessor(), sessions(), mappings());
    let store = Store::open(&path, Options::core(), predecessor()).unwrap();
    assert_eq!(
        store.prepare_pruning(NOW, plenty).unwrap(),
        backup::Status::Ready
    );
    store.shutdown().unwrap();
    std::fs::create_dir(backup_copy(&path)).unwrap();
    let main = std::fs::read(&path).unwrap();
    let original = std::fs::read(backup::path(&path)).unwrap();
    let marker = std::fs::read(backup::marker(&path)).unwrap();
    assert!(run(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), main);
    assert_eq!(std::fs::read(backup::path(&path)).unwrap(), original);
    assert_eq!(std::fs::read(backup::marker(&path)).unwrap(), marker);
    assert!(Store::open(&path, Options::core(), target()).is_err());
}
