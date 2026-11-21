use std::sync::Arc;
use ycoding_core::{
    generation_activity,
    session::{
        generation_meter::{Meter, Outcome},
        store::Service,
    },
};
use ycoding_schema::{DomainDecode, DomainEncode, JsonValue, model, parse_json, provider_request};
use ycoding_store::{
    Metadata, Options, Store, native,
    resources::{UsageAnalyticsRequest, UsageAnalyticsRequestTable},
    session::Document,
};

#[path = "report_support/demand.rs"]
mod demand_support;
#[path = "report_support/prepared.rs"]
mod prepared_support;
#[path = "report_support/mod.rs"]
mod report_support;

fn value<'a>(json: &'a JsonValue, path: &str) -> Option<&'a JsonValue> {
    path.split('.').try_fold(json, |json, key| match json {
        JsonValue::Object(fields) => fields.get(&key.into()),
        JsonValue::Array(items) => items.get(key.parse::<usize>().ok()?),
        _ => None,
    })
}

fn number(json: &JsonValue, path: &str) -> Option<f64> {
    match value(json, path) {
        Some(JsonValue::Number(value)) => Some(*value),
        _ => None,
    }
}

fn fact(
    index: i64,
    outcome: Option<&str>,
    cost: Option<f64>,
    timing: Option<&str>,
) -> UsageAnalyticsRequest {
    UsageAnalyticsRequest {
        id: format!("prq_parity_{index}").into(),
        session_id: "ses_synthetic".into(),
        project_id: "prj_synthetic".into(),
        directory: "/synthetic".into(),
        workspace_id: None,
        session_updated: 1,
        agent: "build".into(),
        source: "step".into(),
        model: Document::new(parse_json(r#"{"providerID":"local","id":"meter"}"#).unwrap())
            .unwrap(),
        usage_anchor: None,
        task_path: Document::new(parse_json("[]").unwrap()).unwrap(),
        request: index,
        attempts: 1,
        continuation: "full".into(),
        invalidation: "first-request".into(),
        prompt_cache_key: "synthetic".into(),
        cache_read_reported: None,
        tokens: Document::new(
            parse_json(r#"{"input":10,"output":20,"reasoning":5,"cache":{"read":3,"write":4}}"#)
                .unwrap(),
        )
        .unwrap(),
        cost,
        timing: timing.map(|timing| Document::new(parse_json(timing).unwrap()).unwrap()),
        time_created: index * 1000,
        outcome: outcome.map(Into::into),
    }
}

#[test]
fn native_usage_is_ready_before_the_sql_mirror_and_respects_privacy_changes() {
    use ycoding_store::analytics::{DeliveryTable, privacy_changed};

    let store = Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([6; 16], 1),
    )
    .unwrap();
    let client = store.client();
    let _reports = report_support::start(client.clone());
    client
        .submit(|tx| UsageAnalyticsRequestTable::insert(tx, &fact(1, None, Some(0.25), None)))
        .unwrap()
        .wait()
        .unwrap();
    let delivery = || {
        client
            .snapshot()
            .unwrap()
            .get::<DeliveryTable>(&[])
            .unwrap()
            .unwrap()
    };
    assert!(!delivery().valid);

    let sessions = Service::new(client.clone());
    let views = ycoding_core::usage_view::Service::new(sessions.clone(), None);
    assert!(
        views.publish().unwrap(),
        "native Usage must not wait for SQL catch-up"
    );
    let input = provider_request::ReportInput::decode(
        &parse_json(r#"{"group":"model","from":1000,"to":2000}"#).unwrap(),
    )
    .unwrap();
    demand_support::prepare(&client, None, std::slice::from_ref(&input)).unwrap();
    let before = views
        .read_prepared(std::slice::from_ref(&input))
        .unwrap()
        .unwrap();
    assert_eq!(number(&before.summary.encode(), "cost"), Some(0.25));
    assert_eq!(
        number(&before.reports[0].encode(), "total.logical"),
        Some(1.0)
    );
    assert!(!delivery().valid);

    client.analytics().unwrap().rebuild().unwrap();
    assert!(delivery().valid);
    let after = views
        .read_prepared(std::slice::from_ref(&input))
        .unwrap()
        .unwrap();
    assert_eq!(after.revision, before.revision);

    client
        .submit(|tx| privacy_changed(tx, Vec::new(), true))
        .unwrap()
        .wait()
        .unwrap();
    assert!(views.read_prepared(&[]).unwrap().is_none());
    assert!(!views.publish().unwrap());
}

#[test]
fn native_usage_publishes_backend_facts_with_a_bounded_source_read() {
    let store = Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([6; 16], 1),
    )
    .unwrap();
    let client = store.client();
    let _reports = report_support::start(client.clone());
    client
        .submit(|tx| {
            for index in 1..=64 {
                let mut row = fact(
                    index,
                    None,
                    Some(0.25),
                    Some(&format!(
                        r#"{{"generatedTokens":{index},"generationDurationNs":1100000000,"firstOutputMs":{index},"totalMs":1000}}"#
                    )),
                );
                row.time_created = index * 900_000;
                UsageAnalyticsRequestTable::insert(tx, &row)?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();

    let statement = client.read_statement(88);
    let views =
        ycoding_core::usage_view::Service::new(Service::new(statement.client().clone()), None);
    assert!(views.publish().unwrap());

    let input = provider_request::ReportInput::decode(
        &parse_json(r#"{"group":"model","from":900000,"to":58500000}"#).unwrap(),
    )
    .unwrap();
    demand_support::prepare(&client, None, &[]).unwrap();
    let report_statement = client.read_statement(80);
    demand_support::prepare(
        report_statement.client(),
        None,
        std::slice::from_ref(&input),
    )
    .unwrap();
    let report = Service::new(client)
        .usage_report_all(&input)
        .unwrap()
        .encode();
    assert_eq!(number(&report, "total.logical"), Some(64.0));
    assert_eq!(number(&report, "total.cost"), Some(16.0));
    assert_eq!(number(&report, "speed.generationSamples"), Some(64.0));
    assert_eq!(
        number(&report, "speed.generationP95TokensPerSecond"),
        Some(61.0 / 1.1)
    );
    assert_eq!(number(&report, "speed.firstOutputP99Ms"), Some(64.0));
    assert_eq!(number(&report, "speed.totalP99Ms"), Some(1000.0));
}

#[test]
fn known_costs_outcomes_speed_percentiles_and_concurrency_are_exact() {
    let store = Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([6; 16], 1),
    )
    .unwrap();
    let _reports = report_support::start(store.client());
    let rows = [
        fact(
            1,
            Some("completed"),
            Some(0.0),
            Some(
                r#"{"generatedTokens":100,"generationDurationNs":1000000000,"firstOutputMs":10,"totalMs":1000}"#,
            ),
        ),
        fact(
            2,
            Some("failed"),
            None,
            Some(
                r#"{"generatedTokens":100,"observedGenerationDurationNs":2000000000,"firstOutputMs":20,"totalMs":3000}"#,
            ),
        ),
        fact(
            3,
            Some("cancelled"),
            Some(0.25),
            Some(
                r#"{"estimatedTokens":9000,"estimatedGenerationDurationNs":1000000000,"receivedOutput":{"estimatedTokens":9000,"durationNs":1000000000},"firstOutputMs":30,"totalMs":2000}"#,
            ),
        ),
        fact(4, None, None, None),
    ];
    store
        .submit(move |tx| {
            rows.iter()
                .try_for_each(|row| UsageAnalyticsRequestTable::insert(tx, row))
        })
        .unwrap()
        .wait()
        .unwrap();
    let sessions = Service::new(store.client());
    let views = ycoding_core::usage_view::Service::new(sessions.clone(), None);
    prepared_support::publish(&store.client(), &views);
    let input = provider_request::ReportInput::decode(
        &parse_json(r#"{"group":"model","from":1000,"to":5000}"#).unwrap(),
    )
    .unwrap();
    let report = {
        demand_support::prepare(&store.client(), None, std::slice::from_ref(&input)).unwrap();
        sessions.usage_report_all(&input)
    }
    .unwrap()
    .encode();
    assert_eq!(number(&report, "total.cost"), Some(0.25));
    assert_eq!(
        number(&report, "total.costCoverage.pricedRequests"),
        Some(2.0)
    );
    assert_eq!(
        number(&report, "total.costCoverage.unpricedRequests"),
        Some(2.0)
    );
    assert_eq!(number(&report, "total.outcomes.completed"), Some(1.0));
    assert_eq!(number(&report, "total.outcomes.failed"), Some(1.0));
    assert_eq!(number(&report, "total.outcomes.cancelled"), Some(1.0));
    assert!(value(&report, "rows.0.concurrency").is_none());
    assert_eq!(number(&report, "speed.generationSamples"), Some(2.0));
    assert_eq!(number(&report, "speed.providerTimedSamples"), Some(1.0));
    assert_eq!(number(&report, "speed.observedSamples"), Some(1.0));
    assert!(value(&report, "speed.generationP95TokensPerSecond").is_none());
    assert!(value(&report, "speed.meanTokensPerSecond").is_none());
    assert_eq!(
        number(&report, "speed.outputTokensPerSecond"),
        Some(200.0 / 3.0)
    );
    assert_eq!(number(&report, "speed.firstOutputP99Ms"), Some(30.0));
    assert_eq!(number(&report, "speed.totalP99Ms"), Some(3000.0));
    let narrower = provider_request::ReportInput::decode(
        &parse_json(r#"{"group":"day","from":3000,"to":4000}"#).unwrap(),
    )
    .unwrap();
    let absent = {
        demand_support::prepare(&store.client(), None, std::slice::from_ref(&narrower)).unwrap();
        sessions.usage_report_all(&narrower)
    }
    .unwrap()
    .encode();
    assert_eq!(number(&absent, "speed.generationSamples"), Some(0.0));
    assert!(value(&absent, "speed.meanTokensPerSecond").is_none());
    assert_eq!(number(&absent, "total.tokens.output"), Some(20.0));
    assert_eq!(
        number(&absent, "rows.0.concurrency"),
        Some(2000.0 / 86_400_000.0)
    );
    let historical = provider_request::ReportInput::decode(
        &parse_json(r#"{"group":"model","from":4000,"to":5000}"#).unwrap(),
    )
    .unwrap();
    assert!(
        value(
            &{
                demand_support::prepare(&store.client(), None, std::slice::from_ref(&historical))
                    .unwrap();
                sessions.usage_report_all(&historical)
            }
            .unwrap()
            .encode(),
            "total.outcomes"
        )
        .is_none()
    );
    let reported = provider_request::ReportInput::decode(
        &parse_json(r#"{"group":"model","from":1000,"to":4000}"#).unwrap(),
    )
    .unwrap();
    assert_eq!(
        number(
            &{
                demand_support::prepare(&store.client(), None, std::slice::from_ref(&reported))
                    .unwrap();
                sessions.usage_report_all(&reported)
            }
            .unwrap()
            .encode(),
            "total.outcomes.completed"
        ),
        Some(1.0)
    );
}

#[test]
fn live_activity_is_attempt_scoped_profile_aware_and_bounded() {
    let activity = generation_activity::Service::new(0, 0);
    let mut meters = (0..60)
        .map(|index| {
            Meter::new(
                provider_request::Id::new(format!("prq_live_{index}")).unwrap(),
                1,
                model::Ref::decode(
                    &parse_json(&format!(
                        r#"{{"providerID":"local","id":"model-{index}","profile":"work"}}"#
                    ))
                    .unwrap(),
                )
                .unwrap(),
                0,
            )
        })
        .collect::<Vec<_>>();
    for meter in &mut meters {
        activity.update(meter, 0);
        meter.waiting(1);
        activity.update(meter, 1);
    }
    let initial = activity.snapshot(1);
    assert_eq!(number(&initial, "active"), Some(60.0));
    assert!(
        matches!(value(&initial, "models"), Some(JsonValue::Array(items)) if items.len() == 50)
    );
    for index in 1..=130 {
        activity.snapshot(index * 5_000_000_000);
    }
    assert!(
        matches!(value(&activity.snapshot(650_000_000_000), "history"), Some(JsonValue::Array(items)) if items.len() == 120)
    );
    for meter in &mut meters {
        meter.settle(Outcome::Cancelled, 650_000_000_000);
        activity.update(meter, 650_000_000_000);
    }
    let empty = activity.snapshot(660_000_000_000);
    assert_eq!(number(&empty, "active"), Some(0.0));
    assert!(value(&empty, "outputTokensPerSecond").is_none());
    let _ = Arc::new(activity);
}

#[test]
fn temporal_concurrency_uses_local_calendar_buckets_including_dst() {
    let store = Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([7; 16], 1),
    )
    .unwrap();
    let _reports = report_support::start(store.client());
    let millis = |date: &str| {
        chrono::DateTime::parse_from_rfc3339(date)
            .unwrap()
            .timestamp_millis()
    };
    let mut spring = fact(1, Some("completed"), Some(0.0), Some(r#"{"totalMs":6000}"#));
    spring.time_created = millis("2026-03-08T12:00:00Z");
    let mut autumn = fact(2, Some("completed"), Some(0.0), Some(r#"{"totalMs":6000}"#));
    autumn.time_created = millis("2026-11-01T12:00:00Z");
    store
        .submit(move |tx| {
            UsageAnalyticsRequestTable::insert(tx, &spring)?;
            UsageAnalyticsRequestTable::insert(tx, &autumn)
        })
        .unwrap()
        .wait()
        .unwrap();
    let sessions = Service::new(store.client());
    let views = ycoding_core::usage_view::Service::new(sessions.clone(), None);
    prepared_support::publish(&store.client(), &views);
    for (group, expected) in [
        (
            "day",
            [6000.0 / (23.0 * 3_600_000.0), 6000.0 / (25.0 * 3_600_000.0)],
        ),
        (
            "month",
            [
                6000.0 / (743.0 * 3_600_000.0),
                6000.0 / (721.0 * 3_600_000.0),
            ],
        ),
    ] {
        let input = provider_request::ReportInput::decode(
            &parse_json(&format!(
                r#"{{"group":"{group}","timeZone":"America/New_York"}}"#
            ))
            .unwrap(),
        )
        .unwrap();
        let report = {
            demand_support::prepare(&store.client(), None, std::slice::from_ref(&input)).unwrap();
            sessions.usage_report_all(&input)
        }
        .unwrap()
        .encode();
        assert_eq!(number(&report, "rows.0.concurrency"), Some(expected[0]));
        assert_eq!(number(&report, "rows.1.concurrency"), Some(expected[1]));
    }
}

#[test]
fn task_overlap_counts_each_request_once_in_report_total_and_speed() {
    let store = Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([53; 16], 1),
    )
    .unwrap();
    let _reports = report_support::start(store.client());
    let mut row = fact(
        1,
        Some("completed"),
        Some(0.0),
        Some(r#"{"generatedTokens":100,"generationDurationNs":1000000000}"#),
    );
    row.task_path = Document::new(parse_json(r#"["ses_child","ses_parent"]"#).unwrap()).unwrap();
    store
        .submit(move |tx| UsageAnalyticsRequestTable::insert(tx, &row))
        .unwrap()
        .wait()
        .unwrap();
    let input =
        provider_request::ReportInput::decode(&parse_json(r#"{"group":"task"}"#).unwrap()).unwrap();
    let views = ycoding_core::usage_view::Service::new(Service::new(store.client()), None);
    prepared_support::publish(&store.client(), &views);
    let report = {
        demand_support::prepare(&store.client(), None, std::slice::from_ref(&input)).unwrap();
        Service::new(store.client()).usage_report_all(&input)
    }
    .unwrap()
    .encode();
    assert_eq!(number(&report, "rowCount"), Some(2.0));
    assert_eq!(number(&report, "rows.0.logical"), Some(1.0));
    assert_eq!(number(&report, "rows.1.logical"), Some(1.0));
    assert_eq!(number(&report, "total.logical"), Some(1.0));
    assert_eq!(number(&report, "total.outcomes.completed"), Some(1.0));
    assert_eq!(number(&report, "speed.generationSamples"), Some(1.0));
    assert_eq!(number(&report, "speed.outputTokensPerSecond"), Some(100.0));
}

#[test]
fn mixed_grain_edges_and_weighted_percentiles_preserve_report_population() {
    let store = Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([54; 16], 1),
    )
    .unwrap();
    let _reports = report_support::start(store.client());
    let mut rows = Vec::new();
    for (index, (time, rate)) in [
        (59_998, 900),
        (59_999, 10),
        (60_000, 10),
        (899_999, 20),
        (900_000, 100),
        (900_001, 900),
    ]
    .into_iter()
    .enumerate()
    {
        let mut row = fact(
            index as i64,
            None,
            Some(0.0),
            Some(&format!(
                r#"{{"generatedTokens":{rate},"generationDurationNs":1000000000}}"#
            )),
        );
        row.time_created = time;
        rows.push(row);
    }
    store
        .submit(move |tx| {
            rows.iter()
                .try_for_each(|row| UsageAnalyticsRequestTable::insert(tx, row))
        })
        .unwrap()
        .wait()
        .unwrap();
    let input = provider_request::ReportInput::decode(
        &parse_json(r#"{"group":"model","from":59999,"to":900001}"#).unwrap(),
    )
    .unwrap();
    let views = ycoding_core::usage_view::Service::new(Service::new(store.client()), None);
    prepared_support::publish(&store.client(), &views);
    let report = {
        demand_support::prepare(&store.client(), None, std::slice::from_ref(&input)).unwrap();
        Service::new(store.client()).usage_report_all(&input)
    }
    .unwrap()
    .encode();
    assert_eq!(number(&report, "total.logical"), Some(4.0));
    assert_eq!(number(&report, "total.tokens.input"), Some(40.0));
    assert_eq!(number(&report, "speed.generationSamples"), Some(4.0));
    assert_eq!(number(&report, "speed.meanTokensPerSecond"), Some(35.0));
    assert_eq!(number(&report, "speed.outputTokensPerSecond"), Some(35.0));
    assert_eq!(
        number(&report, "speed.generationP50TokensPerSecond"),
        Some(10.0)
    );
    for field in [
        "generationP90TokensPerSecond",
        "generationP95TokensPerSecond",
    ] {
        assert_eq!(number(&report, &format!("speed.{field}")), Some(100.0));
    }
}

#[test]
fn global_usage_refuses_until_prepared_cells_are_complete_then_matches_the_seeded_facts() {
    let store = Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([7; 16], 1),
    )
    .unwrap();
    let rows = (1..=300)
        .map(|index| fact(index, Some("completed"), Some(0.0), None))
        .collect::<Vec<_>>();
    store
        .submit(move |tx| {
            rows.iter()
                .try_for_each(|row| UsageAnalyticsRequestTable::insert(tx, row))
        })
        .unwrap()
        .wait()
        .unwrap();
    let client = store.client();
    let _reports = report_support::start_with(client.clone(), false);
    let sessions = Service::new(client.clone());
    let views = ycoding_core::usage_view::Service::new(sessions.clone(), None);
    let input = provider_request::ReportInput::decode(
        &parse_json(r#"{"group":"model","from":0,"to":301000}"#).unwrap(),
    )
    .unwrap();
    let refused = || {
        for error in [
            sessions.usage_all().expect_err("summary must refuse"),
            sessions
                .usage_report_all(&input)
                .expect_err("report must refuse"),
        ] {
            assert!(!matches!(error, ycoding_store::Error::Rejected(_)));
            assert!(matches!(error, ycoding_store::Error::Domain { .. }));
        }
    };
    refused();
    assert!(!ycoding_store::usage_cells::maintain(&client).unwrap());
    refused();
    assert!(!ycoding_store::usage_cells::maintain(&client).unwrap());
    refused();
    while !ycoding_store::usage_cells::ready(&client.snapshot().unwrap()).unwrap() {
        ycoding_store::usage_cells::maintain(&client).unwrap();
    }
    refused();
    prepared_support::publish(&client, &views);
    assert_eq!(
        {
            demand_support::prepare(&store.client(), None, &[]).unwrap();
            sessions.usage_all()
        }
        .unwrap()
        .logical
        .get(),
        300
    );
    let report = {
        demand_support::prepare(&store.client(), None, std::slice::from_ref(&input)).unwrap();
        sessions.usage_report_all(&input)
    }
    .unwrap()
    .encode();
    assert_eq!(number(&report, "rowCount"), Some(1.0));
    assert_eq!(number(&report, "rows.0.logical"), Some(300.0));
    assert_eq!(number(&report, "total.logical"), Some(300.0));
    assert_eq!(number(&report, "total.outcomes.completed"), Some(300.0));
}

#[test]
fn fact_discovery_visits_only_half_open_time_bounds_across_equal_timestamp_pages() {
    let store = Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([79; 16], 1),
    )
    .unwrap();
    let rows = (0..405)
        .map(|index| {
            let mut row = fact(index, None, Some(0.0), None);
            row.id = format!("prq_{:04}", 404 - index).into();
            row.model = Document::new(
                parse_json(&format!(
                    r#"{{"providerID":"local","id":"model-{index:04}"}}"#
                ))
                .unwrap(),
            )
            .unwrap();
            row.time_created = match index {
                0 => 99,
                404 => 101,
                _ => 100,
            };
            row
        })
        .collect::<Vec<_>>();
    store
        .submit(move |tx| {
            rows.iter()
                .try_for_each(|row| UsageAnalyticsRequestTable::insert(tx, row))
        })
        .unwrap()
        .wait()
        .unwrap();
    let _reports = report_support::start(store.client());
    let sessions = Service::new(store.client());
    let views = ycoding_core::usage_view::Service::new(sessions.clone(), None);
    prepared_support::publish(&store.client(), &views);
    for (from, to, expected) in [
        (Some(100i64), Some(101i64), 403),
        (Some(101), None, 1),
        (None, Some(100), 1),
        (None, None, 405),
    ] {
        let mut input = provider_request::ReportInput::decode(
            &parse_json(r#"{"group":"model","limit":200}"#).unwrap(),
        )
        .unwrap();
        input.from = from.map(|value| ycoding_schema::schema::NonNegativeInt::new(value).unwrap());
        input.to = to.map(|value| ycoding_schema::schema::NonNegativeInt::new(value).unwrap());
        let mut visited = std::collections::BTreeSet::new();
        loop {
            let report = {
                demand_support::prepare(&store.client(), None, std::slice::from_ref(&input))
                    .unwrap();
                sessions.usage_report_all(&input)
            }
            .unwrap();
            assert_eq!(report.row_count.get(), expected);
            assert_eq!(report.total.logical.get(), expected);
            assert!(report.rows.len() <= 200);
            for row in report.rows {
                assert_eq!(row.metrics.logical.get(), 1);
                let model = row.model.unwrap().id.to_utf8().unwrap();
                let index = model
                    .strip_prefix("model-")
                    .unwrap()
                    .parse::<i64>()
                    .unwrap();
                let time = match index {
                    0 => 99,
                    404 => 101,
                    _ => 100,
                };
                assert!(from.is_none_or(|lower| time >= lower));
                assert!(to.is_none_or(|upper| time < upper));
                assert!(
                    visited.insert(model),
                    "page cursors must not revisit a request"
                );
            }
            let Some(next) = report.next_offset else {
                break;
            };
            input.offset = Some(next);
        }
        assert_eq!(visited.len() as i64, expected);
    }
    assert!(
        provider_request::ReportInput::decode(
            &parse_json(r#"{"group":"model","from":101,"to":100}"#).unwrap()
        )
        .is_err()
    );
}
