use redb::{ReadableDatabase, ReadableTable, TableDefinition, TableHandle};
use std::collections::BTreeMap;
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use ycoding_schema::{JsonValue, LosslessString, parse_json};
use ycoding_store::{
    Catalog, KeyPart, Metadata, Options, Store, TableDeclaration, TableSpec, backup,
    import::{self, DatabaseKind},
    model_incident, project, resources, session,
    session::Document,
    tuple_key,
    upgrade::{self, Outcome, Predecessor},
};

const REWRITTEN: [&str; 4] = [
    "session",
    "session_task",
    "session_compaction_job",
    "session_provider_request",
];
const ADDED_BEFORE_ANALYTICS: [&str; 9] = [
    "usage_analytics_request",
    "usage_analytics_request_time_created_id_idx",
    "model_incident",
    "model_incident_time_created_id_idx",
    "model_incident_model_time_idx",
    "model_incident_model_agent_time_idx",
    "model_incident_guidance_idx",
    "model_incident_request_idx",
    "model_guidance_clear",
];
const SESSIONS: usize = 1_200;
const NOW: i64 = 1_000;

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ycoding-core-upgrade-{}-{}",
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

fn metadata_value(dump: &Dump, key: &str) -> Vec<u8> {
    dump["storage_metadata"]
        .iter()
        .find(|(name, _)| name == key.as_bytes())
        .map(|(_, value)| value.clone())
        .unwrap()
}

fn target() -> Catalog {
    import::catalog(DatabaseKind::Core)
}

fn without(names: &[&str]) -> Catalog {
    let tables = target()
        .tables()
        .iter()
        .copied()
        .filter(|table| !names.contains(&table.name))
        .collect::<Vec<_>>();
    Catalog::new(1, Box::leak(tables.into_boxed_slice()))
}

fn before_incidents() -> Catalog {
    without(&["model_incident", "model_guidance_clear"])
}

fn before_analytics() -> Catalog {
    without(&[
        "model_incident",
        "model_guidance_clear",
        "usage_analytics_request",
    ])
}

fn identity() -> Metadata {
    Metadata::new([5; 16], 3)
}

fn s(value: &str) -> LosslessString {
    value.into()
}

fn json(text: &str) -> JsonValue {
    parse_json(text).unwrap()
}

