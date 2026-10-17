use std::collections::BTreeSet;
use ycoding_core::session::{
    pending::{Promotion, Request},
    provider_request::Begin,
    store,
    usage_accounting::{Context, Error},
    usage_activity,
    usage_attribution::Attribution,
    usage_read::{Pricing, PricingRef},
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, model, money::UsdPerMillionTokens, parse_json, session,
    session_message, session_pending, usage_accounting, usage_anchor,
};
use ycoding_store::{
    KeyPart, Store,
    resources::{self, RequestTable},
    session::{Document, MessageTable, SessionTable, Task, TaskTable},
    tuple_key,
};

#[path = "autonomy_support/mod.rs"]
mod autonomy;
#[path = "usage_retention_support/mod.rs"]
mod harness;
#[path = "report_support/mod.rs"]
mod report_support;

use harness::{DAY, Harness, NOW};

const ROOT: &str = "ses_acct_root";
const CHILD: &str = "ses_acct_child";
const TASK: &str = "ses_acct_task";
const NESTED: &str = "ses_acct_nested";
const SECOND_TASK: &str = "ses_acct_task_two";
const STRANGER: &str = "ses_acct_stranger";
const CREATED: i64 = NOW - DAY;

fn ses(id: &str) -> session::Id {
    session::Id::new(id).unwrap()
}

fn msg(id: &str) -> session_message::Id {
    session_message::Id::new(id).unwrap()
}

fn anchor(session: &str, input: &str) -> usage_anchor::Ref {
    usage_anchor::Ref {
        session_id: ses(session),
        input_id: msg(input),
    }
}

fn session_row(store: &Store, id: &str, parent: Option<&str>, created: i64) {
    let row = ycoding_store::session::Session {
        parent_id: parent.map(Into::into),
        time_created: created,
        time_updated: created,
        ..autonomy::record(id)
    };
    store
        .submit(move |tx| SessionTable::insert(tx, &row))
        .unwrap()
        .wait()
        .unwrap();
}

fn user_message(text: &str) -> session_pending::Message {
    session_pending::Message::decode(
        &parse_json(&format!(
            r#"{{"type":"user","data":{{"text":"{text}"}},"delivery":"steer"}}"#
        ))
        .unwrap(),
    )
    .unwrap()
}

async fn input(
    sessions: &store::Service,
    session: &str,
    id: &str,
    cause: Option<usage_anchor::Ref>,
    created: i64,
) {
    sessions
        .admit_input_attributed(
            Request {
                id: msg(id),
                session_id: ses(session),
                input: user_message("Work"),
                event_id: ycoding_schema::event::Id::new(format!("evt_{id}")).unwrap(),
                created,
            },
            cause,
        )
        .await
        .unwrap();
    assert_eq!(
        sessions
            .promote_input(&ses(session), msg(id).as_lossless(), created + 1)
            .await
            .unwrap(),
        Promotion::Promoted
    );
}

struct Spec {
    id: String,
    session: &'static str,
    request: i64,
    source: &'static str,
    anchor: Option<usage_anchor::Ref>,
    input: Option<&'static str>,
    cost: Option<f64>,
    model: &'static str,
    tokens: &'static str,
    time: i64,
}

const TOKENS: &str = r#"{"input":1,"output":2,"reasoning":3,"cache":{"read":4,"write":5}}"#;
const MILLION: &str = r#"{"input":1000000,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#;

fn spec(id: &str, session: &'static str, request: i64, cost: Option<f64>) -> Spec {
    Spec {
        id: format!("prq_acct_{id}"),
        session,
        request,
        source: "step",
        anchor: None,
        input: None,
        cost,
        model: "recorded",
        tokens: TOKENS,
        time: NOW - 1000 * request,
    }
}

impl Spec {
    fn source(self, source: &'static str) -> Self {
        Self { source, ..self }
    }
    fn anchored(self, session: &str, input: &str) -> Self {
        Self {
            anchor: Some(anchor(session, input)),
            ..self
        }
    }
    fn input(self, input: &'static str) -> Self {
        Self {
            input: Some(input),
            ..self
        }
    }
    fn catalog(self) -> Self {
        Self {
            model: "catalog",
            tokens: MILLION,
            ..self
        }
    }
    fn at(self, time: i64) -> Self {
        Self { time, ..self }
    }
    fn row(&self) -> resources::Request {
        resources::Request {
            id: self.id.as_str().into(),
            session_id: self.session.into(),
            input_id: self.input.map(Into::into),
            assistant_message_id: None,
            connection_identity_digest: Some("private-connection".into()),
            source: self.source.into(),
            agent: "build".into(),
            model: Document::new(
                parse_json(&format!(
                    r#"{{"providerID":"private-provider","id":"{}"}}"#,
                    self.model
                ))
                .unwrap(),
            )
            .unwrap(),
            route_id: "private-route".into(),
            prompt_cache_key: "private-cache-key".into(),
            system_digest: "private-system".into(),
            tool_digest: "private-tool".into(),
            request: self.request,
            attempts: 1,
            invalidation: "first-request".into(),
            continuation: "full".into(),
            cache_read_reported: None,
            timing: None,
            cost: self.cost,
            tokens: Document::new(parse_json(self.tokens).unwrap()).unwrap(),
            time_created: self.time,
            usage_anchor: self
                .anchor
                .as_ref()
                .map(|anchor| Document::from_domain(anchor).unwrap()),
        }
    }
}

