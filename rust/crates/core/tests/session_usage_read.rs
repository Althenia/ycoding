use std::cell::Cell;
use ycoding_core::session::{
    store::Service,
    usage_read::{Pricing, PricingRef},
};
use ycoding_schema::{
    DecodeError, DomainDecode, DomainEncode, JsonValue, model, money::UsdPerMillionTokens,
    parse_json, provider, provider_request, session,
};
use ycoding_store::{
    Error, Store,
    project::{Project, ProjectTable},
    resources::{Request, RequestTable},
    session::{Document, SessionTable},
};

#[path = "autonomy_support/mod.rs"]
mod support;

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

fn keys(report: &JsonValue) -> Vec<String> {
    let JsonValue::Array(rows) = at(report, "rows") else {
        panic!("rows expected");
    };
    (0..rows.len())
        .map(|index| string(report, &format!("rows.{index}.key")))
        .collect()
}

struct Spec<'a> {
    session: &'a str,
    id: String,
    number: i64,
    provider: &'a str,
    model: &'a str,
    variant: Option<&'a str>,
    profile: Option<&'a str>,
    source: &'a str,
    agent: &'a str,
    continuation: &'a str,
    attempts: i64,
    cost: Option<f64>,
    input: f64,
    time: i64,
    reported: Option<i64>,
    timing: Option<&'a str>,
}

impl<'a> Spec<'a> {
    fn new(session: &'a str, id: &str, number: i64) -> Self {
        Self {
            session,
            id: id.into(),
            number,
            provider: "openai",
            model: "gpt",
            variant: None,
            profile: None,
            source: "step",
            agent: "build",
            continuation: "full",
            attempts: 1,
            cost: Some(1.0),
            input: 10.0,
            time: 0,
            reported: Some(1),
            timing: None,
        }
    }

    fn row(&self) -> Request {
        Request {
            id: self.id.as_str().into(),
            session_id: self.session.into(),
            input_id: None,
            assistant_message_id: None,
            connection_identity_digest: None,
            source: self.source.into(),
            agent: self.agent.into(),
            model: Document::from_domain(&model::Ref {
                id: self.model.into(),
                provider_id: provider::Id(self.provider.into()),
                variant: self.variant.map(Into::into),
                profile: self
                    .profile
                    .map(|profile| model::ProfileName(profile.into())),
            })
            .unwrap(),
            route_id: "test".into(),
            prompt_cache_key: format!("cachekey-{}", self.id).as_str().into(),
            system_digest: "system".into(),
            tool_digest: "tools".into(),
            request: self.number,
            attempts: self.attempts,
            invalidation: "first-request".into(),
            continuation: self.continuation.into(),
            cache_read_reported: self.reported,
            timing: self
                .timing
                .map(|timing| Document::new(parse_json(timing).unwrap()).unwrap()),
            cost: self.cost,
            tokens: Document::new(json(&format!(
                r#"{{"input":{},"output":0,"reasoning":0,"cache":{{"read":0,"write":0}}}}"#,
                self.input
            )))
            .unwrap(),
            time_created: self.time,
        }
    }
}

