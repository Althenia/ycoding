#![allow(dead_code)]

use std::{
    future::Future,
    ops::Bound,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, AtomicU64, Ordering},
    },
};
use ycoding_core::{
    resources::{config::Roots, tool_output_store},
    session::{cleanups::Cleanups, retention::Settings, runner::Clock},
};
use ycoding_schema::{LosslessString, parse_json, session};
use ycoding_store::{
    Client, KeyPart, Metadata, Options, Store, TableSpec, import, resources, session as tables,
    tuple_key,
};

pub const DAY: i64 = 86_400_000;
pub const NOW: i64 = 100 * DAY;

pub struct TestClock(AtomicI64);
impl TestClock {
    pub fn set(&self, value: i64) {
        self.0.store(value, Ordering::SeqCst);
    }
}
impl Clock for TestClock {
    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
    fn sleep(&self, _: u64) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        Box::pin(std::future::pending())
    }
}

pub fn key(value: &str) -> Vec<u8> {
    tuple_key(&[KeyPart::String(&LosslessString::from(value))])
}

pub fn count<T: TableSpec>(client: &Client) -> usize {
    client
        .snapshot()
        .unwrap()
        .scan::<T>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
        .unwrap()
        .len()
}

pub fn catalog() -> ycoding_store::Catalog {
    import::catalog(import::DatabaseKind::Core)
}

pub fn store() -> Store {
    let store = Store::disposable(Options::core(), catalog(), Metadata::new([7; 16], 1)).unwrap();
    project(&store);
    store
}

pub fn file_store(path: &Path) -> Store {
    let store =
        Store::initialize(path, Options::core(), catalog(), Metadata::new([7; 16], 1)).unwrap();
    project(&store);
    store
}

