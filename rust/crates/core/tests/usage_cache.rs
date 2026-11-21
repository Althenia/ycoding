use std::{
    collections::BTreeSet,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use ycoding_core::{
    session::{
        store::Service,
        usage_read::{Pricing, PricingRef},
    },
    usage_view,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, model, money::UsdPerMillionTokens, parse_json,
    provider_request, stringify_json,
};
use ycoding_store::{
    Store, TableSpec,
    analytics::{self, Engine, reports},
    project::{Project, ProjectTable},
    resources::{UsageAnalyticsRequest, UsageAnalyticsRequestTable},
    session::Document,
};

#[path = "report_support/demand.rs"]
mod demand_support;
#[path = "report_support/prepared.rs"]
mod prepared_support;

static ANALYTICS: Mutex<()> = Mutex::new(());
const BASE: i64 = 1_772_841_600_000;

fn row(index: i64) -> UsageAnalyticsRequest {
    UsageAnalyticsRequest {
        id: format!("prq_{index:04}").into(),
        session_id: format!("ses_{}", index % 4).into(),
        project_id: "prj_one".into(),
        directory: format!("/location-{}", index % 3).into(),
        workspace_id: None,
        session_updated: 1,
        agent: "build".into(),
        source: if index % 5 == 0 {
            "decision"
        } else if index % 7 == 0 {
            "title"
        } else {
            "step"
        }
        .into(),
        model: Document::new(
            parse_json(&format!(
                r#"{{"providerID":"local","id":"model-{}"}}"#,
                index % 2
            ))
            .unwrap(),
        )
        .unwrap(),
        usage_anchor: None,
        task_path: Document::new(JsonValue::Array(Vec::new())).unwrap(),
        request: index,
        attempts: 1,
        continuation: "full".into(),
        invalidation: "first-request".into(),
        prompt_cache_key: "cachekey".into(),
        cache_read_reported: Some(1),
        tokens: Document::new(
            parse_json(&format!(
                r#"{{"input":{},"output":{index},"reasoning":0,"cache":{{"read":0,"write":0}}}}"#,
                100 + index
            ))
            .unwrap(),
        )
        .unwrap(),
        cost: (index % 4 == 0).then_some(0.001 * index as f64),
        timing: None,
        outcome: None,
        time_created: BASE + index * 3_600_000,
    }
}

fn insert(store: &Store, rows: impl IntoIterator<Item = i64>) {
    let rows = rows.into_iter().map(row).collect::<Vec<_>>();
    store
        .submit(move |tx| {
            rows.iter()
                .try_for_each(|row| UsageAnalyticsRequestTable::insert(tx, row))
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn delete(store: &Store, index: i64) {
    let key = UsageAnalyticsRequestTable::primary_key(&row(index));
    store
        .submit(move |tx| tx.delete::<UsageAnalyticsRequestTable>(&key).map(|_| ()))
        .unwrap()
        .wait()
        .unwrap();
}

fn project(store: &Store, name: Option<&str>) {
    let name = name.map(Into::into);
    store
        .submit(move |tx| {
            tx.put::<ProjectTable>(&Project {
                id: "prj_one".into(),
                worktree: "/project".into(),
                vcs: None,
                name,
                icon_url: None,
                icon_url_override: None,
                icon_color: None,
                time_created: 1,
                time_updated: 1,
                time_initialized: None,
                sandboxes: Vec::new(),
                commands: None,
            })
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn pricing(rate: f64) -> Pricing {
    let usd = |value| UsdPerMillionTokens::decode(&JsonValue::Number(value)).unwrap();
    Pricing {
        provider: vec![model::Cost {
            tier: None,
            input: usd(rate),
            output: usd(rate * 2.0),
            cache: model::CacheCost {
                read: usd(0.0),
                write: usd(0.0),
            },
        }],
        router: Vec::new(),
    }
}

fn input(value: &str) -> provider_request::ReportInput {
    provider_request::ReportInput::decode(&parse_json(value).unwrap()).unwrap()
}

fn text(value: &impl DomainEncode) -> String {
    stringify_json(&value.encode())
}

struct Fixture {
    store: Store,
    service: Service,
    views: usage_view::Service,
    rate: Arc<Mutex<Option<f64>>>,
    calls: Arc<AtomicUsize>,
    engine: Option<Engine>,
    root: std::path::PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let store = Store::disposable(
            ycoding_store::Options::core(),
            ycoding_store::native::catalog(ycoding_store::native::DatabaseKind::Core),
            ycoding_store::Metadata::new([83; 16], 1),
        )
        .unwrap();
        project(&store, None);
        insert(&store, 0..60);
        let root =
            std::env::temp_dir().join(format!("ycoding-usage-stage-{name}-{}", std::process::id()));
        let engine = reports::start(store.client(), &root).unwrap();
        let service = Service::new(store.client());
        let rate = Arc::new(Mutex::new(Some(1.0)));
        let calls = Arc::new(AtomicUsize::new(0));
        let current = rate.clone();
        let observed = calls.clone();
        let views = usage_view::Service::new(
            service.clone(),
            Some(Arc::new(move |reference: &PricingRef| {
                observed.fetch_add(1, Ordering::SeqCst);
                Ok(if reference.directory.as_str() == Some("/location-2") {
                    None
                } else {
                    current.lock().unwrap().map(pricing)
                })
            })),
        );
        let fixture = Self {
            store,
            service,
            views,
            rate,
            calls,
            engine: Some(engine),
            root,
        };
        fixture.publish();
        fixture
    }

    fn publish(&self) {
        prepared_support::publish(&self.store.client(), &self.views);
    }

    fn revision(&self) -> ycoding_schema::LosslessString {
        self.views.read_prepared(&[]).unwrap().unwrap().revision
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.engine.take().unwrap().shutdown().unwrap();
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn summary_reuses_results_until_its_rows_or_prices_change() {
    let _analytics = ANALYTICS.lock().unwrap_or_else(|error| error.into_inner());
    let fixture = Fixture::new("summary");
    let first = {
        demand_support::prepare(&fixture.store.client(), None, &[]).unwrap();
        fixture.service.usage_all()
    }
    .unwrap();
    let revision = fixture.revision();
    let calls = fixture.calls.load(Ordering::SeqCst);
    for _ in 0..2 {
        assert_eq!(
            text(
                &{
                    demand_support::prepare(&fixture.store.client(), None, &[]).unwrap();
                    fixture.service.usage_all()
                }
                .unwrap()
            ),
            text(&first)
        );
        assert_eq!(
            text(
                &{
                    demand_support::prepare(&fixture.store.client(), None, &[]).unwrap();
                    Service::new(fixture.store.client()).usage_all()
                }
                .unwrap()
            ),
            text(&first)
        );
    }
    assert_eq!(fixture.revision(), revision);
    assert_eq!(fixture.calls.load(Ordering::SeqCst), calls);
    project(&fixture.store, Some("renamed"));
    assert!(fixture.service.usage_all().is_err());
    fixture.publish();
    assert_ne!(fixture.revision(), revision);
    assert_eq!(
        text(
            &{
                demand_support::prepare(&fixture.store.client(), None, &[]).unwrap();
                fixture.service.usage_all()
            }
            .unwrap()
        ),
        text(&first)
    );
    *fixture.rate.lock().unwrap() = None;
    fixture.views.invalidate();
    assert!(fixture.service.usage_all().is_err());
    fixture.publish();
    let unpriced = {
        demand_support::prepare(&fixture.store.client(), None, &[]).unwrap();
        fixture.service.usage_all()
    }
    .unwrap();
    assert_ne!(text(&unpriced), text(&first));
    *fixture.rate.lock().unwrap() = Some(1.0);
    fixture.views.invalidate();
    fixture.publish();
    assert_eq!(
        text(
            &{
                demand_support::prepare(&fixture.store.client(), None, &[]).unwrap();
                fixture.service.usage_all()
            }
            .unwrap()
        ),
        text(&first)
    );
    insert(&fixture.store, [60]);
    assert!(fixture.service.usage_all().is_err());
    fixture.publish();
    let inserted = {
        demand_support::prepare(&fixture.store.client(), None, &[]).unwrap();
        fixture.service.usage_all()
    }
    .unwrap();
    assert_eq!(inserted.logical.get(), first.logical.get() + 1);
    delete(&fixture.store, 1);
    assert!(fixture.service.usage_all().is_err());
    fixture.publish();
    let deleted = {
        demand_support::prepare(&fixture.store.client(), None, &[]).unwrap();
        fixture.service.usage_all()
    }
    .unwrap();
    assert_eq!(deleted.logical.get(), inserted.logical.get() - 1);
    *fixture.rate.lock().unwrap() = Some(3.0);
    fixture.views.invalidate();
    assert!(fixture.service.usage_all().is_err());
    fixture.publish();
    let repriced = {
        demand_support::prepare(&fixture.store.client(), None, &[]).unwrap();
        fixture.service.usage_all()
    }
    .unwrap();
    assert_ne!(text(&repriced), text(&deleted));
    assert_eq!(
        text(&repriced),
        text(
            &{
                demand_support::prepare(&fixture.store.client(), None, &[]).unwrap();
                Service::new(fixture.store.client()).usage_all()
            }
            .unwrap()
        )
    );
}

#[test]
fn reports_reuse_results_per_input_until_a_read_table_or_price_changes() {
    let _analytics = ANALYTICS.lock().unwrap_or_else(|error| error.into_inner());
    let fixture = Fixture::new("report");
    let inputs = [
        input(&format!(
            r#"{{"group":"day","timeZone":"America/New_York","from":{},"to":{},"limit":30,"sort":"key","order":"asc"}}"#,
            BASE + 3_600_000,
            BASE + 50 * 3_600_000
        )),
        input(r#"{"group":"model","limit":200,"sort":"cost","order":"desc"}"#),
        input(r#"{"group":"project","timeZone":"+05:30"}"#),
        input(
            r#"{"group":"hour","timeZone":"America/New_York","providerID":"local","modelID":"model-1"}"#,
        ),
    ];
    let first = inputs
        .iter()
        .map(|input| {
            text(
                &{
                    demand_support::prepare(
                        &fixture.store.client(),
                        None,
                        std::slice::from_ref(input),
                    )
                    .unwrap();
                    fixture.service.usage_report_all(input)
                }
                .unwrap(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        first.iter().collect::<BTreeSet<_>>().len(),
        inputs.len(),
        "inputs must not alias one another"
    );
    let calls = fixture.calls.load(Ordering::SeqCst);
    let revision = fixture.revision();
    for _ in 0..2 {
        for (input, expected) in inputs.iter().zip(&first) {
            assert_eq!(
                &text(
                    &{
                        demand_support::prepare(
                            &fixture.store.client(),
                            None,
                            std::slice::from_ref(input),
                        )
                        .unwrap();
                        fixture.service.usage_report_all(input)
                    }
                    .unwrap()
                ),
                expected
            );
            assert_eq!(
                &text(
                    &{
                        demand_support::prepare(
                            &fixture.store.client(),
                            None,
                            std::slice::from_ref(input),
                        )
                        .unwrap();
                        Service::new(fixture.store.client()).usage_report_all(input)
                    }
                    .unwrap()
                ),
                expected
            );
        }
    }
    assert_eq!(fixture.revision(), revision);
    assert_eq!(fixture.calls.load(Ordering::SeqCst), calls);
    for change in 0..5 {
        match change {
            0 => project(&fixture.store, Some("renamed")),
            1 => insert(&fixture.store, [61]),
            2 => delete(&fixture.store, 2),
            3 => {
                *fixture.rate.lock().unwrap() = Some(2.0);
                fixture.views.invalidate();
            }
            _ => {
                *fixture.rate.lock().unwrap() = None;
                fixture.views.invalidate();
            }
        }
        for input in &inputs {
            assert!(fixture.service.usage_report_all(input).is_err());
        }
        fixture.publish();
        for input in &inputs {
            assert_eq!(
                text(
                    &{
                        demand_support::prepare(
                            &fixture.store.client(),
                            None,
                            std::slice::from_ref(input),
                        )
                        .unwrap();
                        fixture.service.usage_report_all(input)
                    }
                    .unwrap()
                ),
                text(
                    &{
                        demand_support::prepare(
                            &fixture.store.client(),
                            None,
                            std::slice::from_ref(input),
                        )
                        .unwrap();
                        Service::new(fixture.store.client()).usage_report_all(input)
                    }
                    .unwrap()
                )
            );
        }
    }
    fixture
        .store
        .submit(|tx| analytics::privacy_changed(tx, Vec::new(), true).map(|_| ()))
        .unwrap()
        .wait()
        .unwrap();
    for input in &inputs {
        assert!(
            fixture.service.usage_report_all(input).is_err(),
            "a pending purge must fence a reused report"
        );
        assert!(
            Service::new(fixture.store.client())
                .usage_report_all(input)
                .is_err()
        );
    }
}

#[test]
fn a_reused_report_fails_while_the_analytics_directory_is_unusable() {
    let _analytics = ANALYTICS.lock().unwrap_or_else(|error| error.into_inner());
    let fixture = Fixture::new("outage");
    let input = input(r#"{"group":"session"}"#);
    {
        demand_support::prepare(&fixture.store.client(), None, std::slice::from_ref(&input))
            .unwrap();
        fixture.service.usage_report_all(&input)
    }
    .unwrap();
    std::fs::write(
        fixture.root.join("foreign-file"),
        b"not an owned generation",
    )
    .unwrap();
    let computed = Service::new(fixture.store.client())
        .usage_report_all(&input)
        .unwrap_err();
    let reused = fixture.service.usage_report_all(&input).unwrap_err();
    assert_eq!(format!("{reused:?}"), format!("{computed:?}"));
    assert!(
        fixture.service.usage_all().is_err(),
        "summaries must not bypass the unavailable canonical stage"
    );
}

#[test]
fn repeated_bounded_queries_do_not_reprice_or_replace_the_stage() {
    let _analytics = ANALYTICS.lock().unwrap_or_else(|error| error.into_inner());
    let fixture = Fixture::new("bounded");
    let revision = fixture.revision();
    let calls = fixture.calls.load(Ordering::SeqCst);
    for offset in 0..20 {
        let input = input(&format!(
            r#"{{"group":"model","offset":{offset},"limit":1}}"#
        ));
        demand_support::prepare(&fixture.store.client(), None, std::slice::from_ref(&input))
            .unwrap();
        let report = fixture.service.usage_report_all(&input).unwrap();
        assert_eq!(report.row_count.get(), 2);
        assert_eq!(report.rows.len(), usize::from(offset < 2));
    }
    assert_eq!(
        {
            demand_support::prepare(&fixture.store.client(), None, &[]).unwrap();
            fixture.service.usage_all()
        }
        .unwrap()
        .logical
        .get(),
        60
    );
    assert_eq!(fixture.revision(), revision);
    assert_eq!(fixture.calls.load(Ordering::SeqCst), calls);
}