fn insert(store: &Store, specs: Vec<Spec>) {
    let rows = specs.iter().map(Spec::row).collect::<Vec<_>>();
    store
        .submit(move |tx| {
            rows.iter()
                .try_for_each(|row| RequestTable::insert(tx, row))
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn task_row(
    store: &Store,
    session: &str,
    parent: &str,
    input: &str,
    usage_anchor: Option<usage_anchor::Ref>,
    state: &str,
    created: i64,
) {
    let row = Task {
        session_id: session.into(),
        parent_id: parent.into(),
        parent_assistant_message_id: format!("msg_{session}_launch").as_str().into(),
        tool_call_id: format!("call_{session}").as_str().into(),
        input_id: input.into(),
        description: "Explore".into(),
        agent: "explore".into(),
        model: Document::new(parse_json(r#"{"providerID":"local","id":"test"}"#).unwrap()).unwrap(),
        prompt_digest: "d".repeat(64).as_str().into(),
        background: 1,
        delivery: "steer".into(),
        state: state.into(),
        progress: None,
        progress_time: None,
        question_id: None,
        question: None,
        question_data: None,
        question_time: None,
        attempt_started: created,
        owner_pid: None,
        owner_started: None,
        revision: 0,
        time_created: created,
        time_updated: created,
        usage_anchor: usage_anchor.map(|anchor| Document::from_domain(&anchor).unwrap()),
    };
    store
        .submit(move |tx| TaskTable::put(tx, &row))
        .unwrap()
        .wait()
        .unwrap();
}

fn set_task_state(store: &Store, session: &str, state: &str) {
    let key = tuple_key(&[KeyPart::String(&session.into())]);
    let state = state.to_owned();
    store
        .submit(move |tx| {
            let mut row = tx.get::<TaskTable>(&key)?.unwrap();
            row.state = state.as_str().into();
            TaskTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn set_pruned_through(store: &Store, session: &str, through: i64) {
    let key = tuple_key(&[KeyPart::String(&session.into())]);
    store
        .submit(move |tx| {
            let mut row = tx.get::<SessionTable>(&key)?.unwrap();
            row.usage_pruned_through = Some(through);
            SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn catalog_price(reference: &PricingRef) -> Option<Pricing> {
    let price = |value: f64| UsdPerMillionTokens::decode(&JsonValue::Number(value)).unwrap();
    (reference.model.as_str() == Some("catalog")).then(|| Pricing {
        provider: vec![model::Cost {
            tier: None,
            input: price(4.0),
            output: price(0.0),
            cache: model::CacheCost {
                read: price(0.0),
                write: price(0.0),
            },
        }],
        router: Vec::new(),
    })
}

fn context<'a>(active: &'a BTreeSet<session::Id>, records_days: i64) -> Context<'a> {
    Context {
        now: NOW,
        records_days,
        active,
        pricer: Some(&catalog_price),
    }
}

fn prompt_input(ids: &[&str]) -> usage_accounting::PromptInput {
    let ids = ids
        .iter()
        .map(|id| format!(r#""{id}""#))
        .collect::<Vec<_>>()
        .join(",");
    usage_accounting::PromptInput::decode(
        &parse_json(&format!(r#"{{"inputIDs":[{ids}]}}"#)).unwrap(),
    )
    .unwrap()
}

fn task_input(ids: &[&str]) -> usage_accounting::TaskInput {
    let ids = ids
        .iter()
        .map(|id| format!(r#""{id}""#))
        .collect::<Vec<_>>()
        .join(",");
    usage_accounting::TaskInput::decode(
        &parse_json(&format!(r#"{{"sessionIDs":[{ids}]}}"#)).unwrap(),
    )
    .unwrap()
}

fn prompts(
    sessions: &store::Service,
    session: &str,
    ids: &[&str],
    context: &Context<'_>,
) -> JsonValue {
    let costs = sessions
        .prompt_costs(&ses(session), &prompt_input(ids), context)
        .unwrap();
    let encoded = costs.encode();
    assert_eq!(
        usage_accounting::PromptCosts::decode(&encoded).unwrap(),
        costs
    );
    encoded
}

fn tasks(
    sessions: &store::Service,
    session: &str,
    ids: &[&str],
    context: &Context<'_>,
) -> JsonValue {
    let costs = sessions
        .task_costs(&ses(session), &task_input(ids), context)
        .unwrap();
    let encoded = costs.encode();
    assert_eq!(
        usage_accounting::TaskCosts::decode(&encoded).unwrap(),
        costs
    );
    encoded
}

fn at<'a>(value: &'a JsonValue, path: &str) -> &'a JsonValue {
    path.split('.').fold(value, |value, key| match value {
        JsonValue::Object(object) => object
            .get(&key.into())
            .unwrap_or_else(|| panic!("missing {key} in {path}: {value:?}")),
        JsonValue::Array(items) => items
            .get(key.parse::<usize>().unwrap())
            .unwrap_or_else(|| panic!("missing {key} in {path}")),
        _ => panic!("{path} crosses a scalar"),
    })
}

fn len(value: &JsonValue, path: &str) -> usize {
    match at(value, path) {
        JsonValue::Array(items) => items.len(),
        other => panic!("{path} is not an array: {other:?}"),
    }
}

fn same(left: &JsonValue, right: &JsonValue) -> bool {
    match (left, right) {
        (JsonValue::Object(left), JsonValue::Object(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .all(|(key, value)| right.get(key).is_some_and(|other| same(value, other)))
        }
        (JsonValue::Array(left), JsonValue::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| same(left, right))
        }
        _ => left == right,
    }
}

#[track_caller]
fn expect(value: &JsonValue, path: &str, expected: &str) {
    let expected = parse_json(expected).unwrap();
    assert!(
        same(at(value, path), &expected),
        "{path}: {:?} != {expected:?}",
        at(value, path)
    );
}

fn text(value: &str) -> String {
    format!(r#""{value}""#)
}

fn reference(session: &str, input: &str) -> String {
    format!(r#"{{"sessionID":"{session}","inputID":"{input}"}}"#)
}

const EMPTY_TOKENS: &str = r#"{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#;
const NO_COST: &str = r#"{"pricedRequests":0,"unpricedRequests":0}"#;

fn family(store: &Store) {
    session_row(store, ROOT, None, CREATED);
    session_row(store, CHILD, Some(ROOT), CREATED);
}

#[tokio::test]
async fn prompt_costs_split_main_children_and_sorted_helpers_with_recorded_and_catalog_prices() {
    let store = harness::store();
    family(&store);
    let sessions = store::Service::new(store.client());
    input(&sessions, ROOT, "msg_acct_first", None, CREATED + 10).await;
    input(&sessions, ROOT, "msg_acct_second", None, CREATED + 20).await;
    input(&sessions, ROOT, "msg_acct_other", None, CREATED + 30).await;
    insert(
        &store,
        vec![
            spec("root_step", ROOT, 1, Some(2.0)).anchored(ROOT, "msg_acct_first"),
            spec("root_title", ROOT, 2, None)
                .source("title")
                .catalog()
                .anchored(ROOT, "msg_acct_first"),
            spec("root_decision", ROOT, 3, None)
                .source("decision")
                .catalog()
                .anchored(ROOT, "msg_acct_first"),
            spec("child_step", CHILD, 1, Some(1.0)).anchored(ROOT, "msg_acct_first"),
            spec("second_step", ROOT, 4, Some(3.0)).anchored(ROOT, "msg_acct_second"),
            spec("unrequested", ROOT, 5, Some(50.0)).anchored(ROOT, "msg_acct_other"),
        ],
    );
    let active = BTreeSet::new();
    let costs = prompts(
        &sessions,
        ROOT,
        &["msg_acct_first", "msg_acct_second"],
        &context(&active, 7),
    );
    assert_eq!(len(&costs, "units"), 2);
    expect(&costs, "history", &text("retained"));
    expect(
        &costs,
        "unattributed",
        &format!(r#"{{"requests":0,"tokens":{EMPTY_TOKENS},"cost":{NO_COST}}}"#),
    );

    expect(&costs, "units.0.anchor", &reference(ROOT, "msg_acct_first"));
    expect(&costs, "units.0.status", &text("settled"));
    expect(&costs, "units.0.attribution", &text("complete"));
    expect(&costs, "units.0.history", &text("retained"));
    expect(&costs, "units.0.total.requests", "4");
    expect(
        &costs,
        "units.0.total.tokens",
        r#"{"input":2000002,"output":4,"reasoning":6,"cache":{"read":8,"write":10}}"#,
    );
    expect(
        &costs,
        "units.0.total.cost",
        r#"{"known":7,"pricedRequests":3,"unpricedRequests":1,"provenance":"current_catalog"}"#,
    );
    expect(&costs, "units.0.main.requests", "3");
    expect(
        &costs,
        "units.0.main.cost",
        r#"{"known":6,"pricedRequests":2,"unpricedRequests":1,"provenance":"current_catalog"}"#,
    );
    expect(&costs, "units.0.children.requests", "1");
    expect(
        &costs,
        "units.0.children.cost",
        r#"{"total":1,"known":1,"pricedRequests":1,"unpricedRequests":0,"provenance":"recorded"}"#,
    );
    assert_eq!(len(&costs, "units.0.helpers"), 2);
    expect(&costs, "units.0.helpers.0.source", &text("decision"));
    expect(&costs, "units.0.helpers.0.requests", "1");
    expect(
        &costs,
        "units.0.helpers.0.cost",
        r#"{"pricedRequests":0,"unpricedRequests":1}"#,
    );
    expect(&costs, "units.0.helpers.1.source", &text("title"));
    expect(&costs, "units.0.helpers.1.tokens", MILLION);
    expect(
        &costs,
        "units.0.helpers.1.cost",
        r#"{"total":4,"known":4,"pricedRequests":1,"unpricedRequests":0,"provenance":"current_catalog"}"#,
    );

    expect(
        &costs,
        "units.1.anchor",
        &reference(ROOT, "msg_acct_second"),
    );
    expect(
        &costs,
        "units.1.total",
        &format!(
            r#"{{"requests":1,"tokens":{TOKENS},"cost":{{"total":3,"known":3,"pricedRequests":1,"unpricedRequests":0,"provenance":"recorded"}}}}"#
        ),
    );
    expect(&costs, "units.1.main.requests", "1");
    expect(
        &costs,
        "units.1.children",
        &format!(r#"{{"requests":0,"tokens":{EMPTY_TOKENS},"cost":{NO_COST}}}"#),
    );
    assert_eq!(len(&costs, "units.1.helpers"), 0);

    let unpriced = Context {
        pricer: None,
        ..context(&active, 7)
    };
    let without_catalog = prompts(&sessions, ROOT, &["msg_acct_first"], &unpriced);
    expect(
        &without_catalog,
        "units.0.total.cost",
        r#"{"known":3,"pricedRequests":2,"unpricedRequests":2,"provenance":"recorded"}"#,
    );
}

#[tokio::test]
async fn explicit_zero_costs_are_priced_and_count_toward_a_complete_total() {
    let store = harness::store();
    family(&store);
    let sessions = store::Service::new(store.client());
    input(&sessions, ROOT, "msg_acct_first", None, CREATED + 10).await;
    insert(
        &store,
        vec![
            spec("step", ROOT, 1, Some(1.0)).anchored(ROOT, "msg_acct_first"),
            spec("decision", ROOT, 2, Some(0.0))
                .source("decision")
                .anchored(ROOT, "msg_acct_first"),
        ],
    );
    let active = BTreeSet::new();
    let costs = prompts(&sessions, ROOT, &["msg_acct_first"], &context(&active, 7));
    expect(
        &costs,
        "units.0.total.cost",
        r#"{"total":1,"known":1,"pricedRequests":2,"unpricedRequests":0,"provenance":"recorded"}"#,
    );
    expect(
        &costs,
        "units.0.helpers.0.cost",
        r#"{"total":0,"known":0,"pricedRequests":1,"unpricedRequests":0,"provenance":"recorded"}"#,
    );
}

#[tokio::test]
async fn unknown_inputs_are_unattributed_units_and_inputs_owned_by_another_prompt_are_omitted() {
    let store = harness::store();
    family(&store);
    let sessions = store::Service::new(store.client());
    input(&sessions, ROOT, "msg_acct_first", None, CREATED + 10).await;
    input(
        &sessions,
        ROOT,
        "msg_acct_answer",
        Some(anchor(ROOT, "msg_acct_first")),
        CREATED + 20,
    )
    .await;
    insert(
        &store,
        vec![
            spec("answered", ROOT, 1, Some(2.0)).input("msg_acct_answer"),
            spec("first", ROOT, 2, Some(1.0)).anchored(ROOT, "msg_acct_first"),
        ],
    );
    let active = BTreeSet::new();
    let costs = prompts(
        &sessions,
        ROOT,
        &["msg_acct_missing", "msg_acct_answer", "msg_acct_first"],
        &context(&active, 7),
    );
    assert_eq!(len(&costs, "units"), 2);
    expect(
        &costs,
        "units.0.anchor",
        &reference(ROOT, "msg_acct_missing"),
    );
    expect(&costs, "units.0.attribution", &text("unattributed"));
    expect(&costs, "units.0.history", &text("partial"));
    expect(&costs, "units.0.status", &text("settled"));
    expect(
        &costs,
        "units.0.total",
        &format!(r#"{{"requests":0,"tokens":{EMPTY_TOKENS},"cost":{NO_COST}}}"#),
    );
    expect(&costs, "units.1.anchor", &reference(ROOT, "msg_acct_first"));
    expect(&costs, "units.1.attribution", &text("complete"));
    expect(
        &costs,
        "units.1.total.cost",
        r#"{"total":3,"known":3,"pricedRequests":2,"unpricedRequests":0,"provenance":"recorded"}"#,
    );
    expect(&costs, "unattributed.requests", "0");
}

#[tokio::test]
async fn unprovable_history_stays_unattributed_and_never_prices_a_requested_unit_as_complete() {
    let store = harness::store();
    family(&store);
    session_row(&store, STRANGER, None, CREATED);
    session_row(&store, TASK, Some(STRANGER), CREATED);
    task_row(
        &store,
        TASK,
        STRANGER,
        "msg_acct_stranger_launch",
        None,
        "completed",
        CREATED,
    );
    let sessions = store::Service::new(store.client());
    input(&sessions, ROOT, "msg_acct_first", None, CREATED + 10).await;
    insert(
        &store,
        vec![
            spec("historical", ROOT, 1, Some(7.0)),
            spec("current", ROOT, 2, Some(0.0)).anchored(ROOT, "msg_acct_first"),
        ],
    );
    let active = BTreeSet::new();
    let costs = prompts(&sessions, ROOT, &["msg_acct_first"], &context(&active, 7));
    expect(&costs, "unattributed.requests", "1");
    expect(
        &costs,
        "unattributed.cost",
        r#"{"known":7,"pricedRequests":1,"unpricedRequests":0,"provenance":"recorded"}"#,
    );
    expect(&costs, "units.0.attribution", &text("partial"));
    expect(&costs, "units.0.total.requests", "1");
    expect(
        &costs,
        "units.0.total.cost",
        r#"{"known":0,"pricedRequests":1,"unpricedRequests":0,"provenance":"recorded"}"#,
    );
    let rejected = sessions
        .task_costs(&ses(ROOT), &task_input(&[TASK]), &context(&active, 7))
        .unwrap_err();
    assert!(
        matches!(&rejected, Error::SessionNotFound(id) if *id == ses(TASK)),
        "{rejected:?}"
    );
}

async fn task_family(store: &Store, sessions: &store::Service) {
    family(store);
    session_row(store, TASK, Some(ROOT), CREATED);
    session_row(store, NESTED, Some(TASK), CREATED);
    session_row(store, SECOND_TASK, Some(ROOT), CREATED);
    input(sessions, ROOT, "msg_acct_first", None, CREATED + 10).await;
    input(sessions, ROOT, "msg_acct_second", None, CREATED + 20).await;
    task_row(
        store,
        TASK,
        ROOT,
        "msg_acct_task_input",
        Some(anchor(ROOT, "msg_acct_first")),
        "completed",
        CREATED + 11,
    );
    task_row(
        store,
        NESTED,
        TASK,
        "msg_acct_nested_input",
        Some(anchor(ROOT, "msg_acct_first")),
        "completed",
        CREATED + 12,
    );
    task_row(
        store,
        SECOND_TASK,
        ROOT,
        "msg_acct_second_task_input",
        Some(anchor(ROOT, "msg_acct_second")),
        "completed",
        CREATED + 21,
    );
}

#[tokio::test]
async fn recursive_task_costs_count_overlapping_rows_once_and_reconcile_with_prompt_costs() {
    let store = harness::store();
    let sessions = store::Service::new(store.client());
    task_family(&store, &sessions).await;
    insert(
        &store,
        vec![
            spec("root", ROOT, 1, Some(1.0)).anchored(ROOT, "msg_acct_first"),
            spec("task_step", TASK, 1, Some(2.0)).anchored(ROOT, "msg_acct_first"),
            spec("task_title", TASK, 2, Some(3.0))
                .source("title")
                .anchored(ROOT, "msg_acct_first"),
            spec("nested", NESTED, 1, Some(5.0)).anchored(ROOT, "msg_acct_first"),
            spec("second", SECOND_TASK, 1, Some(4.0)).anchored(ROOT, "msg_acct_second"),
        ],
    );
    let active = BTreeSet::new();
    let costs = tasks(
        &sessions,
        ROOT,
        &[TASK, NESTED, SECOND_TASK],
        &context(&active, 7),
    );
    assert_eq!(len(&costs, "tasks"), 3);
    expect(&costs, "history", &text("retained"));
    expect(&costs, "total.requests", "4");
    expect(
        &costs,
        "total.cost",
        r#"{"total":14,"known":14,"pricedRequests":4,"unpricedRequests":0,"provenance":"recorded"}"#,
    );

    expect(&costs, "tasks.0.sessionID", &text(TASK));
    expect(
        &costs,
        "tasks.0.usageAnchor",
        &reference(ROOT, "msg_acct_first"),
    );
    expect(&costs, "tasks.0.status", &text("settled"));
    expect(&costs, "tasks.0.attribution", &text("complete"));
    expect(&costs, "tasks.0.history", &text("retained"));
    expect(&costs, "tasks.0.total.requests", "3");
    expect(&costs, "tasks.0.total.cost.total", "10");
    expect(&costs, "tasks.0.main.requests", "2");
    expect(&costs, "tasks.0.main.cost.total", "5");
    expect(&costs, "tasks.0.children.cost.total", "5");
    assert_eq!(len(&costs, "tasks.0.helpers"), 1);
    expect(&costs, "tasks.0.helpers.0.source", &text("title"));
    expect(&costs, "tasks.0.helpers.0.cost.total", "3");

    expect(&costs, "tasks.1.sessionID", &text(NESTED));
    expect(&costs, "tasks.1.total.cost.total", "5");
    expect(&costs, "tasks.1.main.cost.total", "5");
    expect(&costs, "tasks.1.children.requests", "0");

    expect(&costs, "tasks.2.sessionID", &text(SECOND_TASK));
    expect(
        &costs,
        "tasks.2.usageAnchor",
        &reference(ROOT, "msg_acct_second"),
    );
    expect(&costs, "tasks.2.total.cost.total", "4");

    let units = prompts(
        &sessions,
        ROOT,
        &["msg_acct_first", "msg_acct_second"],
        &context(&active, 7),
    );
    expect(&units, "units.0.total.requests", "4");
    expect(&units, "units.0.total.cost.total", "11");
    expect(&units, "units.0.main.cost.total", "1");
    expect(&units, "units.0.children.cost.total", "10");
    expect(&units, "units.0.helpers.0.cost.total", "3");
    expect(&units, "units.1.main.requests", "0");
    expect(&units, "units.1.children.cost.total", "4");

    let scoped = tasks(&sessions, TASK, &[NESTED], &context(&active, 7));
    expect(&scoped, "tasks.0.total.cost.total", "5");
    let child_scoped = prompts(&sessions, TASK, &["msg_acct_first"], &context(&active, 7));
    expect(
        &child_scoped,
        "units.0.anchor",
        &reference(TASK, "msg_acct_first"),
    );
    expect(&child_scoped, "units.0.attribution", &text("unattributed"));
}

#[tokio::test]
async fn task_costs_reject_sessions_outside_the_family_or_without_a_task_by_their_own_id() {
    let store = harness::store();
    let sessions = store::Service::new(store.client());
    task_family(&store, &sessions).await;
    session_row(&store, STRANGER, None, CREATED);
    let active = BTreeSet::new();
    for (scope, requested, rejected) in [
        (ROOT, vec![TASK, STRANGER], STRANGER),
        (ROOT, vec![CHILD], CHILD),
        (ROOT, vec![ROOT], ROOT),
        (TASK, vec![SECOND_TASK], SECOND_TASK),
        (ROOT, vec!["ses_acct_unknown"], "ses_acct_unknown"),
    ] {
        let error = sessions
            .task_costs(&ses(scope), &task_input(&requested), &context(&active, 7))
            .unwrap_err();
        assert!(
            matches!(&error, Error::SessionNotFound(id) if *id == ses(rejected)),
            "{scope} {requested:?}: {error:?}"
        );
    }
    for missing in [
        sessions
            .prompt_costs(
                &ses("ses_acct_unknown"),
                &prompt_input(&["msg_acct_first"]),
                &context(&active, 7),
            )
            .unwrap_err(),
        sessions
            .task_costs(
                &ses("ses_acct_unknown"),
                &task_input(&[TASK]),
                &context(&active, 7),
            )
            .unwrap_err(),
    ] {
        assert!(
            matches!(&missing, Error::SessionNotFound(id) if *id == ses("ses_acct_unknown")),
            "{missing:?}"
        );
    }
}

#[tokio::test]
async fn a_task_without_a_stored_anchor_resolves_its_launch_input_or_omits_the_anchor() {
    let store = harness::store();
    family(&store);
    session_row(&store, TASK, Some(ROOT), CREATED);
    session_row(&store, SECOND_TASK, Some(ROOT), CREATED);
    let sessions = store::Service::new(store.client());
    input(&sessions, ROOT, "msg_acct_first", None, CREATED + 10).await;
    input(
        &sessions,
        TASK,
        "msg_acct_task_input",
        Some(anchor(ROOT, "msg_acct_first")),
        CREATED + 11,
    )
    .await;
    task_row(
        &store,
        TASK,
        ROOT,
        "msg_acct_task_input",
        None,
        "completed",
        CREATED + 11,
    );
    task_row(
        &store,
        SECOND_TASK,
        ROOT,
        "msg_acct_unknown_input",
        None,
        "completed",
        CREATED + 12,
    );
    let active = BTreeSet::new();
    let costs = tasks(&sessions, ROOT, &[TASK, SECOND_TASK], &context(&active, 7));
    expect(
        &costs,
        "tasks.0.usageAnchor",
        &reference(ROOT, "msg_acct_first"),
    );
    let JsonValue::Object(second) = at(&costs, "tasks.1") else {
        panic!("task cost is an object")
    };
    assert!(second.get(&"usageAnchor".into()).is_none());
}

#[tokio::test]
async fn the_records_cutoff_and_pruning_marks_make_history_partial_and_withhold_totals() {
    let store = harness::store();
    session_row(&store, ROOT, None, NOW - 2 * DAY);
    let sessions = store::Service::new(store.client());
    input(&sessions, ROOT, "msg_acct_first", None, NOW - 2 * DAY).await;
    insert(
        &store,
        vec![
            spec("first", ROOT, 1, Some(1.0))
                .anchored(ROOT, "msg_acct_first")
                .at(NOW - DAY),
        ],
    );
    let active = BTreeSet::new();
    let retained = prompts(&sessions, ROOT, &["msg_acct_first"], &context(&active, 7));
    expect(&retained, "history", &text("retained"));
    expect(&retained, "units.0.history", &text("retained"));
    expect(&retained, "units.0.total.cost.total", "1");

    let cut = prompts(&sessions, ROOT, &["msg_acct_first"], &context(&active, 1));
    expect(&cut, "history", &text("partial"));
    expect(&cut, "units.0.history", &text("partial"));
    expect(
        &cut,
        "units.0.total.cost",
        r#"{"known":1,"pricedRequests":1,"unpricedRequests":0,"provenance":"recorded"}"#,
    );

    let mark = NOW - DAY / 2;
    set_pruned_through(&store, ROOT, mark);
    let pruned = prompts(&sessions, ROOT, &["msg_acct_first"], &context(&active, 7));
    expect(&pruned, "history", &text("partial"));
    expect(&pruned, "units.0.history", &text("partial"));
    input(&sessions, ROOT, "msg_acct_fresh", None, mark + 1).await;
    insert(
        &store,
        vec![
            spec("fresh", ROOT, 2, Some(2.0))
                .anchored(ROOT, "msg_acct_fresh")
                .at(mark + 10),
        ],
    );
    let fresh = prompts(&sessions, ROOT, &["msg_acct_fresh"], &context(&active, 7));
    expect(&fresh, "history", &text("partial"));
    expect(&fresh, "units.0.history", &text("retained"));
    expect(
        &fresh,
        "units.0.total.cost",
        r#"{"total":2,"known":2,"pricedRequests":1,"unpricedRequests":0,"provenance":"recorded"}"#,
    );
}

#[tokio::test]
async fn raising_retention_after_a_real_cleanup_preserves_prompt_and_task_pruning_gaps() {
    for task_kind in [false, true] {
        let harness = Harness::new();
        let store = harness::store();
        let past = NOW - 2 * DAY;
        session_row(&store, ROOT, None, past);
        let sessions = store::Service::new(store.client());
        input(&sessions, ROOT, "msg_acct_first", None, past).await;
        let owner = if task_kind {
            session_row(&store, TASK, Some(ROOT), past);
            task_row(
                &store,
                TASK,
                ROOT,
                "msg_acct_task_input",
                Some(anchor(ROOT, "msg_acct_first")),
                "completed",
                past,
            );
            TASK
        } else {
            ROOT
        };
        let reset = ycoding_store::session::Session {
            time_updated: past,
            ..store
                .snapshot()
                .unwrap()
                .get::<SessionTable>(&tuple_key(&[KeyPart::String(&ROOT.into())]))
                .unwrap()
                .unwrap()
        };
        store
            .submit(move |tx| SessionTable::put(tx, &reset))
            .unwrap()
            .wait()
            .unwrap();
        insert(
            &store,
            vec![
                spec("old", owner, 1, Some(10.0))
                    .anchored(ROOT, "msg_acct_first")
                    .at(past),
            ],
        );
        harness.set(1, 30);
        let reports = report_support::start(store.client());
        harness.cleanups(store.client()).usage().await.unwrap();
        assert!(harness::pruned_through(&store.client(), owner).is_some());
        harness.set(7, 30);
        insert(
            &store,
            vec![
                spec("resumed", owner, 2, Some(1.0))
                    .anchored(ROOT, "msg_acct_first")
                    .at(NOW - 1000),
            ],
        );
        let active = BTreeSet::new();
        let costs = prompts(&sessions, ROOT, &["msg_acct_first"], &context(&active, 7));
        expect(&costs, "units.0.history", &text("partial"));
        expect(
            &costs,
            "units.0.total.cost",
            r#"{"known":1,"pricedRequests":1,"unpricedRequests":0,"provenance":"recorded"}"#,
        );
        if task_kind {
            let tasks = tasks(&sessions, ROOT, &[TASK], &context(&active, 7));
            expect(&tasks, "tasks.0.history", &text("partial"));
            expect(
                &tasks,
                "tasks.0.total.cost",
                r#"{"known":1,"pricedRequests":1,"unpricedRequests":0,"provenance":"recorded"}"#,
            );
            expect(&tasks, "history", &text("partial"));
        }
        drop(reports);
    }
}

#[tokio::test]
async fn pruning_user_message_rows_leaves_prompt_and_task_costs_unchanged() {
    let store = harness::store();
    let sessions = store::Service::new(store.client());
    task_family(&store, &sessions).await;
    insert(
        &store,
        vec![
            spec("root", ROOT, 1, Some(1.0)).anchored(ROOT, "msg_acct_first"),
            spec("task", TASK, 1, Some(2.0)).anchored(ROOT, "msg_acct_first"),
            spec("second", SECOND_TASK, 1, Some(4.0)).anchored(ROOT, "msg_acct_second"),
        ],
    );
    let active = BTreeSet::new();
    let ids = ["msg_acct_first", "msg_acct_second"];
    let before_prompts = prompts(&sessions, ROOT, &ids, &context(&active, 7));
    let before_tasks = tasks(&sessions, ROOT, &[TASK, SECOND_TASK], &context(&active, 7));
    store
        .submit(move |tx| {
            ids.iter().try_for_each(|id| {
                tx.delete::<MessageTable>(&tuple_key(&[KeyPart::String(&(*id).into())]))
                    .map(|_| ())
            })
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<MessageTable>(&tuple_key(&[KeyPart::String(&"msg_acct_first".into())]))
            .unwrap()
            .is_none()
    );
    assert!(same(
        &prompts(&sessions, ROOT, &ids, &context(&active, 7)),
        &before_prompts
    ));
    assert!(same(
        &tasks(&sessions, ROOT, &[TASK, SECOND_TASK], &context(&active, 7)),
        &before_tasks
    ));
    expect(&before_prompts, "units.0.history", &text("retained"));
}

fn begin(session: &str) -> Begin {
    Begin {
        session: ses(session),
        model: model::Ref::decode(&parse_json(r#"{"providerID":"openai","id":"gpt"}"#).unwrap())
            .unwrap(),
        route_id: "openai-responses".into(),
        connection_identity_digest: None,
        prompt_cache_key: "a".repeat(64),
        system_digest: "b".repeat(64),
        tool_digest: "c".repeat(64),
    }
}

fn status(costs: &JsonValue, path: &str) -> String {
    match at(costs, path) {
        JsonValue::String(value) => value.as_str().unwrap().to_owned(),
        other => panic!("{path}: {other:?}"),
    }
}

#[tokio::test]
async fn prompt_status_is_so_far_while_an_execution_request_helper_span_or_running_task_is_active()
{
    let store = harness::store();
    family(&store);
    session_row(&store, TASK, Some(ROOT), CREATED);
    let sessions = store::Service::new(store.client());
    input(&sessions, ROOT, "msg_acct_first", None, CREATED + 10).await;
    input(&sessions, ROOT, "msg_acct_second", None, CREATED + 20).await;
    input(
        &sessions,
        TASK,
        "msg_acct_task_input",
        Some(anchor(ROOT, "msg_acct_first")),
        CREATED + 11,
    )
    .await;
    task_row(
        &store,
        TASK,
        ROOT,
        "msg_acct_task_input",
        Some(anchor(ROOT, "msg_acct_first")),
        "completed",
        CREATED + 11,
    );
    let ids = ["msg_acct_first", "msg_acct_second"];
    let idle = BTreeSet::new();
    let statuses = |active: &BTreeSet<session::Id>| {
        let costs = prompts(&sessions, ROOT, &ids, &context(active, 7));
        (
            status(&costs, "units.0.status"),
            status(&costs, "units.1.status"),
        )
    };
    let settled = ("settled".to_owned(), "settled".to_owned());
    assert_eq!(statuses(&idle), settled);

    let executing = BTreeSet::from([ses(ROOT)]);
    assert_eq!(
        statuses(&executing),
        ("settled".to_owned(), "so-far".to_owned())
    );

    let runner = store::Service::new(store.client());
    let pending = runner
        .begin_provider_request_attributed(
            &begin(CHILD),
            Attribution::Anchored(anchor(ROOT, "msg_acct_first")),
        )
        .await
        .unwrap();
    assert_eq!(statuses(&idle), ("so-far".to_owned(), "settled".to_owned()));
    let independent = store::Service::new(store.client());
    assert_eq!(
        status(
            &prompts(&independent, ROOT, &ids, &context(&idle, 7)),
            "units.0.status"
        ),
        "so-far"
    );
    let copy = pending.clone();
    drop(pending);
    assert_eq!(statuses(&idle), ("so-far".to_owned(), "settled".to_owned()));
    drop(copy);
    assert_eq!(statuses(&idle), settled);

    let span = usage_activity::contribute(
        &store.client(),
        ses(CHILD),
        Some(anchor(ROOT, "msg_acct_second")),
    );
    assert_eq!(statuses(&idle), ("settled".to_owned(), "so-far".to_owned()));
    drop(span);
    assert_eq!(statuses(&idle), settled);

    for state in ["starting", "running", "waiting", "cancelling"] {
        set_task_state(&store, TASK, state);
        assert_eq!(
            statuses(&idle),
            ("so-far".to_owned(), "settled".to_owned()),
            "{state}"
        );
    }
    for state in ["completed", "failed", "cancelled"] {
        set_task_state(&store, TASK, state);
        assert_eq!(statuses(&idle), settled, "{state}");
    }
}

#[tokio::test]
async fn task_status_is_so_far_while_any_session_of_its_family_is_active() {
    let store = harness::store();
    let sessions = store::Service::new(store.client());
    task_family(&store, &sessions).await;
    let task_status = |active: &BTreeSet<session::Id>| {
        let costs = tasks(&sessions, ROOT, &[TASK, SECOND_TASK], &context(active, 7));
        (
            status(&costs, "tasks.0.status"),
            status(&costs, "tasks.1.status"),
        )
    };
    let idle = BTreeSet::new();
    let settled = ("settled".to_owned(), "settled".to_owned());
    assert_eq!(task_status(&idle), settled);
    assert_eq!(
        task_status(&BTreeSet::from([ses(NESTED)])),
        ("so-far".to_owned(), "settled".to_owned())
    );
    assert_eq!(task_status(&BTreeSet::from([ses(ROOT)])), settled);

    let span = usage_activity::contribute(&store.client(), ses(SECOND_TASK), None);
    assert_eq!(
        task_status(&idle),
        ("settled".to_owned(), "so-far".to_owned())
    );
    drop(span);
    assert_eq!(task_status(&idle), settled);

    set_task_state(&store, NESTED, "running");
    assert_eq!(
        task_status(&idle),
        ("so-far".to_owned(), "settled".to_owned())
    );
    set_task_state(&store, NESTED, "completed");

    let pending = store::Service::new(store.client())
        .begin_provider_request_attributed(
            &begin(SECOND_TASK),
            Attribution::Anchored(anchor(ROOT, "msg_acct_second")),
        )
        .await
        .unwrap();
    assert_eq!(task_status(&idle), settled);
    drop(pending);
}

#[tokio::test]
async fn activity_belongs_to_one_backend_and_never_leaks_into_another_store() {
    let first = harness::store();
    let second = harness::store();
    for store in [&first, &second] {
        family(store);
        let sessions = store::Service::new(store.client());
        input(&sessions, ROOT, "msg_acct_first", None, CREATED + 10).await;
    }
    let span = usage_activity::contribute(
        &first.client(),
        ses(ROOT),
        Some(anchor(ROOT, "msg_acct_first")),
    );
    let idle = BTreeSet::new();
    let status_in = |store: &Store| {
        let sessions = store::Service::new(store.client());
        status(
            &prompts(&sessions, ROOT, &["msg_acct_first"], &context(&idle, 7)),
            "units.0.status",
        )
    };
    assert_eq!(status_in(&first), "so-far");
    assert_eq!(status_in(&second), "settled");
    drop(span);
    assert_eq!(status_in(&first), "settled");

    let pending = store::Service::new(second.client())
        .begin_provider_request_attributed(
            &begin(CHILD),
            Attribution::Anchored(anchor(ROOT, "msg_acct_first")),
        )
        .await
        .unwrap();
    assert_eq!(status_in(&second), "so-far");
    assert_eq!(status_in(&first), "settled");
    drop(pending);
    assert_eq!(status_in(&second), "settled");

    let outliving = usage_activity::contribute(
        &first.client(),
        ses(ROOT),
        Some(anchor(ROOT, "msg_acct_first")),
    );
    drop(first);
    let replacement = harness::store();
    family(&replacement);
    input(
        &store::Service::new(replacement.client()),
        ROOT,
        "msg_acct_first",
        None,
        CREATED + 10,
    )
    .await;
    assert_eq!(status_in(&replacement), "settled");
    assert_eq!(status_in(&second), "settled");
    drop(outliving);
    assert_eq!(status_in(&replacement), "settled");
}

#[tokio::test]
async fn reads_page_through_large_ledgers_within_one_consistent_snapshot() {
    let store = harness::store();
    let sessions = store::Service::new(store.client());
    task_family(&store, &sessions).await;
    let specs = (1..=300)
        .map(|index| {
            spec(&format!("bulk_{index}"), TASK, index, Some(0.5)).anchored(ROOT, "msg_acct_first")
        })
        .chain((1..=150).map(|index| {
            spec(&format!("nested_bulk_{index}"), NESTED, index, Some(0.25))
                .anchored(ROOT, "msg_acct_first")
        }))
        .collect();
    insert(&store, specs);
    let active = BTreeSet::new();
    let costs = prompts(&sessions, ROOT, &["msg_acct_first"], &context(&active, 7));
    expect(&costs, "units.0.total.requests", "450");
    expect(&costs, "units.0.total.cost.total", "187.5");
    expect(&costs, "units.0.children.requests", "450");
    let task_costs = tasks(&sessions, ROOT, &[TASK, NESTED], &context(&active, 7));
    expect(&task_costs, "tasks.0.total.requests", "450");
    expect(&task_costs, "tasks.1.total.requests", "150");
    expect(&task_costs, "total.requests", "450");
    expect(&task_costs, "total.cost.total", "187.5");
}

#[tokio::test]
async fn results_expose_only_identifiers_counts_tokens_costs_and_states() {
    let store = harness::store();
    let sessions = store::Service::new(store.client());
    task_family(&store, &sessions).await;
    insert(
        &store,
        vec![
            spec("root", ROOT, 1, None)
                .catalog()
                .anchored(ROOT, "msg_acct_first"),
            spec("task", TASK, 1, Some(2.0)).anchored(ROOT, "msg_acct_first"),
            spec("loose", ROOT, 2, Some(1.0)),
        ],
    );
    let active = BTreeSet::new();
    for encoded in [
        prompts(&sessions, ROOT, &["msg_acct_first"], &context(&active, 7)),
        tasks(&sessions, ROOT, &[TASK], &context(&active, 7)),
    ] {
        let rendered = ycoding_schema::stringify_json(&encoded);
        for private in [
            "private-connection",
            "private-provider",
            "private-route",
            "private-cache-key",
            "private-system",
            "private-tool",
            "prq_acct",
            "/project",
            "prj_one",
        ] {
            assert!(!rendered.contains(private), "{private} in {rendered}");
        }
    }
}