fn session_row(id: &str, parent: Option<&str>) -> session::Session {
    session::Session {
        id: s(id),
        project_id: s("prj_one"),
        workspace_id: None,
        parent_id: parent.map(s),
        fork_session_id: None,
        fork_message_id: None,
        fork_seq: None,
        directory: s("/project"),
        path: None,
        title: s(id),
        cost: 1.5,
        tokens_input: 3,
        tokens_output: 4,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        revert: None,
        permission: None,
        autonomy: Some(json(r#"{"mode":"normal","yolo":1}"#)),
        autonomy_revision: 2,
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
    }
}

fn revision() -> session::Revision {
    session::Revision {
        session_id: s("ses_root"),
        revision: 0,
        parent_revision: None,
        manifest_digest: None,
        covered_through_message_id: None,
        covered_through_seq: None,
        activation_event_id: None,
        activation_sequence: None,
        time_created: 0,
    }
}

fn task() -> session::Task {
    session::Task {
        session_id: s("ses_child"),
        parent_id: s("ses_root"),
        parent_assistant_message_id: s("msg_assistant"),
        tool_call_id: s("call_one"),
        input_id: s("msg_input"),
        description: s("child"),
        agent: s("build"),
        model: Document::new(json(r#"{"providerID":"openai","id":"gpt"}"#)).unwrap(),
        prompt_digest: s(&"a".repeat(64)),
        background: 1,
        delivery: s("steer"),
        state: s("running"),
        progress: None,
        progress_time: None,
        question_id: None,
        question: None,
        question_data: None,
        question_time: None,
        attempt_started: 1,
        owner_pid: Some(7),
        owner_started: Some(s("started")),
        revision: 0,
        time_created: 1,
        time_updated: 1,
        usage_anchor: None,
    }
}

fn job() -> session::Job {
    session::Job {
        id: s("cmp_one"),
        session_id: s("ses_root"),
        legacy_input_id: None,
        trigger: s("manual"),
        requested_through_message_id: s("msg_input"),
        requested_through_seq: 0,
        base_context_revision: 0,
        target_max_input_tokens: Some(0),
        config_digest: Some(s(&"b".repeat(64))),
        status: s("pending"),
        lease_owner: None,
        lease_expires_at: None,
        attempts: 0,
        manifest_digest: None,
        error_code: None,
        error_message: None,
        time_created: 1,
        time_started: None,
        time_ended: None,
        usage_anchor: None,
    }
}

fn request() -> resources::Request {
    resources::Request {
        id: s("prq_one"),
        session_id: s("ses_root"),
        input_id: None,
        assistant_message_id: None,
        connection_identity_digest: None,
        source: s("step"),
        agent: s("build"),
        model: Document::new(json(r#"{"providerID":"openai","id":"gpt"}"#)).unwrap(),
        route_id: s("route"),
        prompt_cache_key: s("key"),
        system_digest: s("system"),
        tool_digest: s("tools"),
        request: 1,
        attempts: 1,
        invalidation: s("first-request"),
        continuation: s("full"),
        cache_read_reported: None,
        timing: None,
        cost: Some(0.25),
        tokens: Document::new(json(
            r#"{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}"#,
        ))
        .unwrap(),
        time_created: 5,
        usage_anchor: None,
    }
}

fn message() -> session::Message {
    session::Message {
        id: s("msg_assistant"),
        session_id: s("ses_root"),
        type_: s("assistant"),
        seq: 1,
        time_created: 1,
        time_updated: 1,
        data: json(r#"{"agent":"build","model":{"providerID":"openai","id":"gpt"}}"#),
    }
}

fn sessions() -> Vec<session::Session> {
    let mut rows = vec![
        session_row("ses_root", None),
        session_row("ses_child", Some("ses_root")),
    ];
    rows.extend((0..SESSIONS).map(|index| session_row(&format!("ses_bulk_{index:05}"), None)));
    rows
}

fn seed(store: &Store) {
    store
        .submit(|tx| {
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
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    for chunk in sessions().chunks(300) {
        let chunk = chunk.to_vec();
        store
            .submit(move |tx| {
                chunk
                    .iter()
                    .try_for_each(|row| session::SessionTable::insert(tx, row))
            })
            .unwrap()
            .wait()
            .unwrap();
    }
    store
        .submit(|tx| {
            session::RevisionTable::insert(tx, &revision())?;
            session::TaskTable::insert(tx, &task())?;
            session::JobTable::insert(tx, &job())?;
            resources::RequestTable::insert(tx, &request())?;
            session::MessageTable::insert(tx, &message())?;
            resources::KvTable::insert(
                tx,
                &resources::Kv {
                    key: s("setting"),
                    value: Document::new(json(r#"{"kept":true}"#)).unwrap(),
                    time_created: 1,
                    time_updated: 1,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn create(path: &Path, catalog: Catalog) {
    let store = Store::initialize(path, Options::core(), catalog, identity()).unwrap();
    seed(&store);
    store.shutdown().unwrap();
}

fn to_predecessor_layout(path: &Path) {
    let database = redb::Database::open(path).unwrap();
    let write = database.begin_write().unwrap();
    for name in REWRITTEN {
        let mut table = write
            .open_table(TableDefinition::<&[u8], &[u8]>::new(name))
            .unwrap();
        let rows = table
            .iter()
            .unwrap()
            .map(|entry| {
                let (key, value) = entry.unwrap();
                (key.value().to_vec(), value.value().to_vec())
            })
            .collect::<Vec<_>>();
        assert!(!rows.is_empty(), "{name}");
        for (key, value) in rows {
            assert_eq!(value.last(), Some(&0), "{name}");
            table
                .insert(key.as_slice(), &value[..value.len() - 1])
                .unwrap();
        }
    }
    write.commit().unwrap();
}

fn corrupt_last_session(path: &Path) {
    let database = redb::Database::open(path).unwrap();
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

fn plenty(_: &Path) -> Result<u64, ycoding_store::Error> {
    Ok(u64::MAX)
}

fn run(path: &Path) -> Result<Outcome, ycoding_store::Error> {
    upgrade::core(path, Options::core(), plenty)
}

fn head_store(directory: &Directory) -> PathBuf {
    let path = directory.database();
    create(&path, before_analytics());
    to_predecessor_layout(&path);
    path
}

fn assert_preserved_except(before: &Dump, after: &Dump, rewritten: &[&str]) {
    for (name, rows) in before {
        if name == "storage_metadata" {
            for key in [
                "physical_format",
                "catalog_version",
                "record_codec_version",
                "key_codec_version",
                "database_identity",
                "generation",
            ] {
                assert_eq!(
                    metadata_value(before, key),
                    metadata_value(after, key),
                    "{key}"
                );
            }
            continue;
        }
        if rewritten.contains(&name.as_str()) {
            let current = rows
                .iter()
                .map(|(key, value)| (key.clone(), [value.as_slice(), &[0]].concat()))
                .collect::<Vec<_>>();
            assert_eq!(&after[name], &current, "{name}");
            continue;
        }
        assert_eq!(&after[name], rows, "{name}");
    }
}

fn open(path: &Path) -> Store {
    Store::open(path, Options::core(), target()).unwrap()
}

#[test]
fn a_current_store_is_reported_current_without_any_write_or_copy() {
    let directory = Directory::new();
    let path = directory.database();
    create(&path, target());
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(run(&path).unwrap(), Outcome::Current);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert!(!backup::upgrade_path(&path).exists());
}

#[test]
fn the_analytics_predecessor_gains_only_the_incident_tables() {
    let directory = Directory::new();
    let path = directory.database();
    create(&path, before_incidents());
    let before = dump(&path);
    assert!(Store::open(&path, Options::core(), target()).is_err());
    assert_eq!(
        run(&path).unwrap(),
        Outcome::Upgraded(Predecessor::BeforeIncidents)
    );
    let after = dump(&path);
    assert_preserved_except(&before, &after, &[]);
    let added = after
        .keys()
        .filter(|name| !before.contains_key(*name))
        .map(String::as_str)
        .collect::<Vec<_>>();
    let mut expected = ADDED_BEFORE_ANALYTICS[2..].to_vec();
    expected.sort();
    assert_eq!(added, expected);
    assert!(added.iter().all(|name| after[*name].is_empty()));
    let store = open(&path);
    assert_eq!(store.metadata(), &identity());
    store.shutdown().unwrap();
    let copy = Store::open(
        backup::upgrade_path(&path),
        Options::core(),
        before_incidents(),
    )
    .unwrap();
    assert_eq!(copy.metadata(), &identity());
    copy.shutdown().unwrap();
    assert_eq!(dump(&backup::upgrade_path(&path)), before);
}

#[test]
fn the_head_predecessor_rewrites_four_layouts_and_preserves_every_other_row() {
    let directory = Directory::new();
    let path = head_store(&directory);
    let before = dump(&path);
    assert!(Store::open(&path, Options::core(), target()).is_err());
    assert_eq!(
        run(&path).unwrap(),
        Outcome::Upgraded(Predecessor::BeforeAnalytics)
    );
    let after = dump(&path);
    assert_preserved_except(&before, &after, &REWRITTEN);
    let mut added = after
        .keys()
        .filter(|name| !before.contains_key(*name))
        .map(String::as_str)
        .collect::<Vec<_>>();
    added.sort();
    let mut expected = ADDED_BEFORE_ANALYTICS.to_vec();
    expected.sort();
    assert_eq!(added, expected);
    for name in &added {
        let facts = name.starts_with("usage_analytics_request");
        assert_eq!(after[*name].len(), usize::from(facts), "{name}");
    }

    let store = open(&path);
    assert_eq!(store.metadata(), &identity());
    let snapshot = store.snapshot().unwrap();
    let rows = snapshot
        .scan::<session::SessionTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
        .unwrap();
    let mut expected = sessions();
    expected.sort_by(|left, right| left.id.cmp(&right.id));
    assert_eq!(rows, expected);
    assert_eq!(
        snapshot
            .scan::<session::TaskTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap(),
        [task()]
    );
    assert_eq!(
        snapshot
            .scan::<session::JobTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap(),
        [job()]
    );
    assert_eq!(
        snapshot
            .scan::<resources::RequestTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap(),
        [request()]
    );
    assert_eq!(
        snapshot
            .index::<session::SessionTable>(
                "session_parent_idx",
                &tuple_key(&[KeyPart::String(&s("ses_root"))]),
                None,
                10,
            )
            .unwrap(),
        [session_row("ses_child", Some("ses_root"))]
    );
    assert_eq!(
        snapshot
            .index::<resources::RequestTable>(
                "session_provider_request_session_request_idx",
                &tuple_key(&[KeyPart::String(&s("ses_root")), KeyPart::I64(1)]),
                None,
                10,
            )
            .unwrap(),
        [request()]
    );
    drop(snapshot);
    store
        .submit(|tx| {
            model_incident::GuidanceClearTable::put(
                tx,
                &model_incident::GuidanceClear {
                    provider_id: s("openai"),
                    model_id: s("gpt"),
                    cleared_at: NOW,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    store.shutdown().unwrap();
    assert_eq!(dump(&backup::upgrade_path(&path)), before);
}

#[test]
fn a_repeated_upgrade_is_current_and_reopens_without_writes() {
    let directory = Directory::new();
    let path = head_store(&directory);
    run(&path).unwrap();
    let copy = std::fs::read(backup::upgrade_path(&path)).unwrap();
    open(&path).shutdown().unwrap();
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(run(&path).unwrap(), Outcome::Current);
    assert_eq!(run(&path).unwrap(), Outcome::Current);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(std::fs::read(backup::upgrade_path(&path)).unwrap(), copy);
    open(&path).shutdown().unwrap();
}

#[test]
fn unknown_catalogs_are_refused_without_writes_or_copies() {
    const FOREIGN: &[TableDeclaration] = &[TableDeclaration {
        name: "foreign",
        indexes: &[],
    }];
    let extended = {
        let tables = before_incidents()
            .tables()
            .iter()
            .copied()
            .chain(FOREIGN.iter().copied())
            .collect::<Vec<_>>();
        Catalog::new(1, Box::leak(tables.into_boxed_slice()))
    };
    for catalog in [
        extended,
        without(&["model_incident", "model_guidance_clear", "session_usage"]),
        without(&["model_guidance_clear"]),
    ] {
        let directory = Directory::new();
        let path = directory.database();
        Store::initialize(&path, Options::core(), catalog, identity())
            .unwrap()
            .shutdown()
            .unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert!(run(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert!(!backup::upgrade_path(&path).exists());
    }
}

#[test]
fn a_failure_while_rewriting_rows_leaves_the_original_store_intact() {
    let directory = Directory::new();
    let path = head_store(&directory);
    corrupt_last_session(&path);
    let before = dump(&path);
    assert!(run(&path).is_err());
    assert_eq!(dump(&path), before);
    assert!(Store::open(&path, Options::core(), target()).is_err());
    Store::open(&path, Options::core(), before_analytics())
        .unwrap()
        .shutdown()
        .unwrap();
    assert!(run(&path).is_err());
    assert_eq!(dump(&path), before);
    assert_eq!(dump(&backup::upgrade_path(&path)), before);
}

#[test]
fn insufficient_space_for_the_pre_upgrade_copy_refuses_before_any_write() {
    let directory = Directory::new();
    let path = head_store(&directory);
    let before = dump(&path);
    let result = upgrade::core(&path, Options::core(), |_| Ok(0));
    assert!(matches!(
        result,
        Err(ycoding_store::Error::Domain {
            kind: "backup_space",
            ..
        })
    ));
    assert_eq!(dump(&path), before);
    assert!(!backup::upgrade_path(&path).exists());
}

#[test]
fn an_unverifiable_existing_pre_upgrade_copy_is_kept_and_refuses_the_upgrade() {
    let directory = Directory::new();
    let path = head_store(&directory);
    let before = dump(&path);
    std::fs::write(backup::upgrade_path(&path), b"not a database").unwrap();
    assert!(run(&path).is_err());
    assert_eq!(dump(&path), before);
    assert_eq!(
        std::fs::read(backup::upgrade_path(&path)).unwrap(),
        b"not a database"
    );
}

fn with_pre_prune_backup(path: &Path) {
    let predecessor = Store::open(path, Options::core(), before_analytics()).unwrap();
    assert_eq!(
        predecessor.prepare_pruning(NOW, plenty).unwrap(),
        backup::Status::Ready
    );
    predecessor.shutdown().unwrap();
    assert!(backup::marker(path).is_file());
}

fn prune_setting(path: &Path) {
    let database = redb::Database::open(path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut table = write
            .open_table(TableDefinition::<&[u8], &[u8]>::new("kv"))
            .unwrap();
        assert!(
            table
                .remove(tuple_key(&[KeyPart::String(&s("setting"))]).as_slice())
                .unwrap()
                .is_some()
        );
    }
    write.commit().unwrap();
}

fn backup_copy(path: &Path) -> PathBuf {
    backup::upgrade_path(&backup::path(path))
}

fn files(path: &Path) -> [PathBuf; 5] {
    [
        path.to_path_buf(),
        backup::path(path),
        backup::marker(path),
        backup::upgrade_path(path),
        backup_copy(path),
    ]
}

fn bytes(path: &Path) -> Vec<Option<Vec<u8>>> {
    files(path)
        .iter()
        .map(|file| std::fs::read(file).ok())
        .collect()
}

fn head_store_with_pruned_backup(directory: &Directory) -> PathBuf {
    let path = head_store(directory);
    with_pre_prune_backup(&path);
    prune_setting(&path);
    path
}

fn place(from: &Path, to: &Path) {
    std::fs::copy(from, to).unwrap();
}

#[test]
fn the_sole_pre_prune_backup_keeps_its_own_verified_copy_before_it_is_upgraded() {
    let directory = Directory::new();
    let path = head_store_with_pruned_backup(&directory);
    let original = dump(&backup::path(&path));
    let main = dump(&path);
    assert!(original["kv"].len() > main["kv"].len());
    assert_eq!(
        run(&path).unwrap(),
        Outcome::Upgraded(Predecessor::BeforeAnalytics)
    );
    assert_eq!(dump(&backup_copy(&path)), original);
    assert_eq!(dump(&backup::upgrade_path(&path)), main);
    let upgraded = dump(&backup::path(&path));
    assert_preserved_except(&original, &upgraded, &REWRITTEN);
    assert_eq!(upgraded["kv"], original["kv"]);
    let store = open(&path);
    assert_eq!(
        store.prepare_pruning(NOW + 1, plenty).unwrap(),
        backup::Status::Ready
    );
    store.shutdown().unwrap();
    let restored = directory.0.join("restored.redb");
    place(&backup::path(&path), &restored);
    let copy = open(&restored);
    let snapshot = copy.snapshot().unwrap();
    assert_eq!(
        snapshot
            .scan::<session::TaskTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap(),
        [task()]
    );
    assert!(
        snapshot
            .get::<resources::KvTable>(&tuple_key(&[KeyPart::String(&s("setting"))]))
            .unwrap()
            .is_some()
    );
    drop(snapshot);
    copy.shutdown().unwrap();
    let before = bytes(&path);
    assert_eq!(run(&path).unwrap(), Outcome::Current);
    assert_eq!(bytes(&path), before);
}

#[test]
fn failing_to_preserve_the_backup_copy_leaves_the_store_backup_and_marker_unchanged() {
    let directory = Directory::new();
    let path = head_store_with_pruned_backup(&directory);
    std::fs::create_dir(backup_copy(&path)).unwrap();
    let main = std::fs::read(&path).unwrap();
    let original = std::fs::read(backup::path(&path)).unwrap();
    let marker = std::fs::read(backup::marker(&path)).unwrap();
    assert!(run(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), main);
    assert_eq!(std::fs::read(backup::path(&path)).unwrap(), original);
    assert_eq!(std::fs::read(backup::marker(&path)).unwrap(), marker);
    assert!(Store::open(&path, Options::core(), target()).is_err());
    std::fs::remove_dir(backup_copy(&path)).unwrap();
    assert_eq!(
        run(&path).unwrap(),
        Outcome::Upgraded(Predecessor::BeforeAnalytics)
    );
}

#[test]
fn an_upgrade_interrupted_after_the_backup_step_resumes_to_the_same_result() {
    let reference = Directory::new();
    let path = head_store_with_pruned_backup(&reference);
    let interrupted = Directory::new();
    let resumed = interrupted.database();
    place(&path, &resumed);
    place(&backup::path(&path), &backup::path(&resumed));
    place(&backup::marker(&path), &backup::marker(&resumed));
    run(&path).unwrap();
    place(&backup::path(&path), &backup::path(&resumed));
    place(&backup::marker(&path), &backup::marker(&resumed));
    place(&backup_copy(&path), &backup_copy(&resumed));
    assert_eq!(
        run(&resumed).unwrap(),
        Outcome::Upgraded(Predecessor::BeforeAnalytics)
    );
    assert_eq!(dump(&resumed), dump(&path));
    assert_eq!(bytes(&resumed)[1..3], bytes(&path)[1..3]);
    let store = open(&resumed);
    assert_eq!(
        store.prepare_pruning(NOW + 1, plenty).unwrap(),
        backup::Status::Ready
    );
    store.shutdown().unwrap();
}

#[test]
fn an_upgraded_backup_with_a_stale_marker_is_resealed_only_when_its_copy_proves_every_record() {
    let reference = Directory::new();
    let path = head_store_with_pruned_backup(&reference);
    let stale_marker = std::fs::read(backup::marker(&path)).unwrap();
    let original_main = std::fs::read(&path).unwrap();
    let original_backup = std::fs::read(backup::path(&path)).unwrap();
    run(&path).unwrap();
    let stage = |directory: &Directory, copy: bool| {
        let resumed = directory.database();
        std::fs::write(&resumed, &original_main).unwrap();
        place(&backup::path(&path), &backup::path(&resumed));
        std::fs::write(backup::marker(&resumed), &stale_marker).unwrap();
        if copy {
            place(&backup_copy(&path), &backup_copy(&resumed));
        }
        resumed
    };

    let proven = Directory::new();
    let resumed = stage(&proven, true);
    assert_eq!(
        run(&resumed).unwrap(),
        Outcome::Upgraded(Predecessor::BeforeAnalytics)
    );
    assert_eq!(
        std::fs::read(backup::marker(&resumed)).unwrap(),
        std::fs::read(backup::marker(&path)).unwrap()
    );
    let store = open(&resumed);
    assert_eq!(
        store.prepare_pruning(NOW + 1, plenty).unwrap(),
        backup::Status::Ready
    );
    store.shutdown().unwrap();

    let unproven = Directory::new();
    let resumed = stage(&unproven, false);
    let before = bytes(&resumed);
    assert!(run(&resumed).is_err());
    assert_eq!(bytes(&resumed), before);

    let mismatched = Directory::new();
    let resumed = stage(&mismatched, false);
    place(&backup::upgrade_path(&path), &backup_copy(&resumed));
    let before = bytes(&resumed);
    assert!(run(&resumed).is_err());
    assert_eq!(bytes(&resumed), before);
    assert_ne!(
        std::fs::read(backup_copy(&resumed)).unwrap(),
        original_backup
    );
}

#[test]
fn a_backup_copy_that_differs_from_the_predecessor_backup_refuses_without_writes() {
    let directory = Directory::new();
    let path = head_store_with_pruned_backup(&directory);
    place(&path, &backup_copy(&path));
    let before = bytes(&path);
    assert!(run(&path).is_err());
    assert_eq!(bytes(&path)[..3], before[..3]);
    assert_eq!(bytes(&path)[4], before[4]);
    assert!(Store::open(&path, Options::core(), target()).is_err());
}

#[test]
fn a_failure_while_rewriting_the_backup_leaves_every_file_unchanged() {
    let directory = Directory::new();
    let path = head_store_with_pruned_backup(&directory);
    corrupt_last_session(&backup::path(&path));
    let main = dump(&path);
    let backup_rows = dump(&backup::path(&path));
    let marker = std::fs::read(backup::marker(&path)).unwrap();
    for _ in 0..2 {
        assert!(run(&path).is_err());
        assert_eq!(dump(&path), main);
        assert_eq!(dump(&backup::path(&path)), backup_rows);
        assert_eq!(std::fs::read(backup::marker(&path)).unwrap(), marker);
        assert!(Store::open(&path, Options::core(), target()).is_err());
    }
}

#[test]
fn a_tampered_marker_still_blocks_cleanup_after_an_upgrade() {
    let directory = Directory::new();
    let path = head_store_with_pruned_backup(&directory);
    run(&path).unwrap();
    std::fs::write(backup::marker(&path), b"tampered").unwrap();
    let store = open(&path);
    assert!(matches!(
        store.prepare_pruning(NOW + 1, plenty).unwrap(),
        backup::Status::Blocked { .. }
    ));
    store.shutdown().unwrap();
}

#[test]
fn both_predecessors_are_recognized_from_the_live_declarations() {
    let mut names = target()
        .tables()
        .iter()
        .map(|table| table.name)
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(names.len(), 56);
    assert_eq!(before_incidents().tables().len(), 54);
    assert_eq!(before_analytics().tables().len(), 53);
    assert!(
        model_incident::TABLES
            .iter()
            .chain([&TableDeclaration::of::<resources::UsageAnalyticsRequestTable>()])
            .all(|table| target().tables().contains(table))
    );
    assert_eq!(
        resources::UsageAnalyticsRequestTable::NAME,
        "usage_analytics_request"
    );
}

fn ledger(id: &str, session: &str, number: i64, key: &str, time: i64) -> resources::Request {
    resources::Request {
        id: s(id),
        session_id: s(session),
        request: number,
        prompt_cache_key: s(key),
        time_created: time,
        ..request()
    }
}

fn facts(store: &Store) -> Vec<resources::UsageAnalyticsRequest> {
    store
        .snapshot()
        .unwrap()
        .scan::<resources::UsageAnalyticsRequestTable>(
            Bound::Unbounded,
            Bound::Unbounded,
            usize::MAX,
        )
        .unwrap()
}

fn fact_ids_by_time(store: &Store) -> Vec<String> {
    store
        .snapshot()
        .unwrap()
        .index_range::<resources::UsageAnalyticsRequestTable>(
            "usage_analytics_request_time_created_id_idx",
            ycoding_store::IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: None,
                order: ycoding_store::IndexOrder::Ascending,
                after: None,
                limit: usize::MAX,
            },
        )
        .unwrap()
        .into_iter()
        .map(|entry| entry.record.id.as_str().unwrap().to_owned())
        .collect()
}

fn with_ledger(store: &Store) {
    store
        .submit(|tx| {
            session::SessionTable::insert(tx, &session_row("ses_gone", None))?;
            resources::RequestTable::insert(
                tx,
                &resources::Request {
                    source: s("title"),
                    cache_read_reported: Some(1),
                    timing: Some(
                        Document::new(json(
                            r#"{"generatedTokens":12,"generationDurationNs":2000000000}"#,
                        ))
                        .unwrap(),
                    ),
                    cost: None,
                    ..ledger("prq_child", "ses_child", 1, "abcdefghijkl", 7)
                },
            )?;
            resources::RequestTable::insert(
                tx,
                &resources::Request {
                    source: s("custom-source"),
                    agent: s("custom-agent"),
                    continuation: s("unknown-mode"),
                    invalidation: s("other-reason"),
                    attempts: 3,
                    ..ledger("prq_label", "ses_root", 2, "ab😀cdefghi", 9)
                },
            )?;
            resources::RequestTable::insert(
                tx,
                &ledger("prq_orphan", "ses_gone", 1, "orphan", 11),
            )?;
            tx.delete::<session::SessionTable>(&tuple_key(&[KeyPart::String(&s("ses_gone"))]))?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn fact(
    request: resources::Request,
    task_path: &str,
    prompt_cache_key: &str,
) -> resources::UsageAnalyticsRequest {
    resources::UsageAnalyticsRequest {
        id: request.id,
        session_id: request.session_id,
        project_id: s("prj_one"),
        directory: s("/project"),
        workspace_id: None,
        session_updated: 2,
        agent: request.agent,
        source: request.source,
        model: request.model,
        usage_anchor: None,
        task_path: Document::new(json(task_path)).unwrap(),
        request: request.request,
        attempts: request.attempts,
        continuation: request.continuation,
        invalidation: request.invalidation,
        prompt_cache_key: s(prompt_cache_key),
        cache_read_reported: request.cache_read_reported,
        tokens: request.tokens,
        cost: request.cost,
        timing: request.timing,
        time_created: request.time_created,
    }
}

#[test]
fn the_head_predecessor_backfills_report_facts_from_its_retained_ledger_only() {
    let directory = Directory::new();
    let path = directory.database();
    let store = Store::initialize(&path, Options::core(), before_analytics(), identity()).unwrap();
    seed(&store);
    with_ledger(&store);
    store.shutdown().unwrap();
    to_predecessor_layout(&path);
    let before = dump(&path);
    assert_eq!(
        run(&path).unwrap(),
        Outcome::Upgraded(Predecessor::BeforeAnalytics)
    );
    assert_preserved_except(&before, &dump(&path), &REWRITTEN);
    let store = open(&path);
    let requests = store
        .snapshot()
        .unwrap()
        .scan::<resources::RequestTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap();
    assert_eq!(
        requests
            .iter()
            .map(|row| row.id.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["prq_child", "prq_label", "prq_one", "prq_orphan"]
    );
    let by_id = |id: &str| {
        requests
            .iter()
            .find(|row| row.id.as_str() == Some(id))
            .unwrap()
            .clone()
    };
    assert_eq!(
        facts(&store),
        [
            fact(by_id("prq_child"), r#"["ses_child"]"#, "abcdefgh"),
            fact(by_id("prq_label"), "[]", "ab😀cdef"),
            fact(by_id("prq_one"), "[]", "key"),
        ]
    );
    assert_eq!(
        fact_ids_by_time(&store),
        ["prq_one", "prq_child", "prq_label"]
    );
    store.shutdown().unwrap();
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(run(&path).unwrap(), Outcome::Current);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(dump(&backup::upgrade_path(&path)), before);
}

#[test]
fn the_analytics_predecessor_keeps_its_facts_verbatim_and_resurrects_no_expired_fact() {
    let directory = Directory::new();
    let path = directory.database();
    let captured = resources::UsageAnalyticsRequest {
        project_id: s("prj_captured"),
        directory: s("/captured"),
        workspace_id: Some(s("wrk_captured")),
        session_updated: 99,
        usage_anchor: Some(
            Document::new(json(r#"{"sessionID":"ses_root","inputID":"msg_input"}"#)).unwrap(),
        ),
        task_path: Document::new(json(r#"["ses_old_task"]"#)).unwrap(),
        prompt_cache_key: s("capture1"),
        ..fact(request(), "[]", "key")
    };
    let store = Store::initialize(&path, Options::core(), before_incidents(), identity()).unwrap();
    seed(&store);
    let stored = captured.clone();
    store
        .submit(move |tx| {
            resources::RequestTable::insert(tx, &ledger("prq_two", "ses_root", 2, "expired", 6))?;
            resources::UsageAnalyticsRequestTable::insert(tx, &stored)
        })
        .unwrap()
        .wait()
        .unwrap();
    store.shutdown().unwrap();
    let before = dump(&path);
    assert_eq!(
        run(&path).unwrap(),
        Outcome::Upgraded(Predecessor::BeforeIncidents)
    );
    assert_preserved_except(&before, &dump(&path), &[]);
    let store = open(&path);
    assert_eq!(facts(&store), [captured]);
    store.shutdown().unwrap();
}

#[test]
fn a_failure_while_backfilling_facts_leaves_the_original_store_intact() {
    let directory = Directory::new();
    let path = directory.database();
    let store = Store::initialize(&path, Options::core(), before_analytics(), identity()).unwrap();
    seed(&store);
    store
        .submit(|tx| {
            session::SessionTable::insert(tx, &session_row("ses_cycle_a", None))?;
            session::SessionTable::insert(tx, &session_row("ses_cycle_b", Some("ses_cycle_a")))?;
            session::SessionTable::put(tx, &session_row("ses_cycle_a", Some("ses_cycle_b")))?;
            resources::RequestTable::insert(
                tx,
                &ledger("prq_zzz_cycle", "ses_cycle_a", 1, "cycle", 8),
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    store.shutdown().unwrap();
    to_predecessor_layout(&path);
    let before = dump(&path);
    for _ in 0..2 {
        assert!(run(&path).is_err());
        assert_eq!(dump(&path), before);
        assert!(Store::open(&path, Options::core(), target()).is_err());
    }
    assert_eq!(dump(&backup::upgrade_path(&path)), before);
}

fn remove_request_raw(path: &Path, row: &resources::Request) {
    let database = redb::Database::open(path).unwrap();
    let write = database.begin_write().unwrap();
    let primary = tuple_key(&[KeyPart::String(&row.id)]);
    for (table, key) in [
        ("session_provider_request", primary.clone()),
        (
            "session_provider_request_session_request_idx",
            tuple_key(&[KeyPart::String(&row.session_id), KeyPart::I64(row.request)]),
        ),
        (
            "session_provider_request_session_source_idx",
            tuple_key(&[
                KeyPart::Bytes(&tuple_key(&[
                    KeyPart::String(&row.session_id),
                    KeyPart::String(&row.source),
                ])),
                KeyPart::Bytes(&primary),
            ]),
        ),
    ] {
        let mut table = write
            .open_table(TableDefinition::<&[u8], &[u8]>::new(table))
            .unwrap();
        assert!(table.remove(key.as_slice()).unwrap().is_some(), "{key:?}");
    }
    write.commit().unwrap();
}

#[test]
fn the_pre_prune_backup_backfills_facts_from_its_own_ledger_and_still_verifies() {
    let directory = Directory::new();
    let path = head_store(&directory);
    with_pre_prune_backup(&path);
    remove_request_raw(&path, &request());
    assert_eq!(
        run(&path).unwrap(),
        Outcome::Upgraded(Predecessor::BeforeAnalytics)
    );
    let store = open(&path);
    assert!(facts(&store).is_empty());
    assert_eq!(
        store.prepare_pruning(NOW + 1, plenty).unwrap(),
        backup::Status::Ready
    );
    store.shutdown().unwrap();
    let restored = directory.0.join("restored.redb");
    place(&backup::path(&path), &restored);
    let copy = open(&restored);
    assert_eq!(facts(&copy), [fact(request(), "[]", "key")]);
    assert_eq!(fact_ids_by_time(&copy), ["prq_one"]);
    copy.shutdown().unwrap();
    let before = bytes(&path);
    assert_eq!(run(&path).unwrap(), Outcome::Current);
    assert_eq!(bytes(&path), before);
}