fn insert(store: &Store, specs: Vec<Spec<'static>>) {
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

fn sessions(store: &Store, rows: Vec<(&'static str, Option<&'static str>, i64)>) {
    store
        .submit(move |tx| {
            rows.iter().try_for_each(|(name, parent, updated)| {
                let mut record = support::record(name);
                record.parent_id = parent.map(Into::into);
                record.time_updated = *updated;
                SessionTable::insert(tx, &record)
            })
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn report_input(value: &str) -> provider_request::ReportInput {
    provider_request::ReportInput::decode(&json(value)).unwrap()
}

fn report(service: &Service, session: &str, input: &str) -> JsonValue {
    service
        .usage_report(&id(session), &report_input(input), None)
        .unwrap()
        .encode()
}

fn setup() -> (Store, Service) {
    let store = support::store();
    let service = Service::new(store.client());
    (store, service)
}

#[test]
fn a_root_family_pages_high_cardinality_session_groups_with_exact_totals() {
    let (store, service) = setup();
    let names = (0..405)
        .map(|index| &*Box::leak(format!("ses_usage_{index:03}").into_boxed_str()))
        .collect::<Vec<&'static str>>();
    sessions(
        &store,
        [("ses_usage_root", None, 1)]
            .into_iter()
            .chain(names.iter().map(|name| (*name, Some("ses_usage_root"), 1)))
            .collect(),
    );
    insert(
        &store,
        names
            .iter()
            .copied()
            .enumerate()
            .map(|(index, name)| {
                let mut spec = Spec::new(name, &format!("prq_usage_{index}"), 1);
                spec.model = Box::leak(format!("model_{index:03}").into_boxed_str());
                spec.input = 1.0;
                spec.time = index as i64;
                spec.timing = Some(Box::leak(
                    format!(
                        r#"{{"firstOutputMs":{index},"totalMs":{},"generatedTokens":1,"generationDurationNs":1000000000}}"#,
                        index * 2
                    )
                    .into_boxed_str(),
                ));
                spec
            })
            .collect(),
    );

    let scoped = report(
        &service,
        "ses_usage_root",
        r#"{"group":"session","offset":300,"limit":3}"#,
    );
    assert_eq!(number(&scoped, "total.logical"), 405.0);
    assert_eq!(number(&scoped, "total.physical"), 405.0);
    assert_eq!(number(&scoped, "total.cost"), 405.0);
    assert_eq!(number(&scoped, "total.tokens.input"), 405.0);
    assert_eq!(
        at(&scoped, "total.cacheReadReported"),
        &JsonValue::Bool(true)
    );
    assert_eq!(number(&scoped, "rowCount"), 405.0);
    assert_eq!(number(&scoped, "nextOffset"), 303.0);
    assert_eq!(
        keys(&scoped),
        ["ses_usage_300", "ses_usage_301", "ses_usage_302"]
    );
    assert_eq!(
        at(&scoped, "rows.0.speed"),
        &json(
            r#"{"firstOutputP50Ms":300,"firstOutputP95Ms":300,"totalP50Ms":600,"totalP95Ms":600,"outputTokensPerSecond":1,"samples":1}"#
        )
    );
    let past = report(
        &service,
        "ses_usage_root",
        r#"{"group":"session","offset":999999,"limit":3}"#,
    );
    assert_eq!(at(&past, "rows"), &json("[]"));
    assert!(!has(&past, "nextOffset"));
    assert_eq!(number(&past, "rowCount"), 405.0);

    let own = report(&service, "ses_usage_007", r#"{"group":"session"}"#);
    assert_eq!(number(&own, "total.logical"), 1.0);
    assert_eq!(keys(&own), ["ses_usage_007"]);
}

#[test]
fn model_keys_use_encode_uri_component_and_sort_bytewise() {
    let (store, service) = setup();
    let models = [
        ("space model", Some("high"), None),
        ("quote'()!*", None, Some("named profile")),
        ("unicode-ไทย-😀", None, None),
        ("slash/model", None, None),
        ("percent%model", None, None),
    ];
    insert(
        &store,
        models
            .iter()
            .enumerate()
            .map(|(index, (name, variant, profile))| {
                let mut spec =
                    Spec::new("ses_one", &format!("prq_encoded_{index}"), index as i64 + 1);
                spec.provider = "custom";
                spec.model = *name;
                spec.variant = *variant;
                spec.profile = *profile;
                spec.cost = Some(0.0);
                spec.input = 0.0;
                spec.time = if index == 0 { -1 } else { index as i64 };
                spec
            })
            .collect(),
    );
    let mut expected = [
        "custom/space%20model/high",
        "custom/quote'()!*/named%20profile",
        "custom/unicode-%E0%B9%84%E0%B8%97%E0%B8%A2-%F0%9F%98%80",
        "custom/slash%2Fmodel",
        "custom/percent%25model",
    ]
    .map(String::from);
    expected.sort();
    let report = report(&service, "ses_one", r#"{"group":"model"}"#);
    assert_eq!(keys(&report), expected);
    assert_eq!(string(&report, "rows.0.label"), "custom/percent%model");
    assert!(
        keys(&report)
            .iter()
            .position(|key| key == "custom/space%20model/high")
            .map(|index| string(&report, &format!("rows.{index}.label")))
            == Some("custom/space model (high)".into())
    );
    assert!(
        keys(&report)
            .iter()
            .position(|key| key.ends_with("named%20profile"))
            .map(|index| string(&report, &format!("rows.{index}.label")))
            == Some("custom/quote'()!* · named profile".into())
    );

    let utc = report_days(&service, r#"{"group":"day"}"#);
    assert_eq!(utc, ["1969-12-31", "1970-01-01"]);
    let local = report_days(&service, r#"{"group":"day","timeZone":"+05:30"}"#);
    assert_eq!(local, ["1970-01-01"]);
}

fn report_days(service: &Service, input: &str) -> Vec<String> {
    keys(&report(service, "ses_one", input))
}

#[test]
fn time_groups_follow_utc_and_fixed_offset_zones_and_reject_unknown_zones() {
    let (store, service) = setup();
    let instant = 1_767_245_400_000_i64;
    insert(&store, {
        let mut spec = Spec::new("ses_one", "prq_time", 1);
        spec.time = instant;
        vec![spec]
    });
    let rows = |input: &str| {
        let report = report(&service, "ses_one", input);
        (
            string(&report, "rows.0.key"),
            string(&report, "rows.0.label"),
        )
    };
    assert_eq!(
        rows(r#"{"group":"hour"}"#),
        (
            "2026-01-01T05:00:00.000Z".into(),
            "2026-01-01T05:00 UTC".into()
        )
    );
    assert_eq!(
        rows(r#"{"group":"hour","timeZone":"UTC"}"#),
        (
            "2026-01-01T05:00:00+00:00".into(),
            "2026-01-01T05:00 +00:00".into()
        )
    );
    assert_eq!(
        rows(r#"{"group":"hour","timeZone":"-08:00"}"#),
        (
            "2025-12-31T21:00:00-08:00".into(),
            "2025-12-31T21:00 -08:00".into()
        )
    );
    assert_eq!(
        rows(r#"{"group":"day","timeZone":"-08:00"}"#),
        ("2025-12-31".into(), "2025-12-31".into())
    );
    assert_eq!(
        rows(r#"{"group":"month"}"#),
        ("2026-01".into(), "2026-01".into())
    );
    assert!(matches!(
        service.usage_report(
            &id("ses_one"),
            &report_input(r#"{"group":"hour","timeZone":"Asia/Kolkata"}"#),
            None
        ),
        Err(Error::Rejected(_))
    ));
}

#[test]
fn ranges_are_half_open_and_sorting_breaks_ties_by_key() {
    let (store, service) = setup();
    insert(&store, {
        let rows = [
            ("a", 1, 3.0, 5.0),
            ("b", 2, 1.0, 5.0),
            ("c", 3, 2.0, 9.0),
            ("d", 4, 2.0, 1.0),
        ];
        rows.iter()
            .map(|(agent, time, cost, input)| {
                let mut spec = Spec::new("ses_one", &format!("prq_sort_{agent}"), *time);
                spec.agent = *agent;
                spec.cost = Some(*cost);
                spec.input = *input;
                spec.time = *time;
                spec
            })
            .collect()
    });
    let order = |input: &str| keys(&report(&service, "ses_one", input));
    assert_eq!(order(r#"{"group":"agent"}"#), ["a", "b", "c", "d"]);
    assert_eq!(
        order(r#"{"group":"agent","order":"desc"}"#),
        ["d", "c", "b", "a"]
    );
    assert_eq!(
        order(r#"{"group":"agent","sort":"cost","order":"desc"}"#),
        ["a", "c", "d", "b"]
    );
    assert_eq!(
        order(r#"{"group":"agent","sort":"tokens","order":"asc"}"#),
        ["d", "a", "b", "c"]
    );
    assert_eq!(
        order(r#"{"group":"agent","sort":"steps","order":"desc"}"#),
        ["a", "b", "c", "d"]
    );
    assert_eq!(order(r#"{"group":"agent","from":2,"to":4}"#), ["b", "c"]);
    let limited = report(&service, "ses_one", r#"{"group":"agent","limit":2}"#);
    assert_eq!(number(&limited, "nextOffset"), 2.0);
    assert_eq!(number(&limited, "total.logical"), 4.0);
}

#[test]
fn speed_uses_ranked_percentiles_and_observed_generation_windows() {
    let (store, service) = setup();
    let timings = [
        r#"{"firstOutputMs":10,"totalMs":100,"generatedTokens":10,"observedGenerationDurationNs":2000000000}"#,
        r#"{"firstOutputMs":40,"totalMs":400,"generatedTokens":10,"observedGenerationDurationNs":500000000}"#,
        r#"{"firstOutputMs":20,"totalMs":200,"generationDurationNs":1000000000}"#,
        r#"{"firstOutputMs":30,"totalMs":300}"#,
    ];
    insert(
        &store,
        timings
            .iter()
            .enumerate()
            .map(|(index, timing)| {
                let mut spec =
                    Spec::new("ses_one", &format!("prq_speed_{index}"), index as i64 + 1);
                spec.timing = Some(*timing);
                spec.time = 10;
                spec
            })
            .collect(),
    );
    let report = report(&service, "ses_one", r#"{"group":"agent"}"#);
    assert_eq!(
        at(&report, "rows.0.speed"),
        &json(
            r#"{"firstOutputP50Ms":20,"firstOutputP95Ms":40,"totalP50Ms":200,"totalP95Ms":400,"outputTokensPerSecond":5,"samples":4}"#
        )
    );
}

#[test]
fn timing_free_groups_have_no_speed_and_helper_continuation_counts_are_exact() {
    let (store, service) = setup();
    insert(&store, {
        let mut step = Spec::new("ses_one", "prq_step", 1);
        step.attempts = 3;
        step.continuation = "continued";
        let mut helper = Spec::new("ses_one", "prq_title", 2);
        helper.source = "title";
        helper.continuation = "fallback";
        helper.reported = None;
        vec![step, helper]
    });
    let report = report(&service, "ses_one", r#"{"group":"agent"}"#);
    assert!(!has(&report, "rows.0.speed"));
    assert_eq!(number(&report, "total.logical"), 2.0);
    assert_eq!(number(&report, "total.physical"), 4.0);
    assert_eq!(number(&report, "total.helpers"), 1.0);
    assert_eq!(number(&report, "total.continued"), 1.0);
    assert_eq!(number(&report, "total.fallback"), 1.0);
    assert_eq!(
        at(&report, "total.cacheReadReported"),
        &JsonValue::Bool(false)
    );
    assert_eq!(string(&report, "total.costProvenance"), "recorded");
}

#[test]
fn project_groups_label_global_named_and_unnamed_projects() {
    let (store, service) = setup();
    store
        .submit(|tx| {
            ProjectTable::insert(
                tx,
                &Project {
                    id: "global".into(),
                    worktree: "/".into(),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 1,
                    time_updated: 1,
                    time_initialized: None,
                    sandboxes: vec![],
                    commands: None,
                },
            )?;
            ProjectTable::insert(
                tx,
                &Project {
                    id: "prj_named".into(),
                    worktree: "/named".into(),
                    vcs: None,
                    name: Some("Named".into()),
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 1,
                    time_updated: 1,
                    time_initialized: None,
                    sandboxes: vec![],
                    commands: None,
                },
            )?;
            for (name, project) in [("ses_global", "global"), ("ses_named", "prj_named")] {
                let mut record = support::record(name);
                record.project_id = project.into();
                record.parent_id = Some("ses_one".into());
                SessionTable::insert(tx, &record)?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    insert(
        &store,
        ["ses_one", "ses_global", "ses_named"]
            .into_iter()
            .enumerate()
            .map(|(index, name)| Spec::new(name, &format!("prq_project_{index}"), 1))
            .collect(),
    );
    let report = report(&service, "ses_one", r#"{"group":"project"}"#);
    assert_eq!(keys(&report), ["global", "prj_named", "prj_one"]);
    assert_eq!(string(&report, "rows.0.label"), "Global (no project)");
    assert_eq!(string(&report, "rows.1.label"), "Named · /named");
    assert_eq!(string(&report, "rows.2.label"), "/project");
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

fn unpriced(store: &Store) {
    insert(store, {
        let mut old = Spec::new("ses_one", "prq_old", 1);
        old.cost = None;
        old.input = 1000.0;
        old.time = 0;
        let mut new = Spec::new("ses_one", "prq_new", 2);
        new.cost = None;
        new.input = 1000.0;
        new.time = 1;
        let mut decision = Spec::new("ses_one", "prq_decision", 3);
        decision.cost = None;
        decision.source = "decision";
        decision.input = 1000.0;
        vec![old, new, decision]
    });
}

#[test]
fn unpriced_requests_are_priced_from_the_catalog_with_current_catalog_provenance() {
    let (store, service) = setup();
    unpriced(&store);
    let pricer = |reference: &PricingRef| {
        assert_eq!(reference.provider.to_utf8().unwrap(), "openai");
        assert_eq!(reference.model.to_utf8().unwrap(), "gpt");
        assert_eq!(reference.directory.to_utf8().unwrap(), "/project");
        Some(catalog(2.0))
    };
    let summary = service
        .usage(&id("ses_one"), Some(&pricer))
        .unwrap()
        .encode();
    assert_eq!(number(&summary, "logical"), 3.0);
    assert!((number(&summary, "cost") - 0.004).abs() < 1e-12);
    assert!((number(&summary, "models.0.cost") - 0.004).abs() < 1e-12);
    assert_eq!(
        string(&summary, "models.0.costProvenance"),
        "current_catalog"
    );

    let report = service
        .usage_report(
            &id("ses_one"),
            &report_input(r#"{"group":"model"}"#),
            Some(&pricer),
        )
        .unwrap()
        .encode();
    assert!((number(&report, "total.cost") - 0.004).abs() < 1e-12);
    assert!((number(&report, "rows.0.cost") - 0.004).abs() < 1e-12);
    assert_eq!(string(&report, "rows.0.costProvenance"), "current_catalog");
    let windowed = service
        .usage_report(
            &id("ses_one"),
            &report_input(r#"{"group":"model","to":1}"#),
            Some(&pricer),
        )
        .unwrap()
        .encode();
    assert!((number(&windowed, "total.cost") - 0.002).abs() < 1e-12);
}

#[test]
fn without_catalog_pricing_unpriced_requests_report_no_cost() {
    let (store, service) = setup();
    unpriced(&store);
    let summary = service.usage(&id("ses_one"), None).unwrap().encode();
    assert_eq!(number(&summary, "logical"), 3.0);
    assert!(!has(&summary, "cost"));
    assert!(!has(&summary, "models.0.cost"));
    let silent = |_: &PricingRef| None;
    let unresolved = service
        .usage(&id("ses_one"), Some(&silent))
        .unwrap()
        .encode();
    assert_eq!(unresolved, summary);
}

#[test]
fn a_read_holds_one_coherent_snapshot_while_pricing_resolves() {
    let (store, service) = setup();
    unpriced(&store);
    let writes = Cell::new(0);
    let pricer = |_: &PricingRef| {
        writes.set(writes.get() + 1);
        let mut late = Spec::new("ses_one", "prq_late", 9);
        late.cost = Some(7.0);
        insert(&store, vec![late]);
        Some(catalog(2.0))
    };
    let summary = service
        .usage(&id("ses_one"), Some(&pricer))
        .unwrap()
        .encode();
    assert_eq!(writes.get(), 1);
    assert_eq!(number(&summary, "logical"), 3.0);
    assert!((number(&summary, "cost") - 0.004).abs() < 1e-12);
    assert_eq!(
        number(
            &service.usage(&id("ses_one"), None).unwrap().encode(),
            "logical"
        ),
        4.0
    );
}

#[test]
fn summaries_rank_models_by_cost_and_describe_the_latest_request_and_family_scope() {
    let (store, service) = setup();
    sessions(&store, vec![("ses_child", Some("ses_one"), 5)]);
    insert(&store, {
        let mut cheap = Spec::new("ses_one", "prq_cheap", 1);
        cheap.model = "cheap";
        cheap.cost = Some(1.0);
        cheap.time = 10;
        let mut dear = Spec::new("ses_one", "prq_dear", 2);
        dear.model = "dear";
        dear.cost = Some(5.0);
        dear.time = 20;
        let mut free = Spec::new("ses_one", "prq_free", 3);
        free.model = "free";
        free.cost = None;
        free.time = 30;
        let mut child = Spec::new("ses_child", "prq_child", 1);
        child.model = "dear";
        child.cost = Some(2.0);
        child.time = 40;
        child.timing = Some(r#"{"firstOutputMs":12,"totalMs":34}"#);
        child.reported = None;
        vec![cheap, dear, free, child]
    });
    let summary = service.usage(&id("ses_one"), None).unwrap().encode();
    assert_eq!(number(&summary, "logical"), 4.0);
    assert_eq!(number(&summary, "cost"), 8.0);
    assert_eq!(at(&summary, "cacheReadReported"), &JsonValue::Bool(false));
    let order = (0..3)
        .map(|index| string(&summary, &format!("models.{index}.model.id")))
        .collect::<Vec<_>>();
    assert_eq!(order, ["dear", "cheap", "free"]);
    assert_eq!(number(&summary, "models.0.requests"), 2.0);
    assert_eq!(number(&summary, "models.0.cost"), 7.0);
    assert!(!has(&summary, "models.2.cost"));
    assert_eq!(string(&summary, "latestInvalidation"), "first-request");
    assert_eq!(string(&summary, "latestNamespace"), "cachekey");
    assert_eq!(
        at(&summary, "latestTiming"),
        &json(r#"{"firstOutputMs":12,"totalMs":34}"#)
    );

    let child = service.usage(&id("ses_child"), None).unwrap().encode();
    assert_eq!(number(&child, "logical"), 1.0);
    assert_eq!(number(&child, "cost"), 2.0);
    let empty = service.usage(&id("ses_two"), None).unwrap().encode();
    assert_eq!(
        empty,
        json(
            r#"{"logical":0,"physical":0,"helpers":0,"continued":0,"fallback":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}"#
        )
    );
}

#[test]
fn a_missing_session_is_not_found_and_invalid_inputs_do_not_decode() {
    let (_store, service) = setup();
    assert!(matches!(
        service.usage(&id("ses_missing"), None),
        Err(Error::Domain {
            kind: "not_found",
            ..
        })
    ));
    assert!(matches!(
        service.usage_report(
            &id("ses_missing"),
            &report_input(r#"{"group":"day"}"#),
            None
        ),
        Err(Error::Domain {
            kind: "not_found",
            ..
        })
    ));
    let rejected: Result<provider_request::ReportInput, DecodeError> =
        provider_request::ReportInput::decode(&json(r#"{"group":"day","from":5,"to":5}"#));
    assert!(rejected.is_err());
}
