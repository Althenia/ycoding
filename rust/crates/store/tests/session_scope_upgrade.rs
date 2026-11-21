use redb::{ReadableDatabase, ReadableTable, TableDefinition, TableHandle};
use std::collections::BTreeMap;
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use ycoding_schema::{JsonValue, LosslessString, parse_json};
use ycoding_store::{
    Catalog, Error, Metadata, Options, Store, TableSpec, backup,
    native::{self, DatabaseKind},
    project, resources, session,
    session::Document,
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
            "ycoding-session-scope-{}-{}",
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
    Catalog::new(3, Box::leak(target().tables().to_vec().into_boxed_slice()))
}

fn identity() -> Metadata {
    Metadata::new([5; 16], 6)
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

fn session_row(id: &str, origin: Option<&str>, scope: &str) -> session::Session {
    session::Session {
        id: s(id),
        project_id: s("prj_scope"),
        workspace_id: None,
        parent_id: None,
        fork_session_id: None,
        fork_message_id: None,
        fork_seq: None,
        directory: s("/project"),
        path: None,
        title: s(id),
        cost: 0.25,
        tokens_input: 1,
        tokens_output: 2,
        tokens_reasoning: 3,
        tokens_cache_read: 4,
        tokens_cache_write: 5,
        revert: None,
        permission: None,
        autonomy: None,
        autonomy_revision: 0,
        orchestration_revision: 0,
        agent: Some(s("build")),
        model: Some(Document::new(json(r#"{"providerID":"openai","id":"gpt"}"#)).unwrap()),
        profile_binding: None,
        daybreak: None,
        time_created: 1,
        time_updated: 2,
        time_archived: None,
        time_active: None,
        time_pinned: None,
        time_suspended: None,
        usage_pruned_through: None,
        origin: origin.map(s),
        scope: s(scope),
    }
}

fn sessions() -> Vec<session::Session> {
    vec![
        session_row("ses_scope_executor", Some("dots-executor"), "bound"),
        session_row("ses_scope_mapped", None, "bound"),
        session_row("ses_scope_plain", None, "bound"),
    ]
}

fn mappings() -> Vec<resources::Kv> {
    vec![resources::Kv {
        key: s("dots.cca.thread.alpha.beta"),
        value: Document::new(json(r#"{"sessionID":"ses_scope_mapped"}"#)).unwrap(),
        time_created: 1,
        time_updated: 1,
    }]
}

fn seed(path: &Path) {
    let store = Store::initialize(path, Options::core(), predecessor(), identity()).unwrap();
    store
        .submit(|tx| {
            project::ProjectTable::insert(
                tx,
                &project::Project {
                    id: s("prj_scope"),
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
            sessions()
                .iter()
                .try_for_each(|row| session::SessionTable::insert(tx, row))?;
            mappings()
                .iter()
                .try_for_each(|row| resources::KvTable::insert(tx, row))
        })
        .unwrap()
        .wait()
        .unwrap();
    store.shutdown().unwrap();
    rewrite_sessions(path, |mut value| {
        assert!(value.ends_with(BOUND));
        value.truncate(value.len() - BOUND.len());
        value
    });
}

fn rewrite_sessions(path: &Path, change: impl Fn(Vec<u8>) -> Vec<u8>) {
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
        for (key, value) in rows {
            table
                .insert(key.as_slice(), change(value).as_slice())
                .unwrap();
        }
    }
    write.commit().unwrap();
}

fn stored(store: &Store) -> Vec<session::Session> {
    store
        .snapshot()
        .unwrap()
        .scan::<session::SessionTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
        .unwrap()
}

fn catalog_version(dump: &Dump) -> Option<Vec<u8>> {
    dump["storage_metadata"]
        .iter()
        .find(|(name, _)| name == b"catalog_version")
        .map(|(_, value)| value.clone())
}

fn assert_only_sessions_gained_the_bound_scope(before: &Dump, after: &Dump) {
    assert_eq!(before.len(), after.len());
    for (name, rows) in before {
        match name.as_str() {
            "session" => {
                let expected = rows
                    .iter()
                    .map(|(key, value)| (key.clone(), [value.as_slice(), BOUND].concat()))
                    .collect::<Vec<_>>();
                assert_eq!(after[name], expected, "{name}");
            }
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
                assert_eq!(catalog_version(after), Some(5u64.to_be_bytes().to_vec()));
            }
            _ => assert_eq!(&after[name], rows, "{name}"),
        }
    }
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
fn the_scope_catalog_is_a_new_version_over_the_same_tables() {
    assert_eq!(target().version, 5);
    assert_eq!(predecessor().tables(), target().tables());
    assert_ne!(stored_manifest(predecessor()), stored_manifest(target()));
}

#[test]
fn existing_sessions_gain_the_bound_scope_keep_their_origin_and_nothing_else_changes() {
    let directory = Directory::new();
    let path = directory.database();
    seed(&path);
    let before = dump(&path);
    assert!(Store::open(&path, Options::core(), target()).is_err());

    assert_eq!(
        run(&path).unwrap(),
        Outcome::Upgraded(Predecessor::BeforeSessionScope)
    );
    let after = dump(&path);
    assert_only_sessions_gained_the_bound_scope(&before, &after);
    assert_eq!(dump(&backup::upgrade_path(&path)), before);

    let store = Store::open(&path, Options::core(), target()).unwrap();
    assert_eq!(store.metadata(), &identity());
    assert_eq!(stored(&store), sessions());
    store.shutdown().unwrap();

    let bytes = std::fs::read(&path).unwrap();
    for _ in 0..2 {
        assert_eq!(run(&path).unwrap(), Outcome::Current);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn records_round_trip_each_scope_and_reject_unknown_scopes() {
    for scope in ["bound", "standalone"] {
        let row = session_row("ses_scope_new", Some("dots-executor"), scope);
        let bytes = session::SessionTable::encode(&row).unwrap();
        assert_eq!(bytes[0], 1);
        assert_eq!(session::SessionTable::decode(&bytes).unwrap(), row);
    }
    let bound =
        session::SessionTable::encode(&session_row("ses_scope_new", None, "bound")).unwrap();
    assert!(bound.ends_with(&[[0].as_slice(), BOUND].concat()));
    assert!(session::SessionTable::decode(&bound[..bound.len() - BOUND.len()]).is_err());
    for scope in ["other", "", "Bound"] {
        assert!(session::SessionTable::encode(&session_row("ses_scope_bad", None, scope)).is_err());
    }
}

#[test]
fn a_corrupt_scope_predecessor_row_refuses_the_upgrade_without_writes() {
    let directory = Directory::new();
    let path = directory.database();
    seed(&path);
    rewrite_sessions(&path, |mut value| {
        value.push(7);
        value
    });
    let before = dump(&path);
    for _ in 0..2 {
        assert!(run(&path).is_err());
        assert_eq!(dump(&path), before);
        assert!(Store::open(&path, Options::core(), target()).is_err());
    }
}

#[test]
fn a_pre_prune_backup_of_a_scope_predecessor_upgrades_with_its_store() {
    let directory = Directory::new();
    let path = directory.database();
    seed(&path);
    let store = Store::open(&path, Options::core(), predecessor()).unwrap();
    assert_eq!(
        store.prepare_pruning(NOW, plenty).unwrap(),
        backup::Status::Ready
    );
    store.shutdown().unwrap();
    let original_backup = dump(&backup::path(&path));

    assert_eq!(
        run(&path).unwrap(),
        Outcome::Upgraded(Predecessor::BeforeSessionScope)
    );
    assert_eq!(
        dump(&backup::upgrade_path(&backup::path(&path))),
        original_backup
    );
    let restored = directory.0.join("restored.redb");
    std::fs::copy(backup::path(&path), &restored).unwrap();
    let copy = Store::open(&restored, Options::core(), target()).unwrap();
    assert_eq!(stored(&copy), sessions());
    copy.shutdown().unwrap();
    let store = Store::open(&path, Options::core(), target()).unwrap();
    assert_eq!(stored(&store), sessions());
    store.shutdown().unwrap();
    assert_eq!(run(&path).unwrap(), Outcome::Current);
}
