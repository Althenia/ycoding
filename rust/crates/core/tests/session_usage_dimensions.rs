use ycoding_core::session::{
    store::Service,
    usage_read::{Pricing, PricingRef},
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, model, money::UsdPerMillionTokens,
    parse_json, provider, provider_request, session, session_id::SessionId, session_message_id,
    usage_anchor,
};
use ycoding_store::{
    Store,
    project::{Project, ProjectTable},
    resources::{Request, RequestTable, UsageAnalyticsRequest, UsageAnalyticsRequestTable},
    session::{
        Document, Event, EventTable, Message, MessageTable, Sequence, SequenceTable, SessionTable,
        Task, TaskTable,
    },
};

#[allow(dead_code)]
#[path = "session_support/mod.rs"]
mod diagnostics_support;
#[path = "report_support/mod.rs"]
mod report_support;
#[path = "autonomy_support/mod.rs"]
mod support;

const APPROXIMATE: f64 = 1e-9;

struct ReportStore {
    _reports: report_support::Reports,
    store: Store,
}

impl std::ops::Deref for ReportStore {
    type Target = Store;
    fn deref(&self) -> &Store {
        &self.store
    }
}

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn json(value: &str) -> JsonValue {
    parse_json(value).unwrap()
}

fn at<'a>(value: &'a JsonValue, path: &str) -> &'a JsonValue {
    path.split('.').fold(value, |value, part| match value {
        JsonValue::Array(items) => &items[part.parse::<usize>().unwrap()],
        JsonValue::Object(object) => object
            .get(&part.into())
            .unwrap_or_else(|| panic!("missing {part} in {path}")),
        _ => panic!("cannot descend into {part} in {path}"),
    })
}

fn has(value: &JsonValue, path: &str) -> bool {
    let (parent, last) = path.rsplit_once('.').unwrap_or(("", path));
    let parent = if parent.is_empty() {
        value
    } else {
        at(value, parent)
    };
    matches!(parent, JsonValue::Object(object) if object.get(&last.into()).is_some())
}

fn number(value: &JsonValue, path: &str) -> f64 {
    match at(value, path) {
        JsonValue::Number(number) => *number,
        other => panic!("number expected at {path}: {other:?}"),
    }
}

fn string(value: &JsonValue, path: &str) -> String {
    match at(value, path) {
        JsonValue::String(text) => text.to_utf8().unwrap(),
        other => panic!("string expected at {path}: {other:?}"),
    }
}

fn same(left: &JsonValue, right: &JsonValue) -> bool {
    match (left, right) {
        (JsonValue::Object(left), JsonValue::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, value)| {
                    right
                        .get(key)
                        .is_some_and(|candidate| same(value, candidate))
                })
        }
        (JsonValue::Array(left), JsonValue::Array(right)) => {
            left.len() == right.len() && left.iter().zip(right).all(|(a, b)| same(a, b))
        }
        _ => left == right,
    }
}

fn expect_same(actual: &JsonValue, expected: &str, context: &str) {
    assert!(
        same(actual, &json(expected)),
        "{context}: {actual:?} != {expected}"
    );
}

fn near(actual: f64, expected: f64, context: &str) {
    assert!(
        (actual - expected).abs() < APPROXIMATE,
        "{context}: {actual} != {expected}"
    );
}

fn keys(report: &JsonValue) -> Vec<String> {
    let JsonValue::Array(rows) = at(report, "rows") else {
        panic!("rows expected");
    };
    (0..rows.len())
        .map(|index| string(report, &format!("rows.{index}.key")))
        .collect()
}

fn row_of(report: &JsonValue, key: &str) -> usize {
    keys(report)
        .iter()
        .position(|candidate| candidate == key)
        .unwrap_or_else(|| panic!("row {key} missing from {:?}", keys(report)))
}

fn sorted(report: &JsonValue) {
    let keys = keys(report);
    let mut expected = keys.clone();
    expected.sort();
    assert_eq!(keys, expected, "rows follow ascending bytewise key order");
}

#[derive(Clone)]
struct Spec {
    session: String,
    id: String,
    number: i64,
    provider: String,
    model: String,
    variant: Option<String>,
    profile: Option<String>,
    source: String,
    cost: Option<f64>,
    input: f64,
    time: i64,
    timing: Option<String>,
    anchor: Option<(String, String)>,
    input_id: Option<LosslessString>,
    task_path: Vec<String>,
}

impl Spec {
    fn new(session: &str, id: &str, number: i64) -> Self {
        Self {
            session: session.into(),
            id: id.into(),
            number,
            provider: "openai".into(),
            model: "gpt".into(),
            variant: None,
            profile: None,
            source: "step".into(),
            cost: Some(1.0),
            input: 10.0,
            time: number,
            timing: None,
            anchor: None,
            input_id: None,
            task_path: Vec::new(),
        }
    }

    fn input_id(mut self, input: &str) -> Self {
        self.input_id = Some(input.into());
        self
    }

    fn input_units(mut self, units: Vec<u16>) -> Self {
        self.input_id = Some(LosslessString::from_utf16(units));
        self
    }

    fn model(mut self, provider: &str, model: &str) -> Self {
        self.provider = provider.into();
        self.model = model.into();
        self
    }

    fn variant(mut self, variant: &str) -> Self {
        self.variant = Some(variant.into());
        self
    }

    fn profile(mut self, profile: &str) -> Self {
        self.profile = Some(profile.into());
        self
    }

    fn cost(mut self, cost: Option<f64>) -> Self {
        self.cost = cost;
        self
    }

    fn input(mut self, input: f64) -> Self {
        self.input = input;
        self
    }

    fn source(mut self, source: &str) -> Self {
        self.source = source.into();
        self
    }

    fn timing(mut self, timing: &str) -> Self {
        self.timing = Some(timing.into());
        self
    }

    fn anchor(mut self, session: &str, input: &str) -> Self {
        self.anchor = Some((session.into(), input.into()));
        self
    }

    fn task_path(mut self, path: &[&str]) -> Self {
        self.task_path = path.iter().map(|id| (*id).into()).collect();
        self
    }

    fn row(&self) -> Request {
        Request {
            id: self.id.as_str().into(),
            session_id: self.session.as_str().into(),
            input_id: self.input_id.clone(),
            assistant_message_id: None,
            connection_identity_digest: None,
            source: self.source.as_str().into(),
            agent: "build".into(),
            model: Document::from_domain(&model::Ref {
                id: self.model.as_str().into(),
                provider_id: provider::Id(self.provider.as_str().into()),
                variant: self.variant.as_deref().map(Into::into),
                profile: self
                    .profile
                    .as_deref()
                    .map(|profile| model::ProfileName(profile.into())),
            })
            .unwrap(),
            route_id: "test".into(),
            prompt_cache_key: format!("cachekey-{}", self.id).as_str().into(),
            system_digest: "system".into(),
            tool_digest: "tools".into(),
            request: self.number,
            attempts: 1,
            invalidation: "first-request".into(),
            continuation: "full".into(),
            cache_read_reported: Some(1),
            timing: self
                .timing
                .as_deref()
                .map(|timing| Document::new(parse_json(timing).unwrap()).unwrap()),
            cost: self.cost,
            tokens: Document::new(json(&format!(
                r#"{{"input":{},"output":0,"reasoning":0,"cache":{{"read":0,"write":0}}}}"#,
                self.input
            )))
            .unwrap(),
            time_created: self.time,
            usage_anchor: self.anchor.as_ref().map(|(session, input)| {
                Document::from_domain(&usage_anchor::Ref {
                    session_id: SessionId::new(session.as_str()).unwrap(),
                    input_id: session_message_id::Id::new(input.as_str()).unwrap(),
                })
                .unwrap()
            }),
        }
    }

    fn path(&self) -> String {
        format!(
            "[{}]",
            self.task_path
                .iter()
                .map(|id| format!("\"{id}\""))
                .collect::<Vec<_>>()
                .join(",")
        )
    }
}