fn project(store: &Store) {
    store
        .submit(|tx| {
            ycoding_store::project::ProjectTable::insert(
                tx,
                &ycoding_store::project::Project {
                    id: "prj_one".into(),
                    worktree: "/project".into(),
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
}

pub fn request(id: &str, suffix: &str, number: i64, time: i64) -> resources::Request {
    resources::Request {
        id: format!("prq_{id}_{suffix}").into(),
        session_id: id.into(),
        input_id: None,
        assistant_message_id: None,
        connection_identity_digest: None,
        source: "step".into(),
        agent: "build".into(),
        model: tables::Document::new(parse_json(r#"{"providerID":"p","id":"m"}"#).unwrap())
            .unwrap(),
        route_id: "test".into(),
        prompt_cache_key: "key".into(),
        system_digest: "system".into(),
        tool_digest: "tools".into(),
        request: number,
        attempts: 1,
        invalidation: "first-request".into(),
        continuation: "full".into(),
        cache_read_reported: None,
        timing: None,
        cost: Some(1.0),
        tokens: tables::Document::new(
            parse_json(r#"{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}"#)
                .unwrap(),
        )
        .unwrap(),
        time_created: time,
        usage_anchor: None,
    }
}

pub fn fact(id: &str, session: &str, time: i64) -> resources::UsageAnalyticsRequest {
    resources::UsageAnalyticsRequest {
        id: id.into(),
        session_id: session.into(),
        project_id: "prj_one".into(),
        directory: "/project".into(),
        workspace_id: None,
        session_updated: time,
        agent: "build".into(),
        source: "step".into(),
        model: tables::Document::new(parse_json(r#"{"providerID":"p","id":"m"}"#).unwrap())
            .unwrap(),
        usage_anchor: None,
        task_path: tables::Document::new(parse_json("[]").unwrap()).unwrap(),
        request: 1,
        attempts: 1,
        continuation: "full".into(),
        invalidation: "first-request".into(),
        prompt_cache_key: "abcdefgh".into(),
        cache_read_reported: None,
        tokens: tables::Document::new(
            parse_json(r#"{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}"#)
                .unwrap(),
        )
        .unwrap(),
        cost: Some(1.0),
        timing: None,
        time_created: time,
    }
}

pub fn insert_facts(store: &Store, facts: Vec<resources::UsageAnalyticsRequest>) {
    store
        .submit(move |tx| {
            facts
                .iter()
                .try_for_each(|fact| resources::UsageAnalyticsRequestTable::insert(tx, fact))
        })
        .unwrap()
        .wait()
        .unwrap();
}

pub fn fact_ids(client: &Client) -> Vec<String> {
    client
        .snapshot()
        .unwrap()
        .scan::<resources::UsageAnalyticsRequestTable>(
            Bound::Unbounded,
            Bound::Unbounded,
            usize::MAX,
        )
        .unwrap()
        .into_iter()
        .map(|row| row.id.as_str().unwrap().to_owned())
        .collect()
}

pub fn insert_requests(store: &Store, rows: Vec<resources::Request>) {
    store
        .submit(move |tx| {
            rows.iter()
                .try_for_each(|row| resources::RequestTable::insert(tx, row))
        })
        .unwrap()
        .wait()
        .unwrap();
}

pub fn pruned_through(client: &Client, id: &str) -> Option<i64> {
    client
        .snapshot()
        .unwrap()
        .get::<tables::SessionTable>(&key(id))
        .unwrap()
        .unwrap()
        .usage_pruned_through
}

pub fn seed(store: &Store, id: &str, updated: i64) {
    let id = id.to_owned();
    store
        .submit(move |tx| {
            tables::SessionTable::put(
                tx,
                &tables::Session {
                    time_updated: updated,
                    ..super::autonomy::record(&id)
                },
            )?;
            tables::SequenceTable::put(
                tx,
                &tables::Sequence {
                    aggregate_id: id.as_str().into(),
                    seq: 0,
                    owner_id: None,
                },
            )?;
            tables::EventTable::insert(
                tx,
                &tables::Event {
                    id: format!("evt_{id}").into(),
                    aggregate_id: id.as_str().into(),
                    seq: 0,
                    created: 0,
                    type_: "session.file_change.recorded.2".into(),
                    data: parse_json(
                        r#"{"change":{"path":"file","patch":"@@","additions":1,"deletions":0}}"#,
                    )
                    .unwrap(),
                },
            )?;
            tables::MessageTable::insert(
                tx,
                &tables::Message {
                    id: format!("msg_{id}").into(),
                    session_id: id.as_str().into(),
                    type_: "user".into(),
                    seq: 0,
                    time_created: 0,
                    time_updated: 0,
                    data: parse_json(r#"{"text":"canonical transcript"}"#).unwrap(),
                },
            )?;
            tables::FileChangeTable::insert(
                tx,
                &tables::FileChange {
                    session_id: id.as_str().into(),
                    path: "file".into(),
                    patch: "@@".into(),
                    additions: 1,
                    deletions: 0,
                    latest_seq: 0,
                },
            )?;
            tables::ManifestTable::put(
                tx,
                &tables::Manifest {
                    digest: "a".repeat(64).into(),
                    schema_version: 1,
                    content: tables::Document::new(parse_json("{}").unwrap())?,
                    input_tokens: 1,
                    retained_tokens: 0,
                    time_created: 0,
                },
            )?;
            tables::RevisionTable::insert(
                tx,
                &tables::Revision {
                    session_id: id.as_str().into(),
                    revision: 0,
                    parent_revision: None,
                    manifest_digest: None,
                    covered_through_message_id: None,
                    covered_through_seq: None,
                    activation_event_id: None,
                    activation_sequence: None,
                    time_created: 0,
                },
            )?;
            tables::ExclusionTable::insert(
                tx,
                &tables::Exclusion {
                    session_id: id.as_str().into(),
                    context_revision: 0,
                    target_key: "b".repeat(64).into(),
                    target_kind: "message".into(),
                    target_selector: tables::Document::new(parse_json("{}").unwrap())?,
                    dependency_group: None,
                    reason: "exact_duplicate".into(),
                    manifest_digest: "a".repeat(64).into(),
                },
            )?;
            resources::RequestTable::insert(tx, &request(&id, "old", 1, updated))?;
            resources::UsageTable::insert(
                tx,
                &resources::Usage {
                    session_id: id.as_str().into(),
                    model_key: "p:m".into(),
                    model: request(&id, "unused", 0, 0).model,
                    logical: 1,
                    physical: 1,
                    helpers: 0,
                    continued: 0,
                    fallback: 0,
                    cost: Some(1.0),
                    input: 1,
                    output: 1,
                    reasoning: 0,
                    cache_read: 0,
                    cache_write: 0,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}

pub struct Harness {
    pub root: PathBuf,
    pub outputs: Arc<tool_output_store::Store>,
    pub clock: Arc<TestClock>,
    pub active: Arc<Mutex<Vec<session::Id>>>,
    pub settings: Arc<Mutex<Settings>>,
}
impl Harness {
    pub fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "ycoding-usage-retention-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let roots = Roots::development(&root).unwrap();
        Self {
            root,
            outputs: Arc::new(tool_output_store::Store::new(&roots)),
            clock: Arc::new(TestClock(AtomicI64::new(NOW))),
            active: Arc::default(),
            settings: Arc::new(Mutex::new(Settings {
                records_days: 7,
                usage_days: 30,
                latency_days: 30,
                incident_days: 30,
            })),
        }
    }
    pub fn cleanups(&self, client: Client) -> Cleanups {
        let active = self.active.clone();
        self.cleanups_with(client, Arc::new(move || active.lock().unwrap().clone()))
    }
    pub fn cleanups_with(
        &self,
        client: Client,
        active: Arc<dyn Fn() -> Vec<session::Id> + Send + Sync>,
    ) -> Cleanups {
        let settings = self.settings.clone();
        Cleanups::new(
            client,
            self.outputs.clone(),
            self.clock.clone(),
            active,
            Arc::new(move || *settings.lock().unwrap()),
        )
    }
    pub fn set(&self, records_days: i64, usage_days: i64) {
        let mut settings = self.settings.lock().unwrap();
        settings.records_days = records_days;
        settings.usage_days = usage_days;
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        if self.root.exists() {
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }
}
