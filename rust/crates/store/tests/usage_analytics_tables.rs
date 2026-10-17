use std::{
    ops::Bound,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_schema::{
    DomainEncode, LosslessString, parse_json, session_id::SessionId, session_message_id,
    usage_anchor,
};
use ycoding_store::{
    IndexOrder, IndexQuery, KeyPart, Metadata, Options, Store, TableSpec, backup, import, project,
    resources,
    session::{self as tables, Document},
    tuple_key,
};

static NEXT: AtomicU64 = AtomicU64::new(0);

fn catalog() -> ycoding_store::Catalog {
    import::catalog(import::DatabaseKind::Core)
}

fn store() -> Store {
    Store::disposable(Options::core(), catalog(), Metadata::new([5; 16], 1)).unwrap()
}

fn anchor() -> usage_anchor::Ref {
    usage_anchor::Ref {
        session_id: SessionId::new("ses_one").unwrap(),
        input_id: session_message_id::Id::new("msg_one").unwrap(),
    }
}

fn fact(id: &str, session: &str, time: i64) -> resources::UsageAnalyticsRequest {
    resources::UsageAnalyticsRequest {
        id: id.into(),
        session_id: session.into(),
        project_id: "prj_one".into(),
        directory: "/project".into(),
        workspace_id: None,
        session_updated: time,
        agent: "build".into(),
        source: "step".into(),
        model: Document::new(parse_json(r#"{"providerID":"openai","id":"gpt"}"#).unwrap()).unwrap(),
        usage_anchor: None,
        task_path: Document::new(parse_json("[]").unwrap()).unwrap(),
        request: 1,
        attempts: 1,
        continuation: "full".into(),
        invalidation: "first-request".into(),
        prompt_cache_key: "abcdefgh".into(),
        cache_read_reported: None,
        tokens: Document::new(
            parse_json(r#"{"input":1,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#)
                .unwrap(),
        )
        .unwrap(),
        cost: None,
        timing: None,
        time_created: time,
    }
}

fn full_fact() -> resources::UsageAnalyticsRequest {
    resources::UsageAnalyticsRequest {
        workspace_id: Some("wrk_one".into()),
        usage_anchor: Some(Document::from_domain(&anchor()).unwrap()),
        task_path: Document::new(parse_json(r#"["ses_child","ses_parent"]"#).unwrap()).unwrap(),
        cache_read_reported: Some(1),
        cost: Some(0.25),
        timing: Some(
            Document::new(
                parse_json(r#"{"generatedTokens":12,"generationDurationNs":2000000000}"#).unwrap(),
            )
            .unwrap(),
        ),
        ..fact("fact_full", "ses_gone", 42)
    }
}

fn insert(store: &Store, facts: Vec<resources::UsageAnalyticsRequest>) {
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

fn scan(store: &Store) -> Vec<resources::UsageAnalyticsRequest> {
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

fn ordered(store: &Store, order: IndexOrder, lower: Bound<&[u8]>) -> Vec<String> {
    store
        .snapshot()
        .unwrap()
        .index_range::<resources::UsageAnalyticsRequestTable>(
            "usage_analytics_request_time_created_id_idx",
            IndexQuery {
                lower,
                upper: Bound::Unbounded,
                prefix: None,
                order,
                after: None,
                limit: 100,
            },
        )
        .unwrap()
        .into_iter()
        .map(|entry| entry.record.id.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn the_fact_table_is_declared_with_one_secondary_time_index_and_is_part_of_the_core_catalog() {
    assert_eq!(
        resources::UsageAnalyticsRequestTable::NAME,
        "usage_analytics_request"
    );
    let indexes = resources::UsageAnalyticsRequestTable::INDEXES;
    assert_eq!(indexes.len(), 1);
    assert_eq!(
        indexes[0].name,
        "usage_analytics_request_time_created_id_idx"
    );
    assert!(!indexes[0].unique);
    assert!(
        resources::TABLES
            .iter()
            .any(|table| table.name == "usage_analytics_request")
    );
    assert!(
        catalog()
            .tables()
            .iter()
            .any(|table| table.name == "usage_analytics_request")
    );
}

#[test]
fn facts_without_a_session_round_trip_every_column() {
    let store = store();
    let full = full_fact();
    insert(
        &store,
        vec![full.clone(), fact("fact_minimal", "ses_gone", 43)],
    );
    let rows = scan(&store);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0], full);
    assert_eq!(
        rows[0].usage_anchor.as_ref().unwrap().value(),
        &anchor().encode()
    );
    assert_eq!(rows[1], fact("fact_minimal", "ses_gone", 43));
    assert!(rows[1].usage_anchor.is_none() && rows[1].workspace_id.is_none());
    let by_key = store
        .snapshot()
        .unwrap()
        .get::<resources::UsageAnalyticsRequestTable>(&tuple_key(&[KeyPart::String(
            &LosslessString::from("fact_full"),
        )]))
        .unwrap();
    assert_eq!(by_key, Some(full));
}

#[test]
fn a_second_insert_of_the_same_id_is_refused_and_leaves_the_first_row() {
    let store = store();
    insert(&store, vec![full_fact()]);
    let duplicate = resources::UsageAnalyticsRequest {
        cost: Some(99.0),
        ..full_fact()
    };
    assert!(
        store
            .submit(move |tx| resources::UsageAnalyticsRequestTable::insert(tx, &duplicate))
            .unwrap()
            .wait()
            .is_err()
    );
    assert_eq!(scan(&store), vec![full_fact()]);
}

#[test]
fn the_time_index_orders_by_creation_time_then_id_in_both_directions_and_honors_a_lower_bound() {
    let store = store();
    insert(
        &store,
        vec![
            fact("fact_b", "ses_gone", 5),
            fact("fact_a", "ses_gone", 5),
            fact("fact_c", "ses_gone", 1),
            fact("fact_d", "ses_gone", 9),
        ],
    );
    assert_eq!(
        ordered(&store, IndexOrder::Ascending, Bound::Unbounded),
        ["fact_c", "fact_a", "fact_b", "fact_d"]
    );
    assert_eq!(
        ordered(&store, IndexOrder::Descending, Bound::Unbounded),
        ["fact_d", "fact_b", "fact_a", "fact_c"]
    );
    let lower = tuple_key(&[KeyPart::I64(5)]);
    assert_eq!(
        ordered(&store, IndexOrder::Ascending, Bound::Included(&lower)),
        ["fact_a", "fact_b", "fact_d"]
    );
    let after = tuple_key(&[KeyPart::I64(6)]);
    assert_eq!(
        ordered(&store, IndexOrder::Ascending, Bound::Included(&after)),
        ["fact_d"]
    );
}

#[test]
fn deleting_a_fact_removes_its_index_entry() {
    let store = store();
    insert(
        &store,
        vec![fact("fact_a", "ses_gone", 1), fact("fact_b", "ses_gone", 2)],
    );
    store
        .submit(|tx| {
            resources::UsageAnalyticsRequestTable::delete(
                tx,
                &tuple_key(&[KeyPart::String(&LosslessString::from("fact_a"))]),
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        ordered(&store, IndexOrder::Ascending, Bound::Unbounded),
        ["fact_b"]
    );
}

#[test]
fn session_request_task_and_compaction_rows_keep_an_optional_anchor_and_sessions_a_monotonic_cutoff_column()
 {
    let store = store();
    store
        .submit(|tx| {
            project::ProjectTable::insert(
                tx,
                &project::Project {
                    id: "prj_one".into(),
                    worktree: "/project".into(),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 1,
                    time_updated: 1,
                    time_initialized: None,
                    sandboxes: Vec::new(),
                    commands: None,
                },
            )?;
            for (id, parent, pruned) in [
                ("ses_one", None, Some(1234)),
                ("ses_two", Some("ses_one"), None),
            ] {
                tables::SessionTable::insert(
                    tx,
                    &tables::Session {
                        id: id.into(),
                        project_id: "prj_one".into(),
                        workspace_id: None,
                        parent_id: parent.map(Into::into),
                        fork_session_id: None,
                        fork_message_id: None,
                        fork_seq: None,
                        directory: "/project".into(),
                        path: None,
                        title: "Title".into(),
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
                        agent: None,
                        model: None,
                        profile_binding: None,
                        daybreak: None,
                        time_created: 1,
                        time_updated: 1,
                        time_archived: None,
                        time_active: None,
                        time_pinned: None,
                        time_suspended: None,
                        usage_pruned_through: pruned,
                    },
                )?;
            }
            tables::RevisionTable::insert(
                tx,
                &tables::Revision {
                    session_id: "ses_one".into(),
                    revision: 0,
                    parent_revision: None,
                    manifest_digest: None,
                    covered_through_message_id: None,
                    covered_through_seq: None,
                    activation_event_id: None,
                    activation_sequence: None,
                    time_created: 1,
                },
            )?;
            let anchor = Some(Document::from_domain(&anchor())?);
            resources::RequestTable::insert(
                tx,
                &resources::Request {
                    id: "prq_one".into(),
                    session_id: "ses_one".into(),
                    input_id: None,
                    assistant_message_id: None,
                    connection_identity_digest: None,
                    source: "step".into(),
                    agent: "build".into(),
                    model: Document::new(
                        parse_json(r#"{"providerID":"openai","id":"gpt"}"#).unwrap(),
                    )?,
                    route_id: "test".into(),
                    prompt_cache_key: "key".into(),
                    system_digest: "system".into(),
                    tool_digest: "tools".into(),
                    request: 1,
                    attempts: 1,
                    invalidation: "first-request".into(),
                    continuation: "full".into(),
                    cache_read_reported: None,
                    timing: None,
                    cost: None,
                    tokens: Document::new(
                        parse_json(
                            r#"{"input":1,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#,
                        )
                        .unwrap(),
                    )?,
                    time_created: 1,
                    usage_anchor: anchor.clone(),
                },
            )?;
            tables::TaskTable::insert(
                tx,
                &tables::Task {
                    session_id: "ses_two".into(),
                    parent_id: "ses_one".into(),
                    parent_assistant_message_id: "assistant".into(),
                    tool_call_id: "call".into(),
                    input_id: "input".into(),
                    description: "task".into(),
                    agent: "build".into(),
                    model: Document::new(
                        parse_json(r#"{"providerID":"test","id":"test"}"#).unwrap(),
                    )?,
                    prompt_digest: "digest".into(),
                    background: 1,
                    delivery: "steer".into(),
                    state: "running".into(),
                    progress: None,
                    progress_time: None,
                    question_id: None,
                    question: None,
                    question_data: None,
                    question_time: None,
                    attempt_started: 0,
                    owner_pid: None,
                    owner_started: None,
                    revision: 0,
                    time_created: 1,
                    time_updated: 1,
                    usage_anchor: anchor.clone(),
                },
            )?;
            tables::JobTable::insert(
                tx,
                &tables::Job {
                    id: "cmp_one".into(),
                    session_id: "ses_one".into(),
                    legacy_input_id: Some("msg_one".into()),
                    trigger: "manual".into(),
                    requested_through_message_id: "msg_one".into(),
                    requested_through_seq: 0,
                    base_context_revision: 0,
                    target_max_input_tokens: None,
                    config_digest: None,
                    status: "pending".into(),
                    lease_owner: None,
                    lease_expires_at: None,
                    attempts: 0,
                    manifest_digest: None,
                    error_code: None,
                    error_message: None,
                    time_created: 1,
                    time_started: None,
                    time_ended: None,
                    usage_anchor: anchor,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    let expected = Some(anchor().encode());
    let request = snapshot
        .get::<resources::RequestTable>(&tuple_key(&[KeyPart::String(&"prq_one".into())]))
        .unwrap()
        .unwrap();
    assert_eq!(request.usage_anchor.map(|a| a.value().clone()), expected);
    let task = snapshot
        .get::<tables::TaskTable>(&tuple_key(&[KeyPart::String(&"ses_two".into())]))
        .unwrap()
        .unwrap();
    assert_eq!(task.usage_anchor.map(|a| a.value().clone()), expected);
    let job = snapshot
        .get::<tables::JobTable>(&tuple_key(&[KeyPart::String(&"cmp_one".into())]))
        .unwrap()
        .unwrap();
    assert_eq!(job.usage_anchor.map(|a| a.value().clone()), expected);
    for (id, pruned) in [("ses_one", Some(1234)), ("ses_two", None)] {
        let row = snapshot
            .get::<tables::SessionTable>(&tuple_key(&[KeyPart::String(&id.into())]))
            .unwrap()
            .unwrap();
        assert_eq!(row.usage_pruned_through, pruned, "{id}");
    }
}

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ycoding-usage-tables-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn the_verified_backup_restores_every_fact_with_its_indexes() {
    let scratch = Scratch::new();
    let path = scratch.0.join("core.redb");
    let store =
        Store::initialize(&path, Options::core(), catalog(), Metadata::new([5; 16], 1)).unwrap();
    insert(
        &store,
        vec![
            full_fact(),
            fact("fact_a", "ses_gone", 5),
            fact("fact_b", "ses_other_gone", 7),
        ],
    );
    let rows = scan(&store);
    assert_eq!(rows.len(), 3);
    assert_eq!(
        store.prepare_pruning(0, |_| Ok(u64::MAX)).unwrap(),
        backup::Status::Ready
    );
    let restored = scratch.0.join("restored.redb");
    std::fs::copy(backup::path(&path), &restored).unwrap();
    let copy = Store::open(&restored, Options::core(), catalog()).unwrap();
    assert_eq!(scan(&copy), rows);
    assert_eq!(
        ordered(&copy, IndexOrder::Ascending, Bound::Unbounded),
        ["fact_a", "fact_b", "fact_full"]
    );
    copy.shutdown().unwrap();
    store.shutdown().unwrap();
}

#[test]
fn deleting_a_session_removes_its_ledger_rows_and_keeps_its_facts() {
    let store = store();
    store
        .submit(|tx| {
            project::ProjectTable::insert(
                tx,
                &project::Project {
                    id: "prj_one".into(),
                    worktree: "/project".into(),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 1,
                    time_updated: 1,
                    time_initialized: None,
                    sandboxes: Vec::new(),
                    commands: None,
                },
            )?;
            tables::SessionTable::insert(
                tx,
                &tables::Session {
                    id: "ses_one".into(),
                    project_id: "prj_one".into(),
                    workspace_id: None,
                    parent_id: None,
                    fork_session_id: None,
                    fork_message_id: None,
                    fork_seq: None,
                    directory: "/project".into(),
                    path: None,
                    title: "Title".into(),
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
                    agent: None,
                    model: None,
                    profile_binding: None,
                    daybreak: None,
                    time_created: 1,
                    time_updated: 1,
                    time_archived: None,
                    time_active: None,
                    time_pinned: None,
                    time_suspended: None,
                    usage_pruned_through: None,
                },
            )?;
            resources::RequestTable::insert(
                tx,
                &resources::Request {
                    id: "prq_one".into(),
                    session_id: "ses_one".into(),
                    input_id: None,
                    assistant_message_id: None,
                    connection_identity_digest: None,
                    source: "step".into(),
                    agent: "build".into(),
                    model: Document::new(
                        parse_json(r#"{"providerID":"openai","id":"gpt"}"#).unwrap(),
                    )?,
                    route_id: "test".into(),
                    prompt_cache_key: "key".into(),
                    system_digest: "system".into(),
                    tool_digest: "tools".into(),
                    request: 1,
                    attempts: 1,
                    invalidation: "first-request".into(),
                    continuation: "full".into(),
                    cache_read_reported: None,
                    timing: None,
                    cost: None,
                    tokens: Document::new(
                        parse_json(
                            r#"{"input":1,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#,
                        )
                        .unwrap(),
                    )?,
                    time_created: 1,
                    usage_anchor: None,
                },
            )?;
            resources::UsageAnalyticsRequestTable::insert(tx, &fact("prq_one", "ses_one", 1))
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(
        store
            .submit(|tx| tables::delete(tx, &"ses_one".into()))
            .unwrap()
            .wait()
            .unwrap()
    );
    let snapshot = store.snapshot().unwrap();
    assert!(
        snapshot
            .get::<resources::RequestTable>(&tuple_key(&[KeyPart::String(&"prq_one".into())]))
            .unwrap()
            .is_none()
    );
    assert!(
        snapshot
            .get::<tables::SessionTable>(&tuple_key(&[KeyPart::String(&"ses_one".into())]))
            .unwrap()
            .is_none()
    );
    drop(snapshot);
    assert_eq!(scan(&store), vec![fact("prq_one", "ses_one", 1)]);
    assert_eq!(
        ordered(&store, IndexOrder::Ascending, Bound::Unbounded),
        ["prq_one"]
    );
}