fn insert(store: &Store, specs: Vec<Spec>) {
    let rows = specs
        .iter()
        .map(|spec| (spec.row(), spec.path()))
        .collect::<Vec<_>>();
    store
        .submit(move |tx| {
            rows.iter().try_for_each(|(row, path)| {
                RequestTable::insert(tx, row)?;
                let session = tx
                    .get::<SessionTable>(&ycoding_store::tuple_key(&[
                        ycoding_store::KeyPart::String(&row.session_id),
                    ]))?
                    .unwrap();
                UsageAnalyticsRequestTable::insert(
                    tx,
                    &UsageAnalyticsRequest {
                        id: row.id.clone(),
                        session_id: row.session_id.clone(),
                        project_id: session.project_id,
                        directory: session.directory,
                        workspace_id: session.workspace_id,
                        session_updated: session.time_updated,
                        agent: row.agent.clone(),
                        source: row.source.clone(),
                        model: row.model.clone(),
                        usage_anchor: row.usage_anchor.clone(),
                        task_path: Document::new(parse_json(path).unwrap())?,
                        request: row.request,
                        attempts: row.attempts,
                        continuation: row.continuation.clone(),
                        invalidation: row.invalidation.clone(),
                        prompt_cache_key: LosslessString::from_utf16(
                            row.prompt_cache_key.code_units().take(8).collect(),
                        ),
                        cache_read_reported: row.cache_read_reported,
                        tokens: row.tokens.clone(),
                        cost: row.cost,
                        timing: row.timing.clone(),
                        time_created: row.time_created,
                    },
                )
            })
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn sessions(store: &Store, rows: Vec<(&'static str, Option<&'static str>)>) {
    store
        .submit(move |tx| {
            rows.iter().try_for_each(|(name, parent)| {
                let mut record = support::record(name);
                record.parent_id = parent.map(Into::into);
                record.time_updated = 1;
                SessionTable::insert(tx, &record)
            })
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn task(store: &Store, child: &'static str, parent: &'static str) {
    store
        .submit(move |tx| {
            TaskTable::insert(
                tx,
                &Task {
                    session_id: child.into(),
                    parent_id: parent.into(),
                    parent_assistant_message_id: "msg_parent".into(),
                    tool_call_id: format!("call_{child}").as_str().into(),
                    input_id: format!("msg_input_{child}").as_str().into(),
                    description: "Work".into(),
                    agent: "build".into(),
                    model: Document::<model::Ref>::new(json(
                        r#"{"providerID":"local","id":"test"}"#,
                    ))?,
                    prompt_digest: "0".repeat(64).as_str().into(),
                    background: 1,
                    delivery: "steer".into(),
                    state: "completed".into(),
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
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn report_input(value: &str) -> provider_request::ReportInput {
    provider_request::ReportInput::decode(&json(value)).unwrap()
}

fn all(service: &Service, input: &str) -> JsonValue {
    service
        .usage_report_all(&report_input(input), None)
        .unwrap()
        .encode()
}

fn scoped(service: &Service, session: &str, input: &str) -> JsonValue {
    service
        .usage_report(&id(session), &report_input(input), None)
        .unwrap()
        .encode()
}

fn setup() -> (ReportStore, Service) {
    let store = Store::disposable(
        ycoding_store::Options::core(),
        ycoding_store::import::catalog(ycoding_store::import::DatabaseKind::Core),
        ycoding_store::Metadata::new([7; 16], 1),
    )
    .unwrap();
    store
        .submit(|tx| {
            ProjectTable::insert(
                tx,
                &Project {
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
            SessionTable::insert(tx, &support::record("ses_one"))?;
            SessionTable::insert(tx, &support::record("ses_two"))
        })
        .unwrap()
        .wait()
        .unwrap();
    let service = Service::new(store.client());
    let reports = report_support::start(store.client());
    (
        ReportStore {
            _reports: reports,
            store,
        },
        service,
    )
}

fn mixed(store: &Store) {
    insert(
        store,
        vec![
            Spec::new("ses_one", "prq_a", 1),
            Spec::new("ses_one", "prq_b", 2).profile("work"),
            Spec::new("ses_one", "prq_c", 3)
                .model("openai", "gpt-mini")
                .profile("work")
                .variant("high"),
            Spec::new("ses_one", "prq_d", 4).model("anthropic", "claude"),
            Spec::new("ses_one", "prq_e", 5).variant("high"),
        ],
    );
}

#[test]
fn provider_and_model_groups_aggregate_variants_and_expose_typed_dimensions_without_a_model() {
    let (store, service) = setup();
    mixed(&store);
    for (group, expected) in [
        (
            "provider",
            vec![
                (
                    r#"["provider","anthropic"]"#,
                    1.0,
                    "anthropic",
                    r#"{"group":"provider","providerID":"anthropic"}"#,
                ),
                (
                    r#"["provider","openai"]"#,
                    4.0,
                    "openai",
                    r#"{"group":"provider","providerID":"openai"}"#,
                ),
            ],
        ),
        (
            "provider-model",
            vec![
                (
                    r#"["provider-model","anthropic","claude"]"#,
                    1.0,
                    "anthropic/claude",
                    r#"{"group":"provider-model","providerID":"anthropic","modelID":"claude"}"#,
                ),
                (
                    r#"["provider-model","openai","gpt"]"#,
                    3.0,
                    "openai/gpt",
                    r#"{"group":"provider-model","providerID":"openai","modelID":"gpt"}"#,
                ),
                (
                    r#"["provider-model","openai","gpt-mini"]"#,
                    1.0,
                    "openai/gpt-mini",
                    r#"{"group":"provider-model","providerID":"openai","modelID":"gpt-mini"}"#,
                ),
            ],
        ),
        (
            "model-id",
            vec![
                (
                    r#"["model-id","claude"]"#,
                    1.0,
                    "claude",
                    r#"{"group":"model-id","modelID":"claude"}"#,
                ),
                (
                    r#"["model-id","gpt"]"#,
                    3.0,
                    "gpt",
                    r#"{"group":"model-id","modelID":"gpt"}"#,
                ),
                (
                    r#"["model-id","gpt-mini"]"#,
                    1.0,
                    "gpt-mini",
                    r#"{"group":"model-id","modelID":"gpt-mini"}"#,
                ),
            ],
        ),
    ] {
        let backend = all(&service, &format!(r#"{{"group":"{group}"}}"#));
        assert_eq!(string(&backend, "group"), group);
        assert_eq!(number(&backend, "rowCount"), expected.len() as f64);
        assert_eq!(number(&backend, "total.logical"), 5.0, "{group}");
        sorted(&backend);
        for (key, logical, label, dimensions) in &expected {
            let index = row_of(&backend, key);
            assert_eq!(
                number(&backend, &format!("rows.{index}.logical")),
                *logical,
                "{group} {key}"
            );
            assert_eq!(string(&backend, &format!("rows.{index}.label")), *label);
            expect_same(
                at(&backend, &format!("rows.{index}.dimensions")),
                dimensions,
                key,
            );
            assert!(
                !has(&backend, &format!("rows.{index}.model")),
                "{group} {key}: no representative model"
            );
        }
        assert_eq!(
            scoped(&service, "ses_one", &format!(r#"{{"group":"{group}"}}"#)),
            backend,
            "{group}: the ledger scope agrees with the fact scope"
        );
    }
}

#[test]
fn profile_groups_separate_recorded_profiles_from_the_provider_default_at_request_time() {
    let (store, service) = setup();
    mixed(&store);
    let by_profile = all(&service, r#"{"group":"profile"}"#);
    sorted(&by_profile);
    let mut expected = vec![
        r#"["profile","anthropic",null]"#.to_string(),
        r#"["profile","openai","work"]"#.to_string(),
        r#"["profile","openai",null]"#.to_string(),
    ];
    expected.sort();
    assert_eq!(keys(&by_profile), expected);
    let default = row_of(&by_profile, r#"["profile","openai",null]"#);
    assert_eq!(number(&by_profile, &format!("rows.{default}.logical")), 2.0);
    expect_same(
        at(&by_profile, &format!("rows.{default}.dimensions")),
        r#"{"group":"profile","providerID":"openai","profileState":"provider-default"}"#,
        "dimensions",
    );
    assert_eq!(
        string(&by_profile, &format!("rows.{default}.label")),
        "openai · Provider default"
    );
    let recorded = row_of(&by_profile, r#"["profile","openai","work"]"#);
    assert_eq!(
        number(&by_profile, &format!("rows.{recorded}.logical")),
        2.0
    );
    expect_same(
        at(&by_profile, &format!("rows.{recorded}.dimensions")),
        r#"{"group":"profile","providerID":"openai","profile":"work","profileState":"recorded"}"#,
        "dimensions",
    );
    assert_eq!(
        string(&by_profile, &format!("rows.{recorded}.label")),
        "openai · work"
    );

    let by_profile_model = all(&service, r#"{"group":"provider-profile-model"}"#);
    sorted(&by_profile_model);
    let unnamed = row_of(
        &by_profile_model,
        r#"["provider-profile-model","openai",null,"gpt"]"#,
    );
    assert_eq!(
        number(&by_profile_model, &format!("rows.{unnamed}.logical")),
        2.0
    );
    expect_same(
        at(&by_profile_model, &format!("rows.{unnamed}.dimensions")),
        r#"{"group":"provider-profile-model","providerID":"openai","profileState":"provider-default","modelID":"gpt"}"#,
        "dimensions",
    );
    assert_eq!(
        string(&by_profile_model, &format!("rows.{unnamed}.label")),
        "openai/gpt · Provider default"
    );
    let named = row_of(
        &by_profile_model,
        r#"["provider-profile-model","openai","work","gpt-mini"]"#,
    );
    expect_same(
        at(&by_profile_model, &format!("rows.{named}.dimensions")),
        r#"{"group":"provider-profile-model","providerID":"openai","profile":"work","profileState":"recorded","modelID":"gpt-mini"}"#,
        "dimensions",
    );
    assert_eq!(number(&by_profile_model, "rowCount"), 4.0);
    assert_eq!(number(&by_profile_model, "total.logical"), 5.0);
    for index in 0..4 {
        assert!(!has(&by_profile_model, &format!("rows.{index}.model")));
    }
}

#[test]
fn the_same_profile_name_under_two_providers_stays_two_provider_qualified_rows() {
    let (store, service) = setup();
    insert(
        &store,
        vec![
            Spec::new("ses_one", "prq_p1", 1).profile("work"),
            Spec::new("ses_one", "prq_p2", 2)
                .model("anthropic", "claude")
                .profile("work"),
        ],
    );
    let report = all(&service, r#"{"group":"profile"}"#);
    assert_eq!(number(&report, "rowCount"), 2.0);
    for (key, provider) in [
        (r#"["profile","anthropic","work"]"#, "anthropic"),
        (r#"["profile","openai","work"]"#, "openai"),
    ] {
        let index = row_of(&report, key);
        assert_eq!(
            string(&report, &format!("rows.{index}.dimensions.providerID")),
            provider
        );
        assert_eq!(number(&report, &format!("rows.{index}.logical")), 1.0);
    }
}

#[test]
fn prompt_groups_use_the_recorded_anchor_and_report_the_rest_as_unattributed() {
    let (store, service) = setup();
    insert(
        &store,
        vec![
            Spec::new("ses_one", "prq_q1", 1).anchor("ses_one", "msg_a"),
            Spec::new("ses_one", "prq_q2", 2).anchor("ses_one", "msg_a"),
            Spec::new("ses_one", "prq_q3", 3).anchor("ses_one", "msg_b"),
            Spec::new("ses_one", "prq_q4", 4),
            Spec::new("ses_two", "prq_q5", 1).anchor("ses_two", "msg_c"),
        ],
    );
    let backend = all(&service, r#"{"group":"prompt"}"#);
    sorted(&backend);
    assert_eq!(number(&backend, "rowCount"), 4.0);
    assert_eq!(number(&backend, "total.logical"), 5.0);
    let first = row_of(&backend, r#"["prompt","ses_one","msg_a"]"#);
    assert_eq!(number(&backend, &format!("rows.{first}.logical")), 2.0);
    expect_same(
        at(&backend, &format!("rows.{first}.dimensions")),
        r#"{"group":"prompt","anchor":{"sessionID":"ses_one","inputID":"msg_a"},"attribution":"complete"}"#,
        "dimensions",
    );
    assert_eq!(string(&backend, &format!("rows.{first}.label")), "msg_a");
    let none = row_of(&backend, r#"["prompt",null,null]"#);
    assert_eq!(number(&backend, &format!("rows.{none}.logical")), 1.0);
    expect_same(
        at(&backend, &format!("rows.{none}.dimensions")),
        r#"{"group":"prompt","attribution":"unattributed"}"#,
        "dimensions",
    );
    assert_eq!(
        string(&backend, &format!("rows.{none}.label")),
        "Unattributed"
    );
    for index in 0..4 {
        assert!(!has(&backend, &format!("rows.{index}.model")));
    }

    let family = scoped(&service, "ses_one", r#"{"group":"prompt"}"#);
    assert_eq!(number(&family, "total.logical"), 4.0);
    let mut expected = vec![
        r#"["prompt","ses_one","msg_a"]"#.to_string(),
        r#"["prompt","ses_one","msg_b"]"#.to_string(),
        r#"["prompt",null,null]"#.to_string(),
    ];
    expected.sort();
    assert_eq!(
        keys(&family),
        expected,
        "the ledger scope excludes other root families"
    );
}

#[test]
fn backend_task_rows_overlap_by_task_path_while_totals_count_each_request_once() {
    let (store, service) = setup();
    insert(
        &store,
        vec![
            Spec::new("ses_one", "prq_t1", 1).task_path(&["ses_t1"]),
            Spec::new("ses_one", "prq_t2", 2).task_path(&["ses_t1", "ses_t2"]),
            Spec::new("ses_one", "prq_t3", 3),
        ],
    );
    let report = all(&service, r#"{"group":"task"}"#);
    sorted(&report);
    assert_eq!(number(&report, "rowCount"), 3.0);
    assert_eq!(number(&report, "total.logical"), 3.0);
    let outer = row_of(&report, r#"["task","ses_t1"]"#);
    assert_eq!(number(&report, &format!("rows.{outer}.logical")), 2.0);
    expect_same(
        at(&report, &format!("rows.{outer}.dimensions")),
        r#"{"group":"task","sessionID":"ses_t1","attribution":"complete"}"#,
        "dimensions",
    );
    assert_eq!(string(&report, &format!("rows.{outer}.label")), "ses_t1");
    let inner = row_of(&report, r#"["task","ses_t2"]"#);
    assert_eq!(number(&report, &format!("rows.{inner}.logical")), 1.0);
    let main = row_of(&report, r#"["task",null]"#);
    assert_eq!(number(&report, &format!("rows.{main}.logical")), 1.0);
    expect_same(
        at(&report, &format!("rows.{main}.dimensions")),
        r#"{"group":"task","attribution":"unattributed"}"#,
        "dimensions",
    );
    assert_eq!(
        string(&report, &format!("rows.{main}.label")),
        "Main Session / unattributed"
    );
    for index in 0..3 {
        assert!(!has(&report, &format!("rows.{index}.model")));
    }
}

#[test]
fn session_scope_task_rows_follow_the_task_ancestry_of_the_ledger_session() {
    let (store, service) = setup();
    sessions(
        &store,
        vec![("ses_root", None), ("ses_child", Some("ses_root"))],
    );
    task(&store, "ses_child", "ses_root");
    insert(
        &store,
        vec![
            Spec::new("ses_root", "prq_r1", 1),
            Spec::new("ses_child", "prq_c1", 1),
            Spec::new("ses_child", "prq_c2", 2),
        ],
    );
    let report = scoped(&service, "ses_root", r#"{"group":"task"}"#);
    assert_eq!(number(&report, "total.logical"), 3.0);
    assert_eq!(number(&report, "rowCount"), 2.0);
    let child = row_of(&report, r#"["task","ses_child"]"#);
    assert_eq!(number(&report, &format!("rows.{child}.logical")), 2.0);
    assert_eq!(
        string(&report, &format!("rows.{child}.dimensions.attribution")),
        "complete"
    );
    let main = row_of(&report, r#"["task",null]"#);
    assert_eq!(number(&report, &format!("rows.{main}.logical")), 1.0);
    store
        .submit(|tx| ycoding_store::session::delete_task(tx, &"ses_child".into()))
        .unwrap()
        .wait()
        .unwrap();
    let after = scoped(&service, "ses_root", r#"{"group":"task"}"#);
    assert_eq!(number(&after, "rowCount"), 1.0);
    assert_eq!(number(&after, "total.logical"), 3.0);
    assert_eq!(number(&after, "rows.0.logical"), 3.0);
    assert_eq!(
        string(&after, "rows.0.dimensions.attribution"),
        "unattributed"
    );
}

#[test]
fn filters_narrow_the_population_before_grouping_paging_and_totals() {
    let (store, service) = setup();
    mixed(&store);
    for (filter, logical, rows) in [
        (r#""providerID":"openai""#, 4.0, 2.0),
        (r#""profile":"work""#, 2.0, 2.0),
        (r#""modelID":"gpt""#, 3.0, 1.0),
        (r#""selectedEffort":"high""#, 2.0, 2.0),
        (
            r#""providerID":"openai","modelID":"gpt","selectedEffort":"high""#,
            1.0,
            1.0,
        ),
        (r#""providerID":"anthropic","profile":"work""#, 0.0, 0.0),
        (r#""modelID":"missing""#, 0.0, 0.0),
    ] {
        let input = format!(r#"{{"group":"provider-model",{filter}}}"#);
        let backend = all(&service, &input);
        assert_eq!(number(&backend, "total.logical"), logical, "{filter}");
        assert_eq!(number(&backend, "rowCount"), rows, "{filter}");
        assert_eq!(
            scoped(&service, "ses_one", &input),
            backend,
            "{filter}: both scopes filter identically"
        );
    }
    let none = all(&service, r#"{"group":"provider","modelID":"missing"}"#);
    assert_eq!(at(&none, "rows"), &json("[]"));
    assert_eq!(number(&none, "total.logical"), 0.0);
    assert_eq!(number(&none, "total.tokens.input"), 0.0);
    assert!(!has(&none, "nextOffset"));

    let first = all(
        &service,
        r#"{"group":"provider-model","providerID":"openai","limit":1}"#,
    );
    assert_eq!(keys(&first), [r#"["provider-model","openai","gpt"]"#]);
    assert_eq!(number(&first, "rowCount"), 2.0);
    assert_eq!(number(&first, "total.logical"), 4.0);
    assert_eq!(number(&first, "nextOffset"), 1.0);
    let second = all(
        &service,
        r#"{"group":"provider-model","providerID":"openai","limit":1,"offset":1}"#,
    );
    assert_eq!(keys(&second), [r#"["provider-model","openai","gpt-mini"]"#]);
    assert_eq!(number(&second, "total.logical"), 4.0);
    assert!(!has(&second, "nextOffset"));
}

#[test]
fn filters_do_not_alias_lone_code_units_to_replacement_characters() {
    let (store, service) = setup();
    insert(
        &store,
        vec![
            Spec::new("ses_one", "prq_lossless_filter", 1)
                .model("�", "�")
                .profile("�")
                .variant("�"),
        ],
    );
    for field in ["providerID", "modelID", "profile", "selectedEffort"] {
        let absent = format!(r#"{{"group":"model","{field}":"\ud800"}}"#);
        assert_eq!(
            number(&all(&service, &absent), "total.logical"),
            0.0,
            "{field}"
        );
        assert_eq!(
            number(&scoped(&service, "ses_one", &absent), "total.logical"),
            0.0,
            "{field}"
        );
        let present = format!(r#"{{"group":"model","{field}":"�"}}"#);
        assert_eq!(
            number(&all(&service, &present), "total.logical"),
            1.0,
            "{field}"
        );
    }
}

#[test]
fn an_absent_profile_filter_filters_nothing_and_a_named_profile_excludes_provider_defaults() {
    let (store, service) = setup();
    mixed(&store);
    let unfiltered = all(&service, r#"{"group":"profile"}"#);
    assert_eq!(number(&unfiltered, "total.logical"), 5.0);
    let work = all(&service, r#"{"group":"profile","profile":"work"}"#);
    assert_eq!(number(&work, "total.logical"), 2.0);
    assert_eq!(keys(&work), [r#"["profile","openai","work"]"#]);
    assert!(
        provider_request::ReportInput::decode(&json(r#"{"group":"profile","profile":""}"#))
            .is_err()
    );
}

#[test]
fn group_model_keys_labels_and_model_rows_are_unchanged_by_the_new_fields() {
    let (store, service) = setup();
    insert(
        &store,
        vec![
            Spec::new("ses_one", "prq_m1", 1)
                .model("custom", "space model")
                .variant("high")
                .profile("named profile"),
            Spec::new("ses_one", "prq_m2", 2).model("custom", "plain"),
        ],
    );
    let report = all(&service, r#"{"group":"model"}"#);
    assert_eq!(
        keys(&report),
        ["custom/plain", "custom/space%20model/high/named%20profile"]
    );
    let index = row_of(&report, "custom/space%20model/high/named%20profile");
    expect_same(
        at(&report, &format!("rows.{index}.model")),
        r#"{"providerID":"custom","id":"space model","variant":"high","profile":"named profile"}"#,
        "model reference",
    );
    assert!(!has(&report, &format!("rows.{index}.dimensions")));
    for group in ["hour", "day", "month", "session", "project", "agent"] {
        let other = all(&service, &format!(r#"{{"group":"{group}"}}"#));
        assert!(!has(&other, "rows.0.model"), "{group}");
        assert!(!has(&other, "rows.0.dimensions"), "{group}");
    }
    let filtered = all(&service, r#"{"group":"model","selectedEffort":"high"}"#);
    assert_eq!(
        keys(&filtered),
        ["custom/space%20model/high/named%20profile"]
    );
}

fn timed(provider: &str, id: &str, number: i64, timing: &str) -> Spec {
    Spec::new("ses_one", id, number)
        .model(provider, "gpt")
        .timing(timing)
}

fn generation(tokens: u64, duration_ns: u64) -> String {
    format!(r#"{{"generatedTokens":{tokens},"generationDurationNs":{duration_ns}}}"#)
}

#[test]
fn measured_speed_populations_use_exact_nearest_rank_percentiles_and_weighted_rates() {
    let (store, service) = setup();
    let mut specs = Vec::new();
    for (index, tokens) in [2u64, 4, 6, 8, 10].into_iter().enumerate() {
        specs.push(timed(
            "pa",
            &format!("prq_pa_t{index}"),
            index as i64 + 1,
            &format!(
                r#"{{"firstOutputMs":{},"generatedTokens":{tokens},"generationDurationNs":1000000000}}"#,
                10 + index
            ),
        ));
    }
    for (index, tokens) in [1u64, 3, 5].into_iter().enumerate() {
        specs.push(timed(
            "pa",
            &format!("prq_pa_o{index}"),
            index as i64 + 10,
            &format!(r#"{{"generatedTokens":{tokens},"observedGenerationDurationNs":2000000000}}"#),
        ));
    }
    specs.extend([
        timed(
            "pa",
            "prq_pa_short",
            20,
            r#"{"firstOutputMs":7,"generatedTokens":100,"observedGenerationDurationNs":500000000}"#,
        ),
        timed(
            "pa",
            "prq_pa_estimated",
            21,
            r#"{"firstOutputMs":3,"estimatedTokens":1000,"estimatedGenerationDurationNs":1000000000}"#,
        ),
        timed("pa", "prq_pa_no_duration", 22, r#"{"generatedTokens":9}"#),
        timed(
            "pa",
            "prq_pa_no_tokens",
            23,
            r#"{"generationDurationNs":1000000000}"#,
        ),
    ]);
    for tokens in 1..=10u64 {
        specs.push(timed(
            "pb",
            &format!("prq_pb_{tokens}"),
            100 + tokens as i64,
            &generation(tokens, 1_000_000_000),
        ));
    }
    insert(&store, specs);
    let report = all(&service, r#"{"group":"provider"}"#);
    let first = row_of(&report, r#"["provider","pa"]"#);
    let speed = |path: &str| format!("rows.{first}.speed.{path}");
    assert_eq!(number(&report, &speed("generationSamples")), 8.0);
    assert_eq!(number(&report, &speed("providerTimedSamples")), 5.0);
    assert_eq!(number(&report, &speed("observedSamples")), 3.0);
    near(
        number(&report, &speed("generationP50TokensPerSecond")),
        2.5,
        "p50 of 0.5 1.5 2 2.5 4 6 8 10 is the 4th value",
    );
    near(
        number(&report, &speed("generationP90TokensPerSecond")),
        10.0,
        "p90 of eight samples is the 8th value",
    );
    near(
        number(&report, &speed("outputTokensPerSecond")),
        39.0 / 11.0,
        "weighted rate sums valid tokens over valid seconds",
    );
    assert_eq!(number(&report, &speed("samples")), 7.0);
    assert_eq!(number(&report, &speed("firstOutputP50Ms")), 11.0);
    assert_eq!(number(&report, &speed("firstOutputP95Ms")), 14.0);

    let second = row_of(&report, r#"["provider","pb"]"#);
    let speed = |path: &str| format!("rows.{second}.speed.{path}");
    assert_eq!(number(&report, &speed("generationSamples")), 10.0);
    assert_eq!(number(&report, &speed("providerTimedSamples")), 10.0);
    assert_eq!(number(&report, &speed("observedSamples")), 0.0);
    near(
        number(&report, &speed("generationP50TokensPerSecond")),
        5.0,
        "p50 of ten ranks 5",
    );
    near(
        number(&report, &speed("generationP90TokensPerSecond")),
        9.0,
        "p90 of ten ranks 9 not 10",
    );
    near(
        number(&report, &speed("outputTokensPerSecond")),
        5.5,
        "pb rate",
    );
    assert_eq!(number(&report, &speed("samples")), 0.0);
    assert!(!has(
        &report,
        &format!("rows.{second}.speed.firstOutputP50Ms")
    ));
    assert_eq!(
        scoped(&service, "ses_one", r#"{"group":"provider"}"#),
        report
    );
}

#[test]
fn estimated_timing_is_stored_verbatim_but_never_enters_measured_speed_or_accounting() {
    let (store, service) = setup();
    insert(
        &store,
        vec![
            timed(
                "pc",
                "prq_pc_first",
                1,
                r#"{"firstOutputMs":4,"estimatedTokens":900,"estimatedGenerationDurationNs":1000000000}"#,
            ),
            timed(
                "pd",
                "prq_pd_only",
                2,
                r#"{"estimatedTokens":900,"estimatedGenerationDurationNs":1000000000}"#,
            ),
            timed(
                "pe",
                "prq_pe_plain",
                3,
                r#"{"generatedTokens":6,"generationDurationNs":3000000000}"#,
            ),
            timed(
                "pe",
                "prq_pe_mixed",
                4,
                r#"{"generatedTokens":6,"generationDurationNs":3000000000,"estimatedTokens":900,"estimatedGenerationDurationNs":1000000000}"#,
            ),
            timed(
                "pf",
                "prq_pf_recorded",
                5,
                r#"{"firstOutputMs":4,"estimatedTokens":900,"estimatedGenerationDurationNs":1000000000}"#,
            )
            .input(123.0)
            .cost(Some(0.5)),
        ],
    );
    let report = all(&service, r#"{"group":"provider"}"#);
    let counted = row_of(&report, r#"["provider","pc"]"#);
    let speed = |path: &str| format!("rows.{counted}.speed.{path}");
    assert_eq!(number(&report, &speed("samples")), 1.0);
    assert_eq!(number(&report, &speed("generationSamples")), 0.0);
    assert_eq!(number(&report, &speed("providerTimedSamples")), 0.0);
    assert_eq!(number(&report, &speed("observedSamples")), 0.0);
    for absent in [
        "outputTokensPerSecond",
        "generationP50TokensPerSecond",
        "generationP90TokensPerSecond",
    ] {
        assert!(!has(&report, &speed(absent)), "{absent}");
    }
    let only = row_of(&report, r#"["provider","pd"]"#);
    assert!(
        !has(&report, &format!("rows.{only}.speed")),
        "a row with only an estimate has no measured speed"
    );
    let mixed = row_of(&report, r#"["provider","pe"]"#);
    let speed = |path: &str| format!("rows.{mixed}.speed.{path}");
    assert_eq!(number(&report, &speed("generationSamples")), 2.0);
    near(
        number(&report, &speed("outputTokensPerSecond")),
        2.0,
        "pe rate",
    );
    near(
        number(&report, &speed("generationP90TokensPerSecond")),
        2.0,
        "pe p90",
    );
    let recorded = row_of(&report, r#"["provider","pf"]"#);
    assert_eq!(
        number(&report, &format!("rows.{recorded}.tokens.input")),
        123.0,
        "recorded tokens survive an estimate on the same request"
    );
    near(
        number(&report, &format!("rows.{recorded}.cost")),
        0.5,
        "recorded cost survives an estimate on the same request",
    );
    assert_eq!(
        string(&report, &format!("rows.{recorded}.costProvenance")),
        "recorded"
    );
    assert_eq!(
        number(&report, &format!("rows.{recorded}.speed.samples")),
        1.0
    );
    assert_eq!(
        number(&report, &format!("rows.{recorded}.speed.generationSamples")),
        0.0
    );
    assert_eq!(number(&report, "total.logical"), 5.0);
    assert_eq!(number(&report, "total.tokens.input"), 163.0);
    near(
        number(&report, "total.cost"),
        4.5,
        "estimates neither add to nor replace recorded cost",
    );

    let summary = service.usage(&id("ses_one"), None).unwrap().encode();
    assert_eq!(number(&summary, "tokens.input"), 163.0);
    near(number(&summary, "cost"), 4.5, "summary cost");
    assert_eq!(number(&summary, "latestTiming.estimatedTokens"), 900.0);
    assert_eq!(
        number(&summary, "latestTiming.estimatedGenerationDurationNs"),
        1_000_000_000.0
    );
}

fn catalog(cost: f64) -> Pricing {
    Pricing {
        provider: vec![model::Cost {
            tier: None,
            input: UsdPerMillionTokens::decode(&JsonValue::Number(cost)).unwrap(),
            output: UsdPerMillionTokens::decode(&JsonValue::Number(0.0)).unwrap(),
            cache: model::CacheCost {
                read: UsdPerMillionTokens::decode(&JsonValue::Number(0.0)).unwrap(),
                write: UsdPerMillionTokens::decode(&JsonValue::Number(0.0)).unwrap(),
            },
        }],
        router: Vec::new(),
    }
}

fn coverage(value: &JsonValue, path: &str) -> (f64, f64) {
    (
        number(value, &format!("{path}.pricedRequests")),
        number(value, &format!("{path}.unpricedRequests")),
    )
}

#[test]
fn cost_coverage_counts_priced_and_unpriced_requests_and_keeps_an_explicit_zero() {
    let (store, service) = setup();
    insert(
        &store,
        vec![
            Spec::new("ses_one", "prq_ca1", 1)
                .model("ca", "gpt")
                .cost(Some(1.0)),
            Spec::new("ses_one", "prq_ca2", 2)
                .model("ca", "gpt")
                .cost(Some(0.0)),
            Spec::new("ses_one", "prq_cb1", 3)
                .model("cb", "gpt")
                .cost(Some(0.0)),
            Spec::new("ses_one", "prq_cc1", 4)
                .model("cc", "gpt")
                .cost(None)
                .input(1000.0),
            Spec::new("ses_one", "prq_cc2", 5)
                .model("cc", "gpt")
                .cost(None)
                .input(1000.0),
            Spec::new("ses_one", "prq_cd1", 6)
                .model("cd", "gpt")
                .cost(Some(2.0)),
            Spec::new("ses_one", "prq_cd2", 7)
                .model("cd", "gpt")
                .cost(None)
                .input(1000.0),
        ],
    );
    let report = all(&service, r#"{"group":"provider"}"#);
    let row = |provider: &str| row_of(&report, &format!(r#"["provider","{provider}"]"#));
    let (ca, cb, cc, cd) = (row("ca"), row("cb"), row("cc"), row("cd"));
    assert_eq!(
        coverage(&report, &format!("rows.{ca}.costCoverage")),
        (2.0, 0.0)
    );
    near(number(&report, &format!("rows.{ca}.cost")), 1.0, "ca");
    assert_eq!(
        coverage(&report, &format!("rows.{cb}.costCoverage")),
        (1.0, 0.0)
    );
    assert!(
        has(&report, &format!("rows.{cb}.cost")),
        "a measured zero stays a present zero"
    );
    near(number(&report, &format!("rows.{cb}.cost")), 0.0, "cb");
    assert_eq!(
        string(&report, &format!("rows.{cb}.costProvenance")),
        "recorded"
    );
    assert_eq!(
        coverage(&report, &format!("rows.{cc}.costCoverage")),
        (0.0, 2.0)
    );
    assert!(!has(&report, &format!("rows.{cc}.cost")));
    assert!(!has(&report, &format!("rows.{cc}.costProvenance")));
    assert_eq!(
        coverage(&report, &format!("rows.{cd}.costCoverage")),
        (1.0, 1.0)
    );
    near(
        number(&report, &format!("rows.{cd}.cost")),
        2.0,
        "the known subtotal is not a complete bill",
    );
    assert_eq!(coverage(&report, "total.costCoverage"), (4.0, 3.0));
    near(number(&report, "total.cost"), 3.0, "known total");
    assert_eq!(
        scoped(&service, "ses_one", r#"{"group":"provider"}"#),
        report
    );

    let pricer =
        |reference: &PricingRef| (reference.provider.as_str() == Some("cc")).then(|| catalog(2.0));
    let priced = service
        .usage_report_all(&report_input(r#"{"group":"provider"}"#), Some(&pricer))
        .unwrap()
        .encode();
    let cc = row_of(&priced, r#"["provider","cc"]"#);
    assert_eq!(
        coverage(&priced, &format!("rows.{cc}.costCoverage")),
        (2.0, 0.0)
    );
    near(
        number(&priced, &format!("rows.{cc}.cost")),
        0.004,
        "cc catalog",
    );
    assert_eq!(
        string(&priced, &format!("rows.{cc}.costProvenance")),
        "current_catalog"
    );
    assert_eq!(coverage(&priced, "total.costCoverage"), (6.0, 1.0));
}

fn put_message(store: &Store, message: &str, type_: &str, seq: i64, data: &str) {
    let (message, type_, data) = (message.to_string(), type_.to_string(), data.to_string());
    store
        .submit(move |tx| {
            MessageTable::insert(
                tx,
                &Message {
                    id: message.into(),
                    session_id: "ses_one".into(),
                    type_: type_.into(),
                    seq,
                    time_created: 1,
                    time_updated: 1,
                    data: parse_json(&data).unwrap(),
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn measured_assistant(store: &Store, model: &str) {
    put_message(
        store,
        "msg_measured",
        "assistant",
        0,
        &format!(
            r#"{{"time":{{"created":1}},"agent":"build","model":{model},"content":[{{"type":"text","text":"done"}}],"tokens":{{"input":10,"output":2,"reasoning":1,"cache":{{"read":3,"write":4}}}}}}"#
        ),
    );
}

fn select_session_model(store: &Store, provider: &str, id: &str) {
    let (provider, id) = (provider.to_string(), id.to_string());
    store
        .submit(move |tx| {
            let mut row = tx
                .get::<SessionTable>(&ycoding_store::tuple_key(&[
                    ycoding_store::KeyPart::String(&"ses_one".into()),
                ]))?
                .unwrap();
            row.model = Some(Document::from_domain(&model::Ref {
                id: id.as_str().into(),
                provider_id: provider::Id(provider.as_str().into()),
                variant: None,
                profile: None,
            })?);
            SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn step(number: i64, provider: &str, model: &str, timing: Option<&str>) -> Spec {
    let spec =
        Spec::new("ses_one", &format!("prq_diag_{number:03}"), number).model(provider, model);
    match timing {
        Some(timing) => spec.timing(timing),
        None => spec,
    }
}

const GPT_HIGH: &str = r#"{"providerID":"openai","id":"gpt","variant":"high"}"#;

fn window_specs() -> Vec<Spec> {
    let window = [
        (10u64, 1u64),
        (20, 2),
        (30, 1),
        (40, 4),
        (50, 1),
        (60, 2),
        (70, 1),
        (80, 2),
    ];
    let mut specs = vec![
        step(1, "openai", "gpt", Some(&generation(999, 1_000_000_000))),
        step(3, "openai", "gpt", Some(&generation(999, 1_000_000_000))),
    ];
    for (index, (tokens, seconds)) in window.into_iter().enumerate() {
        let number = 5 + index as i64 * 2;
        let timing = if index == 3 {
            format!(
                r#"{{"generatedTokens":{tokens},"observedGenerationDurationNs":{}}}"#,
                seconds * 1_000_000_000
            )
        } else {
            generation(tokens, seconds * 1_000_000_000)
        };
        let record = step(number, "openai", "gpt", Some(&timing));
        specs.push(if index % 2 == 0 {
            record.variant("high")
        } else {
            record.variant("low")
        });
        specs.push(step(
            number + 1,
            "anthropic",
            "claude",
            Some(&generation(1000, 1_000_000_000)),
        ));
    }
    specs.push(step(21, "openai", "gpt", None));
    specs.push(step(
        30,
        "anthropic",
        "claude",
        Some(&generation(1000, 1_000_000_000)),
    ));
    specs.push(step(31, "openai", "gpt", Some(&generation(5000, 1_000_000_000))).source("title"));
    specs
}

#[test]
fn diagnostics_weight_the_selected_models_eight_latest_samples_by_duration() {
    let store = diagnostics_support::store();
    let service = Service::new(store.client());
    measured_assistant(&store, GPT_HIGH);
    insert(&store, window_specs());
    let info = service
        .diagnostics(&id("ses_one"), None)
        .unwrap()
        .unwrap()
        .encode();
    assert_eq!(string(&info, "generationSpeed.model.id"), "gpt");
    assert_eq!(string(&info, "generationSpeed.model.providerID"), "openai");
    assert_eq!(
        string(&info, "generationSpeed.model.variant"),
        "high",
        "the history names the selected model, which is not the newest request's model"
    );
    assert_eq!(number(&info, "generationSpeed.latest.tokens"), 360.0);
    assert_eq!(
        number(&info, "generationSpeed.latest.durationNs"),
        14_000_000_000.0
    );
    near(
        number(&info, "generationSpeed.latest.tokensPerSecond"),
        360.0 / 14.0,
        "duration weighted",
    );
    assert_eq!(string(&info, "generationSpeed.latest.model.id"), "gpt");
    assert!(!has(&info, "generationSpeed.latest.estimated"));
    let JsonValue::Array(recent) = at(&info, "generationSpeed.recent") else {
        panic!("recent samples expected");
    };
    assert_eq!(recent.len(), 8);
    assert_eq!(number(&info, "generationSpeed.recent.0.tokens"), 10.0);
    assert_eq!(number(&info, "generationSpeed.recent.7.tokens"), 80.0);
    for index in 0..8 {
        assert_eq!(
            string(&info, &format!("generationSpeed.recent.{index}.model.id")),
            "gpt"
        );
    }
    assert_eq!(
        string(&info, "generationSpeed.recent.0.model.variant"),
        "high"
    );
    assert_eq!(
        string(&info, "generationSpeed.recent.1.model.variant"),
        "low",
        "provider and model id select samples; variants aggregate"
    );
}

#[test]
fn a_selected_session_model_takes_precedence_over_the_latest_assistant_model() {
    let store = diagnostics_support::store();
    let service = Service::new(store.client());
    measured_assistant(&store, GPT_HIGH);
    select_session_model(&store, "anthropic", "claude");
    insert(&store, window_specs());
    let info = service
        .diagnostics(&id("ses_one"), None)
        .unwrap()
        .unwrap()
        .encode();
    assert_eq!(string(&info, "generationSpeed.model.id"), "claude");
    assert_eq!(
        string(&info, "generationSpeed.model.providerID"),
        "anthropic"
    );
    let JsonValue::Array(recent) = at(&info, "generationSpeed.recent") else {
        panic!("recent samples expected");
    };
    assert_eq!(
        recent.len(),
        8,
        "claude has nine samples; the newest eight count"
    );
    for index in 0..8 {
        assert_eq!(
            string(&info, &format!("generationSpeed.recent.{index}.model.id")),
            "claude"
        );
    }
    assert_eq!(number(&info, "generationSpeed.latest.tokens"), 8000.0);
    assert_eq!(
        number(&info, "generationSpeed.latest.durationNs"),
        8_000_000_000.0
    );
    near(
        number(&info, "generationSpeed.latest.tokensPerSecond"),
        1000.0,
        "claude rate",
    );
}

#[test]
fn diagnostics_mark_the_weighted_sample_estimated_when_any_included_sample_is() {
    let store = diagnostics_support::store();
    let service = Service::new(store.client());
    measured_assistant(&store, r#"{"providerID":"openai","id":"gpt"}"#);
    insert(
        &store,
        vec![
            step(1, "openai", "gpt", Some(&generation(10, 1_000_000_000))),
            step(
                2,
                "openai",
                "gpt",
                Some(r#"{"estimatedTokens":30,"estimatedGenerationDurationNs":3000000000}"#),
            ),
        ],
    );
    let info = service
        .diagnostics(&id("ses_one"), None)
        .unwrap()
        .unwrap()
        .encode();
    assert_eq!(number(&info, "generationSpeed.latest.tokens"), 40.0);
    assert_eq!(
        number(&info, "generationSpeed.latest.durationNs"),
        4_000_000_000.0
    );
    near(
        number(&info, "generationSpeed.latest.tokensPerSecond"),
        10.0,
        "estimated sample is included",
    );
    assert_eq!(
        at(&info, "generationSpeed.latest.estimated"),
        &JsonValue::Bool(true)
    );
    assert!(!has(&info, "generationSpeed.recent.0.estimated"));
    assert_eq!(
        at(&info, "generationSpeed.recent.1.estimated"),
        &JsonValue::Bool(true)
    );
}

fn admitted(
    store: &Store,
    session: &'static str,
    seq: i64,
    input: &'static str,
    caused_by: Option<(&'static str, &'static str)>,
) {
    store
        .submit(move |tx| {
            SequenceTable::put(
                tx,
                &Sequence {
                    aggregate_id: session.into(),
                    seq: 100,
                    owner_id: None,
                },
            )?;
            EventTable::put(
                tx,
                &Event {
                    id: format!("evt_{input}").as_str().into(),
                    aggregate_id: session.into(),
                    seq,
                    created: 1,
                    type_: "session.input.admitted.1".into(),
                    data: json(&format!(
                        r#"{{"inputID":"{input}","sessionID":"{session}",{}"input":{{"type":"user","data":{{"text":"go"}},"delivery":"steer"}}}}"#,
                        caused_by.map_or(String::new(), |(cause_session, cause_input)| format!(
                            r#""causedBy":{{"sessionID":"{cause_session}","inputID":"{cause_input}"}},"#
                        ))
                    )),
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}

#[test]
fn session_prompt_rows_resolve_an_absent_stored_anchor_from_the_input_id_while_facts_stay_as_recorded()
 {
    let (store, service) = setup();
    admitted(&store, "ses_one", 0, "msg_hint", None);
    admitted(
        &store,
        "ses_one",
        1,
        "msg_caused",
        Some(("ses_one", "msg_hint")),
    );
    insert(
        &store,
        vec![
            Spec::new("ses_one", "prq_h1", 1).input_id("msg_hint"),
            Spec::new("ses_one", "prq_h2", 2).input_id("msg_caused"),
            Spec::new("ses_one", "prq_h3", 3)
                .input_id("msg_hint")
                .anchor("ses_one", "msg_a"),
            Spec::new("ses_one", "prq_h4", 4).input_id("msg_unknown"),
            Spec::new("ses_one", "prq_h5", 5),
        ],
    );
    let family = scoped(&service, "ses_one", r#"{"group":"prompt"}"#);
    assert_eq!(number(&family, "total.logical"), 5.0);
    assert_eq!(number(&family, "rowCount"), 3.0);
    let resolved = row_of(&family, r#"["prompt","ses_one","msg_hint"]"#);
    assert_eq!(
        number(&family, &format!("rows.{resolved}.logical")),
        2.0,
        "an input ID and a causedBy chain both resolve to the admitted prompt"
    );
    expect_same(
        at(&family, &format!("rows.{resolved}.dimensions")),
        r#"{"group":"prompt","anchor":{"sessionID":"ses_one","inputID":"msg_hint"},"attribution":"complete"}"#,
        "resolved anchor",
    );
    assert_eq!(
        string(&family, &format!("rows.{resolved}.label")),
        "msg_hint"
    );
    let stored = row_of(&family, r#"["prompt","ses_one","msg_a"]"#);
    assert_eq!(
        number(&family, &format!("rows.{stored}.logical")),
        1.0,
        "a stored anchor wins over the input ID"
    );
    let none = row_of(&family, r#"["prompt",null,null]"#);
    assert_eq!(
        number(&family, &format!("rows.{none}.logical")),
        2.0,
        "an unresolvable input ID and a missing input ID stay unattributed"
    );

    let facts = all(&service, r#"{"group":"prompt"}"#);
    assert_eq!(number(&facts, "total.logical"), 5.0);
    assert_eq!(number(&facts, "rowCount"), 2.0);
    let recorded = row_of(&facts, r#"["prompt","ses_one","msg_a"]"#);
    assert_eq!(number(&facts, &format!("rows.{recorded}.logical")), 1.0);
    let none = row_of(&facts, r#"["prompt",null,null]"#);
    assert_eq!(
        number(&facts, &format!("rows.{none}.logical")),
        4.0,
        "retained facts keep exactly the recorded anchors"
    );
}

#[test]
fn task_ancestry_continues_through_non_task_intermediate_sessions_with_distinct_totals() {
    let (store, service) = setup();
    sessions(
        &store,
        vec![
            ("ses_root", None),
            ("ses_s1", Some("ses_root")),
            ("ses_s2", Some("ses_s1")),
            ("ses_s3", Some("ses_s2")),
        ],
    );
    task(&store, "ses_s1", "ses_root");
    task(&store, "ses_s3", "ses_s2");
    insert(
        &store,
        vec![
            Spec::new("ses_root", "prq_n0", 1),
            Spec::new("ses_s1", "prq_n1", 1),
            Spec::new("ses_s2", "prq_n2", 1),
            Spec::new("ses_s3", "prq_n3", 1),
        ],
    );
    let report = scoped(&service, "ses_root", r#"{"group":"task"}"#);
    sorted(&report);
    assert_eq!(number(&report, "total.logical"), 4.0);
    assert_eq!(number(&report, "rowCount"), 3.0);
    let outer = row_of(&report, r#"["task","ses_s1"]"#);
    assert_eq!(
        number(&report, &format!("rows.{outer}.logical")),
        3.0,
        "the s1 task owns its own request, the non-task child's and the s3 task's"
    );
    let inner = row_of(&report, r#"["task","ses_s3"]"#);
    assert_eq!(number(&report, &format!("rows.{inner}.logical")), 1.0);
    expect_same(
        at(&report, &format!("rows.{inner}.dimensions")),
        r#"{"group":"task","sessionID":"ses_s3","attribution":"complete"}"#,
        "inner task",
    );
    let main = row_of(&report, r#"["task",null]"#);
    assert_eq!(number(&report, &format!("rows.{main}.logical")), 1.0);
    let overlapped: f64 = (0..3)
        .map(|index| number(&report, &format!("rows.{index}.logical")))
        .sum();
    assert_eq!(
        overlapped, 5.0,
        "rows overlap where one request belongs to two tasks while the total stays distinct"
    );
}

#[test]
fn requests_issued_by_non_task_descendants_belong_to_the_nearest_task_ancestor() {
    let (store, service) = setup();
    sessions(
        &store,
        vec![
            ("ses_root", None),
            ("ses_t1", Some("ses_root")),
            ("ses_plain", Some("ses_t1")),
        ],
    );
    task(&store, "ses_t1", "ses_root");
    insert(
        &store,
        vec![
            Spec::new("ses_root", "prq_d0", 1),
            Spec::new("ses_t1", "prq_d1", 1),
            Spec::new("ses_plain", "prq_d2", 1),
            Spec::new("ses_plain", "prq_d3", 2),
        ],
    );
    let report = scoped(&service, "ses_root", r#"{"group":"task"}"#);
    assert_eq!(number(&report, "total.logical"), 4.0);
    assert_eq!(number(&report, "rowCount"), 2.0);
    let owner = row_of(&report, r#"["task","ses_t1"]"#);
    assert_eq!(number(&report, &format!("rows.{owner}.logical")), 3.0);
    let main = row_of(&report, r#"["task",null]"#);
    assert_eq!(
        number(&report, &format!("rows.{main}.logical")),
        1.0,
        "only the root's own request is unattributed"
    );
    let own = scoped(&service, "ses_plain", r#"{"group":"task"}"#);
    assert_eq!(
        keys(&own),
        [r#"["task","ses_t1"]"#],
        "ancestry is the session parent chain, so a read scoped below the task still names it"
    );
    assert_eq!(number(&own, "total.logical"), 2.0);
    assert_eq!(number(&own, "rows.0.logical"), 2.0);
}

#[test]
fn an_explicit_zero_provider_generation_duration_is_invalid_even_beside_a_valid_observed_window() {
    let (store, service) = setup();
    insert(
        &store,
        vec![
            timed(
                "pg",
                "prq_pg_zero",
                1,
                r#"{"firstOutputMs":4,"generatedTokens":10,"generationDurationNs":0,"observedGenerationDurationNs":2000000000}"#,
            ),
            timed(
                "pg",
                "prq_pg_valid",
                2,
                r#"{"generatedTokens":6,"generationDurationNs":3000000000}"#,
            ),
            timed(
                "ph",
                "prq_ph_zero",
                3,
                r#"{"generatedTokens":10,"generationDurationNs":0,"observedGenerationDurationNs":2000000000}"#,
            ),
        ],
    );
    for report in [
        all(&service, r#"{"group":"provider"}"#),
        scoped(&service, "ses_one", r#"{"group":"provider"}"#),
    ] {
        let mixed = row_of(&report, r#"["provider","pg"]"#);
        let speed = |path: &str| format!("rows.{mixed}.speed.{path}");
        assert_eq!(number(&report, &speed("generationSamples")), 1.0);
        assert_eq!(number(&report, &speed("providerTimedSamples")), 1.0);
        assert_eq!(
            number(&report, &speed("observedSamples")),
            0.0,
            "the zero duration is not replaced by the observed window"
        );
        near(
            number(&report, &speed("generationP50TokensPerSecond")),
            2.0,
            "pg p50",
        );
        near(
            number(&report, &speed("generationP90TokensPerSecond")),
            2.0,
            "pg p90",
        );
        near(
            number(&report, &speed("outputTokensPerSecond")),
            2.0,
            "pg weighted rate excludes the invalid request",
        );
        assert_eq!(number(&report, &speed("samples")), 1.0);
        let only = row_of(&report, r#"["provider","ph"]"#);
        assert!(
            !has(&report, &format!("rows.{only}.speed")),
            "a lone zero-duration request has no valid generation or latency population"
        );
    }
}

fn prompt_units(suffix: u16) -> Vec<u16> {
    "msg_".encode_utf16().chain([suffix]).collect()
}

fn admitted_units(store: &Store, event: &'static str, seq: i64, input: Vec<u16>) {
    let input = LosslessString::from_utf16(input);
    store
        .submit(move |tx| {
            SequenceTable::put(
                tx,
                &Sequence {
                    aggregate_id: "ses_one".into(),
                    seq: 100,
                    owner_id: None,
                },
            )?;
            EventTable::put(
                tx,
                &Event {
                    id: event.into(),
                    aggregate_id: "ses_one".into(),
                    seq,
                    created: 1,
                    type_: "session.input.admitted.1".into(),
                    data: ycoding_schema::ObjectEncoder::new()
                        .field("inputID", &input)
                        .field("sessionID", &LosslessString::from("ses_one"))
                        .field(
                            "input",
                            &json(r#"{"type":"user","data":{"text":"go"},"delivery":"steer"}"#),
                        )
                        .finish(),
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}

#[test]
fn prompt_hints_keep_distinct_lossless_input_ids_that_collapse_under_lossy_text() {
    let (store, service) = setup();
    let (lone, replacement) = (prompt_units(0xD800), prompt_units(0xFFFD));
    assert!(
        LosslessString::from_utf16(lone.clone()).to_utf8().is_err(),
        "the lone surrogate is not UTF-8"
    );
    assert_ne!(lone, replacement);
    admitted_units(&store, "evt_surrogate_lone", 0, lone.clone());
    admitted_units(&store, "evt_surrogate_replacement", 1, replacement.clone());
    insert(
        &store,
        vec![
            Spec::new("ses_one", "prq_s1", 1).input_units(lone.clone()),
            Spec::new("ses_one", "prq_s2", 2).input_units(replacement.clone()),
        ],
    );
    let family = scoped(&service, "ses_one", r#"{"group":"prompt"}"#);
    assert_eq!(
        number(&family, "rowCount"),
        2.0,
        "two distinct input IDs resolve to two distinct anchors"
    );
    assert_eq!(number(&family, "total.logical"), 2.0);
    let mut seen = Vec::new();
    for index in 0..2 {
        assert_eq!(number(&family, &format!("rows.{index}.logical")), 1.0);
        let JsonValue::String(input) =
            at(&family, &format!("rows.{index}.dimensions.anchor.inputID"))
        else {
            panic!("anchor input ID expected");
        };
        assert_eq!(
            string(
                &family,
                &format!("rows.{index}.dimensions.anchor.sessionID")
            ),
            "ses_one"
        );
        assert_eq!(
            string(&family, &format!("rows.{index}.dimensions.attribution")),
            "complete"
        );
        seen.push(input.clone());
    }
    for expected in [lone, replacement] {
        assert!(
            seen.contains(&LosslessString::from_utf16(expected.clone())),
            "anchor {expected:?} was aliased: {seen:?}"
        );
    }
}
