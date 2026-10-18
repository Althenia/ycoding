use std::{
    cell::{Cell, RefCell},
    sync::Arc,
};
use ycoding_core::{
    resources::{config::Roots, tool_output_store},
    session::{
        cleanups::Cleanups,
        retention::Settings,
        runner::Clock,
        store::Service,
        usage_read::{Pricing, PricingRef},
    },
};
use ycoding_schema::{
    DecodeError, DomainDecode, DomainEncode, JsonValue, LosslessString, model,
    money::UsdPerMillionTokens, parse_json, provider, provider_request, session,
};
use ycoding_store::{
    Error, Store,
    project::{Project, ProjectTable},
    resources::{Request, RequestTable, UsageAnalyticsRequest, UsageAnalyticsRequestTable},
    session::{Document, SessionTable},
};

#[path = "report_support/mod.rs"]
mod report_support;
#[path = "autonomy_support/mod.rs"]
mod support;

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
            usage_anchor: None,
        }
    }
}

fn insert(store: &Store, specs: Vec<Spec<'static>>) {
    insert_rows(store, specs.iter().map(Spec::row).collect());
}

fn insert_rows(store: &Store, rows: Vec<Request>) {
    for rows in rows.chunks(1_000) {
        let rows = rows.to_vec();
        store
            .submit(move |tx| {
                rows.iter().try_for_each(|row| {
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
                            usage_anchor: None,
                            task_path: Document::new(parse_json("[]").unwrap())?,
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
            r#"{"generationSamples":1,"providerTimedSamples":1,"observedSamples":0,"generationP50TokensPerSecond":1,"generationP90TokensPerSecond":1,"firstOutputP50Ms":300,"firstOutputP95Ms":300,"totalP50Ms":600,"totalP95Ms":600,"outputTokensPerSecond":1,"samples":1}"#
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
    let global = service
        .usage_report_all(
            &report_input(
                r#"{"group":"session","sort":"steps","order":"desc","offset":300,"limit":3}"#,
            ),
            None,
        )
        .unwrap()
        .encode();
    assert_eq!(global, scoped);
    for group in ["session", "model"] {
        let wide = service
            .usage_report_all(
                &report_input(&format!(
                    r#"{{"group":"{group}","offset":100,"limit":100}}"#
                )),
                None,
            )
            .unwrap()
            .encode();
        assert_eq!(keys(&wide).len(), 100);
        assert_eq!(number(&wide, "total.logical"), 405.0);
        assert_eq!(number(&wide, "rows.0.speed.samples"), 1.0);
    }
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

#[test]
fn ambiguous_model_keys_use_the_first_family_observation_and_global_session_order() {
    let (store, service) = setup();
    sessions(&store, vec![("ses_encoded_child", Some("ses_one"), 0)]);
    let mut root = Spec::new("ses_one", "prq_variant", 1);
    root.variant = Some("same");
    let mut child = Spec::new("ses_encoded_child", "prq_profile", 1);
    child.profile = Some("same");
    insert(&store, vec![root, child]);
    let scoped = report(&service, "ses_one", r#"{"group":"model"}"#);
    assert_eq!(keys(&scoped), ["openai/gpt/same"]);
    assert_eq!(string(&scoped, "rows.0.label"), "openai/gpt (same)");
    let global = service
        .usage_report_all(&report_input(r#"{"group":"model"}"#), None)
        .unwrap()
        .encode();
    assert_eq!(string(&global, "rows.0.label"), "openai/gpt · same");
}

#[test]
fn reports_fail_without_an_engine_while_operational_usage_stays_canonical() {
    let (fixture, service) = setup();
    insert(&fixture, vec![Spec::new("ses_one", "prq_no_engine", 1)]);
    let ReportStore { _reports, store } = fixture;
    drop(_reports);
    assert_eq!(
        service.usage(&id("ses_one"), None).unwrap().logical.get(),
        1
    );
    assert!(matches!(
        service.usage_report(&id("ses_one"), &report_input(r#"{"group":"model"}"#), None),
        Err(Error::Record(_))
    ));
    drop(store);
}

#[test]
fn reports_preserve_sqlite_compensated_decimal_cost_totals() {
    let (store, service) = setup();
    insert(
        &store,
        (0..10)
            .map(|index| {
                let mut spec = Spec::new("ses_one", &format!("prq_decimal_{index}"), index);
                spec.cost = Some(0.1);
                spec.input = 0.1;
                spec
            })
            .collect(),
    );
    let result = report(&service, "ses_one", r#"{"group":"model"}"#);
    assert_eq!(number(&result, "total.cost"), 1.0);
    assert_eq!(number(&result, "rows.0.cost"), 1.0);
    assert_eq!(number(&result, "total.tokens.input"), 1.0);
    assert_eq!(number(&result, "rows.0.tokens.input"), 1.0);
    let summary = service.usage_all(None).unwrap().encode();
    assert_eq!(number(&summary, "cost"), 1.0);
    assert_eq!(number(&summary, "models.0.cost"), 1.0);
    assert_eq!(number(&summary, "tokens.input"), 1.0);
}

#[test]
fn report_pricing_selects_strict_context_tiers_before_base_and_router_prices() {
    let (store, service) = setup();
    let mut first = Spec::new("ses_one", "prq_tier_equal", 1);
    first.cost = None;
    first.input = 10.0;
    let mut second = Spec::new("ses_one", "prq_tier_above", 2);
    second.cost = None;
    second.input = 11.0;
    insert(&store, vec![first, second]);
    let pricer = |_: &PricingRef| {
        let mut pricing = catalog(2.0);
        let mut tier = pricing.provider[0].clone();
        tier.tier = Some(model::Tier {
            size: ycoding_schema::schema::Int::new(10).unwrap(),
        });
        tier.input = UsdPerMillionTokens::new(4.0).unwrap();
        pricing.provider.push(tier);
        pricing.router = catalog(100.0).provider;
        Some(pricing)
    };
    let result = service
        .usage_report(
            &id("ses_one"),
            &report_input(r#"{"group":"model"}"#),
            Some(&pricer),
        )
        .unwrap()
        .encode();
    assert!((number(&result, "total.cost") - 0.000064).abs() < 1e-12);
    assert_eq!(string(&result, "rows.0.costProvenance"), "current_catalog");
}

#[test]
fn report_pricing_preserves_router_gaps_strict_boundaries_and_tier_order() {
    let (store, service) = setup();
    insert(
        &store,
        [5.0, 10.0, 11.0, 20.0, 21.0, 30.0, 30.0]
            .into_iter()
            .enumerate()
            .map(|(index, input)| {
                let mut spec = Spec::new(
                    "ses_one",
                    &format!("prq_price_ranges_{index}"),
                    index as i64 + 1,
                );
                spec.input = input;
                spec.cost = None;
                if index == 6 {
                    spec.source = "decision";
                }
                spec
            })
            .collect(),
    );
    let pricer = |_: &PricingRef| {
        let tier = |size, rate| {
            let mut cost = catalog(rate).provider.remove(0);
            cost.tier = Some(model::Tier {
                size: ycoding_schema::schema::Int::new(size).unwrap(),
            });
            cost
        };
        Some(Pricing {
            provider: vec![tier(10, 4.0), tier(20, 6.0), tier(20, 9.0)],
            router: vec![catalog(2.0).provider.remove(0), tier(5, 100.0)],
        })
    };
    let input = report_input(r#"{"group":"model"}"#);
    for report in [
        service
            .usage_report(&id("ses_one"), &input, Some(&pricer))
            .unwrap(),
        service.usage_report_all(&input, Some(&pricer)).unwrap(),
    ] {
        let report = report.encode();
        assert_eq!(number(&report, "total.logical"), 7.0);
        assert!((number(&report, "total.cost") - 0.00144).abs() < 1e-12);
        assert_eq!(number(&report, "total.costCoverage.pricedRequests"), 6.0);
        assert_eq!(number(&report, "total.costCoverage.unpricedRequests"), 1.0);
    }
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
            &report_input(r#"{"group":"hour","timeZone":"Mars/Olympus_Mons"}"#),
            None
        ),
        Err(Error::Rejected(_))
    ));
}

fn millis(iso: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(iso)
        .unwrap()
        .timestamp_millis()
}

#[test]
fn iana_reports_match_intl_dst_days_repeated_hours_and_fractional_offset_boundaries() {
    let (store, service) = setup();
    let times = [
        "2026-03-08T04:30:00Z",
        "2026-03-08T05:30:00Z",
        "2026-03-09T03:30:00Z",
        "2026-03-09T04:30:00Z",
        "2027-03-08T18:14:00Z",
        "2027-03-08T18:15:00Z",
        "2027-04-30T18:14:00Z",
        "2027-04-30T18:15:00Z",
        "2026-10-25T00:30:00Z",
        "2026-10-25T01:30:00Z",
        "2026-03-08T06:30:00Z",
        "2026-03-08T07:30:00Z",
    ];
    insert(
        &store,
        times
            .iter()
            .enumerate()
            .map(|(index, time)| {
                let mut spec = Spec::new("ses_one", &format!("prq_zone_{index}"), index as i64 + 1);
                spec.time = millis(time);
                spec
            })
            .collect(),
    );
    let cases = [
        (
            "day",
            "America/New_York",
            "2026-03-08T05:00:00Z",
            "2026-03-09T04:00:00Z",
            vec!["2026-03-08"],
        ),
        (
            "hour",
            "Europe/Berlin",
            "2026-10-25T00:00:00Z",
            "2026-10-25T02:00:00Z",
            vec!["2026-10-25T02:00:00+02:00", "2026-10-25T02:00:00+01:00"],
        ),
        (
            "hour",
            "america/new_york",
            "2026-03-08T06:00:00Z",
            "2026-03-08T08:00:00Z",
            vec!["2026-03-08T01:00:00-05:00", "2026-03-08T03:00:00-04:00"],
        ),
        (
            "day",
            "Asia/Kathmandu",
            "2027-03-08T18:14:00Z",
            "2027-03-08T18:16:00Z",
            vec!["2027-03-08", "2027-03-09"],
        ),
        (
            "month",
            "Asia/Kathmandu",
            "2027-04-30T18:14:00Z",
            "2027-04-30T18:16:00Z",
            vec!["2027-04", "2027-05"],
        ),
    ];
    for (group, zone, from, to, expected) in cases {
        let input = report_input(&format!(
            r#"{{"group":"{group}","timeZone":"{zone}","from":{},"to":{}}}"#,
            millis(from),
            millis(to)
        ));
        let local = service.usage_report(&id("ses_one"), &input, None).unwrap();
        let global = service.usage_report_all(&input, None).unwrap();
        assert_eq!(local, global);
        assert_eq!(keys(&global.encode()), expected);
        if group == "hour" {
            let descending = service.usage_report_all(&report_input(&format!(r#"{{"group":"{group}","timeZone":"{zone}","from":{},"to":{},"order":"desc","limit":1}}"#, millis(from), millis(to))), None).unwrap();
            assert_eq!(descending.rows[0].key.as_str(), expected.last().copied());
            assert_eq!(descending.row_count.get(), 2);
            assert_eq!(descending.next_offset.unwrap().get(), 1);
        }
    }
    let input = report_input(&format!(
        r#"{{"group":"day","from":{},"to":{}}}"#,
        millis("2026-03-08T05:00:00Z"),
        millis("2026-03-09T04:00:00Z")
    ));
    assert_eq!(
        keys(&service.usage_report_all(&input, None).unwrap().encode()),
        ["2026-03-08", "2026-03-09"]
    );
    assert_eq!(
        service.usage_all(None).unwrap(),
        service.usage(&id("ses_one"), None).unwrap()
    );
}

#[test]
fn utc_aliases_and_intl_offset_forms_canonicalize_and_invalid_zones_are_rejected() {
    let (store, service) = setup();
    insert(&store, vec![Spec::new("ses_one", "prq_alias", 1)]);
    for zone in [
        "UTC", "utc", "Etc/UTC", "GMT", "Etc/GMT", "UCT", "Etc/UCT", "-00:00",
    ] {
        assert_eq!(
            report_days(
                &service,
                &format!(r#"{{"group":"hour","timeZone":"{zone}"}}"#)
            ),
            ["1970-01-01T00:00:00+00:00"]
        );
    }
    for zone in ["+05:30", "+0530", "Asia/Kolkata"] {
        assert_eq!(
            report_days(
                &service,
                &format!(r#"{{"group":"hour","timeZone":"{zone}"}}"#)
            ),
            ["1970-01-01T05:00:00+05:30"]
        );
    }
    assert_eq!(
        report_days(&service, r#"{"group":"hour","timeZone":"+05"}"#),
        ["1970-01-01T05:00:00+05:00"]
    );
    for zone in [
        "Z",
        "Mars/Olympus_Mons",
        "+24:00",
        "+01:60",
        "+1",
        " UTC",
        "CST6CDT",
        "est5edt",
        "MST7MDT",
        "PST8PDT",
    ] {
        for group in ["hour", "model"] {
            assert!(matches!(
                service.usage_report_all(
                    &report_input(&format!(r#"{{"group":"{group}","timeZone":"{zone}"}}"#)),
                    None
                ),
                Err(Error::Rejected("Invalid IANA time zone"))
            ));
        }
    }
}

#[test]
fn backend_usage_includes_roots_children_archived_locations_once_and_uses_global_latest_order() {
    let (store, service) = setup();
    sessions(
        &store,
        vec![
            ("ses_child", Some("ses_one"), 20),
            ("ses_other_root", None, 30),
        ],
    );
    store
        .submit(|tx| {
            let mut row = support::record("ses_archived");
            row.directory = "/other".into();
            row.project_id = "global".into();
            row.time_archived = Some(1);
            row.time_updated = 40;
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
            SessionTable::insert(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    insert(
        &store,
        ["ses_one", "ses_child", "ses_other_root", "ses_archived"]
            .iter()
            .enumerate()
            .map(|(index, name)| {
                let mut spec = Spec::new(name, &format!("prq_all_{index}"), 1);
                spec.time = 100;
                spec.cost = if index == 3 { None } else { Some(index as f64) };
                spec.timing = if index == 3 {
                    Some(r#"{"firstOutputMs":99}"#)
                } else {
                    None
                };
                spec
            })
            .collect(),
    );
    let summary = service.usage_all(None).unwrap();
    assert_eq!(summary.logical.get(), 4);
    assert_eq!(summary.cost.unwrap().get(), 3.0);
    assert_eq!(
        summary
            .latest_timing
            .unwrap()
            .first_output_ms
            .unwrap()
            .get(),
        99
    );
    let pricer = |reference: &PricingRef| {
        assert_eq!(reference.directory.as_str(), Some("/other"));
        Some(catalog(2.0))
    };
    let report = service.usage_report_all(&report_input(r#"{"group":"session","sort":"cost","order":"desc","offset":1,"limit":2,"from":100,"to":101}"#), Some(&pricer)).unwrap().encode();
    assert_eq!(number(&report, "total.logical"), 4.0);
    assert_eq!(number(&report, "rowCount"), 4.0);
    assert_eq!(keys(&report), ["ses_child", "ses_archived"]);
    assert_eq!(number(&report, "nextOffset"), 3.0);
    assert_eq!(string(&report, "rows.1.costProvenance"), "current_catalog");
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
            r#"{"generationSamples":1,"providerTimedSamples":0,"observedSamples":1,"generationP50TokensPerSecond":5,"generationP90TokensPerSecond":5,"firstOutputP50Ms":20,"firstOutputP95Ms":40,"totalP50Ms":200,"totalP95Ms":400,"outputTokensPerSecond":5,"samples":4}"#
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
fn summary_pricing_cache_preserves_negative_results_and_fifo_eviction() {
    let (store, service) = setup();
    let models = (0..257)
        .map(|index| format!("cached-{index}"))
        .collect::<Vec<_>>();
    let sequence = [0, 0].into_iter().chain(1..257).chain([0, 256, 1, 1]);
    insert_rows(
        &store,
        sequence
            .enumerate()
            .map(|(ordinal, index)| {
                let mut spec = Spec::new(
                    "ses_one",
                    &format!("prq_cached_{ordinal:04}"),
                    ordinal as i64 + 1,
                );
                spec.model = &models[index];
                spec.cost = None;
                spec.input = 1000.0;
                spec.time = ordinal as i64;
                spec.row()
            })
            .collect(),
    );
    let calls = RefCell::new(vec![0; 257]);
    let pricer = |reference: &PricingRef| {
        let index = reference
            .model
            .to_utf8()
            .unwrap()
            .strip_prefix("cached-")
            .unwrap()
            .parse::<usize>()
            .unwrap();
        calls.borrow_mut()[index] += 1;
        (index % 2 == 1).then(|| catalog(2.0))
    };
    let summary = service
        .usage(&id("ses_one"), Some(&pricer))
        .unwrap()
        .encode();
    assert_eq!(number(&summary, "logical"), 262.0);
    assert!((number(&summary, "cost") - 0.26).abs() < 1e-12);
    assert_eq!(calls.borrow()[0], 2);
    assert_eq!(calls.borrow()[1], 2);
    assert!(calls.borrow()[2..].iter().all(|count| *count == 1));
}

#[test]
fn a_report_excludes_writes_during_pricing_and_the_next_read_includes_them() {
    let (store, service) = setup();
    unpriced(&store);
    let calls = Cell::new(0);
    let pricer = |_: &PricingRef| {
        calls.set(calls.get() + 1);
        assert_eq!(
            service.get(&id("ses_one")).unwrap().unwrap().id,
            id("ses_one")
        );
        let mut late = Spec::new("ses_one", "prq_report_late", 9);
        late.cost = Some(7.0);
        insert(&store, vec![late]);
        Some(catalog(2.0))
    };
    let input = report_input(r#"{"group":"model","timeZone":"Europe/Berlin"}"#);
    let result = service
        .usage_report(&id("ses_one"), &input, Some(&pricer))
        .unwrap();
    assert_eq!(calls.get(), 1);
    assert_eq!(result.total.logical.get(), 3);
    assert!((result.total.cost.unwrap().get() - 0.004).abs() < 1e-12);
    let next = service.usage_report(&id("ses_one"), &input, None).unwrap();
    assert_eq!(next.total.logical.get(), 4);
    assert_eq!(next.total.cost.unwrap().get(), 7.0);
}

#[test]
fn backend_report_predicates_and_pricing_share_the_captured_snapshot() {
    let (store, service) = setup();
    insert(
        &store,
        (0..10)
            .map(|index| {
                let mut spec = Spec::new("ses_one", &format!("prq_predicate_{index}"), index + 1);
                spec.time = 100;
                spec.cost = None;
                spec.profile = Some("work");
                spec.variant = Some("high");
                match index {
                    1 => spec.time = 101,
                    2 => spec.time = 99,
                    3 => spec.time = 102,
                    4 => spec.provider = "other",
                    5 => spec.model = "other",
                    6 => spec.profile = Some("other"),
                    7 => spec.variant = Some("other"),
                    8 => spec.profile = None,
                    9 => spec.variant = None,
                    _ => {}
                }
                spec
            })
            .collect(),
    );
    let calls = Cell::new(0);
    let pricer = |reference: &PricingRef| {
        calls.set(calls.get() + 1);
        assert_eq!(reference.provider.as_str(), Some("openai"));
        assert_eq!(reference.model.as_str(), Some("gpt"));
        assert_eq!(reference.profile.as_ref().unwrap().as_str(), Some("work"));
        let mut late = Spec::new("ses_one", "prq_predicate_late", 11);
        late.time = 100;
        late.cost = None;
        late.profile = Some("work");
        late.variant = Some("high");
        insert(&store, vec![late]);
        Some(catalog(2.0))
    };
    let input = report_input(
        r#"{"group":"model","from":100,"to":102,"providerID":"openai","modelID":"gpt","profile":"work","selectedEffort":"high"}"#,
    );
    let result = service.usage_report_all(&input, Some(&pricer)).unwrap();
    assert_eq!(calls.get(), 1);
    assert_eq!(result.total.logical.get(), 2);
    assert_eq!(result.row_count.get(), 1);
    assert!((result.total.cost.unwrap().get() - 0.00004).abs() < 1e-12);
    assert_eq!(
        string(&result.encode(), "total.costProvenance"),
        "current_catalog"
    );
    let next = service.usage_report_all(&input, None).unwrap();
    assert_eq!(next.total.logical.get(), 3);
    assert_eq!(next.row_count.get(), 1);
    assert_eq!(next.total.cost, None);
}

#[test]
fn sparse_report_filters_and_unpriced_references_cross_source_pages() {
    let (store, service) = setup();
    insert(
        &store,
        (0..10_017)
            .map(|index| {
                let mut spec = Spec::new("ses_one", &format!("prq_sparse_{index:05}"), index + 1);
                spec.time = index;
                spec.cost = None;
                spec.model = if index == 10_016 { "missing" } else { "priced" };
                spec.timing = Some(r#"{"firstOutputMs":10,"totalMs":20}"#);
                spec
            })
            .collect(),
    );
    let calls = Cell::new(0);
    let pricer = |reference: &PricingRef| {
        calls.set(calls.get() + 1);
        (reference.model.as_str() == Some("priced")).then(|| catalog(2.0))
    };
    let result = service
        .usage_report_all(
            &report_input(r#"{"group":"model","from":10015,"to":10017,"limit":1}"#),
            Some(&pricer),
        )
        .unwrap();
    assert_eq!(calls.get(), 2);
    assert_eq!(result.total.logical.get(), 2);
    assert_eq!(result.row_count.get(), 2);
    assert_eq!(result.next_offset.unwrap().get(), 1);
    assert_eq!(result.rows[0].metrics.cost, None);
    assert_eq!(result.rows[0].metrics.cost_provenance, None);
    assert_eq!(
        result.rows[0]
            .speed
            .as_ref()
            .unwrap()
            .first_output_p95_ms
            .unwrap()
            .get(),
        10
    );
    let summary = service.usage_all(Some(&pricer)).unwrap();
    assert_eq!(summary.logical.get(), 10_017);
    assert_eq!(summary.models.unwrap().len(), 2);
    let input = report_input(r#"{"group":"model","limit":1}"#);
    for scoped in [false, true] {
        let report = if scoped {
            service.usage_report(&id("ses_one"), &input, Some(&pricer))
        } else {
            service.usage_report_all(&input, Some(&pricer))
        }
        .unwrap();
        assert_eq!(report.total.logical.get(), 10_017);
        assert_eq!(report.row_count.get(), 2);
        assert_eq!(report.rows.len(), 1);
        assert_eq!(report.next_offset.unwrap().get(), 1);
        assert_eq!(report.rows[0].metrics.cost, None);
        assert_eq!(report.rows[0].metrics.cost_provenance, None);
        assert!((report.total.cost.unwrap().get() - 0.20032).abs() < 1e-12);
        assert_eq!(
            string(&report.encode(), "total.costProvenance"),
            "current_catalog"
        );
    }
}

#[test]
fn known_prices_follow_the_native_text_projection_for_lossless_profiles() {
    let (store, service) = setup();
    let mut row = Spec::new("ses_one", "prq_lossless_price", 1).row();
    row.cost = None;
    row.model = Document::new(json(
        r#"{"providerID":"openai","id":"gpt","profile":"Work\ud800"}"#,
    ))
    .unwrap();
    insert_rows(&store, vec![row]);
    let pricer = |_: &PricingRef| Some(catalog(2.0));
    let summary = service.usage_all(Some(&pricer)).unwrap();
    let result = service
        .usage_report_all(&report_input(r#"{"group":"model"}"#), Some(&pricer))
        .unwrap();
    assert_eq!(result.total.cost, summary.cost);
    assert_eq!(result.total.cost.unwrap().get(), 0.00002);
    assert_eq!(
        result.rows[0]
            .metrics
            .cost_provenance
            .as_ref()
            .unwrap()
            .0
            .as_str(),
        Some("current_catalog")
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

fn recorded(
    session: &str,
    event: &str,
    request_id: &str,
    number: i64,
    cost: f64,
    time: i64,
) -> ycoding_store::session::NewEvent {
    ycoding_store::session::NewEvent {
        id: event.into(),
        aggregate_id: session.into(),
        type_: "session.provider.request.recorded.1".into(),
        created: time,
        data: json(&format!(
            r#"{{"sessionID":"{session}","id":"{request_id}","source":"step","agent":"build","model":{{"providerID":"openai","id":"gpt"}},"routeID":"test","promptCacheKey":"{}","systemDigest":"{}","toolDigest":"{}","request":{number},"attempts":1,"invalidation":"first-request","continuation":"full","cacheReadReported":true,"cost":{cost},"tokens":{{"input":10,"output":0,"reasoning":0,"cache":{{"read":0,"write":0}}}},"time":{time}}}"#,
            "a".repeat(64),
            "b".repeat(64),
            "c".repeat(64)
        )),
    }
}

fn delete_ledger_row(store: &Store, request_id: &'static str) {
    store
        .submit(move |tx| {
            RequestTable::delete(
                tx,
                &ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&request_id.into())]),
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    store.analytics().unwrap().purge().unwrap();
}

struct Epoch;
impl Clock for Epoch {
    fn now(&self) -> i64 {
        0
    }
    fn sleep(&self, _: u64) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        Box::pin(std::future::pending())
    }
}

async fn settle_purge(store: &Store) {
    let roots = Roots::development(
        &std::env::temp_dir().join(format!("ycoding-usage-read-settle-{}", std::process::id())),
    )
    .unwrap();
    Cleanups::new(
        store.client(),
        Arc::new(tool_output_store::Store::new(&roots)),
        Arc::new(Epoch),
        Arc::new(Vec::new),
        Arc::new(Settings::default),
    )
    .usage()
    .await
    .unwrap();
}

#[tokio::test]
async fn backend_reads_keep_recorded_requests_after_session_removal_while_session_reads_use_the_ledger()
 {
    let (store, service) = setup();
    service
        .publish(recorded(
            "ses_one",
            "evt_fact_one",
            "prq_fact_one",
            1,
            1.0,
            100,
        ))
        .await
        .unwrap();
    service
        .publish(recorded(
            "ses_two",
            "evt_fact_two",
            "prq_fact_two",
            1,
            2.0,
            200,
        ))
        .await
        .unwrap();
    let all = service.usage_all(None).unwrap();
    assert_eq!(all.logical.get(), 2);
    assert_eq!(all.cost.unwrap().get(), 3.0);

    service.remove(&id("ses_one")).await.unwrap();
    let pending = service
        .usage_report_all(&report_input(r#"{"group":"model"}"#), None)
        .err()
        .unwrap();
    assert!(format!("{pending:?}").contains("Privacy"), "{pending:?}");
    settle_purge(&store).await;

    let all = service.usage_all(None).unwrap();
    assert_eq!(all.logical.get(), 2);
    assert_eq!(all.cost.unwrap().get(), 3.0);
    let by_session = service
        .usage_report_all(
            &report_input(r#"{"group":"session","sort":"cost","order":"desc"}"#),
            None,
        )
        .unwrap()
        .encode();
    assert_eq!(number(&by_session, "total.logical"), 2.0);
    assert_eq!(number(&by_session, "rowCount"), 2.0);
    assert_eq!(keys(&by_session), ["ses_two", "ses_one"]);
    assert_eq!(string(&by_session, "rows.0.label"), "Test");
    assert_eq!(string(&by_session, "rows.1.label"), "ses_one");

    let two = service.usage(&id("ses_two"), None).unwrap();
    assert_eq!(two.logical.get(), 1);
    assert_eq!(two.cost.unwrap().get(), 2.0);
    delete_ledger_row(&store, "prq_fact_two");
    assert_eq!(
        service.usage(&id("ses_two"), None).unwrap().logical.get(),
        0
    );
    let session_report = report(&service, "ses_two", r#"{"group":"model"}"#);
    assert_eq!(number(&session_report, "total.logical"), 0.0);
    let all = service.usage_all(None).unwrap();
    assert_eq!(all.logical.get(), 2);
    assert_eq!(all.cost.unwrap().get(), 3.0);
    let by_model = service
        .usage_report_all(&report_input(r#"{"group":"model"}"#), None)
        .unwrap()
        .encode();
    assert_eq!(number(&by_model, "total.logical"), 2.0);
}

#[tokio::test]
async fn a_repeated_request_id_never_rewrites_the_retained_request() {
    let (store, service) = setup();
    let first = service
        .publish(recorded("ses_one", "evt_dup_one", "prq_dup", 1, 1.0, 100))
        .await
        .unwrap();
    service
        .publish(recorded("ses_one", "evt_dup_new", "prq_dup", 1, 9.0, 300))
        .await
        .unwrap();
    let all = service.usage_all(None).unwrap();
    assert_eq!((all.logical.get(), all.cost.unwrap().get()), (1, 1.0));
    let one = service.usage(&id("ses_one"), None).unwrap();
    assert_eq!((one.logical.get(), one.cost.unwrap().get()), (1, 1.0));
    store
        .submit(move |tx| ycoding_core::session::projector::fold(tx, &first))
        .unwrap()
        .wait()
        .unwrap();
    let all = service.usage_all(None).unwrap();
    assert_eq!((all.logical.get(), all.cost.unwrap().get()), (1, 1.0));
    let one = service.usage(&id("ses_one"), None).unwrap();
    assert_eq!((one.logical.get(), one.cost.unwrap().get()), (1, 1.0));

    delete_ledger_row(&store, "prq_dup");
    service
        .publish(recorded("ses_one", "evt_dup_two", "prq_dup", 1, 9.0, 300))
        .await
        .unwrap();

    let all = service.usage_all(None).unwrap();
    assert_eq!((all.logical.get(), all.cost.unwrap().get()), (1, 1.0));
    let one = service.usage(&id("ses_one"), None).unwrap();
    assert_eq!((one.logical.get(), one.cost.unwrap().get()), (1, 9.0));
}
