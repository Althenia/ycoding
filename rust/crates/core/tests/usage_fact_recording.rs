use ycoding_core::session::store::Service;
use ycoding_schema::{DomainDecode, JsonValue, model, parse_json, provider_request};
use ycoding_store::{
    Error, Store, analytics, resources,
    session::{self as tables, NewEvent},
};

#[path = "autonomy_support/mod.rs"]
mod autonomy;
#[path = "usage_retention_support/mod.rs"]
mod harness;
#[path = "report_support/mod.rs"]
mod report_support;

use harness::{count, key};

const TIMING: &str = r#"{"generatedTokens":12,"generationDurationNs":2000000000}"#;

struct World {
    store: Store,
    service: Service,
    _reports: report_support::Reports,
}
impl std::ops::Deref for World {
    type Target = Store;
    fn deref(&self) -> &Store {
        &self.store
    }
}

fn session(
    id: &str,
    parent: Option<&str>,
    directory: &str,
    workspace: Option<&str>,
    updated: i64,
) -> tables::Session {
    tables::Session {
        parent_id: parent.map(Into::into),
        directory: directory.into(),
        workspace_id: workspace.map(Into::into),
        time_updated: updated,
        ..autonomy::record(id)
    }
}

fn task(id: &str, parent: &str) -> tables::Task {
    tables::Task {
        session_id: id.into(),
        parent_id: parent.into(),
        parent_assistant_message_id: "assistant".into(),
        tool_call_id: format!("call_{id}").into(),
        input_id: format!("input_{id}").into(),
        description: "task".into(),
        agent: "build".into(),
        model: tables::Document::new(parse_json(r#"{"providerID":"test","id":"test"}"#).unwrap())
            .unwrap(),
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
        usage_anchor: None,
    }
}

fn world() -> World {
    let store = harness::store();
    store
        .submit(|tx| {
            for row in [
                session("ses_root", None, "/project/root", Some("wrk_one"), 777),
                session("ses_task", Some("ses_root"), "/project/task", None, 778),
                session("ses_grand", Some("ses_task"), "/project/grand", None, 779),
                session("ses_plain", Some("ses_root"), "/project/plain", None, 780),
            ] {
                tables::SessionTable::insert(tx, &row)?;
            }
            tables::TaskTable::insert(tx, &task("ses_task", "ses_root"))?;
            tables::TaskTable::insert(tx, &task("ses_grand", "ses_task"))
        })
        .unwrap()
        .wait()
        .unwrap();
    let service = Service::new(store.client());
    let reports = report_support::start(store.client());
    World {
        store,
        service,
        _reports: reports,
    }
}

fn recorded(
    session: &str,
    event: &str,
    request_id: &str,
    number: i64,
    prompt_cache_key: &str,
    cost: f64,
    timing: Option<&str>,
) -> NewEvent {
    let timing = timing.map_or_else(String::new, |timing| format!(r#""timing":{timing},"#));
    NewEvent {
        id: event.into(),
        aggregate_id: session.into(),
        type_: "session.provider.request.recorded.1".into(),
        created: 5000,
        data: parse_json(&format!(
            r#"{{"sessionID":"{session}","id":"{request_id}","source":"step","agent":"build","model":{{"providerID":"openai","id":"gpt"}},"routeID":"test","promptCacheKey":"{prompt_cache_key}","systemDigest":"{}","toolDigest":"{}","request":{number},"attempts":2,"invalidation":"first-request","continuation":"full","cacheReadReported":true,"cost":{cost},{timing}"tokens":{{"input":10,"output":3,"reasoning":1,"cache":{{"read":4,"write":5}}}},"time":5000}}"#,
            "b".repeat(64),
            "c".repeat(64)
        ))
        .unwrap(),
    }
}

async fn publish(world: &World, session: &str, request: &str, number: i64, prompt_key: &str) {
    world
        .service
        .publish(recorded(
            session,
            &format!("evt_{request}"),
            request,
            number,
            prompt_key,
            0.5,
            None,
        ))
        .await
        .unwrap();
}

fn fact(store: &Store, id: &str) -> Option<resources::UsageAnalyticsRequest> {
    store
        .snapshot()
        .unwrap()
        .get::<resources::UsageAnalyticsRequestTable>(&key(id))
        .unwrap()
}

fn path(fact: &resources::UsageAnalyticsRequest) -> JsonValue {
    fact.task_path.value().clone()
}

fn analytics_count(store: &Store) -> Result<analytics::Value, analytics::Error> {
    store
        .analytics()
        .unwrap()
        .report(vec![analytics::Query {
            sql: "SELECT count(*) FROM usage_analytics_request",
            parameters: vec![],
            max_rows: 1,
        }])
        .map(|mut tables| tables.remove(0).remove(0).remove(0))
}

#[tokio::test]
async fn a_recorded_request_writes_its_fact_with_the_ledger_row_and_request_time_dimensions() {
    let world = world();
    world
        .service
        .publish(recorded(
            "ses_task",
            "evt_one",
            "prq_one",
            3,
            "abcdefghijkl",
            0.5,
            Some(TIMING),
        ))
        .await
        .unwrap();
    let fact = fact(&world, "prq_one").unwrap();
    assert_eq!(fact.session_id.as_str(), Some("ses_task"));
    assert_eq!(fact.project_id.as_str(), Some("prj_one"));
    assert_eq!(fact.directory.as_str(), Some("/project/task"));
    assert!(fact.workspace_id.is_none());
    assert_eq!(fact.session_updated, 778);
    assert_eq!(fact.agent.as_str(), Some("build"));
    assert_eq!(fact.source.as_str(), Some("step"));
    assert_eq!(
        fact.model.domain().unwrap(),
        model::Ref::decode(&parse_json(r#"{"providerID":"openai","id":"gpt"}"#).unwrap()).unwrap()
    );
    assert!(fact.usage_anchor.is_none());
    assert_eq!(path(&fact), parse_json(r#"["ses_task"]"#).unwrap());
    assert_eq!((fact.request, fact.attempts), (3, 2));
    assert_eq!(fact.continuation.as_str(), Some("full"));
    assert_eq!(fact.invalidation.as_str(), Some("first-request"));
    assert_eq!(fact.prompt_cache_key.as_str(), Some("abcdefgh"));
    assert_eq!(fact.cache_read_reported, Some(1));
    assert_eq!(
        fact.tokens.value(),
        &parse_json(r#"{"input":10,"output":3,"reasoning":1,"cache":{"read":4,"write":5}}"#)
            .unwrap()
    );
    assert_eq!(fact.cost, Some(0.5));
    assert_eq!(
        fact.timing.as_ref().map(|timing| timing.domain().unwrap()),
        Some(provider_request::Timing::decode(&parse_json(TIMING).unwrap()).unwrap())
    );
    assert_eq!(fact.time_created, 5000);
    let ledger = world
        .snapshot()
        .unwrap()
        .get::<resources::RequestTable>(&key("prq_one"))
        .unwrap()
        .unwrap();
    assert_eq!(ledger.session_id.as_str(), Some("ses_task"));
    assert_eq!(
        analytics_count(&world).unwrap(),
        analytics::Value::BigInt(1)
    );
}

#[tokio::test]
async fn task_path_lists_each_visited_session_with_a_task_row_nearest_first() {
    let world = world();
    for session in ["ses_grand", "ses_task", "ses_plain", "ses_root"] {
        publish(
            &world,
            session,
            &format!("prq_{session}"),
            1,
            "abcdefghijkl",
        )
        .await;
    }
    for (session, expected) in [
        ("ses_grand", r#"["ses_grand","ses_task"]"#),
        ("ses_task", r#"["ses_task"]"#),
        ("ses_plain", "[]"),
        ("ses_root", "[]"),
    ] {
        let fact = fact(&world, &format!("prq_{session}")).unwrap();
        assert_eq!(path(&fact), parse_json(expected).unwrap(), "{session}");
    }
}

#[tokio::test]
async fn the_cache_key_is_truncated_to_eight_utf16_code_units() {
    let world = world();
    let units = |text: &str| text.encode_utf16().collect::<Vec<u16>>();
    let mut split = units("abcdefg");
    split.push(0xD83D);
    for (id, number, input, expected) in [
        (
            "prq_hex",
            1,
            "0123456789abcdef0123456789abcdef",
            units("01234567"),
        ),
        ("prq_astral", 2, "ab😀cdefghi", units("ab😀cdef")),
        ("prq_split", 3, "abcdefg😀h", split),
        ("prq_short", 4, "abc", units("abc")),
        ("prq_exact", 5, "abcdefgh", units("abcdefgh")),
    ] {
        publish(&world, "ses_root", id, number, input).await;
        let stored = fact(&world, id).unwrap();
        assert_eq!(
            stored.prompt_cache_key.code_units().collect::<Vec<_>>(),
            expected,
            "{id}"
        );
    }
}

#[tokio::test]
async fn later_moves_and_retitles_never_change_an_earlier_fact() {
    let world = world();
    publish(&world, "ses_root", "prq_early", 1, "abcdefghijkl").await;
    world
        .submit(|tx| {
            let mut row = tx.get::<tables::SessionTable>(&key("ses_root"))?.unwrap();
            row.directory = "/project/moved".into();
            row.workspace_id = None;
            row.title = "Renamed".into();
            row.time_updated = 999;
            tables::SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    publish(&world, "ses_root", "prq_late", 2, "abcdefghijkl").await;
    let early = fact(&world, "prq_early").unwrap();
    assert_eq!(early.directory.as_str(), Some("/project/root"));
    assert_eq!(
        early.workspace_id.as_ref().and_then(|id| id.as_str()),
        Some("wrk_one")
    );
    assert_eq!(early.session_updated, 777);
    let late = fact(&world, "prq_late").unwrap();
    assert_eq!(late.directory.as_str(), Some("/project/moved"));
    assert!(late.workspace_id.is_none());
    assert_eq!(late.session_updated, 999);
}

#[tokio::test]
async fn session_deletion_removes_the_ledger_and_leaves_every_fact() {
    let world = world();
    for session in ["ses_root", "ses_task", "ses_grand", "ses_plain"] {
        publish(
            &world,
            session,
            &format!("prq_{session}"),
            1,
            "abcdefghijkl",
        )
        .await;
    }
    assert_eq!(count::<resources::RequestTable>(&world), 4);
    let removed = world
        .service
        .remove(&ycoding_schema::session::Id::new("ses_root").unwrap())
        .await
        .unwrap();
    assert_eq!(removed.len(), 4);
    assert_eq!(count::<tables::SessionTable>(&world), 0);
    assert_eq!(count::<resources::RequestTable>(&world), 0);
    assert_eq!(count::<resources::UsageAnalyticsRequestTable>(&world), 4);
    assert!(matches!(
        analytics_count(&world),
        Err(analytics::Error::Privacy)
    ));
    let settlement = harness::Harness::new();
    settlement.cleanups(world.client()).usage().await.unwrap();
    assert_eq!(
        analytics_count(&world).unwrap(),
        analytics::Value::BigInt(4)
    );
}

#[tokio::test]
async fn the_first_fact_for_a_request_id_wins_over_replays_and_later_events() {
    let world = world();
    let first = world
        .service
        .publish(recorded(
            "ses_root",
            "evt_dup_one",
            "prq_dup",
            1,
            "abcdefghijkl",
            1.0,
            None,
        ))
        .await
        .unwrap();
    world
        .service
        .publish(recorded(
            "ses_root",
            "evt_dup_new",
            "prq_dup",
            1,
            "zzzzzzzzzzzz",
            9.0,
            None,
        ))
        .await
        .unwrap();
    assert_eq!(count::<resources::RequestTable>(&world), 1);
    assert_eq!(count::<resources::UsageAnalyticsRequestTable>(&world), 1);
    assert_eq!(fact(&world, "prq_dup").unwrap().cost, Some(1.0));
    let ledger = world
        .snapshot()
        .unwrap()
        .get::<resources::RequestTable>(&key("prq_dup"))
        .unwrap()
        .unwrap();
    assert_eq!(ledger.cost, Some(1.0));
    world
        .submit(move |tx| ycoding_core::session::projector::fold(tx, &first))
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(count::<resources::UsageAnalyticsRequestTable>(&world), 1);
    assert_eq!(fact(&world, "prq_dup").unwrap().cost, Some(1.0));

    world
        .submit(|tx| resources::RequestTable::delete(tx, &key("prq_dup")))
        .unwrap()
        .wait()
        .unwrap();
    world
        .submit(|tx| {
            let mut row = tx.get::<tables::SessionTable>(&key("ses_root"))?.unwrap();
            row.directory = "/project/elsewhere".into();
            tables::SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    world
        .service
        .publish(recorded(
            "ses_root",
            "evt_dup_two",
            "prq_dup",
            1,
            "zzzzzzzzzzzz",
            9.0,
            None,
        ))
        .await
        .unwrap();
    let retained = fact(&world, "prq_dup").unwrap();
    assert_eq!(retained.cost, Some(1.0));
    assert_eq!(retained.directory.as_str(), Some("/project/root"));
    assert_eq!(retained.prompt_cache_key.as_str(), Some("abcdefgh"));
    assert_eq!(count::<resources::UsageAnalyticsRequestTable>(&world), 1);
    let ledger = world
        .snapshot()
        .unwrap()
        .get::<resources::RequestTable>(&key("prq_dup"))
        .unwrap()
        .unwrap();
    assert_eq!(ledger.cost, Some(9.0));
}

#[tokio::test]
async fn a_failed_recording_leaves_no_event_ledger_row_or_fact() {
    let world = world();
    let events = count::<tables::EventTable>(&world);
    assert!(
        world
            .service
            .publish(recorded(
                "ses_missing",
                "evt_missing",
                "prq_missing",
                1,
                "abcdefghijkl",
                0.5,
                None
            ))
            .await
            .is_err()
    );
    world
        .submit(|tx| {
            for id in ["ses_cx", "ses_cy"] {
                tables::SessionTable::insert(tx, &session(id, None, "/project/cycle", None, 1))?;
            }
            tables::TaskTable::insert(tx, &task("ses_cx", "ses_cy"))?;
            tables::TaskTable::insert(tx, &task("ses_cy", "ses_cx"))?;
            for (id, parent) in [("ses_cx", "ses_cy"), ("ses_cy", "ses_cx")] {
                let mut row = tx.get::<tables::SessionTable>(&key(id))?.unwrap();
                row.parent_id = Some(parent.into());
                tables::SessionTable::put(tx, &row)?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let error = world
        .service
        .publish(recorded(
            "ses_cx",
            "evt_cycle",
            "prq_cycle",
            1,
            "abcdefghijkl",
            0.5,
            None,
        ))
        .await
        .unwrap_err();
    assert!(matches!(error, Error::Domain { .. }), "{error:?}");
    assert_eq!(count::<tables::EventTable>(&world), events);
    assert_eq!(count::<resources::RequestTable>(&world), 0);
    assert_eq!(count::<resources::UsageAnalyticsRequestTable>(&world), 0);
}
