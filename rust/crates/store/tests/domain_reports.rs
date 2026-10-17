use ycoding_schema::{model, parse_json, provider};
use ycoding_store::{
    Metadata, Options, Store,
    analytics::{self, Query, Value, reports},
    project, resources, session,
};

#[test]
fn domain_sources_reconcile_every_committed_row_metadata_retention_and_purge_without_private_fields()
 {
    let root = std::env::temp_dir().join(format!(
        "ycoding-store-domain-reports-{}",
        std::process::id()
    ));
    let store = Store::disposable(
        Options::core(),
        ycoding_store::import::catalog(ycoding_store::import::DatabaseKind::Core),
        Metadata::new([31; 16], 1),
    )
    .unwrap();
    let engine = reports::start(store.client(), &root).unwrap();
    store.submit(|tx| {
        project::ProjectTable::insert(tx,&project::Project { id: "p".into(),worktree: "/project".into(),vcs: None,name: None,icon_url: None,icon_url_override: None,icon_color: None,time_created: 1,time_updated: 1,time_initialized: None,sandboxes: Vec::new(),commands: None })?;
        session::SessionTable::insert(tx,&session::Session { id: "s".into(),project_id: "p".into(),workspace_id: None,parent_id: None,fork_session_id: None,fork_message_id: None,fork_seq: None,directory: "/project".into(),path: None,title: "Title".into(),cost:0.0,tokens_input:0,tokens_output:0,tokens_reasoning:0,tokens_cache_read:0,tokens_cache_write:0,revert:None,permission:None,autonomy:None,autonomy_revision:0,orchestration_revision:0,agent:None,model:None,profile_binding:None,daybreak:None,time_created:1,time_updated:1,time_archived:None,time_active:None,time_pinned:None,time_suspended:None, usage_pruned_through:None })?;
        for index in 0..405 {
            resources::RequestTable::insert(tx,&resources::Request { id: format!("private-request-{index}").into(),session_id:"s".into(),input_id:None,assistant_message_id:None,connection_identity_digest:None,source:"step".into(),agent:"build".into(),model:session::Document::from_domain(&model::Ref { provider_id:provider::Id("openai".into()),id:format!("model_{index:03}").into(),variant:None,profile:None })?,route_id:"private-route".into(),prompt_cache_key:"private-cache".into(),system_digest:"private-system".into(),tool_digest:"private-tools".into(),request:index,attempts:1,invalidation:"none".into(),continuation:"full".into(),cache_read_reported:Some(1),timing:None,cost:Some(1.0),tokens:session::Document::new(parse_json(r#"{"input":1,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#).unwrap())?,time_created:index, usage_anchor: None })?;
        }
        Ok(())
    }).unwrap().wait().unwrap();
    let grouped = engine.report(vec![Query { sql:"SELECT model_key,sum(input) FROM session_provider_request GROUP BY model_key ORDER BY model_key LIMIT 3 OFFSET 300",parameters:Vec::new(),max_rows:3 },
        Query { sql:"SELECT count(*),sum(input) FROM session_provider_request",parameters:Vec::new(),max_rows:1 }]).unwrap();
    assert_eq!(grouped[0].len(), 3);
    assert_eq!(grouped[0][0][0], Value::Text("openai/model_300".into()));
    assert_eq!(reports::value_number(&grouped[1][0][0]).unwrap(), 405.0);
    assert_eq!(reports::value_number(&grouped[1][0][1]).unwrap(), 405.0);
    store
        .submit(|tx| {
            for index in 0..10 {
                let identity = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(
                    &format!("private-request-{index}").into(),
                )]);
                let mut row = tx.get::<resources::RequestTable>(&identity)?.unwrap();
                row.cost = Some(0.1);
                resources::RequestTable::put(tx, &row)?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let sqlite = rusqlite::Connection::open_in_memory().unwrap();
    sqlite
        .execute_batch("CREATE TABLE costs(value REAL)")
        .unwrap();
    for _ in 0..10 {
        sqlite
            .execute("INSERT INTO costs VALUES (?)", [0.1])
            .unwrap();
    }
    let expected: f64 = sqlite
        .query_row("SELECT sum(value) FROM costs", [], |row| row.get(0))
        .unwrap();
    let actual = engine
        .report(vec![Query {
            sql: "SELECT sqlite_sum(cost) FROM session_provider_request WHERE request_order < 10",
            parameters: Vec::new(),
            max_rows: 1,
        }])
        .unwrap();
    assert_eq!(reports::value_number(&actual[0][0][0]).unwrap(), expected);
    let expected = sqlite.prepare("WITH RECURSIVE rows(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM rows WHERE i<8192) SELECT i%3 AS key, sum(CASE WHEN i%17=0 THEN NULL WHEN i%2=0 THEN 0.1 ELSE -0.1 END) FROM rows GROUP BY key ORDER BY key").unwrap().query_map([], |row| Ok((row.get::<_,i64>(0)?, row.get::<_,f64>(1)?))).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
    let actual = engine.report(vec![Query { sql: "SELECT i%3 AS key, sqlite_sum(CASE WHEN i%17=0 THEN NULL WHEN i%2=0 THEN 0.1 ELSE -0.1 END) FROM range(8193) rows(i) GROUP BY key ORDER BY key", parameters: Vec::new(), max_rows: 3 }, Query { sql: "SELECT sqlite_sum(NULL::DOUBLE), sqlite_sum(value) FROM (SELECT 1.0 AS value WHERE false)", parameters: Vec::new(), max_rows: 1 }]).unwrap();
    assert_eq!(
        actual[0]
            .iter()
            .map(|row| (
                reports::value_number(&row[0]).unwrap() as i64,
                reports::value_number(&row[1]).unwrap()
            ))
            .collect::<Vec<_>>(),
        expected
    );
    assert_eq!(actual[1], vec![vec![Value::Null, Value::Null]]);
    let expected: f64 = sqlite.query_row("SELECT sum(value) FROM (SELECT 1e16 AS value UNION ALL SELECT 1.0 UNION ALL SELECT -1e16)", [], |row| row.get(0)).unwrap();
    let actual = engine.report(vec![Query { sql: "SELECT sqlite_sum(value) FROM (SELECT 1e16 AS value UNION ALL SELECT 1.0 UNION ALL SELECT -1e16)", parameters: Vec::new(), max_rows: 1 }]).unwrap();
    assert_eq!(reports::value_number(&actual[0][0][0]).unwrap(), expected);
    let request_source = reports::SOURCES
        .iter()
        .find(|source| source.name == "session_provider_request")
        .unwrap();
    for field in [
        "id",
        "route_id",
        "prompt_cache_key",
        "system_digest",
        "tool_digest",
        "connection_identity_digest",
        "payload",
        "credential",
    ] {
        assert!(
            !request_source
                .columns
                .iter()
                .any(|column| column.name == field)
        );
    }
    store
        .submit(|tx| {
            let mut row = tx
                .get::<session::SessionTable>(&ycoding_store::tuple_key(&[
                    ycoding_store::KeyPart::String(&"s".into()),
                ]))?
                .unwrap();
            row.title = "Renamed".into();
            session::SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        engine
            .report(vec![Query {
                sql: "SELECT title FROM session",
                parameters: Vec::new(),
                max_rows: 1
            }])
            .unwrap()[0][0][0],
        Value::Text("Renamed".into())
    );
    store
        .submit(|tx| {
            resources::RequestTable::delete(
                tx,
                &ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(
                    &"private-request-0".into(),
                )]),
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(matches!(
        engine.report(vec![Query {
            sql: "SELECT count(*) FROM session_provider_request",
            parameters: Vec::new(),
            max_rows: 1
        }]),
        Err(analytics::Error::Privacy)
    ));
    engine.purge().unwrap();
    assert_eq!(
        reports::value_number(
            &engine
                .report(vec![Query {
                    sql: "SELECT count(*) FROM session_provider_request",
                    parameters: Vec::new(),
                    max_rows: 1
                }])
                .unwrap()[0][0][0]
        )
        .unwrap(),
        404.0
    );
    engine.shutdown().unwrap();
    assert!(store.client().analytics().is_err());
    store.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
