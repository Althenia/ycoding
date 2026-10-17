use std::sync::Mutex;
use ycoding_schema::{model, parse_json, provider};
use ycoding_store::{
    KeyPart, Metadata, Options, Store,
    analytics::{self, Query, Value, reports},
    import, project, resources,
    session::{self as tables, Document},
    tuple_key,
};

static SERIAL: Mutex<()> = Mutex::new(());

fn store() -> Store {
    Store::disposable(
        Options::core(),
        import::catalog(import::DatabaseKind::Core),
        Metadata::new([33; 16], 1),
    )
    .unwrap()
}

fn fact(index: i64, session: &str) -> resources::UsageAnalyticsRequest {
    resources::UsageAnalyticsRequest {
        id: format!("fact-{index:04}").into(),
        session_id: session.into(),
        project_id: "p".into(),
        directory: "/project".into(),
        workspace_id: None,
        session_updated: 1,
        agent: "build".into(),
        source: "step".into(),
        model: Document::from_domain(&model::Ref {
            provider_id: provider::Id("openai".into()),
            id: format!("model_{index:03}").into(),
            variant: None,
            profile: None,
        })
        .unwrap(),
        usage_anchor: None,
        task_path: Document::new(parse_json("[]").unwrap()).unwrap(),
        request: index,
        attempts: 1,
        continuation: "full".into(),
        invalidation: "none".into(),
        prompt_cache_key: "private-".into(),
        cache_read_reported: Some(1),
        tokens: Document::new(
            parse_json(r#"{"input":1,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#)
                .unwrap(),
        )
        .unwrap(),
        cost: Some(1.0),
        timing: None,
        time_created: index,
    }
}

fn query(sql: &'static str, max_rows: usize) -> Query {
    Query {
        sql,
        parameters: Vec::new(),
        max_rows,
    }
}

fn number(value: &Value) -> f64 {
    reports::value_number(value).unwrap()
}

#[test]
fn the_fact_source_exposes_normalized_columns_and_none_of_the_private_fields() {
    let source = reports::SOURCES
        .iter()
        .find(|source| source.name == "usage_analytics_request")
        .unwrap();
    let ledger = reports::SOURCES
        .iter()
        .find(|source| source.name == "session_provider_request")
        .unwrap();
    assert!(
        ledger
            .columns
            .iter()
            .any(|column| column.name == "input_key"
                && matches!(column.kind, analytics::ColumnType::Text)),
        "the ledger carries the lossless prompt-hint lookup key"
    );
    assert!(
        !source
            .columns
            .iter()
            .any(|column| column.name == "input_key"),
        "retained facts never gain ledger-only hint material"
    );
    for column in ledger
        .columns
        .iter()
        .filter(|column| column.name != "input_key")
    {
        assert!(
            source
                .columns
                .iter()
                .any(|candidate| candidate.name == column.name
                    && std::mem::discriminant(&candidate.kind)
                        == std::mem::discriminant(&column.kind)),
            "missing normalized column {}",
            column.name
        );
    }
    for column in ["project_id", "directory", "workspace_id"] {
        assert!(
            source
                .columns
                .iter()
                .any(|candidate| candidate.name == column),
            "{column}"
        );
    }
    for field in [
        "id",
        "prompt_cache_key",
        "route_id",
        "system_digest",
        "tool_digest",
        "connection_identity_digest",
        "payload",
        "credential",
        "email",
    ] {
        assert!(
            !source.columns.iter().any(|column| column.name == field),
            "{field}"
        );
    }
}

#[test]
fn the_fact_source_exposes_the_recorded_session_update_time() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let source = reports::SOURCES
        .iter()
        .find(|source| source.name == "usage_analytics_request")
        .unwrap();
    assert!(
        source
            .columns
            .iter()
            .any(|column| column.name == "session_updated"
                && matches!(column.kind, analytics::ColumnType::Integer))
    );
    let root = std::env::temp_dir().join(format!(
        "ycoding-store-usage-source-updated-{}",
        std::process::id()
    ));
    let store = store();
    let engine = reports::start(store.client(), &root).unwrap();
    store
        .submit(|tx| {
            resources::UsageAnalyticsRequestTable::insert(
                tx,
                &resources::UsageAnalyticsRequest {
                    session_updated: 777,
                    ..fact(1, "ses_gone")
                },
            )?;
            resources::UsageAnalyticsRequestTable::insert(
                tx,
                &resources::UsageAnalyticsRequest {
                    session_updated: 4242,
                    ..fact(2, "ses_gone")
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let rows = engine
        .report(vec![query(
            "SELECT session_updated FROM usage_analytics_request ORDER BY session_updated",
            2,
        )])
        .unwrap();
    assert_eq!(
        rows[0]
            .iter()
            .map(|row| number(&row[0]))
            .collect::<Vec<_>>(),
        [777.0, 4242.0]
    );
    engine.shutdown().unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn facts_without_sessions_reconcile_every_committed_row_and_purge_after_deletion() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root =
        std::env::temp_dir().join(format!("ycoding-store-usage-source-{}", std::process::id()));
    let store = store();
    let engine = reports::start(store.client(), &root).unwrap();
    store
        .submit(|tx| {
            (0..405).try_for_each(|index| {
                resources::UsageAnalyticsRequestTable::insert(tx, &fact(index, "ses_gone"))
            })
        })
        .unwrap()
        .wait()
        .unwrap();
    let rows = engine
        .report(vec![
            query(
                "SELECT model_key,sum(input) FROM usage_analytics_request GROUP BY model_key ORDER BY model_key LIMIT 3 OFFSET 300",
                3,
            ),
            query(
                "SELECT count(*),sum(input),sum(cost),min(time_created),max(time_created) FROM usage_analytics_request",
                1,
            ),
            query("SELECT count(*) FROM session", 1),
        ])
        .unwrap();
    assert_eq!(rows[0].len(), 3);
    assert_eq!(rows[0][0][0], Value::Text("openai/model_300".into()));
    assert_eq!(
        (0..5)
            .map(|column| number(&rows[1][0][column]))
            .collect::<Vec<_>>(),
        [405.0, 405.0, 405.0, 0.0, 404.0]
    );
    assert_eq!(number(&rows[2][0][0]), 0.0);

    store
        .submit(|tx| {
            resources::UsageAnalyticsRequestTable::delete(
                tx,
                &tuple_key(&[KeyPart::String(&"fact-0000".into())]),
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(matches!(
        engine.report(vec![query(
            "SELECT count(*) FROM usage_analytics_request",
            1
        )]),
        Err(analytics::Error::Privacy)
    ));
    engine.purge().unwrap();
    assert_eq!(
        number(
            &engine
                .report(vec![query(
                    "SELECT count(*) FROM usage_analytics_request",
                    1
                )])
                .unwrap()[0][0][0]
        ),
        404.0
    );
    engine.shutdown().unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn session_deletion_purges_the_ledger_source_but_never_the_fact_source() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let root = std::env::temp_dir().join(format!(
        "ycoding-store-usage-source-session-{}",
        std::process::id()
    ));
    let store = store();
    let engine = reports::start(store.client(), &root).unwrap();
    store
        .submit(|tx| {
            project::ProjectTable::insert(
                tx,
                &project::Project {
                    id: "p".into(),
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
                    project_id: "p".into(),
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
                    id: "fact-0001".into(),
                    session_id: "ses_one".into(),
                    input_id: None,
                    assistant_message_id: None,
                    connection_identity_digest: None,
                    source: "step".into(),
                    agent: "build".into(),
                    model: fact(1, "ses_one").model,
                    route_id: "private-route".into(),
                    prompt_cache_key: "private-cache".into(),
                    system_digest: "private-system".into(),
                    tool_digest: "private-tools".into(),
                    request: 1,
                    attempts: 1,
                    invalidation: "none".into(),
                    continuation: "full".into(),
                    cache_read_reported: Some(1),
                    timing: None,
                    cost: Some(1.0),
                    tokens: fact(1, "ses_one").tokens,
                    time_created: 1,
                    usage_anchor: None,
                },
            )?;
            resources::UsageAnalyticsRequestTable::insert(tx, &fact(1, "ses_one"))
        })
        .unwrap()
        .wait()
        .unwrap();
    let both = engine
        .report(vec![
            query("SELECT count(*) FROM session_provider_request", 1),
            query("SELECT count(*) FROM usage_analytics_request", 1),
        ])
        .unwrap();
    assert_eq!((number(&both[0][0][0]), number(&both[1][0][0])), (1.0, 1.0));
    store
        .submit(|tx| tables::delete(tx, &"ses_one".into()))
        .unwrap()
        .wait()
        .unwrap();
    engine.purge().unwrap();
    let both = engine
        .report(vec![
            query("SELECT count(*) FROM session_provider_request", 1),
            query("SELECT count(*) FROM usage_analytics_request", 1),
            query("SELECT count(*) FROM session", 1),
        ])
        .unwrap();
    assert_eq!(
        (
            number(&both[0][0][0]),
            number(&both[1][0][0]),
            number(&both[2][0][0])
        ),
        (0.0, 1.0, 0.0)
    );
    engine.shutdown().unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
